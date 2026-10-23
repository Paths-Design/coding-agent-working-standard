//! Directory-relative publication for the admitted session-cache prefix.
//! The selected engine resolves the canonical Git root; the native exchange
//! binds it to readiness. This operation does not independently resolve Git or authority.
//! An unavailable result is diagnostic only; it must not change a guard decision.

#[cfg(test)]
use serde_json::Value;
use serde_json::json;
use std::{
    ffi::{CStr, CString},
    fs::File,
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::ffi::OsStrExt,
    },
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

const ENVELOPE: &CStr = c".session-envelope.json";
const POINTER: &CStr = c".caller-session.json";
static TEMPORARY: AtomicU64 = AtomicU64::new(0);
pub const MAX_EXISTING_BYTES: usize = 65_536;

/// `canonical_root` is the selected engine's verified physical Git root.
/// SID/event are the original supplied payload fields, never resolved fallback
/// identity or values recovered from old HOOK_* environment/cache state.
pub struct CaptureInput<'a> {
    pub canonical_root: &'a Path,
    pub supplied_session_id: Option<&'a str>,
    pub supplied_hook_event: Option<&'a str>,
}

/// Exact contents read through the retained session directory capability.
/// Missing is only an actual ENOENT; read errors never become fresh capture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExistingEnvelope<'a> {
    Missing,
    Bytes(&'a [u8]),
}

/// The caller owns old-JSON interpretation. This is diagnostic only and must
/// not become a protective refusal. Native publishes neither file on failure.
#[derive(Debug)]
pub struct DecodeDiagnostic(pub String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureDecision {
    Capture(Option<Vec<u16>>),
    Decline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeclineReason {
    DecoderDeclined,
    ExistingTooLarge,
    UnsupportedExistingFile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    MissingSession,
    UnsafeSession,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureOutcome {
    Skipped(SkipReason),
    Declined(DeclineReason),
    Captured,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Root,
    Governance,
    Sessions,
    Session,
    Clock,
    ExistingEnvelope,
    Decision,
    Envelope,
    Pointer,
}
#[derive(Debug)]
pub enum FailureKind {
    Io(io::Error),
    Deadline,
    Cancelled(String),
    DecodeDiagnostic(String),
}
#[derive(Debug)]
pub struct CaptureFailure {
    pub stage: Stage,
    /// Publication is envelope then pointer, not an all-or-nothing pair.
    pub envelope_published: bool,
    pub kind: FailureKind,
}
impl std::fmt::Display for CaptureFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "session cache unavailable at {:?}; envelope_published={}: {:?}",
            self.stage, self.envelope_published, self.kind
        )
    }
}
impl std::error::Error for CaptureFailure {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Point {
    SessionOpened,
    EnvelopeStaged,
    EnvelopePublished,
    PointerStaged,
}
trait Port {
    fn point(&mut self, _point: Point) -> io::Result<()> {
        Ok(())
    }
    fn write(&mut self, file: &mut File, bytes: &[u8]) -> io::Result<usize> {
        file.write(bytes)
    }
}
struct NativePort;
impl Port for NativePort {}

fn check(
    expires: Instant,
    checkpoint: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), FailureKind> {
    checkpoint().map_err(FailureKind::Cancelled)?;
    if Instant::now() >= expires {
        Err(FailureKind::Deadline)
    } else {
        Ok(())
    }
}
fn name(value: &str) -> io::Result<CString> {
    CString::new(value).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL filename"))
}
fn opened(raw: libc::c_int) -> io::Result<File> {
    if raw < 0 {
        Err(io::Error::last_os_error())
    }
    // SAFETY: successful open transfers this newly owned descriptor.
    else {
        Ok(unsafe { File::from_raw_fd(raw) })
    }
}
pub(crate) fn directory_at(parent: &File, component: &CStr, create: bool) -> io::Result<File> {
    if create && unsafe { libc::mkdirat(parent.as_raw_fd(), component.as_ptr(), 0o700) } != 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EEXIST) {
            return Err(error);
        }
    }
    opened(unsafe {
        libc::openat(
            parent.as_raw_fd(),
            component.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    })
}
pub(crate) fn timestamp() -> io::Result<String> {
    let seconds: libc::time_t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_secs()
        .try_into()
        .map_err(io::Error::other)?;
    let mut utc = std::mem::MaybeUninit::<libc::tm>::zeroed();
    if unsafe { libc::gmtime_r(&seconds, utc.as_mut_ptr()) }.is_null() {
        return Err(io::Error::last_os_error());
    }
    let mut output = [0u8; 64];
    let count = unsafe {
        libc::strftime(
            output.as_mut_ptr().cast(),
            output.len(),
            c"%Y-%m-%dT%H:%M:%SZ".as_ptr(),
            utc.as_ptr(),
        )
    };
    if count == 0 {
        return Err(io::Error::other("UTC timestamp unavailable"));
    }
    String::from_utf8(output[..count].to_vec()).map_err(io::Error::other)
}

/// No fsync promise, PID effects or implicit governance creation. Existing
/// directories/files are not rejected by unrelated snapshot owner/mode/nlink
/// policies: the selected Python writer has no such policies.
/// The decoder receives the exact old bytes or Missing while all opened
/// directory FDs remain live. It selects a preserved creation string as UTF-16
/// units, or None to use native now (malformed old JSON can select None).
/// Native serializes lone surrogates as \uXXXX; no Rust old-JSON parser runs.
/// An empty returned string also selects now, matching the old writer rule.
pub fn capture_with_decision(
    input: &CaptureInput<'_>,
    expires: Instant,
    decide: impl FnOnce(ExistingEnvelope<'_>) -> Result<CaptureDecision, DecodeDiagnostic>,
) -> Result<CaptureOutcome, CaptureFailure> {
    capture_operation_decision(input, expires, timestamp, &mut NativePort, decide)
}

/// The invocation owner supplies its existing cancellation observation. Checks
/// bound publication; a cancellation racing the final check and rename is not
/// an atomic cancellation guarantee. Blocking filesystem calls are unchanged.
pub fn capture_with_decision_checked(
    input: &CaptureInput<'_>,
    expires: Instant,
    mut checkpoint: impl FnMut() -> Result<(), String>,
    decide: impl FnOnce(ExistingEnvelope<'_>) -> Result<CaptureDecision, DecodeDiagnostic>,
) -> Result<CaptureOutcome, CaptureFailure> {
    capture_operation_decision_checked(
        input,
        expires,
        timestamp,
        &mut NativePort,
        &mut checkpoint,
        decide,
    )
}

fn capture_operation_decision(
    input: &CaptureInput<'_>,
    expires: Instant,
    clock: impl FnOnce() -> io::Result<String>,
    port: &mut impl Port,
    decide: impl FnOnce(ExistingEnvelope<'_>) -> Result<CaptureDecision, DecodeDiagnostic>,
) -> Result<CaptureOutcome, CaptureFailure> {
    capture_operation_decision_checked(input, expires, clock, port, &mut || Ok(()), decide)
}

fn capture_operation_decision_checked(
    input: &CaptureInput<'_>,
    expires: Instant,
    clock: impl FnOnce() -> io::Result<String>,
    port: &mut impl Port,
    checkpoint: &mut impl FnMut() -> Result<(), String>,
    decide: impl FnOnce(ExistingEnvelope<'_>) -> Result<CaptureDecision, DecodeDiagnostic>,
) -> Result<CaptureOutcome, CaptureFailure> {
    let sid = match input.supplied_session_id {
        Some(value) if !value.is_empty() && value != "unknown" => value,
        _ => return Ok(CaptureOutcome::Skipped(SkipReason::MissingSession)),
    };
    if sid == "."
        || sid == ".."
        || !sid
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.@:-".contains(&b))
    {
        return Ok(CaptureOutcome::Skipped(SkipReason::UnsafeSession));
    }
    let mut stage = Stage::Root;
    let mut envelope_published = false;
    let result = (|| -> Result<CaptureOutcome, FailureKind> {
        check(expires, checkpoint)?;
        if !input.canonical_root.is_absolute() {
            return Err(FailureKind::Io(io::Error::other(
                "physical absolute root required",
            )));
        }
        let root_name = CString::new(input.canonical_root.as_os_str().as_bytes())
            .map_err(io::Error::other)
            .map_err(FailureKind::Io)?;
        let root = opened(unsafe {
            libc::open(
                root_name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        })
        .map_err(FailureKind::Io)?;
        stage = Stage::Governance;
        let caws = directory_at(&root, c".caws", false).map_err(FailureKind::Io)?;
        check(expires, checkpoint)?;
        stage = Stage::Sessions;
        let sessions = directory_at(&caws, c"sessions", true).map_err(FailureKind::Io)?;
        stage = Stage::Session;
        check(expires, checkpoint)?;
        let session = directory_at(&sessions, &name(sid).map_err(FailureKind::Io)?, true)
            .map_err(FailureKind::Io)?;
        port.point(Point::SessionOpened).map_err(FailureKind::Io)?;
        stage = Stage::Clock;
        let now = clock().map_err(FailureKind::Io)?;
        stage = Stage::ExistingEnvelope;
        let previous = match previous_bytes(&session, expires, checkpoint)? {
            Previous::Declined(reason) => return Ok(CaptureOutcome::Declined(reason)),
            Previous::Bytes(bytes) => Some(bytes),
            Previous::Missing => None,
        };
        stage = Stage::Decision;
        let decision = decide(match previous.as_deref() {
            Some(bytes) => ExistingEnvelope::Bytes(bytes),
            None => ExistingEnvelope::Missing,
        })
        .map_err(|error| FailureKind::DecodeDiagnostic(error.0))?;
        check(expires, checkpoint)?;
        let created = match decision {
            CaptureDecision::Capture(created) => created,
            CaptureDecision::Decline => {
                return Ok(CaptureOutcome::Declined(DeclineReason::DecoderDeclined));
            }
        };
        let root_text = input
            .canonical_root
            .to_str()
            .ok_or_else(|| FailureKind::Io(io::Error::other("root must be UTF-8")))?;
        let event = input
            .supplied_hook_event
            .filter(|s| !s.is_empty())
            .unwrap_or("unknown");
        let mut envelope = serde_json::to_vec(&json!({
            "session_id": sid, "repo_root": root_text,
            "last_seen_at": now, "hook_event": event, "platform": "codex"
        }))
        .map_err(|e| FailureKind::Io(io::Error::other(e)))?;
        // Fixed native-owned schema, with only the selected creation value
        // serialized from UTF-16 units. No caller JSON bytes are spliced in.
        envelope.pop();
        envelope.extend_from_slice(b",\"created_at\":");
        append_utf16_string(
            &mut envelope,
            created
                .as_deref()
                .filter(|v| !v.is_empty())
                .unwrap_or(&now.encode_utf16().collect::<Vec<_>>()),
        );
        envelope.push(b'}');
        envelope.push(b'\n');
        stage = Stage::Envelope;
        atomic_json(
            &session,
            ENVELOPE,
            &envelope,
            expires,
            Point::EnvelopeStaged,
            port,
            checkpoint,
        )?;
        envelope_published = true;
        port.point(Point::EnvelopePublished)
            .map_err(FailureKind::Io)?;
        stage = Stage::Pointer;
        let mut pointer = serde_json::to_vec(&json!({
            "session_id": sid, "repo_root": root_text, "last_seen_at": now
        }))
        .map_err(|e| FailureKind::Io(io::Error::other(e)))?;
        pointer.push(b'\n');
        atomic_json(
            &sessions,
            POINTER,
            &pointer,
            expires,
            Point::PointerStaged,
            port,
            checkpoint,
        )?;
        Ok(CaptureOutcome::Captured)
    })();
    result.map_err(|kind| CaptureFailure {
        stage,
        envelope_published,
        kind,
    })
}

enum Previous {
    Missing,
    Bytes(Vec<u8>),
    Declined(DeclineReason),
}

fn previous_bytes(
    session: &File,
    expires: Instant,
    checkpoint: &mut impl FnMut() -> Result<(), String>,
) -> Result<Previous, FailureKind> {
    check(expires, checkpoint)?;
    let mut old = match opened(unsafe {
        libc::openat(
            session.as_raw_fd(),
            ENVELOPE.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    }) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Previous::Missing),
        Err(e) => return Err(FailureKind::Io(e)),
    };
    // Python can block on a special file. Preserve it and report unsupported;
    // do not let a provenance cache stall a protective guard indefinitely.
    let metadata = old.metadata().map_err(FailureKind::Io)?;
    if !metadata.is_file() {
        return Ok(Previous::Declined(DeclineReason::UnsupportedExistingFile));
    }
    if metadata.len() > MAX_EXISTING_BYTES as u64 {
        return Ok(Previous::Declined(DeclineReason::ExistingTooLarge));
    }
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        check(expires, checkpoint)?;
        let remaining = (MAX_EXISTING_BYTES + 1 - bytes.len()).min(chunk.len());
        match old.read(&mut chunk[..remaining]) {
            Ok(0) => break,
            Ok(n) => {
                bytes.extend_from_slice(&chunk[..n]);
                if bytes.len() > MAX_EXISTING_BYTES {
                    return Ok(Previous::Declined(DeclineReason::ExistingTooLarge));
                }
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(FailureKind::Io(e)),
        }
    }
    Ok(Previous::Bytes(bytes))
}

fn append_utf16_string(output: &mut Vec<u8>, units: &[u16]) {
    const HEX: &[u8] = b"0123456789abcdef";
    output.push(b'"');
    for &unit in units {
        output.extend_from_slice(&[
            b'\\',
            b'u',
            HEX[(unit >> 12) as usize],
            HEX[((unit >> 8) & 15) as usize],
            HEX[((unit >> 4) & 15) as usize],
            HEX[(unit & 15) as usize],
        ]);
    }
    output.push(b'"');
}

/// Finite operation-test adapter. Production old-JSON interpretation belongs
/// to the selected engine and is not supplied by this test helper.
#[cfg(test)]
fn finite_serde_decision(
    sid: &str,
    old: ExistingEnvelope<'_>,
) -> Result<Option<Vec<u16>>, DecodeDiagnostic> {
    let ExistingEnvelope::Bytes(bytes) = old else {
        return Ok(None);
    };
    let value: Value =
        serde_json::from_slice(bytes).map_err(|e| DecodeDiagnostic(e.to_string()))?;
    if value.get("session_id").and_then(Value::as_str) != Some(sid) {
        return Ok(None);
    }
    Ok(value
        .get("created_at")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .map(|v| v.encode_utf16().collect()))
}

#[cfg(test)]
fn capture(input: &CaptureInput<'_>, expires: Instant) -> Result<CaptureOutcome, CaptureFailure> {
    capture_with(input, expires, timestamp, &mut NativePort)
}

#[cfg(test)]
fn capture_with(
    input: &CaptureInput<'_>,
    expires: Instant,
    clock: impl FnOnce() -> io::Result<String>,
    port: &mut impl Port,
) -> Result<CaptureOutcome, CaptureFailure> {
    capture_operation(input, expires, clock, port, |old| {
        finite_serde_decision(input.supplied_session_id.unwrap_or(""), old)
    })
}

/// Compatibility adapter for the retained 23 module checks only.
#[cfg(test)]
fn capture_operation(
    input: &CaptureInput<'_>,
    expires: Instant,
    clock: impl FnOnce() -> io::Result<String>,
    port: &mut impl Port,
    decide: impl FnOnce(ExistingEnvelope<'_>) -> Result<Option<Vec<u16>>, DecodeDiagnostic>,
) -> Result<CaptureOutcome, CaptureFailure> {
    capture_operation_decision(input, expires, clock, port, |old| {
        decide(old).map(CaptureDecision::Capture)
    })
}

#[cfg(test)]
fn capture_legacy_decision(
    input: &CaptureInput<'_>,
    expires: Instant,
    decide: impl FnOnce(ExistingEnvelope<'_>) -> Result<Option<Vec<u16>>, DecodeDiagnostic>,
) -> Result<CaptureOutcome, CaptureFailure> {
    capture_with_decision(input, expires, |old| {
        decide(old).map(CaptureDecision::Capture)
    })
}

struct Temporary<'a> {
    parent: &'a File,
    name: CString,
    file: File,
    renamed: bool,
}
impl Drop for Temporary<'_> {
    fn drop(&mut self) {
        if !self.renamed {
            unsafe {
                libc::unlinkat(self.parent.as_raw_fd(), self.name.as_ptr(), 0);
            }
        }
    }
}
fn atomic_json(
    parent: &File,
    target: &CStr,
    bytes: &[u8],
    expires: Instant,
    point: Point,
    port: &mut impl Port,
    checkpoint: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), FailureKind> {
    check(expires, checkpoint)?;
    let mut temporary = None;
    for _ in 0..16 {
        check(expires, checkpoint)?;
        let target_text = target.to_string_lossy();
        let stem = if target_text.starts_with("agent-pid-") && target_text.ends_with(".json") {
            format!(".{}.tmp", target_text.trim_end_matches(".json"))
        } else {
            format!("tmp-{target_text}")
        };
        let temporary_name = name(&format!(
            "{}.{}.{}",
            stem,
            std::process::id(),
            TEMPORARY.fetch_add(1, Ordering::Relaxed)
        ))
        .map_err(FailureKind::Io)?;
        match opened(unsafe {
            libc::openat(
                parent.as_raw_fd(),
                temporary_name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        }) {
            Ok(file) => {
                temporary = Some(Temporary {
                    parent,
                    name: temporary_name,
                    file,
                    renamed: false,
                });
                break;
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(FailureKind::Io(e)),
        }
    }
    let mut temporary =
        temporary.ok_or_else(|| FailureKind::Io(io::Error::other("temporary collision limit")))?;
    let mut offset = 0;
    while offset < bytes.len() {
        check(expires, checkpoint)?;
        match port.write(&mut temporary.file, &bytes[offset..]) {
            Ok(0) => return Err(FailureKind::Io(io::ErrorKind::WriteZero.into())),
            Ok(n) if n <= bytes.len() - offset => offset += n,
            Ok(_) => return Err(FailureKind::Io(io::Error::other("invalid write count"))),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(FailureKind::Io(e)),
        }
    }
    port.point(point).map_err(FailureKind::Io)?;
    check(expires, checkpoint)?;
    if unsafe {
        libc::renameat(
            parent.as_raw_fd(),
            temporary.name.as_ptr(),
            parent.as_raw_fd(),
            target.as_ptr(),
        )
    } != 0
    {
        return Err(FailureKind::Io(io::Error::last_os_error()));
    }
    temporary.renamed = true;
    Ok(())
}

/// Nonmutating SessionEnd preparation. Directory creation is delayed until the
/// complete envelope/PID profile and the engine's creation decision admit.
pub(crate) struct PreparedPrefix {
    caws: File,
    sessions: Option<File>,
    session: Option<File>,
    existing: Option<Vec<u8>>,
    root: String,
    sid: String,
    preflight_failure: Option<CaptureFailure>,
}
pub(crate) enum PrefixPreparation {
    Ready(PreparedPrefix),
    Declined(DeclineReason),
}
impl PreparedPrefix {
    pub(crate) fn existing(&self) -> ExistingEnvelope<'_> {
        match self.existing.as_deref() {
            Some(bytes) => ExistingEnvelope::Bytes(bytes),
            None => ExistingEnvelope::Missing,
        }
    }
    pub(crate) fn sessions(&self) -> Option<&File> {
        self.sessions.as_ref()
    }
    pub(crate) fn take_preflight_failure(&mut self) -> Option<CaptureFailure> {
        self.preflight_failure.take()
    }
    pub(crate) fn ensure_sessions(&mut self) -> io::Result<&File> {
        if self.sessions.is_none() {
            self.sessions = Some(directory_at(&self.caws, c"sessions", true)?);
        }
        Ok(self.sessions.as_ref().unwrap())
    }
}
fn optional_directory(parent: &File, component: &CStr) -> io::Result<Option<File>> {
    match directory_at(parent, component, false) {
        Ok(file) => Ok(Some(file)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}
pub(crate) fn prepare_prefix(
    input: &CaptureInput<'_>,
    expires: Instant,
    checkpoint: &mut impl FnMut() -> Result<(), String>,
) -> Result<PrefixPreparation, CaptureFailure> {
    let mut stage = Stage::Root;
    let result = (|| {
        check(expires, checkpoint)?;
        let sid = input
            .supplied_session_id
            .filter(|sid| {
                !sid.is_empty()
                    && *sid != "unknown"
                    && *sid != "."
                    && *sid != ".."
                    && sid
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_.@:-".contains(&b))
            })
            .ok_or_else(|| FailureKind::Io(io::Error::other("unsafe prefix session identity")))?;
        if !input.canonical_root.is_absolute() {
            return Err(FailureKind::Io(io::Error::other(
                "absolute prefix root required",
            )));
        }
        let root_text = input
            .canonical_root
            .to_str()
            .ok_or_else(|| FailureKind::Io(io::Error::other("UTF-8 prefix root required")))?;
        let root_name = name(root_text).map_err(FailureKind::Io)?;
        let root = opened(unsafe {
            libc::open(
                root_name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        })
        .map_err(FailureKind::Io)?;
        stage = Stage::Governance;
        let caws = directory_at(&root, c".caws", false).map_err(FailureKind::Io)?;
        stage = Stage::Sessions;
        let sessions = optional_directory(&caws, c"sessions").map_err(FailureKind::Io)?;
        check(expires, checkpoint)?;
        stage = Stage::Session;
        let mut preflight_failure = None;
        let session = match &sessions {
            Some(sessions) => {
                match optional_directory(sessions, &name(sid).map_err(FailureKind::Io)?) {
                    Ok(session) => session,
                    Err(error) => {
                        preflight_failure = Some(CaptureFailure {
                            stage,
                            envelope_published: false,
                            kind: FailureKind::Io(error),
                        });
                        None
                    }
                }
            }
            None => None,
        };
        stage = Stage::ExistingEnvelope;
        let existing = match &session {
            Some(session) => match previous_bytes(session, expires, checkpoint) {
                Ok(Previous::Missing) => None,
                Ok(Previous::Bytes(bytes)) => Some(bytes),
                Ok(Previous::Declined(reason)) => return Ok(PrefixPreparation::Declined(reason)),
                Err(kind @ (FailureKind::Cancelled(_) | FailureKind::Deadline)) => {
                    return Err(kind);
                }
                Err(kind) => {
                    preflight_failure = Some(CaptureFailure {
                        stage,
                        envelope_published: false,
                        kind,
                    });
                    None
                }
            },
            None => None,
        };
        Ok(PrefixPreparation::Ready(PreparedPrefix {
            caws,
            sessions,
            session,
            existing,
            root: root_text.into(),
            sid: sid.into(),
            preflight_failure,
        }))
    })();
    result.map_err(|kind| CaptureFailure {
        stage,
        envelope_published: false,
        kind,
    })
}

/// Independent sibling open after an envelope root/sessions open failed. It
/// deliberately does not inspect or reinterpret the unavailable envelope.
pub(crate) fn prepare_pid_prefix(
    input: &CaptureInput<'_>,
    expires: Instant,
    checkpoint: &mut impl FnMut() -> Result<(), String>,
) -> Result<PreparedPrefix, CaptureFailure> {
    let mut stage = Stage::Root;
    let result = (|| {
        check(expires, checkpoint)?;
        let root_text = input
            .canonical_root
            .to_str()
            .ok_or_else(|| FailureKind::Io(io::Error::other("UTF-8 prefix root required")))?;
        let root_name = name(root_text).map_err(FailureKind::Io)?;
        let root = opened(unsafe {
            libc::open(
                root_name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        })
        .map_err(FailureKind::Io)?;
        stage = Stage::Governance;
        let caws = directory_at(&root, c".caws", false).map_err(FailureKind::Io)?;
        stage = Stage::Sessions;
        let sessions = optional_directory(&caws, c"sessions").map_err(FailureKind::Io)?;
        Ok(PreparedPrefix {
            caws,
            sessions,
            session: None,
            existing: None,
            root: root_text.into(),
            sid: input.supplied_session_id.unwrap_or("").into(),
            preflight_failure: None,
        })
    })();
    result.map_err(|kind| CaptureFailure {
        stage,
        envelope_published: false,
        kind,
    })
}

pub(crate) fn publish_json(
    parent: &File,
    target: &CStr,
    bytes: &[u8],
    expires: Instant,
    checkpoint: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), FailureKind> {
    atomic_json(
        parent,
        target,
        bytes,
        expires,
        Point::PointerStaged,
        &mut NativePort,
        checkpoint,
    )
}

/// Envelope and pointer are one ordered best-effort stage. PID refresh is a
/// sibling operation and is attempted by the owner even after an I/O failure.
pub(crate) fn commit_prefix(
    prepared: &mut PreparedPrefix,
    surface: &str,
    created: Option<Vec<u16>>,
    expires: Instant,
    checkpoint: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), CaptureFailure> {
    let mut stage = Stage::Sessions;
    let mut envelope_published = false;
    let result = (|| {
        check(expires, checkpoint)?;
        prepared.ensure_sessions().map_err(FailureKind::Io)?;
        stage = Stage::Session;
        if prepared.session.is_none() {
            prepared.session = Some(
                directory_at(
                    prepared.sessions.as_ref().unwrap(),
                    &name(&prepared.sid).map_err(FailureKind::Io)?,
                    true,
                )
                .map_err(FailureKind::Io)?,
            );
        }
        stage = Stage::Clock;
        let now = timestamp().map_err(FailureKind::Io)?;
        let mut envelope = serde_json::to_vec(&json!({
            "session_id": prepared.sid, "repo_root": prepared.root,
            "last_seen_at": now, "hook_event": "SessionEnd", "platform": surface,
        }))
        .map_err(|error| FailureKind::Io(io::Error::other(error)))?;
        envelope.pop();
        envelope.extend_from_slice(b",\"created_at\":");
        let default_created = now.encode_utf16().collect::<Vec<_>>();
        append_utf16_string(
            &mut envelope,
            created
                .as_deref()
                .filter(|units| !units.is_empty())
                .unwrap_or(&default_created),
        );
        envelope.extend_from_slice(b"}\n");
        stage = Stage::Envelope;
        publish_json(
            prepared.session.as_ref().unwrap(),
            ENVELOPE,
            &envelope,
            expires,
            checkpoint,
        )?;
        envelope_published = true;
        stage = Stage::Pointer;
        let mut pointer = serde_json::to_vec(
            &json!({ "session_id":prepared.sid, "repo_root":prepared.root, "last_seen_at":now }),
        )
        .map_err(|error| FailureKind::Io(io::Error::other(error)))?;
        pointer.push(b'\n');
        publish_json(
            prepared.sessions.as_ref().unwrap(),
            POINTER,
            &pointer,
            expires,
            checkpoint,
        )
    })();
    result.map_err(|kind| CaptureFailure {
        stage,
        envelope_published,
        kind,
    })
}

#[cfg(test)]
#[path = "session_cache/tests.rs"]
mod tests;
