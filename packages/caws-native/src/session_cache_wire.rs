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
        let result = |status, published, diagnostic| {
            make_result(&self.correlation, status, published, diagnostic)
        };
        if Instant::now() >= expires {
            return Execution {
                result: result(
                    Status::Unavailable,
                    false,
                    Some("cache deadline expired".into()),
                ),
                exchange_error: None,
            };
        }
        let sid = match &self.sid {
            RawSid::Skipped => {
                return Execution {
                    result: result(Status::Skipped, false, None),
                    exchange_error: None,
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
        let captured = session_cache::capture_with_decision(&input, expires, |old| {
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

#[cfg(test)]
mod tests;
