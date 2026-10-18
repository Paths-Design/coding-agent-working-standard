use crate::cli::Config;
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
    result: NativeResult,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeResult {
    pub exit_code: u8,
    pub stdout: String,
    pub stderr: String,
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
    Ok(response.result)
}
