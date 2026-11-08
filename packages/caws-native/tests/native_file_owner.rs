#![cfg(target_os = "macos")]

use serde_json::Value;
use std::{
    fs,
    io::Write,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
    process::{Command, Output, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static SERIAL: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    home: PathBuf,
    project: PathBuf,
    lane: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        Self::with_original_home(None)
    }
    fn with_original_home(shared: Option<PathBuf>) -> Self {
        let parent = std::env::var_os("CAWS_NATIVE_TEST_ARTIFACT_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        assert!(parent.is_absolute());
        fs::create_dir_all(&parent).unwrap();
        let root = parent.join(format!(
            "native-file-owner-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let root = root.canonicalize().unwrap();
        let node = PathBuf::from(
            std::env::var_os("CAWS_NATIVE_CUSTODY_NODE_PATH")
                .expect("supply real Node through CAWS_NATIVE_CUSTODY_NODE_PATH"),
        )
        .canonicalize()
        .unwrap();
        assert!(node.is_absolute());
        fs::create_dir(root.join("bin")).unwrap();
        let home = shared.unwrap_or_else(|| root.join("home"));
        if !home.exists() {
            fs::create_dir(&home).unwrap();
            fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
        }
        fs::create_dir(root.join("machine")).unwrap();
        fs::set_permissions(root.join("machine"), fs::Permissions::from_mode(0o700)).unwrap();
        symlink(&node, root.join("configured-node")).unwrap();
        fs::write(
            root.join("configured-git"),
            br#"#!/bin/sh
printf 'query\n' >> "${NATIVE_FILE_ROOT}/git-queries.log"
exec /usr/bin/git "$@"
"#,
        )
        .unwrap();
        fs::set_permissions(
            root.join("configured-git"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        let project = root.join("project");
        fs::create_dir(&project).unwrap();
        let git = |args: &[&str]| {
            let output = Command::new("/usr/bin/git")
                .args(args)
                .current_dir(&project)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "-b", "main"]);
        git(&[
            "-c",
            "user.name=Native fixture",
            "-c",
            "user.email=native@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-m",
            "fixture",
        ]);
        fs::create_dir(project.join(".caws")).unwrap();
        let lane = project.join(".caws/worktrees/owned");
        git(&["worktree", "add", "-b", "owned", lane.to_str().unwrap()]);
        fs::write(root.join("engine.cjs"), ENGINE).unwrap();
        Self {
            root,
            home,
            project,
            lane,
        }
    }

    fn invoke(&self, mode: &str, tool: &str) -> Output {
        // nativeEventTimeoutMs clamps the registered Claude callback to this
        // existing production interval; no runtime deadline is changed here.
        self.invoke_with_timeout(mode, tool, 30_000)
    }

    fn invoke_with_timeout(&self, mode: &str, tool: &str, timeout_ms: u32) -> Output {
        self.invoke_with_count(mode, tool, timeout_ms, 1)
    }
    fn invoke_with_count(&self, mode: &str, tool: &str, timeout_ms: u32, count: u64) -> Output {
        let timeout = timeout_ms.to_string();
        let mut child = Command::new(env!("CARGO_BIN_EXE_caws-native"))
            .arg("invoke")
            .arg("--engine")
            .arg(self.root.join("engine.cjs"))
            .arg("--node")
            .arg(self.root.join("configured-node"))
            .args([
                "--surface",
                "claude-code",
                "--event",
                "pre_tool_use",
                "--runtime-digest",
                &"a".repeat(64),
                "--timeout-ms",
                timeout.as_str(),
                "--configuration",
                "system",
            ])
            .current_dir(&self.lane)
            .env_clear()
            // No literal PATH Git or Node: native selection is configured.
            .env("PATH", self.root.join("bin"))
            .env("HOME", &self.home)
            .env("CAWS_HOME", self.root.join("machine"))
            .env("CAWS_GIT_BINARY", self.root.join("configured-git"))
            .env("NATIVE_FILE_ROOT", &self.root)
            .env("NATIVE_FILE_PROJECT", &self.project)
            .env("NATIVE_FILE_LANE", &self.lane)
            .env("NATIVE_FILE_MODE", mode)
            .env("NATIVE_FILE_EXPECTED_COUNT", count.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let payload = serde_json::json!({
            "session_id":"native-file-owner",
            "cwd":self.lane,
            "tool_name":tool,
            "tool_use_id":"original-native-file-tool",
            "permission_mode":"default",
            "tool_input":{"file_path":"owned.rs","content":"owned content"}
        })
        .to_string();
        let payload = match mode {
            "duplicate-session" => payload.replacen(
                "\"session_id\":\"native-file-owner\"",
                "\"session_id\":\"foreign\",\"session_id\":\"native-file-owner\"",
                1,
            ),
            "escaped-duplicate-session" => payload.replacen(
                "\"session_id\":\"native-file-owner\"",
                "\"session_id\":\"foreign\",\"session_\\u0069d\":\"native-file-owner\"",
                1,
            ),
            "empty-session" => payload.replacen(
                "\"session_id\":\"native-file-owner\"",
                "\"session_id\":\"\"",
                1,
            ),
            "duplicate-tool" => payload.replacen(
                "\"tool_name\":\"Write\"",
                "\"tool_name\":\"Edit\",\"tool_name\":\"Write\"",
                1,
            ),
            "duplicate-cwd" => payload.replacen("\"cwd\":", "\"cwd\":null,\"cwd\":", 1),
            "duplicate-file-path" => payload.replacen(
                "\"file_path\":\"owned.rs\"",
                "\"file_path\":\"foreign.rs\",\"file_path\":\"owned.rs\"",
                1,
            ),
            "lossy-session" => payload.replacen(
                "\"session_id\":\"native-file-owner\"",
                "\"session_id\":\"native:file-owner\"",
                1,
            ),
            "opaque-duplicates" => payload.replacen('{', "{\"opaque\":1e9999,\"opaque\":2,", 1),
            _ => payload,
        };
        child
            .stdin
            .take()
            .unwrap()
            .write_all(payload.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        fs::write(self.root.join("native.stdout"), &output.stdout).unwrap();
        fs::write(self.root.join("native.stderr"), &output.stderr).unwrap();
        output
    }

    fn state(&self) -> Option<Value> {
        // StrikeStore::open: HOME/.caws/state/sessions/<safe>/strikes.json.
        let path = self
            .home
            .join(".caws/state/sessions/native-file-owner/strikes.json");
        match fs::read(path) {
            Ok(bytes) => Some(serde_json::from_slice(&bytes).unwrap()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => panic!("cannot read actual strike state: {error}"),
        }
    }

    fn rows(&self) -> Vec<Value> {
        fs::read_to_string(self.root.join("wire.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}

const ENGINE: &str = r#"
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const readline = require('node:readline');
const root = process.env.NATIVE_FILE_ROOT;
const mode = process.env.NATIVE_FILE_MODE;
const lines = readline.createInterface({input:process.stdin});
const queued = [];
let waiting;
lines.on('line', line => {
  const value = JSON.parse(line);
  fs.appendFileSync(root + '/wire.jsonl', JSON.stringify(value) + '\n');
  if (waiting) { const resolve = waiting; waiting = null; resolve(value); }
  else queued.push(value);
});
const receive = () => queued.length ? Promise.resolve(queued.shift())
  : new Promise(resolve => { waiting = resolve; });
const sendText = text => {
  fs.appendFileSync(root + '/controls.jsonl', text);
  return process.stdout.write(text);
};
const send = value => sendText(JSON.stringify(value) + '\n');
(async () => {
  const request = await receive();
  const original = JSON.parse(request.inputJson);
  assert.equal(request.surface, 'claude-code');
  assert.equal(request.caller.cwd, process.env.NATIVE_FILE_LANE);
  assert.equal(request.fileToolContext, 'caws.runtime.file-tool-context.v2');
  assert.equal(request.guardStrikes, 'caws.runtime.guard-strikes.v2');
  assert.equal(request.stockScopeResolver, undefined);
  const identity = {id:request.id, runtimeDigest:request.runtimeDigest};
  const token = 'b'.repeat(64);
  let snapshot = null;
  const ready = active => ({
    schema:'caws.runtime.ready.v1', ...identity, active,
    budgetHome:root + '/machine',
    projectDigest:active ? crypto.createHash('sha256')
      .update(process.env.NATIVE_FILE_PROJECT).digest('hex') : null,
    sessionId:active ? original.session_id : null
  });
  const proposal = (exitCode, stdout) => ({
    schema:'caws.runtime.proposal.v2', ...identity, token:'proposal',
    containment:null,
    response:{schema:'caws.runtime.response.v1', ...identity,
      result:{exitCode,stdoutBase64:Buffer.from(stdout).toString('base64'),stderrBase64:''}}
  });
  async function finish(exitCode, stdout) {
    send(proposal(exitCode, stdout));
    const handoff = await receive();
    assert.equal(handoff.schema, 'caws.runtime.handoff.v2');
    assert.equal(handoff.success, true);
    lines.close();
    process.exit(0);
  }
  const contextFrame = ordinal => ({
    schema:'caws.runtime.file-tool-context.request.v2', ...identity,
    token, ordinal, snapshotToken:snapshot
  });
  async function context(ordinal) {
    send(contextFrame(ordinal));
    const result = await receive();
    assert.equal(result.schema, 'caws.runtime.file-tool-context.result.v2');
    assert.equal(Object.keys(result).length, 7);
    assert.equal(result.id, request.id);
    assert.equal(result.runtimeDigest, request.runtimeDigest);
    assert.equal(result.token, token);
    assert.equal(result.ordinal, ordinal);
    assert.match(result.snapshotToken, /^[a-f0-9]{64}$/);
    if (snapshot !== null) assert.equal(result.snapshotToken, snapshot);
    snapshot = result.snapshotToken;
    assert.equal(result.context.checkout, process.env.NATIVE_FILE_LANE);
    assert.equal(result.context.canonical, process.env.NATIVE_FILE_PROJECT);
    assert.equal(result.context.branch, 'owned');
    assert.equal(result.context.mergeInProgress, false);
    assert.equal(result.stockScopeResolver, undefined);
    return result;
  }
  const actions = {
    scope_guard:'increment_scope_guard',
    shortcut_language:'increment_shortcut_language'
  };
  function strikeFrame(key, change = {}) {
    assert.ok(actions[key]);
    return {schema:'caws.runtime.guard-strikes.request.v2', ...identity,
      token, operation:actions[key], contextSnapshotToken:snapshot, ...change};
  }
  async function strike(key, change) {
    send(strikeFrame(key, change));
    const result = await receive();
    assert.equal(result.schema, 'caws.runtime.guard-strikes.result.v2');
    assert.equal(Object.keys(result).length, 8);
    assert.equal(result.id, request.id);
    assert.equal(result.runtimeDigest, request.runtimeDigest);
    assert.equal(result.token, token);
    assert.equal(result.operation, actions[key]);
    assert.equal(result.contextSnapshotToken, snapshot);
    assert.equal(result.count, Number(process.env.NATIVE_FILE_EXPECTED_COUNT));
    assert.match(result.stateSha256, /^[a-f0-9]{64}$/);
  }
  if (mode === 'decline' || mode === 'zero-effect-refusal') {
    send(ready(false));
    assert.equal((await receive()).schema, 'caws.runtime.dispatch.v1');
    return finish(mode === 'decline' ? 0 : 2,
      mode === 'decline' ? 'must-not-deliver\n' : 'native refusal\n');
  }
  if (mode === 'hold-before-capture') {
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  await context(1);
  send(ready(true));
  assert.equal((await receive()).schema, 'caws.runtime.dispatch.v1');
  if (mode === 'context-overlap-strike') {
    sendText(JSON.stringify(strikeFrame('scope_guard')) + '\n'
      + JSON.stringify(contextFrame(2)) + '\n');
    await receive();
    throw Error('overlapping observation admitted');
  }
  if (mode === 'shortcut-before-capture2') {
    await strike('shortcut_language');
    throw Error('premature shortcut admitted');
  }
  for (const [name, change] of [
    ['wrong-token', {token:'c'.repeat(64)}],
    ['wrong-snapshot', {contextSnapshotToken:'c'.repeat(64)}],
    ['wrong-id', {id:request.id + '-foreign'}],
    ['wrong-digest', {runtimeDigest:'c'.repeat(64)}],
    ['malformed', {home:'/foreign'}],
    ['legacy-action', {operation:'scope_guard'}]
  ]) {
    if (mode === name) {
      await strike('scope_guard', change);
      throw Error(name + ' admitted');
    }
  }
  if (mode === 'duplicate-operation') {
    const text = JSON.stringify(strikeFrame('scope_guard')).replace(
      '"operation":"increment_scope_guard"',
      '"operation":"increment_shortcut_language","operation":"increment_scope_guard"');
    sendText(text + '\n');
    await receive();
    throw Error('duplicate operation admitted');
  }
  if (mode === 'reversed-context') {
    await context(3);
    throw Error('reversed context admitted');
  }
  if (!['scope-after-capture2','late-unused-scope'].includes(mode)) {
    await strike('scope_guard');
  }
  if (mode === 'scope-replay') {
    await strike('scope_guard');
    throw Error('scope replay admitted');
  }
  await context(2);
  if (mode === 'scope-after-capture2') {
    await strike('scope_guard');
    throw Error('unused late scope admitted');
  }
  if ((original.tool_name === 'Write' && mode !== 'late-unused-shortcut')
      || mode === 'edit-shortcut') {
    await strike('shortcut_language');
  }
  if (mode === 'shortcut-replay') {
    await strike('shortcut_language');
    throw Error('shortcut replay admitted');
  }
  if (mode === 'missing-allow') return finish(0, 'must-not-deliver\n');
  if (mode === 'missing-warning') return finish(1, 'must-not-deliver\n');
  if (mode === 'missing-ask') {
    return finish(0, JSON.stringify({
      hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'ask',
        permissionDecisionReason:'must-not-deliver'}
    }) + '\n');
  }
  if (mode === 'git-image-drift') {
    fs.unlinkSync(root + '/configured-git');
    fs.symlinkSync('/usr/bin/git', root + '/configured-git');
  }
  if (mode === 'terminal-refusal') return finish(2, 'native refusal\n');
  await context(3);
  if (mode === 'late-unused-scope' || mode === 'late-unused-shortcut') {
    await strike(mode === 'late-unused-scope' ? 'scope_guard' : 'shortcut_language');
    throw Error('unused operation after final observation admitted');
  }
  if (mode === 'late-strike') {
    await strike('shortcut_language');
    throw Error('post-final strike admitted');
  }
  if (mode === 'buffered-late-strike') {
    sendText(JSON.stringify(proposal(0, 'must-not-deliver\n')) + '\n'
      + JSON.stringify(strikeFrame('shortcut_language')) + '\n');
    await receive();
    throw Error('buffered late strike accompanied allow');
  }
  await finish(0, 'native-owner-ok\n');
})().catch(error => {
  fs.writeFileSync(root + '/engine-error.txt', String(error));
  process.stderr.write(String(error));
  process.exit(7);
});
"#;

impl Fixture {
    fn controls(&self) -> Vec<Value> {
        fs::read_to_string(self.root.join("controls.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn context_results(&self) -> Vec<Value> {
        self.rows()
            .into_iter()
            .filter(|row| row["schema"] == "caws.runtime.file-tool-context.result.v2")
            .collect()
    }

    fn strike_controls(&self) -> Vec<Value> {
        self.controls()
            .into_iter()
            .filter(|row| row["schema"] == "caws.runtime.guard-strikes.request.v2")
            .collect()
    }
}

#[test]
fn first_publication_initializes_original_home_and_does_not_follow_machine_home() {
    let fixture = Fixture::new();
    assert!(!fixture.home.join(".caws").exists());
    let output = fixture.invoke("complete", "Write");
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"native-owner-ok\n");
    let state = fixture.state().unwrap();
    assert_eq!(state["scope_guard"], 1);
    assert_eq!(state["shortcut_language"], 1);
    assert_eq!(
        fs::metadata(fixture.home.join(".caws"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert!(
        !fixture
            .root
            .join("machine/state/sessions/native-file-owner/strikes.json")
            .exists()
    );
}

#[test]
fn one_session_keeps_its_standing_across_repositories_and_machine_homes() {
    let first = Fixture::new();
    let second = Fixture::with_original_home(Some(first.home.clone()));
    assert_ne!(first.project, second.project);
    assert_ne!(first.root.join("machine"), second.root.join("machine"));
    for (fixture, expected) in [(&first, 1), (&second, 2)] {
        let output = fixture.invoke_with_count("complete", "Write", 30_000, expected);
        assert_eq!(
            output.status.code(),
            Some(0),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"native-owner-ok\n");
        let state = fixture.state().unwrap();
        assert_eq!(state["scope_guard"], expected);
        assert_eq!(state["shortcut_language"], expected);
        assert!(
            !fixture
                .root
                .join("machine/state/sessions/native-file-owner/strikes.json")
                .exists()
        );
    }
}

#[test]
fn unsafe_original_home_or_counter_root_cannot_create_state_or_redirect_publication() {
    for mode in ["symlink", "file", "shared-home"] {
        let fixture = Fixture::new();
        let target = fixture.home.join(".caws");
        let victim = fixture.root.join("victim");
        fs::create_dir(&victim).unwrap();
        match mode {
            "symlink" => symlink(&victim, &target).unwrap(),
            "file" => fs::write(&target, b"preserve original entry").unwrap(),
            "shared-home" => {
                fs::set_permissions(&fixture.home, fs::Permissions::from_mode(0o777)).unwrap()
            }
            _ => unreachable!(),
        }
        let output = fixture.invoke("complete", "Write");
        assert_eq!(output.status.code(), Some(2), "{mode}");
        assert_eq!(fixture.context_results().len(), 1, "{mode}");
        assert_eq!(fixture.strike_controls().len(), 1, "{mode}");
        let diagnostic = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(diagnostic.contains("UnsafePath"), "{mode}: {diagnostic}");
        assert_eq!(fs::read_dir(&victim).unwrap().count(), 0, "{mode}");
        assert!(
            !fixture
                .root
                .join("machine/state/sessions/native-file-owner/strikes.json")
                .exists(),
            "{mode}"
        );
        match mode {
            "symlink" => assert_eq!(fs::read_link(&target).unwrap(), victim),
            "file" => assert_eq!(fs::read(&target).unwrap(), b"preserve original entry"),
            "shared-home" => {
                assert!(!target.exists());
                assert_eq!(
                    fs::metadata(&fixture.home).unwrap().permissions().mode() & 0o777,
                    0o777
                );
            }
            _ => unreachable!(),
        }
    }
}

#[test]
fn real_native_write_and_edit_observe_original_canonical_roots_and_fixed_counters() {
    for tool in ["Write", "Edit"] {
        let fixture = Fixture::new();
        let output = fixture.invoke("complete", tool);
        assert_eq!(
            output.status.code(),
            Some(0),
            "{tool}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"native-owner-ok\n");
        let state = fixture.state().expect("actual durable strike state");
        assert_eq!(state["scope_guard"], 1);
        if tool == "Write" {
            assert_eq!(state["shortcut_language"], 1);
        } else {
            assert!(state.get("shortcut_language").is_none());
        }
        let contexts = fixture.context_results();
        assert_eq!(contexts.len(), 3);
        assert_eq!(contexts[0]["ordinal"], 1);
        assert_eq!(contexts[1]["ordinal"], 2);
        assert_eq!(contexts[2]["ordinal"], 3);
        assert_eq!(contexts[0]["snapshotToken"], contexts[2]["snapshotToken"]);
        assert!(
            !fs::read(fixture.root.join("git-queries.log"))
                .unwrap()
                .is_empty()
        );
        let strikes = fixture.strike_controls();
        assert_eq!(strikes.len(), if tool == "Write" { 2 } else { 1 });
        for strike in strikes {
            assert_eq!(strike["token"], contexts[0]["token"]);
            assert_eq!(strike["contextSnapshotToken"], contexts[0]["snapshotToken"]);
        }
    }
}

#[test]
fn engine_declared_inactivity_cannot_allow_a_declared_native_file_callback() {
    let fixture = Fixture::new();
    let output = fixture.invoke("decline", "Write");
    assert_eq!(
        output.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("must-not-deliver"));
    assert!(fixture.state().is_none());
    assert!(!fixture.root.join("git-queries.log").exists());
    assert!(fixture.context_results().is_empty());
    assert!(fixture.strike_controls().is_empty());
    assert!(fixture.controls().iter().any(|row| {
        row["schema"] == "caws.runtime.proposal.v2" && row["response"]["result"]["exitCode"] == 0
    }));
}

#[test]
fn protective_refusal_can_complete_with_zero_queries_and_zero_effects() {
    let fixture = Fixture::new();
    let output = fixture.invoke("zero-effect-refusal", "Write");
    assert_eq!(
        output.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"native refusal\n");
    assert!(fixture.state().is_none());
    assert!(!fixture.root.join("git-queries.log").exists());
    assert!(fixture.context_results().is_empty());
    assert!(fixture.strike_controls().is_empty());
}

#[test]
fn a_short_original_deadline_is_not_renewed_to_complete_native_work() {
    let fixture = Fixture::new();
    let output = fixture.invoke_with_timeout("hold-before-capture", "Write", 5000);
    assert_eq!(output.status.code(), Some(2));
    assert!(!String::from_utf8_lossy(&output.stdout).contains("native-owner-ok"));
    assert!(fixture.state().is_none());
    assert!(!fixture.root.join("git-queries.log").exists());
    assert!(fixture.context_results().is_empty());
    let diagnostic = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(diagnostic.contains("deadline"), "{diagnostic}");
}

#[test]
fn ambiguous_or_missing_original_identity_refuses_before_queries_or_publication() {
    for (mode, diagnostic) in [
        ("duplicate-session", "session_id"),
        ("escaped-duplicate-session", "session_id"),
        ("empty-session", "nonempty original session"),
        ("duplicate-tool", "tool_name"),
        ("duplicate-cwd", "cwd"),
        ("duplicate-file-path", "file_path"),
    ] {
        let fixture = Fixture::new();
        let output = fixture.invoke(mode, "Write");
        assert_eq!(output.status.code(), Some(2), "{mode}");
        assert!(fixture.state().is_none(), "{mode}");
        assert!(
            !fixture.root.join("home/.caws/state/sessions").exists(),
            "{mode}"
        );
        assert!(!fixture.root.join("git-queries.log").exists(), "{mode}");
        let diagnostic_output = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            diagnostic_output.contains(diagnostic),
            "{mode}: {diagnostic_output}"
        );
        if mode != "empty-session" {
            assert!(
                diagnostic_output.contains("duplicate field"),
                "{mode}: {diagnostic_output}"
            );
        }
    }
}

#[test]
fn unrelated_opaque_duplicate_extensions_and_large_numerals_do_not_select_authority() {
    let fixture = Fixture::new();
    let output = fixture.invoke("opaque-duplicates", "Write");
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"native-owner-ok\n");
    let state = fixture.state().unwrap();
    assert_eq!(state["scope_guard"], 1);
    assert_eq!(state["shortcut_language"], 1);
    assert_eq!(fixture.context_results().len(), 3);
    assert!(
        !fs::read(fixture.root.join("git-queries.log"))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn allow_warning_and_ask_require_delivered_capture3_after_actual_publications() {
    for mode in ["missing-allow", "missing-warning", "missing-ask"] {
        let fixture = Fixture::new();
        let output = fixture.invoke(mode, "Write");
        assert_eq!(output.status.code(), Some(2), "{mode}");
        assert!(
            !String::from_utf8_lossy(&output.stdout).contains("must-not-deliver"),
            "{mode}"
        );
        let state = fixture.state().expect("both completed transactions remain");
        assert_eq!(state["scope_guard"], 1, "{mode}");
        assert_eq!(state["shortcut_language"], 1, "{mode}");
        assert_eq!(fixture.context_results().len(), 2, "{mode}");
        assert!(
            fixture.controls().iter().any(|row| {
                row["schema"] == "caws.runtime.proposal.v2"
                    && row["response"]["result"]["stdoutBase64"]
                        .as_str()
                        .is_some_and(|value| !value.is_empty())
            }),
            "{mode}: intended nonblocking proposal was not emitted"
        );
    }
}

#[test]
fn original_refusal_retains_completed_effects_without_another_observation() {
    let fixture = Fixture::new();
    let output = fixture.invoke("terminal-refusal", "Write");
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(output.stdout, b"native refusal\n");
    let state = fixture.state().unwrap();
    assert_eq!(state["scope_guard"], 1);
    assert_eq!(state["shortcut_language"], 1);
    assert_eq!(fixture.context_results().len(), 2);
    assert_eq!(fixture.strike_controls().len(), 2);
}

#[test]
fn forged_malformed_and_wrong_action_requests_do_not_publish() {
    for mode in [
        "wrong-token",
        "wrong-snapshot",
        "wrong-id",
        "wrong-digest",
        "malformed",
        "legacy-action",
        "duplicate-operation",
    ] {
        let fixture = Fixture::new();
        let output = fixture.invoke(mode, "Write");
        assert_eq!(output.status.code(), Some(2), "{mode}");
        assert!(fixture.state().is_none(), "{mode}");
        assert!(
            !fixture.root.join("home/.caws/state/sessions").exists(),
            "{mode}"
        );
        assert_eq!(fixture.context_results().len(), 1, "{mode}");
        assert_eq!(fixture.strike_controls().len(), 1, "{mode}");
        let strike = fixture.strike_controls().remove(0);
        match mode {
            "wrong-token" => assert_eq!(strike["token"], "c".repeat(64)),
            "wrong-snapshot" => assert_eq!(strike["contextSnapshotToken"], "c".repeat(64)),
            "wrong-id" => assert!(strike["id"].as_str().unwrap().ends_with("-foreign")),
            "wrong-digest" => assert_eq!(strike["runtimeDigest"], "c".repeat(64)),
            "malformed" => assert_eq!(strike["home"], "/foreign"),
            "legacy-action" => assert_eq!(strike["operation"], "scope_guard"),
            "duplicate-operation" => {
                let raw = fs::read_to_string(fixture.root.join("controls.jsonl")).unwrap();
                assert!(raw.contains(
                    "\"operation\":\"increment_shortcut_language\",\"operation\":\"increment_scope_guard\""
                ));
            }
            _ => unreachable!(),
        }
        assert!(
            !String::from_utf8_lossy(&output.stdout).contains("native-owner-ok"),
            "{mode}"
        );
    }
}

#[test]
fn foreign_phase_and_overlapping_observation_controls_do_not_publish() {
    for mode in [
        "shortcut-before-capture2",
        "scope-after-capture2",
        "reversed-context",
        "context-overlap-strike",
    ] {
        let fixture = Fixture::new();
        let output = fixture.invoke(mode, "Write");
        assert_eq!(output.status.code(), Some(2), "{mode}");
        assert!(fixture.state().is_none(), "{mode}");
        assert!(
            !fixture.root.join("home/.caws/state/sessions").exists(),
            "{mode}"
        );
        let controls = fixture.controls();
        match mode {
            "shortcut-before-capture2" => {
                assert_eq!(fixture.context_results().len(), 1);
                assert_eq!(
                    fixture.strike_controls()[0]["operation"],
                    "increment_shortcut_language"
                );
            }
            "scope-after-capture2" => {
                assert_eq!(fixture.context_results().len(), 2);
                assert_eq!(fixture.strike_controls().len(), 1);
                assert_eq!(
                    fixture.strike_controls()[0]["operation"],
                    "increment_scope_guard"
                );
            }
            "reversed-context" => {
                assert_eq!(fixture.context_results().len(), 1);
                assert!(controls.iter().any(|row| {
                    row["schema"] == "caws.runtime.file-tool-context.request.v2"
                        && row["ordinal"] == 3
                }));
            }
            "context-overlap-strike" => {
                assert_eq!(fixture.context_results().len(), 1);
                let last = &controls[controls.len() - 2..];
                assert_eq!(last[0]["operation"], "increment_scope_guard");
                assert_eq!(
                    last[1]["schema"],
                    "caws.runtime.file-tool-context.request.v2"
                );
                assert_eq!(last[1]["ordinal"], 2);
            }
            _ => unreachable!(),
        }
    }
}

#[test]
fn edit_cannot_publish_the_write_only_shortcut_operation() {
    let fixture = Fixture::new();
    let output = fixture.invoke("edit-shortcut", "Edit");
    assert_eq!(output.status.code(), Some(2));
    let state = fixture.state().unwrap();
    assert_eq!(state["scope_guard"], 1);
    assert!(state.get("shortcut_language").is_none());
    assert_eq!(fixture.context_results().len(), 2);
    assert_eq!(
        fixture.strike_controls()[1]["operation"],
        "increment_shortcut_language"
    );
}

#[test]
fn lossy_legacy_session_bucket_alias_is_not_used_by_native_publication() {
    let fixture = Fixture::new();
    let output = fixture.invoke("lossy-session", "Write");
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(fixture.context_results().len(), 1);
    assert_eq!(
        fixture.strike_controls()[0]["operation"],
        "increment_scope_guard"
    );
    assert!(!fixture.root.join("home/.caws/state/sessions").exists());
}

#[test]
fn independent_unused_operations_are_refused_after_final_observation() {
    for mode in ["late-unused-scope", "late-unused-shortcut"] {
        let fixture = Fixture::new();
        let output = fixture.invoke(mode, "Write");
        assert_eq!(output.status.code(), Some(2), "{mode}");
        assert_eq!(fixture.context_results().len(), 3, "{mode}");
        let state = fixture.state().unwrap();
        let action = if mode == "late-unused-scope" {
            assert!(state.get("scope_guard").is_none());
            assert_eq!(state["shortcut_language"], 1);
            "increment_scope_guard"
        } else {
            assert_eq!(state["scope_guard"], 1);
            assert!(state.get("shortcut_language").is_none());
            "increment_shortcut_language"
        };
        let controls = fixture.controls();
        let final_context = controls
            .iter()
            .position(|row| {
                row["schema"] == "caws.runtime.file-tool-context.request.v2" && row["ordinal"] == 3
            })
            .unwrap();
        let unused_operation = controls
            .iter()
            .position(|row| {
                row["schema"] == "caws.runtime.guard-strikes.request.v2"
                    && row["operation"] == action
            })
            .unwrap();
        assert!(unused_operation > final_context, "{mode}");
        assert!(
            !String::from_utf8_lossy(&output.stdout).contains("native-owner-ok"),
            "{mode}"
        );
    }
}

#[test]
fn replay_late_controls_and_post_shortcut_image_drift_cannot_upgrade_to_allow() {
    for mode in [
        "scope-replay",
        "shortcut-replay",
        "late-strike",
        "buffered-late-strike",
        "git-image-drift",
    ] {
        let fixture = Fixture::new();
        let output = fixture.invoke(mode, "Write");
        assert_eq!(output.status.code(), Some(2), "{mode}");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(!stdout.contains("native-owner-ok"), "{mode}");
        assert!(!stdout.contains("must-not-deliver"), "{mode}");
        let state = fixture
            .state()
            .expect("completed effects remain original-owned");
        assert_eq!(state["scope_guard"], 1, "{mode}");
        let strikes = fixture.strike_controls();
        if mode == "scope-replay" {
            assert!(state.get("shortcut_language").is_none());
            assert_eq!(strikes.len(), 2);
            assert!(
                strikes
                    .iter()
                    .all(|row| row["operation"] == "increment_scope_guard")
            );
            assert_eq!(fixture.context_results().len(), 1);
        } else {
            assert_eq!(state["shortcut_language"], 1, "{mode}");
            if mode == "git-image-drift" {
                assert_eq!(strikes.len(), 2);
                assert_eq!(fixture.context_results().len(), 2);
                assert!(fixture.controls().iter().any(|row| {
                    row["schema"] == "caws.runtime.file-tool-context.request.v2"
                        && row["ordinal"] == 3
                }));
                assert_eq!(
                    fs::read_link(fixture.root.join("configured-git")).unwrap(),
                    PathBuf::from("/usr/bin/git")
                );
            } else {
                assert_eq!(strikes.len(), 3, "{mode}");
                assert_eq!(strikes[2]["operation"], "increment_shortcut_language");
                if mode != "shortcut-replay" {
                    assert_eq!(fixture.context_results().len(), 3, "{mode}");
                }
            }
        }
    }
}
