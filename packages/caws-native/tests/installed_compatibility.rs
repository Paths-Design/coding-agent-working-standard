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
        unix::{fs::PermissionsExt, net::UnixStream, process::CommandExt},
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChildSetup {
    Inherit,
    DuplicateStdout,
    BlockSigterm,
}

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
        self.install_with_policy(body, describe, DESCRIBE_MS, 0);
    }
    fn install_with_policy(
        &self,
        body: &str,
        describe: bool,
        timeout_ms: u64,
        engine_padding: usize,
    ) {
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
            let native = if engine_padding == 0 {
                b"#!/bin/sh\nexit 77\n".to_vec()
            } else {
                b"#!/bin/sh\nprintf 'NATIVE DISPATCHED\\n' > \"$CAWS_COMPATIBILITY_WITNESS/native-started.bin\"\nexit 77\n".to_vec()
            };
            let engine = if engine_padding == 0 {
                b"throw Error('engine must not run during describe');\n".to_vec()
            } else {
                vec![b' '; engine_padding]
            };
            files.extend([
                ("native/caws-native".into(), native),
                ("native/caws-hook-native".into(), b"fixture identity only\n".to_vec()),
                ("native/node".into(), source.into_bytes()),
                ("engine.js".into(), engine),
                ("describe.js".into(), b"fixture describe argv member\n".to_vec()),
                ("native-entry.json".into(), serde_json::to_vec(&serde_json::json!({
                    "schema":"caws.runtime.native-entry.v2", "nativeExecutable":"native/caws-native",
                    "nodeExecutable":"native/node", "engineEntry":"engine.js", "describeEntry":"describe.js",
                    "timeoutMs":timeout_ms,
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
        self.spawn_with_setup(event, describe, stdin, ChildSetup::Inherit)
    }
    fn spawn_with_setup(
        &self,
        event: &str,
        describe: bool,
        stdin: Stdio,
        setup: ChildSetup,
    ) -> Running {
        let mut args = vec!["codex", event, "--system"];
        if describe {
            args.push("--describe");
        }
        let started = Instant::now();
        let mut command = Command::new(env!("CARGO_BIN_EXE_caws-hook-native"));
        command
            .args(&args)
            .env("CAWS_HOME", &self.root)
            .env("CAWS_COMPATIBILITY_WITNESS", &self.root)
            .env("CAWS_COMPATIBILITY_CONTEXT", "spaces and unicode: café")
            .current_dir(&self.root)
            .stdin(stdin)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let receipt = if setup == ChildSetup::Inherit {
            None
        } else {
            Some(fs::File::create(self.root.join("pre-exec-facts.bin")).unwrap())
        };
        if let Some(receipt) = &receipt {
            let receipt_fd = receipt.as_raw_fd();
            // These are actual child-side inherited process attributes, set
            // after Command has installed its stdout and before the stable exec.
            // The closure uses only libc operations and stack-owned values.
            unsafe {
                command.pre_exec(move || {
                    let mut facts = [libc::getpid(), 0, 0, 0];
                    match setup {
                        ChildSetup::DuplicateStdout => {
                            let alias = libc::fcntl(1, libc::F_DUPFD, 128);
                            if alias < 0 {
                                return Err(io::Error::last_os_error());
                            }
                            facts[1] = alias;
                            facts[2] = libc::fcntl(alias, libc::F_GETFD);
                            facts[3] = libc::fcntl(alias, libc::F_GETFL);
                            if facts[2] < 0 || facts[3] < 0 {
                                return Err(io::Error::last_os_error());
                            }
                        }
                        ChildSetup::BlockSigterm => {
                            let mut mask: libc::sigset_t = std::mem::zeroed();
                            if libc::sigemptyset(&mut mask) != 0
                                || libc::sigaddset(&mut mask, libc::SIGTERM) != 0
                                || libc::sigprocmask(libc::SIG_BLOCK, &mask, std::ptr::null_mut())
                                    != 0
                            {
                                return Err(io::Error::last_os_error());
                            }
                            let mut observed: libc::sigset_t = std::mem::zeroed();
                            if libc::sigprocmask(libc::SIG_BLOCK, std::ptr::null(), &mut observed)
                                != 0
                            {
                                return Err(io::Error::last_os_error());
                            }
                            facts[1] = libc::SIGTERM;
                            facts[2] = libc::sigismember(&observed, libc::SIGTERM);
                        }
                        ChildSetup::Inherit => (),
                    }
                    let size = std::mem::size_of_val(&facts);
                    if libc::write(receipt_fd, facts.as_ptr().cast(), size) != size as isize {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        let mut child = command.spawn().unwrap();
        if receipt.is_some() {
            let bytes = fs::read(self.root.join("pre-exec-facts.bin")).unwrap();
            assert_eq!(bytes.len(), 4 * std::mem::size_of::<i32>());
            let facts: Vec<_> = bytes
                .chunks_exact(4)
                .map(|bytes| i32::from_ne_bytes(bytes.try_into().unwrap()))
                .collect();
            fs::write(
                self.root.join("pre-exec-facts.json"),
                serde_json::to_vec_pretty(&serde_json::json!({
                    "setup":format!("{setup:?}"), "pid":facts[0], "descriptor_or_signal":facts[1],
                    "descriptor_flags_or_blocked":facts[2], "open_flags":facts[3],
                }))
                .unwrap(),
            )
            .unwrap();
        }
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
            "argv":args,"foreground_pid":child.id(),"cwd":self.root,"machine_home":self.root,"child_setup":format!("{setup:?}")
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
            stdout_eof_elapsed: None,
            stderr_eof_elapsed: None,
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
            "foreground_elapsed_ms":result.elapsed.as_millis(),
            "completion_elapsed_ms":result.completion_elapsed.map(|elapsed|elapsed.as_millis()),
            "foreground_exit_observed_ns":result.elapsed.as_nanos(),
            "stdout_eof_observed_ns":result.stdout_eof_elapsed.map(|elapsed|elapsed.as_nanos()),
            "stderr_eof_observed_ns":result.stderr_eof_elapsed.map(|elapsed|elapsed.as_nanos()),
            "completion_observed_ns":result.completion_elapsed.map(|elapsed|elapsed.as_nanos()),
            "process_sample_elapsed_ms":result.process_sample_elapsed.as_millis(),
            "stdout_eof":result.out_eof,"stderr_eof":result.err_eof,"input_bytes_written":result.input_bytes
        })).unwrap()).unwrap();
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
    completion_elapsed: Option<Duration>,
    stdout_eof_elapsed: Option<Duration>,
    stderr_eof_elapsed: Option<Duration>,
    process_sample_elapsed: Duration,
    processes: Vec<Process>,
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
    stdout_eof_elapsed: Option<Duration>,
    stderr_eof_elapsed: Option<Duration>,
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
    fn drain_stdout(&mut self) {
        if !self.out_eof && drain(&mut self.output, &mut self.stdout) {
            self.out_eof = true;
            self.stdout_eof_elapsed = Some(self.started.elapsed());
        }
    }
    fn drain_stderr(&mut self) {
        if !self.err_eof && drain(&mut self.error, &mut self.stderr) {
            self.err_eof = true;
            self.stderr_eof_elapsed = Some(self.started.elapsed());
        }
    }
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
            self.drain_stdout();
            self.drain_stderr();
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
            self.drain_stdout();
            self.drain_stderr();
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
                self.drain_stdout();
            }
            if drain_error {
                self.drain_stderr();
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
            self.drain_stdout();
            self.drain_stderr();
            thread::sleep(Duration::from_millis(5));
        }
        // Completion is observed only when the foreground is reaped and both
        // harness-facing streams have returned EOF. A failed collector records
        // null rather than presenting its finite collection limit as completion.
        let completion_elapsed = match (self.stdout_eof_elapsed, self.stderr_eof_elapsed) {
            (Some(stdout), Some(stderr)) => Some(elapsed.max(stdout).max(stderr)),
            _ => None,
        };
        // Take the contemporaneous process observation before persistence work.
        // These rows authorize observations only; they are never signal targets.
        let processes = fixture.sample("after-foreground");
        let process_sample_elapsed = self.started.elapsed();
        let result = ResultRecord {
            status,
            elapsed,
            completion_elapsed,
            stdout_eof_elapsed: self.stdout_eof_elapsed,
            stderr_eof_elapsed: self.stderr_eof_elapsed,
            process_sample_elapsed,
            processes,
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
fn completion_elapsed(result: &ResultRecord) -> Duration {
    result
        .completion_elapsed
        .expect("foreground exit and both output EOFs must be observed")
}
fn assert_private_group_not_live(fixture: &Fixture, result: &ResultRecord, witness: &str) {
    let selected = fixture.witness(witness);
    let pid = selected["pid"].as_u64().unwrap() as u32;
    let pgid = selected["pgid"].as_u64().unwrap() as u32;
    let worker = selected["ppid"].as_u64().unwrap() as u32;
    assert!(worker > 1 && worker != pid);
    assert_eq!(
        pgid, pid,
        "selected child must witness its own private group"
    );
    let live: Vec<_> = result
        .processes
        .iter()
        .filter(|process| {
            (process.pid == pid
                || process.pgid == pgid
                || process.pid == worker
                || process.pgid == worker)
                && !process.state.starts_with('Z')
        })
        .map(|process| {
            (
                process.pid,
                process.ppid,
                process.pgid,
                process.state.as_str(),
            )
        })
        .collect();
    assert!(
        live.is_empty(),
        "post-completion sample returned a live worker/selected/private-group member: {live:?}; artifacts: {}",
        fixture.root.display()
    );
    // Absence and zombie-only rows are bounded snapshot observations. They do
    // not prove escaped-descendant absence or independently prove the worker reap.
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
        assert_private_group_not_live(&fixture, &result, "started");
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
        assert_private_group_not_live(&fixture, &result, "started");
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
    assert_private_group_not_live(&fixture, &result, "started");
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
        assert_private_group_not_live(&fixture, &result, "started");
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
    assert_private_group_not_live(&fixture, &result, "started");
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
    assert_private_group_not_live(&fixture, &result, "started");
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
    assert!(completion_elapsed(&result) < Duration::from_millis(DESCRIBE_MS));
    assert_private_group_not_live(&fixture, &result, "started");
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
        assert!(completion_elapsed(&result) < Duration::from_millis(DESCRIBE_MS));
        assert_private_group_not_live(&fixture, &result, "started");
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
    assert!(completion_elapsed(&result) < Duration::from_millis(DESCRIBE_MS));
    assert_private_group_not_live(&fixture, &result, "started");
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
    assert!(completion_elapsed(&result) < Duration::from_millis(DESCRIBE_MS));
    assert_private_group_not_live(&fixture, &result, "leader");
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
        completion_elapsed(&result) < Duration::from_millis(30_000),
        "legacy completion exceeded original deadline: {:?}",
        completion_elapsed(&result)
    );
    assert_private_group_not_live(&fixture, &result, "started");
}

#[test]
fn inherited_stdout_alias_cannot_keep_harness_output_open_during_private_pipe_uncertainty() {
    let fixture = Fixture::new("inherited-stdout-alias");
    // Close the specifically controlled alias in the selected process itself.
    // Thus its escaped holder retains only the child's private stdio, and an
    // inherited harness alias retained by the worker is independently observable.
    fixture.install("facts=(w/'pre-exec-facts.bin').read_bytes()\nalias=int.from_bytes(facts[4:8],sys.byteorder,signed=True)\ntry:\n    os.fstat(alias)\n    alias_was_open=True\n    os.close(alias)\nexcept OSError as error:\n    if error.errno!=9:\n        raise\n    alias_was_open=False\nwitness('started',alias=alias,alias_was_open=alias_was_open)\nread_fd,write_fd=os.pipe()\npid=os.fork()\nif pid==0:\n    os.close(read_fd)\n    os.setsid()\n    witness('escaped-holder')\n    os.write(write_fd,b'R')\n    os.close(write_fd)\n    time.sleep(3)\n    os._exit(0)\nos.close(write_fd)\nassert os.read(read_fd,1)==b'R'\nos.close(read_fd)\nwitness('leader',holder=pid)\nos.write(1,b'LEADER WITH ESCAPED HOLDER\\n')\nos._exit(37)",true);
    let mut running =
        fixture.spawn_with_setup("stop", true, Stdio::piped(), ChildSetup::DuplicateStdout);
    let foreground = running.child.id();
    running.wait_for_witness(&fixture, "leader");
    let leader = fixture.witness("leader");
    let holder = fixture.witness("escaped-holder");
    let selected = leader["pid"].as_u64().unwrap() as u32;
    let worker = leader["ppid"].as_u64().unwrap() as u32;
    let holder_pid = holder["pid"].as_u64().unwrap() as u32;
    let before = fixture.sample("escaped-holder-before-foreground-exit");
    assert_eq!(leader["holder"], holder["pid"]);
    assert_eq!(holder["ppid"], selected);
    assert_eq!(holder["pgid"], holder_pid);
    assert_eq!(holder["sid"], holder_pid);
    assert_ne!(holder["pgid"], leader["pgid"]);
    assert!(before.iter().any(|process| process.pid == selected
        && process.ppid == worker
        && process.pgid == selected));
    assert!(
        before
            .iter()
            .any(|process| process.pid == worker && process.ppid == foreground)
    );
    assert!(
        before
            .iter()
            .any(|process| process.pid == holder_pid && !process.state.starts_with('Z'))
    );
    let result = running.finish(&fixture, Some(b""), true, true, FAST_LIMIT);
    expect_code(&result, 2);
    assert_no_synthesized_stdout(&result, b"LEADER WITH ESCAPED HOLDER\n");
    assert!(completion_elapsed(&result) < Duration::from_millis(DESCRIBE_MS));
    let inherited = fixture.witness("pre-exec-facts");
    assert_eq!(inherited["pid"], foreground);
    assert_eq!(inherited["setup"], "DuplicateStdout");
    let alias = inherited["descriptor_or_signal"].as_i64().unwrap();
    assert!(alias >= 128);
    assert_eq!(
        inherited["descriptor_flags_or_blocked"].as_i64().unwrap() & i64::from(libc::FD_CLOEXEC),
        0
    );
    assert_eq!(fixture.witness("started")["alias"], alias);
    assert_eq!(fixture.witness("started")["alias_was_open"], false);
    let after = fixture.sample("escaped-holder-after-foreground-exit");
    assert!(
        after.iter().any(|process| process.pid == holder_pid
            && process.pgid == holder_pid
            && !process.state.starts_with('Z')),
        "the private pipe holder must remain live when harness output EOF is observed"
    );
    assert!(
        result
            .processes
            .iter()
            .any(|process| process.pid == worker && !process.state.starts_with('Z')),
        "uncertain private-pipe custody must retain a live worker at host completion"
    );
    assert!(
        result
            .processes
            .iter()
            .any(|process| process.pid == selected
                && process.ppid == worker
                && process.pgid == selected
                && process.state.starts_with('Z')),
        "the worker must retain the exited actual child while its private pipes remain held"
    );
    assert!(
        result
            .processes
            .iter()
            .any(|process| process.pid == holder_pid
                && process.pgid == holder_pid
                && !process.state.starts_with('Z')),
        "the escaped private-pipe holder must be live in the completion sample"
    );
    // This is the deliberately uncertain case. Host completion is bounded, but
    // no universal descendant cutoff, worker-exit or cleanup completion is claimed.
    // The holder self-expires after three seconds. It is outside the original
    // private group; this test neither signals it nor claims it has been cleaned.
}

#[test]
fn inherited_blocked_sigterm_does_not_delay_foreground_cancellation_until_expiry() {
    let fixture = Fixture::new("inherited-blocked-sigterm");
    fixture.install(
        "witness('started')\nos.write(1,b'BEFORE MASKED TERM\\n')\ntime.sleep(4)",
        true,
    );
    let mut running =
        fixture.spawn_with_setup("stop", true, Stdio::piped(), ChildSetup::BlockSigterm);
    let foreground = running.child.id();
    running.wait_for_witness(&fixture, "started");
    running.wait_for_stdout(b"BEFORE MASKED TERM\n");
    fixture.sample("before-masked-term");
    let inherited = fixture.witness("pre-exec-facts");
    assert_eq!(inherited["pid"], foreground);
    assert_eq!(inherited["setup"], "BlockSigterm");
    assert_eq!(inherited["descriptor_or_signal"], libc::SIGTERM);
    assert_eq!(inherited["descriptor_flags_or_blocked"], 1);
    let signal_started = Instant::now();
    let signal_result = unsafe { libc::kill(running.child.id() as i32, libc::SIGTERM) };
    fs::write(
        fixture.root.join("signal-sent.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "foreground_pid":foreground, "signal":libc::SIGTERM, "result":signal_result,
            "elapsed_before_signal_ms":running.started.elapsed().as_millis(),
        }))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(signal_result, 0);
    let result = running.finish(&fixture, Some(b""), true, true, FAST_LIMIT);
    let cancellation_elapsed = signal_started.elapsed();
    fs::write(fixture.root.join("signal-observed.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "foreground_exit_code":result.status.code(), "cancellation_elapsed_ms":cancellation_elapsed.as_millis(),
    })).unwrap()).unwrap();
    expect_code(&result, 2);
    assert_no_synthesized_stdout(&result, b"BEFORE MASKED TERM\n");
    assert!(String::from_utf8_lossy(&result.stderr).contains("raw signal 15"));
    assert!(
        cancellation_elapsed < Duration::from_millis(500),
        "blocked inherited SIGTERM was not handled promptly: {cancellation_elapsed:?}"
    );
    assert!(completion_elapsed(&result) < Duration::from_millis(DESCRIBE_MS));
    assert_private_group_not_live(&fixture, &result, "started");
}

#[test]
fn selected_policy_expiry_during_generation_verification_does_not_borrow_original_delivery_time() {
    const PADDING: usize = 32 * 1024 * 1024;
    for (event, describe, expected) in [
        ("pre_tool_use", false, 2),
        ("stop", false, 0),
        ("stop", true, 2),
    ] {
        let fixture = Fixture::new(&format!("selection-expiry-{event}-{describe}"));
        // Always install a native generation. The engine is a valid declared
        // whitespace member; its full hash precedes selected-policy derivation.
        fixture.install_with_policy("witness('started')\nsys.exit(76)", true, 1, PADDING);
        fs::write(
            fixture.root.join("selection-policy.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "timeout_ms":1, "declared_engine_padding_bytes":PADDING,
                "event":event, "describe":describe, "expected_code":expected,
            }))
            .unwrap(),
        )
        .unwrap();
        let result =
            fixture
                .spawn(event, describe)
                .finish(&fixture, Some(b""), true, true, FAST_LIMIT);
        expect_code(&result, expected);
        assert!(
            result.stdout.is_empty(),
            "expired selected policy authorized stdout delivery"
        );
        assert!(
            result.stderr.is_empty(),
            "original clock authorized diagnostics after selected policy expired"
        );
        assert!(!fixture.root.join("started.json").exists());
        assert!(!fixture.root.join("native-started.bin").exists());
        assert!(result.elapsed > Duration::from_millis(1));
        assert!(completion_elapsed(&result) < Duration::from_secs(30));
    }
    // This fixture requires actual verification to consume the 1ms budget on the
    // executing host. Without phase instrumentation, wall time alone cannot prove
    // the precise internal expiry checkpoint on arbitrarily faster hardware.
}

#[test]
fn spontaneously_signalled_child_drains_produced_bytes_after_mild_reader_delay() {
    const PAYLOAD: usize = 128 * 1024;
    let fixture = Fixture::new("signalled-buffered-output");
    let expected_stdout: Vec<u8> = (0..PAYLOAD).map(|index| (index % 256) as u8).collect();
    let stderr_payload: Vec<u8> = (0..PAYLOAD)
        .map(|index| (255 - index % 256) as u8)
        .collect();
    fs::write(fixture.root.join("stdout-produced.bin"), &expected_stdout).unwrap();
    fs::write(fixture.root.join("stderr-produced.bin"), &stderr_payload).unwrap();
    // Each returned write count witnesses bytes accepted by the actual private
    // output pipe. Signal only after both complete writes, without a harness
    // signal or a production test switch. Both payloads exceed a forwarding turn.
    fixture.install("witness('started')\nstdout_payload=bytes(range(256))*512\nstderr_payload=bytes(reversed(range(256)))*512\ndef produce(fd,payload):\n    written=0\n    while written<len(payload):\n        count=os.write(fd,payload[written:])\n        assert count>0\n        written+=count\n    return written\nstdout_bytes=produce(1,stdout_payload)\nstderr_bytes=produce(2,stderr_payload)\nwitness('produced',stdout_bytes=stdout_bytes,stderr_bytes=stderr_bytes)\nos.kill(os.getpid(),signal.SIGTERM)",true);
    let running = fixture.spawn("stop", true);
    // Observe the actual selected child without draining either output pipe.
    // A finite self-signalling child may already be exited when ps can sample it;
    // the started witness supplies this phase boundary without a live-ps guard.
    let start_until = running.started + Duration::from_secs(1);
    while !fixture.root.join("started.json").exists() && Instant::now() < start_until {
        thread::sleep(Duration::from_millis(5));
    }
    let started_before_reading = fixture.root.join("started.json").exists();
    let child_start_observed = Instant::now();
    let child_start_observed_elapsed = running.started.elapsed();
    // Withhold both readers briefly from this observed phase, independently of
    // executable startup latency. Payload and selected timeout remain unchanged.
    let hold_until = child_start_observed + Duration::from_millis(100);
    while started_before_reading && Instant::now() < hold_until {
        thread::sleep(Duration::from_millis(5));
    }
    let witness_until = child_start_observed + Duration::from_millis(250);
    while started_before_reading
        && !fixture.root.join("produced.json").exists()
        && Instant::now() < witness_until
    {
        thread::sleep(Duration::from_millis(5));
    }
    let produced_before_reading = fixture.root.join("produced.json").exists();
    let mut stdout_queued: libc::c_int = 0;
    let mut stderr_queued: libc::c_int = 0;
    let stdout_query = unsafe {
        libc::ioctl(
            running.output.as_raw_fd(),
            libc::FIONREAD,
            &mut stdout_queued,
        )
    };
    let stdout_errno = if stdout_query == 0 {
        None
    } else {
        io::Error::last_os_error().raw_os_error()
    };
    let stderr_query = unsafe {
        libc::ioctl(
            running.error.as_raw_fd(),
            libc::FIONREAD,
            &mut stderr_queued,
        )
    };
    let stderr_errno = if stderr_query == 0 {
        None
    } else {
        io::Error::last_os_error().raw_os_error()
    };
    let pressure_observed = running.started.elapsed();
    let pressure_since_child_observation = child_start_observed.elapsed();
    fs::write(fixture.root.join("reader-pressure.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "started_before_reading":started_before_reading,
        "child_start_observed_elapsed_ms":started_before_reading.then_some(child_start_observed_elapsed.as_millis()),
        "produced_before_reading":produced_before_reading, "payload_bytes_per_stream":PAYLOAD,
        "reader_probe_since_child_observation_ms":started_before_reading.then_some(pressure_since_child_observation.as_millis()),
        "reader_probe_elapsed_ms":pressure_observed.as_millis(), "stdout_host_queued_bytes":stdout_queued,
        "stderr_host_queued_bytes":stderr_queued, "stdout_query_result":stdout_query,
        "stderr_query_result":stderr_query,"stdout_errno":stdout_errno,"stderr_errno":stderr_errno,
    })).unwrap()).unwrap();
    let reader_delay = running.started.elapsed();
    let reader_delay_since_child_observation = child_start_observed.elapsed();
    let result = running.finish(&fixture, Some(b""), true, true, FAST_LIMIT);
    fs::write(
        fixture.root.join("reader-start.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "reader_pump_start_elapsed_ms":reader_delay.as_millis(),
            "child_start_observed_elapsed_ms":started_before_reading.then_some(child_start_observed_elapsed.as_millis()),
            "reader_pump_start_since_child_observation_ms":started_before_reading.then_some(reader_delay_since_child_observation.as_millis()),
        }))
        .unwrap(),
    )
    .unwrap();
    // A missing produced witness or absent pressure is an explicit setup gap:
    // this run cannot establish sensitivity to queued-output loss on this host.
    assert!(
        started_before_reading,
        "setup gap: selected child start was not observed within its finite wait; artifacts: {}",
        fixture.root.display()
    );
    assert!(
        produced_before_reading,
        "setup gap: selected child did not complete both writes within 250ms after its start was observed; artifacts: {}",
        fixture.root.display()
    );
    assert!(
        reader_delay_since_child_observation < Duration::from_millis(300),
        "setup gap: withholding after child observation was not mild: {reader_delay_since_child_observation:?}"
    );
    assert_eq!(
        stdout_query, 0,
        "stdout pressure query failed: {stdout_errno:?}"
    );
    assert_eq!(
        stderr_query, 0,
        "stderr pressure query failed: {stderr_errno:?}"
    );
    assert!(
        stdout_queued >= 0 && (stdout_queued as usize) < PAYLOAD,
        "setup gap: no stdout bytes remained outside the harness pipe"
    );
    assert!(
        stderr_queued >= 0 && (stderr_queued as usize) < PAYLOAD,
        "setup gap: no stderr bytes remained outside the harness pipe"
    );
    let produced = fixture.witness("produced");
    assert_eq!(produced["stdout_bytes"], PAYLOAD);
    assert_eq!(produced["stderr_bytes"], PAYLOAD);
    expect_code(&result, 2);
    assert!(
        result.stdout == expected_stdout,
        "signalled child stdout changed or truncated: expected {PAYLOAD} bytes, observed {}; artifacts: {}",
        result.stdout.len(),
        fixture.root.display()
    );
    let mut expected_stderr = stderr_payload;
    expected_stderr.extend_from_slice(b"[CAWS native installed entry: delivery incomplete; compatibility child interrupted; raw signal 15]\n");
    assert!(
        result.stderr == expected_stderr,
        "signalled child stderr payload or raw-signal diagnostic changed: expected {} bytes, observed {}; artifacts: {}",
        expected_stderr.len(),
        result.stderr.len(),
        fixture.root.display()
    );
    assert!(completion_elapsed(&result) < Duration::from_millis(DESCRIBE_MS));
    assert_private_group_not_live(&fixture, &result, "started");
}
