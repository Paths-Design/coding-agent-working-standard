'use strict';

/**
 * CAWS-DEFECT-SESSION-RESOLVER-CLI-GUARD-PARITY-01 — the CLI and the hook
 * guards must resolve the same session inside one harness session.
 *
 * The incident: a shell exported CAWS_SESSION_ID='@darianrosebrook'. Inside a
 * Claude Code session, `caws worktree create` stamped that string as the
 * worktree owner, while the PreToolUse worktree-write-guard resolved the
 * session from the hook payload and refused the same session's own Write as
 * "owned by a DIFFERENT session".
 *
 * Coverage:
 *   A1  the real CLI stamps the harness id, prints one notice naming the
 *       ignored CAWS_SESSION_ID, and the real write guard admits that owner.
 *   A2  the TS resolver and lib/session-id.sh, fed the same env and a hook
 *       payload, return the same id.
 *   A3  with no harness var, CAWS_SESSION_ID resolves exactly as before.
 *   A4  Codex (CODEX_THREAD_ID) follows the same rule.
 *   A5  `caws reprieve show|revoke` resolve the session the same way.
 *   Invariant 3: surfaces whose identity rides CAWS_SESSION_ID or
 *   DSH_SESSION_ID keep their prior resolution.
 *
 * Every session variable is set explicitly per test: the jest setup file
 * (tests/helpers/isolate-session-env.js) deletes the ambient ones, and spawned
 * children get a constructed env, never the invoking agent's.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { resolveCallerSession } = require('../../dist/shell/session/resolve-session');
const {
  runReprieveGrantCommand,
  runReprieveShowCommand,
  runReprieveRevokeCommand,
} = require('../../dist/shell/commands/reprieve');

const CLI = path.resolve(__dirname, '../../dist/index.js');
const SHARED_DIR = path.resolve(__dirname, '../../templates/hook-packs/shared');
const SESSION_ID_SH = path.join(SHARED_DIR, 'lib/session-id.sh');
const PARSE_INPUT_SH = path.join(SHARED_DIR, 'lib/parse-input.sh');
const WRITE_GUARD = path.join(SHARED_DIR, 'worktree-write-guard.sh');

// The incident's stray value, and a synthetic Claude Code session id.
const STRAY = '@darianrosebrook';
const CLAUDE_ID = '0b5e7c1a-1111-4222-8333-444455556666';

// Session vars a child process must not inherit from the test runner.
const SESSION_VARS = [
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_THREAD_ID',
  'QWEN_CODE_SESSION_ID',
  'DSH_SESSION_ID',
  'CAWS_SESSION_ID',
  'HOOK_SESSION_ID',
  'CURSOR_TRACE_ID',
  'CAWS_AGENT_SURFACE',
  'CAWS_PLATFORM_FLAG',
  'CAWS_AGENT_PROCESS_NAMES',
  'CAWS_PROJECT_DIR',
];

function baseChildEnv(root) {
  const env = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin`,
    HOME: process.env.HOME,
    CAWS_HOME: path.join(root, 'machine'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'commit.gpgsign',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'user.name',
    GIT_CONFIG_VALUE_2: 'Fixture',
    GIT_CONFIG_KEY_3: 'user.email',
    GIT_CONFIG_VALUE_3: 'fixture@example.invalid',
  };
  for (const v of SESSION_VARS) expect(env[v]).toBeUndefined();
  return env;
}

function noticeFor(canonical, surface, envVar, id) {
  return `caws: CAWS_SESSION_ID=${canonical} was not used. This process runs inside a ${surface} session (${envVar}=${id}), and the hook guards resolve that session from the tool payload, so the session identity here is ${id}. Unset CAWS_SESSION_ID in this shell to silence this notice.`;
}

function noticeLines(stderr) {
  return stderr.split('\n').filter((line) => line.includes('was not used'));
}

/** Capture what the resolver writes to process.stderr during fn(). */
function captureStderr(fn) {
  const writes = [];
  const spy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  try {
    return { value: fn(), notices: noticeLines(writes.join('')) };
  } finally {
    spy.mockRestore();
  }
}

function tempProject(prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const cawsDir = path.join(root, '.caws');
  fs.mkdirSync(path.join(cawsDir, 'sessions'), { recursive: true });
  return { root, cawsDir };
}

function tsResolve(cawsDir, root, env) {
  const r = resolveCallerSession({ cawsDir, worktreeRoot: root, env, allowMint: false });
  expect(r.ok).toBe(true);
  return r.value;
}

/**
 * What the guards see: parse a PreToolUse payload with the shipped parser,
 * then resolve the operating session exactly as worktree-write-guard.sh does
 * (resolve_caws_session_id_with_payload "$HOOK_SESSION_ID"). A non-matching
 * CAWS_AGENT_PROCESS_NAMES keeps the agent-PID tier from finding the test
 * runner's own ancestors.
 */
function guardResolve(root, env, payloadSessionId) {
  const script =
    'source "$1" && source "$2" && parse_hook_input && resolve_caws_session_id_with_payload "${HOOK_SESSION_ID:-}"';
  const r = spawnSync(
    'bash',
    ['--noprofile', '--norc', '-c', script, 'bash', PARSE_INPUT_SH, SESSION_ID_SH],
    {
      cwd: root,
      env: {
        ...baseChildEnv(root),
        CAWS_PROJECT_DIR: root,
        CAWS_AGENT_PROCESS_NAMES: 'caws-parity-fixture-no-such-agent',
        ...env,
      },
      input: JSON.stringify({
        session_id: payloadSessionId,
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: path.join(root, 'fixture.txt'), content: 'x' },
        cwd: root,
      }),
      encoding: 'utf8',
    }
  );
  expect({ status: r.status, stderr: r.status === 0 ? '' : r.stderr }).toEqual({
    status: 0,
    stderr: '',
  });
  return r.stdout.trim();
}

// ─── A1: the incident, end to end through the built CLI and the real guard ──

describe('A1 — a stray CAWS_SESSION_ID inside a Claude Code session', () => {
  let root, env;

  function run(args, cwd, extra = {}) {
    return spawnSync(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...env, ...extra },
      encoding: 'utf8',
    });
  }
  function succeeded(result) {
    expect({ status: result.status, stderr: result.status ? result.stderr : '' }).toEqual({
      status: 0,
      stderr: '',
    });
  }
  function guard(payloadSessionId, filePath, extra) {
    return spawnSync('bash', [WRITE_GUARD], {
      cwd: root,
      env: {
        ...env,
        CAWS_PROJECT_DIR: root,
        CAWS_AGENT_SURFACE: 'claude-code',
        CAWS_AGENT_PROCESS_NAMES: 'caws-parity-fixture-no-such-agent',
        ...extra,
      },
      input: JSON.stringify({
        session_id: payloadSessionId,
        hook_event_name: 'PreToolUse',
        permission_mode: 'default',
        tool_name: 'Write',
        tool_input: { file_path: filePath, content: 'x\n' },
        cwd: root,
      }),
      encoding: 'utf8',
    });
  }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-parity-cli-')));
    env = baseChildEnv(root);
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['commit', '-q', '--allow-empty', '-m', 'fixture'],
    ])
      succeeded(spawnSync('git', args, { cwd: root, env, encoding: 'utf8' }));
    succeeded(run(['init', '--agent-surface', 'none'], root));
    succeeded(
      run(
        [
          'specs',
          'create',
          'PAR-001',
          '--title',
          'Parity fixture',
          '--mode',
          'chore',
          '--scope-in',
          'src',
        ],
        root,
        { CAWS_SESSION_ID: 'spec-author' }
      )
    );
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('worktree create stamps the Claude Code session, claim recognizes it, and the write guard admits that owner', () => {
    const incidentEnv = { CAWS_SESSION_ID: STRAY, CLAUDE_CODE_SESSION_ID: CLAUDE_ID };
    const expectedNotice =
      'caws: CAWS_SESSION_ID=@darianrosebrook was not used. This process runs inside a claude-code session (CLAUDE_CODE_SESSION_ID=0b5e7c1a-1111-4222-8333-444455556666), and the hook guards resolve that session from the tool payload, so the session identity here is 0b5e7c1a-1111-4222-8333-444455556666. Unset CAWS_SESSION_ID in this shell to silence this notice.';

    const created = run(['worktree', 'create', 'wt-par', '--spec', 'PAR-001'], root, incidentEnv);
    succeeded(created);
    const owner = JSON.parse(fs.readFileSync(path.join(root, '.caws/worktrees.json'), 'utf8'))[
      'wt-par'
    ].owner;
    // The stamped owner is the harness session, never the stray string.
    expect(owner.session_id).toBe(CLAUDE_ID);
    expect(owner.platform).toBe('claude-code');
    // One notice, naming the ignored value, even though the command resolves
    // the caller more than once.
    expect(noticeLines(created.stderr)).toEqual([expectedNotice]);
    // The stray value is not offered back as a continuation to export.
    expect(created.stdout).not.toContain('export CAWS_SESSION_ID=');

    const wtPath = path.join(root, '.caws/worktrees/wt-par');
    const claim = run(['claim'], wtPath, incidentEnv);
    succeeded(claim);
    expect(claim.stdout).toContain(`OWNED (you) — ${CLAUDE_ID}`);
    expect(noticeLines(claim.stderr)).toEqual([expectedNotice]);

    // The guard resolves the caller from the payload; the hook process also
    // inherits the shell's stray export, exactly as in the incident.
    const target = path.join(wtPath, 'src', 'parity.ts');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const own = guard(CLAUDE_ID, target, incidentEnv);
    expect(own.stderr).not.toContain('DIFFERENT session');
    expect(own.status).toBe(0);

    // Negative control: the same fixture blocks a session that does not own
    // the worktree, so the admit above is an ownership decision.
    const foreign = guard('a-different-session', target, incidentEnv);
    expect(foreign.status).toBe(2);
    expect(foreign.stderr).toContain(
      "this is a write into worktree 'wt-par''s payload (.caws/worktrees/wt-par/...), which is owned by a DIFFERENT session."
    );
    // Four CLI spawns plus two full guard runs; ~35s alone, slower under a
    // parallel full-suite run.
  }, 240000);
});

// ─── A2: TS resolver and shell resolver agree on the same inputs ────────────

describe('A2 — the CLI resolver and lib/session-id.sh resolve the same caller', () => {
  let root, cawsDir;
  beforeEach(() => ({ root, cawsDir } = tempProject('caws-parity-a2-')));
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test.each([
    [
      'claude-code session with a stray CAWS_SESSION_ID',
      { CAWS_SESSION_ID: STRAY, CLAUDE_CODE_SESSION_ID: CLAUDE_ID },
      CLAUDE_ID,
      CLAUDE_ID,
    ],
    [
      'codex session with a stray CAWS_SESSION_ID',
      { CAWS_SESSION_ID: 'stray-for-codex', CODEX_THREAD_ID: 'codex-thread-a2' },
      'codex-thread-a2',
      'codex-thread-a2',
    ],
    [
      'CAWS_SESSION_ID agreeing with the harness',
      { CAWS_SESSION_ID: 'same-a2', CLAUDE_CODE_SESSION_ID: 'same-a2' },
      'same-a2',
      'same-a2',
    ],
  ])('%s', (_label, env, payloadId, expected) => {
    const cli = captureStderr(() => tsResolve(cawsDir, root, env)).value.identity.session_id;
    const shell = guardResolve(root, env, payloadId);
    expect({ cli, shell }).toEqual({ cli: expected, shell: expected });
  });
});

// ─── A3: no harness var — CAWS_SESSION_ID resolves unchanged ────────────────

describe('A3 — CAWS_SESSION_ID with no harness session variable', () => {
  let root, cawsDir;
  beforeEach(() => ({ root, cawsDir } = tempProject('caws-parity-a3-')));
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('resolves CAWS_SESSION_ID as the caws_env source with no notice', () => {
    const { value, notices } = captureStderr(() =>
      tsResolve(cawsDir, root, { CAWS_SESSION_ID: 'terminal-pin-a3' })
    );
    expect(value).toEqual({
      identity: { session_id: 'terminal-pin-a3', platform: 'none' },
      source: 'caws_env',
    });
    expect(notices).toEqual([]);
  });

  test('an operator CLAUDE_SESSION_ID is not a harness session and does not displace it', () => {
    const { value, notices } = captureStderr(() =>
      tsResolve(cawsDir, root, { CAWS_SESSION_ID: 'terminal-pin-a3b', CLAUDE_SESSION_ID: 'op-a3b' })
    );
    expect(value.identity.session_id).toBe('terminal-pin-a3b');
    expect(value.source).toBe('caws_env');
    expect(notices).toEqual([]);
  });
});

// ─── A4: Codex follows the same rule ────────────────────────────────────────

describe('A4 — a Codex session with a stray CAWS_SESSION_ID', () => {
  let root, cawsDir;
  beforeEach(() => ({ root, cawsDir } = tempProject('caws-parity-a4-')));
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('resolves CODEX_THREAD_ID and names the ignored value once', () => {
    const env = { CAWS_SESSION_ID: 'stray-a4', CODEX_THREAD_ID: 'codex-thread-a4' };
    const { value, notices } = captureStderr(() => {
      const first = tsResolve(cawsDir, root, env);
      // A second resolution in the same process must not repeat the notice.
      tsResolve(cawsDir, root, env);
      return first;
    });
    expect(value).toEqual({
      identity: { session_id: 'codex-thread-a4', platform: 'codex' },
      source: 'codex_thread_env',
    });
    expect(notices).toEqual([noticeFor('stray-a4', 'codex', 'CODEX_THREAD_ID', 'codex-thread-a4')]);
  });
});

// ─── Invariant 3 and the ambiguity boundaries ───────────────────────────────

describe('surfaces whose identity rides CAWS_SESSION_ID or DSH_SESSION_ID resolve as before', () => {
  let root, cawsDir;
  beforeEach(() => ({ root, cawsDir } = tempProject('caws-parity-inv-')));
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test.each([
    // A dsh process started from a Claude Code shell inherits CLAUDE_CODE_SESSION_ID.
    [
      'dsh session with an inherited Claude Code id',
      {
        CAWS_SESSION_ID: 'dsh-canon',
        DSH_SESSION_ID: 'dsh-id',
        CLAUDE_CODE_SESSION_ID: 'inherited-1',
      },
      'dsh-canon',
    ],
    [
      'dsh session carrying its id in DSH_SESSION_ID and CAWS_SESSION_ID',
      { CAWS_SESSION_ID: 'dsh-canon-2', DSH_SESSION_ID: 'dsh-id-2' },
      'dsh-canon-2',
    ],
    // Surfaces with no session var of their own declare themselves instead.
    [
      'opencode declared by CAWS_AGENT_SURFACE',
      {
        CAWS_SESSION_ID: 'oc-canon',
        CAWS_AGENT_SURFACE: 'opencode',
        CLAUDE_CODE_SESSION_ID: 'inherited-2',
      },
      'oc-canon',
    ],
    [
      'zcode declared by CAWS_PLATFORM_FLAG',
      { CAWS_SESSION_ID: 'zc-canon', CAWS_PLATFORM_FLAG: 'zcode', CODEX_THREAD_ID: 'inherited-3' },
      'zc-canon',
    ],
    [
      'qwen session with an inherited Claude Code id',
      {
        CAWS_SESSION_ID: 'qw-canon',
        QWEN_CODE_SESSION_ID: 'qw-id',
        CLAUDE_CODE_SESSION_ID: 'inherited-4',
      },
      'qw-canon',
    ],
    // Nested harnesses: the environment cannot say which one is the caller.
    [
      'two harness ids present',
      {
        CAWS_SESSION_ID: 'nest-canon',
        CLAUDE_CODE_SESSION_ID: 'nest-claude',
        CODEX_THREAD_ID: 'nest-codex',
      },
      'nest-canon',
    ],
    // Inside a hook process the dispatcher already normalized CAWS_SESSION_ID
    // from the guards' own resolution.
    [
      'hook process (HOOK_SESSION_ID set)',
      {
        CAWS_SESSION_ID: 'hook-canon',
        HOOK_SESSION_ID: 'hook-payload',
        CLAUDE_CODE_SESSION_ID: 'hook-harness',
      },
      'hook-canon',
    ],
    [
      'hook process whose payload had no session id',
      {
        CAWS_SESSION_ID: 'hook-canon-2',
        HOOK_SESSION_ID: 'unknown',
        CLAUDE_CODE_SESSION_ID: 'hook-harness-2',
      },
      'hook-canon-2',
    ],
  ])('%s keeps CAWS_SESSION_ID with no notice', (_label, env, expected) => {
    const { value, notices } = captureStderr(() => tsResolve(cawsDir, root, env));
    expect(value.identity.session_id).toBe(expected);
    expect(value.source).toBe('caws_env');
    expect(notices).toEqual([]);
  });

  test('a declared surface that matches the harness does not block the harness id', () => {
    const env = {
      CAWS_SESSION_ID: 'stray-decl',
      CAWS_AGENT_SURFACE: 'claude-code',
      CLAUDE_CODE_SESSION_ID: 'claude-decl',
    };
    const { value, notices } = captureStderr(() => tsResolve(cawsDir, root, env));
    expect(value.identity).toEqual({ session_id: 'claude-decl', platform: 'claude-code' });
    expect(notices).toEqual([
      noticeFor('stray-decl', 'claude-code', 'CLAUDE_CODE_SESSION_ID', 'claude-decl'),
    ]);
  });

  test('a "none" platform declaration names no harness, so it does not block the harness id', () => {
    const env = {
      CAWS_SESSION_ID: 'stray-none',
      CAWS_PLATFORM_FLAG: 'none',
      CODEX_THREAD_ID: 'codex-none',
    };
    const { value } = captureStderr(() => tsResolve(cawsDir, root, env));
    expect(value.identity).toEqual({ session_id: 'codex-none', platform: 'codex' });
  });

  test('a CAWS_SESSION_ID that agrees with the harness id resolves as before, with no notice', () => {
    const env = { CAWS_SESSION_ID: 'agree-id', CLAUDE_CODE_SESSION_ID: 'agree-id' };
    const { value, notices } = captureStderr(() => tsResolve(cawsDir, root, env));
    expect(value).toEqual({
      identity: { session_id: 'agree-id', platform: 'none' },
      source: 'caws_env',
    });
    expect(notices).toEqual([]);
  });

  test('CURSOR_TRACE_ID from an IDE terminal does not make a Claude Code session ambiguous', () => {
    const env = {
      CAWS_SESSION_ID: 'stray-cursor',
      CLAUDE_CODE_SESSION_ID: 'claude-in-cursor',
      CURSOR_TRACE_ID: 'cursor-trace',
    };
    const { value } = captureStderr(() => tsResolve(cawsDir, root, env));
    expect(value.identity.session_id).toBe('claude-in-cursor');
    expect(value.source).toBe('claude_code_env');
  });
});

// ─── A5: reprieve show/revoke resolve the session the same way ──────────────

describe('A5 — caws reprieve show/revoke inside a harness session', () => {
  let repoRoot, homeDir;

  function seedLease(sessionId) {
    fs.mkdirSync(path.join(repoRoot, '.caws', 'leases'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, '.caws', 'leases', `${sessionId}.json`),
      JSON.stringify({
        lease_version: 1,
        session_id: sessionId,
        platform: 'claude-code',
        status: 'active',
        started_at: '2026-10-04T01:00:00.000Z',
        last_active: '2026-10-04T01:59:00.000Z',
        repo_root: repoRoot,
      })
    );
  }

  function grantFor(sessionId) {
    const errors = [];
    const code = runReprieveGrantCommand({
      cwd: repoRoot,
      homeDir,
      env: {}, // a human terminal: no agent-session vars
      out: () => {},
      err: (line) => errors.push(line),
      handlers: 'protected-paths.sh',
      reason: 'parity fixture',
      approvedBy: 'fixture-human',
      expiresAt: '2099-01-01T00:00:00Z',
      session: sessionId,
      surface: 'claude-code',
    });
    expect({ code, errors }).toEqual({ code: 0, errors: [] });
  }

  function showJson(env) {
    const lines = [];
    const errors = [];
    const code = runReprieveShowCommand({
      cwd: repoRoot,
      homeDir,
      env,
      out: (line) => lines.push(line),
      err: (line) => errors.push(line),
      surface: 'claude-code',
      json: true,
    });
    expect({ code, errors }).toEqual({ code: 0, errors: [] });
    return JSON.parse(lines.join('\n'));
  }

  beforeEach(() => {
    repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-parity-a5-')));
    homeDir = path.join(repoRoot, 'machine-home');
    const env = baseChildEnv(repoRoot);
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['commit', '-q', '--allow-empty', '-m', 'root'],
    ]) {
      const r = spawnSync('git', args, { cwd: repoRoot, env, encoding: 'utf8' });
      expect(r.status).toBe(0);
    }
    fs.mkdirSync(path.join(homeDir, 'state', 'sessions'), { recursive: true });
  });
  afterEach(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  test('show looks up the harness session the guards consult, not the stray CAWS_SESSION_ID', () => {
    seedLease('claude-a5-show');
    grantFor('claude-a5-show');
    const env = { CAWS_SESSION_ID: 'stray-a5-show', CLAUDE_CODE_SESSION_ID: 'claude-a5-show' };
    const { value: shown, notices } = captureStderr(() => showJson(env));
    expect(shown.session_id).toBe('claude-a5-show');
    expect(shown.active).toBe(true);
    expect(shown.reprieve.handlers).toEqual(['protected-paths.sh']);
    expect(notices).toEqual([
      noticeFor('stray-a5-show', 'claude-code', 'CLAUDE_CODE_SESSION_ID', 'claude-a5-show'),
    ]);
  });

  test('revoke tombstones the grant held by the harness session, not the stray id', () => {
    seedLease('claude-a5-revoke');
    grantFor('claude-a5-revoke');
    const env = { CAWS_SESSION_ID: 'stray-a5-revoke', CLAUDE_CODE_SESSION_ID: 'claude-a5-revoke' };
    const lines = [];
    const errors = [];
    const { value: code } = captureStderr(() =>
      runReprieveRevokeCommand({
        cwd: repoRoot,
        homeDir,
        env,
        out: (line) => lines.push(line),
        err: (line) => errors.push(line),
        surface: 'claude-code',
        reason: 'parity fixture done',
        json: true,
      })
    );
    expect({ code, errors }).toEqual({ code: 0, errors: [] });
    expect(JSON.parse(lines.join('\n')).session_id).toBe('claude-a5-revoke');
    // Revoke always writes a tombstone for the session it resolved, so the
    // proof is WHICH record became the tombstone.
    const sessionsDir = path.join(homeDir, 'state', 'sessions');
    const record = JSON.parse(
      fs.readFileSync(
        path.join(sessionsDir, 'claude-a5-revoke', 'guard-reprieve-claude-a5-revoke.json'),
        'utf8'
      )
    );
    expect(record.handlers).toEqual([]);
    expect(typeof record.revoked_at).toBe('string');
    expect(fs.existsSync(path.join(sessionsDir, 'stray-a5-revoke'))).toBe(false);
    expect(captureStderr(() => showJson(env)).value.active).toBe(false);
  });

  test.each([
    [
      'claude-code with a stray value',
      { CAWS_SESSION_ID: 'stray-a5-t1', CLAUDE_CODE_SESSION_ID: 'claude-a5-t1' },
    ],
    [
      'codex with a stray value',
      { CAWS_SESSION_ID: 'stray-a5-t2', CODEX_THREAD_ID: 'codex-a5-t2' },
    ],
    ['no harness var', { CAWS_SESSION_ID: 'terminal-a5-t3' }],
    [
      'dsh with an inherited Claude Code id',
      {
        CAWS_SESSION_ID: 'dsh-a5-t4',
        DSH_SESSION_ID: 'dsh-id-t4',
        CLAUDE_CODE_SESSION_ID: 'inherited-t4',
      },
    ],
  ])('show resolves the same session as the CLI resolver: %s', (_label, env) => {
    const shown = captureStderr(() => showJson(env)).value.session_id;
    const cawsDir = path.join(repoRoot, '.caws');
    const cli = captureStderr(() => tsResolve(cawsDir, repoRoot, env)).value.identity.session_id;
    expect(shown).toBe(cli);
  });
});
