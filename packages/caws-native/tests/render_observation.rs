//! Component transport tests with actual original-process Git/calendar owners.
//! These do not activate the ordinary frontend or a resident publication owner.
#![cfg(target_os = "macos")]
use base64::{Engine, engine::general_purpose::STANDARD};
use caws_native::{
    render_context::{CapturedRenderContext, OriginalInvocation as GitInvocation},
    render_observation::{self as observation, ObservationOwner},
    renderer_calendar::{
        self as calendar, CapturedCalendar, OriginalInvocation as CalendarInvocation,
    },
    session_publication::Transport,
    session_publication_wire as publication,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    cell::Cell,
    collections::{BTreeMap, VecDeque},
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

const ID: &str = "original-render-component";
const TOKEN: &str = "e8dd4552-66b6-4027-8d12-641be326347c";
const DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
static SERIAL: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new(body: &str) -> Self {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "render-observation-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("bin")).unwrap();
        let executable = root.join("bin/git");
        fs::write(
            &executable,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'/calls\n{body}\n",
                root.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        Self { root }
    }
    fn git(&self, expires: Instant) -> CapturedRenderContext {
        CapturedRenderContext::capture(
            GitInvocation {
                id: ID.into(),
                runtime_digest: DIGEST.into(),
                caller_cwd: self.root.to_str().unwrap().into(),
                cwd: self.root.to_str().unwrap().into(),
                environment: BTreeMap::from([
                    (
                        "PATH".into(),
                        format!("{}:/usr/bin:/bin", self.root.join("bin").display()),
                    ),
                    ("HOME".into(), self.root.to_str().unwrap().into()),
                    ("LC_ALL".into(), "C".into()),
                ]),
            },
            expires,
            &|| false,
        )
        .unwrap()
    }
    fn owner(&self, expires: Instant) -> ObservationOwner {
        ObservationOwner::new(self.git(expires), captured_calendar(ID, expires), expires)
            .ok()
            .unwrap()
    }
    fn calls(&self) -> Vec<String> {
        fs::read_to_string(self.root.join("calls"))
            .unwrap_or_default()
            .lines()
            .map(String::from)
            .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn captured_calendar(id: &str, expires: Instant) -> CapturedCalendar {
    CapturedCalendar::capture(CalendarInvocation {
        id: id.into(),
        runtime_digest: DIGEST.into(),
        deadline: expires,
        max_queries: 512,
    })
    .unwrap()
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn frame(value: Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(&value).unwrap();
    bytes.push(b'\n');
    bytes
}
fn tuple(schema: &str) -> Value {
    json!({"schema":schema,"id":ID,"runtimeDigest":DIGEST,"token":TOKEN,"attempt":"original-attempt","observationId":"b".repeat(64),"inputDigest":sha(b"[]")})
}
fn prepare() -> Vec<u8> {
    frame(
        json!({"schema":publication::PREPARE,"id":ID,"runtimeDigest":DIGEST,"token":TOKEN,"attempt":"original-attempt","kind":"render","snapshot":{"observationId":"b".repeat(64),"inputDigest":sha(b"[]"),"sessionId":"original-session","reason":"exit","endedAt":"2026-10-23T00:00:00Z","files":[],"priorInventory":[]}}),
    )
}
fn ready() -> Vec<u8> {
    frame(
        json!({"schema":publication::READY,"id":ID,"runtimeDigest":DIGEST,"token":TOKEN,"attempt":"original-attempt","kind":"render","direction":"inputs"}),
    )
}
fn request(sequence: u32, operation: &str) -> Value {
    let mut value = tuple(observation::REQUEST);
    value["sequence"] = sequence.into();
    value["operation"] = operation.into();
    value
}
fn git_request() -> Vec<u8> {
    frame(request(1, "git"))
}
fn calendar_request(sequence: u32) -> Vec<u8> {
    let mut value = request(sequence, "calendar");
    value["request"] = json!({"schema":calendar::REQUEST_SCHEMA,"profile":calendar::PROFILE,"id":ID,"runtimeDigest":DIGEST,"token":TOKEN,"sequence":sequence-1,"seconds":["0","-1"]});
    frame(value)
}
fn prepared(disposition: &str) -> Vec<u8> {
    let mut value = tuple(publication::PREPARED);
    value["kind"] = "render".into();
    value["disposition"] = disposition.into();
    value["artifacts"] = json!([]);
    value["removals"] = json!([]);
    if disposition == "aborted" {
        value["diagnostic"] = "deliberately aborted component".into();
    }
    frame(value)
}
#[derive(Default)]
struct Recording {
    reads: VecDeque<Vec<u8>>,
    writes: Vec<Vec<u8>>,
    credits: Vec<usize>,
    read_count: usize,
    fail_schema: Option<&'static str>,
    cancel_schema: Option<(&'static str, Rc<Cell<bool>>)>,
    fail_credit: bool,
}
impl Recording {
    fn rows(&self) -> Vec<Value> {
        self.writes
            .iter()
            .map(|bytes| serde_json::from_slice(bytes).unwrap())
            .collect()
    }
}
impl Transport for Recording {
    fn write(&mut self, bytes: &[u8], _: Instant) -> Result<(), String> {
        let value: Value = serde_json::from_slice(bytes).unwrap();
        if self
            .fail_schema
            .is_some_and(|schema| value["schema"] == schema)
        {
            return Err("actual component transport write failure".into());
        }
        self.writes.push(bytes.to_vec());
        if let Some((schema, cancelled)) = &self.cancel_schema {
            if value["schema"] == *schema {
                cancelled.set(true);
            }
        }
        Ok(())
    }
    fn read(&mut self, _: Instant) -> Result<Vec<u8>, String> {
        self.read_count += 1;
        self.reads
            .pop_front()
            .ok_or_else(|| "component transport EOF".into())
    }
    fn credit(&mut self, bytes: usize) -> Result<(), String> {
        if self.fail_credit {
            return Err("component credit failure".into());
        }
        self.credits.push(bytes);
        Ok(())
    }
}
fn open(owner: &mut ObservationOwner, recording: &mut Recording, expires: Instant) {
    let mut transport = owner.transport(recording, &|| false);
    transport.write(&prepare(), expires).unwrap();
    transport.write(&ready(), expires).unwrap();
}
const FOUR_QUERIES: &str = "case \"$1 $2\" in\n'rev-parse --is-inside-work-tree') printf 'true\\n';;\n'symbolic-ref --quiet') printf 'main\\n';;\n'rev-parse --short') printf 'abc123\\n';;\n'status --porcelain') /usr/bin/head -c 140000 /dev/zero;;\n*) exit 97;;\nesac";
fn reassemble(rows: &[Value], sequence: u32, operation: &str) -> Vec<u8> {
    let header = rows
        .iter()
        .find(|row| row["schema"] == observation::RESULT && row["sequence"] == sequence)
        .unwrap();
    assert_eq!(header["operation"], operation);
    let chunks: Vec<_> = rows
        .iter()
        .filter(|row| row["schema"] == observation::CHUNK && row["sequence"] == sequence)
        .collect();
    let mut bytes = Vec::new();
    for (index, row) in chunks.iter().enumerate() {
        assert_eq!(row["operation"], operation);
        assert_eq!(row["offset"], bytes.len());
        let chunk = STANDARD.decode(row["base64"].as_str().unwrap()).unwrap();
        assert_eq!(STANDARD.encode(&chunk), row["base64"]);
        if index + 1 < chunks.len() {
            assert_eq!(chunk.len(), 64 * 1024);
        } else {
            assert!(!chunk.is_empty() && chunk.len() <= 64 * 1024);
        }
        bytes.extend(chunk);
    }
    assert_eq!(header["byteLength"], bytes.len());
    assert_eq!(header["sha256"], sha(&bytes));
    bytes
}

#[test]
fn actual_git_then_calendar_share_one_reader_binding_and_exact_chunk_bytes() {
    let fixture = Fixture::new(FOUR_QUERIES);
    let expires = Instant::now() + Duration::from_secs(5);
    let mut owner = fixture.owner(expires);
    let prepared = prepared("ready");
    let mut recording = Recording {
        reads: VecDeque::from([git_request(), calendar_request(2), prepared.clone()]),
        ..Default::default()
    };
    open(&mut owner, &mut recording, expires);
    assert!(fixture.calls().is_empty(), "binding must not query Git");
    let rows = recording.rows();
    assert_eq!(rows[1]["schema"], publication::READY);
    assert_eq!(rows[2]["schema"], observation::BINDING);
    assert_eq!(rows[2]["cwd"], fixture.root.to_str().unwrap());
    assert_eq!(
        rows[2]["executable"]["sha256"],
        sha(&fs::read(fixture.root.join("bin/git")).unwrap())
    );
    assert_eq!(
        rows[2]["calendarContext"]["originalPid"],
        std::process::id()
    );
    assert_eq!(
        owner
            .transport(&mut recording, &|| false)
            .read(expires)
            .unwrap(),
        prepared
    );
    assert_eq!(
        fixture.calls(),
        [
            "rev-parse --is-inside-work-tree",
            "symbolic-ref --quiet --short HEAD",
            "rev-parse --short HEAD",
            "status --porcelain"
        ]
    );
    assert_eq!(recording.read_count, 3);
    assert_eq!(
        recording.credits,
        [git_request().len(), calendar_request(2).len()]
    );
    let rows = recording.rows();
    let git_bytes = reassemble(&rows, 1, "git");
    let observed: Value = serde_json::from_slice(&git_bytes).unwrap();
    assert_eq!(observed["id"], ID);
    assert_eq!(observed["token"], TOKEN);
    assert_eq!(observed["queries"][3]["exitCode"], 0);
    assert_eq!(
        STANDARD
            .decode(observed["queries"][3]["stdout"].as_str().unwrap())
            .unwrap(),
        vec![0; 140000]
    );
    for query in observed["queries"].as_array().unwrap() {
        assert_eq!(query["cleanup"]["groupSettled"], true);
        assert_eq!(query["cleanup"]["stdoutEof"], true);
        assert_eq!(query["cleanup"]["stderrEof"], true);
        assert_eq!(query["cleanup"]["reaped"], true);
    }
    let calendar_bytes = reassemble(&rows, 2, "calendar");
    let local: Value = serde_json::from_slice(&calendar_bytes).unwrap();
    assert_eq!(local["schema"], calendar::REPLY_SCHEMA);
    assert_eq!(local["sequence"], 1);
    assert_eq!(local["context"], rows[2]["calendarContext"]);
    assert_eq!(local["results"][0]["seconds"], "0");
    assert_eq!(local["results"][1]["seconds"], "-1");
    assert_eq!(local["results"][0]["kind"], "local_calendar");
    assert!(owner.failure().is_none());
    assert!(owner.cleanup_settled());
}

#[test]
fn captured_identity_mismatch_and_native_phase_mismatch_decline_before_binding_or_query() {
    let fixture = Fixture::new(FOUR_QUERIES);
    let expires = Instant::now() + Duration::from_secs(3);
    let error = ObservationOwner::new(
        fixture.git(expires),
        captured_calendar("different-original", expires),
        expires,
    )
    .err()
    .unwrap();
    assert_eq!(error.category, "binding");
    for (field, replacement) in [
        ("id", json!("other")),
        ("runtimeDigest", json!("b".repeat(64))),
        ("token", json!("bad/token")),
        ("attempt", json!("")),
    ] {
        let mut owner = fixture.owner(expires);
        let mut recording = Recording::default();
        let mut value: Value = serde_json::from_slice(&prepare()).unwrap();
        value[field] = replacement;
        assert!(
            owner
                .transport(&mut recording, &|| false)
                .write(&frame(value), expires)
                .is_err()
        );
        assert!(recording.writes.is_empty());
    }
    for field in ["observationId", "inputDigest"] {
        let mut owner = fixture.owner(expires);
        let mut recording = Recording::default();
        let mut value: Value = serde_json::from_slice(&prepare()).unwrap();
        value["snapshot"][field] = "wrong".into();
        assert!(
            owner
                .transport(&mut recording, &|| false)
                .write(&frame(value), expires)
                .is_err()
        );
        assert!(recording.writes.is_empty());
    }
    assert!(fixture.calls().is_empty());
}

#[test]
fn hostile_request_identity_ordinal_shape_and_encoding_never_spawn_git() {
    let mut cases = Vec::new();
    for field in [
        "id",
        "runtimeDigest",
        "token",
        "attempt",
        "observationId",
        "inputDigest",
    ] {
        let mut value = request(1, "git");
        value[field] = "wrong".into();
        cases.push(frame(value));
    }
    cases.push(frame(request(0, "git")));
    cases.push(frame(request(2, "git")));
    cases.push(calendar_request(2));
    for field in ["args", "request", "executable"] {
        let mut value = request(1, "git");
        value[field] = Value::Null;
        cases.push(frame(value));
    }
    let ordinary = String::from_utf8(git_request()).unwrap();
    cases.push(
        ordinary
            .replacen("\"id\":", "\"id\":\"duplicate\",\"id\":", 1)
            .into_bytes(),
    );
    cases.push(ordinary.trim_end().as_bytes().to_vec());
    cases.push([git_request(), b"\n".to_vec()].concat());
    cases.push(vec![0xff, b'\n']);
    let mut oversized = request(1, "git");
    oversized["arbitrary"] = json!("x".repeat(65536));
    cases.push(frame(oversized));
    for bytes in cases {
        let fixture = Fixture::new(FOUR_QUERIES);
        let expires = Instant::now() + Duration::from_secs(3);
        let mut owner = fixture.owner(expires);
        let mut recording = Recording {
            reads: VecDeque::from([bytes]),
            ..Default::default()
        };
        open(&mut owner, &mut recording, expires);
        assert!(
            owner
                .transport(&mut recording, &|| false)
                .read(expires)
                .is_err()
        );
        assert!(fixture.calls().is_empty());
        assert!(recording.credits.is_empty());
        assert!(owner.failure().is_some());
        let reads = recording.read_count;
        assert!(
            owner
                .transport(&mut recording, &|| false)
                .read(expires)
                .is_err()
        );
        assert_eq!(recording.read_count, reads);
    }
}

#[test]
fn prepared_ready_requires_git_abort_may_close_early_and_closed_lease_rejects_replay() {
    for disposition in ["ready", "aborted"] {
        let fixture = Fixture::new(FOUR_QUERIES);
        let expires = Instant::now() + Duration::from_secs(3);
        let mut owner = fixture.owner(expires);
        let prepared = prepared(disposition);
        let mut recording = Recording {
            reads: VecDeque::from([prepared.clone(), git_request()]),
            ..Default::default()
        };
        open(&mut owner, &mut recording, expires);
        let result = owner.transport(&mut recording, &|| false).read(expires);
        if disposition == "ready" {
            assert!(result.is_err());
        } else {
            assert_eq!(result.unwrap(), prepared);
            assert!(
                owner
                    .transport(&mut recording, &|| false)
                    .read(expires)
                    .is_err()
            );
        }
        assert!(fixture.calls().is_empty());
    }
    let fixture = Fixture::new(FOUR_QUERIES);
    let expires = Instant::now() + Duration::from_secs(3);
    let mut owner = fixture.owner(expires);
    let mut recording = Recording {
        reads: VecDeque::from([git_request()]),
        ..Default::default()
    };
    assert!(
        owner
            .transport(&mut recording, &|| false)
            .read(expires)
            .is_err()
    );
    assert!(fixture.calls().is_empty());
}

#[test]
fn actual_git_failure_survives_failed_failure_write_and_explicit_custody_transfer() {
    let fixture = Fixture::new("printf admitted; /bin/sleep 30");
    let expires = Instant::now() + Duration::from_millis(900);
    let mut owner = fixture.owner(expires);
    let mut recording = Recording {
        reads: VecDeque::from([git_request()]),
        fail_schema: Some(observation::FAILURE),
        ..Default::default()
    };
    open(&mut owner, &mut recording, expires);
    assert!(
        owner
            .transport(&mut recording, &|| false)
            .read(expires)
            .is_err()
    );
    // Retain the actual failure through bounded cleanup before assertions unwind.
    let cleanup_expires = Instant::now() + Duration::from_secs(2);
    while !owner.cleanup_settled() && Instant::now() < cleanup_expires {
        let _ = owner.retry_cleanup();
        std::thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(fixture.calls().len(), 1);
    let failure = owner.failure().unwrap();
    assert_eq!(failure.category, "query");
    let git = failure.git.as_ref().unwrap();
    assert_eq!(git.stdout, b"admitted");
    assert!(git.cause.as_ref().unwrap().cleanup.pid.is_some());
    assert!(failure.cleanup_settled(), "{failure:?}");
    let original_pid = git.cause.as_ref().unwrap().cleanup.pid;
    let first_message = git.cause.as_ref().unwrap().first_message.clone();
    let reads = recording.read_count;
    assert!(
        owner
            .transport(&mut recording, &|| false)
            .read(expires + Duration::from_secs(5))
            .is_err()
    );
    assert_eq!(recording.read_count, reads);
    let mut transferred = owner.take_failure().unwrap();
    assert_eq!(
        transferred
            .git
            .as_ref()
            .unwrap()
            .cause
            .as_ref()
            .unwrap()
            .cleanup
            .pid,
        original_pid
    );
    assert_eq!(
        transferred
            .git
            .as_ref()
            .unwrap()
            .cause
            .as_ref()
            .unwrap()
            .first_message,
        first_message
    );
    assert_eq!(transferred.git.as_ref().unwrap().stdout, b"admitted");
    transferred.retry_cleanup().unwrap();
    assert!(transferred.cleanup_settled());
    assert!(owner.retry_cleanup().is_err());
    assert!(!owner.cleanup_settled());
    assert!(
        owner
            .transport(&mut recording, &|| false)
            .write(&prepare(), expires + Duration::from_secs(5))
            .is_err()
    );
    assert_eq!(fixture.calls().len(), 1);
}

#[test]
fn transport_credit_failure_and_cancel_after_git_never_reopen_or_reexecute() {
    for cancel_after_header in [false, true] {
        let fixture = Fixture::new(FOUR_QUERIES);
        let expires = Instant::now() + Duration::from_secs(3);
        let mut owner = fixture.owner(expires);
        let cancelled = Rc::new(Cell::new(false));
        let mut recording = Recording {
            reads: VecDeque::from([git_request(), git_request()]),
            fail_credit: !cancel_after_header,
            cancel_schema: cancel_after_header.then(|| (observation::RESULT, cancelled.clone())),
            ..Default::default()
        };
        open(&mut owner, &mut recording, expires);
        assert!(
            owner
                .transport(&mut recording, &|| cancelled.get())
                .read(expires)
                .is_err()
        );
        assert_eq!(fixture.calls().len(), 4);
        assert_eq!(
            owner.failure().unwrap().category,
            if cancel_after_header {
                "cancelled"
            } else {
                "transport"
            }
        );
        assert!(owner.cleanup_settled());
        cancelled.set(false);
        let reads = recording.read_count;
        assert!(
            owner
                .transport(&mut recording, &|| false)
                .read(expires)
                .is_err()
        );
        assert_eq!(recording.read_count, reads);
        assert_eq!(fixture.calls().len(), 4);
    }
}

#[test]
fn nested_calendar_duplicate_binding_and_sequence_are_rejected_without_a_second_git() {
    let valid = String::from_utf8(calendar_request(2)).unwrap();
    // Replace only the inner member, leaving the original bytes for the native
    // calendar decoder. A Value round trip would erase this counterexample.
    let duplicate = valid
        .replacen(
            "\"seconds\":[\"0\",\"-1\"]",
            "\"sequence\":1,\"seconds\":[\"0\",\"-1\"]",
            1,
        )
        .into_bytes();
    assert_ne!(duplicate, valid.as_bytes());
    let mut cases = vec![duplicate];
    for (field, replacement) in [
        ("id", json!("different-original")),
        ("sequence", json!(2)),
        ("profile", json!("unsupported")),
    ] {
        let mut value: Value = serde_json::from_slice(&calendar_request(2)).unwrap();
        value["request"][field] = replacement;
        cases.push(frame(value));
    }
    for bytes in cases {
        let fixture = Fixture::new(FOUR_QUERIES);
        let expires = Instant::now() + Duration::from_secs(3);
        let mut owner = fixture.owner(expires);
        let mut recording = Recording {
            reads: VecDeque::from([git_request(), bytes]),
            ..Default::default()
        };
        open(&mut owner, &mut recording, expires);
        assert!(
            owner
                .transport(&mut recording, &|| false)
                .read(expires)
                .is_err()
        );
        assert_eq!(fixture.calls().len(), 4);
        assert!(owner.failure().is_some());
        assert!(
            recording
                .rows()
                .iter()
                .all(|row| row["schema"] != observation::RESULT || row["operation"] != "calendar")
        );
    }
}

#[test]
fn cancellation_and_original_deadline_prevent_query_even_with_a_later_transport_deadline() {
    for cancelled in [false, true] {
        let fixture = Fixture::new(FOUR_QUERIES);
        let captured_expires = Instant::now() + Duration::from_secs(3);
        let expires = if cancelled {
            captured_expires
        } else {
            Instant::now() + Duration::from_millis(100)
        };
        let mut owner = ObservationOwner::new(
            fixture.git(captured_expires),
            captured_calendar(ID, captured_expires),
            expires,
        )
        .ok()
        .unwrap();
        let mut recording = Recording {
            reads: VecDeque::from([git_request()]),
            ..Default::default()
        };
        open(&mut owner, &mut recording, captured_expires);
        if !cancelled {
            std::thread::sleep(Duration::from_millis(110));
        }
        assert!(
            owner
                .transport(&mut recording, &|| cancelled)
                .read(captured_expires + Duration::from_secs(30))
                .is_err()
        );
        assert_eq!(
            owner.failure().unwrap().category,
            if cancelled { "cancelled" } else { "deadline" }
        );
        assert!(fixture.calls().is_empty());
        assert_eq!(recording.read_count, 0);
    }
}
