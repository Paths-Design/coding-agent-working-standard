use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Command, Output, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
};

static SERIAL: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    dir: PathBuf,
    node: String,
}
impl Fixture {
    fn new() -> Self {
        let dir = std::env::var_os("CAWS_NATIVE_TEST_ARTIFACT_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(format!(
                "caws-native-{}-{}",
                std::process::id(),
                SERIAL.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&dir).unwrap();
        // Caller snapshots include environment values; test receipts remain private.
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        let resolved = Command::new("node")
            .args(["-p", "process.execPath"])
            .output()
            .expect("Node is required for native behavioral tests");
        assert!(resolved.status.success());
        fs::create_dir(dir.join("budget-home")).unwrap();
        fs::set_permissions(dir.join("budget-home"), fs::Permissions::from_mode(0o700)).unwrap();
        Self {
            dir,
            node: String::from_utf8(resolved.stdout).unwrap().trim().into(),
        }
    }
    fn command(&self, mode: &str, event: &str, timeout: &str) -> Command {
        self.command_with_configuration(mode, event, timeout, "system")
    }
    fn command_with_configuration(
        &self,
        mode: &str,
        event: &str,
        timeout: &str,
        configuration: &str,
    ) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_caws-native"));
        command
            .args([
                "invoke",
                "--engine",
                concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/engine.cjs"),
                "--node",
                &self.node,
                "--surface",
                "codex",
                "--event",
                event,
                "--runtime-digest",
                &"a".repeat(64),
                "--timeout-ms",
                timeout,
                "--configuration",
                configuration,
            ])
            .env("CAWS_NATIVE_TEST_MODE", mode)
            .env("CAWS_NATIVE_TEST_BUDGET_HOME", self.dir.join("budget-home"))
            .env("CAWS_NATIVE_TEST_EVENTS", self.dir.join("events.jsonl"))
            .env("CAWS_NATIVE_TEST_RECEIPT", self.dir.join("requests.jsonl"))
            .env(
                "CAWS_NATIVE_TEST_RAW_REQUEST",
                self.dir.join("raw-requests.jsonl"),
            )
            .env("CAWS_NATIVE_TEST_CHILD", self.dir.join("child"))
            .env("CAWS_NATIVE_TEST_ENGINE_PID", self.dir.join("engine"))
            // Native execution uses the absolute Node path; no Python or shell is available.
            .env("PATH", "");
        command
    }
    fn requests(&self) -> Vec<serde_json::Value> {
        fs::read_to_string(self.dir.join("requests.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if std::thread::panicking() || std::env::var_os("CAWS_NATIVE_TEST_ARTIFACT_ROOT").is_some()
        {
            eprintln!("native scenario artifacts retained: {}", self.dir.display());
            return;
        }
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn execute(mut command: Command, input: Vec<u8>) -> Output {
    let evidence = command
        .get_envs()
        .find(|(key, _)| *key == "CAWS_NATIVE_TEST_RECEIPT")
        .and_then(|(_, value)| value.map(PathBuf::from))
        .and_then(|file| {
            file.parent().map(|parent| {
                parent.join(format!("call-{}", SERIAL.fetch_add(1, Ordering::Relaxed)))
            })
        });
    if let Some(directory) = &evidence {
        fs::create_dir(directory).unwrap();
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(directory.join("input.bin"), &input).unwrap();
        fs::write(
            directory.join("command.json"),
            serde_json::to_vec(
                &command
                    .get_args()
                    .map(|arg| arg.to_string_lossy().into_owned())
                    .collect::<Vec<_>>(),
            )
            .unwrap(),
        )
        .unwrap();
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let writer = thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let mut stdout = child.stdout.take().unwrap();
    let out = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).unwrap();
        bytes
    });
    let mut stderr = child.stderr.take().unwrap();
    let err = thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).unwrap();
        bytes
    });
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() > Duration::from_secs(8) {
            stop_test_child(&mut child);
            panic!("native invocation exceeded test watchdog");
        }
        thread::sleep(Duration::from_millis(5));
    };
    writer.join().unwrap();
    let output = Output {
        status,
        stdout: out.join().unwrap(),
        stderr: err.join().unwrap(),
    };
    if let Some(directory) = evidence {
        fs::write(directory.join("stdout.bin"), &output.stdout).unwrap();
        fs::write(directory.join("stderr.bin"), &output.stderr).unwrap();
        fs::write(directory.join("status.json"), serde_json::to_vec(&serde_json::json!({"exit_code":output.status.code(),"elapsed_ms":started.elapsed().as_millis()})).unwrap()).unwrap();
    }
    output
}
fn failure(output: &Output, code: i32, stage: &str) {
    assert_eq!(output.status.code(), Some(code));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains(&format!("infrastructure failure ({stage})")),
        "{stderr}"
    );
    assert!(
        stderr.contains("Checks did not complete; request was not retried."),
        "{stderr}"
    );
}

#[test]
fn exact_native_result_and_original_payload_are_delivered_without_path_interpreters() {
    let fixture = Fixture::new();
    let output = execute(
        fixture.command("exact", "pre_tool_use", "2000"),
        br#"{"tool_input":{"command":"echo hi"},"unknown":{"preserve":[null,3,true]}}"#.to_vec(),
    );
    assert_eq!(output.status.code(), Some(7));
    assert_eq!(output.stdout, "native\n雪\0exact".as_bytes());
    assert_eq!(output.stderr, b"diagnostic\nexact\n");
    let requests = fixture.requests();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(request["schema"], "caws.runtime.request.v1");
    assert_eq!(request["runtimeDigest"], "a".repeat(64));
    assert_eq!(request["surface"], "codex");
    assert_eq!(request["event"], "pre_tool_use");
    assert_eq!(request["configuration"], "system");
    assert_eq!(request["caller"]["environment"]["PATH"], "");
    assert_eq!(
        request["caller"]["processId"].as_u64().unwrap().to_string(),
        request["id"].as_str().unwrap().split('-').next().unwrap()
    );
    assert_ne!(
        request["caller"]["processId"].as_u64().unwrap(),
        std::process::id() as u64
    );
    assert!(std::path::Path::new(request["caller"]["cwd"].as_str().unwrap()).is_absolute());
    assert_eq!(
        request["inputJson"],
        r#"{"tool_input":{"command":"echo hi"},"unknown":{"preserve":[null,3,true]}}"#
    );
    assert_eq!(request["payload"]["tool_input"]["command"], "echo hi");
    assert_eq!(
        request["payload"]["unknown"]["preserve"],
        serde_json::json!([null, 3, true])
    );
    assert!(request["deadlineEpochMs"].as_u64().unwrap() <= 9_007_199_254_740_991);
    assert!(!request["id"].as_str().unwrap().is_empty());
}

#[test]
fn opaque_numeric_payload_tokens_reach_the_engine_without_narrowing() {
    for number in [
        "9007199254740993",
        "18446744073709551615",
        "18446744073709551617",
        "-9223372036854775809",
        "0.12345678901234567890123456789",
        "1e-400",
        "1e400",
        "-0",
        "1E+004",
    ] {
        let fixture = Fixture::new();
        let input = format!(
            " {{\"revision\":{number},\"nested\":[{number},{{\"$serde_json::private::Number\":\"123\",\"sibling\":true}},{{\"$serde_json::private::RawValue\":\"123\",\"sibling\":true}}]}}\n"
        );
        let output = execute(
            fixture.command("exact", "pre_tool_use", "2000"),
            input.as_bytes().to_vec(),
        );
        assert_eq!(
            output.status.code(),
            Some(7),
            "{number}: {:?}",
            output.stderr
        );
        let raw = fs::read_to_string(fixture.dir.join("raw-requests.jsonl")).unwrap();
        assert!(
            raw.contains(&format!("\"payload\":{}", input.trim())),
            "numeric payload changed: {number}"
        );
        assert!(
            raw.contains(&format!(
                "\"inputJson\":{}",
                serde_json::to_string(&input).unwrap()
            )),
            "original input changed: {number}"
        );
    }
}

#[test]
fn invalid_numeric_json_is_rejected_before_an_engine_can_start() {
    for number in ["01", "+1", "1e", "NaN", "Infinity", "-Infinity"] {
        let fixture = Fixture::new();
        let output = execute(
            fixture.command("exact", "pre_tool_use", "2000"),
            format!("{{\"revision\":{number}}}").into_bytes(),
        );
        failure(&output, 2, "configuration");
        assert!(
            !fixture.dir.join("engine").exists(),
            "invalid numeric input started engine: {number}"
        );
    }
}

#[test]
fn empty_stdin_uses_empty_object_without_replacing_original_custody_bytes() {
    let f = Fixture::new();
    for input in [Vec::new(), b"{}".to_vec()] {
        let out = execute(f.command("exact", "pre_tool_use", "1500"), input);
        assert_eq!(out.status.code(), Some(7));
        assert_eq!(out.stdout, "native\n雪\0exact".as_bytes());
        assert_eq!(out.stderr, b"diagnostic\nexact\n");
    }
    let requests = f.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0]["payload"], serde_json::json!({}));
    assert_eq!(requests[1]["payload"], requests[0]["payload"]);
    assert_eq!(requests[0]["inputJson"], "");
    assert_eq!(requests[1]["inputJson"], "{}");
    let invalid = execute(f.command("exact", "pre_tool_use", "1500"), b" \n".to_vec());
    failure(&invalid, 2, "configuration");
    assert_eq!(f.requests().len(), 2);
}

#[test]
fn hostile_response_and_uncertain_process_failure_refuse_without_retry() {
    for mode in [
        "id",
        "digest",
        "schema",
        "exit-code",
        "extra-field",
        "malformed",
        "oversize",
        "stderr-oversize",
        "bad-base64",
        "pad-bits",
        "old-text-shape",
        "outer-id",
        "outer-digest",
        "proposal-token",
        "proposal-extra",
        "proposal-missing-containment",
        "ready-twice",
        "failure",
        "crash",
    ] {
        let fixture = Fixture::new();
        let output = execute(
            fixture.command(mode, "pre_tool_use", "2000"),
            b"{}".to_vec(),
        );
        failure(&output, 2, "execution");
        let block: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(block["decision"], "block", "{mode}");
        assert!(
            block["reason"]
                .as_str()
                .unwrap()
                .contains("Execution outcome may be uncertain")
        );
        assert_eq!(fixture.requests().len(), 1, "{mode} replayed the request");
    }
}

#[test]
fn opaque_native_channels_deliver_invalid_utf8_nul_and_every_byte_exactly() {
    let fixture = Fixture::new();
    let output = execute(
        fixture.command("binary", "post_tool_use", "2000"),
        b"{}".to_vec(),
    );
    assert_eq!(output.status.code(), Some(7));
    assert_eq!(output.stdout, [0xff, 0x00, 0x61]);
    assert_eq!(output.stderr, (0..=255).collect::<Vec<u8>>());
    assert_eq!(fixture.requests().len(), 1);
}

#[test]
fn concurrent_callers_keep_their_own_cwd_environment_and_entry_mode() {
    let first = Fixture::new();
    let second = Fixture::new();
    let first_cwd = fs::canonicalize(&first.dir).unwrap();
    let second_cwd = fs::canonicalize(&second.dir).unwrap();
    let mut one = first.command_with_configuration("exact", "pre_tool_use", "3000", "project");
    one.current_dir(&first_cwd)
        .env("CAWS_CALLER_MARKER", "first");
    let mut two = second.command("exact", "pre_tool_use", "3000");
    two.current_dir(&second_cwd)
        .env("CAWS_CALLER_MARKER", "second");
    let one = thread::spawn(move || execute(one, b"{}".to_vec()));
    let two = thread::spawn(move || execute(two, b"{}".to_vec()));
    assert_eq!(one.join().unwrap().status.code(), Some(7));
    assert_eq!(two.join().unwrap().status.code(), Some(7));
    for (fixture, cwd, marker, configuration) in [
        (&first, first_cwd, "first", "project"),
        (&second, second_cwd, "second", "system"),
    ] {
        let requests = fixture.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["caller"]["cwd"], cwd.to_str().unwrap());
        assert_eq!(
            requests[0]["caller"]["environment"]["CAWS_CALLER_MARKER"],
            marker
        );
        assert_eq!(requests[0]["configuration"], configuration);
    }
}

#[test]
fn non_utf8_caller_environment_is_explicit_configuration_failure_before_dispatch() {
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};
    // The Darwin fixture filesystem rejects non-UTF8 names at mkdir itself;
    // environment bytes exercise the native validation boundary on this host.
    for invalid in ["name", "value"] {
        let fixture = Fixture::new();
        let mut command = fixture.command("exact", "pre_tool_use", "2000");
        match invalid {
            "name" => {
                command.env(OsString::from_vec(b"BAD_\xff".to_vec()), "value");
            }
            "value" => {
                command.env("BAD_CALLER", OsString::from_vec(b"bad_\xff".to_vec()));
            }
            _ => unreachable!(),
        }
        let output = execute(command, b"{}".to_vec());
        failure(&output, 2, "configuration");
        assert!(String::from_utf8_lossy(&output.stderr).contains("not valid UTF-8"));
        assert!(
            !fixture.dir.join("engine").exists(),
            "{invalid} started an engine"
        );
        assert!(!fixture.dir.join("requests.jsonl").exists());
    }
}

#[test]
fn malformed_and_oversized_original_hook_input_never_starts_engine() {
    for input in [b"[]".to_vec(), b"{bad".to_vec(), vec![b' '; 1_048_577]] {
        let fixture = Fixture::new();
        let output = execute(fixture.command("exact", "pre_tool_use", "2000"), input);
        failure(&output, 2, "configuration");
        assert!(!fixture.dir.join("requests.jsonl").exists());
    }
}

#[test]
fn configuration_failure_allows_only_non_guard_events_and_never_reports_checks_passed() {
    for event in [
        "pre_tool_use",
        "post_tool_use",
        "session_start",
        "stop",
        "pre_compact",
        "session_end",
    ] {
        let fixture = Fixture::new();
        let mut command = fixture.command("exact", event, "2000");
        // Duplicate options are rejected before dispatch, exercising native configuration policy.
        command.args(["--node", "/missing-node"]);
        let output = execute(command, b"{}".to_vec());
        failure(
            &output,
            if event == "pre_tool_use" { 2 } else { 0 },
            "configuration",
        );
        if event != "pre_tool_use" {
            assert!(output.stdout.is_empty());
        }
        assert!(!fixture.dir.join("requests.jsonl").exists());
    }
}

#[test]
fn timeout_covers_silent_engine_closed_output_and_blocked_input_write() {
    for (mode, payload) in [
        ("timeout", b"{}".to_vec()),
        ("closed-pipes", b"{}".to_vec()),
        (
            "no-read",
            serde_json::to_vec(&serde_json::json!({"large":"x".repeat(500_000)})).unwrap(),
        ),
    ] {
        let fixture = Fixture::new();
        let started = Instant::now();
        // An active-phase timeout needs time to observe the Ready/grant exchange;
        // creation of a cold Node process is not evidence of dispatch.
        let output = execute(
            fixture.command(
                mode,
                "post_tool_use",
                if mode == "no-read" { "250" } else { "1000" },
            ),
            payload,
        );
        assert!(started.elapsed() < Duration::from_secs(3), "{mode}");
        let before_grant = mode == "no-read";
        assert_eq!(
            fixture.dir.join("events.jsonl").exists(),
            !before_grant,
            "{mode}: no phase witness; stderr={}",
            String::from_utf8_lossy(&output.stderr)
        );
        failure(
            &output,
            if before_grant { 0 } else { 2 },
            if before_grant {
                "configuration"
            } else {
                "execution"
            },
        );
        if before_grant {
            assert!(output.stdout.is_empty());
        } else {
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()["decision"],
                "block"
            );
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains(if mode == "closed-pipes" {
                "stream closed"
            } else {
                "deadline expired"
            }),
            "{stderr}"
        );
    }
}

#[test]
fn engine_exit_with_grandchild_held_pipes_is_bounded_and_owned_child_is_killed() {
    let fixture = Fixture::new();
    let mut unrelated = Command::new(&fixture.node)
        .args(["-e", "setInterval(() => {},1000)"])
        .spawn()
        .unwrap();
    let started = Instant::now();
    let output = execute(
        fixture.command("pipe-holder", "pre_tool_use", "2000"),
        b"{}".to_vec(),
    );
    assert_eq!(output.status.code(), Some(7));
    assert_eq!(output.stdout, "native\n雪\0exact".as_bytes());
    assert_eq!(output.stderr, b"diagnostic\nexact\n");
    assert!(
        started.elapsed() < Duration::from_millis(1500),
        "held pipes exceeded request and cleanup allowance"
    );
    assert!(
        unrelated.try_wait().unwrap().is_none(),
        "foreign process was terminated"
    );
    unrelated.kill().unwrap();
    unrelated.wait().unwrap();
    let pid = fs::read_to_string(fixture.dir.join("child")).unwrap_or_else(|error| {
        panic!(
            "pipe-holder fixture did not start its child: {error}; native stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        )
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let state = Command::new("ps")
            .args(["-p", pid.trim(), "-o", "stat="])
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&state.stdout);
        if text.trim().is_empty() || text.trim().starts_with('Z') {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "owned child {pid} remains running: {text}"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn missing_node_is_configuration_failure_before_dispatch() {
    let fixture = Fixture::new();
    let command = fixture.command("exact", "pre_tool_use", "2000");
    let args: Vec<_> = command.get_args().map(|v| v.to_os_string()).collect();
    let mut replaced = Command::new(env!("CARGO_BIN_EXE_caws-native"));
    let mut args = args;
    args[4] = "/definitely/missing/caws-node".into();
    replaced.args(args);
    let output = execute(replaced, b"{}".to_vec());
    failure(&output, 2, "configuration");
    assert!(String::from_utf8_lossy(&output.stderr).contains("engine spawn"));
}

#[test]
fn exact_input_custody_includes_whitespace_key_order_and_utf8_at_budget_boundary() {
    let fixture = Fixture::new();
    let mut input = "\n { \"z\": \"雪\", \"a\": 1 } \t".as_bytes().to_vec();
    input.resize(1_048_576, b' ');
    let output = execute(
        fixture.command("exact", "pre_tool_use", "3000"),
        input.clone(),
    );
    assert_eq!(output.status.code(), Some(7));
    let requests = fixture.requests();
    assert_eq!(requests[0]["inputJson"].as_str().unwrap().as_bytes(), input);
    assert_eq!(requests[0]["payload"], serde_json::json!({"a":1,"z":"雪"}));
}

#[test]
fn held_original_stdin_expires_before_engine_start() {
    let fixture = Fixture::new();
    let mut child = fixture
        .command("exact", "pre_tool_use", "150")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(b"{}").unwrap();
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(started.elapsed() < Duration::from_secs(3));
        thread::sleep(Duration::from_millis(5));
    };
    drop(stdin);
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_end(&mut stdout)
        .unwrap();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_end(&mut stderr)
        .unwrap();
    failure(
        &Output {
            status,
            stdout,
            stderr,
        },
        2,
        "configuration",
    );
    assert!(!fixture.dir.join("requests.jsonl").exists());
}

#[test]
fn runtime_surface_subset_is_grounded_in_canonical_registry() {
    let registry: serde_json::Value =
        serde_json::from_str(include_str!("../../caws-cli/surfaces/registry.json")).unwrap();
    for surface in [
        "codex",
        "claude-code",
        "kimi-code",
        "qwen-code",
        "zcode",
        "opencode",
        "dsh",
    ] {
        assert!(
            registry["surfaces"].get(surface).is_some(),
            "runtime surface absent from canonical registry: {surface}"
        );
    }
}

fn wait_for_file(path: &std::path::Path) -> String {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Ok(text) = fs::read_to_string(path) {
            return text;
        }
        assert!(
            Instant::now() < deadline,
            "fixture did not create {}",
            path.display()
        );
        thread::sleep(Duration::from_millis(5));
    }
}

fn wait_bounded(child: &mut std::process::Child) -> std::process::ExitStatus {
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if started.elapsed() > Duration::from_secs(4) {
            stop_test_child(child);
            panic!("native cancellation exceeded watchdog");
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn stop_test_child(child: &mut std::process::Child) {
    // Give native cleanup a chance before the watchdog's unavoidable SIGKILL fallback.
    // SAFETY: this is the direct test-owned process, not an inferred process group.
    unsafe {
        libc::kill(child.id() as i32, libc::SIGTERM);
    }
    let deadline = Instant::now() + Duration::from_millis(700);
    while Instant::now() < deadline {
        if child.try_wait().unwrap().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(5));
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn captured(child: &mut std::process::Child) -> Output {
    let status = wait_bounded(child);
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_end(&mut stdout)
        .unwrap();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_end(&mut stderr)
        .unwrap();
    Output {
        status,
        stdout,
        stderr,
    }
}

fn assert_not_running(pid: &str) {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let state = Command::new("ps")
            .args(["-p", pid.trim(), "-o", "stat="])
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&state.stdout);
        if text.trim().is_empty() || text.trim().starts_with('Z') {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "owned process {pid} remains running: {text}"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn external_signals_cancel_input_engine_and_held_pipes_without_killing_foreign_processes() {
    for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        for mode in ["input", "timeout", "pipe-holder-wait"] {
            let fixture = Fixture::new();
            let mut unrelated = Command::new(&fixture.node)
                .args(["-e", "setInterval(() => {},1000)"])
                .spawn()
                .unwrap();
            let mut child = fixture
                .command(
                    if mode == "input" { "exact" } else { mode },
                    "pre_tool_use",
                    "5000",
                )
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let mut input = child.stdin.take().unwrap();
            input.write_all(b"{}").unwrap();
            let mut engine_pid = None;
            let mut descendant_pid = None;
            if mode == "input" {
                // The native process is waiting for the still-open original stdin.
                thread::sleep(Duration::from_millis(100));
            } else {
                drop(input);
                engine_pid = Some(wait_for_file(&fixture.dir.join("engine")));
                if mode == "pipe-holder-wait" {
                    descendant_pid = Some(wait_for_file(&fixture.dir.join("child")));
                }
            }
            let started = Instant::now();
            // SAFETY: signal only the direct native child created by this test.
            assert_eq!(unsafe { libc::kill(child.id() as i32, signal) }, 0);
            let output = captured(&mut child);
            assert!(
                started.elapsed() < Duration::from_millis(1500),
                "{mode}, signal {signal}"
            );
            assert_eq!(output.status.code(), Some(2));
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(
                stderr.contains(&format!("cancelled by signal {signal}")),
                "{stderr}"
            );
            assert!(
                stderr.contains("consumer receipt is unconfirmed"),
                "{stderr}"
            );
            assert!(
                unrelated.try_wait().unwrap().is_none(),
                "foreign process terminated"
            );
            unrelated.kill().unwrap();
            unrelated.wait().unwrap();
            if let Some(pid) = engine_pid {
                assert_not_running(&pid);
            }
            if let Some(pid) = descendant_pid {
                assert_not_running(&pid);
            }
            if mode == "input" {
                assert!(!fixture.dir.join("engine").exists());
            }
        }
    }
}

#[test]
fn caller_death_cancels_and_cleans_owned_engine_group() {
    let fixture = Fixture::new();
    let engine = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/engine.cjs");
    let script = r#"
      const fs = require('node:fs');
      const {spawn} = require('node:child_process');
      const child = spawn(process.env.NATIVE, ['invoke','--engine',process.env.ENGINE,'--node',process.execPath,'--surface','codex','--event','pre_tool_use','--runtime-digest','a'.repeat(64),'--timeout-ms','5000','--configuration','system'], {stdio:['pipe','ignore','ignore']});
      fs.writeFileSync(process.env.NATIVE_PID, String(child.pid));
      child.stdin.end('{}');
      const timer = setInterval(() => { if (fs.existsSync(process.env.CAWS_NATIVE_TEST_ENGINE_PID)) { clearInterval(timer); process.exit(0); } }, 5);
    "#;
    let mut parent = Command::new(&fixture.node)
        .args(["-e", script])
        .env("NATIVE", env!("CARGO_BIN_EXE_caws-native"))
        .env("ENGINE", engine)
        .env("NATIVE_PID", fixture.dir.join("native"))
        .env("CAWS_NATIVE_TEST_ENGINE_PID", fixture.dir.join("engine"))
        .env("CAWS_NATIVE_TEST_MODE", "timeout")
        .spawn()
        .unwrap();
    assert!(wait_bounded(&mut parent).success());
    assert_not_running(&wait_for_file(&fixture.dir.join("native")));
    assert_not_running(&wait_for_file(&fixture.dir.join("engine")));
}

#[test]
fn closed_caller_output_channel_cancels_engine_before_request_deadline() {
    let fixture = Fixture::new();
    let mut child = fixture
        .command("timeout", "pre_tool_use", "5000")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"{}").unwrap();
    let engine_pid = wait_for_file(&fixture.dir.join("engine"));
    drop(child.stdout.take());
    let started = Instant::now();
    let status = wait_bounded(&mut child);
    assert!(started.elapsed() < Duration::from_millis(1500));
    assert_eq!(status.code(), Some(2));
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    assert!(stderr.contains("caller output channel closed"), "{stderr}");
    assert_not_running(&engine_pid);
}

#[test]
fn output_backpressure_is_bounded_and_never_claims_consumer_receipt() {
    let control = Fixture::new();
    let drained = execute(
        control.command("large-native-result", "pre_tool_use", "2000"),
        b"{}".to_vec(),
    );
    assert_eq!(drained.status.code(), Some(7));
    assert_eq!(drained.stdout, vec![b'x'; 1_000_000]);
    assert_eq!(drained.stderr, b"diagnostic\nexact\n");
    let acknowledged = fs::read_to_string(control.dir.join("events.jsonl")).unwrap();
    assert!(
        acknowledged
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .any(|row| row["schema"] == "caws.runtime.handoff.v2" && row["success"] == true)
    );
    let fixture = Fixture::new();
    let mut child = fixture
        .command("large-native-result", "pre_tool_use", "2000")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"{}").unwrap();
    let started = Instant::now();
    // Do not read stdout until the native writer has terminated.
    let output = captured(&mut child);
    fs::write(fixture.dir.join("stdout.bin"), &output.stdout).unwrap();
    fs::write(fixture.dir.join("stderr.bin"), &output.stderr).unwrap();
    assert!(
        started.elapsed() < Duration::from_millis(3700),
        "configured2000ms + delivery500ms + shared postproposal500ms + cleanup500ms + diagnostic100ms + scheduling allowance ceiling exceeded"
    );
    assert_eq!(output.status.code(), Some(2));
    assert!(
        !output.stdout.is_empty() && output.stdout.len() < 1_000_000,
        "must observe actual native delivery, not a pre-proposal infrastructure fallback"
    );
    assert!(output.stdout.iter().all(|byte| *byte == b'x'));
    let events: Vec<serde_json::Value> = fs::read_to_string(fixture.dir.join("events.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let handoff = events
        .iter()
        .find(|row| row["schema"] == "caws.runtime.handoff.v2")
        .expect("partial local delivery must produce a handoff outcome");
    assert_eq!(handoff["id"], fixture.requests()[0]["id"]);
    assert_eq!(handoff["runtimeDigest"], "a".repeat(64));
    assert_eq!(handoff["token"], "fixture-proposal");
    assert_eq!(handoff["success"], false);
    assert!(!events.iter().any(|row| row["settled"] == true));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("bounded output write: request deadline expired"),
        "{stderr}"
    );
    assert!(
        stderr.contains("Output may be partial; consumer receipt is unconfirmed"),
        "{stderr}"
    );
    assert_not_running(&wait_for_file(&fixture.dir.join("engine")));
}

#[test]
fn known_proposals_survive_late_engine_exit_or_settlement_past_request_deadline() {
    for mode in ["nonzero", "late-post-proposal-hang"] {
        let fixture = Fixture::new();
        let output = execute(
            fixture.command(mode, "pre_tool_use", "1000"),
            b"{}".to_vec(),
        );
        assert_eq!(
            output.status.code(),
            Some(7),
            "{mode}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, "native\n雪\0exact".as_bytes());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.starts_with("diagnostic\nexact\n"),
            "{mode}: {stderr}"
        );
        assert!(
            stderr.contains("post-proposal diagnostic"),
            "{mode}: {stderr}"
        );
        assert!(
            !stderr.contains("Checks did not complete"),
            "{mode}: {stderr}"
        );
        assert_eq!(fixture.requests().len(), 1);
    }
}

#[test]
fn valid_null_and_regular_file_outputs_do_not_cancel_native_execution() {
    for null in [true, false] {
        let fixture = Fixture::new();
        let path = if null {
            PathBuf::from("/dev/null")
        } else {
            fixture.dir.join("output")
        };
        let output = fs::OpenOptions::new()
            .write(true)
            .create(!null)
            .truncate(!null)
            .open(&path)
            .unwrap();
        let mut child = fixture
            .command("exact", "pre_tool_use", "2000")
            .stdin(Stdio::piped())
            .stdout(output)
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(b"{}").unwrap();
        assert_eq!(wait_bounded(&mut child).code(), Some(7));
        let mut stderr = Vec::new();
        child
            .stderr
            .take()
            .unwrap()
            .read_to_end(&mut stderr)
            .unwrap();
        assert_eq!(stderr, b"diagnostic\nexact\n");
        if !null {
            assert_eq!(fs::read(path).unwrap(), "native\n雪\0exact".as_bytes());
        }
    }
}

#[test]
fn malformed_effect_preserves_known_refusal_and_never_enters_signal_path() {
    let fixture = Fixture::new();
    let output = execute(
        fixture.command("proposal-malformed-containment", "pre_tool_use", "3000"),
        b"{}".to_vec(),
    );
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        "{\"decision\":\"block\",\"reason\":\"retained\"}\n"
    );
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("containment intent rejected")
    );
    let events = fs::read_to_string(fixture.dir.join("events.jsonl")).unwrap();
    let ack = events
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .find(|row| row["schema"] == "caws.runtime.handoff.v2")
        .unwrap();
    assert_eq!(ack["containment"], serde_json::Value::Null);
}

/// Cleanup pins the native group with a direct, unreaped anchor child. It never
/// infers a cleanup signal target from Codex, the test harness, or a stale PID.
struct TerminalFixtureCleanup {
    anchor: std::process::Child,
    caller: Option<std::process::Child>,
    sibling: Option<std::process::Child>,
    root: PathBuf,
}
fn terminal_wait(
    child: &mut std::process::Child,
    budget: Duration,
) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + budget;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Err(_) => return None,
            Ok(None) => (),
        }
        if Instant::now() >= deadline {
            return None;
        }
        thread::sleep(Duration::from_millis(5));
    }
}
impl Drop for TerminalFixtureCleanup {
    fn drop(&mut self) {
        let _ = fs::write(self.root.join("stop-sibling"), b"stop");
        if let Some(caller) = self.caller.as_mut()
            && matches!(caller.try_wait(), Ok(None))
        {
            // A timeout/panic cannot become an accepted effect witness: this
            // cleanup runs after the scenario has already failed its assertions.
            let _ = fs::write(
                self.root.join("caller-cleanup-fired.marker"),
                b"external cleanup",
            );
            let _ = caller.kill();
            let _ = terminal_wait(caller, Duration::from_millis(500));
        }
        match self.anchor.try_wait() {
            Ok(None) => {
                // SAFETY: this direct child created its own group. Do not reap
                // it between group signals: its live/zombie PID pins the PGID.
                unsafe {
                    libc::kill(-(self.anchor.id() as i32), libc::SIGTERM);
                }
                thread::sleep(Duration::from_millis(700));
                unsafe {
                    libc::kill(-(self.anchor.id() as i32), libc::SIGKILL);
                }
                let _ = terminal_wait(&mut self.anchor, Duration::from_millis(500));
            }
            Ok(Some(_)) | Err(_) => {
                let _ = fs::write(
                    self.root.join("group-cleanup-unconfirmed.txt"),
                    b"anchor already reaped or wait failed; no group signal",
                );
            }
        }
        if let Some(sibling) = self.sibling.as_mut()
            && terminal_wait(sibling, Duration::from_millis(500)).is_none()
            && matches!(sibling.try_wait(), Ok(None))
        {
            let _ = sibling.kill();
            let _ = terminal_wait(sibling, Duration::from_millis(500));
        }
    }
}

#[test]
fn terminal_output_loss_does_not_veto_earned_containment_or_borrow_another_process() {
    use std::os::unix::process::{CommandExt, ExitStatusExt};
    // Always retain these effect artifacts, including successful scenarios.
    let fixture = std::mem::ManuallyDrop::new(Fixture::new());
    let caller_binary = fixture.dir.join("caws-fx-agent");
    let compiler_output = fs::File::create(fixture.dir.join("fixture-compiler.log")).unwrap();
    let mut compiler = Command::new("rustc")
        .args([
            "--edition=2024",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/terminal-caller.rs"
            ),
            "-o",
        ])
        .arg(&caller_binary)
        .stdout(Stdio::from(compiler_output.try_clone().unwrap()))
        .stderr(Stdio::from(compiler_output))
        .spawn()
        .unwrap();
    let compile = terminal_wait(&mut compiler, Duration::from_secs(30));
    if compile.is_none() && matches!(compiler.try_wait(), Ok(None)) {
        let _ = compiler.kill();
        let _ = terminal_wait(&mut compiler, Duration::from_millis(500));
    }
    assert!(
        compile.is_some_and(|status| status.success()),
        "fixture compilation failed; {}",
        fixture.dir.display()
    );
    for mode in ["close-after-prefix", "full-unread"] {
        let root = fixture.dir.join(mode);
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("budget-home")).unwrap();
        fs::write(
            root.join("input.bin"),
            b"{\"session_id\":\"terminal-fixture\"}",
        )
        .unwrap();
        let anchor = Command::new(&fixture.node)
            .args(["-e", "setInterval(()=>{},1000)"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .unwrap();
        let mut cleanup = TerminalFixtureCleanup {
            anchor,
            caller: None,
            sibling: None,
            root: root.clone(),
        };
        cleanup.sibling = Some(Command::new(&fixture.node).args(["-e", r#"
            const fs=require('node:fs'),p=process.env.CASE;
            setInterval(()=>{if(fs.existsSync(p+'/stop-sibling'))process.exit(0);fs.appendFileSync(p+'/sibling-heartbeat.bin','x')},20);
        "#]).env("CASE", &root).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap());
        wait_for_file(&root.join("sibling-heartbeat.bin"));
        let sibling_before = fs::metadata(root.join("sibling-heartbeat.bin"))
            .unwrap()
            .len();
        let caller = Command::new(&caller_binary)
            .env("TERMINAL_CASE_ROOT", &root)
            .env("TERMINAL_OUTPUT_MODE", mode)
            .env("TERMINAL_GROUP_ANCHOR", cleanup.anchor.id().to_string())
            .env("TERMINAL_NATIVE", env!("CARGO_BIN_EXE_caws-native"))
            .env(
                "TERMINAL_ENGINE",
                concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/tests/fixtures/terminal-engine.cjs"
                ),
            )
            .env("TERMINAL_NODE", &fixture.node)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(
                fs::File::create(root.join("caller-stderr.bin")).unwrap(),
            ))
            .spawn()
            .unwrap();
        let caller_pid = caller.id();
        cleanup.caller = Some(caller);
        let started = Instant::now();
        let status = terminal_wait(cleanup.caller.as_mut().unwrap(), Duration::from_secs(12));
        // Assert before Drop: watchdog cleanup must never manufacture SIGTERM
        // evidence accepted by this test.
        assert!(
            status.is_some(),
            "caller watchdog: artifacts {}",
            root.display()
        );
        let status = status.unwrap();
        fs::write(root.join("caller-wait-status.json"), serde_json::to_vec_pretty(&serde_json::json!({"pid":caller_pid,"exit_code":status.code(),"signal":status.signal(),"elapsed_ms":started.elapsed().as_millis()})).unwrap()).unwrap();
        assert_eq!(
            status.signal(),
            Some(libc::SIGTERM),
            "actual caller did not receive earned SIGTERM; inspect {}",
            root.display()
        );
        let ack: serde_json::Value =
            serde_json::from_str(&wait_for_file(&root.join("handoff.json"))).unwrap();
        let intent: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(root.join("intent.json")).unwrap()).unwrap();
        assert_eq!(ack["schema"], "caws.runtime.handoff.v2");
        assert_eq!(
            ack["success"], false,
            "output acceptance is independent of signal acceptance"
        );
        assert_eq!(ack["containment"]["schema"], "caws.containment.receipt.v1");
        assert_eq!(ack["containment"]["pid"], caller_pid);
        assert_eq!(intent["pid"], caller_pid);
        assert_ne!(caller_pid, std::process::id());
        for key in [
            "pid",
            "startEpoch",
            "comm",
            "sessionId",
            "latchPath",
            "latchGeneration",
        ] {
            assert_eq!(
                ack["containment"][key], intent[key],
                "effect receipt changed {key}"
            );
        }
        assert_eq!(ack["containment"]["status"], "signal-accepted");
        assert_eq!(ack["containment"]["reason"], "signal-accepted");
        assert_eq!(ack["containment"]["errno"], serde_json::Value::Null);
        assert!(!root.join("forbidden-next-action.marker").exists());
        assert!(!root.join("caller-watchdog-fired.marker").exists());
        if mode == "close-after-prefix" {
            assert_eq!(fs::read(root.join("accepted-prefix.bin")).unwrap(), b"{");
        } else {
            assert!(root.join("stdout-held-unread.marker").exists());
            assert!(!root.join("accepted-prefix.bin").exists());
        }
        let events: Vec<serde_json::Value> = fs::read_to_string(root.join("wire-events.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            events
                .iter()
                .filter(|row| row["stage"] == "dispatch")
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|row| row["stage"] == "proposal")
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|row| row["stage"] == "handoff")
                .count(),
            1
        );
        assert!(
            !events
                .iter()
                .any(|row| row["stage"] == "dispatch-after-terminal"
                    || row["stage"] == "fixture-watchdog-fired")
        );
        thread::sleep(Duration::from_millis(80));
        let sibling_after = fs::metadata(root.join("sibling-heartbeat.bin"))
            .unwrap()
            .len();
        assert!(sibling_after > sibling_before);
        assert!(
            cleanup
                .sibling
                .as_mut()
                .unwrap()
                .try_wait()
                .unwrap()
                .is_none()
        );
        assert!(cleanup.anchor.try_wait().unwrap().is_none());
        fs::write(root.join("sibling-progress.json"), serde_json::to_vec_pretty(&serde_json::json!({"pid":cleanup.sibling.as_ref().unwrap().id(),"before":sibling_before,"after":sibling_after,"survived":true})).unwrap()).unwrap();
        // No process state is inferred from syscall acceptance: separately
        // observe fixture/native shutdown before external cleanup acts.
        assert_not_running(&wait_for_file(&root.join("native-pid.txt")));
        assert_not_running(&wait_for_file(&root.join("engine-pid.txt")));
        let native_stderr = fs::read_to_string(root.join("native-stderr.bin")).unwrap();
        assert!(
            native_stderr.contains("output delivery failed"),
            "no delivery failure witness: {native_stderr}"
        );
        if mode == "close-after-prefix" {
            assert!(
                native_stderr.contains("Broken pipe"),
                "reader closure was not the observed failure: {native_stderr}"
            );
        } else {
            assert!(
                native_stderr.contains("bounded output write")
                    && native_stderr.contains("deadline"),
                "unread output did not reach its bounded delivery deadline: {native_stderr}"
            );
        }
        eprintln!(
            "terminal containment artifact {}: {}",
            root.display(),
            serde_json::json!({"caller_signal":status.signal(),"local_output_success":ack["success"],"effect":ack["containment"],"sibling_progress":sibling_after-sibling_before})
        );
        drop(cleanup);
    }
    eprintln!(
        "terminal transport artifacts retained: {}",
        fixture.dir.display()
    );
}
