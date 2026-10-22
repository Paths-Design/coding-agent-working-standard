//! Independent, finite project observation for the original native invocation.
//!
//! This observation is neither project authority nor a publication grant. The
//! executable is selected from captured caller data, not a renderer image. Its
//! pathname, backing-file metadata and bytes are checked around both launches;
//! pathname verification plus spawn is not an atomic executable pin. Filesystem
//! and process syscalls have no hard bound against a kernel stall. Uncertain
//! query cleanup is retained by ProjectFailure for the invocation owner's retry;
//! this module does not provide durable custody after that owner is destroyed.

use serde_json::value::RawValue;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::CString,
    fmt, fs,
    io::{self, Read},
    os::{
        fd::AsRawFd,
        unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt},
            process::{CommandExt, ExitStatusExt},
        },
    },
    path::{Path, PathBuf},
    process::{Child, ChildStderr, ChildStdout, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

const MAX_OUTPUT: usize = 1_048_576;
const MAX_TOOL_BYTES: u64 = 134_217_728;
const MAX_PATH_BYTES: usize = 4096;
const QUERY_BUDGET: Duration = Duration::from_secs(5);
const CLEANUP_BUDGET: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectPhase {
    Caller,
    Payload,
    Candidate,
    SelectExecutable,
    PinExecutable,
    BeforeLaunch,
    Spawn,
    Pipes,
    Query,
    QueryDeadline,
    Cancelled,
    OutputLimit,
    ExitObservation,
    Cleanup,
    QueryStatus,
    AfterLaunch,
    CheckoutOutput,
    CommonDirectoryOutput,
    PhysicalRoot,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutableIdentity {
    pub device: u64,
    pub inode: u64,
    pub bytes: u64,
    pub mode: u32,
    pub modified_seconds: i64,
    pub modified_nanoseconds: i64,
    pub changed_seconds: i64,
    pub changed_nanoseconds: i64,
}
impl ExecutableIdentity {
    fn of(meta: &fs::Metadata) -> Self {
        Self {
            device: meta.dev(),
            inode: meta.ino(),
            bytes: meta.len(),
            mode: meta.mode(),
            modified_seconds: meta.mtime(),
            modified_nanoseconds: meta.mtime_nsec(),
            changed_seconds: meta.ctime(),
            changed_nanoseconds: meta.ctime_nsec(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectedExecutable {
    /// Preserve the selected pathname for launch, including its argv[0] semantics.
    pub path: PathBuf,
    pub physical_path: PathBuf,
    pub identity: ExecutableIdentity,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedProject {
    pub checkout: PathBuf,
    pub canonical_root: PathBuf,
    pub executable: SelectedExecutable,
    /// Direct-child/pipe settlement observations for the two actual queries.
    pub queries: [QueryCleanup; 2],
    pub query_bytes: [QueryBytes; 2],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryBytes {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OsFailure {
    pub kind: io::ErrorKind,
    pub raw_errno: Option<i32>,
    pub message: String,
}
impl From<io::Error> for OsFailure {
    fn from(error: io::Error) -> Self {
        Self {
            kind: error.kind(),
            raw_errno: error.raw_os_error(),
            message: error.to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitObservation {
    pub success: bool,
    pub code: Option<i32>,
    pub signal: Option<i32>,
    pub core_dumped: bool,
}
impl From<ExitStatus> for ExitObservation {
    fn from(status: ExitStatus) -> Self {
        Self {
            success: status.success(),
            code: status.code(),
            signal: status.signal(),
            core_dumped: status.core_dumped(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopAttempt {
    NotAttempted,
    Accepted(crate::owned_group::GroupStop),
    Refused(crate::owned_group::StopError),
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReapAttempt {
    NotAttempted,
    Completed(ExitObservation),
    ObservationFailed(OsFailure),
    InvalidObservation { pid: i32, code: i32 },
    Failed(OsFailure),
    TimedOut,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CleanupAttempt {
    pub stop: StopAttempt,
    pub settlement:
        Option<Result<crate::owned_group::GroupSettlement, crate::owned_group::SettlementError>>,
    pub reap: ReapAttempt,
}
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PipeObservation {
    pub stdout_open: bool,
    pub stderr_open: bool,
    pub stdout_eof: bool,
    pub stderr_eof: bool,
    pub stdout_bytes: usize,
    pub stderr_bytes: usize,
}
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QueryCleanup {
    pub pid: Option<u32>,
    pub exit_observed: bool,
    pub pipes: PipeObservation,
    pub attempts: Vec<CleanupAttempt>,
    pub reaped: Option<ExitObservation>,
    pub ownership_retained: bool,
}
impl QueryCleanup {
    pub fn settled(&self) -> bool {
        self.pid.is_none()
            || (self.reaped.is_some()
                && !self.ownership_retained
                && !self.pipes.stdout_open
                && !self.pipes.stderr_open)
    }
}

/// Carries the direct Child that pins the private group until accepted stop/reap.
/// The owner must keep this value alive through independent engine cleanup.
pub struct RetainedQuery {
    child: Option<Child>,
    stdout: Option<ChildStdout>,
    stderr: Option<ChildStderr>,
    state: QueryCleanup,
}
impl fmt::Debug for RetainedQuery {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RetainedQuery")
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}
impl RetainedQuery {
    fn new(mut child: Child) -> Self {
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        Self {
            state: QueryCleanup {
                pid: Some(child.id()),
                ownership_retained: true,
                pipes: PipeObservation {
                    stdout_open: stdout.is_some(),
                    stderr_open: stderr.is_some(),
                    ..PipeObservation::default()
                },
                ..QueryCleanup::default()
            },
            child: Some(child),
            stdout,
            stderr,
        }
    }

    pub fn state(&self) -> &QueryCleanup {
        &self.state
    }

    fn close_pipes(&mut self) {
        self.stdout.take();
        self.stderr.take();
        self.state.pipes.stdout_open = false;
        self.state.pipes.stderr_open = false;
    }

    /// One bounded retry. Cancellation does not suppress cleanup. Stop refusal
    /// never permits a reap, and an observation failure retains the Child.
    pub fn retry_cleanup(&mut self) -> QueryCleanup {
        self.retry_cleanup_with(crate::owned_group::stop_before_reap)
    }

    fn retry_cleanup_with(
        &mut self,
        stop: impl FnOnce(
            &Child,
        )
            -> Result<crate::owned_group::GroupStop, crate::owned_group::StopError>,
    ) -> QueryCleanup {
        self.close_pipes();
        let Some(child) = self.child.as_mut() else {
            return self.state.clone();
        };
        let mut attempt = CleanupAttempt {
            stop: StopAttempt::NotAttempted,
            settlement: None,
            reap: ReapAttempt::NotAttempted,
        };
        match stop(child) {
            Ok(stop) => attempt.stop = StopAttempt::Accepted(stop),
            Err(error) => {
                attempt.stop = StopAttempt::Refused(error);
                self.state.attempts.push(attempt);
                return self.state.clone();
            }
        }
        let until = Instant::now() + CLEANUP_BUDGET;
        loop {
            // Observe without reaping immediately before any try_wait.
            match exit_observed(child) {
                Ok(true) => {
                    self.state.exit_observed = true;
                    let settlement = crate::owned_group::settlement_before_reap(child);
                    let exited = matches!(
                        &settlement,
                        Ok(crate::owned_group::GroupSettlement::Exited { .. })
                    );
                    let unavailable = settlement.is_err();
                    attempt.settlement = Some(settlement);
                    if unavailable {
                        // An accepted signal and an exited direct child do not
                        // establish that the private group has settled.
                        break;
                    }
                    if !exited {
                        if Instant::now() >= until {
                            attempt.reap = ReapAttempt::TimedOut;
                            break;
                        }
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            let status = ExitObservation::from(status);
                            attempt.reap = ReapAttempt::Completed(status);
                            self.state.reaped = Some(status);
                            self.state.ownership_retained = false;
                            self.child = None;
                            break;
                        }
                        Ok(None) => {}
                        Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                        Err(error) => {
                            attempt.reap = ReapAttempt::Failed(error.into());
                            break;
                        }
                    }
                }
                Ok(false) => {}
                Err(ExitIssue::Io(error)) => {
                    attempt.reap = ReapAttempt::ObservationFailed(error);
                    break;
                }
                Err(ExitIssue::Identity { pid, code }) => {
                    attempt.reap = ReapAttempt::InvalidObservation { pid, code };
                    break;
                }
            }
            if Instant::now() >= until {
                attempt.reap = ReapAttempt::TimedOut;
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        self.state.attempts.push(attempt);
        self.state.clone()
    }
}
impl Drop for RetainedQuery {
    fn drop(&mut self) {
        if self.child.is_some() {
            let observation = self.retry_cleanup();
            if !observation.settled() {
                // This is the final destruction boundary, not durable custody.
                // Never report the still-owned Child as successfully reaped.
                eprintln!(
                    "project query ownership unresolved at owner destruction: {observation:?}"
                );
            }
        }
    }
}

#[derive(Debug)]
pub struct ProjectFailure {
    pub first_phase: ProjectPhase,
    pub first_message: String,
    pub cleanup: Box<QueryCleanup>,
    pub retained: Option<Box<RetainedQuery>>,
}
impl ProjectFailure {
    fn new(phase: ProjectPhase, message: impl Into<String>) -> Self {
        Self {
            first_phase: phase,
            first_message: message.into(),
            cleanup: Box::default(),
            retained: None,
        }
    }
    fn query(phase: ProjectPhase, message: impl Into<String>, mut query: RetainedQuery) -> Self {
        let cleanup = query.retry_cleanup();
        let retained = (!cleanup.settled()).then(|| Box::new(query));
        Self {
            first_phase: phase,
            first_message: message.into(),
            cleanup: Box::new(cleanup),
            retained,
        }
    }
    pub fn retry_cleanup(&mut self) -> Result<(), String> {
        if let Some(query) = self.retained.as_mut() {
            self.cleanup = Box::new(query.retry_cleanup());
            if self.cleanup.settled() {
                self.retained.take();
            }
        }
        if self.retained_uncertain() {
            Err(format!(
                "project query cleanup remains uncertain: {:?}",
                self.cleanup
            ))
        } else {
            Ok(())
        }
    }
    pub fn retained_uncertain(&self) -> bool {
        self.retained.is_some() || !self.cleanup.settled()
    }
}
impl fmt::Display for ProjectFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "project {:?}: {}; query cleanup: {:?}",
            self.first_phase, self.first_message, self.cleanup
        )
    }
}
impl std::error::Error for ProjectFailure {}

/// Extract only the last matching top-level member. Other keys and values stay
/// raw, including lone surrogates, huge numbers, nested data, and duplicates.
/// RawValue has already validated the grammar; this scanner does not coerce it.
pub fn payload_string(payload: &RawValue, key: &str) -> Result<Option<String>, String> {
    let text = payload.get();
    let bytes = text.as_bytes();
    let mut at = whitespace(bytes, 0);
    if bytes.get(at) != Some(&b'{') {
        return Err("original project payload must be an object".into());
    }
    at += 1;
    let mut last = None;
    loop {
        at = whitespace(bytes, at);
        if bytes.get(at) == Some(&b'}') {
            at = whitespace(bytes, at + 1);
            if at != bytes.len() {
                return Err("original payload has trailing bytes".into());
            }
            break;
        }
        let key_start = at;
        let key_end = string_end(bytes, at)?;
        at = whitespace(bytes, key_end);
        if bytes.get(at) != Some(&b':') {
            return Err("original payload member has no colon".into());
        }
        at = whitespace(bytes, at + 1);
        let value_start = at;
        at = value_end(bytes, at)?;
        if key_matches(&text[key_start..key_end], key) {
            last = Some(text[value_start..at].trim());
        }
        at = whitespace(bytes, at);
        match bytes.get(at) {
            Some(b',') => at += 1,
            Some(b'}') => {}
            _ => return Err("original payload member has no delimiter".into()),
        }
    }
    match last {
        None | Some("null") => Ok(None),
        Some(value) => serde_json::from_str::<String>(value)
            .map(Some)
            .map_err(|_| format!("original payload {key} must be a native UTF-8 string or null")),
    }
}

fn whitespace(bytes: &[u8], mut at: usize) -> usize {
    while bytes
        .get(at)
        .is_some_and(|b| matches!(*b, b' ' | b'\n' | b'\r' | b'\t'))
    {
        at += 1;
    }
    at
}
fn string_end(bytes: &[u8], mut at: usize) -> Result<usize, String> {
    if bytes.get(at) != Some(&b'"') {
        return Err("original payload member key must be a JSON string".into());
    }
    at += 1;
    while let Some(byte) = bytes.get(at) {
        match *byte {
            b'"' => return Ok(at + 1),
            b'\\' => at += 2,
            _ => at += 1,
        }
    }
    Err("unterminated original payload string".into())
}
fn value_end(bytes: &[u8], mut at: usize) -> Result<usize, String> {
    let start = at;
    let mut depth = 0usize;
    while let Some(byte) = bytes.get(at) {
        match *byte {
            b'"' => at = string_end(bytes, at)?,
            b'[' | b'{' => {
                depth += 1;
                at += 1;
            }
            b']' | b'}' if depth > 0 => {
                depth -= 1;
                at += 1;
            }
            b',' | b'}' if depth == 0 => {
                if at == start {
                    return Err("original payload member has no value".into());
                }
                return Ok(at);
            }
            _ => at += 1,
        }
    }
    Err("unterminated original payload member".into())
}

// Compare JSON key spelling as UTF-16 units without materializing unowned keys.
// A lone surrogate in an unrelated key is simply a nonmatch for a Rust str.
fn key_matches(raw: &str, expected: &str) -> bool {
    let Some(inner) = raw.strip_prefix('"').and_then(|s| s.strip_suffix('"')) else {
        return false;
    };
    let mut source = inner.chars();
    let mut wanted = expected.encode_utf16();
    while let Some(character) = source.next() {
        if character == '\\' {
            let unit = match source.next() {
                Some('"') => b'"' as u16,
                Some('\\') => b'\\' as u16,
                Some('/') => b'/' as u16,
                Some('b') => 8,
                Some('f') => 12,
                Some('n') => 10,
                Some('r') => 13,
                Some('t') => 9,
                Some('u') => {
                    let mut value = 0u16;
                    for _ in 0..4 {
                        let Some(digit) = source.next().and_then(|c| c.to_digit(16)) else {
                            return false;
                        };
                        value = (value << 4) | digit as u16;
                    }
                    value
                }
                _ => return false,
            };
            if wanted.next() != Some(unit) {
                return false;
            }
        } else {
            let mut units = [0u16; 2];
            for unit in character.encode_utf16(&mut units) {
                if wanted.next() != Some(*unit) {
                    return false;
                }
            }
        }
    }
    wanted.next().is_none()
}

fn checkpoint(expires: Instant, is_cancelled: &dyn Fn() -> bool) -> Result<(), ProjectFailure> {
    if is_cancelled() {
        return Err(ProjectFailure::new(
            ProjectPhase::Cancelled,
            "original invocation cancelled",
        ));
    }
    if Instant::now() >= expires {
        return Err(ProjectFailure::new(
            ProjectPhase::QueryDeadline,
            "original project observation deadline expired",
        ));
    }
    Ok(())
}

/// POSIX Node path.resolve(base, supplied): normalize before physical traversal.
fn resolve_path(base: &str, supplied: &str) -> Result<PathBuf, String> {
    if !base.starts_with('/') || base.contains('\0') || supplied.contains('\0') {
        return Err("project path requires absolute native UTF-8 caller cwd".into());
    }
    let joined = if supplied.starts_with('/') {
        supplied.to_owned()
    } else {
        format!("{base}/{supplied}")
    };
    let mut parts = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    let resolved = format!("/{}", parts.join("/"));
    if resolved.len() > MAX_PATH_BYTES {
        return Err("project path exceeds finite path profile".into());
    }
    Ok(resolved.into())
}

fn candidate(
    caller_cwd: &str,
    environment: &BTreeMap<String, String>,
    payload: &RawValue,
) -> Result<PathBuf, ProjectFailure> {
    let supplied = payload_string(payload, "cwd")
        .map_err(|message| ProjectFailure::new(ProjectPhase::Payload, message))?;
    let selected = supplied
        .as_deref()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            environment
                .get("CAWS_PROJECT_DIR")
                .map(String::as_str)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or(caller_cwd);
    resolve_path(caller_cwd, selected)
        .map_err(|message| ProjectFailure::new(ProjectPhase::Candidate, message))
}

fn executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    let Ok(path) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: path is a live, NUL-terminated native string.
    unsafe { libc::access(path.as_ptr(), libc::X_OK) == 0 }
}

fn select_executable(
    caller_cwd: &str,
    environment: &BTreeMap<String, String>,
) -> Result<PathBuf, ProjectFailure> {
    let override_value = environment
        .get("CAWS_GIT_BINARY")
        .filter(|value| !value.is_empty());
    let name = match override_value {
        // The TS resolver returns an absolute override verbatim. In particular,
        // normalizing `symlink/..` here would change kernel path traversal.
        Some(value) if value.starts_with('/') => {
            if value.contains('\0') || value.len() > MAX_PATH_BYTES {
                return Err(ProjectFailure::new(
                    ProjectPhase::SelectExecutable,
                    "absolute Git override exceeds native path profile",
                ));
            }
            return Ok(PathBuf::from(value.as_str()));
        }
        Some(value) if value.contains('/') || value.contains('\\') => {
            return resolve_path(caller_cwd, value)
                .map_err(|message| ProjectFailure::new(ProjectPhase::SelectExecutable, message));
        }
        Some(value) => value.as_str(),
        None => "git",
    };
    for directory in environment
        .get("PATH")
        .map(String::as_str)
        .unwrap_or("")
        .split(':')
        .filter(|directory| !directory.is_empty())
    {
        let joined = format!("{directory}/{name}");
        let candidate = resolve_path(caller_cwd, &joined)
            .map_err(|message| ProjectFailure::new(ProjectPhase::SelectExecutable, message))?;
        if executable_file(&candidate) {
            return Ok(candidate);
        }
    }
    Err(ProjectFailure::new(
        ProjectPhase::SelectExecutable,
        "captured caller Git executable is unavailable",
    ))
}

fn pin_executable(
    path: &Path,
    expires: Instant,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<SelectedExecutable, ProjectFailure> {
    checkpoint(expires, is_cancelled)?;
    if !executable_file(path) {
        return Err(ProjectFailure::new(
            ProjectPhase::PinExecutable,
            "selected Git is not an executable regular file",
        ));
    }
    // Follow the selected symlink for compatibility, but retain/check both the
    // selected pathname and physical backing identity around every launch.
    let physical_path = fs::canonicalize(path).map_err(|e| {
        ProjectFailure::new(
            ProjectPhase::PinExecutable,
            format!("Git physical path: {e}"),
        )
    })?;
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| {
            ProjectFailure::new(
                ProjectPhase::PinExecutable,
                format!("Git executable open: {e}"),
            )
        })?;
    let before = file.metadata().map_err(|e| {
        ProjectFailure::new(
            ProjectPhase::PinExecutable,
            format!("Git executable metadata: {e}"),
        )
    })?;
    if !before.is_file() || before.len() > MAX_TOOL_BYTES {
        return Err(ProjectFailure::new(
            ProjectPhase::PinExecutable,
            "Git executable exceeds regular-file profile",
        ));
    }
    let identity = ExecutableIdentity::of(&before);
    let mut total = 0u64;
    let mut digest = Sha256::new();
    loop {
        checkpoint(expires, is_cancelled)?;
        let mut bytes = [0u8; 32768];
        let count = match file.read(&mut bytes) {
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => {
                return Err(ProjectFailure::new(
                    ProjectPhase::PinExecutable,
                    format!("Git executable read: {error}"),
                ));
            }
        };
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > MAX_TOOL_BYTES {
            return Err(ProjectFailure::new(
                ProjectPhase::PinExecutable,
                "Git executable grew beyond byte profile",
            ));
        }
        digest.update(&bytes[..count]);
    }
    let after = file.metadata().map_err(|e| {
        ProjectFailure::new(
            ProjectPhase::PinExecutable,
            format!("Git executable final metadata: {e}"),
        )
    })?;
    let named = fs::metadata(path).map_err(|e| {
        ProjectFailure::new(
            ProjectPhase::PinExecutable,
            format!("Git executable named metadata: {e}"),
        )
    })?;
    let final_physical = fs::canonicalize(path).map_err(|e| {
        ProjectFailure::new(
            ProjectPhase::PinExecutable,
            format!("Git executable final physical path: {e}"),
        )
    })?;
    if identity != ExecutableIdentity::of(&after)
        || identity != ExecutableIdentity::of(&named)
        || physical_path != final_physical
        || total != identity.bytes
    {
        return Err(ProjectFailure::new(
            ProjectPhase::PinExecutable,
            "Git executable changed during capture",
        ));
    }
    checkpoint(expires, is_cancelled)?;
    Ok(SelectedExecutable {
        path: path.to_owned(),
        physical_path,
        identity,
        sha256: format!("{:x}", digest.finalize()),
    })
}

fn verify_executable(
    selected: &SelectedExecutable,
    phase: ProjectPhase,
    expires: Instant,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<(), ProjectFailure> {
    let current =
        pin_executable(&selected.path, expires, is_cancelled).map_err(|mut failure| {
            if !matches!(
                failure.first_phase,
                ProjectPhase::Cancelled | ProjectPhase::QueryDeadline
            ) {
                failure.first_phase = phase;
            }
            failure
        })?;
    if &current != selected {
        return Err(ProjectFailure::new(
            phase,
            "selected Git executable identity changed",
        ));
    }
    Ok(())
}

enum ExitIssue {
    Io(OsFailure),
    Identity { pid: i32, code: i32 },
}
fn exit_observed(child: &Child) -> Result<bool, ExitIssue> {
    let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
    // SAFETY: observes this retained Child only, without releasing its identity.
    if unsafe {
        libc::waitid(
            libc::P_PID,
            child.id() as libc::id_t,
            info.as_mut_ptr(),
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    } != 0
    {
        return Err(ExitIssue::Io(io::Error::last_os_error().into()));
    }
    // SAFETY: successful waitid initializes the supplied siginfo.
    let info = unsafe { info.assume_init() };
    let pid = unsafe { info.si_pid() };
    if pid == 0 && info.si_code == 0 {
        return Ok(false);
    }
    if pid != child.id() as i32
        || !matches!(
            info.si_code,
            libc::CLD_EXITED | libc::CLD_KILLED | libc::CLD_DUMPED
        )
    {
        return Err(ExitIssue::Identity {
            pid,
            code: info.si_code,
        });
    }
    Ok(true)
}

fn nonblocking(fd: i32) -> Result<(), io::Error> {
    // SAFETY: fd is borrowed from an owned live pipe.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn drain(
    file: &mut impl Read,
    output: &mut Vec<u8>,
    total: &mut usize,
    expires: Instant,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<bool, ProjectFailure> {
    for _ in 0..8 {
        checkpoint(expires, is_cancelled)?;
        let mut buffer = [0u8; 8192];
        match file.read(&mut buffer) {
            Ok(0) => return Ok(true),
            Ok(count) => {
                if *total > MAX_OUTPUT - count {
                    return Err(ProjectFailure::new(
                        ProjectPhase::OutputLimit,
                        "combined Git stdout/stderr exceeds byte limit",
                    ));
                }
                *total += count;
                output.extend_from_slice(&buffer[..count]);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(false),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => {
                return Err(ProjectFailure::new(
                    ProjectPhase::Query,
                    format!("Git pipe read: {error}"),
                ));
            }
        }
    }
    Ok(false)
}

struct QueryOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    cleanup: QueryCleanup,
}
fn query(
    selected: &SelectedExecutable,
    cwd: &Path,
    environment: &BTreeMap<String, String>,
    args: &[&str],
    expires: Instant,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<QueryOutput, ProjectFailure> {
    let until = std::cmp::min(expires, Instant::now() + QUERY_BUDGET);
    verify_executable(selected, ProjectPhase::BeforeLaunch, until, is_cancelled)?;
    checkpoint(until, is_cancelled)?;
    let mut command = Command::new(&selected.path);
    command
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(environment)
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
    let child = command
        .spawn()
        .map_err(|e| ProjectFailure::new(ProjectPhase::Spawn, format!("Git query spawn: {e}")))?;
    let mut owner = RetainedQuery::new(child);
    let operation = (|| -> Result<(Vec<u8>, Vec<u8>), ProjectFailure> {
        let stdout = owner.stdout.as_ref().ok_or_else(|| {
            ProjectFailure::new(ProjectPhase::Pipes, "Git stdout pipe unavailable")
        })?;
        let stderr = owner.stderr.as_ref().ok_or_else(|| {
            ProjectFailure::new(ProjectPhase::Pipes, "Git stderr pipe unavailable")
        })?;
        nonblocking(stdout.as_raw_fd())
            .and_then(|_| nonblocking(stderr.as_raw_fd()))
            .map_err(|e| {
                ProjectFailure::new(ProjectPhase::Pipes, format!("Git pipe configuration: {e}"))
            })?;
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut total = 0usize;
        loop {
            checkpoint(until, is_cancelled)?;
            if !owner.state.pipes.stdout_eof {
                let result = drain(
                    owner.stdout.as_mut().expect("owned stdout"),
                    &mut out,
                    &mut total,
                    until,
                    is_cancelled,
                );
                owner.state.pipes.stdout_bytes = out.len();
                owner.state.pipes.stdout_eof = result?;
            }
            if !owner.state.pipes.stderr_eof {
                let result = drain(
                    owner.stderr.as_mut().expect("owned stderr"),
                    &mut err,
                    &mut total,
                    until,
                    is_cancelled,
                );
                owner.state.pipes.stderr_bytes = err.len();
                owner.state.pipes.stderr_eof = result?;
            }
            owner.state.exit_observed =
                match exit_observed(owner.child.as_ref().expect("owned child")) {
                    Ok(exited) => exited,
                    Err(ExitIssue::Io(error)) => {
                        return Err(ProjectFailure::new(
                            ProjectPhase::ExitObservation,
                            format!("Git exit observation: {error:?}"),
                        ));
                    }
                    Err(ExitIssue::Identity { pid, code }) => {
                        return Err(ProjectFailure::new(
                            ProjectPhase::ExitObservation,
                            format!("Git child identity unavailable (pid {pid}, code {code})"),
                        ));
                    }
                };
            if owner.state.pipes.stdout_eof
                && owner.state.pipes.stderr_eof
                && owner.state.exit_observed
            {
                checkpoint(until, is_cancelled)?;
                return Ok((out, err));
            }
            thread::sleep(Duration::from_millis(2));
        }
    })();
    let (stdout, stderr) = match operation {
        Ok(value) => value,
        Err(failure) => {
            return Err(ProjectFailure::query(
                failure.first_phase,
                failure.first_message,
                owner,
            ));
        }
    };
    let cleanup = owner.retry_cleanup();
    if !cleanup.settled() {
        return Err(ProjectFailure {
            first_phase: ProjectPhase::Cleanup,
            first_message: "Git query completed but private-group cleanup is uncertain".into(),
            cleanup: Box::new(cleanup),
            retained: Some(Box::new(owner)),
        });
    }
    let mut final_failure =
        verify_executable(selected, ProjectPhase::AfterLaunch, until, is_cancelled).err();
    if final_failure.is_none() && !cleanup.reaped.is_some_and(|status| status.success) {
        final_failure = Some(ProjectFailure::new(
            ProjectPhase::QueryStatus,
            format!(
                "Git query failed ({:?}; stderr bytes {})",
                cleanup.reaped,
                stderr.len()
            ),
        ));
    }
    // TS decodes both streams even on successful exit. Stderr text is allowed;
    // invalid UTF-8 is unavailable, not a lossy replacement.
    if final_failure.is_none() && std::str::from_utf8(&stderr).is_err() {
        final_failure = Some(ProjectFailure::new(
            ProjectPhase::QueryStatus,
            "Git stderr is not UTF-8",
        ));
    }
    if let Some(mut failure) = final_failure {
        failure.cleanup = Box::new(cleanup);
        return Err(failure);
    }
    Ok(QueryOutput {
        stdout,
        stderr,
        cleanup,
    })
}

fn git_path(bytes: &[u8], phase: ProjectPhase) -> Result<PathBuf, ProjectFailure> {
    // Narrow physical-path profile: exactly one UTF-8 line terminated by LF.
    // No trim-based repair of ambiguous/control-bearing Git output.
    let text = std::str::from_utf8(bytes)
        .map_err(|_| ProjectFailure::new(phase, "Git path output is not UTF-8"))?;
    let value = text
        .strip_suffix('\n')
        .ok_or_else(|| ProjectFailure::new(phase, "Git path output lacks one-line framing"))?;
    if value.is_empty()
        || value.trim() != value
        || value.len() > MAX_PATH_BYTES
        || !value.starts_with('/')
        || value.chars().any(char::is_control)
        || (value != "/" && value.ends_with('/'))
    {
        return Err(ProjectFailure::new(
            phase,
            "Git path output exceeds canonical absolute path profile",
        ));
    }
    let resolved =
        resolve_path("/", value).map_err(|message| ProjectFailure::new(phase, message))?;
    if resolved.as_os_str() != Path::new(value).as_os_str() {
        return Err(ProjectFailure::new(
            phase,
            "Git path output is not lexically normalized",
        ));
    }
    Ok(resolved)
}

fn physical_directory(path: &Path) -> Result<PathBuf, ProjectFailure> {
    let physical = fs::canonicalize(path).map_err(|e| {
        ProjectFailure::new(
            ProjectPhase::PhysicalRoot,
            format!("project physical path: {e}"),
        )
    })?;
    let text = physical.to_str().ok_or_else(|| {
        ProjectFailure::new(
            ProjectPhase::PhysicalRoot,
            "project physical path is not UTF-8",
        )
    })?;
    if !physical.is_dir() || text.len() > MAX_PATH_BYTES || text.chars().any(char::is_control) {
        return Err(ProjectFailure::new(
            ProjectPhase::PhysicalRoot,
            "project physical path exceeds directory profile",
        ));
    }
    Ok(physical)
}

pub fn observe(
    caller_cwd: &str,
    environment: &BTreeMap<String, String>,
    original_payload: &RawValue,
    expires: Instant,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<ObservedProject, ProjectFailure> {
    checkpoint(expires, is_cancelled)?;
    if !caller_cwd.starts_with('/') || caller_cwd.contains('\0') {
        return Err(ProjectFailure::new(
            ProjectPhase::Caller,
            "caller cwd must be absolute native UTF-8",
        ));
    }
    if environment
        .iter()
        .any(|(name, value)| name.is_empty() || name.contains(['=', '\0']) || value.contains('\0'))
    {
        return Err(ProjectFailure::new(
            ProjectPhase::Caller,
            "captured caller environment has an invalid native entry",
        ));
    }
    let candidate = candidate(caller_cwd, environment, original_payload)?;
    let filtered: BTreeMap<String, String> = environment
        .iter()
        .filter(|(name, _)| !name.starts_with("GIT_") && !name.starts_with("HOOK_"))
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    let executable_path = select_executable(caller_cwd, &filtered)?;
    let executable = pin_executable(&executable_path, expires, is_cancelled)?;
    let first = query(
        &executable,
        &candidate,
        &filtered,
        &["rev-parse", "--show-toplevel"],
        expires,
        is_cancelled,
    )?;
    let checkout =
        git_path(&first.stdout, ProjectPhase::CheckoutOutput).map_err(|mut failure| {
            failure.cleanup = Box::new(first.cleanup.clone());
            failure
        })?;
    checkpoint(expires, is_cancelled).map_err(|mut failure| {
        failure.cleanup = Box::new(first.cleanup.clone());
        failure
    })?;
    // The second query uses Git's checkout spelling, as the TS runtime does.
    let second = query(
        &executable,
        &checkout,
        &filtered,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        expires,
        is_cancelled,
    )?;
    let common =
        git_path(&second.stdout, ProjectPhase::CommonDirectoryOutput).map_err(|mut failure| {
            failure.cleanup = Box::new(second.cleanup.clone());
            failure
        })?;
    // Preserve the store's mapping order. Resolving a .git symlink first can
    // select a different parent, so derive the CAWS root before canonicalize.
    let finishing = (|| {
        let canonical = common.parent().ok_or_else(|| {
            ProjectFailure::new(
                ProjectPhase::CommonDirectoryOutput,
                "Git common directory has no parent",
            )
        })?;
        checkpoint(expires, is_cancelled)?;
        let checkout = physical_directory(&checkout)?;
        let canonical_root = physical_directory(canonical)?;
        checkpoint(expires, is_cancelled)?;
        Ok((checkout, canonical_root))
    })();
    let (checkout, canonical_root) = finishing.map_err(|mut failure: ProjectFailure| {
        failure.cleanup = Box::new(second.cleanup.clone());
        failure
    })?;
    let observed = ObservedProject {
        checkout,
        canonical_root,
        executable,
        queries: [first.cleanup, second.cleanup],
        query_bytes: [
            QueryBytes {
                stdout: first.stdout,
                stderr: first.stderr,
            },
            QueryBytes {
                stdout: second.stdout,
                stderr: second.stderr,
            },
        ],
    };
    #[cfg(test)]
    println!("native project observation: {observed:?}");
    Ok(observed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::unix::fs::PermissionsExt,
        sync::atomic::{AtomicU64, Ordering},
    };

    fn raw(text: &str) -> Box<RawValue> {
        RawValue::from_string(text.into()).unwrap()
    }

    #[test]
    fn raw_owned_members_last_win_without_decoding_unrelated_data() {
        let value = raw(
            r#"{"\ud800":1e9999,"opaque":{"number":99999999999999999999999999999999999999999,"surrogate":"\ud800","array":["}\"",{"a":1}]},"cwd":false,"c\u0077d":"../chosen","session_id":"old","session_\u0069d":"s"}"#,
        );
        assert_eq!(
            payload_string(&value, "cwd").unwrap(),
            Some("../chosen".into())
        );
        assert_eq!(
            payload_string(&value, "session_id").unwrap(),
            Some("s".into())
        );
        assert_eq!(payload_string(&value, "missing").unwrap(), None);
        assert!(value.get().contains("1e9999"));
        assert!(value.get().contains(r#""surrogate":"\ud800""#));
    }

    #[test]
    fn cwd_types_and_null_empty_semantics_are_distinct() {
        for text in ["{}", r#"{"cwd":null}"#] {
            assert_eq!(payload_string(&raw(text), "cwd").unwrap(), None);
        }
        assert_eq!(
            payload_string(&raw(r#"{"cwd":""}"#), "cwd").unwrap(),
            Some("".into())
        );
        for text in [
            r#"{"cwd":1e9999}"#,
            r#"{"cwd":false}"#,
            r#"{"cwd":[]}"#,
            r#"{"cwd":{}}"#,
            r#"{"cwd":"\ud800"}"#,
        ] {
            assert!(payload_string(&raw(text), "cwd").is_err(), "{text}");
        }
        assert!(payload_string(&raw(r#"{"cwd":"good","cwd":false}"#), "cwd").is_err());
    }

    #[test]
    fn lexical_candidate_precedence_matches_node_before_symlink_traversal() {
        let env = BTreeMap::from([("CAWS_PROJECT_DIR".into(), "../environment".into())]);
        assert_eq!(
            candidate(
                "/caller/nested",
                &env,
                &raw(r#"{"cwd":"../payload/./leaf/.."}"#)
            )
            .unwrap(),
            PathBuf::from("/caller/payload")
        );
        for text in ["{}", r#"{"cwd":null}"#, r#"{"cwd":""}"#] {
            assert_eq!(
                candidate("/caller/nested", &env, &raw(text)).unwrap(),
                PathBuf::from("/caller/environment")
            );
        }
        assert_eq!(
            candidate("/caller/nested", &BTreeMap::new(), &raw("{}")).unwrap(),
            PathBuf::from("/caller/nested")
        );
        assert_eq!(
            resolve_path("/a/b", "../../../c//./d").unwrap(),
            PathBuf::from("/c/d")
        );
        assert!(candidate("/a", &env, &raw(r#"{"cwd":0}"#)).is_err());
    }

    #[test]
    fn path_profile_refuses_ambiguous_git_outputs() {
        assert_eq!(
            git_path(b"/repo\n", ProjectPhase::CheckoutOutput).unwrap(),
            PathBuf::from("/repo")
        );
        for bytes in [
            &b"relative\n"[..],
            &b"/repo\nextra\n"[..],
            &b"/repo\r\n"[..],
            &b"/repo"[..],
            &b"/repo/../other\n"[..],
            &b"//repo\n"[..],
            &b"/repo/\n"[..],
            &b"/bad\xff\n"[..],
        ] {
            assert!(
                git_path(bytes, ProjectPhase::CheckoutOutput).is_err(),
                "{bytes:?}"
            );
        }
    }

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "caws-invocation-project-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            fs::create_dir(&path).unwrap();
            Self(path.canonicalize().unwrap())
        }
        fn executable(&self, name: &str, body: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            path
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn captured_executable_selection_skips_empty_path_entries_and_uses_caller_base() {
        let scratch = Scratch::new();
        scratch.executable("git", "exit 0");
        let cwd = scratch.0.to_str().unwrap();
        let empty = BTreeMap::from([("PATH".into(), ":".into())]);
        assert!(
            select_executable(cwd, &empty).is_err(),
            "empty PATH must not select caller ./git"
        );
        let relative = BTreeMap::from([("PATH".into(), ":.:".into())]);
        assert_eq!(
            select_executable(cwd, &relative).unwrap(),
            scratch.0.join("git")
        );
        let override_env = BTreeMap::from([
            ("PATH".into(), ".".into()),
            ("CAWS_GIT_BINARY".into(), "missing".into()),
        ]);
        assert!(
            select_executable(cwd, &override_env).is_err(),
            "override must not fall back to git"
        );
        let explicit = BTreeMap::from([("CAWS_GIT_BINARY".into(), "./missing".into())]);
        assert_eq!(
            select_executable(cwd, &explicit).unwrap(),
            scratch.0.join("missing")
        );
    }

    #[test]
    fn real_query_accepts_exit_zero_stderr_and_reaps_owned_child() {
        let scratch = Scratch::new();
        let path = scratch.executable("git", "printf '/repo\\n'; printf warning >&2");
        let deadline = Instant::now() + Duration::from_secs(3);
        let selected = pin_executable(&path, deadline, &|| false).unwrap();
        let output = query(
            &selected,
            &scratch.0,
            &BTreeMap::new(),
            &[],
            deadline,
            &|| false,
        )
        .unwrap();
        assert_eq!(output.stdout, b"/repo\n");
        assert_eq!(output.cleanup.pipes.stderr_bytes, 7);
        assert!(output.cleanup.settled());
        assert!(output.cleanup.reaped.unwrap().success);
        assert!(matches!(
            output.cleanup.attempts[0].stop,
            StopAttempt::Accepted(_)
        ));
    }

    #[test]
    fn pipe_holding_descendant_cannot_extend_query_deadline() {
        let scratch = Scratch::new();
        let path = scratch.executable("git", "(/bin/sleep 30) &\nprintf '/repo\\n'\nexit 0");
        let deadline = Instant::now() + Duration::from_millis(150);
        let selected = pin_executable(&path, deadline, &|| false).unwrap();
        let mut failure = query(
            &selected,
            &scratch.0,
            &BTreeMap::new(),
            &[],
            deadline,
            &|| false,
        )
        .err()
        .expect("held pipe must time out");
        assert_eq!(failure.first_phase, ProjectPhase::QueryDeadline);
        failure.retry_cleanup().unwrap();
        assert!(failure.cleanup.settled(), "{:?}", failure.cleanup);
        assert!(failure.cleanup.reaped.is_some());
        assert!(!failure.cleanup.pipes.stdout_open && !failure.cleanup.pipes.stderr_open);
    }

    #[test]
    fn cancellation_keeps_first_failure_and_settles_the_private_query() {
        let scratch = Scratch::new();
        let path = scratch.executable("git", "/bin/sleep 30");
        let deadline = Instant::now() + Duration::from_secs(3);
        let selected = pin_executable(&path, deadline, &|| false).unwrap();
        let start = Instant::now();
        let mut failure = query(
            &selected,
            &scratch.0,
            &BTreeMap::new(),
            &[],
            deadline,
            &|| start.elapsed() >= Duration::from_millis(100),
        )
        .err()
        .expect("query must cancel");
        assert_eq!(failure.first_phase, ProjectPhase::Cancelled);
        let message = failure.first_message.clone();
        failure.retry_cleanup().unwrap();
        assert!(!failure.retained_uncertain());
        assert_eq!(failure.first_message, message);
    }

    #[test]
    fn stop_refusal_retains_the_actual_child_until_an_independent_retry() {
        let scratch = Scratch::new();
        let path = scratch.executable("git", "/bin/sleep 30");
        let mut command = Command::new(&path);
        command
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
        let mut owner = RetainedQuery::new(command.spawn().unwrap());
        let pid = owner.child.as_ref().unwrap().id();
        let cleanup = owner.retry_cleanup_with(|_| {
            Err(crate::owned_group::StopError {
                stage: crate::owned_group::StopStage::Signal,
                raw_errno: Some(libc::EPERM),
                signal_errno: Some(libc::EPERM),
                observed_pid: Some(pid as i32),
                observed_code: None,
                group: None,
            })
        });
        assert!(!cleanup.settled());
        assert!(cleanup.reaped.is_none());
        assert!(cleanup.ownership_retained);
        assert_eq!(owner.child.as_ref().unwrap().id(), pid);
        assert!(matches!(
            cleanup.attempts[0].reap,
            ReapAttempt::NotAttempted
        ));
        let mut failure = ProjectFailure {
            first_phase: ProjectPhase::Query,
            first_message: "first-observation-sentinel".into(),
            cleanup: Box::new(cleanup),
            retained: Some(Box::new(owner)),
        };
        println!("injected stop refusal retained actual child: {failure:?}");
        failure.retry_cleanup().unwrap();
        assert_eq!(failure.first_message, "first-observation-sentinel");
        assert_eq!(failure.first_phase, ProjectPhase::Query);
        assert!(!failure.retained_uncertain());
        assert_eq!(failure.cleanup.attempts.len(), 2);
        assert!(failure.cleanup.reaped.is_some());
        println!("independent actual retry settled: {failure:?}");
    }

    #[test]
    fn early_pipe_eof_does_not_kill_a_still_running_successful_query() {
        let scratch = Scratch::new();
        let path = scratch.executable("git", "exec 1>&- 2>&-\n/bin/sleep 0.1\nexit 0");
        let deadline = Instant::now() + Duration::from_secs(3);
        let selected = pin_executable(&path, deadline, &|| false).unwrap();
        let output = query(
            &selected,
            &scratch.0,
            &BTreeMap::new(),
            &[],
            deadline,
            &|| false,
        )
        .unwrap();
        assert!(output.stdout.is_empty());
        assert!(output.cleanup.reaped.unwrap().success);
        assert!(output.cleanup.pipes.stdout_eof && output.cleanup.pipes.stderr_eof);
        assert!(output.cleanup.settled());
        println!(
            "early EOF waited for actual successful exit: {:?}",
            output.cleanup
        );
    }

    #[test]
    fn exited_leader_with_detached_pipes_requires_private_group_settlement() {
        let scratch = Scratch::new();
        let path = scratch.executable(
            "git",
            "(/bin/sleep 30 >/dev/null 2>&1) &\nprintf '%s\\n' \"$!\"\nexit 0",
        );
        let deadline = Instant::now() + Duration::from_secs(3);
        let selected = pin_executable(&path, deadline, &|| false).unwrap();
        let output = query(
            &selected,
            &scratch.0,
            &BTreeMap::new(),
            &[],
            deadline,
            &|| false,
        )
        .unwrap();
        assert!(output.cleanup.settled());
        let last = output.cleanup.attempts.last().unwrap();
        let Some(Ok(crate::owned_group::GroupSettlement::Exited { observation })) =
            &last.settlement
        else {
            panic!(
                "private group was not observed settled: {:?}",
                output.cleanup
            );
        };
        assert_eq!(observation.members, observation.zombies);
        assert_eq!(observation.leaders, 1);
        println!(
            "pipe-independent descendant output={:?}; settlement={:?}",
            output.stdout, output.cleanup
        );
    }

    #[test]
    fn selected_executable_replacement_refuses_before_child_creation() {
        let scratch = Scratch::new();
        let path = scratch.executable("git", "printf original");
        let deadline = Instant::now() + Duration::from_secs(3);
        let selected = pin_executable(&path, deadline, &|| false).unwrap();
        fs::write(&path, "#!/bin/sh\nprintf replaced\n").unwrap();
        let failure = query(
            &selected,
            &scratch.0,
            &BTreeMap::new(),
            &[],
            deadline,
            &|| false,
        )
        .err()
        .expect("changed binary must refuse");
        assert_eq!(failure.first_phase, ProjectPhase::BeforeLaunch);
        assert!(failure.cleanup.pid.is_none());
        assert!(failure.retained.is_none());
    }

    #[test]
    fn combined_output_limit_counts_both_streams() {
        let mut out = Vec::new();
        let mut total = MAX_OUTPUT - 2;
        let mut input = io::Cursor::new(b"abc");
        let failure = drain(
            &mut input,
            &mut out,
            &mut total,
            Instant::now() + Duration::from_secs(1),
            &|| false,
        )
        .err()
        .unwrap();
        assert_eq!(failure.first_phase, ProjectPhase::OutputLimit);
        assert!(out.is_empty());
        assert_eq!(total, MAX_OUTPUT - 2);
    }
}
