use super::*;

fn copy_refusal_original(original: &StoreAcquire) -> StoreAcquire {
    serde_json::from_slice(&serde_json::to_vec(original).unwrap()).unwrap()
}

fn refusal_job(
    registry: &Arc<Mutex<StoreRegistry>>,
    original: StoreAcquire,
) -> (StoreJob, UnixStream) {
    let record = registry.lock().unwrap().reserve(original).unwrap();
    {
        let mut held = record.lock().unwrap();
        held.original_project_bound = true;
        held.publication_error = Some("native selection changed".into());
    }
    let (transport, caller, _replies) = relay_pair();
    let transport = bind_deadline(transport, &record);
    let capacity = Arc::new(ProjectCapacity {
        used: AtomicUsize::new(0),
        maximum: 1,
    });
    (
        StoreJob {
            record,
            registry: Arc::clone(registry),
            transport,
            _connection: Arc::new(ConnectionPermit(Arc::new(AtomicUsize::new(1)))),
            _project: capacity.acquire().unwrap(),
        },
        caller,
    )
}

#[test]
fn native_refusal_reclaims_record_permit_and_changed_generation_replay_without_ack() {
    let f = Fixture::new();
    let mut actor = f.actor();
    let registry = Arc::new(Mutex::new(StoreRegistry::new(1)));
    let capacity = Arc::clone(&registry.lock().unwrap().capacity);
    let original = native_transport_fixture(&f, "refused-original");
    let id = publication::original_request_id(&original.id);
    let (job, _caller) = refusal_job(&registry, copy_refusal_original(&original));
    actor.store_records.push(Arc::clone(&job.record));
    assert!(capacity.retained());
    actor.persist_native_refusal(&job, &original).unwrap();
    let completion = job.record.lock().unwrap().completion();
    assert!(!completion.retained);
    assert!(completion.acquisition.is_none());
    assert_eq!(
        completion.error.as_deref(),
        Some("native selection changed")
    );
    assert!(registry.lock().unwrap().is_empty());
    assert!(actor.store_records.is_empty());
    assert!(
        capacity.retained(),
        "the completing job still owns its permit"
    );
    drop(job);
    assert!(!capacity.retained());
    assert!(actor.idle_proof(expires()).is_ok());
    let terminal = actor.journal.lookup(&id, expires()).unwrap().unwrap();
    let before = fixture_file_bytes(&f.root);
    for changed_generation in [false, true] {
        let mut replay = copy_refusal_original(&original);
        if changed_generation {
            replay.runtime_digest = "e".repeat(64);
        }
        let (job, _caller) = refusal_job(&registry, copy_refusal_original(&replay));
        actor.store_records.push(Arc::clone(&job.record));
        assert!(actor.reject_terminal_replay(&job, &replay).unwrap());
        let replay_completion = job.record.lock().unwrap().completion();
        assert!(!replay_completion.retained);
        assert_eq!(
            replay_completion.error.as_deref(),
            Some("original invocation already terminal; no replay across generations")
        );
        assert!(replay_completion.acquisition.is_none());
        assert!(registry.lock().unwrap().is_empty());
        drop(job);
        assert!(!capacity.retained());
        assert!(actor.idle_proof(expires()).is_ok());
        assert_eq!(fixture_file_bytes(&f.root), before);
    }
    retain_registration_observation(
        "refusal-reclamation",
        serde_json::json!({"terminal":terminal,"completion":completion,"registryEmpty":registry.lock().unwrap().is_empty(),"capacityRetained":capacity.retained(),"actorRecords":actor.store_records.len(),"replayHistoryUnchanged":fixture_file_bytes(&f.root)==before,"scope":"actual journal and actor release methods; native challenge and coordinator exit not executed"}),
    );
}

#[test]
fn native_refusal_persistence_failure_keeps_actor_record_and_capacity() {
    for offset in [1, 2] {
        let f = Fixture::new();
        let mut actor = f.actor();
        let registry = Arc::new(Mutex::new(StoreRegistry::new(1)));
        let capacity = Arc::clone(&registry.lock().unwrap().capacity);
        let original = native_transport_fixture(&f, "failed-refusal");
        let (job, _caller) = refusal_job(&registry, copy_refusal_original(&original));
        actor.store_records.push(Arc::clone(&job.record));
        actor.journal.inject_refusal_sync_failure(offset);
        let error = actor.persist_native_refusal(&job, &original).unwrap_err();
        assert!(error.contains("injected sync error"), "{error}");
        assert!(job.record.lock().unwrap().completion().retained);
        assert!(!registry.lock().unwrap().is_empty());
        assert_eq!(actor.store_records.len(), 1);
        drop(job);
        assert!(capacity.retained());
        assert!(actor.idle_proof(expires()).is_err());
        retain_registration_observation(
            &format!("refusal-sync-{offset}"),
            serde_json::json!({"error":error,"capacityRetained":capacity.retained(),"actorRecords":actor.store_records.len(),"files":fixture_file_bytes(&f.root).iter().map(|(p,b)|(p.to_string_lossy().into_owned(),sha(b))).collect::<BTreeMap<_,_>>()}),
        );
    }
}

#[test]
fn native_refusal_revalidates_terminal_after_registry_contention() {
    for replay in [false, true] {
        let f = Fixture::new();
        let mut actor = f.actor();
        actor.observations = Arc::new(ObservationLog::open(&f.config, Instant::now()).unwrap());
        let registry = Arc::new(Mutex::new(StoreRegistry::new(1)));
        let capacity = Arc::clone(&registry.lock().unwrap().capacity);
        let original = native_transport_fixture(&f, "contended-refusal");
        if replay {
            let (seed, _caller) = refusal_job(&registry, copy_refusal_original(&original));
            actor.store_records.push(Arc::clone(&seed.record));
            actor.persist_native_refusal(&seed, &original).unwrap();
            drop(seed);
        }
        let (job, _caller) = refusal_job(&registry, copy_refusal_original(&original));
        actor.store_records.push(Arc::clone(&job.record));
        let record = Arc::clone(&job.record);
        let terminal_path = custody_path(&f.config)
            .join("operations/services")
            .join(wire::project_service_key(f.root.to_str().unwrap()).unwrap())
            .join(format!(
                "{}.json",
                publication::original_request_id(&original.id)
            ));
        let log_path = base(&f.config).join("observations.jsonl");
        let held_registry = registry.lock().unwrap();
        let worker = std::thread::spawn(move || {
            let result = if replay {
                actor.reject_terminal_replay(&job, &original).map(|_| ())
            } else {
                actor.persist_native_refusal(&job, &original)
            };
            (actor, job, result)
        });
        // Observe actual progress past persistence/lookup, with registry custody
        // held. No guessed sleep supplies the interleaving under test.
        let until = Instant::now() + Duration::from_secs(2);
        let mut reached = false;
        while Instant::now() < until {
            reached = if replay {
                record.lock().unwrap().publication_error.as_deref()
                    == Some("original invocation already terminal; no replay across generations")
            } else {
                fs::read_to_string(&log_path)
                    .unwrap()
                    .contains("publication_refused_durable")
            };
            if reached {
                break;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        if !reached {
            drop(held_registry);
            let _ = worker.join();
            panic!("actor did not reach terminal lookup/persistence while registry was held");
        }
        let bytes = fs::read(&terminal_path).unwrap();
        let before_inode = fs::metadata(&terminal_path).unwrap().ino();
        let replacement = terminal_path.with_extension("replacement");
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&replacement)
            .unwrap();
        file.write_all(&bytes).unwrap();
        file.sync_all().unwrap();
        fs::rename(&replacement, &terminal_path).unwrap();
        let after_inode = fs::metadata(&terminal_path).unwrap().ino();
        assert_ne!(before_inode, after_inode);
        assert_eq!(fs::read(&terminal_path).unwrap(), bytes);
        drop(held_registry);
        let (actor, job, result) = worker.join().unwrap();
        let error = result.expect_err("changed terminal inode must prevent reclamation");
        assert!(
            error.contains("operation changed outside the owner")
                || error.contains("selected operation changed"),
            "{error}"
        );
        assert!(job.record.lock().unwrap().completion().retained);
        assert!(!registry.lock().unwrap().is_empty());
        assert_eq!(actor.store_records.len(), 1);
        drop(job);
        assert!(capacity.retained());
        retain_registration_observation(
            &format!("refusal-contended-{replay}"),
            serde_json::json!({"replay":replay,"error":error,"beforeInode":before_inode,"afterInode":after_inode,"terminalSha256":sha(&bytes),"sameBytes":fs::read(&terminal_path).unwrap()==bytes,"capacityRetained":capacity.retained(),"actorRecords":actor.store_records.len()}),
        );
    }
}

#[test]
fn native_refusal_does_not_convert_partial_reservation() {
    for running in [false, true] {
        let f = Fixture::new();
        let mut actor = f.actor();
        let registry = Arc::new(Mutex::new(StoreRegistry::new(1)));
        let original = native_transport_fixture(&f, "partial-reservation");
        let digest = sha(&serde_json::to_vec(&original).unwrap());
        let identity = journal::Identity {
            request_id: publication::original_request_id(&original.id),
            argument_digest: digest.clone(),
            project_service_key: wire::project_service_key(f.root.to_str().unwrap()).unwrap(),
            source_generation: original.runtime_digest.clone(),
            execution_image_digest: original.runtime_digest.clone(),
        };
        actor
            .journal
            .admit(identity.clone(), digest.as_bytes(), expires())
            .unwrap();
        if running {
            actor
                .journal
                .begin_next(
                    &original.runtime_digest,
                    &original.runtime_digest,
                    expires(),
                )
                .unwrap()
                .unwrap();
        }
        let (job, _caller) = refusal_job(&registry, copy_refusal_original(&original));
        actor.store_records.push(Arc::clone(&job.record));
        let before = fixture_file_bytes(&f.root);
        assert!(!actor.reject_terminal_replay(&job, &original).unwrap());
        assert!(
            actor
                .persist_native_refusal(&job, &original)
                .unwrap_err()
                .contains("existing original")
        );
        assert_eq!(fixture_file_bytes(&f.root), before);
        assert!(job.record.lock().unwrap().completion().retained);
        assert!(!registry.lock().unwrap().is_empty());
    }
}

#[test]
fn native_refusal_consumed_replay_releases_only_new_registration() {
    let f = Fixture::new();
    let mut actor = f.actor();
    let registry = Arc::new(Mutex::new(StoreRegistry::new(1)));
    let capacity = Arc::clone(&registry.lock().unwrap().capacity);
    let original = native_transport_fixture(&f, "consumed-replay");
    let digest = sha(&serde_json::to_vec(&original).unwrap());
    let identity = journal::Identity {
        request_id: publication::original_request_id(&original.id),
        argument_digest: digest.clone(),
        project_service_key: wire::project_service_key(f.root.to_str().unwrap()).unwrap(),
        source_generation: original.runtime_digest.clone(),
        execution_image_digest: original.runtime_digest.clone(),
    };
    actor
        .journal
        .admit(identity.clone(), digest.as_bytes(), expires())
        .unwrap();
    let dispatch = actor
        .journal
        .begin_next(
            &original.runtime_digest,
            &original.runtime_digest,
            expires(),
        )
        .unwrap()
        .unwrap();
    let returned = actor
        .journal
        .returned(
            &dispatch,
            journal::ReturnedResult::ProcessExit {
                code: Some(0),
                signal: None,
            },
            None,
            expires(),
        )
        .unwrap();
    actor
        .journal
        .consume(
            &returned,
            &returned.consumption_digest().unwrap(),
            expires(),
        )
        .unwrap();
    let before = fixture_file_bytes(&f.root);
    let mut replay = copy_refusal_original(&original);
    replay.runtime_digest = "e".repeat(64);
    let (job, _caller) = refusal_job(&registry, copy_refusal_original(&replay));
    actor.store_records.push(Arc::clone(&job.record));
    assert!(actor.reject_terminal_replay(&job, &replay).unwrap());
    assert!(!job.record.lock().unwrap().completion().retained);
    assert!(registry.lock().unwrap().is_empty());
    drop(job);
    assert!(!capacity.retained());
    assert!(actor.idle_proof(expires()).is_ok());
    assert_eq!(fixture_file_bytes(&f.root), before);
    retain_registration_observation(
        "refusal-consumed-replay",
        serde_json::json!({"capacityRetained":capacity.retained(),"actorRecords":actor.store_records.len(),"historyUnchanged":fixture_file_bytes(&f.root)==before}),
    );
}
