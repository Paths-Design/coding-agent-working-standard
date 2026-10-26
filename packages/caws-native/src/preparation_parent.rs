//! Offline source preparation transport. Pins establish startup identity only.
//! The fixed TypeScript child re-derives all live project/write authority.
//! This foreground owner is not runtime custody or a durable resume service.
use crate::{
    monotonic_deadline::{DeadlineEnvelope, MonotonicDeadline},
    owned_group,
};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{
            fs::{MetadataExt, OpenOptionsExt},
            net::UnixStream,
            process::CommandExt,
        },
    },
    path::{Component, Path, PathBuf},
    process::{Child, ChildStderr, ChildStdout, Command, Stdio},
    thread,
    time::Duration,
};
type Result<T> = std::result::Result<T, String>;
const FRAME: usize = 16 * 1024 * 1024;
const REQUEST: usize = 64 * 1024;
const METADATA: usize = 1024 * 1024;
const OBJECTS: usize = 512 * 1024 * 1024;
const ENTRY: &str =
    "node_modules/@paths.design/caws-cli/dist/tooling/native-qualification-prepare-entry.js";
const CLI_ENTRY: &str = "node_modules/@paths.design/caws-cli/dist/index.js";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FilePin {
    path: PathBuf,
    size_bytes: u64,
    sha256: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProgramPin {
    path: PathBuf,
    size_bytes: u64,
    sha256: String,
    mode: u32,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TreePin {
    root: PathBuf,
    inventory: FilePin,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitViewPin {
    root: PathBuf,
    inventory: FilePin,
    object_format: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bootstrap {
    schema: String,
    node: ProgramPin,
    git: ProgramPin,
    prefix: TreePin,
    git_view: GitViewPin,
    timeout_ms: u64,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Inventory {
    entry: String,
    prefix: PathBuf,
    rows: Vec<Row>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Row {
    path: String,
    #[serde(rename = "type")]
    kind: String,
    mode: u32,
    sha256: Option<String>,
    size_bytes: Option<u64>,
    target: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source {
    source_root: PathBuf,
    commit: String,
    tree: String,
    object_format: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    schema: String,
    source: Source,
    output_root: PathBuf,
    future_build_root: PathBuf,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    oid: String,
    kind: String,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Rpc {
    Checkpoint {
        seq: u64,
    },
    Metadata {
        seq: u64,
        operation: String,
        cwd: PathBuf,
        #[serde(default)]
        path: Option<String>,
    },
    Objects {
        seq: u64,
        selections: Vec<Selection>,
    },
    Result {
        seq: u64,
        result: Value,
    },
}
impl Rpc {
    fn seq(&self) -> u64 {
        match self {
            Self::Checkpoint { seq }
            | Self::Metadata { seq, .. }
            | Self::Objects { seq, .. }
            | Self::Result { seq, .. } => *seq,
        }
    }
}
fn require(ok: bool, message: &str) -> Result<()> {
    if ok { Ok(()) } else { Err(message.into()) }
}
fn checked(deadline: &MonotonicDeadline) -> Result<()> {
    deadline.check().map_err(|e| e.to_string())
}
fn remaining(deadline: &MonotonicDeadline) -> Result<u64> {
    checked(deadline)?;
    let left = deadline
        .expires()
        .saturating_duration_since(std::time::Instant::now())
        .as_millis();
    require(left > 0, "Original preparation deadline expired")?;
    Ok(left.min(u64::MAX as u128) as u64)
}
fn normalized(path: &Path) -> bool {
    path.is_absolute()
        && path
            .to_str()
            .is_some_and(|s| s.len() <= 4096 && !s.contains('\0'))
        && path
            .components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
        && path
            .to_str()
            .is_some_and(|s| s == "/" || (!s.ends_with('/') && !s.contains("//")))
}
fn physical(path: &Path) -> Result<()> {
    require(normalized(path), "Expected normalized absolute path")?;
    require(
        fs::canonicalize(path).map_err(|e| e.to_string())? == path,
        "Physical path required",
    )
}
fn relative(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.contains('\0')
        && !path.contains('\\')
        && !path.starts_with('/')
        && !path.ends_with('/')
        && !path.contains("//")
        && path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
}
fn oid(oid: &str, format: &str) -> bool {
    let length = match format {
        "sha1" => 40,
        "sha256" => 64,
        _ => return false,
    };
    oid.len() == length
        && oid
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn stamp(m: &fs::Metadata) -> (u64, u64, u64, i64, i64, i64, i64, u32) {
    (
        m.dev(),
        m.ino(),
        m.len(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
        m.mode(),
    )
}
fn read_file(path: &Path, limit: usize, deadline: &MonotonicDeadline) -> Result<Vec<u8>> {
    checked(deadline)?;
    physical(path)?;
    let mut f = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| e.to_string())?;
    let before = f.metadata().map_err(|e| e.to_string())?;
    require(
        before.is_file() && before.len() <= limit as u64,
        "Expected bounded regular file",
    )?;
    let mut bytes = Vec::new();
    loop {
        checked(deadline)?;
        let mut block = [0; 32768];
        let n = f.read(&mut block).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&block[..n]);
        require(bytes.len() <= limit, "File byte limit exceeded")?;
    }
    require(
        stamp(&before) == stamp(&f.metadata().map_err(|e| e.to_string())?)
            && stamp(&before) == stamp(&fs::symlink_metadata(path).map_err(|e| e.to_string())?),
        "File changed during capture",
    )?;
    Ok(bytes)
}
fn check_file(pin: &FilePin, limit: usize, deadline: &MonotonicDeadline) -> Result<Vec<u8>> {
    require(
        pin.sha256.len() == 64
            && pin
                .sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
        "Invalid SHA256 pin",
    )?;
    let bytes = read_file(&pin.path, limit, deadline)?;
    require(
        bytes.len() as u64 == pin.size_bytes && sha(&bytes) == pin.sha256,
        "File pin mismatch",
    )?;
    Ok(bytes)
}
fn check_program(pin: &ProgramPin, deadline: &MonotonicDeadline) -> Result<()> {
    check_file(
        &FilePin {
            path: pin.path.clone(),
            size_bytes: pin.size_bytes,
            sha256: pin.sha256.clone(),
        },
        OBJECTS,
        deadline,
    )?;
    require(
        pin.mode <= 0o777
            && pin.mode & 0o111 != 0
            && fs::symlink_metadata(&pin.path)
                .map_err(|e| e.to_string())?
                .mode()
                & 0o7777
                == pin.mode,
        "Program mode mismatch",
    )
}
fn check_inventory(
    root: &Path,
    pin: &FilePin,
    entry: &str,
    deadline: &MonotonicDeadline,
) -> Result<()> {
    physical(root)?;
    let inv: Inventory =
        serde_json::from_slice(&check_file(pin, FRAME, deadline)?).map_err(|e| e.to_string())?;
    let expected_entry = if entry == "." {
        root.to_path_buf()
    } else {
        root.join(CLI_ENTRY)
    };
    require(
        inv.prefix == root
            && Path::new(&inv.entry) == expected_entry
            && !inv.rows.is_empty()
            && inv.rows.len() <= 200000,
        "Inventory identity/count mismatch",
    )?;
    let mut expected = BTreeMap::new();
    for row in &inv.rows {
        require(
            row.path == "." || relative(&row.path),
            "Invalid inventory relative name",
        )?;
        require(
            row.mode <= 0o777 && expected.insert(row.path.clone(), row).is_none(),
            "Duplicate row or invalid mode",
        )?;
    }
    require(
        expected.get(".").is_some_and(|r| r.kind == "directory"),
        "Inventory root must be a directory",
    )?;
    let mut pending = vec![(root.to_path_buf(), ".".to_owned())];
    let mut seen = BTreeSet::new();
    let mut total = 0u64;
    while let Some((path, name)) = pending.pop() {
        checked(deadline)?;
        require(
            seen.insert(name.clone()) && seen.len() <= 200000,
            "Inventory count exceeded",
        )?;
        let row = expected.get(&name).ok_or("Uninventoried prefix member")?;
        let m = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        require(m.mode() & 0o7777 == row.mode, "Inventory mode mismatch")?;
        if m.is_dir() {
            require(
                row.kind == "directory"
                    && row.sha256.is_none()
                    && row.size_bytes.is_none()
                    && row.target.is_none(),
                "Invalid directory row",
            )?;
            for item in fs::read_dir(&path).map_err(|e| e.to_string())? {
                let item = item.map_err(|e| e.to_string())?;
                let child = item
                    .file_name()
                    .into_string()
                    .map_err(|_| "Non-UTF8 inventory member")?;
                require(
                    relative(&child) && !child.contains('/'),
                    "Invalid prefix child name",
                )?;
                let rel = if name == "." {
                    child
                } else {
                    format!("{name}/{child}")
                };
                pending.push((item.path(), rel));
            }
        } else if m.file_type().is_symlink() {
            require(
                row.kind == "symlink" && row.sha256.is_none() && row.size_bytes.is_none(),
                "Invalid link row",
            )?;
            let target = fs::read_link(&path).map_err(|e| e.to_string())?;
            require(
                !target.is_absolute() && target.to_str() == row.target.as_deref(),
                "Link target mismatch",
            )?;
            // Only genuine relative npm .bin links are admitted; their targets
            // must resolve to inventoried regular files inside this full prefix.
            require(
                path.parent()
                    .and_then(Path::file_name)
                    .is_some_and(|p| p == ".bin"),
                "Only npm .bin symlinks are admitted",
            )?;
            let resolved = fs::canonicalize(&path).map_err(|e| e.to_string())?;
            require(
                resolved.starts_with(root) && resolved != root && resolved.is_file(),
                "Prefix link escapes its root",
            )?;
            let rel = resolved
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_str()
                .ok_or("Non-UTF8 link target")?;
            require(
                expected.get(rel).is_some_and(|r| r.kind == "file"),
                "Uninventoried link target",
            )?;
        } else {
            require(
                m.is_file() && row.kind == "file" && row.target.is_none(),
                "Special prefix member refused",
            )?;
            let size = row.size_bytes.ok_or("File size absent")?;
            total = total.checked_add(size).ok_or("Inventory size overflow")?;
            require(
                total <= 2 * 1024 * 1024 * 1024,
                "Prefix total exceeds bound",
            )?;
            check_file(
                &FilePin {
                    path,
                    size_bytes: size,
                    sha256: row.sha256.clone().ok_or("File hash absent")?,
                },
                OBJECTS,
                deadline,
            )?;
        }
    }
    require(
        seen.len() == expected.len(),
        "Inventory contains absent members",
    )?;
    if entry != "." {
        require(
            expected.get(CLI_ENTRY).is_some_and(|r| r.kind == "file"),
            "CLI entry absent from inventory",
        )?;
        require(
            expected.get(entry).is_some_and(|r| r.kind == "file"),
            "Fixed preparation entry absent from inventory",
        )?;
    }
    Ok(())
}
fn validate_request(bytes: &[u8]) -> Result<Request> {
    require(
        !bytes.is_empty() && bytes.len() <= REQUEST,
        "Expected bounded request",
    )?;
    let req: Request =
        serde_json::from_slice(bytes).map_err(|e| format!("Invalid preparation request: {e}"))?;
    require(
        req.schema == "caws.frozen_source_preparation.v1",
        "Unsupported request schema",
    )?;
    require(
        normalized(&req.source.source_root)
            && normalized(&req.output_root)
            && normalized(&req.future_build_root),
        "Invalid request path",
    )?;
    require(
        oid(&req.source.commit, &req.source.object_format)
            && oid(&req.source.tree, &req.source.object_format),
        "Invalid source object identity",
    )?;
    Ok(req)
}
fn bootstrap(text: Option<&str>) -> Result<Bootstrap> {
    let text = text.ok_or("Unconfigured preparation bootstrap; no child started")?;
    require(text.len() <= FRAME, "Bootstrap record exceeds bound")?;
    let pin: Bootstrap =
        serde_json::from_str(text).map_err(|e| format!("Invalid bootstrap: {e}"))?;
    require(
        pin.schema == "caws.preparation.bootstrap.v1" && (1..=120000).contains(&pin.timeout_ms),
        "Invalid bootstrap schema/deadline",
    )?;
    require(
        matches!(pin.git_view.object_format.as_str(), "sha1" | "sha256"),
        "Invalid private Git object format",
    )?;
    Ok(pin)
}
fn startup_environment() -> Result<BTreeMap<String, String>> {
    startup_environment_from(env::vars_os())
}
fn startup_environment_from(
    values: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> Result<BTreeMap<String, String>> {
    let mut identity = BTreeMap::new();
    for (name, value) in values {
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.starts_with("NODE_") || name.starts_with("DYLD_") || name.starts_with("LD_") {
            return Err(format!("Startup injection variable refused: {name}"));
        }
        if matches!(
            name,
            "CAWS_SESSION_ID"
                | "CAWS_AGENT_SURFACE"
                | "CAWS_PLATFORM_FLAG"
                | "CLAUDE_SESSION_ID"
                | "CLAUDE_CODE_SESSION_ID"
                | "CODEX_THREAD_ID"
                | "QWEN_CODE_SESSION_ID"
                | "DSH_SESSION_ID"
                | "HOOK_SESSION_ID"
        ) {
            let value = value.to_str().ok_or("Non-UTF8 identity environment")?;
            require(
                value.len() <= 4096 && !value.contains('\0'),
                "Identity environment exceeds bound",
            )?;
            identity.insert(name.into(), value.into());
        }
    }
    Ok(identity)
}
fn nonblocking(fd: i32) -> Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    require(
        flags >= 0 && unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } >= 0,
        "Cannot set nonblocking descriptor",
    )
}
fn pause(deadline: &MonotonicDeadline) -> Result<()> {
    checked(deadline)?;
    thread::sleep(Duration::from_millis(1));
    checked(deadline)
}
/// The direct Child remains retained until settlement, output EOF and reap.
/// A refused cleanup is returned to the foreground owner with this handle live.
struct OwnedChild {
    child: Option<Child>,
    stdout: ChildStdout,
    stderr: ChildStderr,
    out: Vec<u8>,
    err: Vec<u8>,
    out_eof: bool,
    err_eof: bool,
    pipes_ready: bool,
}
fn drain(reader: &mut impl Read, bytes: &mut Vec<u8>, limit: usize) -> Result<bool> {
    for _ in 0..8 {
        let mut block = [0; 32768];
        match reader.read(&mut block) {
            Ok(0) => return Ok(true),
            Ok(n) => {
                bytes.extend_from_slice(&block[..n]);
                require(bytes.len() <= limit, "Child output exceeds bound")?;
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Ok(false),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(false)
}
impl OwnedChild {
    fn new(mut child: Child) -> Self {
        // Both fixed starters always request these pipes. No fallible operation
        // occurs between receiving Child and retaining it in this owner.
        let stdout = child.stdout.take().expect("fixed starter stdout");
        let stderr = child.stderr.take().expect("fixed starter stderr");
        Self {
            child: Some(child),
            stdout,
            stderr,
            out: vec![],
            err: vec![],
            out_eof: false,
            err_eof: false,
            pipes_ready: false,
        }
    }
    fn prepare_pipes(&mut self) -> Result<()> {
        nonblocking(self.stdout.as_raw_fd())?;
        nonblocking(self.stderr.as_raw_fd())?;
        self.pipes_ready = true;
        Ok(())
    }
    fn drain(&mut self, limit: usize) -> Result<()> {
        require(
            self.pipes_ready,
            "Child pipe nonblocking profile unavailable; custody retained",
        )?;
        if !self.out_eof {
            self.out_eof = drain(&mut self.stdout, &mut self.out, limit)?;
        }
        if !self.err_eof {
            self.err_eof = drain(&mut self.stderr, &mut self.err, METADATA)?;
        }
        Ok(())
    }
    fn finish(&mut self, deadline: &MonotonicDeadline, limit: usize, stop: bool) -> Result<i32> {
        if self.child.is_none() {
            return Err("Already reaped child".into());
        }
        if stop {
            checked(deadline)?;
            owned_group::stop_before_reap(self.child.as_ref().unwrap())
                .map_err(|e| e.to_string())?;
        }
        require(
            self.pipes_ready,
            "Child pipe nonblocking profile unavailable; custody retained",
        )?;
        loop {
            checked(deadline)?;
            self.drain(limit)?;
            match owned_group::settlement_before_reap(self.child.as_ref().unwrap())
                .map_err(|e| e.to_string())?
            {
                owned_group::GroupSettlement::Exited { .. } if self.out_eof && self.err_eof => {
                    checked(deadline)?;
                    return self.reap_observed_child(deadline);
                }
                _ => pause(deadline)?,
            }
        }
    }
    fn reap_observed_child(&mut self, deadline: &MonotonicDeadline) -> Result<i32> {
        // Called only after group settlement and both output EOFs. Keep the
        // actual reap fact even if scheduling or the syscall crosses expiry.
        let status = self
            .child
            .as_mut()
            .ok_or("Already reaped child")?
            .wait()
            .map_err(|e| e.to_string())?;
        self.child = None;
        checked(deadline)?;
        Ok(status.code().unwrap_or(-1))
    }
}
// Do not implement Drop that signals/reaps or starts a renewed cleanup budget.
// PreparationFailure carries unreaped owners to the foreground binary.

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct FdInfo {
    fd: i32,
    kind: u32,
}
const MAX_OPEN_FDS: usize = 16384;
fn fd_count(bytes: i32, capacity: usize) -> io::Result<usize> {
    let width = std::mem::size_of::<FdInfo>();
    if bytes <= 0 || bytes as usize >= capacity * width || bytes as usize % width != 0 {
        return Err(io::Error::from_raw_os_error(libc::EOVERFLOW));
    }
    Ok(bytes as usize / width)
}
/// Called only after fork, with a preallocated buffer and no other child
/// threads. A complete live descriptor snapshot replaces the unbounded hard
/// RLIMIT (Darwin commonly reports infinity). Full/refused snapshots fail shut.
#[cfg(target_os = "macos")]
fn close_profile(rows: &mut [FdInfo], inherited: Option<i32>) -> io::Result<()> {
    let bytes = unsafe {
        libc::proc_pidinfo(
            libc::getpid(),
            libc::PROC_PIDLISTFDS,
            0,
            rows.as_mut_ptr().cast(),
            std::mem::size_of_val(rows) as i32,
        )
    };
    let count = fd_count(bytes, rows.len())?;
    let mut inherited_seen = inherited.is_none();
    for row in &rows[..count] {
        if row.fd < 0 {
            return Err(io::Error::from_raw_os_error(libc::EINVAL));
        }
        if row.fd < 3 {
            continue;
        }
        let flags = unsafe { libc::fcntl(row.fd, libc::F_GETFD) };
        if flags < 0 {
            return Err(io::Error::last_os_error());
        }
        let wanted = if Some(row.fd) == inherited {
            inherited_seen = true;
            flags & !libc::FD_CLOEXEC
        } else {
            flags | libc::FD_CLOEXEC
        };
        if unsafe { libc::fcntl(row.fd, libc::F_SETFD, wanted) } < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    if !inherited_seen {
        return Err(io::Error::from_raw_os_error(libc::EBADF));
    }
    Ok(())
}
#[cfg(not(target_os = "macos"))]
fn close_profile(_rows: &mut [FdInfo], _inherited: Option<i32>) -> io::Result<()> {
    Err(io::Error::from_raw_os_error(libc::ENOTSUP))
}
fn spawn_fixed(
    program: &ProgramPin,
    args: &[String],
    cwd: &Path,
    extra: &[(String, String)],
    inherited: Option<i32>,
    deadline: &MonotonicDeadline,
) -> Result<Child> {
    checked(deadline)?;
    check_program(program, deadline)?;
    let mut descriptors = vec![FdInfo::default(); MAX_OPEN_FDS];
    let mut cmd = Command::new(&program.path);
    cmd.args(args)
        .current_dir(cwd)
        .env_clear()
        .env("LANG", "C")
        .env("LC_ALL", "C")
        .env("TZ", "UTC")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in extra {
        cmd.env(key, value);
    }
    unsafe {
        cmd.pre_exec(move || {
            if libc::setpgid(0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            // Preserve Rust's private exec-error pipe until exec, while preventing
            // every ambient descriptor from reaching the fixed executable.
            close_profile(&mut descriptors, inherited)
        });
    }
    checked(deadline)?;
    cmd.spawn().map_err(|e| format!("Pinned child spawn: {e}"))
}
struct Channel {
    socket: UnixStream,
    input: Vec<u8>,
    eof: bool,
}
impl Channel {
    fn read(&mut self, node: &mut OwnedChild, deadline: &MonotonicDeadline) -> Result<Value> {
        loop {
            checked(deadline)?;
            node.drain(METADATA)?;
            if self.input.len() >= 4 {
                let length = u32::from_be_bytes(self.input[..4].try_into().unwrap()) as usize;
                require(length > 0 && length <= FRAME, "Invalid parent frame length")?;
                if self.input.len() >= length + 4 {
                    let value = serde_json::from_slice(&self.input[4..4 + length])
                        .map_err(|e| format!("Invalid RPC JSON: {e}"))?;
                    self.input.drain(..length + 4);
                    return Ok(value);
                }
            }
            require(!self.eof, "Child channel EOF before terminal result")?;
            let mut block = [0; 32768];
            match self.socket.read(&mut block) {
                Ok(0) => self.eof = true,
                Ok(n) => {
                    self.input.extend_from_slice(&block[..n]);
                    require(self.input.len() <= FRAME + 4, "Input frame exceeds bound")?;
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => pause(deadline)?,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e.to_string()),
            }
        }
    }
    fn write(
        &mut self,
        value: &Value,
        node: &mut OwnedChild,
        deadline: &MonotonicDeadline,
    ) -> Result<()> {
        let payload = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        require(
            !payload.is_empty() && payload.len() <= FRAME,
            "Output frame exceeds bound",
        )?;
        let mut frame = Vec::with_capacity(payload.len() + 4);
        frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        frame.extend(payload);
        let mut offset = 0;
        while offset < frame.len() {
            checked(deadline)?;
            node.drain(METADATA)?;
            match self
                .socket
                .write(&frame[offset..(offset + 32768).min(frame.len())])
            {
                Ok(0) => return Err("Parent channel closed during write".into()),
                Ok(n) => offset += n,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => pause(deadline)?,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(())
    }
    fn terminal_eof(&mut self, node: &mut OwnedChild, deadline: &MonotonicDeadline) -> Result<()> {
        require(
            self.input.is_empty(),
            "Trailing child frames after terminal result",
        )?;
        while !self.eof {
            checked(deadline)?;
            node.drain(METADATA)?;
            let mut byte = [0];
            match self.socket.read(&mut byte) {
                Ok(0) => self.eof = true,
                Ok(_) => return Err("Trailing child bytes after terminal result".into()),
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => pause(deadline)?,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(())
    }
}
#[derive(Clone)]
struct MetadataPin {
    path: PathBuf,
    bytes: Option<Vec<u8>>,
}
impl MetadataPin {
    fn capture(path: PathBuf, deadline: &MonotonicDeadline) -> Result<Self> {
        let bytes = match fs::symlink_metadata(&path) {
            Ok(_) => Some(read_file(&path, METADATA, deadline)?),
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.to_string()),
        };
        Ok(Self { path, bytes })
    }
    fn check(&self, deadline: &MonotonicDeadline) -> Result<()> {
        let current = Self::capture(self.path.clone(), deadline)?;
        require(self.bytes == current.bytes, "Source configuration changed")
    }
}
#[derive(Clone)]
struct SourceGit {
    top: PathBuf,
    git_dir: PathBuf,
    common: PathBuf,
    pins: Vec<MetadataPin>,
}
fn admitted_metadata_roots(
    cwd: &Path,
    caller: SourceGit,
    source: &SourceGit,
    canonical: SourceGit,
) -> BTreeMap<PathBuf, SourceGit> {
    // The caller, source and canonical observations have already been checked
    // against the same physical common store. The fixed ignore query uses the
    // caller's worktree root even when the process starts in a subdirectory.
    BTreeMap::from([
        (caller.top.clone(), caller.clone()),
        (cwd.to_path_buf(), caller),
        (source.top.clone(), source.clone()),
        (canonical.top.clone(), canonical),
    ])
}
fn locate_git(cwd: &Path, deadline: &MonotonicDeadline) -> Result<SourceGit> {
    physical(cwd)?;
    require(cwd.is_dir(), "Metadata cwd must be a directory")?;
    for top in cwd.ancestors().take(128) {
        checked(deadline)?;
        let marker = top.join(".git");
        let m = match fs::symlink_metadata(&marker) {
            Ok(m) => m,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.to_string()),
        };
        let mut pins = vec![];
        let git_dir = if m.is_dir() {
            physical(&marker)?;
            marker
        } else {
            require(
                m.is_file(),
                "Source .git must be directory or ordinary gitfile",
            )?;
            let pin = MetadataPin::capture(marker, deadline)?;
            let text =
                std::str::from_utf8(pin.bytes.as_ref().unwrap()).map_err(|e| e.to_string())?;
            let target = text
                .strip_prefix("gitdir: ")
                .and_then(|s| s.strip_suffix('\n'))
                .ok_or("Malformed source gitfile")?;
            require(
                !target.contains(['\n', '\r', '\0']),
                "Malformed source gitfile target",
            )?;
            let path = Path::new(target);
            let resolved = fs::canonicalize(if path.is_absolute() {
                path.to_path_buf()
            } else {
                top.join(path)
            })
            .map_err(|e| e.to_string())?;
            physical(&resolved)?;
            pins.push(pin);
            resolved
        };
        require(git_dir.is_dir(), "Git metadata directory missing")?;
        let common_pin = MetadataPin::capture(git_dir.join("commondir"), deadline)?;
        let common = match &common_pin.bytes {
            None => git_dir.clone(),
            Some(bytes) => {
                let text = std::str::from_utf8(bytes).map_err(|e| e.to_string())?;
                let target = text.strip_suffix('\n').ok_or("Malformed commondir")?;
                require(
                    !target.is_empty() && !target.contains(['\0', '\r', '\n']),
                    "Malformed common directory target",
                )?;
                fs::canonicalize(git_dir.join(target)).map_err(|e| e.to_string())?
            }
        };
        physical(&common)?;
        require(common.is_dir(), "Source common directory missing")?;
        pins.push(common_pin);
        pins.push(MetadataPin::capture(common.join("config"), deadline)?);
        pins.push(MetadataPin::capture(
            git_dir.join("config.worktree"),
            deadline,
        )?);
        require(
            pins[pins.len() - 2].bytes.is_some(),
            "Common Git config required",
        )?;
        physical(&common.join("objects"))?;
        for name in ["alternates", "http-alternates"] {
            require(
                fs::symlink_metadata(common.join("objects/info").join(name))
                    .is_err_and(|e| e.kind() == io::ErrorKind::NotFound),
                "Object alternates refused",
            )?;
            pins.push(MetadataPin::capture(
                common.join("objects/info").join(name),
                deadline,
            )?);
        }
        return Ok(SourceGit {
            top: top.to_path_buf(),
            git_dir,
            common,
            pins,
        });
    }
    Err("Cannot locate ordinary source Git metadata".into())
}
fn safe_config(bytes: &[u8]) -> Result<()> {
    require(bytes.len() <= METADATA, "Config output exceeds bound")?;
    for record in bytes.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        let key = record.split(|b| *b == b'\n').next().unwrap();
        let key = std::str::from_utf8(key)
            .map_err(|e| e.to_string())?
            .to_ascii_lowercase();
        // These fixed builtin queries perform no fetch, push or hook dispatch.
        // Ordinary remote location/refspec metadata is inert here; promisor
        // and transport/helper configuration remain outside this profile.
        if key.starts_with("remote.") {
            let leaf = key.rsplit('.').next().unwrap_or("");
            require(
                matches!(
                    leaf,
                    "url" | "fetch" | "pushurl" | "push" | "mirror" | "tagopt"
                ),
                "Remote executable/lazy-fetch configuration refused",
            )?;
            continue;
        }
        require(
            !key.starts_with("include.")
                && !key.starts_with("includeif.")
                && !key.starts_with("filter.")
                && !key.starts_with("alias.")
                && !key.starts_with("credential.")
                && !key.starts_with("url.")
                && !key.starts_with("protocol.")
                && !key.starts_with("submodule.")
                && !key.starts_with("diff.")
                && !key.starts_with("merge.")
                && !key.starts_with("pager.")
                && !matches!(
                    key.as_str(),
                    "core.fsmonitor"
                        | "core.sshcommand"
                        | "core.gitproxy"
                        | "core.worktree"
                        | "core.alternaterefscommand"
                        | "core.pager"
                        | "core.editor"
                        | "core.excludesfile"
                        | "core.attributesfile"
                        | "extensions.partialclone"
                ),
            "Source Git config contains unsupported executable/redirect/include family",
        )?;
    }
    Ok(())
}
fn safe_worktree_config(bytes: &[u8]) -> Result<()> {
    safe_config(bytes)?;
    for record in bytes.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        let key = record.split(|b| *b == b'\n').next().unwrap();
        let key = std::str::from_utf8(key)
            .map_err(|e| e.to_string())?
            .to_ascii_lowercase();
        // These index/sparse-working-file settings cannot affect rev-parse,
        // raw cat-file, or check-ignore --no-index. Refuse every other setting
        // rather than silently change effective source/ignore semantics.
        require(
            matches!(
                key.as_str(),
                "core.sparsecheckout" | "core.sparsecheckoutcone" | "index.sparse"
            ),
            "Unsupported semantic worktree configuration",
        )?;
    }
    Ok(())
}
fn git_env() -> Vec<(String, String)> {
    [
        ("GIT_CONFIG_NOSYSTEM", "1"),
        ("GIT_CONFIG_SYSTEM", "/dev/null"),
        ("GIT_CONFIG_GLOBAL", "/dev/null"),
        ("GIT_TERMINAL_PROMPT", "0"),
        ("GIT_NO_REPLACE_OBJECTS", "1"),
        ("GIT_NO_LAZY_FETCH", "1"),
        ("GIT_OPTIONAL_LOCKS", "0"),
        ("GIT_ATTR_NOSYSTEM", "1"),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .collect()
}
fn private_git_args(view: &Path) -> Vec<String> {
    vec![
        "--no-pager".into(),
        "--no-optional-locks".into(),
        format!("--git-dir={}", view.display()),
        "--bare".into(),
        "-c".into(),
        "core.bare=true".into(),
        "-c".into(),
        "core.hooksPath=/dev/null".into(),
        "-c".into(),
        "core.fsmonitor=false".into(),
        "-c".into(),
        "extensions.worktreeConfig=false".into(),
    ]
}
struct Parent {
    bootstrap: Bootstrap,
    deadline: MonotonicDeadline,
    node: OwnedChild,
    queries: Vec<OwnedChild>,
    channel: Channel,
    roots: BTreeMap<PathBuf, SourceGit>,
    source: SourceGit,
    observed_result: Option<Value>,
}
impl Parent {
    fn query(
        &mut self,
        args: Vec<String>,
        cwd: &Path,
        extra: Vec<(String, String)>,
        input: Option<Vec<u8>>,
        limit: usize,
    ) -> Result<(i32, Vec<u8>, Vec<u8>)> {
        checked(&self.deadline)?;
        let mut child = spawn_git(
            &self.bootstrap.git,
            &args,
            cwd,
            &extra,
            input.is_some(),
            &self.deadline,
        )?;
        let mut writer = child.stdin.take();
        let owner = OwnedChild::new(child);
        self.queries.push(owner);
        let index = self.queries.len() - 1;
        let mut offset = 0;
        self.queries[index].prepare_pipes()?;
        if let Some(ref pipe) = writer {
            nonblocking(pipe.as_raw_fd())?;
        }
        loop {
            checked(&self.deadline)?;
            self.node.drain(METADATA)?;
            self.queries[index].drain(limit)?;
            if let Some(bytes) = input.as_ref() {
                if offset < bytes.len() {
                    match writer
                        .as_mut()
                        .ok_or("Missing Git batch stdin")?
                        .write(&bytes[offset..(offset + 32768).min(bytes.len())])
                    {
                        Ok(0) => return Err("Git batch input closed".into()),
                        Ok(n) => offset += n,
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                        Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                        Err(e) => return Err(e.to_string()),
                    }
                }
                if offset == bytes.len() {
                    writer.take();
                }
            }
            let owner = &mut self.queries[index];
            if owner.out_eof && owner.err_eof {
                let code = owner.finish(&self.deadline, limit, false)?;
                let out = std::mem::take(&mut owner.out);
                let err = std::mem::take(&mut owner.err);
                require(
                    (0..=255).contains(&code),
                    "Git terminated without an ordinary exit code",
                )?;
                require(
                    out.len().checked_add(err.len()).is_some_and(|n| n <= limit),
                    "Combined Git output exceeds bound",
                )?;
                self.queries.pop();
                return Ok((code, out, err));
            }
            pause(&self.deadline)?;
        }
    }
    fn check_source_pins(&self, source: &SourceGit) -> Result<()> {
        for pin in &source.pins {
            pin.check(&self.deadline)?;
        }
        Ok(())
    }
    fn admit_source(&mut self, source: &SourceGit) -> Result<()> {
        self.check_source_pins(source)?;
        for pin in source.pins.iter().filter(|p| {
            p.path
                .file_name()
                .is_some_and(|s| s == "config" || s == "config.worktree")
                && p.bytes.is_some()
        }) {
            let mut args = private_git_args(&self.bootstrap.git_view.root);
            args.extend([
                "config".into(),
                "--no-includes".into(),
                "--null".into(),
                "--list".into(),
                "--file".into(),
                pin.path.to_string_lossy().into_owned(),
            ]);
            let (code, out, _) = self.query(
                args,
                &self.bootstrap.git_view.root.clone(),
                git_env(),
                None,
                METADATA,
            )?;
            require(code == 0, "Source config parser refused")?;
            safe_config(&out)?;
            if pin.path.file_name().is_some_and(|s| s == "config.worktree") {
                safe_worktree_config(&out)?;
            }
        }
        self.check_source_pins(source)
    }
    fn metadata(
        &mut self,
        operation: &str,
        cwd: &Path,
        path: Option<&str>,
    ) -> Result<(i32, Vec<u8>, Vec<u8>)> {
        let source = self
            .roots
            .get(cwd)
            .cloned()
            .ok_or("Unadmitted metadata cwd")?;
        self.admit_source(&source)?;
        let mut args = vec!["--no-pager".into(), "--no-optional-locks".into()];
        // Explicit fixed directories avoid source discovery and ambient redirects.
        args.extend([
            format!("--git-dir={}", source.git_dir.display()),
            format!("--work-tree={}", source.top.display()),
        ]);
        // Every common/per-worktree config was parsed without following
        // includes. Disable Git's implicit worktree-config routing and helper
        // paths; only the explicitly selected builtin operation can execute.
        args.extend([
            "-c".into(),
            "extensions.worktreeConfig=false".into(),
            "-c".into(),
            "core.hooksPath=/dev/null".into(),
            "-c".into(),
            "core.fsmonitor=false".into(),
        ]);
        let exact: Vec<String> = match operation {
            "commonDir" => vec![
                "rev-parse".into(),
                "--path-format=absolute".into(),
                "--git-common-dir".into(),
            ],
            "topLevel" => vec!["rev-parse".into(), "--show-toplevel".into()],
            "objectFormat" => vec!["rev-parse".into(), "--show-object-format".into()],
            "headCommit" => vec![
                "rev-parse".into(),
                "--verify".into(),
                "HEAD^{commit}".into(),
            ],
            "headTree" => vec!["rev-parse".into(), "--verify".into(), "HEAD^{tree}".into()],
            "ignored" => {
                let p = path.ok_or("Ignored query path absent")?;
                require(relative(p), "Ignored query path must be relative")?;
                vec![
                    "check-ignore".into(),
                    "--quiet".into(),
                    "--no-index".into(),
                    "--".into(),
                    p.into(),
                ]
            }
            _ => return Err("Unknown metadata operation".into()),
        };
        require(
            operation == "ignored" || path.is_none(),
            "Unexpected metadata path",
        )?;
        args.extend(exact);
        let result = self.query(args, cwd, git_env(), None, METADATA)?;
        self.check_source_pins(&source)?;
        Ok(result)
    }
    fn objects(&mut self, seq: u64, selections: Vec<Selection>) -> Result<()> {
        require(
            !selections.is_empty() && selections.len() <= 50000,
            "Object selection count invalid",
        )?;
        let mut input = Vec::new();
        for selection in selections {
            require(
                oid(&selection.oid, &self.bootstrap.git_view.object_format)
                    && matches!(selection.kind.as_str(), "commit" | "tree" | "blob"),
                "Invalid object selection",
            )?;
            input.extend_from_slice(selection.oid.as_bytes());
            input.push(b'\n');
        }
        let source = self.source.clone();
        self.admit_source(&source)?;
        let mut args = private_git_args(&self.bootstrap.git_view.root);
        args.extend(["cat-file".into(), "--batch".into()]);
        let mut extra = git_env();
        extra.push((
            "GIT_OBJECT_DIRECTORY".into(),
            source.common.join("objects").to_string_lossy().into_owned(),
        ));
        let (code, out, err) = self.query(
            args,
            &self.bootstrap.git_view.root.clone(),
            extra,
            Some(input),
            OBJECTS,
        )?;
        self.check_source_pins(&source)?;
        for chunk in out.chunks(256 * 1024) {
            self.channel.write(
                &json!({"kind":"objectChunk","seq":seq,"data":B64.encode(chunk)}),
                &mut self.node,
                &self.deadline,
            )?;
        }
        self.channel.write(
            &json!({"kind":"objectEnd","seq":seq,"exitCode":code,"stderr":B64.encode(err)}),
            &mut self.node,
            &self.deadline,
        )
    }
    fn serve(&mut self, start: Value) -> Result<Value> {
        self.node.prepare_pipes()?;
        // The reviewed private view is pre-existing and format-matched before
        // the child receives any request bytes or can request object reads.
        let mut format_args = private_git_args(&self.bootstrap.git_view.root);
        format_args.extend(["rev-parse".into(), "--show-object-format".into()]);
        let (code, format, _) = self.query(
            format_args,
            &self.bootstrap.git_view.root.clone(),
            git_env(),
            None,
            METADATA,
        )?;
        require(
            code == 0
                && format == format!("{}\n", self.bootstrap.git_view.object_format).as_bytes(),
            "Private Git object format mismatch",
        )?;
        self.channel.write(&start, &mut self.node, &self.deadline)?;
        let mut next = 1u64;
        loop {
            let raw = self.channel.read(&mut self.node, &self.deadline)?;
            let rpc: Rpc = serde_json::from_value(raw)
                .map_err(|e| format!("Unknown/malformed child RPC: {e}"))?;
            require(rpc.seq() == next, "Uncorrelated child RPC sequence")?;
            next = next.checked_add(1).ok_or("RPC sequence overflow")?;
            match rpc {
                Rpc::Checkpoint { seq } => self.channel.write(
                    &json!({"kind":"ok","seq":seq,"remainingMs":remaining(&self.deadline)?}),
                    &mut self.node,
                    &self.deadline,
                )?,
                Rpc::Metadata {
                    seq,
                    operation,
                    cwd,
                    path,
                } => {
                    let (code, out, err) = self.metadata(&operation, &cwd, path.as_deref())?;
                    self.channel.write(&json!({"kind":"gitResult","seq":seq,"exitCode":code,"stdout":B64.encode(out),"stderr":B64.encode(err)}),&mut self.node,&self.deadline)?;
                }
                Rpc::Objects { seq, selections } => self.objects(seq, selections)?,
                Rpc::Result { result, .. } => {
                    require(
                        result.is_object() && result.get("adoption") == Some(&json!("NOT_ADOPTED")),
                        "Invalid terminal result adoption",
                    )?;
                    require(
                        matches!(
                            result.get("status").and_then(Value::as_str),
                            Some("prepared" | "failed")
                        ),
                        "Invalid terminal result status",
                    )?;
                    self.observed_result = Some(result.clone());
                    self.channel.terminal_eof(&mut self.node, &self.deadline)?;
                    let code = self.node.finish(&self.deadline, METADATA, false)?;
                    let expected =
                        if result.get("status").and_then(Value::as_str) == Some("prepared") {
                            0
                        } else {
                            2
                        };
                    require(
                        code == expected && self.node.out.is_empty(),
                        "Node exit/output refused",
                    )?;
                    return Ok(result);
                }
            }
        }
    }
}
fn spawn_git(
    program: &ProgramPin,
    args: &[String],
    cwd: &Path,
    extra: &[(String, String)],
    input: bool,
    deadline: &MonotonicDeadline,
) -> Result<Child> {
    // Keep the same closed starter; only stdin plumbing differs from Node.
    checked(deadline)?;
    check_program(program, deadline)?;
    let mut descriptors = vec![FdInfo::default(); MAX_OPEN_FDS];
    let mut command = Command::new(&program.path);
    command
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .env("LANG", "C")
        .env("LC_ALL", "C")
        .env("TZ", "UTC")
        .stdin(if input { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in extra {
        command.env(k, v);
    }
    unsafe {
        command.pre_exec(move || {
            if libc::setpgid(0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            close_profile(&mut descriptors, None)
        });
    }
    checked(deadline)?;
    command.spawn().map_err(|e| e.to_string())
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalFacts {
    pub node_started: bool,
    pub checkpoint_closed: bool,
    pub node_stdout_eof: bool,
    pub node_stderr_eof: bool,
    pub node_reaped: bool,
    pub groups_settled: bool,
    pub parent_loss_settlement: &'static str,
}
impl TerminalFacts {
    fn not_started() -> Self {
        Self {
            node_started: false,
            checkpoint_closed: true,
            node_stdout_eof: false,
            node_stderr_eof: false,
            node_reaped: false,
            groups_settled: false,
            parent_loss_settlement: "UNQUALIFIED",
        }
    }
    fn observed(parent: &Parent, closed: bool) -> Self {
        Self::children(&parent.node, &parent.queries, closed)
    }
    fn children(node: &OwnedChild, queries: &[OwnedChild], closed: bool) -> Self {
        Self {
            node_started: true,
            checkpoint_closed: closed,
            node_stdout_eof: node.out_eof,
            node_stderr_eof: node.err_eof,
            node_reaped: node.child.is_none(),
            groups_settled: node.child.is_none() && queries.iter().all(|c| c.child.is_none()),
            parent_loss_settlement: "UNQUALIFIED",
        }
    }
}
#[derive(Debug)]
pub struct PreparationCompletion {
    pub result: Value,
    pub terminal: TerminalFacts,
    deadline: DeadlineEnvelope,
}
impl PreparationCompletion {
    pub fn exit_code(&self) -> u8 {
        if self.result.get("status").and_then(Value::as_str) == Some("prepared") {
            0
        } else {
            2
        }
    }
    pub fn envelope(&self) -> Value {
        json!({"schema":"caws.preparation.parent_result.v1",
        "result":self.result,"terminal":self.terminal})
    }
    pub fn deliver_stdout(&self) -> Result<()> {
        deliver_json(1, &self.envelope(), self.deadline)
    }
}
/// A failed attempt may hold actual live children while this value remains
/// alive. Dropping it or exiting the finite CLI never proves settlement.
/// There is no replay, adoption or continuation from interrupted attempts.
pub struct PreparationFailure {
    pub reason: String,
    pub terminal: TerminalFacts,
    pub child_result: Option<Value>,
    retained: Vec<OwnedChild>,
    deadline: Option<DeadlineEnvelope>,
}
impl PreparationFailure {
    pub fn retains_custody(&self) -> bool {
        self.retained.iter().any(|c| c.child.is_some())
    }
}
impl std::fmt::Debug for PreparationFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreparationFailure")
            .field("reason", &self.reason)
            .field("retainsCustody", &self.retains_custody())
            .finish()
    }
}
impl PreparationFailure {
    pub fn envelope(&self) -> Value {
        json!({"schema":"caws.preparation.parent_result.v1",
        "result":{"status":"failed","adoption":"NOT_ADOPTED",
            "writerState":if self.terminal.node_started{"RETAINED_UNCERTAIN"}else{"NOT_STARTED"},
            "phase":"parent","reason":self.reason},"childResult":self.child_result,"terminal":self.terminal})
    }
    pub fn deliver_stdout(&self) -> Result<()> {
        match self.deadline {
            Some(deadline) => deliver_json(1, &self.envelope(), deadline),
            None => immediate_diagnostic(&self.envelope()),
        }
    }
}
fn failure(reason: String) -> PreparationFailure {
    PreparationFailure {
        reason,
        retained: vec![],
        terminal: TerminalFacts::not_started(),
        child_result: None,
        deadline: None,
    }
}
fn timed_failure(mut error: PreparationFailure, deadline: DeadlineEnvelope) -> PreparationFailure {
    if error.deadline.is_none() {
        error.deadline = Some(deadline);
    }
    error
}
struct FdFlags {
    fd: i32,
    flags: i32,
}
impl FdFlags {
    fn nonblocking(fd: i32) -> Result<Self> {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        require(
            flags >= 0 && unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } >= 0,
            "Cannot establish nonblocking terminal sink",
        )?;
        Ok(Self { fd, flags })
    }
}
impl Drop for FdFlags {
    fn drop(&mut self) {
        unsafe { libc::fcntl(self.fd, libc::F_SETFL, self.flags) };
    }
}
fn write_terminal(fd: i32, bytes: &[u8], deadline: &MonotonicDeadline) -> Result<()> {
    checked(deadline)?;
    terminal_sink(fd)?;
    let _flags = FdFlags::nonblocking(fd)?;
    let mut offset = 0;
    while offset < bytes.len() {
        checked(deadline)?;
        let end = (offset + 8192).min(bytes.len());
        let n = unsafe { libc::write(fd, bytes[offset..end].as_ptr().cast(), end - offset) };
        if n > 0 {
            offset += n as usize;
            continue;
        }
        if n == 0 {
            return Err("Terminal sink made no progress".into());
        }
        match io::Error::last_os_error().kind() {
            io::ErrorKind::WouldBlock => pause(deadline)?,
            io::ErrorKind::Interrupted => {}
            _ => return Err("Terminal sink refused delivery".into()),
        }
    }
    checked(deadline)
}
fn terminal_sink(fd: i32) -> Result<()> {
    let mut raw = std::mem::MaybeUninit::<libc::stat>::uninit();
    require(
        unsafe { libc::fstat(fd, raw.as_mut_ptr()) } == 0,
        "Terminal sink cannot be classified",
    )?;
    let mode = unsafe { raw.assume_init() }.st_mode & libc::S_IFMT;
    // O_NONBLOCK has a useful finite backpressure contract for these types.
    // Regular files and arbitrary devices can ignore it and are refused.
    require(
        mode == libc::S_IFIFO || mode == libc::S_IFSOCK,
        "Unsupported terminal sink; FIFO/socket required",
    )
}
fn deliver_json(fd: i32, value: &Value, envelope: DeadlineEnvelope) -> Result<()> {
    // Receiving the original monotonic envelope preserves its absolute expiry;
    // it cannot grant a renewed timeout after child execution or stdin.
    let deadline = MonotonicDeadline::receive(envelope).map_err(|e| e.to_string())?;
    let mut bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    require(bytes.len() <= FRAME, "Terminal envelope exceeds bound")?;
    bytes.push(b'\n');
    write_terminal(fd, &bytes, &deadline)
}
fn immediate_diagnostic(value: &Value) -> Result<()> {
    // Unconfigured/malformed startup has no selected invocation deadline and
    // starts no child. At most one nonblocking diagnostic syscall is allowed.
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    require(
        bytes.len() < 4096,
        "Startup diagnostic exceeds immediate bound",
    )?;
    terminal_sink(2)?;
    let _flags = FdFlags::nonblocking(2)?;
    let n = unsafe { libc::write(2, bytes.as_ptr().cast(), bytes.len()) };
    require(
        n == bytes.len() as isize,
        "Startup diagnostic was not delivered",
    )
}
/// No flags or request fields can replace this compiled bootstrap record.
/// Request stdin and the startup clock are sampled only once by the binary.
pub fn execute(bytes: &[u8]) -> std::result::Result<PreparationCompletion, PreparationFailure> {
    execute_configured(bytes, option_env!("CAWS_PREPARATION_BOOTSTRAP_V1"))
}
fn execute_configured(
    bytes: &[u8],
    record: Option<&str>,
) -> std::result::Result<PreparationCompletion, PreparationFailure> {
    let request = validate_request(bytes).map_err(failure)?;
    let pins = bootstrap(record).map_err(failure)?;
    let deadline = MonotonicDeadline::capture(Duration::from_millis(pins.timeout_ms))
        .map_err(|e| failure(e.to_string()))?;
    let original = deadline.envelope();
    execute_with_deadline(bytes, request, pins, deadline).map_err(|e| timed_failure(e, original))
}
fn execute_with_deadline(
    bytes: &[u8],
    request: Request,
    pins: Bootstrap,
    deadline: MonotonicDeadline,
) -> std::result::Result<PreparationCompletion, PreparationFailure> {
    let environment = startup_environment().map_err(failure)?;
    let cwd = env::current_dir().map_err(|e| failure(e.to_string()))?;
    physical(&cwd).map_err(failure)?;
    check_program(&pins.node, &deadline).map_err(failure)?;
    check_program(&pins.git, &deadline).map_err(failure)?;
    check_inventory(&pins.prefix.root, &pins.prefix.inventory, ENTRY, &deadline)
        .map_err(failure)?;
    check_inventory(
        &pins.git_view.root,
        &pins.git_view.inventory,
        ".",
        &deadline,
    )
    .map_err(failure)?;
    require(
        request.source.object_format == pins.git_view.object_format,
        "Private Git/source format mismatch",
    )
    .map_err(failure)?;
    let source = locate_git(&request.source.source_root, &deadline).map_err(failure)?;
    require(
        source.top == request.source.source_root,
        "Source must be its actual checkout root",
    )
    .map_err(failure)?;
    let caller = locate_git(&cwd, &deadline).map_err(failure)?;
    require(
        source.common == caller.common,
        "Caller/source object store mismatch",
    )
    .map_err(failure)?;
    let canonical = source
        .common
        .parent()
        .ok_or_else(|| failure("Invalid canonical common path".into()))?
        .to_path_buf();
    require(
        source.common.file_name().is_some_and(|p| p == ".git"),
        "Only ordinary canonical common directories admitted",
    )
    .map_err(failure)?;
    let canonical_git = locate_git(&canonical, &deadline).map_err(failure)?;
    require(
        canonical_git.common == source.common,
        "Canonical store mismatch",
    )
    .map_err(failure)?;
    let roots = admitted_metadata_roots(&cwd, caller, &source, canonical_git);
    let (parent, child_socket) = UnixStream::pair().map_err(|e| failure(e.to_string()))?;
    let fd = unsafe { libc::fcntl(child_socket.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 64) };
    require(fd >= 64, "Cannot reserve inherited parent descriptor").map_err(failure)?;
    let inherited = unsafe { OwnedFd::from_raw_fd(fd) };
    parent
        .set_nonblocking(true)
        .map_err(|e| failure(e.to_string()))?;
    let entry = pins.prefix.root.join(ENTRY);
    let args = vec![
        entry.to_string_lossy().into_owned(),
        "--parent-fd".into(),
        fd.to_string(),
    ];
    let start = json!({"kind":"start","request":B64.encode(bytes),"cwd":cwd,"parentPid":std::process::id(),"environment":environment,"remainingMs":remaining(&deadline).map_err(failure)?});
    let node = spawn_fixed(
        &pins.node,
        &args,
        &pins.prefix.root,
        &[],
        Some(fd),
        &deadline,
    )
    .map_err(failure)?;
    drop(inherited);
    drop(child_socket);
    let node = OwnedChild::new(node);
    let mut owner = Parent {
        bootstrap: pins,
        deadline,
        node,
        queries: vec![],
        channel: Channel {
            socket: parent,
            input: vec![],
            eof: false,
        },
        roots,
        source,
        observed_result: None,
    };
    match owner.serve(start) {
        Ok(result) => {
            let closed = owner
                .channel
                .socket
                .shutdown(std::net::Shutdown::Both)
                .is_ok()
                || owner.channel.eof;
            Ok(PreparationCompletion {
                result,
                terminal: TerminalFacts::observed(&owner, closed),
                deadline: owner.deadline.envelope(),
            })
        }
        Err(reason) => {
            // Revoke the checkpoint transport BEFORE any cleanup operation.
            // Even when settlement cannot finish within the original interval,
            // the writer cannot obtain another authorization from this parent.
            let Parent {
                deadline: original_deadline,
                mut node,
                mut queries,
                channel,
                observed_result: child_result,
                ..
            } = owner;
            let _ = channel.socket.shutdown(std::net::Shutdown::Both);
            // Drop the sole parent endpoint before settlement even if shutdown
            // refused; no outstanding writer checkpoint can receive a reply.
            drop(channel);
            // Stop/reap only within the one original budget. Refusal retains
            // actual children; no try_wait/foreign PID adoption or fresh timer.
            for child in &mut queries {
                let _ = child.finish(&original_deadline, OBJECTS, true);
            }
            let _ = node.finish(&original_deadline, METADATA, true);
            let terminal = TerminalFacts::children(&node, &queries, true);
            let deadline = Some(original_deadline.envelope());
            let mut retained = queries;
            retained.push(node);
            Err(PreparationFailure {
                reason,
                retained,
                terminal,
                deadline,
                child_result,
            })
        }
    }
}
/// Read original request bytes under an already-captured absolute deadline.
/// This entry refuses an unconfigured binary before waiting for stdin.
pub fn run_stdin() -> std::result::Result<PreparationCompletion, PreparationFailure> {
    let pins = bootstrap(option_env!("CAWS_PREPARATION_BOOTSTRAP_V1")).map_err(failure)?;
    let deadline = MonotonicDeadline::capture(Duration::from_millis(pins.timeout_ms))
        .map_err(|e| failure(e.to_string()))?;
    let original = deadline.envelope();
    // Reject a known unsupported CLI receipt sink before input, children or
    // materialization. The sink-independent library execute API does not own
    // its caller's eventual delivery choice.
    terminal_sink(1).map_err(|e| timed_failure(failure(e), original))?;
    let input = read_request(&deadline).map_err(|e| timed_failure(failure(e), original))?;
    let request = validate_request(&input).map_err(|e| timed_failure(failure(e), original))?;
    execute_with_deadline(&input, request, pins, deadline).map_err(|e| timed_failure(e, original))
}
fn read_request(deadline: &MonotonicDeadline) -> Result<Vec<u8>> {
    // stdin can be a pipe held open indefinitely. Poll before each bounded read.
    let _flags = FdFlags::nonblocking(0)?;
    let mut input = Vec::new();
    loop {
        checked(deadline)?;
        let mut block = [0u8; 4096];
        let n = unsafe { libc::read(0, block.as_mut_ptr().cast(), block.len()) };
        if n == 0 {
            break;
        }
        if n > 0 {
            input.extend_from_slice(&block[..n as usize]);
            require(input.len() <= REQUEST, "Request exceeds 64KiB")?;
            continue;
        }
        match io::Error::last_os_error().kind() {
            io::ErrorKind::WouldBlock => pause(deadline)?,
            io::ErrorKind::Interrupted => {}
            _ => return Err("Request stdin read failed".into()),
        }
    }
    Ok(input)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Vec<u8> {
        serde_json::to_vec(&json!({"schema":"caws.frozen_source_preparation.v1","source":{"sourceRoot":"/source","commit":"a".repeat(40),"tree":"b".repeat(40),"objectFormat":"sha1"},"outputRoot":"/output","futureBuildRoot":"/build"})).unwrap()
    }
    #[test]
    fn request_is_closed_and_has_no_context_authority() {
        let bytes = request();
        assert!(validate_request(&bytes).is_ok());
        for field in ["cwd", "environment", "pins", "parentPid", "program"] {
            let mut v: Value = serde_json::from_slice(&bytes).unwrap();
            v[field] = json!("injected");
            assert!(
                validate_request(&serde_json::to_vec(&v).unwrap()).is_err(),
                "{field}"
            );
        }
        let mut v: Value = serde_json::from_slice(&bytes).unwrap();
        v["source"]["commit"] = json!("HEAD");
        assert!(validate_request(&serde_json::to_vec(&v).unwrap()).is_err());
        assert!(validate_request(&[0xff]).is_err());
        assert!(validate_request(&vec![b' '; REQUEST + 1]).is_err());
    }
    #[test]
    fn unconfigured_refuses_without_children() {
        let e = execute_configured(&request(), None).unwrap_err();
        assert!(e.reason.contains("Unconfigured"));
        assert!(!e.retains_custody());
    }
    #[test]
    fn rpc_rejects_unknown_operations_and_fields() {
        assert!(
            serde_json::from_value::<Rpc>(json!({"kind":"spawn","seq":1,"program":"/bin/sh"}))
                .is_err()
        );
        assert!(
            serde_json::from_value::<Rpc>(json!({"kind":"checkpoint","seq":1,"argv":[]})).is_err()
        );
        assert!(serde_json::from_value::<Rpc>(json!({"kind":"objects","seq":1,"selections":[{"oid":"a".repeat(40),"kind":"blob","path":"x"}]})).is_err());
    }
    #[test]
    fn config_includes_and_execution_are_refused_without_following() {
        for bytes in [
            b"include.path\n/tmp/evil\0".as_slice(),
            b"includeif.gitdir:x.path\n/tmp/evil\0",
            b"core.fsmonitor\n/bin/false\0",
            b"filter.lfs.process\n/bin/false\0",
            b"extensions.partialclone\norigin\0",
            b"remote.origin.promisor\ntrue\0",
            b"remote.origin.uploadpack\n/bin/false\0",
        ] {
            assert!(safe_config(bytes).is_err());
        }
        assert!(
            safe_config(
                b"core.repositoryformatversion\n0\0core.bare\nfalse\0core.logallrefupdates\ntrue\0"
            )
            .is_ok()
        );
        assert!(safe_config(b"remote.origin.url\nssh://example.test/project\0remote.origin.fetch\n+refs/heads/*:refs/remotes/origin/*\0core.hookspath\n.caws/hooks\0extensions.worktreeconfig\ntrue\0").is_ok());
        assert!(
            safe_worktree_config(
                b"core.sparsecheckout\ntrue\0core.sparsecheckoutcone\nfalse\0index.sparse\nfalse\0"
            )
            .is_ok()
        );
        for bytes in [
            b"core.ignorecase\ntrue\0".as_slice(),
            b"core.excludesfile\n/elsewhere\0",
            b"extensions.objectformat\nsha256\0",
        ] {
            assert!(safe_worktree_config(bytes).is_err());
        }
    }
    #[test]
    fn path_and_oid_boundaries_do_not_admit_revision_expressions() {
        for p in ["../x", "a/../x", "/x", "a//b", "a/./b", "a\\b", ""] {
            assert!(!relative(p), "{p}");
        }
        assert!(relative("a/b"));
        assert!(!oid("HEAD^{tree}", "sha1"));
        assert!(!oid(&"A".repeat(40), "sha1"));
        assert!(oid(&"a".repeat(64), "sha256"));
    }
    #[test]
    fn deadline_is_not_renewed_on_observation() {
        let deadline = MonotonicDeadline::capture(Duration::from_millis(20)).unwrap();
        thread::sleep(Duration::from_millis(30));
        assert!(remaining(&deadline).is_err());
        assert!(checked(&deadline).is_err());
    }
    fn temp_root(label: &str) -> PathBuf {
        let deadline = MonotonicDeadline::capture(Duration::from_secs(5)).unwrap();
        let base = fs::canonicalize(env::temp_dir()).unwrap();
        let root = base.join(format!(
            "caws-preparation-{label}-{}-{}",
            std::process::id(),
            deadline.envelope().started_ns
        ));
        fs::create_dir(&root).unwrap();
        root
    }
    #[test]
    fn file_pins_detect_replacement_and_forbid_symlinks() {
        let deadline = MonotonicDeadline::capture(Duration::from_secs(5)).unwrap();
        let root = temp_root("pin");
        let path = root.join("input");
        fs::write(&path, b"original").unwrap();
        let pin = FilePin {
            path: path.clone(),
            size_bytes: 8,
            sha256: sha(b"original"),
        };
        assert_eq!(check_file(&pin, 32, &deadline).unwrap(), b"original");
        fs::write(&path, b"replaced").unwrap();
        assert!(check_file(&pin, 32, &deadline).is_err());
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink("missing", &path).unwrap();
        assert!(check_file(&pin, 32, &deadline).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn inventory_rejects_extra_members() {
        let deadline = MonotonicDeadline::capture(Duration::from_secs(5)).unwrap();
        let parent = temp_root("tree");
        let root = parent.join("prefix");
        fs::create_dir(&root).unwrap();
        let mode = fs::symlink_metadata(&root).unwrap().mode() & 0o777;
        let bytes=serde_json::to_vec(&json!({"entry":root,"prefix":root,"rows":[{"path":".","type":"directory","mode":mode}]})).unwrap();
        let path = parent.join("inventory.json");
        fs::write(&path, &bytes).unwrap();
        let pin = FilePin {
            path,
            size_bytes: bytes.len() as u64,
            sha256: sha(&bytes),
        };
        assert!(check_inventory(&root, &pin, ".", &deadline).is_ok());
        fs::write(root.join("unexpected"), b"x").unwrap();
        assert!(check_inventory(&root, &pin, ".", &deadline).is_err());
        fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn startup_injection_is_rejected_before_pin_or_spawn_work() {
        for key in [
            "NODE_OPTIONS",
            "NODE_PATH",
            "DYLD_INSERT_LIBRARIES",
            "LD_PRELOAD",
        ] {
            let values = vec![(key.into(), "injected".into())];
            assert_eq!(
                startup_environment_from(values).unwrap_err(),
                format!("Startup injection variable refused: {key}")
            );
        }
        let identity = startup_environment_from(vec![
            ("CODEX_THREAD_ID".into(), "session".into()),
            ("PATH".into(), "/untrusted".into()),
        ])
        .unwrap();
        assert_eq!(
            identity,
            BTreeMap::from([("CODEX_THREAD_ID".into(), "session".into())])
        );
    }
    #[test]
    fn incomplete_fd_snapshots_are_never_admitted() {
        let width = std::mem::size_of::<FdInfo>();
        assert_eq!(width, 8);
        assert!(fd_count(0, 8).is_err());
        assert!(fd_count(-1, 8).is_err());
        assert!(fd_count((8 * width) as i32, 8).is_err());
        assert!(fd_count(7, 8).is_err());
        assert_eq!(fd_count((3 * width) as i32, 8).unwrap(), 3);
    }
    #[test]
    fn terminal_refuses_regular_file_before_writing() {
        let root = temp_root("sink");
        let path = root.join("output");
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .unwrap();
        let deadline = MonotonicDeadline::capture(Duration::from_secs(1)).unwrap();
        assert!(write_terminal(file.as_raw_fd(), b"must not appear", &deadline).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"");
        drop(file);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn blocked_terminal_sink_expires_without_renewal() {
        let (mut writer, _held_reader) = UnixStream::pair().unwrap();
        writer.set_nonblocking(true).unwrap();
        loop {
            match writer.write(&[b'x'; 8192]) {
                Ok(n) => assert!(n > 0),
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) => panic!("{e}"),
            }
        }
        let deadline = MonotonicDeadline::capture(Duration::from_millis(30)).unwrap();
        assert!(write_terminal(writer.as_raw_fd(), b"terminal result", &deadline).is_err());
        assert!(checked(&deadline).is_err());
    }
    #[test]
    fn process_fixture() {
        let mode = env::var("CAWS_PREPARATION_TEST_FIXTURE");
        if let Ok(mode) = mode {
            if mode == "held-output" {
                // Deliberately leave stdout inherited by a live member of the same
                // private group after its direct leader exits.
                let pid = unsafe { libc::fork() };
                assert!(pid >= 0);
                if pid == 0 {
                    unsafe {
                        libc::sleep(2);
                        libc::_exit(0)
                    }
                }
            } else if mode == "signal" {
                unsafe { libc::raise(libc::SIGTERM) };
            } else if mode == "descriptor" {
                let open: i32 = env::var("CAWS_PREPARATION_TEST_OPEN_FD")
                    .unwrap()
                    .parse()
                    .unwrap();
                let closed: i32 = env::var("CAWS_PREPARATION_TEST_CLOSED_FD")
                    .unwrap()
                    .parse()
                    .unwrap();
                assert!(unsafe { libc::fcntl(open, libc::F_GETFD) } >= 0);
                assert_eq!(unsafe { libc::fcntl(closed, libc::F_GETFD) }, -1);
                assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::EBADF));
                let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
                assert_eq!(unsafe { libc::fstat(open, stat.as_mut_ptr()) }, 0);
                assert_eq!(
                    unsafe { stat.assume_init() }.st_mode & libc::S_IFMT,
                    libc::S_IFSOCK
                );
            }
            std::process::exit(0);
        }
        assert!(env::var("CAWS_PREPARATION_TEST_FIXTURE").is_err());
    }
    #[cfg(target_os = "macos")]
    fn fixture(mode: &str) -> OwnedChild {
        fixture_with_profile(mode, None, None)
    }
    #[cfg(target_os = "macos")]
    fn fixture_with_profile(mode: &str, inherited: Option<i32>, closed: Option<i32>) -> OwnedChild {
        let mut command = Command::new(env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "preparation_parent::tests::process_fixture",
                "--nocapture",
            ])
            .env("CAWS_PREPARATION_TEST_FIXTURE", mode)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(fd) = inherited {
            command.env("CAWS_PREPARATION_TEST_OPEN_FD", fd.to_string());
        }
        if let Some(fd) = closed {
            command.env("CAWS_PREPARATION_TEST_CLOSED_FD", fd.to_string());
        }
        let mut descriptors = vec![FdInfo::default(); MAX_OPEN_FDS];
        unsafe {
            command.pre_exec(move || {
                if libc::setpgid(0, 0) != 0 {
                    return Err(io::Error::last_os_error());
                }
                close_profile(&mut descriptors, inherited)
            });
        }
        let mut owner = OwnedChild::new(command.spawn().unwrap());
        owner.prepare_pipes().unwrap();
        owner
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn actual_fd_profile_preserves_only_selected_high_socket() {
        let (a, b) = UnixStream::pair().unwrap();
        let open = unsafe { libc::fcntl(a.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 64) };
        assert!(open >= 64);
        let open_owner = unsafe { OwnedFd::from_raw_fd(open) };
        let closed = unsafe { libc::fcntl(b.as_raw_fd(), libc::F_DUPFD_CLOEXEC, open + 1) };
        assert!(closed > open);
        let closed_owner = unsafe { OwnedFd::from_raw_fd(closed) };
        // This descriptor would leak without the actual child snapshot profile.
        assert_eq!(unsafe { libc::fcntl(closed, libc::F_SETFD, 0) }, 0);
        let mut owner = fixture_with_profile("descriptor", Some(open), Some(closed));
        drop(open_owner);
        drop(closed_owner);
        let deadline = MonotonicDeadline::capture(Duration::from_secs(5)).unwrap();
        assert_eq!(owner.finish(&deadline, METADATA, false).unwrap(), 0);
        assert!(owner.child.is_none());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn terminal_process_is_actually_reaped() {
        let mut owner = fixture("exit");
        let pid = owner.child.as_ref().unwrap().id();
        let deadline = MonotonicDeadline::capture(Duration::from_secs(5)).unwrap();
        assert_eq!(owner.finish(&deadline, METADATA, false).unwrap(), 0);
        assert!(owner.child.is_none());
        let mut status = 0;
        assert_eq!(
            unsafe { libc::waitpid(pid as i32, &mut status, libc::WNOHANG) },
            -1
        );
        assert_eq!(
            io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD)
        );
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn expiry_between_settlement_and_reap_keeps_fact_without_success() {
        let mut owner = fixture("exit");
        let pid = owner.child.as_ref().unwrap().id();
        let setup = MonotonicDeadline::capture(Duration::from_secs(5)).unwrap();
        loop {
            owner.drain(METADATA).unwrap();
            if matches!(
                owned_group::settlement_before_reap(owner.child.as_ref().unwrap()).unwrap(),
                owned_group::GroupSettlement::Exited { .. }
            ) && owner.out_eof
                && owner.err_eof
            {
                break;
            }
            pause(&setup).unwrap();
        }
        let deadline = MonotonicDeadline::capture(Duration::from_millis(20)).unwrap();
        checked(&deadline).unwrap();
        // Model descheduling after the last pre-reap check. This is the same
        // original interval; the real child is reaped by the production method.
        thread::sleep(Duration::from_millis(30));
        assert!(
            owner
                .reap_observed_child(&deadline)
                .unwrap_err()
                .contains("expired")
        );
        assert!(owner.child.is_none());
        assert!(owner.out_eof && owner.err_eof);
        let mut status = 0;
        assert_eq!(
            unsafe { libc::waitpid(pid as i32, &mut status, libc::WNOHANG) },
            -1
        );
        assert_eq!(
            io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD)
        );
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn inherited_output_fd_and_live_group_cannot_publish_success() {
        let mut owner = fixture("held-output");
        let setup = MonotonicDeadline::capture(Duration::from_secs(5)).unwrap();
        let positive_live_group = loop {
            owner.drain(METADATA).unwrap();
            match owned_group::settlement_before_reap(owner.child.as_ref().unwrap()) {
                Ok(owned_group::GroupSettlement::GroupLive { .. }) => break true,
                Ok(owned_group::GroupSettlement::Exited { .. }) => break false,
                Ok(owned_group::GroupSettlement::LeaderRunning) => {}
                Err(_) => break false,
            }
            if pause(&setup).is_err() {
                break false;
            }
        };
        if !positive_live_group {
            let teardown = MonotonicDeadline::capture(Duration::from_secs(5)).unwrap();
            let _ = owner.finish(&teardown, METADATA, true);
        }
        assert!(
            positive_live_group,
            "Fixture must prove exited leader plus live inherited-output group before probe"
        );
        assert!(!owner.out_eof);
        let deadline = MonotonicDeadline::capture(Duration::from_millis(40)).unwrap();
        assert!(owner.finish(&deadline, METADATA, false).is_err());
        assert!(owner.child.is_some());
        assert!(!owner.out_eof);
        // A distinct test-harness teardown budget is not an invocation retry.
        // This test never calls execute/run_stdin with a renewed deadline.
        let teardown = MonotonicDeadline::capture(Duration::from_secs(5)).unwrap();
        owner.finish(&teardown, METADATA, true).unwrap();
        assert!(owner.child.is_none());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn signal_exit_is_not_an_ordinary_success_code() {
        let mut owner = fixture("signal");
        let deadline = MonotonicDeadline::capture(Duration::from_secs(5)).unwrap();
        assert_eq!(owner.finish(&deadline, METADATA, false).unwrap(), -1);
        assert!(owner.child.is_none());
    }
    #[test]
    fn absent_alternates_pin_refuses_later_creation() {
        let root = temp_root("alternates");
        let path = root.join("alternates");
        let deadline = MonotonicDeadline::capture(Duration::from_secs(5)).unwrap();
        let pin = MetadataPin::capture(path.clone(), &deadline).unwrap();
        assert!(pin.bytes.is_none());
        assert!(pin.check(&deadline).is_ok());
        fs::write(&path, b"/unadmitted/object/directory\n").unwrap();
        assert_eq!(
            pin.check(&deadline).unwrap_err(),
            "Source configuration changed"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn nested_caller_admits_its_own_root_without_admitting_other_worktrees() {
        let common = PathBuf::from("/canonical/.git");
        let observation = |top: &str, git_dir: &str| SourceGit {
            top: PathBuf::from(top),
            git_dir: PathBuf::from(git_dir),
            common: common.clone(),
            pins: vec![],
        };
        let caller = observation("/owned", "/canonical/.git/worktrees/owned");
        let source = observation("/source", "/canonical/.git/worktrees/source");
        let canonical = observation("/canonical", "/canonical/.git");
        let roots = admitted_metadata_roots(
            Path::new("/owned/packages/caws-cli"),
            caller,
            &source,
            canonical,
        );
        assert_eq!(roots.len(), 4);
        let cwd = roots.get(Path::new("/owned/packages/caws-cli")).unwrap();
        let ignore = roots.get(Path::new("/owned")).unwrap();
        assert_eq!(ignore.top, Path::new("/owned"));
        assert_eq!(ignore.git_dir, cwd.git_dir);
        assert_eq!(ignore.common, cwd.common);
        assert!(roots.contains_key(Path::new("/source")));
        assert!(roots.contains_key(Path::new("/canonical")));
        assert!(!roots.contains_key(Path::new("/unrelated")));
        assert!(!roots.contains_key(Path::new("/owned/arbitrary-child")));
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn unavailable_pipe_profile_refuses_io_and_retains_actual_child() {
        let mut owner = fixture("exit");
        owner.pipes_ready = false;
        assert_eq!(
            owner.drain(METADATA).unwrap_err(),
            "Child pipe nonblocking profile unavailable; custody retained"
        );
        let deadline = MonotonicDeadline::capture(Duration::from_secs(5)).unwrap();
        assert_eq!(
            owner.finish(&deadline, METADATA, false).unwrap_err(),
            "Child pipe nonblocking profile unavailable; custody retained"
        );
        assert!(owner.child.is_some());
        // The test restores the already-established descriptor profile only to
        // settle its own fixture; production never repairs an unknown profile.
        owner.pipes_ready = true;
        owner.finish(&deadline, METADATA, true).unwrap();
        assert!(owner.child.is_none());
    }
}
