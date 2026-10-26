//! Real frontend boundary checks. Held stdin exposes accidental payload reads;
//! these fixtures never execute a native installed callback or grant admission.
use caws_native::monotonic_deadline::{DeadlineEnvelope, MonotonicDeadline};
use serde_json::{Value, json};
use std::{
    fs,
    io::Read,
    os::unix::process::ExitStatusExt,
    path::PathBuf,
    process::{Child, Command, Output, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
};
static SERIAL: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    marker: PathBuf,
    retained: bool,
}
impl Fixture {
    fn new() -> Self {
        let parent = std::env::var_os("CAWS_NATIVE_DEADLINE_ARTIFACT_DIR");
        let retained = parent.is_some();
        let parent = parent.map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        fs::create_dir_all(&parent).unwrap();
        let root = parent.join(format!(
            "caws-installed-deadline-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let marker = root.join("engine-started");
        // /bin/sh is a test engine: even an accidental launch has no descendants.
        let quoted_marker = marker.to_str().unwrap().replace('\'', "'\\''");
        fs::write(
            root.join("engine.sh"),
            format!("printf started > '{quoted_marker}'\nexit 73\n"),
        )
        .unwrap();
        // Prove the tripwire works without inherited environment before using
        // its absence as an engine-effect observation. This is fixture setup,
        // outside the native invocation under test.
        let probe = Command::new("/bin/sh")
            .arg(root.join("engine.sh"))
            .env_clear()
            .status()
            .unwrap();
        assert_eq!(probe.code(), Some(73));
        assert_eq!(fs::read(&marker).unwrap(), b"started");
        fs::remove_file(&marker).unwrap();
        if retained {
            fs::write(
                root.join("tripwire.json"),
                json!({"fixtureProbeExitCode":probe.code(),"markerBytes":"started",
                    "scope":"fixture setup outside native invocation; environment cleared"})
                .to_string(),
            )
            .unwrap();
        }
        Self {
            root,
            marker,
            retained,
        }
    }
    fn args(&self, event: &str) -> Vec<String> {
        vec![
            "invoke-installed-v1".into(),
            "--engine".into(),
            self.root.join("engine.sh").to_str().unwrap().into(),
            "--node".into(),
            "/bin/sh".into(),
            "--surface".into(),
            "codex".into(),
            "--event".into(),
            event.into(),
            "--runtime-digest".into(),
            "a".repeat(64),
            "--timeout-ms".into(),
            "30000".into(),
            "--configuration".into(),
            "system".into(),
        ]
    }
    fn held(&self, args: &[String]) -> (Output, Duration) {
        let started = Instant::now();
        let ambient = wire(live(30_000, 0));
        let mut child = OwnedChild(
            Command::new(env!("CARGO_BIN_EXE_caws-native"))
                .args(args)
                // A plausible ambient handoff must neither rescue nor replace argv.
                .env("CAWS_NATIVE_ORIGINAL_DEADLINE", &ambient)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let input = child.0.stdin.take().unwrap(); // deliberately no bytes and no EOF
        let status = loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                break status;
            }
            if started.elapsed() >= Duration::from_secs(5) {
                if self.retained {
                    fs::write(self.root.join("watchdog.json"),
                        json!({"argv":args,"elapsedMs":started.elapsed().as_secs_f64()*1000.0,
                            "observation":"frontend remains live with stdin held open; owned child cleanup follows"}).to_string()).unwrap();
                }
                panic!("frontend waited for stdin or renewed its clock");
            }
            thread::sleep(Duration::from_millis(5));
        };
        drop(input);
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        child
            .0
            .stdout
            .take()
            .unwrap()
            .read_to_end(&mut stdout)
            .unwrap();
        child
            .0
            .stderr
            .take()
            .unwrap()
            .read_to_end(&mut stderr)
            .unwrap();
        let elapsed = started.elapsed();
        if self.retained {
            let observation = self.root.join(format!(
                "observation-{}",
                SERIAL.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&observation).unwrap();
            fs::write(observation.join("stdout.bin"), &stdout).unwrap();
            fs::write(observation.join("stderr.bin"), &stderr).unwrap();
            fs::write(observation.join("result.json"), serde_json::to_vec_pretty(&json!({
                "binary":env!("CARGO_BIN_EXE_caws-native"),"argv":args,
                "exitCode":status.code(),"signal":status.signal(),
                "elapsedMs":elapsed.as_secs_f64()*1000.0,"engineMarkerPresent":self.marker.exists(),
                "stdin":"held open with no bytes until native exit",
                "environmentOverrides":{"CAWS_NATIVE_ORIGINAL_DEADLINE":ambient},
                "scope":"real frontend receiver and fixture engine; no installed entry or admission qualification"
            })).unwrap()).unwrap();
        }
        assert!(
            !self.marker.exists(),
            "engine ran before original stdin completed"
        );
        (
            Output {
                status,
                stdout,
                stderr,
            },
            elapsed,
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if !self.retained {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }
}
struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}
fn live(interval_ms: u64, consumed_ms: u64) -> DeadlineEnvelope {
    let now = MonotonicDeadline::capture(Duration::from_secs(30))
        .unwrap()
        .envelope()
        .started_ns;
    DeadlineEnvelope {
        started_ns: now - consumed_ms * 1_000_000,
        expires_ns: now + (interval_ms - consumed_ms) * 1_000_000,
    }
}
fn wire(value: DeadlineEnvelope) -> String {
    json!({"startedNs":value.started_ns.to_string(), "expiresNs":value.expires_ns.to_string(),
           "runtimeDigest":"a".repeat(64)})
    .to_string()
}
fn with_wire(mut args: Vec<String>, value: String) -> Vec<String> {
    args.extend(["--original-deadline".into(), value]);
    args
}
fn replace(value: &str, key: &str, replacement: Value) -> String {
    let mut parsed: Value = serde_json::from_str(value).unwrap();
    parsed[key] = replacement;
    parsed.to_string()
}
fn outcome(output: &Output, event: &str) {
    assert_eq!(
        output.status.code(),
        Some(if event == "pre_tool_use" { 2 } else { 0 })
    );
    if event == "pre_tool_use" {
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).unwrap()["decision"],
            "block"
        );
    } else {
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn installed_live_partial_transit_expires_before_stdin_and_reports_original_interval() {
    for event in ["pre_tool_use", "stop"] {
        let f = Fixture::new();
        // Config allows 30s; this original 10s interval has already spent 8s.
        let args = with_wire(f.args(event), wire(live(10_000, 8_000)));
        let (output, elapsed) = f.held(&args);
        outcome(&output, event);
        assert!(elapsed < Duration::from_secs(5));
        let error = String::from_utf8(output.stderr).unwrap();
        assert!(error.contains("request deadline expired"), "{error}");
        let suffix = error
            .split_once("; native progress ")
            .expect("actual execute progress")
            .1;
        let progress: Value = serde_json::Deserializer::from_str(suffix)
            .into_iter::<Value>()
            .next()
            .expect("progress JSON prefix")
            .unwrap();
        let total = progress["elapsedLocalMs"].as_u64().unwrap();
        // Reject both fresh frontend timing (~2s) and config-sized timing (~30s).
        assert!(
            (9500..20_000).contains(&total),
            "wrong original progress: {progress}"
        );
        assert_eq!(progress["phase"], "payload");
    }
}

#[test]
fn installed_invalid_handoffs_refuse_before_stdin_without_environment_rescue() {
    for event in ["pre_tool_use", "stop"] {
        let f = Fixture::new();
        let good = wire(live(30_000, 0));
        let now = live(30_000, 0).started_ns;
        let mut cases: Vec<(&str, Vec<String>)> = vec![
            ("missing", f.args(event)),
            ("malformed", with_wire(f.args(event), "{".into())),
            (
                "oversize",
                with_wire(
                    f.args(event),
                    format!("{good}{}", " ".repeat(513 - good.len())),
                ),
            ),
            (
                "unknown field",
                with_wire(f.args(event), replace(&good, "unknown", json!(true))),
            ),
            (
                "duplicate field",
                with_wire(
                    f.args(event),
                    good.replacen("{", "{\"startedNs\":\"1\",", 1),
                ),
            ),
            (
                "numeric",
                with_wire(f.args(event), replace(&good, "startedNs", json!(now))),
            ),
            (
                "binding",
                with_wire(
                    f.args(event),
                    replace(&good, "runtimeDigest", json!("b".repeat(64))),
                ),
            ),
            (
                "expired",
                with_wire(
                    f.args(event),
                    wire(DeadlineEnvelope {
                        started_ns: now - 2_000_000,
                        expires_ns: now - 1_000_000,
                    }),
                ),
            ),
            (
                "future",
                with_wire(
                    f.args(event),
                    wire(DeadlineEnvelope {
                        started_ns: now + 60_000_000_000,
                        expires_ns: now + 61_000_000_000,
                    }),
                ),
            ),
            (
                "zero interval",
                with_wire(
                    f.args(event),
                    wire(DeadlineEnvelope {
                        started_ns: now,
                        expires_ns: now,
                    }),
                ),
            ),
            (
                "reverse interval",
                with_wire(
                    f.args(event),
                    wire(DeadlineEnvelope {
                        started_ns: now,
                        expires_ns: now - 1,
                    }),
                ),
            ),
            (
                "one ns over config",
                with_wire(
                    f.args(event),
                    wire(DeadlineEnvelope {
                        started_ns: now,
                        expires_ns: now + 30_000_000_001,
                    }),
                ),
            ),
        ];
        for bad in ["", "01", "+1", "-1", "1\n", "1.0", "18446744073709551616"] {
            cases.push((
                "noncanonical",
                with_wire(f.args(event), replace(&good, "startedNs", json!(bad))),
            ));
        }
        let mut duplicate = with_wire(f.args(event), good.clone());
        duplicate.extend(["--original-deadline".into(), good.clone()]);
        cases.push(("duplicate option", duplicate));
        let mut unknown = with_wire(f.args(event), good.clone());
        unknown[1] = "--unknown".into();
        cases.push(("unknown option", unknown));
        let mut mixed = with_wire(f.args(event), good.clone());
        mixed[0] = "invoke".into();
        cases.push(("mixed direct route", mixed));
        let mut version = with_wire(f.args(event), good.clone());
        version[0] = "invoke-installed-v2".into();
        cases.push(("unknown version", version));
        let mut large = with_wire(f.args(event), good);
        large[12] = "30001".into();
        cases.push(("config ceiling", large));
        for (name, args) in cases {
            let (output, _) = f.held(&args);
            outcome(&output, event);
            assert!(!output.stderr.is_empty(), "missing diagnostic: {name}");
            assert!(
                !String::from_utf8_lossy(&output.stderr).contains("native progress"),
                "payload reached: {name}"
            );
        }
    }
}

#[test]
fn direct_invoke_retains_its_existing_clock_and_ignores_ambient_deadline() {
    let f = Fixture::new();
    let mut args = f.args("pre_tool_use");
    args[0] = "invoke".into();
    args[12] = "150".into();
    let (output, elapsed) = f.held(&args);
    outcome(&output, "pre_tool_use");
    assert!(elapsed < Duration::from_secs(5));
    let error = String::from_utf8(output.stderr).unwrap();
    assert!(error.contains("request deadline expired"), "{error}");
    assert!(
        error.contains("native progress"),
        "ordinary execute did not run: {error}"
    );
}
