use super::*;
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::symlink,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
static NEXT: AtomicU64 = AtomicU64::new(0);
const ID: &str = "123-456";
const TOKEN: &str = "123e4567-e89b-42d3-a456-426614174000";
const DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[cfg(target_os = "macos")]
mod prefix {
    use super::*;
    use crate::agent_pid_cache::OriginalAncestry;
    fn admit(f: &Fixture, payload: &RawValue, original: &OriginalAncestry) -> PrefixAdmitted {
        let mut invocation = f.invocation(payload);
        invocation.event = "session_end";
        invocation.advertised_capability = Some(PREFIX_CAPABILITY);
        let mut owner = PrefixOwner::new(PrefixInvocation {
            invocation,
            original_ancestry: original,
        })
        .unwrap();
        let mut request = f.request();
        request["schema"] = json!(PREFIX_REQUEST_SCHEMA);
        owner.admit(&bytes(&request)).unwrap()
    }
    fn decision() -> Vec<u8> {
        bytes(
            &json!({"schema":PREFIX_DECISION_SCHEMA,"id":ID,"runtimeDigest":DIGEST,"token":TOKEN,"action":"capture","createdUnits":[111,108,100]}),
        )
    }
    fn result(frame: &PrefixResultFrame) -> Value {
        serde_json::from_slice(&frame.encode().unwrap()).unwrap()
    }
    #[test]
    fn distinct_prefix_capability_cannot_be_confused_with_cache_only_v1() {
        let f = Fixture::new();
        let payload = raw(r#"{"session_id":"s"}"#);
        let original = OriginalAncestry::fixture_not_found("codex");
        let mut invocation = f.invocation(&payload);
        invocation.event = "session_end";
        assert!(
            PrefixOwner::new(PrefixInvocation {
                invocation,
                original_ancestry: &original
            })
            .is_err()
        );
        let mut invocation = f.invocation(&payload);
        invocation.advertised_capability = Some(PREFIX_CAPABILITY);
        assert!(Owner::new(invocation).is_err());
    }
    #[test]
    fn complete_prefix_has_exact_terminal_fields_and_real_envelope_pointer_values() {
        let f = Fixture::new();
        let original = OriginalAncestry::fixture_not_found("codex");
        let execution = admit(&f, &raw(r#"{"session_id":"s"}"#), &original).execute_checked(
            expires(),
            || Ok(()),
            |previous| {
                let previous: Value = serde_json::from_slice(previous).unwrap();
                assert_eq!(previous["schema"], PREFIX_PREVIOUS_SCHEMA);
                assert!(previous["existingBase64"].is_null());
                Ok(decision())
            },
        );
        assert!(execution.exchange_error.is_none());
        assert!(execution.cancellation_error.is_none());
        assert!(execution.result.prefix_complete());
        let terminal = result(&execution.result);
        let keys: std::collections::BTreeSet<_> = terminal
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, PREFIX_RESULT_KEYS.iter().copied().collect());
        assert_eq!(terminal["status"], "completed");
        assert_eq!(terminal["envelopePublished"], true);
        assert_eq!(terminal["pointerPublished"], true);
        assert_eq!(terminal["agentPid"], "not_found");
        assert_eq!(terminal["reap"], "not_run");
        assert!(!execution.result.fallback_safe());
        assert_eq!(read(&f.envelope("s"))["created_at"], "old");
        assert_eq!(read(&f.envelope("s"))["hook_event"], "SessionEnd");
        assert_eq!(read(&f.pointer())["session_id"], "s");
    }
    #[test]
    fn unsupported_pid_json_declines_before_any_envelope_pointer_or_marker_effect() {
        for old in [
            br#"{"agent_pid":true}"#.as_slice(),
            br#"{"agent_pid":1,"created_at":"\ud800"}"#,
            br#"{"agent_pid":1,"started_at":123}"#,
        ] {
            let f = Fixture::new();
            let original = OriginalAncestry::fixture_current("codex");
            let own = f.root.join(format!(
                ".caws/sessions/agent-pid-{}.json",
                std::process::id()
            ));
            fs::create_dir_all(own.parent().unwrap()).unwrap();
            fs::write(&own, old).unwrap();
            let execution = admit(&f, &raw(r#"{"session_id":"s"}"#), &original).execute_checked(
                expires(),
                || Ok(()),
                |_| panic!("unsupported PID JSON must decline before decision/effects"),
            );
            assert!(execution.result.fallback_safe());
            assert!(!execution.result.prefix_complete());
            assert_eq!(fs::read(own).unwrap(), old);
            assert!(!f.envelope("s").parent().unwrap().exists());
            assert!(!f.pointer().exists());
            assert!(
                !f.root
                    .join(".caws/sessions/.agent-pid-reap-marker")
                    .exists()
            );
        }
    }
    #[test]
    fn unavailable_envelope_preserves_it_and_completes_the_independent_pid_attempt() {
        let f = Fixture::new();
        let original = OriginalAncestry::fixture_not_found("codex");
        fs::create_dir_all(f.root.join(".caws/sessions")).unwrap();
        let blocked = f.root.join(".caws/sessions/s");
        fs::write(&blocked, b"not directory").unwrap();
        let execution = admit(&f, &raw(r#"{"session_id":"s"}"#), &original).execute_checked(
            expires(),
            || Ok(()),
            |_| panic!("unavailable envelope must not be pretended Missing"),
        );
        let terminal = result(&execution.result);
        assert_eq!(terminal["status"], "unavailable");
        assert_eq!(terminal["prefixComplete"], true);
        assert_eq!(terminal["envelopePublished"], false);
        assert_eq!(terminal["pointerPublished"], false);
        assert_eq!(terminal["agentPid"], "not_found");
        assert_eq!(fs::read(blocked).unwrap(), b"not directory");
        assert!(!execution.result.fallback_safe());
    }
    #[test]
    fn pointer_failure_keeps_partial_effect_truth_and_still_attempts_pid() {
        let f = Fixture::new();
        let original = OriginalAncestry::fixture_not_found("codex");
        fs::create_dir_all(f.pointer()).unwrap();
        let execution = admit(&f, &raw(r#"{"session_id":"s"}"#), &original).execute_checked(
            expires(),
            || Ok(()),
            |_| Ok(decision()),
        );
        let terminal = result(&execution.result);
        assert_eq!(terminal["status"], "unavailable");
        assert_eq!(terminal["prefixComplete"], true);
        assert_eq!(terminal["envelopePublished"], true);
        assert_eq!(terminal["pointerPublished"], false);
        assert_eq!(terminal["agentPid"], "not_found");
        assert!(f.pointer().is_dir());
        assert_eq!(read(&f.envelope("s"))["session_id"], "s");
    }
    #[test]
    fn lost_decision_and_late_cancellation_are_never_completion_or_replay_grants() {
        let f = Fixture::new();
        let original = OriginalAncestry::fixture_not_found("codex");
        let execution = admit(&f, &raw(r#"{"session_id":"s"}"#), &original).execute_checked(
            expires(),
            || Ok(()),
            |_| Err(WireError("transport lost")),
        );
        assert!(execution.exchange_error.is_some());
        assert!(!execution.result.prefix_complete());
        assert!(!execution.result.fallback_safe());
        assert!(!f.root.join(".caws/sessions").exists());
        let cancelled = std::cell::Cell::new(false);
        let execution = admit(&f, &raw(r#"{"session_id":"s"}"#), &original).execute_checked(
            expires(),
            || {
                if cancelled.get() {
                    Err("caller exited".into())
                } else {
                    Ok(())
                }
            },
            |_| {
                cancelled.set(true);
                Ok(decision())
            },
        );
        assert_eq!(
            execution.cancellation_error.as_deref(),
            Some("caller exited")
        );
        assert!(!execution.result.prefix_complete());
        assert!(!execution.result.fallback_safe());
        assert!(!f.root.join(".caws/sessions").exists());
    }
}
struct Fixture {
    base: PathBuf,
    root: PathBuf,
    project: String,
    retain: bool,
}
impl Fixture {
    fn new() -> Self {
        let retained = std::env::var_os("CAWS_TEST_ARTIFACT_DIR").map(PathBuf::from);
        if let Some(parent) = &retained {
            assert!(parent.is_absolute());
            fs::create_dir_all(parent).unwrap();
        }
        let retain = retained.is_some();
        let base = retained.unwrap_or_else(std::env::temp_dir).join(format!(
            "caws-cache-wire-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&base).unwrap();
        let base = fs::canonicalize(base).unwrap();
        let root = base.join("repo");
        fs::create_dir_all(root.join(".caws")).unwrap();
        let project = sha(root.to_str().unwrap().as_bytes());
        Self {
            base,
            root,
            project,
            retain,
        }
    }
    fn invocation<'a>(&'a self, payload: &'a RawValue) -> Invocation<'a> {
        Invocation {
            id: ID,
            runtime_digest: DIGEST,
            original_payload: payload,
            surface: "codex",
            event: "pre_tool_use",
            configuration: "system",
            ready_active: true,
            ready_project_digest: Some(&self.project),
            dispatched: true,
            advertised_capability: Some(CAPABILITY),
        }
    }
    fn request(&self) -> Value {
        json!({"schema":REQUEST_SCHEMA,"id":ID,"runtimeDigest":DIGEST,"token":TOKEN,"canonicalRoot":self.root.to_str().unwrap()})
    }
    fn admit(&self, payload: &RawValue) -> Admitted {
        Owner::new(self.invocation(payload))
            .unwrap()
            .admit(&bytes(&self.request()))
            .unwrap()
    }
    fn envelope(&self, sid: &str) -> PathBuf {
        self.root
            .join(".caws/sessions")
            .join(sid)
            .join(".session-envelope.json")
    }
    fn pointer(&self) -> PathBuf {
        self.root.join(".caws/sessions/.caller-session.json")
    }
    fn seed(&self, sid: &str, old: &[u8]) {
        fs::create_dir_all(self.envelope(sid).parent().unwrap()).unwrap();
        fs::write(self.envelope(sid), old).unwrap();
    }
}
impl Fixture {
    fn record(&self, name: &str, value: Value) {
        if self.retain {
            fs::write(
                self.base.join(format!("{name}.json")),
                serde_json::to_vec_pretty(&value).unwrap(),
            )
            .unwrap();
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if self.retain {
            let result = json!({"syntheticOriginalProject":true,"root":self.root,"completedWithoutPanic":!std::thread::panicking()});
            fs::write(
                self.base.join("result.json"),
                serde_json::to_vec_pretty(&result).unwrap(),
            )
            .unwrap();
        } else {
            fs::remove_dir_all(&self.base).unwrap();
        }
    }
}
fn raw(text: &str) -> Box<RawValue> {
    RawValue::from_string(text.into()).unwrap()
}
fn bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}
fn read(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}
fn expires() -> Instant {
    Instant::now() + Duration::from_secs(5)
}

#[test]
fn cancellation_after_valid_decision_is_fatal_not_a_replay_grant() {
    for action in ["capture", "decline"] {
        let f = Fixture::new();
        f.seed("s", b"old envelope");
        fs::write(f.pointer(), b"old pointer").unwrap();
        let cancelled = std::cell::Cell::new(false);
        let mut calls = 0;
        let execution = f.admit(&raw(r#"{"session_id":"s"}"#)).execute_checked(
            expires(),
            || {
                if cancelled.get() {
                    Err("native caller exited".into())
                } else {
                    Ok(())
                }
            },
            |_| {
                calls += 1;
                cancelled.set(true);
                Ok(bytes(&decision(action, Value::Null)))
            },
        );
        assert_eq!(calls, 1);
        assert_eq!(
            execution.cancellation_error.as_deref(),
            Some("native caller exited")
        );
        assert!(execution.exchange_error.is_none());
        assert_eq!(execution.result.status(), Status::Unavailable);
        assert!(!execution.result.fallback_safe());
        assert!(!execution.result.envelope_published());
        assert_eq!(fs::read(f.envelope("s")).unwrap(), b"old envelope");
        assert_eq!(fs::read(f.pointer()).unwrap(), b"old pointer");
    }
}
fn decision(action: &str, units: Value) -> Value {
    json!({"schema":DECISION_SCHEMA,"id":ID,"runtimeDigest":DIGEST,"token":TOKEN,"action":action,"createdUnits":units})
}
fn duplicate(frame: &Value, key: &str, value: &str) -> Vec<u8> {
    let original = frame.to_string();
    format!("{{\"{key}\":{value},{}", &original[1..]).into_bytes()
}

#[test]
fn context_requires_native_capability_active_dispatch_and_exact_surface_event_configuration() {
    let f = Fixture::new();
    let p = raw("{}");
    for case in 0..10 {
        let mut ctx = f.invocation(&p);
        match case {
            0 => ctx.ready_active = false,
            1 => ctx.dispatched = false,
            2 => ctx.surface = "claude-code",
            3 => ctx.event = "stop",
            4 => ctx.configuration = "project",
            5 => ctx.advertised_capability = None,
            6 => ctx.advertised_capability = Some("invented"),
            7 => ctx.ready_project_digest = None,
            8 => ctx.runtime_digest = "bad",
            _ => ctx.id = "",
        }
        assert!(Owner::new(ctx).is_err(), "case {case}");
    }
    assert!(Owner::new(f.invocation(&p)).is_ok());
}

#[test]
fn request_fields_binding_uuid_root_and_single_attempt_are_strict() {
    let f = Fixture::new();
    let p = raw(r#"{"session_id":"s"}"#);
    for (key, value) in [
        ("schema", json!("wrong")),
        ("id", json!("other")),
        ("runtimeDigest", json!("b".repeat(64))),
        ("token", json!("123e4567-e89b-12d3-a456-426614174000")),
        ("token", json!(TOKEN.to_uppercase())),
        ("token", json!("123e4567-e89b-42d3-7456-426614174000")),
        ("canonicalRoot", json!("/other")),
        ("canonicalRoot", json!(42)),
        ("unknown", json!(true)),
    ] {
        let mut changed = f.request();
        changed[key] = value;
        let mut owner = Owner::new(f.invocation(&p)).unwrap();
        assert!(owner.admit(&bytes(&changed)).is_err(), "{key}");
        assert!(
            owner.admit(&bytes(&f.request())).is_err(),
            "invalid first attempt cannot retry"
        );
    }
    for key in REQUEST_KEYS {
        let mut missing = f.request();
        missing.as_object_mut().unwrap().remove(*key);
        assert!(
            Owner::new(f.invocation(&p))
                .unwrap()
                .admit(&bytes(&missing))
                .is_err(),
            "missing {key}"
        );
        assert!(
            Owner::new(f.invocation(&p))
                .unwrap()
                .admit(&duplicate(
                    &f.request(),
                    key,
                    &f.request()[*key].to_string()
                ))
                .is_err(),
            "duplicate {key}"
        );
    }
    let mut owner = Owner::new(f.invocation(&p)).unwrap();
    assert!(owner.admit(&bytes(&f.request())).is_ok());
    assert!(owner.admit(&bytes(&f.request())).is_err());
    for root in [
        "relative", "/a/../b", "/a/./b", "/a//b", "/a/", "/a\0b", "/a\nb",
    ] {
        assert!(!root_path(root), "{root:?}");
    }
    assert!(root_path(f.root.to_str().unwrap()));
}

#[test]
fn previous_distinguishes_missing_empty_and_exact_binary_bytes_with_fixed_keys() {
    let f = Fixture::new();
    let p = raw("{}");
    let admitted = f.admit(&p);
    for old in [
        ExistingEnvelope::Missing,
        ExistingEnvelope::Bytes(b""),
        ExistingEnvelope::Bytes(b"\x00\xffNaN\r\n"),
    ] {
        let encoded = encode_previous(admitted.correlation(), old).unwrap();
        assert_eq!(encoded.last(), Some(&b'\n'));
        let v: Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(v.as_object().unwrap().len(), PREVIOUS_KEYS.len());
        assert_eq!(v["schema"], PREVIOUS_SCHEMA);
        assert_eq!(v["id"], ID);
        assert_eq!(v["runtimeDigest"], DIGEST);
        assert_eq!(v["token"], TOKEN);
        match old {
            ExistingEnvelope::Missing => assert_eq!(v["existingBase64"], Value::Null),
            ExistingEnvelope::Bytes(b) => assert_eq!(
                STANDARD
                    .decode(v["existingBase64"].as_str().unwrap())
                    .unwrap(),
                b
            ),
        }
    }
    assert!(
        encode_previous(
            admitted.correlation(),
            ExistingEnvelope::Bytes(&vec![0; MAX_EXISTING_BYTES + 1])
        )
        .is_err()
    );
}

#[test]
fn decision_requires_nullable_units_and_rejects_wrong_types_actions_duplicates_and_identity() {
    let f = Fixture::new();
    let p = raw("{}");
    let admitted = f.admit(&p);
    let c = admitted.correlation();
    assert_eq!(
        decode_decision(&bytes(&decision("capture", json!([0, 55296, 65535]))), c).unwrap(),
        CaptureDecision::Capture(Some(vec![0, 55296, 65535]))
    );
    assert_eq!(
        decode_decision(&bytes(&decision("capture", Value::Null)), c).unwrap(),
        CaptureDecision::Capture(None)
    );
    assert_eq!(
        decode_decision(&bytes(&decision("decline", Value::Null)), c).unwrap(),
        CaptureDecision::Decline
    );
    for units in [
        json!([-1]),
        json!([65536]),
        json!([1.0]),
        json!([1e0]),
        json!(["1"]),
        json!(false),
        json!({}),
    ] {
        assert!(decode_decision(&bytes(&decision("capture", units)), c).is_err());
    }
    assert!(decode_decision(&bytes(&decision("decline", json!([]))), c).is_err());
    for (key, value) in [
        ("schema", json!("wrong")),
        ("id", json!("foreign")),
        ("runtimeDigest", json!("b".repeat(64))),
        ("token", json!("123e4567-e89b-42d3-a456-426614174001")),
        ("action", json!("retry")),
        ("unknown", json!(true)),
    ] {
        let mut d = decision("capture", Value::Null);
        d[key] = value;
        assert!(decode_decision(&bytes(&d), c).is_err(), "{key}");
    }
    for key in DECISION_KEYS {
        let mut d = decision("capture", Value::Null);
        d.as_object_mut().unwrap().remove(*key);
        assert!(decode_decision(&bytes(&d), c).is_err(), "missing {key}");
        assert!(
            decode_decision(
                &duplicate(
                    &decision("capture", Value::Null),
                    key,
                    &decision("capture", Value::Null)[*key].to_string()
                ),
                c
            )
            .is_err(),
            "duplicate {key}"
        );
    }
    assert!(
        decode_decision(&bytes(&f.request()), c).is_err(),
        "repeat request in decision phase"
    );
}

#[test]
fn created_unit_and_frame_limits_are_enforced_at_the_boundary() {
    let f = Fixture::new();
    let p = raw("{}");
    let admitted = f.admit(&p);
    let c = admitted.correlation();
    let exact = decision("capture", json!(vec![65535u16; MAX_CREATED_UNITS]));
    let encoded = bytes(&exact);
    assert!(encoded.len() <= MAX_DECISION_BYTES);
    assert_eq!(
        decode_decision(&encoded, c).unwrap(),
        CaptureDecision::Capture(Some(vec![65535; MAX_CREATED_UNITS]))
    );
    assert!(
        decode_decision(
            &bytes(&decision(
                "capture",
                json!(vec![0u16; MAX_CREATED_UNITS + 1])
            )),
            c
        )
        .is_err()
    );
    assert!(decode_decision(&vec![b' '; MAX_DECISION_BYTES + 2], c).is_err());
    assert!(
        Owner::new(f.invocation(&p))
            .unwrap()
            .admit(&vec![b' '; MAX_REQUEST_BYTES + 2])
            .is_err()
    );
    let mut multiline = bytes(&decision("capture", Value::Null));
    multiline.insert(1, b'\n');
    assert!(decode_decision(&multiline, c).is_err());
}

#[test]
fn raw_sid_uses_last_owned_member_and_never_decodes_unowned_value_extensions() {
    let f = Fixture::new();
    let huge = "1".repeat(5000);
    let text = format!(
        r#"{{"session_id":"wrong","extension":{{"n":1e9999,"integer":{huge},"unicode":"\ud800","x":1,"x":2}},"session_\u0069d":"s"}}"#
    );
    let p = raw(&text);
    let executed = f.admit(&p).execute(expires(), |previous| {
        let v: Value = serde_json::from_slice(previous).unwrap();
        assert_eq!(v["existingBase64"], Value::Null);
        Ok(bytes(&decision("capture", Value::Null)))
    });
    assert_eq!(executed.result.status(), Status::Captured);
    assert!(executed.exchange_error.is_none());
    assert_eq!(read(&f.envelope("s"))["session_id"], "s");
    assert!(!f.envelope("wrong").exists());
    for text in [
        r#"{"session_id":"\ud800","session_id":"last"}"#,
        r#"{"session_id":42,"session_id":"last"}"#,
    ] {
        assert!(matches!(raw_sid(&raw(text)),RawSid::Safe(s) if s=="last"));
    }
}

#[test]
fn skipped_identity_does_not_exchange_or_mint_from_prior_cache() {
    let f = Fixture::new();
    f.seed("old", b"cached");
    fs::write(f.pointer(), b"old pointer").unwrap();
    for text in [
        "{}",
        r#"{"session_id":""}"#,
        r#"{"session_id":"unknown"}"#,
        r#"{"session_id":"../escape"}"#,
    ] {
        let p = raw(text);
        let e = f
            .admit(&p)
            .execute(expires(), |_| panic!("no exchange without safe raw SID"));
        assert_eq!(e.result.status(), Status::Skipped);
        assert!(!e.result.envelope_published());
        assert!(!e.result.fallback_safe());
        assert!(e.exchange_error.is_none());
    }
    assert_eq!(fs::read(f.envelope("old")).unwrap(), b"cached");
    assert_eq!(fs::read(f.pointer()).unwrap(), b"old pointer");
    assert_eq!(
        fs::read_dir(f.root.join(".caws/sessions")).unwrap().count(),
        2
    );
}

#[test]
fn unsupported_owned_or_key_profile_declines_without_guessing_sid() {
    let f = Fixture::new();
    for text in [
        r#"{"session_id":42}"#,
        r#"{"session_id":null}"#,
        r#"{"session_id":"\ud800"}"#,
        r#"{"\ud800":"unused","session_id":"s"}"#,
    ] {
        let p = raw(text);
        let e = f.admit(&p).execute(expires(), |_| {
            panic!("unsupported payload must not read old cache")
        });
        assert_eq!(e.result.status(), Status::Declined);
        assert!(e.result.fallback_safe());
        assert!(!e.result.envelope_published());
        assert!(e.exchange_error.is_none());
        assert!(!f.root.join(".caws/sessions").exists());
    }
}

#[test]
fn execute_binds_native_machine_event_serializes_units_and_exact_result_shape() {
    let f = Fixture::new();
    let p = raw(r#"{"session_id":"s","hook_event_name":"fake"}"#);
    let old = br#"{"session_id":"s","created_at":"\ud800","unused":NaN}"#;
    f.seed("s", old);
    let mut calls = 0;
    let e = f.admit(&p).execute(expires(), |previous| {
        calls += 1;
        let v: Value = serde_json::from_slice(previous).unwrap();
        assert_eq!(
            STANDARD
                .decode(v["existingBase64"].as_str().unwrap())
                .unwrap(),
            old
        );
        Ok(bytes(&decision("capture", json!([55296]))))
    });
    assert_eq!(calls, 1);
    assert_eq!(e.result.status(), Status::Captured);
    assert!(e.result.envelope_published());
    assert!(!e.result.fallback_safe());
    assert!(e.exchange_error.is_none());
    let output = fs::read(f.envelope("s")).unwrap();
    let text = std::str::from_utf8(&output).unwrap();
    assert!(text.contains(r#""created_at":"\ud800""#));
    assert!(text.contains(r#""hook_event":"PreToolUse""#));
    assert!(!text.contains("fake"));
    let result: Value = serde_json::from_slice(&e.result.encode().unwrap()).unwrap();
    assert_eq!(
        result,
        json!({"schema":RESULT_SCHEMA,"id":ID,"runtimeDigest":DIGEST,"token":TOKEN,"status":"captured","envelopePublished":true,"diagnostic":null})
    );
    assert_eq!(result.as_object().unwrap().len(), RESULT_KEYS.len());
}

#[test]
fn explicit_decline_is_only_fallback_safe_after_complete_terminal_result() {
    let f = Fixture::new();
    let p = raw(r#"{"session_id":"s"}"#);
    f.seed("s", b"before");
    fs::write(f.pointer(), b"pointer before").unwrap();
    let e = f
        .admit(&p)
        .execute(expires(), |_| Ok(bytes(&decision("decline", Value::Null))));
    assert_eq!(e.result.status(), Status::Declined);
    assert!(!e.result.envelope_published());
    assert!(e.result.fallback_safe());
    assert!(e.exchange_error.is_none());
    assert_eq!(fs::read(f.envelope("s")).unwrap(), b"before");
    assert_eq!(fs::read(f.pointer()).unwrap(), b"pointer before");
    let result: Value = serde_json::from_slice(&e.result.encode().unwrap()).unwrap();
    assert_eq!(result["diagnostic"], "engine decoder explicitly declined");
}

#[test]
fn lost_or_wrong_decision_is_unavailable_without_replay_or_mutation() {
    for wrong in [false, true] {
        let f = Fixture::new();
        let p = raw(r#"{"session_id":"s"}"#);
        f.seed("s", b"before");
        let mut calls = 0;
        let e = f.admit(&p).execute(expires(), |_| {
            calls += 1;
            if wrong {
                let mut d = decision("capture", Value::Null);
                d["token"] = json!("foreign");
                Ok(bytes(&d))
            } else {
                Err(WireError("lost response"))
            }
        });
        assert_eq!(calls, 1);
        assert_eq!(e.result.status(), Status::Unavailable);
        assert!(!e.result.envelope_published());
        assert!(!e.result.fallback_safe());
        assert!(e.exchange_error.is_some());
        assert_eq!(fs::read(f.envelope("s")).unwrap(), b"before");
        assert!(!f.pointer().exists());
    }
}

#[test]
fn oversize_declines_before_exchange_but_symlink_io_is_unavailable() {
    let f = Fixture::new();
    let p = raw(r#"{"session_id":"s"}"#);
    let old = vec![b'x'; MAX_EXISTING_BYTES + 1];
    f.seed("s", &old);
    let e = f
        .admit(&p)
        .execute(expires(), |_| panic!("oversize must not exchange"));
    assert_eq!(e.result.status(), Status::Declined);
    assert!(e.result.fallback_safe());
    assert!(!e.result.envelope_published());
    assert_eq!(fs::read(f.envelope("s")).unwrap(), old);
    fs::remove_file(f.envelope("s")).unwrap();
    let foreign = f.base.join("foreign");
    fs::write(&foreign, b"foreign").unwrap();
    symlink(&foreign, f.envelope("s")).unwrap();
    let e = f
        .admit(&p)
        .execute(expires(), |_| panic!("symlink must not exchange"));
    assert_eq!(e.result.status(), Status::Unavailable);
    assert!(!e.result.fallback_safe());
    assert!(!e.result.envelope_published());
    assert_eq!(fs::read(&foreign).unwrap(), b"foreign");
}

#[test]
fn partial_pointer_rename_failure_reports_published_envelope_without_fallback() {
    let f = Fixture::new();
    let p = raw(r#"{"session_id":"s"}"#);
    fs::create_dir_all(f.pointer()).unwrap();
    fs::write(f.pointer().join("kept"), b"old").unwrap();
    let e = f.admit(&p).execute(expires(), |_| {
        Ok(bytes(&decision("capture", json!([110, 101, 119]))))
    });
    assert_eq!(e.result.status(), Status::Unavailable);
    assert!(e.result.envelope_published());
    assert!(!e.result.fallback_safe());
    assert!(e.exchange_error.is_none());
    assert_eq!(read(&f.envelope("s"))["created_at"], "new");
    assert_eq!(fs::read(f.pointer().join("kept")).unwrap(), b"old");
}

#[test]
fn expired_exchange_and_diagnostic_credit_are_bounded() {
    let f = Fixture::new();
    let p = raw(r#"{"session_id":"s"}"#);
    let admitted = f.admit(&p);
    let frame = make_result(
        admitted.correlation(),
        Status::Unavailable,
        false,
        Some("λ".repeat(5000)),
    );
    assert_eq!(
        frame.diagnostic.as_ref().unwrap().len(),
        MAX_DIAGNOSTIC_BYTES
    );
    assert!(frame.encode().unwrap().len() <= MAX_RESULT_BYTES + 1);
    let e = admitted.execute(Instant::now(), |_| panic!("expired exchange cannot start"));
    assert_eq!(e.result.status(), Status::Unavailable);
    assert!(!e.result.fallback_safe());
    assert!(!f.root.join(".caws/sessions").exists());
}

#[test]
fn declared_wire_contract_matches_native_schemas_fields_limits_and_decline_variants() {
    let contract: Value = serde_json::from_str(include_str!("contract.json")).unwrap();
    assert_eq!(contract["capability"], CAPABILITY);
    for (name, schema, keys, limit) in [
        ("request", REQUEST_SCHEMA, REQUEST_KEYS, MAX_REQUEST_BYTES),
        (
            "previous",
            PREVIOUS_SCHEMA,
            PREVIOUS_KEYS,
            MAX_PREVIOUS_BYTES,
        ),
        (
            "decision",
            DECISION_SCHEMA,
            DECISION_KEYS,
            MAX_DECISION_BYTES,
        ),
        ("result", RESULT_SCHEMA, RESULT_KEYS, MAX_RESULT_BYTES),
    ] {
        assert_eq!(contract["frames"][name]["schema"], schema);
        assert_eq!(contract["frames"][name]["requiredKeys"], json!(keys));
        assert_eq!(contract["frames"][name]["maxBodyBytes"], limit);
    }
    assert_eq!(contract["maxExistingBytes"], MAX_EXISTING_BYTES);
    assert_eq!(contract["maxCreatedUnits"], MAX_CREATED_UNITS);
    assert_eq!(contract["maxDiagnosticUtf8Bytes"], MAX_DIAGNOSTIC_BYTES);
    assert_eq!(
        contract["maxExtraEngineStdoutBytesIncludingLf"],
        MAX_EXTRA_ENGINE_STDOUT_BYTES
    );
    assert_eq!(contract["actions"], json!(["capture", "decline"]));
    assert_eq!(
        contract["statuses"],
        json!(["captured", "skipped", "declined", "unavailable"])
    );
    for reason in [
        DeclineReason::DecoderDeclined,
        DeclineReason::ExistingTooLarge,
        DeclineReason::UnsupportedExistingFile,
    ] {
        assert!(matches!(
            CaptureOutcome::Declined(reason),
            CaptureOutcome::Declined(_)
        ));
    }
}

#[cfg(target_os = "macos")]
mod stop_prefix {
    use super::*;
    use crate::{
        agent_pid_cache::OriginalAncestry, invocation_project::*,
        monotonic_deadline::MonotonicDeadline,
    };
    fn project(f: &Fixture) -> ObservedProject {
        let clean = || QueryCleanup {
            pid: Some(42),
            exit_observed: true,
            pipes: PipeObservation {
                stdout_eof: true,
                stderr_eof: true,
                ..Default::default()
            },
            attempts: Vec::new(),
            reaped: Some(ExitObservation {
                success: true,
                code: Some(0),
                signal: None,
                core_dumped: false,
            }),
            ownership_retained: false,
        };
        ObservedProject {
            checkout: f.root.clone(),
            canonical_root: f.root.clone(),
            executable: SelectedExecutable {
                path: PathBuf::from("/synthetic/git"),
                physical_path: PathBuf::from("/synthetic/git"),
                identity: ExecutableIdentity {
                    device: 1,
                    inode: 1,
                    bytes: 1,
                    mode: 0o755,
                    modified_seconds: 0,
                    modified_nanoseconds: 0,
                    changed_seconds: 0,
                    changed_nanoseconds: 0,
                },
                sha256: DIGEST.into(),
            },
            queries: [clean(), clean()],
            query_bytes: std::array::from_fn(|_| QueryBytes {
                stdout: Vec::new(),
                stderr: Vec::new(),
            }),
        }
    }
    fn invocation<'a>(f: &'a Fixture, payload: &'a RawValue, surface: &'a str) -> Invocation<'a> {
        let mut i = f.invocation(payload);
        i.surface = surface;
        i.event = "stop";
        i.advertised_capability = Some(STOP_PREFIX_CAPABILITY);
        i
    }
    fn request(f: &Fixture) -> Vec<u8> {
        let mut v = f.request();
        v["schema"] = json!(STOP_PREFIX_REQUEST_SCHEMA);
        bytes(&v)
    }
    fn decision() -> Vec<u8> {
        bytes(
            &json!({"schema":STOP_PREFIX_DECISION_SCHEMA,"id":ID,"runtimeDigest":DIGEST,"token":TOKEN,
            "action":"capture","createdUnits":[111,108,100]}),
        )
    }
    fn admit<'a>(
        f: &'a Fixture,
        payload: &'a RawValue,
        surface: &'a str,
        original: &'a OriginalAncestry,
        project: &'a ObservedProject,
        deadline: &'a MonotonicDeadline,
    ) -> StopPrefixAdmitted<'a> {
        StopPrefixOwner::new(StopPrefixInvocation {
            invocation: invocation(f, payload, surface),
            original_ancestry: original,
            original_project: project,
            deadline,
        })
        .unwrap()
        .admit(&request(f))
        .unwrap()
    }
    fn frame(execution: &StopPrefixExecution<'_>) -> Value {
        serde_json::from_slice(&execution.result.encode().unwrap()).unwrap()
    }
    fn wait_expired(deadline: &MonotonicDeadline) {
        let stop = Instant::now() + Duration::from_secs(1);
        while deadline.check().is_ok() && Instant::now() < stop {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(deadline.check().is_err(), "original expiry did not pass");
    }
    #[test]
    fn stop_prefix_requires_original_project_settlement_ready_and_distinct_event() {
        let f = Fixture::new();
        let payload = raw(r#"{"session_id":"s"}"#);
        let original = OriginalAncestry::fixture_not_found("opencode");
        let deadline = MonotonicDeadline::capture(Duration::from_secs(5)).unwrap();
        for case in [
            "event",
            "capability",
            "surface",
            "not-dispatched",
            "root",
            "custody",
            "no-pid",
            "second-no-pid",
            "zero-pid",
            "open-pipe",
            "no-exit",
            "no-reap",
            "failed-exit",
            "missing-eof",
        ] {
            let mut p = project(&f);
            let mut i = invocation(&f, &payload, "opencode");
            match case {
                "event" => i.event = "session_end",
                "capability" => i.advertised_capability = Some(PREFIX_CAPABILITY),
                "surface" => i.surface = "codex",
                "not-dispatched" => i.dispatched = false,
                "root" => p.canonical_root = f.base.join("other"),
                "no-pid" => p.queries[0].pid = None,
                "second-no-pid" => p.queries[1].pid = None,
                "zero-pid" => p.queries[0].pid = Some(0),
                "open-pipe" => p.queries[0].pipes.stdout_open = true,
                "no-exit" => p.queries[0].exit_observed = false,
                "no-reap" => p.queries[0].reaped = None,
                "failed-exit" => p.queries[0].reaped.as_mut().unwrap().success = false,
                "missing-eof" => p.queries[0].pipes.stderr_eof = false,
                _ => p.queries[0].ownership_retained = true,
            }
            let result = StopPrefixOwner::new(StopPrefixInvocation {
                invocation: i,
                original_ancestry: &original,
                original_project: &p,
                deadline: &deadline,
            });
            f.record(&format!("refusal-{case}"),json!({"case":case,"refused":result.is_err(),"sessionsExist":f.root.join(".caws/sessions").exists()}));
            assert!(result.is_err(), "{case}");
            assert!(!f.root.join(".caws/sessions").exists());
        }
        let mut i = f.invocation(&payload);
        i.event = "stop";
        i.advertised_capability = Some(STOP_PREFIX_CAPABILITY);
        assert!(
            PrefixOwner::new(PrefixInvocation {
                invocation: i,
                original_ancestry: &original
            })
            .is_err()
        );
    }
    #[test]
    fn stop_request_binding_refuses_consumes_attempt_and_cannot_use_session_end_schema() {
        let f = Fixture::new();
        let payload = raw(r#"{"session_id":"s"}"#);
        let p = project(&f);
        let original = OriginalAncestry::fixture_not_found("opencode");
        let deadline = MonotonicDeadline::capture(Duration::from_secs(5)).unwrap();
        for key in ["schema", "id", "canonicalRoot", "runtimeDigest", "token"] {
            let mut owner = StopPrefixOwner::new(StopPrefixInvocation {
                invocation: invocation(&f, &payload, "opencode"),
                original_ancestry: &original,
                original_project: &p,
                deadline: &deadline,
            })
            .unwrap();
            let mut v: Value = serde_json::from_slice(&request(&f)).unwrap();
            v[key] = if key == "schema" {
                json!(PREFIX_REQUEST_SCHEMA)
            } else {
                json!("other")
            };
            assert!(owner.admit(&bytes(&v)).is_err(), "{key}");
            assert!(
                owner.admit(&request(&f)).is_err(),
                "invalid first attempt reopened"
            );
            assert!(!f.root.join(".caws/sessions").exists());
        }
    }
    #[test]
    fn real_stop_envelope_pointer_and_native_completion_bind_original_deadline() {
        for surface in ["opencode", "zcode"] {
            let f = Fixture::new();
            let payload = raw(r#"{"session_id":"s"}"#);
            let p = project(&f);
            let original = OriginalAncestry::fixture_not_found(surface);
            let deadline = MonotonicDeadline::capture(Duration::from_secs(5)).unwrap();
            let execution = admit(&f, &payload, surface, &original, &p, &deadline).execute_checked(
                || Ok(()),
                |previous| {
                    let previous: Value = serde_json::from_slice(previous).unwrap();
                    assert_eq!(previous["schema"], STOP_PREFIX_PREVIOUS_SCHEMA);
                    Ok(decision())
                },
            );
            let value = frame(&execution);
            f.record("complete",json!({"surface":surface,"result":value,"envelope":read(&f.envelope("s")),"pointer":read(&f.pointer()),"deadline":deadline.envelope(),"syntheticOriginalProject":true}));
            assert_eq!(value["schema"], STOP_PREFIX_RESULT_SCHEMA);
            assert_eq!(value["status"], "completed");
            assert_eq!(value["agentPid"], "not_found");
            assert_eq!(value["reap"], "not_run");
            assert_eq!(read(&f.envelope("s"))["hook_event"], "Stop");
            assert_eq!(read(&f.envelope("s"))["platform"], surface);
            assert_eq!(read(&f.envelope("s"))["created_at"], "old");
            let completed = match execution.into_completed() {
                Ok(value) => value,
                Err(_) => panic!("completed Stop evidence refused"),
            };
            assert_eq!(completed.correlation().id, ID);
            assert_eq!(completed.canonical_root(), f.root.to_str().unwrap());
            assert_eq!(completed.surface(), surface);
            assert_eq!(completed.supplied_session_id(), "s");
            assert_eq!(completed.deadline().envelope(), deadline.envelope());
            assert!(completed.check().is_ok());
        }
    }
    #[test]
    fn pointer_io_failure_retains_partial_truth_and_completes_remaining_attempts() {
        let f = Fixture::new();
        let payload = raw(r#"{"session_id":"s"}"#);
        let p = project(&f);
        let original = OriginalAncestry::fixture_not_found("opencode");
        let deadline = MonotonicDeadline::capture(Duration::from_secs(5)).unwrap();
        fs::create_dir_all(f.pointer()).unwrap();
        let execution = admit(&f, &payload, "opencode", &original, &p, &deadline)
            .execute_checked(|| Ok(()), |_| Ok(decision()));
        let value = frame(&execution);
        f.record("partial-pointer",json!({"result":value,"envelope":read(&f.envelope("s")),"pointerIsDirectory":f.pointer().is_dir()}));
        assert_eq!(value["status"], "unavailable");
        assert_eq!(value["prefixComplete"], true);
        assert_eq!(value["envelopePublished"], true);
        assert_eq!(value["pointerPublished"], false);
        assert_eq!(value["agentPid"], "not_found");
        assert!(!execution.result.fallback_safe());
        let completed = match execution.into_completed() {
            Ok(value) => value,
            Err(_) => panic!("advisory IO is a completed attempt, not replay permission"),
        };
        assert!(completed.result().prefix_complete());
        assert!(!completed.result().fallback_safe());
        let retained: Value =
            serde_json::from_slice(&completed.result().encode().unwrap()).unwrap();
        assert_eq!(retained["status"], "unavailable");
        assert_eq!(retained["envelopePublished"], true);
        assert_eq!(retained["pointerPublished"], false);
    }
    #[test]
    fn cancellation_after_envelope_keeps_effects_and_cannot_complete_or_replay() {
        let f = Fixture::new();
        let payload = raw(r#"{"session_id":"s"}"#);
        let p = project(&f);
        let original = OriginalAncestry::fixture_not_found("opencode");
        let deadline = MonotonicDeadline::capture(Duration::from_secs(5)).unwrap();
        let execution = admit(&f, &payload, "opencode", &original, &p, &deadline).execute_checked(
            || {
                if f.envelope("s").is_file() {
                    Err("caller stopped after envelope".into())
                } else {
                    Ok(())
                }
            },
            |_| Ok(decision()),
        );
        let value = frame(&execution);
        f.record("cancel-partial",json!({"result":value,"envelopeExists":f.envelope("s").is_file(),"pointerExists":f.pointer().exists(),"cancellation":execution.cancellation_error}));
        assert_eq!(value["prefixComplete"], false);
        assert_eq!(value["envelopePublished"], true);
        assert_eq!(value["pointerPublished"], false);
        assert!(execution.cancellation_error.is_some());
        assert!(!execution.result.fallback_safe());
        assert!(execution.into_completed().is_err());
    }
    #[test]
    fn original_expiry_before_execution_and_during_decision_never_renews() {
        for during_decision in [false, true] {
            let f = Fixture::new();
            let payload = raw(r#"{"session_id":"s"}"#);
            let p = project(&f);
            let original = OriginalAncestry::fixture_not_found("opencode");
            let deadline = MonotonicDeadline::capture(Duration::from_millis(20)).unwrap();
            let admitted = admit(&f, &payload, "opencode", &original, &p, &deadline);
            if !during_decision {
                wait_expired(&deadline);
            }
            let execution = admitted.execute_checked(
                || Ok(()),
                |_| {
                    assert!(during_decision, "expired execution asked for a decision");
                    wait_expired(&deadline);
                    Ok(decision())
                },
            );
            let value = frame(&execution);
            f.record("expired",json!({"duringDecision":during_decision,"deadline":deadline.envelope(),"result":value,"sessionsExist":f.root.join(".caws/sessions").exists()}));
            assert_eq!(value["prefixComplete"], false);
            assert_eq!(value["envelopePublished"], false);
            assert!(
                execution
                    .cancellation_error
                    .as_deref()
                    .is_some_and(|e| e.contains("Original monotonic deadline expired"))
            );
            assert!(!f.root.join(".caws/sessions").exists());
            assert!(execution.into_completed().is_err());
        }
    }
    #[test]
    fn completion_consumption_and_retained_receipt_recheck_original_expiry() {
        for delay_before_completion in [true, false] {
            let f = Fixture::new();
            let payload = raw(r#"{"session_id":"s"}"#);
            let p = project(&f);
            let original = OriginalAncestry::fixture_not_found("opencode");
            let deadline = MonotonicDeadline::capture(Duration::from_millis(200)).unwrap();
            let execution = admit(&f, &payload, "opencode", &original, &p, &deadline)
                .execute_checked(|| Ok(()), |_| Ok(decision()));
            let value = frame(&execution);
            f.record("live-prefix",json!({"result":value,"deadline":deadline.envelope(),"delayBeforeCompletion":delay_before_completion,"live":deadline.check().is_ok()}));
            assert!(
                execution.result.prefix_complete(),
                "must exercise completed work before delayed consumption"
            );
            assert!(
                deadline.check().is_ok(),
                "live setup expired before delayed consumption"
            );
            if delay_before_completion {
                wait_expired(&deadline);
                let result = execution.into_completed();
                f.record("expired-completion",json!({"refused":result.is_err(),"deadline":deadline.envelope(),"originalResult":value}));
                let refused = match result {
                    Err(value) => value,
                    Ok(_) => panic!("completion renewed expired original deadline"),
                };
                assert!(refused.result.prefix_complete());
                assert_eq!(frame(&refused), value);
            } else {
                let completed = match execution.into_completed() {
                    Ok(value) => value,
                    Err(_) => panic!("live completion refused"),
                };
                wait_expired(&deadline);
                let check = completed.check();
                f.record("expired-retained-completion",json!({"checkError":check.as_ref().err(),"deadline":completed.deadline().envelope(),"result":serde_json::from_slice::<Value>(&completed.result().encode().unwrap()).unwrap()}));
                assert!(
                    check
                        .as_ref()
                        .is_err_and(|e| e.contains("Original monotonic deadline expired"))
                );
                assert_eq!(completed.deadline().envelope(), deadline.envelope());
            }
        }
    }
    #[test]
    fn lost_or_wrong_event_decision_is_not_missing_or_fallback_safe() {
        for wrong in [false, true] {
            let f = Fixture::new();
            let payload = raw(r#"{"session_id":"s"}"#);
            let p = project(&f);
            let original = OriginalAncestry::fixture_not_found("opencode");
            let deadline = MonotonicDeadline::capture(Duration::from_secs(5)).unwrap();
            let execution = admit(&f, &payload, "opencode", &original, &p, &deadline)
                .execute_checked(
                    || Ok(()),
                    |_| {
                        if wrong {
                            let mut v: Value = serde_json::from_slice(&decision()).unwrap();
                            v["schema"] = json!(PREFIX_DECISION_SCHEMA);
                            Ok(bytes(&v))
                        } else {
                            Err(WireError("lost Stop decision"))
                        }
                    },
                );
            let value = frame(&execution);
            f.record("decision-refused",json!({"wrongEvent":wrong,"result":value,"exchangeError":execution.exchange_error.as_ref().map(ToString::to_string)}));
            assert!(execution.exchange_error.is_some());
            assert!(!execution.result.prefix_complete());
            assert!(!execution.result.fallback_safe());
            assert!(execution.into_completed().is_err());
            assert!(!f.root.join(".caws/sessions").exists());
        }
    }
    #[test]
    fn missing_original_id_cannot_borrow_fallback_session_or_complete() {
        let f = Fixture::new();
        let payload = raw("{}");
        let p = project(&f);
        let original = OriginalAncestry::fixture_not_found("opencode");
        let deadline = MonotonicDeadline::capture(Duration::from_secs(5)).unwrap();
        let execution = admit(&f, &payload, "opencode", &original, &p, &deadline).execute_checked(
            || Ok(()),
            |_| panic!("missing original id asked for decision"),
        );
        let value = frame(&execution);
        f.record(
            "missing-sid",
            json!({"result":value,"sessionsExist":f.root.join(".caws/sessions").exists()}),
        );
        assert_eq!(value["status"], "declined");
        assert!(execution.result.fallback_safe());
        assert!(!f.root.join(".caws/sessions").exists());
        assert!(execution.into_completed().is_err());
    }
}

#[cfg(target_os = "macos")]
mod original_stop_capture {
    use super::*;
    use crate::{invocation_project::ProjectPhase, monotonic_deadline::MonotonicDeadline};
    use std::{
        collections::BTreeMap,
        os::unix::{fs::PermissionsExt, process::CommandExt},
        process::Command,
    };

    struct RealFixture {
        base: PathBuf,
        root: PathBuf,
        retain: bool,
    }
    impl RealFixture {
        fn new() -> Self {
            let parent = std::env::var_os("CAWS_TEST_ARTIFACT_DIR").map(PathBuf::from);
            let retain = parent.is_some();
            let parent = parent.unwrap_or_else(std::env::temp_dir);
            assert!(parent.is_absolute());
            fs::create_dir_all(&parent).unwrap();
            let base = parent.join(format!(
                "caws-original-stop-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&base).unwrap();
            let base = fs::canonicalize(base).unwrap();
            let root = base.join("repo");
            fs::create_dir_all(root.join(".caws")).unwrap();
            Self { base, root, retain }
        }
        fn environment(&self) -> BTreeMap<String, String> {
            BTreeMap::from([
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("HOME".into(), self.base.to_str().unwrap().into()),
                ("LANG".into(), "C".into()),
                ("LC_ALL".into(), "C".into()),
                ("CAWS_GIT_BINARY".into(), "/usr/bin/git".into()),
                (
                    "CAWS_PROJECT_DIR".into(),
                    self.root.to_str().unwrap().into(),
                ),
            ])
        }
        fn init(&self) {
            let result = Command::new("/usr/bin/git")
                .args(["init", "--quiet"])
                .arg(&self.root)
                .env_clear()
                .envs(self.environment())
                .output()
                .unwrap();
            self.record("git-init", json!({"exit":result.status.code(),"stdout":String::from_utf8_lossy(&result.stdout),"stderr":String::from_utf8_lossy(&result.stderr)}));
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
        fn record(&self, name: &str, value: Value) {
            if self.retain {
                fs::write(
                    self.base.join(format!("{name}.json")),
                    serde_json::to_vec_pretty(&value).unwrap(),
                )
                .unwrap();
            }
        }
        fn invocation<'a>(
            &'a self,
            payload: &'a RawValue,
            project_digest: &'a str,
        ) -> Invocation<'a> {
            Invocation {
                id: ID,
                runtime_digest: DIGEST,
                original_payload: payload,
                surface: "opencode",
                event: "stop",
                configuration: "system",
                ready_active: true,
                ready_project_digest: Some(project_digest),
                dispatched: true,
                advertised_capability: Some(STOP_PREFIX_CAPABILITY),
            }
        }
        fn request(&self) -> Vec<u8> {
            bytes(
                &json!({"schema":STOP_PREFIX_REQUEST_SCHEMA,"id":ID,"runtimeDigest":DIGEST,"token":TOKEN,"canonicalRoot":self.root}),
            )
        }
    }
    impl Drop for RealFixture {
        fn drop(&mut self) {
            if self.retain {
                self.record("result",json!({"kind":"original-stop-capture-fixture","root":self.root,"completedWithoutPanic":!std::thread::panicking()}));
            } else {
                fs::remove_dir_all(&self.base).unwrap();
            }
        }
    }
    // The actual native frontend has the shipped basename, selected before the
    // test body. No process-global environment mutation is needed in the suite.
    fn native_frontend(test: &str, action: impl FnOnce(&RealFixture)) {
        let f = RealFixture::new();
        if std::env::var_os("CAWS_ORIGINAL_STOP_CAPTURE_CHILD").is_some() {
            action(&f);
        } else {
            let selected = format!("session_cache_wire::tests::original_stop_capture::{test}");
            let result = Command::new(std::env::current_exe().unwrap())
                .arg0("/controlled-native-frontend/opencode")
                .args(["--exact", &selected, "--nocapture", "--test-threads=1"])
                .env("CAWS_ORIGINAL_STOP_CAPTURE_CHILD", "1")
                .env("COMMAND_MODE", "unix2003")
                .env_remove("CAWS_AGENT_PROCESS_NAMES")
                .output()
                .unwrap();
            f.record("native-frontend", json!({"selectedTest":selected,"argv0":"opencode","exit":result.status.code(),"stdout":String::from_utf8_lossy(&result.stdout),"stderr":String::from_utf8_lossy(&result.stderr)}));
            assert!(
                result.status.success(),
                "stdout={} stderr={}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr)
            );
        }
    }
    fn input<'a>(
        f: &'a RealFixture,
        env: &'a BTreeMap<String, String>,
        payload: &'a RawValue,
    ) -> OriginalStopCaptureInput<'a> {
        OriginalStopCaptureInput {
            id: ID,
            runtime_digest: DIGEST,
            surface: "opencode",
            caller_cwd: f.base.to_str().unwrap(),
            caller_environment: env,
            original_payload: payload,
        }
    }
    fn capture<'a>(
        f: &RealFixture,
        env: &BTreeMap<String, String>,
        payload: &RawValue,
        deadline: &'a MonotonicDeadline,
    ) -> OriginalStopCapture<'a> {
        OriginalStopCapture::capture(input(f, env, payload), deadline, || Ok(())).unwrap()
    }
    fn decision() -> Vec<u8> {
        bytes(
            &json!({"schema":STOP_PREFIX_DECISION_SCHEMA,"id":ID,"runtimeDigest":DIGEST,"token":TOKEN,"action":"capture","createdUnits":[111,108,100]}),
        )
    }
    fn observation(captured: &OriginalStopCapture<'_>) -> Value {
        let p = captured.observed_project();
        json!({"id":captured.id(),"surface":captured.surface(),"runtimeDigest":captured.runtime_digest(),"callerCwd":captured.caller_cwd(),"callerEnvironment":captured.caller_environment(),"originalPayload":captured.original_payload().get(),"deadline":captured.deadline().envelope(),"checkout":p.checkout,"canonicalRoot":p.canonical_root,"gitPath":p.executable.path,"gitPhysicalPath":p.executable.physical_path,"gitSha256":p.executable.sha256,"queries":p.queries.iter().enumerate().map(|(index,q)|json!({"ordinal":index+1,"pid":q.pid,"exitObserved":q.exit_observed,"ownershipRetained":q.ownership_retained,"stdoutOpen":q.pipes.stdout_open,"stderrOpen":q.pipes.stderr_open,"stdoutEof":q.pipes.stdout_eof,"stderrEof":q.pipes.stderr_eof,"success":q.reaped.as_ref().map(|r|r.success),"code":q.reaped.as_ref().and_then(|r|r.code),"stdout":String::from_utf8_lossy(&p.query_bytes[index].stdout),"stderr":String::from_utf8_lossy(&p.query_bytes[index].stderr)})).collect::<Vec<_>>()})
    }
    fn expire(deadline: &MonotonicDeadline) {
        std::thread::sleep(
            deadline.expires().saturating_duration_since(Instant::now()) + Duration::from_millis(2),
        );
        assert_eq!(
            deadline.check().unwrap_err().to_string(),
            "Original monotonic deadline expired"
        );
    }

    #[test]
    fn real_git_capture_and_prefix_use_original_payload_environment_project_and_clock() {
        native_frontend(
            "real_git_capture_and_prefix_use_original_payload_environment_project_and_clock",
            |f| {
                f.init();
                let nested = f.root.join("nested");
                fs::create_dir(&nested).unwrap();
                let mut environment = f.environment();
                environment.insert(
                    "CAWS_PROJECT_DIR".into(),
                    f.base.join("missing-project").to_str().unwrap().into(),
                );
                environment.insert(
                    "GIT_DIR".into(),
                    f.base.join("poisoned-git-dir").to_str().unwrap().into(),
                );
                environment.insert(
                    "HOOK_CAPTURE_POISON".into(),
                    "ignored-by-git-observation".into(),
                );
                let payload_text = format!("{{\"session_id\":\"s\",\"cwd\":{}}}", json!(nested));
                let payload = raw(&payload_text);
                let deadline = MonotonicDeadline::capture(Duration::from_secs(10)).unwrap();
                let captured = capture(f, &environment, &payload, &deadline);
                f.record("actual-original-project", observation(&captured));
                let project = captured.observed_project();
                assert_eq!(project.checkout, f.root);
                assert_eq!(project.canonical_root, f.root);
                assert_eq!(
                    project.query_bytes[0].stdout,
                    format!("{}\n", f.root.display()).as_bytes()
                );
                assert_eq!(
                    project.query_bytes[1].stdout,
                    format!("{}\n", f.root.join(".git").display()).as_bytes()
                );
                assert_ne!(project.queries[0].pid, project.queries[1].pid);
                for query in &project.queries {
                    assert!(query.pid.is_some_and(|pid| pid > 0));
                    assert!(query.settled());
                    assert!(query.exit_observed);
                    assert!(
                        query
                            .reaped
                            .as_ref()
                            .is_some_and(|exit| exit.success && exit.code == Some(0))
                    );
                    assert!(query.pipes.stdout_eof && query.pipes.stderr_eof);
                }
                assert!(std::ptr::eq(captured.deadline(), &deadline));
                // Later caller-side edits cannot replace retained original inputs.
                environment.insert("CAWS_PROJECT_DIR".into(), "/later/unrelated".into());
                assert_eq!(
                    captured.caller_environment()["CAWS_PROJECT_DIR"],
                    f.base.join("missing-project").to_str().unwrap()
                );
                assert_eq!(captured.original_payload().get(), payload_text);
                let project_digest = sha(f.root.to_str().unwrap().as_bytes());
                let mut owner = captured
                    .prefix_owner(f.invocation(&payload, &project_digest))
                    .unwrap();
                let execution = owner.admit(&f.request()).unwrap().execute_checked(
                    || Ok(()),
                    |previous| {
                        let frame: Value = serde_json::from_slice(previous).unwrap();
                        assert_eq!(frame["schema"], STOP_PREFIX_PREVIOUS_SCHEMA);
                        Ok(decision())
                    },
                );
                let result: Value =
                    serde_json::from_slice(&execution.result().encode().unwrap()).unwrap();
                let envelope = read(&f.root.join(".caws/sessions/s/.session-envelope.json"));
                let pointer = read(&f.root.join(".caws/sessions/.caller-session.json"));
                let pid_record = read(&f.root.join(format!(
                    ".caws/sessions/agent-pid-{}.json",
                    std::process::id()
                )));
                f.record("actual-prefix",json!({"result":result,"envelope":envelope,"pointer":pointer,"pidRecord":pid_record,"originalDeadline":deadline.envelope()}));
                assert_eq!(result["status"], "completed");
                assert_eq!(result["envelopePublished"], true);
                assert_eq!(result["pointerPublished"], true);
                assert_eq!(result["agentPid"], "refreshed");
                assert_eq!(result["reap"], "completed");
                assert_eq!(envelope["hook_event"], "Stop");
                assert_eq!(envelope["created_at"], "old");
                for value in [&envelope, &pointer, &pid_record] {
                    assert_eq!(value["session_id"], "s");
                    assert_eq!(value["repo_root"], f.root.to_str().unwrap());
                }
                assert_eq!(pid_record["agent_pid"], std::process::id());
                let completed = match execution.into_completed() {
                    Ok(value) => value,
                    Err(_) => panic!("actual prefix refused completion"),
                };
                assert_eq!(completed.canonical_root(), f.root.to_str().unwrap());
                assert!(std::ptr::eq(completed.deadline(), &deadline));
                completed.check().unwrap();
                assert!(
                    captured
                        .prefix_owner(f.invocation(&payload, &project_digest))
                        .is_err()
                );
            },
        );
    }

    #[test]
    fn capture_bridge_binding_refusal_consumes_owner_before_any_prefix_effects() {
        native_frontend(
            "capture_bridge_binding_refusal_consumes_owner_before_any_prefix_effects",
            |f| {
                f.init();
                let environment = f.environment();
                let payload = raw(r#"{"session_id":"s"}"#);
                let other = raw(r#"{"session_id":"other"}"#);
                let project_digest = sha(f.root.to_str().unwrap().as_bytes());
                let wrong_digest = "b".repeat(64);
                for case in [
                    "id",
                    "runtime",
                    "surface",
                    "payload",
                    "project",
                    "dispatch",
                    "event",
                    "configuration",
                ] {
                    let deadline = MonotonicDeadline::capture(Duration::from_secs(10)).unwrap();
                    let captured = capture(f, &environment, &payload, &deadline);
                    let mut invocation = f.invocation(&payload, &project_digest);
                    match case {
                        "id" => invocation.id = "different",
                        "runtime" => invocation.runtime_digest = &wrong_digest,
                        "surface" => invocation.surface = "zcode",
                        "payload" => invocation.original_payload = &other,
                        "project" => invocation.ready_project_digest = Some(&wrong_digest),
                        "dispatch" => invocation.dispatched = false,
                        "event" => invocation.event = "session_end",
                        _ => invocation.configuration = "project",
                    }
                    let first = captured
                        .prefix_owner(invocation)
                        .err()
                        .expect("original binding must refuse");
                    let second = captured
                        .prefix_owner(f.invocation(&payload, &project_digest))
                        .err()
                        .expect("refusal must consume original owner attempt");
                    f.record(&format!("binding-refusal-{case}"),json!({"case":case,"first":first,"second":second,"sessionsExist":f.root.join(".caws/sessions").exists()}));
                    assert_eq!(second, "original Stop prefix owner already attempted");
                    assert!(!f.root.join(".caws/sessions").exists());
                }
            },
        );
    }

    #[test]
    fn real_failed_git_query_returns_structured_cleanup_and_error_source() {
        native_frontend(
            "real_failed_git_query_returns_structured_cleanup_and_error_source",
            |f| {
                let environment = f.environment();
                let payload = raw(r#"{"session_id":"s"}"#);
                let deadline = MonotonicDeadline::capture(Duration::from_secs(10)).unwrap();
                let error = match OriginalStopCapture::capture(
                    input(f, &environment, &payload),
                    &deadline,
                    || Ok(()),
                ) {
                    Err(error) => error,
                    Ok(_) => panic!("nonrepository must not fabricate project capture"),
                };
                assert!(std::error::Error::source(&error).is_some());
                let OriginalStopCaptureFailure::Project {
                    mut failure,
                    interruption,
                } = error
                else {
                    panic!("project failure was flattened")
                };
                f.record("actual-git-failure",json!({"phase":format!("{:?}",failure.first_phase),"message":failure.first_message,"interruption":interruption,"cleanup":format!("{:?}",failure.cleanup),"retainedUncertain":failure.retained_uncertain()}));
                assert_eq!(failure.first_phase, ProjectPhase::QueryStatus);
                assert!(interruption.is_none());
                assert!(failure.cleanup.pid.is_some_and(|pid| pid > 0));
                assert!(failure.cleanup.exit_observed);
                assert!(
                    failure
                        .cleanup
                        .reaped
                        .as_ref()
                        .is_some_and(|exit| !exit.success && exit.code == Some(128))
                );
                failure.retry_cleanup().unwrap();
                assert!(!failure.retained_uncertain());
                assert!(!f.root.join(".caws/sessions").exists());
            },
        );
    }

    #[test]
    fn cancellation_during_real_query_keeps_original_reason_and_structured_child_cleanup() {
        native_frontend(
            "cancellation_during_real_query_keeps_original_reason_and_structured_child_cleanup",
            |f| {
                f.init();
                let mut environment = f.environment();
                let payload = raw(r#"{"session_id":"s"}"#);
                let marker = f.base.join("query-started");
                let wrapper = f.base.join("git-witness.sh");
                fs::write(
                    &wrapper,
                    b"#!/bin/sh\n: > \"$CAWS_CAPTURE_QUERY_STARTED\"\nexec /usr/bin/git \"$@\"\n",
                )
                .unwrap();
                fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
                environment.insert("CAWS_GIT_BINARY".into(), wrapper.to_str().unwrap().into());
                environment.insert(
                    "CAWS_CAPTURE_QUERY_STARTED".into(),
                    marker.to_str().unwrap().into(),
                );
                let deadline = MonotonicDeadline::capture(Duration::from_secs(10)).unwrap();
                let error = match OriginalStopCapture::capture(
                    input(f, &environment, &payload),
                    &deadline,
                    || {
                        if marker.exists() {
                            Err("original cancellation during Git child".into())
                        } else {
                            Ok(())
                        }
                    },
                ) {
                    Err(error) => error,
                    Ok(_) => panic!("query cancellation minted capture"),
                };
                let OriginalStopCaptureFailure::Project {
                    mut failure,
                    interruption,
                } = error
                else {
                    panic!("query cancellation lost structured project failure")
                };
                f.record("query-cancellation",json!({"markerExists":marker.exists(),"phase":format!("{:?}",failure.first_phase),"message":failure.first_message,"interruption":interruption,"cleanupBeforeRetry":format!("{:?}",failure.cleanup),"retainedBeforeRetry":failure.retained_uncertain()}));
                assert!(marker.exists());
                assert_eq!(failure.first_phase, ProjectPhase::Cancelled);
                assert_eq!(
                    interruption.as_deref(),
                    Some("original cancellation during Git child")
                );
                assert!(failure.cleanup.pid.is_some_and(|pid| pid > 0));
                failure.retry_cleanup().unwrap();
                f.record("query-cancellation-settlement",json!({"cleanup":format!("{:?}",failure.cleanup),"retainedUncertain":failure.retained_uncertain()}));
                assert!(!failure.retained_uncertain());
                assert!(!f.root.join(".caws/sessions").exists());
            },
        );
    }

    #[test]
    fn original_capture_deadline_and_cancellation_refuse_before_observation() {
        native_frontend(
            "original_capture_deadline_and_cancellation_refuse_before_observation",
            |f| {
                let environment = f.environment();
                let payload = raw(r#"{"session_id":"s"}"#);
                let expired = MonotonicDeadline::capture(Duration::from_millis(1)).unwrap();
                expire(&expired);
                let error = match OriginalStopCapture::capture(
                    input(f, &environment, &payload),
                    &expired,
                    || Ok(()),
                ) {
                    Err(error) => error,
                    Ok(_) => panic!("expired original minted capture"),
                };
                assert!(
                    matches!(&error,OriginalStopCaptureFailure::Interrupted(message) if message=="Original monotonic deadline expired")
                );
                let live = MonotonicDeadline::capture(Duration::from_secs(10)).unwrap();
                let cancelled = match OriginalStopCapture::capture(
                    input(f, &environment, &payload),
                    &live,
                    || Err("original cancelled before capture".into()),
                ) {
                    Err(error) => error,
                    Ok(_) => panic!("cancelled original minted capture"),
                };
                assert!(
                    matches!(&cancelled,OriginalStopCaptureFailure::Interrupted(message) if message=="original cancelled before capture")
                );
                f.record("pre-capture-refusal",json!({"expiredDeadline":expired.envelope(),"expiry":error.to_string(),"cancellation":cancelled.to_string(),"sessionsExist":f.root.join(".caws/sessions").exists()}));
                assert!(!f.root.join(".caws/sessions").exists());
            },
        );
    }

    #[test]
    fn original_capture_and_completed_prefix_never_accept_a_fresh_clock() {
        native_frontend(
            "original_capture_and_completed_prefix_never_accept_a_fresh_clock",
            |f| {
                f.init();
                let environment = f.environment();
                let payload = raw(r#"{"session_id":"s"}"#);
                let digest = sha(f.root.to_str().unwrap().as_bytes());
                let original = MonotonicDeadline::capture(Duration::from_secs(2)).unwrap();
                let captured = capture(f, &environment, &payload, &original);
                let mut owner = captured
                    .prefix_owner(f.invocation(&payload, &digest))
                    .unwrap();
                let execution = owner
                    .admit(&f.request())
                    .unwrap()
                    .execute_checked(|| Ok(()), |_| Ok(decision()));
                let completed = match execution.into_completed() {
                    Ok(value) => value,
                    Err(_) => panic!("live prefix setup must complete"),
                };
                expire(&original);
                let fresh = MonotonicDeadline::capture(Duration::from_secs(10)).unwrap();
                fresh.check().unwrap();
                let diagnostic = completed.check().unwrap_err();
                f.record("expired-retained-original",json!({"originalDeadline":original.envelope(),"freshUnrelatedDeadline":fresh.envelope(),"captureDeadline":captured.deadline().envelope(),"completionDeadline":completed.deadline().envelope(),"diagnostic":diagnostic,"envelope":read(&f.root.join(".caws/sessions/s/.session-envelope.json"))}));
                assert_eq!(diagnostic, "Original monotonic deadline expired");
                assert!(std::ptr::eq(captured.deadline(), &original));
                assert!(std::ptr::eq(completed.deadline(), &original));
                // A separate original can expire before owner admission, with no effect.
                let other_original = MonotonicDeadline::capture(Duration::from_secs(2)).unwrap();
                let other_capture = capture(f, &environment, &payload, &other_original);
                expire(&other_original);
                let error = other_capture
                    .prefix_owner(f.invocation(&payload, &digest))
                    .err()
                    .expect("expired original owner must refuse");
                assert_eq!(error, "Original monotonic deadline expired");
            },
        );
    }
}
