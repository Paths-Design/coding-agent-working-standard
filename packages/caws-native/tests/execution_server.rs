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
        json!({"ok":false,"reason":"NativeBoundaryRefused","userSpawnMayHaveOccurred":false})
    );
    assert!(!line.contains("must-not-run"));
    input.shutdown(std::net::Shutdown::Write).unwrap();
    assert!(child.wait().unwrap().success());
}

#[test]
fn real_binary_refuses_configured_parent_mismatch_without_protocol_output() {
    let fixture = Fixture::new();
    let config = fixture.config(true);
    let (mut input, endpoint) = UnixStream::pair().unwrap();
    let stdin_fd: OwnedFd = endpoint.try_clone().unwrap().into();
    let stdout_fd: OwnedFd = endpoint.into();
    let mut child = Command::new(env!("CARGO_BIN_EXE_caws-execution"))
        .arg("--config")
        .arg(config)
        .stdin(Stdio::from(stdin_fd))
        .stdout(Stdio::from(stdout_fd))
        .spawn()
        .unwrap();
    let mut bytes = Vec::new();
    input.read_to_end(&mut bytes).unwrap();
    assert_eq!(child.wait().unwrap().code(), Some(2));
    assert!(bytes.is_empty());
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
}
