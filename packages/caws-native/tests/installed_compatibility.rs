//! Real installed-binary controls for legacy and describe compatibility custody.
//! The test harness never invokes the fork-based module in its own test threads.
#![cfg(target_os = "macos")]

use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::{fs::PermissionsExt, net::UnixStream},
    },
    path::PathBuf,
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
    thread,
    time::{Duration, Instant},
};

static SEQUENCE: AtomicUsize = AtomicUsize::new(0);
const EVENTS: [&str; 6] = [
    "pre_tool_use",
    "post_tool_use",
    "session_start",
    "stop",
    "pre_compact",
    "session_end",
];
const DESCRIBE_MS: u64 = 1200;
const FAST_LIMIT: Duration = Duration::from_secs(4);

struct Fixture {
    root: PathBuf,
    retain: bool,
}
impl Fixture {
    fn new(name: &str) -> Self {
        let configured = std::env::var_os("CAWS_NATIVE_ENTRY_ARTIFACT_DIR");
        let parent = configured
            .clone()
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let root = parent.join(format!(
            "caws-compatibility-{name}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        Self {
            root: fs::canonicalize(root).unwrap(),
            retain: configured.is_some(),
        }
    }
    fn install(&self, body: &str, describe: bool) {
        let source = format!(
            "#!/usr/bin/env python3\nimport os, sys, json, time, signal\nfrom pathlib import Path\nw = Path(os.environ['CAWS_COMPATIBILITY_WITNESS'])\ndef witness(name, **extra):\n    data = dict(pid=os.getpid(), ppid=os.getppid(), pgid=os.getpgid(0), sid=os.getsid(0), monotonic_ns=time.monotonic_ns(), **extra)\n    temporary = w / (name + '.writing')\n    temporary.write_text(json.dumps(data))\n    temporary.rename(w / (name + '.json'))\nsignal.alarm(5)\n{body}\n"
        );
        let mut files = BTreeMap::<String, Vec<u8>>::from([
            ("launcher.py".into(), b"raise SystemExit(79)\n".to_vec()),
            (
                "bootstrap.py".into(),
                if describe {
                    b"raise SystemExit(78)\n".to_vec()
                } else {
                    source.as_bytes().to_vec()
                },
            ),
        ]);
        if describe {
            files.extend([
                ("native/caws-native".into(), b"#!/bin/sh\nexit 77\n".to_vec()),
                ("native/caws-hook-native".into(), b"fixture identity only\n".to_vec()),
                ("native/node".into(), source.into_bytes()),
                ("engine.js".into(), b"throw Error('engine must not run during describe');\n".to_vec()),
                ("describe.js".into(), b"fixture describe argv member\n".to_vec()),
                ("native-entry.json".into(), serde_json::to_vec(&serde_json::json!({
                    "schema":"caws.runtime.native-entry.v2", "nativeExecutable":"native/caws-native",
                    "nodeExecutable":"native/node", "engineEntry":"engine.js", "describeEntry":"describe.js",
                    "timeoutMs":DESCRIBE_MS,
                    "installedInvocation":{"protocol":"invoke-installed-v1","maxOriginalTimeoutMs":30000}
                })).unwrap()),
                ("native-modes.json".into(), Vec::new()),
            ]);
            let modes: BTreeMap<_, _> = files
                .keys()
                .map(|path| {
                    (
                        path.clone(),
                        if path.starts_with("native/") {
                            0o755
                        } else {
                            0o644
                        },
                    )
                })
                .collect();
            files.insert(
                "native-modes.json".into(),
                serde_json::to_vec(&modes).unwrap(),
            );
        }
        let manifest: BTreeMap<_, _> = files
            .iter()
            .map(|(path, bytes)| (path, format!("{:x}", Sha256::digest(bytes))))
            .collect();
        let manifest = serde_json::to_vec(&manifest).unwrap();
        let digest = format!("{:x}", Sha256::digest(&manifest));
        let generation = self.root.join("lib/runtimes").join(&digest);
        for (path, bytes) in files {
            let destination = generation.join(&path);
            fs::create_dir_all(destination.parent().unwrap()).unwrap();
            fs::write(&destination, bytes).unwrap();
            fs::set_permissions(
                &destination,
                fs::Permissions::from_mode(if path.starts_with("native/") {
                    0o755
                } else {
                    0o644
                }),
            )
            .unwrap();
        }
        fs::write(generation.join("manifest.json"), manifest).unwrap();
        fs::create_dir_all(self.root.join("state")).unwrap();
        fs::write(
            self.root.join("state/adapter-runtime.json"),
            serde_json::to_vec(&serde_json::json!({
                "version":1,"digest":digest,"previous_digest":null
            }))
            .unwrap(),
        )
        .unwrap();
    }
    fn spawn(&self, event: &str, describe: bool) -> Running {
        self.spawn_with_stdin(event, describe, Stdio::piped())
    }
    fn spawn_with_stdin(&self, event: &str, describe: bool, stdin: Stdio) -> Running {
        let mut args = vec!["codex", event, "--system"];
        if describe {
            args.push("--describe");
        }
        let started = Instant::now();
        let mut child = Command::new(env!("CARGO_BIN_EXE_caws-hook-native"))
            .args(&args)
            .env("CAWS_HOME", &self.root)
            .env("CAWS_COMPATIBILITY_WITNESS", &self.root)
            .env("CAWS_COMPATIBILITY_CONTEXT", "spaces and unicode: café")
            .current_dir(&self.root)
            .stdin(stdin)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take();
        let output = child.stdout.take().unwrap();
        let error = child.stderr.take().unwrap();
        for fd in [
            input.as_ref().map(AsRawFd::as_raw_fd),
            Some(output.as_raw_fd()),
            Some(error.as_raw_fd()),
        ]
        .into_iter()
        .flatten()
        {
            let old = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            assert!(old >= 0);
            assert_eq!(
                unsafe { libc::fcntl(fd, libc::F_SETFL, old | libc::O_NONBLOCK) },
                0
            );
        }
        fs::write(self.root.join("invocation.json"), serde_json::to_vec_pretty(&serde_json::json!({
            "binary":env!("CARGO_BIN_EXE_caws-hook-native"),
            "binary_sha256":format!("{:x}",Sha256::digest(fs::read(env!("CARGO_BIN_EXE_caws-hook-native")).unwrap())),
            "argv":args,"foreground_pid":child.id(),"cwd":self.root,"machine_home":self.root
        })).unwrap()).unwrap();
        Running {
            child,
            input,
            output,
            error,
            stdout: Vec::new(),
            stderr: Vec::new(),
            out_eof: false,
            err_eof: false,
            started,
            finished: false,
        }
    }
    fn witness(&self, name: &str) -> serde_json::Value {
        serde_json::from_slice(&fs::read(self.root.join(format!("{name}.json"))).unwrap()).unwrap()
    }
    fn sample(&self, name: &str) -> Vec<Process> {
        let output = Command::new("/bin/ps")
            .args(["-axo", "pid=,ppid=,pgid=,stat="])
            .output()
            .unwrap();
        fs::write(self.root.join(format!("{name}.ps.txt")), &output.stdout).unwrap();
        assert!(output.status.success(), "ps failed: {:?}", output.stderr);
        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(|line| {
                let columns: Vec<_> = line.split_whitespace().collect();
                assert_eq!(columns.len(), 4, "incomplete ps row: {line}");
                Process {
                    pid: columns[0].parse().unwrap(),
                    ppid: columns[1].parse().unwrap(),
                    pgid: columns[2].parse().unwrap(),
                    state: columns[3].into(),
                }
            })
            .collect()
    }
    fn record(&self, result: &ResultRecord) {
        fs::write(self.root.join("stdout.bin"), &result.stdout).unwrap();
        fs::write(self.root.join("stderr.bin"), &result.stderr).unwrap();
        fs::write(self.root.join("result.json"), serde_json::to_vec_pretty(&serde_json::json!({
            "exit_code":result.status.code(),"elapsed_ms":result.elapsed.as_millis(),"watchdog_fired":result.watchdog,
            "stdout_eof":result.out_eof,"stderr_eof":result.err_eof,"input_bytes_written":result.input_bytes
        })).unwrap()).unwrap();
        self.sample("after-foreground");
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if !self.retain && !std::thread::panicking() {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}
struct Process {
    pid: u32,
    ppid: u32,
    pgid: u32,
    state: String,
}
struct ResultRecord {
    status: ExitStatus,
    elapsed: Duration,
    watchdog: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    out_eof: bool,
    err_eof: bool,
    input_bytes: usize,
}
struct Running {
    child: Child,
    input: Option<ChildStdin>,
    output: ChildStdout,
    error: ChildStderr,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    out_eof: bool,
    err_eof: bool,
    started: Instant,
    finished: bool,
}
fn drain(reader: &mut impl Read, bytes: &mut Vec<u8>) -> bool {
    let mut chunk = [0; 8192];
    // Bound every pump turn, including a producer that writes continuously.
    for _ in 0..32 {
        match reader.read(&mut chunk) {
            Ok(0) => return true,
            Ok(length) => bytes.extend_from_slice(&chunk[..length]),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return false,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => panic!("pipe read failed: {error}"),
        }
    }
    false
}
impl Running {
    fn observe_custody_without_reading_output(&self, fixture: &Fixture) {
        let until = Instant::now() + Duration::from_secs(1);
        while !fixture.root.join("started.json").exists() && Instant::now() < until {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(
            fixture.root.join("started.json").exists(),
            "fixture did not start"
        );
        let witness = fixture.witness("started");
        let selected = witness["pid"].as_u64().unwrap() as u32;
        let worker = witness["ppid"].as_u64().unwrap() as u32;
        assert_ne!(worker, self.child.id());
        assert_eq!(witness["pgid"], selected);
        let sample = fixture.sample("before-backpressure-exit");
        assert!(sample.iter().any(|process| process.pid == selected
            && process.ppid == worker
            && process.pgid == selected
            && !process.state.starts_with('Z')));
        assert!(
            sample
                .iter()
                .any(|process| process.pid == worker && process.ppid == self.child.id())
        );
    }
    fn wait_for_witness(&mut self, fixture: &Fixture, name: &str) {
        let until = Instant::now() + Duration::from_secs(2);
        while !fixture.root.join(format!("{name}.json")).exists() && Instant::now() < until {
            self.out_eof |= drain(&mut self.output, &mut self.stdout);
            self.err_eof |= drain(&mut self.error, &mut self.stderr);
            thread::sleep(Duration::from_millis(5));
        }
        assert!(
            fixture.root.join(format!("{name}.json")).exists(),
            "fixture did not reach {name}"
        );
    }
    fn wait_for_stdout(&mut self, expected: &[u8]) {
        let until = Instant::now() + Duration::from_secs(2);
        while self.stdout.len() < expected.len() && Instant::now() < until {
            self.out_eof |= drain(&mut self.output, &mut self.stdout);
            self.err_eof |= drain(&mut self.error, &mut self.stderr);
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            self.stdout, expected,
            "partial output must reach the caller before cancellation"
        );
    }
    fn finish(
        mut self,
        fixture: &Fixture,
        input: Option<&[u8]>,
        drain_output: bool,
        drain_error: bool,
        limit: Duration,
    ) -> ResultRecord {
        let mut written = 0;
        let mut watchdog = false;
        let status = loop {
            if let Some(bytes) = input {
                if written == bytes.len() {
                    self.input.take();
                } else if let Some(pipe) = &mut self.input {
                    match pipe.write(&bytes[written..bytes.len().min(written + 8192)]) {
                        Ok(count) => written += count,
                        Err(error)
                            if matches!(
                                error.kind(),
                                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                            ) =>
                        {
                            ()
                        }
                        Err(error) => panic!("input delivery failed: {error}"),
                    }
                }
            }
            if drain_output {
                self.out_eof |= drain(&mut self.output, &mut self.stdout);
            }
            if drain_error {
                self.err_eof |= drain(&mut self.error, &mut self.stderr);
            }
            if let Some(status) = self.child.try_wait().unwrap() {
                break status;
            }
            if self.started.elapsed() >= limit {
                watchdog = true;
                // This is our actual unreaped direct Child, never a PID recovered from a file.
                self.child.kill().unwrap();
                let cleanup = Instant::now() + Duration::from_secs(1);
                let status = loop {
                    if let Some(status) = self.child.try_wait().unwrap() {
                        break status;
                    }
                    assert!(
                        Instant::now() < cleanup,
                        "direct foreground child did not stop"
                    );
                    thread::sleep(Duration::from_millis(5));
                };
                break status;
            }
            thread::sleep(Duration::from_millis(5));
        };
        let elapsed = self.started.elapsed();
        self.finished = true;
        self.input.take();
        // Foreground termination must also release the harness-facing descriptors.
        // A worker retaining these pipes cannot hang this collector.
        let until = Instant::now() + Duration::from_millis(250);
        while !(self.out_eof && self.err_eof) && Instant::now() < until {
            self.out_eof |= drain(&mut self.output, &mut self.stdout);
            self.err_eof |= drain(&mut self.error, &mut self.stderr);
            thread::sleep(Duration::from_millis(5));
        }
        let result = ResultRecord {
            status,
            elapsed,
            watchdog,
            stdout: std::mem::take(&mut self.stdout),
            stderr: std::mem::take(&mut self.stderr),
            out_eof: self.out_eof,
            err_eof: self.err_eof,
            input_bytes: written,
        };
        fixture.record(&result);
        assert!(
            !result.watchdog,
            "external test watchdog fired; artifacts: {}",
            fixture.root.display()
        );
        assert!(
            result.out_eof && result.err_eof,
            "host output descriptions survived foreground exit; artifacts: {}",
            fixture.root.display()
        );
        result
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        if !self.finished {
            // On assertion failure, cancel only the direct child whose handle we own.
            // The fixture's alarm bounds its own lifetime; no observed PID is killed.
            let _ = self.child.kill();
            let until = Instant::now() + Duration::from_secs(1);
            while Instant::now() < until {
                if self.child.try_wait().ok().flatten().is_some() {
                    break;
                }
                thread::sleep(Duration::from_millis(5));
            }
        }
    }
}
fn expect_code(result: &ResultRecord, code: i32) {
    assert_eq!(result.status.code(), Some(code));
}
fn assert_no_synthesized_stdout(result: &ResultRecord, expected: &[u8]) {
    assert_eq!(result.stdout, expected);
}

#[test]
fn legacy_natural_nonzero_codes_and_original_argv_are_preserved() {
    for code in [1, 2, 37, 143, 255] {
        let fixture = Fixture::new(&format!("legacy-code-{code}"));
        fixture.install(&format!("witness('started', argv=sys.argv[1:])\nos.write(1,b'partial\\x00\\xff')\nos.write(2,b'fixture stderr\\n')\nsys.exit({code})"), false);
        let result = fixture.spawn("pre_tool_use", false).finish(
            &fixture,
            Some(b""),
            true,
            true,
            FAST_LIMIT,
        );
        expect_code(&result, code);
        assert_no_synthesized_stdout(&result, b"partial\x00\xff");
        assert_eq!(result.stderr, b"fixture stderr\n");
        assert_eq!(
            fixture.witness("started")["argv"],
            serde_json::json!(["codex", "pre_tool_use", "--system"])
        );
    }
}

#[test]
fn describe_natural_nonzero_codes_are_preserved_without_native_or_legacy_retry() {
    for code in [1, 2, 37, 143, 255] {
        let fixture = Fixture::new(&format!("describe-code-{code}"));
        fixture.install(&format!("witness('started', argv=sys.argv[1:])\nos.write(1,b'describe partial\\n')\nsys.exit({code})"),true);
        let result =
            fixture
                .spawn("stop", true)
                .finish(&fixture, Some(b""), true, true, FAST_LIMIT);
        expect_code(&result, code);
        assert_no_synthesized_stdout(&result, b"describe partial\n");
        assert!(result.stderr.is_empty());
        let argv = fixture.witness("started")["argv"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(argv.len(), 9);
        assert!(argv[0].as_str().unwrap().ends_with("/describe.js"));
        assert_eq!(argv[1], "--surface");
        assert_eq!(argv[2], "codex");
        assert_eq!(argv[3], "--event");
        assert_eq!(argv[4], "stop");
        let pointer: serde_json::Value = serde_json::from_slice(
            &fs::read(fixture.root.join("state/adapter-runtime.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(argv[5], "--runtime-digest");
        assert_eq!(argv[6], pointer["digest"]);
        assert_eq!(argv[7], "--configuration");
        assert_eq!(argv[8], "system");
    }
}

#[test]
fn describe_configuration_fault_is_an_error_without_child_output() {
    let fixture = Fixture::new("describe-configuration-fault");
    let result = fixture
        .spawn("stop", true)
        .finish(&fixture, Some(b""), true, true, FAST_LIMIT);
    expect_code(&result, 2);
    assert!(result.stdout.is_empty());
    assert!(String::from_utf8_lossy(&result.stderr).contains("CAWS native installed entry"));
    assert!(!fixture.root.join("started.json").exists());
}

#[test]
fn legacy_stdin_raw_bytes_eof_cwd_and_environment_reach_selected_child() {
    let fixture = Fixture::new("raw-context");
    fixture.install("witness('started', cwd=os.getcwd(), context=os.environ['CAWS_COMPATIBILITY_CONTEXT'])\nraw=sys.stdin.buffer.read()\n(w/'stdin.bin').write_bytes(raw)\nwitness('eof', bytes=len(raw))\nos.write(1,raw)\nos.write(2,b'raw stderr\\x00\\xfe')",false);
    let input: Vec<u8> = (0..200_000).map(|index| (index % 256) as u8).collect();
    let result =
        fixture
            .spawn("stop", false)
            .finish(&fixture, Some(&input), true, true, FAST_LIMIT);
    expect_code(&result, 0);
    assert_eq!(result.input_bytes, input.len());
    assert_eq!(result.stdout, input);
    assert_eq!(fs::read(fixture.root.join("stdin.bin")).unwrap(), input);
    assert_eq!(result.stderr, b"raw stderr\x00\xfe");
    assert_eq!(fixture.witness("eof")["bytes"], input.len());
    assert_eq!(
        fixture.witness("started")["cwd"],
        fixture.root.to_str().unwrap()
    );
    assert_eq!(
        fixture.witness("started")["context"],
        "spaces and unicode: café"
    );
}

#[test]
fn raw_signal_uses_event_fault_policy_and_does_not_append_block_json() {
    for event in EVENTS {
        let fixture = Fixture::new(&format!("signal-{event}"));
        fixture.install("witness('started')\nos.write(1,b'partial before signal\\n')\nos.kill(os.getpid(),signal.SIGTERM)",false);
        let result =
            fixture
                .spawn(event, false)
                .finish(&fixture, Some(b""), true, true, FAST_LIMIT);
        expect_code(&result, if event == "pre_tool_use" { 2 } else { 0 });
        assert_no_synthesized_stdout(&result, b"partial before signal\n");
        let error = String::from_utf8_lossy(&result.stderr);
        assert!(
            error.contains("signal") && error.contains("15"),
            "missing raw signal diagnostic: {error}"
        );
        assert!(error.len() <= 1024, "unbounded signal diagnostic");
    }
    let fixture = Fixture::new("describe-signal");
    fixture.install("witness('started')\nos.write(1,b'describe partial\\n')\nos.kill(os.getpid(),signal.SIGTERM)",true);
    let result = fixture
        .spawn("stop", true)
        .finish(&fixture, Some(b""), true, true, FAST_LIMIT);
    expect_code(&result, 2);
    assert_no_synthesized_stdout(&result, b"describe partial\n");
    let error = String::from_utf8_lossy(&result.stderr);
    assert!(
        error.contains("signal") && error.contains("15"),
        "missing raw signal diagnostic: {error}"
    );
}

#[test]
fn describe_does_not_consume_unread_caller_stdin() {
    let fixture = Fixture::new("describe-preserves-caller-stdin");
    // The selected description process never reads fd 0. Its short finite wait
    // leaves the foreground pump time to expose an accidental read of host stdin.
    fixture.install("witness('started')\ntime.sleep(0.15)\nos.write(1,b'DESCRIBE WITHOUT STDIN\\n')\nsys.exit(37)", true);
    let sentinel = b"caller-owned describe input\x00\xff\n";
    fs::write(fixture.root.join("stdin-sent.bin"), sentinel).unwrap();
    let (mut caller_reader, mut source_writer) = UnixStream::pair().unwrap();
    caller_reader.set_nonblocking(true).unwrap();
    source_writer.set_nonblocking(true).unwrap();
    source_writer.write_all(sentinel).unwrap();
    drop(source_writer);
    let child_stdin: OwnedFd = caller_reader.try_clone().unwrap().into();
    let running = fixture.spawn_with_stdin("stop", true, Stdio::from(child_stdin));
    // Preserve the remaining-input evidence even if the foreground collector
    // reports a timeout or a harness-output descriptor that survived termination.
    let completed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        running.finish(&fixture, None, true, true, FAST_LIMIT)
    }));
    let started = Instant::now();
    let until = started + Duration::from_millis(200);
    let mut remaining = Vec::new();
    let mut eof = false;
    let mut read_error = None;
    let mut bytes = [0; 1024];
    while Instant::now() < until {
        match caller_reader.read(&mut bytes) {
            Ok(0) => {
                eof = true;
                break;
            }
            Ok(length) => remaining.extend_from_slice(&bytes[..length]),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(5));
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => (),
            Err(error) => {
                read_error = Some(error.to_string());
                break;
            }
        }
    }
    fs::write(fixture.root.join("stdin-remaining.bin"), &remaining).unwrap();
    fs::write(
        fixture.root.join("stdin-preservation.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "sent_bytes":sentinel.len(), "remaining_bytes":remaining.len(), "eof":eof,
            "read_elapsed_ms":started.elapsed().as_millis(), "read_error":read_error,
        }))
        .unwrap(),
    )
    .unwrap();
    let result = completed.unwrap_or_else(|panic| std::panic::resume_unwind(panic));
    expect_code(&result, 37);
    assert_no_synthesized_stdout(&result, b"DESCRIBE WITHOUT STDIN\n");
    assert!(result.stderr.is_empty());
    assert!(fixture.root.join("started.json").exists());
    assert!(
        read_error.is_none(),
        "caller input observation failed: {read_error:?}"
    );
    assert!(
        eof,
        "caller input observation did not reach EOF within its bound"
    );
    assert_eq!(
        remaining,
        sentinel,
        "describe consumed caller-owned stdin; artifacts: {}",
        fixture.root.display()
    );
}

#[test]
fn describe_pending_stdin_is_bounded_by_selected_timeout() {
    let fixture = Fixture::new("pending-stdin");
    fixture.install(
        "witness('started')\nsys.stdin.buffer.read()\nwitness('unexpected-eof')",
        true,
    );
    // None deliberately leaves the test's stdin writer open and sends no bytes.
    let result = fixture
        .spawn("stop", true)
        .finish(&fixture, None, true, true, FAST_LIMIT);
    expect_code(&result, 2);
    assert!(result.stdout.is_empty());
    assert!(fixture.root.join("started.json").exists());
    assert!(!fixture.root.join("unexpected-eof.json").exists());
    assert!(result.elapsed < Duration::from_millis(DESCRIBE_MS + 700));
}

#[test]
fn describe_stdout_and_stderr_backpressure_cannot_hold_foreground_past_deadline() {
    for fd in [1, 2] {
        let fixture = Fixture::new(&format!("backpressure-{fd}"));
        fixture.install(&format!("witness('started')\nfor index in range(1024):\n    os.write({fd},b'x'*8192)\nwitness('unexpected-completion')"),true);
        let running = fixture.spawn("stop", true);
        running.observe_custody_without_reading_output(&fixture);
        let result = running.finish(&fixture, Some(b""), fd != 1, fd != 2, FAST_LIMIT);
        expect_code(&result, 2);
        let blocked = if fd == 1 {
            &result.stdout
        } else {
            &result.stderr
        };
        assert!(!blocked.is_empty(), "fixture produced no bytes");
        assert!(
            blocked.iter().all(|byte| *byte == b'x'),
            "unexpected synthesized bytes on blocked output"
        );
        if fd == 2 {
            assert!(result.stdout.is_empty());
        }
        assert!(!fixture.root.join("unexpected-completion.json").exists());
        assert!(result.elapsed < Duration::from_millis(DESCRIBE_MS + 700));
    }
}

#[test]
fn describe_foreground_cancellation_preserves_partial_stdout_and_observed_custody() {
    let fixture = Fixture::new("cancel");
    fixture.install(
        "witness('started')\nos.write(1,b'before cancel\\n')\ntime.sleep(4)",
        true,
    );
    let mut running = fixture.spawn("stop", true);
    let foreground = running.child.id();
    running.wait_for_witness(&fixture, "started");
    running.wait_for_stdout(b"before cancel\n");
    let witness = fixture.witness("started");
    let selected = witness["pid"].as_u64().unwrap() as u32;
    let worker = witness["ppid"].as_u64().unwrap() as u32;
    assert_ne!(worker, foreground);
    assert_eq!(witness["pgid"], selected);
    let before = fixture.sample("before-cancel");
    assert!(before.iter().any(|process| process.pid == selected
        && process.ppid == worker
        && process.pgid == selected
        && !process.state.starts_with('Z')));
    assert!(
        before
            .iter()
            .any(|process| process.pid == worker && process.ppid == foreground)
    );
    // Signal only the unreaped foreground Child held directly by this test.
    assert_eq!(
        unsafe { libc::kill(running.child.id() as i32, libc::SIGTERM) },
        0
    );
    let result = running.finish(&fixture, Some(b""), true, true, FAST_LIMIT);
    expect_code(&result, 2);
    assert_no_synthesized_stdout(&result, b"before cancel\n");
    assert!(String::from_utf8_lossy(&result.stderr).contains("delivery incomplete"));
    assert!(result.elapsed < Duration::from_millis(DESCRIBE_MS + 700));
}

#[test]
fn describe_exited_leader_with_live_pipe_holder_cannot_leak_late_output() {
    let fixture = Fixture::new("pipe-holder");
    fixture.install("read_fd,write_fd=os.pipe()\npid=os.fork()\nif pid==0:\n    os.close(read_fd)\n    witness('holder')\n    os.write(write_fd,b'R')\n    os.close(write_fd)\n    time.sleep(3)\n    os.write(1,b'LATE HOLDER OUTPUT\\n')\n    os._exit(0)\nos.close(write_fd)\nassert os.read(read_fd,1)==b'R'\nos.close(read_fd)\nwitness('leader',holder=pid)\nos.write(1,b'LEADER OUTPUT\\n')\nos._exit(37)",true);
    let result = fixture
        .spawn("stop", true)
        .finish(&fixture, Some(b""), true, true, FAST_LIMIT);
    expect_code(&result, 37);
    assert_no_synthesized_stdout(&result, b"LEADER OUTPUT\n");
    let leader = fixture.witness("leader");
    let holder = fixture.witness("holder");
    assert_eq!(leader["holder"], holder["pid"]);
    assert_eq!(leader["pgid"], holder["pgid"]);
    let pgid = leader["pgid"].as_u64().unwrap() as u32;
    let after = fixture.sample("pipe-holder-after");
    assert!(
        after
            .iter()
            .filter(|process| process.pgid == pgid)
            .all(|process| process.state.starts_with('Z')),
        "sample returned a live member of the observed private group"
    );
    // This is a sampled private-group observation, not an escaped-descendant census.
    assert!(result.elapsed < Duration::from_millis(DESCRIBE_MS + 700));
}

#[test]
fn legacy_execution_uses_original_thirty_second_deadline() {
    let fixture = Fixture::new("legacy-original-deadline");
    fixture.install("signal.alarm(35)\nwitness('started')\nos.write(1,b'LEGACY STARTED\\n')\ntime.sleep(34)\nos.write(1,b'AFTER THIRTY FOUR SECONDS\\n')",false);
    let result = fixture.spawn("pre_tool_use", false).finish(
        &fixture,
        Some(b""),
        true,
        true,
        Duration::from_secs(32),
    );
    expect_code(&result, 2);
    assert_no_synthesized_stdout(&result, b"LEGACY STARTED\n");
    assert!(fixture.root.join("started.json").exists());
    assert!(
        result.elapsed >= Duration::from_secs(29),
        "legacy received a shorter budget: {:?}",
        result.elapsed
    );
    assert!(
        result.elapsed < Duration::from_millis(30_700),
        "legacy exceeded original deadline: {:?}",
        result.elapsed
    );
}
