use crate::cli::Config;
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
    caller: Caller,
    deadline_epoch_ms: u64,
    payload: Box<RawValue>,
    input_json: String,
}

impl Request {
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
}

pub enum EngineFrame {
    Ready(Ready),
    Proposal { token: String, result: NativeResult },
    Failure(String),
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
    #[serde(rename = "caws.runtime.proposal.v1")]
    Proposal {
        id: String,
        #[serde(rename = "runtimeDigest")]
        runtime_digest: String,
        token: String,
        response: Response,
    },
    #[serde(rename = "caws.runtime.failure.v1")]
    Failure {
        id: String,
        #[serde(rename = "runtimeDigest")]
        runtime_digest: String,
        message: String,
    },
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
    let frame: WireFrame =
        serde_json::from_slice(bytes).map_err(|e| format!("invalid engine frame: {e}"))?;
    match frame {
        WireFrame::Ready {
            id,
            runtime_digest,
            active,
            budget_home,
            project_digest,
            session_id,
        } => {
            identity(&id, &runtime_digest, request)?;
            let home = std::path::PathBuf::from(&budget_home);
            if !home.is_absolute() || budget_home.contains('\0') || budget_home.len() > 4096 {
                return Err("invalid ready budget home".into());
            }
            if active != project_digest.is_some()
                || project_digest
                    .as_ref()
                    .is_some_and(|d| !crate::cli::valid_digest(d))
            {
                return Err("invalid ready project identity".into());
            }
            if session_id
                .as_ref()
                .is_some_and(|s| s.len() > 128 || s.contains('\0'))
            {
                return Err("invalid ready session identity".into());
            }
            Ok(EngineFrame::Ready(Ready {
                active,
                budget_home: home,
                project_digest,
                session_id,
            }))
        }
        WireFrame::Proposal {
            id,
            runtime_digest,
            token,
            response,
        } => {
            identity(&id, &runtime_digest, request)?;
            if token.is_empty()
                || token.len() > 128
                || !token
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
            {
                return Err("invalid proposal token".into());
            }
            Ok(EngineFrame::Proposal {
                token,
                result: response_result(response, request)?,
            })
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

pub fn dispatch(request: &Request) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(&serde_json::json!({
        "schema":"caws.runtime.dispatch.v1","id":request.id,"runtimeDigest":request.runtime_digest
    }))
    .expect("serializing string-only dispatch frame");
    bytes.push(b'\n');
    bytes
}

pub fn handoff(request: &Request, token: &str, success: bool) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(&serde_json::json!({
        "schema":"caws.runtime.handoff.v1","id":request.id,"runtimeDigest":request.runtime_digest,
        "token":token,"success":success
    }))
    .expect("serializing string-only handoff frame");
    bytes.push(b'\n');
    bytes
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
}
