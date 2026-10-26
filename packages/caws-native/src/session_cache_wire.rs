//! One-shot cache exchange bound to native Request/Ready observations.
//! Transport uses the existing Session.send/frame deadline and cancellation
//! checks. This module never reads stdin or acquires a second transport reader.
use crate::session_cache::{
    self, CaptureDecision, CaptureInput, CaptureOutcome, DeclineReason, DecodeDiagnostic,
    ExistingEnvelope,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{
    Deserialize, Deserializer, Serialize,
    de::{self, MapAccess, Visitor},
};
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};
use std::{
    fmt,
    path::{Component, Path},
    time::Instant,
};

pub const CAPABILITY: &str = "caws.runtime.session-cache.v1";
pub const PREFIX_CAPABILITY: &str = "caws.runtime.session-end-prefix.v1";
pub const STOP_PREFIX_CAPABILITY: &str = "caws.runtime.stop-prefix.v1";
pub const STOP_PREFIX_REQUEST_SCHEMA: &str = "caws.runtime.stop-prefix.request.v1";
pub const STOP_PREFIX_PREVIOUS_SCHEMA: &str = "caws.runtime.stop-prefix.previous.v1";
pub const STOP_PREFIX_DECISION_SCHEMA: &str = "caws.runtime.stop-prefix.decision.v1";
pub const STOP_PREFIX_RESULT_SCHEMA: &str = "caws.runtime.stop-prefix.result.v1";
pub const PREFIX_REQUEST_SCHEMA: &str = "caws.runtime.session-end-prefix.request.v1";
pub const PREFIX_PREVIOUS_SCHEMA: &str = "caws.runtime.session-end-prefix.previous.v1";
pub const PREFIX_DECISION_SCHEMA: &str = "caws.runtime.session-end-prefix.decision.v1";
pub const PREFIX_RESULT_SCHEMA: &str = "caws.runtime.session-end-prefix.result.v1";
pub const PREFIX_RESULT_KEYS: &[&str] = &[
    "schema",
    "id",
    "runtimeDigest",
    "token",
    "status",
    "prefixComplete",
    "envelopePublished",
    "pointerPublished",
    "agentPid",
    "reap",
    "diagnostic",
];
pub const REQUEST_SCHEMA: &str = "caws.runtime.session-cache.request.v1";
pub const PREVIOUS_SCHEMA: &str = "caws.runtime.session-cache.previous.v1";
pub const DECISION_SCHEMA: &str = "caws.runtime.session-cache.decision.v1";
pub const RESULT_SCHEMA: &str = "caws.runtime.session-cache.result.v1";
pub const MAX_REQUEST_BYTES: usize = 32_768;
pub const MAX_PREVIOUS_BYTES: usize = 90_112;
pub const MAX_DECISION_BYTES: usize = 394_240;
pub const MAX_RESULT_BYTES: usize = 32_768;
/// Only the two extra engine->native frames, including both LF delimiters.
/// Extra cumulative control credit; proposal limits and cancellation remain independent.
pub const MAX_EXTRA_ENGINE_STDOUT_BYTES: usize = MAX_REQUEST_BYTES + MAX_DECISION_BYTES + 2;
pub const MAX_CREATED_UNITS: usize = 65_536;
pub const MAX_DIAGNOSTIC_BYTES: usize = 4_096;
pub const MAX_EXISTING_BYTES: usize = session_cache::MAX_EXISTING_BYTES;
pub const REQUEST_KEYS: &[&str] = &["schema", "id", "runtimeDigest", "token", "canonicalRoot"];
pub const PREVIOUS_KEYS: &[&str] = &["schema", "id", "runtimeDigest", "token", "existingBase64"];
pub const DECISION_KEYS: &[&str] = &[
    "schema",
    "id",
    "runtimeDigest",
    "token",
    "action",
    "createdUnits",
];
pub const RESULT_KEYS: &[&str] = &[
    "schema",
    "id",
    "runtimeDigest",
    "token",
    "status",
    "envelopePublished",
    "diagnostic",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WireError(pub &'static str);
impl fmt::Display for WireError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for WireError {}
type Result<T> = std::result::Result<T, WireError>;

/// Narrow parameters borrowed from native-owned Config/Request and validated
/// Ready, never decoded from a cache-request frame or caller environment.
pub struct Invocation<'a> {
    pub id: &'a str,
    pub runtime_digest: &'a str,
    pub original_payload: &'a RawValue,
    pub surface: &'a str,
    pub event: &'a str,
    pub configuration: &'a str,
    pub ready_active: bool,
    pub ready_project_digest: Option<&'a str>,
    pub dispatched: bool,
    pub advertised_capability: Option<&'a str>,
}

pub struct Owner<'a> {
    invocation: Invocation<'a>,
    attempted: bool,
}
impl<'a> Owner<'a> {
    pub fn new(invocation: Invocation<'a>) -> Result<Self> {
        if !invocation.ready_active
            || !invocation.dispatched
            || invocation.surface != "codex"
            || invocation.event != "pre_tool_use"
            || invocation.configuration != "system"
            || invocation.advertised_capability != Some(CAPABILITY)
            || invocation.id.is_empty()
            || invocation.id.len() > 128
            || invocation.id.contains('\0')
            || !digest(invocation.runtime_digest)
            || !invocation.ready_project_digest.is_some_and(digest)
        {
            return Err(WireError(
                "cache operation outside native active dispatched system Codex PreToolUse",
            ));
        }
        Ok(Self {
            invocation,
            attempted: false,
        })
    }

    /// An attempt is consumed before decoding, including a rejected first frame.
    /// The transport phase owner rejects repeats and post-proposal requests.
    pub fn admit(&mut self, frame: &[u8]) -> Result<Admitted> {
        if self.attempted {
            return Err(WireError("cache request already attempted"));
        }
        self.attempted = true;
        let wire: RequestFrame = decode(frame, MAX_REQUEST_BYTES)?;
        if wire.schema != REQUEST_SCHEMA
            || wire.id != self.invocation.id
            || wire.runtime_digest != self.invocation.runtime_digest
            || !uuid_v4(&wire.token)
            || !root_path(&wire.canonical_root)
            || sha(wire.canonical_root.as_bytes()) != self.invocation.ready_project_digest.unwrap()
        {
            return Err(WireError("cache request binding mismatch"));
        }
        Ok(Admitted {
            correlation: Correlation {
                id: wire.id,
                runtime_digest: wire.runtime_digest,
                token: wire.token,
            },
            canonical_root: wire.canonical_root,
            sid: raw_sid(self.invocation.original_payload),
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestFrame {
    schema: String,
    id: String,
    runtime_digest: String,
    token: String,
    canonical_root: String,
}
#[derive(Debug, Clone)]
pub struct Correlation {
    id: String,
    runtime_digest: String,
    token: String,
}
impl Correlation {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn runtime_digest(&self) -> &str {
        &self.runtime_digest
    }
    pub fn token(&self) -> &str {
        &self.token
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviousFrame<'a> {
    schema: &'static str,
    id: &'a str,
    runtime_digest: &'a str,
    token: &'a str,
    existing_base64: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Action {
    Capture,
    Decline,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DecisionFrame {
    schema: String,
    id: String,
    runtime_digest: String,
    token: String,
    action: Action,
    #[serde(deserialize_with = "required_units")]
    created_units: Option<Vec<u16>>,
}
fn required_units<'de, D: Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<Vec<u16>>, D::Error> {
    let value = Option::<Vec<u16>>::deserialize(d)?;
    if value.as_ref().is_some_and(|v| v.len() > MAX_CREATED_UNITS) {
        return Err(de::Error::custom("too many creation units"));
    }
    Ok(value)
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Captured,
    Skipped,
    Declined,
    Unavailable,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultFrame {
    schema: &'static str,
    id: String,
    runtime_digest: String,
    token: String,
    status: Status,
    envelope_published: bool,
    diagnostic: Option<String>,
}
impl ResultFrame {
    pub fn status(&self) -> Status {
        self.status
    }
    pub fn envelope_published(&self) -> bool {
        self.envelope_published
    }
    /// Local status predicate only. TS may fall back only after receiving the
    /// complete correlated terminal result; a lost result never grants replay.
    pub fn fallback_safe(&self) -> bool {
        self.status == Status::Declined && !self.envelope_published
    }
    pub fn encode(&self) -> Result<Vec<u8>> {
        encode(self, MAX_RESULT_BYTES)
    }
}

pub struct Admitted {
    correlation: Correlation,
    canonical_root: String,
    sid: RawSid,
}
pub struct Execution {
    pub result: ResultFrame,
    /// Invalid/lost decision exchange is separately visible to root; it must not
    /// replay or convert this into a compatibility request. Root owns cleanup.
    pub exchange_error: Option<WireError>,
    /// Cancellation is an invocation failure, never a diagnostic-only cache
    /// miss or a grant to replay compatibility dispatch.
    pub cancellation_error: Option<String>,
}
impl Admitted {
    pub fn correlation(&self) -> &Correlation {
        &self.correlation
    }

    /// Root closure must use original Session.send/frame and original deadline.
    /// No transport retry, new reader, thread or cancellation suppression exists.
    pub fn execute(
        self,
        expires: Instant,
        exchange: impl FnOnce(&[u8]) -> Result<Vec<u8>>,
    ) -> Execution {
        self.execute_checked(expires, || Ok(()), exchange)
    }

    pub fn execute_checked(
        self,
        expires: Instant,
        mut checkpoint: impl FnMut() -> std::result::Result<(), String>,
        exchange: impl FnOnce(&[u8]) -> Result<Vec<u8>>,
    ) -> Execution {
        let result = |status, published, diagnostic| {
            make_result(&self.correlation, status, published, diagnostic)
        };
        if let Err(error) = checkpoint() {
            return Execution {
                result: result(Status::Unavailable, false, Some(error.clone())),
                exchange_error: None,
                cancellation_error: Some(error),
            };
        }
        if Instant::now() >= expires {
            return Execution {
                result: result(
                    Status::Unavailable,
                    false,
                    Some("cache deadline expired".into()),
                ),
                exchange_error: None,
                cancellation_error: None,
            };
        }
        let sid = match &self.sid {
            RawSid::Skipped => {
                return Execution {
                    result: result(Status::Skipped, false, None),
                    exchange_error: None,
                    cancellation_error: None,
                };
            }
            RawSid::Unsupported => {
                return Execution {
                    result: result(
                        Status::Declined,
                        false,
                        Some("original payload session-id profile unsupported".into()),
                    ),
                    exchange_error: None,
                    cancellation_error: None,
                };
            }
            RawSid::Safe(sid) => sid,
        };
        let input = CaptureInput {
            canonical_root: Path::new(&self.canonical_root),
            supplied_session_id: Some(sid),
            supplied_hook_event: Some("PreToolUse"),
        };
        let mut exchange_error = None;
        let captured =
            session_cache::capture_with_decision_checked(&input, expires, &mut checkpoint, |old| {
                let decided = (|| {
                    let previous = encode_previous(&self.correlation, old)?;
                    let response = exchange(&previous)?;
                    decode_decision(&response, &self.correlation)
                })();
                match decided {
                    Ok(value) => Ok(value),
                    Err(error) => {
                        exchange_error = Some(error);
                        Err(DecodeDiagnostic(
                            "session-cache decision exchange unavailable".into(),
                        ))
                    }
                }
            });
        let cancellation_error = match &captured {
            Err(session_cache::CaptureFailure {
                kind: session_cache::FailureKind::Cancelled(error),
                ..
            }) => Some(error.clone()),
            _ => None,
        };
        let frame = match captured {
            Ok(CaptureOutcome::Captured) => result(Status::Captured, true, None),
            Ok(CaptureOutcome::Skipped(_)) => result(Status::Skipped, false, None),
            Ok(CaptureOutcome::Declined(reason)) => result(
                Status::Declined,
                false,
                Some(
                    match reason {
                        DeclineReason::DecoderDeclined => "engine decoder explicitly declined",
                        DeclineReason::ExistingTooLarge => "existing envelope exceeds 65536 bytes",
                        DeclineReason::UnsupportedExistingFile => {
                            "existing envelope is not a regular file"
                        }
                    }
                    .into(),
                ),
            ),
            Err(error) => result(
                Status::Unavailable,
                error.envelope_published,
                Some(error.to_string()),
            ),
        };
        Execution {
            result: frame,
            exchange_error,
            cancellation_error,
        }
    }
}

pub fn encode_previous(
    correlation: &Correlation,
    existing: ExistingEnvelope<'_>,
) -> Result<Vec<u8>> {
    let existing_base64 = match existing {
        ExistingEnvelope::Missing => None,
        ExistingEnvelope::Bytes(bytes) if bytes.len() <= MAX_EXISTING_BYTES => {
            Some(STANDARD.encode(bytes))
        }
        _ => return Err(WireError("previous envelope exceeds byte limit")),
    };
    encode(
        &PreviousFrame {
            schema: PREVIOUS_SCHEMA,
            id: &correlation.id,
            runtime_digest: &correlation.runtime_digest,
            token: &correlation.token,
            existing_base64,
        },
        MAX_PREVIOUS_BYTES,
    )
}
pub fn decode_decision(frame: &[u8], correlation: &Correlation) -> Result<CaptureDecision> {
    let wire: DecisionFrame = decode(frame, MAX_DECISION_BYTES)?;
    if wire.schema != DECISION_SCHEMA
        || wire.id != correlation.id
        || wire.runtime_digest != correlation.runtime_digest
        || wire.token != correlation.token
    {
        return Err(WireError("cache decision binding mismatch"));
    }
    match wire.action {
        Action::Capture => Ok(CaptureDecision::Capture(wire.created_units)),
        Action::Decline if wire.created_units.is_none() => Ok(CaptureDecision::Decline),
        Action::Decline => Err(WireError("decline cannot carry creation units")),
    }
}

fn make_result(
    c: &Correlation,
    status: Status,
    published: bool,
    diagnostic: Option<String>,
) -> ResultFrame {
    let diagnostic = diagnostic.map(|mut text| {
        let mut end = text.len().min(MAX_DIAGNOSTIC_BYTES);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        if text.is_empty() {
            text.push_str("session cache unavailable");
        }
        text
    });
    ResultFrame {
        schema: RESULT_SCHEMA,
        id: c.id.clone(),
        runtime_digest: c.runtime_digest.clone(),
        token: c.token.clone(),
        status,
        envelope_published: published,
        diagnostic,
    }
}
fn encode<T: Serialize>(value: &T, max: usize) -> Result<Vec<u8>> {
    let mut body =
        serde_json::to_vec(value).map_err(|_| WireError("cache frame encoding failed"))?;
    if body.len() > max {
        return Err(WireError("cache frame exceeds byte limit"));
    }
    body.push(b'\n');
    Ok(body)
}
fn decode<T: for<'de> Deserialize<'de>>(frame: &[u8], max: usize) -> Result<T> {
    if frame.len() > max + 1 {
        return Err(WireError("cache frame exceeds byte limit"));
    }
    let body = frame.strip_suffix(b"\n").unwrap_or(frame);
    if body.len() > max || body.contains(&b'\n') {
        return Err(WireError("invalid cache frame boundary"));
    }
    serde_json::from_slice(body).map_err(|_| WireError("invalid cache frame fields"))
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn uuid_v4(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 36
        && b[14] == b'4'
        && b"89ab".contains(&b[19])
        && b.iter().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                *c == b'-'
            } else {
                c.is_ascii_digit() || (b'a'..=b'f').contains(c)
            }
        })
}
fn root_path(value: &str) -> bool {
    let path = Path::new(value);
    !value.is_empty()
        && value.len() <= 4096
        && path.is_absolute()
        && !value.chars().any(char::is_control)
        && !value.contains("//")
        && (value == "/" || !value.ends_with('/'))
        && path
            .components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
        && !value.split('/').any(|c| c == "." || c == "..")
}

enum RawSid {
    Safe(String),
    Skipped,
    Unsupported,
}
struct LastSessionMember(Option<Box<RawValue>>);
impl<'de> Deserialize<'de> for LastSessionMember {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct Top;
        impl<'de> Visitor<'de> for Top {
            type Value = LastSessionMember;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("original payload object")
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut last = None;
                while let Some(key) = map.next_key::<String>()? {
                    // RawValue validates syntax without decoding unowned numeric
                    // values, UTF-16 strings, duplicate maps or other extensions.
                    let value = map.next_value::<Box<RawValue>>()?;
                    if key == "session_id" {
                        last = Some(value);
                    }
                }
                Ok(LastSessionMember(last))
            }
        }
        d.deserialize_map(Top)
    }
}
fn raw_sid(payload: &RawValue) -> RawSid {
    let last = match serde_json::from_str::<LastSessionMember>(payload.get()) {
        Ok(LastSessionMember(None)) => return RawSid::Skipped,
        Ok(LastSessionMember(Some(last))) => last,
        Err(_) => return RawSid::Unsupported,
    };
    let sid = match serde_json::from_str::<String>(last.get()) {
        Ok(sid) => sid,
        Err(_) => return RawSid::Unsupported,
    };
    if sid.is_empty()
        || sid == "unknown"
        || sid == "."
        || sid == ".."
        || !sid
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.@:-".contains(&b))
    {
        RawSid::Skipped
    } else {
        RawSid::Safe(sid)
    }
}

/// Separate admission keeps the original PreToolUse v1 invocation API intact.
pub struct PrefixInvocation<'a> {
    pub invocation: Invocation<'a>,
    pub original_ancestry: &'a crate::agent_pid_cache::OriginalAncestry,
}
pub struct PrefixOwner<'a> {
    invocation: Invocation<'a>,
    original: &'a crate::agent_pid_cache::OriginalAncestry,
    attempted: bool,
}
impl<'a> PrefixOwner<'a> {
    pub fn new(input: PrefixInvocation<'a>) -> Result<Self> {
        let invocation = input.invocation;
        if !cfg!(target_os = "macos")
            || !invocation.ready_active
            || !invocation.dispatched
            || !matches!(invocation.surface, "codex" | "claude-code")
            || invocation.event != "session_end"
            || invocation.configuration != "system"
            || invocation.advertised_capability != Some(PREFIX_CAPABILITY)
            || invocation.id.is_empty()
            || invocation.id.len() > 128
            || invocation.id.contains('\0')
            || !digest(invocation.runtime_digest)
            || !invocation.ready_project_digest.is_some_and(digest)
        {
            return Err(WireError(
                "prefix operation outside native active dispatched system SessionEnd",
            ));
        }
        Ok(Self {
            invocation,
            original: input.original_ancestry,
            attempted: false,
        })
    }
    pub fn admit(&mut self, frame: &[u8]) -> Result<PrefixAdmitted> {
        if self.attempted {
            return Err(WireError("prefix request already attempted"));
        }
        self.attempted = true;
        let wire: RequestFrame = decode(frame, MAX_REQUEST_BYTES)?;
        if wire.schema != PREFIX_REQUEST_SCHEMA
            || wire.id != self.invocation.id
            || wire.runtime_digest != self.invocation.runtime_digest
            || !uuid_v4(&wire.token)
            || !root_path(&wire.canonical_root)
            || sha(wire.canonical_root.as_bytes()) != self.invocation.ready_project_digest.unwrap()
        {
            return Err(WireError("prefix request binding mismatch"));
        }
        Ok(PrefixAdmitted {
            correlation: Correlation {
                id: wire.id,
                runtime_digest: wire.runtime_digest,
                token: wire.token,
            },
            canonical_root: wire.canonical_root,
            sid: raw_sid(self.invocation.original_payload),
            surface: self.invocation.surface.into(),
            original: self.original.clone(),
        })
    }
}
/// Original native input, captured before starting the engine. These values are
/// observations to make, not an asserted project, completed prefix or grant.
pub struct OriginalStopCaptureInput<'a> {
    pub id: &'a str,
    pub runtime_digest: &'a str,
    pub surface: &'a str,
    pub caller_cwd: &'a str,
    pub caller_environment: &'a std::collections::BTreeMap<String, String>,
    pub original_payload: &'a RawValue,
}

/// Keep remote custody intact: the original custodian Child/control must reach
/// the root's cleanup owner. Display text is never a substitute for this value.
#[derive(Debug)]
pub enum OriginalStopCaptureFailure {
    Invocation(String),
    Interrupted(String),
    Ancestry(String),
    Project {
        failure: Box<crate::context_git::original_project::RemoteFailure>,
        interruption: Option<String>,
    },
}
impl OriginalStopCaptureFailure {
    /// No project child can exist on invocation/ancestry/checkpoint errors.
    /// A project error retains its real remote handle, including after pending.
    pub fn cleanup_settled(&self) -> bool {
        match self {
            Self::Project { failure, .. } => failure.cleanup_settled(),
            _ => true,
        }
    }
    pub fn retry_cleanup_until(
        &mut self,
        original: &crate::monotonic_deadline::MonotonicDeadline,
        until: Instant,
    ) -> std::result::Result<(), String> {
        match self {
            Self::Project { failure, .. } => failure.retry_cleanup_until(original, until),
            _ => Ok(()),
        }
    }
    pub fn retry_cleanup(&mut self) -> std::result::Result<(), String> {
        match self {
            Self::Project { failure, .. } => failure.retry_cleanup(),
            _ => Ok(()),
        }
    }
}
impl fmt::Display for OriginalStopCaptureFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invocation(message) => write!(f, "original Stop invocation: {message}"),
            Self::Interrupted(message) => write!(f, "original Stop interrupted: {message}"),
            Self::Ancestry(message) => write!(f, "original Stop ancestry: {message}"),
            Self::Project {
                failure,
                interruption,
            } => {
                write!(f, "original Stop {failure}")?;
                if let Some(message) = interruption {
                    write!(f, "; original interruption: {message}")?;
                }
                Ok(())
            }
        }
    }
}
impl std::error::Error for OriginalStopCaptureFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Project { failure, .. } => Some(failure.as_ref()),
            _ => None,
        }
    }
}
fn original_stop_checkpoint(
    deadline: &crate::monotonic_deadline::MonotonicDeadline,
    cancel: &mut impl FnMut() -> std::result::Result<(), String>,
) -> std::result::Result<(), String> {
    cancel()?;
    deadline.check().map_err(|error| error.to_string())
}

/// Actual original-process capture. No Clone, Deserialize, asserted-project
/// constructor or permission flag exists. This is an unactivated library
/// prerequisite; it grants no stock selection, profile or publication authority.
/// Git children are owned by the separate native custodian, selected by the
/// caller's generation pin; this original process captures its own ancestry.
pub struct OriginalStopCapture<'deadline> {
    id: String,
    runtime_digest: String,
    surface: String,
    caller_cwd: String,
    caller_environment: std::collections::BTreeMap<String, String>,
    original_payload: Box<RawValue>,
    project: crate::context_git::original_project::CapturedProject,
    ancestry: crate::agent_pid_cache::OriginalAncestry,
    deadline: &'deadline crate::monotonic_deadline::MonotonicDeadline,
    original_pid: u32,
    owner_attempted: std::cell::Cell<bool>,
    _original_thread: std::marker::PhantomData<std::rc::Rc<()>>,
}
impl<'deadline> OriginalStopCapture<'deadline> {
    pub fn capture(
        input: OriginalStopCaptureInput<'_>,
        // Supplied by the trusted native-generation selector, never engine input.
        executor: &crate::invocation_project::SelectedExecutable,
        deadline: &'deadline crate::monotonic_deadline::MonotonicDeadline,
        mut cancel: impl FnMut() -> std::result::Result<(), String>,
    ) -> std::result::Result<Self, OriginalStopCaptureFailure> {
        original_stop_checkpoint(deadline, &mut cancel)
            .map_err(OriginalStopCaptureFailure::Interrupted)?;
        if !cfg!(target_os = "macos")
            || !matches!(input.surface, "opencode" | "zcode")
            || input.id.is_empty()
            || input.id.len() > 128
            || input.id.contains('\0')
            || !digest(input.runtime_digest)
        {
            return Err(OriginalStopCaptureFailure::Invocation(
                "unsupported original identity, surface or platform".into(),
            ));
        }
        // Capture ancestry first: no project Child exists on an ancestry error.
        // This API already supplies String diagnostics; preserve that exact value.
        let ancestry = crate::agent_pid_cache::OriginalAncestry::capture(
            input.surface,
            deadline.expires(),
            || original_stop_checkpoint(deadline, &mut cancel),
        )
        .map_err(OriginalStopCaptureFailure::Ancestry)?;
        original_stop_checkpoint(deadline, &mut cancel)
            .map_err(OriginalStopCaptureFailure::Interrupted)?;
        let interruption = std::cell::RefCell::new(None);
        let project = {
            let callback = std::cell::RefCell::new(&mut cancel);
            crate::context_git::original_project::capture(
                crate::context_git::original_project::Input {
                    id: input.id,
                    runtime_digest: input.runtime_digest,
                    caller_cwd: input.caller_cwd,
                    environment: input.caller_environment,
                    payload: input.original_payload,
                },
                executor,
                deadline,
                &|| match original_stop_checkpoint(deadline, &mut **callback.borrow_mut()) {
                    Ok(()) => false,
                    Err(message) => {
                        interruption.borrow_mut().get_or_insert(message);
                        true
                    }
                },
            )
        };
        let project = project.map_err(|failure| OriginalStopCaptureFailure::Project {
            failure: Box::new(failure),
            interruption: interruption.into_inner(),
        })?;
        original_stop_checkpoint(deadline, &mut cancel)
            .map_err(OriginalStopCaptureFailure::Interrupted)?;
        Ok(Self {
            id: input.id.into(),
            runtime_digest: input.runtime_digest.into(),
            surface: input.surface.into(),
            caller_cwd: input.caller_cwd.into(),
            caller_environment: input.caller_environment.clone(),
            original_payload: input.original_payload.to_owned(),
            project,
            ancestry,
            deadline,
            original_pid: std::process::id(),
            owner_attempted: std::cell::Cell::new(false),
            _original_thread: std::marker::PhantomData,
        })
    }
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn runtime_digest(&self) -> &str {
        &self.runtime_digest
    }
    pub fn surface(&self) -> &str {
        &self.surface
    }
    pub fn caller_cwd(&self) -> &str {
        &self.caller_cwd
    }
    pub fn caller_environment(&self) -> &std::collections::BTreeMap<String, String> {
        &self.caller_environment
    }
    pub fn original_payload(&self) -> &RawValue {
        &self.original_payload
    }
    /// Actual cwd spellings used by the two original custodian queries. This
    /// borrow supplies context replay data, not new selection or SQL authority.
    pub fn query_cwds(&self) -> &[std::path::PathBuf; 2] {
        self.project.query_cwds()
    }
    pub fn observed_project(&self) -> &crate::invocation_project::ObservedProject {
        self.project.project()
    }
    pub fn deadline(&self) -> &crate::monotonic_deadline::MonotonicDeadline {
        self.deadline
    }

    /// The first owner attempt is consumed even on a binding refusal. Consume
    /// captured originals internally; only Ready/dispatch context comes later.
    /// The returned prefix borrows this externally owned capture and its clock.
    pub fn prefix_owner<'capture>(
        &'capture self,
        invocation: Invocation<'capture>,
    ) -> std::result::Result<StopPrefixOwner<'capture>, String> {
        if self.owner_attempted.replace(true) {
            return Err("original Stop prefix owner already attempted".into());
        }
        if self.original_pid != std::process::id()
            || invocation.id != self.id
            || invocation.runtime_digest != self.runtime_digest
            || invocation.surface != self.surface
            || invocation.original_payload.get() != self.original_payload.get()
        {
            return Err("original Stop prefix invocation binding mismatch".into());
        }
        StopPrefixOwner::new(StopPrefixInvocation {
            invocation: Invocation {
                id: &self.id,
                runtime_digest: &self.runtime_digest,
                original_payload: &self.original_payload,
                surface: &self.surface,
                event: invocation.event,
                configuration: invocation.configuration,
                ready_active: invocation.ready_active,
                ready_project_digest: invocation.ready_project_digest,
                dispatched: invocation.dispatched,
                advertised_capability: invocation.advertised_capability,
            },
            original_ancestry: &self.ancestry,
            original_project: self.project.project(),
            deadline: self.deadline,
        })
    }
}

/// Inputs retained by the trusted original native frontend. The supplied
/// original_project must be the original invocation's independent observation,
/// never a current-project recomputation or deserialized TS substitute. This
/// prefix supplies no generation, selection, source-profile or publication grant.
pub struct StopPrefixInvocation<'a> {
    pub invocation: Invocation<'a>,
    pub original_ancestry: &'a crate::agent_pid_cache::OriginalAncestry,
    pub original_project: &'a crate::invocation_project::ObservedProject,
    pub deadline: &'a crate::monotonic_deadline::MonotonicDeadline,
}
pub struct StopPrefixOwner<'a> {
    invocation: Invocation<'a>,
    original: &'a crate::agent_pid_cache::OriginalAncestry,
    canonical_root: String,
    deadline: &'a crate::monotonic_deadline::MonotonicDeadline,
    attempted: bool,
}
impl<'a> StopPrefixOwner<'a> {
    pub(crate) fn new(input: StopPrefixInvocation<'a>) -> std::result::Result<Self, String> {
        input.deadline.check().map_err(|e| e.to_string())?;
        let invocation = input.invocation;
        let root = input
            .original_project
            .canonical_root
            .to_str()
            .ok_or("original Stop project is not native UTF-8")?;
        let checkout = input
            .original_project
            .checkout
            .to_str()
            .ok_or("original Stop checkout is not native UTF-8")?;
        // ObservedProject fixes both query slots at the type boundary. A real
        // capture retains each launched PID even after reap; pid=None denotes
        // an absent launch, not evidence that an invocation query completed.
        let settled = input.original_project.queries.iter().all(|query| {
            query.pid.is_some_and(|pid| pid > 0)
                && query.settled()
                && query.exit_observed
                && !query.ownership_retained
                && !query.pipes.stdout_open
                && !query.pipes.stderr_open
                && query.reaped.as_ref().is_some_and(|exit| exit.success)
                && query.pipes.stdout_eof
                && query.pipes.stderr_eof
        });
        if !cfg!(target_os = "macos")
            || !invocation.ready_active
            || !invocation.dispatched
            || !matches!(invocation.surface, "opencode" | "zcode")
            || invocation.event != "stop"
            || invocation.configuration != "system"
            || invocation.advertised_capability != Some(STOP_PREFIX_CAPABILITY)
            || invocation.id.is_empty()
            || invocation.id.len() > 128
            || invocation.id.contains('\0')
            || !digest(invocation.runtime_digest)
            || !root_path(root)
            || !root_path(checkout)
            || invocation.ready_project_digest != Some(sha(root.as_bytes()).as_str())
            || !settled
        {
            return Err("Stop prefix original project/Ready/custody or invocation mismatch".into());
        }
        Ok(Self {
            invocation,
            original: input.original_ancestry,
            canonical_root: root.into(),
            deadline: input.deadline,
            attempted: false,
        })
    }
    /// A first attempt is consumed even on malformed/binding refusal.
    pub fn admit(&mut self, frame: &[u8]) -> Result<StopPrefixAdmitted<'a>> {
        if self.attempted {
            return Err(WireError("Stop prefix request already attempted"));
        }
        self.attempted = true;
        self.deadline
            .check()
            .map_err(|_| WireError("original Stop prefix deadline unavailable"))?;
        let wire: RequestFrame = decode(frame, MAX_REQUEST_BYTES)?;
        if wire.schema != STOP_PREFIX_REQUEST_SCHEMA
            || wire.id != self.invocation.id
            || wire.runtime_digest != self.invocation.runtime_digest
            || !uuid_v4(&wire.token)
            || wire.canonical_root != self.canonical_root
        {
            return Err(WireError("Stop prefix request binding mismatch"));
        }
        Ok(StopPrefixAdmitted {
            inner: PrefixAdmitted {
                correlation: Correlation {
                    id: wire.id,
                    runtime_digest: wire.runtime_digest,
                    token: wire.token,
                },
                canonical_root: self.canonical_root.clone(),
                sid: raw_sid(self.invocation.original_payload),
                surface: self.invocation.surface.into(),
                original: self.original.clone(),
            },
            deadline: self.deadline,
        })
    }
}
pub struct StopPrefixAdmitted<'a> {
    inner: PrefixAdmitted,
    deadline: &'a crate::monotonic_deadline::MonotonicDeadline,
}
struct StopPrefixBinding {
    correlation: Correlation,
    canonical_root: String,
    surface: String,
    session_id: Option<String>,
}
pub struct StopPrefixExecution<'a> {
    result: PrefixResultFrame,
    exchange_error: Option<WireError>,
    cancellation_error: Option<String>,
    binding: StopPrefixBinding,
    deadline: &'a crate::monotonic_deadline::MonotonicDeadline,
}
impl<'a> StopPrefixAdmitted<'a> {
    /// Compatibility entrypoint: the supplied checkpoint retains every original
    /// invocation. Native main uses execute_with_authority_checks explicitly.
    pub fn execute_checked(
        self,
        checkpoint: impl FnMut() -> std::result::Result<(), String>,
        exchange: impl FnOnce(&[u8]) -> Result<Vec<u8>>,
    ) -> StopPrefixExecution<'a> {
        self.execute_with_checks(checkpoint, || Ok(()), exchange)
    }
    /// Keep cancellation/original-deadline checks at every read/preflight/write
    /// checkpoint; require full authority separately at effects and decisions.
    pub fn execute_with_authority_checks(
        self,
        checkpoint: impl FnMut() -> std::result::Result<(), String>,
        mut authority: impl FnMut() -> std::result::Result<(), String>,
        exchange: impl FnOnce(&[u8]) -> Result<Vec<u8>>,
    ) -> StopPrefixExecution<'a> {
        let deadline = self.deadline;
        self.execute_with_checks(
            checkpoint,
            || {
                deadline.check().map_err(|error| error.to_string())?;
                authority()?;
                deadline.check().map_err(|error| error.to_string())
            },
            exchange,
        )
    }
    fn execute_with_checks(
        self,
        mut checkpoint: impl FnMut() -> std::result::Result<(), String>,
        authority: impl FnMut() -> std::result::Result<(), String>,
        exchange: impl FnOnce(&[u8]) -> Result<Vec<u8>>,
    ) -> StopPrefixExecution<'a> {
        let binding = StopPrefixBinding {
            correlation: Correlation {
                id: self.inner.correlation.id.clone(),
                runtime_digest: self.inner.correlation.runtime_digest.clone(),
                token: self.inner.correlation.token.clone(),
            },
            canonical_root: self.inner.canonical_root.clone(),
            surface: self.inner.surface.clone(),
            session_id: match &self.inner.sid {
                RawSid::Safe(sid) => Some(sid.clone()),
                _ => None,
            },
        };
        let deadline = self.deadline;
        let execution = self.inner.execute_event_with_authority(
            session_cache::PrefixEvent::Stop,
            deadline.expires(),
            || {
                deadline.check().map_err(|e| e.to_string())?;
                checkpoint()
            },
            authority,
            exchange,
        );
        StopPrefixExecution {
            result: execution.result,
            exchange_error: execution.exchange_error,
            cancellation_error: execution.cancellation_error,
            binding,
            deadline,
        }
    }
}
/// In-process completion evidence, not deserializable and not a publication
/// grant. QualifiedStop must independently bind selection/source/profile and
/// revalidate original deadline/readset before any subsequent effects.
pub struct CompletedStopPrefix<'a> {
    result: PrefixResultFrame,
    binding: StopPrefixBinding,
    deadline: &'a crate::monotonic_deadline::MonotonicDeadline,
}
impl<'a> StopPrefixExecution<'a> {
    pub fn result(&self) -> &PrefixResultFrame {
        &self.result
    }
    pub fn exchange_error(&self) -> Option<&WireError> {
        self.exchange_error.as_ref()
    }
    pub fn cancellation_error(&self) -> Option<&str> {
        self.cancellation_error.as_deref()
    }
    /// Refusal retains the actual execution and partial-effects/error receipt.
    pub fn into_completed(self) -> std::result::Result<CompletedStopPrefix<'a>, Self> {
        if !self.result.prefix_complete()
            || self.exchange_error.is_some()
            || self.cancellation_error.is_some()
            || self.binding.session_id.is_none()
            || self.deadline.check().is_err()
        {
            return Err(self);
        }
        Ok(CompletedStopPrefix {
            result: self.result,
            binding: self.binding,
            deadline: self.deadline,
        })
    }
}
impl CompletedStopPrefix<'_> {
    pub fn result(&self) -> &PrefixResultFrame {
        &self.result
    }
    pub fn correlation(&self) -> &Correlation {
        &self.binding.correlation
    }
    pub fn canonical_root(&self) -> &str {
        &self.binding.canonical_root
    }
    pub fn surface(&self) -> &str {
        &self.binding.surface
    }
    pub fn supplied_session_id(&self) -> &str {
        self.binding
            .session_id
            .as_deref()
            .expect("completed supplied id")
    }
    pub fn deadline(&self) -> &crate::monotonic_deadline::MonotonicDeadline {
        self.deadline
    }
    pub fn check(&self) -> std::result::Result<(), String> {
        self.deadline.check().map_err(|e| e.to_string())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PrefixStatus {
    Completed,
    Declined,
    Unavailable,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefixResultFrame {
    schema: &'static str,
    id: String,
    runtime_digest: String,
    token: String,
    status: PrefixStatus,
    prefix_complete: bool,
    envelope_published: bool,
    pointer_published: bool,
    agent_pid: crate::agent_pid_cache::AgentPidOutcome,
    reap: crate::agent_pid_cache::ReapOutcome,
    diagnostic: Option<String>,
}
impl PrefixResultFrame {
    pub fn encode(&self) -> Result<Vec<u8>> {
        encode(self, MAX_RESULT_BYTES)
    }
    pub fn prefix_complete(&self) -> bool {
        self.prefix_complete
    }
    pub fn status(&self) -> PrefixStatus {
        self.status
    }
    pub fn fallback_safe(&self) -> bool {
        self.status == PrefixStatus::Declined
            && !self.prefix_complete
            && !self.envelope_published
            && !self.pointer_published
    }
}
pub struct PrefixAdmitted {
    correlation: Correlation,
    canonical_root: String,
    sid: RawSid,
    surface: String,
    original: crate::agent_pid_cache::OriginalAncestry,
}
pub struct PrefixExecution {
    pub result: PrefixResultFrame,
    pub exchange_error: Option<WireError>,
    pub cancellation_error: Option<String>,
}
fn prefix_result(
    event: session_cache::PrefixEvent,
    c: &Correlation,
    status: PrefixStatus,
    complete: bool,
    envelope: bool,
    pointer: bool,
    agent_pid: crate::agent_pid_cache::AgentPidOutcome,
    reap: crate::agent_pid_cache::ReapOutcome,
    diagnostic: Option<String>,
) -> PrefixResultFrame {
    // Reuse the bounded UTF-8 diagnostic normalization, not the v1 status schema.
    let diagnostic = make_result(c, Status::Unavailable, envelope, diagnostic).diagnostic;
    PrefixResultFrame {
        schema: match event {
            session_cache::PrefixEvent::SessionEnd => PREFIX_RESULT_SCHEMA,
            session_cache::PrefixEvent::Stop => STOP_PREFIX_RESULT_SCHEMA,
        },
        id: c.id.clone(),
        runtime_digest: c.runtime_digest.clone(),
        token: c.token.clone(),
        status,
        prefix_complete: complete,
        envelope_published: envelope,
        pointer_published: pointer,
        agent_pid,
        reap,
        diagnostic,
    }
}
fn prefix_checkpoint(
    expires: Instant,
    checkpoint: &mut impl FnMut() -> std::result::Result<(), String>,
) -> std::result::Result<(), session_cache::FailureKind> {
    checkpoint().map_err(session_cache::FailureKind::Cancelled)?;
    if Instant::now() >= expires {
        Err(session_cache::FailureKind::Deadline)
    } else {
        Ok(())
    }
}
impl PrefixAdmitted {
    pub fn execute_checked(
        self,
        expires: Instant,
        checkpoint: impl FnMut() -> std::result::Result<(), String>,
        exchange: impl FnOnce(&[u8]) -> Result<Vec<u8>>,
    ) -> PrefixExecution {
        self.execute_event(
            session_cache::PrefixEvent::SessionEnd,
            expires,
            checkpoint,
            exchange,
        )
    }
    fn execute_event(
        self,
        event: session_cache::PrefixEvent,
        expires: Instant,
        checkpoint: impl FnMut() -> std::result::Result<(), String>,
        exchange: impl FnOnce(&[u8]) -> Result<Vec<u8>>,
    ) -> PrefixExecution {
        self.execute_event_with_authority(event, expires, checkpoint, || Ok(()), exchange)
    }
    fn execute_event_with_authority(
        self,
        event: session_cache::PrefixEvent,
        expires: Instant,
        mut checkpoint: impl FnMut() -> std::result::Result<(), String>,
        mut authority: impl FnMut() -> std::result::Result<(), String>,
        exchange: impl FnOnce(&[u8]) -> Result<Vec<u8>>,
    ) -> PrefixExecution {
        use crate::agent_pid_cache::{
            self, AgentPidOutcome as Pid, PrepareError, ReapOutcome as Reap,
        };
        use session_cache::{FailureKind, PrefixPreparation};
        let terminal =
            |status, complete, envelope, pointer, pid, reap, diagnostic| PrefixExecution {
                result: prefix_result(
                    event,
                    &self.correlation,
                    status,
                    complete,
                    envelope,
                    pointer,
                    pid,
                    reap,
                    diagnostic,
                ),
                exchange_error: None,
                cancellation_error: None,
            };
        let fatal = |failure: FailureKind, envelope, pointer, pid, reap| {
            let label = match event {
                session_cache::PrefixEvent::SessionEnd => "SessionEnd",
                session_cache::PrefixEvent::Stop => "Stop",
            };
            let diagnostic = format!("{label} prefix interrupted: {failure:?}");
            let mut execution = terminal(
                PrefixStatus::Unavailable,
                false,
                envelope,
                pointer,
                pid,
                reap,
                Some(diagnostic),
            );
            if let FailureKind::Cancelled(error) = failure {
                execution.cancellation_error = Some(error);
            }
            execution
        };
        if let Err(failure) = prefix_checkpoint(expires, &mut checkpoint) {
            return fatal(failure, false, false, Pid::NotRun, Reap::NotRun);
        }
        if !self.original.supports(&self.surface) {
            return terminal(
                PrefixStatus::Declined,
                false,
                false,
                false,
                Pid::NotRun,
                Reap::NotRun,
                Some("original native process/PID profile unsupported".into()),
            );
        }
        let sid = match &self.sid {
            RawSid::Safe(sid) => sid,
            _ => {
                return terminal(
                    PrefixStatus::Declined,
                    false,
                    false,
                    false,
                    Pid::NotRun,
                    Reap::NotRun,
                    Some(
                        match event {
                            session_cache::PrefixEvent::SessionEnd => {
                                "original SessionEnd session-id profile unsupported"
                            }
                            session_cache::PrefixEvent::Stop => {
                                "original Stop session-id profile unsupported"
                            }
                        }
                        .into(),
                    ),
                );
            }
        };
        let input = CaptureInput {
            canonical_root: Path::new(&self.canonical_root),
            supplied_session_id: Some(sid),
            supplied_hook_event: Some(match event {
                session_cache::PrefixEvent::SessionEnd => "SessionEnd",
                session_cache::PrefixEvent::Stop => "Stop",
            }),
        };
        let mut diagnostics = Vec::new();
        let mut envelope_unavailable = false;
        let mut prepared = match session_cache::prepare_prefix(&input, expires, &mut checkpoint) {
            Ok(PrefixPreparation::Ready(prepared)) => prepared,
            Ok(PrefixPreparation::Declined(_)) => {
                return terminal(
                    PrefixStatus::Declined,
                    false,
                    false,
                    false,
                    Pid::NotRun,
                    Reap::NotRun,
                    Some("old envelope file profile unsupported".into()),
                );
            }
            Err(error) => {
                if matches!(
                    error.kind,
                    FailureKind::Cancelled(_) | FailureKind::Deadline
                ) {
                    return fatal(error.kind, false, false, Pid::NotRun, Reap::NotRun);
                }
                envelope_unavailable = true;
                diagnostics.push(error.to_string());
                match session_cache::prepare_pid_prefix(&input, expires, &mut checkpoint) {
                    Ok(prepared) => prepared,
                    Err(error) => {
                        if matches!(
                            error.kind,
                            FailureKind::Cancelled(_) | FailureKind::Deadline
                        ) {
                            return fatal(error.kind, false, false, Pid::NotRun, Reap::NotRun);
                        }
                        diagnostics.push(error.to_string());
                        if let Err(failure) = prefix_checkpoint(expires, &mut checkpoint) {
                            return fatal(failure, false, false, Pid::NotRun, Reap::NotRun);
                        }
                        return terminal(
                            PrefixStatus::Unavailable,
                            true,
                            false,
                            false,
                            Pid::Unavailable,
                            Reap::NotRun,
                            Some(diagnostics.join("; ")),
                        );
                    }
                }
            }
        };
        if let Some(error) = prepared.take_preflight_failure() {
            envelope_unavailable = true;
            diagnostics.push(error.to_string());
        }
        let pid = match agent_pid_cache::prepare(
            prepared.sessions(),
            &self.original,
            expires,
            &mut checkpoint,
        ) {
            Ok(prepared) => Some(prepared),
            Err(PrepareError::Unsupported(reason)) => {
                return terminal(
                    PrefixStatus::Declined,
                    false,
                    false,
                    false,
                    Pid::NotRun,
                    Reap::NotRun,
                    Some(reason.into()),
                );
            }
            Err(PrepareError::Failure(failure)) => {
                if matches!(failure, FailureKind::Cancelled(_) | FailureKind::Deadline) {
                    return fatal(failure, false, false, Pid::NotRun, Reap::NotRun);
                }
                diagnostics.push(format!("PID preflight unavailable: {failure:?}"));
                None
            }
        };
        let decided = if envelope_unavailable {
            Ok(CaptureDecision::Capture(None))
        } else {
            (|| {
                let existing_base64 = match prepared.existing() {
                    ExistingEnvelope::Missing => None,
                    ExistingEnvelope::Bytes(bytes) => Some(STANDARD.encode(bytes)),
                };
                let frame = encode(
                    &PreviousFrame {
                        schema: match event {
                            session_cache::PrefixEvent::SessionEnd => PREFIX_PREVIOUS_SCHEMA,
                            session_cache::PrefixEvent::Stop => STOP_PREFIX_PREVIOUS_SCHEMA,
                        },
                        id: &self.correlation.id,
                        runtime_digest: &self.correlation.runtime_digest,
                        token: &self.correlation.token,
                        existing_base64,
                    },
                    MAX_PREVIOUS_BYTES,
                )?;
                let response = exchange(&frame)?;
                let decision: DecisionFrame = decode(&response, MAX_DECISION_BYTES)?;
                if decision.schema
                    != match event {
                        session_cache::PrefixEvent::SessionEnd => PREFIX_DECISION_SCHEMA,
                        session_cache::PrefixEvent::Stop => STOP_PREFIX_DECISION_SCHEMA,
                    }
                    || decision.id != self.correlation.id
                    || decision.runtime_digest != self.correlation.runtime_digest
                    || decision.token != self.correlation.token
                {
                    return Err(WireError("prefix decision binding mismatch"));
                }
                match decision.action {
                    Action::Capture => Ok(CaptureDecision::Capture(decision.created_units)),
                    Action::Decline if decision.created_units.is_none() => {
                        Ok(CaptureDecision::Decline)
                    }
                    _ => Err(WireError("prefix decline carries creation units")),
                }
            })()
        };
        if let Err(failure) = prefix_checkpoint(expires, &mut checkpoint) {
            return fatal(failure, false, false, Pid::NotRun, Reap::NotRun);
        }
        if !envelope_unavailable {
            // Revalidate after the engine exchange even when it declined or
            // returned malformed data; that callback can change authority.
            if let Err(error) = authority() {
                return fatal(
                    FailureKind::Cancelled(error),
                    false,
                    false,
                    Pid::NotRun,
                    Reap::NotRun,
                );
            }
        }
        let created = match decided {
            Ok(CaptureDecision::Capture(created)) => created,
            Ok(CaptureDecision::Decline) => {
                return terminal(
                    PrefixStatus::Declined,
                    false,
                    false,
                    false,
                    Pid::NotRun,
                    Reap::NotRun,
                    Some("engine decoder explicitly declined".into()),
                );
            }
            Err(error) => {
                let mut execution = terminal(
                    PrefixStatus::Unavailable,
                    false,
                    false,
                    false,
                    Pid::NotRun,
                    Reap::NotRun,
                    Some(error.to_string()),
                );
                execution.exchange_error = Some(error);
                return execution;
            }
        };
        let (envelope, pointer) = if envelope_unavailable {
            (false, false)
        } else {
            let committed = session_cache::commit_prefix_for_event_with_authority(
                &mut prepared,
                &self.surface,
                event,
                created,
                expires,
                &mut checkpoint,
                &mut authority,
            );
            match committed {
                Ok(()) => (true, true),
                Err(error) => {
                    let envelope = error.envelope_published;
                    if matches!(
                        error.kind,
                        FailureKind::Cancelled(_) | FailureKind::Deadline
                    ) {
                        return fatal(error.kind, envelope, false, Pid::NotRun, Reap::NotRun);
                    }
                    diagnostics.push(error.to_string());
                    (envelope, false)
                }
            }
        };
        if let Err(failure) = prefix_checkpoint(expires, &mut checkpoint) {
            return fatal(failure, envelope, pointer, Pid::NotRun, Reap::NotRun);
        }
        let (agent_pid, reap) = match pid {
            Some(pid) => {
                let outcome = pid.commit_with_authority(
                    &mut prepared,
                    sid,
                    &self.canonical_root,
                    expires,
                    &mut checkpoint,
                    &mut authority,
                );
                if let Some(failure) = outcome.failure {
                    if matches!(failure, FailureKind::Cancelled(_) | FailureKind::Deadline) {
                        return fatal(failure, envelope, pointer, outcome.agent_pid, outcome.reap);
                    }
                    diagnostics.push(format!("PID prefix unavailable: {failure:?}"));
                }
                (outcome.agent_pid, outcome.reap)
            }
            None => (Pid::Unavailable, Reap::NotRun),
        };
        if let Err(failure) = prefix_checkpoint(expires, &mut checkpoint) {
            return fatal(failure, envelope, pointer, agent_pid, reap);
        }
        let status = if diagnostics.is_empty() {
            PrefixStatus::Completed
        } else {
            PrefixStatus::Unavailable
        };
        terminal(
            status,
            true,
            envelope,
            pointer,
            agent_pid,
            reap,
            if diagnostics.is_empty() {
                None
            } else {
                Some(diagnostics.join("; "))
            },
        )
    }
}

#[cfg(test)]
#[path = "session_cache_wire/tests.rs"]
mod tests;
