//! Actual native receive/Actor/relay/filesystem integration. The preparation
//! peer is controlled here; this is not the ordinary TS consumer qualification.
use super::*;
use std::{
    collections::VecDeque,
    os::unix::fs::{MetadataExt, PermissionsExt},
};
fn expires() -> Instant {
    Instant::now() + Duration::from_secs(10)
}
struct Fixture {
    root: PathBuf,
    config: Arc<OwnerConfig>,
    routing: Arc<Mutex<Routing>>,
}
impl Fixture {
    fn new() -> Self {
        Self::with_capacity(1)
    }
    fn with_capacity(max_retained_records: u16) -> Self {
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("caws-session-actor-{}", random().unwrap()));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(
            Command::new("/usr/bin/git")
                .args(["init", "--quiet"])
                .arg(&root)
                .status()
                .unwrap()
                .success()
        );
        fs::create_dir(root.join(".caws")).unwrap();
        fs::create_dir(root.join("state")).unwrap();
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
                max_retained_records,
                first_frame_ms: 1000,
                request_ms: 10_000,
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
        let custody = journal::Custody::acquire(&custody_path(&config), expires()).unwrap();
        let routing = Arc::new(Mutex::new(Routing {
            actors: BTreeMap::new(),
            joins: vec![],
            config: Arc::clone(&config),
            custody,
            budget: Arc::new(Mutex::new(Budget {
                used: 0,
                maximum: 1,
            })),
            observations: Arc::new(ObservationLog::unavailable(Instant::now())),
        }));
        Self {
            root,
            config,
            routing,
        }
    }
    fn acquire(&self, id: &str) -> SessionAcquire {
        self.acquire_in(id, &self.root)
    }
    fn acquire_in(&self, id: &str, project: &Path) -> SessionAcquire {
        let raw =
            RawValue::from_string(serde_json::json!({"session_id":"s","cwd":project}).to_string())
                .unwrap();
        let runtime = "a".repeat(64);
        let project_digest = sha(project.to_str().unwrap().as_bytes());
        let environment = BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]);
        let request=serde_json::to_vec(&serde_json::json!({"schema":REQUEST_SCHEMA,"id":id,"runtimeDigest":runtime,"token":"token","canonicalRoot":project})).unwrap();
        SessionAcquire::capture(
            &request,
            &SessionInvocation {
                id,
                runtime_digest: &runtime,
                original_payload: &raw,
                surface: "codex",
                event: "session_end",
                configuration: "system",
                ready_active: true,
                ready_project_digest: Some(&project_digest),
                ready_session_id: Some("s"),
                dispatched: true,
                caller_cwd: project.to_str().unwrap(),
                caller_environment: &environment,
            },
            expires(),
        )
        .unwrap()
    }
    fn session(&self) -> PathBuf {
        self.root.join(".caws/sessions/s")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let joins = {
            let mut routing = self.routing.lock().unwrap();
            routing.actors.clear();
            std::mem::take(&mut routing.joins)
        };
        for join in joins {
            join.join().unwrap();
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn run(
    f: &Fixture,
    registry: Arc<Mutex<SessionRegistry>>,
    id: &str,
    missing: bool,
    wrong_ack: bool,
) -> SessionCompletion {
    run_metadata(f, registry, id, missing, wrong_ack,
        b"{\"ended\":{\"reason\":\"other\"},\"summary_provenance\":{\"mode\":\"preserved\",\"reason\":\"zero_turns\"}}",0)
}
fn run_metadata(
    f: &Fixture,
    registry: Arc<Mutex<SessionRegistry>>,
    id: &str,
    missing: bool,
    wrong_ack: bool,
    prepared_metadata: &[u8],
    prepared_frame_length: usize,
) -> SessionCompletion {
    let acquire = f.acquire(id);
    let bytes = serde_json::to_vec(&acquire).unwrap();
    run_captured(
        f,
        registry,
        &bytes,
        missing,
        wrong_ack,
        EngineExpectation {
            metadata: prepared_metadata,
            frame_length: prepared_frame_length,
            allowed: true,
        },
    )
}
struct EngineExpectation<'a> {
    metadata: &'a [u8],
    frame_length: usize,
    allowed: bool,
}
fn run_captured(
    f: &Fixture,
    registry: Arc<Mutex<SessionRegistry>>,
    bytes: &[u8],
    missing: bool,
    wrong_ack: bool,
    engine_expectation: EngineExpectation<'_>,
) -> SessionCompletion {
    let EngineExpectation {
        metadata: prepared_metadata,
        frame_length: prepared_frame_length,
        allowed: allow_engine_exchange,
    } = engine_expectation;
    let bytes = bytes.to_vec();
    let acquired: SessionAcquire = serde_json::from_slice(&bytes).unwrap();
    let session_path = PathBuf::from(acquired.request().unwrap().canonical_root)
        .join(".caws/sessions")
        .join(&acquired.session_id);
    let (mut client, mut server) = UnixStream::pair().unwrap();
    client.set_nonblocking(true).unwrap();
    server.set_nonblocking(true).unwrap();
    let config = Arc::clone(&f.config);
    let routing = Arc::clone(&f.routing);
    let permit = Arc::new(ConnectionPermit(Arc::new(AtomicUsize::new(1))));
    let join = thread::spawn(move || {
        assert!(receive_first(
            &mut server,
            &bytes,
            &[],
            Instant::now(),
            &config,
            &routing,
            &permit,
            &registry
        ))
    });
    let mut pending = Vec::new();
    let mut engine: VecDeque<Vec<u8>> = VecDeque::new();
    let mut read_bytes = 0usize;
    let mut credited_bytes = 0usize;
    let mut expected_sequence = 0u64;
    let completion = loop {
        let incoming = frame(&mut client, &mut pending, 2_097_152, expires()).unwrap();
        match serde_json::from_slice::<Frame<SessionCompletion>>(&incoming).unwrap() {
            Frame::Registered { .. } | Frame::ProjectBound { .. } => {}
            Frame::WriteEngineFrame { sequence, base64 } => {
                assert!(
                    allow_engine_exchange,
                    "rejected original reached engine write"
                );
                expected_sequence += 1;
                assert_eq!(sequence, expected_sequence);
                let sent: serde_json::Value =
                    serde_json::from_slice(&STANDARD.decode(base64).unwrap()).unwrap();
                if sent["schema"] == publication_wire::PREPARE {
                    assert_eq!(sent["kind"], "seal");
                    let common = |schema: &str| serde_json::json!({"schema":schema,"id":sent["id"],"runtimeDigest":sent["runtimeDigest"],"token":sent["token"],"attempt":sent["attempt"],"kind":"seal"});
                    let mut prepared = common(publication_wire::PREPARED);
                    prepared.as_object_mut().unwrap().extend(serde_json::json!({"observationId":sent["snapshot"]["observationId"],"inputDigest":sent["snapshot"]["inputDigest"],"disposition":if missing{"aborted"}else{"ready"},"artifacts":[],"removals":[]}).as_object().unwrap().clone());
                    assert_eq!(sent["snapshot"]["reason"], "other");
                    if missing {
                        prepared["diagnostic"] =
                            serde_json::json!("metadata absent; ordinary SessionEnd no-op");
                    } else {
                        prepared["summaryMode"] = serde_json::json!("preserved");
                        prepared["artifacts"] = serde_json::json!([{"name":".meta.json","role":"metadata","byteLength":prepared_metadata.len(),"sha256":sha(prepared_metadata)}]);
                    }
                    let mut prepared_bytes = serde_json::to_vec(&prepared).unwrap();
                    if prepared_frame_length > 0 {
                        prepared_bytes.resize(prepared_frame_length - 1, b' ');
                    }
                    engine.push_back(prepared_bytes);
                    if !missing {
                        for (index, bytes) in prepared_metadata
                            .chunks(publication_wire::MAX_CHUNK_BYTES)
                            .enumerate()
                        {
                            let mut chunk = common(publication_wire::CHUNK);
                            chunk.as_object_mut().unwrap().extend(serde_json::json!({"name":".meta.json","offset":index*publication_wire::MAX_CHUNK_BYTES,"base64":STANDARD.encode(bytes)}).as_object().unwrap().clone());
                            engine.push_back(serde_json::to_vec(&chunk).unwrap());
                        }
                    }
                    let mut ready = common(publication_wire::READY);
                    ready["direction"] = serde_json::json!("prepared");
                    engine.push_back(serde_json::to_vec(&ready).unwrap());
                }
                if sent["schema"] == publication_wire::RESULT {
                    assert_eq!(
                        sent["status"],
                        if missing {
                            "not_published"
                        } else {
                            "published"
                        }
                    );
                    if missing {
                        assert!(!session_path.join(publication::MARKER_NAME).exists());
                        assert!(!session_path.join(".meta.json").exists());
                    } else {
                        let marker: serde_json::Value = serde_json::from_slice(
                            &fs::read(session_path.join(publication::MARKER_NAME)).unwrap(),
                        )
                        .unwrap();
                        assert_eq!(marker["terminalDigest"], sent["terminalDigest"]);
                        assert_eq!(
                            fs::read(session_path.join(".meta.json")).unwrap(),
                            prepared_metadata
                        );
                    }
                    engine.push_back(serde_json::to_vec(&serde_json::json!({"schema":publication_wire::CONSUMED,"id":sent["id"],"runtimeDigest":sent["runtimeDigest"],"token":sent["token"],"attempt":sent["attempt"],"terminalDigest":if wrong_ack{serde_json::json!("f".repeat(64))}else{sent["terminalDigest"].clone()}})).unwrap());
                }
                write_all(
                    &client,
                    &encoded(
                        &Reply {
                            schema: relay::REPLY_SCHEMA.into(),
                            sequence,
                            result: Ok(Value::Written),
                        },
                        relay::REPLY_MAX,
                    )
                    .unwrap(),
                    expires(),
                )
                .unwrap();
            }
            Frame::ReadEngineFrame { sequence } => {
                assert!(
                    allow_engine_exchange,
                    "rejected original reached engine read"
                );
                expected_sequence += 1;
                assert_eq!(sequence, expected_sequence);
                let mut bytes = engine
                    .pop_front()
                    .expect("native requested next prepared or consumed frame");
                bytes.push(b'\n');
                read_bytes += bytes.len();
                assert!(
                    read_bytes <= publication_wire::MAX_FRAME_BYTES + 16 * 1024 + credited_bytes
                );
                write_all(
                    &client,
                    &encoded(
                        &Reply {
                            schema: relay::REPLY_SCHEMA.into(),
                            sequence,
                            result: Ok(Value::Read {
                                base64: STANDARD.encode(bytes),
                            }),
                        },
                        relay::REPLY_MAX,
                    )
                    .unwrap(),
                    expires(),
                )
                .unwrap();
            }
            Frame::PublicationCredit { sequence, bytes } => {
                assert!(
                    allow_engine_exchange,
                    "rejected original earned engine credit"
                );
                expected_sequence += 1;
                assert_eq!(sequence, expected_sequence);
                assert!(bytes > 0 && credited_bytes + bytes <= read_bytes);
                credited_bytes += bytes;
                write_all(
                    &client,
                    &encoded(
                        &Reply {
                            schema: relay::REPLY_SCHEMA.into(),
                            sequence,
                            result: Ok(Value::Credited),
                        },
                        relay::REPLY_MAX,
                    )
                    .unwrap(),
                    expires(),
                )
                .unwrap();
            }
            Frame::Complete { completion } => {
                if prepared_frame_length > publication_wire::MAX_FRAME_BYTES {
                    assert_eq!(credited_bytes, 0, "oversized Prepared earned credit");
                } else if !wrong_ack {
                    assert_eq!(credited_bytes, read_bytes);
                }
                if prepared_metadata.len() > 4 * 1024 * 1024 {
                    assert!(read_bytes > 4 * 1024 * 1024);
                }
                break completion;
            }
        }
    };
    join.join().unwrap();
    completion
}
#[test]
fn actual_receive_actor_seals_or_consumes_missing_metadata_noop_and_restores_shared_slot() {
    for missing in [false, true] {
        let f = Fixture::new();
        let capacity = relay::OperationCapacity::new(1);
        let registry = Arc::new(Mutex::new(SessionRegistry::new(Arc::clone(&capacity))));
        for id in ["first", "second"] {
            fs::create_dir_all(f.session()).unwrap();
            if !missing {
                fs::write(f.session().join(".meta.json"), b"{\"original\":true}").unwrap();
            }
            let completion = run(&f, Arc::clone(&registry), id, missing, false);
            assert!(completion.status().is_ok(), "{completion:?}");
            assert!(!completion.retained);
            assert!(completion.original_project_bound);
            assert!(registry.lock().unwrap().records.is_empty());
            assert!(!capacity.retained());
            let key = wire::project_service_key(f.root.to_str().unwrap()).unwrap();
            let record = f
                .root
                .join("state/render-service/custody/operations/services")
                .join(key)
                .join(format!("{}.json", publication::original_request_id(id)));
            let retained: serde_json::Value =
                serde_json::from_slice(&fs::read(record).unwrap()).unwrap();
            assert_eq!(retained["body"]["outcome"]["execution"], "consumed");
            assert_eq!(retained["body"]["verifiedRequestBase64"], "");
        }
    }
}
#[test]
fn consumed_original_replay_preserves_tombstone_and_refunds_transient_shared_slot() {
    // This observes the actual receive/Actor path, not journal admission alone.
    // Reuse the exact captured bytes, including timestamp and invocation budget.
    let f = Fixture::new();
    let capacity = relay::OperationCapacity::new(1);
    let registry = Arc::new(Mutex::new(SessionRegistry::new(Arc::clone(&capacity))));
    fs::create_dir_all(f.session()).unwrap();
    fs::write(f.session().join(".meta.json"), b"{}").unwrap();
    let original = serde_json::to_vec(&f.acquire("consumed-original")).unwrap();
    let metadata = b"{\"ended\":{\"reason\":\"other\"}}";
    let first = run_captured(
        &f,
        Arc::clone(&registry),
        &original,
        false,
        false,
        EngineExpectation {
            metadata,
            frame_length: 0,
            allowed: true,
        },
    );
    assert!(first.status().is_ok(), "{first:?}");
    assert!(!first.retained);
    assert!(registry.lock().unwrap().records.is_empty());
    assert!(!capacity.retained());

    let key = wire::project_service_key(f.root.to_str().unwrap()).unwrap();
    let journal = f
        .root
        .join("state/render-service/custody/operations/services")
        .join(key);
    let tombstone = journal.join(format!(
        "{}.json",
        publication::original_request_id("consumed-original")
    ));
    let retained: serde_json::Value =
        serde_json::from_slice(&fs::read(&tombstone).unwrap()).unwrap();
    assert_eq!(retained["body"]["outcome"]["execution"], "consumed");
    assert_eq!(retained["body"]["verifiedRequestBase64"], "");

    // Include names, bytes, inode, mode and modification time: a replay must not
    // rewrite the consumed receipt or touch any published session artifact.
    fn snapshot(root: &Path) -> BTreeMap<PathBuf, (Vec<u8>, u64, u32, i64, i64)> {
        fn visit(
            root: &Path,
            dir: &Path,
            files: &mut BTreeMap<PathBuf, (Vec<u8>, u64, u32, i64, i64)>,
        ) {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                let stat = fs::symlink_metadata(&path).unwrap();
                assert!(!stat.file_type().is_symlink());
                let bytes = if stat.is_dir() {
                    Vec::new()
                } else {
                    fs::read(&path).unwrap()
                };
                files.insert(
                    path.strip_prefix(root).unwrap().into(),
                    (
                        bytes,
                        stat.ino(),
                        stat.mode(),
                        stat.mtime(),
                        stat.mtime_nsec(),
                    ),
                );
                if stat.is_dir() {
                    visit(root, &path, files);
                }
            }
        }
        let mut files = BTreeMap::new();
        visit(root, root, &mut files);
        files
    }
    let journal_before = snapshot(&journal);
    let session_before = snapshot(&f.session());
    let replay = run_captured(
        &f,
        Arc::clone(&registry),
        &original,
        false,
        false,
        EngineExpectation {
            metadata,
            frame_length: 0,
            allowed: false,
        },
    );
    assert!(replay.status().is_err(), "replay executed: {replay:?}");
    assert!(
        replay
            .error
            .as_deref()
            .unwrap()
            .contains("consumed original request ID"),
        "{replay:?}"
    );
    assert!(replay.original_project_bound);
    assert_eq!(snapshot(&journal), journal_before);
    assert_eq!(snapshot(&f.session()), session_before);

    // Admission's typed KnownNotExecuted rejection must release only this new
    // transient registration, so a fresh original can still use capacity one.
    let fresh = run(&f, Arc::clone(&registry), "fresh-original", false, false);
    assert!(
        fresh.status().is_ok(),
        "fresh original refused after known replay rejection: replay={replay:?}, fresh={fresh:?}"
    );
    assert!(!replay.retained);
    assert!(!fresh.retained);
    assert!(registry.lock().unwrap().records.is_empty());
    assert!(!capacity.retained());
    assert_eq!(
        fs::read(tombstone).unwrap(),
        journal_before[&PathBuf::from(format!(
            "{}.json",
            publication::original_request_id("consumed-original")
        ))]
            .0
    );
}
#[test]
fn wrong_consumed_keeps_actual_actor_original_and_shared_permit() {
    let f = Fixture::new();
    let capacity = relay::OperationCapacity::new(1);
    let registry = Arc::new(Mutex::new(SessionRegistry::new(Arc::clone(&capacity))));
    fs::create_dir_all(f.session()).unwrap();
    fs::write(f.session().join(".meta.json"), b"{}").unwrap();
    let completion = run(&f, Arc::clone(&registry), "wrong-ack", false, true);
    assert!(completion.status().is_err());
    assert!(completion.retained);
    assert!(capacity.retained());
    assert_eq!(registry.lock().unwrap().records.len(), 1);
    assert!(
        capacity
            .acquire()
            .unwrap_err()
            .contains("capacity exhausted")
    );
}

fn session_journal(f: &Fixture, project: &Path, id: &str) -> PathBuf {
    f.root
        .join("state/render-service/custody/operations/services")
        .join(wire::project_service_key(project.to_str().unwrap()).unwrap())
        .join(format!("{}.json", publication::original_request_id(id)))
}
fn file_receipt(path: &Path) -> (Vec<u8>, u64, u32, i64, i64) {
    let stat = fs::symlink_metadata(path).unwrap();
    assert!(stat.is_file() && !stat.file_type().is_symlink());
    (
        fs::read(path).unwrap(),
        stat.ino(),
        stat.mode(),
        stat.mtime(),
        stat.mtime_nsec(),
    )
}
fn no_engine() -> EngineExpectation<'static> {
    EngineExpectation {
        metadata: b"{}",
        frame_length: 0,
        allowed: false,
    }
}

#[test]
fn fresh_original_at_unknown_fence_refunds_only_its_transient_slot_for_another_project() {
    let f = Fixture::with_capacity(2);
    let capacity = relay::OperationCapacity::new(2);
    let registry = Arc::new(Mutex::new(SessionRegistry::new(Arc::clone(&capacity))));
    fs::create_dir_all(f.session()).unwrap();
    fs::write(f.session().join(".meta.json"), b"{}").unwrap();
    let first = run(&f, Arc::clone(&registry), "retained-A", false, true);
    assert!(first.status().is_err() && first.retained, "{first:?}");
    let original = Arc::clone(&registry.lock().unwrap().records["retained-A"]);
    let writer = Arc::clone(original.lock().unwrap().writer.as_ref().unwrap());
    assert!(original.lock().unwrap().publication.is_some());
    let a_record = session_journal(&f, &f.root, "retained-A");
    let before = [
        &a_record,
        &f.session().join(".meta.json"),
        &f.session().join(publication::MARKER_NAME),
    ]
    .into_iter()
    .map(|p| (p.to_path_buf(), file_receipt(p)))
    .collect::<BTreeMap<_, _>>();
    let second_bytes = serde_json::to_vec(&f.acquire("fresh-A2")).unwrap();
    let second = run_captured(
        &f,
        Arc::clone(&registry),
        &second_bytes,
        false,
        false,
        no_engine(),
    );
    assert!(
        second.status().is_err(),
        "fenced original executed: {second:?}"
    );
    assert!(second.original_project_bound);
    assert!(
        !second.retained,
        "fresh non-executed original leaked capacity: {second:?}"
    );
    assert!(!session_journal(&f, &f.root, "fresh-A2").exists());
    assert_eq!(
        registry
            .lock()
            .unwrap()
            .records
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        ["retained-A"]
    );
    // One actual shared permit remains held by A; precisely the other slot is
    // available. Do not raise the configured frontier or evict the old record.
    let available = capacity
        .acquire()
        .expect("fresh fence refusal must refund one slot");
    assert!(capacity.acquire().is_err());
    drop(available);

    let b = f.root.join("project-b");
    fs::create_dir(&b).unwrap();
    assert!(
        Command::new("/usr/bin/git")
            .args(["init", "--quiet"])
            .arg(&b)
            .status()
            .unwrap()
            .success()
    );
    let b_session = b.join(".caws/sessions/s");
    fs::create_dir_all(&b_session).unwrap();
    fs::write(b_session.join(".meta.json"), b"{}").unwrap();
    let b_original = serde_json::to_vec(&f.acquire_in("fresh-B", &b)).unwrap();
    let b_metadata = b"{\"ended\":{\"reason\":\"other\"},\"project\":\"B\"}";
    let completed = run_captured(
        &f,
        Arc::clone(&registry),
        &b_original,
        false,
        false,
        EngineExpectation {
            metadata: b_metadata,
            frame_length: 0,
            allowed: true,
        },
    );
    assert!(
        completed.status().is_ok() && !completed.retained,
        "B blocked by unrelated A fence: {completed:?}"
    );
    let b_durable: serde_json::Value =
        serde_json::from_slice(&fs::read(session_journal(&f, &b, "fresh-B")).unwrap()).unwrap();
    assert_eq!(b_durable["body"]["outcome"]["execution"], "consumed");
    assert_eq!(b_durable["body"]["verifiedRequestBase64"], "");
    assert_eq!(fs::read(b_session.join(".meta.json")).unwrap(), b_metadata);
    for (path, receipt) in before {
        assert_eq!(
            file_receipt(&path),
            receipt,
            "A changed while another original was refused/consumed"
        );
    }
    assert!(Arc::ptr_eq(
        original.lock().unwrap().writer.as_ref().unwrap(),
        &writer
    ));
    assert!(original.lock().unwrap().publication.is_some());
    assert!(original.lock().unwrap().completion.retained);
    let available = capacity.acquire().unwrap();
    assert!(capacity.acquire().is_err());
    drop(available);
}

#[test]
fn registry_absence_does_not_refund_a_prior_durable_identity_at_unknown_fence() {
    let f = Fixture::with_capacity(2);
    let capacity = relay::OperationCapacity::new(2);
    let registry = Arc::new(Mutex::new(SessionRegistry::new(Arc::clone(&capacity))));
    fs::create_dir_all(f.session()).unwrap();
    fs::write(f.session().join(".meta.json"), b"{}").unwrap();
    let captured = serde_json::to_vec(&f.acquire("accepted-A")).unwrap();
    let first = run_captured(
        &f,
        Arc::clone(&registry),
        &captured,
        false,
        true,
        EngineExpectation {
            metadata: b"{\"ended\":{\"reason\":\"other\"}}",
            frame_length: 0,
            allowed: true,
        },
    );
    assert!(first.status().is_err() && first.retained);
    let durable = session_journal(&f, &f.root, "accepted-A");
    let before = file_receipt(&durable);
    // Registry absence is the condition possible after restart. Preserve the
    // actual original record outside the registry here; do not discard its
    // writer/Publication merely to manufacture a free slot in this control.
    let retained = registry
        .lock()
        .unwrap()
        .records
        .remove("accepted-A")
        .unwrap();
    let writer = Arc::clone(retained.lock().unwrap().writer.as_ref().unwrap());
    let replay = run_captured(
        &f,
        Arc::clone(&registry),
        &captured,
        false,
        false,
        no_engine(),
    );
    assert!(
        replay.status().is_err() && replay.retained,
        "durable accepted ID incorrectly refunded: {replay:?}"
    );
    assert_eq!(file_receipt(&durable), before);
    assert!(capacity.acquire().is_err());
    assert!(registry.lock().unwrap().records.contains_key("accepted-A"));
    assert!(Arc::ptr_eq(
        retained.lock().unwrap().writer.as_ref().unwrap(),
        &writer
    ));
    assert!(retained.lock().unwrap().publication.is_some());
}

#[test]
fn unknown_fence_durable_lookup_error_retains_the_new_slot_and_old_custody() {
    let f = Fixture::with_capacity(2);
    let capacity = relay::OperationCapacity::new(2);
    let registry = Arc::new(Mutex::new(SessionRegistry::new(Arc::clone(&capacity))));
    fs::create_dir_all(f.session()).unwrap();
    fs::write(f.session().join(".meta.json"), b"{}").unwrap();
    let first = run(&f, Arc::clone(&registry), "uncertain-A", false, true);
    assert!(first.status().is_err() && first.retained);
    let original = Arc::clone(&registry.lock().unwrap().records["uncertain-A"]);
    let writer = Arc::clone(original.lock().unwrap().writer.as_ref().unwrap());
    let durable = session_journal(&f, &f.root, "uncertain-A");
    let before = file_receipt(&durable);
    // current() checks the complete directory name set while holding actual
    // journal custody. An untracked file must fail lookup, never imply absence.
    let foreign = durable.parent().unwrap().join("untracked.json");
    fs::write(&foreign, b"{}").unwrap();
    let captured = serde_json::to_vec(&f.acquire("lookup-error-A2")).unwrap();
    let second = run_captured(
        &f,
        Arc::clone(&registry),
        &captured,
        false,
        false,
        no_engine(),
    );
    assert!(
        second.status().is_err() && second.retained,
        "lookup uncertainty refunded: {second:?}"
    );
    assert!(
        second
            .error
            .as_deref()
            .unwrap()
            .contains("durable original identity unavailable"),
        "{second:?}"
    );
    assert_eq!(registry.lock().unwrap().records.len(), 2);
    assert!(capacity.acquire().is_err());
    assert!(!session_journal(&f, &f.root, "lookup-error-A2").exists());
    assert_eq!(file_receipt(&durable), before);
    assert!(Arc::ptr_eq(
        original.lock().unwrap().writer.as_ref().unwrap(),
        &writer
    ));
    assert!(original.lock().unwrap().publication.is_some());
}

#[test]
fn local_acquire_failure_has_no_fabricated_owner_completion_or_retention_verdict() {
    struct UnusedTransport;
    impl publication::Transport for UnusedTransport {
        fn credit(&mut self, _: usize) -> Result<()> {
            panic!("invalid request reached engine credit");
        }
        fn write(&mut self, _: &[u8], _: Instant) -> Result<()> {
            panic!("invalid request reached engine write");
        }
        fn read(&mut self, _: Instant) -> Result<Vec<u8>> {
            panic!("invalid request reached engine read");
        }
    }
    let f = Fixture::new();
    let mut acquire = f.acquire("local-failure");
    acquire.request_base64 = STANDARD.encode(b"{}");
    let observed = acquire_session(
        &f.config,
        acquire,
        expires(),
        || false,
        &mut UnusedTransport,
    );
    assert!(observed.status().is_err());
    match observed {
        SessionAcquisition::Unconfirmed {
            id,
            registration,
            original_project_bound,
            error,
            ..
        } => {
            assert_eq!(id, "local-failure");
            assert_eq!(registration, None);
            assert!(!original_project_bound);
            assert!(error.contains("missing field"));
        }
        SessionAcquisition::Complete(completion) => {
            panic!("local failure manufactured owner completion: {completion:?}")
        }
    }
}

#[test]
fn actual_actor_large_seal_preserves_exact_bytes_and_uses_only_validated_credit() {
    let f = Fixture::new();
    let capacity = relay::OperationCapacity::new(1);
    let registry = Arc::new(Mutex::new(SessionRegistry::new(Arc::clone(&capacity))));
    fs::create_dir_all(f.session()).unwrap();
    fs::write(f.session().join(".meta.json"), b"{}").unwrap();
    let metadata = serde_json::to_vec(
        &serde_json::json!({"ended":{"reason":"other"},"retained":"x".repeat(5*1024*1024)}),
    )
    .unwrap();
    let completion = run_metadata(
        &f,
        Arc::clone(&registry),
        "large-seal",
        false,
        false,
        &metadata,
        0,
    );
    assert!(completion.status().is_ok(), "{completion:?}");
    assert_eq!(fs::read(f.session().join(".meta.json")).unwrap(), metadata);
    assert!(!capacity.retained());
    assert!(registry.lock().unwrap().records.is_empty());
}

#[test]
fn actual_actor_near_limit_prepared_reply_envelope_preserves_inner_bound() {
    for extra in [0, 1] {
        let f = Fixture::new();
        let capacity = relay::OperationCapacity::new(1);
        let registry = Arc::new(Mutex::new(SessionRegistry::new(Arc::clone(&capacity))));
        fs::create_dir_all(f.session()).unwrap();
        fs::write(f.session().join(".meta.json"), b"{}").unwrap();
        let metadata = b"{\"ended\":{\"reason\":\"other\"}}";
        let completion = run_metadata(
            &f,
            Arc::clone(&registry),
            "prepared-envelope",
            false,
            false,
            metadata,
            publication_wire::MAX_FRAME_BYTES + extra,
        );
        assert_eq!(completion.status().is_ok(), extra == 0, "{completion:?}");
        assert_eq!(capacity.retained(), extra != 0);
        if extra == 0 {
            assert_eq!(fs::read(f.session().join(".meta.json")).unwrap(), metadata);
        } else {
            assert_eq!(fs::read(f.session().join(".meta.json")).unwrap(), b"{}");
            assert!(!f.session().join(publication::MARKER_NAME).exists());
            assert_eq!(registry.lock().unwrap().records.len(), 1);
        }
    }
}
