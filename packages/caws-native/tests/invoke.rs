use std::{
    fs,
    io::{Read, Write},
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
        let dir = std::env::temp_dir().join(format!(
            "caws-native-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&dir).unwrap();
        let resolved = Command::new("node")
            .args(["-p", "process.execPath"])
            .output()
            .expect("Node is required for native behavioral tests");
        assert!(resolved.status.success());
        Self {
            dir,
            node: String::from_utf8(resolved.stdout).unwrap().trim().into(),
        }
    }
    fn command(&self, mode: &str, event: &str, timeout: &str) -> Command {
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
            ])
            .env("CAWS_NATIVE_TEST_MODE", mode)
            .env("CAWS_NATIVE_TEST_RECEIPT", self.dir.join("requests.jsonl"))
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
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn execute(mut command: Command, input: Vec<u8>) -> Output {
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
    Output {
        status,
        stdout: out.join().unwrap(),
        stderr: err.join().unwrap(),
    }
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
fn hostile_response_and_uncertain_process_failure_refuse_without_retry() {
    for mode in [
        "id",
        "digest",
        "schema",
        "exit-code",
        "extra-field",
        "malformed",
        "nonzero",
        "oversize",
        "stderr-oversize",
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
        let output = execute(fixture.command(mode, "post_tool_use", "250"), payload);
        assert!(started.elapsed() < Duration::from_secs(3), "{mode}");
        failure(&output, 2, "execution");
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8_lossy(&output.stderr).contains("deadline expired"));
    }
}

#[test]
fn engine_exit_with_grandchild_held_pipes_is_bounded_and_owned_child_is_killed() {
    let fixture = Fixture::new();
    let mut unrelated = Command::new(&fixture.node)
        .args(["-e", "setInterval(() => {},1000)"])
        .spawn()
        .unwrap();
    let output = execute(
        fixture.command("pipe-holder", "pre_tool_use", "350"),
        b"{}".to_vec(),
    );
    failure(&output, 2, "execution");
    assert!(
        unrelated.try_wait().unwrap().is_none(),
        "foreign process was terminated"
    );
    unrelated.kill().unwrap();
    unrelated.wait().unwrap();
    let pid = fs::read_to_string(fixture.dir.join("child")).unwrap();
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
        for mode in ["input", "timeout", "pipe-holder"] {
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
                if mode == "pipe-holder" {
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
      const child = spawn(process.env.NATIVE, ['invoke','--engine',process.env.ENGINE,'--node',process.execPath,'--surface','codex','--event','pre_tool_use','--runtime-digest','a'.repeat(64),'--timeout-ms','5000'], {stdio:['pipe','ignore','ignore']});
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
    let fixture = Fixture::new();
    let mut child = fixture
        .command("late-large-native-result", "pre_tool_use", "1000")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"{}").unwrap();
    let started = Instant::now();
    // Do not read stdout until the native writer has terminated.
    let output = captured(&mut child);
    assert!(
        started.elapsed() >= Duration::from_millis(1000),
        "fixture did not exercise late engine completion plus blocked native delivery"
    );
    assert!(
        started.elapsed() < Duration::from_millis(2100),
        "configured1000ms + cleanup500ms + delivery500ms + diagnostic100ms ceiling exceeded"
    );
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.len() < 1_000_000);
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
