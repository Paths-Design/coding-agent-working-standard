use super::*;

#[test]
fn collector_panic_after_spawn_reaps_the_retained_original_child() {
    let mut pid = None;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut command = Command::new("/bin/sleep");
        command.arg("10"); // An omitted cleanup remains live beyond the absence check.
        execute_observed(command, Vec::new(), |original| {
            pid = Some(original);
            panic!("deliberate collector post-spawn failure");
        });
    }));
    let panic = result.expect_err("post-spawn observer did not unwind");
    assert_eq!(
        panic.downcast_ref::<&str>(),
        Some(&"deliberate collector post-spawn failure")
    );
    let pid = pid.expect("original child was not spawned");
    assert_eq!(
        assert_not_running_with(
            pid,
            Instant::now() + Duration::from_secs(2),
            |pid| query_ps(&[pid])
        ),
        PsObservation::Absent { pid }
    );
    let mut status = 0;
    // The original direct child must have been reaped, not merely terminated.
    assert_eq!(
        unsafe { libc::waitpid(pid as i32, &mut status, libc::WNOHANG) },
        -1
    );
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ECHILD)
    );
}

#[test]
fn session_cache_exchange_is_bound_to_original_payload_and_preproposal_phase() {
    for mode in [
        "cache-capture",
        "cache-decline",
        "cache-wrong-root",
        "cache-wrong-decision",
        "cache-repeat",
        "cache-before-ready",
        "cache-missing-sid",
    ] {
        let fixture = Fixture::new();
        let root = fs::canonicalize(&fixture.dir)
            .unwrap()
            .join("cache-project");
        let session = root.join(".caws/sessions/raw-supplied");
        fs::create_dir_all(&session).unwrap();
        let envelope = session.join(".session-envelope.json");
        let pointer = root.join(".caws/sessions/.caller-session.json");
        let old = br#"{"session_id":"raw-supplied","created_at":"preserved","untrusted":"old"}"#;
        fs::write(&envelope, old).unwrap();
        let mut command = fixture.command(mode, "pre_tool_use", "5000");
        command.env("CAWS_NATIVE_TEST_CACHE_ROOT", &root);
        let native_tmp = fixture.dir.join("native-tmp");
        fs::create_dir(&native_tmp).unwrap();
        command.env("TMPDIR", &native_tmp);
        let payload = if mode == "cache-missing-sid" {
            br#"{"tool_name":"Bash","tool_input":{"command":"echo fixture"}}"#.to_vec()
        } else {
            br#"{"session_id":"raw-supplied","hook_event_name":"forged","tool_name":"Bash","tool_input":{"command":"echo fixture"}}"#.to_vec()
        };
        let output = execute(command, payload);
        if ["cache-capture", "cache-decline", "cache-missing-sid"].contains(&mode) {
            assert_eq!(
                output.status.code(),
                Some(7),
                "{mode}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(output.stdout, "native\n雪\0exact".as_bytes());
        } else {
            failure(
                &output,
                2,
                if mode == "cache-before-ready" {
                    "configuration"
                } else {
                    "execution"
                },
            );
        }
        let published = ["cache-capture", "cache-repeat"].contains(&mode);
        if published {
            let value: serde_json::Value =
                serde_json::from_slice(&fs::read(&envelope).unwrap()).unwrap();
            assert_eq!(value["session_id"], "raw-supplied");
            assert_eq!(value["created_at"], "preserved");
            assert_eq!(value["hook_event"], "PreToolUse");
            assert_eq!(value["platform"], "codex");
            assert_eq!(value["repo_root"], root.to_str().unwrap());
            assert!(value["last_seen_at"].as_str().unwrap().ends_with('Z'));
            assert!(value.get("untrusted").is_none());
            let caller: serde_json::Value =
                serde_json::from_slice(&fs::read(&pointer).unwrap()).unwrap();
            assert_eq!(caller["session_id"], "raw-supplied");
            assert_eq!(caller["last_seen_at"], value["last_seen_at"]);
        } else {
            assert_eq!(fs::read(&envelope).unwrap(), old);
            assert!(!pointer.exists());
        }
        // Ready's unrelated session label cannot choose the native destination.
        assert!(!root.join(".caws/sessions/session").exists());
        let requests = fixture.requests();
        assert_eq!(requests.len(), 1, "{mode}: native request must not replay");
        assert_eq!(requests[0]["sessionCache"], "caws.runtime.session-cache.v1");
        let events = fs::read_to_string(fixture.dir.join("events.jsonl")).unwrap_or_default();
        let results: Vec<serde_json::Value> = events
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .filter_map(|row: serde_json::Value| row.get("cacheResult").cloned())
            .collect();
        assert_eq!(
            results.len(),
            usize::from(
                [
                    "cache-capture",
                    "cache-decline",
                    "cache-repeat",
                    "cache-missing-sid"
                ]
                .contains(&mode)
            )
        );
        if mode == "cache-decline" {
            assert_eq!(results[0]["status"], "declined");
            assert_eq!(results[0]["envelopePublished"], false);
        }
        if mode == "cache-missing-sid" {
            assert_eq!(results[0]["status"], "skipped");
            assert_eq!(results[0]["envelopePublished"], false);
        }
    }
}
