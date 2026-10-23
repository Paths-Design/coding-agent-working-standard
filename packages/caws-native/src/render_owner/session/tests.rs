//! Actual native receive/Actor/relay/filesystem integration. The preparation
//! peer is controlled here; this is not the ordinary TS consumer qualification.
use super::*;
use std::{collections::VecDeque, os::unix::fs::PermissionsExt};
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
                max_retained_records: 1,
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
        let raw = RawValue::from_string(
            serde_json::json!({"session_id":"s","cwd":self.root}).to_string(),
        )
        .unwrap();
        let runtime = "a".repeat(64);
        let project_digest = sha(self.root.to_str().unwrap().as_bytes());
        let environment = BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]);
        let request=serde_json::to_vec(&serde_json::json!({"schema":REQUEST_SCHEMA,"id":id,"runtimeDigest":runtime,"token":"token","canonicalRoot":self.root})).unwrap();
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
                caller_cwd: self.root.to_str().unwrap(),
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
                        assert!(!f.session().join(publication::MARKER_NAME).exists());
                        assert!(!f.session().join(".meta.json").exists());
                    } else {
                        let marker: serde_json::Value = serde_json::from_slice(
                            &fs::read(f.session().join(publication::MARKER_NAME)).unwrap(),
                        )
                        .unwrap();
                        assert_eq!(marker["terminalDigest"], sent["terminalDigest"]);
                        assert_eq!(
                            fs::read(f.session().join(".meta.json")).unwrap(),
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
