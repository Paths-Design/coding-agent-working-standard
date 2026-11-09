//! Original producer facts only. No engine frame can supply this discriminator.
use serde::Deserialize;
use serde_json::value::RawValue;
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileOperation {
    Write,
    Edit,
}

#[derive(Debug)]
pub struct OriginalOperation {
    pub surface: &'static str,
    pub session_id: String,
    pub operation: FileOperation,
}

pub fn eligible(surface: &str, payload: &RawValue) -> Result<bool, String> {
    if surface == "claude-code" {
        return super::eligible_native_payload(payload);
    }
    if surface != "qwen-code" {
        return Ok(false);
    }
    #[derive(Deserialize)]
    struct Tool {
        tool_name: Option<String>,
    }
    let tool: Tool = serde_json::from_str(payload.get())
        .map_err(|error| format!("original Qwen file tool: {error}"))?;
    if tool.tool_name.as_deref() != Some("write_file") {
        return Ok(false);
    }
    capture(surface, payload)?;
    Ok(true)
}

pub fn capture(surface: &str, payload: &RawValue) -> Result<OriginalOperation, String> {
    if surface == "claude-code" {
        let session_id = super::native_original_session(payload)?;
        #[derive(Deserialize)]
        struct Tool {
            tool_name: String,
        }
        let tool: Tool = serde_json::from_str(payload.get()).map_err(|e| e.to_string())?;
        return Ok(OriginalOperation {
            surface: "claude-code",
            session_id,
            operation: if tool.tool_name == "Write" {
                FileOperation::Write
            } else {
                FileOperation::Edit
            },
        });
    }
    if surface != "qwen-code" {
        return Err("unsupported original native file surface".into());
    }
    #[derive(Deserialize)]
    struct Original {
        session_id: String,
        tool_name: String,
        #[serde(rename = "cwd")]
        _cwd: Option<String>,
        #[serde(rename = "tool_use_id")]
        _tool_use_id: Option<Box<RawValue>>,
        #[serde(rename = "tool_call_id")]
        _tool_call_id: Option<Box<RawValue>>,
        #[serde(rename = "permission_mode")]
        _permission_mode: Option<Box<RawValue>>,
        #[serde(rename = "execution_workdir")]
        _execution_workdir: Option<Box<RawValue>>,
        tool_input: Box<RawValue>,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct WriteInput {
        file_path: String,
        content: String,
    }
    let original: Original = serde_json::from_str(payload.get())
        .map_err(|error| format!("original Qwen selectors: {error}"))?;
    if original.tool_name != "write_file"
        || original.session_id.is_empty()
        || original.session_id.trim().is_empty()
    {
        return Err("Qwen native file callback lacks original Write/session identity".into());
    }
    let input: WriteInput = serde_json::from_str(original.tool_input.get())
        .map_err(|error| format!("original Qwen Write input: {error}"))?;
    if !Path::new(&input.file_path).is_absolute()
        || input.file_path.trim() != input.file_path
        || input.file_path.contains('\0')
        || input.content.contains('\0')
    {
        return Err("original Qwen Write requires absolute native path and text".into());
    }
    Ok(OriginalOperation {
        surface: "qwen-code",
        session_id: original.session_id,
        operation: FileOperation::Write,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn raw(text: &str) -> Box<RawValue> {
        RawValue::from_string(text.into()).unwrap()
    }
    const GOOD: &str = r#"{"session_id":"actual-qwen","cwd":"/owned","tool_name":"write_file","tool_input":{"file_path":"/owned/src/a.ts","content":"export const a = 1;"},"opaque":{"x":1e9999,"x":2}}"#;
    #[test]
    fn original_qwen_write_retains_surface_session_and_opaque_source() {
        let source = raw(GOOD);
        assert!(eligible("qwen-code", &source).unwrap());
        let observed = capture("qwen-code", &source).unwrap();
        assert_eq!(observed.surface, "qwen-code");
        assert_eq!(observed.session_id, "actual-qwen");
        assert_eq!(observed.operation, FileOperation::Write);
        assert_eq!(source.get(), GOOD);
        assert!(!eligible("codex", &source).unwrap());
        assert!(!eligible("qwen-code", &raw(&GOOD.replace("write_file", "Write"))).unwrap());
        assert!(!eligible("qwen-code", &raw(&GOOD.replace("write_file", "edit"))).unwrap());
    }
    #[test]
    fn original_qwen_known_selectors_and_input_are_not_last_key_winners() {
        for source in [
            GOOD.replace(
                "\"session_id\":",
                "\"session_id\":\"other\",\"session_id\":",
            ),
            GOOD.replace("\"cwd\":", "\"cwd\":\"/foreign\",\"cwd\":"),
            GOOD.replace("\"tool_name\":", "\"tool_name\":\"edit\",\"tool_name\":"),
            GOOD.replace(
                "\"file_path\":",
                "\"file_path\":\"/foreign\",\"file_path\":",
            ),
            GOOD.replace("\"content\":", "\"content\":\"other\",\"content\":"),
            GOOD.replace("/owned/src/a.ts", "relative.ts"),
            GOOD.replace("\"content\":", "\"cwd\":\"/foreign\",\"content\":"),
            GOOD.replace("actual-qwen", ""),
        ] {
            assert!(capture("qwen-code", &raw(&source)).is_err(), "{source}");
        }
    }
}
