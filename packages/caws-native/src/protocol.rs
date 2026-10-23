use crate::cli::Config;
use crate::process_effect::{ContainmentIntent, ContainmentReceipt};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::collections::BTreeMap;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Caller {
    cwd: String,
    environment: BTreeMap<String, String>,
    process_id: u32,
}

impl Caller {
    fn capture() -> Result<Self, String> {
        let cwd = std::env::current_dir()
            .map_err(|_| "caller cwd is unavailable")?
            .into_os_string()
            .into_string()
            .map_err(|_| "caller cwd is not valid UTF-8")?;
        let mut environment = BTreeMap::new();
        for (name, value) in std::env::vars_os() {
            let name = name
                .into_string()
                .map_err(|_| "caller environment name is not valid UTF-8")?;
            let value = value
                .into_string()
                .map_err(|_| "caller environment value is not valid UTF-8")?;
            if name.is_empty() || name.contains('=') {
                return Err("caller environment name is invalid".into());
            }
            environment.insert(name, value);
        }
        Ok(Self {
            cwd,
            environment,
            process_id: std::process::id(),
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    schema: &'static str,
    pub id: String,
    pub runtime_digest: String,
    surface: String,
    event: String,
    configuration: String,
    session_cache: &'static str,
    #[cfg(feature = "sqlite-store")]
    session_store: &'static str,
    caller: Caller,
    deadline_epoch_ms: u64,
    payload: Box<RawValue>,
    input_json: String,
}

impl Request {
    /// RawValue retains payload formatting. Compact only JSON whitespace outside
    /// strings so a payload newline cannot terminate the transport frame early.
    /// Keep input_json's decoded bytes and every raw number token unchanged.
    pub fn encode_frame(&self) -> serde_json::Result<Vec<u8>> {
        let mut bytes = serde_json::to_vec(self)?;
        let mut quoted = false;
        let mut escaped = false;
        bytes.retain(|byte| {
            if quoted {
                if escaped {
                    escaped = false;
                } else if *byte == b'\\' {
                    escaped = true;
                } else if *byte == b'"' {
                    quoted = false;
                }
                true
            } else if *byte == b'"' {
                quoted = true;
                true
            } else {
                !matches!(*byte, b' ' | b'\t' | b'\r' | b'\n')
            }
        });
        bytes.push(b'\n');
        Ok(bytes)
    }

    #[cfg(feature = "sqlite-store")]
    pub fn transcript_store_invocation<'a>(
        &'a self,
        ready: &'a Ready,
        dispatched: bool,
    ) -> caws_native::transcript_store_wire::Invocation<'a> {
        caws_native::transcript_store_wire::Invocation {
            id: &self.id,
            runtime_digest: &self.runtime_digest,
            original_payload: &self.payload,
            surface: &self.surface,
            event: &self.event,
            configuration: &self.configuration,
            ready_active: ready.active,
            ready_project_digest: ready.project_digest.as_deref(),
            ready_session_id: ready.session_id.as_deref(),
            dispatched,
            database: self
                .caller
                .environment
                .get("CAWS_TRANSCRIPT_DATABASE")
                .map(String::as_str),
            caller_cwd: &self.caller.cwd,
            caller_environment: &self.caller.environment,
        }
    }
    pub fn session_cache_owner<'a>(
        &'a self,
        ready: &'a Ready,
        dispatched: bool,
    ) -> Result<caws_native::session_cache_wire::Owner<'a>, String> {
        use caws_native::session_cache_wire::{Invocation, Owner};
        Owner::new(Invocation {
            id: &self.id,
            runtime_digest: &self.runtime_digest,
            original_payload: &self.payload,
            surface: &self.surface,
            event: &self.event,
            configuration: &self.configuration,
            ready_active: ready.active,
            ready_project_digest: ready.project_digest.as_deref(),
            dispatched,
            advertised_capability: Some(self.session_cache),
        })
        .map_err(|error| error.to_string())
    }
    pub fn caller_environment(&self) -> &BTreeMap<String, String> {
        &self.caller.environment
    }
    pub fn caller_cwd(&self) -> &str {
        &self.caller.cwd
    }
    pub fn new(
        config: &Config,
        payload: Box<RawValue>,
        input_json: String,
        expires: Instant,
    ) -> Result<Self, String> {
        let since_epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "clock before epoch")?;
        let remaining = expires
            .checked_duration_since(Instant::now())
            .ok_or("request deadline expired")?;
        let deadline = since_epoch.as_millis() + remaining.as_millis();
        if deadline > 9_007_199_254_740_991 {
            return Err("deadline exceeds JavaScript safe integer".into());
        }
        Ok(Self {
            schema: "caws.runtime.request.v1",
            id: format!("{}-{}", std::process::id(), since_epoch.as_nanos()),
            runtime_digest: config.digest.clone(),
            surface: config.surface.clone(),
            event: config.event.clone(),
            configuration: config.configuration.clone(),
            session_cache: caws_native::session_cache_wire::CAPABILITY,
            #[cfg(feature = "sqlite-store")]
            session_store: caws_native::transcript_store_wire::CAPABILITY,
            caller: Caller::capture()?,
            deadline_epoch_ms: deadline as u64,
            payload,
            input_json,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Response {
    schema: String,
    id: String,
    runtime_digest: String,
    result: EncodedNativeResult,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EncodedNativeResult {
    exit_code: u8,
    stdout_base64: String,
    stderr_base64: String,
}

pub struct NativeResult {
    pub exit_code: u8,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

fn decode_native_bytes(encoded: &str) -> Result<Vec<u8>, String> {
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|e| format!("invalid native byte encoding: {e}"))?;
    if STANDARD.encode(&bytes) != encoded {
        return Err("noncanonical native byte encoding".into());
    }
    Ok(bytes)
}

fn response_result(response: Response, request: &Request) -> Result<NativeResult, String> {
    if response.schema != "caws.runtime.response.v1"
        || response.id != request.id
        || response.runtime_digest != request.runtime_digest
    {
        return Err("engine response identity mismatch".into());
    }
    Ok(NativeResult {
        exit_code: response.result.exit_code,
        stdout: decode_native_bytes(&response.result.stdout_base64)?,
        stderr: decode_native_bytes(&response.result.stderr_base64)?,
    })
}

pub struct Ready {
    pub active: bool,
    pub budget_home: std::path::PathBuf,
    pub project_digest: Option<String>,
    pub session_id: Option<String>,
    pub service_offer: Option<Box<caws_native::render_owner::Offer>>,
}

pub enum EngineFrame {
    Ready(Ready),
    SessionCacheRequest(Vec<u8>),
    #[cfg(feature = "sqlite-store")]
    TranscriptStoreRequest(Vec<u8>),
    Proposal {
        token: String,
        result: NativeResult,
        containment: ContainmentProposal,
    },
    Failure(String),
}

/// Decode optional effects independently: malformed intent never erases an
/// otherwise known protective native result, and can never request a signal.
pub enum ContainmentProposal {
    None,
    Intent(ContainmentIntent),
    Invalid(String),
}
fn containment_proposal(raw: &RawValue) -> ContainmentProposal {
    if raw.get() == "null" {
        return ContainmentProposal::None;
    }
    match serde_json::from_str::<ContainmentIntent>(raw.get()) {
        Ok(intent) => match intent.validate() {
            Ok(()) => ContainmentProposal::Intent(intent),
            Err(error) => ContainmentProposal::Invalid(error),
        },
        Err(_) => ContainmentProposal::Invalid("malformed containment intent".into()),
    }
}

#[derive(Deserialize)]
#[serde(tag = "schema", deny_unknown_fields)]
enum WireFrame {
    #[serde(rename = "caws.runtime.ready.v1")]
    Ready {
        id: String,
        #[serde(rename = "runtimeDigest")]
        runtime_digest: String,
        active: bool,
        #[serde(rename = "budgetHome")]
        budget_home: String,
        #[serde(rename = "projectDigest", deserialize_with = "required_nullable")]
        project_digest: Option<String>,
        #[serde(rename = "sessionId", deserialize_with = "required_nullable")]
        session_id: Option<String>,
    },
    #[serde(rename = "caws.runtime.ready.v2")]
    ServiceReady {
        id: String,
        #[serde(rename = "runtimeDigest")]
        runtime_digest: String,
        active: bool,
        #[serde(rename = "budgetHome")]
        budget_home: String,
        #[serde(rename = "projectDigest", deserialize_with = "required_nullable")]
        project_digest: Option<String>,
        #[serde(rename = "sessionId", deserialize_with = "required_nullable")]
        session_id: Option<String>,
        #[serde(rename = "serviceOffer")]
        service_offer: Box<caws_native::render_owner::Offer>,
    },
    #[serde(rename = "caws.runtime.failure.v1")]
    Failure {
        id: String,
        #[serde(rename = "runtimeDigest")]
        runtime_digest: String,
        message: String,
    },
}

// Internally tagged enums buffer their content before decoding variants and
// cannot retain RawValue. Decode this frame directly from the original bytes
// so numeric spelling, duplicates and the independent effect subtree survive.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProposalWire {
    schema: String,
    id: String,
    runtime_digest: String,
    token: String,
    response: Response,
    containment: Box<RawValue>,
}

fn required_nullable<'de, D: serde::Deserializer<'de>>(
    value: D,
) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(value)
}

fn identity(id: &str, digest: &str, request: &Request) -> Result<(), String> {
    if id != request.id || digest != request.runtime_digest {
        return Err("engine frame identity mismatch".into());
    }
    Ok(())
}

pub fn validate_frame(bytes: &[u8], request: &Request) -> Result<EngineFrame, String> {
    #[derive(Deserialize)]
    struct Discriminator {
        schema: String,
    }
    let header: Discriminator =
        serde_json::from_slice(bytes).map_err(|e| format!("invalid engine frame: {e}"))?;
    #[cfg(feature = "sqlite-store")]
    if header.schema == caws_native::transcript_store_wire::REQUEST_SCHEMA {
        // Classification is not admission. The single-use store owner must
        // retain every recognized refusal, including its byte bound, so an
        // unbound failure cannot borrow Ready's project budget namespace.
        return Ok(EngineFrame::TranscriptStoreRequest(bytes.to_vec()));
    }
    if header.schema == caws_native::session_cache_wire::REQUEST_SCHEMA {
        if bytes.len() > caws_native::session_cache_wire::MAX_REQUEST_BYTES {
            return Err("session cache request exceeds frame budget".into());
        }
        // Phase and all fields are validated by the single-use native owner.
        return Ok(EngineFrame::SessionCacheRequest(bytes.to_vec()));
    }
    if header.schema == "caws.runtime.proposal.v2" {
        let proposal: ProposalWire =
            serde_json::from_slice(bytes).map_err(|e| format!("invalid engine frame: {e}"))?;
        identity(&proposal.id, &proposal.runtime_digest, request)?;
        if proposal.schema != header.schema
            || proposal.token.is_empty()
            || proposal.token.len() > 128
            || !proposal
                .token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        {
            return Err("invalid proposal token".into());
        }
        return Ok(EngineFrame::Proposal {
            token: proposal.token,
            result: response_result(proposal.response, request)?,
            containment: containment_proposal(&proposal.containment),
        });
    }
    let frame: WireFrame =
        serde_json::from_slice(bytes).map_err(|e| format!("invalid engine frame: {e}"))?;
    match frame {
        WireFrame::ServiceReady {
            id,
            runtime_digest,
            active,
            budget_home,
            project_digest,
            session_id,
            service_offer,
        } => {
            identity(&id, &runtime_digest, request)?;
            if !active
                || request.surface != "codex"
                || request.event != "stop"
                || request.configuration != "system"
            {
                return Err("service ready outside active system Codex Stop".into());
            }
            validate_ready(active, &budget_home, &project_digest, &session_id)?;
            Ok(EngineFrame::Ready(Ready {
                active,
                budget_home: budget_home.into(),
                project_digest,
                session_id,
                service_offer: Some(service_offer),
            }))
        }
        WireFrame::Ready {
            id,
            runtime_digest,
            active,
            budget_home,
            project_digest,
            session_id,
        } => {
            identity(&id, &runtime_digest, request)?;
            validate_ready(active, &budget_home, &project_digest, &session_id)?;
            Ok(EngineFrame::Ready(Ready {
                active,
                budget_home: budget_home.into(),
                project_digest,
                session_id,
                service_offer: None,
            }))
        }
        WireFrame::Failure {
            id,
            runtime_digest,
            message,
        } => {
            identity(&id, &runtime_digest, request)?;
            if message.is_empty() || message.len() > 4096 || message.contains('\0') {
                return Err("invalid engine failure diagnostic".into());
            }
            Ok(EngineFrame::Failure(message))
        }
    }
}

fn validate_ready(
    active: bool,
    home: &str,
    project: &Option<String>,
    session: &Option<String>,
) -> Result<(), String> {
    if !std::path::Path::new(home).is_absolute() || home.contains('\0') || home.len() > 4096 {
        return Err("invalid ready budget home".into());
    }
    if active != project.is_some()
        || project
            .as_ref()
            .is_some_and(|d| !crate::cli::valid_digest(d))
    {
        return Err("invalid ready project identity".into());
    }
    if session
        .as_ref()
        .is_some_and(|s| s.len() > 128 || s.contains('\0'))
    {
        return Err("invalid ready session identity".into());
    }
    Ok(())
}

pub fn dispatch(request: &Request) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(&serde_json::json!({
        "schema":"caws.runtime.dispatch.v1","id":request.id,"runtimeDigest":request.runtime_digest
    }))
    .expect("serializing string-only dispatch frame");
    bytes.push(b'\n');
    bytes
}

pub fn handoff(
    request: &Request,
    token: &str,
    success: bool,
    containment: Option<&ContainmentReceipt>,
) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec(&serde_json::json!({
        "schema":"caws.runtime.handoff.v2","id":request.id,"runtimeDigest":request.runtime_digest,
        "token":token,"success":success,"containment":containment
    }))
    .expect("serializing bounded containment handoff frame");
    // The peer control decoder admits exactly this bounded control envelope.
    if bytes.len() > 64 * 1024 {
        return Err("containment handoff exceeds control envelope".into());
    }
    bytes.push(b'\n');
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_binary_channels_preserve_every_byte() {
        let bytes: Vec<u8> = (0..=255).collect();
        assert_eq!(
            decode_native_bytes(&STANDARD.encode(&bytes)).unwrap(),
            bytes
        );
        assert_eq!(decode_native_bytes("/wBh").unwrap(), [0xff, 0x00, 0x61]);
        assert!(decode_native_bytes("").unwrap().is_empty());
        let large = vec![0xff; 1_048_576];
        assert_eq!(
            decode_native_bytes(&STANDARD.encode(&large)).unwrap(),
            large
        );
    }

    #[test]
    fn malformed_and_noncanonical_binary_channels_are_rejected() {
        for value in [
            "Zg", "Zg=", "Zg===", "Zh==", "Zm9=", "Z g==", "Zg==\n", "-w==", "雪", "=AAA", "AA=A",
        ] {
            assert!(decode_native_bytes(value).is_err(), "{value:?}");
        }
    }
    fn fixture_request() -> Request {
        Request {
            schema: "caws.runtime.request.v1",
            id: "request".into(),
            runtime_digest: "a".repeat(64),
            surface: "codex".into(),
            event: "pre_tool_use".into(),
            configuration: "system".into(),
            session_cache: caws_native::session_cache_wire::CAPABILITY,
            #[cfg(feature = "sqlite-store")]
            session_store: caws_native::transcript_store_wire::CAPABILITY,
            caller: Caller {
                cwd: "/fixture".into(),
                environment: BTreeMap::new(),
                process_id: 99,
            },
            deadline_epoch_ms: 1,
            payload: RawValue::from_string("{}".into()).unwrap(),
            input_json: "{}".into(),
        }
    }
    #[test]
    fn request_frame_preserves_raw_payload_and_original_input_across_formatting() {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct RetainedRequest {
            payload: Box<RawValue>,
            input_json: String,
        }
        let cases = [
            ("{}", "{}"),
            ("{\n  \"tool\": \"Read\"\n}\n", r#"{"tool":"Read"}"#),
            (
                "{\r\n\t\"nested\": [\r\n 1, { \"value\": true }\r\n ]\r\n}\r\n",
                r#"{"nested":[1,{"value":true}]}"#,
            ),
            (
                r#"{ "quoted": " space \n \r \t \" \\ 雪 " }"#,
                r#"{"quoted":" space \n \r \t \" \\ 雪 "}"#,
            ),
            (
                "{\n \"large\": 900719925474099312345678901234567890,\n \"exponent\": 1.000e+400,\n \"negativeZero\": -0.00\n}",
                r#"{"large":900719925474099312345678901234567890,"exponent":1.000e+400,"negativeZero":-0.00}"#,
            ),
            (
                r#"{ "same": -0, "same": 2.000e-09, "slash": "\\", "after": [ 3 ] }"#,
                r#"{"same":-0,"same":2.000e-09,"slash":"\\","after":[3]}"#,
            ),
        ];
        for (input, expected_payload) in cases {
            let mut request = fixture_request();
            request.payload = RawValue::from_string(input.to_owned()).unwrap();
            request.input_json = input.to_owned();
            let frame = request.encode_frame().unwrap();
            assert_eq!(frame.iter().filter(|byte| **byte == b'\n').count(), 1);
            assert_eq!(frame.last(), Some(&b'\n'));
            assert!(!frame.contains(&b'\r'));
            let decoded: RetainedRequest = serde_json::from_slice(&frame).unwrap();
            assert_eq!(decoded.input_json.as_bytes(), input.as_bytes());
            assert_eq!(decoded.payload.get(), expected_payload);
            // The ordinary first-LF reader must receive the entire JSON envelope.
            let first = frame.split(|byte| *byte == b'\n').next().unwrap();
            let first_decoded: RetainedRequest = serde_json::from_slice(first).unwrap();
            assert_eq!(first_decoded.input_json, input);
        }
    }

    #[test]
    fn pretty_raw_payload_is_a_real_negative_control_for_uncompacted_framing() {
        let mut request = fixture_request();
        request.input_json = "{\n \"nested\": {\n \"n\": 123\n }\n}".into();
        request.payload = RawValue::from_string(request.input_json.clone()).unwrap();
        let unframed = serde_json::to_vec(&request).unwrap();
        let truncated = unframed.split(|byte| *byte == b'\n').next().unwrap();
        assert!(truncated.ends_with(b"\"payload\":{"));
        assert!(serde_json::from_slice::<Box<RawValue>>(truncated).is_err());
        let repaired = request.encode_frame().unwrap();
        assert!(serde_json::from_slice::<Box<RawValue>>(&repaired).is_ok());
    }
    #[test]
    #[cfg(feature = "sqlite-store")]
    fn oversized_store_frame_reaches_the_typed_owner_without_admission() {
        let request = fixture_request();
        let bytes = serde_json::to_vec(&serde_json::json!({
            "schema": caws_native::transcript_store_wire::REQUEST_SCHEMA,
            "padding": "x".repeat(caws_native::transcript_store_wire::MAX_REQUEST_BYTES),
        }))
        .unwrap();
        assert!(bytes.len() > caws_native::transcript_store_wire::MAX_REQUEST_BYTES);
        match validate_frame(&bytes, &request).unwrap() {
            EngineFrame::TranscriptStoreRequest(retained) => assert_eq!(retained, bytes),
            _ => panic!("recognized store refusal lost its typed owner"),
        }
    }
    #[test]
    fn v2_requires_containment_and_malformed_intent_keeps_known_native_result() {
        let request = fixture_request();
        let mut frame = serde_json::json!({"schema":"caws.runtime.proposal.v2","id":request.id,"runtimeDigest":request.runtime_digest,"token":"proposal","response":{"schema":"caws.runtime.response.v1","id":request.id,"runtimeDigest":request.runtime_digest,"result":{"exitCode":2,"stdoutBase64":STANDARD.encode(b"known refusal"),"stderrBase64":""}},"containment":null});
        let decode = |frame: &serde_json::Value| {
            validate_frame(&serde_json::to_vec(frame).unwrap(), &request)
        };
        assert!(matches!(
            decode(&frame).unwrap(),
            EngineFrame::Proposal {
                containment: ContainmentProposal::None,
                ..
            }
        ));
        frame.as_object_mut().unwrap().remove("containment");
        assert!(decode(&frame).is_err());
        frame["containment"] = serde_json::json!({"pid":1});
        match decode(&frame).unwrap() {
            EngineFrame::Proposal {
                result,
                containment: ContainmentProposal::Invalid(_),
                ..
            } => assert_eq!(result.stdout, b"known refusal"),
            _ => panic!("known result was discarded or malformed intent admitted"),
        }
        frame["schema"] = serde_json::json!("caws.runtime.proposal.v1");
        assert!(decode(&frame).is_err());
    }
    #[test]
    fn ready_v1_remains_without_service_and_v2_cannot_omit_or_null_the_offer() {
        let request = fixture_request();
        let mut frame = serde_json::json!({"schema":"caws.runtime.ready.v1","id":request.id,"runtimeDigest":request.runtime_digest,
            "active":true,"budgetHome":"/home/.caws","projectDigest":"a".repeat(64),"sessionId":"session"});
        let decode = |frame: &serde_json::Value| {
            validate_frame(&serde_json::to_vec(frame).unwrap(), &request)
        };
        match decode(&frame).unwrap() {
            EngineFrame::Ready(ready) => {
                assert!(ready.active);
                assert!(ready.service_offer.is_none());
            }
            _ => panic!("Ready v1 changed variant"),
        }
        frame["serviceOffer"] = serde_json::Value::Null;
        assert!(decode(&frame).is_err());
        frame["schema"] = serde_json::json!("caws.runtime.ready.v2");
        assert!(decode(&frame).is_err());
        frame.as_object_mut().unwrap().remove("serviceOffer");
        assert!(decode(&frame).is_err());
    }
}
