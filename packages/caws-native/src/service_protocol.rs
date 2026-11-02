//! Exact typed-TS service wire data. This module verifies syntax and correlation;
//! it grants no authority, custody, FD rights, admission, deadline, or replay rights.
//! A native owner must retain its issued grant AND immutable expected request and
//! independently validate authority before dispatch. Digests are public identities.
use serde::{
    Deserialize, Deserializer, Serialize, Serializer,
    de::{self, MapAccess, SeqAccess, Visitor},
    ser::SerializeMap,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fmt};

pub const MAX_RENDER_ARGUMENT_BYTES: usize = 65_536;
pub const MAX_RENDER_REQUEST_BYTES: usize = 131_072;
pub const MAX_RENDER_OUTCOME_BYTES: usize = 8_192;
pub const MAX_SERVICE_GRANT_BYTES: usize = 32_768;
pub const MAX_SERVICE_BRIDGE_REQUEST_BYTES: usize = 132_096;
pub const MAX_SERVICE_BRIDGE_REPLY_BYTES: usize = 9_216;
pub const MAX_SERVICE_RECEIPT_BYTES: usize = 9_216;
const SAFE: u64 = 9_007_199_254_740_991;
const REQUEST: &str = "caws.service.render.request.v1";
const OUTCOME: &str = "caws.service.render.outcome.v1";
const GRANT: &str = "caws.service.render.grant.v1";
const BRIDGE_REQUEST: &str = "caws.service.render.bridge.request.v1";
const BRIDGE_REPLY: &str = "caws.service.render.bridge.reply.v1";
const RECEIPT: &str = "caws.service.render.client.receipt.v1";
const ADAPTER: &str = "sterling-session-log-broker-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProtocolError;
impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("invalid session render service frame")
    }
}
impl std::error::Error for ProtocolError {}
pub type Result<T> = std::result::Result<T, ProtocolError>;
fn require(value: bool) -> Result<()> {
    if value { Ok(()) } else { Err(ProtocolError) }
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}
fn invocation(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || b"._:-".contains(&v))
}
fn path(value: &str) -> bool {
    value.len() <= 4096
        && value.starts_with('/')
        && !value.contains('\0')
        && (value == "/" || value[1..].split('/').all(|v| !matches!(v, "" | "." | "..")))
}
fn json<T: Serialize + ?Sized>(value: &T) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|_| ProtocolError)
}
fn encode<T: Serialize>(value: &T, max: usize) -> Result<Vec<u8>> {
    let mut body = json(value)?;
    require(body.len() <= max)?;
    body.push(b'\n');
    Ok(body)
}

// Preserve input member order for JSON.stringify equivalence. A BTreeMap-based
// Value round trip would incorrectly refuse reordered canonical objects. Valid
// service numbers are exclusively unsigned safe integers: float, negative, and
// exponent spellings cannot occur in a successfully validated v1 frame.
struct Canonical(String);
impl<'de> Deserialize<'de> for Canonical {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Canonical;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("canonical service JSON")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<Canonical, E> {
                Ok(Canonical(v.to_string()))
            }
            fn visit_unit<E: de::Error>(self) -> std::result::Result<Canonical, E> {
                Ok(Canonical("null".into()))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<Canonical, E> {
                if v > SAFE {
                    return Err(E::custom("unsafe integer"));
                }
                Ok(Canonical(v.to_string()))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<Canonical, E> {
                if v < 0 {
                    return Err(E::custom("negative integer"));
                }
                self.visit_u64(v as u64)
            }
            fn visit_str<E: de::Error>(self, v: &str) -> std::result::Result<Canonical, E> {
                serde_json::to_string(v).map(Canonical).map_err(E::custom)
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Canonical, A::Error> {
                let mut entries = Vec::new();
                while let Some(value) = a.next_element::<Canonical>()? {
                    entries.push(value.0);
                }
                Ok(Canonical(format!("[{}]", entries.join(","))))
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Canonical, A::Error> {
                let mut seen = BTreeSet::new();
                let mut entries = Vec::new();
                while let Some(key) = a.next_key::<String>()? {
                    if !seen.insert(key.clone()) {
                        return Err(de::Error::custom("duplicate field"));
                    }
                    let value = a.next_value::<Canonical>()?;
                    entries.push(format!(
                        "{}:{}",
                        serde_json::to_string(&key).map_err(de::Error::custom)?,
                        value.0
                    ));
                }
                Ok(Canonical(format!("{{{}}}", entries.join(","))))
            }
        }
        d.deserialize_any(V)
    }
}
fn decode<T: for<'de> Deserialize<'de>>(frame: &[u8], max: usize) -> Result<T> {
    require(frame.len() <= max + 1)?;
    let body = frame.strip_suffix(b"\n").unwrap_or(frame);
    require(body.len() <= max)?;
    let text = std::str::from_utf8(body).map_err(|_| ProtocolError)?;
    let canonical: Canonical = serde_json::from_str(text).map_err(|_| ProtocolError)?;
    require(canonical.0 == text)?;
    serde_json::from_slice(body).map_err(|_| ProtocolError)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OriginalSource {
    pub handler_sha256: String,
    pub closure_digest: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionImage {
    pub image_digest: String,
    pub client_sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderRequest {
    pub schema: String,
    pub request_id: String,
    pub invocation_id: String,
    pub selected_index: u16,
    pub operation: String,
    pub canonical_project: String,
    pub project_service_key: String,
    pub source_generation: String,
    pub original_source: OriginalSource,
    pub execution_image: ExecutionImage,
    pub argument_digest: String,
    pub arguments: [String; 12],
}
pub fn render_argument_digest(args: &[String; 12]) -> Result<String> {
    require(args.iter().all(|v| !v.contains('\0')))?;
    let body = json(&("caws-session-render-argv-v1", args))?;
    require(body.len() <= MAX_RENDER_ARGUMENT_BYTES)?;
    Ok(sha(&body))
}
pub fn render_request_id(invocation_id: &str, selected_index: u16) -> Result<String> {
    require(invocation(invocation_id))?;
    Ok(sha(&json(&(
        "caws-service-render-request-id-v1",
        invocation_id,
        selected_index,
        "render:0",
    ))?))
}
pub fn project_service_key(project: &str) -> Result<String> {
    require(path(project))?;
    Ok(sha(&json(&(
        "caws-project-service-key-v1",
        project,
        "session-render",
    ))?))
}
fn source_valid(source: &OriginalSource, image: &ExecutionImage) -> bool {
    [
        &source.handler_sha256,
        &source.closure_digest,
        &image.image_digest,
        &image.client_sha256,
    ]
    .into_iter()
    .all(|v| hash(v))
}
impl RenderRequest {
    pub fn validate(&self) -> Result<()> {
        require(
            self.schema == REQUEST
                && self.operation == "render:0"
                && hash(&self.source_generation)
                && source_valid(&self.original_source, &self.execution_image),
        )?;
        require(
            self.request_id == render_request_id(&self.invocation_id, self.selected_index)?
                && self.project_service_key == project_service_key(&self.canonical_project)?
                && self.argument_digest == render_argument_digest(&self.arguments)?,
        )?;
        require(json(self)?.len() <= MAX_RENDER_REQUEST_BYTES)
    }
}
pub fn decode_render_request(frame: &[u8]) -> Result<RenderRequest> {
    let value: RenderRequest = decode(frame, MAX_RENDER_REQUEST_BYTES)?;
    value.validate()?;
    Ok(value)
}
pub fn encode_render_request(value: &RenderRequest) -> Result<Vec<u8>> {
    value.validate()?;
    encode(value, MAX_RENDER_REQUEST_BYTES)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceRenderGrant {
    pub schema: String,
    pub grant_id: String,
    pub adapter: String,
    pub invocation_id: String,
    pub selected_index: u16,
    pub canonical_project: String,
    pub source_generation: String,
    pub original_source: OriginalSource,
    pub execution_image: ExecutionImage,
    pub original_handler_entry: String,
    pub original_handler_path: String,
    pub hooks_directory: String,
    pub lease_file: String,
    pub remaining_budget_ms: u64,
}
impl ServiceRenderGrant {
    pub fn validate(&self) -> Result<()> {
        require(
            self.schema == GRANT
                && self.adapter == ADAPTER
                && self.original_handler_entry == "session-log.sh"
                && invocation(&self.invocation_id)
                && hash(&self.grant_id)
                && hash(&self.source_generation)
                && source_valid(&self.original_source, &self.execution_image)
                && [
                    &self.canonical_project,
                    &self.original_handler_path,
                    &self.hooks_directory,
                    &self.lease_file,
                ]
                .into_iter()
                .all(|v| path(v))
                && (1..=120_000).contains(&self.remaining_budget_ms),
        )?;
        require(json(self)?.len() <= MAX_SERVICE_GRANT_BYTES)
    }
    pub fn request(&self, arguments: [String; 12]) -> Result<RenderRequest> {
        self.validate()?;
        let request = RenderRequest {
            schema: REQUEST.into(),
            request_id: render_request_id(&self.invocation_id, self.selected_index)?,
            invocation_id: self.invocation_id.clone(),
            selected_index: self.selected_index,
            operation: "render:0".into(),
            canonical_project: self.canonical_project.clone(),
            project_service_key: project_service_key(&self.canonical_project)?,
            source_generation: self.source_generation.clone(),
            original_source: self.original_source.clone(),
            execution_image: self.execution_image.clone(),
            argument_digest: render_argument_digest(&arguments)?,
            arguments,
        };
        request.validate()?;
        Ok(request)
    }
    pub fn validate_bound_request(&self, request: &RenderRequest) -> Result<()> {
        request.validate()?;
        require(*request == self.request(request.arguments.clone())?)
    }
}
pub fn decode_service_grant(frame: &[u8]) -> Result<ServiceRenderGrant> {
    let value: ServiceRenderGrant = decode(frame, MAX_SERVICE_GRANT_BYTES)?;
    value.validate()?;
    Ok(value)
}
pub fn encode_service_grant(value: &ServiceRenderGrant) -> Result<Vec<u8>> {
    value.validate()?;
    encode(value, MAX_SERVICE_GRANT_BYTES)
}
pub fn service_grant_digest(grant: &ServiceRenderGrant) -> Result<String> {
    grant.validate()?;
    Ok(sha(&json(grant)?))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceBridgeRequest {
    pub schema: String,
    pub grant_id: String,
    pub grant_digest: String,
    pub request: RenderRequest,
}
fn envelope(
    schema: &str,
    expected: &str,
    grant_id: &str,
    grant_digest: &str,
    grant: &ServiceRenderGrant,
) -> Result<()> {
    grant.validate()?;
    require(
        schema == expected
            && grant_id == grant.grant_id
            && grant_digest == service_grant_digest(grant)?,
    )
}
pub fn decode_service_bridge_request(
    frame: &[u8],
    issued: &ServiceRenderGrant,
) -> Result<ServiceBridgeRequest> {
    let value: ServiceBridgeRequest = decode(frame, MAX_SERVICE_BRIDGE_REQUEST_BYTES)?;
    envelope(
        &value.schema,
        BRIDGE_REQUEST,
        &value.grant_id,
        &value.grant_digest,
        issued,
    )?;
    issued.validate_bound_request(&value.request)?;
    Ok(value)
}
pub fn encode_service_bridge_request(
    grant: &ServiceRenderGrant,
    request: &RenderRequest,
) -> Result<Vec<u8>> {
    grant.validate_bound_request(request)?;
    encode(
        &ServiceBridgeRequest {
            schema: BRIDGE_REQUEST.into(),
            grant_id: grant.grant_id.clone(),
            grant_digest: service_grant_digest(grant)?,
            request: request.clone(),
        },
        MAX_SERVICE_BRIDGE_REQUEST_BYTES,
    )
}
/// Native ingress additionally compares all request fields against the exact
/// owner-issued expectation. A client can recompute every hash in these frames.
/// Passing this function does not evaluate current admission/authority/custody.
pub fn validate_issued_request(
    incoming: &ServiceBridgeRequest,
    issued: &ServiceRenderGrant,
    expected: &RenderRequest,
) -> Result<()> {
    envelope(
        &incoming.schema,
        BRIDGE_REQUEST,
        &incoming.grant_id,
        &incoming.grant_digest,
        issued,
    )?;
    issued.validate_bound_request(expected)?;
    issued.validate_bound_request(&incoming.request)?;
    require(incoming.request == *expected)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RenderResult {
    ProcessExit {
        code: Option<u8>,
        signal: Option<u8>,
    },
    DaemonResponse {
        served: u64,
        elapsed_ms: u64,
        cached: bool,
    },
}
impl Serialize for RenderResult {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        match self {
            Self::ProcessExit { code, signal } => {
                let mut m = s.serialize_map(Some(3))?;
                m.serialize_entry("kind", "process_exit")?;
                m.serialize_entry("code", code)?;
                m.serialize_entry("signal", signal)?;
                m.end()
            }
            Self::DaemonResponse {
                served,
                elapsed_ms,
                cached,
            } => {
                let mut m = s.serialize_map(Some(5))?;
                m.serialize_entry("kind", "daemon_response")?;
                m.serialize_entry("response", "ok")?;
                m.serialize_entry("served", served)?;
                m.serialize_entry("elapsedMs", elapsed_ms)?;
                m.serialize_entry("cached", cached)?;
                m.end()
            }
        }
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum CancelReason {
    #[serde(rename = "source_retired")]
    SourceRetired,
    #[serde(rename = "grant_withdrawn")]
    GrantWithdrawn,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RenderOutcome {
    Rejected {
        reason: String,
    },
    Queued,
    Running,
    Unknown,
    CancelledBeforeDispatch {
        reason: CancelReason,
    },
    Returned {
        result: RenderResult,
        artifact_manifest_digest: Option<String>,
    },
}
impl Serialize for RenderOutcome {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(None)?;
        m.serialize_entry(
            "admission",
            if matches!(self, Self::Rejected { .. }) {
                "rejected"
            } else {
                "accepted"
            },
        )?;
        match self {
            Self::Rejected { reason } => {
                m.serialize_entry("execution", "known_not_executed")?;
                m.serialize_entry("reason", reason)?;
            }
            Self::Queued => m.serialize_entry("execution", "queued")?,
            Self::Running => m.serialize_entry("execution", "running")?,
            Self::Unknown => m.serialize_entry("execution", "unknown")?,
            Self::CancelledBeforeDispatch { reason } => {
                m.serialize_entry("execution", "cancelled_before_dispatch")?;
                m.serialize_entry("reason", reason)?;
            }
            Self::Returned {
                result,
                artifact_manifest_digest,
            } => {
                m.serialize_entry("execution", "returned")?;
                m.serialize_entry("result", result)?;
                m.serialize_entry("artifactManifestDigest", artifact_manifest_digest)?;
            }
        }
        m.end()
    }
}
fn exact(v: &Value, keys: &[&str]) -> Result<()> {
    require(
        v.as_object()
            .is_some_and(|m| m.len() == keys.len() && keys.iter().all(|k| m.contains_key(*k))),
    )
}
fn string(v: &Value) -> Result<&str> {
    v.as_str().ok_or(ProtocolError)
}
fn uint(v: &Value, min: u64, max: u64) -> Result<u64> {
    v.as_u64()
        .filter(|n| (min..=max).contains(n))
        .ok_or(ProtocolError)
}
fn result_value(v: &Value) -> Result<RenderResult> {
    match v["kind"].as_str() {
        Some("process_exit") => {
            exact(v, &["kind", "code", "signal"])?;
            require(v["code"].is_null() != v["signal"].is_null())?;
            Ok(RenderResult::ProcessExit {
                code: if v["code"].is_null() {
                    None
                } else {
                    Some(uint(&v["code"], 0, 255)? as u8)
                },
                signal: if v["signal"].is_null() {
                    None
                } else {
                    Some(uint(&v["signal"], 1, 127)? as u8)
                },
            })
        }
        Some("daemon_response") => {
            exact(v, &["kind", "response", "served", "elapsedMs", "cached"])?;
            require(v["response"] == "ok")?;
            Ok(RenderResult::DaemonResponse {
                served: uint(&v["served"], 1, SAFE)?,
                elapsed_ms: uint(&v["elapsedMs"], 0, SAFE)?,
                cached: v["cached"].as_bool().ok_or(ProtocolError)?,
            })
        }
        _ => Err(ProtocolError),
    }
}
fn outcome_value(v: &Value) -> Result<RenderOutcome> {
    if v["admission"] == "rejected" && v["execution"] == "known_not_executed" {
        exact(v, &["admission", "execution", "reason"])?;
        let reason = string(&v["reason"])?;
        require(reason.len() <= 1024)?;
        return Ok(RenderOutcome::Rejected {
            reason: reason.into(),
        });
    }
    require(v["admission"] == "accepted")?;
    match v["execution"].as_str() {
        Some("queued" | "running" | "unknown") => {
            exact(v, &["admission", "execution"])?;
            Ok(match v["execution"].as_str() {
                Some("queued") => RenderOutcome::Queued,
                Some("running") => RenderOutcome::Running,
                _ => RenderOutcome::Unknown,
            })
        }
        Some("cancelled_before_dispatch") => {
            exact(v, &["admission", "execution", "reason"])?;
            let reason = match v["reason"].as_str() {
                Some("source_retired") => CancelReason::SourceRetired,
                Some("grant_withdrawn") => CancelReason::GrantWithdrawn,
                _ => return Err(ProtocolError),
            };
            Ok(RenderOutcome::CancelledBeforeDispatch { reason })
        }
        Some("returned") => {
            exact(
                v,
                &["admission", "execution", "result", "artifactManifestDigest"],
            )?;
            let digest = if v["artifactManifestDigest"].is_null() {
                None
            } else {
                let d = string(&v["artifactManifestDigest"])?;
                require(hash(d))?;
                Some(d.into())
            };
            Ok(RenderOutcome::Returned {
                result: result_value(&v["result"])?,
                artifact_manifest_digest: digest,
            })
        }
        _ => Err(ProtocolError),
    }
}
impl<'de> Deserialize<'de> for RenderOutcome {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        outcome_value(&Value::deserialize(d)?)
            .map_err(|_| de::Error::custom("invalid render outcome"))
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderOutcomeFrame {
    pub schema: String,
    pub request_id: String,
    pub argument_digest: String,
    pub project_service_key: String,
    pub source_generation: String,
    pub execution_image_digest: String,
    pub outcome: RenderOutcome,
}
impl RenderOutcomeFrame {
    pub fn for_request(request: &RenderRequest, outcome: RenderOutcome) -> Result<Self> {
        request.validate()?;
        let frame = Self {
            schema: OUTCOME.into(),
            request_id: request.request_id.clone(),
            argument_digest: request.argument_digest.clone(),
            project_service_key: request.project_service_key.clone(),
            source_generation: request.source_generation.clone(),
            execution_image_digest: request.execution_image.image_digest.clone(),
            outcome,
        };
        frame.validate(request)?;
        Ok(frame)
    }
    pub fn validate(&self, request: &RenderRequest) -> Result<()> {
        request.validate()?;
        require(
            self.schema == OUTCOME
                && self.request_id == request.request_id
                && self.argument_digest == request.argument_digest
                && self.project_service_key == request.project_service_key
                && self.source_generation == request.source_generation
                && self.execution_image_digest == request.execution_image.image_digest,
        )?;
        // Public typed constructors also undergo semantic checks (e.g. both code/signal set).
        outcome_value(&serde_json::to_value(&self.outcome).map_err(|_| ProtocolError)?)?;
        require(json(self)?.len() <= MAX_RENDER_OUTCOME_BYTES)
    }
}
pub fn decode_render_outcome(frame: &[u8], request: &RenderRequest) -> Result<RenderOutcomeFrame> {
    let value: RenderOutcomeFrame = decode(frame, MAX_RENDER_OUTCOME_BYTES)?;
    value.validate(request)?;
    Ok(value)
}
pub fn encode_render_outcome(
    frame: &RenderOutcomeFrame,
    request: &RenderRequest,
) -> Result<Vec<u8>> {
    frame.validate(request)?;
    encode(frame, MAX_RENDER_OUTCOME_BYTES)
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceBridgeReply {
    pub schema: String,
    pub grant_id: String,
    pub grant_digest: String,
    pub outcome: RenderOutcomeFrame,
}
pub fn decode_service_bridge_reply(
    frame: &[u8],
    grant: &ServiceRenderGrant,
    request: &RenderRequest,
) -> Result<ServiceBridgeReply> {
    grant.validate_bound_request(request)?;
    let value: ServiceBridgeReply = decode(frame, MAX_SERVICE_BRIDGE_REPLY_BYTES)?;
    envelope(
        &value.schema,
        BRIDGE_REPLY,
        &value.grant_id,
        &value.grant_digest,
        grant,
    )?;
    value.outcome.validate(request)?;
    Ok(value)
}
pub fn encode_service_bridge_reply(
    grant: &ServiceRenderGrant,
    request: &RenderRequest,
    outcome: &RenderOutcomeFrame,
) -> Result<Vec<u8>> {
    grant.validate_bound_request(request)?;
    outcome.validate(request)?;
    encode(
        &ServiceBridgeReply {
            schema: BRIDGE_REPLY.into(),
            grant_id: grant.grant_id.clone(),
            grant_digest: service_grant_digest(grant)?,
            outcome: outcome.clone(),
        },
        MAX_SERVICE_BRIDGE_REPLY_BYTES,
    )
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FailureReason {
    TransportUnavailable,
    TransportError,
    TransportClosed,
    InvalidReply,
    ReplyTooLarge,
    Timeout,
    Interrupted,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientObservation {
    OwnerOutcome { frame: RenderOutcomeFrame },
    NotAttempted { reason: FailureReason },
    MayHaveBeenDelivered { reason: FailureReason },
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceClientReceipt {
    pub grant_id: String,
    pub grant_digest: String,
    pub outcome: ClientObservation,
}
/// Receipt data only. In particular may-have-been-delivered/unknown never proves
/// nonexecution or supplies authority to retry an effect.
pub fn decode_service_client_receipt(
    frame: &[u8],
    grant: &ServiceRenderGrant,
    request: &RenderRequest,
) -> Result<ServiceClientReceipt> {
    grant.validate_bound_request(request)?;
    let value: Value = decode(frame, MAX_SERVICE_RECEIPT_BYTES)?;
    exact(&value, &["schema", "grantId", "grantDigest", "outcome"])?;
    envelope(
        string(&value["schema"])?,
        RECEIPT,
        string(&value["grantId"])?,
        string(&value["grantDigest"])?,
        grant,
    )?;
    let o = &value["outcome"];
    let outcome = if o["kind"] == "owner_outcome" {
        exact(o, &["kind", "frame"])?;
        let frame: RenderOutcomeFrame =
            serde_json::from_value(o["frame"].clone()).map_err(|_| ProtocolError)?;
        frame.validate(request)?;
        ClientObservation::OwnerOutcome { frame }
    } else {
        exact(
            o,
            &[
                "kind",
                "requestId",
                "argumentDigest",
                "projectServiceKey",
                "sourceGeneration",
                "executionImageDigest",
                "delivery",
                "execution",
                "reason",
            ],
        )?;
        require(
            o["kind"] == "client_observation"
                && o["requestId"] == request.request_id
                && o["argumentDigest"] == request.argument_digest
                && o["projectServiceKey"] == request.project_service_key
                && o["sourceGeneration"] == request.source_generation
                && o["executionImageDigest"] == request.execution_image.image_digest,
        )?;
        let reason = serde_json::from_value(o["reason"].clone()).map_err(|_| ProtocolError)?;
        if o["delivery"] == "not_attempted" && o["execution"] == "known_not_executed" {
            ClientObservation::NotAttempted { reason }
        } else if o["delivery"] == "may_have_been_delivered" && o["execution"] == "unknown" {
            ClientObservation::MayHaveBeenDelivered { reason }
        } else {
            return Err(ProtocolError);
        }
    };
    Ok(ServiceClientReceipt {
        grant_id: grant.grant_id.clone(),
        grant_digest: service_grant_digest(grant)?,
        outcome,
    })
}
pub fn encode_service_client_receipt(
    receipt: &ServiceClientReceipt,
    grant: &ServiceRenderGrant,
    request: &RenderRequest,
) -> Result<Vec<u8>> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Frame<'a> {
        schema: &'static str,
        grant_id: &'a str,
        grant_digest: &'a str,
        outcome: Observation<'a>,
    }
    #[derive(Serialize)]
    #[serde(untagged)]
    enum Observation<'a> {
        Owner {
            kind: &'static str,
            frame: &'a RenderOutcomeFrame,
        },
        Local {
            kind: &'static str,
            #[serde(rename = "requestId")]
            request_id: &'a str,
            #[serde(rename = "argumentDigest")]
            argument_digest: &'a str,
            #[serde(rename = "projectServiceKey")]
            project_service_key: &'a str,
            #[serde(rename = "sourceGeneration")]
            source_generation: &'a str,
            #[serde(rename = "executionImageDigest")]
            execution_image_digest: &'a str,
            delivery: &'static str,
            execution: &'static str,
            reason: FailureReason,
        },
    }
    let outcome = match &receipt.outcome {
        ClientObservation::OwnerOutcome { frame } => Observation::Owner {
            kind: "owner_outcome",
            frame,
        },
        ClientObservation::NotAttempted { reason }
        | ClientObservation::MayHaveBeenDelivered { reason } => {
            let attempted = matches!(
                receipt.outcome,
                ClientObservation::MayHaveBeenDelivered { .. }
            );
            Observation::Local {
                kind: "client_observation",
                request_id: &request.request_id,
                argument_digest: &request.argument_digest,
                project_service_key: &request.project_service_key,
                source_generation: &request.source_generation,
                execution_image_digest: &request.execution_image.image_digest,
                delivery: if attempted {
                    "may_have_been_delivered"
                } else {
                    "not_attempted"
                },
                execution: if attempted {
                    "unknown"
                } else {
                    "known_not_executed"
                },
                reason: *reason,
            }
        }
    };
    let frame = encode(
        &Frame {
            schema: RECEIPT,
            grant_id: &receipt.grant_id,
            grant_digest: &receipt.grant_digest,
            outcome,
        },
        MAX_SERVICE_RECEIPT_BYTES,
    )?;
    decode_service_client_receipt(&frame, grant, request)?;
    Ok(frame)
}

#[cfg(test)]
#[path = "service_protocol/tests.rs"]
mod tests;
