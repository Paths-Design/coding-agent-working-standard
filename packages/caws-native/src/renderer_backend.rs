//! Owned compatibility worker for the captured Sterling renderer daemon.
//! This is not admission, authority, replay, fallback, or a resident host pool.
//! The host retains its durable Dispatch and validates the selected immutable
//! image/grant before sending a command. One private control socket belongs to
//! that host. EOF/Stop stops the owned backend; no lease PID is ever adopted.
//!
//! The supplied machine home/image/environment are owner-verified inputs. The
//! complete declared image is checked once; immutable image preservation and
//! source retirement remain host duties. Python/stdlib/OS are external TCB.
//! Whole-worker SIGKILL, arbitrary escaped descendants, physical kernel stalls,
//! authenticated daemon health, and full renderer argv parity are not claimed.
use crate::owned_group::{GroupObservation, GroupStop};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    net::TcpStream,
    os::{
        fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd, RawFd},
        unix::{
            fs::{MetadataExt, OpenOptionsExt},
            net::UnixStream,
            process::{CommandExt, ExitStatusExt},
        },
    },
    path::{Component, Path, PathBuf},
    process::{Child, ChildStderr, ChildStdout, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};
const COMMAND_SCHEMA: &str = "caws.renderer.worker.command.v1";
const EVENT_SCHEMA: &str = "caws.renderer.worker.event.v1";
pub const MAX_COMMAND_BYTES: usize = 131_072;
pub const MAX_EVENT_BYTES: usize = 8192;
const MAX_REPLY: usize = 1024;
const MAX_LEASE: u64 = 16_384;
const MAX_CAPTURE: usize = 65_536;
const SAFE: u64 = 9_007_199_254_740_991;
const TICK: Duration = Duration::from_millis(10);
pub mod entry;
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FailureCode {
    InvalidSpec,
    InvalidArguments,
    UnsupportedLegacyWire,
    ImageMismatch,
    UnsafePrivateState,
    Io,
    Deadline,
    HostClosed,
    HostStopped,
    ControlProtocol,
    ChildExited,
    InvalidDaemonReply,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Failure {
    pub code: FailureCode,
    pub errno: Option<i32>,
}
impl Failure {
    fn new(code: FailureCode) -> Self {
        Self { code, errno: None }
    }
    fn io(error: io::Error) -> Self {
        Self {
            code: FailureCode::Io,
            errno: error.raw_os_error(),
        }
    }
}
type Result<T> = std::result::Result<T, Failure>;
fn fail<T>(code: FailureCode) -> Result<T> {
    Err(Failure::new(code))
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn deadline(value: Instant) -> Result<()> {
    if Instant::now() >= value {
        fail(FailureCode::Deadline)
    } else {
        Ok(())
    }
}
fn absolute(path: &Path) -> bool {
    path.is_absolute()
        && path
            .to_str()
            .is_some_and(|v| v.len() <= 4096 && !v.as_bytes().contains(&0))
        && path
            .components()
            .all(|v| matches!(v, Component::RootDir | Component::Normal(_)))
}
fn socket_write(fd: RawFd, bytes: &[u8]) -> io::Result<usize> {
    // Per-call suppression prevents a closed control/TCP peer from killing the
    // worker before it cleans its Child. No process-global signal mutation.
    let count = unsafe { libc::send(fd, bytes.as_ptr().cast(), bytes.len(), libc::MSG_NOSIGNAL) };
    if count < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(count as usize)
    }
}
fn close_on_exec(fd: RawFd) -> Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        return Err(Failure::io(io::Error::last_os_error()));
    }
    Ok(())
}
fn nonblocking(fd: RawFd) -> Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    let rights = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0
        || rights < 0
        || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
        || unsafe { libc::fcntl(fd, libc::F_SETFD, rights | libc::FD_CLOEXEC) } < 0
    {
        return Err(Failure::io(io::Error::last_os_error()));
    }
    Ok(())
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PinnedFile {
    pub path: PathBuf,
    pub sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PinnedBackendSpec {
    pub python: PinnedFile,
    pub hooks_dir: PathBuf,
    pub image_files: Vec<PinnedFile>,
    pub image_digest: String,
    /// Fresh empty private namespace; never the project's existing daemon lease.
    pub work_dir: PathBuf,
    pub home: PathBuf,
    pub search_path: String,
    pub agent_surface: String,
    pub idle_seconds: u32,
    pub cache_megabytes: u16,
    /// Native-produced per-backend metadata, never inherited caller Git routing.
    pub git_view: Option<crate::service_git_view::GitView>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerLimits {
    pub startup_ms: u32,
    pub connect_ms: u32,
    pub write_ms: u32,
    pub render_ms: u32,
    pub read_ms: u32,
    pub cleanup_ms: u32,
}
impl WorkerLimits {
    fn validate(&self) -> Result<()> {
        if [
            self.startup_ms,
            self.connect_ms,
            self.write_ms,
            self.render_ms,
            self.read_ms,
            self.cleanup_ms,
        ]
        .iter()
        .all(|v| (1..=300_000).contains(v))
        {
            Ok(())
        } else {
            fail(FailureCode::InvalidSpec)
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HostCommand {
    Render {
        request_id: String,
        arguments: Box<[String; 12]>,
    },
    Stop,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostFrame {
    pub schema: String,
    pub command: HostCommand,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonResponse {
    pub served: u64,
    pub elapsed_ms: u64,
    pub cached: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "execution", rename_all = "snake_case", deny_unknown_fields)]
pub enum RequestResult {
    KnownNotAttempted { failure: Failure },
    Unknown { failure: Failure },
    Returned { response: DaemonResponse },
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureStats {
    pub bytes_seen: u64,
    pub bytes_retained: usize,
    pub truncated: bool,
    pub eof: bool,
    pub io_failed: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackendExit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanupReceipt {
    pub child_pid: Option<u32>,
    pub direct_child_reaped: bool,
    pub backend_exit: Option<BackendExit>,
    pub identity_verified_before_signal: bool,
    pub group_signal_accepted: bool,
    pub group_exited_only: Option<GroupObservation>,
    pub group_signal_errno: Option<i32>,
    pub reap_error_errno: Option<i32>,
    pub deadline_exceeded: bool,
    pub stdout: CaptureStats,
    pub stderr: CaptureStats,
    pub logs_persisted: bool,
    pub cleanup_elapsed_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkerEvent {
    Ready {
        readiness: String,
        child_pid: u32,
        image_digest: String,
        startup_elapsed_ms: u64,
    },
    Progress {
        request_id: String,
        phase: String,
    },
    Result {
        request_id: String,
        result: RequestResult,
        reply_bytes: Vec<u8>,
    },
    Failed {
        failure: Failure,
    },
    CleanupDeadline {
        child_pid: u32,
    },
    Cleanup {
        receipt: CleanupReceipt,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventFrame {
    pub schema: String,
    pub event: WorkerEvent,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerExit {
    pub failure: Option<Failure>,
    pub last_request_id: Option<String>,
    pub last_result: Option<RequestResult>,
    pub last_reply_bytes: Vec<u8>,
    pub cleanup: CleanupReceipt,
}
/// Same typed argument domain as the selected service wire. LF/US are accepted
/// data there, but cannot be represented by this legacy daemon profile. The host
/// calls this before durable dispatch; worker repeats it before any TCP write.
pub fn validate_arguments(args: &[String; 12]) -> Result<()> {
    crate::service_protocol::render_argument_digest(args)
        .map_err(|_| Failure::new(FailureCode::InvalidArguments))?;
    let wire_bytes = args
        .iter()
        .try_fold(45usize, |sum, value| sum.checked_add(value.len()))
        .ok_or(Failure::new(FailureCode::InvalidArguments))?;
    if wire_bytes > 65536 || args.iter().any(|v| v.contains(['\n', '\x1f'])) {
        return fail(FailureCode::UnsupportedLegacyWire);
    }
    Ok(())
}
pub fn encode_command(command: HostCommand) -> Result<Vec<u8>> {
    if let HostCommand::Render {
        request_id,
        arguments,
    } = &command
    {
        if !hash(request_id) {
            return fail(FailureCode::ControlProtocol);
        }
        crate::service_protocol::render_argument_digest(arguments)
            .map_err(|_| Failure::new(FailureCode::InvalidArguments))?;
    }
    let mut bytes = serde_json::to_vec(&HostFrame {
        schema: COMMAND_SCHEMA.into(),
        command,
    })
    .map_err(|_| Failure::new(FailureCode::ControlProtocol))?;
    if bytes.len() > MAX_COMMAND_BYTES {
        return fail(FailureCode::ControlProtocol);
    }
    bytes.push(b'\n');
    Ok(bytes)
}
pub fn decode_event(frame: &[u8]) -> Result<EventFrame> {
    if frame.len() > MAX_EVENT_BYTES + 1 {
        return fail(FailureCode::ControlProtocol);
    }
    let body = frame
        .strip_suffix(b"\n")
        .ok_or(Failure::new(FailureCode::ControlProtocol))?;
    let value: EventFrame =
        serde_json::from_slice(body).map_err(|_| Failure::new(FailureCode::ControlProtocol))?;
    if value.schema != EVENT_SCHEMA {
        return fail(FailureCode::ControlProtocol);
    }
    Ok(value)
}
fn parse_reply(bytes: &[u8], expected: u64) -> Result<DaemonResponse> {
    let text =
        std::str::from_utf8(bytes).map_err(|_| Failure::new(FailureCode::InvalidDaemonReply))?;
    let body = text
        .strip_suffix('\n')
        .ok_or(Failure::new(FailureCode::InvalidDaemonReply))?;
    let parts: Vec<_> = body.split(' ').collect();
    if !(parts.len() == 3 || parts.len() == 4)
        || parts[0] != "ok"
        || (parts.len() == 4 && parts[3] != "cached")
    {
        return fail(FailureCode::InvalidDaemonReply);
    }
    let number = |v: &str| -> Result<u64> {
        if v.is_empty()
            || (v.len() > 1 && v.starts_with('0'))
            || !v.bytes().all(|b| b.is_ascii_digit())
        {
            return fail(FailureCode::InvalidDaemonReply);
        }
        let n = v
            .parse::<u64>()
            .map_err(|_| Failure::new(FailureCode::InvalidDaemonReply))?;
        if n > SAFE {
            return fail(FailureCode::InvalidDaemonReply);
        }
        Ok(n)
    };
    let served = number(parts[1])?;
    let elapsed_ms = number(parts[2])?;
    if served != expected || served == 0 || (parts.len() == 4 && elapsed_ms != 0) {
        return fail(FailureCode::InvalidDaemonReply);
    }
    Ok(DaemonResponse {
        served,
        elapsed_ms,
        cached: parts.len() == 4,
    })
}
struct Capture {
    bytes: Vec<u8>,
    stats: CaptureStats,
}
impl Capture {
    fn new() -> Self {
        Self {
            bytes: Vec::new(),
            stats: CaptureStats::default(),
        }
    }
    fn drain(&mut self, fd: RawFd) {
        // Bound work per tick while continuing to drain/discard beyond retention.
        for _ in 0..8 {
            let mut buffer = [0u8; 8192];
            let count = unsafe { libc::read(fd, buffer.as_mut_ptr().cast(), buffer.len()) };
            if count == 0 {
                self.stats.eof = true;
                break;
            }
            if count < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                if error.kind() != io::ErrorKind::WouldBlock {
                    self.stats.io_failed = true;
                }
                break;
            }
            let count = count as usize;
            self.stats.bytes_seen = self.stats.bytes_seen.saturating_add(count as u64);
            let keep = count.min(MAX_CAPTURE - self.bytes.len());
            self.bytes.extend_from_slice(&buffer[..keep]);
            self.stats.bytes_retained = self.bytes.len();
            self.stats.truncated |= keep < count;
        }
    }
}
struct OwnedBackend {
    child: Option<Child>,
    pid: u32,
    stdout: ChildStdout,
    stderr: ChildStderr,
    out: Capture,
    err: Capture,
}
impl OwnedBackend {
    fn spawn(spec: &PinnedBackendSpec, lease: &Path, writer: Option<RawFd>) -> Result<Self> {
        let mut command = Command::new(&spec.python.path);
        command
            .args(["-I", "-S", "-B"])
            .arg(spec.hooks_dir.join("session_log_daemon.py"))
            .arg("--hooks-dir")
            .arg(&spec.hooks_dir)
            .arg("--lease-file")
            .arg(lease)
            .arg("--idle-s")
            .arg(spec.idle_seconds.to_string())
            .env_clear()
            .env("HOME", &spec.home)
            .env("PATH", &spec.search_path)
            .env("LC_ALL", "C")
            .env("CAWS_AGENT_SURFACE", &spec.agent_surface)
            .env("CAWS_SLRD_CACHE_MB", spec.cache_megabytes.to_string())
            .current_dir(&spec.work_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(view) = &spec.git_view {
            command
                .env("CAWS_SERVICE_GIT_DIRECTORY", &view.git_directory)
                .env("CAWS_SERVICE_GIT_WORK_TREE", &view.git_work_tree)
                .env(
                    "CAWS_SERVICE_GIT_ORIGINAL_DIRECTORY",
                    &view.git_original_directory,
                )
                .env(
                    "CAWS_SERVICE_GIT_COMMON_DIRECTORY",
                    &view.git_common_directory,
                );
        }
        // Only an async-signal-safe group assignment is performed after fork.
        unsafe {
            command.pre_exec(move || {
                if libc::setpgid(0, 0) != 0 {
                    return Err(io::Error::last_os_error());
                }
                if let Some(fd) = writer
                    && libc::fcntl(fd, libc::F_SETFD, 0) < 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().map_err(Failure::io)?;
        let pid = child.id();
        // Command's piped configuration guarantees these slots. The guard must
        // own the Child before any fallible pipe configuration can return.
        let stdout = child.stdout.take().expect("piped backend stdout");
        let stderr = child.stderr.take().expect("piped backend stderr");
        let backend = Self {
            child: Some(child),
            pid,
            stdout,
            stderr,
            out: Capture::new(),
            err: Capture::new(),
        };
        nonblocking(backend.stdout.as_raw_fd())?;
        nonblocking(backend.stderr.as_raw_fd())?;
        Ok(backend)
    }
    fn drain(&mut self) {
        self.out.drain(self.stdout.as_raw_fd());
        self.err.drain(self.stderr.as_raw_fd());
    }
    fn observe(&self) -> Result<bool> {
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        // WNOWAIT observes only this still-owned direct child without releasing
        // its PID/group identity. Cleanup signals before Child::try_wait/reap.
        if unsafe {
            libc::waitid(
                libc::P_PID,
                self.pid as libc::id_t,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        } != 0
        {
            return Err(Failure::io(io::Error::last_os_error()));
        }
        let info = unsafe { info.assume_init() };
        let observed = unsafe { info.si_pid() };
        if observed != 0 && observed != self.pid as libc::pid_t {
            return fail(FailureCode::ChildExited);
        }
        Ok(observed == 0)
    }
    fn live(&self) -> Result<()> {
        if self.observe()? {
            Ok(())
        } else {
            fail(FailureCode::ChildExited)
        }
    }
    fn stop_group(&self) -> Result<GroupStop> {
        // The unreaped direct child pins the group identity even after exit.
        // A failed ownership check or kill is never permission to reap it.
        #[cfg(test)]
        tests::before_stop_observe(self)?;
        self.observe()?;
        #[cfg(test)]
        tests::before_stop_signal(self)?;
        crate::owned_group::stop_before_reap(
            self.child
                .as_ref()
                .ok_or(Failure::new(FailureCode::ChildExited))?,
        )
        .map_err(|error| Failure {
            code: FailureCode::Io,
            errno: error.raw_errno,
        })
    }
}
impl Drop for OwnedBackend {
    fn drop(&mut self) {
        if self.child.is_none() {
            return;
        }
        // Exceptional cleanup retains both Child and the caller's custody
        // lifetime. Unavailable ownership/signaling quarantines rather than
        // releasing identity or pretending a finite kernel cleanup bound.
        while self.stop_group().is_err() {
            self.drain();
            thread::sleep(TICK);
        }
        if let Some(mut child) = self.child.take() {
            loop {
                match child.wait() {
                    Ok(_) => break,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                    Err(_) => thread::sleep(TICK),
                }
            }
        }
    }
}
struct PrivateDirectory {
    path: PathBuf,
    fd: OwnedFd,
    identity: (u64, u64),
}
impl PrivateDirectory {
    fn open(path: &Path) -> Result<Self> {
        if !absolute(path) || fs::canonicalize(path).map_err(Failure::io)? != path {
            return fail(FailureCode::UnsafePrivateState);
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map_err(Failure::io)?;
        let meta = file.metadata().map_err(Failure::io)?;
        if !meta.is_dir()
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o7777 != 0o700
        {
            return fail(FailureCode::UnsafePrivateState);
        }
        if fs::read_dir(path).map_err(Failure::io)?.next().is_some() {
            return fail(FailureCode::UnsafePrivateState);
        }
        Ok(Self {
            path: path.to_owned(),
            identity: (meta.dev(), meta.ino()),
            fd: file.into(),
        })
    }
    fn check(&self) -> Result<()> {
        let meta = fs::symlink_metadata(&self.path).map_err(Failure::io)?;
        if !meta.is_dir()
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o7777 != 0o700
            || (meta.dev(), meta.ino()) != self.identity
        {
            return fail(FailureCode::UnsafePrivateState);
        }
        Ok(())
    }
    fn read_lease(&self) -> Result<Option<Lease>> {
        self.check()?;
        let raw = unsafe {
            libc::openat(
                self.fd.as_raw_fd(),
                c"lease.json".as_ptr(),
                libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if raw < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ENOENT) {
                return Ok(None);
            }
            return Err(Failure::io(error));
        }
        let file = unsafe { File::from_raw_fd(raw) };
        let meta = file.metadata().map_err(Failure::io)?;
        if !meta.is_file()
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o7777 != 0o600
            || meta.nlink() != 1
            || meta.len() > MAX_LEASE
        {
            return fail(FailureCode::UnsafePrivateState);
        }
        let mut bytes = Vec::new();
        file.take(MAX_LEASE + 1)
            .read_to_end(&mut bytes)
            .map_err(Failure::io)?;
        if bytes.len() > MAX_LEASE as usize {
            return fail(FailureCode::UnsafePrivateState);
        }
        let lease = serde_json::from_slice(&bytes)
            .map_err(|_| Failure::new(FailureCode::UnsafePrivateState))?;
        self.check()?;
        Ok(Some(lease))
    }
    fn write_new(&self, name: &std::ffi::CStr, bytes: &[u8]) -> Result<()> {
        self.check()?;
        let raw = unsafe {
            libc::openat(
                self.fd.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if raw < 0 {
            return Err(Failure::io(io::Error::last_os_error()));
        }
        let mut file = unsafe { File::from_raw_fd(raw) };
        if unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } != 0 {
            return Err(Failure::io(io::Error::last_os_error()));
        }
        file.write_all(bytes).map_err(Failure::io)
    }
}
#[derive(Deserialize)]
struct Lease {
    pid: u32,
    port: u16,
    token: String,
    fingerprint: String,
    hooks_dir: String,
    served: u64,
}
impl Lease {
    fn valid(&self, pid: u32, spec: &PinnedBackendSpec, fingerprint: &str) -> bool {
        self.pid == pid
            && self.port != 0
            && self.token.len() == 32
            && self
                .token
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            && self.fingerprint == fingerprint
            && self.hooks_dir == spec.hooks_dir.to_str().expect("validated UTF-8 path")
            && self.served <= SAFE
    }
}
struct Control {
    stream: UnixStream,
    pending: Vec<u8>,
    partial_since: Option<Instant>,
    read_ms: u32,
}
impl Control {
    fn next(&mut self) -> Result<Option<HostCommand>> {
        if entry::interrupted() {
            return fail(FailureCode::HostStopped);
        }
        if let Some(start) = self.partial_since {
            deadline(start + Duration::from_millis(u64::from(self.read_ms)))?;
        }
        loop {
            if let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
                let bytes: Vec<_> = self.pending.drain(..=end).collect();
                self.partial_since = if self.pending.is_empty() {
                    None
                } else {
                    Some(Instant::now())
                };
                let frame: HostFrame = serde_json::from_slice(&bytes[..bytes.len() - 1])
                    .map_err(|_| Failure::new(FailureCode::ControlProtocol))?;
                if frame.schema != COMMAND_SCHEMA {
                    return fail(FailureCode::ControlProtocol);
                }
                if let HostCommand::Render {
                    request_id,
                    arguments,
                } = &frame.command
                {
                    if !hash(request_id) {
                        return fail(FailureCode::ControlProtocol);
                    }
                    crate::service_protocol::render_argument_digest(arguments)
                        .map_err(|_| Failure::new(FailureCode::ControlProtocol))?;
                }
                return Ok(Some(frame.command));
            }
            let mut bytes = [0u8; 8192];
            match self.stream.read(&mut bytes) {
                Ok(0) => return fail(FailureCode::HostClosed),
                Ok(n) => {
                    if self.pending.is_empty() {
                        self.partial_since = Some(Instant::now());
                    }
                    self.pending.extend_from_slice(&bytes[..n]);
                    if self.pending.len() > MAX_COMMAND_BYTES + 1 {
                        return fail(FailureCode::ControlProtocol);
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(None),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(Failure::io(error)),
            }
        }
    }
    fn watch(&mut self) -> Result<()> {
        match self.next()? {
            None => Ok(()),
            Some(HostCommand::Stop) => fail(FailureCode::HostStopped),
            Some(_) => fail(FailureCode::ControlProtocol),
        }
    }
}
struct Worker {
    control: Control,
    writer_lifetime: Option<OwnedFd>,
    group: Option<OwnedBackend>,
    directory: Option<PrivateDirectory>,
    limits: WorkerLimits,
    last_request_id: Option<String>,
    last_result: Option<RequestResult>,
    last_reply_bytes: Vec<u8>,
}
impl Worker {
    fn tick(&mut self, expires: Instant) -> Result<()> {
        self.tick_mode(expires, true)
    }
    fn tick_mode(&mut self, expires: Instant, require_live: bool) -> Result<()> {
        deadline(expires)?;
        self.control.watch()?;
        if let Some(directory) = &self.directory {
            directory.check()?;
        }
        if let Some(group) = &mut self.group {
            group.drain();
            if require_live {
                group.live()?;
            } else {
                group.observe()?;
            }
            if group.out.stats.io_failed || group.err.stats.io_failed {
                return fail(FailureCode::Io);
            }
        }
        Ok(())
    }
    fn pause(&mut self, expires: Instant) -> Result<()> {
        self.pause_mode(expires, true)
    }
    fn pause_mode(&mut self, expires: Instant, require_live: bool) -> Result<()> {
        self.tick_mode(expires, require_live)?;
        let mut fds = [libc::pollfd {
            fd: self.control.stream.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        }];
        let timeout = expires
            .saturating_duration_since(Instant::now())
            .min(TICK)
            .as_millis()
            .max(1) as i32;
        if unsafe { libc::poll(fds.as_mut_ptr(), 1, timeout) } < 0 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(Failure::io(error));
            }
        }
        self.tick_mode(expires, require_live)
    }
    fn emit(&mut self, event: WorkerEvent) -> Result<()> {
        let mut bytes = serde_json::to_vec(&EventFrame {
            schema: EVENT_SCHEMA.into(),
            event,
        })
        .map_err(|_| Failure::new(FailureCode::ControlProtocol))?;
        if bytes.len() > MAX_EVENT_BYTES {
            return fail(FailureCode::ControlProtocol);
        }
        bytes.push(b'\n');
        let expires = Instant::now() + Duration::from_millis(u64::from(self.limits.write_ms));
        let mut offset = 0;
        while offset < bytes.len() {
            deadline(expires)?;
            match socket_write(self.control.stream.as_raw_fd(), &bytes[offset..]) {
                Ok(0) => return fail(FailureCode::HostClosed),
                Ok(n) => offset += n,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    if let Some(group) = &mut self.group {
                        group.drain();
                    }
                    self.control.watch()?;
                    thread::sleep(TICK.min(expires.saturating_duration_since(Instant::now())));
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(Failure::io(error)),
            }
        }
        Ok(())
    }
    fn connect(&mut self, port: u16, expires: Instant) -> Result<TcpStream> {
        self.tick(expires)?;
        let raw = unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0) };
        if raw < 0 {
            return Err(Failure::io(io::Error::last_os_error()));
        }
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        nonblocking(fd.as_raw_fd())?;
        let mut address: libc::sockaddr_in = unsafe { std::mem::zeroed() };
        address.sin_family = libc::AF_INET as libc::sa_family_t;
        address.sin_port = port.to_be();
        address.sin_addr.s_addr = u32::from_ne_bytes([127, 0, 0, 1]);
        #[cfg(any(
            target_os = "macos",
            target_os = "ios",
            target_os = "freebsd",
            target_os = "openbsd",
            target_os = "netbsd",
            target_os = "dragonfly"
        ))]
        {
            address.sin_len = std::mem::size_of::<libc::sockaddr_in>() as u8;
        }
        let result = unsafe {
            libc::connect(
                fd.as_raw_fd(),
                (&address as *const libc::sockaddr_in).cast(),
                std::mem::size_of_val(&address) as libc::socklen_t,
            )
        };
        if result != 0 {
            let error = io::Error::last_os_error();
            if !matches!(
                error.raw_os_error(),
                Some(libc::EINPROGRESS) | Some(libc::EWOULDBLOCK) | Some(libc::EINTR)
            ) {
                return Err(Failure::io(error));
            }
            loop {
                self.tick(expires)?;
                let mut pollfd = libc::pollfd {
                    fd: fd.as_raw_fd(),
                    events: libc::POLLOUT,
                    revents: 0,
                };
                let result = unsafe { libc::poll(&mut pollfd, 1, 0) };
                if result < 0 {
                    return Err(Failure::io(io::Error::last_os_error()));
                }
                if result > 0 {
                    let mut error: libc::c_int = 0;
                    let mut len = std::mem::size_of_val(&error) as libc::socklen_t;
                    if unsafe {
                        libc::getsockopt(
                            fd.as_raw_fd(),
                            libc::SOL_SOCKET,
                            libc::SO_ERROR,
                            (&mut error as *mut libc::c_int).cast(),
                            &mut len,
                        )
                    } != 0
                    {
                        return Err(Failure::io(io::Error::last_os_error()));
                    }
                    if error != 0 {
                        return Err(Failure::io(io::Error::from_raw_os_error(error)));
                    }
                    break;
                }
                self.pause(expires)?;
            }
        }
        self.tick(expires)?;
        Ok(unsafe { TcpStream::from_raw_fd(fd.into_raw_fd()) })
    }
    fn verify_file(
        &mut self,
        file: &PinnedFile,
        max: u64,
        expires: Instant,
    ) -> Result<fs::Metadata> {
        self.tick(expires)?;
        if !absolute(&file.path)
            || !hash(&file.sha256)
            || fs::canonicalize(&file.path).map_err(Failure::io)? != file.path
        {
            return fail(FailureCode::InvalidSpec);
        }
        let mut opened = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(&file.path)
            .map_err(Failure::io)?;
        let before = opened.metadata().map_err(Failure::io)?;
        if !before.is_file() || before.len() > max {
            return fail(FailureCode::InvalidSpec);
        }
        let mut digest = Sha256::new();
        let mut total = 0u64;
        loop {
            self.tick(expires)?;
            let mut buffer = [0u8; 32768];
            let count = opened.read(&mut buffer).map_err(Failure::io)?;
            if count == 0 {
                break;
            }
            total += count as u64;
            if total > max {
                return fail(FailureCode::ImageMismatch);
            }
            digest.update(&buffer[..count]);
        }
        let after = opened.metadata().map_err(Failure::io)?;
        if (
            before.dev(),
            before.ino(),
            before.len(),
            before.mtime(),
            before.mtime_nsec(),
        ) != (
            after.dev(),
            after.ino(),
            after.len(),
            after.mtime(),
            after.mtime_nsec(),
        ) || format!("{:x}", digest.finalize()) != file.sha256
        {
            return fail(FailureCode::ImageMismatch);
        }
        Ok(before)
    }
    fn start(&mut self, spec: &PinnedBackendSpec) -> Result<(Lease, String)> {
        let expires = Instant::now() + Duration::from_millis(u64::from(self.limits.startup_ms));
        if !absolute(&spec.hooks_dir)
            || !absolute(&spec.home)
            || !hash(&spec.image_digest)
            || spec.image_files.len() > 128
            || spec.image_files.len() < 2
            || spec.idle_seconds == 0
            || spec.cache_megabytes == 0
            || spec.cache_megabytes > 4096
            || spec.agent_surface.is_empty()
            || spec.agent_surface.len() > 64
            || !spec
                .agent_surface
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
            || spec.search_path.is_empty()
            || spec.search_path.len() > 4096
            || !spec.search_path.split(':').all(|p| absolute(Path::new(p)))
        {
            return fail(FailureCode::InvalidSpec);
        }
        self.directory = Some(PrivateDirectory::open(&spec.work_dir)?);
        if let Some(view) = &spec.git_view {
            if ![
                &view.git_directory,
                &view.git_work_tree,
                &view.git_original_directory,
                &view.git_common_directory,
            ]
            .into_iter()
            .all(|path| absolute(path))
                || fs::canonicalize(&view.git_directory).map_err(Failure::io)? != view.git_directory
            {
                return fail(FailureCode::InvalidSpec);
            }
            let metadata = fs::symlink_metadata(&view.git_directory).map_err(Failure::io)?;
            if !metadata.is_dir()
                || metadata.uid() != unsafe { libc::geteuid() }
                || metadata.mode() & 0o7777 != 0o700
            {
                return fail(FailureCode::UnsafePrivateState);
            }
        }
        self.verify_file(&spec.python, 134_217_728, expires)?;
        let mut seen = BTreeSet::new();
        let mut fingerprint_entries = Vec::new();
        let mut total = 0u64;
        for file in &spec.image_files {
            if !file.path.starts_with(&spec.hooks_dir) || !seen.insert(file.path.clone()) {
                return fail(FailureCode::InvalidSpec);
            }
            let meta = self.verify_file(file, 16_777_216, expires)?;
            total = total.saturating_add(meta.len());
            if total > 67_108_864 {
                return fail(FailureCode::InvalidSpec);
            }
            let direct = file.path == spec.hooks_dir.join("session_log_daemon.py")
                || file.path == spec.hooks_dir.join("session_log_renderer.py");
            let lib = file.path.parent() == Some(spec.hooks_dir.join("lib").as_path())
                && file.path.extension().is_some_and(|s| s == "py");
            if direct || lib {
                let nanos =
                    i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec());
                fingerprint_entries.push((file.path.clone(), nanos));
            }
        }
        for name in ["session_log_daemon.py", "session_log_renderer.py"] {
            if !seen.contains(&spec.hooks_dir.join(name)) {
                return fail(FailureCode::InvalidSpec);
            }
        }
        let lib = spec.hooks_dir.join("lib");
        let mut count = 0;
        for entry in fs::read_dir(lib).map_err(Failure::io)? {
            self.tick(expires)?;
            count += 1;
            if count > 128 {
                return fail(FailureCode::InvalidSpec);
            }
            let entry = entry.map_err(Failure::io)?;
            if entry.path().extension().is_some_and(|s| s == "py") && !seen.contains(&entry.path())
            {
                return fail(FailureCode::InvalidSpec);
            }
        }
        fingerprint_entries.sort_by(|a, b| a.0.cmp(&b.0));
        let body = fingerprint_entries
            .iter()
            .map(|(p, n)| format!("{}:{n}", p.display()))
            .collect::<Vec<_>>()
            .join("\n");
        let fingerprint = format!("{:x}", Sha256::digest(body.as_bytes()));
        self.tick(expires)?;
        self.group = Some(OwnedBackend::spawn(
            spec,
            &spec.work_dir.join("lease.json"),
            self.writer_lifetime.as_ref().map(AsRawFd::as_raw_fd),
        )?);
        loop {
            self.tick(expires)?;
            let lease = self
                .directory
                .as_ref()
                .expect("private namespace")
                .read_lease()?;
            if let Some(lease) = lease {
                if !lease.valid(
                    self.group.as_ref().expect("owned backend").pid,
                    spec,
                    &fingerprint,
                ) || lease.served != 0
                {
                    return fail(FailureCode::UnsafePrivateState);
                }
                let connect_expires = (Instant::now()
                    + Duration::from_millis(u64::from(self.limits.connect_ms)))
                .min(expires);
                // No bytes or synthetic render are sent. Lease publication is
                // source-bound after imports/listen; connect only tests listener.
                drop(self.connect(lease.port, connect_expires)?);
                self.tick(expires)?;
                return Ok((lease, fingerprint));
            }
            self.pause(expires)?;
        }
    }
    fn render(
        &mut self,
        spec: &PinnedBackendSpec,
        lease: &Lease,
        fingerprint: &str,
        args: &[String; 12],
        request_id: &str,
        served: u64,
    ) -> (RequestResult, Vec<u8>) {
        let mut attempted = false;
        let mut reply = Vec::new();
        let result = (|| -> Result<DaemonResponse> {
            validate_arguments(args)?;
            let current = self
                .directory
                .as_ref()
                .expect("private namespace")
                .read_lease()?
                .ok_or(Failure::new(FailureCode::UnsafePrivateState))?;
            if !current.valid(
                self.group.as_ref().expect("owned backend").pid,
                spec,
                fingerprint,
            ) || current.port != lease.port
                || current.token != lease.token
                || current.served != served
            {
                return fail(FailureCode::UnsafePrivateState);
            }
            let mut socket = self.connect(
                lease.port,
                Instant::now() + Duration::from_millis(u64::from(self.limits.connect_ms)),
            )?;
            let mut payload = lease.token.as_bytes().to_vec();
            for value in args {
                payload.push(0x1f);
                payload.extend_from_slice(value.as_bytes());
            }
            payload.push(b'\n');
            // The daemon's receive loop has a 65536-byte cap including token,
            // separators and LF. Encoded JSON suitability alone is insufficient.
            if payload.len() > 65536 {
                return fail(FailureCode::UnsupportedLegacyWire);
            }
            let render_expires =
                Instant::now() + Duration::from_millis(u64::from(self.limits.render_ms));
            let write_expires = (Instant::now()
                + Duration::from_millis(u64::from(self.limits.write_ms)))
            .min(render_expires);
            let mut offset = 0;
            while offset < payload.len() {
                self.tick(write_expires)?;
                let first_attempt = !attempted;
                attempted = true;
                let written = socket_write(socket.as_raw_fd(), &payload[offset..]);
                if first_attempt {
                    self.emit(WorkerEvent::Progress {
                        request_id: request_id.into(),
                        phase: "write_attempted".into(),
                    })?;
                }
                match written {
                    Ok(0) => return fail(FailureCode::Io),
                    Ok(count) => offset += count,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        self.pause(write_expires)?
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                    Err(error) => return Err(Failure::io(error)),
                }
            }
            #[cfg(test)]
            tests::before_reply_read(self.group.as_ref().expect("owned backend"))?;
            let mut read_expires = None;
            loop {
                let expires = read_expires.unwrap_or(render_expires).min(render_expires);
                self.tick_mode(expires, false)?;
                let mut bytes = [0u8; 512];
                match socket.read(&mut bytes) {
                    Ok(0) => break,
                    Ok(count) => {
                        if read_expires.is_none() {
                            read_expires = Some(
                                Instant::now()
                                    + Duration::from_millis(u64::from(self.limits.read_ms)),
                            );
                        }
                        reply.extend_from_slice(&bytes[..count]);
                        if reply.len() > MAX_REPLY {
                            return fail(FailureCode::InvalidDaemonReply);
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        self.pause_mode(expires, false)?
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                    Err(error) => return Err(Failure::io(error)),
                }
            }
            self.tick_mode(render_expires, false)?;
            let next = served
                .checked_add(1)
                .ok_or(Failure::new(FailureCode::InvalidDaemonReply))?;
            parse_reply(&reply, next)
        })();
        match result {
            Ok(response) => (RequestResult::Returned { response }, reply),
            Err(failure) => {
                reply.truncate(MAX_REPLY);
                (
                    if attempted {
                        RequestResult::Unknown { failure }
                    } else {
                        RequestResult::KnownNotAttempted { failure }
                    },
                    reply,
                )
            }
        }
    }
    fn cleanup(&mut self) -> CleanupReceipt {
        let mut receipt = CleanupReceipt {
            child_pid: self.group.as_ref().map(|g| g.pid),
            direct_child_reaped: false,
            backend_exit: None,
            identity_verified_before_signal: false,
            group_signal_accepted: false,
            group_exited_only: None,
            group_signal_errno: None,
            reap_error_errno: None,
            deadline_exceeded: false,
            stdout: CaptureStats::default(),
            stderr: CaptureStats::default(),
            logs_persisted: false,
            cleanup_elapsed_ms: 0,
        };
        let cleanup_started = Instant::now();
        let expires = cleanup_started + Duration::from_millis(u64::from(self.limits.cleanup_ms));
        let mut stopped = false;
        let mut reported = false;
        loop {
            let mut complete = self.group.is_none();
            if let Some(group) = &mut self.group {
                group.drain();
                if !stopped {
                    match group.stop_group() {
                        Ok(result) => {
                            stopped = true;
                            receipt.identity_verified_before_signal = true;
                            receipt.group_signal_accepted = matches!(result, GroupStop::Signalled);
                            receipt.group_signal_errno = match result {
                                GroupStop::Signalled => None,
                                GroupStop::Absent => Some(libc::ESRCH),
                                GroupStop::ExitedOnly { observation } => {
                                    receipt.group_exited_only = Some(observation);
                                    Some(libc::EPERM)
                                }
                            };
                        }
                        Err(failure) => receipt.group_signal_errno = failure.errno,
                    }
                }
                if stopped && let Some(child) = &mut group.child {
                    #[cfg(test)]
                    tests::before_reap();
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            receipt.direct_child_reaped = true;
                            receipt.backend_exit = Some(exit(status));
                            group.child = None;
                        }
                        Ok(None) => {}
                        Err(error) => receipt.reap_error_errno = error.raw_os_error(),
                    }
                }
                complete = group.child.is_none() && group.out.stats.eof && group.err.stats.eof;
            }
            if Instant::now() >= expires {
                receipt.deadline_exceeded = true;
                if !reported {
                    reported = true;
                    let _ = self.emit(WorkerEvent::CleanupDeadline {
                        child_pid: receipt.child_pid.unwrap_or(0),
                    });
                }
                // A deadline is a quarantine report, not permission to release
                // custody. Retain the worker until both actual reap and pipe
                // EOF; a holder can outlive the leader's wait status.
            }
            if complete {
                break;
            }
            thread::sleep(TICK);
        }
        if let Some(group) = &mut self.group {
            group.drain();
            receipt.stdout = group.out.stats.clone();
            receipt.stderr = group.err.stats.clone();
            if let Some(directory) = &self.directory {
                receipt.logs_persisted =
                    directory.write_new(c"stdout.bin", &group.out.bytes).is_ok()
                        && directory.write_new(c"stderr.bin", &group.err.bytes).is_ok();
            }
        }
        receipt.deadline_exceeded |= Instant::now() >= expires;
        receipt.cleanup_elapsed_ms =
            cleanup_started.elapsed().as_millis().min(u128::from(SAFE)) as u64;
        receipt
    }
}
fn exit(status: ExitStatus) -> BackendExit {
    BackendExit {
        code: status.code(),
        signal: status.signal(),
    }
}
/// Root wires this entry in a separate native worker process. The host keeps the
/// worker Child; this worker alone retains the backend Child until actual reap.
/// EOF/control Stop is observed during every polling phase. No global signal
/// handler or process-global locale/environment mutation occurs here. The host
/// transfers its guarded machine-custody duplicate (reserved FD6) here; it is
/// liveness/capacity only, never project authority, and never inherited by Python.
pub fn run_worker(
    spec: PinnedBackendSpec,
    control: UnixStream,
    limits: WorkerLimits,
    custody_lifetime: OwnedFd,
) -> WorkerExit {
    run_worker_inner(spec, control, limits, custody_lifetime, None)
}
/// The production entry requires this actual shared project-writer descriptor.
/// The worker retains it and only its actual backend exec inherits a duplicate.
pub fn run_worker_with_writer(
    spec: PinnedBackendSpec,
    control: UnixStream,
    limits: WorkerLimits,
    custody_lifetime: OwnedFd,
    writer_lifetime: OwnedFd,
) -> WorkerExit {
    run_worker_inner(
        spec,
        control,
        limits,
        custody_lifetime,
        Some(writer_lifetime),
    )
}
fn run_worker_inner(
    spec: PinnedBackendSpec,
    control: UnixStream,
    limits: WorkerLimits,
    custody_lifetime: OwnedFd,
    writer_lifetime: Option<OwnedFd>,
) -> WorkerExit {
    let empty = || CleanupReceipt {
        child_pid: None,
        direct_child_reaped: false,
        backend_exit: None,
        identity_verified_before_signal: false,
        group_signal_accepted: false,
        group_exited_only: None,
        group_signal_errno: None,
        reap_error_errno: None,
        deadline_exceeded: false,
        stdout: CaptureStats::default(),
        stderr: CaptureStats::default(),
        logs_persisted: false,
        cleanup_elapsed_ms: 0,
    };
    if let Err(failure) = limits
        .validate()
        .and_then(|_| close_on_exec(custody_lifetime.as_raw_fd()))
        .and_then(|_| {
            writer_lifetime
                .as_ref()
                .map_or(Ok(()), |fd| close_on_exec(fd.as_raw_fd()))
        })
        .and_then(|_| nonblocking(control.as_raw_fd()))
    {
        return WorkerExit {
            failure: Some(failure),
            last_request_id: None,
            last_result: None,
            last_reply_bytes: Vec::new(),
            cleanup: empty(),
        };
    }
    let mut worker = Worker {
        writer_lifetime,
        control: Control {
            stream: control,
            pending: Vec::new(),
            partial_since: None,
            read_ms: limits.read_ms,
        },
        group: None,
        directory: None,
        limits,
        last_request_id: None,
        last_result: None,
        last_reply_bytes: Vec::new(),
    };
    let started = Instant::now();
    let result = (|| -> Result<()> {
        let (lease, fingerprint) = worker.start(&spec)?;
        worker.emit(WorkerEvent::Ready {
            readiness: "owned_child_lease_and_listener".into(),
            child_pid: worker.group.as_ref().expect("owned backend").pid,
            image_digest: spec.image_digest.clone(),
            startup_elapsed_ms: started.elapsed().as_millis().min(u128::from(SAFE)) as u64,
        })?;
        let mut served = 0;
        loop {
            if let Some(group) = &mut worker.group {
                group.drain();
                group.live()?;
            }
            match worker.control.next()? {
                None => thread::sleep(TICK),
                Some(HostCommand::Stop) => return fail(FailureCode::HostStopped),
                Some(HostCommand::Render {
                    request_id,
                    arguments,
                }) => {
                    let (result, reply_bytes) =
                        worker.render(&spec, &lease, &fingerprint, &arguments, &request_id, served);
                    let terminal = match &result {
                        RequestResult::Unknown { failure } => Some(*failure),
                        RequestResult::KnownNotAttempted { failure }
                            if !matches!(
                                failure.code,
                                FailureCode::UnsupportedLegacyWire | FailureCode::InvalidArguments
                            ) =>
                        {
                            Some(*failure)
                        }
                        _ => None,
                    };
                    if let RequestResult::Returned { response } = &result {
                        served = response.served;
                    }
                    worker.last_request_id = Some(request_id.clone());
                    worker.last_result = Some(result.clone());
                    worker.last_reply_bytes = reply_bytes.clone();
                    worker.emit(WorkerEvent::Result {
                        request_id,
                        result,
                        reply_bytes,
                    })?;
                    if let Some(failure) = terminal {
                        return Err(failure);
                    }
                }
            }
        }
    })();
    let failure = result.err();
    if let Some(failure) = failure {
        let _ = worker.emit(WorkerEvent::Failed { failure });
    }
    let cleanup = worker.cleanup();
    let _ = worker.emit(WorkerEvent::Cleanup {
        receipt: cleanup.clone(),
    });
    let result = WorkerExit {
        failure,
        last_request_id: worker.last_request_id.clone(),
        last_result: worker.last_result.clone(),
        last_reply_bytes: worker.last_reply_bytes.clone(),
        cleanup,
    };
    if let Some(directory) = &worker.directory
        && let Ok(bytes) = serde_json::to_vec_pretty(&result)
    {
        let _ = directory.write_new(c"worker-exit.json", &bytes);
    }
    // Worker/OwnedBackend drops before the liveness-only custody duplicate.
    // Normal cleanup has already reaped; exceptional Drop retains actual wait.
    drop(worker);
    drop(custody_lifetime);
    result
}
#[cfg(test)]
mod tests;
