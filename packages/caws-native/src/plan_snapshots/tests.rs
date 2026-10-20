use super::*;
use std::{
    fs::{self, OpenOptions},
    os::unix::fs::{DirBuilderExt, PermissionsExt, symlink},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    context: Context,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "caws-plan-snapshots-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        for name in ["machine", "user", "project-a", "project-b", "checkout"] {
            fs::DirBuilder::new()
                .mode(0o700)
                .create(root.join(name))
                .unwrap();
        }
        for name in ["project-a", "project-b", "checkout"] {
            fs::create_dir_all(root.join(name).join(".caws/plans")).unwrap();
            fs::create_dir(root.join(name).join("plans")).unwrap();
        }
        fs::create_dir_all(root.join("user/.codex/plans")).unwrap();
        let context = Context {
            home: root.join("machine"),
            legacy_user_home: Some(root.join("user")),
            checkout: Some(root.join("checkout")),
        };
        Self { root, context }
    }
    fn request(&self, project: &str, sid: &str, plan_name: &str) -> Request {
        let project = self.root.join(project);
        let plan = project.join(".caws/plans").join(format!("{plan_name}.md"));
        write(&plan, b"# plan\n");
        let transcript = self.root.join(format!("{sid}-{plan_name}.jsonl"));
        write(
            &transcript,
            format!("{{\"session\":\"{sid}\",\"plan\":\"{plan_name}\"}}\n").as_bytes(),
        );
        Request {
            canonical_project: project,
            surface: "codex".into(),
            session_id: sid.into(),
            transcript_path: transcript,
            action: Action::Produce { plan_path: plan },
        }
    }
    fn snapshot(request: &Request) -> PathBuf {
        let Action::Produce { plan_path } = &request.action else {
            panic!("produce request required")
        };
        plan_path.with_extension("transcript.jsonl")
    }
    fn pending(&self, request: &Request) -> Vec<String> {
        let owner = validate_request(&self.context, request, expires()).unwrap();
        let ns = namespace(&self.context, &owner, expires()).unwrap();
        ticket_names(&ns.pending.file, expires()).unwrap()
    }
    fn stop(&self, request: &Request) -> Outcome {
        let mut stop = request.clone();
        stop.action = Action::Finalize;
        execute(&self.context, &stop, expires()).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn expires() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
fn write(path: &Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}
fn append(path: &Path, bytes: &[u8]) {
    OpenOptions::new()
        .append(true)
        .open(path)
        .unwrap()
        .write_all(bytes)
        .unwrap();
}

#[test]
fn initial_and_final_snapshots_are_exact_bytes_and_duplicate_produce_is_idempotent() {
    let fixture = Fixture::new();
    let request = fixture.request("project-a", "session-a", "plan-a");
    let original = fs::read(&request.transcript_path).unwrap();
    assert_eq!(
        execute(&fixture.context, &request, expires())
            .unwrap()
            .produced,
        1
    );
    assert_eq!(fs::read(Fixture::snapshot(&request)).unwrap(), original);
    execute(&fixture.context, &request, expires()).unwrap();
    assert_eq!(fixture.pending(&request).len(), 1);
    append(&request.transcript_path, b"{\"approval\":true}\n");
    let final_bytes = fs::read(&request.transcript_path).unwrap();
    assert_eq!(fixture.stop(&request).finalized, 1);
    assert_eq!(fs::read(Fixture::snapshot(&request)).unwrap(), final_bytes);
    assert!(fixture.pending(&request).is_empty());
    assert_eq!(fixture.stop(&request).finalized, 0);
    let mut newer = request.clone();
    append(&newer.transcript_path, b"{\"later\":true}\n");
    assert_eq!(
        execute(&fixture.context, &newer, expires())
            .unwrap()
            .produced,
        1
    );
    newer.action = Action::Finalize;
    assert_eq!(
        execute(&fixture.context, &newer, expires())
            .unwrap()
            .finalized,
        1
    );
    assert_eq!(
        fs::read(Fixture::snapshot(&request)).unwrap(),
        fs::read(&request.transcript_path).unwrap()
    );
}

#[test]
fn sessions_and_repositories_with_identical_session_ids_never_copy_or_drain_each_other() {
    let fixture = Fixture::new();
    let a = fixture.request("project-a", "same-id", "plan-a");
    let b = fixture.request("project-a", "different-id", "plan-b");
    let c = fixture.request("project-b", "same-id", "plan-c");
    for request in [&a, &b, &c] {
        execute(&fixture.context, request, expires()).unwrap();
        append(
            &request.transcript_path,
            format!(
                "{{\"final\":\"{}\"}}\n",
                request.canonical_project.display()
            )
            .as_bytes(),
        );
    }
    let b_initial = fs::read(Fixture::snapshot(&b)).unwrap();
    let c_initial = fs::read(Fixture::snapshot(&c)).unwrap();
    assert_eq!(fixture.stop(&a).finalized, 1);
    assert_eq!(
        fs::read(Fixture::snapshot(&a)).unwrap(),
        fs::read(&a.transcript_path).unwrap()
    );
    assert_eq!(fs::read(Fixture::snapshot(&b)).unwrap(), b_initial);
    assert_eq!(fs::read(Fixture::snapshot(&c)).unwrap(), c_initial);
    assert_eq!(fixture.pending(&b).len(), 1);
    assert_eq!(fixture.pending(&c).len(), 1);
    for request in [&b, &c] {
        assert_eq!(fixture.stop(request).finalized, 1);
        assert_eq!(
            fs::read(Fixture::snapshot(request)).unwrap(),
            fs::read(&request.transcript_path).unwrap()
        );
    }
}

#[test]
fn producer_arriving_during_finalizer_publication_keeps_its_distinct_ticket_and_bytes() {
    let fixture = Fixture::new();
    let a = fixture.request("project-a", "session-a", "plan-a");
    execute(&fixture.context, &a, expires()).unwrap();
    append(&a.transcript_path, b"{\"final\":true}\n");
    let mut b = a.clone();
    let plan_b = fixture.root.join("project-a/.caws/plans/plan-b.md");
    write(&plan_b, b"# second plan\n");
    b.action = Action::Produce {
        plan_path: plan_b.clone(),
    };
    let owner = validate_request(&fixture.context, &a, expires()).unwrap();
    let ns = namespace(&fixture.context, &owner, expires()).unwrap();
    let mut stop = a.clone();
    stop.action = Action::Finalize;
    let mut output = Outcome::default();
    let mut observed = 0;
    finalize_with_publication(
        &fixture.context,
        &stop,
        &owner,
        &ns,
        expires(),
        &mut output,
        || {
            observed += 1;
            assert_eq!(execute(&fixture.context, &b, expires())?.produced, 1);
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(observed, 1);
    assert_eq!(output.finalized, 1);
    assert_eq!(fixture.pending(&a).len(), 1);
    assert_eq!(
        fs::read(plan_b.with_extension("transcript.jsonl")).unwrap(),
        fs::read(&a.transcript_path).unwrap()
    );
    assert_eq!(fixture.stop(&a).finalized, 1);
    assert!(fixture.pending(&a).is_empty());
}

#[test]
fn interrupted_after_durable_snapshot_before_ack_replays_without_losing_ticket() {
    let fixture = Fixture::new();
    let request = fixture.request("project-a", "session-a", "plan-a");
    execute(&fixture.context, &request, expires()).unwrap();
    append(&request.transcript_path, b"{\"approved\":true}\n");
    let owner = validate_request(&fixture.context, &request, expires()).unwrap();
    let ns = namespace(&fixture.context, &owner, expires()).unwrap();
    let mut stop = request.clone();
    stop.action = Action::Finalize;
    let error = finalize_with_publication(
        &fixture.context,
        &stop,
        &owner,
        &ns,
        expires(),
        &mut Outcome::default(),
        || {
            Err(failure(
                ErrorKind::Io,
                "injected interruption after durable snapshot",
            ))
        },
    )
    .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Io);
    assert_eq!(fixture.pending(&request).len(), 1);
    let durable = fs::read(Fixture::snapshot(&request)).unwrap();
    assert_eq!(durable, fs::read(&request.transcript_path).unwrap());
    assert_eq!(fixture.stop(&request).finalized, 1);
    assert_eq!(fs::read(Fixture::snapshot(&request)).unwrap(), durable);
    assert!(fixture.pending(&request).is_empty());
}

#[test]
fn target_owner_claim_refuses_foreign_session_and_replaced_transcript_without_overwrite() {
    let fixture = Fixture::new();
    let request = fixture.request("project-a", "session-a", "plan-a");
    execute(&fixture.context, &request, expires()).unwrap();
    let snapshot = Fixture::snapshot(&request);
    let initial = fs::read(&snapshot).unwrap();
    let mut foreign = request.clone();
    foreign.session_id = "session-b".into();
    assert_eq!(
        execute(&fixture.context, &foreign, expires())
            .unwrap_err()
            .kind,
        ErrorKind::OwnerConflict
    );
    assert_eq!(fs::read(&snapshot).unwrap(), initial);
    let moved = fixture.root.join("retired-transcript");
    fs::rename(&request.transcript_path, &moved).unwrap();
    write(&request.transcript_path, &initial);
    let mut stop = request.clone();
    stop.action = Action::Finalize;
    assert_eq!(
        execute(&fixture.context, &stop, expires())
            .unwrap_err()
            .kind,
        ErrorKind::TranscriptChanged
    );
    assert_eq!(fs::read(&snapshot).unwrap(), initial);
    assert_eq!(fixture.pending(&request).len(), 1);
}

#[test]
fn transcript_truncation_and_prefix_rewrite_preserve_pending_and_previous_snapshot() {
    for replacement in [
        b"short".as_slice(),
        b"a completely different transcript prefix with a larger length\n".as_slice(),
    ] {
        let fixture = Fixture::new();
        let request = fixture.request("project-a", "session-a", "plan-a");
        execute(&fixture.context, &request, expires()).unwrap();
        let initial = fs::read(Fixture::snapshot(&request)).unwrap();
        write(&request.transcript_path, replacement);
        let mut stop = request.clone();
        stop.action = Action::Finalize;
        assert_eq!(
            execute(&fixture.context, &stop, expires())
                .unwrap_err()
                .kind,
            ErrorKind::TranscriptChanged
        );
        assert_eq!(fs::read(Fixture::snapshot(&request)).unwrap(), initial);
        assert_eq!(fixture.pending(&request).len(), 1);
    }
}

#[test]
fn unsafe_plan_destination_and_state_paths_refuse_without_touching_external_bytes() {
    let fixture = Fixture::new();
    let request = fixture.request("project-a", "session-a", "plan-a");
    let outside = fixture.root.join("outside.md");
    write(&outside, b"outside remains\n");
    let mut unsafe_request = request.clone();
    unsafe_request.action = Action::Produce {
        plan_path: outside.clone(),
    };
    assert_eq!(
        execute(&fixture.context, &unsafe_request, expires())
            .unwrap_err()
            .kind,
        ErrorKind::UnsafePath
    );
    let Action::Produce { plan_path } = &request.action else {
        unreachable!()
    };
    fs::remove_file(plan_path).unwrap();
    symlink(&outside, plan_path).unwrap();
    assert_eq!(
        execute(&fixture.context, &request, expires())
            .unwrap_err()
            .kind,
        ErrorKind::UnsafePath
    );
    fs::remove_file(plan_path).unwrap();
    write(plan_path, b"# safe plan\n");
    symlink(&outside, Fixture::snapshot(&request)).unwrap();
    assert_eq!(
        execute(&fixture.context, &request, expires())
            .unwrap_err()
            .kind,
        ErrorKind::UnsafePath
    );
    assert_eq!(fs::read(&outside).unwrap(), b"outside remains\n");
    fs::remove_file(Fixture::snapshot(&request)).unwrap();
    let state = fixture.context.home.join("state");
    fs::rename(&state, fixture.root.join("retired-state")).unwrap();
    symlink(fixture.root.join("retired-state"), &state).unwrap();
    assert_eq!(
        execute(&fixture.context, &request, expires())
            .unwrap_err()
            .kind,
        ErrorKind::UnsafePath
    );
}

#[test]
fn legacy_ownerless_list_is_preserved_and_reported_without_copying_or_drain() {
    let fixture = Fixture::new();
    let request = fixture.request("project-a", "session-a", "plan-a");
    let victim = fixture.root.join("legacy-snapshot.jsonl");
    write(&victim, b"legacy owner bytes\n");
    let pending = fixture.root.join("user/.codex/.pending-plan-snapshots");
    let carrier = format!("{}\n", victim.display());
    write(&pending, carrier.as_bytes());
    let mut stop = request.clone();
    stop.action = Action::Finalize;
    let output = execute(&fixture.context, &stop, expires()).unwrap();
    assert_eq!(output.finalized, 0);
    assert_eq!(
        output.diagnostics,
        vec![
            "legacy ownerless pending plan snapshots preserved; explicit provenance migration required"
        ]
    );
    assert_eq!(fs::read(&pending).unwrap(), carrier.as_bytes());
    assert_eq!(fs::read(&victim).unwrap(), b"legacy owner bytes\n");
    execute(&fixture.context, &request, expires()).unwrap();
    assert_eq!(fixture.stop(&request).finalized, 1);
    assert_eq!(fs::read(&pending).unwrap(), carrier.as_bytes());
}

#[test]
fn scope_includes_explicit_checkout_project_and_vendor_plan_roots_only() {
    let fixture = Fixture::new();
    let base = fixture.request("project-a", "session-a", "plan-a");
    for (index, plan) in [
        fixture.root.join("project-a/plans/a.md"),
        fixture.root.join("checkout/.caws/plans/b.md"),
        fixture.root.join("checkout/plans/c.md"),
        fixture.root.join("user/.codex/plans/d.md"),
    ]
    .into_iter()
    .enumerate()
    {
        write(&plan, b"# plan\n");
        let mut request = base.clone();
        request.action = Action::Produce {
            plan_path: plan.clone(),
        };
        assert_eq!(
            execute(&fixture.context, &request, expires())
                .unwrap()
                .produced,
            1,
            "root {index}"
        );
        assert_eq!(
            fs::read(plan.with_extension("transcript.jsonl")).unwrap(),
            fs::read(&request.transcript_path).unwrap()
        );
    }
    let mut invalid = base.clone();
    invalid.action = Action::Produce {
        plan_path: fixture.root.join("project-a/plans/../outside.md"),
    };
    assert_eq!(
        execute(&fixture.context, &invalid, expires())
            .unwrap_err()
            .kind,
        ErrorKind::UnsafePath
    );
    let mut no_home = fixture.context.clone();
    no_home.legacy_user_home = None;
    execute(&no_home, &base, expires()).unwrap();
    assert_eq!(fixture.pending(&base).len(), 5);
    no_home.home = PathBuf::new();
    assert_eq!(
        execute(&no_home, &base, expires()).unwrap_err().kind,
        ErrorKind::UnsafePath
    );
}

#[test]
fn limits_identity_corrupt_ticket_and_expired_budget_refuse_without_acknowledgement() {
    let fixture = Fixture::new();
    let request = fixture.request("project-a", "session-a", "plan-a");
    for sid in ["unknown", "../other", ""] {
        let mut wrong = request.clone();
        wrong.session_id = sid.into();
        assert_eq!(
            execute(&fixture.context, &wrong, expires())
                .unwrap_err()
                .kind,
            ErrorKind::Identity
        );
    }
    assert_eq!(
        execute(
            &fixture.context,
            &request,
            Instant::now() - Duration::from_secs(1)
        )
        .unwrap_err()
        .kind,
        ErrorKind::Deadline
    );
    execute(&fixture.context, &request, expires()).unwrap();
    let owner = validate_request(&fixture.context, &request, expires()).unwrap();
    let ns = namespace(&fixture.context, &owner, expires()).unwrap();
    let name = fixture.pending(&request).pop().unwrap();
    write(&ns.pending.path.join(&name), b"{broken");
    let mut stop = request.clone();
    stop.action = Action::Finalize;
    assert_eq!(
        execute(&fixture.context, &stop, expires())
            .unwrap_err()
            .kind,
        ErrorKind::Corrupt
    );
    assert!(ns.pending.path.join(&name).exists());
    let oversized = fixture.request("project-b", "session-b", "large");
    OpenOptions::new()
        .write(true)
        .open(&oversized.transcript_path)
        .unwrap()
        .set_len(MAX_TRANSCRIPT_BYTES as u64 + 1)
        .unwrap();
    assert_eq!(
        execute(&fixture.context, &oversized, expires())
            .unwrap_err()
            .kind,
        ErrorKind::Limit
    );
}

#[test]
fn same_target_cross_process_lock_is_bounded_and_released_by_process_exit() {
    let fixture = Fixture::new();
    let request = fixture.request("project-a", "session-a", "plan-a");
    let owner = validate_request(&fixture.context, &request, expires()).unwrap();
    let ns = namespace(&fixture.context, &owner, expires()).unwrap();
    let snapshot = Fixture::snapshot(&request);
    let (target, lock) = lock_target(&ns, &snapshot, expires()).unwrap();
    drop(lock);
    fn pipe() -> (File, File) {
        let mut pair = [0; 2];
        assert_eq!(unsafe { libc::pipe(pair.as_mut_ptr()) }, 0);
        unsafe { (File::from_raw_fd(pair[0]), File::from_raw_fd(pair[1])) }
    }
    struct Child {
        pid: libc::pid_t,
        ready: File,
        release: Option<File>,
        reaped: bool,
    }
    impl Child {
        fn finish(&mut self) -> libc::c_int {
            drop(self.release.take());
            if self.reaped {
                return 0;
            }
            let mut status = 0;
            loop {
                let result = unsafe { libc::waitpid(self.pid, &mut status, 0) };
                if result == self.pid {
                    self.reaped = true;
                    return status;
                }
                if result < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                self.reaped = true;
                return -1;
            }
        }
    }
    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.finish();
        }
    }
    let (ready_read, ready_write) = pipe();
    let (release_read, release_write) = pipe();
    let child = unsafe { libc::fork() };
    assert!(child >= 0);
    if child == 0 {
        unsafe {
            libc::close(ready_read.as_raw_fd());
            libc::close(release_write.as_raw_fd());
            let fd = libc::openat(
                target.file.as_raw_fd(),
                c".lock".as_ptr(),
                libc::O_RDWR | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            );
            if fd < 0 || libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) != 0 {
                libc::_exit(10);
            }
            let signal = [1u8];
            if libc::write(ready_write.as_raw_fd(), signal.as_ptr().cast(), 1) != 1 {
                libc::_exit(11);
            }
            // EOF releases the child even when a parent assertion unwinds.
            // The poll also bounds this fixture if the parent disappears.
            let mut release_poll = libc::pollfd {
                fd: release_read.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            libc::poll(&mut release_poll, 1, 2000);
            libc::_exit(0);
        }
    }
    drop(ready_write);
    drop(release_read);
    let mut child = Child {
        pid: child,
        ready: ready_read,
        release: Some(release_write),
        reaped: false,
    };
    let mut ready_poll = libc::pollfd {
        fd: child.ready.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    assert_eq!(unsafe { libc::poll(&mut ready_poll, 1, 2000) }, 1);
    let mut byte = [0u8];
    assert_eq!(
        unsafe { libc::read(child.ready.as_raw_fd(), byte.as_mut_ptr().cast(), 1) },
        1
    );
    assert_eq!(byte, [1]);
    assert_eq!(
        stable_lock(&target, Instant::now() + Duration::from_millis(30))
            .unwrap_err()
            .kind,
        ErrorKind::Deadline
    );
    let status = child.finish();
    eprintln!(
        "plan_snapshot_lock_probe child_pid={} wait_status={status}",
        child.pid
    );
    assert_eq!(status, 0);
    let _lock = stable_lock(&target, expires()).unwrap();
    assert_eq!(
        metadata(
            &open_child(&target.file, ".lock", libc::O_RDONLY, 0).unwrap(),
            false,
            true
        )
        .unwrap()
        .mode()
            & 0o7777,
        0o600
    );
}

#[test]
fn typed_command_context_preserves_explicit_absence_and_refuses_duplicate_or_ambient_inputs() {
    let arguments = |values: &[&str]| {
        values
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<Vec<_>>()
    };
    let context = command_context(&arguments(&[
        "--home",
        "/machine",
        "--checkout",
        "/project",
        "--legacy-user-home",
        "",
    ]))
    .unwrap();
    assert_eq!(context.home, PathBuf::from("/machine"));
    assert_eq!(context.checkout, Some(PathBuf::from("/project")));
    assert!(context.legacy_user_home.is_none());
    for values in [
        vec!["--home", "/machine"],
        vec![
            "--home",
            "/machine",
            "--checkout",
            "/project",
            "--legacy-user-home",
            "",
            "--legacy-user-home",
            "/other",
        ],
        vec![
            "--home",
            "/machine",
            "--checkout",
            "/project",
            "--session-id",
            "inferred",
        ],
    ] {
        assert!(command_context(&arguments(&values)).is_err());
    }
    let fixture = Fixture::new();
    let request = fixture.request("project-a", "session-a", "plan-a");
    let mut value = serde_json::to_value(&request).unwrap();
    value
        .as_object_mut()
        .unwrap()
        .insert("pid".into(), serde_json::json!(1));
    assert!(serde_json::from_value::<Request>(value).is_err());
}

#[test]
fn ticket_capacity_refuses_new_obligation_without_overwriting_existing_snapshot() {
    let fixture = Fixture::new();
    let request = fixture.request("project-a", "session-a", "plan-a");
    execute(&fixture.context, &request, expires()).unwrap();
    let initial = fs::read(Fixture::snapshot(&request)).unwrap();
    let owner = validate_request(&fixture.context, &request, expires()).unwrap();
    let ns = namespace(&fixture.context, &owner, expires()).unwrap();
    // Malformed pending entries still occupy the bounded namespace. Admission
    // cannot ignore them to manufacture capacity or delete them to make room.
    for index in 0..MAX_PENDING_TICKETS - 1 {
        write(
            &ns.pending.path.join(format!("{index:064x}.json")),
            b"untrusted pending record",
        );
    }
    assert_eq!(
        ticket_names(&ns.pending.file, expires()).unwrap().len(),
        MAX_PENDING_TICKETS
    );
    append(&request.transcript_path, b"{\"newer\":true}\n");
    assert_eq!(
        execute(&fixture.context, &request, expires())
            .unwrap_err()
            .kind,
        ErrorKind::Limit
    );
    assert_eq!(fs::read(Fixture::snapshot(&request)).unwrap(), initial);
    assert_eq!(
        ticket_names(&ns.pending.file, expires()).unwrap().len(),
        MAX_PENDING_TICKETS
    );
}

#[test]
fn snapshot_parent_replacement_and_case_alias_owner_collision_refuse() {
    let fixture = Fixture::new();
    let request = fixture.request("project-a", "session-a", "plan-a");
    execute(&fixture.context, &request, expires()).unwrap();
    let initial = fs::read(Fixture::snapshot(&request)).unwrap();
    let Action::Produce { plan_path } = &request.action else {
        unreachable!()
    };
    let mut alias = request.clone();
    alias.session_id = "foreign-owner".into();
    let alias_plan = plan_path.with_file_name("PLAN-A.md");
    if !alias_plan.exists() {
        write(&alias_plan, b"# case alias\n");
    }
    alias.action = Action::Produce {
        plan_path: alias_plan,
    };
    assert_eq!(
        execute(&fixture.context, &alias, expires())
            .unwrap_err()
            .kind,
        ErrorKind::OwnerConflict
    );
    assert_eq!(fs::read(Fixture::snapshot(&request)).unwrap(), initial);
    let parent = plan_path.parent().unwrap();
    let moved = fixture.root.join("retired-plan-directory");
    fs::rename(parent, &moved).unwrap();
    fs::create_dir(parent).unwrap();
    write(plan_path, b"# replacement parent plan\n");
    let mut stop = request.clone();
    stop.action = Action::Finalize;
    assert_eq!(
        execute(&fixture.context, &stop, expires())
            .unwrap_err()
            .kind,
        ErrorKind::UnsafePath
    );
    assert_eq!(
        fs::read(moved.join("plan-a.transcript.jsonl")).unwrap(),
        initial
    );
    assert_eq!(fixture.pending(&request).len(), 1);
    let unicode = parent.join("plan-\u{00e9}.md");
    write(&unicode, b"# unsupported ambiguous basename\n");
    let mut unsafe_name = request.clone();
    unsafe_name.action = Action::Produce { plan_path: unicode };
    assert_eq!(
        execute(&fixture.context, &unsafe_name, expires())
            .unwrap_err()
            .kind,
        ErrorKind::UnsafePath
    );
}

#[test]
fn transcript_destination_alias_refuses_before_claim_or_ticket_and_preserves_identity() {
    let fixture = Fixture::new();
    let mut request = fixture.request("project-a", "session-a", "plan-a");
    let destination = Fixture::snapshot(&request);
    write(&destination, b"original transcript must remain\n");
    request.transcript_path = destination.clone();
    let original = fs::metadata(&destination).unwrap();
    let bytes = fs::read(&destination).unwrap();
    assert_eq!(
        execute(&fixture.context, &request, expires())
            .unwrap_err()
            .kind,
        ErrorKind::UnsafePath
    );
    let current = fs::metadata(&destination).unwrap();
    assert_eq!(
        (current.dev(), current.ino()),
        (original.dev(), original.ino())
    );
    assert_eq!(fs::read(&destination).unwrap(), bytes);
    assert!(fixture.pending(&request).is_empty());
    let owner = validate_request(&fixture.context, &request, expires()).unwrap();
    let ns = namespace(&fixture.context, &owner, expires()).unwrap();
    assert_eq!(fs::read_dir(&ns.targets.path).unwrap().count(), 0);
    // A distinct transcript can establish this destination only after explicit
    // removal of the preexisting ownerless snapshot.
    let mut distinct = request.clone();
    distinct.transcript_path = fixture.root.join("distinct-transcript.jsonl");
    write(&distinct.transcript_path, b"different current transcript\n");
    assert_eq!(
        execute(&fixture.context, &distinct, expires())
            .unwrap_err()
            .kind,
        ErrorKind::OwnerConflict
    );
    fs::remove_file(&destination).unwrap();
    assert_eq!(
        execute(&fixture.context, &distinct, expires())
            .unwrap()
            .produced,
        1
    );
    assert_eq!(
        fs::read(&destination).unwrap(),
        fs::read(&distinct.transcript_path).unwrap()
    );
    append(&distinct.transcript_path, b"native-owned update\n");
    assert_eq!(
        execute(&fixture.context, &distinct, expires())
            .unwrap()
            .produced,
        1
    );
    assert_eq!(
        fs::read(&destination).unwrap(),
        fs::read(&distinct.transcript_path).unwrap()
    );
}

#[test]
fn ownerless_existing_snapshot_in_legacy_list_is_never_claimed_or_overwritten() {
    let fixture = Fixture::new();
    let request = fixture.request("project-a", "session-a", "plan-a");
    let destination = Fixture::snapshot(&request);
    write(&destination, b"legacy snapshot bytes\n");
    let original = fs::metadata(&destination).unwrap();
    let pending = fixture.root.join("user/.codex/.pending-plan-snapshots");
    let carrier = format!("{}\n", destination.display());
    write(&pending, carrier.as_bytes());
    let error = execute(&fixture.context, &request, expires()).unwrap_err();
    assert_eq!(error.kind, ErrorKind::OwnerConflict);
    assert!(error.operation().contains("explicit adoption required"));
    let after = fs::metadata(&destination).unwrap();
    assert_eq!((after.dev(), after.ino()), (original.dev(), original.ino()));
    assert_eq!(fs::read(&destination).unwrap(), b"legacy snapshot bytes\n");
    assert_eq!(fs::read(&pending).unwrap(), carrier.as_bytes());
    assert!(fixture.pending(&request).is_empty());
    let owner = validate_request(&fixture.context, &request, expires()).unwrap();
    let ns = namespace(&fixture.context, &owner, expires()).unwrap();
    for entry in fs::read_dir(&ns.targets.path).unwrap() {
        assert!(!entry.unwrap().path().join("owner.json").exists());
    }
}
