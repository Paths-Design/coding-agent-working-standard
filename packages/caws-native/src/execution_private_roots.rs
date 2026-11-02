//! Producer-owned directories and one-shot host manifest for a write-ceiling launch.
//!
//! Directory handles bind the paths passed to the host. This module does not
//! authenticate the host or prove that a descendant was actually sandboxed.
use crate::execution_prepared::Execution;
use crate::monotonic_deadline::MonotonicDeadline;
#[path = "execution_source_writes.rs"]
mod source_writes;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
pub(crate) use source_writes::SourceWriteBinding;
use std::{
    collections::BTreeMap,
    fs::{self, DirBuilder, File, OpenOptions},
    io::{self, Read},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};

pub(crate) const MANIFEST_FD: i32 = 4;
pub(crate) const ROLE_FDS: [i32; 4] = [5, 6, 7, 8];
const MANIFEST_LIMIT: usize = 512 * 1024;

fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "private execution root unavailable",
    )
}

fn private_directory(path: &Path) -> io::Result<()> {
    if !path.is_absolute()
        || path.components().any(|c| {
            matches!(c, Component::ParentDir)
                || matches!(c, Component::Normal(name) if name == ".git" || name == ".caws")
        })
        || fs::canonicalize(path)? != path
        || path
            .to_str()
            .is_none_or(|s| s.chars().any(char::is_control))
    {
        return Err(denied());
    }
    for ancestor in path.ancestors() {
        if fs::symlink_metadata(ancestor)?.file_type().is_symlink() {
            return Err(denied());
        }
    }
    let metadata = fs::metadata(path)?;
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o7777 != 0o700
    {
        return Err(denied());
    }
    Ok(())
}

fn directory(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
}

fn launch_id() -> io::Result<String> {
    let mut random = [0_u8; 32];
    File::open("/dev/urandom")?.read_exact(&mut random)?;
    Ok(random.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub(crate) struct PrivateLaunch {
    pub launch_id: String,
    pub invocation_root: PathBuf,
    pub output_root: PathBuf,
    pub tmp_root: PathBuf,
    pub cache_root: PathBuf,
    pub ceiling_json: String,
    pub manifest: Vec<u8>,
    pub manifest_sha256: String,
    handles: [File; 4],
    source_writes: Option<SourceWriteBinding>,
}

impl PrivateLaunch {
    pub fn create(
        scratch_root: &Path,
        project_root: &Path,
        session_id: &str,
        thread_id: &str,
        call_id: &str,
        sandbox_state_json: &str,
    ) -> io::Result<Self> {
        private_directory(scratch_root)?;
        if scratch_root.starts_with(project_root) || project_root.starts_with(scratch_root) {
            return Err(denied());
        }
        let mut attempts = 0;
        let (launch_id, invocation_root) = loop {
            if attempts == 3 {
                return Err(denied());
            }
            attempts += 1;
            let id = launch_id()?;
            let root = scratch_root.join(format!("caws-exec-{id}"));
            match DirBuilder::new().mode(0o700).create(&root) {
                Ok(()) => break (id, root),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        };
        let output_root = invocation_root.join("output");
        let tmp_root = invocation_root.join("tmp");
        let cache_root = invocation_root.join("cache");
        for path in [&output_root, &tmp_root, &cache_root] {
            DirBuilder::new().mode(0o700).create(path)?;
        }
        let handles = [
            directory(&invocation_root)?,
            directory(&output_root)?,
            directory(&tmp_root)?,
            directory(&cache_root)?,
        ];
        let ceiling_json = json!({
            "version": 1,
            "invocationRoot": invocation_root,
            "outputRoot": output_root,
            "tmpRoot": tmp_root,
            "cacheRoot": cache_root,
        })
        .to_string();
        let manifest = serde_json::to_vec(&json!({
            "schema": "codex.write-ceiling-launch.v1",
            "launchId": launch_id,
            "sessionId": session_id,
            "threadId": thread_id,
            "callId": call_id,
            "sandboxStateJson": sandbox_state_json,
            "ceilingJson": ceiling_json,
            "directoryFds": {
                "invocationRoot": ROLE_FDS[0],
                "outputRoot": ROLE_FDS[1],
                "tmpRoot": ROLE_FDS[2],
                "cacheRoot": ROLE_FDS[3],
            },
        }))?;
        if manifest.len() > MANIFEST_LIMIT {
            return Err(denied());
        }
        let manifest_sha256 = format!("{:x}", Sha256::digest(&manifest));
        let result = Self {
            launch_id,
            invocation_root,
            output_root,
            tmp_root,
            cache_root,
            ceiling_json,
            manifest,
            manifest_sha256,
            handles,
            source_writes: None,
        };
        result.verify_empty()?;
        Ok(result)
    }

    pub fn handles(&self) -> &[File; 4] {
        &self.handles
    }

    /// Upgrade an already execution-bound launch with an independently admitted binding.
    pub fn attach_source_writes(&mut self, binding: SourceWriteBinding) -> io::Result<()> {
        self.verify_empty()?;
        binding.validate()?;
        let mut manifest: Value = serde_json::from_slice(&self.manifest)?;
        if manifest["schema"] != "codex.write-ceiling-launch.v2" || self.source_writes.is_some() {
            return Err(denied());
        }
        let ceiling = json!({"version":2,"invocationRoot":self.invocation_root,"outputRoot":self.output_root,"tmpRoot":self.tmp_root,"cacheRoot":self.cache_root,"sourceFiles":binding.paths()}).to_string();
        manifest["schema"] = json!("codex.write-ceiling-launch.v3");
        manifest["ceilingJson"] = json!(ceiling);
        manifest["sourceRoot"] = json!(binding.root());
        manifest["sourceRootFd"] = json!(source_writes::SOURCE_ROOT_FD);
        manifest["sourceFiles"] = json!(binding.records());
        manifest["readOnlyPaths"] = json!(binding.read_only());
        let bytes = serde_json::to_vec(&manifest)?;
        if bytes.len() > MANIFEST_LIMIT {
            return Err(denied());
        }
        self.ceiling_json = ceiling;
        self.manifest_sha256 = format!("{:x}", Sha256::digest(&bytes));
        self.manifest = bytes;
        self.source_writes = Some(binding);
        Ok(())
    }

    pub fn source_fd_mappings(&self) -> Vec<(i32, i32)> {
        self.source_writes
            .as_ref()
            .map_or_else(Vec::new, SourceWriteBinding::fd_mappings)
    }

    fn execution_tuple(execution: &Execution) -> io::Result<Value> {
        if execution.argv.is_empty()
            || execution.argv[0] != execution.executable.path
            || !Path::new(&execution.cwd).is_absolute()
            || fs::canonicalize(&execution.cwd)? != Path::new(&execution.cwd)
        {
            return Err(denied());
        }
        let mut environment = BTreeMap::new();
        for entry in &execution.environment {
            if entry.name.is_empty()
                || entry.name.contains('=')
                || entry.name.contains('\0')
                || entry.value.contains('\0')
                || environment.insert(&entry.name, &entry.value).is_some()
            {
                return Err(denied());
            }
        }
        Ok(json!({"argv":execution.argv,"cwd":execution.cwd,"environment":environment}))
    }

    /// Bind the exact USER tuple once, after roots exist and before Source sees
    /// the final record. The record contains this resulting manifest digest.
    fn deadline_value(deadline: &MonotonicDeadline) -> io::Result<Value> {
        deadline.check().map_err(|_| denied())?;
        let envelope = deadline.envelope();
        if envelope
            .expires_ns
            .checked_sub(envelope.started_ns)
            .is_none_or(|n| n == 0 || n > 30_000_000_000)
        {
            return Err(denied());
        }
        Ok(
            json!({"clock":"CLOCK_MONOTONIC","startedNs":envelope.started_ns,"expiresNs":envelope.expires_ns}),
        )
    }

    pub fn bind_execution(
        &mut self,
        execution: &Execution,
        deadline: &MonotonicDeadline,
    ) -> io::Result<()> {
        self.verify_empty()?;
        let mut manifest: Value = serde_json::from_slice(&self.manifest)?;
        if manifest["schema"] != "codex.write-ceiling-launch.v1"
            || manifest.get("execution").is_some()
        {
            return Err(denied());
        }
        manifest["schema"] = json!("codex.write-ceiling-launch.v2");
        manifest["execution"] = Self::execution_tuple(execution)?;
        manifest["preparationDeadline"] = Self::deadline_value(deadline)?;
        let bytes = serde_json::to_vec(&manifest)?;
        if bytes.len() > MANIFEST_LIMIT {
            return Err(denied());
        }
        self.manifest_sha256 = format!("{:x}", Sha256::digest(&bytes));
        self.manifest = bytes;
        Ok(())
    }

    pub fn verify_execution(
        &self,
        execution: &Execution,
        deadline: &MonotonicDeadline,
    ) -> io::Result<()> {
        self.verify_empty()?;
        let manifest: Value = serde_json::from_slice(&self.manifest)?;
        if manifest["schema"]
            != if self.source_writes.is_some() {
                "codex.write-ceiling-launch.v3"
            } else {
                "codex.write-ceiling-launch.v2"
            }
            || manifest["execution"] != Self::execution_tuple(execution)?
            || manifest["preparationDeadline"] != Self::deadline_value(deadline)?
        {
            return Err(denied());
        }
        Ok(())
    }

    pub fn verify_empty(&self) -> io::Result<()> {
        if let Some(binding) = &self.source_writes {
            binding.validate()?;
        }
        // npm rejects one config path reused as both user and global config.
        // Distinct, absent paths in the producer-owned invocation directory
        // disable both sources without importing ambient configuration.
        for name in ["npm-user.npmrc", "npm-global.npmrc"] {
            match fs::symlink_metadata(self.invocation_root.join(name)) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                _ => return Err(denied()),
            }
        }
        for (path, handle) in [
            &self.invocation_root,
            &self.output_root,
            &self.tmp_root,
            &self.cache_root,
        ]
        .into_iter()
        .zip(&self.handles)
        {
            private_directory(path)?;
            let current = fs::symlink_metadata(path)?;
            let held = handle.metadata()?;
            if current.dev() != held.dev() || current.ino() != held.ino() {
                return Err(denied());
            }
        }
        for path in [&self.output_root, &self.tmp_root, &self.cache_root] {
            if fs::read_dir(path)?.next().is_some() {
                return Err(denied());
            }
        }
        let value: Value = serde_json::from_slice(&self.manifest)?;
        if value["ceilingJson"] != self.ceiling_json
            || format!("{:x}", Sha256::digest(&self.manifest)) != self.manifest_sha256
        {
            return Err(denied());
        }
        if let Some(binding) = &self.source_writes {
            let ceiling = json!({"version":2,"invocationRoot":self.invocation_root,"outputRoot":self.output_root,"tmpRoot":self.tmp_root,"cacheRoot":self.cache_root,"sourceFiles":binding.paths()}).to_string();
            if self.ceiling_json != ceiling
                || value["schema"] != "codex.write-ceiling-launch.v3"
                || value["sourceRoot"] != json!(binding.root())
                || value["sourceRootFd"] != json!(source_writes::SOURCE_ROOT_FD)
                || value["sourceFiles"] != json!(binding.records())
                || value["readOnlyPaths"] != json!(binding.read_only())
            {
                return Err(denied());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!(
                    "caws-private-roots-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
            DirBuilder::new().mode(0o700).create(&root).unwrap();
            DirBuilder::new()
                .mode(0o700)
                .create(root.join("scratch"))
                .unwrap();
            DirBuilder::new()
                .mode(0o700)
                .create(root.join("project"))
                .unwrap();
            Self(root)
        }
        fn scratch(&self) -> PathBuf {
            self.0.join("scratch")
        }
        fn project(&self) -> PathBuf {
            self.0.join("project")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn exact_host_manifest_binds_fresh_empty_role_handles_and_caller() {
        let f = Fixture::new();
        let launch = PrivateLaunch::create(
            &f.scratch(),
            &f.project(),
            "session-1",
            "thread-2",
            "call-3",
            "{\"opaque\":true}",
        )
        .unwrap();
        assert_eq!(launch.launch_id.len(), 64);
        assert_eq!(
            launch.manifest_sha256,
            format!("{:x}", Sha256::digest(&launch.manifest))
        );
        let manifest: Value = serde_json::from_slice(&launch.manifest).unwrap();
        assert_eq!(manifest["sessionId"], "session-1");
        assert_eq!(manifest["threadId"], "thread-2");
        assert_eq!(manifest["callId"], "call-3");
        assert_eq!(manifest["sandboxStateJson"], "{\"opaque\":true}");
        assert_eq!(manifest["ceilingJson"], launch.ceiling_json);
        assert_eq!(manifest["directoryFds"]["outputRoot"], ROLE_FDS[1]);
        launch.verify_empty().unwrap();
        fs::write(launch.output_root.join("foreign"), b"unexpected").unwrap();
        assert!(launch.verify_empty().is_err());
    }

    #[test]
    fn v2_manifest_binds_full_execution_once_without_changing_policy_bytes() {
        let f = Fixture::new();
        let mut launch = PrivateLaunch::create(
            &f.scratch(),
            &f.project(),
            "s",
            "t",
            "c",
            "{ \"opaque\": 1 }",
        )
        .unwrap();
        let mut execution: Execution = serde_json::from_value(json!({
            "executable":{"path":"/pinned/node","sha256":"a".repeat(64)},
            "argv":["/pinned/node","/pinned/npm-cli.js","test"],
            "cwd":f.project(),"environment":[{"name":"LC_ALL","value":"C"}],"stdinBase64":""}))
        .unwrap();
        let deadline = MonotonicDeadline::capture(std::time::Duration::from_secs(30)).unwrap();
        launch.bind_execution(&execution, &deadline).unwrap();
        launch.verify_execution(&execution, &deadline).unwrap();
        let manifest: Value = serde_json::from_slice(&launch.manifest).unwrap();
        assert_eq!(manifest["sandboxStateJson"], "{ \"opaque\": 1 }");
        assert_eq!(manifest["execution"]["argv"][0], "/pinned/node");
        assert_eq!(manifest["execution"]["environment"], json!({"LC_ALL":"C"}));
        assert_eq!(
            manifest["preparationDeadline"]["expiresNs"],
            deadline.envelope().expires_ns
        );
        assert!(launch.bind_execution(&execution, &deadline).is_err());
        execution.argv.push("substitution".into());
        assert!(launch.verify_execution(&execution, &deadline).is_err());
    }

    #[test]
    fn source_binding_v3_preserves_tuple_and_pins_sorted_records_and_digest() {
        let f = Fixture::new();
        let mut launch =
            PrivateLaunch::create(&f.scratch(), &f.project(), "s", "t", "c", "{}").unwrap();
        let execution: Execution = serde_json::from_value(json!({
            "executable":{"path":"/pinned/node","sha256":"a".repeat(64)},
            "argv":["/pinned/node","script"],"cwd":f.project(),"environment":[],"stdinBase64":""}))
        .unwrap();
        let deadline = MonotonicDeadline::capture(std::time::Duration::from_secs(30)).unwrap();
        launch.bind_execution(&execution, &deadline).unwrap();
        let before: Value = serde_json::from_slice(&launch.manifest).unwrap();
        let a = f.project().join("a");
        let z = f.project().join("z");
        fs::write(&a, b"abc").unwrap();
        fs::write(&z, b"def").unwrap();
        let binding =
            SourceWriteBinding::bind(&f.project(), &[z.clone(), a.clone()], &[f.scratch()])
                .unwrap();
        launch.attach_source_writes(binding).unwrap();
        launch.verify_execution(&execution, &deadline).unwrap();
        let v: Value = serde_json::from_slice(&launch.manifest).unwrap();
        assert_eq!(v["schema"], "codex.write-ceiling-launch.v3");
        assert_eq!(v["execution"], before["execution"]);
        assert_eq!(v["preparationDeadline"], before["preparationDeadline"]);
        assert_eq!(v["sourceRootFd"], 10);
        assert_eq!(v["sourceRoot"], json!(f.project()));
        assert_eq!(v["sourceFiles"][0]["path"], json!(a));
        assert_eq!(v["sourceFiles"][0]["fileFd"], 11);
        assert_eq!(v["sourceFiles"][0]["parentFd"], 12);
        assert_eq!(v["sourceFiles"][1]["path"], json!(z));
        assert_eq!(v["sourceFiles"][1]["fileFd"], 13);
        assert_eq!(v["sourceFiles"][1]["parentFd"], 14);
        assert_eq!(
            v["sourceFiles"][0]["sha256"],
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(v["sourceFiles"][0]["size"], "3");
        let ceiling: Value = serde_json::from_str(&launch.ceiling_json).unwrap();
        assert_eq!(ceiling["version"], 2);
        assert_eq!(ceiling["sourceFiles"], json!([a, z]));
        assert_eq!(
            launch
                .source_fd_mappings()
                .iter()
                .map(|p| p.1)
                .collect::<Vec<_>>(),
            vec![10, 11, 12, 13, 14]
        );
        assert_eq!(
            launch.manifest_sha256,
            format!("{:x}", Sha256::digest(&launch.manifest))
        );
        fs::write(&a, b"changed").unwrap();
        assert!(launch.verify_execution(&execution, &deadline).is_err());
    }

    #[test]
    fn invocation_npm_configs_must_remain_absent_including_dangling_links() {
        let f = Fixture::new();
        let launch =
            PrivateLaunch::create(&f.scratch(), &f.project(), "s", "t", "c", "{}").unwrap();
        launch.verify_empty().unwrap();
        for name in ["npm-user.npmrc", "npm-global.npmrc"] {
            let path = launch.invocation_root.join(name);
            fs::write(&path, b"registry=https://untrusted.invalid/\n").unwrap();
            assert!(launch.verify_empty().is_err());
            fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink(launch.invocation_root.join("missing"), &path).unwrap();
            assert!(launch.verify_empty().is_err());
            fs::remove_file(&path).unwrap();
            launch.verify_empty().unwrap();
        }
    }

    #[test]
    fn nonprivate_or_aliased_scratch_and_replaced_role_refuse() {
        let f = Fixture::new();
        let scratch = f.scratch();
        fs::set_permissions(&scratch, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(PrivateLaunch::create(&scratch, &f.project(), "s", "t", "c", "{}").is_err());
        fs::set_permissions(&scratch, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&scratch, fs::Permissions::from_mode(0o2700)).unwrap();
        assert!(PrivateLaunch::create(&scratch, &f.project(), "s", "t", "c", "{}").is_err());
        fs::set_permissions(&scratch, fs::Permissions::from_mode(0o700)).unwrap();
        let alias = f.0.join("alias");
        std::os::unix::fs::symlink(&scratch, &alias).unwrap();
        assert!(PrivateLaunch::create(&alias, &f.project(), "s", "t", "c", "{}").is_err());
        let launch = PrivateLaunch::create(&scratch, &f.project(), "s", "t", "c", "{}").unwrap();
        fs::rename(&launch.tmp_root, launch.invocation_root.join("old-tmp")).unwrap();
        DirBuilder::new()
            .mode(0o700)
            .create(&launch.tmp_root)
            .unwrap();
        assert!(launch.verify_empty().is_err());
    }
}
