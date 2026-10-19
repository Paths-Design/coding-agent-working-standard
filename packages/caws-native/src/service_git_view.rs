//! Per-request Git metadata for the renderer compatibility profile.
//!
//! Effective configuration is flattened before running metadata commands. The
//! first profile refuses executable helpers, including LFS filters, rather than
//! silently changing their semantics. Objects and worktree files remain live
//! data; this is not an atomic repository snapshot or full Git compatibility.
use crate::renderer_backend::PinnedFile;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
            process::CommandExt,
        },
    },
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const MAX_QUERY: usize = 1_048_576;
const MAX_FILES: usize = 4096;
const MAX_FILE: u64 = 33_554_432;
const MAX_TOTAL: u64 = 67_108_864;
type Result<T> = std::result::Result<T, String>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitView {
    pub git_directory: PathBuf,
    pub git_work_tree: PathBuf,
    pub git_original_directory: PathBuf,
    pub git_common_directory: PathBuf,
    pub metadata_digest: String,
    pub metadata_files: usize,
    pub metadata_bytes: u64,
}

fn check(expires: Instant) -> Result<()> {
    if Instant::now() >= expires {
        Err("Git view deadline expired".into())
    } else {
        Ok(())
    }
}
fn absolute(path: &Path) -> bool {
    path.is_absolute()
        && path
            .to_str()
            .is_some_and(|s| s.len() <= 4096 && !s.contains('\0'))
        && path
            .components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
}
fn stamp(meta: &fs::Metadata) -> (u64, u64, u64, i64, i64, i64, i64) {
    (
        meta.dev(),
        meta.ino(),
        meta.len(),
        meta.mtime(),
        meta.mtime_nsec(),
        meta.ctime(),
        meta.ctime_nsec(),
    )
}
fn bounded_read(path: &Path, limit: u64, expires: Instant) -> Result<Vec<u8>> {
    check(expires)?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| format!("Git metadata open: {e}"))?;
    let before = file.metadata().map_err(|e| e.to_string())?;
    if !before.is_file() || before.len() > limit {
        return Err("Git metadata is not a bounded regular file".into());
    }
    let mut bytes = Vec::new();
    loop {
        check(expires)?;
        let mut buffer = [0u8; 32768];
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() as u64 > limit {
            return Err("Git metadata exceeds byte limit".into());
        }
    }
    if stamp(&before) != stamp(&file.metadata().map_err(|e| e.to_string())?)
        || stamp(&before) != stamp(&fs::symlink_metadata(path).map_err(|e| e.to_string())?)
    {
        return Err("Git metadata changed during capture".into());
    }
    Ok(bytes)
}

// Own every query child through group shutdown and reap, including error paths.
// Unavailable ownership/cleanup retains the child; no hard kernel-stall bound.
struct QueryChild(Option<Child>);
impl QueryChild {
    fn stopped(&self) -> Result<()> {
        let child = self.0.as_ref().ok_or("Git query already reaped")?;
        crate::owned_group::stop_before_reap(child)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    fn finish(&mut self) -> Result<std::process::ExitStatus> {
        self.stopped()?;
        let child = self.0.as_mut().ok_or("Git query already reaped")?;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => thread::sleep(Duration::from_millis(2)),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(format!("Git query reap: {e}")),
            }
        };
        self.0 = None;
        Ok(status)
    }
}
impl Drop for QueryChild {
    fn drop(&mut self) {
        while self.0.is_some() && self.finish().is_err() {
            thread::sleep(Duration::from_millis(10));
        }
    }
}
fn nonblocking(fd: i32) -> Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error().to_string());
    }
    Ok(())
}
fn drain(file: &mut impl Read, output: &mut Vec<u8>) -> Result<bool> {
    for _ in 0..8 {
        let mut buffer = [0u8; 8192];
        match file.read(&mut buffer) {
            Ok(0) => return Ok(true),
            Ok(n) => {
                output.extend_from_slice(&buffer[..n]);
                if output.len() > MAX_QUERY {
                    return Err("Git query output exceeds byte limit".into());
                }
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Ok(false),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(false)
}
fn query(
    git: &PinnedFile,
    checkout: &Path,
    home: &Path,
    args: &[&str],
    expires: Instant,
) -> Result<Vec<u8>> {
    check(expires)?;
    let mut command = Command::new(&git.path);
    command
        .args(["--no-pager", "--no-optional-locks", "-C"])
        .arg(checkout)
        .args(args)
        .env_clear()
        .env("HOME", home)
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        });
    }
    let mut guard = QueryChild(Some(command.spawn().map_err(|e| e.to_string())?));
    let child = guard.0.as_mut().expect("owned query");
    let mut stdout = child.stdout.take().expect("piped query stdout");
    let mut stderr = child.stderr.take().expect("piped query stderr");
    nonblocking(stdout.as_raw_fd())?;
    nonblocking(stderr.as_raw_fd())?;
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut out_done = false;
    let mut err_done = false;
    while !out_done || !err_done {
        check(expires)?;
        if !out_done {
            out_done = drain(&mut stdout, &mut out)?;
        }
        if !err_done {
            err_done = drain(&mut stderr, &mut err)?;
        }
        if !out_done || !err_done {
            thread::sleep(Duration::from_millis(2));
        }
    }
    let status = guard.finish()?;
    if !status.success() || !err.is_empty() {
        return Err(format!(
            "Git metadata query unavailable (status {status}, stderr bytes {})",
            err.len()
        ));
    }
    Ok(out)
}

fn parse_config(bytes: &[u8]) -> Result<Vec<(String, String)>> {
    if bytes.len() > MAX_QUERY || (!bytes.is_empty() && !bytes.ends_with(&[0])) {
        return Err("Git config framing unavailable".into());
    }
    let mut result = Vec::new();
    if bytes.is_empty() {
        return Ok(result);
    }
    for record in bytes[..bytes.len() - 1].split(|b| *b == 0) {
        if result.len() >= 4096 {
            return Err("Git config entry limit exceeded".into());
        }
        let at = record.iter().position(|b| *b == b'\n');
        let key_end = at.unwrap_or(record.len());
        let key = std::str::from_utf8(&record[..key_end])
            .map_err(|_| "Git config key encoding")?
            .to_owned();
        let value = match at {
            Some(at) => std::str::from_utf8(&record[at + 1..])
                .map_err(|_| "Git config value encoding")?
                .to_owned(),
            None => "true".into(),
        };
        if key.is_empty() || key.contains(['\0', '\n', '\r']) {
            return Err("Git config key unavailable".into());
        }
        let disabled = matches!(
            value.to_ascii_lowercase().as_str(),
            "false" | "no" | "off" | "0"
        );
        let comparison = key.to_ascii_lowercase();
        let helper = comparison.starts_with("filter.")
            || comparison == "core.hookspath"
            || comparison == "diff.external"
            || (comparison == "core.fsmonitor" && !disabled)
            || (comparison.starts_with("diff.")
                && (comparison.ends_with(".command") || comparison.ends_with(".textconv")))
            || (comparison == "log.showsignature" && !disabled)
            || comparison == "extensions.partialclone"
            || comparison.ends_with(".promisor")
            || comparison == "extensions.refstorage"
            || comparison == "core.alternaterefscommand";
        if helper {
            return Err(format!("Git compatibility profile does not support {key}"));
        }
        if value.contains('\r') {
            return Err("Git config CR representation unsupported".into());
        }
        result.push((key, value));
    }
    Ok(result)
}
fn quote(value: &str) -> String {
    let mut result = String::from("\"");
    for c in value.chars() {
        match c {
            '\\' => result.push_str("\\\\"),
            '"' => result.push_str("\\\""),
            '\n' => result.push_str("\\n"),
            '\t' => result.push_str("\\t"),
            '\r' => result.push_str("\\r"),
            _ => result.push(c),
        }
    }
    result.push('"');
    result
}
fn flattened_config(entries: &[(String, String)], worktree: &Path) -> Result<Vec<u8>> {
    let mut bytes = String::new();
    for (key, value) in entries {
        // Includes are already flattened. Keep only configuration that affects
        // local read semantics; no remote, credential, alias, pager or helper.
        if key.starts_with("include.") || key.starts_with("includeif.") {
            continue;
        }
        if !(key.starts_with("core.")
            || key.starts_with("extensions.")
            || key.starts_with("diff.")
            || key.starts_with("status.")
            || key.starts_with("log.")
            || key.starts_with("color.")
            || key.starts_with("format."))
        {
            continue;
        }
        if matches!(
            key.as_str(),
            "core.worktree"
                | "core.bare"
                | "core.fsmonitor"
                | "core.hookspath"
                | "extensions.worktreeconfig"
        ) {
            continue;
        }
        let (section, name) = key.rsplit_once('.').ok_or("Git config key unavailable")?;
        if !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err("Git config variable unavailable".into());
        }
        if let Some((section, subsection)) = section.split_once('.') {
            if !section
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            {
                return Err("Git config section unavailable".into());
            }
            bytes.push_str(&format!(
                "[{section} {}]\n\t{name} = {}\n",
                quote(subsection),
                quote(value)
            ));
        } else {
            if !section
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            {
                return Err("Git config section unavailable".into());
            }
            bytes.push_str(&format!("[{section}]\n\t{name} = {}\n", quote(value)));
        }
    }
    bytes.push_str(&format!("[core]\n\tbare = false\n\tworktree = {}\n\tfsmonitor = false\n\thooksPath = {}\n[protocol]\n\tallow = never\n",quote(worktree.to_str().ok_or("Git worktree encoding")?),quote("/dev/null")));
    Ok(bytes.into_bytes())
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}
fn directory(path: &Path) -> Result<()> {
    fs::create_dir(path).map_err(|e| e.to_string())?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())
}
fn metadata_paths(
    root: &Path,
    rel: &Path,
    output: &mut BTreeSet<PathBuf>,
    expires: Instant,
) -> Result<()> {
    check(expires)?;
    let path = root.join(rel);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    if metadata.is_dir() {
        if rel.components().count() > 32 {
            return Err("Git metadata depth exceeded".into());
        }
        for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            metadata_paths(root, &rel.join(entry.file_name()), output, expires)?;
        }
    } else if metadata.is_file() {
        if output.len() >= MAX_FILES {
            return Err("Git metadata file limit exceeded".into());
        }
        output.insert(rel.to_owned());
    } else {
        return Err("Git metadata symlink or special file unsupported".into());
    }
    Ok(())
}

pub fn capture(
    git: &PinnedFile,
    checkout: &Path,
    home: &Path,
    destination: &Path,
    expires: Instant,
) -> Result<GitView> {
    if ![&git.path, checkout, home, destination]
        .into_iter()
        .all(absolute)
    {
        return Err("Git view requires canonical absolute paths".into());
    }
    if fs::canonicalize(checkout).map_err(|e| e.to_string())? != checkout
        || fs::canonicalize(&git.path).map_err(|e| e.to_string())? != git.path
    {
        return Err("Git source/tool path is not canonical".into());
    }
    let tool = bounded_read(&git.path, 134_217_728, expires)?;
    if format!("{:x}", Sha256::digest(tool)) != git.sha256 {
        return Err("Git tool identity changed".into());
    }
    // This builtin reads configuration only; it does not run repository helpers.
    // Do it before rev-parse or any worktree/index operation.
    let config = query(
        git,
        checkout,
        home,
        &["config", "--null", "--list", "--includes"],
        expires,
    )?;
    let entries = parse_config(&config)?;
    let resolve = |args: &[&str]| -> Result<PathBuf> {
        let bytes = query(git, checkout, home, args, expires)?;
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| "Git directory encoding")?
            .strip_suffix('\n')
            .ok_or("Git directory framing")?;
        let source = if Path::new(text).is_absolute() {
            PathBuf::from(text)
        } else {
            checkout.join(text)
        };
        let path = fs::canonicalize(source).map_err(|e| e.to_string())?;
        if !absolute(&path) {
            return Err("Git directory unavailable".into());
        }
        Ok(path)
    };
    let original = resolve(&["rev-parse", "--git-dir"])?;
    let common = resolve(&["rev-parse", "--git-common-dir"])?;
    if fs::symlink_metadata(destination).is_ok() {
        return Err("Git view destination already exists".into());
    }
    directory(destination)?;
    for sub in ["objects", "objects/info", "refs", "hooks", "info"] {
        directory(&destination.join(sub))?;
    }
    write_new(
        &destination.join("config"),
        &flattened_config(&entries, checkout)?,
    )?;
    let objects = fs::canonicalize(common.join("objects")).map_err(|e| e.to_string())?;
    if !absolute(&objects) || !objects.is_dir() {
        return Err("Git object directory unavailable".into());
    }
    write_new(
        &destination.join("objects/info/alternates"),
        format!(
            "{}\n",
            quote(objects.to_str().ok_or("Git objects encoding")?)
        )
        .as_bytes(),
    )?;
    let mut paths = BTreeSet::new();
    for rel in [
        "refs",
        "packed-refs",
        "shallow",
        "info/attributes",
        "info/exclude",
        "info/grafts",
    ] {
        metadata_paths(&common, Path::new(rel), &mut paths, expires)?;
    }
    for entry in fs::read_dir(&original).map_err(|e| e.to_string())? {
        let name = entry.map_err(|e| e.to_string())?.file_name();
        if name.to_str().is_some_and(|s| s.starts_with("sharedindex.")) {
            metadata_paths(&original, Path::new(&name), &mut paths, expires)?;
        }
    }
    let mut digest = Sha256::new();
    let mut total = 0u64;
    let mut files = 0usize;
    for rel in &paths {
        let source = if rel
            .file_name()
            .is_some_and(|s| s.to_string_lossy().starts_with("sharedindex."))
        {
            original.join(rel)
        } else {
            common.join(rel)
        };
        let bytes = bounded_read(&source, MAX_FILE, expires)?;
        total = total
            .checked_add(bytes.len() as u64)
            .ok_or("Git metadata overflow")?;
        if total > MAX_TOTAL {
            return Err("Git metadata total byte limit exceeded".into());
        }
        let target = destination.join(rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        write_new(&target, &bytes)?;
        digest.update(rel.as_os_str().as_encoded_bytes());
        digest.update([0]);
        digest.update(Sha256::digest(&bytes));
        files += 1;
    }
    for rel in ["HEAD", "index", "info/sparse-checkout"] {
        let source = original.join(rel);
        match fs::symlink_metadata(&source) {
            Err(e) if e.kind() == io::ErrorKind::NotFound && rel != "HEAD" => continue,
            Err(e) => return Err(e.to_string()),
            Ok(_) => {}
        }
        let bytes = bounded_read(&source, MAX_FILE, expires)?;
        total += bytes.len() as u64;
        if total > MAX_TOTAL {
            return Err("Git metadata total byte limit exceeded".into());
        }
        write_new(&destination.join(rel), &bytes)?;
        digest.update(rel.as_bytes());
        digest.update([0]);
        digest.update(Sha256::digest(&bytes));
        files += 1;
    }
    if query(
        git,
        checkout,
        home,
        &["config", "--null", "--list", "--includes"],
        expires,
    )? != config
    {
        return Err("Git configuration changed during capture".into());
    }
    digest.update(Sha256::digest(&config));
    check(expires)?;
    File::open(destination)
        .and_then(|file| file.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(GitView {
        git_directory: destination.to_owned(),
        git_work_tree: checkout.to_owned(),
        git_original_directory: original,
        git_common_directory: common,
        metadata_digest: format!("{:x}", digest.finalize()),
        metadata_files: files,
        metadata_bytes: total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture {
        base: PathBuf,
        home: PathBuf,
        checkout: PathBuf,
        git: PinnedFile,
    }
    impl Fixture {
        fn new() -> Self {
            let parent = std::env::var_os("CAWS_NATIVE_TEST_ARTIFACT_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir);
            let base = fs::canonicalize(parent).unwrap().join(format!(
                "git-view-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            directory(&base).unwrap();
            let home = base.join("home");
            let checkout = base.join("checkout");
            directory(&home).unwrap();
            directory(&checkout).unwrap();
            let path = fs::canonicalize("/usr/bin/git").unwrap();
            let git = PinnedFile {
                sha256: format!("{:x}", Sha256::digest(fs::read(&path).unwrap())),
                path,
            };
            let result = Self {
                base,
                home,
                checkout,
                git,
            };
            result.command(&["init", "-b", "main"]);
            fs::write(result.checkout.join("tracked.txt"), b"one\n").unwrap();
            result.command(&["-c", "core.hooksPath=/dev/null", "add", "--", "tracked.txt"]);
            result.command(&[
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "user.name=fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-m",
                "one",
            ]);
            result
        }
        fn command(&self, args: &[&str]) -> Vec<u8> {
            query(
                &self.git,
                &self.checkout,
                &self.home,
                args,
                Instant::now() + Duration::from_secs(10),
            )
            .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if std::env::var_os("CAWS_NATIVE_TEST_ARTIFACT_ROOT").is_some()
                || std::thread::panicking()
            {
                eprintln!("Git view artifacts retained: {}", self.base.display());
            } else {
                let _ = fs::remove_dir_all(&self.base);
            }
        }
    }

    #[test]
    fn captured_git_view_matches_read_results_and_cannot_follow_later_helper_config() {
        let f = Fixture::new();
        fs::write(f.checkout.join("tracked.txt"), b"changed\n").unwrap();
        let expected = f.command(&["status", "--porcelain"]);
        assert_eq!(expected, b" M tracked.txt\n");
        let view = capture(
            &f.git,
            &f.checkout,
            &f.home,
            &f.base.join("view"),
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(view.git_original_directory, f.checkout.join(".git"));
        assert_eq!(view.git_common_directory, view.git_original_directory);
        let actual = f.command(&[
            "--git-dir",
            view.git_directory.to_str().unwrap(),
            "--work-tree",
            f.checkout.to_str().unwrap(),
            "status",
            "--porcelain",
        ]);
        assert_eq!(actual, expected);
        let hook = f.base.join("forbidden-helper");
        fs::write(
            &hook,
            b"#!/bin/sh\nprintf called > \"$HOME/MUST-NOT-EXECUTE\"\nexit 1\n",
        )
        .unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
        f.command(&["config", "core.fsmonitor", hook.to_str().unwrap()]);
        let after = f.command(&[
            "--git-dir",
            view.git_directory.to_str().unwrap(),
            "--work-tree",
            f.checkout.to_str().unwrap(),
            "status",
            "--porcelain",
        ]);
        assert_eq!(after, expected);
        assert!(!f.home.join("MUST-NOT-EXECUTE").exists());
        let refusal = capture(
            &f.git,
            &f.checkout,
            &f.home,
            &f.base.join("refused"),
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap_err();
        assert!(refusal.contains("core.fsmonitor"));
        assert!(!f.base.join("refused").exists());
        let receipt = serde_json::json!({"view":view,"expectedStatusBytes":expected,"actualStatusBytes":actual,"afterSourceHelperChangeStatusBytes":after,"helperExecuted":false,"freshCaptureRefusal":refusal,"atomicRepositorySnapshot":false,"objectDatabaseAndWorktreeRemainLiveData":true});
        fs::write(
            f.base.join("observation.json"),
            serde_json::to_vec_pretty(&receipt).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn linked_worktree_routing_identity_and_head_remain_original_data() {
        let f = Fixture::new();
        let linked = f.base.join("linked");
        f.command(&[
            "-c",
            "core.hooksPath=/dev/null",
            "worktree",
            "add",
            "--quiet",
            "--detach",
            linked.to_str().unwrap(),
        ]);
        let view = capture(
            &f.git,
            &linked,
            &f.home,
            &f.base.join("linked-view"),
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(view.git_work_tree, linked);
        assert_eq!(view.git_common_directory, f.checkout.join(".git"));
        assert_ne!(view.git_original_directory, view.git_common_directory);
        assert!(
            view.git_original_directory
                .starts_with(view.git_common_directory.join("worktrees"))
        );
        assert_eq!(
            fs::read(view.git_directory.join("HEAD")).unwrap(),
            fs::read(view.git_original_directory.join("HEAD")).unwrap()
        );
        assert!(!view.git_directory.join("commondir").exists());
        fs::write(
            f.base.join("linked-observation.json"),
            serde_json::to_vec_pretty(&view).unwrap(),
        )
        .unwrap();
    }
    #[test]
    fn executable_configuration_is_not_silently_disabled() {
        for key in [
            "filter.lfs.process",
            "core.fsmonitor",
            "core.hookspath",
            "diff.custom.textconv",
            "extensions.partialclone",
            "remote.origin.promisor",
            "extensions.refstorage",
        ] {
            let bytes = format!("{key}\nexecutable\0");
            assert!(parse_config(bytes.as_bytes()).unwrap_err().contains(key));
        }
        assert_eq!(
            parse_config(b"core.fsmonitor\nfalse\0core.ignorecase\ntrue\0").unwrap(),
            vec![
                ("core.fsmonitor".into(), "false".into()),
                ("core.ignorecase".into(), "true".into())
            ]
        );
    }
    #[test]
    fn flattened_config_quotes_values_and_removes_live_includes() {
        let entries=parse_config(b"include.path\n/foreign\0core.ignorecase\ntrue\0diff.test.xfuncname\nline\n\"quote\"\\end\0").unwrap();
        let text = String::from_utf8(flattened_config(&entries, Path::new("/work tree")).unwrap())
            .unwrap();
        assert!(!text.contains("/foreign"));
        assert!(text.contains("[diff \"test\"]\n\txfuncname = \"line\\n\\\"quote\\\"\\\\end\""));
        assert!(text.contains("worktree = \"/work tree\""));
        assert!(text.contains("allow = never"));
        assert!(parse_config(b"core.test\nunterminated").is_err());
        assert!(!absolute(Path::new("/bad\0path")));
    }
}
