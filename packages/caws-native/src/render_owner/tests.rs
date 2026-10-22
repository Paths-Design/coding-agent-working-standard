use super::observations::{OBSERVATION_MAX_BYTES, OBSERVATION_MAX_RECORD};
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("caws-owner-unit-{}", random().unwrap()));
        private_dir(&path, true).unwrap();
        Self(path)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn expires() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
fn config(s: &Scratch) -> OwnerConfig {
    let source = s.0.join("trusted-source");
    fs::write(&source, b"owner fixture").unwrap();
    fs::set_permissions(&source, fs::Permissions::from_mode(0o600)).unwrap();
    private_dir(&s.0.join("state"), true).unwrap();
    OwnerConfig {
        schema: CONFIG_SCHEMA.into(),
        home: s.0.clone(),
        client_root: s.0.clone(),
        template_root: s.0.clone(),
        client_shell_source: source.clone(),
        native_executable: source,
        limits: OwnerLimits {
            max_connections: 4,
            max_projects: 3,
            max_backends: 2,
            max_queue_per_project: 2,
            max_frame_bytes: 1_048_576,
            max_retained_records: 8,
            first_frame_ms: 1000,
            request_ms: 2000,
            startup_ms: 1000,
            idle_ms: 2000,
            backend_idle_seconds: 30,
            cache_megabytes: 1,
            worker: backend::WorkerLimits {
                startup_ms: 1000,
                connect_ms: 1000,
                write_ms: 1000,
                render_ms: 1000,
                read_ms: 1000,
                cleanup_ms: 1000,
            },
        },
    }
}
fn request() -> wire::RenderRequest {
    let corpus: serde_json::Value =
        serde_json::from_slice(include_bytes!("../service_protocol/fixtures.json")).unwrap();
    wire::decode_render_request(
        &STANDARD
            .decode(corpus["request"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap()
}
fn offered() -> Offer {
    let selection = serde_json::json!({"canonicalProject":"/project","surface":"codex","event":"Stop",
        "configuration":"full","runtimeDigest":"a".repeat(64),"selectedIndex":0,"handlers":[{
            "path":"/project/.caws/hooks/session-log.sh","sha256":"b".repeat(64),"entry":"session-log.sh",
            "name":"session-log","args":[],"tier":"full","kind":"shell"}],"libraries":[]});
    serde_json::from_value(serde_json::json!({"schema":OFFER_SCHEMA,"prepared":{
        "schema":"caws.service.prepared.image.v1","imageKey":"c".repeat(64),"imageDigest":"d".repeat(64),
        "manifest":{"schema":"caws.service.render.image.v1","adapter":image::ADAPTER,"profile":image::PROFILE,
            "selection":selection,"originalClosure":[],"originalClosureDigest":"e".repeat(64),"sourceGeneration":"f".repeat(64),
            "execution":{"root":"/image","dispatcher":"runtime/dispatch.sh","hooks":"hooks","client":"client/service-client.js",
                "handlerRoutes":[],"resolvedLibraries":[],"files":[{"path":"client/service-client.js","sha256":"a".repeat(64),"bytes":1,"mode":365}]},
            "toolchainTcb":{"tools":[],"pythonFlags":["-I","-S","-B"],"systemDependencies":"trusted-not-hash-complete"}},"stagingRoot":null},
        "expectedSelection":selection,"policySha256":"a".repeat(64),"checkout":"/checkout","sessionId":"session-1",
        "invocationId":"owner-test:prepared","callerEnvironment":{},"remainingBudgetMs":10000})).unwrap()
}

pub(super) fn pending_job_fixture(
    invocation: &str,
) -> (
    Job,
    UnixStream,
    SyncSender<Result<Vec<u8>>>,
    mpsc::Receiver<()>,
) {
    let (owner, caller) = UnixStream::pair().unwrap();
    owner.set_nonblocking(true).unwrap();
    let (start_tx, start_rx) = mpsc::sync_channel(1);
    let (bridge_tx, bridge_rx) = mpsc::sync_channel(1);
    let mut offer = offered();
    offer.invocation_id = invocation.into();
    let capacity = Arc::new(ProjectCapacity {
        used: AtomicUsize::new(0),
        maximum: 1,
    });
    (
        Job {
            stream: owner,
            offer,
            expires: expires(),
            reader_start: Some(start_tx),
            bridge: bridge_rx,
            _permit: Arc::new(ConnectionPermit(Arc::new(AtomicUsize::new(1)))),
            _project_permit: capacity.acquire().unwrap(),
        },
        caller,
        bridge_tx,
        start_rx,
    )
}

#[test]
fn pending_capacity_covers_active_plus_queue_and_both_shared_lifetimes() {
    let capacity = Arc::new(ProjectCapacity {
        used: AtomicUsize::new(0),
        maximum: 1 + 2,
    });
    let active = capacity.acquire().unwrap();
    let queued = capacity.acquire().unwrap();
    let prepared = capacity.acquire().unwrap();
    assert!(
        capacity.acquire().is_err(),
        "drained offers must not mint slots"
    );
    let reader = Arc::clone(&prepared);
    drop(prepared);
    assert_eq!(capacity.used.load(Ordering::Acquire), 3);
    assert!(
        capacity.acquire().is_err(),
        "a retained reader still occupies its slot"
    );
    drop(reader);
    let replacement = capacity.acquire().unwrap();
    assert_eq!(capacity.used.load(Ordering::Acquire), 3);
    drop((active, queued, replacement));
    assert_eq!(capacity.used.load(Ordering::Acquire), 0);
}

#[test]
fn pending_bridge_readiness_cannot_bypass_fifo_and_expired_head_is_withdrawn() {
    let (first, first_caller, first_result, _first_start) = pending_job_fixture("first");
    let (second, second_caller, second_result, _second_start) = pending_job_fixture("second");
    let mut jobs = VecDeque::from([first, second]);
    second_result.try_send(Ok(b"second\n".to_vec())).unwrap();
    assert!(
        bridge_head(jobs.iter()).is_none(),
        "later readiness bypassed the head"
    );
    first_result.try_send(Ok(b"first\n".to_vec())).unwrap();
    assert_eq!(bridge_head(jobs.iter()).unwrap().unwrap(), b"first\n");
    jobs.pop_front();
    assert_eq!(bridge_head(jobs.iter()).unwrap().unwrap(), b"second\n");
    jobs.pop_front();
    assert!(bridge_head(jobs.iter()).is_none());
    drop((first_caller, second_caller));

    let (mut expired, caller, result, _start) = pending_job_fixture("expired");
    expired.expires = Instant::now() - Duration::from_millis(1);
    result.try_send(Ok(b"already-complete\n".to_vec())).unwrap();
    assert!(
        bridge_arrival(&expired)
            .unwrap()
            .unwrap_err()
            .contains("deadline")
    );
    assert_eq!(
        expired.bridge.try_recv().unwrap().unwrap(),
        b"already-complete\n"
    );
    drop(caller);
}

#[test]
fn pending_reader_requires_activation_and_job_withdrawal_wakes_it_without_freeing_live_slots() {
    let (mut job, _caller, result, start) = pending_job_fixture("reader-withdrawal");
    let global = Arc::clone(&job._permit.0);
    let project = Arc::clone(&job._project_permit.0);
    let reader_global = Arc::clone(&job._permit);
    let reader_project = Arc::clone(&job._project_permit);
    let mut reader = job.stream.try_clone().unwrap();
    let deadline = job.expires;
    let (returned_tx, returned_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let join = thread::spawn(move || {
        read_prepared_bridge(
            &mut reader,
            start,
            result,
            deadline,
            &ObservationLog::unavailable(Instant::now()),
            "reader-withdrawal",
        );
        returned_tx.send(()).unwrap();
        release_rx.recv().unwrap();
        drop((reader_global, reader_project));
    });
    job.reader_start.take().unwrap().send(()).unwrap();
    drop(job);
    returned_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(global.load(Ordering::Acquire), 1);
    assert_eq!(project.used.load(Ordering::Acquire), 1);
    assert!(project.acquire().is_err());
    release_tx.send(()).unwrap();
    join.join().unwrap();
    assert_eq!(global.load(Ordering::Acquire), 0);
    assert_eq!(project.used.load(Ordering::Acquire), 0);

    let (job, caller, result, start) = pending_job_fixture("never-activated");
    let mut reader = job.stream.try_clone().unwrap();
    write_all(&caller, b"unreleased\n", expires()).unwrap();
    let mut job = job;
    drop(job.reader_start.take());
    read_prepared_bridge(
        &mut reader,
        start,
        result,
        job.expires,
        &ObservationLog::unavailable(Instant::now()),
        "never-activated",
    );
    assert_eq!(
        job.bridge.try_recv().unwrap().unwrap_err(),
        "renderer prepared grant withdrawn"
    );
    let mut available: libc::c_int = -1;
    assert_eq!(
        unsafe { libc::ioctl(reader.as_raw_fd(), libc::FIONREAD, &mut available) },
        0
    );
    assert_eq!(
        available,
        b"unreleased\n".len() as i32,
        "unissued grant consumed bridge input"
    );
}

#[test]
fn pending_prefix_domain_keeps_same_session_and_identity_barriers() {
    let first = offered();
    let proof = PrefixIdentity {
        canonical_project: first.expected_selection.canonical_project.clone(),
        source_generation: first.prepared.manifest.source_generation.clone(),
        image_digest: first.prepared.image_digest.clone(),
        proof_profile: "unit-native-proof".into(),
    };
    assert!(!proof.permits_session(&first.session_id, &first));
    let mut alias = first.clone();
    alias.session_id = first.session_id.to_ascii_uppercase();
    assert_ne!(first.session_id, alias.session_id);
    assert!(!proof.permits_session(&first.session_id, &alias));
    assert!(!proof.permits_session(&alias.session_id, &first));
    assert_eq!(alias.session_id, first.session_id.to_ascii_uppercase());
    let mut other = first.clone();
    other.session_id = "other-session".into();
    assert!(proof.permits_session(&first.session_id, &other));
    for mutate in [
        |offer: &mut Offer| offer.expected_selection.canonical_project = "/other".into(),
        |offer: &mut Offer| offer.prepared.manifest.source_generation = "0".repeat(64),
        |offer: &mut Offer| offer.prepared.image_digest = "0".repeat(64),
    ] {
        let mut changed = other.clone();
        mutate(&mut changed);
        assert!(!proof.permits_session(&first.session_id, &changed));
    }
}

#[test]
fn pending_backend_cohort_compares_full_view_and_generation_not_just_pid() {
    let view = git::GitView {
        git_directory: "/private/old/git".into(),
        git_work_tree: "/checkout".into(),
        git_original_directory: "/checkout/.git".into(),
        git_common_directory: "/common/.git".into(),
        metadata_digest: "a".repeat(64),
        metadata_files: 4,
        metadata_bytes: 100,
    };
    let cohort = BackendCohort {
        directory: "/private/old".into(),
        backend_pid: 123,
        image_digest: "b".repeat(64),
        git_directory: view.git_directory.clone(),
        git_work_tree: view.git_work_tree.clone(),
        git_original_directory: view.git_original_directory.clone(),
        git_common_directory: view.git_common_directory.clone(),
        metadata_digest: view.metadata_digest.clone(),
        metadata_files: view.metadata_files,
        metadata_bytes: view.metadata_bytes,
    };
    assert!(cohort.compatible(&cohort.image_digest, &view));
    // A fresh capture has another private directory; its logical view must match.
    let mut fresh_capture = view.clone();
    fresh_capture.git_directory = "/private/capture/git".into();
    assert!(cohort.compatible(&cohort.image_digest, &fresh_capture));
    assert!(!cohort.compatible(&"0".repeat(64), &view));
    for mutate in [
        |view: &mut git::GitView| view.git_work_tree = "/wrong-checkout".into(),
        |view: &mut git::GitView| view.git_original_directory = "/wrong-original".into(),
        |view: &mut git::GitView| view.git_common_directory = "/wrong-common".into(),
        |view: &mut git::GitView| view.metadata_digest = "0".repeat(64),
        |view: &mut git::GitView| view.metadata_files += 1,
        |view: &mut git::GitView| view.metadata_bytes += 1,
    ] {
        let mut changed = view.clone();
        mutate(&mut changed);
        assert!(!cohort.compatible(&cohort.image_digest, &changed));
    }
    let mut replacement = cohort.clone();
    replacement.directory = "/private/replacement".into();
    assert_ne!(
        cohort, replacement,
        "same PID cannot borrow another generation"
    );
    let mut replacement = cohort.clone();
    replacement.git_directory = "/private/replacement/git".into();
    assert_ne!(cohort, replacement);
}

#[test]
fn pending_unknown_withdraws_waiting_and_bounded_inbox_without_releasing_fence_or_capacity() {
    let scratch = Scratch::new();
    let c = config(&scratch);
    provision(&c, expires()).unwrap();
    let custody = journal::Custody::acquire(&custody_path(&c), expires()).unwrap();
    let request = request();
    let bytes = wire::encode_render_request(&request).unwrap();
    let mut journal = journal::Journal::open(
        Arc::clone(&custody),
        &request.project_service_key,
        8,
        expires(),
    )
    .unwrap();
    journal
        .admit(operation_identity(&request), &bytes, expires())
        .unwrap();
    let dispatch = journal
        .begin_next(
            &request.source_generation,
            &request.execution_image.image_digest,
            expires(),
        )
        .unwrap()
        .unwrap();
    journal.unknown(&dispatch, expires()).unwrap();
    let observations = Arc::new(ObservationLog::open(&c, Instant::now()).unwrap());
    let log_path = base(&c).join("observations.jsonl");
    let actor = Actor {
        config: Arc::new(c),
        custody,
        writer_custody: None,
        writer_intent: None,
        journal,
        budget: Arc::new(Mutex::new(Budget {
            used: 1,
            maximum: 1,
        })),
        process: None,
        reserved: true,
        unknown: true,
        observations,
        phase: "test",
        #[cfg(feature = "sqlite-store")]
        store_records: Vec::new(),
    };
    let (waiting, mut waiting_caller, _waiting_result, _waiting_start) =
        pending_job_fixture("waiting");
    let (first, mut first_caller, _first_result, _first_start) =
        pending_job_fixture("queued-first");
    let (second, mut second_caller, _second_result, _second_start) =
        pending_job_fixture("queued-second");
    let (sender, inbox) = mpsc::sync_channel(2);
    assert!(sender.try_send(Mailbox::Render(first)).is_ok());
    assert!(sender.try_send(Mailbox::Render(second)).is_ok());
    let mut waiting = Some(waiting);
    actor.withdraw_for_unknown(&mut VecDeque::new(), &mut waiting, &inbox);
    assert!(waiting.is_none());
    assert!(matches!(inbox.try_recv(), Err(mpsc::TryRecvError::Empty)));
    let mut byte = [0];
    for caller in [&mut waiting_caller, &mut first_caller, &mut second_caller] {
        assert_eq!(
            caller.read(&mut byte).unwrap(),
            0,
            "withdrawn offer retained its connection"
        );
    }
    assert!(actor.unknown);
    assert!(actor.reserved);
    assert_eq!(actor.budget.lock().unwrap().used, 1);
    assert!(matches!(
        actor
            .journal
            .lookup(&request.request_id, expires())
            .unwrap()
            .unwrap()
            .outcome(),
        journal::AcceptedOutcome::Unknown { .. }
    ));
    let records: Vec<serde_json::Value> = fs::read_to_string(log_path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap()["observation"].clone())
        .collect();
    assert_eq!(records, serde_json::json!([
        {"event":"queued_offer_withdrawn","invocationId":"waiting","reason":"unknown_fence"},
        {"event":"queued_offer_withdrawn","invocationId":"queued-first","reason":"unknown_fence"},
        {"event":"queued_offer_withdrawn","invocationId":"queued-second","reason":"unknown_fence"}
    ]).as_array().unwrap().clone());
}

#[test]
fn prepared_grant_is_bound_to_separate_selection_image_logical_lease_and_actual_view() {
    // This exercises the frontend correlation boundary with synthetic data, not
    // sealed-image admission, real backend readiness or project authority.
    let offer = offered();
    let prepared = OwnerPrepared {
        schema: PREPARED_SCHEMA.into(),
        grant: grant(&offer, Instant::now() + Duration::from_secs(9)).unwrap(),
        image: OwnerImage {
            image_key: offer.prepared.image_key.clone(),
            image_digest: offer.prepared.image_digest.clone(),
            manifest: offer.prepared.manifest.clone(),
        },
        git_view: git::GitView {
            git_directory: "/private/git".into(),
            git_work_tree: "/checkout".into(),
            git_original_directory: "/checkout/.git".into(),
            git_common_directory: "/checkout/.git".into(),
            metadata_digest: "a".repeat(64),
            metadata_files: 1,
            metadata_bytes: 1,
        },
        backend_pid: 42,
    };
    validate_prepared(&offer, &prepared).unwrap();
    assert_eq!(prepared.grant.hooks_directory, "/image/hooks");
    assert_eq!(
        prepared.grant.lease_file,
        "/project/.caws/sessions/.renderer-daemon.json"
    );
    for mutate in [
        |p: &mut OwnerPrepared| {
            p.image.manifest.selection.handlers[0].path = "/changed/handler.sh".into()
        },
        |p: &mut OwnerPrepared| p.grant.original_handler_path = "/changed/handler.sh".into(),
        |p: &mut OwnerPrepared| p.grant.source_generation = "0".repeat(64),
        |p: &mut OwnerPrepared| p.grant.execution_image.image_digest = "0".repeat(64),
        |p: &mut OwnerPrepared| p.grant.execution_image.client_sha256 = "0".repeat(64),
        |p: &mut OwnerPrepared| p.grant.hooks_directory = "/project/.caws/hooks".into(),
        |p: &mut OwnerPrepared| p.grant.lease_file = "/private/backend/lease.json".into(),
        |p: &mut OwnerPrepared| p.git_view.git_work_tree = "/different-checkout".into(),
        |p: &mut OwnerPrepared| p.grant.remaining_budget_ms = 10001,
        |p: &mut OwnerPrepared| p.backend_pid = 1,
    ] {
        let mut changed = prepared.clone();
        mutate(&mut changed);
        assert!(validate_prepared(&offer, &changed).is_err());
    }
    let mut changed_offer = offer.clone();
    changed_offer.expected_selection.handlers[0].sha256 = "0".repeat(64);
    assert!(
        validate_prepared(&changed_offer, &prepared).is_err(),
        "copied manifest selection replaced independently expected selection"
    );
}

#[test]
fn provisioning_is_explicit_pristine_and_never_repairs_acquisition_failure() {
    let scratch = Scratch::new();
    let c = config(&scratch);
    assert!(journal::Custody::acquire(&custody_path(&c), expires()).is_err());
    assert!(
        !base(&c).exists(),
        "failed acquisition manufactured a new service root"
    );
    provision(&c, expires()).unwrap();
    let metadata = fs::symlink_metadata(custody_path(&c).join("operations")).unwrap();
    let mut names: Vec<_> = fs::read_dir(custody_path(&c))
        .unwrap()
        .map(|r| r.unwrap().file_name())
        .collect();
    names.sort();
    assert_eq!(
        names,
        [".service-owner.lock", ".service-root.json", "operations"].map(std::ffi::OsString::from)
    );
    assert_eq!(
        fs::metadata(config_path(&c)).unwrap().mode() & 0o7777,
        0o600
    );
    assert!(provision(&c, expires()).is_err());
    assert_eq!(
        fs::metadata(custody_path(&c).join("operations"))
            .unwrap()
            .ino(),
        metadata.ino()
    );
    fs::remove_file(custody_path(&c).join(".service-root.json")).unwrap();
    assert!(journal::Custody::acquire(&custody_path(&c), expires()).is_err());
    assert!(
        !custody_path(&c).join(".service-root.json").exists(),
        "acquire repaired missing authority anchor"
    );
}

#[test]
fn explicit_limits_refuse_zero_and_inconsistent_capacity_without_clamping() {
    let scratch = Scratch::new();
    let c = config(&scratch);
    validate_config(&c).unwrap();
    for mutate in [
        |l: &mut OwnerLimits| l.max_connections = 0,
        |l: &mut OwnerLimits| l.max_projects = 0,
        |l: &mut OwnerLimits| l.max_backends = 4,
        |l: &mut OwnerLimits| l.max_queue_per_project = 0,
        |l: &mut OwnerLimits| l.max_retained_records = 0,
        |l: &mut OwnerLimits| l.max_frame_bytes = 2_097_153,
        |l: &mut OwnerLimits| l.first_frame_ms = 0,
        |l: &mut OwnerLimits| l.worker.cleanup_ms = 0,
        |l: &mut OwnerLimits| l.idle_ms = 0,
        |l: &mut OwnerLimits| l.backend_idle_seconds = 0,
        |l: &mut OwnerLimits| l.cache_megabytes = 0,
    ] {
        let mut bad = c.clone();
        mutate(&mut bad.limits);
        assert!(validate_config(&bad).is_err());
    }
    let mut budget = Budget {
        used: 1,
        maximum: 2,
    };
    budget.reserve().unwrap();
    assert_eq!(budget.used, 2);
    assert!(budget.reserve().is_err());
    assert_eq!(budget.used, 2);
    budget.release();
    assert_eq!(budget.used, 1);
    budget.reserve().unwrap();
    assert_eq!(budget.used, 2);
}

#[test]
fn frames_have_byte_limits_preserve_surplus_and_distinguish_incomplete_eof() {
    let (mut receiver, sender) = UnixStream::pair().unwrap();
    receiver.set_nonblocking(true).unwrap();
    write_all(&sender, b"a\nb\n", expires()).unwrap();
    let mut pending = Vec::new();
    assert_eq!(
        frame(&mut receiver, &mut pending, 8, expires()).unwrap(),
        b"a\n"
    );
    assert_eq!(
        frame(&mut receiver, &mut pending, 8, expires()).unwrap(),
        b"b\n"
    );
    write_all(&sender, b"12345", expires()).unwrap();
    assert!(
        frame(&mut receiver, &mut pending, 4, expires())
            .unwrap_err()
            .contains("too large")
    );
    let (mut receiver, sender) = UnixStream::pair().unwrap();
    receiver.set_nonblocking(true).unwrap();
    write_all(&sender, b"partial", expires()).unwrap();
    drop(sender);
    assert!(
        frame(&mut receiver, &mut Vec::new(), 16, expires())
            .unwrap_err()
            .contains("EOF")
    );
    assert!(
        frame(&mut receiver, &mut Vec::new(), 16, Instant::now())
            .unwrap_err()
            .contains("deadline")
    );
}

#[test]
fn bridge_frame_requires_eof_and_refuses_delayed_surplus_before_releasing_request_bytes() {
    let (mut receiver, sender) = UnixStream::pair().unwrap();
    receiver.set_nonblocking(true).unwrap();
    let inspection = receiver.try_clone().unwrap();
    write_all(&sender, b"one\n", expires()).unwrap();
    let (result_tx, result_rx) = mpsc::channel();
    let reader = thread::spawn(move || {
        result_tx
            .send(bridge_frame_eof(&mut receiver, 32, expires()))
            .unwrap();
    });
    // Observe the first LF frame leaving the real kernel queue before sending
    // surplus. This tests delayed input, rather than two frames in one read.
    let deadline = expires();
    loop {
        let mut available: libc::c_int = -1;
        assert_eq!(
            unsafe { libc::ioctl(inspection.as_raw_fd(), libc::FIONREAD, &mut available) },
            0
        );
        if available == 0 {
            break;
        }
        assert!(Instant::now() < deadline, "first frame was not consumed");
        thread::sleep(TICK);
    }
    write_all(&sender, b"late\n", expires()).unwrap();
    sender.shutdown(std::net::Shutdown::Write).unwrap();
    let result = result_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(result.unwrap_err().contains("surplus bytes"));
    reader.join().unwrap();
}

#[test]
fn bridge_frame_missing_eof_expires_and_exact_lf_eof_succeeds_with_original_bound() {
    let (mut receiver, sender) = UnixStream::pair().unwrap();
    receiver.set_nonblocking(true).unwrap();
    write_all(&sender, b"one\n", expires()).unwrap();
    let error = bridge_frame_eof(
        &mut receiver,
        4,
        Instant::now() + Duration::from_millis(250),
    )
    .unwrap_err();
    assert!(error.contains("deadline"));
    sender.shutdown(std::net::Shutdown::Write).unwrap();
    let (mut receiver, sender) = UnixStream::pair().unwrap();
    receiver.set_nonblocking(true).unwrap();
    write_all(&sender, b"one\n", expires()).unwrap();
    sender.shutdown(std::net::Shutdown::Write).unwrap();
    assert_eq!(
        bridge_frame_eof(&mut receiver, 4, expires()).unwrap(),
        b"one\n"
    );
    let (mut receiver, sender) = UnixStream::pair().unwrap();
    receiver.set_nonblocking(true).unwrap();
    write_all(&sender, b"one\nsecond\n", expires()).unwrap();
    sender.shutdown(std::net::Shutdown::Write).unwrap();
    assert!(
        bridge_frame_eof(&mut receiver, 32, expires())
            .unwrap_err()
            .contains("surplus bytes")
    );
}

#[test]
fn response_channel_accepts_request_half_close_but_observes_full_disconnect() {
    let (owner, caller) = UnixStream::pair().unwrap();
    response_channel(&owner).unwrap();
    caller.shutdown(std::net::Shutdown::Write).unwrap();
    // EOF finishes the request and must not withdraw its response reader.
    response_channel(&owner).unwrap();
    drop(caller);
    assert_eq!(
        response_channel(&owner).unwrap_err(),
        "renderer caller response channel closed"
    );
}

#[test]
fn worker_frame_wait_observes_caller_disconnect_without_probe_or_worker_eof() {
    let (mut control, mut worker) = UnixStream::pair().unwrap();
    control.set_nonblocking(true).unwrap();
    worker.set_nonblocking(true).unwrap();
    let (caller_watch, caller) = UnixStream::pair().unwrap();
    caller.shutdown(std::net::Shutdown::Write).unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let join = thread::spawn(move || {
        let mut first = true;
        frame_while(&mut control, &mut Vec::new(), 128, expires(), || {
            response_channel(&caller_watch)?;
            if first {
                first = false;
                started_tx.send(()).unwrap();
            }
            Ok(())
        })
    });
    started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    drop(caller);
    let result = join.join().unwrap();
    assert_eq!(
        result.unwrap_err(),
        "renderer caller response channel closed"
    );
    // The watcher must not insert a response probe or a worker control frame.
    let mut byte = [0];
    assert_eq!(worker.read(&mut byte).unwrap(), 0);
}

#[test]
fn disconnected_queued_caller_cancels_without_dispatch_and_half_close_dispatches() {
    let scratch = Scratch::new();
    let c = config(&scratch);
    provision(&c, expires()).unwrap();
    let custody = journal::Custody::acquire(&custody_path(&c), expires()).unwrap();
    let old = request();
    let fresh = next_request(&old, "owner-test:live-half-close");
    let mut journal =
        journal::Journal::open(Arc::clone(&custody), &old.project_service_key, 8, expires())
            .unwrap();
    let old_bytes = wire::encode_render_request(&old).unwrap();
    journal
        .admit(operation_identity(&old), &old_bytes, expires())
        .unwrap();
    let (owner, caller) = UnixStream::pair().unwrap();
    caller.shutdown(std::net::Shutdown::Write).unwrap();
    drop(caller);
    let failure = begin_issued_dispatch(&mut journal, &old, &old_bytes, expires(), || {
        response_channel(&owner).map_err(|diagnostic| PreDispatchFailure {
            reason: journal::CancelReason::GrantWithdrawn,
            diagnostic,
        })
    })
    .unwrap_err();
    assert_eq!(
        failure.diagnostic,
        "renderer caller response channel closed"
    );
    let cancelled = cancel_undispatched(
        &mut journal,
        &old.request_id,
        failure.reason,
        c.limits.request_ms,
    )
    .unwrap();
    assert!(matches!(
        cancelled.outcome(),
        journal::AcceptedOutcome::CancelledBeforeDispatch {
            reason: journal::CancelReason::GrantWithdrawn,
            ..
        }
    ));
    assert!(!journal.has_unknown(expires()).unwrap());
    let fresh_bytes = wire::encode_render_request(&fresh).unwrap();
    journal
        .admit(operation_identity(&fresh), &fresh_bytes, expires())
        .unwrap();
    let (owner, caller) = UnixStream::pair().unwrap();
    caller.shutdown(std::net::Shutdown::Write).unwrap();
    let dispatch = begin_issued_dispatch(&mut journal, &fresh, &fresh_bytes, expires(), || {
        response_channel(&owner).map_err(|diagnostic| PreDispatchFailure {
            reason: journal::CancelReason::GrantWithdrawn,
            diagnostic,
        })
    })
    .unwrap_or_else(|failure| panic!("live response reader refused: {}", failure.diagnostic));
    assert_eq!(dispatch.operation().identity().request_id, fresh.request_id);
    assert!(matches!(
        dispatch.operation().outcome(),
        journal::AcceptedOutcome::Running { .. }
    ));
}

#[test]
fn known_idle_actor_releases_project_writer_custody_but_unknown_actor_retains_it() {
    for unknown in [false, true] {
        let scratch = Scratch::new();
        let c = config(&scratch);
        private_dir(&scratch.0.join(".caws"), true).unwrap();
        private_dir(&scratch.0.join(".caws/sessions"), true).unwrap();
        provision(&c, expires()).unwrap();
        let custody = journal::Custody::acquire(&custody_path(&c), expires()).unwrap();
        let writer = crate::render_writer::acquire(&c.home, &scratch.0, expires()).unwrap();
        let journal = journal::Journal::open(
            Arc::clone(&custody),
            &request().project_service_key,
            8,
            expires(),
        )
        .unwrap();
        let mut actor = Actor {
            config: Arc::new(c),
            custody,
            writer_custody: Some(writer),
            writer_intent: None,
            journal,
            budget: Arc::new(Mutex::new(Budget {
                used: 0,
                maximum: 2,
            })),
            process: None,
            reserved: false,
            unknown,
            observations: Arc::new(ObservationLog::unavailable(Instant::now())),
            phase: "test",
            #[cfg(feature = "sqlite-store")]
            store_records: Vec::new(),
        };
        actor.retire();
        let reacquire = crate::render_writer::acquire(
            &actor.config.home,
            &scratch.0,
            Instant::now() + Duration::from_millis(30),
        );
        assert_eq!(reacquire.is_err(), unknown);
        assert_eq!(actor.writer_custody.is_some(), unknown);
    }
}

#[test]
fn git_capture_diagnostic_retains_static_reason_and_numeric_query_facts_only() {
    let scratch = Scratch::new();
    let c = config(&scratch);
    provision(&c, expires()).unwrap();
    let log = ObservationLog::open(&c, Instant::now()).unwrap();
    git_capture_failure(
        &log,
        "Git metadata query unavailable (status exit status: 0, stderr bytes 17)",
    );
    git_capture_failure(
        &log,
        "Git metadata query unavailable (status signal: 9 (SIGKILL), stderr bytes 0)",
    );
    git_capture_failure(
        &log,
        "Git compatibility profile does not support /caller-secret/name",
    );
    let bytes = fs::read_to_string(base(&c).join("observations.jsonl")).unwrap();
    assert!(!bytes.contains("caller-secret"));
    let records: Vec<serde_json::Value> = bytes
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        records[0]["observation"]["reason"],
        "metadata_query_unavailable"
    );
    assert_eq!(records[0]["observation"]["queryExitCode"], 0);
    assert_eq!(records[0]["observation"]["stderrBytes"], 17);
    assert_eq!(records[1]["observation"]["querySignal"], 9);
    assert_eq!(
        records[2]["observation"]["reason"],
        "executable_configuration_refused"
    );
    assert!(records[2]["observation"]["queryExitCode"].is_null());
}

#[test]
fn missing_worker_exec_is_known_not_started_and_same_writer_anchor_accepts_valid_work() {
    // Direct startup seam with a synthetic image identity. This does not claim
    // sealed-image admission or actual renderer compatibility.
    let scratch = Scratch::new();
    let mut c = config(&scratch);
    private_dir(&scratch.0.join(".caws"), true).unwrap();
    private_dir(&scratch.0.join(".caws/sessions"), true).unwrap();
    let output = scratch.0.join(".caws/sessions/test-session");
    private_dir(&output, true).unwrap();
    provision(&c, expires()).unwrap();
    let custody = journal::Custody::acquire(&custody_path(&c), expires()).unwrap();
    let writer = crate::render_writer::acquire(&c.home, &scratch.0, expires()).unwrap();
    let journal = journal::Journal::open(
        Arc::clone(&custody),
        &request().project_service_key,
        8,
        expires(),
    )
    .unwrap();
    let intent = crate::render_writer::begin(
        Arc::clone(&writer),
        &scratch.0,
        &"a".repeat(64),
        b"native-startup-test",
        expires(),
    )
    .unwrap();
    c.native_executable = scratch.0.join("missing-native-executable");
    let observations = Arc::new(ObservationLog::unavailable(Instant::now()));
    let directory = scratch.0.join("startup");
    private_dir(&directory, true).unwrap();
    let mut manifest = offered().prepared.manifest;
    manifest.toolchain_tcb.tools = serde_json::from_value(serde_json::json!([
        {"name":"python3","path":"/usr/bin/python3","sha256":"a".repeat(64)}
    ]))
    .unwrap();
    let view = git::GitView {
        git_directory: scratch.0.clone(),
        git_work_tree: scratch.0.clone(),
        git_original_directory: scratch.0.clone(),
        git_common_directory: scratch.0.clone(),
        metadata_digest: "a".repeat(64),
        metadata_files: 0,
        metadata_bytes: 0,
    };
    let failure = match spawn_worker(
        &c,
        WorkerCustody {
            machine: &custody,
            writer: &writer,
        },
        &manifest,
        view,
        directory,
        Arc::clone(&observations),
        expires(),
    ) {
        Err(failure) => failure,
        Ok(_) => panic!("missing executable unexpectedly started"),
    };
    assert!(!failure.child_started);
    assert_eq!(failure.stage, journal::NotStartedStage::Spawn);
    assert_eq!(failure.errno, Some(libc::ENOENT));
    let mut actor = Actor {
        config: Arc::new(c),
        custody,
        writer_custody: Some(writer),
        writer_intent: Some(intent),
        journal,
        budget: Arc::new(Mutex::new(Budget {
            used: 1,
            maximum: 1,
        })),
        process: None,
        reserved: true,
        unknown: false,
        observations,
        phase: "test",
        #[cfg(feature = "sqlite-store")]
        store_records: Vec::new(),
    };
    actor.startup_failed(failure);
    assert!(!actor.unknown);
    assert!(!actor.reserved);
    assert_eq!(actor.budget.lock().unwrap().used, 0);
    assert!(actor.writer_intent.is_none() && actor.writer_custody.is_none());
    let marker = output.join("valid-request-ran");
    let args = vec![
        "--home".into(),
        scratch.0.to_str().unwrap().into(),
        "--canonical-project".into(),
        scratch.0.to_str().unwrap().into(),
        "--output-directory".into(),
        output.to_str().unwrap().into(),
        "--session-id".into(),
        "test-session".into(),
        "--source-generation".into(),
        "a".repeat(64),
        "--timeout-ms".into(),
        "1000".into(),
        "--".into(),
        "/usr/bin/touch".into(),
        marker.to_str().unwrap().into(),
    ];
    assert_eq!(crate::render_writer::run(&args).unwrap(), 0);
    assert!(marker.is_file());
}

#[test]
fn valid_public_request_hashes_do_not_permit_changed_checkout_session_or_log_destination() {
    let mut good = request();
    let project = good.canonical_project.clone();
    let checkout = "/checkout";
    let session = "session-1";
    good.arguments = std::array::from_fn(|_| String::new());
    good.arguments[0] = format!("{project}/.caws/sessions/{session}");
    good.arguments[1] = checkout.into();
    good.arguments[2] = session.into();
    good.argument_digest = wire::render_argument_digest(&good.arguments).unwrap();
    good.validate().unwrap();
    assert!(arguments_bound(&good, &project, checkout, session));
    for (position, replacement) in [
        (0, "/elsewhere"),
        (1, "/another-checkout"),
        (2, "other-session"),
        (4, "unsupported\nlegacy-wire"),
    ] {
        let mut changed = good.clone();
        changed.arguments[position] = replacement.into();
        changed.argument_digest = wire::render_argument_digest(&changed.arguments).unwrap();
        changed.validate().unwrap();
        assert_eq!(changed.request_id, good.request_id);
        assert!(
            !arguments_bound(&changed, &project, checkout, session),
            "public rehash bypassed positional binding {position}"
        );
    }
}

#[test]
fn restart_cancels_only_withdrawn_queued_grants_and_retains_unknown_capacity() {
    let scratch = Scratch::new();
    let c = config(&scratch);
    provision(&c, expires()).unwrap();
    let custody = journal::Custody::acquire(&custody_path(&c), expires()).unwrap();
    let mut running = request();
    running.arguments[4] = "running effect".into();
    running.argument_digest = wire::render_argument_digest(&running.arguments).unwrap();
    let mut queued = running.clone();
    queued.invocation_id = "owner-test:queued".into();
    queued.request_id =
        wire::render_request_id(&queued.invocation_id, queued.selected_index).unwrap();
    let identity = |r: &wire::RenderRequest| journal::Identity {
        request_id: r.request_id.clone(),
        argument_digest: r.argument_digest.clone(),
        project_service_key: r.project_service_key.clone(),
        source_generation: r.source_generation.clone(),
        execution_image_digest: r.execution_image.image_digest.clone(),
    };
    let mut journal = journal::Journal::open(
        Arc::clone(&custody),
        &running.project_service_key,
        8,
        expires(),
    )
    .unwrap();
    journal
        .admit(
            identity(&running),
            &wire::encode_render_request(&running).unwrap(),
            expires(),
        )
        .unwrap();
    let dispatch = journal
        .begin_next(
            &running.source_generation,
            &running.execution_image.image_digest,
            expires(),
        )
        .unwrap()
        .unwrap();
    journal
        .admit(
            identity(&queued),
            &wire::encode_render_request(&queued).unwrap(),
            expires(),
        )
        .unwrap();
    assert!(matches!(
        journal
            .lookup(&running.request_id, expires())
            .unwrap()
            .unwrap()
            .outcome(),
        journal::AcceptedOutcome::Running { .. }
    ));
    drop(dispatch);
    drop(journal);
    drop(custody);
    let custody = journal::Custody::acquire(&custody_path(&c), expires()).unwrap();
    assert_eq!(
        custody.service_keys(3, expires()).unwrap(),
        [running.project_service_key.clone()]
    );
    let mut journal = journal::Journal::open(
        Arc::clone(&custody),
        &running.project_service_key,
        8,
        expires(),
    )
    .unwrap();
    assert!(recover_journal(&mut journal, expires()).unwrap());
    let unknown = journal
        .lookup(&running.request_id, expires())
        .unwrap()
        .unwrap();
    let cancelled = journal
        .lookup(&queued.request_id, expires())
        .unwrap()
        .unwrap();
    assert!(matches!(
        unknown.outcome(),
        journal::AcceptedOutcome::Unknown { .. }
    ));
    assert!(matches!(
        cancelled.outcome(),
        journal::AcceptedOutcome::CancelledBeforeDispatch {
            reason: journal::CancelReason::GrantWithdrawn,
            ..
        }
    ));
    assert_eq!(
        unknown.verified_request().unwrap(),
        wire::encode_render_request(&running).unwrap()
    );
    assert_eq!(
        cancelled.verified_request().unwrap(),
        wire::encode_render_request(&queued).unwrap()
    );
    assert!(journal.queued_request_ids(expires()).unwrap().is_empty());
    assert!(
        journal
            .begin_next(
                &running.source_generation,
                &running.execution_image.image_digest,
                expires()
            )
            .is_err()
    );
    let mut budget = Budget {
        used: 0,
        maximum: 1,
    };
    if recover_journal(&mut journal, expires()).unwrap() {
        budget.reserve().unwrap();
    }
    assert_eq!(budget.used, 1);
    assert!(budget.reserve().is_err());
}

#[test]
fn admission_denials_bind_invocation_and_actual_unknown_or_capacity_branch() {
    let scratch = Scratch::new();
    let c = config(&scratch);
    provision(&c, expires()).unwrap();
    let custody = journal::Custody::acquire(&custody_path(&c), expires()).unwrap();
    let journal = journal::Journal::open(
        Arc::clone(&custody),
        &request().project_service_key,
        8,
        expires(),
    )
    .unwrap();
    let observations = Arc::new(ObservationLog::open(&c, Instant::now()).unwrap());
    let log_path = base(&c).join("observations.jsonl");
    let mut actor = Actor {
        config: Arc::new(c),
        custody,
        writer_custody: None,
        writer_intent: None,
        journal,
        budget: Arc::new(Mutex::new(Budget {
            used: 0,
            maximum: 1,
        })),
        process: None,
        reserved: false,
        unknown: false,
        observations,
        phase: "test",
        #[cfg(feature = "sqlite-store")]
        store_records: Vec::new(),
    };
    actor.check_unknown_fence("healthy", expires()).unwrap();
    actor.reserve_backend("healthy").unwrap();
    assert!(
        fs::read(&log_path).unwrap().is_empty(),
        "successful admission invented a denial"
    );
    assert!(actor.reserve_backend("capacity-probe").is_err());
    assert_eq!(actor.budget.lock().unwrap().used, 1);
    actor.unknown = true;
    assert!(actor.check_unknown_fence("flag-probe", expires()).is_err());
    actor.unknown = false;
    // A journal read failure is not positive evidence of an unknown fence.
    assert!(
        actor
            .check_unknown_fence("expired-probe", Instant::now())
            .is_err()
    );
    let request = request();
    let bytes = wire::encode_render_request(&request).unwrap();
    actor
        .journal
        .admit(operation_identity(&request), &bytes, expires())
        .unwrap();
    let dispatch = actor
        .journal
        .begin_next(
            &request.source_generation,
            &request.execution_image.image_digest,
            expires(),
        )
        .unwrap()
        .unwrap();
    actor.journal.unknown(&dispatch, expires()).unwrap();
    assert!(
        actor
            .check_unknown_fence("journal-probe", expires())
            .is_err()
    );
    let records: Vec<serde_json::Value> = fs::read_to_string(log_path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap()["observation"].clone())
        .collect();
    assert_eq!(records, serde_json::json!([
        {"event":"admission_denied","invocationId":"capacity-probe","reason":"backend_capacity_exhausted","backendUsed":1,"backendMaximum":1},
        {"event":"admission_denied","invocationId":"flag-probe","reason":"unknown_fence","backendUsed":1,"backendMaximum":1},
        {"event":"admission_denied","invocationId":"journal-probe","reason":"unknown_fence","backendUsed":1,"backendMaximum":1}
    ]).as_array().unwrap().clone());
}

#[test]
fn image_admission_diagnostics_correlate_each_offer_and_keep_static_failure_facts() {
    let scratch = Scratch::new();
    let c = config(&scratch);
    provision(&c, expires()).unwrap();
    let log = ObservationLog::open(&c, Instant::now()).unwrap();
    let mut first = offered();
    first
        .caller_environment
        .insert("SECRET".into(), "unreported-caller-value".into());
    let mut second = first.clone();
    second.invocation_id = "other-invocation".into();
    second.expected_selection.canonical_project = "/other-project".into();
    second.prepared.image_key = "9".repeat(64);
    let failure_context = context(&c, &first);
    let mut failure = image::validate_image(
        Path::new("/unreported-source-path"),
        &failure_context,
        Instant::now() - Duration::from_millis(1),
    )
    .unwrap_err();
    assert_eq!(failure.operation(), "deadline expired");
    let kinds = [
        (image::ErrorKind::Invalid, "invalid"),
        (image::ErrorKind::UnsupportedProfile, "unsupported_profile"),
        (image::ErrorKind::UnsafePath, "unsafe_path"),
        (image::ErrorKind::Changed, "changed"),
        (image::ErrorKind::Deadline, "deadline"),
        (image::ErrorKind::Io, "io"),
    ];
    let mut expected = Vec::new();
    for offer in [&first, &second] {
        for (kind, label) in kinds {
            failure.kind = kind;
            image_admission_failure(&log, offer, &failure);
            expected.push(serde_json::json!({
                "event": "image_admission_refused",
                "invocationId": offer.invocation_id,
                "canonicalProject": offer.expected_selection.canonical_project,
                "imageKey": offer.prepared.image_key,
                "operation": "deadline expired",
                "kind": label,
            }));
        }
    }
    let bytes = fs::read(base(&c).join("observations.jsonl")).unwrap();
    let records: Vec<serde_json::Value> = bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| {
            serde_json::from_slice::<serde_json::Value>(line).unwrap()["observation"].clone()
        })
        .collect();
    assert_eq!(records, expected);
    let text = String::from_utf8(bytes).unwrap();
    assert!(!text.contains("SECRET"));
    assert!(!text.contains("unreported-caller-value"));
    assert!(!text.contains("unreported-source-path"));
}

#[test]
fn diagnostic_log_appends_private_bounded_records_and_refuses_identity_replacement() {
    let scratch = Scratch::new();
    let c = config(&scratch);
    provision(&c, expires()).unwrap();
    let log = ObservationLog::open(&c, Instant::now()).unwrap();
    log.append(&Observation::HostStarted { host_pid: 123 })
        .unwrap();
    log.append(&Observation::ActorError {
        stage: "image_admission",
        reason: observation_reason("SECRET=value /sensitive/path changed"),
    })
    .unwrap();
    let path = base(&c).join("observations.jsonl");
    let bytes = fs::read(&path).unwrap();
    let records: Vec<serde_json::Value> = bytes
        .split(|b| *b == b'\n')
        .filter(|b| !b.is_empty())
        .map(|b| serde_json::from_slice(b).unwrap())
        .collect();
    assert_eq!(records[0]["schema"], "caws.render.owner.observation.v1");
    let first_elapsed = records[0]["elapsedMs"]
        .as_u64()
        .expect("nonnegative elapsed milliseconds");
    let next_elapsed = records[1]["elapsedMs"]
        .as_u64()
        .expect("nonnegative elapsed milliseconds");
    assert!(
        next_elapsed >= first_elapsed,
        "append sequence clock regressed"
    );
    assert_eq!(
        records[0]["observation"],
        serde_json::json!({"event":"host_started","hostPid":123})
    );
    assert_eq!(
        records[1]["observation"],
        serde_json::json!({"event":"actor_error","stage":"image_admission","reason":"identity_or_source_changed"})
    );
    assert!(!String::from_utf8_lossy(&bytes).contains("SECRET"));
    assert!(!String::from_utf8_lossy(&bytes).contains("sensitive"));
    assert_eq!(fs::metadata(&path).unwrap().mode() & 0o7777, 0o600);
    fs::rename(&path, base(&c).join("retained-observations")).unwrap();
    fs::write(&path, b"replacement\n").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(
        log.append(&Observation::HostIdleExit { host_pid: 123 })
            .is_err()
    );
    assert_eq!(
        fs::read(base(&c).join("retained-observations")).unwrap(),
        bytes
    );
    assert_eq!(fs::read(&path).unwrap(), b"replacement\n");
    let mut budget = Budget {
        used: 0,
        maximum: 1,
    };
    budget.reserve().unwrap();
    assert_eq!(budget.used, 1);
}

#[test]
fn diagnostic_log_refuses_full_partial_oversize_and_symlink_without_reset() {
    let scratch = Scratch::new();
    let c = config(&scratch);
    provision(&c, expires()).unwrap();
    let path = base(&c).join("observations.jsonl");
    fs::write(&path, vec![b'\n'; OBSERVATION_MAX_BYTES as usize]).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let log = ObservationLog::open(&c, Instant::now()).unwrap();
    assert!(
        log.append(&Observation::HostStarted { host_pid: 123 })
            .is_err()
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), OBSERVATION_MAX_BYTES);
    drop(log);
    fs::write(&path, b"partial").unwrap();
    assert!(ObservationLog::open(&c, Instant::now()).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"partial");
    fs::write(&path, b"").unwrap();
    let log = ObservationLog::open(&c, Instant::now()).unwrap();
    assert!(
        log.append(&Observation::Prepared {
            invocation_id: &"x".repeat(OBSERVATION_MAX_RECORD),
            session_id: "session",
            selected_index: 0,
            backend_pid: 123
        })
        .is_err()
    );
    assert_eq!(fs::read(&path).unwrap(), b"");
    drop(log);
    fs::remove_file(&path).unwrap();
    let target = scratch.0.join("target");
    fs::write(&target, b"retained\n").unwrap();
    std::os::unix::fs::symlink(&target, &path).unwrap();
    assert!(ObservationLog::open(&c, Instant::now()).is_err());
    assert_eq!(fs::read(&target).unwrap(), b"retained\n");
}

#[test]
fn cleanup_prefix_reader_is_private_bounded_and_keeps_binary_bytes() {
    let scratch = Scratch::new();
    let path = scratch.0.join("stderr.bin");
    let bytes: Vec<u8> = (0..1000).map(|i| (i % 256) as u8).collect();
    fs::write(&path, &bytes).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        STANDARD.decode(prefix_file(&path).unwrap()).unwrap(),
        bytes[..512]
    );
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(prefix_file(&path), None);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let alias = scratch.0.join("alias");
    std::os::unix::fs::symlink(&path, &alias).unwrap();
    assert_eq!(prefix_file(&alias), None);
}

fn operation_identity(r: &wire::RenderRequest) -> journal::Identity {
    journal::Identity {
        request_id: r.request_id.clone(),
        argument_digest: r.argument_digest.clone(),
        project_service_key: r.project_service_key.clone(),
        source_generation: r.source_generation.clone(),
        execution_image_digest: r.execution_image.image_digest.clone(),
    }
}
fn next_request(previous: &wire::RenderRequest, invocation: &str) -> wire::RenderRequest {
    let mut request = previous.clone();
    request.invocation_id = invocation.into();
    request.request_id = wire::render_request_id(invocation, request.selected_index).unwrap();
    request
}

#[test]
fn expired_after_admission_is_cancelled_before_next_job_without_false_unknown() {
    let scratch = Scratch::new();
    let c = config(&scratch);
    provision(&c, expires()).unwrap();
    let custody = journal::Custody::acquire(&custody_path(&c), expires()).unwrap();
    let old = request();
    let fresh = next_request(&old, "owner-test:fresh-after-expiry");
    let mut journal =
        journal::Journal::open(Arc::clone(&custody), &old.project_service_key, 8, expires())
            .unwrap();
    let old_bytes = wire::encode_render_request(&old).unwrap();
    journal
        .admit(operation_identity(&old), &old_bytes, expires())
        .unwrap();
    let revalidation_called = std::cell::Cell::new(false);
    let failure = begin_issued_dispatch(&mut journal, &old, &old_bytes, Instant::now(), || {
        revalidation_called.set(true);
        Ok(())
    })
    .unwrap_err();
    assert!(!revalidation_called.get());
    assert_eq!(failure.reason, journal::CancelReason::GrantWithdrawn);
    let tombstone = cancel_undispatched(
        &mut journal,
        &old.request_id,
        failure.reason,
        c.limits.request_ms,
    )
    .unwrap();
    assert!(matches!(
        tombstone.outcome(),
        journal::AcceptedOutcome::CancelledBeforeDispatch {
            reason: journal::CancelReason::GrantWithdrawn,
            ..
        }
    ));
    assert!(!journal.has_unknown(expires()).unwrap());
    assert!(journal.queued_request_ids(expires()).unwrap().is_empty());
    let fresh_bytes = wire::encode_render_request(&fresh).unwrap();
    journal
        .admit(operation_identity(&fresh), &fresh_bytes, expires())
        .unwrap();
    let dispatch = begin_issued_dispatch(&mut journal, &fresh, &fresh_bytes, expires(), || Ok(()))
        .unwrap_or_else(|f| panic!("fresh job refused: {}", f.diagnostic));
    assert_eq!(dispatch.operation().identity().request_id, fresh.request_id);
    assert_eq!(
        dispatch.operation().verified_request().unwrap(),
        fresh_bytes
    );
    assert!(
        cancel_undispatched(
            &mut journal,
            &fresh.request_id,
            journal::CancelReason::GrantWithdrawn,
            c.limits.request_ms
        )
        .is_err()
    );
    assert!(matches!(
        journal
            .lookup(&fresh.request_id, expires())
            .unwrap()
            .unwrap()
            .outcome(),
        journal::AcceptedOutcome::Running { .. }
    ));
}

#[test]
fn stale_queue_and_source_retirement_never_turn_unattempted_effect_into_running_unknown() {
    let scratch = Scratch::new();
    let c = config(&scratch);
    provision(&c, expires()).unwrap();
    let custody = journal::Custody::acquire(&custody_path(&c), expires()).unwrap();
    let old = request();
    let fresh = next_request(&old, "owner-test:later-than-old-queue");
    let mut journal =
        journal::Journal::open(Arc::clone(&custody), &old.project_service_key, 8, expires())
            .unwrap();
    let old_bytes = wire::encode_render_request(&old).unwrap();
    let fresh_bytes = wire::encode_render_request(&fresh).unwrap();
    journal
        .admit(operation_identity(&old), &old_bytes, expires())
        .unwrap();
    journal
        .admit(operation_identity(&fresh), &fresh_bytes, expires())
        .unwrap();
    let failure = begin_issued_dispatch(&mut journal, &fresh, &fresh_bytes, expires(), || Ok(()))
        .unwrap_err();
    assert_eq!(failure.reason, journal::CancelReason::GrantWithdrawn);
    assert!(failure.diagnostic.contains("oldest queued"));
    assert!(!journal.has_unknown(expires()).unwrap());
    assert!(matches!(
        journal
            .lookup(&old.request_id, expires())
            .unwrap()
            .unwrap()
            .outcome(),
        journal::AcceptedOutcome::Queued { .. }
    ));
    cancel_undispatched(
        &mut journal,
        &fresh.request_id,
        failure.reason,
        c.limits.request_ms,
    )
    .unwrap();
    let failure = begin_issued_dispatch(&mut journal, &old, &old_bytes, expires(), || {
        Err(PreDispatchFailure {
            reason: journal::CancelReason::SourceRetired,
            diagnostic: "source retired".into(),
        })
    })
    .unwrap_err();
    assert_eq!(failure.reason, journal::CancelReason::SourceRetired);
    let cancelled = cancel_undispatched(
        &mut journal,
        &old.request_id,
        failure.reason,
        c.limits.request_ms,
    )
    .unwrap();
    assert!(matches!(
        cancelled.outcome(),
        journal::AcceptedOutcome::CancelledBeforeDispatch {
            reason: journal::CancelReason::SourceRetired,
            ..
        }
    ));
    assert!(!journal.has_unknown(expires()).unwrap());
    assert!(journal.queued_request_ids(expires()).unwrap().is_empty());
}
