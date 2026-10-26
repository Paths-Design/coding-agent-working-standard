//! The real custodian entrypoint and its actual Child/group are exercised here.
//! Custodian component controls and native frame-pump controls use the actual
//! binary. The scripted engine fixture does not establish installed TS routing.
#![cfg(target_os = "macos")]
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{fs::PermissionsExt, net::UnixStream, process::CommandExt},
    },
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new(body: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "caws-context-git-test-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("git"), format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(root.join("git"), fs::Permissions::from_mode(0o700)).unwrap();
        Self { root }
    }
    fn start(&self, budget: Duration) -> (Child, UnixStream) {
        self.start_with_control(budget, &[])
    }
    fn start_with_control(&self, budget: Duration, control: &[u8]) -> (Child, UnixStream) {
        let (mut local, remote) = UnixStream::pair().unwrap();
        local
            .set_read_timeout(Some(Duration::from_secs(8)))
            .unwrap();
        let fd = unsafe { libc::fcntl(remote.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 64) };
        assert!(fd >= 64);
        let inherited = unsafe { OwnedFd::from_raw_fd(fd) };
        let mut command = Command::new(env!("CARGO_BIN_EXE_caws-native"));
        command
            .arg("context-git-custodian")
            .arg(fd.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        unsafe {
            command.pre_exec(move || {
                if libc::setsid() < 0 || libc::fcntl(fd, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn().unwrap();
        drop(inherited);
        drop(remote);
        let mut time = std::mem::MaybeUninit::<libc::timespec>::zeroed();
        assert_eq!(
            unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, time.as_mut_ptr()) },
            0
        );
        let time = unsafe { time.assume_init() };
        let now = time.tv_sec as u64 * 1_000_000_000 + time.tv_nsec as u64;
        let config = json!({"request": {"schema": "caws.runtime.context-git.request.v1", "id": "fixture", "runtimeDigest": "a".repeat(64),
            "token": "b".repeat(64), "ordinal": 1, "operation": "checkout", "executable": self.root.join("git"), "cwd": self.root},
            "environment": [[b"PATH".to_vec(), b"/usr/bin:/bin".to_vec()], [b"GIT_DIR".to_vec(), b"foreign".to_vec()], [b"HOOK_TOKEN".to_vec(), b"foreign".to_vec()]],
            "expires_ns": now + budget.as_nanos() as u64});
        let mut bytes = serde_json::to_vec(&config).unwrap();
        bytes.push(b'\n');
        bytes.extend_from_slice(control);
        local.write_all(&bytes).unwrap();
        (child, local)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn finish(mut child: Child, socket: UnixStream) -> Value {
    let mut line = String::new();
    BufReader::new(socket).read_line(&mut line).unwrap();
    let row: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(
        row["cleanup"],
        json!({"groupSettled": true, "stdoutEof": true, "stderrEof": true, "reaped": true}),
        "{row}"
    );
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success(), "custodian {status}");
            break;
        }
        assert!(Instant::now() < deadline, "settled custodian did not exit");
        std::thread::sleep(Duration::from_millis(5));
    }
    row
}
fn wait_file(path: &PathBuf) -> String {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Ok(text) = fs::read_to_string(path) {
            if !text.trim().is_empty() {
                return text;
            }
        }
        assert!(Instant::now() < deadline, "fixture did not start");
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn assert_process_not_live(pid: &str) {
    let output = Command::new("/bin/ps")
        .args(["-p", pid.trim(), "-o", "stat="])
        .output()
        .unwrap();
    assert!(
        output.status.success() || output.status.code() == Some(1),
        "ps observation failed"
    );
    let state = String::from_utf8(output.stdout).unwrap();
    assert!(
        state.trim().is_empty() || state.trim().starts_with('Z'),
        "descendant remains live: {state}"
    );
}

#[test]
fn real_custodian_preserves_argv_environment_and_nonzero_exit() {
    let fixture = Fixture::new(
        "test \"$GIT_DIR$HOOK_TOKEN\" = '' || exit 99\nprintf '%s\\n' \"$@\"\nprintf 'diagnostic' >&2\nexit 7",
    );
    let (child, socket) = fixture.start(Duration::from_secs(3));
    let row = finish(child, socket);
    assert_eq!(row["status"], "exited");
    assert_eq!(row["exitCode"], 7);
    assert_eq!(row["signal"], Value::Null);
    use base64::Engine;
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(row["stdout"].as_str().unwrap())
            .unwrap(),
        b"rev-parse\n--show-toplevel\n"
    );
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(row["stderr"].as_str().unwrap())
            .unwrap(),
        b"diagnostic"
    );
}

#[test]
fn coalesced_configuration_and_cancel_return_correlated_no_child_result() {
    let fixture = Fixture::new("echo spawned > spawned\nexit 99");
    let (child, socket) = fixture.start_with_control(Duration::from_secs(3), b"S");
    let row = finish(child, socket);
    assert_eq!(row["schema"], "caws.runtime.context-git.result.v1");
    assert_eq!(row["id"], "fixture");
    assert_eq!(row["runtimeDigest"], "a".repeat(64));
    assert_eq!(row["token"], "b".repeat(64));
    assert_eq!(row["ordinal"], 1);
    assert_eq!(row["operation"], "checkout");
    assert_eq!(row["status"], "cancelled");
    assert_eq!(row["exitCode"], Value::Null);
    assert_eq!(row["signal"], Value::Null);
    assert!(
        !fixture.root.join("spawned").exists(),
        "cancelled configuration created Git"
    );
}

#[test]
fn leader_exit_cannot_release_pipeholding_descendant() {
    let fixture = Fixture::new("sleep 30 &\necho $! > descendant\nexit 11");
    let (child, socket) = fixture.start(Duration::from_secs(3));
    let descendant = wait_file(&fixture.root.join("descendant"));
    let row = finish(child, socket);
    assert_eq!(row["status"], "exited");
    assert_eq!(row["exitCode"], 11);
    assert_process_not_live(&descendant);
}

#[test]
fn cancellation_stops_original_group_and_drains_pipes() {
    let fixture = Fixture::new("sleep 30 &\necho $! > descendant\nwait");
    let (child, mut socket) = fixture.start(Duration::from_secs(3));
    let descendant = wait_file(&fixture.root.join("descendant"));
    socket.write_all(b"S").unwrap();
    let row = finish(child, socket);
    assert_eq!(row["status"], "cancelled");
    assert_eq!(row["signal"], libc::SIGKILL);
    assert_process_not_live(&descendant);
}

#[test]
fn frontend_control_eof_cannot_orphan_git() {
    let fixture = Fixture::new("sleep 30 &\necho $! > descendant\nwait");
    let (mut child, socket) = fixture.start(Duration::from_secs(3));
    let descendant = wait_file(&fixture.root.join("descendant"));
    drop(socket);
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(
            Instant::now() < deadline,
            "custodian did not settle after frontend EOF"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_process_not_live(&descendant);
}

#[test]
fn deadline_and_combined_output_bound_settle_before_result() {
    let fixture = Fixture::new("sleep 30");
    let (child, socket) = fixture.start(Duration::from_millis(100));
    let row = finish(child, socket);
    assert_eq!(row["status"], "deadline");
    assert_eq!(row["signal"], libc::SIGKILL);
    let fixture = Fixture::new("/usr/bin/yes output");
    let (child, socket) = fixture.start(Duration::from_secs(3));
    let row = finish(child, socket);
    assert_eq!(row["status"], "output_limit");
    use base64::Engine;
    let total = base64::engine::general_purpose::STANDARD
        .decode(row["stdout"].as_str().unwrap())
        .unwrap()
        .len()
        + base64::engine::general_purpose::STANDARD
            .decode(row["stderr"].as_str().unwrap())
            .unwrap()
            .len();
    assert_eq!(total, 1024 * 1024);
}

const ENGINE: &str = r#"
const fs = require('node:fs');
const readline = require('node:readline');
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const iterator = lines[Symbol.asyncIterator]();
const read = async () => { const next = await iterator.next(); if(next.done) throw Error('native EOF'); return JSON.parse(next.value); };
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
(async () => {
 const request = await read();
 if(request.contextGit !== 'caws.runtime.context-git.v1') throw Error('missing native capability');
 const root = process.env.CONTEXT_GIT_FIXTURE_ROOT;
 const mode = process.env.CONTEXT_GIT_FIXTURE_MODE;
 const identity = { id: request.id, runtimeDigest: request.runtimeDigest };
 const git = ordinal => ({ schema:'caws.runtime.context-git.request.v1', ...identity, token:'b'.repeat(64), ordinal,
   operation: ordinal === 1 ? 'checkout' : 'commonDir', executable:root + '/git', cwd:root });
 const ready = () => ({ schema:'caws.runtime.ready.v1', ...identity, active:false, budgetHome:root, projectDigest:null, sessionId:null });
 if(mode === 'malformed') { write({...git(1), operation:'shell', args:['-c','echo unsafe']}); return; }
 if(mode === 'overlap') { process.stdout.write(JSON.stringify(git(1)) + '\n' + JSON.stringify(git(2)) + '\n'); return; }
 if(mode === 'earlyReady') { process.stdout.write(JSON.stringify(git(1)) + '\n' + JSON.stringify(ready()) + '\n'); return; }
 if(mode === 'earlyFailure') { process.stdout.write(JSON.stringify(git(1)) + '\n' + JSON.stringify({schema:'caws.runtime.failure.v1',...identity,message:'premature failure'}) + '\n'); return; }
 if(mode === 'eof') { write(git(1)); process.stdout.end(); return; }
 if(mode === 'afterReady') { write(ready()); await read(); write(git(1)); return; }
 if(mode === 'responseOverlap') {
   write(git(1));
   // A new request on the first partial result chunk precedes its LF. The
   // deliberately large result prevents one final write from hiding overlap.
   process.stdin.once('data', () => write(git(2)));
   await new Promise(resolve => setTimeout(resolve, 1000)); return;
 }
 for(let ordinal = 1; ordinal <= 2; ordinal++) {
   write(git(ordinal));
   // Exercise Node stderr drain while the native owner waits for Git.
   process.stderr.write('e'.repeat(16000));
   const result = await read();
   fs.appendFileSync(root + '/results.jsonl', JSON.stringify(result) + '\n');
   if(result.id !== request.id || result.runtimeDigest !== request.runtimeDigest || result.ordinal !== ordinal ||
      result.token !== 'b'.repeat(64) || result.status !== 'exited' || result.exitCode !== 0 ||
      !Object.values(result.cleanup).every(value => value === true)) throw Error('invalid settled Git result');
 }
 if(mode === 'failureAfterResult') { write({schema:'caws.runtime.failure.v1',...identity,message:'valid failure after settled context'}); return; }
 write(ready()); await read();
 write({schema:'caws.runtime.proposal.v2',...identity,token:'proposal',containment:null,
   response:{schema:'caws.runtime.response.v1',...identity,result:{exitCode:0,stdoutBase64:Buffer.from('context-ok\n').toString('base64'),stderrBase64:''}}});
 await read(); lines.close();
})().then(() => process.exit(0), error => { console.error(error); process.exit(3); });
"#;

fn invoke(fixture: &Fixture, mode: &str) -> std::process::Output {
    fs::write(fixture.root.join("engine.cjs"), ENGINE).unwrap();
    let selected_node = std::env::var_os("CAWS_NATIVE_CUSTODY_NODE_PATH")
        .map(|value| {
            let path = PathBuf::from(value);
            assert!(path.is_absolute(), "fixture Node override must be absolute");
            path
        })
        .unwrap_or_else(|| PathBuf::from("node"));
    let node = Command::new(selected_node)
        .args(["-p", "process.execPath"])
        .output()
        .expect("actual Node executable required");
    assert!(node.status.success());
    let node = String::from_utf8(node.stdout).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_caws-native"));
    command
        .args(["invoke", "--engine"])
        .arg(fixture.root.join("engine.cjs"))
        .args([
            "--node",
            node.trim(),
            "--surface",
            "codex",
            "--event",
            "pre_tool_use",
            "--runtime-digest",
            &"a".repeat(64),
            "--timeout-ms",
            "6000",
            "--configuration",
            "project",
        ])
        .env("CONTEXT_GIT_FIXTURE_ROOT", &fixture.root)
        .env("CONTEXT_GIT_FIXTURE_MODE", mode)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"{\n \"raw\": 90071992547409931234567890\n}\n")
        .unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn native_frame_pump_services_two_git_requests_before_ready() {
    let fixture = Fixture::new("printf '%s\\n' \"$*\" >> args\nprintf '%s\\n' \"$PWD\"");
    let output = invoke(&fixture, "normal");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"context-ok\n");
    let arguments = fs::read_to_string(fixture.root.join("args")).unwrap();
    assert_eq!(
        arguments,
        "rev-parse --show-toplevel\nrev-parse --path-format=absolute --git-common-dir\n"
    );
    let results = fs::read_to_string(fixture.root.join("results.jsonl")).unwrap();
    let rows: Vec<Value> = results
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["operation"], "checkout");
    assert_eq!(rows[1]["operation"], "commonDir");
    assert_eq!(rows[0]["id"], rows[1]["id"]);
}

#[test]
fn native_phase_guards_refuse_arbitrary_overlap_and_post_ready_git() {
    for (mode, diagnostic) in [
        ("malformed", "context Git request"),
        ("overlap", "overlapped pending context Git"),
        ("earlyReady", "overlapped pending context Git"),
        ("earlyFailure", "overlapped pending context Git"),
        ("afterReady", "context Git request after Ready"),
    ] {
        let fixture = Fixture::new("echo spawned > spawned\nexit 0");
        let output = invoke(&fixture, mode);
        assert_eq!(
            output.status.code(),
            Some(2),
            "{mode}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(diagnostic),
            "{mode}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            !fixture.root.join("spawned").exists(),
            "{mode} spawned Git despite refusal"
        );
    }
}

#[test]
fn native_valid_failure_after_git_result_is_distinct_from_early_eof() {
    let fixture = Fixture::new("printf '%s\\n' \"$PWD\"");
    let output = invoke(&fixture, "failureAfterResult");
    assert_eq!(output.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("valid failure after settled context")
    );
    let results = fs::read_to_string(fixture.root.join("results.jsonl")).unwrap();
    assert_eq!(results.lines().count(), 2);
    let fixture = Fixture::new("echo spawned > spawned\nsleep 30");
    let output = invoke(&fixture, "eof");
    assert_eq!(output.status.code(), Some(2));
    let diagnostic = String::from_utf8_lossy(&output.stderr);
    assert!(
        diagnostic.contains("stream closed during pending context Git")
            || diagnostic.contains("overlapped pending context Git"),
        "{diagnostic}"
    );
}

#[test]
fn native_refuses_second_request_during_backpressured_partial_git_result() {
    let fixture = Fixture::new("/usr/bin/head -c 524288 /dev/zero");
    let output = invoke(&fixture, "responseOverlap");
    assert_eq!(output.status.code(), Some(2));
    let diagnostic = String::from_utf8_lossy(&output.stderr);
    assert!(
        diagnostic.contains("overlapped partial context Git result"),
        "{diagnostic}"
    );
}
