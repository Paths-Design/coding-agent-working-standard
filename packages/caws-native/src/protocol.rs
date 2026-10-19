use crate::cli::Config;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    schema: &'static str,
    pub id: String,
    pub runtime_digest: String,
    surface: String,
    event: String,
    deadline_epoch_ms: u64,
    payload: Map<String, Value>,
    input_json: String,
}

impl Request {
    pub fn new(
        config: &Config,
        payload: Map<String, Value>,
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

pub fn validate_response(bytes: &[u8], request: &Request) -> Result<NativeResult, String> {
    let response: Response =
        serde_json::from_slice(bytes).map_err(|e| format!("invalid engine response: {e}"))?;
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
