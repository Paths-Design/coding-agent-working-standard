//! MCP shape and exact opaque sandbox custody only. Nothing here authenticates
//! a host, grants authority, or permits execution.
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Value, value::RawValue};
use std::{
    collections::{BTreeMap, HashSet},
    fmt,
    path::Path,
};

const REQUEST_LIMIT: usize = 1024 * 1024;
const STATE_LIMIT: usize = 256 * 1024;
const SOURCE_LIMIT: usize = 65_536;

// Deliberately not Debug: source and metadata may be private.
pub(crate) struct UnverifiedCall {
    pub id_json: String,
    pub source: String,
    pub cwd: Option<String>,
    pub session_id: String,
    pub thread_id: String,
    pub call_id: String,
    pub caller_anchor: String,
    pub server_environment_id: String,
    pub sandbox_state_json: String,
    pub sandbox_cwd_uri: String,
    pub sandbox_launcher: String,
}

// Maps retain raw values for exact byte custody and reject duplicate names,
// including alternate escaped spellings of the same name.
struct RawObject(BTreeMap<String, Box<RawValue>>);
impl<'de> Deserialize<'de> for RawObject {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct ObjectVisitor;
        impl<'de> Visitor<'de> for ObjectVisitor {
            type Value = RawObject;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an object with unique keys")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Self::Value, A::Error> {
                let mut values = BTreeMap::new();
                while let Some((key, value)) = m.next_entry::<String, Box<RawValue>>()? {
                    if values.insert(key, value).is_some() {
                        return Err(de::Error::custom("duplicate key"));
                    }
                }
                Ok(RawObject(values))
            }
        }
        d.deserialize_map(ObjectVisitor)
    }
}

// Validate unknown metadata recursively without interpreting it. Sandboxed
// policy values are excluded: their duplicate semantics belong to the launcher.
struct UniqueJson;
impl<'de> Deserialize<'de> for UniqueJson {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct Any;
        impl<'de> Visitor<'de> for Any {
            type Value = UniqueJson;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("JSON without duplicate object keys")
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
                Ok(UniqueJson)
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
                Ok(UniqueJson)
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
                Ok(UniqueJson)
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
                Ok(UniqueJson)
            }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> {
                Ok(UniqueJson)
            }
            fn visit_string<E: de::Error>(self, _: String) -> Result<Self::Value, E> {
                Ok(UniqueJson)
            }
            fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(UniqueJson)
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(UniqueJson)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                while seq.next_element::<UniqueJson>()?.is_some() {}
                Ok(UniqueJson)
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut keys = HashSet::new();
                while let Some((key, _)) = map.next_entry::<String, UniqueJson>()? {
                    if !keys.insert(key) {
                        return Err(de::Error::custom("duplicate key"));
                    }
                }
                Ok(UniqueJson)
            }
        }
        d.deserialize_any(Any)
    }
}

fn obj(raw: &RawValue) -> Result<RawObject, ()> {
    serde_json::from_str(raw.get()).map_err(|_| ())
}
fn field<'a>(o: &'a RawObject, k: &str) -> Result<&'a RawValue, ()> {
    o.0.get(k).map(|x| x.as_ref()).ok_or(())
}
fn exact(o: &RawObject, required: &[&str], optional: &[&str]) -> Result<(), ()> {
    if required.iter().all(|k| o.0.contains_key(*k))
        && o.0
            .keys()
            .all(|k| required.contains(&k.as_str()) || optional.contains(&k.as_str()))
    {
        Ok(())
    } else {
        Err(())
    }
}
fn string(raw: &RawValue, max: usize, allow_empty: bool) -> Result<String, ()> {
    let v: String = serde_json::from_str(raw.get()).map_err(|_| ())?;
    if v.len() > max || (!allow_empty && v.is_empty()) || v.chars().any(char::is_control) {
        return Err(());
    }
    Ok(v)
}
fn path(raw: &RawValue) -> Result<String, ()> {
    let v: String = serde_json::from_str(raw.get()).map_err(|_| ())?;
    if v.is_empty() || v.len() > 4096 || v.contains('\0') || !Path::new(&v).is_absolute() {
        return Err(());
    }
    Ok(v)
}

fn unique(raw: &RawValue) -> Result<(), ()> {
    serde_json::from_str::<UniqueJson>(raw.get())
        .map(|_| ())
        .map_err(|_| ())
}

/// Parse exactly one complete request. Caller must authenticate peer/metadata and
/// bind it to the original invocation before relying on any returned field.
pub(crate) fn parse_call(input: &[u8]) -> Result<UnverifiedCall, ()> {
    if input.is_empty() || input.len() > REQUEST_LIMIT {
        return Err(());
    }
    let root: RawObject = serde_json::from_slice(input).map_err(|_| ())?;
    exact(&root, &["jsonrpc", "id", "method", "params"], &[])?;
    if string(field(&root, "jsonrpc")?, 8, false)? != "2.0"
        || string(field(&root, "method")?, 32, false)? != "tools/call"
    {
        return Err(());
    }
    let id = field(&root, "id")?;
    let id_value: Value = serde_json::from_str(id.get()).map_err(|_| ())?;
    match id_value {
        Value::String(ref s)
            if !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control) => {}
        Value::Number(ref n) if n.as_i64().is_some() || n.as_u64().is_some() => {}
        _ => return Err(()),
    }
    let params = obj(field(&root, "params")?)?;
    exact(&params, &["name", "arguments", "_meta"], &[])?;
    if string(field(&params, "name")?, 64, false)? != "caws_exec" {
        return Err(());
    }
    let args = obj(field(&params, "arguments")?)?;
    exact(&args, &["source"], &["cwd"])?;
    let source: String = serde_json::from_str(field(&args, "source")?.get()).map_err(|_| ())?;
    if source.len() > SOURCE_LIMIT
        || source
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(());
    }
    let cwd = args.0.get("cwd").map(|v| path(v)).transpose()?;
    let meta = obj(field(&params, "_meta")?)?;
    for (key, value) in &meta.0 {
        if key != "codex/sandbox-state" && key != "codex/sandbox-state-meta" {
            unique(value)?;
        }
    }
    let session_id = string(field(&meta, "sessionId")?, 256, false)?;
    let thread_id = string(field(&meta, "threadId")?, 256, false)?;
    let call_id = string(field(&meta, "callId")?, 256, false)?;
    let context = obj(field(&meta, "codex/caller-context")?)?;
    exact(
        &context,
        &["version", "callerAnchor", "serverEnvironmentId"],
        &[],
    )?;
    if field(&context, "version")?.get() != "1" {
        return Err(());
    }
    let anchor = obj(field(&context, "callerAnchor")?)?;
    exact(&anchor, &["kind", "cwd"], &[])?;
    if string(field(&anchor, "kind")?, 16, false)? != "local" {
        return Err(());
    }
    let caller_anchor = path(field(&anchor, "cwd")?)?;
    let server_environment_id = string(field(&context, "serverEnvironmentId")?, 256, false)?;
    let state = field(&meta, "codex/sandbox-state")?;
    let alias = field(&meta, "codex/sandbox-state-meta")?;
    if state.get().len() > STATE_LIMIT || alias.get().len() > STATE_LIMIT {
        return Err(());
    }
    let state_value: Value = serde_json::from_str(state.get()).map_err(|_| ())?;
    let alias_value: Value = serde_json::from_str(alias.get()).map_err(|_| ())?;
    if !state_value.is_object() || state_value != alias_value {
        return Err(());
    }
    // Retain URI for owner binding; no path conversion or substitution here.
    let sandbox_cwd_uri = state_value
        .get("sandboxCwd")
        .and_then(Value::as_str)
        .ok_or(())?
        .to_owned();
    if sandbox_cwd_uri.is_empty()
        || sandbox_cwd_uri.len() > 4096
        || sandbox_cwd_uri.chars().any(char::is_control)
    {
        return Err(());
    }
    let launcher = obj(field(&meta, "codex/sandbox-launcher")?)?;
    exact(&launcher, &["codexExecutable"], &[])?;
    let sandbox_launcher = path(field(&launcher, "codexExecutable")?)?;
    Ok(UnverifiedCall {
        id_json: id.get().to_owned(),
        source,
        cwd,
        session_id,
        thread_id,
        call_id,
        caller_anchor,
        server_environment_id,
        sandbox_state_json: state.get().to_owned(),
        sandbox_cwd_uri,
        sandbox_launcher,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Synthetic stock-shaped request, deliberately lacking caller-context.
    const STOCK: &str = r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"_meta":{"sessionId":"session","threadId":"thread","callId":"call","x-codex-turn-metadata":{"reasoning_effort":"medium"},"codex/sandbox-state":{"sandboxCwd":"file:///sandbox","useMxc":false},"codex/sandbox-state-meta":{"sandboxCwd":"file:///sandbox","useMxc":false},"codex/sandbox-launcher":{"codexExecutable":"/bin/codex"}},"name":"caws_fixed_macos_fd_probe","arguments":{}}}"#;
    fn synthetic() -> Value {
        let mut v: Value = serde_json::from_str(STOCK).unwrap();
        v["params"]["name"] = json!("caws_exec");
        v["params"]["arguments"] = json!({"source":"printf hello\n", "cwd":"/work"});
        v["params"]["_meta"]["codex/caller-context"] = json!({
            "version":1,"callerAnchor":{"kind":"local","cwd":"/caller"},
            "serverEnvironmentId":"env-1"});
        v["params"]["_meta"]["sessionId"] = json!("parent-session");
        v["params"]["_meta"]["threadId"] = json!("child-thread");
        v["params"]["_meta"]["callId"] = json!("call-3");
        v
    }
    fn parse(v: &Value) -> Result<UnverifiedCall, ()> {
        parse_call(serde_json::to_string(v).unwrap().as_bytes())
    }
    #[test]
    fn synthetic_stock_shape_and_adaptation_without_caller_namespace_refuse() {
        assert!(parse_call(STOCK.as_bytes()).is_err());
        let mut v: Value = serde_json::from_str(STOCK).unwrap();
        v["params"]["name"] = json!("caws_exec");
        v["params"]["arguments"] = json!({"source":"true"});
        assert!(parse(&v).is_err());
    }
    #[test]
    fn synthetic_local_context_preserves_independent_identities() {
        let call = parse(&synthetic()).ok().unwrap();
        assert_eq!(
            (
                call.session_id.as_str(),
                call.thread_id.as_str(),
                call.call_id.as_str()
            ),
            ("parent-session", "child-thread", "call-3")
        );
        assert_eq!(call.caller_anchor, "/caller");
        assert_eq!(call.server_environment_id, "env-1");
        assert_eq!(call.cwd.as_deref(), Some("/work"));
        assert_eq!(call.source, "printf hello\n");
    }
    #[test]
    fn preserves_exact_opaque_primary_and_accepts_equal_alias() {
        let serialized = serde_json::to_string(&synthetic()).unwrap();
        let old =
            serde_json::to_string(&synthetic()["params"]["_meta"]["codex/sandbox-state"]).unwrap();
        let formatted = old.replacen('{', "{\n ", 1);
        let altered = serialized.replacen(&old, &formatted, 1);
        let call = parse_call(altered.as_bytes()).ok().unwrap();
        assert_eq!(call.sandbox_state_json, formatted);
        assert_ne!(call.sandbox_state_json, old);
    }
    #[test]
    fn rejects_alias_conflict_and_model_identity_spoof() {
        let mut v = synthetic();
        v["params"]["_meta"]["codex/sandbox-state-meta"]["useMxc"] = json!(true);
        assert!(parse(&v).is_err());
        let mut v = synthetic();
        v["params"]["arguments"]["threadId"] = json!("spoof");
        assert!(parse(&v).is_err());
    }
    #[test]
    fn rejects_unavailable_nonlocal_and_noninteger_versions() {
        for version in [json!(1.0), json!("1"), json!(true), json!(2), json!(null)] {
            let mut v = synthetic();
            v["params"]["_meta"]["codex/caller-context"]["version"] = version;
            assert!(parse(&v).is_err());
        }
        let mut v = synthetic();
        v["params"]["_meta"]["codex/caller-context"]["callerAnchor"] =
            json!({"kind":"unavailable","reason":"no-local-caller-anchor"});
        assert!(parse(&v).is_err());
        let mut v = synthetic();
        v["params"]["_meta"]["codex/caller-context"]["callerAnchor"]["cwd"] = json!("relative");
        assert!(parse(&v).is_err());
    }
    #[test]
    fn rejects_duplicate_owned_and_unknown_metadata_objects() {
        let input = serde_json::to_string(&synthetic()).unwrap();
        let duplicate = input.replacen("\"jsonrpc\":", "\"jsonrpc\":\"2.0\",\"jsonrpc\":", 1);
        assert!(parse_call(duplicate.as_bytes()).is_err());
        let duplicate = input.replacen(
            "\"reasoning_effort\":",
            "\"reasoning_effort\":null,\"reasoning_effort\":",
            1,
        );
        assert!(parse_call(duplicate.as_bytes()).is_err());
    }
    #[test]
    fn bounds_and_text_controls_refuse() {
        let mut v = synthetic();
        v["params"]["arguments"]["source"] = json!("a".repeat(SOURCE_LIMIT + 1));
        assert!(parse(&v).is_err());
        let mut v = synthetic();
        v["params"]["arguments"]["source"] = json!("echo \u{1}");
        assert!(parse(&v).is_err());
        let mut v = synthetic();
        v["params"]["_meta"]["threadId"] = json!("line\nbreak");
        assert!(parse(&v).is_err());
        assert!(parse_call(&vec![b' '; REQUEST_LIMIT + 1]).is_err());
    }
    #[test]
    fn opaque_policy_duplicate_is_retained_for_launcher_semantics() {
        let input = serde_json::to_string(&synthetic()).unwrap();
        let replacement = "\"useMxc\":true,\"useMxc\":false";
        let duplicated = input.replace("\"useMxc\":false", replacement);
        let call = parse_call(duplicated.as_bytes()).ok().unwrap();
        assert!(call.sandbox_state_json.contains(replacement));
    }
    #[test]
    fn native_and_execution_paths_allow_lf_without_identity_conflation() {
        let mut v = synthetic();
        v["params"]["_meta"]["codex/caller-context"]["callerAnchor"]["cwd"] = json!("/owned\nlane");
        v["params"]["arguments"]["cwd"] = json!("/execution\nlane");
        let call = parse(&v).ok().unwrap();
        assert_eq!(call.caller_anchor, "/owned\nlane");
        assert_eq!(call.cwd.as_deref(), Some("/execution\nlane"));
        assert_ne!(call.caller_anchor, call.cwd.unwrap());
        let mut v = synthetic();
        v["params"]["_meta"]["codex/caller-context"]["callerAnchor"]["cwd"] = json!("/bad\0path");
        assert!(parse(&v).is_err());
    }
}
