use super::*;
use serde_json::{Value, json};

fn owner(deadline: Instant) -> ContextGitOwner {
    ContextGitOwner::new(Invocation {
        id: "invocation-1".into(),
        runtime_digest: "a".repeat(64),
        deadline,
        environment: vec![("PATH".into(), "/usr/bin:/bin".into())],
    })
    .unwrap()
}
fn frame(ordinal: u8) -> Value {
    json!({ "schema": REQUEST_SCHEMA, "id": "invocation-1", "runtimeDigest": "a".repeat(64),
        "token": "b".repeat(64), "ordinal": ordinal, "operation": if ordinal == 1 { "checkout" } else { "commonDir" },
        "executable": "/usr/bin/git", "cwd": "/tmp" })
}
fn begin(owner: &mut ContextGitOwner, frame: Value) -> Result<PendingGit, String> {
    owner.begin(&serde_json::to_vec(&frame).unwrap())
}

#[test]
fn rejects_uncorrelated_identity_or_argv_without_consuming_ordinal() {
    for (key, value) in [
        ("schema", json!("foreign")),
        ("id", json!("foreign")),
        ("runtimeDigest", json!("c".repeat(64))),
        ("token", json!("B".repeat(64))),
        ("ordinal", json!(2)),
        ("operation", json!("commonDir")),
        ("executable", json!("git")),
        ("cwd", json!("relative")),
        ("args", json!(["-c", "core.sshCommand=anything"])),
        ("environment", json!({"GIT_DIR": "/foreign"})),
    ] {
        let mut owner = owner(Instant::now());
        let mut request = frame(1);
        request[key] = value;
        assert!(
            begin(&mut owner, request).is_err(),
            "accepted invalid field {key}"
        );
        assert_eq!(owner.next, 1, "invalid field {key} consumed ordinal");
        assert!(owner.binding.is_none());
    }
}

#[test]
fn sequential_operations_bind_token_executable_and_reject_replay() {
    let mut owner = owner(Instant::now());
    let mut first = begin(&mut owner, frame(1)).unwrap();
    let row: ResultFrame = serde_json::from_slice(&first.advance().unwrap().unwrap()).unwrap();
    assert_eq!(row.status, "deadline");
    assert_eq!(row.exit_code, None);
    assert!(
        row.cleanup.reaped
            && row.cleanup.group_settled
            && row.cleanup.stdout_eof
            && row.cleanup.stderr_eof
    );
    assert!(
        first.child.is_none(),
        "insufficient budget must not create a custodian"
    );
    assert!(begin(&mut owner, frame(1)).is_err());
    for (field, value) in [
        ("token", json!("c".repeat(64))),
        ("executable", json!("/bin/sh")),
    ] {
        let mut request = frame(2);
        request[field] = value;
        assert!(begin(&mut owner, request).is_err());
        assert_eq!(owner.next, 2);
    }
    let mut second = begin(&mut owner, frame(2)).unwrap();
    let row: ResultFrame = serde_json::from_slice(&second.advance().unwrap().unwrap()).unwrap();
    assert_eq!(row.ordinal, 2);
    assert_eq!(row.operation, Operation::CommonDir);
    assert!(begin(&mut owner, frame(2)).is_err());
}

#[test]
fn overlap_and_ready_are_rejected_before_spawn() {
    let mut owner = owner(Instant::now());
    owner.active.store(true, Ordering::Release);
    assert!(begin(&mut owner, frame(1)).is_err());
    assert!(owner.mark_ready().is_err());
    assert_eq!(owner.next, 1);
    owner.active.store(false, Ordering::Release);
    owner.mark_ready().unwrap();
    assert!(begin(&mut owner, frame(1)).is_err());
}

#[test]
fn fixed_operations_cannot_supply_arbitrary_arguments() {
    assert_eq!(Operation::Checkout.argv(), ["rev-parse", "--show-toplevel"]);
    assert_eq!(
        Operation::CommonDir.argv(),
        ["rev-parse", "--path-format=absolute", "--git-common-dir"]
    );
    let mut owner = owner(Instant::now());
    let mut request = frame(1);
    request["operation"] = json!("shell");
    assert!(begin(&mut owner, request).is_err());
    assert!(owner.begin(&vec![b' '; MAX_REQUEST + 1]).is_err());
}

#[test]
fn diagnostics_are_bounded_on_utf8_boundaries() {
    let request: Request = serde_json::from_value(frame(1)).unwrap();
    let row = result(&request, "spawn_failed", &"€".repeat(600));
    assert_eq!(row.diagnostic.len(), 1023);
    assert_eq!(row.diagnostic, "€".repeat(341));
}

#[test]
fn delivered_uncertainty_cannot_report_successful_cleanup() {
    let request: Request = serde_json::from_value(frame(1)).unwrap();
    let active = Arc::new(AtomicBool::new(true));
    let mut uncertain = PendingGit::immediate(
        request.clone(),
        result(&request, "cleanup_unsettled", "custody retained"),
        active.clone(),
    );
    let row: ResultFrame = serde_json::from_slice(&uncertain.advance().unwrap().unwrap()).unwrap();
    assert_eq!(row.status, "cleanup_unsettled");
    assert!(!row.cleanup.reaped);
    assert!(uncertain.delivered);
    let error = uncertain.cancel_and_settle(Instant::now()).unwrap_err();
    assert!(error.contains("cleanup remains uncertain"));
    assert!(
        active.load(Ordering::Acquire),
        "uncertain delivery released request ownership"
    );

    let mut owner = owner(Instant::now());
    let mut settled = begin(&mut owner, frame(1)).unwrap();
    let row: ResultFrame = serde_json::from_slice(&settled.advance().unwrap().unwrap()).unwrap();
    assert!(
        row.cleanup.group_settled
            && row.cleanup.stdout_eof
            && row.cleanup.stderr_eof
            && row.cleanup.reaped
    );
    assert!(settled.delivered);
    assert_eq!(settled.cancel_and_settle(Instant::now()).unwrap(), None);
    assert!(!owner.active.load(Ordering::Acquire));
}
