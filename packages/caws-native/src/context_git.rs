//! Finite context Git execution. The frontend owns a native custodian, and that
//! custodian retains the actual Git Child until group settlement and both EOFs.
//! Executable metadata detects ordinary replacement; it does not bind exec to
//! an immutable file description or attest a wrapper's transitive programs.
use crate::monotonic_deadline::MonotonicDeadline;
use crate::owned_group::{GroupSettlement, settlement_before_reap, stop_before_reap};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    fs,
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::{
            ffi::{OsStrExt, OsStringExt},
            fs::MetadataExt,
            net::UnixStream,
            process::{CommandExt, ExitStatusExt},
        },
    },
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicI32, Ordering},
    },
    time::{Duration, Instant},
};

#[path = "context_git/original_project.rs"]
pub mod original_project;

#[path = "context_git/render.rs"]
pub mod render;

#[path = "context_git/stop.rs"]
pub mod stop;

pub const MAX_REQUEST: usize = 32 * 1024;
pub const MAX_RESULT: usize = 2 * 1024 * 1024;
pub const MAX_OUTPUT: usize = 1024 * 1024;
pub const CAPABILITY: &str = "caws.runtime.context-git.v1";
pub const EXECUTION_WORKDIR_CAPABILITY: &str = "caws.runtime.context-git.execution-workdir.v1";
pub const MAX_EXTRA_ENGINE_STDOUT_BYTES: usize = 2 * (MAX_REQUEST + 1);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Profile {
    Ordinary,
    ExecutionWorkdir,
}
impl Profile {
    pub const fn capability(self) -> &'static str {
        match self {
            Self::Ordinary => CAPABILITY,
            Self::ExecutionWorkdir => EXECUTION_WORKDIR_CAPABILITY,
        }
    }
    const fn requests(self) -> u8 {
        match self {
            Self::Ordinary => 2,
            Self::ExecutionWorkdir => 4,
        }
    }
    pub const fn control_credit_limit(self) -> usize {
        self.requests() as usize * (MAX_REQUEST + 1)
    }
}
// The owning invocation transport admits 8MiB. Byte-array JSON can encode an
// inherited byte as four characters (255,); retain that full admitted domain.
const MAX_CONFIGURATION: usize = 4 * 8 * 1024 * 1024 + MAX_REQUEST;
const CLEANUP: Duration = Duration::from_millis(500);
const TICK: Duration = Duration::from_millis(5);
const REQUEST_SCHEMA: &str = "caws.runtime.context-git.request.v1";
const RESULT_SCHEMA: &str = "caws.runtime.context-git.result.v1";

/// Capture this environment before starting Node. Requests cannot add env/argv.
pub struct Invocation {
    pub id: String,
    pub runtime_digest: String,
    pub deadline: Instant,
    pub environment: Vec<(OsString, OsString)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Operation {
    #[serde(rename = "checkout")]
    Checkout,
    #[serde(rename = "commonDir")]
    CommonDir,
}
impl Operation {
    fn argv(self) -> &'static [&'static str] {
        match self {
            Self::Checkout => &["rev-parse", "--show-toplevel"],
            Self::CommonDir => &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Request {
    schema: String,
    id: String,
    runtime_digest: String,
    token: String,
    ordinal: u8,
    operation: Operation,
    executable: PathBuf,
    cwd: PathBuf,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Cleanup {
    pub group_settled: bool,
    pub stdout_eof: bool,
    pub stderr_eof: bool,
    pub reaped: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ResultFrame {
    schema: String,
    id: String,
    runtime_digest: String,
    token: String,
    ordinal: u8,
    operation: Operation,
    pub status: String,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub cleanup: Cleanup,
    pub diagnostic: String,
}
fn result(request: &Request, status: &str, diagnostic: &str) -> ResultFrame {
    let mut end = diagnostic.len().min(1024);
    while !diagnostic.is_char_boundary(end) {
        end -= 1;
    }
    ResultFrame {
        schema: RESULT_SCHEMA.into(),
        id: request.id.clone(),
        runtime_digest: request.runtime_digest.clone(),
        token: request.token.clone(),
        ordinal: request.ordinal,
        operation: request.operation,
        status: status.into(),
        exit_code: None,
        signal: None,
        stdout: String::new(),
        stderr: String::new(),
        cleanup: Cleanup::default(),
        diagnostic: diagnostic[..end].into(),
    }
}
fn lower_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}
fn nonblocking(fd: RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
fn monotonic_ns() -> u64 {
    let mut time = std::mem::MaybeUninit::<libc::timespec>::zeroed();
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, time.as_mut_ptr()) } != 0 {
        return 0;
    }
    let time = unsafe { time.assume_init() };
    (time.tv_sec as u64)
        .saturating_mul(1_000_000_000)
        .saturating_add(time.tv_nsec as u64)
}

pub struct ContextGitOwner {
    invocation: Invocation,
    profile: Profile,
    binding: Option<(String, PathBuf)>,
    next: u8,
    active: Arc<AtomicBool>,
    ready: bool,
}
impl ContextGitOwner {
    pub fn new(invocation: Invocation) -> Result<Self, String> {
        Self::new_with_profile(invocation, Profile::Ordinary)
    }
    /// Profile is selected from the native Request, never a Git request frame.
    pub fn new_with_profile(invocation: Invocation, profile: Profile) -> Result<Self, String> {
        if invocation.id.is_empty()
            || invocation.id.len() > 128
            || !lower_hex(&invocation.runtime_digest)
        {
            return Err("invalid context Git invocation identity".into());
        }
        Ok(Self {
            invocation,
            profile,
            binding: None,
            next: 1,
            active: Arc::new(AtomicBool::new(false)),
            ready: false,
        })
    }
    pub fn control_credit_limit(&self) -> usize {
        self.profile.control_credit_limit()
    }
    pub fn mark_ready(&mut self) -> Result<(), String> {
        if self.active.load(Ordering::Acquire) {
            return Err("context Git still active at Ready".into());
        }
        self.ready = true;
        Ok(())
    }
    pub fn begin(&mut self, frame: &[u8]) -> Result<PendingGit, String> {
        if self.ready || self.active.load(Ordering::Acquire) || self.next > self.profile.requests()
        {
            return Err("context Git overlap, replay or request after Ready".into());
        }
        if frame.len() > MAX_REQUEST {
            return Err("context Git request exceeds 32KiB".into());
        }
        let request: Request =
            serde_json::from_slice(frame).map_err(|e| format!("context Git request: {e}"))?;
        if request.schema != REQUEST_SCHEMA
            || request.id != self.invocation.id
            || request.runtime_digest != self.invocation.runtime_digest
            || !lower_hex(&request.token)
            || request.ordinal != self.next
            || !request.executable.is_absolute()
            || !request.cwd.is_absolute()
            || request.operation
                != if self.next % 2 == 1 {
                    Operation::Checkout
                } else {
                    Operation::CommonDir
                }
        {
            return Err("context Git request identity, ordinal, operation or path differs".into());
        }
        if self.binding.as_ref().is_some_and(|(token, executable)| {
            token != &request.token || executable != &request.executable
        }) {
            return Err("context Git token or executable changed".into());
        }
        self.binding
            .get_or_insert_with(|| (request.token.clone(), request.executable.clone()));
        self.next += 1;
        let invocation_expires_ns = monotonic_ns().saturating_add(
            self.invocation
                .deadline
                .saturating_duration_since(Instant::now())
                .as_nanos()
                .min(u64::MAX as u128) as u64,
        );
        let available = self
            .invocation
            .deadline
            .saturating_duration_since(Instant::now());
        let execution = available
            .checked_sub(CLEANUP)
            .unwrap_or_default()
            .min(Duration::from_secs(5));
        if execution.is_zero() {
            let mut row = result(
                &request,
                "deadline",
                "insufficient context Git execution budget; no child created",
            );
            row.cleanup = Cleanup {
                group_settled: true,
                stdout_eof: true,
                stderr_eof: true,
                reaped: true,
            };
            return Ok(PendingGit::immediate(request, row, self.active.clone()));
        }
        if !cfg!(target_os = "macos") {
            return Err("context Git group settlement requires macOS".into());
        }
        let environment = self
            .invocation
            .environment
            .iter()
            .filter(|(name, _)| {
                let name = name.as_bytes();
                !name.starts_with(b"GIT_") && !name.starts_with(b"HOOK_")
            })
            .map(|(name, value)| (name.as_bytes().to_vec(), value.as_bytes().to_vec()))
            .collect();
        let configuration = Configuration {
            request: request.clone(),
            environment,
            expires_ns: monotonic_ns()
                .saturating_add(execution.as_nanos() as u64)
                .min(invocation_expires_ns.saturating_sub(CLEANUP.as_nanos() as u64)),
        };
        let mut input = serde_json::to_vec(&configuration).map_err(|e| e.to_string())?;
        if input.len() >= MAX_CONFIGURATION {
            return Err("context Git environment exceeds configuration bound".into());
        }
        input.push(b'\n');
        let (control, remote) = UnixStream::pair().map_err(|e| e.to_string())?;
        control.set_nonblocking(true).map_err(|e| e.to_string())?;
        let fd = unsafe { libc::fcntl(remote.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 64) };
        if fd < 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        let remote = unsafe { OwnedFd::from_raw_fd(fd) };
        let mut command = Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
        command
            .arg("context-git-custodian")
            .arg(fd.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // The native custodian does not load frontend-controlled preload images.
        for (name, _) in std::env::vars_os() {
            if name.as_bytes().starts_with(b"DYLD_") || name.as_bytes().starts_with(b"LD_") {
                command.env_remove(name);
            }
        }
        unsafe {
            command.pre_exec(move || {
                if libc::setsid() < 0 || libc::fcntl(fd, libc::F_SETFD, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let mut row = result(
                    &request,
                    "spawn_failed",
                    &format!("context Git custodian spawn: {error}"),
                );
                row.cleanup = Cleanup {
                    group_settled: true,
                    stdout_eof: true,
                    stderr_eof: true,
                    reaped: true,
                };
                return Ok(PendingGit::immediate(request, row, self.active.clone()));
            }
        };
        drop(remote);
        self.active.store(true, Ordering::Release);
        Ok(PendingGit {
            request,
            child: Some(child),
            control: Some(control),
            input,
            written: 0,
            output: Vec::new(),
            immediate: None,
            validated: None,
            control_eof: false,
            active: self.active.clone(),
            cancelled: false,
            cleanup_requested: false,
            delivered: false,
        })
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    request: Request,
    environment: Vec<(Vec<u8>, Vec<u8>)>,
    expires_ns: u64,
}

/// Poll this together with Node's descriptors. Dropping closes sole liveness;
/// the native custodian continues custody instead of relying on frontend Drop.
pub struct PendingGit {
    request: Request,
    child: Option<Child>,
    control: Option<UnixStream>,
    input: Vec<u8>,
    written: usize,
    output: Vec<u8>,
    immediate: Option<ResultFrame>,
    validated: Option<Vec<u8>>,
    control_eof: bool,
    active: Arc<AtomicBool>,
    cancelled: bool,
    cleanup_requested: bool,
    delivered: bool,
}
impl PendingGit {
    fn immediate(request: Request, row: ResultFrame, active: Arc<AtomicBool>) -> Self {
        Self {
            request,
            child: None,
            control: None,
            input: Vec::new(),
            written: 0,
            output: Vec::new(),
            immediate: Some(row),
            validated: None,
            control_eof: false,
            active,
            cancelled: false,
            cleanup_requested: false,
            delivered: false,
        }
    }
    pub fn interests(&self) -> Vec<libc::pollfd> {
        self.control
            .as_ref()
            .map(|stream| libc::pollfd {
                fd: stream.as_raw_fd(),
                events: libc::POLLIN
                    | if self.written < self.input.len() {
                        libc::POLLOUT
                    } else {
                        0
                    },
                revents: 0,
            })
            .into_iter()
            .collect()
    }
    pub fn cancel(&mut self) {
        if self.validated.is_some() {
            return;
        }
        self.cancelled = true;
        // Cancelling before configuration delivery must not finish that config.
        if self.written < self.input.len() {
            self.control.take();
            let mut row = result(
                &self.request,
                "cancelled",
                "cancelled before complete custodian configuration; no Git child created",
            );
            row.cleanup = Cleanup {
                group_settled: true,
                stdout_eof: true,
                stderr_eof: true,
                reaped: true,
            };
            self.immediate = Some(row);
            self.active.store(false, Ordering::Release);
        }
    }
    pub fn advance(&mut self) -> Result<Option<Vec<u8>>, String> {
        self.advance_checked(|| Ok(()))
    }
    pub fn advance_until(
        &mut self,
        original: &MonotonicDeadline,
        until: Instant,
    ) -> Result<Option<Vec<u8>>, String> {
        self.advance_checked(|| frontend_cleanup_check(original, until).map(|_| ()))
    }
    fn advance_checked(
        &mut self,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<Option<Vec<u8>>, String> {
        check()?;
        if self.delivered {
            return Ok(None);
        }
        if let Some(row) = self.immediate.take() {
            self.delivered = true;
            return serde_json::to_vec(&row)
                .map(Some)
                .map_err(|e| e.to_string());
        }
        let Some(stream) = self.control.as_mut() else {
            return Err(
                "context Git cancellation closed control; custodian retains cleanup".into(),
            );
        };
        if self.validated.is_some() {
            if !self.control_eof {
                let mut trailing = [0u8; 1];
                check()?;
                match stream.read(&mut trailing) {
                    Ok(0) => self.control_eof = true,
                    Ok(_) => {
                        return Err(
                            "context Git custodian sent data after its complete result".into()
                        );
                    }
                    Err(e)
                        if matches!(
                            e.kind(),
                            io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                        ) =>
                    {
                        ()
                    }
                    Err(e) => return Err(format!("context Git custodian completion: {e}")),
                }
            }
            if !self.control_eof {
                return Ok(None);
            }
            let Some(child) = self.child.as_mut() else {
                return Err("missing original context Git custodian Child".into());
            };
            check()?;
            match child
                .try_wait()
                .map_err(|e| format!("context Git custodian reap: {e}"))?
            {
                None => return Ok(None),
                Some(status) if !status.success() => {
                    return Err(format!(
                        "context Git custodian exited abnormally after result: {status}"
                    ));
                }
                Some(_) => {
                    self.child.take();
                }
            }
            self.control.take();
            self.active.store(false, Ordering::Release);
            self.delivered = true;
            return Ok(self.validated.take());
        }
        if self.written < self.input.len() {
            check()?;
            match stream.write(&self.input[self.written..]) {
                Ok(0) => return Err("context Git configuration write made no progress".into()),
                Ok(n) => self.written += n,
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) =>
                {
                    ()
                }
                Err(e) => return Err(format!("context Git configuration: {e}")),
            }
        } else if self.cancelled {
            check()?;
            match stream.write(b"S") {
                Ok(1) => self.cancelled = false,
                Ok(_) => (),
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) =>
                {
                    ()
                }
                Err(e) => return Err(format!("context Git cancellation: {e}")),
            }
        }
        let mut bytes = [0u8; 16_384];
        check()?;
        match stream.read(&mut bytes) {
            Ok(0) => return Err("context Git custodian closed without a complete result".into()),
            Ok(n) => self.output.extend_from_slice(&bytes[..n]),
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                ()
            }
            Err(e) => return Err(format!("context Git result: {e}")),
        }
        if self.output.len() > MAX_RESULT {
            return Err("context Git result exceeds 2MiB".into());
        }
        let Some(end) = self.output.iter().position(|&v| v == b'\n') else {
            return Ok(None);
        };
        if end + 1 != self.output.len() {
            return Err("context Git custodian sent trailing result bytes".into());
        }
        check()?;
        let row: ResultFrame = serde_json::from_slice(&self.output[..end])
            .map_err(|e| format!("context Git result decode: {e}"))?;
        if row.schema != RESULT_SCHEMA
            || row.id != self.request.id
            || row.runtime_digest != self.request.runtime_digest
            || row.token != self.request.token
            || row.ordinal != self.request.ordinal
            || row.operation != self.request.operation
            || row.diagnostic.len() > 1024
            || !matches!(
                row.status.as_str(),
                "exited"
                    | "spawn_failed"
                    | "cancelled"
                    | "deadline"
                    | "output_limit"
                    | "cleanup_unsettled"
                    | "identity_changed"
            )
            || STANDARD
                .decode(&row.stdout)
                .map_err(|e| e.to_string())?
                .len()
                + STANDARD
                    .decode(&row.stderr)
                    .map_err(|e| e.to_string())?
                    .len()
                > MAX_OUTPUT
        {
            return Err("context Git result identity or bounds differs".into());
        }
        if row.cleanup.reaped
            && row.cleanup.group_settled
            && row.cleanup.stdout_eof
            && row.cleanup.stderr_eof
        {
            self.validated = Some(self.output[..end].to_vec());
            return Ok(None);
        } else if row.status != "cleanup_unsettled" {
            return Err("context Git result claims completion without settlement".into());
        }
        self.delivered = true;
        Ok(Some(self.output[..end].to_vec()))
    }
    /// Frontend cleanup cannot add time to the retained original invocation.
    /// Expiry leaves this value holding its actual custodian and uncertain frame.
    pub fn cancel_and_settle_until(
        &mut self,
        original: &MonotonicDeadline,
        until: Instant,
    ) -> Result<Option<Vec<u8>>, String> {
        if !self.cleanup_requested {
            self.cleanup_requested = true;
            self.cancel();
            if let Some(stream) = &mut self.control {
                if self.cancelled {
                    let _ = stream.write(b"S");
                    self.cancelled = false;
                }
                // EOF requests owned cleanup even if the best-effort stop byte
                // could not be delivered. No configuration is resumed afterward.
                let _ = stream.shutdown(std::net::Shutdown::Write);
            }
        }
        let until = until.min(original.expires());
        loop {
            if self.delivered {
                if self.active.load(Ordering::Acquire) {
                    return Err("context Git cleanup remains uncertain after delivered result; native custodian retains original Child".into());
                }
                // An immediate no-Git result still retains its actual custodian
                // until that original Child is observed exiting successfully.
                if let Some(child) = self.child.as_mut() {
                    frontend_cleanup_check(original, until)?;
                    match child.try_wait().map_err(|e| e.to_string())? {
                        Some(status) if status.success() => {
                            self.child.take();
                        }
                        Some(status) => {
                            return Err(format!(
                                "context Git custodian exited abnormally: {status}"
                            ));
                        }
                        None => {
                            frontend_cleanup_poll(original, until, &mut [])?;
                            continue;
                        }
                    }
                }
                return Ok(None);
            }
            frontend_cleanup_check(original, until)?;
            if let Some(frame) =
                self.advance_checked(|| frontend_cleanup_check(original, until).map(|_| ()))?
            {
                frontend_cleanup_check(original, until)?;
                return if self.active.load(Ordering::Acquire) || self.child.is_some() {
                    Err("context Git result retained uncertain custodian cleanup".into())
                } else {
                    Ok(Some(frame))
                };
            }
            let mut fds = self.interests();
            frontend_cleanup_poll(original, until, &mut fds)?;
        }
    }
    pub fn cancel_and_settle(&mut self, deadline: Instant) -> Result<Option<Vec<u8>>, String> {
        if self.delivered {
            return if self.active.load(Ordering::Acquire) {
                Err("context Git cleanup remains uncertain after delivered result; native custodian retains original Child".into())
            } else {
                Ok(None)
            };
        }
        self.cancel();
        loop {
            if let Some(frame) = self.advance()? {
                return Ok(Some(frame));
            }
            if Instant::now() >= deadline {
                return Err("context Git cleanup pending in native custodian".into());
            }
            let mut fds = self.interests();
            unsafe {
                libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, 5);
            }
        }
    }
}
impl Drop for PendingGit {
    fn drop(&mut self) {
        self.control.take();
        // Passive join only. The custodian is never killed to produce a receipt.
        if let Some(mut child) = self.child.take() {
            let _ = std::thread::Builder::new()
                .name("caws-context-git-reap".into())
                .spawn(move || {
                    let _ = child.wait();
                });
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Identity {
    dev: u64,
    ino: u64,
    len: u64,
    mtime: i64,
    mtime_nsec: i64,
    ctime: i64,
    ctime_nsec: i64,
}
fn identity(path: &PathBuf) -> io::Result<Identity> {
    let meta = fs::metadata(path)?;
    if !meta.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "context Git executable is not a file",
        ));
    }
    Ok(Identity {
        dev: meta.dev(),
        ino: meta.ino(),
        len: meta.len(),
        mtime: meta.mtime(),
        mtime_nsec: meta.mtime_nsec(),
        ctime: meta.ctime(),
        ctime_nsec: meta.ctime_nsec(),
    })
}
static SIGNAL: AtomicI32 = AtomicI32::new(0);
extern "C" fn interrupted(signal: i32) {
    SIGNAL.store(signal, Ordering::Relaxed);
}
fn configure_signals() -> io::Result<()> {
    for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP, libc::SIGPIPE] {
        let mut action = unsafe { std::mem::zeroed::<libc::sigaction>() };
        action.sa_sigaction = interrupted as *const () as usize;
        unsafe {
            libc::sigemptyset(&mut action.sa_mask);
        }
        if unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}
/// A frontend observation bound, never a new operation or cleanup allowance.
/// Custodians keep their separate actual-child responsibility after it expires.
pub(crate) fn frontend_cleanup_check(
    original: &MonotonicDeadline,
    until: Instant,
) -> Result<Instant, String> {
    original
        .check()
        .map_err(|error| format!("frontend cleanup deadline: {error}; custody retained"))?;
    let until = until.min(original.expires());
    if Instant::now() >= until {
        return Err("frontend cleanup deadline expired; custody retained".into());
    }
    Ok(until)
}
pub(crate) fn frontend_cleanup_poll(
    original: &MonotonicDeadline,
    until: Instant,
    fds: &mut [libc::pollfd],
) -> Result<(), String> {
    let until = frontend_cleanup_check(original, until)?;
    let milliseconds = until
        .saturating_duration_since(Instant::now())
        .min(TICK)
        .as_millis() as i32;
    let result = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, milliseconds) };
    if result < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
        return Err(format!(
            "frontend cleanup poll: {}",
            io::Error::last_os_error()
        ));
    }
    frontend_cleanup_check(original, until).map(|_| ())
}
fn tick(fds: &mut [libc::pollfd]) {
    unsafe {
        libc::poll(
            fds.as_mut_ptr(),
            fds.len() as libc::nfds_t,
            TICK.as_millis() as i32,
        );
    }
}
fn observe_exit(child: &Child, row: &mut QueryReceipt) -> bool {
    if row.exit_code.is_some() || row.signal.is_some() {
        return true;
    }
    let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
    if unsafe {
        libc::waitid(
            libc::P_PID,
            child.id(),
            info.as_mut_ptr(),
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    } != 0
    {
        return false;
    }
    let info = unsafe { info.assume_init() };
    if unsafe { info.si_pid() } != child.id() as i32 {
        return false;
    }
    if info.si_code == libc::CLD_EXITED {
        row.exit_code = Some(unsafe { info.si_status() });
    } else if matches!(info.si_code, libc::CLD_KILLED | libc::CLD_DUMPED) {
        row.signal = Some(unsafe { info.si_status() });
    }
    row.exit_code.is_some() || row.signal.is_some()
}
fn publish(stream: &mut UnixStream, row: &ResultFrame) -> bool {
    let Ok(bytes) = serde_json::to_vec(row) else {
        return false;
    };
    if bytes.len() >= MAX_RESULT {
        return false;
    }
    publish_bytes(stream, bytes)
}

// Callers retain their distinct frame size contracts before entering this
// bounded nonblocking writer. Sending a receipt does not release child custody.
fn publish_bytes(stream: &mut UnixStream, mut bytes: Vec<u8>) -> bool {
    bytes.push(b'\n');
    let deadline = Instant::now() + CLEANUP;
    let mut sent = 0;
    while sent < bytes.len() && Instant::now() < deadline {
        match stream.write(&bytes[sent..]) {
            Ok(0) => return false,
            Ok(n) => sent += n,
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                tick(&mut [libc::pollfd {
                    fd: stream.as_raw_fd(),
                    events: libc::POLLOUT,
                    revents: 0,
                }])
            }
            Err(_) => return false,
        }
    }
    sent == bytes.len()
}

/// Binary-private mode entry. Call before normal CLI parsing. The inherited
/// socket is the sole frontend liveness capability and is CLOEXEC before Git.
pub fn run_custodian(fd: RawFd) -> Result<(), String> {
    if fd < 64 || !cfg!(target_os = "macos") {
        return Err("invalid/unsupported context Git custodian descriptor".into());
    }
    let mut kind = 0i32;
    let mut size = std::mem::size_of::<i32>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_TYPE,
            (&mut kind as *mut i32).cast(),
            &mut size,
        )
    } != 0
        || kind != libc::SOCK_STREAM
    {
        return Err("context Git custodian requires a stream socket".into());
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error().to_string());
    }
    let mut stream = unsafe { UnixStream::from_raw_fd(fd) };
    nonblocking(fd).map_err(|e| e.to_string())?;
    configure_signals().map_err(|e| e.to_string())?;
    let start = Instant::now();
    let mut bytes = Vec::new();
    let (configuration_bytes, configuration_cancelled): (Vec<u8>, bool) = loop {
        let mut part = [0u8; 8192];
        match stream.read(&mut part) {
            Ok(0) => return Ok(()),
            Ok(n) => bytes.extend_from_slice(&part[..n]),
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                ()
            }
            Err(e) => return Err(e.to_string()),
        }
        if bytes.len() > MAX_CONFIGURATION {
            return Err("context Git custodian configuration too large".into());
        }
        if let Some(end) = bytes.iter().position(|&b| b == b'\n') {
            // A complete configuration plus a coalesced stop byte retains the
            // correlation needed for a truthful no-child cancellation result.
            break (bytes[..end].to_vec(), !bytes[end + 1..].is_empty());
        }
        if start.elapsed() >= Duration::from_secs(5) || SIGNAL.load(Ordering::Relaxed) != 0 {
            return Ok(());
        }
        tick(&mut [libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        }]);
    };
    #[derive(Deserialize)]
    struct Schema {
        schema: Option<String>,
    }
    let envelope: Schema = serde_json::from_slice(&configuration_bytes)
        .map_err(|e| format!("context Git configuration: {e}"))?;
    if envelope.schema.as_deref() == Some(original_project::CONFIG_SCHEMA) {
        return original_project::run_configuration(
            &mut stream,
            &configuration_bytes,
            configuration_cancelled,
        );
    }
    if envelope.schema.as_deref() == Some(stop::CONFIG_SCHEMA) {
        return stop::run_configuration(&mut stream, &configuration_bytes, configuration_cancelled);
    }
    if envelope.schema.is_some() {
        return render::run_configuration(
            &mut stream,
            &configuration_bytes,
            configuration_cancelled,
        );
    }
    let configuration: Configuration = serde_json::from_slice(&configuration_bytes)
        .map_err(|e| format!("context Git configuration: {e}"))?;
    let request = &configuration.request;
    run_owned_query(
        &mut stream,
        QuerySpec {
            executable: &request.executable,
            cwd: &request.cwd,
            environment: &configuration.environment,
            argv: request.operation.argv(),
            expires_ns: configuration.expires_ns,
        },
        configuration_cancelled,
        |stream, receipt| {
            let mut row = result(request, &receipt.status, &receipt.diagnostic);
            row.exit_code = receipt.exit_code;
            row.signal = receipt.signal;
            row.stdout = receipt.stdout.clone();
            row.stderr = receipt.stderr.clone();
            row.cleanup = receipt.cleanup.clone();
            publish(stream, &row)
        },
    );
    Ok(())
}

/// Data from the single shared actual-Child custody loop, not signal authority.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueryReceipt {
    status: String,
    pid: Option<u32>,
    exit_code: Option<i32>,
    signal: Option<i32>,
    stdout: String,
    stderr: String,
    cleanup: Cleanup,
    diagnostic: String,
}
impl QueryReceipt {
    fn new(status: &str, diagnostic: &str) -> Self {
        let mut end = diagnostic.len().min(1024);
        while !diagnostic.is_char_boundary(end) {
            end -= 1;
        }
        Self {
            status: status.into(),
            pid: None,
            exit_code: None,
            signal: None,
            stdout: String::new(),
            stderr: String::new(),
            cleanup: Cleanup::default(),
            diagnostic: diagnostic[..end].into(),
        }
    }
}
struct QuerySpec<'a> {
    executable: &'a PathBuf,
    cwd: &'a PathBuf,
    environment: &'a [(Vec<u8>, Vec<u8>)],
    argv: &'static [&'static str],
    expires_ns: u64,
}
/// No fallible post-spawn return: even after an unsettled receipt, the original
/// Child/group remain here until settlement, both pipe EOFs, and actual reap.
fn run_owned_query(
    mut stream: &mut UnixStream,
    spec: QuerySpec<'_>,
    configuration_cancelled: bool,
    mut publish: impl FnMut(&mut UnixStream, &QueryReceipt) -> bool,
) -> QueryReceipt {
    let fd = stream.as_raw_fd();
    let mut row = QueryReceipt::new("exited", "");
    let before = match identity(spec.executable) {
        Ok(identity) => identity,
        Err(error) => {
            row = QueryReceipt::new("spawn_failed", &format!("context Git executable: {error}"));
            row.cleanup = Cleanup {
                group_settled: true,
                stdout_eof: true,
                stderr_eof: true,
                reaped: true,
            };
            publish(&mut stream, &row);
            return row;
        }
    };
    let mut control = [0u8; 32];
    let live = matches!(stream.read(&mut control), Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted));
    if configuration_cancelled
        || !live
        || monotonic_ns() >= spec.expires_ns
        || SIGNAL.load(Ordering::Relaxed) != 0
    {
        row.status = if configuration_cancelled || !live || SIGNAL.load(Ordering::Relaxed) != 0 {
            "cancelled"
        } else {
            "deadline"
        }
        .into();
        row.cleanup = Cleanup {
            group_settled: true,
            stdout_eof: true,
            stderr_eof: true,
            reaped: true,
        };
        publish(&mut stream, &row);
        return row;
    }
    let mut command = Command::new(spec.executable);
    command
        .args(spec.argv)
        .current_dir(spec.cwd)
        .env_clear()
        .envs(
            spec.environment
                .iter()
                .filter(|(key, _)| !key.starts_with(b"GIT_") && !key.starts_with(b"HOOK_"))
                .map(|(key, value)| {
                    (
                        OsString::from_vec(key.clone()),
                        OsString::from_vec(value.clone()),
                    )
                }),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP, libc::SIGPIPE] {
                libc::signal(signal, libc::SIG_DFL);
            }
            Ok(())
        });
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            row = QueryReceipt::new("spawn_failed", &format!("context Git spawn: {error}"));
            row.cleanup = Cleanup {
                group_settled: true,
                stdout_eof: true,
                stderr_eof: true,
                reaped: true,
            };
            publish(&mut stream, &row);
            return row;
        }
    };
    row.pid = Some(child.id());
    // No fallible return or Drop-based cleanup beyond actual child creation.
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_fd = stdout.as_ref().map(AsRawFd::as_raw_fd);
    let err_fd = stderr.as_ref().map(AsRawFd::as_raw_fd);
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut output_bytes = 0usize;
    let mut out_ready = false;
    let mut err_ready = false;
    let mut stopping: Option<Instant> = None;
    let mut disconnected = false;
    let mut published = false;
    let mut last_stop = Instant::now() - TICK;
    loop {
        // Cancellation arriving after the actual leader exit cannot relabel
        // that command's completed exit. Descendants still require settlement.
        let leader_exited = observe_exit(&child, &mut row);
        for (pipe, ready) in [(out_fd, &mut out_ready), (err_fd, &mut err_ready)] {
            if !*ready && let Some(pipe) = pipe {
                if nonblocking(pipe).is_ok() {
                    *ready = true;
                } else {
                    row.status = "cleanup_unsettled".into();
                    stopping.get_or_insert_with(Instant::now);
                }
            }
        }
        if !disconnected {
            match stream.read(&mut control) {
                Ok(n) => {
                    if n == 0 {
                        disconnected = true;
                    }
                    if stopping.is_none() {
                        if !leader_exited {
                            row.status = "cancelled".into();
                        }
                        stopping = Some(Instant::now());
                    }
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) =>
                {
                    ()
                }
                Err(_) => {
                    disconnected = true;
                    if stopping.is_none() {
                        if !leader_exited {
                            row.status = "cancelled".into();
                        }
                        stopping = Some(Instant::now());
                    }
                }
            }
        }
        if stopping.is_none()
            && !leader_exited
            && (monotonic_ns() >= spec.expires_ns || SIGNAL.load(Ordering::Relaxed) != 0)
        {
            row.status = if SIGNAL.load(Ordering::Relaxed) != 0 {
                "cancelled"
            } else {
                "deadline"
            }
            .into();
            stopping = Some(Instant::now());
        }
        for (pipe, ready, eof, output) in [
            (out_fd, out_ready, &mut row.cleanup.stdout_eof, &mut out),
            (err_fd, err_ready, &mut row.cleanup.stderr_eof, &mut err),
        ] {
            if !ready || *eof {
                continue;
            }
            let mut part = [0u8; 8192];
            let n = unsafe {
                libc::read(
                    pipe.expect("ready pipe exists"),
                    part.as_mut_ptr().cast(),
                    part.len(),
                )
            };
            if n == 0 {
                *eof = true;
            } else if n > 0 {
                let capacity = MAX_OUTPUT.saturating_sub(output_bytes);
                let accepted = (n as usize).min(capacity);
                output.extend_from_slice(&part[..accepted]);
                output_bytes += accepted;
                if accepted < n as usize && stopping.is_none() {
                    row.status = "output_limit".into();
                    stopping = Some(Instant::now());
                }
            } else if !matches!(
                io::Error::last_os_error().kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
            ) {
                row.status = "cleanup_unsettled".into();
                stopping.get_or_insert_with(Instant::now);
            }
        }
        let settled = settlement_before_reap(&child);
        // A WNOWAIT observation retains actual exit/signal even when cleanup
        // later exceeds the response budget. It never releases the leader.
        observe_exit(&child, &mut row);
        if !matches!(settled, Ok(GroupSettlement::LeaderRunning)) && stopping.is_none() {
            stopping = Some(Instant::now());
        }
        if stopping.is_some() && last_stop.elapsed() >= TICK {
            if let Err(error) = stop_before_reap(&child) {
                row.diagnostic = QueryReceipt::new("", &error.to_string()).diagnostic;
            }
            last_stop = Instant::now();
        }
        // Neither cancellation, a dead leader nor pipe EOF alone permits reap.
        row.cleanup.group_settled = matches!(
            settlement_before_reap(&child),
            Ok(GroupSettlement::Exited { .. })
        );
        if row.cleanup.group_settled && row.cleanup.stdout_eof && row.cleanup.stderr_eof {
            match child.try_wait() {
                Ok(Some(status)) => {
                    row.exit_code = status.code();
                    row.signal = status.signal();
                    row.cleanup.reaped = true;
                }
                Ok(None) => (),
                Err(error) => {
                    row.diagnostic =
                        QueryReceipt::new("", &format!("context Git reap: {error}")).diagnostic
                }
            }
        }
        if row.cleanup.reaped {
            if identity(spec.executable).ok().as_ref() != Some(&before) {
                row.status = "identity_changed".into();
                row.diagnostic = "selected context Git executable changed during execution".into();
            }
            row.stdout = STANDARD.encode(&out);
            row.stderr = STANDARD.encode(&err);
            if !published && !disconnected {
                publish(&mut stream, &row);
            }
            return row;
        }
        if stopping.is_some_and(|start| start.elapsed() >= CLEANUP) && !published {
            let mut pending = row.clone();
            pending.status = "cleanup_unsettled".into();
            pending.diagnostic =
                "context Git cleanup pending; native custodian retains original Child and group"
                    .into();
            pending.stdout = STANDARD.encode(&out);
            pending.stderr = STANDARD.encode(&err);
            if !disconnected {
                publish(&mut stream, &pending);
            }
            published = true;
        }
        let mut fds = Vec::new();
        if !disconnected {
            fds.push(libc::pollfd {
                fd,
                events: libc::POLLIN,
                revents: 0,
            });
        }
        for (pipe, ready, eof) in [
            (out_fd, out_ready, row.cleanup.stdout_eof),
            (err_fd, err_ready, row.cleanup.stderr_eof),
        ] {
            if ready && !eof {
                fds.push(libc::pollfd {
                    fd: pipe.expect("ready pipe exists"),
                    events: libc::POLLIN,
                    revents: 0,
                });
            }
        }
        tick(&mut fds);
        if stopping.is_some() {
            std::thread::sleep(TICK);
        }
    }
}

#[cfg(test)]
mod frontend_cleanup_tests {
    use super::*;

    #[test]
    fn frontend_bound_uses_both_original_clock_and_earlier_reserve() {
        let original = MonotonicDeadline::capture(Duration::from_secs(1)).unwrap();
        let expired_reserve = Instant::now() - Duration::from_millis(1);
        assert_eq!(
            frontend_cleanup_check(&original, expired_reserve).unwrap_err(),
            "frontend cleanup deadline expired; custody retained"
        );
        assert!(original.check().is_ok());
        let short = MonotonicDeadline::capture(Duration::from_millis(5)).unwrap();
        while short.check().is_ok() {
            std::thread::sleep(Duration::from_millis(1));
        }
        let error =
            frontend_cleanup_check(&short, Instant::now() + Duration::from_secs(1)).unwrap_err();
        assert!(error.contains("Original monotonic deadline expired"));
    }

    #[test]
    fn bounded_cancellation_cannot_clear_delivered_uncertainty() {
        let request = Request {
            schema: REQUEST_SCHEMA.into(),
            id: "bounded-fixture".into(),
            runtime_digest: "a".repeat(64),
            token: "b".repeat(64),
            ordinal: 1,
            operation: Operation::Checkout,
            executable: "/usr/bin/git".into(),
            cwd: "/".into(),
        };
        let active = Arc::new(AtomicBool::new(true));
        let mut pending = PendingGit::immediate(
            request.clone(),
            result(&request, "cleanup_unsettled", "custody retained"),
            active.clone(),
        );
        let frame = pending.advance().unwrap().expect("actual uncertain frame");
        let row: ResultFrame = serde_json::from_slice(&frame).unwrap();
        assert_eq!(row.status, "cleanup_unsettled");
        let original = MonotonicDeadline::capture(Duration::from_secs(1)).unwrap();
        let error = pending
            .cancel_and_settle_until(&original, original.expires())
            .unwrap_err();
        assert!(error.contains("cleanup remains uncertain"));
        assert!(
            active.load(Ordering::Acquire),
            "uncertain frame cannot release ownership"
        );
        assert!(pending.cleanup_requested);
        assert!(pending.delivered);
    }
}
#[cfg(test)]
#[path = "context_git/tests.rs"]
mod tests;
