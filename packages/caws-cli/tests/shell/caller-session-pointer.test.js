'use strict';

// CAWS-WORKTREE-OWNERSHIP-HARNESS-ID-001 — hook-side caller-session pointer (A1).
//
// Proves the hook template's _write_durable_session_envelope ALSO writes a
// per-repo caller-session pointer at
// <repo_root>/.caws/sessions/.caller-session.json (CAWS-SESSION-LOG-
// RELOCATE-001 moved it out of repo-root tmp/) from the authoritative
// hook-payload session id, and skips the write when the session id is
// missing/unknown (consistent with the resolver refusing the literal
// 'unknown').
//
// The function is exercised by sourcing the template script in a bash
// subshell against a real temp git repo with a .caws/ dir (the writer
// resolves repo_root via git-common-dir and only writes where .caws/
// exists), then asserting the on-disk pointer.
// This is the same shell-out style as tests/integration/cursor-hooks.test.js.
//
// The resolver-side consumption of this pointer (A2-A5) is proven in
// tests/shell/session/resolve-session.test.js. Together they close the
// agent-Bash lockout: hook writes the pointer (A1), resolver reads it to
// disambiguate >=2 fresh envelopes (A2).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(
  __dirname,
  '..',
  '..',
  'templates',
  'hook-packs',
  'claude-code',
  'lib',
  'parse-input.sh'
);

function mkRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-pointer-test-'));
  // Real git repo so git-common-dir resolution works.
  execFileSync('git', ['init', '-q'], { cwd: root });
  // CAWS-SESSION-LOG-RELOCATE-001: the writer only writes per-session state
  // where a .caws/ directory exists (a real CAWS project).
  fs.mkdirSync(path.join(root, '.caws'), { recursive: true });
  return root;
}

function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch { /* best-effort cleanup */ }
}

// Source the template, set the hook env, call the envelope/pointer writer,
// and return after the function completes. Output is swallowed (the
// function is all-failures-silent by contract); we assert on-disk state.
function runEnvelopeWrite(root, env) {
  const exportLines = Object.entries(env)
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join('\n');
  const script = `
set +e
${exportLines}
source ${JSON.stringify(SCRIPT)}
_write_durable_session_envelope
exit 0
`;
  execFileSync('bash', ['-c', script], { cwd: root, stdio: 'pipe' });
}

function readPointer(root) {
  // CAWS-SESSION-LOG-RELOCATE-001: pointer now lives under .caws/sessions/.
  const p = path.join(root, '.caws', 'sessions', '.caller-session.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

describe('CAWS-WORKTREE-OWNERSHIP-HARNESS-ID-001: hook writes caller-session pointer', () => {
  let root;
  afterEach(() => root && cleanup(root));

  // A1: hook writes the pointer from the hook-payload session id.
  test('A1: writes .caws/sessions/.caller-session.json naming the hook session id', () => {
    root = mkRepo();
    runEnvelopeWrite(root, {
      HOOK_SESSION_ID: 'sess-A1',
      HOOK_CWD: root,
      HOOK_EVENT_NAME: 'PreToolUse',
    });
    const pointer = readPointer(root);
    expect(pointer).not.toBeNull();
    expect(pointer.session_id).toBe('sess-A1');
    // repo_root realpath-equals the temp repo (tolerate /var vs /private/var).
    expect(fs.realpathSync(pointer.repo_root)).toBe(fs.realpathSync(root));
    expect(typeof pointer.last_seen_at).toBe('string');
    expect(pointer.last_seen_at.length).toBeGreaterThan(0);
  });

  // A1-refresh: a second fire from the same session updates last_seen_at
  // and keeps the same session_id (pointer names the active caller).
  test('A1-refresh: second fire keeps session_id, the pointer is overwritten', () => {
    root = mkRepo();
    runEnvelopeWrite(root, {
      HOOK_SESSION_ID: 'sess-refresh',
      HOOK_CWD: root,
      HOOK_EVENT_NAME: 'SessionStart',
    });
    runEnvelopeWrite(root, {
      HOOK_SESSION_ID: 'sess-refresh',
      HOOK_CWD: root,
      HOOK_EVENT_NAME: 'PreToolUse',
    });
    const pointer = readPointer(root);
    expect(pointer.session_id).toBe('sess-refresh');
  });

  // A1-skip-unknown: literal 'unknown' session id writes no pointer (the
  // resolver refuses 'unknown', so a pointer naming it would be useless).
  test("A1-skip: HOOK_SESSION_ID='unknown' writes no pointer", () => {
    root = mkRepo();
    runEnvelopeWrite(root, {
      HOOK_SESSION_ID: 'unknown',
      HOOK_CWD: root,
      HOOK_EVENT_NAME: 'PreToolUse',
    });
    expect(readPointer(root)).toBeNull();
  });

  // A1-skip-empty: empty session id writes no pointer.
  test('A1-skip: empty HOOK_SESSION_ID writes no pointer', () => {
    root = mkRepo();
    runEnvelopeWrite(root, {
      HOOK_SESSION_ID: '',
      HOOK_CWD: root,
      HOOK_EVENT_NAME: 'PreToolUse',
    });
    expect(readPointer(root)).toBeNull();
  });

  // Sibling-overwrite semantics: a different session firing overwrites the
  // pointer to name itself. This is intended — the pointer names the most
  // recent hook-firing session; the resolver degrades safely (refuses) when
  // the pointer does not name one of THIS call's fresh candidates.
  test('sibling overwrite: last writer wins the pointer (resolver degrades safely)', () => {
    root = mkRepo();
    runEnvelopeWrite(root, { HOOK_SESSION_ID: 'sess-mine', HOOK_CWD: root });
    runEnvelopeWrite(root, { HOOK_SESSION_ID: 'sess-sibling', HOOK_CWD: root });
    const pointer = readPointer(root);
    expect(pointer.session_id).toBe('sess-sibling');
  });
});
