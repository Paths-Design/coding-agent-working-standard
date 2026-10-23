use super::*;
use std::{
    collections::BTreeMap,
    fs,
    os::unix::{fs::symlink, process::CommandExt},
    path::PathBuf,
    process::Command,
    time::Duration,
};
fn expires() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
struct Fixture {
    base: PathBuf,
    root: PathBuf,
    sessions: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!(
            "caws-agent-pid-{}-{}",
            std::process::id(),
            QUARANTINE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir(&base).unwrap();
        let base = fs::canonicalize(base).unwrap();
        let root = base.join("repo");
        let sessions = root.join(".caws/sessions");
        fs::create_dir_all(&sessions).unwrap();
        Self {
            base,
            root,
            sessions,
        }
    }
    fn directory(&self) -> File {
        File::open(&self.sessions).unwrap()
    }
    fn candidate(&self, name: &str, bytes: &[u8]) -> Candidate {
        let name = CString::new(name).unwrap();
        fs::write(self.sessions.join(name.to_str().unwrap()), bytes).unwrap();
        let file = optional_file(&self.directory(), &name).unwrap().unwrap();
        let identity = identity(&file.metadata().unwrap());
        Candidate {
            name,
            file,
            identity,
            pid: Some(123),
            orphan: false,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.base).unwrap();
    }
}

#[test]
fn measured_unix2003_find_boundaries_are_not_generic_ceiling_or_strict_minutes() {
    assert!(!hard(8 * 86400 - 1));
    assert!(hard(8 * 86400));
    assert!(!grace(4 * 86400 - 1));
    assert!(grace(4 * 86400));
    assert!(grace(7 * 86400 - 1));
    assert!(!grace(7 * 86400));
    assert!(marker_recent(60 * 60));
    assert!(!marker_recent(60 * 60 + 1));
    assert!(!orphan_old(60 * 60));
    assert!(orphan_old(60 * 60 + 1));
    assert!(marker_recent(-86400));
    assert!(!hard(-86400));
    assert!(!grace(-86400));
    assert!(!orphan_old(-86400));
}
#[test]
fn finite_pid_json_preserves_creation_and_rejects_semantic_extensions() {
    let parsed = parse_record(
        br#"{"agent_pid":123,"created_at":"old\n\n","started_at":"1700000000","unused":"ascii"}"#,
    )
    .unwrap();
    assert_eq!(parsed.pid, 123);
    assert_eq!(parsed.created.as_deref(), Some("old"));
    for bytes in [
        br#"{"agent_pid":true}"#.as_slice(),
        br#"{"agent_pid":1.0}"#,
        br#"{"agent_pid":1e0}"#,
        br#"{"agent_pid":-1}"#,
        br#"{"agent_pid":0}"#,
        br#"{"agent_pid":2147483648}"#,
        br#"{"agent_pid":123,"agent_pid":124}"#,
        br#"{"agent_pid":123,"unused":false}"#,
        br#"{"agent_pid":123,"unused":[]}"#,
        br#"{"agent_pid":123,"created_at":"\ud800"}"#,
        br#"{"agent_pid":123,"created_at":"\u00e9"}"#,
        br#"{"agent_pid":123,"created_at":"\u0000"}"#,
        br#"{"agent_pid":123,"started_at":1700000000}"#,
    ] {
        assert!(
            matches!(parse_record(bytes), Err(PrepareError::Unsupported(_))),
            "{:?}",
            bytes
        );
    }
}

struct ScriptedObserver {
    calls: BTreeMap<u32, usize>,
    changed_at: Option<(u32, usize)>,
    chain: usize,
    matched: u32,
    comm_calls: usize,
}
impl Observer for ScriptedObserver {
    fn birth(&mut self, pid: u32) -> io::Result<Birth> {
        let count = self.calls.entry(pid).or_default();
        *count += 1;
        Ok(Birth {
            parent: if pid >= self.chain as u32 { 1 } else { pid + 1 },
            seconds: 123,
            micros: if self.changed_at == Some((pid, *count)) {
                1
            } else {
                0
            },
        })
    }
    fn comm(&mut self, pid: u32, _: Instant) -> io::Result<Vec<u8>> {
        self.comm_calls += 1;
        Ok(if pid == self.matched {
            b"/actual/argv0/codex".to_vec()
        } else {
            b"intermediate".to_vec()
        })
    }
}
fn observer(chain: usize, matched: u32) -> ScriptedObserver {
    ScriptedObserver {
        calls: BTreeMap::new(),
        changed_at: None,
        chain,
        matched,
        comm_calls: 0,
    }
}
#[test]
fn ancestry_is_original_bounded_bracketed_and_rechecks_the_previous_edge() {
    let mut stable = observer(20, 4);
    let captured =
        OriginalAncestry::capture_with("codex", 2, true, expires(), &mut || Ok(()), &mut stable)
            .unwrap();
    assert_eq!(captured.matched, Some(4));
    assert_eq!(captured.rows[0].pid, 2);
    let mut changed = observer(20, 4);
    changed.changed_at = Some((2, 2));
    let captured =
        OriginalAncestry::capture_with("codex", 2, true, expires(), &mut || Ok(()), &mut changed)
            .unwrap();
    assert!(captured.unavailable);
    assert!(captured.matched.is_none());
    assert!(captured.rows.is_empty());
    let mut edge = observer(20, 4);
    edge.changed_at = Some((2, 3));
    let captured =
        OriginalAncestry::capture_with("codex", 2, true, expires(), &mut || Ok(()), &mut edge)
            .unwrap();
    assert!(captured.unavailable);
    assert!(captured.matched.is_none());
    assert_eq!(edge.comm_calls, 1);
    let mut bounded = observer(100, 99);
    let captured =
        OriginalAncestry::capture_with("codex", 2, true, expires(), &mut || Ok(()), &mut bounded)
            .unwrap();
    assert_eq!(captured.rows.len(), MAX_HOPS);
    assert_eq!(bounded.comm_calls, MAX_HOPS);
    assert!(captured.matched.is_none());
}
#[test]
fn ancestry_cancellation_is_an_error_and_never_a_cache_miss() {
    let failure = OriginalAncestry::capture_with(
        "codex",
        2,
        true,
        expires(),
        &mut || Err("caller gone".into()),
        &mut observer(20, 4),
    );
    assert!(matches!(failure,Err(FailureKind::Cancelled(ref error))if error=="caller gone"));
}

#[cfg(target_os = "macos")]
#[test]
fn unsupported_pid_preflight_and_symlink_leave_every_target_untouched() {
    let fixture = Fixture::new();
    let original = OriginalAncestry::fixture_current("codex");
    let own = fixture
        .sessions
        .join(format!("agent-pid-{}.json", std::process::id()));
    fs::write(&own, b"{malformed").unwrap();
    assert!(matches!(
        prepare(
            Some(&fixture.directory()),
            &original,
            expires(),
            &mut || Ok(())
        ),
        Err(PrepareError::Unsupported(_))
    ));
    assert_eq!(fs::read(&own).unwrap(), b"{malformed");
    assert!(!fixture.sessions.join(MARKER.to_str().unwrap()).exists());
    fs::remove_file(&own).unwrap();
    let outside = fixture.base.join("outside");
    fs::write(&outside, b"sentinel").unwrap();
    symlink(&outside, &own).unwrap();
    assert!(matches!(
        prepare(
            Some(&fixture.directory()),
            &original,
            expires(),
            &mut || Ok(())
        ),
        Err(PrepareError::Failure(FailureKind::Io(_)))
    ));
    assert_eq!(fs::read(outside).unwrap(), b"sentinel");
    assert!(fs::symlink_metadata(own).unwrap().is_symlink());
}
#[cfg(target_os = "macos")]
#[test]
fn validated_moved_instance_is_removed_but_replaced_instance_is_restored() {
    let fixture = Fixture::new();
    let candidate = fixture.candidate("agent-pid-1.json", b"original");
    remove_candidate(&fixture.directory(), &candidate, &mut NativeReap).unwrap();
    assert!(!fixture.sessions.join("agent-pid-1.json").exists());
    let candidate = fixture.candidate("agent-pid-2.json", b"original");
    struct Replace<'a>(&'a Fixture);
    impl ReapPort for Replace<'_> {
        fn before_move(&mut self, name: &CStr) -> io::Result<()> {
            fs::rename(
                self.0.sessions.join(name.to_str().unwrap()),
                self.0.sessions.join("saved"),
            )?;
            fs::write(self.0.sessions.join(name.to_str().unwrap()), b"replacement")
        }
    }
    let error =
        remove_candidate(&fixture.directory(), &candidate, &mut Replace(&fixture)).unwrap_err();
    assert!(error.to_string().contains("restored"));
    assert_eq!(
        fs::read(fixture.sessions.join("agent-pid-2.json")).unwrap(),
        b"replacement"
    );
    assert_eq!(
        fs::read(fixture.sessions.join("saved")).unwrap(),
        b"original"
    );
}
#[cfg(target_os = "macos")]
#[test]
fn mismatched_reap_entry_is_retained_if_nooverwrite_restore_loses_its_slot() {
    let fixture = Fixture::new();
    let candidate = fixture.candidate("agent-pid-1.json", b"original");
    struct Replace<'a>(&'a Fixture);
    impl ReapPort for Replace<'_> {
        fn before_move(&mut self, name: &CStr) -> io::Result<()> {
            fs::rename(
                self.0.sessions.join(name.to_str().unwrap()),
                self.0.sessions.join("saved"),
            )?;
            fs::write(self.0.sessions.join(name.to_str().unwrap()), b"replacement")
        }
        fn after_move(&mut self, name: &CStr) -> io::Result<()> {
            fs::write(self.0.sessions.join(name.to_str().unwrap()), b"newer")
        }
    }
    let error =
        remove_candidate(&fixture.directory(), &candidate, &mut Replace(&fixture)).unwrap_err();
    assert!(error.to_string().contains("retained"));
    assert_eq!(
        fs::read(fixture.sessions.join("agent-pid-1.json")).unwrap(),
        b"newer"
    );
    let quarantines: Vec<_> = fs::read_dir(&fixture.sessions)
        .unwrap()
        .map(Result::unwrap)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".caws-agent-pid-reap.")
        })
        .collect();
    assert_eq!(quarantines.len(), 1);
    assert_eq!(
        fs::read(quarantines[0].path().join("entry")).unwrap(),
        b"replacement"
    );
}

#[cfg(target_os = "macos")]
fn set_age(file: &std::path::Path, age: i64) {
    let seconds = now_seconds().unwrap() - age;
    let times = [libc::timespec {
        tv_sec: seconds,
        tv_nsec: 0,
    }; 2];
    let file = File::open(file).unwrap();
    assert_eq!(
        unsafe { libc::futimens(file.as_raw_fd(), times.as_ptr()) },
        0
    );
}
#[cfg(target_os = "macos")]
#[test]
fn actual_original_frontend_refresh_and_reap() {
    const CHILD: &str = "CAWS_AGENT_PID_NATIVE_TEST_ROOT";
    if let Some(root) = std::env::var_os(CHILD) {
        let root = PathBuf::from(root);
        let sessions = root.join(".caws/sessions");
        fs::create_dir_all(&sessions).unwrap();
        let original = OriginalAncestry::capture("codex", expires(), || Ok(())).unwrap();
        assert!(original.supports("codex"));
        assert_eq!(original.rows[0].pid, std::process::id());
        assert_eq!(original.matched, Some(std::process::id()));
        let pid = std::process::id();
        let own = sessions.join(format!("agent-pid-{pid}.json"));
        fs::write(
            &own,
            format!(r#"{{"agent_pid":{pid},"created_at":"preserved\n\n","started_at":"1"}}"#),
        )
        .unwrap();
        for (name, agent_pid, age) in [
            ("hard-live", pid, 9 * 86400),
            ("grace-live", pid, 5 * 86400),
            ("grace-dead", i32::MAX as u32, 5 * 86400),
            ("gap-dead", i32::MAX as u32, 7 * 86400 + 3600),
        ] {
            let file = sessions.join(format!("agent-pid-{name}.json"));
            fs::write(&file, format!(r#"{{"agent_pid":{agent_pid}}}"#)).unwrap();
            set_age(&file, age);
        }
        assert_ne!(unsafe { libc::kill(i32::MAX, 0) }, 0);
        for (name, age) in [
            (".agent-pid-old.tmp.1", 61 * 60),
            (".agent-pid-young.tmp.1", 59 * 60),
        ] {
            let file = sessions.join(name);
            fs::write(&file, b"orphan").unwrap();
            set_age(&file, age);
        }
        let input = session_cache::CaptureInput {
            canonical_root: &root,
            supplied_session_id: Some("original-session"),
            supplied_hook_event: Some("SessionEnd"),
        };
        let mut prepared =
            match session_cache::prepare_prefix(&input, expires(), &mut || Ok(())).unwrap() {
                session_cache::PrefixPreparation::Ready(value) => value,
                _ => panic!("unexpected decline"),
            };
        let pid_stage = prepare(prepared.sessions(), &original, expires(), &mut || Ok(())).unwrap();
        session_cache::commit_prefix(&mut prepared, "codex", None, expires(), &mut || Ok(()))
            .unwrap();
        let outcome = pid_stage.commit(
            &mut prepared,
            "original-session",
            root.to_str().unwrap(),
            expires(),
            &mut || Ok(()),
        );
        assert!(outcome.failure.is_none(), "{:?}", outcome.failure);
        assert_eq!(outcome.agent_pid, AgentPidOutcome::Refreshed);
        assert_eq!(outcome.reap, ReapOutcome::Completed);
        let record: serde_json::Value = serde_json::from_slice(&fs::read(&own).unwrap()).unwrap();
        assert_eq!(record["created_at"], "preserved");
        assert_eq!(record["session_id"], "original-session");
        assert_eq!(record["surface"], "codex");
        assert_eq!(
            record["started_at"].as_str(),
            Some(original.rows[0].birth.seconds.to_string().as_str())
        );
        assert!(!sessions.join("agent-pid-hard-live.json").exists());
        assert!(sessions.join("agent-pid-grace-live.json").exists());
        assert!(!sessions.join("agent-pid-grace-dead.json").exists());
        assert!(sessions.join("agent-pid-gap-dead.json").exists());
        assert!(!sessions.join(".agent-pid-old.tmp.1").exists());
        assert!(sessions.join(".agent-pid-young.tmp.1").exists());
        let marker = identity(&fs::metadata(sessions.join(MARKER.to_str().unwrap())).unwrap());
        let again = prepare(prepared.sessions(), &original, expires(), &mut || Ok(()))
            .unwrap()
            .commit(
                &mut prepared,
                "original-session",
                root.to_str().unwrap(),
                expires(),
                &mut || Ok(()),
            );
        assert!(again.failure.is_none());
        assert_eq!(again.reap, ReapOutcome::RateLimited);
        assert_eq!(
            identity(&fs::metadata(sessions.join(MARKER.to_str().unwrap())).unwrap()),
            marker
        );
        fs::write(
            root.join("child-receipt.json"),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
    } else {
        let fixture = Fixture::new();
        let output = Command::new(std::env::current_exe().unwrap())
            .arg0("/controlled-native-frontend/codex")
            .args([
                "--exact",
                "agent_pid_cache::tests::actual_original_frontend_refresh_and_reap",
                "--nocapture",
            ])
            .env(CHILD, &fixture.root)
            .env("COMMAND_MODE", "unix2003")
            .env_remove("CAWS_AGENT_PROCESS_NAMES")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let record: serde_json::Value =
            serde_json::from_slice(&fs::read(fixture.root.join("child-receipt.json")).unwrap())
                .unwrap();
        assert_eq!(record["session_id"], "original-session");
        assert!(record["started_at"].is_string());
    }
}
