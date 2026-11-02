use sha2::{Digest, Sha256};
use std::io::Write;
use std::os::unix::ffi::OsStringExt;
use std::process::Stdio;
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};
#[allow(dead_code)]
#[path = "../src/installed_entry.rs"]
mod installed_entry;
#[path = "../src/installed_generation.rs"]
mod installed_generation;

static SEQUENCE: AtomicUsize = AtomicUsize::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let parent = std::env::var_os("CAWS_NATIVE_ENTRY_ARTIFACT_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let root = parent.join(format!(
            "caws-installed-entry-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        Self(fs::canonicalize(root).unwrap())
    }
    fn invoke(&self, args: &[&str]) -> Output {
        let output = Command::new(env!("CARGO_BIN_EXE_caws-hook-native"))
            .args(args)
            .env("CAWS_HOME", &self.0)
            .output()
            .unwrap();
        self.retain(args, &output);
        output
    }
    fn retain(&self, args: &[&str], output: &Output) {
        if std::env::var_os("CAWS_NATIVE_ENTRY_ARTIFACT_DIR").is_none() {
            return;
        }
        let record = self.0.join(format!(
            "observation-{}",
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&record).unwrap();
        fs::write(record.join("stdout.bin"), &output.stdout).unwrap();
        fs::write(record.join("stderr.bin"), &output.stderr).unwrap();
        fs::write(record.join("result.json"), serde_json::to_vec_pretty(&serde_json::json!({
            "argv":args,"exit_code":output.status.code(),"machine_home":self.0,"binary":env!("CARGO_BIN_EXE_caws-hook-native"),
        })).unwrap()).unwrap();
    }
    fn generation(&self, native: Option<&[u8]>) -> String {
        self.generation_with_entry(native, serde_json::json!({
            "schema":"caws.runtime.native-entry.v1", "nativeExecutable":"native/caws-native",
            "nodeExecutable":"native/node", "engineEntry":"engine.js", "describeEntry":"describe.js", "timeoutMs":1000,
        }))
    }
    fn installed_current(&self, native: &[u8]) -> String {
        let mut metadata = installed_v2_metadata();
        metadata["timeoutMs"] = 1000.into();
        self.generation_with_entry(Some(native), metadata)
    }
    fn generation_with_entry(&self, native: Option<&[u8]>, metadata: serde_json::Value) -> String {
        let mut files: BTreeMap<String, Vec<u8>> = BTreeMap::from([
            ("launcher.py".into(), b"raise SystemExit(77)\n".to_vec()),
            (
                "bootstrap.py".into(),
                b"print('LEGACY_EXECUTED')\n".to_vec(),
            ),
        ]);
        if let Some(bytes) = native {
            files.insert("native/caws-native".into(), bytes.to_vec());
            files.insert("native/caws-hook-native".into(), b"identity only".to_vec());
            files.insert("native/node".into(), b"#!/bin/sh\nexit 78\n".to_vec());
            files.insert(
                "engine.js".into(),
                b"throw Error('not a real engine fixture');".to_vec(),
            );
            files.insert(
                "describe.js".into(),
                b"throw Error('not a real description fixture');".to_vec(),
            );
            files.insert(
                "native-entry.json".into(),
                serde_json::to_vec(&metadata).unwrap(),
            );
            files.insert("native-modes.json".into(), Vec::new());
            let modes: BTreeMap<_, _> = files
                .keys()
                .map(|p| {
                    (
                        p.clone(),
                        if p.starts_with("native/") {
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
            .map(|(p, b)| (p, format!("{:x}", Sha256::digest(b))))
            .collect();
        let manifest = serde_json::to_vec(&manifest).unwrap();
        let digest = format!("{:x}", Sha256::digest(&manifest));
        let generation = self.0.join("lib/runtimes").join(&digest);
        for (p, b) in &files {
            let target = generation.join(p);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(&target, b).unwrap();
            fs::set_permissions(
                &target,
                fs::Permissions::from_mode(if p.starts_with("native/") {
                    0o755
                } else {
                    0o644
                }),
            )
            .unwrap();
        }
        fs::write(generation.join("manifest.json"), manifest).unwrap();
        fs::create_dir_all(self.0.join("state")).unwrap();
        fs::write(
            self.0.join("state/adapter-runtime.json"),
            serde_json::to_vec(
                &serde_json::json!({"version":1,"digest":digest,"previous_digest":null}),
            )
            .unwrap(),
        )
        .unwrap();
        digest
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if std::env::var_os("CAWS_NATIVE_ENTRY_ARTIFACT_DIR").is_none() {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

#[test]
fn invalid_invocation_precedes_missing_pointer() {
    let f = Fixture::new();
    for args in [
        vec![],
        vec!["codex"],
        vec!["codex", "stop", "--system", "--system"],
        vec!["unknown", "stop"],
        vec!["codex", "unknown"],
        vec!["codex", "stop", "--engine", "caller.js"],
        vec!["codex", "stop", "--describe", "--describe"],
    ] {
        let output = f.invoke(&args);
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8_lossy(&output.stderr).contains("Usage:"));
    }
}
#[test]
fn configuration_fault_policy_is_event_scoped() {
    let f = Fixture::new();
    for event in [
        "pre_tool_use",
        "post_tool_use",
        "session_start",
        "stop",
        "pre_compact",
        "session_end",
    ] {
        let output = f.invoke(&["codex", event]);
        assert_eq!(
            output.status.code(),
            Some(if event == "pre_tool_use" { 2 } else { 0 })
        );
        assert!(!output.stderr.is_empty());
        if event == "pre_tool_use" {
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()["decision"],
                "block"
            );
        } else {
            assert!(output.stdout.is_empty());
        }
    }
}
#[test]
fn positively_recognized_legacy_delegates_to_its_bootstrap() {
    let f = Fixture::new();
    f.generation(None);
    let output = f.invoke(&["codex", "stop", "--describe", "--system"]);
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(output.stdout, b"LEGACY_EXECUTED\n");
}
#[test]
fn native_process_nonzero_is_not_retried_through_legacy() {
    let f = Fixture::new();
    f.installed_current(b"#!/bin/sh\nprintf 'NATIVE_DISPATCHED\\n'\nexit 37\n");
    let output = f.invoke(&["codex", "stop"]);
    assert_eq!(output.status.code(), Some(37));
    assert_eq!(output.stdout, b"NATIVE_DISPATCHED\n");
    assert!(output.stderr.is_empty());
}
#[test]
fn modified_native_member_fails_before_dispatch_without_legacy_retry() {
    let f = Fixture::new();
    let digest = f.installed_current(b"#!/bin/sh\necho NATIVE_DISPATCHED\n");
    fs::write(
        f.0.join("lib/runtimes").join(digest).join("engine.js"),
        b"changed",
    )
    .unwrap();
    let output = f.invoke(&["codex", "pre_tool_use"]);
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("integrity failure: engine.js"));
    assert!(!String::from_utf8_lossy(&output.stdout).contains("LEGACY_EXECUTED"));
}
#[test]
fn undeclared_shadow_member_and_mode_changes_refuse() {
    for shadow in [true, false] {
        let f = Fixture::new();
        let digest = f.installed_current(b"#!/bin/sh\necho NATIVE_DISPATCHED\n");
        let generation = f.0.join("lib/runtimes").join(digest);
        if shadow {
            fs::write(generation.join("shadow.js"), b"unexpected").unwrap();
        } else {
            fs::set_permissions(
                generation.join("native/caws-native"),
                fs::Permissions::from_mode(0o644),
            )
            .unwrap();
        }
        let output = f.invoke(&["codex", "pre_tool_use"]);
        assert_eq!(output.status.code(), Some(2));
        assert!(!String::from_utf8_lossy(&output.stdout).contains("NATIVE_DISPATCHED"));
        assert!(String::from_utf8_lossy(&output.stderr).contains(if shadow {
            "Undeclared native"
        } else {
            "mode mismatch"
        }));
    }
}

#[test]
fn native_selection_remains_pinned_when_pointer_advances() {
    let f = Fixture::new();
    let original = caws_native::monotonic_deadline::MonotonicDeadline::capture(
        std::time::Duration::from_millis(30000),
    )
    .unwrap();
    let expected = original.envelope();
    let first = f.installed_current(b"#!/bin/sh\necho SELECTED_A\n");
    let selected = installed_entry::Selection::read_with_deadline(&f.0, original).unwrap();
    let second = f.installed_current(b"#!/bin/sh\necho SELECTED_B\n");
    assert_ne!(first, second);
    let invocation = installed_entry::Invocation::parse(&["codex".into(), "stop".into()]).unwrap();
    let mut command = selected.command(&invocation).unwrap();
    let carrier = deadline_carrier(&command);
    assert_eq!(carrier["runtimeDigest"], first);
    assert_eq!(carrier["startedNs"], expected.started_ns.to_string());
    assert_eq!(
        carrier["expiresNs"],
        (expected.started_ns + 1000 * 1_000_000).to_string()
    );
    let output = command.output().unwrap();
    f.retain(&["PINNED_SELECTION_A_AFTER_POINTER_B"], &output);
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(output.stdout, b"SELECTED_A\n");
    assert_eq!(selected.inspected_digest, first);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(
            &fs::read(f.0.join("state/adapter-runtime.json")).unwrap()
        )
        .unwrap()["digest"],
        second
    );
}

#[test]
fn selected_generation_mutation_after_pointer_read_refuses_launch() {
    let f = Fixture::new();
    let digest = f.installed_current(b"#!/bin/sh\necho SELECTED_A\n");
    let selected = installed_entry::Selection::read(&f.0).unwrap();
    fs::write(
        f.0.join("lib/runtimes").join(digest).join("engine.js"),
        b"changed after selection",
    )
    .unwrap();
    let invocation = installed_entry::Invocation::parse(&["codex".into(), "stop".into()]).unwrap();
    let error = selected
        .command(&invocation)
        .err()
        .expect("changed selected generation must refuse");
    assert!(error.contains("integrity failure: engine.js"));
    if std::env::var_os("CAWS_NATIVE_ENTRY_ARTIFACT_DIR").is_some() {
        fs::write(f.0.join("launch-refusal.txt"), error).unwrap();
    }
}

#[test]
fn installed_entry_exec_retains_pid_cwd_stdin_and_environment_at_selected_process_boundary() {
    let f = Fixture::new();
    f.installed_current(b"#!/bin/sh\nprintf '%s\\n' \"$$\" > \"$R01_WITNESS/pid.txt\"\npwd -P > \"$R01_WITNESS/cwd.txt\"\nprintf '%s' \"$R01_CONTEXT\" > \"$R01_WITNESS/environment.bin\"\ncat > \"$R01_WITNESS/stdin.bin\"\n");
    let raw = b"{ \"fixture\": \"raw bytes, not a proposed command\" }\n\n";
    let mut child = Command::new(env!("CARGO_BIN_EXE_caws-hook-native"))
        .args(["codex", "stop"])
        .env("CAWS_HOME", &f.0)
        .env("R01_WITNESS", &f.0)
        .env("R01_CONTEXT", "preserve spaces and unicode: caf\u{e9}")
        .current_dir(&f.0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let expected_pid = child.id();
    child.stdin.take().unwrap().write_all(raw).unwrap();
    let output = child.wait_with_output().unwrap();
    f.retain(&["SELECTED_PROCESS_CONTEXT_BOUNDARY"], &output);
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        fs::read_to_string(f.0.join("pid.txt")).unwrap().trim(),
        expected_pid.to_string()
    );
    assert_eq!(
        fs::read_to_string(f.0.join("cwd.txt")).unwrap().trim(),
        f.0.to_str().unwrap()
    );
    assert_eq!(fs::read(f.0.join("stdin.bin")).unwrap(), raw);
    assert_eq!(
        fs::read_to_string(f.0.join("environment.bin")).unwrap(),
        "preserve spaces and unicode: caf\u{e9}"
    );
}

#[test]
fn non_utf8_invocation_refuses_before_pointer_access() {
    let f = Fixture::new();
    let output = Command::new(env!("CARGO_BIN_EXE_caws-hook-native"))
        .args([
            std::ffi::OsString::from("codex"),
            std::ffi::OsString::from("stop"),
            std::ffi::OsString::from_vec(vec![0xff]),
        ])
        .env("CAWS_HOME", &f.0)
        .output()
        .unwrap();
    f.retain(&["codex", "stop", "<non-UTF8-ff>"], &output);
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("must be UTF-8"));
}

fn installed_v2_metadata() -> serde_json::Value {
    serde_json::json!({
        "schema":"caws.runtime.native-entry.v2", "nativeExecutable":"native/caws-native",
        "nodeExecutable":"native/node", "engineEntry":"engine.js", "describeEntry":"describe.js", "timeoutMs":30000,
        "installedInvocation":{"protocol":"invoke-installed-v1","maxOriginalTimeoutMs":30000},
    })
}

#[test]
fn generation_v1_remains_readable_without_installed_receiver_capability() {
    let fixture = Fixture::new();
    let digest = fixture.generation(Some(b"#!/bin/sh\nexit 91\n"));
    let mut cancel = || Ok(());
    let mut verify = installed_generation::Verification::new(
        std::time::Instant::now() + std::time::Duration::from_secs(30),
        &mut cancel,
    );
    let selected =
        installed_generation::Selection::read_generation(&fixture.0, &digest, &mut verify).unwrap();
    assert!(selected.native_entry().is_some());
    assert_eq!(
        selected.installed_invocation_entry().unwrap_err(),
        "Selected generation does not support invoke-installed-v1"
    );
    let deadline = caws_native::monotonic_deadline::MonotonicDeadline::capture(
        std::time::Duration::from_millis(1000),
    )
    .unwrap();
    let mut live = || Ok(());
    let mut bounded = installed_generation::Verification::new(deadline.expires(), &mut live);
    let (native, node, engine) = selected.native_paths(&mut bounded).unwrap();
    assert_eq!(
        selected
            .validate_installed_invocation(&native, &node, &engine, 1000, &deadline, &mut bounded)
            .unwrap_err(),
        "Selected generation does not support invoke-installed-v1"
    );
}

#[test]
fn generation_capability_wire_shape_and_policy_are_exact() {
    let mut cases = Vec::new();
    for change in [
        "missing",
        "null",
        "extra",
        "extra-capability",
        "protocol",
        "max-short",
        "max-long",
        "zero",
        "timeout-long",
        "schema",
    ] {
        let mut metadata = installed_v2_metadata();
        match change {
            "missing" => {
                metadata
                    .as_object_mut()
                    .unwrap()
                    .remove("installedInvocation");
            }
            "null" => metadata["installedInvocation"] = serde_json::Value::Null,
            "extra" => metadata["callerCapability"] = true.into(),
            "extra-capability" => metadata["installedInvocation"]["fallback"] = true.into(),
            "protocol" => metadata["installedInvocation"]["protocol"] = "invoke".into(),
            "max-short" => metadata["installedInvocation"]["maxOriginalTimeoutMs"] = 29999.into(),
            "max-long" => metadata["installedInvocation"]["maxOriginalTimeoutMs"] = 30001.into(),
            "zero" => metadata["timeoutMs"] = 0.into(),
            "timeout-long" => metadata["timeoutMs"] = 30001.into(),
            "schema" => metadata["schema"] = "caws.runtime.native-entry.v3".into(),
            _ => unreachable!(),
        }
        cases.push((change, metadata));
    }
    let mut v1_null = installed_v2_metadata();
    v1_null["schema"] = "caws.runtime.native-entry.v1".into();
    v1_null["installedInvocation"] = serde_json::Value::Null;
    cases.push(("v1-null-capability", v1_null));
    for (name, metadata) in cases {
        let fixture = Fixture::new();
        let digest = fixture.generation_with_entry(Some(b"#!/bin/sh\nexit 91\n"), metadata);
        let mut cancel = || Ok(());
        let mut verify = installed_generation::Verification::new(
            std::time::Instant::now() + std::time::Duration::from_secs(30),
            &mut cancel,
        );
        let error =
            installed_generation::Selection::read_generation(&fixture.0, &digest, &mut verify)
                .unwrap_err();
        assert!(error.contains("native entry"), "{name}: {error}");
    }
}

#[test]
fn installed_binding_requires_selected_paths_timeout_and_original_expiry() {
    use caws_native::monotonic_deadline::MonotonicDeadline;
    use std::time::Duration;
    let fixture = Fixture::new();
    let digest =
        fixture.generation_with_entry(Some(b"#!/bin/sh\nexit 91\n"), installed_v2_metadata());
    let deadline = MonotonicDeadline::capture(Duration::from_secs(30)).unwrap();
    let mut cancel = || deadline.check().map_err(|error| error.to_string());
    let mut verify = installed_generation::Verification::new(deadline.expires(), &mut cancel);
    let selected =
        installed_generation::Selection::read_generation(&fixture.0, &digest, &mut verify).unwrap();
    let (native, node, engine) = selected.native_paths(&mut verify).unwrap();
    assert!(
        selected
            .validate_installed_invocation(&native, &node, &engine, 30000, &deadline, &mut verify)
            .is_ok()
    );
    for (wrong_native, wrong_node, wrong_engine) in [
        (fixture.0.join("wrong-native"), node.clone(), engine.clone()),
        (native.clone(), fixture.0.join("wrong-node"), engine.clone()),
        (native.clone(), node.clone(), fixture.0.join("wrong-engine")),
    ] {
        assert_eq!(
            selected
                .validate_installed_invocation(
                    &wrong_native,
                    &wrong_node,
                    &wrong_engine,
                    30000,
                    &deadline,
                    &mut verify
                )
                .unwrap_err(),
            "Invocation paths differ from admitted native generation"
        );
    }
    for timeout in [1, 29999, 30001, 120000] {
        assert_eq!(
            selected
                .validate_installed_invocation(
                    &native,
                    &node,
                    &engine,
                    timeout,
                    &deadline,
                    &mut verify
                )
                .unwrap_err(),
            "Installed invocation timeout differs from selected generation"
        );
    }
    // A matching configured timeout does not excuse a larger original interval.
    let longer = MonotonicDeadline::capture(Duration::from_millis(31000)).unwrap();
    let mut live = || Ok(());
    let mut longer_verify = installed_generation::Verification::new(longer.expires(), &mut live);
    assert_eq!(
        selected
            .validate_installed_invocation(
                &native,
                &node,
                &engine,
                30000,
                &longer,
                &mut longer_verify
            )
            .unwrap_err(),
        "Installed invocation timeout differs from selected generation"
    );
    let mut live = || Ok(());
    let mut renewed = installed_generation::Verification::new(
        deadline.expires() + Duration::from_secs(1),
        &mut live,
    );
    assert_eq!(
        selected
            .validate_installed_invocation(&native, &node, &engine, 30000, &deadline, &mut renewed)
            .unwrap_err(),
        "Installed verification exceeds original deadline"
    );
    let expired = MonotonicDeadline::capture(Duration::from_millis(1)).unwrap();
    std::thread::sleep(Duration::from_millis(10));
    assert!(
        selected
            .validate_installed_invocation(&native, &node, &engine, 30000, &expired, &mut verify)
            .unwrap_err()
            .contains("expired")
    );
}

// These tests witness installed transport argv and a stub frontend boundary.
// They do not exercise the actual caws-native receiver's generation admission.
fn command_arguments(command: &Command) -> Vec<String> {
    command
        .get_args()
        .map(|value| {
            value
                .to_str()
                .expect("forwarded argv must be UTF-8")
                .to_owned()
        })
        .collect()
}
fn deadline_carrier(command: &Command) -> serde_json::Value {
    let arguments = command_arguments(command);
    assert_eq!(arguments.len(), 17);
    assert_eq!(arguments[0], "invoke-installed-v1");
    assert_eq!(
        arguments
            .iter()
            .filter(|value| value.as_str() == "--original-deadline")
            .count(),
        1
    );
    let position = arguments
        .iter()
        .position(|value| value == "--original-deadline")
        .unwrap();
    let value: serde_json::Value = serde_json::from_str(&arguments[position + 1]).unwrap();
    let keys: std::collections::BTreeSet<_> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        ["expiresNs", "runtimeDigest", "startedNs"]
            .into_iter()
            .collect()
    );
    for key in ["startedNs", "expiresNs"] {
        let decimal = value[key]
            .as_str()
            .expect("deadline integers must be strings");
        let parsed: u64 = decimal.parse().unwrap();
        assert_eq!(decimal, parsed.to_string());
    }
    value
}

#[test]
fn installed_handoff_uses_exact_selected_arguments_and_canonical_original_clock() {
    use caws_native::monotonic_deadline::MonotonicDeadline;
    use std::time::Duration;
    let original = MonotonicDeadline::capture(Duration::from_millis(30000)).unwrap();
    let expected = original.envelope();
    // Capture precedes fixture creation, pointer publication and selection I/O.
    let fixture = Fixture::new();
    let digest = fixture.installed_current(b"#!/bin/sh\nexit 0\n");
    let before_selection = MonotonicDeadline::capture(Duration::from_secs(30))
        .unwrap()
        .envelope();
    assert!(expected.started_ns < before_selection.started_ns);
    let selected = installed_entry::Selection::read_with_deadline(&fixture.0, original).unwrap();
    let invocation =
        installed_entry::Invocation::parse(&["codex".into(), "stop".into(), "--system".into()])
            .unwrap();
    let command = selected.command(&invocation).unwrap();
    let carrier = deadline_carrier(&command);
    assert_eq!(carrier["startedNs"], expected.started_ns.to_string());
    assert_eq!(
        carrier["expiresNs"],
        (expected.started_ns + 1000 * 1_000_000).to_string()
    );
    assert!(
        carrier["expiresNs"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap()
            < expected.expires_ns
    );
    assert_eq!(carrier["runtimeDigest"], digest);
    let root = fixture.0.join("lib/runtimes").join(&digest);
    assert_eq!(
        command.get_program(),
        root.join("native/caws-native").as_os_str()
    );
    assert_eq!(
        command_arguments(&command),
        vec![
            "invoke-installed-v1".to_owned(),
            "--engine".to_owned(),
            root.join("engine.js").to_str().unwrap().to_owned(),
            "--node".to_owned(),
            root.join("native/node").to_str().unwrap().to_owned(),
            "--timeout-ms".to_owned(),
            "1000".to_owned(),
            "--original-deadline".to_owned(),
            serde_json::to_string(&carrier).unwrap(),
            "--surface".to_owned(),
            "codex".to_owned(),
            "--event".to_owned(),
            "stop".to_owned(),
            "--runtime-digest".to_owned(),
            digest,
            "--configuration".to_owned(),
            "system".to_owned(),
        ]
    );
    // Revalidation and rebuilding command argv must retain the exact clock.
    assert_eq!(
        deadline_carrier(&selected.command(&invocation).unwrap()),
        carrier
    );
}

#[test]
fn selected_policy_cannot_extend_an_earlier_original_expiry() {
    use caws_native::monotonic_deadline::MonotonicDeadline;
    use std::time::Duration;
    let original = MonotonicDeadline::capture(Duration::from_millis(20000)).unwrap();
    let expected = original.envelope();
    let fixture = Fixture::new();
    fixture.generation_with_entry(Some(b"#!/bin/sh\nexit 0\n"), installed_v2_metadata());
    let selected = installed_entry::Selection::read_with_deadline(&fixture.0, original).unwrap();
    let invocation = installed_entry::Invocation::parse(&["codex".into(), "stop".into()]).unwrap();
    let command = selected.command(&invocation).unwrap();
    let carrier = deadline_carrier(&command);
    assert_eq!(carrier["startedNs"], expected.started_ns.to_string());
    assert_eq!(carrier["expiresNs"], expected.expires_ns.to_string());
    assert_eq!(command_arguments(&command)[6], "30000");
}

#[test]
fn installed_original_above_thirty_seconds_or_expired_refuses_before_selection() {
    use caws_native::monotonic_deadline::MonotonicDeadline;
    use std::time::Duration;
    let fixture = Fixture::new(); // No pointer: deadline refusal must win first.
    let longer = MonotonicDeadline::capture(Duration::from_millis(30001)).unwrap();
    let error = installed_entry::Selection::read_with_deadline(&fixture.0, longer).unwrap_err();
    assert_eq!(error, "Installed entry original interval exceeds 30000ms");
    let expired = MonotonicDeadline::capture(Duration::from_millis(1)).unwrap();
    std::thread::sleep(Duration::from_millis(10));
    let error = installed_entry::Selection::read_with_deadline(&fixture.0, expired).unwrap_err();
    assert_eq!(error, "Original monotonic deadline expired");
    assert!(!fixture.0.join("state/adapter-runtime.json").exists());
}

#[test]
fn installed_v1_dispatch_refuses_before_frontend_without_ordinary_or_legacy_retry() {
    let fixture = Fixture::new();
    fixture.generation(Some(
        b"#!/bin/sh\nprintf 'FRONTEND_WAS_EXECUTED\\n'\n: > \"$CAWS_HOME/frontend-witness\"\n",
    ));
    let selected = installed_entry::Selection::read(&fixture.0).unwrap();
    let invocation =
        installed_entry::Invocation::parse(&["codex".into(), "pre_tool_use".into()]).unwrap();
    let error = selected
        .command(&invocation)
        .err()
        .expect("v1 must not create installed command");
    assert_eq!(
        error,
        "Selected generation does not support invoke-installed-v1"
    );
    let output = fixture.invoke(&["codex", "pre_tool_use"]);
    assert_eq!(output.status.code(), Some(2));
    let refusal: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(refusal["decision"], "block");
    assert!(
        refusal["reason"]
            .as_str()
            .unwrap()
            .contains("does not support invoke-installed-v1")
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("does not support invoke-installed-v1")
    );
    assert!(!fixture.0.join("frontend-witness").exists());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("FRONTEND_WAS_EXECUTED"));
    assert!(!String::from_utf8_lossy(&output.stdout).contains("LEGACY_EXECUTED"));
}

#[test]
fn stub_frontend_observes_explicit_selected_handoff_despite_hostile_ambient_deadline() {
    use caws_native::monotonic_deadline::MonotonicDeadline;
    use std::time::Duration;
    let fixture = Fixture::new();
    let digest = fixture.installed_current(b"#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CAWS_HOME/observed-argv.txt\"\nprintf 'STUB_FRONTEND_OBSERVED\\n'\n");
    let forged_digest = "f".repeat(64);
    let forged = serde_json::json!({"startedNs":"0","expiresNs":u64::MAX.to_string(),"runtimeDigest":forged_digest});
    let before = MonotonicDeadline::capture(Duration::from_secs(30))
        .unwrap()
        .envelope();
    let output = Command::new(env!("CARGO_BIN_EXE_caws-hook-native"))
        .args(["codex", "stop", "--system"])
        .env("CAWS_HOME", &fixture.0)
        .env(
            "CAWS_NATIVE_ORIGINAL_DEADLINE",
            serde_json::to_string(&forged).unwrap(),
        )
        .env("CAWS_RUNTIME_DIGEST", &forged_digest)
        .output()
        .unwrap();
    let after = MonotonicDeadline::capture(Duration::from_secs(30))
        .unwrap()
        .envelope();
    fixture.retain(
        &["STUB_FRONTEND_HANDOFF_WITH_HOSTILE_AMBIENT_DATA"],
        &output,
    );
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(output.stdout, b"STUB_FRONTEND_OBSERVED\n");
    assert!(output.stderr.is_empty());
    let arguments = fs::read_to_string(fixture.0.join("observed-argv.txt")).unwrap();
    let arguments: Vec<_> = arguments.lines().collect();
    assert_eq!(arguments.len(), 17);
    assert_eq!(arguments[0], "invoke-installed-v1");
    assert_eq!(arguments[7], "--original-deadline");
    assert_eq!(arguments[13], "--runtime-digest");
    assert_eq!(arguments[14], digest);
    let carrier: serde_json::Value = serde_json::from_str(arguments[8]).unwrap();
    assert_eq!(carrier["runtimeDigest"], digest);
    assert_ne!(carrier, forged);
    let started = carrier["startedNs"].as_str().unwrap();
    let expires = carrier["expiresNs"].as_str().unwrap();
    let start_ns: u64 = started.parse().unwrap();
    let expire_ns: u64 = expires.parse().unwrap();
    assert_eq!(started, start_ns.to_string());
    assert_eq!(expires, expire_ns.to_string());
    assert!(start_ns >= before.started_ns && start_ns <= after.started_ns);
    assert_eq!(expire_ns - start_ns, 1000 * 1_000_000);
}
