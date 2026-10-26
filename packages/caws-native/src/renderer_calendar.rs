//! Bounded local-calendar observations in the original frontend process.
//!
//! Capture before starting the engine. Requests cannot select a timezone or PID.
//! This leaf does not activate a carrier or snapshot the timezone database.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, ffi::OsString, fmt, marker::PhantomData, rc::Rc, time::Instant};

pub const PROFILE: &str = "cpython-3.11.13-renderer-calendar.v1";
pub const REQUEST_SCHEMA: &str = "caws.renderer-calendar.local.request.v1";
pub const REPLY_SCHEMA: &str = "caws.renderer-calendar.local.reply.v1";
pub const MAX_BATCH: usize = 256;
pub const MAX_TOTAL_QUERIES: usize = 65_536;
pub const MAX_REQUEST_BYTES: usize = 32 * 1024;
pub const MAX_REPLY_BYTES: usize = 2 * 1024 * 1024;

pub struct Invocation {
    pub id: String,
    pub runtime_digest: String,
    pub token: String,
    pub deadline: Instant,
    pub max_queries: usize,
}

/// Facts available in the original frontend before the engine creates its
/// publication token. No timezone, process identity, or token is request-selected.
pub struct OriginalInvocation {
    pub id: String,
    pub runtime_digest: String,
    pub deadline: Instant,
    pub max_queries: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    InvalidInvocation,
    InvalidRequest,
    BindingMismatch,
    ProfileMismatch,
    SequenceMismatch,
    QueryLimit,
    Deadline,
    Cancelled,
    EnvironmentChanged,
    WrongProcess,
    UnsupportedEnvironment,
    UnsupportedPlatform,
    ResponseTooLarge,
    Terminal,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CalendarFailure {
    pub kind: FailureKind,
    pub diagnostic: String,
}
impl CalendarFailure {
    fn new(kind: FailureKind, diagnostic: impl Into<String>) -> Self {
        Self {
            kind,
            diagnostic: bounded_text(diagnostic.into(), 1024),
        }
    }
}
impl fmt::Display for CalendarFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.diagnostic)
    }
}
impl std::error::Error for CalendarFailure {}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EnvironmentValue {
    Absent,
    Present { value: String },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginalContext {
    pub original_pid: u32,
    pub tz: EnvironmentValue,
    pub tzdir: EnvironmentValue,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Request {
    schema: String,
    profile: String,
    id: String,
    runtime_digest: String,
    token: String,
    sequence: u32,
    seconds: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LocalObservation {
    #[serde(rename_all = "camelCase")]
    LocalCalendar {
        seconds: String,
        tm_year: i32,
        tm_mon: i32,
        tm_mday: i32,
        tm_hour: i32,
        tm_min: i32,
        tm_sec: i32,
    },
    OsError {
        seconds: String,
        errno: i32,
        message: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Reply<'a> {
    schema: &'static str,
    profile: &'static str,
    id: &'a str,
    runtime_digest: &'a str,
    token: &'a str,
    sequence: u32,
    context: &'a OriginalContext,
    results: Vec<LocalObservation>,
}

/// Original process facts captured before Node. Binding consumes this value;
/// an unbound capture cannot perform a calendar observation.
///
/// ```compile_fail,E0599
/// use caws_native::renderer_calendar::CapturedCalendar;
/// fn unbound(captured: &mut CapturedCalendar) {
///     let _ = captured.observe(&[], &mut || Ok(()));
/// }
/// ```
///
/// ```compile_fail,E0382
/// use caws_native::renderer_calendar::CapturedCalendar;
/// fn rebind(captured: CapturedCalendar) {
///     let _ = captured.bind("first-token".into());
///     let _ = captured.bind("another-token".into());
/// }
/// ```
pub struct CapturedCalendar {
    invocation: OriginalInvocation,
    context: OriginalContext,
    tz: Option<OsString>,
    tzdir: Option<OsString>,
    _original_thread: PhantomData<Rc<()>>,
}
impl CapturedCalendar {
    pub fn capture(invocation: OriginalInvocation) -> Result<Self, CalendarFailure> {
        if !cfg!(all(
            any(target_os = "macos", target_os = "linux"),
            target_pointer_width = "64"
        )) {
            return Err(CalendarFailure::new(
                FailureKind::UnsupportedPlatform,
                "local-calendar profile supports 64-bit macOS and Linux libc",
            ));
        }
        if invocation.id.is_empty()
            || invocation.id.len() > 256
            || invocation.id.contains('\0')
            || !lower_digest(&invocation.runtime_digest)
            || !(1..=MAX_TOTAL_QUERIES).contains(&invocation.max_queries)
        {
            return Err(CalendarFailure::new(
                FailureKind::InvalidInvocation,
                "invalid original calendar binding or query bound",
            ));
        }
        if Instant::now() >= invocation.deadline {
            return Err(CalendarFailure::new(
                FailureKind::Deadline,
                "original calendar deadline expired",
            ));
        }
        let original_pid = std::process::id();
        if original_pid <= 1 {
            return Err(CalendarFailure::new(
                FailureKind::WrongProcess,
                "original calendar process PID unavailable",
            ));
        }
        let tz = std::env::var_os("TZ");
        let tzdir = std::env::var_os("TZDIR");
        let context = OriginalContext {
            original_pid,
            tz: environment_value(&tz)?,
            tzdir: environment_value(&tzdir)?,
        };
        let captured = Self {
            invocation,
            context,
            tz,
            tzdir,
            _original_thread: PhantomData,
        };
        captured.checkpoint(&mut || Ok(()))?;
        // Original frontend capture precedes Node/runner admission. Match the
        // time-module startup initialization without deferring avoidable libc
        // cache initialization into the later observation exchange. This does
        // not grant the unbound capture authority to query calendar fields.
        initialize_timezone();
        captured.checkpoint(&mut || Ok(()))?;
        Ok(captured)
    }

    pub fn context(&self) -> &OriginalContext {
        &self.context
    }

    pub fn id(&self) -> &str {
        &self.invocation.id
    }

    pub fn runtime_digest(&self) -> &str {
        &self.invocation.runtime_digest
    }

    /// Bind exactly once to the existing native-validated publication token.
    /// Consuming ownership also makes a refused binding unavailable for replay.
    pub fn bind(self, token: String) -> Result<OriginalCalendar, CalendarFailure> {
        self.checkpoint(&mut || Ok(()))?;
        if token.is_empty()
            || token.len() > 128
            || !token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        {
            return Err(CalendarFailure::new(
                FailureKind::InvalidInvocation,
                "invalid original publication token",
            ));
        }
        Ok(OriginalCalendar {
            captured: self,
            token,
            next_sequence: 1,
            queries: 0,
            terminal: false,
        })
    }

    fn checkpoint(
        &self,
        cancel: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<(), CalendarFailure> {
        cancel().map_err(|reason| CalendarFailure::new(FailureKind::Cancelled, reason))?;
        if Instant::now() >= self.invocation.deadline {
            return Err(CalendarFailure::new(
                FailureKind::Deadline,
                "original calendar deadline expired",
            ));
        }
        if std::process::id() != self.context.original_pid {
            return Err(CalendarFailure::new(
                FailureKind::WrongProcess,
                "calendar capability left its original process",
            ));
        }
        if std::env::var_os("TZ") != self.tz || std::env::var_os("TZDIR") != self.tzdir {
            return Err(CalendarFailure::new(
                FailureKind::EnvironmentChanged,
                "original TZ or TZDIR changed",
            ));
        }
        Ok(())
    }
}

/// Bound invocation-local capability, deliberately neither Send nor Sync.
pub struct OriginalCalendar {
    captured: CapturedCalendar,
    token: String,
    next_sequence: u32,
    queries: usize,
    terminal: bool,
}
impl OriginalCalendar {
    /// Convenience for callers which already hold the original token. Both
    /// entry points use exactly the same process capture and consuming bind.
    pub fn capture(invocation: Invocation) -> Result<Self, CalendarFailure> {
        let Invocation {
            id,
            runtime_digest,
            token,
            deadline,
            max_queries,
        } = invocation;
        CapturedCalendar::capture(OriginalInvocation {
            id,
            runtime_digest,
            deadline,
            max_queries,
        })?
        .bind(token)
    }

    pub fn context(&self) -> &OriginalContext {
        self.captured.context()
    }

    /// Returns one complete correlated batch, or a terminal typed failure.
    /// An OS conversion failure is a per-second observation, never a timestamp.
    pub fn observe(
        &mut self,
        frame: &[u8],
        cancel: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<Vec<u8>, CalendarFailure> {
        if self.terminal {
            return Err(CalendarFailure::new(
                FailureKind::Terminal,
                "original calendar capability has terminated",
            ));
        }
        let result = self.observe_inner(frame, cancel);
        if result.is_err() {
            self.terminal = true;
        }
        result
    }

    fn checkpoint(
        &self,
        cancel: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<(), CalendarFailure> {
        self.captured.checkpoint(cancel)
    }

    fn observe_inner(
        &mut self,
        frame: &[u8],
        cancel: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<Vec<u8>, CalendarFailure> {
        self.checkpoint(cancel)?;
        if frame.len() > MAX_REQUEST_BYTES {
            return Err(CalendarFailure::new(
                FailureKind::InvalidRequest,
                "calendar request exceeds byte bound",
            ));
        }
        let request: Request = serde_json::from_slice(frame).map_err(|_| {
            CalendarFailure::new(FailureKind::InvalidRequest, "malformed calendar request")
        })?;
        if request.schema != REQUEST_SCHEMA {
            return Err(CalendarFailure::new(
                FailureKind::InvalidRequest,
                "unsupported calendar request schema",
            ));
        }
        if request.profile != PROFILE {
            return Err(CalendarFailure::new(
                FailureKind::ProfileMismatch,
                "calendar profile mismatch",
            ));
        }
        if request.id != self.captured.invocation.id
            || request.runtime_digest != self.captured.invocation.runtime_digest
            || request.token != self.token
        {
            return Err(CalendarFailure::new(
                FailureKind::BindingMismatch,
                "calendar invocation binding mismatch",
            ));
        }
        if request.sequence != self.next_sequence {
            return Err(CalendarFailure::new(
                FailureKind::SequenceMismatch,
                "calendar sequence is replayed or skipped",
            ));
        }
        if request.seconds.is_empty() || request.seconds.len() > MAX_BATCH {
            return Err(CalendarFailure::new(
                FailureKind::InvalidRequest,
                "calendar batch outside 1..256",
            ));
        }
        if request.seconds.len() > self.captured.invocation.max_queries - self.queries {
            return Err(CalendarFailure::new(
                FailureKind::QueryLimit,
                "original calendar total query bound exhausted",
            ));
        }
        let mut unique = BTreeSet::new();
        let mut seconds = Vec::with_capacity(request.seconds.len());
        for text in &request.seconds {
            let value = text.parse::<i64>().map_err(|_| {
                CalendarFailure::new(FailureKind::InvalidRequest, "seconds must be canonical i64")
            })?;
            if value.to_string() != *text || !unique.insert(value) {
                return Err(CalendarFailure::new(
                    FailureKind::InvalidRequest,
                    "seconds must be distinct canonical i64",
                ));
            }
            seconds.push(value);
        }
        let mut results = Vec::with_capacity(seconds.len());
        for (text, seconds) in request.seconds.iter().zip(seconds) {
            self.checkpoint(cancel)?;
            let observed = local_calendar(seconds, text);
            self.checkpoint(cancel)?;
            results.push(observed);
        }
        self.queries += request.seconds.len();
        self.next_sequence += 1;
        let reply = serde_json::to_vec(&Reply {
            schema: REPLY_SCHEMA,
            profile: PROFILE,
            id: &self.captured.invocation.id,
            runtime_digest: &self.captured.invocation.runtime_digest,
            token: &self.token,
            sequence: request.sequence,
            context: self.captured.context(),
            results,
        })
        .map_err(|_| {
            CalendarFailure::new(
                FailureKind::ResponseTooLarge,
                "calendar reply encoding failed",
            )
        })?;
        if reply.len() > MAX_REPLY_BYTES {
            return Err(CalendarFailure::new(
                FailureKind::ResponseTooLarge,
                "calendar reply exceeds byte bound",
            ));
        }
        self.checkpoint(cancel)?;
        Ok(reply)
    }
}

fn lower_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn environment_value(value: &Option<OsString>) -> Result<EnvironmentValue, CalendarFailure> {
    match value {
        None => Ok(EnvironmentValue::Absent),
        Some(value) => value
            .to_str()
            .map(|value| EnvironmentValue::Present {
                value: value.into(),
            })
            .ok_or_else(|| {
                CalendarFailure::new(
                    FailureKind::UnsupportedEnvironment,
                    "original TZ or TZDIR is not UTF-8",
                )
            }),
    }
}
fn bounded_text(mut text: String, maximum: usize) -> String {
    if text.len() > maximum {
        let mut end = maximum;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    text
}

#[cfg(all(
    any(target_os = "macos", target_os = "linux"),
    target_pointer_width = "64"
))]
fn initialize_timezone() {
    unsafe extern "C" {
        fn tzset();
    }
    // This initializes libc timezone state, using the original environment.
    // No environment mutation or shared-owner execution is selected here.
    unsafe { tzset() }
}
#[cfg(not(all(
    any(target_os = "macos", target_os = "linux"),
    target_pointer_width = "64"
)))]
fn initialize_timezone() {}

#[cfg(all(
    any(target_os = "macos", target_os = "linux"),
    target_pointer_width = "64"
))]
fn local_calendar(seconds: i64, text: &str) -> LocalObservation {
    let native_seconds: libc::time_t = seconds;
    let mut calendar = std::mem::MaybeUninit::<libc::tm>::uninit();
    #[cfg(target_os = "macos")]
    let errno = unsafe { libc::__error() };
    #[cfg(target_os = "linux")]
    let errno = unsafe { libc::__errno_location() };
    unsafe { *errno = 0 };
    let result = unsafe { libc::localtime_r(&native_seconds, calendar.as_mut_ptr()) };
    if result.is_null() {
        // Match _PyTime_localtime in the declared CPython profile: libc
        // failure without errno becomes the platform's EINVAL, not a date.
        let number = unsafe { *errno };
        os_error(text, localtime_error_number(number))
    } else {
        let value = unsafe { calendar.assume_init() };
        LocalObservation::LocalCalendar {
            seconds: text.into(),
            tm_year: value.tm_year,
            tm_mon: value.tm_mon,
            tm_mday: value.tm_mday,
            tm_hour: value.tm_hour,
            tm_min: value.tm_min,
            tm_sec: value.tm_sec,
        }
    }
}
#[cfg(all(
    any(target_os = "macos", target_os = "linux"),
    target_pointer_width = "64"
))]
fn localtime_error_number(errno: i32) -> i32 {
    if errno == 0 { libc::EINVAL } else { errno }
}
#[cfg(all(
    any(target_os = "macos", target_os = "linux"),
    target_pointer_width = "64"
))]
fn os_error(seconds: &str, errno: i32) -> LocalObservation {
    let mut buffer = [0 as libc::c_char; 1024];
    let status = unsafe { libc::strerror_r(errno, buffer.as_mut_ptr(), buffer.len()) };
    let message = if status == 0 {
        unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) }
            .to_string_lossy()
            .into_owned()
    } else {
        std::io::Error::from_raw_os_error(errno).to_string()
    };
    LocalObservation::OsError {
        seconds: seconds.into(),
        errno,
        message: bounded_text(message, 128),
    }
}
#[cfg(not(all(
    any(target_os = "macos", target_os = "linux"),
    target_pointer_width = "64"
)))]
fn local_calendar(_: i64, text: &str) -> LocalObservation {
    LocalObservation::OsError {
        seconds: text.into(),
        errno: libc::ENOSYS,
        message: "unsupported original calendar platform".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn null_localtime_error_maps_only_unset_errno_to_einval() {
        assert_eq!(localtime_error_number(0), libc::EINVAL);
        assert_eq!(localtime_error_number(libc::EILSEQ), libc::EILSEQ);
        assert_eq!(localtime_error_number(libc::EOVERFLOW), libc::EOVERFLOW);
        assert_eq!(localtime_error_number(libc::EINVAL), libc::EINVAL);
    }

    fn captured() -> CapturedCalendar {
        CapturedCalendar::capture(OriginalInvocation {
            id: "original-calendar".into(),
            runtime_digest: "a".repeat(64),
            deadline: Instant::now() + Duration::from_secs(5),
            max_queries: 2,
        })
        .unwrap()
    }

    fn original() -> OriginalCalendar {
        OriginalCalendar::capture(Invocation {
            id: "original-calendar".into(),
            runtime_digest: "a".repeat(64),
            token: "2b0cc027-897f-47ee-bc02-1849a3c1a1c0".into(),
            deadline: Instant::now() + Duration::from_secs(5),
            max_queries: 2,
        })
        .unwrap()
    }
    fn request() -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "schema": REQUEST_SCHEMA, "profile": PROFILE,
            "id": "original-calendar", "runtimeDigest": "a".repeat(64),
            "token": "2b0cc027-897f-47ee-bc02-1849a3c1a1c0",
            "sequence": 1, "seconds": ["0"]
        }))
        .unwrap()
    }
    #[test]
    fn captured_process_mismatch_cannot_produce_calendar() {
        let mut owner = original();
        owner.captured.context.original_pid = std::process::id().saturating_add(1);
        assert_eq!(
            owner.observe(&request(), &mut || Ok(())).unwrap_err().kind,
            FailureKind::WrongProcess
        );
        assert_eq!(
            owner.observe(&request(), &mut || Ok(())).unwrap_err().kind,
            FailureKind::Terminal
        );
    }
    #[test]
    fn changed_capture_identity_is_refused_without_mutating_environment() {
        for tzdir in [false, true] {
            let before: Vec<_> = std::env::vars_os().collect();
            let mut owner = original();
            if tzdir {
                owner.captured.tzdir = Some(OsString::from("different-calendar-tzdir"));
            } else {
                owner.captured.tz = Some(OsString::from("different-calendar-tz"));
            }
            assert_eq!(
                owner.observe(&request(), &mut || Ok(())).unwrap_err().kind,
                FailureKind::EnvironmentChanged
            );
            assert_eq!(std::env::vars_os().collect::<Vec<_>>(), before);
        }
    }
    #[test]
    fn expired_original_deadline_cannot_be_replaced_by_request() {
        let mut owner = original();
        owner.captured.invocation.deadline = Instant::now();
        assert_eq!(
            owner.observe(&request(), &mut || Ok(())).unwrap_err().kind,
            FailureKind::Deadline
        );
    }
    #[test]
    fn binding_rechecks_original_process_environment_identity_and_deadline() {
        let before: Vec<_> = std::env::vars_os().collect();
        let mut original = captured();
        original.context.original_pid = std::process::id().saturating_add(1);
        assert_eq!(
            original
                .bind("valid-original-token".into())
                .err()
                .unwrap()
                .kind,
            FailureKind::WrongProcess
        );
        for tzdir in [false, true] {
            let mut original = captured();
            if tzdir {
                original.tzdir = Some(OsString::from("different-calendar-tzdir"));
            } else {
                original.tz = Some(OsString::from("different-calendar-tz"));
            }
            assert_eq!(
                original
                    .bind("valid-original-token".into())
                    .err()
                    .unwrap()
                    .kind,
                FailureKind::EnvironmentChanged
            );
        }
        let mut original = captured();
        original.invocation.deadline = Instant::now();
        assert_eq!(
            original
                .bind("valid-original-token".into())
                .err()
                .unwrap()
                .kind,
            FailureKind::Deadline
        );
        assert_eq!(std::env::vars_os().collect::<Vec<_>>(), before);
    }
    #[test]
    fn binding_refuses_malformed_original_tokens() {
        for token in ["", "bad/token", "bad\0token", "non-ASCII-é", "trailing\n"] {
            assert_eq!(
                captured().bind(token.into()).err().unwrap().kind,
                FailureKind::InvalidInvocation
            );
        }
        assert_eq!(
            captured().bind("x".repeat(129)).err().unwrap().kind,
            FailureKind::InvalidInvocation
        );
    }
}
