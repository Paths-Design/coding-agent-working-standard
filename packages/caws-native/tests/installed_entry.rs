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
    f.generation(Some(b"#!/bin/sh\nprintf 'NATIVE_DISPATCHED\\n'\nexit 37\n"));
    let output = f.invoke(&["codex", "stop"]);
    assert_eq!(output.status.code(), Some(37));
    assert_eq!(output.stdout, b"NATIVE_DISPATCHED\n");
    assert!(output.stderr.is_empty());
}
#[test]
fn modified_native_member_fails_before_dispatch_without_legacy_retry() {
    let f = Fixture::new();
    let digest = f.generation(Some(b"#!/bin/sh\necho NATIVE_DISPATCHED\n"));
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
        let digest = f.generation(Some(b"#!/bin/sh\necho NATIVE_DISPATCHED\n"));
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
    let first = f.generation(Some(b"#!/bin/sh\necho SELECTED_A\n"));
    let selected = installed_entry::Selection::read(&f.0).unwrap();
    let second = f.generation(Some(b"#!/bin/sh\necho SELECTED_B\n"));
    assert_ne!(first, second);
    let invocation = installed_entry::Invocation::parse(&["codex".into(), "stop".into()]).unwrap();
    let output = selected.command(&invocation).unwrap().output().unwrap();
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
    let digest = f.generation(Some(b"#!/bin/sh\necho SELECTED_A\n"));
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
    f.generation(Some(b"#!/bin/sh\nprintf '%s\\n' \"$$\" > \"$R01_WITNESS/pid.txt\"\npwd -P > \"$R01_WITNESS/cwd.txt\"\nprintf '%s' \"$R01_CONTEXT\" > \"$R01_WITNESS/environment.bin\"\ncat > \"$R01_WITNESS/stdin.bin\"\n"));
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
