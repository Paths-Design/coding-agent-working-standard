//! Real binary stdio negotiation and authenticated-parent refusal. These tests
//! do not stand in for the pinned Codex sandbox/worker qualification.
#![cfg(target_os = "macos")]
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    os::{fd::OwnedFd, unix::net::UnixStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
fn image(path: &Path) -> Value {
    let path = fs::canonicalize(path).unwrap();
    json!({"path":path,"sha256":format!("{:x}",Sha256::digest(fs::read(&path).unwrap()))})
}
impl Fixture {
    fn new() -> Self {
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "caws-stdio-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn config(&self, wrong_host: bool) -> PathBuf {
        let generation = self.0.join("configured agent's generation");
        fs::create_dir(&generation).unwrap();
        for name in ["node", "authorizer.js", "discovery.js", "writer-main.js"] {
            fs::write(generation.join(name), name).unwrap();
        }
        let manifest = self.0.join("manifest.json");
        let files = ["authorizer.js", "discovery.js", "node", "writer-main.js"]
            .map(|name| json!({"path":name,"sha256":image(&generation.join(name))["sha256"]}));
        fs::write(
            &manifest,
            serde_json::to_vec(&json!({"schema":"caws.execution.generation.v1","files":files}))
                .unwrap(),
        )
        .unwrap();
        let config = self.0.join("config.json");
        let current = std::env::current_exe().unwrap();
        fs::write(&config,serde_json::to_vec(&json!({"schema":"caws.execution.server-config.v1",
            "native":image(Path::new(env!("CARGO_BIN_EXE_caws-execution"))),
            "host":image(if wrong_host {Path::new("/usr/bin/true")} else {&current}),
            "node":image(&generation.join("node")),"authorizer":image(&generation.join("authorizer.js")),
            "discovery":image(&generation.join("discovery.js")),"writer":image(&generation.join("writer-main.js")),
            "generation":{"root":generation,"manifest":image(&manifest)}})).unwrap()).unwrap();
        config
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn real_binary_advertises_context_and_exposes_only_source_and_cwd() {
    let fixture = Fixture::new();
    let config = fixture.config(false);
    let (mut input, endpoint) = UnixStream::pair().unwrap();
    let stdin_fd: OwnedFd = endpoint.try_clone().unwrap().into();
    let stdout_fd: OwnedFd = endpoint.into();
    let mut child = Command::new(env!("CARGO_BIN_EXE_caws-execution"))
        .arg("--config")
        .arg(&config)
        .stdin(Stdio::from(stdin_fd))
        .stdout(Stdio::from(stdout_fd))
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut output = BufReader::new(input.try_clone().unwrap());
    let mut line = String::new();
    writeln!(
        input,
        "{}",
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}})
    )
    .unwrap();
    output.read_line(&mut line).unwrap();
    let init: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(
        init["result"]["capabilities"]["experimental"],
        json!({"codex/caller-context":{"version":1},"codex/sandbox-state":{}})
    );
    line.clear();
    writeln!(
        input,
        "{}",
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}})
    )
    .unwrap();
    output.read_line(&mut line).unwrap();
    let list: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(list["result"]["tools"].as_array().unwrap().len(), 1);
    assert_eq!(list["result"]["tools"][0]["name"], "caws_exec");
    let description = list["result"]["tools"][0]["description"].as_str().unwrap();
    let prefix = description
        .split_once("Configured evidence writer prefix:\n")
        .expect("configured writer prefix marker")
        .1
        .split_once('\n')
        .unwrap()
        .0;
    // Interpret the advertised words with an independent shell consumer. The
    // prefix paths are inert fixture files; printf prints argv without running
    // the configured Node or writer, so quoting errors cannot hide in mocks.
    let words = Command::new("/bin/bash")
        .args(["--noprofile", "--norc", "-c"])
        .arg(format!("printf '%s\\0' {prefix}"))
        .output()
        .unwrap();
    assert!(words.status.success());
    let configured: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    let mut expected = configured["node"]["path"]
        .as_str()
        .unwrap()
        .as_bytes()
        .to_vec();
    expected.push(0);
    expected.extend(configured["writer"]["path"].as_str().unwrap().as_bytes());
    expected.push(0);
    assert_eq!(words.stdout, expected);
    for required in [
        "pass, fail, or unchecked",
        "--ac AC_ID",
        "--evidence-ref 'CITATION'",
        "--command 'DESCRIPTION'",
        "--exit-code INTEGER",
        "--artifact-path 'RELATIVE_PATH'",
        "--commit-sha COMMIT_SHA",
        "40 lowercase hexadecimal",
        "--verify requires both --artifact-path and --commit-sha",
        "citations only and never runs tests",
        "inside quoted CITATION or DESCRIPTION remain inert data",
        "stdoutBase64, stderrBase64",
        "Decode the base64 stdout",
        "caws specs commit SPEC_ID",
        "clean status before merge",
        "inspect the canonical spec and events",
        "configured, not a live generation or authority verification",
        "Other closed Bash profiles remain available",
    ] {
        assert!(
            description.contains(required),
            "missing usable contract: {required}"
        );
    }
    assert_eq!(
        list["result"]["tools"][0]["inputSchema"]["properties"],
        json!({"source":{"type":"string"},"cwd":{"type":"string"}})
    );
    // A valid parent does not turn model arguments into caller context.
    line.clear();
    writeln!(input,"{}",json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"caws_exec","arguments":{"source":"printf must-not-run"},"_meta":{}}})).unwrap();
    output.read_line(&mut line).unwrap();
    let denied: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(denied["result"]["isError"], true);
    let detail: Value =
        serde_json::from_str(denied["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(
        detail,
        json!({"ok":false,"reason":"NativeBoundaryRefused","userSpawnMayHaveOccurred":false,"stage":"ingress"})
    );
    println!("observed invalid-meta refusal: {detail}");
    assert!(!line.contains("must-not-run"));
    input.shutdown(std::net::Shutdown::Write).unwrap();
    assert!(child.wait().unwrap().success());
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    assert_eq!(stderr, "");
}

#[test]
fn real_binary_refuses_configured_parent_mismatch_without_protocol_output() {
    let fixture = Fixture::new();
    let config = fixture.config(true);
    let (mut input, endpoint) = UnixStream::pair().unwrap();
    let stdin_fd: OwnedFd = endpoint.try_clone().unwrap().into();
    let stdout_fd: OwnedFd = endpoint.into();
    let sentinel = fixture.0.join("source-must-not-launch");
    let source = format!("printf SUBMITTED_SOURCE_SECRET > {}", sentinel.display());
    writeln!(input, "{}", json!({"jsonrpc":"2.0","id":1,"method":"tools/call", "params":{"name":"caws_exec","arguments":{"source":source}}})).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_caws-execution"))
        .arg("--config")
        .arg(config)
        .stdin(Stdio::from(stdin_fd))
        .stdout(Stdio::from(stdout_fd))
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut bytes = Vec::new();
    input.read_to_end(&mut bytes).unwrap();
    assert_eq!(child.wait().unwrap().code(), Some(2));
    assert!(bytes.is_empty());
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    assert_eq!(
        stderr,
        "caws-execution: startup-refused stage=host-channel\n"
    );
    assert!(!stderr.contains("SUBMITTED_SOURCE_SECRET"));
    assert!(!stderr.contains(fixture.0.to_str().unwrap()));
    assert!(!sentinel.exists());
}

#[test]
fn ordinary_stdio_pipes_are_not_an_authenticated_request_channel() {
    let fixture = Fixture::new();
    let config = fixture.config(false);
    let output = Command::new(env!("CARGO_BIN_EXE_caws-execution"))
        .arg("--config")
        .arg(config)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert_eq!(
        output.stderr,
        b"caws-execution: startup-refused stage=host-channel\n"
    );
}

#[test]
fn real_worker_refuses_when_private_startup_descriptor_is_missing() {
    let fixture = Fixture::new();
    let config = fixture.config(false);
    let output = Command::new(env!("CARGO_BIN_EXE_caws-execution"))
        .args(["--worker", "--config"])
        .arg(config)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert_eq!(
        output.stderr,
        b"caws-execution: entry-failed stage=worker-failed\n"
    );
}

#[test]
fn invalid_configuration_has_closed_startup_diagnostic_without_its_path_or_bytes() {
    let fixture = Fixture::new();
    let config = fixture.0.join("PRIVATE_CONFIG_PATH_SECRET.json");
    fs::write(&config, br#"{"schema":"PRIVATE_CONFIG_CONTENT_SECRET"}"#).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_caws-execution"))
        .arg("--config")
        .arg(&config)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(output.stdout, b"");
    assert_eq!(
        output.stderr,
        b"caws-execution: startup-refused stage=config\n"
    );
    for secret in [
        "PRIVATE_CONFIG_PATH_SECRET",
        "PRIVATE_CONFIG_CONTENT_SECRET",
        fixture.0.to_str().unwrap(),
    ] {
        assert!(!String::from_utf8_lossy(&output.stderr).contains(secret));
    }
}

#[test]
fn rejected_arguments_have_one_closed_diagnostic_without_echoing_arguments() {
    let fixture = Fixture::new();
    let config = fixture.config(false);
    let cases = [
        vec!["PRIVATE_ARGUMENT_SECRET".into()],
        vec!["--config".into()],
        vec![
            "--config".into(),
            config.as_os_str().to_owned(),
            "PRIVATE_ARGUMENT_SECRET".into(),
        ],
        vec!["--worker".into(), "PRIVATE_ARGUMENT_SECRET".into()],
    ];
    for args in cases {
        let output = Command::new(env!("CARGO_BIN_EXE_caws-execution"))
            .args(args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert_eq!(output.stdout, b"");
        assert_eq!(
            output.stderr,
            b"caws-execution: startup-refused stage=arguments\n"
        );
    }
}

#[test]
fn self_image_refusal_is_distinct_from_configuration_and_channel_refusal() {
    let fixture = Fixture::new();
    let config_path = fixture.config(false);
    let mut config: Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
    config["native"]["sha256"] = Value::String("0".repeat(64));
    fs::write(&config_path, serde_json::to_vec(&config).unwrap()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_caws-execution"))
        .arg("--config")
        .arg(config_path)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(output.stdout, b"");
    assert_eq!(
        output.stderr,
        b"caws-execution: startup-refused stage=self-image\n"
    );
}

#[test]
fn synthetic_generation_drift_has_closed_call_stage_before_project_node_or_user() {
    exercise_synthetic_call_refusal(true);
}

#[test]
fn synthetic_preparation_identity_failure_preserves_closed_reason_without_metadata() {
    exercise_synthetic_call_refusal(false);
}

fn exercise_synthetic_call_refusal(generation_drift: bool) {
    let fixture = Fixture::new();
    let config = fixture.config(false);
    let configured: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    if !generation_drift {
        let initialized = Command::new("/usr/bin/git")
            .args(["init", "--quiet"])
            .arg(&fixture.0)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(initialized.status.success());
        fs::create_dir(fixture.0.join(".caws")).unwrap();
    }
    let (mut input, endpoint) = UnixStream::pair().unwrap();
    let stdin_fd: OwnedFd = endpoint.try_clone().unwrap().into();
    let stdout_fd: OwnedFd = endpoint.into();
    let mut child = Command::new(env!("CARGO_BIN_EXE_caws-execution"))
        .arg("--config")
        .arg(&config)
        .stdin(Stdio::from(stdin_fd))
        .stdout(Stdio::from(stdout_fd))
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut output = BufReader::new(input.try_clone().unwrap());
    let mut line = String::new();
    writeln!(
        input,
        "{}",
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}})
    )
    .unwrap();
    output.read_line(&mut line).unwrap();
    let initialized: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(
        initialized["result"]["serverInfo"]["name"],
        "caws-execution"
    );
    if generation_drift {
        fs::write(
            configured["authorizer"]["path"].as_str().unwrap(),
            "PRIVATE_GENERATION_DRIFT",
        )
        .unwrap();
    }
    let marker = fixture.0.join("USER-must-remain-absent");
    let state = json!({"sandboxCwd":format!("file://{}", fixture.0.display()), "useMxc":false,
        "privatePolicy":"PRIVATE_POLICY_CONTENT"});
    let launcher = if generation_drift {
        configured["host"]["path"].clone()
    } else {
        json!("/usr/bin/true")
    };
    let packet = json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
        "name":"caws_exec","arguments":{"source":format!("printf PRIVATE_SUBMITTED_SOURCE > {}", marker.display())},
        "_meta":{"sessionId":"PRIVATE_SESSION_ID","threadId":"PRIVATE_THREAD_ID","callId":"PRIVATE_CALL_ID",
            "codex/caller-context":{"version":1,"callerAnchor":{"kind":"local","cwd":fixture.0},"serverEnvironmentId":"PRIVATE_SERVER_ENV"},
            "codex/sandbox-state":state,"codex/sandbox-state-meta":state,
            "codex/sandbox-launcher":{"codexExecutable":launcher}}}});
    line.clear();
    writeln!(input, "{packet}").unwrap();
    output.read_line(&mut line).unwrap();
    let reply: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(reply["result"]["isError"], true);
    let detail: Value =
        serde_json::from_str(reply["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    let expected = if generation_drift {
        json!({"ok":false,"reason":"NativeBoundaryRefused","userSpawnMayHaveOccurred":false,"stage":"generation"})
    } else {
        json!({"ok":false,"reason":"NativeBoundaryRefused","userSpawnMayHaveOccurred":false,"stage":"preparation","preparationReason":"Identity"})
    };
    assert_eq!(detail, expected);
    for secret in ["PRIVATE_", fixture.0.to_str().unwrap()] {
        assert!(!line.contains(secret));
    }
    assert!(!marker.exists());
    println!("observed synthetic call refusal: {detail}");
    input.shutdown(std::net::Shutdown::Write).unwrap();
    assert!(child.wait().unwrap().success());
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    assert_eq!(stderr, "");
}
