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
}
impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!(
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
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.base).unwrap();
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
