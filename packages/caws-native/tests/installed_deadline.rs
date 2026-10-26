//! Real frontend boundary checks. Held stdin exposes accidental payload reads;
//! these fixtures never execute a native installed callback or grant admission.
use caws_native::monotonic_deadline::{DeadlineEnvelope, MonotonicDeadline};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    os::unix::{fs::PermissionsExt, process::ExitStatusExt},
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

const INVOKE_EVENTS: [&str; 6] = [
    "pre_tool_use",
    "post_tool_use",
    "session_start",
    "stop",
    "pre_compact",
    "session_end",
];

fn installed_entry() -> Value {
    json!({
        "schema":"caws.runtime.native-entry.v2",
        "nativeExecutable":"native/caws-native",
        "nodeExecutable":"native/node",
        "engineEntry":"engine.js", "describeEntry":"describe.js", "timeoutMs":30000,
        "installedInvocation":{"protocol":"invoke-installed-v1","maxOriginalTimeoutMs":30000},
    })
}

// The actual frontend runs from its exact admitted generation. The pinned
// script adapter is only the Node tripwire: it writes a marker and emits no
// protocol. This fixture does not qualify a production Node image.
struct PublishedFixture {
    fixture: Fixture,
    home: PathBuf,
    runtime: PathBuf,
    digest: String,
}
impl PublishedFixture {
    fn new(entry: Option<Value>) -> Self {
        use sha2::{Digest, Sha256};
        use std::collections::BTreeMap;
        let fixture = Fixture::new();
        let home = fixture.root.join("home");
        let stage = home.join("lib/runtimes/stage");
        fs::create_dir_all(stage.join("native")).unwrap();
        let mut bodies = BTreeMap::from([
            (
                "launcher.py".to_owned(),
                b"legacy fixture identity\n".to_vec(),
            ),
            (
                "native/caws-native".into(),
                fs::read(env!("CARGO_BIN_EXE_caws-native")).unwrap(),
            ),
            (
                "native/caws-hook-native".into(),
                b"stable entry fixture identity\n".to_vec(),
            ),
            (
                "native/node".into(),
                b"#!/bin/sh\nexec /bin/sh \"$@\"\n".to_vec(),
            ),
            (
                "engine.js".into(),
                fs::read(fixture.root.join("engine.sh")).unwrap(),
            ),
            (
                "describe.js".into(),
                b"fixture describe identity\n".to_vec(),
            ),
        ]);
        if let Some(entry) = entry {
            bodies.insert(
                "native-entry.json".into(),
                serde_json::to_vec(&entry).unwrap(),
            );
        } else {
            // The legacy classification requires an authenticated bootstrap.
            // It remains inert; this control must reach installed admission.
            bodies.insert(
                "bootstrap.py".into(),
                b"legacy bootstrap fixture identity\n".to_vec(),
            );
        }
        bodies.insert("native-modes.json".into(), Vec::new());
        let modes: BTreeMap<_, _> = bodies
            .keys()
            .map(|name| {
                (
                    name.clone(),
                    if name.starts_with("native/") {
                        0o755
                    } else {
                        0o644
                    },
                )
            })
            .collect();
        bodies.insert(
            "native-modes.json".into(),
            serde_json::to_vec(&modes).unwrap(),
        );
        let mut manifest = BTreeMap::new();
        for (name, bytes) in bodies {
            fs::write(stage.join(&name), &bytes).unwrap();
            fs::set_permissions(stage.join(&name), fs::Permissions::from_mode(modes[&name]))
                .unwrap();
            manifest.insert(name, format!("{:x}", Sha256::digest(&bytes)));
        }
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let digest = format!("{:x}", Sha256::digest(&bytes));
        fs::write(stage.join("manifest.json"), bytes).unwrap();
        let runtime = home.join("lib/runtimes").join(&digest);
        fs::rename(stage, &runtime).unwrap();
        fs::create_dir_all(home.join("state")).unwrap();
        // Selection is by the supplied digest; this unrelated pointer must not
        // be consulted by the receiver, including its prelaunch revalidation.
        fs::write(
            home.join("state/adapter-runtime.json"),
            json!({"version":1,"digest":"b".repeat(64)}).to_string(),
        )
        .unwrap();
        // Validate the exact relocated tripwire executable as well as the
        // system shell used by Fixture. A platform launcher may not relocate.
        let probe = Command::new(runtime.join("native/node"))
            .arg(runtime.join("engine.js"))
            .env_clear()
            .output()
            .unwrap();
        if fixture.retained {
            fs::write(
                fixture.root.join("relocated-tripwire.stderr"),
                &probe.stderr,
            )
            .unwrap();
            fs::write(
                fixture.root.join("relocated-tripwire.json"),
                json!({"exitCode":probe.status.code(),"signal":probe.status.signal(),
                    "markerPresent":fixture.marker.exists(),"scope":"fixture setup, outside invocation"}).to_string(),
            ).unwrap();
        }
        assert_eq!(
            probe.status.code(),
            Some(73),
            "relocated tripwire: {}",
            String::from_utf8_lossy(&probe.stderr)
        );
        assert_eq!(fs::read(&fixture.marker).unwrap(), b"started");
        fs::remove_file(&fixture.marker).unwrap();
        Self {
            fixture,
            home,
            runtime,
            digest,
        }
    }
    fn args(&self, event: &str) -> Vec<String> {
        let mut args = self.fixture.args(event);
        args[2] = self.runtime.join("engine.js").to_str().unwrap().into();
        args[4] = self.runtime.join("native/node").to_str().unwrap().into();
        args[10] = self.digest.clone();
        let original = MonotonicDeadline::capture(Duration::from_secs(30))
            .unwrap()
            .envelope();
        with_wire(
            args,
            json!({
                "startedNs": original.started_ns.to_string(),
                "expiresNs": original.expires_ns.to_string(),
                "runtimeDigest": self.digest,
            })
            .to_string(),
        )
    }
    fn run(&self, args: &[String], git: Option<&std::path::Path>) -> Output {
        if self.fixture.marker.exists() {
            fs::remove_file(&self.fixture.marker).unwrap();
        }
        let mut command = Command::new(self.runtime.join("native/caws-native"));
        command
            .args(args)
            .current_dir(&self.fixture.root)
            .env_clear()
            .env("HOME", &self.fixture.root)
            .env("CAWS_HOME", &self.home)
            .env("PATH", "/usr/bin:/bin")
            .env("CAWS_NATIVE_TRACE_PROGRESS", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(git) = git {
            command.env("CAWS_GIT_BINARY", git).env(
                "PATH",
                format!("{}:/usr/bin:/bin", self.fixture.root.display()),
            );
        }
        let mut child = OwnedChild(command.spawn().unwrap());
        let payload = json!({
            "session_id": "receiver-fixture-session",
            "cwd": self.fixture.root,
        })
        .to_string();
        child
            .0
            .stdin
            .take()
            .unwrap()
            .write_all(payload.as_bytes())
            .unwrap();
        let started = Instant::now();
        let status = loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                break status;
            }
            assert!(
                started.elapsed() < Duration::from_secs(35),
                "receiver watchdog"
            );
            thread::sleep(Duration::from_millis(5));
        };
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
        if self.fixture.retained {
            let observation = self.fixture.root.join(format!(
                "published-observation-{}",
                SERIAL.fetch_add(1, Ordering::Relaxed),
            ));
            fs::create_dir(&observation).unwrap();
            fs::write(observation.join("stdout.bin"), &stdout).unwrap();
            fs::write(observation.join("stderr.bin"), &stderr).unwrap();
            fs::write(observation.join("result.json"), json!({
                "binary":self.runtime.join("native/caws-native"),"argv":args,
                "originalPayload":payload,
                "exitCode":status.code(),"signal":status.signal(),
                "generationDigest":self.digest,"engineMarkerPresent":self.fixture.marker.exists(),
                "scope":"real frontend receiver in synthetic verified generation; no maintained engine or installed entry qualification",
            }).to_string()).unwrap();
        }
        Output {
            status,
            stdout,
            stderr,
        }
    }
}

fn invocation_progress(output: &Output) -> Value {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let suffix = stderr
        .split_once("; native progress ")
        .expect("execution progress")
        .1;
    serde_json::Deserializer::from_str(suffix)
        .into_iter::<Value>()
        .next()
        .unwrap()
        .unwrap()
}

#[test]
fn installed_generation_positive_control_reaches_only_pinned_engine_for_all_events() {
    let f = PublishedFixture::new(Some(installed_entry()));
    for event in INVOKE_EVENTS {
        let output = f.run(&f.args(event), None);
        outcome(&output, event);
        assert_eq!(fs::read(&f.fixture.marker).unwrap(), b"started", "{event}");
        let progress = invocation_progress(&output);
        assert_eq!(progress["generationReceiptRevalidations"]["count"], 2);
        assert_eq!(progress["selectionAdvertised"], false);
        assert_eq!(progress["originalRenderCaptured"], false);
        assert_eq!(progress["dispatchGrantWritten"], false);
    }
}

#[test]
fn installed_generation_capability_refusals_never_reach_engine_for_all_events() {
    let mut old = installed_entry();
    old["schema"] = json!("caws.runtime.native-entry.v1");
    old.as_object_mut().unwrap().remove("installedInvocation");
    let mut missing = installed_entry();
    missing
        .as_object_mut()
        .unwrap()
        .remove("installedInvocation");
    let mut null = installed_entry();
    null["installedInvocation"] = Value::Null;
    let mut wrong_protocol = installed_entry();
    wrong_protocol["installedInvocation"]["protocol"] = json!("invoke-installed-v2");
    let mut wrong_maximum = installed_entry();
    wrong_maximum["installedInvocation"]["maxOriginalTimeoutMs"] = json!(30001);
    let mut extra = installed_entry();
    extra["installedInvocation"]["unknown"] = json!(true);
    for (entry, diagnostic) in [
        (None, "Exact generation has no native entry"),
        (
            Some(old),
            "Selected generation does not support invoke-installed-v1",
        ),
        (Some(missing), "Malformed native entry:"),
        (Some(null), "Malformed native entry:"),
        (
            Some(wrong_protocol),
            "Unsupported native entry schema or timeout",
        ),
        (
            Some(wrong_maximum),
            "Unsupported native entry schema or timeout",
        ),
        (Some(extra), "Malformed native entry:"),
    ] {
        let f = PublishedFixture::new(entry);
        for event in INVOKE_EVENTS {
            let output = f.run(&f.args(event), None);
            outcome(&output, event);
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(stderr.contains(diagnostic), "{event}: {stderr}");
            assert!(!f.fixture.marker.exists(), "{event}: {diagnostic}");
            let progress = invocation_progress(&output);
            assert_eq!(progress["phase"], "installed-generation-capture");
            assert_eq!(progress["generationReceiptRevalidations"]["count"], 0);
        }
    }
}

#[test]
fn direct_generation_keeps_v1_compatibility_for_all_events() {
    let mut entry = installed_entry();
    entry["schema"] = json!("caws.runtime.native-entry.v1");
    entry.as_object_mut().unwrap().remove("installedInvocation");
    let f = PublishedFixture::new(Some(entry));
    for event in INVOKE_EVENTS {
        let mut args = f.args(event);
        args.truncate(15);
        args[0] = "invoke".into();
        let output = f.run(&args, None);
        outcome(&output, event);
        assert_eq!(fs::read(&f.fixture.marker).unwrap(), b"started");
        assert_eq!(
            invocation_progress(&output)["generationReceiptRevalidations"]["count"],
            0
        );
    }
}

#[test]
fn installed_generation_path_and_timeout_binding_refuse_before_engine_for_all_events() {
    let f = PublishedFixture::new(Some(installed_entry()));
    for event in INVOKE_EVENTS {
        for index in [2, 4, 12] {
            let mut args = f.args(event);
            let expected = if index == 12 {
                args[index] = "29999".into();
                // Keep the received interval within the altered CLI timeout:
                // this must reach generation timeout binding, not parse refusal.
                let original = MonotonicDeadline::capture(Duration::from_millis(29999))
                    .unwrap()
                    .envelope();
                args[16] = json!({"startedNs":original.started_ns.to_string(),
                    "expiresNs":original.expires_ns.to_string(),"runtimeDigest":f.digest})
                .to_string();
                "Installed invocation timeout differs from selected generation"
            } else {
                args[index] = if index == 2 {
                    f.fixture.root.join("engine.sh").to_str().unwrap().into()
                } else {
                    "/bin/sh".into()
                };
                "Invocation paths differ from admitted native generation"
            };
            let output = f.run(&args, None);
            outcome(&output, event);
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(stderr.contains(expected), "{event}/{index}: {stderr}");
            assert!(!f.fixture.marker.exists());
            assert_eq!(
                invocation_progress(&output)["phase"],
                "installed-generation-capture"
            );
        }
    }
}

#[cfg(target_os = "macos")]
#[test]
fn optional_original_capture_reuses_mandatory_receipt_and_mutation_blocks_launch() {
    let f = PublishedFixture::new(Some(installed_entry()));
    let mut args = f.args("stop");
    args[6] = "opencode".into();
    // With no project in this temporary directory, optional capture refuses.
    // Its refusal must retain the supplied receipt and permit compatibility.
    let output = f.run(&args, None);
    outcome(&output, "stop");
    assert_eq!(fs::read(&f.fixture.marker).unwrap(), b"started");
    let progress = invocation_progress(&output);
    assert_eq!(progress["generationReceiptRevalidations"]["count"], 2);
    assert_eq!(progress["originalRenderCaptured"], false);
    assert!(
        progress["marks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|mark| mark[0] == "original-executor")
    );
    assert!(
        !progress["marks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|mark| mark[0] == "generation-capture")
    );

    let quote = |path: PathBuf| path.to_str().unwrap().replace('\'', "'\\''");
    let git = f.fixture.root.join("git");
    let witness = f.fixture.root.join("mutation-witness");
    // Original capture resolves payload.cwd, pins CAWS_GIT_BINARY and issues
    // rev-parse before policy/governance admission. This first query mutates
    // the retained generation and refuses; no Git repository is necessary.
    fs::write(
        &git,
        format!(
            "#!/bin/sh\nprintf changed > '{}'\nprintf witnessed > '{}'\nexit 91\n",
            quote(f.runtime.join("engine.js")),
            quote(witness.clone()),
        ),
    )
    .unwrap();
    fs::set_permissions(&git, fs::Permissions::from_mode(0o755)).unwrap();
    // Refresh only the transport envelope for this separate invocation.
    let mut args = f.args("stop");
    args[6] = "opencode".into();
    let output = f.run(&args, Some(&git));
    outcome(&output, "stop");
    assert_eq!(
        fs::read(witness).unwrap(),
        b"witnessed",
        "mutation must actually execute before Node"
    );
    assert!(!f.fixture.marker.exists());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("Admitted generation member changed"),
        "{stderr}"
    );
    assert_eq!(
        invocation_progress(&output)["generationReceiptRevalidations"]["count"],
        2
    );
}
