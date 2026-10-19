use super::*;
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
#[derive(Default)]
struct DirectSyncTrace {
    fail_after: Option<usize>,
    expire_after: Option<usize>,
    calls: Vec<(u64, u64)>,
}
std::thread_local! {
    static DIRECT_SYNC_TRACE: std::cell::RefCell<Option<DirectSyncTrace>> = const { std::cell::RefCell::new(None) };
}
struct DirectSyncProbe;
impl DirectSyncProbe {
    fn start(fail_after: Option<usize>, expire_after: Option<usize>) -> Self {
        DIRECT_SYNC_TRACE.with(|cell| {
            let mut slot = cell.borrow_mut();
            assert!(slot.is_none(), "direct sync probes must not overlap");
            *slot = Some(DirectSyncTrace {
                fail_after,
                expire_after,
                calls: Vec::new(),
            });
        });
        Self
    }
    fn calls(&self) -> Vec<(u64, u64)> {
        DIRECT_SYNC_TRACE.with(|cell| cell.borrow().as_ref().unwrap().calls.clone())
    }
}
impl Drop for DirectSyncProbe {
    fn drop(&mut self) {
        DIRECT_SYNC_TRACE.with(|cell| *cell.borrow_mut() = None);
    }
}
// This seam observes direct directory_at sync_fd calls, not merely the
// later Journal::sync wrapper. Each recorded call follows a real fsync.
// Faults model reported errors/deadlines, not physical power loss.
pub(super) fn after_direct_sync(fd: RawFd, expires: Instant) -> Result<()> {
    DIRECT_SYNC_TRACE.with(|cell| {
        let mut slot = cell.borrow_mut();
        let Some(trace) = slot.as_mut() else {
            return Ok(());
        };
        let duplicate = File::from(owned_fd(
            unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) },
            "duplicate observed sync descriptor",
        )?);
        let metadata = duplicate
            .metadata()
            .map_err(|error| JournalError::io("observed sync metadata", error))?;
        trace.calls.push((metadata.dev(), metadata.ino()));
        let number = trace.calls.len();
        if trace.fail_after == Some(number) {
            return Err(JournalError::io(
                "injected direct sync error after real fsync",
                io::Error::other("injected initialization sync report"),
            ));
        }
        if trace.expire_after == Some(number) {
            // Exercise the real post-syscall deadline check in sync_fd.
            thread::sleep(expires.saturating_duration_since(Instant::now()));
        }
        Ok(())
    })
}
fn soon() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
struct Fixture {
    base: PathBuf,
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let parent = std::env::var_os("CAWS_NATIVE_TEST_ARTIFACT_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let base = fs::canonicalize(parent).unwrap().join(format!(
            "caws-service-journal-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir(&base).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(
            base.join("scenario.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "test": std::thread::current().name(), "pid": std::process::id(),
                "componentOnly": true, "daemonDispatched": false
            }))
            .unwrap(),
        )
        .unwrap();
        let root = base.join("private");
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self { base, root }
    }
    fn open(&self, capacity: u16) -> Journal {
        Journal::open(&self.root, &"c".repeat(64), capacity, soon()).unwrap()
    }
    fn dir(&self) -> PathBuf {
        self.root.join("services").join("c".repeat(64))
    }
    fn record(&self, id: u64) -> PathBuf {
        self.dir().join(format!("{id:064x}.json"))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if std::env::var_os("CAWS_NATIVE_TEST_ARTIFACT_ROOT").is_some() {
            eprintln!(
                "service journal artifacts retained: {}",
                self.base.display()
            );
        } else {
            let _ = fs::remove_dir_all(&self.base);
        }
    }
}
fn identity(id: u64) -> Identity {
    Identity {
        request_id: format!("{id:064x}"),
        argument_digest: "d".repeat(64),
        project_service_key: "c".repeat(64),
        source_generation: "a".repeat(64),
        execution_image_digest: "b".repeat(64),
    }
}
fn admitted(journal: &mut Journal, id: u64) -> Operation {
    match journal
        .admit(identity(id), br#"{"args":[]}"#, soon())
        .unwrap()
    {
        Admission::Accepted {
            operation,
            duplicate: false,
        } => *operation,
        other => panic!("expected new queued admission: {other:?}"),
    }
}
fn error<T>(result: Result<T>, kind: ErrorKind) {
    match result {
        Err(error) => assert_eq!(error.kind, kind, "{error}"),
        Ok(_) => panic!("expected {kind:?}"),
    }
}
fn begin(journal: &mut Journal) -> Dispatch {
    journal
        .begin_next(&"a".repeat(64), &"b".repeat(64), soon())
        .unwrap()
        .unwrap()
}
fn ok_result() -> ReturnedResult {
    ReturnedResult::DaemonResponse {
        response: OkResponse::Value,
        served: 1,
        elapsed_ms: 0,
        cached: false,
    }
}
fn rejected(value: Admission, text: &str) {
    match value {
        Admission::Rejected(value) => {
            assert_eq!(value.admission, Rejected::Value);
            assert_eq!(value.execution, KnownNotExecuted::Value);
            assert!(value.reason.contains(text));
            assert!(value.reason.len() <= 1024);
        }
        other => panic!("expected rejection: {other:?}"),
    }
}
fn filesystem_identity(path: &Path) -> (u64, u64) {
    let metadata = fs::metadata(path).unwrap();
    (metadata.dev(), metadata.ino())
}
fn assert_retry_anchors_then_dispatch(fixture: &Fixture) {
    let probe = DirectSyncProbe::start(None, None);
    let mut journal = fixture.open(2);
    let expected = vec![
        filesystem_identity(&fixture.root.join("services")),
        filesystem_identity(&fixture.root),
        filesystem_identity(&fixture.dir()),
        filesystem_identity(&fixture.root.join("services")),
    ];
    let calls = probe.calls();
    assert!(
        calls.len() >= 4,
        "retry omitted hierarchy fsync calls: {calls:?}"
    );
    assert_eq!(&calls[..4], expected.as_slice());
    let operation = admitted(&mut journal, 1);
    let queued: Envelope = serde_json::from_slice(&fs::read(fixture.record(1)).unwrap()).unwrap();
    assert_eq!(queued.body, operation);
    assert!(matches!(
        queued.body.outcome,
        AcceptedOutcome::Queued { .. }
    ));
    let dispatch = begin(&mut journal);
    let running: Envelope = serde_json::from_slice(&fs::read(fixture.record(1)).unwrap()).unwrap();
    assert_eq!(running.body, *dispatch.operation());
    assert!(matches!(
        running.body.outcome,
        AcceptedOutcome::Running { .. }
    ));
}
#[test]
fn initialization_sync_failure_reopens_visible_directories_and_resyncs_all_ancestors() {
    // First services-child/parent, then service-key-child/parent. Failures
    // leave actual directory names visible. Every retry must redo both
    // child and parent syncs even where mkdir no longer runs.
    for failed_call in 1..=4 {
        let fixture = Fixture::new();
        let probe = DirectSyncProbe::start(Some(failed_call), None);
        error(
            Journal::open(&fixture.root, &"c".repeat(64), 2, soon()),
            ErrorKind::Io,
        );
        assert_eq!(probe.calls().len(), failed_call);
        assert!(fixture.root.join("services").is_dir());
        assert!(!fixture.record(1).exists());
        drop(probe);
        assert_retry_anchors_then_dispatch(&fixture);
    }
}
#[test]
fn initialization_deadline_after_real_directory_sync_is_reanchored_on_retry() {
    let fixture = Fixture::new();
    let probe = DirectSyncProbe::start(None, Some(1));
    error(
        Journal::open(
            &fixture.root,
            &"c".repeat(64),
            2,
            Instant::now() + Duration::from_millis(100),
        ),
        ErrorKind::Deadline,
    );
    assert_eq!(probe.calls().len(), 1);
    assert!(fixture.root.join("services").is_dir());
    assert!(!fixture.record(1).exists());
    drop(probe);
    assert_retry_anchors_then_dispatch(&fixture);
}
#[test]
fn platform_mode_constants_are_converted_to_metadata_mode_width() {
    let fixture = Fixture::new();
    let journal = fixture.open(1);
    let metadata = journal.lock.metadata().unwrap();
    assert_eq!(
        metadata.mode() & metadata_mode_bits(libc::S_IFMT),
        metadata_mode_bits(libc::S_IFREG)
    );
    assert!(file_shape(metadata.uid(), metadata.mode(), metadata.nlink()).is_ok());
    error(
        file_shape(metadata.uid(), metadata_mode_bits(libc::S_IFDIR) | 0o600, 1),
        ErrorKind::UnsafePath,
    );
}
#[test]
fn queued_recovery_duplicate_identity_and_exact_payload_do_not_redispatch() {
    let fixture = Fixture::new();
    let mut journal = fixture.open(3);
    let first = admitted(&mut journal, 1);
    assert!(matches!(first.outcome(), AcceptedOutcome::Queued { .. }));
    match journal
        .admit(identity(1), br#"{"args":[]}"#, soon())
        .unwrap()
    {
        Admission::Accepted {
            operation,
            duplicate: true,
        } => assert_eq!(*operation, first),
        other => panic!("{other:?}"),
    }
    for field in 0..4 {
        let mut changed = identity(1);
        match field {
            0 => changed.argument_digest = "e".repeat(64),
            1 => changed.source_generation = "e".repeat(64),
            2 => changed.execution_image_digest = "e".repeat(64),
            _ => changed.project_service_key = "e".repeat(64),
        }
        rejected(
            journal.admit(changed, br#"{"args":[]}"#, soon()).unwrap(),
            if field == 3 {
                "invalid identity"
            } else {
                "collision"
            },
        );
    }
    rejected(
        journal
            .admit(identity(1), br#"{"args":["changed"]}"#, soon())
            .unwrap(),
        "collision",
    );
    drop(journal);
    let mut reopened = fixture.open(3);
    assert_eq!(
        reopened.lookup(&identity(1).request_id, soon()).unwrap(),
        Some(first)
    );
    let permit = begin(&mut reopened);
    assert_eq!(permit.operation().identity(), &identity(1));
    assert_eq!(
        permit.operation().verified_request().unwrap(),
        br#"{"args":[]}"#
    );
    error(
        reopened.begin_next(&"a".repeat(64), &"b".repeat(64), soon()),
        ErrorKind::Fenced,
    );
}
#[test]
fn post_dispatch_restart_is_unknown_and_fences_other_generations_and_capacity() {
    let fixture = Fixture::new();
    let mut journal = fixture.open(2);
    admitted(&mut journal, 1);
    let mut other = identity(2);
    other.source_generation = "e".repeat(64);
    assert!(matches!(
        journal.admit(other, b"{}", soon()).unwrap(),
        Admission::Accepted {
            duplicate: false,
            ..
        }
    ));
    let _permit = begin(&mut journal);
    drop(journal);
    let mut reopened = fixture.open(2);
    assert!(matches!(
        reopened
            .lookup(&identity(1).request_id, soon())
            .unwrap()
            .unwrap()
            .outcome(),
        AcceptedOutcome::Unknown { .. }
    ));
    error(
        reopened.begin_next(&"e".repeat(64), &"b".repeat(64), soon()),
        ErrorKind::Fenced,
    );
    rejected(
        reopened.admit(identity(3), b"{}", soon()).unwrap(),
        "capacity exhausted",
    );
    assert!(
        fixture.record(1).exists() && fixture.record(2).exists() && !fixture.record(3).exists()
    );
}
#[test]
fn returned_is_observed_result_separate_from_optional_artifact_and_survives_duplicate() {
    let fixture = Fixture::new();
    let mut journal = fixture.open(1);
    admitted(&mut journal, 1);
    let permit = begin(&mut journal);
    let returned = journal
        .returned(&permit, ok_result(), None, soon())
        .unwrap();
    assert_eq!(
        returned.outcome(),
        &AcceptedOutcome::Returned {
            admission: Accepted::Value,
            result: ok_result(),
            artifact_manifest_digest: None
        }
    );
    assert!(
        journal
            .begin_next(&"a".repeat(64), &"b".repeat(64), soon())
            .unwrap()
            .is_none()
    );
    error(journal.unknown(&permit, soon()), ErrorKind::Invalid);
    drop(journal);
    let mut journal = fixture.open(1);
    match journal
        .admit(identity(1), br#"{"args":[]}"#, soon())
        .unwrap()
    {
        Admission::Accepted {
            operation,
            duplicate: true,
        } => assert_eq!(*operation, returned),
        other => panic!("{other:?}"),
    }
    rejected(
        journal.admit(identity(2), b"{}", soon()).unwrap(),
        "capacity exhausted",
    );
}
#[test]
fn lifetime_lock_and_exact_queued_order_cross_source_generations() {
    let fixture = Fixture::new();
    let mut journal = fixture.open(3);
    admitted(&mut journal, 1);
    let mut next = identity(2);
    next.source_generation = "e".repeat(64);
    journal.admit(next, b"{}", soon()).unwrap();
    error(
        Journal::open(
            &fixture.root,
            &"c".repeat(64),
            3,
            Instant::now() + Duration::from_millis(20),
        ),
        ErrorKind::Busy,
    );
    error(
        journal.begin_next(&"e".repeat(64), &"b".repeat(64), soon()),
        ErrorKind::SourceMismatch,
    );
    let first = begin(&mut journal);
    assert_eq!(first.operation().sequence(), 1);
    journal
        .returned(
            &first,
            ReturnedResult::ProcessExit {
                code: Some(7),
                signal: None,
            },
            Some("f".repeat(64)),
            soon(),
        )
        .unwrap();
    let next = journal
        .begin_next(&"e".repeat(64), &"b".repeat(64), soon())
        .unwrap()
        .unwrap();
    assert_eq!(next.operation().sequence(), 2);
    assert_eq!(
        next.operation().identity().request_id,
        identity(2).request_id
    );
}
#[test]
fn failed_running_sync_never_returns_dispatch_and_poisons_handle() {
    for offset in [1, 2] {
        let fixture = Fixture::new();
        let mut journal = fixture.open(2);
        admitted(&mut journal, 1);
        journal.fail_sync = Some(journal.sync_count + offset);
        let failure = journal
            .begin_next(&"a".repeat(64), &"b".repeat(64), soon())
            .unwrap_err();
        assert_eq!(failure.kind, ErrorKind::Io);
        assert_eq!(failure.publication_may_have_happened, offset == 2);
        error(
            journal.lookup(&identity(1).request_id, soon()),
            ErrorKind::Poisoned,
        );
        drop(journal);
        let mut reopened = fixture.open(2);
        if offset == 1 {
            // No permit escaped, so no daemon write was allowed. The old
            // queued record is safe to execute after a failed publication.
            assert!(matches!(
                reopened
                    .lookup(&identity(1).request_id, soon())
                    .unwrap()
                    .unwrap()
                    .outcome(),
                AcceptedOutcome::Queued { .. }
            ));
            assert!(
                reopened
                    .begin_next(&"a".repeat(64), &"b".repeat(64), soon())
                    .unwrap()
                    .is_some()
            );
        } else {
            assert!(matches!(
                reopened
                    .lookup(&identity(1).request_id, soon())
                    .unwrap()
                    .unwrap()
                    .outcome(),
                AcceptedOutcome::Unknown { .. }
            ));
            error(
                reopened.begin_next(&"a".repeat(64), &"b".repeat(64), soon()),
                ErrorKind::Fenced,
            );
        }
    }
}
#[test]
fn failed_admission_sync_never_acknowledges_acceptance_or_allows_handle_reuse() {
    for offset in [1, 2] {
        let fixture = Fixture::new();
        let mut journal = fixture.open(2);
        journal.fail_sync = Some(journal.sync_count + offset);
        let failure = journal.admit(identity(1), b"{}", soon()).unwrap_err();
        assert_eq!(failure.kind, ErrorKind::Io);
        assert_eq!(failure.publication_may_have_happened, offset == 2);
        error(
            journal.lookup(&identity(1).request_id, soon()),
            ErrorKind::Poisoned,
        );
        drop(journal);
        let mut reopened = fixture.open(2);
        if offset == 1 {
            assert!(
                reopened
                    .lookup(&identity(1).request_id, soon())
                    .unwrap()
                    .is_none()
            );
            assert!(!fixture.record(1).exists());
        } else {
            assert!(matches!(
                reopened
                    .lookup(&identity(1).request_id, soon())
                    .unwrap()
                    .unwrap()
                    .outcome(),
                AcceptedOutcome::Queued { .. }
            ));
            assert!(matches!(
                reopened.admit(identity(1), b"{}", soon()).unwrap(),
                Admission::Accepted {
                    duplicate: true,
                    ..
                }
            ));
        }
    }
}
#[test]
fn explicit_unknown_is_durable_and_cannot_be_completed_by_an_old_permit() {
    let fixture = Fixture::new();
    let mut journal = fixture.open(2);
    admitted(&mut journal, 1);
    let permit = begin(&mut journal);
    assert!(matches!(
        journal.unknown(&permit, soon()).unwrap().outcome(),
        AcceptedOutcome::Unknown { .. }
    ));
    error(
        journal.returned(&permit, ok_result(), None, soon()),
        ErrorKind::Invalid,
    );
    error(
        journal.begin_next(&"e".repeat(64), &"f".repeat(64), soon()),
        ErrorKind::Fenced,
    );
    drop(journal);
    let mut reopened = fixture.open(2);
    match reopened
        .admit(identity(1), br#"{"args":[]}"#, soon())
        .unwrap()
    {
        Admission::Accepted {
            operation,
            duplicate: true,
        } => assert!(matches!(
            operation.outcome(),
            AcceptedOutcome::Unknown { .. }
        )),
        other => panic!("{other:?}"),
    }
    error(
        reopened.begin_next(&"a".repeat(64), &"b".repeat(64), soon()),
        ErrorKind::Fenced,
    );
}
#[test]
fn uncertain_finish_reopens_unknown_or_actual_returned_never_queued() {
    for offset in [1, 2] {
        let fixture = Fixture::new();
        let mut journal = fixture.open(1);
        admitted(&mut journal, 1);
        let permit = begin(&mut journal);
        journal.fail_sync = Some(journal.sync_count + offset);
        let failure = journal
            .returned(&permit, ok_result(), None, soon())
            .unwrap_err();
        assert_eq!(failure.publication_may_have_happened, offset == 2);
        error(
            journal.admit(identity(2), b"{}", soon()),
            ErrorKind::Poisoned,
        );
        drop(journal);
        let mut reopened = fixture.open(1);
        let operation = reopened
            .lookup(&identity(1).request_id, soon())
            .unwrap()
            .unwrap();
        if offset == 1 {
            assert!(matches!(
                operation.outcome(),
                AcceptedOutcome::Unknown { .. }
            ));
            error(
                reopened.begin_next(&"a".repeat(64), &"b".repeat(64), soon()),
                ErrorKind::Fenced,
            );
        } else {
            assert_eq!(
                operation.outcome(),
                &AcceptedOutcome::Returned {
                    admission: Accepted::Value,
                    result: ok_result(),
                    artifact_manifest_digest: None
                }
            );
            assert!(
                reopened
                    .begin_next(&"a".repeat(64), &"b".repeat(64), soon())
                    .unwrap()
                    .is_none()
            );
        }
    }
}
#[test]
fn rejected_inputs_capacity_and_sequence_overflow_create_no_false_acceptance() {
    let fixture = Fixture::new();
    let mut journal = fixture.open(2);
    rejected(
        journal
            .admit(
                identity(1),
                &vec![0; MAX_VERIFIED_REQUEST_BYTES + 1],
                soon(),
            )
            .unwrap(),
        "byte bound",
    );
    assert!(!fixture.record(1).exists());
    let operation = admitted(&mut journal, 1);
    drop(journal);
    let mut maxed = operation;
    maxed.sequence = u64::MAX;
    fs::write(fixture.record(1), encode(&maxed).unwrap()).unwrap();
    let mut journal = fixture.open(2);
    rejected(
        journal.admit(identity(2), b"{}", soon()).unwrap(),
        "sequence exhausted",
    );
    assert!(!fixture.record(2).exists());
    assert_eq!(
        journal
            .lookup(&identity(1).request_id, soon())
            .unwrap()
            .unwrap()
            .sequence(),
        u64::MAX
    );
}
#[test]
fn short_malformed_oversized_and_changed_checksums_fail_closed() {
    for kind in 0..5 {
        let fixture = Fixture::new();
        let mut journal = fixture.open(1);
        admitted(&mut journal, 1);
        drop(journal);
        let bytes = match kind {
            0 => Vec::new(),
            1 => b"{".to_vec(),
            2 => vec![b'x'; MAX_RECORD_BYTES + 1],
            3 => {
                let mut value: serde_json::Value =
                    serde_json::from_slice(&fs::read(fixture.record(1)).unwrap()).unwrap();
                value["body"]["outcome"]["execution"] = "running".into();
                serde_json::to_vec(&value).unwrap()
            }
            _ => {
                let mut value: serde_json::Value =
                    serde_json::from_slice(&fs::read(fixture.record(1)).unwrap()).unwrap();
                value["body"]["verifiedRequestBase64"] = STANDARD.encode(b"changed").into();
                serde_json::to_vec(&value).unwrap()
            }
        };
        fs::write(fixture.record(1), &bytes).unwrap();
        error(
            Journal::open(&fixture.root, &"c".repeat(64), 1, soon()),
            ErrorKind::Corrupt,
        );
        assert_eq!(fs::read(fixture.record(1)).unwrap(), bytes);
    }
}
#[test]
fn closed_result_schema_rejects_missing_extra_and_invalid_values() {
    for value in [
        serde_json::json!({"kind":"process_exit","code":0}),
        serde_json::json!({"kind":"process_exit","code":null,"signal":null}),
        serde_json::json!({"kind":"process_exit","code":0,"signal":15}),
        serde_json::json!({"kind":"process_exit","code":null,"signal":0}),
        serde_json::json!({"kind":"process_exit","code":null,"signal":128}),
        serde_json::json!({"kind":"process_exit","code":256,"signal":null}),
        serde_json::json!({"kind":"daemon_response","response":"ok","served":0,"elapsedMs":0,"cached":false}),
        serde_json::json!({"kind":"daemon_response","response":"ok","served":1,"elapsedMs":9007199254740992u64,"cached":false}),
        serde_json::json!({"kind":"daemon_response","response":"ok","served":1,"elapsedMs":0,"cached":false,"workerExit":0}),
    ] {
        let invalid = serde_json::from_value::<ReturnedResult>(value.clone())
            .map_or(true, |result| !result.valid());
        assert!(invalid, "accepted invalid result: {value}");
    }
    for value in [
        serde_json::json!({"admission":"accepted","execution":"queued","workerExit":0}),
        serde_json::json!({"admission":"accepted","execution":"returned","result":{"kind":"daemon_response","response":"ok","served":1,"elapsedMs":0,"cached":false}}),
    ] {
        assert!(serde_json::from_value::<AcceptedOutcome>(value).is_err());
    }
}
#[test]
fn symlink_shared_mode_hardlink_and_foreign_owner_shape_are_rejected() {
    for kind in 0..4 {
        let fixture = Fixture::new();
        let mut journal = fixture.open(1);
        admitted(&mut journal, 1);
        drop(journal);
        match kind {
            0 => {
                let other = fixture.base.join("other");
                fs::rename(fixture.record(1), &other).unwrap();
                symlink(other, fixture.record(1)).unwrap();
            }
            1 => fs::set_permissions(fixture.record(1), fs::Permissions::from_mode(0o644)).unwrap(),
            2 => {
                fs::hard_link(fixture.record(1), fixture.base.join("other-link")).unwrap();
            }
            _ => fs::set_permissions(&fixture.root, fs::Permissions::from_mode(0o750)).unwrap(),
        }
        error(
            Journal::open(&fixture.root, &"c".repeat(64), 1, soon()),
            ErrorKind::UnsafePath,
        );
    }
    let fixture = Fixture::new();
    let journal = fixture.open(1);
    let metadata = journal.lock.metadata().unwrap();
    assert!(file_shape(metadata.uid(), metadata.mode(), metadata.nlink()).is_ok());
    error(
        file_shape(
            metadata.uid().wrapping_add(1),
            metadata.mode(),
            metadata.nlink(),
        ),
        ErrorKind::UnsafePath,
    );
}
#[test]
fn symlink_root_and_invalid_capacity_never_create_a_journal() {
    let fixture = Fixture::new();
    let alias = fixture.base.join("alias");
    symlink(&fixture.root, &alias).unwrap();
    error(
        Journal::open(&alias, &"c".repeat(64), 1, soon()),
        ErrorKind::UnsafePath,
    );
    for capacity in [0, MAX_RETAINED_RECORDS + 1] {
        error(
            Journal::open(&fixture.root, &"c".repeat(64), capacity, soon()),
            ErrorKind::Invalid,
        );
    }
    assert!(!fixture.root.join("services").exists());
}
#[test]
fn replaced_lock_changed_capacity_deadline_and_live_tampering_do_not_authorize_dispatch() {
    let fixture = Fixture::new();
    let mut journal = fixture.open(2);
    admitted(&mut journal, 1);
    error(
        journal.begin_next(&"a".repeat(64), &"b".repeat(64), Instant::now()),
        ErrorKind::Deadline,
    );
    fs::write(fixture.record(1), b"broken").unwrap();
    error(
        journal.begin_next(&"a".repeat(64), &"b".repeat(64), soon()),
        ErrorKind::UnsafePath,
    );
    drop(journal);
    error(
        Journal::open(&fixture.root, &"c".repeat(64), 1, soon()),
        ErrorKind::Corrupt,
    );
    let fixture = Fixture::new();
    let mut journal = fixture.open(1);
    admitted(&mut journal, 1);
    fs::rename(
        fixture.dir().join(".journal.lock"),
        fixture.dir().join("old-lock"),
    )
    .unwrap();
    fs::write(fixture.dir().join(".journal.lock"), b"").unwrap();
    fs::set_permissions(
        fixture.dir().join(".journal.lock"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    error(
        journal.begin_next(&"a".repeat(64), &"b".repeat(64), soon()),
        ErrorKind::UnsafePath,
    );
}
#[test]
fn abandoned_unpublished_temporary_never_becomes_an_accepted_operation() {
    let fixture = Fixture::new();
    let mut journal = fixture.open(2);
    let first = admitted(&mut journal, 1);
    drop(journal);
    fs::write(
        fixture.dir().join(".operation.tmp"),
        b"incomplete unpublished bytes",
    )
    .unwrap();
    fs::set_permissions(
        fixture.dir().join(".operation.tmp"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let journal = fixture.open(2);
    assert_eq!(
        journal.lookup(&identity(1).request_id, soon()).unwrap(),
        Some(first)
    );
    assert!(
        journal
            .lookup(&identity(2).request_id, soon())
            .unwrap()
            .is_none()
    );
    assert!(!fixture.dir().join(".operation.tmp").exists());
}

fn cancellation_disk_snapshot(
    fixture: &Fixture,
) -> std::collections::BTreeMap<String, (Vec<u8>, Stamp)> {
    fs::read_dir(fixture.dir())
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            let metadata = fs::symlink_metadata(entry.path()).unwrap();
            assert!(metadata.is_file());
            (
                entry.file_name().into_string().unwrap(),
                (fs::read(entry.path()).unwrap(), Stamp::of(&metadata)),
            )
        })
        .collect()
}

fn cancellation_json(reason: CancelReason) -> serde_json::Value {
    let reason = match reason {
        CancelReason::SourceRetired => "source_retired",
        CancelReason::GrantWithdrawn => "grant_withdrawn",
    };
    serde_json::json!({
        "admission": "accepted",
        "execution": "cancelled_before_dispatch",
        "reason": reason
    })
}

#[test]
fn cancelled_schema_is_closed_and_retains_accepted_nonexecution_semantics() {
    for reason in [CancelReason::SourceRetired, CancelReason::GrantWithdrawn] {
        let outcome = AcceptedOutcome::CancelledBeforeDispatch {
            admission: Accepted::Value,
            reason,
        };
        let json = serde_json::to_value(&outcome).unwrap();
        assert_eq!(json, cancellation_json(reason));
        assert_eq!(
            serde_json::from_value::<AcceptedOutcome>(json).unwrap(),
            outcome
        );
        assert!(!outcome.fenced());
    }
    for value in [
        serde_json::json!({"admission":"accepted","execution":"cancelled_before_dispatch"}),
        serde_json::json!({"admission":"rejected","execution":"cancelled_before_dispatch","reason":"source_retired"}),
        serde_json::json!({"admission":"accepted","execution":"cancelled_before_dispatch","reason":null}),
        serde_json::json!({"admission":"accepted","execution":"cancelled_before_dispatch","reason":"future_reason"}),
        serde_json::json!({"admission":"accepted","execution":"cancelled_before_dispatch","reason":"source_retired","result":{"kind":"process_exit","code":0,"signal":null}}),
        serde_json::json!({"admission":"accepted","execution":"cancelled_before_dispatch","reason":"grant_withdrawn","artifactManifestDigest":null}),
        serde_json::json!({"admission":"accepted","execution":"cancelled_before_dispatch","reason":"source_retired","allowInlineFallback":true}),
    ] {
        assert!(
            serde_json::from_value::<AcceptedOutcome>(value.clone()).is_err(),
            "accepted invalid cancellation: {value}"
        );
    }
}

#[test]
fn queued_cancellation_is_durable_idempotent_and_retains_replay_tombstone() {
    for reason in [CancelReason::SourceRetired, CancelReason::GrantWithdrawn] {
        let fixture = Fixture::new();
        let mut journal = fixture.open(1);
        let original = admitted(&mut journal, 1);
        let before = cancellation_disk_snapshot(&fixture);
        let cancelled = journal
            .cancel_queued(&identity(1).request_id, reason, soon())
            .unwrap();
        assert_eq!(cancelled.identity(), original.identity());
        assert_eq!(cancelled.sequence(), original.sequence());
        assert_eq!(cancelled.verified_request().unwrap(), br#"{"args":[]}"#);
        assert_eq!(
            serde_json::to_value(cancelled.outcome()).unwrap(),
            cancellation_json(reason)
        );
        let bytes = fs::read(fixture.record(1)).unwrap();
        let envelope: Envelope = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(envelope.schema, RECORD_SCHEMA);
        assert_eq!(envelope.body, cancelled);
        assert_eq!(
            envelope.body_sha256,
            hash(&serde_json::to_vec(&envelope.body).unwrap())
        );
        let disk_json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(disk_json["body"]["outcome"], cancellation_json(reason));
        assert_eq!(disk_json["body"]["sequence"], serde_json::json!(1));
        let after = cancellation_disk_snapshot(&fixture);
        let record = format!("{:064x}.json", 1);
        for (name, previous) in &before {
            if name != &record {
                assert_eq!(after.get(name), Some(previous));
            }
        }
        assert_ne!(
            before.get(&record).unwrap().1.inode,
            after.get(&record).unwrap().1.inode
        );
        let sync_count = journal.sync_count;
        assert_eq!(
            journal
                .cancel_queued(&identity(1).request_id, reason, soon())
                .unwrap(),
            cancelled
        );
        assert_eq!(journal.sync_count, sync_count);
        assert_eq!(cancellation_disk_snapshot(&fixture), after);
        let conflicting = match reason {
            CancelReason::SourceRetired => CancelReason::GrantWithdrawn,
            CancelReason::GrantWithdrawn => CancelReason::SourceRetired,
        };
        error(
            journal.cancel_queued(&identity(1).request_id, conflicting, soon()),
            ErrorKind::Invalid,
        );
        assert_eq!(cancellation_disk_snapshot(&fixture), after);
        drop(journal);
        let mut reopened = fixture.open(1);
        assert_eq!(
            reopened.lookup(&identity(1).request_id, soon()).unwrap(),
            Some(cancelled.clone())
        );
        match reopened
            .admit(identity(1), br#"{"args":[]}"#, soon())
            .unwrap()
        {
            Admission::Accepted {
                operation,
                duplicate: true,
            } => assert_eq!(*operation, cancelled),
            other => panic!("expected retained cancellation: {other:?}"),
        }
        assert!(
            reopened
                .begin_next(&"a".repeat(64), &"b".repeat(64), soon())
                .unwrap()
                .is_none()
        );
        rejected(
            reopened.admit(identity(2), b"{}", soon()).unwrap(),
            "capacity exhausted",
        );
        assert!(fixture.record(1).exists());
        assert!(!fixture.record(2).exists());
    }
}

#[test]
fn cancelled_queue_head_allows_next_generation_without_reordering_sequences() {
    let fixture = Fixture::new();
    let mut journal = fixture.open(3);
    admitted(&mut journal, 1);
    let mut next = identity(2);
    next.source_generation = "e".repeat(64);
    next.execution_image_digest = "f".repeat(64);
    assert!(matches!(
        journal.admit(next.clone(), b"next", soon()).unwrap(),
        Admission::Accepted {
            duplicate: false,
            ..
        }
    ));
    error(
        journal.begin_next(
            &next.source_generation,
            &next.execution_image_digest,
            soon(),
        ),
        ErrorKind::SourceMismatch,
    );
    let cancelled = journal
        .cancel_queued(&identity(1).request_id, CancelReason::SourceRetired, soon())
        .unwrap();
    assert_eq!(cancelled.sequence(), 1);
    let dispatch = journal
        .begin_next(
            &next.source_generation,
            &next.execution_image_digest,
            soon(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(dispatch.operation().identity(), &next);
    assert_eq!(dispatch.operation().sequence(), 2);
    assert_eq!(dispatch.operation().verified_request().unwrap(), b"next");
    assert_eq!(
        journal.lookup(&identity(1).request_id, soon()).unwrap(),
        Some(cancelled)
    );
    let mut third = identity(3);
    third.source_generation = next.source_generation.clone();
    third.execution_image_digest = next.execution_image_digest.clone();
    assert!(matches!(
        journal.admit(third, b"third", soon()).unwrap(),
        Admission::Accepted {
            duplicate: false,
            ..
        }
    ));
    assert_eq!(
        journal
            .lookup(&identity(3).request_id, soon())
            .unwrap()
            .unwrap()
            .sequence(),
        3
    );
}

#[test]
fn cancelling_queued_tail_never_clears_an_unknown_head_fence() {
    let fixture = Fixture::new();
    let mut journal = fixture.open(2);
    admitted(&mut journal, 1);
    admitted(&mut journal, 2);
    let dispatch = begin(&mut journal);
    let unknown = journal.unknown(&dispatch, soon()).unwrap();
    let unknown_bytes = fs::read(fixture.record(1)).unwrap();
    let unknown_stamp = Stamp::of(&fs::metadata(fixture.record(1)).unwrap());
    let cancelled = journal
        .cancel_queued(
            &identity(2).request_id,
            CancelReason::GrantWithdrawn,
            soon(),
        )
        .unwrap();
    assert_eq!(cancelled.sequence(), 2);
    assert_eq!(fs::read(fixture.record(1)).unwrap(), unknown_bytes);
    assert_eq!(
        Stamp::of(&fs::metadata(fixture.record(1)).unwrap()),
        unknown_stamp
    );
    error(
        journal.begin_next(&"a".repeat(64), &"b".repeat(64), soon()),
        ErrorKind::Fenced,
    );
    drop(journal);
    let mut reopened = fixture.open(2);
    assert_eq!(
        reopened.lookup(&identity(1).request_id, soon()).unwrap(),
        Some(unknown)
    );
    assert_eq!(
        reopened.lookup(&identity(2).request_id, soon()).unwrap(),
        Some(cancelled)
    );
    error(
        reopened.begin_next(&"e".repeat(64), &"f".repeat(64), soon()),
        ErrorKind::Fenced,
    );
}

#[test]
fn cancellation_cannot_reclassify_running_unknown_or_returned_and_writes_nothing() {
    for state in ["running", "unknown", "returned"] {
        let fixture = Fixture::new();
        let mut journal = fixture.open(2);
        admitted(&mut journal, 1);
        admitted(&mut journal, 2);
        let dispatch = begin(&mut journal);
        if state == "unknown" {
            journal.unknown(&dispatch, soon()).unwrap();
        } else if state == "returned" {
            journal
                .returned(&dispatch, ok_result(), None, soon())
                .unwrap();
        }
        let original = journal.lookup(&identity(1).request_id, soon()).unwrap();
        let before = cancellation_disk_snapshot(&fixture);
        for reason in [CancelReason::SourceRetired, CancelReason::GrantWithdrawn] {
            error(
                journal.cancel_queued(&identity(1).request_id, reason, soon()),
                ErrorKind::Invalid,
            );
            assert_eq!(cancellation_disk_snapshot(&fixture), before);
            assert_eq!(
                journal.lookup(&identity(1).request_id, soon()).unwrap(),
                original
            );
        }
        if state == "returned" {
            let next = begin(&mut journal);
            assert_eq!(next.operation().sequence(), 2);
        } else {
            error(
                journal.begin_next(&"a".repeat(64), &"b".repeat(64), soon()),
                ErrorKind::Fenced,
            );
        }
    }
}

#[test]
fn invalid_missing_or_expired_cancellation_does_not_write_or_poison_queue() {
    let fixture = Fixture::new();
    let mut journal = fixture.open(1);
    admitted(&mut journal, 1);
    let before = cancellation_disk_snapshot(&fixture);
    error(
        journal.cancel_queued("not-a-digest", CancelReason::SourceRetired, soon()),
        ErrorKind::Invalid,
    );
    error(
        journal.cancel_queued(&identity(9).request_id, CancelReason::SourceRetired, soon()),
        ErrorKind::Invalid,
    );
    error(
        journal.cancel_queued(
            &identity(1).request_id,
            CancelReason::SourceRetired,
            Instant::now(),
        ),
        ErrorKind::Deadline,
    );
    assert_eq!(cancellation_disk_snapshot(&fixture), before);
    assert!(matches!(
        journal
            .cancel_queued(&identity(1).request_id, CancelReason::SourceRetired, soon())
            .unwrap()
            .outcome(),
        AcceptedOutcome::CancelledBeforeDispatch { .. }
    ));
}

#[test]
fn idempotent_cancellation_refuses_changed_persisted_bytes_without_repairing_them() {
    let fixture = Fixture::new();
    let mut journal = fixture.open(1);
    admitted(&mut journal, 1);
    journal
        .cancel_queued(&identity(1).request_id, CancelReason::SourceRetired, soon())
        .unwrap();
    fs::write(fixture.record(1), b"corrupt retained cancellation").unwrap();
    let before = cancellation_disk_snapshot(&fixture);
    error(
        journal.cancel_queued(&identity(1).request_id, CancelReason::SourceRetired, soon()),
        ErrorKind::UnsafePath,
    );
    assert_eq!(cancellation_disk_snapshot(&fixture), before);
    drop(journal);
    error(
        Journal::open(&fixture.root, &"c".repeat(64), 1, soon()),
        ErrorKind::Corrupt,
    );
    assert_eq!(
        fs::read(fixture.record(1)).unwrap(),
        b"corrupt retained cancellation"
    );
}

#[test]
fn failed_cancellation_sync_never_acknowledges_and_poisoned_handle_cannot_dispatch() {
    for offset in [1, 2] {
        let fixture = Fixture::new();
        let mut journal = fixture.open(1);
        let original = admitted(&mut journal, 1);
        let queued_bytes = fs::read(fixture.record(1)).unwrap();
        journal.fail_sync = Some(journal.sync_count + offset);
        let failure = journal
            .cancel_queued(&identity(1).request_id, CancelReason::SourceRetired, soon())
            .unwrap_err();
        assert_eq!(failure.kind, ErrorKind::Io);
        assert_eq!(failure.publication_may_have_happened, offset == 2);
        let observed_bytes = fs::read(fixture.record(1)).unwrap();
        let observed: Envelope = serde_json::from_slice(&observed_bytes).unwrap();
        if offset == 1 {
            assert_eq!(observed_bytes, queued_bytes);
            assert!(matches!(
                observed.body.outcome(),
                AcceptedOutcome::Queued { .. }
            ));
        } else {
            assert_eq!(
                serde_json::to_value(observed.body.outcome()).unwrap(),
                cancellation_json(CancelReason::SourceRetired)
            );
        }
        let before = cancellation_disk_snapshot(&fixture);
        error(
            journal.lookup(&identity(1).request_id, soon()),
            ErrorKind::Poisoned,
        );
        error(
            journal.cancel_queued(&identity(1).request_id, CancelReason::SourceRetired, soon()),
            ErrorKind::Poisoned,
        );
        error(
            journal.begin_next(&"a".repeat(64), &"b".repeat(64), soon()),
            ErrorKind::Poisoned,
        );
        assert_eq!(cancellation_disk_snapshot(&fixture), before);
        drop(journal);
        let mut reopened = fixture.open(1);
        let recovered = reopened
            .lookup(&identity(1).request_id, soon())
            .unwrap()
            .unwrap();
        assert_eq!(recovered.identity(), original.identity());
        assert_eq!(recovered.sequence(), original.sequence());
        assert_eq!(
            recovered.verified_request().unwrap(),
            original.verified_request().unwrap()
        );
        if offset == 1 {
            assert!(matches!(
                recovered.outcome(),
                AcceptedOutcome::Queued { .. }
            ));
        } else {
            assert_eq!(
                serde_json::to_value(recovered.outcome()).unwrap(),
                cancellation_json(CancelReason::SourceRetired)
            );
        }
        // A recovered retired queue item must be cancelled, not dispatched.
        let cancelled = reopened
            .cancel_queued(&identity(1).request_id, CancelReason::SourceRetired, soon())
            .unwrap();
        assert_eq!(
            serde_json::to_value(cancelled.outcome()).unwrap(),
            cancellation_json(CancelReason::SourceRetired)
        );
        match reopened
            .admit(identity(1), br#"{"args":[]}"#, soon())
            .unwrap()
        {
            Admission::Accepted {
                operation,
                duplicate: true,
            } => assert_eq!(*operation, cancelled),
            other => panic!("expected cancelled duplicate after recovery: {other:?}"),
        }
        assert!(
            reopened
                .begin_next(&"a".repeat(64), &"b".repeat(64), soon())
                .unwrap()
                .is_none()
        );
    }
}
