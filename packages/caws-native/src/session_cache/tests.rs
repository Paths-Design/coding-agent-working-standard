use super::*;
use std::{
    fs,
    os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, symlink},
    },
    path::PathBuf,
    time::Duration,
};

const NOW: &str = "2026-10-21T04:05:06Z";
const OLD: &str = "2001-02-03T04:05:06Z";

#[test]
fn prefix_preparation_does_not_create_directories_before_a_decoder_decline() {
    let f = Fixture::new();
    let prepared = match prepare_prefix(
        &f.input(Some("s"), Some("SessionEnd")),
        expires(),
        &mut || Ok(()),
    )
    .unwrap()
    {
        PrefixPreparation::Ready(value) => value,
        _ => panic!("unexpected decline"),
    };
    assert!(matches!(prepared.existing(), ExistingEnvelope::Missing));
    assert!(prepared.sessions().is_none());
    assert!(!f.root.join(".caws/sessions").exists());
}

#[test]
fn prefix_keeps_pid_directory_capability_when_session_open_fails() {
    let f = Fixture::new();
    fs::create_dir_all(f.root.join(".caws/sessions")).unwrap();
    fs::write(f.session("s"), b"not a directory").unwrap();
    let mut prepared = match prepare_prefix(
        &f.input(Some("s"), Some("SessionEnd")),
        expires(),
        &mut || Ok(()),
    )
    .unwrap()
    {
        PrefixPreparation::Ready(value) => value,
        _ => panic!("unexpected decline"),
    };
    assert!(prepared.sessions().is_some());
    let failure = prepared.take_preflight_failure().unwrap();
    assert_eq!(failure.stage, Stage::Session);
    assert!(!failure.envelope_published);
    assert_eq!(fs::read(f.session("s")).unwrap(), b"not a directory");
    assert!(!f.pointer().exists());
}

#[test]
fn admitted_prefix_preserves_creation_and_selected_claude_platform() {
    let f = Fixture::new();
    let mut prepared = match prepare_prefix(
        &f.input(Some("s"), Some("SessionEnd")),
        expires(),
        &mut || Ok(()),
    )
    .unwrap()
    {
        PrefixPreparation::Ready(value) => value,
        _ => panic!("unexpected decline"),
    };
    commit_prefix(
        &mut prepared,
        "claude-code",
        Some(OLD.encode_utf16().collect()),
        expires(),
        &mut || Ok(()),
    )
    .unwrap();
    let envelope = value(&f.envelope("s"));
    assert_eq!(envelope["created_at"], OLD);
    assert_eq!(envelope["hook_event"], "SessionEnd");
    assert_eq!(envelope["platform"], "claude-code");
    assert_eq!(value(&f.pointer())["session_id"], "s");
}
struct Fixture {
    base: PathBuf,
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!(
            "caws-session-cache-draft-{}-{}",
            std::process::id(),
            TEMPORARY.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&base).unwrap();
        let base = fs::canonicalize(base).unwrap();
        let root = base.join("repo");
        fs::create_dir_all(root.join(".caws")).unwrap();
        Self { base, root }
    }
    fn session(&self, sid: &str) -> PathBuf {
        self.root.join(".caws/sessions").join(sid)
    }
    fn envelope(&self, sid: &str) -> PathBuf {
        self.session(sid).join(ENVELOPE.to_str().unwrap())
    }
    fn pointer(&self) -> PathBuf {
        self.root
            .join(".caws/sessions")
            .join(POINTER.to_str().unwrap())
    }
    fn input<'a>(&'a self, sid: Option<&'a str>, event: Option<&'a str>) -> CaptureInput<'a> {
        CaptureInput {
            canonical_root: &self.root,
            supplied_session_id: sid,
            supplied_hook_event: event,
        }
    }
    fn seed(&self, sid: &str, bytes: &[u8]) {
        fs::create_dir_all(self.session(sid)).unwrap();
        fs::write(self.envelope(sid), bytes).unwrap();
    }
    fn run(&self, sid: Option<&str>) -> Result<CaptureOutcome, CaptureFailure> {
        capture_with(
            &self.input(sid, Some("PreToolUse")),
            expires(),
            || Ok(NOW.into()),
            &mut NativePort,
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.base).unwrap();
    }
}
fn expires() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
fn value(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}
fn no_temporaries(path: &Path) {
    for entry in fs::read_dir(path).unwrap() {
        let entry = entry.unwrap();
        assert!(
            !entry.file_name().as_bytes().starts_with(b"tmp-"),
            "temporary remains: {:?}",
            entry.path()
        );
    }
}
struct TestPort<F: FnMut(Point) -> io::Result<()>> {
    point: F,
    max_write: usize,
    bytes_written: usize,
    fail_after: usize,
    interrupted: bool,
}
impl<F: FnMut(Point) -> io::Result<()>> Port for TestPort<F> {
    fn point(&mut self, point: Point) -> io::Result<()> {
        (self.point)(point)
    }
    fn write(&mut self, file: &mut File, bytes: &[u8]) -> io::Result<usize> {
        if !self.interrupted {
            self.interrupted = true;
            return Err(io::ErrorKind::Interrupted.into());
        }
        if self.bytes_written >= self.fail_after {
            return Ok(0);
        }
        let count = file.write(
            &bytes[..bytes
                .len()
                .min(self.max_write)
                .min(self.fail_after - self.bytes_written)],
        )?;
        self.bytes_written += count;
        Ok(count)
    }
}
fn port<F: FnMut(Point) -> io::Result<()>>(point: F) -> TestPort<F> {
    TestPort {
        point,
        max_write: usize::MAX,
        bytes_written: 0,
        fail_after: usize::MAX,
        interrupted: true,
    }
}

#[test]
fn raw_missing_and_unsafe_sid_never_create_sessions_or_use_fallback_identity() {
    let f = Fixture::new();
    for sid in [None, Some(""), Some("unknown")] {
        assert_eq!(
            f.run(sid).unwrap(),
            CaptureOutcome::Skipped(SkipReason::MissingSession)
        );
    }
    for sid in [
        ".",
        "..",
        "../foreign",
        "a/b",
        "a\\b",
        "a\0b",
        "élan",
        "x\n",
    ] {
        assert_eq!(
            f.run(Some(sid)).unwrap(),
            CaptureOutcome::Skipped(SkipReason::UnsafeSession)
        );
    }
    assert!(!f.root.join(".caws/sessions").exists());
}

#[test]
fn fresh_capture_has_exact_fields_raw_event_and_permitted_at_sid() {
    let f = Fixture::new();
    let sid = "agent@local:1-_.";
    assert_eq!(f.run(Some(sid)).unwrap(), CaptureOutcome::Captured);
    assert_eq!(
        value(&f.envelope(sid)),
        json!({"session_id":sid, "repo_root":f.root.to_str().unwrap(),
        "created_at":NOW,"last_seen_at":NOW,"hook_event":"PreToolUse","platform":"codex"})
    );
    assert_eq!(
        value(&f.pointer()),
        json!({"session_id":sid,"repo_root":f.root.to_str().unwrap(),"last_seen_at":NOW})
    );
    assert_eq!(fs::metadata(f.session(sid)).unwrap().mode() & 0o777, 0o700);
    assert_eq!(fs::metadata(f.envelope(sid)).unwrap().mode() & 0o777, 0o600);
    for event in [None, Some(""), Some("raw-event-even-if-different")] {
        assert_eq!(
            capture_with(
                &f.input(Some(sid), event),
                expires(),
                || Ok(NOW.into()),
                &mut NativePort
            )
            .unwrap(),
            CaptureOutcome::Captured
        );
        assert_eq!(
            value(&f.envelope(sid))["hook_event"],
            event.filter(|s| !s.is_empty()).unwrap_or("unknown")
        );
    }
}

#[test]
fn created_is_preserved_only_for_same_sid_nonempty_string_independent_of_other_metadata() {
    let f = Fixture::new();
    for (old, expected) in [
        (
            json!({"session_id":"s","created_at":OLD,"repo_root":"wrong","last_seen_at":null,"platform":false}),
            OLD,
        ),
        (
            json!({"session_id":"s","created_at":"not-a-date"}),
            "not-a-date",
        ),
        (json!({"session_id":"different","created_at":OLD}), NOW),
        (json!({"session_id":"s","created_at":""}), NOW),
        (json!({"session_id":"s","created_at":42}), NOW),
        (json!({"created_at":OLD}), NOW),
        (json!([]), NOW),
        (json!(null), NOW),
    ] {
        f.seed("s", &serde_json::to_vec(&old).unwrap());
        assert_eq!(f.run(Some("s")).unwrap(), CaptureOutcome::Captured);
        assert_eq!(value(&f.envelope("s"))["created_at"], expected);
        assert_eq!(value(&f.envelope("s"))["last_seen_at"], NOW);
    }
    f.seed(
        "s",
        br#"{"session_id":"other","session_id":"s","created_at":"first","created_at":"last"}"#,
    );
    f.run(Some("s")).unwrap();
    assert_eq!(value(&f.envelope("s"))["created_at"], "last");
}

#[test]
fn unsupported_old_json_preserves_both_files_instead_of_resetting_created() {
    let f = Fixture::new();
    for old in [
        br#"{"session_id":"s","created_at":"kept","unused":NaN}"#.as_slice(),
        br#"{"session_id":"s","created_at":"kept","unused":Infinity}"#,
        br#"{"session_id":"s","created_at":"\ud800"}"#,
        br#"{"session_id":"s","created_at":"kept", broken"#,
        br#"{"session_id":"s","created_at":"kept","unused":1e9999}"#,
    ] {
        f.seed("s", old);
        fs::write(f.pointer(), b"old pointer bytes").unwrap();
        let failed = f.run(Some("s")).unwrap_err();
        assert_eq!(failed.stage, Stage::Decision);
        assert!(!failed.envelope_published);
        assert!(matches!(failed.kind, FailureKind::DecodeDiagnostic(_)));
        assert_eq!(fs::read(f.envelope("s")).unwrap(), old);
        assert_eq!(fs::read(f.pointer()).unwrap(), b"old pointer bytes");
        no_temporaries(&f.session("s"));
        no_temporaries(&f.root.join(".caws/sessions"));
    }
}

#[test]
fn publication_is_envelope_before_pointer_and_pointer_failure_reports_partial_pair() {
    let f = Fixture::new();
    f.seed("s", br#"{"session_id":"s","created_at":"original"}"#);
    fs::write(f.pointer(), b"pointer before").unwrap();
    let mut observed_envelope = false;
    let mut observed_pointer = false;
    let mut p = port(|point| {
        match point {
            Point::EnvelopeStaged => {
                assert_eq!(value(&f.envelope("s"))["created_at"], "original");
                assert_eq!(fs::read(f.pointer()).unwrap(), b"pointer before");
            }
            Point::EnvelopePublished => {
                observed_envelope = true;
                assert_eq!(value(&f.envelope("s"))["last_seen_at"], NOW);
                assert_eq!(fs::read(f.pointer()).unwrap(), b"pointer before");
            }
            Point::PointerStaged => {
                observed_pointer = true;
                return Err(io::Error::other("injected pointer failure"));
            }
            _ => {}
        }
        Ok(())
    });
    let failure = capture_with(
        &f.input(Some("s"), None),
        expires(),
        || Ok(NOW.into()),
        &mut p,
    )
    .unwrap_err();
    assert_eq!(failure.stage, Stage::Pointer);
    assert!(failure.envelope_published);
    assert!(observed_envelope && observed_pointer);
    assert_eq!(value(&f.envelope("s"))["created_at"], "original");
    assert_eq!(fs::read(f.pointer()).unwrap(), b"pointer before");
    no_temporaries(&f.session("s"));
    no_temporaries(&f.root.join(".caws/sessions"));
}

#[test]
fn short_writes_and_interruption_complete_json_but_zero_write_cleans_temporary() {
    let f = Fixture::new();
    let mut p = port(|_| Ok(()));
    p.max_write = 3;
    p.interrupted = false;
    assert_eq!(
        capture_with(
            &f.input(Some("s"), None),
            expires(),
            || Ok(NOW.into()),
            &mut p
        )
        .unwrap(),
        CaptureOutcome::Captured
    );
    assert_eq!(value(&f.envelope("s"))["created_at"], NOW);
    assert_eq!(value(&f.pointer())["session_id"], "s");
    let old = fs::read(f.envelope("s")).unwrap();
    let pointer = fs::read(f.pointer()).unwrap();
    let mut p = port(|_| Ok(()));
    p.max_write = 3;
    p.fail_after = 7;
    let failure = capture_with(
        &f.input(Some("s"), None),
        expires(),
        || Ok(NOW.into()),
        &mut p,
    )
    .unwrap_err();
    assert_eq!(failure.stage, Stage::Envelope);
    assert!(!failure.envelope_published);
    assert_eq!(fs::read(f.envelope("s")).unwrap(), old);
    assert_eq!(fs::read(f.pointer()).unwrap(), pointer);
    no_temporaries(&f.session("s"));
}

#[test]
fn missing_governance_never_creates_it_and_symlinked_directories_do_not_redirect() {
    for component in [".caws", ".caws/sessions", ".caws/sessions/s"] {
        let f = Fixture::new();
        let foreign = f.base.join("foreign");
        fs::create_dir(&foreign).unwrap();
        let target = f.root.join(component);
        if target.exists() {
            fs::remove_dir_all(&target).unwrap();
        }
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        symlink(&foreign, &target).unwrap();
        let failed = f.run(Some("s")).unwrap_err();
        assert!(!failed.envelope_published);
        assert_eq!(fs::read_dir(&foreign).unwrap().count(), 0);
    }
    let f = Fixture::new();
    fs::remove_dir(f.root.join(".caws")).unwrap();
    assert_eq!(f.run(Some("s")).unwrap_err().stage, Stage::Governance);
    assert!(!f.root.join(".caws").exists());
}

#[test]
fn opened_session_directory_remains_pinned_across_name_to_symlink_swap() {
    let f = Fixture::new();
    let foreign = f.base.join("foreign");
    fs::create_dir(&foreign).unwrap();
    let moved = f.root.join(".caws/sessions/pinned-old");
    let mut p = port(|point| {
        if matches!(point, Point::SessionOpened) {
            fs::rename(f.session("s"), &moved)?;
            symlink(&foreign, f.session("s"))?;
        }
        Ok(())
    });
    capture_with(
        &f.input(Some("s"), None),
        expires(),
        || Ok(NOW.into()),
        &mut p,
    )
    .unwrap();
    assert_eq!(fs::read_dir(&foreign).unwrap().count(), 0);
    assert_eq!(
        value(&moved.join(ENVELOPE.to_str().unwrap()))["session_id"],
        "s"
    );
    assert_eq!(value(&f.pointer())["session_id"], "s");
}

#[test]
fn envelope_symlink_is_refused_but_pointer_symlink_is_locally_replaced() {
    let f = Fixture::new();
    let foreign = f.base.join("foreign-file");
    fs::write(&foreign, b"untouched").unwrap();
    fs::create_dir_all(f.session("s")).unwrap();
    symlink(&foreign, f.envelope("s")).unwrap();
    let failed = f.run(Some("s")).unwrap_err();
    assert_eq!(failed.stage, Stage::ExistingEnvelope);
    assert!(!failed.envelope_published);
    assert_eq!(fs::read(&foreign).unwrap(), b"untouched");
    assert!(!f.pointer().exists());
    fs::remove_file(f.envelope("s")).unwrap();
    symlink(&foreign, f.pointer()).unwrap();
    f.run(Some("s")).unwrap();
    assert_eq!(fs::read(&foreign).unwrap(), b"untouched");
    assert!(
        !fs::symlink_metadata(f.pointer())
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(value(&f.pointer())["session_id"], "s");
}

#[test]
fn old_hardlink_is_read_then_locally_replaced_without_altering_foreign_inode() {
    let f = Fixture::new();
    let foreign = f.base.join("foreign-file");
    let bytes = br#"{"session_id":"s","created_at":"foreign-original"}"#;
    fs::write(&foreign, bytes).unwrap();
    fs::create_dir_all(f.session("s")).unwrap();
    fs::hard_link(&foreign, f.envelope("s")).unwrap();
    let before = fs::metadata(&foreign).unwrap();
    assert_eq!(before.nlink(), 2);
    f.run(Some("s")).unwrap();
    assert_eq!(fs::read(&foreign).unwrap(), bytes);
    assert_eq!(fs::metadata(&foreign).unwrap().ino(), before.ino());
    assert_ne!(fs::metadata(f.envelope("s")).unwrap().ino(), before.ino());
    assert_eq!(value(&f.envelope("s"))["created_at"], "foreign-original");
    assert_eq!(fs::metadata(&foreign).unwrap().nlink(), 1);
}

#[test]
fn actual_pointer_rename_failure_leaves_published_envelope_and_cleans_temporary() {
    let f = Fixture::new();
    fs::create_dir_all(f.pointer()).unwrap();
    fs::write(f.pointer().join("retained"), b"old directory content").unwrap();
    let failure = f.run(Some("s")).unwrap_err();
    assert_eq!(failure.stage, Stage::Pointer);
    assert!(failure.envelope_published);
    assert!(matches!(failure.kind, FailureKind::Io(_)));
    assert_eq!(value(&f.envelope("s"))["session_id"], "s");
    assert_eq!(
        fs::read(f.pointer().join("retained")).unwrap(),
        b"old directory content"
    );
    no_temporaries(&f.root.join(".caws/sessions"));
}

#[test]
fn final_envelope_name_swapped_after_read_does_not_mutate_symlink_target() {
    let f = Fixture::new();
    let foreign = f.base.join("foreign-file");
    fs::write(&foreign, b"untouched").unwrap();
    f.seed("s", br#"{"session_id":"s","created_at":"before-swap"}"#);
    let mut p = port(|point| {
        if matches!(point, Point::EnvelopeStaged) {
            fs::remove_file(f.envelope("s"))?;
            symlink(&foreign, f.envelope("s"))?;
        }
        Ok(())
    });
    capture_with(
        &f.input(Some("s"), None),
        expires(),
        || Ok(NOW.into()),
        &mut p,
    )
    .unwrap();
    assert_eq!(fs::read(&foreign).unwrap(), b"untouched");
    assert_eq!(value(&f.envelope("s"))["created_at"], "before-swap");
    assert!(
        !fs::symlink_metadata(f.envelope("s"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[test]
fn native_clock_is_whole_second_utc_and_expiry_cannot_publish() {
    let current = timestamp().unwrap();
    assert_eq!(current.len(), 20);
    assert!(current.ends_with('Z'));
    assert_eq!(&current[10..11], "T");
    assert_eq!(&current[16..17], ":");
    let f = Fixture::new();
    let failed = capture(&f.input(Some("s"), None), Instant::now()).unwrap_err();
    assert!(matches!(failed.kind, FailureKind::Deadline));
    assert!(!failed.envelope_published);
    assert!(!f.root.join(".caws/sessions").exists());
}

fn cancellation_preserves_publication_boundary(target: Option<Point>) {
    let f = Fixture::new();
    f.seed("s", b"old envelope");
    fs::write(f.pointer(), b"old pointer").unwrap();
    let cancelled = std::cell::Cell::new(false);
    let mut p = port(|point| {
        if target == Some(point) {
            cancelled.set(true);
        }
        Ok(())
    });
    let mut calls = 0;
    let failure = capture_operation_decision_checked(
        &f.input(Some("s"), Some("PreToolUse")),
        expires(),
        || Ok(NOW.into()),
        &mut p,
        &mut || {
            if cancelled.get() {
                Err("exact cancellation cause".into())
            } else {
                Ok(())
            }
        },
        |old| {
            calls += 1;
            assert_eq!(old, ExistingEnvelope::Bytes(b"old envelope"));
            if target.is_none() {
                cancelled.set(true);
            }
            Ok(CaptureDecision::Capture(None))
        },
    )
    .unwrap_err();
    assert_eq!(calls, 1);
    assert!(
        matches!(failure.kind, FailureKind::Cancelled(ref cause) if cause == "exact cancellation cause")
    );
    let published = target == Some(Point::EnvelopePublished);
    assert_eq!(failure.envelope_published, published);
    if published {
        assert_eq!(value(&f.envelope("s"))["last_seen_at"], NOW);
    } else {
        assert_eq!(fs::read(f.envelope("s")).unwrap(), b"old envelope");
    }
    assert_eq!(fs::read(f.pointer()).unwrap(), b"old pointer");
    no_temporaries(&f.session("s"));
    no_temporaries(&f.root.join(".caws/sessions"));
}

#[test]
fn cancellation_after_decision_prevents_both_publications() {
    cancellation_preserves_publication_boundary(None);
}

#[test]
fn cancellation_before_envelope_rename_removes_staged_temporary() {
    cancellation_preserves_publication_boundary(Some(Point::EnvelopeStaged));
}

#[test]
fn cancellation_after_envelope_publication_preserves_old_pointer() {
    cancellation_preserves_publication_boundary(Some(Point::EnvelopePublished));
}

#[test]
fn cancellation_at_entry_does_not_create_session_directories_or_exchange() {
    let f = Fixture::new();
    let failed = capture_with_decision_checked(
        &f.input(Some("s"), None),
        expires(),
        || Err("caller exited".into()),
        |_| panic!("cancelled operation reached decision"),
    )
    .unwrap_err();
    assert!(matches!(failed.kind, FailureKind::Cancelled(ref cause) if cause == "caller exited"));
    assert!(!failed.envelope_published);
    assert!(!f.root.join(".caws/sessions").exists());
}

#[test]
fn identical_sid_in_two_physical_roots_keeps_envelope_and_pointer_separate() {
    let a = Fixture::new();
    let b = Fixture::new();
    a.seed("same", br#"{"session_id":"same","created_at":"root-a"}"#);
    b.seed("same", br#"{"session_id":"same","created_at":"root-b"}"#);
    a.run(Some("same")).unwrap();
    b.run(Some("same")).unwrap();
    assert_eq!(value(&a.envelope("same"))["created_at"], "root-a");
    assert_eq!(value(&b.envelope("same"))["created_at"], "root-b");
    assert_eq!(value(&a.pointer())["repo_root"], a.root.to_str().unwrap());
    assert_eq!(value(&b.pointer())["repo_root"], b.root.to_str().unwrap());
    assert_ne!(a.root, b.root);
}

#[test]
fn unicode_created_is_preserved_and_unused_large_integer_reports_unsupported() {
    let f = Fixture::new();
    let created = "λ\u{1f642}\nexact";
    f.seed(
        "s",
        &serde_json::to_vec(&json!({"session_id":"s","created_at":created})).unwrap(),
    );
    f.run(Some("s")).unwrap();
    assert_eq!(value(&f.envelope("s"))["created_at"], created);
    let old = format!(
        "{{\"session_id\":\"s\",\"created_at\":\"kept\",\"unused\":{}}}",
        "1".repeat(5000)
    );
    f.seed("s", old.as_bytes());
    let pointer = fs::read(f.pointer()).unwrap();
    let failure = f.run(Some("s")).unwrap_err();
    assert!(matches!(failure.kind, FailureKind::DecodeDiagnostic(_)));
    assert!(!failure.envelope_published);
    assert_eq!(fs::read(f.envelope("s")).unwrap(), old.as_bytes());
    assert_eq!(fs::read(f.pointer()).unwrap(), pointer);
}

#[test]
fn callback_receives_actual_missing_or_exact_uninterpreted_old_bytes() {
    let f = Fixture::new();
    let mut calls = 0;
    let outcome = capture_operation(
        &f.input(Some("s"), None),
        expires(),
        || Ok(NOW.into()),
        &mut NativePort,
        |old| {
            calls += 1;
            assert_eq!(old, ExistingEnvelope::Missing);
            Ok(None)
        },
    )
    .unwrap();
    assert_eq!(outcome, CaptureOutcome::Captured);
    assert_eq!(calls, 1);
    assert_eq!(value(&f.envelope("s"))["created_at"], NOW);
    for raw in [b"".as_slice(), b"\xff\x00not utf8 or JSON\r\n"] {
        f.seed("s", raw);
        let mut calls = 0;
        capture_operation(
            &f.input(Some("s"), None),
            expires(),
            || Ok(NOW.into()),
            &mut NativePort,
            |old| {
                calls += 1;
                assert_eq!(old, ExistingEnvelope::Bytes(raw));
                Ok(None)
            },
        )
        .unwrap();
        assert_eq!(calls, 1);
        assert_eq!(value(&f.envelope("s"))["created_at"], NOW);
    }
}

#[test]
fn public_callback_entry_uses_native_clock_and_does_not_decode_old_bytes() {
    let f = Fixture::new();
    f.seed("s", b"malformed old bytes");
    let outcome = capture_legacy_decision(&f.input(Some("s"), None), expires(), |old| {
        assert_eq!(old, ExistingEnvelope::Bytes(b"malformed old bytes"));
        Ok(None)
    })
    .unwrap();
    assert_eq!(outcome, CaptureOutcome::Captured);
    let envelope = value(&f.envelope("s"));
    assert_eq!(envelope["created_at"], envelope["last_seen_at"]);
    assert_eq!(envelope["created_at"].as_str().unwrap().len(), 20);
    assert!(envelope["created_at"].as_str().unwrap().ends_with('Z'));
    assert_eq!(
        value(&f.pointer())["last_seen_at"],
        envelope["last_seen_at"]
    );
}

#[test]
fn callback_creation_units_preserve_lone_surrogates_controls_and_quotes_as_data() {
    let f = Fixture::new();
    let raw = br#"{"session_id":"s","created_at":"\ud800","unused":NaN}"#;
    f.seed("s", raw);
    capture_operation(
        &f.input(Some("s"), None),
        expires(),
        || Ok(NOW.into()),
        &mut NativePort,
        |old| {
            assert_eq!(old, ExistingEnvelope::Bytes(raw));
            Ok(Some(vec![0xd800, 0x0000, 0xdc00, 0x0022, 0x005c]))
        },
    )
    .unwrap();
    let output = fs::read(f.envelope("s")).unwrap();
    let token = br#""created_at":"\ud800\u0000\udc00\u0022\u005c""#;
    assert!(output.windows(token.len()).any(|bytes| bytes == token));
    assert_eq!(output.iter().filter(|&&b| b == b'\n').count(), 1);
    assert_eq!(value(&f.pointer())["session_id"], "s");
    assert_eq!(fs::metadata(f.envelope("s")).unwrap().mode() & 0o777, 0o600);
}

#[test]
fn callback_decode_refusal_never_publishes_envelope_or_pointer() {
    for old in [None, Some(b"old malformed JSON".as_slice())] {
        let f = Fixture::new();
        fs::create_dir_all(f.session("s")).unwrap();
        if let Some(bytes) = old {
            f.seed("s", bytes);
        }
        fs::write(f.pointer(), b"pointer before").unwrap();
        let failed = capture_operation(
            &f.input(Some("s"), None),
            expires(),
            || Ok(NOW.into()),
            &mut NativePort,
            |observed| {
                assert_eq!(
                    observed,
                    old.map(ExistingEnvelope::Bytes)
                        .unwrap_or(ExistingEnvelope::Missing)
                );
                Err(DecodeDiagnostic("decoder unavailable".into()))
            },
        )
        .unwrap_err();
        assert_eq!(failed.stage, Stage::Decision);
        assert!(!failed.envelope_published);
        match failed.kind {
            FailureKind::DecodeDiagnostic(message) => assert_eq!(message, "decoder unavailable"),
            other => panic!("wrong failure kind: {other:?}"),
        }
        if let Some(bytes) = old {
            assert_eq!(fs::read(f.envelope("s")).unwrap(), bytes);
        } else {
            assert!(!f.envelope("s").exists());
        }
        assert_eq!(fs::read(f.pointer()).unwrap(), b"pointer before");
        no_temporaries(&f.session("s"));
        no_temporaries(&f.root.join(".caws/sessions"));
    }
}

#[test]
fn malformed_old_decision_or_empty_preserved_string_selects_native_default() {
    for decision in [None, Some(Vec::new())] {
        let f = Fixture::new();
        let malformed = b"{malformed";
        f.seed("s", malformed);
        capture_operation(
            &f.input(Some("s"), Some("raw")),
            expires(),
            || Ok(NOW.into()),
            &mut NativePort,
            |old| {
                assert_eq!(old, ExistingEnvelope::Bytes(malformed));
                Ok(decision)
            },
        )
        .unwrap();
        assert_eq!(value(&f.envelope("s"))["created_at"], NOW);
        assert_eq!(value(&f.envelope("s"))["last_seen_at"], NOW);
        assert_eq!(value(&f.envelope("s"))["hook_event"], "raw");
        assert_eq!(value(&f.pointer())["last_seen_at"], NOW);
    }
}

#[test]
fn callback_time_parent_and_session_rename_keep_native_capabilities_pinned() {
    for replaced in [".caws", ".caws/sessions", ".caws/sessions/s"] {
        let f = Fixture::new();
        f.seed("s", b"old exact bytes");
        let target = f.root.join(replaced);
        let pinned = target.with_file_name("pinned-old");
        let foreign = f.base.join("foreign");
        fs::create_dir(&foreign).unwrap();
        capture_operation(
            &f.input(Some("s"), None),
            expires(),
            || Ok(NOW.into()),
            &mut NativePort,
            |old| {
                assert_eq!(old, ExistingEnvelope::Bytes(b"old exact bytes"));
                fs::rename(&target, &pinned).unwrap();
                symlink(&foreign, &target).unwrap();
                Ok(Some("kept".encode_utf16().collect()))
            },
        )
        .unwrap();
        let (envelope, pointer) = match replaced {
            ".caws" => (
                pinned.join("sessions/s/.session-envelope.json"),
                pinned.join("sessions/.caller-session.json"),
            ),
            ".caws/sessions" => (
                pinned.join("s/.session-envelope.json"),
                pinned.join(".caller-session.json"),
            ),
            _ => (pinned.join(".session-envelope.json"), f.pointer()),
        };
        assert_eq!(value(&envelope)["created_at"], "kept");
        assert_eq!(value(&pointer)["session_id"], "s");
        assert_eq!(fs::read_dir(&foreign).unwrap().count(), 0);
    }
}

#[test]
fn native_read_failure_never_invokes_decoder_or_becomes_missing() {
    let f = Fixture::new();
    let foreign = f.base.join("foreign");
    fs::write(&foreign, b"foreign bytes").unwrap();
    fs::create_dir_all(f.session("s")).unwrap();
    symlink(&foreign, f.envelope("s")).unwrap();
    let mut called = false;
    let failed = capture_operation(
        &f.input(Some("s"), None),
        expires(),
        || Ok(NOW.into()),
        &mut NativePort,
        |_| {
            called = true;
            Ok(None)
        },
    )
    .unwrap_err();
    assert!(!called);
    assert_eq!(failed.stage, Stage::ExistingEnvelope);
    assert!(matches!(failed.kind, FailureKind::Io(_)));
    assert!(!failed.envelope_published);
    assert_eq!(fs::read(f.envelope("s")).unwrap(), b"foreign bytes");
    assert!(!f.pointer().exists());
    assert_eq!(fs::read(&foreign).unwrap(), b"foreign bytes");
}

#[test]
fn public_callback_never_runs_for_missing_raw_identity_even_with_populated_caches() {
    let f = Fixture::new();
    f.seed("old", br#"{"session_id":"old","created_at":"kept"}"#);
    fs::write(f.pointer(), b"old pointer bytes").unwrap();
    let before = fs::read(f.envelope("old")).unwrap();
    for sid in [None, Some(""), Some("unknown")] {
        let outcome = capture_legacy_decision(&f.input(sid, None), expires(), |_| {
            panic!("decoder cannot run without raw SID")
        })
        .unwrap();
        assert_eq!(outcome, CaptureOutcome::Skipped(SkipReason::MissingSession));
    }
    assert_eq!(fs::read(f.envelope("old")).unwrap(), before);
    assert_eq!(fs::read(f.pointer()).unwrap(), b"old pointer bytes");
    assert_eq!(
        fs::read_dir(f.root.join(".caws/sessions")).unwrap().count(),
        2
    );
}

#[test]
fn explicit_decline_leaves_existing_targets_and_no_temporary() {
    let f = Fixture::new();
    f.seed("s", b"old exact bytes");
    fs::write(f.pointer(), b"old pointer").unwrap();
    let outcome = capture_with_decision(&f.input(Some("s"), None), expires(), |old| {
        assert_eq!(old, ExistingEnvelope::Bytes(b"old exact bytes"));
        Ok(CaptureDecision::Decline)
    })
    .unwrap();
    assert_eq!(
        outcome,
        CaptureOutcome::Declined(DeclineReason::DecoderDeclined)
    );
    assert_eq!(fs::read(f.envelope("s")).unwrap(), b"old exact bytes");
    assert_eq!(fs::read(f.pointer()).unwrap(), b"old pointer");
    no_temporaries(&f.session("s"));
    no_temporaries(&f.root.join(".caws/sessions"));
}

#[test]
fn size_boundary_is_complete_bytes_and_oversize_declines_without_callback() {
    for size in [MAX_EXISTING_BYTES, MAX_EXISTING_BYTES + 1] {
        let f = Fixture::new();
        let bytes = vec![b'x'; size];
        f.seed("s", &bytes);
        fs::write(f.pointer(), b"old pointer").unwrap();
        let mut called = false;
        let outcome = capture_with_decision(&f.input(Some("s"), None), expires(), |old| {
            called = true;
            assert_eq!(old, ExistingEnvelope::Bytes(&bytes));
            Ok(CaptureDecision::Capture(Some(
                "kept".encode_utf16().collect(),
            )))
        })
        .unwrap();
        if size == MAX_EXISTING_BYTES {
            assert!(called);
            assert_eq!(outcome, CaptureOutcome::Captured);
            assert_eq!(value(&f.envelope("s"))["created_at"], "kept");
        } else {
            assert!(!called);
            assert_eq!(
                outcome,
                CaptureOutcome::Declined(DeclineReason::ExistingTooLarge)
            );
            assert_eq!(fs::read(f.envelope("s")).unwrap(), bytes);
            assert_eq!(fs::read(f.pointer()).unwrap(), b"old pointer");
        }
        no_temporaries(&f.session("s"));
    }
}

#[test]
fn nonregular_envelope_declines_and_never_waits_for_fifo_writer() {
    for fifo in [false, true] {
        let f = Fixture::new();
        fs::create_dir_all(f.session("s")).unwrap();
        if fifo {
            let path = CString::new(f.envelope("s").as_os_str().as_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        } else {
            fs::create_dir(f.envelope("s")).unwrap();
        }
        let mut called = false;
        let outcome = capture_with_decision(&f.input(Some("s"), None), expires(), |_| {
            called = true;
            Ok(CaptureDecision::Capture(None))
        })
        .unwrap();
        assert!(!called);
        assert_eq!(
            outcome,
            CaptureOutcome::Declined(DeclineReason::UnsupportedExistingFile)
        );
        assert!(!f.pointer().exists());
        assert!(!fs::metadata(f.envelope("s")).unwrap().is_file());
        no_temporaries(&f.session("s"));
    }
}
