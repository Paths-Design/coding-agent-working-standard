use super::*;
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering as AtomicOrdering},
};

struct Fixture {
    root: PathBuf,
    home: PathBuf,
    legacy: PathBuf,
    logs: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let base = fs::canonicalize(std::env::temp_dir()).unwrap();
        let root = base.join(format!(
            "caws-guard-strikes-test-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let home = root.join("home");
        let legacy = root.join("legacy");
        let logs = root.join("logs");
        for dir in [&home, &legacy, &logs] {
            fs::create_dir(dir).unwrap();
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self {
            root,
            home,
            legacy,
            logs,
        }
    }
    fn directory(&self, sid: &str) -> PathBuf {
        self.home
            .join("state/sessions")
            .join(StrikeIdentity::resolve(sid).unwrap().sanitized())
    }
    fn state(&self, sid: &str) -> PathBuf {
        self.directory(sid).join("strikes.json")
    }
    fn write(&self, path: &Path, value: &[u8]) {
        fs::write(path, value).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn store(&self, sid: &str, budget: TransactionBudget<'_>) -> StrikeStore {
        StrikeStore::open(&self.home, StrikeIdentity::resolve(sid).unwrap(), budget).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn original() -> MonotonicDeadline {
    MonotonicDeadline::capture(Duration::from_secs(20)).unwrap()
}
fn budget<'a>(
    clock: &'a MonotonicDeadline,
    cancelled: &'a dyn Fn() -> bool,
) -> TransactionBudget<'a> {
    TransactionBudget::original(clock, clock.expires(), cancelled)
}
fn parsed(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}
fn wait_path(path: &Path) {
    let until = Instant::now() + Duration::from_secs(10);
    while !path.exists() {
        assert!(
            Instant::now() < until,
            "missing worker readiness {}",
            path.display()
        );
        thread::sleep(Duration::from_millis(2));
    }
}
fn worker(f: &Fixture, sid: &str, mode: &str, tag: &str) -> Child {
    Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "guard_strikes::tests::subprocess_worker",
            "--ignored",
            "--nocapture",
        ])
        .env("CAWS_STRIKE_TEST_ROOT", &f.root)
        .env("CAWS_STRIKE_TEST_SID", sid)
        .env("CAWS_STRIKE_TEST_MODE", mode)
        .env("CAWS_STRIKE_TEST_TAG", tag)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

#[test]
fn identity_preserves_ascii_buckets_and_refuses_unsupported_identity() {
    assert_eq!(StrikeIdentity::resolve("a:b").unwrap().sanitized(), "a_b");
    assert_eq!(StrikeIdentity::resolve("a@b").unwrap().sanitized(), "a_b");
    assert_ne!(StrikeIdentity::resolve("a-b").unwrap().sanitized(), "a_b");
    for sid in [
        "",
        "unknown",
        ".",
        "..",
        "a/b",
        "a\\b",
        "a b",
        "日本",
        "a\0b",
        &"a".repeat(129),
    ] {
        assert_eq!(
            StrikeIdentity::resolve(sid).unwrap_err().kind,
            ErrorKind::Identity,
            "{sid:?}"
        );
    }
    assert_eq!(
        StrikeIdentity::resolve(&"a".repeat(128))
            .unwrap()
            .sanitized()
            .len(),
        128
    );
}

#[test]
fn increment_imports_once_preserves_other_values_and_returns_exact_hash() {
    let f = Fixture::new();
    let clock = original();
    let cancel = || false;
    let b = budget(&clock, &cancel);
    let first = f.legacy.join("first.json");
    let second = f.legacy.join("second.json");
    f.write(
        &first,
        br#"{"scope_guard":2,"worktree_guard":7,"other":{"a":[1,true,"x"]}}"#,
    );
    f.write(&second, br#"{"scope_guard":4,"custom_guard":9}"#);
    let store = f.store("import", b);
    let result = store
        .increment_scope_guard(&[first.clone(), second.clone()], b)
        .unwrap();
    assert_eq!(result.count, 5);
    assert_eq!(
        result.state_sha256,
        digest(&fs::read(f.state("import")).unwrap())
    );
    assert_eq!(
        parsed(&f.state("import")),
        json!({"scope_guard":5,"worktree_guard":7,"custom_guard":9,"other":{"a":[1,true,"x"]}})
    );
    f.write(&first, br#"{"scope_guard":900,"worktree_guard":100}"#);
    assert_eq!(
        store
            .increment_scope_guard(&[first, second], b)
            .unwrap()
            .count,
        6
    );
    assert_eq!(parsed(&f.state("import"))["worktree_guard"], 7);
    assert_eq!(
        parsed(&f.directory("import").join(".guard-strikes-imported.json"))["imported"],
        true
    );
}

#[test]
fn existing_global_without_marker_is_never_refolded() {
    let f = Fixture::new();
    let clock = original();
    let cancel = || false;
    let b = budget(&clock, &cancel);
    let store = f.store("oldglobal", b);
    f.write(
        &f.state("oldglobal"),
        br#"{"scope_guard":8,"preserved":11}"#,
    );
    let legacy = f.legacy.join("old.json");
    f.write(&legacy, br#"{"scope_guard":50,"preserved":99}"#);
    assert_eq!(store.increment_scope_guard(&[legacy], b).unwrap().count, 9);
    assert_eq!(parsed(&f.state("oldglobal"))["preserved"], 11);
    assert!(
        f.directory("oldglobal")
            .join(".guard-strikes-imported.json")
            .exists()
    );
}

#[test]
fn strict_counts_duplicate_json_and_bounds_fail_before_mutation() {
    let f = Fixture::new();
    let clock = original();
    let cancel = || false;
    let b = budget(&clock, &cancel);
    let store = f.store("strict", b);
    for bytes in [
        br#"{"scope_guard":"2"}"#.as_slice(),
        br#"{"scope_guard":null}"#,
        br#"{"scope_guard":-1}"#,
        br#"{"scope_guard":1.5}"#,
        br#"{"scope_guard":9007199254740992}"#,
        br#"{"scope_guard":1,"scope_guard":7}"#,
        br#"{"other":{"x":1,"x":2}}"#,
        br#"[]"#,
        b"{",
    ] {
        f.write(&f.state("strict"), bytes);
        assert_eq!(
            store.increment_scope_guard(&[], b).unwrap_err().kind,
            ErrorKind::Corrupt
        );
        assert_eq!(fs::read(f.state("strict")).unwrap(), bytes);
        assert!(
            !f.directory("strict")
                .join(".guard-strikes-imported.json")
                .exists()
        );
    }
    let overflow = br#"{"scope_guard":9007199254740991,"other":4}"#;
    f.write(&f.state("strict"), overflow);
    assert_eq!(
        store.increment_scope_guard(&[], b).unwrap_err().kind,
        ErrorKind::Overflow
    );
    assert_eq!(fs::read(f.state("strict")).unwrap(), overflow);
    for representation in [
        br#"{"scope_guard":1.0}"#.as_slice(),
        br#"{"scope_guard":1e0}"#,
    ] {
        f.write(&f.state("strict"), representation);
        assert_eq!(store.increment_scope_guard(&[], b).unwrap().count, 2);
    }
    f.write(&f.state("strict"), &vec![b' '; MAX_BYTES + 1]);
    assert_eq!(
        store.increment_scope_guard(&[], b).unwrap_err().kind,
        ErrorKind::Corrupt
    );
}

#[test]
fn hostile_state_paths_cannot_change_external_bytes() {
    let f = Fixture::new();
    let clock = original();
    let cancel = || false;
    let b = budget(&clock, &cancel);
    let store = f.store("hostile", b);
    let outside = f.root.join("outside.json");
    f.write(&outside, br#"{"scope_guard":30}"#);
    symlink(&outside, f.state("hostile")).unwrap();
    assert_eq!(
        store.increment_scope_guard(&[], b).unwrap_err().kind,
        ErrorKind::UnsafePath
    );
    assert_eq!(parsed(&outside)["scope_guard"], 30);
    fs::remove_file(f.state("hostile")).unwrap();
    fs::hard_link(&outside, f.state("hostile")).unwrap();
    assert_eq!(
        store.increment_scope_guard(&[], b).unwrap_err().kind,
        ErrorKind::UnsafePath
    );
    assert_eq!(parsed(&outside)["scope_guard"], 30);
    fs::remove_file(f.state("hostile")).unwrap();
    fs::create_dir(f.state("hostile")).unwrap();
    assert_eq!(
        store.increment_scope_guard(&[], b).unwrap_err().kind,
        ErrorKind::UnsafePath
    );
    fs::remove_dir(f.state("hostile")).unwrap();
    f.write(&f.state("hostile"), b"{}");
    fs::set_permissions(f.state("hostile"), fs::Permissions::from_mode(0o666)).unwrap();
    assert_eq!(
        store.increment_scope_guard(&[], b).unwrap_err().kind,
        ErrorKind::UnsafePath
    );
    let alias = f.root.join("alias");
    symlink(&f.home, &alias).unwrap();
    assert_eq!(
        StrikeStore::open(&alias, StrikeIdentity::resolve("x").unwrap(), b)
            .err()
            .unwrap()
            .kind,
        ErrorKind::UnsafePath
    );
}

#[test]
fn retained_directory_and_lock_replacements_are_refused() {
    let f = Fixture::new();
    let clock = original();
    let cancel = || false;
    let b = budget(&clock, &cancel);
    let store = f.store("replace", b);
    let old = f.directory("replace").with_extension("old");
    fs::rename(f.directory("replace"), &old).unwrap();
    fs::create_dir(f.directory("replace")).unwrap();
    assert_eq!(
        store.increment_scope_guard(&[], b).unwrap_err().kind,
        ErrorKind::UnsafePath
    );
    assert!(!f.state("replace").exists());
    let fresh = f.store("lock", b);
    let held = fresh.directory.lock(LOCK, b).unwrap();
    let lock_path = f.directory("lock").join(".guard-strikes.lock");
    fs::remove_file(&lock_path).unwrap();
    f.write(&lock_path, b"");
    assert_eq!(
        verify_lock(&fresh.directory, LOCK, &held, b)
            .unwrap_err()
            .kind,
        ErrorKind::UnsafePath
    );
    assert!(!f.state("lock").exists());
}

#[test]
fn held_flock_exhausts_original_deadline_and_cancellation_without_state_write() {
    let f = Fixture::new();
    let clock = original();
    let cancel = || false;
    let b = budget(&clock, &cancel);
    let store = f.store("wait", b);
    let _held = store.directory.lock(LOCK, b).unwrap();
    let short = MonotonicDeadline::capture(Duration::from_millis(35)).unwrap();
    assert_eq!(
        store
            .increment_scope_guard(&[], budget(&short, &cancel))
            .unwrap_err()
            .kind,
        ErrorKind::Deadline
    );
    assert!(!f.state("wait").exists());
    let stopped = AtomicBool::new(false);
    let cancelled = || stopped.load(AtomicOrdering::SeqCst);
    thread::scope(|scope| {
        scope.spawn(|| {
            thread::sleep(Duration::from_millis(20));
            stopped.store(true, AtomicOrdering::SeqCst);
        });
        assert_eq!(
            store
                .increment_scope_guard(&[], budget(&clock, &cancelled))
                .unwrap_err()
                .kind,
            ErrorKind::Cancelled
        );
    });
    assert!(!f.state("wait").exists());
}

#[test]
fn post_rename_cancellation_is_terminal_uncertainty_with_known_identity() {
    let f = Fixture::new();
    let clock = original();
    let never = || false;
    let store = f.store("uncertain", budget(&clock, &never));
    let cancelled = || f.state("uncertain").exists();
    let error = store
        .increment_scope_guard(&[], budget(&clock, &cancelled))
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::PublicationUncertain);
    let known = error.publication.unwrap();
    assert_eq!(known.count, 1);
    assert_eq!(
        known.state_sha256,
        digest(&fs::read(f.state("uncertain")).unwrap())
    );
    assert_eq!(parsed(&f.state("uncertain"))["scope_guard"], 1);
    // A caller must keep the failed port consumed; this core does not replay.
}

#[test]
fn selected_guard_reset_preserves_keys_and_delete_never_resurrects_legacy() {
    let f = Fixture::new();
    let clock = original();
    let cancel = || false;
    let b = budget(&clock, &cancel);
    let store = f.store("reset", b);
    let audit = ResetAudit::open(&f.logs, b).unwrap();
    let legacy = f.legacy.join("old.json");
    let before = json!({"scope_guard":9,"worktree_guard":4,"custom":{"nested":[1,true,"kept"]}});
    f.write(&legacy, &serde_json::to_vec(&before).unwrap());
    let receipt = store
        .reset(Some("scope_guard"), &[legacy.clone()], &audit, b)
        .unwrap();
    assert_eq!(
        parsed(&f.state("reset")),
        json!({"worktree_guard":4,"custom":{"nested":[1,true,"kept"]}})
    );
    assert_eq!(
        receipt.after_sha256,
        Some(digest(&fs::read(f.state("reset")).unwrap()))
    );
    assert_eq!(
        store
            .increment_scope_guard(&[legacy.clone()], b)
            .unwrap()
            .count,
        1
    );
    store.reset(None, &[legacy.clone()], &audit, b).unwrap();
    assert!(!f.state("reset").exists());
    assert!(
        f.directory("reset")
            .join(".guard-strikes-imported.json")
            .exists()
    );
    assert_eq!(store.increment_scope_guard(&[legacy], b).unwrap().count, 1);
    let text = fs::read_to_string(f.logs.join("strike-resets.log")).unwrap();
    let records: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(records.len(), 4);
    assert_eq!(records[0]["phase"], "intent");
    assert_eq!(records[0]["beforeState"], before);
    assert_eq!(records[0]["beforeState"]["worktree_guard"], 4);
    assert_eq!(
        records[0]["beforeState"]["custom"]["nested"],
        json!([1, true, "kept"])
    );
    let before_object = records[0]["beforeState"].as_object().unwrap();
    assert_eq!(
        records[0]["before"],
        digest(&encoded(before_object).unwrap())
    );
    assert_eq!(records[0]["before"], receipt.before_sha256);
    assert_eq!(records[0]["target"], f.state("reset").to_str().unwrap());
    assert_eq!(records[0]["bucket"], "reset");
    assert_eq!(records[0]["session"], "reset");
    assert_eq!(records[0]["guard"], "scope_guard");
    assert_eq!(records[1]["phase"], "commit");
    assert_eq!(records[0]["transaction"], records[1]["transaction"]);
    assert_eq!(records[0]["after"], records[1]["after"]);
    assert_eq!(records[0]["before"], records[1]["before"]);
    assert_eq!(records[0]["target"], records[1]["target"]);
    assert_eq!(
        records[2]["beforeState"],
        json!({"scope_guard":1,"worktree_guard":4,"custom":{"nested":[1,true,"kept"]}})
    );
    assert_eq!(records[2]["phase"], "intent");
    assert_eq!(records[3]["phase"], "commit");
    assert_eq!(records[2]["after"], Value::Null);
}

#[test]
fn failed_audit_prevents_reset_and_partial_audit_is_uncertain() {
    let f = Fixture::new();
    let clock = original();
    let cancel = || false;
    let b = budget(&clock, &cancel);
    let store = f.store("audit", b);
    store.increment_scope_guard(&[], b).unwrap();
    let audit = ResetAudit::open(&f.logs, b).unwrap();
    let outside = f.root.join("outside.log");
    f.write(&outside, b"untouched\n");
    symlink(&outside, f.logs.join("strike-resets.log")).unwrap();
    assert_eq!(
        store.reset(None, &[], &audit, b).unwrap_err().kind,
        ErrorKind::UnsafePath
    );
    assert_eq!(parsed(&f.state("audit"))["scope_guard"], 1);
    assert_eq!(fs::read(&outside).unwrap(), b"untouched\n");
    fs::remove_file(f.logs.join("strike-resets.log")).unwrap();
    let cancelled = || f.logs.join("strike-resets.log").exists();
    assert_eq!(
        store
            .reset(None, &[], &audit, budget(&clock, &cancelled))
            .unwrap_err()
            .kind,
        ErrorKind::PublicationUncertain
    );
    assert_eq!(parsed(&f.state("audit"))["scope_guard"], 1);
}

#[test]
#[ignore = "subprocess endpoint exercised by the parent process tests"]
fn subprocess_worker() {
    let Some(root) = std::env::var_os("CAWS_STRIKE_TEST_ROOT") else {
        assert!(std::env::var_os("CAWS_STRIKE_TEST_MODE").is_none());
        return;
    };
    let root = PathBuf::from(root);
    let sid = std::env::var("CAWS_STRIKE_TEST_SID").unwrap();
    let mode = std::env::var("CAWS_STRIKE_TEST_MODE").unwrap();
    let tag = std::env::var("CAWS_STRIKE_TEST_TAG").unwrap();
    let clock = original();
    let cancel = || false;
    let b = budget(&clock, &cancel);
    let store = StrikeStore::open(
        &root.join("home"),
        StrikeIdentity::resolve(&sid).unwrap(),
        b,
    )
    .unwrap();
    if mode == "hold" {
        let _held = store.directory.lock(LOCK, b).unwrap();
        fs::write(root.join(format!("ready-{tag}")), b"held").unwrap();
        loop {
            thread::sleep(Duration::from_millis(10));
        }
    }
    fs::write(root.join(format!("ready-{tag}")), b"entering").unwrap();
    let result = store.increment_scope_guard(&[], b).unwrap();
    fs::write(root.join(format!("result-{tag}")), result.count.to_string()).unwrap();
    assert!(result.count >= 1);
}

#[test]
fn subprocess_collision_buckets_serialize_without_losing_other_keys() {
    let f = Fixture::new();
    let clock = original();
    let cancel = || false;
    let b = budget(&clock, &cancel);
    let store = f.store("a:b", b);
    f.write(&f.state("a:b"), br#"{"worktree_guard":11}"#);
    let held = store.directory.lock(LOCK, b).unwrap();
    let mut one = worker(&f, "a:b", "increment", "one");
    let mut two = worker(&f, "a@b", "increment", "two");
    wait_path(&f.root.join("ready-one"));
    wait_path(&f.root.join("ready-two"));
    // Both independent processes reached the same held kernel lock.
    thread::sleep(Duration::from_millis(30));
    assert!(!f.root.join("result-one").exists());
    assert!(!f.root.join("result-two").exists());
    drop(held);
    assert!(one.wait().unwrap().success());
    assert!(two.wait().unwrap().success());
    let mut counts = vec![
        fs::read_to_string(f.root.join("result-one")).unwrap(),
        fs::read_to_string(f.root.join("result-two")).unwrap(),
    ];
    counts.sort();
    assert_eq!(counts, vec!["1", "2"]);
    assert_eq!(
        parsed(&f.state("a:b")),
        json!({"scope_guard":2,"worktree_guard":11})
    );
    assert_eq!(
        f.store("distinct", b)
            .increment_scope_guard(&[], b)
            .unwrap()
            .count,
        1
    );
    assert_eq!(parsed(&f.state("a:b"))["scope_guard"], 2);
}

#[test]
fn subprocess_crash_releases_kernel_lock_without_deleting_lock_inode() {
    let f = Fixture::new();
    let mut child = worker(&f, "crash", "hold", "crash");
    wait_path(&f.root.join("ready-crash"));
    let clock = original();
    let cancel = || false;
    let b = budget(&clock, &cancel);
    let store = f.store("crash", b);
    let before = named_metadata(store.directory.fd(), LOCK).unwrap().unwrap();
    let short = MonotonicDeadline::capture(Duration::from_millis(30)).unwrap();
    assert_eq!(
        store
            .increment_scope_guard(&[], budget(&short, &cancel))
            .unwrap_err()
            .kind,
        ErrorKind::Deadline
    );
    child.kill().unwrap();
    assert!(!child.wait().unwrap().success());
    assert_eq!(store.increment_scope_guard(&[], b).unwrap().count, 1);
    let after = named_metadata(store.directory.fd(), LOCK).unwrap().unwrap();
    assert!(same_inode(&before, &after));
}

#[test]
fn reset_interruption_after_marker_preserves_imported_unrelated_guard_keys() {
    let f = Fixture::new();
    let clock = original();
    let never = || false;
    let b = budget(&clock, &never);
    let store = f.store("partial-import", b);
    let audit = ResetAudit::open(&f.logs, b).unwrap();
    let legacy = f.legacy.join("partial.json");
    f.write(&legacy, br#"{"scope_guard":9,"worktree_guard":4}"#);
    let marker = f
        .directory("partial-import")
        .join(".guard-strikes-imported.json");
    let cancelled = || marker.exists();
    let error = store
        .reset(
            Some("scope_guard"),
            &[legacy.clone()],
            &audit,
            budget(&clock, &cancelled),
        )
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::PublicationUncertain);
    assert_eq!(
        parsed(&f.state("partial-import")),
        json!({"scope_guard":9,"worktree_guard":4})
    );
    f.write(&legacy, br#"{"scope_guard":900,"worktree_guard":900}"#);
    assert_eq!(store.increment_scope_guard(&[legacy], b).unwrap().count, 10);
    assert_eq!(parsed(&f.state("partial-import"))["worktree_guard"], 4);
    let text = fs::read_to_string(f.logs.join("strike-resets.log")).unwrap();
    let rows: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["phase"], "intent");
}

#[test]
fn reset_holds_session_lock_while_waiting_for_project_audit_lock() {
    let f = Fixture::new();
    let clock = original();
    let never = || false;
    let b = budget(&clock, &never);
    let store = f.store("reset-lock", b);
    store.increment_scope_guard(&[], b).unwrap();
    let audit = ResetAudit::open(&f.logs, b).unwrap();
    let held_audit = audit.directory.lock(AUDIT_LOCK, b).unwrap();
    thread::scope(|scope| {
        let reset = scope.spawn(|| {
            let reset_clock = original();
            let reset_cancel = || false;
            store.reset(None, &[], &audit, budget(&reset_clock, &reset_cancel))
        });
        // Observe the session lock's actual kernel exclusion, rather than only
        // sleeping and assuming the reset thread reached its wait boundary.
        let until = Instant::now() + Duration::from_secs(2);
        loop {
            let name = f.directory("reset-lock").join(".guard-strikes.lock");
            use std::os::unix::fs::OpenOptionsExt;
            let probe = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(name)
                .unwrap();
            let r = unsafe { libc::flock(probe.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if r != 0 {
                assert_eq!(io::Error::last_os_error().kind(), io::ErrorKind::WouldBlock);
                break;
            }
            drop(probe);
            assert!(Instant::now() < until, "reset never retained session lock");
            thread::sleep(Duration::from_millis(2));
        }
        let short = MonotonicDeadline::capture(Duration::from_millis(30)).unwrap();
        assert_eq!(
            store
                .increment_scope_guard(&[], budget(&short, &never))
                .unwrap_err()
                .kind,
            ErrorKind::Deadline
        );
        assert_eq!(
            f.store("independent", b)
                .increment_scope_guard(&[], b)
                .unwrap()
                .count,
            1
        );
        assert_eq!(parsed(&f.state("reset-lock"))["scope_guard"], 1);
        drop(held_audit);
        assert!(reset.join().unwrap().is_ok());
    });
    assert!(!f.state("reset-lock").exists());
    let text = fs::read_to_string(f.logs.join("strike-resets.log")).unwrap();
    let rows: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["phase"], "intent");
    assert_eq!(rows[1]["phase"], "commit");
}

#[test]
fn reset_intent_records_complete_preimage_before_state_mutation() {
    let f = Fixture::new();
    let clock = original();
    let never = || false;
    let b = budget(&clock, &never);
    let store = f.store("intent-order", b);
    let before =
        json!({"scope_guard":8,"worktree_guard":3,"custom":{"nested":[true,"retained",7]}});
    let before_bytes = encoded(before.as_object().unwrap()).unwrap();
    f.write(&f.state("intent-order"), &before_bytes);
    let audit = ResetAudit::open(&f.logs, b).unwrap();
    let seen = AtomicBool::new(false);
    let log = f.logs.join("strike-resets.log");
    let cancelled = || {
        let record = fs::read(&log)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        let Some(record) = record else {
            return false;
        };
        assert_eq!(record["phase"], "intent");
        assert_eq!(record["beforeState"], before);
        assert_eq!(record["before"], digest(&before_bytes));
        assert_eq!(record["target"], f.state("intent-order").to_str().unwrap());
        assert_eq!(record["action"], "reset");
        assert_eq!(record["mode"], "guard");
        assert_eq!(record["dryRun"], false);
        assert_eq!(record["guard"], "scope_guard");
        assert_eq!(fs::read(f.state("intent-order")).unwrap(), before_bytes);
        assert!(
            !f.directory("intent-order")
                .join(".guard-strikes-imported.json")
                .exists()
        );
        seen.store(true, AtomicOrdering::SeqCst);
        true
    };
    let error = store
        .reset(Some("scope_guard"), &[], &audit, budget(&clock, &cancelled))
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::PublicationUncertain);
    assert!(seen.load(AtomicOrdering::SeqCst));
    assert_eq!(fs::read(f.state("intent-order")).unwrap(), before_bytes);
    let record = parsed(&log);
    assert_eq!(record["beforeState"]["worktree_guard"], 3);
    assert_eq!(
        record["beforeState"]["custom"]["nested"],
        json!([true, "retained", 7])
    );
    // Cancellation observes the complete intent before state effects. It does
    // not establish that the interrupted audit append reached its fsync.
}

#[test]
fn audit_keeps_near_limit_preimage_and_refuses_oversize_before_open() {
    let f = Fixture::new();
    let clock = original();
    let never = || false;
    let b = budget(&clock, &never);
    let store = f.store("bounded-audit", b);
    let before = json!({"scope_guard":12,"other":"x".repeat(MAX_BYTES - 128)});
    let before_bytes = encoded(before.as_object().unwrap()).unwrap();
    assert!(before_bytes.len() <= MAX_BYTES);
    f.write(&f.state("bounded-audit"), &before_bytes);
    let audit = ResetAudit::open(&f.logs, b).unwrap();
    store.reset(None, &[], &audit, b).unwrap();
    let log = fs::read_to_string(f.logs.join("strike-resets.log")).unwrap();
    let lines: Vec<&str> = log.lines().collect();
    assert_eq!(lines.len(), 2);
    assert!(
        lines[0].len() > MAX_BYTES,
        "metadata must fit alongside the full state budget"
    );
    assert!(lines[0].len() + 1 <= MAX_AUDIT_RECORD_BYTES);
    let intent: Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(intent["beforeState"], before);
    assert_eq!(
        intent["beforeState"]["other"].as_str().unwrap().len(),
        MAX_BYTES - 128
    );
    assert_eq!(intent["before"], digest(&before_bytes));
    assert_eq!(intent["mode"], "all");
    assert_eq!(intent["guard"], Value::Null);
    assert_eq!(intent["dryRun"], false);
    let empty_logs = f.root.join("empty-logs");
    fs::create_dir(&empty_logs).unwrap();
    let empty_audit = ResetAudit::open(&empty_logs, b).unwrap();
    let oversized = json!({"beforeState":"x".repeat(MAX_AUDIT_RECORD_BYTES)});
    let mut visible = false;
    assert_eq!(
        empty_audit
            .append(&oversized, b, &mut visible)
            .unwrap_err()
            .kind,
        ErrorKind::Corrupt
    );
    assert!(!visible);
    assert!(!empty_logs.join("strike-resets.log").exists());
}

/// Cross-language filesystem proof only: this selector exists solely in the
/// libtest binary. The JS harness owns stdin, bounded lifetime and process
/// cleanup; this local clock does not prove production Native IPC deadlines.
#[test]
#[ignore = "external TypeScript fixture bridge; requires fixed stdin and inherited FD3"]
fn increment_scope_guard_worker() {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct FixtureRequest {
        schema: String,
        guard: String,
        session_id: String,
        checkout: PathBuf,
    }
    let clock = MonotonicDeadline::capture(Duration::from_secs(5)).unwrap();
    let never = || false;
    let b = budget(&clock, &never);
    // Validate the inherited result descriptor before effects. Never open a
    // caller-selected result path or send receipts to test-framework stdout.
    let result_flags = unsafe { libc::fcntl(3, libc::F_GETFL) };
    assert!(result_flags >= 0, "fixture bridge requires inherited FD3");
    assert_ne!(result_flags & libc::O_ACCMODE, libc::O_RDONLY);
    let result_kind = metadata(3).unwrap().st_mode & libc::S_IFMT;
    assert!(
        matches!(result_kind, libc::S_IFIFO | libc::S_IFSOCK),
        "fixture FD3 must be a pipe or socket"
    );
    // SAFETY: fcntl/fstat established a live inherited writable descriptor;
    // this test owns it exactly once and closes it after its single receipt.
    let mut result = unsafe { File::from_raw_fd(3) };
    let mut input = Vec::new();
    std::io::stdin()
        .lock()
        .take(4097)
        .read_to_end(&mut input)
        .unwrap();
    assert!(input.len() <= 4096, "fixture request exceeds 4KiB");
    let request: FixtureRequest =
        serde_json::from_value(Value::Object(object(&input).unwrap())).unwrap();
    assert_eq!(request.schema, "caws.guard-strikes.increment.v1");
    assert_eq!(request.guard, "scope_guard");
    assert_eq!(request.session_id, "file-tools-fixture");
    let home = PathBuf::from(std::env::var_os("HOME").expect("fixture HOME is required"));
    let root = home.parent().expect("fixture HOME needs a parent");
    let temporary = fs::canonicalize(std::env::temp_dir()).unwrap();
    assert_eq!(
        root.parent(),
        Some(temporary.as_path()),
        "fixture root must be a direct physical temp child"
    );
    assert!(
        root.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("caws-file-tools-"))
    );
    assert_eq!(home, root.join("user"));
    assert_eq!(fs::canonicalize(root).unwrap(), root);
    assert_eq!(fs::canonicalize(&home).unwrap(), home);
    assert_eq!(
        fs::canonicalize(&request.checkout).unwrap(),
        request.checkout
    );
    assert!(
        request.checkout.starts_with(root.join("repo")),
        "checkout escaped the private fixture repo"
    );
    let root_directory = Directory::open(root, b).unwrap();
    let home_directory = Directory::open(&home, b).unwrap();
    assert_eq!(
        metadata(root_directory.fd()).unwrap().st_mode & 0o777,
        0o700
    );
    assert_eq!(
        metadata(home_directory.fd()).unwrap().st_mode & 0o777,
        0o700
    );
    let checkout_directory = Directory::open(&request.checkout, b).unwrap();
    root_directory.verify(b).unwrap();
    home_directory.verify(b).unwrap();
    checkout_directory.verify(b).unwrap();
    let identity = StrikeIdentity::resolve(&request.session_id).unwrap();
    let legacy = request
        .checkout
        .join(".codex")
        .join("logs")
        .join(format!("guard-strikes-{}.json", identity.sanitized()));
    let store = StrikeStore::open(&home.join(".caws"), identity, b).unwrap();
    let committed = store.increment_scope_guard(&[legacy], b).unwrap();
    let mut receipt = serde_json::to_vec(&json!({
        "schema":"caws.guard-strikes.committed.v1",
        "count":committed.count,
        "stateSha256":committed.state_sha256,
    }))
    .unwrap();
    receipt.push(b'\n');
    assert!(receipt.len() <= 4096);
    result.write_all(&receipt).unwrap();
    result.flush().unwrap();
    drop(result);
}
