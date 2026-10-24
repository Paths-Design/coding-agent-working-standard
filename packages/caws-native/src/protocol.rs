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

pub const SELECTION_OBSERVATION_CAPABILITY: &str = "caws.runtime.selection-observation.v1";
pub const SELECTION_OBSERVATION_REQUEST: &str = "caws.runtime.selection-observation.request.v1";
pub const SELECTION_OBSERVATION_RESULT: &str = "caws.runtime.selection-observation.result.v1";
pub const SELECTION_OBSERVATION_CHUNK: &str = "caws.runtime.selection-observation.chunk.v1";
pub const MAX_SELECTION_REQUEST: usize = 16 * 1024 + 2048;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectionObservationLimits {
    maximum_observations: usize,
    maximum_bytes: usize,
    maximum_path_bytes: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectionObservationCapability {
    schema: &'static str,
    snapshot_id: String,
    limits: SelectionObservationLimits,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SelectionObservationFrame {
    schema: String,
    id: String,
    runtime_digest: String,
    snapshot_id: String,
    sequence: usize,
    operation: crate::selection_observation::Operation,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    selection_observation: Option<SelectionObservationCapability>,
    #[cfg(target_os = "macos")]
    session_end_prefix: &'static str,
    #[cfg(target_os = "macos")]
    session_publication: &'static str,
    #[cfg(target_os = "macos")]
    context_git: &'static str,
    #[cfg(feature = "sqlite-store")]
    session_store: &'static str,
    caller: Caller,
    deadline_epoch_ms: u64,
    payload: Box<RawValue>,
    input_json: String,
}

impl Request {
    /// This advertises observation transport only. The native caller supplies a
    /// successfully constructed owner; no engine field grants this lifecycle.
    pub fn advertise_selection_observation(
        &mut self,
        snapshot_id: &str,
        limits: crate::selection_observation::Limits,
    ) {
        self.selection_observation = Some(SelectionObservationCapability {
            schema: SELECTION_OBSERVATION_CAPABILITY,
            snapshot_id: snapshot_id.into(),
            limits: SelectionObservationLimits {
                maximum_observations: limits.maximum_observations,
                maximum_bytes: limits.maximum_bytes,
                maximum_path_bytes: limits.maximum_path_bytes,
            },
        });
    }
    pub fn selection_request(
        &self,
        bytes: &[u8],
    ) -> Result<crate::selection_observation::SelectionObservationRequest, String> {
        let capability = self
            .selection_observation
            .as_ref()
            .ok_or("selection observation was not advertised")?;
        if bytes.len() > MAX_SELECTION_REQUEST {
            return Err("selection request exceeds native frame bound".into());
        }
        let row: SelectionObservationFrame = serde_json::from_slice(bytes)
            .map_err(|e| format!("invalid selection observation frame: {e}"))?;
        identity(&row.id, &row.runtime_digest, self)?;
        if row.schema != SELECTION_OBSERVATION_REQUEST
            || row.snapshot_id != capability.snapshot_id
            || row.sequence == 0
            || row.sequence > capability.limits.maximum_observations
        {
            return Err("selection observation correlation mismatch".into());
        }
        Ok(crate::selection_observation::SelectionObservationRequest {
            snapshot_id: row.snapshot_id,
            sequence: row.sequence,
            operation: row.operation,
        })
    }
    pub fn selection_control_limit(&self) -> Result<usize, String> {
        let capability = self
            .selection_observation
            .as_ref()
            .ok_or("selection observation was not advertised")?;
        capability
            .limits
            .maximum_observations
            .checked_mul(MAX_SELECTION_REQUEST + 1)
            .ok_or_else(|| "selection control byte bound overflow".into())
    }
    /// Native-original root inputs only. Empty optional XDG/OpenCode values
    /// retain existing loader default semantics; malformed present roots cannot
    /// expand observation access. No engine request contributes an allowed root.
    pub fn original_selection_roots(
        &self,
        original: &caws_native::session_cache_wire::OriginalStopCapture<'_>,
    ) -> Result<Vec<std::path::PathBuf>, String> {
        use std::path::{Component, PathBuf};
        if original.id() != self.id || original.runtime_digest() != self.runtime_digest {
            return Err("original selection capture identity mismatch".into());
        }
        let environment = original.caller_environment();
        let user = environment
            .get("HOME")
            .filter(|v| !v.is_empty())
            .ok_or("original selection HOME unavailable")?;
        let machine = environment
            .get("CAWS_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(user).join(".caws"));
        let project = original.observed_project();
        let mut roots = vec![
            machine,
            project.checkout.clone(),
            project.canonical_root.clone(),
            PathBuf::from(user),
        ];
        for name in ["XDG_CONFIG_HOME", "OPENCODE_CONFIG_DIR"] {
            if let Some(value) = environment.get(name).filter(|v| !v.is_empty()) {
                roots.push(PathBuf::from(value));
            }
        }
        for root in &roots {
            let value = root
                .to_str()
                .ok_or("original selection root is not UTF-8")?;
            if !root.is_absolute()
                || value.len() > 16 * 1024
                || value.contains('\0')
                || root
                    .components()
                    .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
            {
                return Err("original selection roots must be absolute and normalized".into());
            }
        }
        roots.sort();
        roots.dedup();
        Ok(roots)
    }

    pub fn session_invocation<'a>(
        &'a self,
        ready: &'a Ready,
        dispatched: bool,
    ) -> caws_native::render_owner::SessionInvocation<'a> {
        caws_native::render_owner::SessionInvocation {
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
            caller_cwd: &self.caller.cwd,
            caller_environment: &self.caller.environment,
        }
    }
    pub fn session_prefix_owner<'a>(
        &'a self,
        ready: &'a Ready,
        dispatched: bool,
        original: &'a caws_native::agent_pid_cache::OriginalAncestry,
    ) -> Result<caws_native::session_cache_wire::PrefixOwner<'a>, String> {
        use caws_native::session_cache_wire::{
            Invocation, PREFIX_CAPABILITY, PrefixInvocation, PrefixOwner,
        };
        PrefixOwner::new(PrefixInvocation {
            invocation: Invocation {
                id: &self.id,
                runtime_digest: &self.runtime_digest,
                original_payload: &self.payload,
                surface: &self.surface,
                event: &self.event,
                configuration: &self.configuration,
                ready_active: ready.active,
                ready_project_digest: ready.project_digest.as_deref(),
                dispatched,
                advertised_capability: cfg!(target_os = "macos").then_some(PREFIX_CAPABILITY),
            },
            original_ancestry: original,
        })
        .map_err(|error| error.to_string())
    }
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
    pub fn original_stop_input(
        &self,
    ) -> caws_native::session_cache_wire::OriginalStopCaptureInput<'_> {
        caws_native::session_cache_wire::OriginalStopCaptureInput {
            id: &self.id,
            runtime_digest: &self.runtime_digest,
            surface: &self.surface,
            caller_cwd: &self.caller.cwd,
            caller_environment: &self.caller.environment,
            original_payload: &self.payload,
        }
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
            selection_observation: None,
            #[cfg(target_os = "macos")]
            session_end_prefix: caws_native::session_cache_wire::PREFIX_CAPABILITY,
            #[cfg(target_os = "macos")]
            session_publication: "caws.runtime.session-publication.v1",
            #[cfg(target_os = "macos")]
            context_git: caws_native::context_git::CAPABILITY,
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
    ContextGitRequest(Vec<u8>),
    SelectionObservationRequest(Vec<u8>),
    SessionCacheRequest(Vec<u8>),
    SessionEndPrefixRequest(Vec<u8>),
    SessionSealRequest(Vec<u8>),
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
    if header.schema == SELECTION_OBSERVATION_REQUEST {
        // Classification grants no read or extra control credit. The advertised
        // native owner validates identity, operation and sequence before either.
        if bytes.len() > MAX_SELECTION_REQUEST {
            return Err("selection request exceeds native frame bound".into());
        }
        return Ok(EngineFrame::SelectionObservationRequest(bytes.to_vec()));
    }
    if header.schema == caws_native::session_cache_wire::PREFIX_REQUEST_SCHEMA {
        if bytes.len() > caws_native::session_cache_wire::MAX_REQUEST_BYTES {
            return Err("session prefix request exceeds frame budget".into());
        }
        return Ok(EngineFrame::SessionEndPrefixRequest(bytes.to_vec()));
    }
    if header.schema == "caws.runtime.session-seal.request.v1" {
        if bytes.len() > 32_768 {
            return Err("session seal request exceeds frame budget".into());
        }
        return Ok(EngineFrame::SessionSealRequest(bytes.to_vec()));
    }
    if header.schema == "caws.runtime.context-git.request.v1" {
        if bytes.len() > caws_native::context_git::MAX_REQUEST {
            return Err("context Git request exceeds frame budget".into());
        }
        // Classification does not grant spawning. The pre-Ready owner checks
        // every field, sequence and invocation identity before creating custody.
        return Ok(EngineFrame::ContextGitRequest(bytes.to_vec()));
    }
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
            selection_observation: None,
            #[cfg(target_os = "macos")]
            session_end_prefix: caws_native::session_cache_wire::PREFIX_CAPABILITY,
            #[cfg(target_os = "macos")]
            session_publication: "caws.runtime.session-publication.v1",
            #[cfg(target_os = "macos")]
            context_git: caws_native::context_git::CAPABILITY,
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
    fn selection_transport_is_optional_and_exactly_correlated() {
        let mut request = fixture_request();
        assert!(
            serde_json::to_value(&request)
                .unwrap()
                .get("selectionObservation")
                .is_none()
        );
        let frame = serde_json::json!({"schema":SELECTION_OBSERVATION_REQUEST,"id":request.id,
            "runtimeDigest":request.runtime_digest,"snapshotId":"native-snapshot","sequence":1,
            "operation":{"kind":"read","path":"/original/config.json"}});
        let bytes = serde_json::to_vec(&frame).unwrap();
        assert!(
            request
                .selection_request(&bytes)
                .unwrap_err()
                .contains("not advertised")
        );
        request.advertise_selection_observation(
            "native-snapshot",
            crate::selection_observation::Limits::default(),
        );
        let captured = request.selection_request(&bytes).unwrap();
        assert_eq!(captured.snapshot_id, "native-snapshot");
        assert_eq!(captured.sequence, 1);
        assert_eq!(captured.operation.path, "/original/config.json");
        match validate_frame(&bytes, &request).unwrap() {
            EngineFrame::SelectionObservationRequest(retained) => assert_eq!(retained, bytes),
            _ => panic!("selection frame not retained"),
        }
        for (name, value) in [
            ("id", serde_json::json!("other")),
            ("runtimeDigest", serde_json::json!("b".repeat(64))),
            ("snapshotId", serde_json::json!("engine-selected")),
            ("sequence", serde_json::json!(0)),
            ("unknown", serde_json::json!(true)),
        ] {
            let mut wrong = frame.clone();
            wrong[name] = value;
            assert!(
                request
                    .selection_request(&serde_json::to_vec(&wrong).unwrap())
                    .is_err(),
                "{name}"
            );
        }
    }
    #[test]
    fn prefix_and_seal_classification_preserves_bytes_without_granting_admission() {
        let request = fixture_request();
        for (schema, prefix) in [
            (caws_native::session_cache_wire::PREFIX_REQUEST_SCHEMA, true),
            ("caws.runtime.session-seal.request.v1", false),
        ] {
            // Deliberately missing identity and operation fields: only the
            // typed owner may admit these bytes after the dispatch phase.
            let bytes = format!("{{\"schema\":\"{schema}\",\"unknown\":true}} ").into_bytes();
            match validate_frame(&bytes, &request).unwrap() {
                EngineFrame::SessionEndPrefixRequest(retained) if prefix => {
                    assert_eq!(retained, bytes)
                }
                EngineFrame::SessionSealRequest(retained) if !prefix => assert_eq!(retained, bytes),
                _ => panic!("operation lost its typed owner"),
            }
            let oversized = serde_json::to_vec(&serde_json::json!({
                "schema": schema, "padding": "x".repeat(32_768)
            }))
            .unwrap();
            assert!(validate_frame(&oversized, &request).is_err());
            let duplicate =
                format!("{{\"schema\":\"{schema}\",\"schema\":\"caws.runtime.ready.v1\"}}");
            assert!(validate_frame(duplicate.as_bytes(), &request).is_err());
        }
    }
    #[test]
    fn context_git_capability_and_typed_owner_boundary_are_explicit() {
        let request = fixture_request();
        let encoded: serde_json::Value =
            serde_json::from_slice(&request.encode_frame().unwrap()).unwrap();
        #[cfg(target_os = "macos")]
        assert_eq!(encoded["contextGit"], caws_native::context_git::CAPABILITY);
        #[cfg(not(target_os = "macos"))]
        assert!(!encoded.as_object().unwrap().contains_key("contextGit"));
        let bytes = br#"{"schema":"caws.runtime.context-git.request.v1","id":"foreign","ordinal":2,"arbitrary":true}"#;
        match validate_frame(bytes, &request).unwrap() {
            EngineFrame::ContextGitRequest(retained) => assert_eq!(retained, bytes),
            _ => panic!("context request did not reach its typed owner"),
        }
        let oversized = serde_json::to_vec(&serde_json::json!({"schema":"caws.runtime.context-git.request.v1", "padding":"x".repeat(caws_native::context_git::MAX_REQUEST)})).unwrap();
        assert_eq!(
            validate_frame(&oversized, &request).err(),
            Some("context Git request exceeds frame budget".into())
        );
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

/// Nonspawning replay of the two actual original custodian query observations.
/// This is context data for the maintained engine, never selection authority.
/// No externally decoded result or caller-provided observation constructs it.
pub struct CapturedContext {
    id: String,
    runtime_digest: String,
    executable: std::path::PathBuf,
    cwds: [std::path::PathBuf; 2],
    bytes: [caws_native::invocation_project::QueryBytes; 2],
    cleanup: [caws_native::invocation_project::QueryCleanup; 2],
    token: Option<String>,
    next: usize,
    ready: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapturedContextRequest {
    schema: String,
    id: String,
    runtime_digest: String,
    token: String,
    ordinal: u8,
    operation: caws_native::context_git::Operation,
    executable: std::path::PathBuf,
    cwd: std::path::PathBuf,
}
impl CapturedContext {
    pub fn new(original: &caws_native::session_cache_wire::OriginalStopCapture<'_>) -> Self {
        let project = original.observed_project();
        Self {
            id: original.id().into(),
            runtime_digest: original.runtime_digest().into(),
            executable: project.executable.path.clone(),
            cwds: original.query_cwds().clone(),
            bytes: project.query_bytes.clone(),
            cleanup: project.queries.clone(),
            token: None,
            next: 0,
            ready: false,
        }
    }
    pub fn mark_ready(&mut self) {
        self.ready = true;
    }
    pub fn response(&mut self, frame: &[u8]) -> Result<Vec<u8>, String> {
        let result = self.response_inner(frame);
        if result.is_err() {
            self.next = 2;
        }
        result
    }
    fn response_inner(&mut self, frame: &[u8]) -> Result<Vec<u8>, String> {
        if self.ready || self.next >= 2 {
            return Err("captured context replay after Ready or consumed".into());
        }
        // Consume failed attempts too: malformed context cannot reset the owner.
        let index = self.next;
        self.next += 1;
        if frame.len() > caws_native::context_git::MAX_REQUEST {
            return Err("captured context request exceeds bound".into());
        }
        let row: CapturedContextRequest =
            serde_json::from_slice(frame).map_err(|e| format!("captured context request: {e}"))?;
        let operation = if index == 0 {
            caws_native::context_git::Operation::Checkout
        } else {
            caws_native::context_git::Operation::CommonDir
        };
        if row.schema != "caws.runtime.context-git.request.v1"
            || row.id != self.id
            || row.runtime_digest != self.runtime_digest
            || !crate::cli::valid_digest(&row.token)
            || row.ordinal != index as u8 + 1
            || row.operation != operation
            || row.executable != self.executable
            || row.cwd != self.cwds[index]
            || self.token.as_ref().is_some_and(|v| v != &row.token)
        {
            // A failed first request must not leave a valid second slot.
            self.next = 2;
            return Err("captured context request differs from original query".into());
        }
        self.token.get_or_insert_with(|| row.token.clone());
        let cleanup = &self.cleanup[index];
        let exit = cleanup.reaped.ok_or("captured context lacks actual reap")?;
        if !cleanup.settled()
            || !cleanup.exit_observed
            || !exit.success
            || exit.code != Some(0)
            || exit.signal.is_some()
            || !cleanup.pipes.stdout_eof
            || !cleanup.pipes.stderr_eof
            || cleanup.ownership_retained
        {
            self.next = 2;
            return Err("captured context lacks settled actual query".into());
        }
        // CapturedProject is constructed only after original group settlement;
        // query EOF/reap and bytes below are the actual retained observations.
        let result = serde_json::json!({"schema":"caws.runtime.context-git.result.v1","id":self.id,"runtimeDigest":self.runtime_digest,"token":row.token,"ordinal":row.ordinal,"operation":row.operation,"status":"exited","exitCode":exit.code,"signal":exit.signal,"stdout":STANDARD.encode(&self.bytes[index].stdout),"stderr":STANDARD.encode(&self.bytes[index].stderr),"cleanup":{"groupSettled":true,"stdoutEof":cleanup.pipes.stdout_eof,"stderrEof":cleanup.pipes.stderr_eof,"reaped":cleanup.reaped.is_some()},"diagnostic":""});
        let mut encoded = serde_json::to_vec(&result).map_err(|e| e.to_string())?;
        if encoded.len() > caws_native::context_git::MAX_RESULT {
            self.next = 2;
            return Err("captured context result exceeds bound".into());
        }
        encoded.push(b'\n');
        Ok(encoded)
    }
}

#[cfg(test)]
mod captured_context_tests {
    use super::*;
    use caws_native::invocation_project::{
        ExitObservation, PipeObservation, QueryBytes, QueryCleanup,
    };
    fn fixture() -> CapturedContext {
        let cleanup = QueryCleanup {
            pid: Some(99),
            exit_observed: true,
            pipes: PipeObservation {
                stdout_eof: true,
                stderr_eof: true,
                ..Default::default()
            },
            reaped: Some(ExitObservation {
                success: true,
                code: Some(0),
                signal: None,
                core_dumped: false,
            }),
            ..Default::default()
        };
        // Wire-state fixture only; no fake OriginalStopCapture is constructed.
        CapturedContext {
            id: "original".into(),
            runtime_digest: "a".repeat(64),
            executable: "/chosen/git".into(),
            cwds: ["/caller/nested".into(), "/checkout-spelling".into()],
            bytes: [
                QueryBytes {
                    stdout: b"/checkout-spelling\n".to_vec(),
                    stderr: b"original warning\n".to_vec(),
                },
                QueryBytes {
                    stdout: b"/canonical/.git\n".to_vec(),
                    stderr: Vec::new(),
                },
            ],
            cleanup: [cleanup.clone(), cleanup],
            token: None,
            next: 0,
            ready: false,
        }
    }
    fn request(index: usize) -> serde_json::Value {
        serde_json::json!({"schema":"caws.runtime.context-git.request.v1","id":"original","runtimeDigest":"a".repeat(64),"token":"b".repeat(64),"ordinal":index+1,"operation":if index==0{"checkout"}else{"commonDir"},"executable":"/chosen/git","cwd":if index==0{"/caller/nested"}else{"/checkout-spelling"}})
    }
    fn encode(value: &serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(value).unwrap()
    }
    #[test]
    fn cached_frames_preserve_actual_bytes_cwd_order_and_terminal_consumption() {
        let mut replay = fixture();
        for index in 0..2 {
            let response = replay.response(&encode(&request(index))).unwrap();
            assert_eq!(response.last(), Some(&b'\n'));
            let response: serde_json::Value = serde_json::from_slice(&response).unwrap();
            assert_eq!(response["ordinal"], index + 1);
            assert_eq!(response["exitCode"], 0);
            assert!(response["signal"].is_null());
            assert_eq!(
                STANDARD
                    .decode(response["stdout"].as_str().unwrap())
                    .unwrap(),
                replay.bytes[index].stdout
            );
            assert_eq!(
                STANDARD
                    .decode(response["stderr"].as_str().unwrap())
                    .unwrap(),
                replay.bytes[index].stderr
            );
            for key in ["groupSettled", "stdoutEof", "stderrEof", "reaped"] {
                assert_eq!(response["cleanup"][key], true)
            }
        }
        assert!(replay.response(&encode(&request(0))).is_err());
    }
    #[test]
    fn cached_context_rejects_identity_path_order_unknown_fields_and_consumes_failure() {
        for (key, value) in [
            ("id", serde_json::json!("other")),
            ("runtimeDigest", serde_json::json!("c".repeat(64))),
            ("token", serde_json::json!("invalid")),
            ("cwd", serde_json::json!("/unrelated")),
            ("executable", serde_json::json!("/other/git")),
            ("ordinal", serde_json::json!(2)),
            ("operation", serde_json::json!("commonDir")),
            ("extra", serde_json::json!(true)),
        ] {
            let mut replay = fixture();
            let mut frame = request(0);
            frame[key] = value;
            assert!(replay.response(&encode(&frame)).is_err(), "accepted {key}");
            assert!(
                replay.response(&encode(&request(1))).is_err(),
                "failure did not consume {key}"
            );
        }
        let mut replay = fixture();
        assert!(replay.response(b"{").is_err());
        assert!(replay.response(&encode(&request(1))).is_err());
        let mut replay = fixture();
        replay.response(&encode(&request(0))).unwrap();
        let mut second = request(1);
        second["token"] = serde_json::json!("c".repeat(64));
        assert!(replay.response(&encode(&second)).is_err());
        let mut replay = fixture();
        replay.mark_ready();
        assert!(replay.response(&encode(&request(0))).is_err());
    }
    #[test]
    fn cached_context_cannot_fabricate_eof_exit_or_reap() {
        for defect in [
            "stdout-eof",
            "stderr-eof",
            "reap",
            "retained",
            "exit",
            "exit-observed",
        ] {
            let mut replay = fixture();
            let q = &mut replay.cleanup[0];
            match defect {
                "stdout-eof" => q.pipes.stdout_eof = false,
                "stderr-eof" => q.pipes.stderr_eof = false,
                "reap" => q.reaped = None,
                "retained" => q.ownership_retained = true,
                "exit" => q.reaped.as_mut().unwrap().success = false,
                "exit-observed" => q.exit_observed = false,
                _ => unreachable!(),
            }
            assert!(
                replay.response(&encode(&request(0))).is_err(),
                "accepted {defect}"
            );
            assert!(replay.response(&encode(&request(1))).is_err());
        }
    }
}
