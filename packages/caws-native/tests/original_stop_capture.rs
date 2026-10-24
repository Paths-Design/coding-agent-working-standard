//! Original frontend ancestry + actual caws-native custodian integration.
//! Controlled opencode argv0 supplies the ancestry fixture only. The custodian
//! executor is Cargo's real native binary, never this test harness executable.
#![cfg(target_os = "macos")]
use caws_native::{
    context_git::original_project::FailureKind,
    invocation_project::{ExecutableIdentity, ProjectPhase, SelectedExecutable},
    monotonic_deadline::MonotonicDeadline,
    session_cache_wire::*,
};
use serde_json::{Value, json, value::RawValue};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
use std::{
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::net::{UnixListener, UnixStream},
    },
    sync::mpsc,
};
static NEXT: AtomicU64 = AtomicU64::new(0);
const ID: &str = "123-456";
const TOKEN: &str = "123e4567-e89b-42d3-a456-426614174000";
const DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
fn raw(text: &str) -> Box<RawValue> {
    RawValue::from_string(text.into()).unwrap()
}
fn bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}
fn read(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
// Fixture-only snapshot. The application must pass its trusted generation pin.
fn executor() -> SelectedExecutable {
    use std::os::unix::fs::MetadataExt;
    let path = PathBuf::from(env!("CARGO_BIN_EXE_caws-native"));
    let physical_path = path.canonicalize().unwrap();
    let meta = fs::metadata(&path).unwrap();
    SelectedExecutable {
        path,
        physical_path,
        sha256: sha(&fs::read(env!("CARGO_BIN_EXE_caws-native")).unwrap()),
        identity: ExecutableIdentity {
            device: meta.dev(),
            inode: meta.ino(),
            bytes: meta.len(),
            mode: meta.mode(),
            modified_seconds: meta.mtime(),
            modified_nanoseconds: meta.mtime_nsec(),
            changed_seconds: meta.ctime(),
            changed_nanoseconds: meta.ctime_nsec(),
        },
    }
}

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
    fn invocation<'a>(&'a self, payload: &'a RawValue, project_digest: &'a str) -> Invocation<'a> {
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
        let selected = test.to_owned();
        let result = Command::new(std::env::current_exe().unwrap())
            .arg0("/controlled-native-frontend/opencode")
            .args(["--exact", &selected, "--nocapture", "--test-threads=1"])
            .env("CAWS_ORIGINAL_STOP_CAPTURE_CHILD", "1")
            .env("COMMAND_MODE", "unix2003")
            .env_remove("CAWS_AGENT_PROCESS_NAMES")
            .output()
            .unwrap();
        let native = executor();
        f.record("native-frontend", json!({"selectedTest":selected,"argv0":"opencode","custodianExecutor":{"path":native.path,"physicalPath":native.physical_path,"sha256":native.sha256,"identity":format!("{:?}",native.identity)},"exit":result.status.code(),"stdout":String::from_utf8_lossy(&result.stdout),"stderr":String::from_utf8_lossy(&result.stderr)}));
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
    OriginalStopCapture::capture(input(f, env, payload), &executor(), deadline, || Ok(())).unwrap()
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
            assert_eq!(captured.query_cwds(), &[nested.clone(), f.root.clone()]);
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
                &executor(),
                &deadline,
                || Ok(()),
            ) {
                Err(error) => error,
                Ok(_) => panic!("nonrepository must not fabricate project capture"),
            };
            assert!(
                std::error::Error::source(&error)
                    .and_then(|cause| cause
                        .downcast_ref::<caws_native::context_git::original_project::RemoteFailure>(
                    ))
                    .is_some()
            );
            let OriginalStopCaptureFailure::Project {
                mut failure,
                interruption,
            } = error
            else {
                panic!("project failure was flattened")
            };
            let receipt = failure
                .receipt()
                .expect("real nonrepository query must have a correlated terminal receipt");
            f.record("actual-git-failure",json!({"kind":format!("{:?}",failure.kind),"diagnostic":failure.diagnostic,"interruption":interruption,"receipt":receipt,"custodianPid":failure.custodian_pid(),"cleanupSettled":failure.cleanup_settled()}));
            assert_eq!(
                failure.kind,
                FailureKind::Project(ProjectPhase::QueryStatus)
            );
            assert!(interruption.is_none());
            assert_eq!(receipt["terminal"], true);
            assert_eq!(receipt["rows"].as_array().unwrap().len(), 1);
            assert!(
                receipt["rows"][0]["receipt"]["pid"]
                    .as_u64()
                    .is_some_and(|v| v > 0)
            );
            assert_eq!(receipt["rows"][0]["receipt"]["exitCode"], 128);
            for key in ["groupSettled", "stdoutEof", "stderrEof", "reaped"] {
                assert_eq!(receipt["rows"][0]["receipt"]["cleanup"][key], true, "{key}")
            }
            failure.retry_cleanup().unwrap();
            assert!(failure.cleanup_settled());
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
                    b"#!/bin/sh\n: > \"$CAWS_CAPTURE_QUERY_STARTED\"\n/bin/sleep 30\nexec /usr/bin/git \"$@\"\n",
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
                &executor(),
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
            f.record("query-cancellation",json!({"markerExists":marker.exists(),"kind":format!("{:?}",failure.kind),"diagnostic":failure.diagnostic,"interruption":interruption,"receiptBeforeRetry":failure.receipt(),"custodianPid":failure.custodian_pid(),"cleanupBeforeRetry":failure.cleanup_settled()}));
            assert!(marker.exists());
            assert_eq!(failure.kind, FailureKind::Cancelled);
            assert_eq!(
                interruption.as_deref(),
                Some("original cancellation during Git child")
            );
            assert!(failure.custodian_pid().is_some_and(|pid| pid > 0));
            let until = Instant::now() + Duration::from_secs(3);
            while !failure.cleanup_settled() && Instant::now() < until {
                let _ = failure.retry_cleanup();
            }
            f.record(
                "query-cancellation-settlement",
                json!({"receipt":failure.receipt(),"cleanupSettled":failure.cleanup_settled()}),
            );
            assert!(failure.cleanup_settled());
            let receipt = failure.receipt().unwrap();
            assert_eq!(receipt["terminal"], true);
            assert_eq!(receipt["rows"].as_array().unwrap().len(), 1);
            assert!(
                receipt["rows"][0]["receipt"]["pid"]
                    .as_u64()
                    .is_some_and(|pid| pid > 0)
            );
            for key in ["groupSettled", "stdoutEof", "stderrEof", "reaped"] {
                assert_eq!(receipt["rows"][0]["receipt"]["cleanup"][key], true, "{key}")
            }
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
                &executor(),
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
                &executor(),
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

fn transfer_pipe_writer(mut socket: &UnixStream) {
    let mut pid = std::process::id().to_ne_bytes();
    let mut iov = libc::iovec {
        iov_base: pid.as_mut_ptr().cast(),
        iov_len: pid.len(),
    };
    let mut control = [0usize; 8];
    let size = std::mem::size_of::<i32>() as u32;
    let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    message.msg_controllen = unsafe { libc::CMSG_SPACE(size) } as _;
    assert!((message.msg_controllen as usize) <= std::mem::size_of_val(&control));
    unsafe {
        let header = libc::CMSG_FIRSTHDR(&message);
        assert!(!header.is_null());
        (*header).cmsg_level = libc::SOL_SOCKET;
        (*header).cmsg_type = libc::SCM_RIGHTS;
        (*header).cmsg_len = libc::CMSG_LEN(size) as _;
        *libc::CMSG_DATA(header).cast::<i32>() = libc::STDOUT_FILENO;
    }
    assert_eq!(
        unsafe { libc::sendmsg(socket.as_raw_fd(), &message, 0) },
        pid.len() as isize
    );
    let mut ack = [0u8; 1];
    socket.read_exact(&mut ack).unwrap();
    assert_eq!(&ack, b"A");
}
fn receive_pipe_writer(socket: &UnixStream) -> (OwnedFd, u32) {
    socket.set_nonblocking(true).unwrap();
    let mut pid = [0u8; 4];
    let mut iov = libc::iovec {
        iov_base: pid.as_mut_ptr().cast(),
        iov_len: pid.len(),
    };
    let mut control = [0usize; 8];
    let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    message.msg_controllen = std::mem::size_of_val(&control) as _;
    let until = Instant::now() + Duration::from_secs(2);
    loop {
        assert!(Instant::now() < until, "pipe transfer receive deadline");
        message.msg_controllen = std::mem::size_of_val(&control) as _;
        message.msg_flags = 0;
        let count = unsafe { libc::recvmsg(socket.as_raw_fd(), &mut message, 0) };
        if count < 0
            && matches!(
                std::io::Error::last_os_error().kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
            )
        {
            std::thread::sleep(Duration::from_millis(2));
            continue;
        }
        assert_eq!(
            count,
            pid.len() as isize,
            "pipe transfer receive: {}",
            std::io::Error::last_os_error()
        );
        break;
    }
    assert_eq!(message.msg_flags & libc::MSG_CTRUNC, 0);
    let writer = unsafe {
        let header = libc::CMSG_FIRSTHDR(&message);
        assert!(!header.is_null());
        assert_eq!((*header).cmsg_level, libc::SOL_SOCKET);
        assert_eq!((*header).cmsg_type, libc::SCM_RIGHTS);
        assert_eq!(
            (*header).cmsg_len,
            libc::CMSG_LEN(std::mem::size_of::<i32>() as u32) as libc::socklen_t
        );
        assert!(libc::CMSG_NXTHDR(&message, header).is_null());
        OwnedFd::from_raw_fd(*libc::CMSG_DATA(header).cast::<i32>())
    };
    assert_eq!(
        unsafe { libc::fcntl(writer.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) },
        0
    );
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    assert_eq!(unsafe { libc::fstat(writer.as_raw_fd(), &mut stat) }, 0);
    assert_eq!(stat.st_mode & libc::S_IFMT, libc::S_IFIFO);
    assert_eq!(
        unsafe { libc::fcntl(writer.as_raw_fd(), libc::F_GETFL) } & libc::O_ACCMODE,
        libc::O_WRONLY
    );
    (writer, u32::from_ne_bytes(pid))
}

// A read-only kernel process-table observation. This never supplies signal or
// reap authority; proc_pidinfo alone may omit the exited process being checked.
fn process_table_state(pid: u32) -> Result<Value, String> {
    let mut child = Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "pid=,ppid=,pgid=,stat="])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let until = Instant::now() + Duration::from_secs(2);
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            break;
        }
        if Instant::now() >= until {
            // Only this retained, unreaped diagnostic Child anchors its kill.
            let _ = child.kill();
            let stop = Instant::now() + Duration::from_secs(2);
            while child.try_wait().map_err(|e| e.to_string())?.is_none() && Instant::now() < stop {
                std::thread::sleep(Duration::from_millis(2));
            }
            return Err("read-only ps observation exceeded its bound".into());
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    let text = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
    if !output.status.success() || !output.stderr.is_empty() {
        return Err(format!("ps {}: {text}; {:?}", output.status, output.stderr));
    }
    let fields: Vec<_> = text.split_whitespace().collect();
    if fields.len() != 4 {
        return Err(format!("unexpected process table row: {text}"));
    }
    let number = |index: usize| fields[index].parse::<u32>().map_err(|e| e.to_string());
    Ok(
        json!({"pid":number(0)?,"parent":number(1)?,"group":number(2)?,"state":fields[3],"raw":text}),
    )
}

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ProcessBirth {
    pid: u32,
    parent: u32,
    group: u32,
    start_seconds: u64,
    start_micros: u64,
    status: u32,
}
fn process_birth(pid: u32) -> Option<ProcessBirth> {
    let mut raw = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_bsdinfo>();
    unsafe {
        *libc::__error() = 0;
    }
    let count = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            raw.as_mut_ptr().cast(),
            size as i32,
        )
    };
    if count == 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
        return None;
    }
    assert_eq!(
        count,
        size as i32,
        "process observation unavailable for {pid}: {}",
        std::io::Error::last_os_error()
    );
    let raw = unsafe { raw.assume_init() };
    assert_eq!(raw.pbi_pid, pid);
    assert!(raw.pbi_start_tvsec > 0 && raw.pbi_start_tvusec < 1_000_000);
    Some(ProcessBirth {
        pid,
        parent: raw.pbi_ppid,
        group: raw.pbi_pgid,
        start_seconds: raw.pbi_start_tvsec,
        start_micros: raw.pbi_start_tvusec,
        status: raw.pbi_status,
    })
}
fn same_birth(a: &ProcessBirth, b: &ProcessBirth) -> bool {
    a.pid == b.pid && a.start_seconds == b.start_seconds && a.start_micros == b.start_micros
}

#[test]
fn pending_original_stop_error_retains_remote_custody_across_retry_and_drop() {
    const ROLE: &str = "CAWS_ORIGINAL_STOP_PENDING_PIPE";
    if let Some(socket) = std::env::var_os(ROLE) {
        let socket = UnixStream::connect(socket).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let marker = b"held-original-stop\n";
        assert_eq!(
            unsafe { libc::write(libc::STDOUT_FILENO, marker.as_ptr().cast(), marker.len()) },
            marker.len() as isize
        );
        transfer_pipe_writer(&socket);
        std::process::exit(7);
    }
    native_frontend(
        "pending_original_stop_error_retains_remote_custody_across_retry_and_drop",
        |f| {
            for drop_error in [false, true] {
                let anchor = PathBuf::from(format!(
                    "/private/tmp/caws-stop-pipe-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
                fs::create_dir(&anchor).unwrap();
                fs::set_permissions(&anchor, fs::Permissions::from_mode(0o700)).unwrap();
                let socket_path = anchor.join("s");
                let listener = UnixListener::bind(&socket_path).unwrap();
                listener.set_nonblocking(true).unwrap();
                let wrapper = f.base.join(if drop_error {
                    "drop-git.sh"
                } else {
                    "retry-git.sh"
                });
                fs::write(&wrapper,format!("#!/bin/sh\n{ROLE}='{}' exec '{}' --exact pending_original_stop_error_retains_remote_custody_across_retry_and_drop --nocapture --test-threads=1\n",socket_path.display(),std::env::current_exe().unwrap().display())).unwrap();
                fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700)).unwrap();
                let mut environment = f.environment();
                environment.insert("CAWS_GIT_BINARY".into(), wrapper.to_str().unwrap().into());
                let (captured_tx, captured_rx) = mpsc::channel();
                let (release_tx, release_rx) = mpsc::channel();
                let holder = std::thread::spawn(move || {
                    let until = Instant::now() + Duration::from_secs(6);
                    let peer = loop {
                        match listener.accept() {
                            Ok((peer, _)) => break peer,
                            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                assert!(
                                    Instant::now() < until,
                                    "Stop Git stdout transfer never arrived"
                                );
                                std::thread::sleep(Duration::from_millis(2))
                            }
                            Err(e) => panic!("Stop pipe accept: {e}"),
                        }
                    };
                    let (writer, pid) = receive_pipe_writer(&peer);
                    let birth = process_birth(pid).expect("actual Git must remain alive until ACK");
                    (&peer).write_all(b"A").unwrap();
                    captured_tx.send(birth).unwrap();
                    let released = release_rx.recv_timeout(Duration::from_secs(6)).is_ok();
                    drop(writer);
                    released
                });
                let payload = raw(r#"{"session_id":"s"}"#);
                let deadline = MonotonicDeadline::capture(Duration::from_secs(8)).unwrap();
                let error = match OriginalStopCapture::capture(
                    input(f, &environment, &payload),
                    &executor(),
                    &deadline,
                    || Ok(()),
                ) {
                    Err(error) => error,
                    Ok(_) => panic!("unobserved stdout EOF minted original Stop capture"),
                };
                assert!(!error.cleanup_settled());
                let OriginalStopCaptureFailure::Project {
                    failure,
                    interruption,
                } = &error
                else {
                    panic!("pending Stop capture lost typed remote failure: {error}")
                };
                assert_eq!(failure.kind, FailureKind::Project(ProjectPhase::Cleanup));
                assert!(interruption.is_none());
                assert!(std::error::Error::source(&error).and_then(|cause|cause.downcast_ref::<caws_native::context_git::original_project::RemoteFailure>()).is_some());
                let initial = failure.receipt().unwrap();
                let custodian = process_birth(failure.custodian_pid().unwrap()).unwrap();
                let git = captured_rx.recv_timeout(Duration::from_secs(1)).unwrap();
                let mut owned_error = Some(error);
                if drop_error {
                    drop(owned_error.take());
                    std::thread::sleep(Duration::from_millis(100));
                }
                let custodian_while_held = process_birth(custodian.pid);
                let git_while_held = process_table_state(git.pid);
                // Release before assertions about the held state, so a test failure
                // cannot strand the deliberate outside-group pipe writer.
                release_tx.send(()).unwrap();
                let released = holder.join().unwrap();
                fs::remove_file(socket_path).unwrap();
                fs::remove_dir(anchor).unwrap();
                let terminal = if let Some(error) = owned_error.as_mut() {
                    let until = Instant::now() + Duration::from_secs(3);
                    while !error.cleanup_settled() && Instant::now() < until {
                        let _ = error.retry_cleanup();
                    }
                    assert!(error.cleanup_settled(), "{error:?}");
                    let OriginalStopCaptureFailure::Project { failure, .. } = error else {
                        unreachable!()
                    };
                    let receipt = failure.receipt().unwrap();
                    assert_eq!(receipt["terminal"], true);
                    assert!(receipt["project"].is_null());
                    assert_eq!(receipt["failure"]["phase"], "Cleanup");
                    for key in ["groupSettled", "stdoutEof", "stderrEof", "reaped"] {
                        assert_eq!(receipt["rows"][0]["receipt"]["cleanup"][key], true, "{key}")
                    }
                    Some(receipt)
                } else {
                    assert!(drop_error);
                    None
                };
                let until = Instant::now() + Duration::from_secs(3);
                let after = loop {
                    let after = [process_birth(custodian.pid), process_birth(git.pid)];
                    if after[0].as_ref().is_none_or(|v| !same_birth(v, &custodian))
                        && after[1].as_ref().is_none_or(|v| !same_birth(v, &git))
                    {
                        break after;
                    }
                    assert!(
                        Instant::now() < until,
                        "Stop custodian/Git instance remains after writer release"
                    );
                    std::thread::sleep(Duration::from_millis(2));
                };
                f.record(if drop_error{"pending-error-drop"}else{"pending-error-retry"},json!({"scope":"actual OriginalStopCapture error ownership with test-owned stdout writer; no admission","executor":env!("CARGO_BIN_EXE_caws-native"),"dropError":drop_error,"initialReceipt":initial,"custodian":custodian,"git":git,"custodianWhileHeld":custodian_while_held,"gitWhileHeld":git_while_held,"writerReleased":released,"terminalReceipt":terminal,"afterRelease":after,"originalDeadline":deadline.envelope(),"sessionsExist":f.root.join(".caws/sessions").exists()}));
                assert!(released);
                assert_eq!(initial["terminal"], false);
                assert_eq!(initial["rows"].as_array().unwrap().len(), 1);
                assert_eq!(initial["rows"][0]["receipt"]["exitCode"], 7);
                assert_eq!(initial["rows"][0]["receipt"]["cleanup"]["stdoutEof"], false);
                assert_eq!(initial["rows"][0]["receipt"]["cleanup"]["reaped"], false);
                assert_eq!(git.parent, custodian.pid);
                assert_eq!(git.group, git.pid);
                assert!(
                    custodian_while_held
                        .as_ref()
                        .is_some_and(|v| same_birth(v, &custodian) && v.status != libc::SZOMB)
                );
                let held = git_while_held.unwrap();
                assert_eq!(held["parent"], custodian.pid);
                assert!(held["state"].as_str().unwrap().starts_with('Z'));
                assert!(!f.root.join(".caws/sessions").exists());
            }
        },
    );
}

#[test]
fn caller_selected_native_pin_is_required_before_any_project_child() {
    native_frontend(
        "caller_selected_native_pin_is_required_before_any_project_child",
        |f| {
            f.init();
            let environment = f.environment();
            let payload = raw(r#"{"session_id":"s"}"#);
            let mut selected = executor();
            selected.identity.inode ^= 1;
            let deadline = MonotonicDeadline::capture(Duration::from_secs(10)).unwrap();
            let error = match OriginalStopCapture::capture(
                input(f, &environment, &payload),
                &selected,
                &deadline,
                || Ok(()),
            ) {
                Err(error) => error,
                Ok(_) => {
                    panic!("ignored caller-selected native pin and minted original project capture")
                }
            };
            assert!(error.cleanup_settled());
            let OriginalStopCaptureFailure::Project {
                failure,
                interruption,
            } = &error
            else {
                panic!("selected native refusal lost typed remote cause: {error}")
            };
            assert_eq!(
                failure.kind,
                FailureKind::Project(ProjectPhase::BeforeLaunch)
            );
            assert_eq!(failure.custodian_pid(), None);
            assert!(failure.receipt().is_none());
            assert!(interruption.is_none());
            f.record("wrong-native-pin",json!({"kind":format!("{:?}",failure.kind),"diagnostic":failure.diagnostic,"custodianPid":failure.custodian_pid(),"receipt":failure.receipt(),"cleanupSettled":error.cleanup_settled(),"sessionsExist":f.root.join(".caws/sessions").exists()}));
            assert!(!f.root.join(".caws/sessions").exists());
        },
    );
}
