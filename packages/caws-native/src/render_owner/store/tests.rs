use super::*;
use store::Transport;

fn expires() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
fn retain_deadline_observation(name: &str, observation: serde_json::Value) {
    if let Some(root) = std::env::var_os("CAWS_NATIVE_TEST_ARTIFACT_ROOT") {
        let path = PathBuf::from(root).join(format!("store-deadline-{name}.json"));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .unwrap();
        serde_json::to_writer_pretty(&mut file, &observation).unwrap();
        file.sync_all().unwrap();
    }
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
        let deadline = MonotonicDeadline::capture(Duration::from_secs(5)).unwrap();
        self.acquire_with_deadline(id, &deadline)
    }
    fn acquire_with_deadline(&self, id: &str, deadline: &MonotonicDeadline) -> StoreAcquire {
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
            deadline,
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
        let _ = fs::remove_dir_all(rendezvous(&self.config));
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
            deadline: Arc::new(MonotonicDeadline::capture(Duration::from_secs(5)).unwrap()),
            limit: 2_097_152,
            native: None,
        },
        caller,
        tx,
    )
}
fn bind_deadline(
    mut transport: RelayTransport,
    record: &Arc<Mutex<StoreRecord>>,
) -> RelayTransport {
    let envelope = record.lock().unwrap().original.deadline;
    transport.deadline = Arc::new(MonotonicDeadline::receive(envelope).unwrap());
    transport.expires = transport.expires.min(transport.deadline.expires());
    transport
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
        transport: bind_deadline(transport, &record),
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
    owner_refusal_bytes(f, routing, registry, bytes)
}
fn owner_refusal_bytes(
    f: &Fixture,
    routing: Arc<Mutex<Routing>>,
    registry: Arc<Mutex<StoreRegistry>>,
    bytes: Vec<u8>,
) -> StoreCompletion {
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
        transport: bind_deadline(transport, &record),
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

// This qualification uses the producer's real sealed stages and native worker.
// The ordinary unit selection does not establish this external-fixture contract.
fn fifo_pin(value: &serde_json::Value) -> Vec<u8> {
    let path = Path::new(value["path"].as_str().expect("fixture pin path"));
    canonical(path).unwrap();
    let metadata = fs::symlink_metadata(path).unwrap();
    assert!(metadata.is_file() && metadata.len() <= 32 * 1024 * 1024);
    let bytes = fs::read(path).unwrap();
    assert_eq!(sha(&bytes), value["sha256"].as_str().unwrap());
    for size_field in ["bytes", "sizeBytes"] {
        if !value[size_field].is_null() {
            assert_eq!(bytes.len() as u64, value[size_field].as_u64().unwrap());
        }
    }
    bytes
}
fn fifo_observations(config: &OwnerConfig) -> Vec<serde_json::Value> {
    fs::read_to_string(base(config).join("observations.jsonl"))
        .unwrap()
        .lines()
        .map(|line| {
            let mut value: serde_json::Value = serde_json::from_str(line).unwrap();
            assert_eq!(value["schema"], "caws.render.owner.observation.v1");
            assert!(value["observation"].is_object());
            value["observation"].take()
        })
        .collect()
}
struct FifoActor {
    sender: Option<SyncSender<Mailbox>>,
    peers: Vec<UnixStream>,
    readers: Vec<thread::JoinHandle<()>>,
    actor: Option<thread::JoinHandle<()>>,
}
impl FifoActor {
    fn render(
        &mut self,
        offer: Offer,
        capacity: &Arc<ProjectCapacity>,
        active: &Arc<AtomicUsize>,
        observations: &Arc<ObservationLog>,
        deadline: Instant,
    ) -> UnixStream {
        let (mut reader, caller) = UnixStream::pair().unwrap();
        reader.set_nonblocking(true).unwrap();
        caller.set_nonblocking(true).unwrap();
        let stream = reader.try_clone().unwrap();
        self.peers.push(caller.try_clone().unwrap());
        active.fetch_add(1, Ordering::AcqRel);
        let permit = Arc::new(ConnectionPermit(Arc::clone(active)));
        let project = capacity.acquire().unwrap();
        let (start_tx, start_rx) = mpsc::sync_channel(1);
        let (bridge_tx, bridge_rx) = mpsc::sync_channel(1);
        let invocation = offer.invocation_id.clone();
        let log = Arc::clone(observations);
        self.sender
            .as_ref()
            .unwrap()
            .send(Mailbox::Render(Job {
                stream,
                offer,
                expires: deadline,
                reader_start: Some(start_tx),
                bridge: bridge_rx,
                _permit: Arc::clone(&permit),
                _project_permit: Arc::clone(&project),
            }))
            .unwrap_or_else(|_| panic!("actual Actor mailbox closed"));
        self.readers.push(thread::spawn(move || {
            // The production reader waits on the Actor's actual activation.
            read_prepared_bridge(
                &mut reader,
                start_rx,
                bridge_tx,
                deadline,
                &log,
                &invocation,
            );
            drop((reader, permit, project));
        }));
        caller
    }
    fn stop(&mut self) {
        for peer in &self.peers {
            let _ = peer.shutdown(std::net::Shutdown::Both);
        }
        self.sender.take();
        if let Some(actor) = self.actor.take() {
            assert!(actor.join().is_ok(), "actual Actor panicked");
        }
        for reader in self.readers.drain(..) {
            assert!(reader.join().is_ok(), "actual bridge reader panicked");
        }
    }
}
impl Drop for FifoActor {
    fn drop(&mut self) {
        // Revoke the owned peers and mailbox on an assertion failure too.
        for peer in &self.peers {
            let _ = peer.shutdown(std::net::Shutdown::Both);
        }
        self.sender.take();
        if let Some(actor) = self.actor.take() {
            let _ = actor.join();
        }
        for reader in self.readers.drain(..) {
            let _ = reader.join();
        }
    }
}

#[test]
#[ignore = "requires normally prepared reviewed external image fixture"]
fn resident_actor_run_orders_prepared_renderer_store_and_later_renderer() {
    let fixture_path = PathBuf::from(
        std::env::var_os("CAWS_NATIVE_FIFO_FIXTURE")
            .expect("CAWS_NATIVE_FIFO_FIXTURE must name the normally prepared fixture"),
    );
    canonical(&fixture_path).unwrap();
    let fixture_metadata = fs::symlink_metadata(&fixture_path).unwrap();
    assert!(fixture_metadata.is_file() && fixture_metadata.len() <= 2 * 1024 * 1024);
    let fixture_bytes = fs::read(&fixture_path).unwrap();
    assert!(fixture_bytes.len() <= 2 * 1024 * 1024);
    let fixture: serde_json::Value = serde_json::from_slice(&fixture_bytes).unwrap();
    assert_eq!(
        fixture["schema"],
        "caws.qualification.render-owner.prepared-fixture.v1"
    );
    assert_eq!(fixture["state"], "fixture_prepared");
    assert_eq!(fixture["adoption"], "NOT_ADOPTED");
    let artifact_root = PathBuf::from(fixture["artifactRoot"].as_str().unwrap());
    canonical(&artifact_root).unwrap();
    assert_eq!(fixture_path.parent(), Some(artifact_root.as_path()));
    let config: OwnerConfig = serde_json::from_value(fixture["ownerConfig"].clone()).unwrap();
    validate_config(&config).unwrap();
    assert_eq!(config.home.to_str(), fixture["home"].as_str());
    let project = PathBuf::from(fixture["project"].as_str().unwrap());
    canonical(&project).unwrap();
    let inputs = &fixture["inputs"];
    assert!(inputs["nativeBuild"].is_object());
    let request_digest = inputs["nativeBuild"]["requestDigest"].as_str().unwrap();
    assert!(
        request_digest.len() == 64 && request_digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    );
    assert_eq!(inputs["nativeBuild"]["adoption"], "NOT_ADOPTED");
    assert_eq!(inputs["nativeBuild"]["profile"], "debug");
    fifo_pin(&inputs["nativeBuild"]["requestFile"]);
    fifo_pin(&inputs["nativeBuild"]["prefixManifest"]);
    let receipt: serde_json::Value =
        serde_json::from_slice(&fifo_pin(&inputs["nativeBuild"]["completionReceipt"])).unwrap();
    assert_eq!(receipt["schema"], "caws.native_sqlite_build_receipt.v1");
    assert_eq!(receipt["status"], "completed");
    assert_eq!(receipt["requestDigest"], request_digest);
    assert_eq!(receipt["adoption"], "NOT_ADOPTED");
    assert_eq!(receipt["profile"], "debug");
    assert_eq!(
        receipt["prefixManifest"],
        inputs["nativeBuild"]["prefixManifest"]
    );
    let native_pin = &receipt["artifacts"]["native"];
    assert_eq!(
        native_pin["path"].as_str(),
        config.native_executable.to_str()
    );
    fifo_pin(native_pin);
    fifo_pin(
        &serde_json::json!({"path":inputs["qualifier"]["cliRootSource"],
        "sha256":inputs["qualifier"]["cliRootSourceSha256"]}),
    );
    assert_eq!(inputs["transcript"]["path"], fixture["transcriptFile"]);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&fifo_pin(&inputs["ownerConfig"])).unwrap(),
        fixture["ownerConfig"]
    );
    for name in [
        "qualifier",
        "selection",
        "policy",
        "tools",
        "sourceCustody",
        "transcript",
        "meta",
    ] {
        fifo_pin(&inputs[name]);
    }
    let offers = fixture["offers"].as_array().unwrap();
    assert_eq!(offers.len(), 2);
    let pinned_images = inputs["preparedImages"].as_array().unwrap();
    assert_eq!(pinned_images.len(), 2);
    let mut prepared_offers = Vec::new();
    let mut arguments = Vec::new();
    for (index, label) in ["A", "B"].into_iter().enumerate() {
        assert_eq!(offers[index]["label"], label);
        let offer: Offer = serde_json::from_value(offers[index]["offer"].clone()).unwrap();
        validate_offer(&offer).unwrap();
        assert_eq!(offer.invocation_id, format!("render-owner-fifo:{label}"));
        assert_eq!(
            offer.expected_selection.canonical_project,
            project.to_str().unwrap()
        );
        assert_eq!(
            Some(offer.session_id.as_str()),
            fixture["sessionId"].as_str()
        );
        assert_eq!(
            offer.policy_sha256,
            inputs["policy"]["sha256"].as_str().unwrap()
        );
        assert_eq!(
            serde_json::to_value(&offer.prepared).unwrap(),
            serde_json::from_slice::<serde_json::Value>(&fifo_pin(&pinned_images[index])).unwrap()
        );
        let args: [String; 12] =
            serde_json::from_value(offers[index]["renderArguments"].clone()).unwrap();
        assert_eq!(Some(args[9].as_str()), fixture["transcriptFile"].as_str());
        arguments.push(args);
        prepared_offers.push(offer);
    }
    assert_eq!(
        prepared_offers[0].expected_selection,
        prepared_offers[1].expected_selection
    );
    assert_ne!(
        prepared_offers[0].prepared.staging_root,
        prepared_offers[1].prepared.staging_root
    );
    assert!(
        prepared_offers
            .iter()
            .all(|offer| offer.prepared.staging_root.is_some())
    );
    let config = Arc::new(config);
    let original_deadline =
        MonotonicDeadline::capture(Duration::from_millis(config.limits.request_ms as u64)).unwrap();
    let deadline = original_deadline.expires();
    provision(&config, deadline).unwrap();
    let custody = journal::Custody::acquire(&custody_path(&config), deadline).unwrap();
    let key = wire::project_service_key(project.to_str().unwrap()).unwrap();
    let journal = journal::Journal::open(
        Arc::clone(&custody),
        &key,
        config.limits.max_retained_records,
        deadline,
    )
    .unwrap();
    assert!(!journal.has_unknown(deadline).unwrap());
    let observations = Arc::new(ObservationLog::open(&config, Instant::now()).unwrap());
    let budget = Arc::new(Mutex::new(Budget {
        used: 0,
        maximum: config.limits.max_backends as usize,
    }));
    let capacity = Arc::new(ProjectCapacity {
        used: AtomicUsize::new(0),
        maximum: 1 + config.limits.max_queue_per_project as usize,
    });
    let active = Arc::new(AtomicUsize::new(0));
    let (sender, receiver) = mpsc::sync_channel(config.limits.max_queue_per_project as usize);
    let actor = Actor {
        config: Arc::clone(&config),
        custody,
        writer_custody: None,
        writer_intent: None,
        journal,
        budget: Arc::clone(&budget),
        process: None,
        reserved: false,
        unknown: false,
        observations: Arc::clone(&observations),
        phase: "test",
        store_records: Vec::new(),
    };
    let mut running = FifoActor {
        sender: Some(sender),
        peers: Vec::new(),
        readers: Vec::new(),
        actor: Some(thread::spawn(move || actor.run(receiver))),
    };
    let mut a = running.render(
        prepared_offers[0].clone(),
        &capacity,
        &active,
        &observations,
        deadline,
    );
    let a_bytes = frame(
        &mut a,
        &mut Vec::new(),
        config.limits.max_frame_bytes as usize,
        deadline,
    )
    .unwrap();
    let a_prepared: OwnerPrepared = serde_json::from_slice(&a_bytes).unwrap();
    validate_prepared(&prepared_offers[0], &a_prepared).unwrap();
    assert!(arguments_bound(
        &a_prepared.grant.request(arguments[0].clone()).unwrap(),
        project.to_str().unwrap(),
        &prepared_offers[0].checkout,
        &prepared_offers[0].session_id
    ));

    let database = artifact_root.join("fifo-source.sqlite");
    assert!(!database.exists(), "fixture is single-use; no replay");
    let connection = rusqlite::Connection::open(&database).unwrap();
    connection.execute_batch("CREATE TABLE message(id,session_id,time_created,data);CREATE TABLE part(id,message_id,time_created,data);").unwrap();
    connection
        .execute(
            "INSERT INTO message VALUES('m',?1,0,'{}')",
            [&prepared_offers[0].session_id],
        )
        .unwrap();
    connection
        .execute_batch("INSERT INTO part VALUES('p','m',0,'{}')")
        .unwrap();
    connection.close().unwrap();
    let database_before = fs::read(&database).unwrap();
    let runtime = prepared_offers[0].expected_selection.runtime_digest.clone();
    let payload = RawValue::from_string(
        serde_json::json!({"session_id":prepared_offers[0].session_id,"cwd":project}).to_string(),
    )
    .unwrap();
    let mut environment = prepared_offers[0].caller_environment.clone();
    environment.insert(
        "CAWS_TRANSCRIPT_DATABASE".into(),
        database.to_str().unwrap().into(),
    );
    let id = "render-owner-fifo:S";
    let request = serde_json::to_vec(&serde_json::json!({"schema":store::REQUEST_SCHEMA,"id":id,
        "runtimeDigest":runtime,"token":"fifo-token","canonicalRoot":project,"profile":store::PROFILE})).unwrap();
    let acquisition = StoreAcquire::capture(
        &request,
        store::Invocation {
            id,
            runtime_digest: &runtime,
            original_payload: &payload,
            surface: "opencode",
            event: "stop",
            configuration: "system",
            ready_active: true,
            ready_project_digest: Some(&sha(project.as_os_str().as_encoded_bytes())),
            ready_session_id: Some(&prepared_offers[0].session_id),
            dispatched: true,
            database: database.to_str(),
            caller_cwd: project.to_str().unwrap(),
            caller_environment: &environment,
        },
        &original_deadline,
    );
    let registry = Arc::new(Mutex::new(StoreRegistry::new(
        config.limits.max_retained_records as usize,
    )));
    let record = registry.lock().unwrap().reserve(acquisition).unwrap();
    let registration = record.lock().unwrap().registration.clone();
    let query = StoreStatusQuery::new(id.into(), runtime.clone(), registration);
    let (mut transport, mut store_caller, replies) = relay_pair();
    transport.expires = deadline;
    running.peers.push(store_caller.try_clone().unwrap());
    active.fetch_add(1, Ordering::AcqRel);
    running
        .sender
        .as_ref()
        .unwrap()
        .send(Mailbox::Store(StoreJob {
            record: Arc::clone(&record),
            registry: Arc::clone(&registry),
            transport: bind_deadline(transport, &record),
            _connection: Arc::new(ConnectionPermit(Arc::clone(&active))),
            _project: capacity.acquire().unwrap(),
        }))
        .unwrap_or_else(|_| panic!("actual Actor mailbox closed before S"));
    drop(record); // Status below must depend on the Actor/queued job, not this caller.
    let mut b = running.render(
        prepared_offers[1].clone(),
        &capacity,
        &active,
        &observations,
        deadline,
    );
    let mut barrier_seen = None;
    loop {
        for caller in [&mut store_caller, &mut b] {
            assert!(
                matches!(caller.read(&mut [0u8; 1]), Err(error) if error.kind() == io::ErrorKind::WouldBlock),
                "SQL relay or later renderer grant overtook prepared A"
            );
        }
        let held = fifo_observations(&config);
        assert!(
            !held
                .iter()
                .any(|event| event["stage"] == "store_acquisition_start"
                    || (event["invocationId"] == "render-owner-fifo:B"
                        && event["stage"] == "image_admission"))
        );
        let barriers = held
            .iter()
            .filter(|event| {
                event["event"] == "actor_stage"
                    && event["stage"] == "store_cohort_waiting"
                    && event["invocationId"] == id
            })
            .count();
        assert!(barriers <= 1, "one waiting observation per StoreJob");
        if barriers == 1 {
            let seen = barrier_seen.get_or_insert_with(Instant::now);
            if seen.elapsed() >= Duration::from_millis(250) {
                break;
            }
        }
        assert!(
            Instant::now() < deadline,
            "actual Actor never encountered S behind the prepared A cohort"
        );
        thread::sleep(TICK);
    }
    assert_eq!(registry.lock().unwrap().status(&query).phase, "registered");
    a.shutdown(std::net::Shutdown::Both).unwrap(); // Actual reader EOF revokes A.

    let mut next = || -> OwnerFrame {
        serde_json::from_slice(
            &frame(
                &mut store_caller,
                &mut Vec::new(),
                config.limits.max_frame_bytes as usize,
                deadline,
            )
            .unwrap(),
        )
        .unwrap()
    };
    assert!(matches!(next(), OwnerFrame::Credit { sequence: 1, .. }));
    ack(&replies, 1, Ok(ReplyValue::Credited));
    let OwnerFrame::WriteEngineFrame {
        sequence: 2,
        base64,
    } = next()
    else {
        panic!("S must acquire an actual SQL row")
    };
    let row: serde_json::Value = serde_json::from_slice(&STANDARD.decode(base64).unwrap()).unwrap();
    assert_eq!(row["schema"], store::ROW_SCHEMA);
    assert_eq!(row["id"], id);
    assert_eq!(row["ordinal"], 1);
    assert_eq!(row["cells"][0]["base64"], STANDARD.encode(b"m"));
    assert_eq!(row["cells"][2]["base64"], STANDARD.encode(b"p"));
    ack(&replies, 2, Ok(ReplyValue::Written));
    assert!(matches!(
        next(),
        OwnerFrame::ReadEngineFrame { sequence: 3 }
    ));
    let control = serde_json::to_vec(&serde_json::json!({"schema":store::CONTROL_SCHEMA,"id":id,
        "runtimeDigest":runtime,"token":"fifo-token","ordinal":1,"action":"continue"}))
    .unwrap();
    ack(
        &replies,
        3,
        Ok(ReplyValue::Read {
            base64: STANDARD.encode(control),
        }),
    );
    assert!(matches!(next(), OwnerFrame::Credit { sequence: 4, .. }));
    ack(&replies, 4, Ok(ReplyValue::Credited));
    let OwnerFrame::WriteEngineFrame {
        sequence: 5,
        base64,
    } = next()
    else {
        panic!("S CLOSED missing")
    };
    let closed: serde_json::Value =
        serde_json::from_slice(&STANDARD.decode(base64).unwrap()).unwrap();
    assert_eq!(closed["schema"], store::CLOSED_SCHEMA);
    assert_eq!(closed["end"], "exhausted");
    assert_eq!(closed["closed"], true);
    assert_eq!(closed["failure"], serde_json::Value::Null);
    ack(&replies, 5, Ok(ReplyValue::Written));
    let OwnerFrame::Complete { completion } = next() else {
        panic!("S settlement missing")
    };
    assert!(completion.error.is_none());
    assert!(completion.retained);
    let acquisition = completion.acquisition.unwrap();
    assert_eq!(acquisition.rows_delivered, 1);
    assert_eq!(acquisition.close, "succeeded");
    assert!(!acquisition.retained_handle && !acquisition.retained_uncertain);
    let b_bytes = frame(
        &mut b,
        &mut Vec::new(),
        config.limits.max_frame_bytes as usize,
        deadline,
    )
    .unwrap();
    let b_prepared: OwnerPrepared = serde_json::from_slice(&b_bytes).unwrap();
    validate_prepared(&prepared_offers[1], &b_prepared).unwrap();
    assert!(arguments_bound(
        &b_prepared.grant.request(arguments[1].clone()).unwrap(),
        project.to_str().unwrap(),
        &prepared_offers[1].checkout,
        &prepared_offers[1].session_id
    ));
    assert_eq!(registry.lock().unwrap().status(&query).phase, "settled");
    b.shutdown(std::net::Shutdown::Both).unwrap();
    running.stop();
    assert_eq!(active.load(Ordering::Acquire), 0);
    assert_eq!(capacity.used.load(Ordering::Acquire), 0);
    assert_eq!(budget.lock().unwrap().used, 0);
    assert_eq!(fs::read(&database).unwrap(), database_before);
    let connection = rusqlite::Connection::open(&database).unwrap();
    connection
        .execute_batch("BEGIN EXCLUSIVE;ROLLBACK")
        .unwrap();
    connection.close().unwrap();
    drop(crate::render_writer::acquire(&config.home, &project, deadline).unwrap());
    let events = fifo_observations(&config);
    let position = |event: &str, invocation: &str, stage: Option<&str>| {
        let matches: Vec<_> = events
            .iter()
            .enumerate()
            .filter(|(_, value)| {
                value["event"] == event
                    && value["invocationId"] == invocation
                    && stage.is_none_or(|stage| value["stage"] == stage)
            })
            .collect();
        assert_eq!(
            matches.len(),
            1,
            "exact event {event}/{invocation}/{stage:?}"
        );
        matches[0].0
    };
    let order = [
        position("prepared", "render-owner-fifo:A", None),
        position("actor_stage", id, Some("store_cohort_waiting")),
        position("prepared_withdrawn", "render-owner-fifo:A", None),
        position("actor_stage", "render-owner-fifo:A", Some("finish")),
        position("actor_stage", id, Some("store_acquisition_start")),
        position("actor_stage", id, Some("store_settlement_retained")),
        position(
            "actor_stage",
            "render-owner-fifo:B",
            Some("image_admission"),
        ),
        position("prepared", "render-owner-fifo:B", None),
        position("prepared_withdrawn", "render-owner-fifo:B", None),
    ];
    assert!(
        order.windows(2).all(|pair| pair[0] < pair[1]),
        "actual Actor order: {order:?}"
    );
    let workers: Vec<_> = events
        .iter()
        .filter(|value| value["event"] == "worker_created")
        .collect();
    assert!(!workers.is_empty(), "actual admitted worker required");
    for worker in workers {
        let cleanups: Vec<_> = events
            .iter()
            .filter(|value| {
                value["event"] == "worker_cleanup"
                    && value["nativeWorkerPid"] == worker["nativeWorkerPid"]
                    && value["backendPid"] == worker["backendPid"]
            })
            .collect();
        assert_eq!(cleanups.len(), 1);
        let receipt = &cleanups[0]["receipt"];
        assert_eq!(receipt["directChildReaped"], true);
        assert_eq!(receipt["stdout"]["eof"], true);
        assert_eq!(receipt["stderr"]["eof"], true);
        assert_eq!(receipt["deadlineExceeded"], false);
        assert_eq!(
            events
                .iter()
                .filter(|value| value["event"] == "worker_exit"
                    && value["nativeWorkerPid"] == worker["nativeWorkerPid"])
                .count(),
            1
        );
    }
    fs::write(
        artifact_root.join("fifo-actor-order.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
        "fixtureSha256":sha(&fixture_bytes),"actualOrder":order,"sqlRow":row,"closed":closed,
        "backendPids":[a_prepared.backend_pid,b_prepared.backend_pid],
        "ownerPreparedFramesBase64":[STANDARD.encode(&a_bytes),STANDARD.encode(&b_bytes)],"events":events}))
        .unwrap(),
    )
    .unwrap();
    println!(
        "actual Actor A withdrawal -> SQL row/CLOSED/retained -> B prepared; fixture={}; order={order:?}",
        fixture_path.display()
    );
}

#[test]
fn sql_control_512_bound_is_independent_from_publication_read_and_credit() {
    for (publication, length, allowed) in
        [(false, 512, true), (false, 513, false), (true, 513, true)]
    {
        let (mut relay, mut caller, replies) = relay_pair();
        let join = thread::spawn(move || {
            if publication {
                publication::Transport::read(&mut relay, expires())
            } else {
                store::Transport::read(&mut relay, expires())
            }
        });
        match command(&mut caller) {
            OwnerFrame::ReadEngineFrame { sequence } => {
                assert!(!publication);
                assert_eq!(sequence, 1);
            }
            OwnerFrame::PublicationReadEngineFrame { sequence } => {
                assert!(publication);
                assert_eq!(sequence, 1);
            }
            _ => panic!("wrong read operation"),
        }
        ack(
            &replies,
            1,
            Ok(ReplyValue::Read {
                base64: STANDARD.encode(vec![b'x'; length]),
            }),
        );
        let result = join.join().unwrap();
        assert_eq!(result.is_ok(), allowed, "{result:?}");
        if allowed {
            assert_eq!(result.unwrap(), vec![b'x'; length]);
        }
    }
}
#[test]
fn publication_credit_requires_exact_delivery_ack_sequence_and_operation() {
    for wrong_sequence in [false, true] {
        let (mut relay, mut caller, replies) = relay_pair();
        let join = thread::spawn(move || publication::Transport::credit(&mut relay, 73));
        match command(&mut caller) {
            OwnerFrame::PublicationCredit { sequence, bytes } => {
                assert_eq!(sequence, 1);
                assert_eq!(bytes, 73);
            }
            _ => panic!("SQL credit must not carry publication credit"),
        }
        ack(
            &replies,
            if wrong_sequence { 2 } else { 1 },
            Ok(ReplyValue::Credited),
        );
        let result = join.join().unwrap();
        assert_eq!(result.is_ok(), !wrong_sequence);
        if wrong_sequence {
            assert!(result.unwrap_err().contains("acknowledgement mismatch"));
        }
    }
}

#[test]
fn publication_write_outer_envelope_does_not_widen_sql_write_variant() {
    let inner = publication_wire::MAX_FRAME_BYTES;
    let (mut relay, mut caller, replies) = relay_pair();
    let join = thread::spawn(move || {
        publication::Transport::write(&mut relay, &vec![b'x'; inner], expires()).unwrap();
        assert!(
            publication::Transport::write(&mut relay, &vec![b'x'; inner + 1], expires()).is_err()
        );
        assert!(store::Transport::write(&mut relay, &vec![b'x'; inner], expires()).is_err());
    });
    let bytes = frame(
        &mut caller,
        &mut Vec::new(),
        publication_wire::MAX_RELAY_FRAME_BYTES,
        expires(),
    )
    .unwrap();
    assert!(bytes.len() > inner);
    match decode_owner_frame(&bytes, inner).unwrap() {
        OwnerFrame::PublicationWriteEngineFrame { sequence, base64 } => {
            assert_eq!(sequence, 1);
            assert_eq!(STANDARD.decode(base64).unwrap(), vec![b'x'; inner]);
        }
        _ => panic!("wrong publication write variant"),
    }
    ack(&replies, 1, Ok(ReplyValue::Written));
    join.join().unwrap();
    let wrong = encoded(
        &OwnerFrame::WriteEngineFrame {
            sequence: 1,
            base64: STANDARD.encode(vec![b'x'; inner]),
        },
        publication_wire::MAX_RELAY_FRAME_BYTES,
    )
    .unwrap();
    assert!(
        decode_owner_frame(&wrong, inner)
            .err()
            .unwrap()
            .contains("variant envelope bound")
    );
}

#[test]
fn store_acquisition_requires_versioned_absolute_expiry_not_remaining_budget() {
    let f = Fixture::new();
    let value = serde_json::to_value(f.acquire("absolute-contract")).unwrap();
    assert_eq!(value["schema"], "caws.render.owner.store-acquire.v2");
    assert!(
        value.get("remainingBudgetMs").is_none(),
        "relative budget must not survive IPC"
    );
    let start = value["deadline"]["startedNs"]
        .as_u64()
        .expect("original native start");
    let end = value["deadline"]["expiresNs"]
        .as_u64()
        .expect("original absolute expiry");
    assert!(end > start);
    assert!(end - start <= 120_000_000_000);
}

#[test]
fn invalid_expired_and_other_version_carriers_refuse_before_registry_or_routing() {
    let f = Fixture::new();
    let route = routing(&f);
    let registry = Arc::new(Mutex::new(StoreRegistry::new(1)));
    for (kind, expected) in [
        (
            "missing",
            "resident store invalid v2 absolute deadline envelope",
        ),
        (
            "unknown-field",
            "resident store invalid v2 absolute deadline envelope",
        ),
        (
            "wrong-type",
            "resident store invalid v2 absolute deadline envelope",
        ),
        ("expired", "Original monotonic deadline expired"),
        ("future", "Monotonic deadline starts after native now"),
        ("cap", "Monotonic deadline exceeds 120000ms"),
        (
            "v1",
            "resident store unsupported acquisition schema; v2 absolute deadline required",
        ),
        (
            "unknown-version",
            "resident store unsupported acquisition schema; v2 absolute deadline required",
        ),
    ] {
        let mut raw = serde_json::to_value(f.acquire(kind)).unwrap();
        match kind {
            "missing" => {
                raw.as_object_mut().unwrap().remove("deadline");
            }
            "unknown-field" => {
                raw["deadline"]["remainingBudgetMs"] = serde_json::json!(5000);
            }
            "wrong-type" => {
                raw["deadline"]["expiresNs"] = serde_json::json!("5000");
            }
            "expired" => {
                raw["deadline"] = serde_json::json!({"startedNs":0,"expiresNs":1});
            }
            "future" => {
                raw["deadline"] = serde_json::json!({"startedNs":u64::MAX-1,"expiresNs":u64::MAX});
            }
            "cap" => {
                raw["deadline"] = serde_json::json!({"startedNs":0,"expiresNs":120_000_000_001u64});
            }
            "v1" => {
                raw["schema"] = serde_json::json!("caws.render.owner.store-acquire.v1");
                raw.as_object_mut().unwrap().remove("deadline");
                raw["remainingBudgetMs"] = serde_json::json!(5000);
            }
            "unknown-version" => {
                raw["schema"] = serde_json::json!("caws.render.owner.store-acquire.v99");
            }
            _ => unreachable!(),
        }
        let mut bytes = serde_json::to_vec(&raw).unwrap();
        bytes.push(b'\n');
        let result = owner_refusal_bytes(&f, Arc::clone(&route), Arc::clone(&registry), bytes);
        assert_eq!(result.error.as_deref(), Some(expected), "{kind}");
        assert_eq!(result.id, kind);
        assert!(result.registration.is_none());
        assert!(!result.original_project_bound);
        assert!(result.acquisition.is_none());
        assert!(
            registry.lock().unwrap().is_empty(),
            "{kind} reserved a record"
        );
        assert!(
            route.lock().unwrap().actors.is_empty(),
            "{kind} routed an actor"
        );
    }
    f.can_lock();
}

#[test]
fn registry_lock_wait_cannot_reserve_after_original_or_receiver_cap_expiry() {
    for original_expires_first in [true, false] {
        let f = Fixture::new();
        let route = routing(&f);
        let registry = Arc::new(Mutex::new(StoreRegistry::new(1)));
        let mut config = (*f.config).clone();
        config.limits.request_ms = if original_expires_first { 5000 } else { 500 };
        let config = Arc::new(config);
        let (mut owner, mut client) = UnixStream::pair().unwrap();
        owner.set_nonblocking(true).unwrap();
        client.set_nonblocking(true).unwrap();
        let (at_lock, reached_lock) = mpsc::sync_channel(1);
        let (finished, completed) = mpsc::sync_channel(1);
        // Own the lock before the receiving thread can start admission.
        let locked = registry.lock().unwrap();
        let deadline = MonotonicDeadline::capture(if original_expires_first {
            Duration::from_millis(500)
        } else {
            Duration::from_secs(5)
        })
        .unwrap();
        let acquire = f.acquire_with_deadline("registry-wait", &deadline);
        let bytes = encoded(&acquire, config.limits.max_frame_bytes as usize).unwrap();
        let received = Instant::now();
        let effective = deadline
            .expires()
            .min(received + Duration::from_millis(u64::from(config.limits.request_ms)));
        let worker_registry = Arc::clone(&registry);
        let worker_route = Arc::clone(&route);
        let handler = thread::spawn(move || {
            BEFORE_STORE_REGISTRY_LOCK.with(|slot| *slot.borrow_mut() = Some(at_lock));
            assert!(receive_first(
                &mut owner,
                &bytes,
                &[],
                received,
                &config,
                &worker_route,
                &Arc::new(ConnectionPermit(Arc::new(AtomicUsize::new(1)))),
                &worker_registry
            ));
            finished.send(()).unwrap();
        });
        assert!(
            reached_lock.recv_timeout(Duration::from_secs(1)).unwrap(),
            "receive_first must reach a genuinely contended registry mutex"
        );
        assert!(
            Instant::now() < effective,
            "receiver did not reach contention while live"
        );
        let bound = Instant::now() + Duration::from_secs(2);
        while Instant::now() < effective && Instant::now() < bound {
            thread::sleep(TICK);
        }
        assert!(
            Instant::now() >= effective,
            "fixture did not cross effective expiry"
        );
        if original_expires_first {
            assert!(deadline.check().is_err());
        } else {
            assert!(
                deadline.check().is_ok(),
                "cap control must retain a live original"
            );
        }
        drop(locked);
        completed
            .recv_timeout(Duration::from_secs(1))
            .expect("receiver did not finish bounded refusal");
        handler.join().unwrap();
        // Inspect authority state before transport decoding: an omitted check
        // can reserve and then fail its expired Registered write without bytes.
        retain_deadline_observation(
            if original_expires_first {
                "registry-original"
            } else {
                "registry-cap"
            },
            serde_json::json!({
                "schema":"caws.store_deadline_observation.v1",
                "originalDeadline": deadline.envelope(),
                "originalExpired": deadline.check().is_err(),
                "effectiveExpired": Instant::now() >= effective,
                "registryEmpty": registry.lock().unwrap().is_empty(),
                "actorCount": route.lock().unwrap().actors.len(),
                "boundary":"actual receive_first under synchronized mutex contention; no installed frontend"
            }),
        );
        assert!(
            registry.lock().unwrap().is_empty(),
            "expired waiter reserved a record"
        );
        assert!(
            route.lock().unwrap().actors.is_empty(),
            "expired waiter created a route"
        );
        let result = match command(&mut client) {
            OwnerFrame::Complete { completion } => completion,
            _ => panic!("expired mutex waiter registered or issued a relay command"),
        };
        assert_eq!(
            result.error.as_deref(),
            Some(if original_expires_first {
                "Original monotonic deadline expired"
            } else {
                "renderer owner deadline expired"
            })
        );
        assert!(result.registration.is_none());
        assert!(!result.original_project_bound);
        assert!(result.acquisition.is_none());
        f.can_lock();
    }
}

#[test]
fn delayed_capture_preserves_exact_original_envelope_and_cannot_remint_expiry() {
    let f = Fixture::new();
    let route = routing(&f);
    let registry = Arc::new(Mutex::new(StoreRegistry::new(1)));
    let deadline = MonotonicDeadline::capture(Duration::from_millis(50)).unwrap();
    let original = deadline.envelope();
    let bound = Instant::now() + Duration::from_secs(1);
    while deadline.check().is_ok() && Instant::now() < bound {
        thread::sleep(TICK);
    }
    assert!(
        deadline.check().is_err(),
        "fixture never crossed original expiry"
    );
    let acquire = f.acquire_with_deadline("delayed-capture", &deadline);
    assert_eq!(
        acquire.deadline, original,
        "capture must forward, never remint the interval"
    );
    let result = owner_refusal(&f, Arc::clone(&route), Arc::clone(&registry), acquire);
    retain_deadline_observation(
        "delayed-capture",
        serde_json::json!({
            "schema":"caws.store_deadline_observation.v1", "originalDeadline":original,
            "completion":result, "registryEmpty":registry.lock().unwrap().is_empty(),
            "actorCount":route.lock().unwrap().actors.len(),
            "boundary":"actual capture and receiver; no installed frontend"
        }),
    );
    assert_eq!(
        result.error.as_deref(),
        Some("Original monotonic deadline expired")
    );
    assert!(result.registration.is_none());
    assert!(!result.original_project_bound);
    assert!(result.acquisition.is_none());
    assert!(registry.lock().unwrap().is_empty());
    assert!(route.lock().unwrap().actors.is_empty());
    f.can_lock();
}

#[test]
fn owner_request_limit_is_an_earlier_cap_and_never_changes_original_envelope() {
    let f = Fixture::new();
    let acquire = f.acquire("cap");
    let received = Instant::now();
    let (deadline, expires) = restore_deadline(&acquire, received, 1000).unwrap();
    assert_eq!(deadline.envelope(), acquire.deadline);
    assert_eq!(expires, received + Duration::from_secs(1));
    let (_, original_cap) = restore_deadline(&acquire, received, 120_000).unwrap();
    assert!(original_cap > expires);
    assert!(original_cap < received + Duration::from_secs(6));
}

fn fixture_file_bytes(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(path: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.is_file() {
                out.insert(path.clone(), fs::read(path).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, &mut out);
    out
}

#[test]
fn queued_expiry_precedes_publication_reservation_writer_and_sql() {
    for publication in [false, true] {
        let f = Fixture::new();
        let mut actor = f.actor();
        let mut acquire = f.acquire("queued-expiry");
        let deadline = MonotonicDeadline::capture(Duration::from_millis(50)).unwrap();
        acquire.deadline = deadline.envelope();
        acquire.publication = publication;
        let registry = Arc::new(Mutex::new(StoreRegistry::new(1)));
        let record = registry.lock().unwrap().reserve(acquire).unwrap();
        record.lock().unwrap().original_project_bound = true;
        let (transport, _caller, _replies) = relay_pair();
        let transport = bind_deadline(transport, &record);
        let capacity = Arc::new(ProjectCapacity {
            used: AtomicUsize::new(0),
            maximum: 1,
        });
        let job = StoreJob {
            record: Arc::clone(&record),
            registry,
            transport,
            _connection: Arc::new(ConnectionPermit(Arc::new(AtomicUsize::new(1)))),
            _project: capacity.acquire().unwrap(),
        };
        let files_before = fixture_file_bytes(&f.root);
        let bound = Instant::now() + Duration::from_secs(1);
        while deadline.check().is_ok() && Instant::now() < bound {
            thread::sleep(TICK);
        }
        assert!(
            deadline.check().is_err(),
            "fixture never crossed original expiry"
        );
        actor.acquire_store_job(job);
        let completion = record.lock().unwrap().completion();
        assert_eq!(completion.error.as_deref(), Some("after_project_binding"));
        let retained = record.lock().unwrap();
        let files_after = fixture_file_bytes(&f.root);
        let hashes = |files: &BTreeMap<PathBuf, Vec<u8>>| {
            files
                .iter()
                .map(|(p, b)| {
                    (
                        p.strip_prefix(&f.root)
                            .unwrap()
                            .to_string_lossy()
                            .into_owned(),
                        sha(b),
                    )
                })
                .collect::<BTreeMap<_, _>>()
        };
        retain_deadline_observation(
            if publication {
                "queued-publication"
            } else {
                "queued-raw"
            },
            serde_json::json!({
                "schema":"caws.store_deadline_observation.v1", "publicationRequested":publication,
                "completion":completion, "actorPhase":actor.phase,
                "writerPresent":retained.writer.is_some(), "publicationPresent":retained.publication.is_some(),
                "writerCustodyPresent":actor.writer_custody.is_some(),
                "filesBefore":hashes(&files_before), "filesAfter":hashes(&files_after),
                "boundary":"actual expired StoreJob actor call with real SQLite fixture; no installed frontend"
            }),
        );
        assert!(
            matches!(&retained.result,Some(Err(store::ServeError::AfterProjectBinding(message))) if message=="Original monotonic deadline expired")
        );
        assert!(
            completion.acquisition.is_none(),
            "SQL was reached after queue expiry"
        );
        assert!(retained.writer.is_none());
        assert!(retained.publication.is_none());
        assert!(actor.writer_custody.is_none());
        assert!(!actor.journal.has_unknown(expires()).unwrap());
        assert_eq!(actor.phase, "store_deadline_refused");
        assert_eq!(
            fixture_file_bytes(&f.root),
            files_before,
            "expired job changed journal/writer/source files"
        );
        f.can_lock();
    }
}

#[test]
fn old_owner_offer_parser_closure_is_identified_before_registration() {
    let f = Fixture::new();
    private_dir(&rendezvous(&f.config), true).unwrap();
    let listener = UnixListener::bind(socket_path(&f.config)).unwrap();
    listener.set_nonblocking(true).unwrap();
    fs::set_permissions(socket_path(&f.config), fs::Permissions::from_mode(0o600)).unwrap();
    let peer = thread::spawn(move || {
        let until = Instant::now() + Duration::from_secs(2);
        let (mut stream, _) = loop {
            match listener.accept() {
                Ok(peer) => break peer,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < until, "frontend never connected");
                    thread::sleep(TICK);
                }
                Err(error) => panic!("old owner fixture accept: {error}"),
            }
        };
        stream.set_nonblocking(true).unwrap();
        let bytes = frame(&mut stream, &mut Vec::new(), 2_097_152, expires()).unwrap();
        let header: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(header["schema"], "caws.render.owner.store-acquire.v2");
        // An older owner does not recognize v2, then runs this unchanged Offer
        // decoder and closes without registering/routing the store operation.
        assert!(serde_json::from_slice::<Offer>(&bytes).is_err());
    });
    let (mut relay, _caller, _replies) = relay_pair();
    let result = acquire_store(
        &f.config,
        f.acquire("old-owner"),
        expires(),
        || false,
        &mut relay,
    );
    peer.join().unwrap();
    assert_eq!(
        result.error.as_deref(),
        Some(
            "resident store acquisition v2 unavailable before registration: renderer owner peer EOF"
        )
    );
    assert!(result.registration.is_none());
    assert!(result.acquisition.is_none());
    assert!(!result.original_project_bound);
    f.can_lock();
}

#[test]
fn late_relay_acknowledgement_cannot_succeed_past_original_expiry() {
    let (mut relay, mut caller, replies) = relay_pair();
    let deadline = Arc::new(MonotonicDeadline::capture(Duration::from_millis(50)).unwrap());
    relay.expires = deadline.expires();
    relay.deadline = Arc::clone(&deadline);
    let (sent, received) = mpsc::sync_channel(1);
    let join = thread::spawn(move || sent.send(relay.write(b"sentinel\n", expires())).unwrap());
    assert!(matches!(
        command(&mut caller),
        OwnerFrame::WriteEngineFrame { sequence: 1, .. }
    ));
    let bound = Instant::now() + Duration::from_secs(1);
    while deadline.check().is_ok() && Instant::now() < bound {
        thread::sleep(TICK);
    }
    assert!(deadline.check().is_err());
    // The relay may already have returned on its periodic deadline check.
    let _ = replies.try_send(RelayReply {
        schema: REPLY_SCHEMA.into(),
        sequence: 1,
        result: Ok(ReplyValue::Written),
    });
    let error = received
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .unwrap_err();
    assert_eq!(error, "Original monotonic deadline expired");
    join.join().unwrap();
}

// Raw native-shaped transport data deliberately cannot construct a production
// native capability. Positive original/prefix ownership is exercised by the
// existing real-custodian integration target; installed main integration is a
// separate required trace, not inferred from these socket controls.
fn native_transport_fixture(f: &Fixture, id: &str) -> StoreAcquire {
    let mut acquire = f.acquire(id);
    acquire.original_payload =
        RawValue::from_string(serde_json::json!({"session_id":"s", "cwd":f.root}).to_string())
            .unwrap();
    acquire.schema = NATIVE_ACQUIRE_SCHEMA.into();
    acquire.publication = true;
    acquire.native_stop = Some(NativeStopBinding {
        canonical_root: f.root.to_str().unwrap().into(),
        render_cwd: f.root.to_str().unwrap().into(),
        session_id: "s".into(),
        payload_sha256: sha(acquire.original_payload.get().as_bytes()),
        prefix_sha256: "b".repeat(64),
        prefix_token: "fixture-prefix".into(),
        original_deadline: acquire.deadline,
    });
    acquire
}
fn native_challenge(
    acquire: &StoreAcquire,
    sequence: u64,
    phase: NativeStopPhase,
) -> NativeChallengeFrame {
    NativeChallengeFrame {
        sequence,
        id: acquire.id.clone(),
        runtime_digest: acquire.runtime_digest.clone(),
        registration: "c".repeat(64),
        binding_digest: acquire
            .native_stop
            .as_ref()
            .unwrap()
            .digest(acquire)
            .unwrap(),
        original_deadline: acquire.deadline,
        challenge: "d".repeat(64),
        phase,
    }
}
fn native_challenge_over_socket(challenge: NativeChallengeFrame) -> NativeChallengeFrame {
    let (sender, mut receiver) = UnixStream::pair().unwrap();
    sender.set_nonblocking(true).unwrap();
    receiver.set_nonblocking(true).unwrap();
    write_all(
        &sender,
        &encoded(&OwnerFrame::NativeStopCheck(challenge), STATUS_MAX).unwrap(),
        expires(),
    )
    .unwrap();
    let received = frame(&mut receiver, &mut Vec::new(), STATUS_MAX, expires()).unwrap();
    match decode_owner_frame(&received, STATUS_MAX).unwrap() {
        OwnerFrame::NativeStopCheck(value) => value,
        _ => panic!("native-only challenge became an engine relay command"),
    }
}
fn retain_registration_observation(name: &str, value: serde_json::Value) {
    if let Some(root) = std::env::var_os("CAWS_NATIVE_TEST_ARTIFACT_ROOT") {
        let path = PathBuf::from(root).join(format!("native-registration-{name}.json"));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .unwrap();
        serde_json::to_writer_pretty(&mut file, &value).unwrap();
        file.sync_all().unwrap();
    }
}

#[test]
fn native_phase_sequence_accepts_cold_and_retained_writer_without_skipping_checks() {
    use NativeStopPhase::*;
    let f = Fixture::new();
    let acquire = native_transport_fixture(&f, "native-phases");
    let registration = "c".repeat(64);
    let mut observations = Vec::new();
    for locked in [true, false] {
        let mut phases = vec![BeforeReservation, BeforeWriter];
        if locked {
            phases.push(WriterLocked);
        }
        phases.extend([WriterRetired, BeforeSql, BeforePublication]);
        let mut state = NativeChallengeState::default();
        for (index, phase) in phases.iter().enumerate() {
            let sequence = index as u64 + 1;
            let frame = native_challenge_over_socket(native_challenge(&acquire, sequence, *phase));
            state
                .accept(&acquire, Some(&registration), true, sequence, &frame)
                .unwrap();
        }
        assert_eq!(state.checks, phases.len());
        assert_eq!(state.last_phase, Some(BeforePublication));
        let replay = native_challenge_over_socket(native_challenge(
            &acquire,
            phases.len() as u64 + 1,
            BeforePublication,
        ));
        let error = state
            .accept(
                &acquire,
                Some(&registration),
                true,
                replay.sequence,
                &replay,
            )
            .unwrap_err();
        assert_eq!(
            error,
            "native Stop challenge correlation, phase or budget mismatch"
        );
        assert_eq!(state.checks, phases.len());
        observations.push(serde_json::json!({"writerLockAcquired":locked,"phases":phases,"acceptedChecks":state.checks,"terminalReplayError":error}));
    }
    retain_registration_observation(
        "phase-sequences",
        serde_json::json!({"scope":"Real socket frames through client phase validation; no authenticated native owner, SQL or production dispatch", "observations":observations}),
    );
}
#[test]
fn native_challenge_socket_rejects_foreign_identity_clock_phase_and_replay() {
    let f = Fixture::new();
    let acquire = native_transport_fixture(&f, "native-wire");
    let registration = "c".repeat(64);
    let mut state = NativeChallengeState::default();
    let first = native_challenge_over_socket(native_challenge(
        &acquire,
        1,
        NativeStopPhase::BeforeReservation,
    ));
    state
        .accept(&acquire, Some(&registration), true, 1, &first)
        .unwrap();
    assert_eq!(state.checks, 1);
    assert_eq!(state.last_phase, Some(NativeStopPhase::BeforeReservation));
    assert_eq!(
        state
            .accept(&acquire, Some(&registration), true, 2, &first)
            .unwrap_err(),
        "native Stop challenge correlation, phase or budget mismatch"
    );
    let mut refusals = Vec::new();
    for defect in [
        "id",
        "generation",
        "registration",
        "digest",
        "clock",
        "sequence",
        "phase",
        "nonce",
    ] {
        let mut value = native_challenge(&acquire, 1, NativeStopPhase::BeforeReservation);
        match defect {
            "id" => value.id = "another-original".into(),
            "generation" => value.runtime_digest = "f".repeat(64),
            "registration" => value.registration = "e".repeat(64),
            "digest" => value.binding_digest = "e".repeat(64),
            "clock" => value.original_deadline.expires_ns += 1,
            "sequence" => value.sequence = 2,
            "phase" => value.phase = NativeStopPhase::BeforeSql,
            "nonce" => value.challenge = "invalid nonce".into(),
            _ => unreachable!(),
        }
        let received = native_challenge_over_socket(value);
        let mut state = NativeChallengeState::default();
        let error = state
            .accept(&acquire, Some(&registration), true, 1, &received)
            .unwrap_err();
        assert_eq!(
            error, "native Stop challenge correlation, phase or budget mismatch",
            "{defect}"
        );
        assert_eq!(
            state.checks, 0,
            "foreign challenge consumed a valid phase: {defect}"
        );
        refusals.push(serde_json::json!({"defect":defect,"received":received,"error":error,"acceptedChecks":state.checks}));
    }
    retain_registration_observation(
        "foreign-challenges",
        serde_json::json!({"scope":"Actual socket framing and correlation validation, not native admission", "acceptedFirst":first,"refusals":refusals}),
    );
}
#[test]
fn native_wire_checks_generation_before_registry_and_never_uses_publication_boolean_as_grant() {
    // This incomplete-generation socket control pins admission ordering.
    // tests/native_peer.rs separately exercises actual native/Node process
    // identities against a complete synthetic installed generation.
    let f = Fixture::new();
    let route = routing(&f);
    let registry = Arc::new(Mutex::new(StoreRegistry::new(1)));
    let acquire = native_transport_fixture(&f, "raw-native-wire");
    acquire
        .native_stop
        .as_ref()
        .unwrap()
        .validate(&acquire, &acquire.request().unwrap())
        .unwrap();
    let generation = f
        .config
        .home
        .join("lib/runtimes")
        .join(&acquire.runtime_digest);
    fs::create_dir_all(&generation).unwrap();
    fs::write(generation.join("manifest.json"), b"{}").unwrap();
    let before = fixture_file_bytes(&f.root);
    let bytes = encoded(&acquire, f.config.limits.max_frame_bytes as usize).unwrap();
    let (mut owner, mut client) = UnixStream::pair().unwrap();
    owner.set_nonblocking(true).unwrap();
    client.set_nonblocking(true).unwrap();
    let config = Arc::clone(&f.config);
    let routed = Arc::clone(&route);
    let retained = Arc::clone(&registry);
    let joined = thread::spawn(move || {
        let received = frame(
            &mut owner,
            &mut Vec::new(),
            config.limits.max_frame_bytes as usize,
            expires(),
        )
        .unwrap();
        assert!(receive_first(
            &mut owner,
            &received,
            &[],
            Instant::now(),
            &config,
            &routed,
            &Arc::new(ConnectionPermit(Arc::new(AtomicUsize::new(1)))),
            &retained
        ));
    });
    write_all(&client, &bytes, expires()).unwrap();
    let completion = match command(&mut client) {
        OwnerFrame::Complete { completion } => completion,
        _ => panic!("raw same-UID socket peer reached registration before native admission"),
    };
    joined.join().unwrap();
    assert_eq!(
        completion.error.as_deref(),
        Some("Runtime manifest integrity failure")
    );
    assert!(completion.registration.is_none());
    assert!(!completion.original_project_bound);
    assert!(completion.acquisition.is_none());
    assert!(registry.lock().unwrap().is_empty());
    assert!(route.lock().unwrap().actors.is_empty());
    assert_eq!(fixture_file_bytes(&f.root), before);
    let file_hashes: BTreeMap<_, _> = before
        .iter()
        .map(|(path, bytes)| (path.to_string_lossy().into_owned(), sha(bytes)))
        .collect();
    retain_registration_observation(
        "unauthenticated",
        serde_json::json!({"scope":"Real socket and incomplete generation; no assertion about actual SQLite opens", "completion":completion,"registryEmpty":registry.lock().unwrap().is_empty(),"actorCount":route.lock().unwrap().actors.len(),"beforeAndAfterFileHashes":file_hashes}),
    );
    // This tests unchanged actual files and absent records/routes, not a claim
    // that an exclusive lock probe alone detects every SQLite open.
    let (relay, _socket, _replies) = relay_pair();
    assert_eq!(
        relay.native_project().err().unwrap(),
        "native store has no authenticated producer"
    );
}

#[test]
fn native_reply_binds_exact_challenge_digest_and_phase() {
    let challenge = "a".repeat(64);
    let digest = "b".repeat(64);
    for defect in ["none", "challenge", "digest", "phase", "variant"] {
        let reply = if defect == "variant" {
            ReplyValue::Written
        } else {
            ReplyValue::NativeStopChecked {
                challenge: if defect == "challenge" {
                    "c".repeat(64)
                } else {
                    challenge.clone()
                },
                binding_digest: if defect == "digest" {
                    "c".repeat(64)
                } else {
                    digest.clone()
                },
                phase: if defect == "phase" {
                    NativeStopPhase::BeforeSql
                } else {
                    NativeStopPhase::BeforeReservation
                },
            }
        };
        let result = verify_native_reply(
            reply,
            &challenge,
            &digest,
            NativeStopPhase::BeforeReservation,
        );
        if defect == "none" {
            assert_eq!(result, Ok(()));
        } else {
            assert_eq!(
                result.unwrap_err(),
                "native Stop callback response differs from this challenge",
                "{defect}"
            );
        }
    }
}
