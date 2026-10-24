//! Native-owned anchored session publication. Prepared bytes never select a
//! directory. The caller supplies original frontend observations and a durable
//! running reservation, retains writer custody through consumption, and keeps
//! this entire object on any uncertain/error path.
use crate::monotonic_deadline::EffectCheck;
use crate::{service_journal as journal, session_publication_wire as wire};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::CString,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, RawFd},
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

type Result<T> = std::result::Result<T, String>;
pub const MARKER_NAME: &str = ".session-publication.json";
const MARKER_SCHEMA: &str = "caws.session.publication.v1";
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn check(expires: Instant) -> Result<()> {
    if Instant::now() >= expires {
        Err("session publication deadline expired".into())
    } else {
        Ok(())
    }
}
fn random() -> Result<String> {
    let mut bytes = [0u8; 32];
    File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(err)?;
    Ok(sha(&bytes))
}
fn cstr(name: &str) -> Result<CString> {
    CString::new(name).map_err(err)
}
#[derive(Debug, Clone, PartialEq, Eq)]
struct Stamp(u64, u64, u64, i64, i64, i64, i64);
fn stamp(m: &fs::Metadata) -> Stamp {
    Stamp(
        m.dev(),
        m.ino(),
        m.len(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
    )
}
fn safe(m: &fs::Metadata, directory: bool) -> Result<()> {
    if (if directory {
        !m.is_dir()
    } else {
        !m.is_file() || m.nlink() != 1
    }) || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o022 != 0
    {
        return Err("session publication requires owned non-writable regular anchors".into());
    }
    Ok(())
}
fn openat(parent: RawFd, name: &str, directory: bool) -> Result<File> {
    let name = cstr(name)?;
    let fd = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            libc::O_RDONLY
                | libc::O_NOFOLLOW
                | libc::O_CLOEXEC
                | libc::O_NONBLOCK
                | if directory { libc::O_DIRECTORY } else { 0 },
        )
    };
    if fd < 0 {
        return Err(err(std::io::Error::last_os_error()));
    }
    let file = unsafe { File::from_raw_fd(fd) };
    safe(&file.metadata().map_err(err)?, directory)?;
    Ok(file)
}
fn named_identity(parent: &File, name: &str, held: &File, directory: bool) -> Result<()> {
    let current = openat(parent.as_raw_fd(), name, directory)?;
    let a = current.metadata().map_err(err)?;
    let b = held.metadata().map_err(err)?;
    if (a.dev(), a.ino()) != (b.dev(), b.ino()) {
        return Err("session publication anchor replaced".into());
    }
    Ok(())
}
#[derive(Debug)]
struct Directory {
    project_path: PathBuf,
    project: File,
    governance: File,
    sessions: File,
    session: File,
    session_id: String,
}
impl Directory {
    fn open(
        project_path: &Path,
        session_id: &str,
        expires: Instant,
        effect: &EffectCheck<'_>,
    ) -> Result<Self> {
        effect("publication.directory")?;
        check(expires)?;
        if !project_path.is_absolute()
            || fs::canonicalize(project_path).map_err(err)? != project_path
        {
            return Err("publication project is not canonical absolute".into());
        }
        let project = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC)
            .open(project_path)
            .map_err(err)?;
        safe(&project.metadata().map_err(err)?, true)?;
        let governance = openat(project.as_raw_fd(), ".caws", true)?;
        let child = |parent: &File, name: &str| -> Result<File> {
            let leaf = cstr(name)?;
            effect("publication.mkdir")?;
            if unsafe { libc::mkdirat(parent.as_raw_fd(), leaf.as_ptr(), 0o700) } == 0 {
                effect("publication.mkdir.sync")?;
                parent.sync_all().map_err(err)?;
            } else if std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists {
                return Err(err(std::io::Error::last_os_error()));
            }
            openat(parent.as_raw_fd(), name, true)
        };
        let sessions = child(&governance, "sessions")?;
        let session = child(&sessions, session_id)?;
        let directory = Self {
            project_path: project_path.into(),
            project,
            governance,
            sessions,
            session,
            session_id: session_id.into(),
        };
        directory.revalidate(expires)?;
        Ok(directory)
    }
    fn path(&self) -> PathBuf {
        self.project_path
            .join(".caws/sessions")
            .join(&self.session_id)
    }
    fn revalidate(&self, expires: Instant) -> Result<()> {
        check(expires)?;
        let current = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC)
            .open(&self.project_path)
            .map_err(err)?;
        let a = current.metadata().map_err(err)?;
        let b = self.project.metadata().map_err(err)?;
        safe(&a, true)?;
        if (a.dev(), a.ino()) != (b.dev(), b.ino()) {
            return Err("publication canonical project replaced".into());
        }
        named_identity(&self.project, ".caws", &self.governance, true)?;
        named_identity(&self.governance, "sessions", &self.sessions, true)?;
        named_identity(&self.sessions, &self.session_id, &self.session, true)
    }
    fn read(&self, name: &str, expires: Instant) -> Result<Option<Captured>> {
        self.revalidate(expires)?;
        let leaf = cstr(name)?;
        let raw = unsafe {
            libc::openat(
                self.session.as_raw_fd(),
                leaf.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            )
        };
        if raw < 0 {
            let e = std::io::Error::last_os_error();
            return if e.kind() == std::io::ErrorKind::NotFound {
                Ok(None)
            } else {
                Err(err(e))
            };
        }
        let file = unsafe { File::from_raw_fd(raw) };
        let captured = Captured::read(file, expires)?;
        let current = openat(self.session.as_raw_fd(), name, false)?;
        if stamp(&current.metadata().map_err(err)?) != captured.stamp {
            return Err("publication input replaced while reading".into());
        }
        self.revalidate(expires)?;
        Ok(Some(captured))
    }
    fn inventory(&self, expires: Instant) -> Result<BTreeMap<String, Captured>> {
        self.revalidate(expires)?;
        let mut result = BTreeMap::new();
        let mut total = 0usize;
        // Enumeration selects names only. Every selected file is opened relative
        // to the held session descriptor and anchors are checked again afterward.
        for (index, entry) in fs::read_dir(self.path()).map_err(err)?.enumerate() {
            check(expires)?;
            if index >= 16_384 {
                return Err("session directory enumeration bound".into());
            }
            let name = entry
                .map_err(err)?
                .file_name()
                .into_string()
                .map_err(|_| "session filename is not UTF8")?;
            if wire::role(&name).is_some() {
                if result.len() >= wire::MAX_ARTIFACTS {
                    return Err("session inventory count bound".into());
                }
                let captured = self
                    .read(&name, expires)?
                    .ok_or("session inventory entry disappeared")?;
                total = total
                    .checked_add(captured.bytes.len())
                    .ok_or("session inventory byte overflow")?;
                if total > wire::MAX_TOTAL_BYTES {
                    return Err("session inventory byte bound".into());
                }
                result.insert(name, captured);
            }
        }
        self.revalidate(expires)?;
        Ok(result)
    }
}
#[derive(Debug, Clone)]
struct Captured {
    bytes: Vec<u8>,
    stamp: Stamp,
}
impl Captured {
    fn read(mut file: File, expires: Instant) -> Result<Self> {
        check(expires)?;
        let before = file.metadata().map_err(err)?;
        safe(&before, false)?;
        if before.len() > wire::MAX_ARTIFACT_BYTES as u64 {
            return Err("publication file byte bound".into());
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(wire::MAX_ARTIFACT_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(err)?;
        check(expires)?;
        let after = file.metadata().map_err(err)?;
        if stamp(&before) != stamp(&after) || bytes.len() as u64 != before.len() {
            return Err("publication file changed while reading".into());
        }
        Ok(Self {
            bytes,
            stamp: stamp(&before),
        })
    }
    fn descriptor(&self, name: &str, role: &str) -> wire::Descriptor {
        wire::Descriptor {
            name: name.into(),
            role: role.into(),
            byte_length: self.bytes.len(),
            sha256: sha(&self.bytes),
        }
    }
}

/// These fields come from independently captured frontend observations, never a
/// prepared frame. The owner has already matched its observed canonical root.
#[derive(Debug, Clone)]
pub struct OriginalBinding {
    pub project: PathBuf,
    pub id: String,
    pub runtime_digest: String,
    pub token: String,
    pub session_id: String,
    pub reason: String,
    pub ended_at: String,
}
pub fn original_request_id(id: &str) -> String {
    sha(&serde_json::to_vec(&("caws.session.original.v1", id)).expect("string tuple serialization"))
}

/// A native-derived extra source. Its aliases describe data; they cannot change
/// the owned output directory or expand the publication target allowlist.
#[derive(Debug)]
pub struct SourceInput {
    name: String,
    role: String,
    path: PathBuf,
    captured: Captured,
}
impl SourceInput {
    pub fn capture(name: &str, role: &str, path: &Path, expires: Instant) -> Result<Self> {
        if !wire::leaf(name)
            || role.is_empty()
            || role.len() > 32
            || !role.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
            || !path.is_absolute()
        {
            return Err("invalid native source alias".into());
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(path)
            .map_err(err)?;
        let captured = Captured::read(file, expires)?;
        Ok(Self {
            name: name.into(),
            role: role.into(),
            path: path.into(),
            captured,
        })
    }
    fn revalidate(&self, expires: Instant) -> Result<()> {
        let current = Self::capture(&self.name, &self.role, &self.path, expires)?;
        if current.captured.stamp != self.captured.stamp
            || current.captured.bytes != self.captured.bytes
        {
            return Err("native publication source changed".into());
        }
        Ok(())
    }
}
#[cfg(test)]
mod stop_source_tests {
    use super::*;
    use std::{
        sync::atomic::{AtomicBool, Ordering},
        time::Duration,
    };
    struct Fixture {
        root: PathBuf,
        deadline: Arc<crate::monotonic_deadline::MonotonicDeadline>,
        cancelled: Arc<AtomicBool>,
    }
    impl Fixture {
        fn new() -> Self {
            let parent = std::env::var_os("CAWS_NATIVE_TEST_ARTIFACT_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir);
            fs::create_dir_all(&parent).unwrap();
            let root = parent
                .canonicalize()
                .unwrap()
                .join(format!("stop-sources-{}", random().unwrap()));
            fs::create_dir(&root).unwrap();
            Self {
                root,
                deadline: Arc::new(
                    crate::monotonic_deadline::MonotonicDeadline::capture(Duration::from_secs(5))
                        .unwrap(),
                ),
                cancelled: Arc::new(AtomicBool::new(false)),
            }
        }
        fn capture(&self) -> CapturedStopSources {
            let result = CapturedStopSources::capture(
                &self.root,
                "s",
                &self.root.join(".opencode/logs"),
                Arc::clone(&self.deadline),
                Arc::clone(&self.cancelled),
                Instant::now() + Duration::from_secs(5),
                &|_| Ok(()),
            )
            .unwrap();
            if std::env::var_os("CAWS_NATIVE_TEST_ARTIFACT_ROOT").is_some() {
                fs::write(
                    self.root.join("captured-catalog.json"),
                    serde_json::to_vec_pretty(&result.catalog).unwrap(),
                )
                .unwrap();
                let files: Vec<_> = result
                    .inputs
                    .iter()
                    .map(|input| input.captured.descriptor(&input.name, &input.role))
                    .collect();
                let bytes: BTreeMap<_, _> = result
                    .inputs
                    .iter()
                    .map(|input| (input.name.clone(), STANDARD.encode(&input.captured.bytes)))
                    .collect();
                fs::write(
                    self.root.join("captured-inputs.json"),
                    serde_json::to_vec_pretty(&json!({
                        "sessionId": "s", "files": files, "bytesBase64": bytes,
                        "sourceCatalog": result.catalog,
                        "inputDigest": stop_source_input_digest(&files, &result.catalog).unwrap()
                    }))
                    .unwrap(),
                )
                .unwrap();
            }
            result
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if std::env::var_os("CAWS_NATIVE_TEST_ARTIFACT_ROOT").is_none() {
                let _ = fs::remove_dir_all(&self.root);
            }
        }
    }
    #[test]
    fn native_stop_absence_is_explicit_and_appearance_refuses_revalidation() {
        let f = Fixture::new();
        let captured = f.capture();
        assert_eq!(captured.catalog["audit"]["disposition"], "absent");
        assert_eq!(captured.catalog["hookOutcomes"]["disposition"], "absent");
        assert_eq!(
            captured.catalog["subagents"]["claudeCandidate"]["kind"],
            "absent"
        );
        assert_eq!(
            captured.catalog["subagents"]["qwenCandidate"]["kind"],
            "absent"
        );
        assert!(captured.inputs.is_empty());
        fs::create_dir_all(f.root.join(".opencode/logs")).unwrap();
        fs::write(f.root.join(".opencode/logs/audit.log"), "appeared").unwrap();
        assert_eq!(
            captured
                .revalidate(Instant::now() + Duration::from_secs(5), &|_| Ok(()))
                .unwrap_err(),
            "Stop source path or absence changed"
        );
    }
    #[test]
    fn native_stop_catalog_reuses_owned_metadata_bytes_and_retains_complete_listing() {
        let f = Fixture::new();
        let directory = f.root.join(".caws/sessions/s/s/subagents");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("agent-one.meta.json"),
            br#"{"toolUseId":"tool-one","agentType":"review"}"#,
        )
        .unwrap();
        fs::write(directory.join("agent-one.jsonl"), "ignored transcript").unwrap();
        let captured = f.capture();
        assert_eq!(captured.inputs.len(), 1);
        assert_eq!(
            captured.catalog["subagents"]["claudeCandidate"]["listing"]["names"],
            json!(["agent-one.jsonl", "agent-one.meta.json"])
        );
        assert_eq!(
            captured.inputs[0].captured.bytes.as_slice(),
            br#"{"toolUseId":"tool-one","agentType":"review"}"#
        );
        let descriptor = captured.catalog["subagents"]["claudeCandidate"]["listing"]["entries"][0]
            ["file"]["descriptor"]
            .clone();
        assert_eq!(
            descriptor["sha256"],
            sha(&captured.inputs[0].captured.bytes)
        );
        fs::write(directory.join("agent-two.meta.json"), "{}").unwrap();
        assert_eq!(
            captured
                .revalidate(Instant::now() + Duration::from_secs(5), &|_| Ok(()))
                .unwrap_err(),
            "Stop source path or absence changed"
        );
    }
    #[test]
    fn native_stop_entry_change_and_cancel_are_not_fresh_success() {
        let f = Fixture::new();
        let directory = f.root.join(".caws/sessions/s/s/subagents");
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("agent-one.meta.json");
        fs::write(&path, "{}").unwrap();
        let captured = f.capture();
        fs::write(&path, "{\"changed\":true}").unwrap();
        assert_eq!(
            captured
                .revalidate(Instant::now() + Duration::from_secs(5), &|_| Ok(()))
                .unwrap_err(),
            "Stop source path or absence changed"
        );
        f.cancelled.store(true, Ordering::Release);
        assert_eq!(
            captured
                .revalidate(Instant::now() + Duration::from_secs(5), &|_| Ok(()))
                .unwrap_err(),
            "Stop source capture cancelled"
        );
    }
    #[test]
    fn failed_directory_listing_is_an_error_result_not_absence() {
        let f = Fixture::new();
        let file = f.root.join("regular-file");
        fs::write(&file, "not a directory").unwrap();
        let failed =
            catalog_listing(&file, Instant::now() + Duration::from_secs(5), &|_| Ok(())).unwrap();
        assert!(!failed.unwrap_err().is_empty());
        let catalog = f.capture();
        assert_eq!(
            catalog.revalidate(Instant::now(), &|_| Ok(())).unwrap_err(),
            "session publication deadline expired"
        );
    }
    #[test]
    fn relative_audit_override_is_an_explicit_unresolved_domain_refusal() {
        let f = Fixture::new();
        let error = CapturedStopSources::capture(
            &f.root,
            "s",
            Path::new("relative-logs"),
            Arc::clone(&f.deadline),
            Arc::clone(&f.cancelled),
            Instant::now() + Duration::from_secs(5),
            &|_| Ok(()),
        )
        .unwrap_err();
        assert_eq!(error, "invalid native Stop source roots");
    }
    #[test]
    fn stop_catalog_digest_binds_absence_path_and_listing_not_only_file_descriptors() {
        let f = Fixture::new();
        let captured = f.capture();
        let digest = stop_source_input_digest(&[], &captured.catalog).unwrap();
        let mut changed = captured.catalog.clone();
        changed["audit"]["path"] = json!("/another/audit.log");
        assert_ne!(digest, stop_source_input_digest(&[], &changed).unwrap());
        changed = captured.catalog.clone();
        changed["audit"]["disposition"] = json!("failed");
        changed["audit"]["error"] = json!("permission denied");
        assert_ne!(digest, stop_source_input_digest(&[], &changed).unwrap());
        assert_ne!(
            digest,
            sha(&serde_json::to_vec(&Vec::<wire::Descriptor>::new()).unwrap())
        );
    }
}

pub const STOP_PREPARE: &str = "caws.runtime.session-publication.prepare.v2";
pub const STOP_SOURCE_CATALOG: &str = "caws.runtime.stop-render-sources.v1";
pub(crate) fn stop_source_input_digest(
    files: &[wire::Descriptor],
    catalog: &serde_json::Value,
) -> Result<String> {
    // Value's sorted object representation is the explicit v2 digest domain;
    // v1 retains its existing descriptor-vector byte identity unchanged.
    fn sorted(value: serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Array(values) => {
                serde_json::Value::Array(values.into_iter().map(sorted).collect())
            }
            serde_json::Value::Object(values) => {
                let ordered: BTreeMap<_, _> = values
                    .into_iter()
                    .map(|(key, value)| (key, sorted(value)))
                    .collect();
                serde_json::Value::Object(ordered.into_iter().collect())
            }
            value => value,
        }
    }
    Ok(sha(&serde_json::to_vec(&sorted(
        json!({"files":files,"sourceCatalog":catalog}),
    ))
    .map_err(err)?))
}

/// Data labels and native-held input witnesses, never a publication grant.
/// Positive bytes reuse SourceInput and its current-path revalidation contract.
#[derive(Debug)]
pub(crate) struct CapturedStopSources {
    catalog: serde_json::Value,
    deadline: Arc<crate::monotonic_deadline::MonotonicDeadline>,
    cancelled: Arc<std::sync::atomic::AtomicBool>,
    inputs: Vec<SourceInput>,
    paths: Vec<(PathBuf, Option<Stamp>, Option<Stamp>)>,
    directories: Vec<(PathBuf, std::result::Result<Vec<String>, String>)>,
}
impl CapturedStopSources {
    pub(crate) fn capture(
        project: &Path,
        session_id: &str,
        audit_root: &Path,
        deadline: Arc<crate::monotonic_deadline::MonotonicDeadline>,
        cancelled: Arc<std::sync::atomic::AtomicBool>,
        expires: Instant,
        effect: &EffectCheck<'_>,
    ) -> Result<Self> {
        effect("stop.sources.capture")?;
        if !project.is_absolute() || !audit_root.is_absolute() || !wire::leaf(session_id) {
            return Err("invalid native Stop source roots".into());
        }
        let directory = project.join(".caws/sessions").join(session_id);
        let transcript = directory.join(".transcript-projection.jsonl");
        let mut captured = Self {
            catalog: serde_json::Value::Null,
            deadline,
            cancelled,
            inputs: Vec::new(),
            paths: Vec::new(),
            directories: Vec::new(),
        };
        let audit = captured.file(
            "audit.log",
            "audit",
            &audit_root.join("audit.log"),
            false,
            expires,
            effect,
        )?;
        let hook = captured.file(
            "hook-events.jsonl",
            "hook_outcomes",
            &directory.join("hook-events.jsonl"),
            false,
            expires,
            effect,
        )?;
        let claude = captured.directory(
            "claude",
            &directory.join(session_id).join("subagents"),
            expires,
            effect,
        )?;
        let qwen = captured.directory(
            "qwen",
            &directory
                .parent()
                .ok_or("Stop session parent unavailable")?
                .join("subagents")
                .join(session_id),
            expires,
            effect,
        )?;
        captured.catalog = json!({"schema":STOP_SOURCE_CATALOG,"transcriptPath":catalog_path(&transcript)?,"audit":audit,"hookOutcomes":hook,"subagents":{"claudeCandidate":claude,"qwenCandidate":qwen}});
        if serde_json::to_vec(&captured.catalog).map_err(err)?.len() > wire::MAX_FRAME_BYTES {
            return Err("Stop source catalog frame bound".into());
        }
        captured.revalidate(expires, effect)?;
        Ok(captured)
    }
    fn checkpoint(&self, expires: Instant, effect: &EffectCheck<'_>) -> Result<()> {
        effect("stop.sources.check")?;
        self.deadline.check().map_err(err)?;
        if self.cancelled.load(std::sync::atomic::Ordering::Acquire) {
            return Err("Stop source capture cancelled".into());
        }
        check(expires)
    }
    fn witness(&mut self, path: &Path, expires: Instant, effect: &EffectCheck<'_>) -> Result<bool> {
        effect("stop.sources.path")?;
        self.checkpoint(expires, effect)?;
        catalog_path(path)?;
        let (named, followed) = catalog_stamps(path)?;
        let present = named.is_some();
        self.paths.push((path.into(), named, followed));
        effect("stop.sources.path.complete")?;
        self.checkpoint(expires, effect)?;
        Ok(present)
    }
    fn file(
        &mut self,
        alias: &str,
        role: &str,
        path: &Path,
        tolerate_read_failure: bool,
        expires: Instant,
        effect: &EffectCheck<'_>,
    ) -> Result<serde_json::Value> {
        if !self.witness(path, expires, effect)? {
            return Ok(json!({"path":catalog_path(path)?,"disposition":"absent"}));
        }
        effect("stop.sources.file")?;
        self.checkpoint(expires, effect)?;
        let input = SourceInput::capture(alias, role, path, expires);
        effect("stop.sources.file.complete")?;
        self.checkpoint(expires, effect)?;
        match input {
            Ok(input) => {
                if self.inputs.len() >= wire::MAX_ARTIFACTS
                    || self
                        .inputs
                        .iter()
                        .map(|i| i.captured.bytes.len())
                        .sum::<usize>()
                        .saturating_add(input.captured.bytes.len())
                        > wire::MAX_TOTAL_BYTES
                {
                    return Err("Stop source inventory bound".into());
                }
                let descriptor = input.captured.descriptor(&input.name, &input.role);
                self.inputs.push(input);
                Ok(json!({"path":catalog_path(path)?,"disposition":"read","descriptor":descriptor}))
            }
            Err(error) if tolerate_read_failure => Ok(
                json!({"path":catalog_path(path)?,"disposition":"failed","error":catalog_error(&error)}),
            ),
            Err(error) => Err(error),
        }
    }
    fn directory(
        &mut self,
        tier: &str,
        path: &Path,
        expires: Instant,
        effect: &EffectCheck<'_>,
    ) -> Result<serde_json::Value> {
        if !self.witness(path, expires, effect)? {
            return Ok(json!({"path":catalog_path(path)?,"kind":"absent"}));
        }
        effect("stop.sources.directory")?;
        self.checkpoint(expires, effect)?;
        let metadata = match fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(json!({"path":catalog_path(path)?,"kind":"not-directory"}));
            }
            Err(error) => return Err(err(error)),
        };
        if !metadata.is_dir() {
            return Ok(json!({"path":catalog_path(path)?,"kind":"not-directory"}));
        }
        let listing = catalog_listing(path, expires, &|_| self.checkpoint(expires, effect))?;
        self.directories.push((path.into(), listing.clone()));
        let listing = match listing {
            Err(error) => json!({"disposition":"failed","error":error}),
            Ok(names) => {
                let mut entries = Vec::new();
                for name in &names {
                    effect("stop.sources.entry")?;
                    self.checkpoint(expires, effect)?;
                    // Only metadata matching the stock glob is opened. Other
                    // names remain in the retained directory inventory witness.
                    if !name.starts_with("agent-") || !name.ends_with(".meta.json") {
                        continue;
                    }
                    let alias = format!("subagent-{tier}-{}", sha(name.as_bytes()));
                    let file =
                        self.file(&alias, "subagent", &path.join(&name), true, expires, effect)?;
                    entries.push(json!({"name":name,"file":file}));
                }
                json!({"disposition":"listed","names":names,"entries":entries})
            }
        };
        Ok(json!({"path":catalog_path(path)?,"kind":"directory","listing":listing}))
    }
    fn revalidate(&self, expires: Instant, effect: &EffectCheck<'_>) -> Result<()> {
        for (path, named, followed) in &self.paths {
            effect("stop.sources.revalidate.path")?;
            self.checkpoint(expires, effect)?;
            let current = catalog_stamps(path)?;
            if &current.0 != named || &current.1 != followed {
                return Err("Stop source path or absence changed".into());
            }
        }
        for (path, prior) in &self.directories {
            effect("stop.sources.revalidate.listing")?;
            if &catalog_listing(path, expires, &|_| self.checkpoint(expires, effect))? != prior {
                return Err("Stop source directory listing changed".into());
            }
        }
        // SourceInput owns the positive buffers; Publication revalidates them
        // alongside all prior inputs before each phase and before publication.
        self.checkpoint(expires, effect)
    }
}
fn catalog_path(path: &Path) -> Result<&str> {
    let value = path.to_str().ok_or("Stop source path is not UTF8")?;
    if !path.is_absolute() || value.len() > 4096 || value.contains(['\0', '\r', '\n']) {
        return Err("Stop source path bound".into());
    }
    Ok(value)
}
fn catalog_stamps(path: &Path) -> Result<(Option<Stamp>, Option<Stamp>)> {
    let read = |follow| -> Result<Option<Stamp>> {
        let metadata = if follow {
            fs::metadata(path)
        } else {
            fs::symlink_metadata(path)
        };
        match metadata {
            Ok(metadata) => Ok(Some(stamp(&metadata))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(err(error)),
        }
    };
    Ok((read(false)?, read(true)?))
}
fn catalog_error(value: &str) -> String {
    value.chars().take(1024).collect()
}
fn catalog_listing(
    path: &Path,
    expires: Instant,
    effect: &EffectCheck<'_>,
) -> Result<std::result::Result<Vec<String>, String>> {
    effect("stop.sources.listing")?;
    check(expires)?;
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) => return Ok(Err(catalog_error(&err(error)))),
    };
    let mut names = Vec::new();
    for entry in entries {
        effect("stop.sources.listing.entry")?;
        check(expires)?;
        if names.len() >= wire::MAX_ARTIFACTS {
            return Err("Stop source directory entry bound".into());
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => return Ok(Err(catalog_error(&err(error)))),
        };
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Stop source filename is not UTF8")?;
        if name.is_empty() || name.len() > 255 || name.contains(['/', '\0']) {
            return Err("Stop source filename bound".into());
        }
        names.push(name);
    }
    names.sort();
    effect("stop.sources.listing.complete")?;
    check(expires)?;
    Ok(Ok(names))
}

pub trait Transport {
    fn write(&mut self, bytes: &[u8], expires: Instant) -> Result<()>;
    /// Returns the exact engine JSON frame including its single consumed LF.
    fn read(&mut self, expires: Instant) -> Result<Vec<u8>>;
    fn credit(&mut self, bytes: usize) -> Result<()>;
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishedSelection {
    pub schema: String,
    pub canonical_root: PathBuf,
    pub session_id: String,
    pub correlation: wire::Correlation,
    pub terminal_digest: String,
    pub artifacts: Vec<wire::Descriptor>,
}
impl PublishedSelection {
    pub fn marker_name(&self) -> &'static str {
        MARKER_NAME
    }
    pub fn marker_bytes(&self) -> Result<Vec<u8>> {
        serde_json::to_vec(self).map_err(err)
    }
    pub fn marker_digest(&self) -> Result<String> {
        self.marker_bytes().map(|bytes| sha(&bytes))
    }
}
#[derive(Debug)]
pub struct Publication {
    original: OriginalBinding,
    correlation: wire::Correlation,
    directory: Directory,
    /// The exact Arc survives warm-backend retirement and publication. No path
    /// lookup/reacquisition can recreate this capability after a handoff gap.
    writer: Arc<journal::Custody>,
    prior: BTreeMap<String, Captured>,
    prior_marker: Option<Captured>,
    sources: Vec<SourceInput>,
    stop_sources: Option<CapturedStopSources>,
    prepared: BTreeMap<String, (wire::Descriptor, Vec<u8>)>,
    removals: BTreeSet<String>,
    phases: Vec<wire::Kind>,
    credit: wire::CreditBudget,
    aborted: bool,
    uncertain: bool,
    published: Option<PublishedSelection>,
    published_marker: Option<Stamp>,
    published_stamps: BTreeMap<String, Stamp>,
    #[cfg(test)]
    fail_after_removal: bool,
}
impl Publication {
    pub(crate) fn capture_stop_checked(
        original: OriginalBinding,
        writer: Arc<journal::Custody>,
        reservation: &journal::Dispatch,
        mut sources: CapturedStopSources,
        expires: Instant,
        effect: &EffectCheck<'_>,
    ) -> Result<Self> {
        sources.revalidate(expires, effect)?;
        let inputs = std::mem::take(&mut sources.inputs);
        let mut publication =
            Self::capture_checked(original, writer, reservation, inputs, expires, effect)?;
        sources.revalidate(expires, effect)?;
        publication.stop_sources = Some(sources);
        Ok(publication)
    }
    pub fn capture(
        original: OriginalBinding,
        writer: Arc<journal::Custody>,
        reservation: &journal::Dispatch,
        sources: Vec<SourceInput>,
        expires: Instant,
    ) -> Result<Self> {
        Self::capture_checked(original, writer, reservation, sources, expires, &|_| Ok(()))
    }
    pub(crate) fn capture_checked(
        original: OriginalBinding,
        writer: Arc<journal::Custody>,
        reservation: &journal::Dispatch,
        sources: Vec<SourceInput>,
        expires: Instant,
        effect: &EffectCheck<'_>,
    ) -> Result<Self> {
        effect("publication.capture")?;
        if original.id.is_empty()
            || original.id.len() > 256
            || !wire::digest(&original.runtime_digest)
            || original.token.is_empty()
            || original.token.len() > 128
            || !wire::leaf(&original.session_id)
            || original.session_id.len() > 128
            || original.reason.len() > 4096
            || original.ended_at.len() > 128
            || reservation.operation().identity().request_id != original_request_id(&original.id)
            || reservation.operation().identity().source_generation != original.runtime_digest
            || reservation.operation().identity().project_service_key
                != crate::service_protocol::project_service_key(
                    original
                        .project
                        .to_str()
                        .ok_or("publication root is not UTF8")?,
                )
                .map_err(err)?
        {
            return Err("publication original durable reservation mismatch".into());
        }
        let directory = Directory::open(&original.project, &original.session_id, expires, effect)?;
        let prior = directory.inventory(expires)?;
        let prior_marker = directory.read(MARKER_NAME, expires)?;
        let correlation = wire::Correlation {
            id: original.id.clone(),
            runtime_digest: original.runtime_digest.clone(),
            token: original.token.clone(),
            attempt: random()?,
        };
        let mut names: BTreeSet<String> = prior.keys().cloned().collect();
        let mut bytes: usize = prior.values().map(|entry| entry.bytes.len()).sum();
        for source in &sources {
            source.revalidate(expires)?;
            bytes = bytes
                .checked_add(source.captured.bytes.len())
                .ok_or("publication snapshot overflow")?;
            if !names.insert(source.name.clone()) || bytes > wire::MAX_TOTAL_BYTES {
                return Err("publication source aliases or byte frontier exceeded".into());
            }
        }
        if names.len() > wire::MAX_ARTIFACTS {
            return Err("publication snapshot file count bound".into());
        }
        Ok(Self {
            original,
            correlation,
            directory,
            writer,
            prior,
            prior_marker,
            sources,
            stop_sources: None,
            prepared: BTreeMap::new(),
            removals: BTreeSet::new(),
            phases: Vec::new(),
            credit: wire::CreditBudget::default(),
            aborted: false,
            uncertain: false,
            published: None,
            published_marker: None,
            published_stamps: BTreeMap::new(),
            #[cfg(test)]
            fail_after_removal: false,
        })
    }
    pub fn writer(&self) -> &Arc<journal::Custody> {
        &self.writer
    }
    pub fn correlation(&self) -> &wire::Correlation {
        &self.correlation
    }
    fn frame(&self, schema: &str, fields: serde_json::Value) -> Result<Vec<u8>> {
        let mut value = serde_json::to_value(&self.correlation).map_err(err)?;
        let object = value
            .as_object_mut()
            .ok_or("publication correlation encoding")?;
        object.insert("schema".into(), schema.into());
        object.extend(
            fields
                .as_object()
                .ok_or("publication frame fields")?
                .clone(),
        );
        let mut bytes = serde_json::to_vec(&value).map_err(err)?;
        bytes.push(b'\n');
        if bytes.len() > wire::MAX_FRAME_BYTES {
            return Err("publication frame bound".into());
        }
        Ok(bytes)
    }
    fn write(
        &self,
        transport: &mut impl Transport,
        schema: &str,
        fields: serde_json::Value,
        expires: Instant,
    ) -> Result<()> {
        check(expires)?;
        transport.write(&self.frame(schema, fields)?, expires)
    }
    fn read<T: serde::de::DeserializeOwned>(
        &self,
        transport: &mut impl Transport,
        expires: Instant,
    ) -> Result<(T, usize)> {
        check(expires)?;
        let bytes = transport.read(expires)?;
        if bytes.len() > wire::MAX_FRAME_BYTES
            || bytes.last() != Some(&b'\n')
            || bytes[..bytes.len() - 1].contains(&b'\n')
        {
            return Err("publication incoming frame bound or LF mismatch".into());
        }
        let value = serde_json::from_slice(&bytes).map_err(err)?;
        Ok((value, bytes.len()))
    }
    fn credit_validated(&mut self, transport: &mut impl Transport, bytes: usize) -> Result<()> {
        self.credit.accept(bytes)?;
        transport.credit(bytes)
    }
    fn prior_descriptors(&self) -> Vec<wire::Descriptor> {
        self.prior
            .iter()
            .map(|(name, captured)| {
                captured.descriptor(name, wire::role(name).expect("captured target role"))
            })
            .collect()
    }
    fn revalidate_inputs(&self, expires: Instant) -> Result<()> {
        self.revalidate_snapshot(&self.prior, self.prior_marker.as_ref(), expires)
    }
    fn revalidate_snapshot(
        &self,
        expected: &BTreeMap<String, Captured>,
        expected_marker: Option<&Captured>,
        expires: Instant,
    ) -> Result<()> {
        if let Some(sources) = &self.stop_sources {
            sources.revalidate(expires, &|_| Ok(()))?;
        }
        self.directory.revalidate(expires)?;
        let current = self.directory.inventory(expires)?;
        if current.len() != expected.len()
            || current.iter().any(|(name, entry)| {
                expected
                    .get(name)
                    .is_none_or(|prior| entry.stamp != prior.stamp || entry.bytes != prior.bytes)
            })
        {
            return Err("publication session snapshot changed".into());
        }
        let marker = self.directory.read(MARKER_NAME, expires)?;
        if marker.as_ref().map(|m| (&m.stamp, &m.bytes))
            != expected_marker.map(|m| (&m.stamp, &m.bytes))
        {
            return Err("publication prior marker changed".into());
        }
        for source in &self.sources {
            if let Some(catalog) = &self.stop_sources {
                catalog.checkpoint(expires, &|_| Ok(()))?;
            }
            source.revalidate(expires)?;
            if let Some(catalog) = &self.stop_sources {
                catalog.checkpoint(expires, &|_| Ok(()))?;
            }
        }
        Ok(())
    }
    /// Complete one bounded phase without touching output names. Projection is
    /// staged and becomes an input to the following render phase in this object.
    pub fn exchange_phase(
        &mut self,
        kind: wire::Kind,
        transport: &mut impl Transport,
        expires: Instant,
    ) -> Result<()> {
        if self.aborted
            || self.uncertain
            || self.published.is_some()
            || !matches!(
                (self.phases.as_slice(), kind),
                (
                    [],
                    wire::Kind::Projection | wire::Kind::Render | wire::Kind::Seal
                ) | ([wire::Kind::Projection], wire::Kind::Render)
            )
        {
            return Err("publication phase transition refused".into());
        }
        self.revalidate_inputs(expires)?;
        let mut files: Vec<(wire::Descriptor, &[u8])> = self
            .prior
            .iter()
            .map(|(name, entry)| {
                (
                    entry.descriptor(name, wire::role(name).expect("target role")),
                    entry.bytes.as_slice(),
                )
            })
            .collect();
        for source in &self.sources {
            files.push((
                source.captured.descriptor(&source.name, &source.role),
                &source.captured.bytes,
            ));
        }
        for (name, (descriptor, bytes)) in &self.prepared {
            files.retain(|(d, _)| d.name != *name);
            files.push((descriptor.clone(), bytes));
        }
        let descriptors: Vec<_> = files.iter().map(|(d, _)| d.clone()).collect();
        let catalog = (kind == wire::Kind::Render)
            .then(|| {
                self.stop_sources
                    .as_ref()
                    .map(|sources| sources.catalog.clone())
            })
            .flatten();
        let input_digest = match &catalog {
            Some(catalog) => stop_source_input_digest(&descriptors, catalog)?,
            None => sha(&serde_json::to_vec(&descriptors).map_err(err)?),
        };
        let observation_id = random()?;
        let mut snapshot = json!({"observationId":observation_id,"inputDigest":input_digest,"sessionId":self.original.session_id,"reason":self.original.reason,"endedAt":self.original.ended_at,"files":descriptors,"priorInventory":self.prior_descriptors()});
        let schema = if let Some(catalog) = catalog {
            snapshot
                .as_object_mut()
                .ok_or("Stop snapshot encoding")?
                .insert("sourceCatalog".into(), catalog);
            STOP_PREPARE
        } else {
            wire::PREPARE
        };
        self.write(
            transport,
            schema,
            json!({"kind":kind,"snapshot":snapshot}),
            expires,
        )?;
        for (descriptor, bytes) in files {
            for (index, chunk) in bytes.chunks(wire::MAX_CHUNK_BYTES).enumerate() {
                self.write(transport, wire::INPUTS, json!({"kind":kind,"name":descriptor.name,"offset":index*wire::MAX_CHUNK_BYTES,"base64":STANDARD.encode(chunk)}), expires)?;
            }
        }
        self.write(
            transport,
            wire::READY,
            json!({"kind":kind,"direction":"inputs"}),
            expires,
        )?;
        let (prepared, prepared_bytes): (wire::Prepared, usize) = self.read(transport, expires)?;
        if prepared.schema != wire::PREPARED
            || prepared.correlation() != self.correlation
            || prepared.kind != kind
            || prepared.observation_id != observation_id
            || prepared.input_digest != input_digest
        {
            return Err("publication prepared snapshot correlation mismatch".into());
        }
        if prepared.disposition == "aborted" {
            if !prepared.artifacts.is_empty()
                || !prepared.removals.is_empty()
                || prepared.summary_mode.is_some()
                || prepared
                    .diagnostic
                    .as_ref()
                    .is_none_or(|s| s.len() > 4096 || s.contains('\0'))
            {
                return Err("invalid aborted publication".into());
            }
            self.credit_validated(transport, prepared_bytes)?;
            self.aborted = true;
        } else {
            if prepared.disposition != "ready"
                || prepared.diagnostic.is_some()
                || prepared.artifacts.is_empty()
                || prepared.artifacts.len() > wire::MAX_ARTIFACTS
                || (kind != wire::Kind::Render && prepared.artifacts.len() != 1)
                || prepared.removals.len() > wire::MAX_ARTIFACTS
                || prepared.summary_mode.as_ref().is_some_and(|s| {
                    kind != wire::Kind::Seal || !matches!(s.as_str(), "recomputed" | "preserved")
                })
            {
                return Err("invalid publication preparation".into());
            }
            let mut names = BTreeSet::new();
            let mut total = 0usize;
            for descriptor in &prepared.artifacts {
                total = total
                    .checked_add(descriptor.byte_length)
                    .ok_or("publication artifact byte overflow")?;
                if !wire::target(kind, descriptor)
                    || !names.insert(descriptor.name.clone())
                    || descriptor.byte_length > wire::MAX_ARTIFACT_BYTES
                    || !wire::digest(&descriptor.sha256)
                    || total > wire::MAX_TOTAL_BYTES
                {
                    return Err("invalid prepared artifact descriptor".into());
                }
            }
            let mut removals = BTreeSet::new();
            for name in &prepared.removals {
                if kind != wire::Kind::Render
                    || !removals.insert(name.clone())
                    || names.contains(name)
                    || !self.prior.contains_key(name)
                    || !matches!(wire::role(name), Some("turn" | "spill" | "index"))
                {
                    return Err("publication removal not in captured render inventory".into());
                }
            }
            let retained_bytes: usize = self
                .prepared
                .iter()
                .filter(|(name, _)| !names.contains(*name) && !removals.contains(*name))
                .map(|(_, (_, bytes))| bytes.len())
                .sum();
            if total > wire::MAX_TOTAL_BYTES - retained_bytes {
                return Err("publication staged aggregate byte bound".into());
            }
            self.credit_validated(transport, prepared_bytes)?;
            let mut phase_outputs = BTreeMap::new();
            for descriptor in prepared.artifacts {
                let mut bytes = Vec::with_capacity(descriptor.byte_length);
                while bytes.len() < descriptor.byte_length {
                    let (chunk, chunk_bytes): (wire::Chunk, usize) =
                        self.read(transport, expires)?;
                    if chunk.schema != wire::CHUNK
                        || chunk.correlation() != self.correlation
                        || chunk.kind != kind
                        || chunk.name != descriptor.name
                        || chunk.offset != bytes.len()
                        || chunk.base64.len() > wire::MAX_CHUNK_BYTES.div_ceil(3) * 4
                        || chunk_bytes > chunk.base64.len() + wire::MAX_CHUNK_FRAME_OVERHEAD - 4
                    {
                        return Err("publication chunk correlation or bound mismatch".into());
                    }
                    let decoded = STANDARD.decode(&chunk.base64).map_err(err)?;
                    if decoded.len()
                        != (descriptor.byte_length - bytes.len()).min(wire::MAX_CHUNK_BYTES)
                        || STANDARD.encode(&decoded) != chunk.base64
                    {
                        return Err("invalid publication chunk bytes".into());
                    }
                    self.credit_validated(transport, chunk_bytes)?;
                    bytes.extend_from_slice(&decoded);
                }
                if sha(&bytes) != descriptor.sha256 {
                    return Err("prepared artifact digest mismatch".into());
                }
                phase_outputs.insert(descriptor.name.clone(), (descriptor, bytes));
            }
            for name in removals {
                self.prepared.remove(&name);
                self.removals.insert(name);
            }
            self.prepared.extend(phase_outputs);
        }
        let (ready, ready_bytes): (wire::Ready, usize) = self.read(transport, expires)?;
        if ready.schema != wire::READY
            || ready.correlation() != self.correlation
            || ready.kind != kind
            || ready.direction != "prepared"
        {
            return Err("publication prepared completion mismatch".into());
        }
        self.credit_validated(transport, ready_bytes)?;
        self.phases.push(kind);
        self.revalidate_inputs(expires)
    }
    fn replace(
        &self,
        name: &str,
        bytes: &[u8],
        expires: Instant,
        effect: &EffectCheck<'_>,
    ) -> Result<()> {
        self.directory.revalidate(expires)?;
        let temporary = format!(".publication-{}.tmp", random()?);
        let temporary_name = cstr(&temporary)?;
        let target_name = cstr(name)?;
        effect("publication.temporary")?;
        check(expires)?;
        let raw = unsafe {
            libc::openat(
                self.directory.session.as_raw_fd(),
                temporary_name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if raw < 0 {
            return Err(err(std::io::Error::last_os_error()));
        }
        let mut file = unsafe { File::from_raw_fd(raw) };
        let result = (|| {
            for chunk in bytes.chunks(wire::MAX_CHUNK_BYTES) {
                effect("publication.write")?;
                check(expires)?;
                file.write_all(chunk).map_err(err)?;
            }
            effect("publication.file.sync")?;
            file.sync_all().map_err(err)?;
            self.directory.revalidate(expires)?;
            named_identity(&self.directory.session, &temporary, &file, false)?;
            effect("publication.rename")?;
            check(expires)?;
            if unsafe {
                libc::renameat(
                    self.directory.session.as_raw_fd(),
                    temporary_name.as_ptr(),
                    self.directory.session.as_raw_fd(),
                    target_name.as_ptr(),
                )
            } != 0
            {
                return Err(err(std::io::Error::last_os_error()));
            }
            effect("publication.sync.after_rename")?;
            self.directory.session.sync_all().map_err(err)?;
            named_identity(&self.directory.session, name, &file, false)?;
            effect("publication.replaced")?;
            self.directory.revalidate(expires)
        })();
        // A failed cleanup never changes the result or grants another attempt.
        unsafe {
            libc::unlinkat(
                self.directory.session.as_raw_fd(),
                temporary_name.as_ptr(),
                0,
            )
        };
        result
    }
    /// Returns a terminal selection only after every file and the last marker
    /// are synced. Any failure after effects begin permanently marks uncertainty.
    pub fn publish(&mut self, expires: Instant) -> Result<PublishedSelection> {
        self.publish_checked(expires, &|_| Ok(()))
    }
    pub(crate) fn publish_checked(
        &mut self,
        expires: Instant,
        effect: &EffectCheck<'_>,
    ) -> Result<PublishedSelection> {
        effect("publication.publish")?;
        if self.uncertain
            || self.aborted
            || self.published.is_some()
            || !matches!(
                self.phases.as_slice(),
                [wire::Kind::Seal]
                    | [wire::Kind::Render]
                    | [wire::Kind::Projection, wire::Kind::Render]
            )
        {
            return Err("publication is not ready".into());
        }
        self.revalidate_inputs(expires)?;
        let mut inventory: BTreeMap<_, _> = self
            .prior_descriptors()
            .into_iter()
            .map(|d| (d.name.clone(), d))
            .collect();
        for name in &self.removals {
            inventory.remove(name);
        }
        for (name, (descriptor, _)) in &self.prepared {
            inventory.insert(name.clone(), descriptor.clone());
        }
        if inventory.len() > wire::MAX_ARTIFACTS
            || inventory.values().map(|d| d.byte_length).sum::<usize>() > wire::MAX_TOTAL_BYTES
        {
            return Err("published inventory frontier exceeded".into());
        }
        let artifacts: Vec<_> = inventory.into_values().collect();
        let terminal_digest =
            sha(&serde_json::to_vec(&(&self.correlation, "published", &artifacts)).map_err(err)?);
        let selected = PublishedSelection {
            schema: MARKER_SCHEMA.into(),
            canonical_root: self.original.project.clone(),
            session_id: self.original.session_id.clone(),
            correlation: self.correlation.clone(),
            terminal_digest,
            artifacts,
        };
        effect("publication.effects")?;
        check(expires)?;
        self.uncertain = true;
        let mut expected = self.prior.clone();
        // Keep every intermediate named inventory within the admitted frontier:
        // remove obsolete leaves and shrink existing leaves before any growth.
        // The prior snapshot stays retained for uncertain-outcome custody, while
        // the old marker remains in place until the complete new inventory syncs.
        for name in &self.removals {
            self.revalidate_snapshot(&expected, self.prior_marker.as_ref(), expires)?;
            let leaf = cstr(name)?;
            effect("publication.unlink")?;
            check(expires)?;
            if unsafe { libc::unlinkat(self.directory.session.as_raw_fd(), leaf.as_ptr(), 0) } != 0
            {
                return Err(err(std::io::Error::last_os_error()));
            }
            effect("publication.sync.after_unlink")?;
            self.directory.session.sync_all().map_err(err)?;
            expected.remove(name);
            #[cfg(test)]
            if self.fail_after_removal {
                return Err("injected post-removal publication failure".into());
            }
        }
        let mut writes: Vec<_> = self.prepared.iter().collect();
        writes.sort_by_key(|(name, (_, bytes))| {
            self.prior
                .get(*name)
                .is_none_or(|prior| bytes.len() > prior.bytes.len())
        });
        for (name, (_, bytes)) in writes {
            self.revalidate_snapshot(&expected, self.prior_marker.as_ref(), expires)?;
            self.replace(name, bytes, expires, effect)?;
            expected.insert(
                name.clone(),
                self.directory
                    .read(name, expires)?
                    .ok_or("published artifact disappeared")?,
            );
        }
        self.revalidate_snapshot(&expected, self.prior_marker.as_ref(), expires)?;
        effect("publication.marker")?;
        self.replace(MARKER_NAME, &selected.marker_bytes()?, expires, effect)?;
        self.published_marker = Some(
            self.directory
                .read(MARKER_NAME, expires)?
                .ok_or("published marker disappeared")?
                .stamp,
        );
        self.published_stamps = expected
            .into_iter()
            .map(|(name, file)| (name, file.stamp))
            .collect();
        self.published = Some(selected.clone());
        self.revalidate_current(&selected.terminal_digest, expires)?;
        effect("publication.committed")?;
        self.uncertain = false;
        Ok(selected)
    }
    pub fn revalidate_current(&self, terminal_digest: &str, expires: Instant) -> Result<()> {
        let selected = self.published.as_ref().ok_or("no published selection")?;
        if terminal_digest != selected.terminal_digest {
            return Err("published terminal changed".into());
        }
        let marker = self
            .directory
            .read(MARKER_NAME, expires)?
            .ok_or("published marker disappeared")?;
        if Some(&marker.stamp) != self.published_marker.as_ref()
            || marker.bytes != selected.marker_bytes()?
        {
            return Err("published current marker changed".into());
        }
        let inventory = self.directory.inventory(expires)?;
        if inventory.len() != selected.artifacts.len()
            || selected.artifacts.iter().any(|d| {
                inventory.get(&d.name).is_none_or(|entry| {
                    self.published_stamps.get(&d.name) != Some(&entry.stamp)
                        || entry.descriptor(&d.name, &d.role) != *d
                })
            })
        {
            return Err("published generation bytes or inventory changed".into());
        }
        Ok(())
    }
    pub fn write_result(&self, transport: &mut impl Transport, expires: Instant) -> Result<()> {
        let (status, terminal_digest, artifacts) = match &self.published {
            Some(selected) if !self.uncertain => (
                "published",
                selected.terminal_digest.clone(),
                selected.artifacts.clone(),
            ),
            _ if self.aborted && !self.uncertain => (
                "not_published",
                sha(&serde_json::to_vec(&(&self.correlation, "not_published")).map_err(err)?),
                Vec::new(),
            ),
            _ => return Err("publication has no definitive result".into()),
        };
        self.write(
            transport,
            wire::RESULT,
            json!({"status":status,"terminalDigest":terminal_digest,"artifacts":artifacts}),
            expires,
        )
    }
    pub fn terminal_digest(&self) -> Result<String> {
        match &self.published {
            Some(selected) if !self.uncertain => Ok(selected.terminal_digest.clone()),
            _ if self.aborted && !self.uncertain => Ok(sha(&serde_json::to_vec(&(
                &self.correlation,
                "not_published",
            ))
            .map_err(err)?)),
            _ => Err("publication has no definitive terminal".into()),
        }
    }
    /// Receipt parsing alone never reaches this boundary. The frontend's
    /// ordinary consumer must independently read/use the exact generation first;
    /// this owner then validates the held selection again before heavy release.
    pub fn exact_consumed(&self, bytes: &[u8], expires: Instant) -> Result<String> {
        if self.uncertain || bytes.len() > wire::MAX_FRAME_BYTES {
            return Err("uncertain or oversized consumption".into());
        }
        let consumed: wire::Consumed = serde_json::from_slice(bytes).map_err(err)?;
        if consumed.schema != wire::CONSUMED || consumed.correlation() != self.correlation {
            return Err("publication consumed correlation mismatch".into());
        }
        if consumed.terminal_digest != self.terminal_digest()? {
            return Err("publication consumed terminal mismatch".into());
        }
        if self.aborted {
            self.revalidate_inputs(expires)?;
        } else {
            self.revalidate_current(&consumed.terminal_digest, expires)?;
        }
        Ok(consumed.terminal_digest)
    }
    /// Credit a receipt only after native current-generation revalidation.
    pub fn consume_receipt(
        &mut self,
        bytes: &[u8],
        transport: &mut impl Transport,
        expires: Instant,
    ) -> Result<String> {
        if bytes.last() != Some(&b'\n') || bytes[..bytes.len() - 1].contains(&b'\n') {
            return Err("publication consumed LF mismatch".into());
        }
        let digest = self.exact_consumed(bytes, expires)?;
        self.credit_validated(transport, bytes.len())?;
        Ok(digest)
    }
    pub fn uncertain(&self) -> bool {
        self.uncertain
    }
    pub fn aborted(&self) -> bool {
        self.aborted
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::VecDeque,
        os::unix::fs::{PermissionsExt, symlink},
        time::Duration,
    };
    fn expires() -> Instant {
        Instant::now() + Duration::from_secs(10)
    }
    struct Fixture {
        root: PathBuf,
        retain: bool,
        journal: journal::Journal,
        dispatch: journal::Dispatch,
        writer: Arc<journal::Custody>,
    }
    impl Fixture {
        fn new() -> Self {
            Self::at(std::env::temp_dir(), false)
        }
        fn deadline_effect(scenario: &str) -> Self {
            let parent = std::env::var_os("CAWS_NATIVE_TEST_ARTIFACT_ROOT");
            let retain = parent.is_some();
            let fixture = Self::at(
                parent.map(PathBuf::from).unwrap_or_else(std::env::temp_dir),
                retain,
            );
            fixture.evidence(
                "scenario",
                &json!({"schema":"caws.deadline-effect.fixture.v1","scenario":scenario}),
            );
            fixture
        }
        fn evidence(&self, name: &str, row: &serde_json::Value) {
            fs::write(
                self.root.join(format!("{name}.json")),
                serde_json::to_vec_pretty(row).unwrap(),
            )
            .unwrap();
        }
        fn at(parent: PathBuf, retain: bool) -> Self {
            let root = parent
                .canonicalize()
                .unwrap()
                .join(format!("caws-publication-{}", random().unwrap()));
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            fs::create_dir(root.join(".caws")).unwrap();
            let home = root.join("machine");
            fs::create_dir(&home).unwrap();
            fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
            let custody = journal::Custody::initialize(&home, expires()).unwrap();
            let key = crate::service_protocol::project_service_key(root.to_str().unwrap()).unwrap();
            let mut journal = journal::Journal::open(custody, &key, 256, expires()).unwrap();
            let identity = journal::Identity {
                request_id: original_request_id("original"),
                argument_digest: sha(b"original"),
                project_service_key: key,
                source_generation: "a".repeat(64),
                execution_image_digest: "a".repeat(64),
            };
            assert!(matches!(
                journal.admit(identity, b"original", expires()).unwrap(),
                journal::Admission::Accepted {
                    duplicate: false,
                    ..
                }
            ));
            let dispatch = journal
                .begin_next(&"a".repeat(64), &"a".repeat(64), expires())
                .unwrap()
                .unwrap();
            let writer = crate::render_writer::acquire(&home, &root, expires()).unwrap();
            fs::create_dir(root.join(".caws/sessions")).unwrap();
            fs::create_dir(root.join(".caws/sessions/s")).unwrap();
            fs::write(root.join(".caws/sessions/s/.meta.json"), b"{\"old\":true}").unwrap();
            Self {
                root,
                retain,
                journal,
                dispatch,
                writer,
            }
        }
        fn capture(&self) -> Publication {
            Publication::capture(
                OriginalBinding {
                    project: self.root.clone(),
                    id: "original".into(),
                    runtime_digest: "a".repeat(64),
                    token: "token".into(),
                    session_id: "s".into(),
                    reason: "exit".into(),
                    ended_at: "2026-10-22T00:00:00Z".into(),
                },
                Arc::clone(&self.writer),
                &self.dispatch,
                vec![],
                expires(),
            )
            .unwrap()
        }
        fn capture_checked(&self, effect: &EffectCheck<'_>) -> Result<Publication> {
            Publication::capture_checked(
                OriginalBinding {
                    project: self.root.clone(),
                    id: "original".into(),
                    runtime_digest: "a".repeat(64),
                    token: "token".into(),
                    session_id: "s".into(),
                    reason: "exit".into(),
                    ended_at: "2026-10-22T00:00:00Z".into(),
                },
                Arc::clone(&self.writer),
                &self.dispatch,
                vec![],
                expires(),
                effect,
            )
        }
        fn path(&self, name: &str) -> PathBuf {
            self.root.join(".caws/sessions/s").join(name)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if self.retain {
                eprintln!(
                    "publication deadline fixture retained: {}",
                    self.root.display()
                );
            } else {
                let _ = fs::remove_dir_all(&self.root);
            }
        }
    }
    struct Exchange {
        frames: Vec<serde_json::Value>,
        replies: VecDeque<Vec<u8>>,
        output: Vec<u8>,
        corrupt: bool,
        output_name: String,
        output_role: String,
        credited: usize,
        reads: usize,
        short_chunk: bool,
        padded_chunk: bool,
    }
    impl Exchange {
        fn new() -> Self {
            Self {
                frames: vec![],
                replies: VecDeque::new(),
                output: b"{\"ended\":{\"reason\":\"exit\"}}".to_vec(),
                corrupt: false,
                output_name: ".meta.json".into(),
                output_role: "metadata".into(),
                credited: 0,
                reads: 0,
                short_chunk: false,
                padded_chunk: false,
            }
        }
    }
    impl Transport for Exchange {
        fn write(&mut self, bytes: &[u8], _: Instant) -> Result<()> {
            let frame: serde_json::Value = serde_json::from_slice(bytes).unwrap();
            if frame["schema"] == wire::READY && frame["direction"] == "inputs" {
                let prepare = self
                    .frames
                    .iter()
                    .rev()
                    .find(|f| f["schema"] == wire::PREPARE)
                    .unwrap();
                let common = |schema: &str| json!({"schema":schema,"id":prepare["id"],"runtimeDigest":prepare["runtimeDigest"],"token":prepare["token"],"attempt":prepare["attempt"],"kind":prepare["kind"]});
                let descriptor = wire::Descriptor {
                    name: self.output_name.clone(),
                    role: self.output_role.clone(),
                    byte_length: self.output.len(),
                    sha256: sha(&self.output),
                };
                let mut prepared = common(wire::PREPARED);
                prepared.as_object_mut().unwrap().extend(json!({"observationId":prepare["snapshot"]["observationId"],"inputDigest":prepare["snapshot"]["inputDigest"],"disposition":"ready","artifacts":[descriptor],"removals":[]}).as_object().unwrap().clone());
                if prepare["kind"] == "seal" {
                    prepared["summaryMode"] = json!("preserved");
                }
                if self.corrupt {
                    prepared["attempt"] = json!("stale");
                }
                self.replies
                    .push_back(serde_json::to_vec(&prepared).unwrap());
                for (index, bytes) in self.output.chunks(wire::MAX_CHUNK_BYTES).enumerate() {
                    let mut chunk = common(wire::CHUNK);
                    chunk.as_object_mut().unwrap().extend(
                        json!({"name":self.output_name,"offset":index*wire::MAX_CHUNK_BYTES,"base64":STANDARD.encode(bytes)})
                            .as_object().unwrap().clone());
                    self.replies.push_back(serde_json::to_vec(&chunk).unwrap());
                }
                let mut ready = common(wire::READY);
                ready["direction"] = json!("prepared");
                self.replies.push_back(serde_json::to_vec(&ready).unwrap());
            }
            self.frames.push(frame);
            Ok(())
        }
        fn read(&mut self, _: Instant) -> Result<Vec<u8>> {
            let mut bytes = self.replies.pop_front().ok_or("no framed response")?;
            let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            if value["schema"] == wire::CHUNK && self.short_chunk {
                value["base64"] = json!(STANDARD.encode(b"x"));
                bytes = serde_json::to_vec(&value).unwrap();
            }
            if value["schema"] == wire::CHUNK && self.padded_chunk {
                bytes.extend(vec![b' '; wire::MAX_CHUNK_FRAME_OVERHEAD]);
            }
            bytes.push(b'\n');
            self.reads += bytes.len();
            assert!(
                self.reads <= wire::MAX_FRAME_BYTES + 16 * 1024 + self.credited,
                "uncredited publication stdout exceeded the initial frontend allowance"
            );
            Ok(bytes)
        }
        fn credit(&mut self, bytes: usize) -> Result<()> {
            assert!(bytes > 0 && self.credited + bytes <= self.reads);
            self.credited += bytes;
            Ok(())
        }
    }
    fn ack(publication: &Publication, terminal: &str) -> Vec<u8> {
        publication
            .frame(wire::CONSUMED, json!({"terminalDigest":terminal}))
            .unwrap()
    }
    #[test]
    fn captured_input_chunks_use_input_direction_schema_and_exact_bytes() {
        let f = Fixture::new();
        let bytes =
            serde_json::to_vec(&json!({"padding":"x".repeat(wire::MAX_CHUNK_BYTES + 7)})).unwrap();
        fs::write(f.path(".meta.json"), &bytes).unwrap();
        let mut publication = f.capture();
        let mut transport = Exchange::new();
        publication
            .exchange_phase(wire::Kind::Seal, &mut transport, expires())
            .unwrap();
        let inputs: Vec<_> = transport
            .frames
            .iter()
            .filter(|frame| frame["schema"] == "caws.runtime.session-publication.inputs.v1")
            .collect();
        assert_eq!(inputs.len(), bytes.len().div_ceil(wire::MAX_CHUNK_BYTES));
        assert!(
            transport
                .frames
                .iter()
                .all(|frame| frame["schema"] != wire::CHUNK)
        );
        let prepare = &transport.frames[0];
        let mut recovered = Vec::new();
        for (index, frame) in inputs.iter().enumerate() {
            assert_eq!(frame["kind"], "seal");
            assert_eq!(frame["name"], ".meta.json");
            assert_eq!(frame["offset"], index * wire::MAX_CHUNK_BYTES);
            for key in ["id", "runtimeDigest", "token", "attempt"] {
                assert_eq!(frame[key], prepare[key]);
            }
            recovered.extend(STANDARD.decode(frame["base64"].as_str().unwrap()).unwrap());
        }
        assert_eq!(recovered, bytes);
        assert_eq!(prepare["snapshot"]["files"][0]["sha256"], sha(&recovered));
    }
    #[test]
    fn invalid_prepared_or_short_or_padded_chunks_never_earn_credit() {
        for fault in ["prepared", "short", "padding"] {
            let f = Fixture::new();
            let mut publication = f.capture();
            let mut transport = Exchange::new();
            transport.output = vec![b'x'; wire::MAX_CHUNK_BYTES + 1];
            transport.corrupt = fault == "prepared";
            transport.short_chunk = fault == "short";
            transport.padded_chunk = fault == "padding";
            let error = publication
                .exchange_phase(wire::Kind::Seal, &mut transport, expires())
                .unwrap_err();
            assert!(
                error.contains(match fault {
                    "prepared" => "correlation mismatch",
                    "short" => "invalid publication chunk bytes",
                    _ => "chunk correlation or bound mismatch",
                }),
                "{error}"
            );
            if fault == "prepared" {
                assert_eq!(transport.credited, 0);
            } else {
                assert!(transport.credited > 0 && transport.credited < transport.reads);
            }
            assert_eq!(fs::read(f.path(".meta.json")).unwrap(), b"{\"old\":true}");
            assert!(!f.path(MARKER_NAME).exists());
        }
    }
    #[test]
    fn direct_render_needs_no_projection_and_rejects_projection_targets() {
        for projection_target in [false, true] {
            let f = Fixture::new();
            let mut publication = f.capture();
            let mut transport = Exchange::new();
            transport.output_name = if projection_target {
                "store-projection.jsonl"
            } else {
                "turn-001.json"
            }
            .into();
            transport.output_role = if projection_target {
                "projection"
            } else {
                "turn"
            }
            .into();
            transport.output = b"{\"schema_version\":2}".to_vec();
            let result = publication.exchange_phase(wire::Kind::Render, &mut transport, expires());
            assert_eq!(
                transport
                    .frames
                    .iter()
                    .filter(|f| f["schema"] == wire::PREPARE)
                    .map(|f| f["kind"].clone())
                    .collect::<Vec<_>>(),
                vec![json!("render")]
            );
            assert!(!f.path("store-projection.jsonl").exists());
            if projection_target {
                assert!(
                    result
                        .unwrap_err()
                        .contains("invalid prepared artifact descriptor")
                );
                assert!(!f.path(MARKER_NAME).exists());
                assert!(publication.publish(expires()).is_err());
            } else {
                result.unwrap();
                assert!(
                    !f.path("turn-001.json").exists(),
                    "direct render wrote before publication"
                );
                let selected = publication.publish(expires()).unwrap();
                assert_eq!(fs::read(f.path("turn-001.json")).unwrap(), transport.output);
                assert_eq!(
                    selected
                        .artifacts
                        .iter()
                        .filter(|d| d.role == "projection")
                        .count(),
                    0
                );
                assert_eq!(
                    publication
                        .exact_consumed(&ack(&publication, &selected.terminal_digest), expires())
                        .unwrap(),
                    selected.terminal_digest
                );
                assert!(
                    publication
                        .exchange_phase(wire::Kind::Projection, &mut transport, expires())
                        .unwrap_err()
                        .contains("phase transition refused")
                );
            }
        }
    }
    // These fixtures isolate the real publisher after preparation. Chunk and
    // phase admission are exercised by Exchange above; populating its validated
    // state directly avoids retaining base64 copies of the large boundary files.
    fn prepare_render_outputs(
        publication: &mut Publication,
        outputs: Vec<(&str, Vec<u8>)>,
        removals: &[&str],
    ) {
        for (name, bytes) in outputs {
            let descriptor = wire::Descriptor {
                name: name.into(),
                role: wire::role(name).unwrap().into(),
                byte_length: bytes.len(),
                sha256: sha(&bytes),
            };
            assert!(wire::target(wire::Kind::Render, &descriptor));
            publication
                .prepared
                .insert(name.into(), (descriptor, bytes));
        }
        publication.removals = removals.iter().map(|name| (*name).into()).collect();
        publication.phases = vec![wire::Kind::Render];
    }
    #[test]
    fn render_new_name_at_artifact_limit_removes_old_before_growth_and_keeps_final_bound() {
        for remove_old in [false, true] {
            let f = Fixture::new();
            fs::write(
                f.path("turn-001.json"),
                vec![b'o'; wire::MAX_ARTIFACT_BYTES],
            )
            .unwrap();
            let mut publication = f.capture();
            let metadata = fs::read(f.path(".meta.json")).unwrap();
            prepare_render_outputs(
                &mut publication,
                vec![("turn-002.json", vec![b'n'; wire::MAX_ARTIFACT_BYTES])],
                if remove_old { &["turn-001.json"] } else { &[] },
            );
            let result = publication.publish(expires());
            if !remove_old {
                assert_eq!(result.unwrap_err(), "published inventory frontier exceeded");
                assert!(!publication.uncertain());
                assert_eq!(
                    fs::read(f.path("turn-001.json")).unwrap(),
                    publication.prior["turn-001.json"].bytes
                );
                assert!(!f.path("turn-002.json").exists());
                assert!(!f.path(MARKER_NAME).exists());
            } else {
                let selected = result.unwrap();
                assert!(!publication.uncertain());
                assert!(!f.path("turn-001.json").exists());
                assert_eq!(
                    fs::read(f.path("turn-002.json")).unwrap(),
                    publication.prepared["turn-002.json"].1
                );
                assert_eq!(
                    selected
                        .artifacts
                        .iter()
                        .map(|d| d.byte_length)
                        .sum::<usize>(),
                    wire::MAX_ARTIFACT_BYTES + metadata.len()
                );
                assert_eq!(selected.artifacts.len(), 2);
                assert_eq!(
                    fs::read(f.path(MARKER_NAME)).unwrap(),
                    selected.marker_bytes().unwrap()
                );
                assert_eq!(
                    publication
                        .exact_consumed(&ack(&publication, &selected.terminal_digest), expires())
                        .unwrap(),
                    selected.terminal_digest
                );
            }
            assert_eq!(fs::read(f.path(".meta.json")).unwrap(), metadata);
            assert!(Arc::ptr_eq(publication.writer(), &f.writer));
        }
    }
    #[test]
    fn render_shrinks_same_name_before_alphabetically_earlier_growth() {
        let f = Fixture::new();
        fs::write(f.path("turn-001.json"), b"a").unwrap();
        fs::write(
            f.path("turn-002.json"),
            vec![b'o'; wire::MAX_ARTIFACT_BYTES],
        )
        .unwrap();
        let retained = vec![b'r'; 1024 * 1024];
        fs::write(f.path("turn-003.json"), &retained).unwrap();
        let mut publication = f.capture();
        let metadata = fs::read(f.path(".meta.json")).unwrap();
        prepare_render_outputs(
            &mut publication,
            vec![
                ("turn-001.json", vec![b'n'; wire::MAX_ARTIFACT_BYTES]),
                ("turn-002.json", b"b".to_vec()),
            ],
            &[],
        );
        // Alphabetical growth first would leave 129MiB plus metadata on disk.
        let selected = publication.publish(expires()).unwrap();
        assert!(!publication.uncertain());
        assert_eq!(
            fs::read(f.path("turn-001.json")).unwrap(),
            publication.prepared["turn-001.json"].1
        );
        assert_eq!(fs::read(f.path("turn-002.json")).unwrap(), b"b");
        assert_eq!(fs::read(f.path("turn-003.json")).unwrap(), retained);
        assert_eq!(fs::read(f.path(".meta.json")).unwrap(), metadata);
        assert_eq!(selected.artifacts.len(), 4);
        assert_eq!(
            publication
                .exact_consumed(&ack(&publication, &selected.terminal_digest), expires())
                .unwrap(),
            selected.terminal_digest
        );
        assert!(Arc::ptr_eq(publication.writer(), &f.writer));
    }
    #[test]
    fn failure_after_actual_removal_keeps_prior_marker_inputs_and_writer_uncertain() {
        let f = Fixture::new();
        fs::write(f.path("turn-001.json"), b"old turn").unwrap();
        let previous = f.capture();
        let artifacts = previous.prior_descriptors();
        let selected = PublishedSelection {
            schema: MARKER_SCHEMA.into(),
            canonical_root: f.root.clone(),
            session_id: "s".into(),
            correlation: previous.correlation.clone(),
            terminal_digest: sha(&serde_json::to_vec(&(
                &previous.correlation,
                "published",
                &artifacts,
            ))
            .unwrap()),
            artifacts,
        };
        let prior_marker = selected.marker_bytes().unwrap();
        fs::write(f.path(MARKER_NAME), &prior_marker).unwrap();
        drop(previous);
        let mut publication = f.capture();
        prepare_render_outputs(
            &mut publication,
            vec![("turn-002.json", b"new turn".to_vec())],
            &["turn-001.json"],
        );
        publication.fail_after_removal = true;
        assert_eq!(
            publication.publish(expires()).unwrap_err(),
            "injected post-removal publication failure"
        );
        assert!(
            !f.path("turn-001.json").exists(),
            "failure must follow the actual unlink and directory sync"
        );
        assert!(!f.path("turn-002.json").exists());
        assert_eq!(fs::read(f.path(MARKER_NAME)).unwrap(), prior_marker);
        assert_eq!(publication.prior["turn-001.json"].bytes, b"old turn");
        assert_eq!(
            fs::read(f.path(".meta.json")).unwrap(),
            publication.prior[".meta.json"].bytes
        );
        assert!(publication.uncertain());
        assert!(publication.published.is_none());
        assert!(Arc::ptr_eq(publication.writer(), &f.writer));
        assert!(
            publication
                .exact_consumed(&ack(&publication, &selected.terminal_digest), expires())
                .is_err()
        );
        assert_eq!(
            publication.publish(expires()).unwrap_err(),
            "publication is not ready"
        );
        assert!(f.journal.has_unknown(expires()).unwrap());
    }
    #[test]
    fn seal_stages_before_effects_and_only_exact_current_generation_can_release_journal() {
        let mut f = Fixture::new();
        let mut publication = f.capture();
        assert!(Arc::ptr_eq(publication.writer(), &f.writer));
        let mut transport = Exchange::new();
        publication
            .exchange_phase(wire::Kind::Seal, &mut transport, expires())
            .unwrap();
        assert_eq!(fs::read(f.path(".meta.json")).unwrap(), b"{\"old\":true}");
        assert!(!f.path(MARKER_NAME).exists());
        let selected = publication.publish(expires()).unwrap();
        assert_eq!(fs::read(f.path(".meta.json")).unwrap(), transport.output);
        assert_eq!(
            fs::read(f.path(MARKER_NAME)).unwrap(),
            selected.marker_bytes().unwrap()
        );
        assert_eq!(selected.artifacts[0].name, ".meta.json");
        assert_eq!(selected.artifacts[0].sha256, sha(&transport.output));
        assert!(
            publication
                .exact_consumed(&ack(&publication, &"f".repeat(64)), expires())
                .is_err()
        );
        let terminal = publication
            .exact_consumed(&ack(&publication, &selected.terminal_digest), expires())
            .unwrap();
        let returned = f
            .journal
            .returned(
                &f.dispatch,
                journal::ReturnedResult::SessionPublication {
                    terminal_digest: terminal.clone(),
                },
                Some(terminal.clone()),
                expires(),
            )
            .unwrap();
        assert!(f.journal.has_unknown(expires()).unwrap());
        f.journal.consume(&returned, &terminal, expires()).unwrap();
        assert!(!f.journal.has_unknown(expires()).unwrap());
        assert!(Arc::ptr_eq(publication.writer(), &f.writer));
    }
    #[test]
    fn changed_input_and_stale_attempt_never_replace_metadata_or_publish_marker() {
        for stale in [false, true] {
            let f = Fixture::new();
            let mut publication = f.capture();
            let mut transport = Exchange::new();
            transport.corrupt = stale;
            if stale {
                assert!(
                    publication
                        .exchange_phase(wire::Kind::Seal, &mut transport, expires())
                        .unwrap_err()
                        .contains("correlation mismatch")
                );
            } else {
                publication
                    .exchange_phase(wire::Kind::Seal, &mut transport, expires())
                    .unwrap();
                fs::write(f.path(".meta.json"), b"{\"foreign\":true}").unwrap();
                assert!(
                    publication
                        .publish(expires())
                        .unwrap_err()
                        .contains("snapshot changed")
                );
            }
            assert!(!f.path(MARKER_NAME).exists());
            assert_eq!(
                fs::read(f.path(".meta.json")).unwrap(),
                if stale {
                    b"{\"old\":true}".as_slice()
                } else {
                    b"{\"foreign\":true}".as_slice()
                }
            );
        }
    }
    #[test]
    fn same_bytes_replaced_marker_artifact_and_symlink_refuse_consumption() {
        for replacement_kind in ["marker", "artifact", "symlink"] {
            let f = Fixture::new();
            let mut publication = f.capture();
            publication
                .exchange_phase(wire::Kind::Seal, &mut Exchange::new(), expires())
                .unwrap();
            let selected = publication.publish(expires()).unwrap();
            if replacement_kind == "marker" {
                let replacement = f.path("replacement");
                fs::write(&replacement, selected.marker_bytes().unwrap()).unwrap();
                fs::rename(&replacement, f.path(MARKER_NAME)).unwrap();
            } else if replacement_kind == "artifact" {
                let replacement = f.path("replacement");
                let original = fs::read(f.path(".meta.json")).unwrap();
                fs::write(&replacement, &original).unwrap();
                fs::rename(&replacement, f.path(".meta.json")).unwrap();
                assert_eq!(fs::read(f.path(".meta.json")).unwrap(), original);
            } else {
                let target = f.root.join("foreign.json");
                fs::write(&target, fs::read(f.path(".meta.json")).unwrap()).unwrap();
                fs::remove_file(f.path(".meta.json")).unwrap();
                symlink(&target, f.path(".meta.json")).unwrap();
            }
            assert!(
                publication
                    .exact_consumed(&ack(&publication, &selected.terminal_digest), expires())
                    .is_err()
            );
            assert!(Arc::ptr_eq(publication.writer(), &f.writer));
        }
    }

    #[test]
    fn native_expiry_or_clock_failure_prevents_publication_directory_creation() {
        use crate::monotonic_deadline::{DeadlineError, effect_test_support::NativeClock};
        for failure in [DeadlineError::Expired, DeadlineError::Clock(libc::EIO)] {
            let f = Fixture::deadline_effect(&format!("capture/{failure:?}"));
            fs::remove_file(f.path(".meta.json")).unwrap();
            fs::remove_dir(f.root.join(".caws/sessions/s")).unwrap();
            fs::remove_dir(f.root.join(".caws/sessions")).unwrap();
            let clock = NativeClock::new("publication.mkdir", failure);
            let check = |at| clock.check(at);
            check("outer").unwrap();
            let error = f
                .capture_checked(&check)
                .err()
                .expect("capture must refuse native clock failure");
            f.evidence("result", &json!({"error":error,"stages":clock.stages.borrow().clone(),"sessionDirectoryExists":f.root.join(".caws/sessions").exists()}));
            assert_eq!(error, failure.to_string());
            assert!(
                !f.root.join(".caws/sessions").exists(),
                "expired capture created directories"
            );
            assert!(clock.stages.borrow().contains(&"publication.mkdir"));
        }
    }
    #[test]
    fn deep_native_check_prevents_rename_and_retains_uncertain_partial_effects() {
        use crate::monotonic_deadline::{DeadlineError, effect_test_support::NativeClock};
        for stage in [
            "publication.effects",
            "publication.rename",
            "publication.sync.after_rename",
            "publication.marker",
        ] {
            for failure in [DeadlineError::Expired, DeadlineError::Clock(libc::EIO)] {
                let f = Fixture::deadline_effect(&format!("{stage}/{failure:?}"));
                let mut publication = f.capture();
                let before = fs::read(f.path(".meta.json")).unwrap();
                let replacement = b"{\"ended\":true}".to_vec();
                {
                    let mut exchange = Exchange::new();
                    exchange.output = replacement.clone();
                    publication
                        .exchange_phase(wire::Kind::Seal, &mut exchange, expires())
                        .unwrap();
                    assert_eq!(publication.phases, vec![wire::Kind::Seal]);
                    assert_eq!(publication.prepared[".meta.json"].1, replacement);
                }
                let clock = NativeClock::new(stage, failure);
                let check = |at| clock.check(at);
                check("outer").unwrap();
                assert_eq!(
                    publication
                        .publish_checked(clock.expires(), &check)
                        .unwrap_err(),
                    failure.to_string()
                );
                assert!(clock.stages.borrow().contains(&stage));
                if matches!(
                    stage,
                    "publication.sync.after_rename" | "publication.marker"
                ) {
                    assert_eq!(
                        fs::read(f.path(".meta.json")).unwrap(),
                        replacement,
                        "post-rename failure must follow an actual visible replacement"
                    );
                } else {
                    assert_eq!(
                        fs::read(f.path(".meta.json")).unwrap(),
                        before,
                        "native failure before rename must retain prior target bytes"
                    );
                }
                assert_eq!(
                    publication.uncertain(),
                    stage != "publication.effects",
                    "pre-effect refusal stays clean; partial effects retain uncertainty"
                );
                assert!(!f.path(MARKER_NAME).exists());
                assert!(publication.published.is_none());
                assert!(Arc::ptr_eq(publication.writer(), &f.writer));
                let names: Vec<_> = fs::read_dir(f.path(".meta.json").parent().unwrap())
                    .unwrap()
                    .map(|entry| entry.unwrap().file_name())
                    .collect();
                assert_eq!(
                    names,
                    vec![std::ffi::OsString::from(".meta.json")],
                    "temporary cleanup must not replace refusal or authorize retry"
                );
                let row = serde_json::json!({"operation":"publication","stage":stage,"failure":failure.to_string(),"stages":clock.stages.borrow().clone(),"metadataBytes":String::from_utf8(fs::read(f.path(".meta.json")).unwrap()).unwrap(),"markerExists":f.path(MARKER_NAME).exists(),"uncertain":publication.uncertain()});
                f.evidence("result", &row);
                eprintln!("CAWS_DEADLINE_EFFECT {}", row);
            }
        }
    }
    #[test]
    fn live_native_checker_publishes_exact_artifacts_and_terminal_marker() {
        use crate::monotonic_deadline::{DeadlineError, effect_test_support::NativeClock};
        let f = Fixture::deadline_effect("live publication");
        let mut publication = f.capture();
        let replacement = b"{\"ended\":true}".to_vec();
        {
            let mut exchange = Exchange::new();
            exchange.output = replacement.clone();
            publication
                .exchange_phase(wire::Kind::Seal, &mut exchange, expires())
                .unwrap();
            assert_eq!(publication.phases, vec![wire::Kind::Seal]);
            assert_eq!(publication.prepared[".meta.json"].1, replacement);
        }
        let clock = NativeClock::new("never", DeadlineError::Expired);
        let selected = publication
            .publish_checked(clock.expires(), &|at| clock.check(at))
            .unwrap();
        assert_eq!(fs::read(f.path(".meta.json")).unwrap(), replacement);
        assert_eq!(
            fs::read(f.path(MARKER_NAME)).unwrap(),
            selected.marker_bytes().unwrap()
        );
        assert!(!publication.uncertain());
        assert_eq!(
            publication.published.as_ref().unwrap().terminal_digest,
            selected.terminal_digest
        );
        for stage in [
            "publication.temporary",
            "publication.write",
            "publication.file.sync",
            "publication.rename",
            "publication.sync.after_rename",
            "publication.committed",
        ] {
            assert!(
                clock.stages.borrow().contains(&stage),
                "positive control missed {stage}"
            );
        }
        f.evidence("result", &json!({"operation":"live publication","terminalDigest":selected.terminal_digest,"stages":clock.stages.borrow().clone(),"uncertain":publication.uncertain()}));
        assert!(Arc::ptr_eq(publication.writer(), &f.writer));
    }
}
