use super::*;
use store::Transport;

fn expires() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
struct Fixture {
    root: PathBuf,
    database: PathBuf,
    config: Arc<OwnerConfig>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("caws-resident-store-{}", random().unwrap()));
        private_dir(&root, true).unwrap();
        let result = Command::new("/usr/bin/git")
            .args(["init", "--quiet"])
            .arg(&root)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .output()
            .unwrap();
        assert!(result.status.success(), "{result:?}");
        private_dir(&root.join("state"), true).unwrap();
        let source = root.join("source");
        fs::write(&source, b"fixture").unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o600)).unwrap();
        let config = Arc::new(OwnerConfig {
            schema: CONFIG_SCHEMA.into(),
            home: root.clone(),
            client_root: root.clone(),
            template_root: root.clone(),
            client_shell_source: source.clone(),
            native_executable: source,
            limits: OwnerLimits {
                max_connections: 4,
                max_projects: 2,
                max_backends: 1,
                max_queue_per_project: 2,
                max_frame_bytes: 2_097_152,
                max_retained_records: 2,
                first_frame_ms: 1000,
                request_ms: 5000,
                startup_ms: 1000,
                idle_ms: 100,
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
        });
        provision(&config, expires()).unwrap();
        let database = root.join("source.sqlite");
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection.execute_batch("CREATE TABLE message(id,session_id,time_created,data);CREATE TABLE part(id,message_id,time_created,data);INSERT INTO message VALUES('m','s',0,'{}');INSERT INTO part VALUES('p','m',0,'{}');").unwrap();
        connection.close().unwrap();
        Self {
            root,
            database,
            config,
        }
    }
    fn acquire(&self, id: &str) -> StoreAcquire {
        let root = self.root.to_str().unwrap();
        let runtime = "a".repeat(64);
        let bytes = serde_json::to_vec(&serde_json::json!({"schema":store::REQUEST_SCHEMA,"id":id,"runtimeDigest":runtime,"token":"token","canonicalRoot":root,"profile":store::PROFILE})).unwrap();
        let payload = RawValue::from_string("{\"session_id\":\"s\"}".into()).unwrap();
        let environment = BTreeMap::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            (
                "CAWS_TRANSCRIPT_DATABASE".into(),
                self.database.to_str().unwrap().into(),
            ),
        ]);
        StoreAcquire::capture(
            &bytes,
            store::Invocation {
                id,
                runtime_digest: &runtime,
                original_payload: &payload,
                surface: "opencode",
                event: "stop",
                configuration: "system",
                ready_active: true,
                ready_project_digest: Some(&sha(root.as_bytes())),
                ready_session_id: Some("s"),
                dispatched: true,
                database: self.database.to_str(),
                caller_cwd: root,
                caller_environment: &environment,
            },
            expires(),
        )
    }
    fn actor(&self) -> Actor {
        let custody = journal::Custody::acquire(&custody_path(&self.config), expires()).unwrap();
        let key = wire::project_service_key(self.root.to_str().unwrap()).unwrap();
        let journal = journal::Journal::open(Arc::clone(&custody), &key, 2, expires()).unwrap();
        Actor {
            config: Arc::clone(&self.config),
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
            observations: Arc::new(ObservationLog::unavailable(Instant::now())),
            phase: "test",
            store_records: Vec::new(),
        }
    }
    fn can_lock(&self) {
        let connection = rusqlite::Connection::open(&self.database).unwrap();
        connection
            .execute_batch("BEGIN EXCLUSIVE;ROLLBACK")
            .unwrap();
        connection.close().unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn relay_pair() -> (RelayTransport, UnixStream, SyncSender<RelayReply>) {
    let (owner, caller) = UnixStream::pair().unwrap();
    owner.set_nonblocking(true).unwrap();
    caller.set_nonblocking(true).unwrap();
    let (tx, rx) = mpsc::sync_channel(1);
    (
        RelayTransport {
            stream: owner,
            replies: rx,
            cancelled: Arc::new(AtomicBool::new(false)),
            sequence: 0,
            expires: expires(),
            limit: 2_097_152,
        },
        caller,
        tx,
    )
}
fn command(stream: &mut UnixStream) -> OwnerFrame {
    serde_json::from_slice(&frame(stream, &mut Vec::new(), 2_097_152, expires()).unwrap()).unwrap()
}
fn ack(
    sender: &SyncSender<RelayReply>,
    sequence: u64,
    result: std::result::Result<ReplyValue, String>,
) {
    sender
        .send(RelayReply {
            schema: REPLY_SCHEMA.into(),
            sequence,
            result,
        })
        .unwrap();
}
#[test]
fn resident_write_waits_for_exact_actual_delivery_ack_and_preserves_failure() {
    for wrong_sequence in [false, true] {
        let (mut relay, mut caller, replies) = relay_pair();
        let (done_tx, done_rx) = mpsc::sync_channel(1);
        let join = thread::spawn(move || {
            done_tx.send(relay.write(b"sentinel\n", expires())).unwrap();
        });
        match command(&mut caller) {
            OwnerFrame::WriteEngineFrame { sequence, base64 } => {
                assert_eq!(sequence, 1);
                assert_eq!(STANDARD.decode(base64).unwrap(), b"sentinel\n");
            }
            _ => panic!("expected actual write request"),
        }
        assert!(
            matches!(done_rx.try_recv(), Err(mpsc::TryRecvError::Empty)),
            "request receipt acknowledged delivery prematurely"
        );
        ack(
            &replies,
            if wrong_sequence { 2 } else { 1 },
            Err("actual-write-failed".into()),
        );
        let error = done_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .unwrap_err();
        assert_eq!(
            error,
            if wrong_sequence {
                "resident store relay acknowledgement mismatch"
            } else {
                "actual-write-failed"
            }
        );
        join.join().unwrap();
    }
}
#[test]
fn resident_registry_is_finite_no_replay_and_status_requires_actual_retained_record() {
    let f = Fixture::new();
    let mut registry = StoreRegistry::new(1);
    let record = registry.reserve(f.acquire("one")).unwrap();
    let registration = record.lock().unwrap().registration.clone();
    let query = StoreStatusQuery::new("one".into(), "a".repeat(64), registration);
    assert!(registry.status(&query).present);
    assert!(
        registry
            .reserve(f.acquire("one"))
            .unwrap_err()
            .contains("duplicate")
    );
    assert!(
        registry
            .reserve(f.acquire("two"))
            .unwrap_err()
            .contains("capacity exhausted before SQL")
    );
    let wrong = StoreStatusQuery::new("one".into(), "b".repeat(64), query.registration.clone());
    assert!(!registry.status(&wrong).present);
    drop(record);
    let missing = registry.status(&query);
    assert!(
        !missing.present,
        "weak registry must not manufacture an owner"
    );
    assert_eq!(missing.phase, "missing");
    assert!(
        !registry.is_empty(),
        "unreleased reservations must keep the host alive and refuse replay"
    );
    let capacity = Arc::new(ProjectCapacity {
        used: AtomicUsize::new(0),
        maximum: 1,
    });
    let renderer = capacity.acquire().unwrap();
    drop(renderer);
    assert_eq!(capacity.used.load(Ordering::Acquire), 0);
    f.can_lock();
}
#[test]
fn resident_actor_retains_full_sql_failure_after_frontend_write_loss() {
    let f = Fixture::new();
    let before = fs::read(&f.database).unwrap();
    let mut actor = f.actor();
    let registry = Arc::new(Mutex::new(StoreRegistry::new(2)));
    let record = registry
        .lock()
        .unwrap()
        .reserve(f.acquire("write-loss"))
        .unwrap();
    record.lock().unwrap().original_project_bound = true;
    let registration = record.lock().unwrap().registration.clone();
    let (transport, mut caller, replies) = relay_pair();
    let capacity = Arc::new(ProjectCapacity {
        used: AtomicUsize::new(0),
        maximum: 1,
    });
    let job = StoreJob {
        record: Arc::clone(&record),
        registry: Arc::clone(&registry),
        transport,
        _connection: Arc::new(ConnectionPermit(Arc::new(AtomicUsize::new(1)))),
        _project: capacity.acquire().unwrap(),
    };
    let peer = thread::spawn(move || {
        assert!(matches!(
            command(&mut caller),
            OwnerFrame::Credit { sequence: 1, .. }
        ));
        ack(&replies, 1, Ok(ReplyValue::Credited));
        match command(&mut caller) {
            OwnerFrame::WriteEngineFrame {
                sequence: 2,
                base64,
            } => {
                let row: serde_json::Value =
                    serde_json::from_slice(&STANDARD.decode(base64).unwrap()).unwrap();
                assert_eq!(row["schema"], store::ROW_SCHEMA);
                assert_eq!(row["ordinal"], 1);
                assert_eq!(row["cells"][0]["base64"], "bQ==");
            }
            _ => panic!("no real row"),
        }
        ack(&replies, 2, Err("frontend actual write failed".into()));
        // The original frontend is gone before we inspect the Actor's record.
        drop(caller);
    });
    actor.acquire_store_job(job);
    peer.join().unwrap();
    drop(record);
    assert_eq!(
        actor.store_records.len(),
        1,
        "acquisition must survive Job/frontend destruction"
    );
    let retained = actor.store_records[0].lock().unwrap();
    let Some(Err(store::ServeError::AfterAcquisition {
        phase,
        message,
        outcome,
    })) = &retained.result
    else {
        panic!("full acquired failure lost")
    };
    assert_eq!(*phase, store::ServeFailurePhase::Exchange);
    assert_eq!(message, "frontend actual write failed");
    assert_eq!(outcome.end, sql::End::Failed);
    assert!(
        matches!(&outcome.first_failure, Some(sql::Failure::Transport(message)) if message == "frontend actual write failed")
    );
    assert_eq!(outcome.metrics.rows_copied, 1);
    // The source handed one row to the native visitor. The exact failed-write
    // acknowledgement and Transport first failure above prohibit a delivery claim.
    assert_eq!(outcome.metrics.rows_delivered, 1);
    assert!(matches!(
        outcome.cleanup.rollback,
        sql::CleanupCall::Succeeded
    ));
    assert!(matches!(outcome.cleanup.close, sql::CleanupCall::Succeeded));
    assert!(outcome.retained.is_none());
    drop(retained);
    let query = StoreStatusQuery::new("write-loss".into(), "a".repeat(64), registration);
    let status = registry.lock().unwrap().status(&query);
    assert!(status.present);
    assert_eq!(status.phase, "settled");
    let result = status.completion.unwrap();
    assert!(result.original_project_bound);
    assert_eq!(result.error.as_deref(), Some("Exchange"));
    assert_eq!(result.acquisition.unwrap().rows_delivered, 1);
    assert_eq!(capacity.used.load(Ordering::Acquire), 0);
    f.can_lock();
    assert_eq!(fs::read(&f.database).unwrap(), before);
    // A dropped-retention negative control must make the real status disappear.
    actor.store_records.clear();
    assert!(!registry.lock().unwrap().status(&query).present);
}
#[test]
fn resident_request_cancellation_is_not_global_and_owns_sql_callback() {
    let f = Fixture::new();
    let connection = rusqlite::Connection::open(&f.database).unwrap();
    connection
        .execute_batch("INSERT INTO part VALUES('p2','m',1,'{\"second\":true}')")
        .unwrap();
    connection.close().unwrap();
    let cancelled = Arc::new(AtomicBool::new(false));
    let callback = Arc::clone(&cancelled);
    let part_cells = |row: &sql::StoreRow| match (&row.cells[2], &row.cells[3]) {
        (sql::SqlCell::Text(id), sql::SqlCell::Text(data)) => (id.clone(), data.clone()),
        other => panic!("wrong source storage classes: {other:?}"),
    };
    let mut visited = Vec::new();
    let outcome = sql::acquire_owned(
        f.database.to_str().unwrap(),
        "s",
        sql::AcquisitionLimits {
            max_rows: 2,
            max_cell_bytes: 1024,
            max_total_bytes: 4096,
        },
        sql::OwnedCancellation {
            is_cancelled: Arc::new(move || callback.load(Ordering::Acquire)),
            deadline: expires(),
        },
        |row| {
            assert_eq!(row.ordinal, 1);
            assert!(matches!(&row.cells[0], sql::SqlCell::Text(id) if id == b"m"));
            visited.push(part_cells(&row));
            cancelled.store(true, Ordering::Release);
            Ok::<_, sql::VisitorFailure<String>>(sql::Visit::Continue)
        },
    );
    assert!(matches!(
        outcome.first_failure,
        Some(sql::Failure::Cancelled(sql::CancelReason::Requested))
    ));
    assert_eq!(
        visited,
        vec![(b"p".to_vec(), b"{}".to_vec())],
        "cancellation must precede the second visitor"
    );
    assert_eq!(outcome.metrics.rows_copied, 1);
    assert_eq!(outcome.metrics.rows_delivered, 1);
    assert!(matches!(outcome.cleanup.close, sql::CleanupCall::Succeeded));
    f.can_lock();
    let mut unrelated = Vec::new();
    let other = sql::acquire(
        f.database.to_str().unwrap(),
        "s",
        sql::AcquisitionLimits {
            max_rows: 2,
            max_cell_bytes: 1024,
            max_total_bytes: 4096,
        },
        sql::Cancellation {
            is_cancelled: || false,
            deadline: expires(),
        },
        |row| {
            unrelated.push(part_cells(&row));
            Ok::<_, sql::VisitorFailure<String>>(sql::Visit::Continue)
        },
    );
    assert_eq!(other.end, sql::End::Exhausted);
    assert_eq!(other.metrics.rows_delivered, 2);
    assert_eq!(
        unrelated,
        vec![
            (b"p".to_vec(), b"{}".to_vec()),
            (b"p2".to_vec(), b"{\"second\":true}".to_vec())
        ]
    );
    f.can_lock();
}

fn routing(f: &Fixture) -> Arc<Mutex<Routing>> {
    let custody = journal::Custody::acquire(&custody_path(&f.config), expires()).unwrap();
    Arc::new(Mutex::new(Routing {
        actors: BTreeMap::new(),
        joins: Vec::new(),
        config: Arc::clone(&f.config),
        custody,
        budget: Arc::new(Mutex::new(Budget {
            used: 0,
            maximum: 1,
        })),
        observations: Arc::new(ObservationLog::unavailable(Instant::now())),
    }))
}
fn owner_refusal(
    f: &Fixture,
    routing: Arc<Mutex<Routing>>,
    registry: Arc<Mutex<StoreRegistry>>,
    acquire: StoreAcquire,
) -> StoreCompletion {
    let bytes = encoded(&acquire, f.config.limits.max_frame_bytes as usize).unwrap();
    let (mut owner, mut client) = UnixStream::pair().unwrap();
    owner.set_nonblocking(true).unwrap();
    client.set_nonblocking(true).unwrap();
    let c = Arc::clone(&f.config);
    let handler = thread::spawn(move || {
        assert!(receive_first(
            &mut owner,
            &bytes,
            &[],
            Instant::now(),
            &c,
            &routing,
            &Arc::new(ConnectionPermit(Arc::new(AtomicUsize::new(1)))),
            &registry
        ));
    });
    let completion = loop {
        match command(&mut client) {
            OwnerFrame::Registered { .. } => {}
            OwnerFrame::Complete { completion } => break completion,
            _ => panic!("unexpected grant before refusal"),
        }
    };
    handler.join().unwrap();
    completion
}
#[test]
fn resident_wrong_engine_root_creates_no_foreign_route_or_journal_and_retains_refusal() {
    let original = Fixture::new();
    let foreign = Fixture::new();
    let mut acquire = original.acquire("foreign");
    let mut request: serde_json::Value =
        serde_json::from_slice(&acquire.request().unwrap()).unwrap();
    request["canonicalRoot"] = serde_json::json!(foreign.root.to_str().unwrap());
    acquire.request_base64 = STANDARD.encode(serde_json::to_vec(&request).unwrap());
    acquire.ready_project_digest = Some(sha(foreign.root.to_str().unwrap().as_bytes()));
    acquire.database = Some("/does/not/exist-resident-routing-control".into());
    acquire.caller_environment.insert(
        "CAWS_TRANSCRIPT_DATABASE".into(),
        acquire.database.clone().unwrap(),
    );
    let routing = routing(&original);
    let registry = Arc::new(Mutex::new(StoreRegistry::new(1)));
    let result = owner_refusal(
        &original,
        Arc::clone(&routing),
        Arc::clone(&registry),
        acquire,
    );
    assert!(!result.original_project_bound);
    assert_eq!(result.error.as_deref(), Some("before_acquisition"));
    assert!(
        routing.lock().unwrap().actors.is_empty(),
        "foreign Ready root must never create project state"
    );
    assert!(
        routing
            .lock()
            .unwrap()
            .custody
            .service_keys(2, expires())
            .unwrap()
            .is_empty()
    );
    let registry = registry.lock().unwrap();
    assert_eq!(registry.quarantine.len(), 1);
    let retained = registry.quarantine[0].lock().unwrap();
    assert!(
        matches!(&retained.result, Some(Err(store::ServeError::BeforeAcquisition(message))) if message == "store original project binding mismatch")
    );
    original.can_lock();
    foreign.can_lock();
}
#[test]
fn resident_full_slot_refuses_before_observation_and_leaves_renderer_cleanup_admitted() {
    let f = Fixture::new();
    let routing = routing(&f);
    let registry = Arc::new(Mutex::new(StoreRegistry::new(1)));
    let retained = registry
        .lock()
        .unwrap()
        .reserve(f.acquire("retained"))
        .unwrap();
    let (renderer, mut renderer_caller, _, _) =
        super::super::tests::pending_job_fixture("renderer-still-owned");
    let connections = Arc::clone(&renderer._permit.0);
    let project = Arc::clone(&renderer._project_permit.0);
    let mut acquire = f.acquire("full");
    acquire.caller_cwd = "/does/not/exist-observation-must-not-run".into();
    let result = owner_refusal(&f, Arc::clone(&routing), Arc::clone(&registry), acquire);
    assert_eq!(
        result.error.as_deref(),
        Some("resident store retention capacity exhausted before SQL")
    );
    assert!(!result.original_project_bound);
    assert!(routing.lock().unwrap().actors.is_empty());
    assert_eq!(connections.load(Ordering::Acquire), 1);
    assert_eq!(project.used.load(Ordering::Acquire), 1);
    drop(renderer);
    assert_eq!(connections.load(Ordering::Acquire), 0);
    assert_eq!(project.used.load(Ordering::Acquire), 0);
    assert_eq!(renderer_caller.read(&mut [0]).unwrap(), 0);
    assert_eq!(registry.lock().unwrap().records.len(), 1);
    drop(retained);
    f.can_lock();
}

#[test]
fn resident_store_barrier_retains_waiting_slot_until_renderer_cohort_drains() {
    let f = Fixture::new();
    let registry = Arc::new(Mutex::new(StoreRegistry::new(2)));
    let record = registry
        .lock()
        .unwrap()
        .reserve(f.acquire("barrier"))
        .unwrap();
    record.lock().unwrap().original_project_bound = true;
    let (transport, mut caller, replies) = relay_pair();
    let capacity = Arc::new(ProjectCapacity {
        used: AtomicUsize::new(0),
        maximum: 2,
    });
    let mut waiting = Some(StoreJob {
        record: Arc::clone(&record),
        registry,
        transport,
        _connection: Arc::new(ConnectionPermit(Arc::new(AtomicUsize::new(1)))),
        _project: capacity.acquire().unwrap(),
    });
    let (renderer, _renderer_caller, _, _) =
        super::super::tests::pending_job_fixture("prepared-before-store");
    let mut cohort = VecDeque::from([renderer]);
    assert!(take_after_cohort(&mut waiting, cohort.len()).is_none());
    assert!(waiting.is_some());
    assert!(record.lock().unwrap().result.is_none());
    assert!(
        matches!(caller.read(&mut [0]), Err(error) if error.kind() == io::ErrorKind::WouldBlock),
        "SQL exchange overtook the pending renderer"
    );
    cohort.clear();
    let job = take_after_cohort(&mut waiting, cohort.len())
        .expect("drained cohort releases exact waiting job");
    assert!(waiting.is_none());
    let peer = thread::spawn(move || {
        assert!(matches!(
            command(&mut caller),
            OwnerFrame::Credit { sequence: 1, .. }
        ));
        ack(&replies, 1, Ok(ReplyValue::Credited));
        assert!(matches!(
            command(&mut caller),
            OwnerFrame::WriteEngineFrame { sequence: 2, .. }
        ));
        ack(&replies, 2, Err("barrier-control".into()));
    });
    let mut actor = f.actor();
    actor.acquire_store_job(job);
    peer.join().unwrap();
    assert_eq!(actor.store_records.len(), 1);
    assert_eq!(record.lock().unwrap().phase, "settled");
    assert_eq!(capacity.used.load(Ordering::Acquire), 0);
    f.can_lock();
}
