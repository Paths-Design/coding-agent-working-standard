'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { installMachineRuntime } = require('../../dist/init/machine-adapters');
const {
  runReprieveGrantCommand: grant,
  runReprieveShowCommand: show,
  runReprieveRevokeCommand: revoke,
  runReprieveListCommand: list,
} = require('../../dist/shell/commands/reprieve');

let root, home, a, b;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-reprieve-roundtrip-'));
  home = path.join(root, 'machine');
  installMachineRuntime({ home });
  [a, b] = ['a', 'b'].map((name) => {
    const repo = path.join(root, name);
    fs.mkdirSync(path.join(repo, '.caws/hooks'), { recursive: true });
    expect(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo }).status).toBe(0);
    fs.writeFileSync(
      path.join(repo, '.caws/hooks/guard.sh'),
      '#!/bin/bash\necho \'{"decision":"block","reason":"fixture guard"}\'\nexit 2\n',
      { mode: 0o755 }
    );
    fs.writeFileSync(
      path.join(repo, '.caws/hooks/adapter-policy.json'),
      JSON.stringify({
        version: 1,
        surfaces: {
          codex: {
            libraries: {},
            events: { pre_tool_use: { hooks_dir: '.caws/hooks', handlers: ['guard.sh'] } },
          },
        },
      })
    );
    return repo;
  });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const recordPath = (sid) => path.join(home, 'state/sessions', sid, `guard-reprieve-${sid}.json`);
const options = (repo = a) => ({
  cwd: repo,
  env: { CAWS_HOME: home },
  session: 'fixture-session',
  surface: 'codex',
  out: () => {},
  err: () => {},
});
function dispatch(repo, sid = 'fixture-session') {
  return spawnSync('python3', [path.join(home, 'bin/caws-hook'), 'codex', 'pre_tool_use'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, CAWS_HOME: home, CAWS_PROJECT_DIR: repo },
    input: JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: 'sample.ts' },
      session_id: sid,
    }),
  });
}
function grantFixture(extra = {}) {
  return grant({
    ...options(),
    handlers: 'guard.sh',
    reason: 'isolated roundtrip test',
    approvedBy: 'test-human',
    for: '5m',
    ...extra,
  });
}

test('CLI grant is consumed by actual dispatch in two repos; exact session and handler stay enforced', () => {
  expect(grantFixture()).toBe(0);
  expect(fs.existsSync(recordPath('fixture-session'))).toBe(true);
  for (const repo of [a, b]) {
    const allowed = dispatch(repo);
    expect(allowed.status).toBe(0);
    expect(allowed.stderr).toContain('[reprieve] guard.sh skipped for session fixture-session');
    const foreign = dispatch(repo, 'foreign-session');
    expect(foreign.status).toBe(2);
    expect(JSON.parse(foreign.stdout).reason).toBe('fixture guard');
  }
  expect(grantFixture({ handlers: 'another-guard.sh' })).toBe(0);
  expect(dispatch(a).status).toBe(2);
});

test('revocation shadows a legacy grant and is inactive in show and list', () => {
  expect(grantFixture()).toBe(0);
  const legacy = path.join(b, '.codex/hooks/state/guard-reprieve-fixture-session.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.copyFileSync(recordPath('fixture-session'), legacy);
  expect(revoke({ ...options(b), reason: 'test complete' })).toBe(0);
  expect(dispatch(a).status).toBe(2);
  expect(dispatch(b).status).toBe(2);
  let observed;
  expect(
    show({
      ...options(b),
      json: true,
      out: (s) => {
        observed = JSON.parse(s);
      },
    })
  ).toBe(0);
  expect(observed.active).toBe(false);
  expect(
    list({
      ...options(a),
      json: true,
      out: (s) => {
        observed = JSON.parse(s);
      },
    })
  ).toBe(0);
  expect(observed.reprieves.find((r) => r.session_id === 'fixture-session').active).toBe(false);
});

test.each(['expired', 'malformed', 'wrong-session'])(
  '%s record never suppresses a guard',
  (kind) => {
    expect(grantFixture()).toBe(0);
    const p = recordPath('fixture-session');
    const record = JSON.parse(fs.readFileSync(p));
    if (kind === 'expired') record.expires_at = '2000-01-01T00:00:00Z';
    if (kind === 'wrong-session') record.session_id = 'someone-else';
    fs.writeFileSync(p, kind === 'malformed' ? '{broken' : JSON.stringify(record));
    expect(dispatch(a).status).toBe(2);
  }
);

test('read-only show, list and dry-run create no state; DSH cannot self-grant', () => {
  const empty = path.join(root, 'empty-home');
  const opts = { ...options(), env: { CAWS_HOME: empty } };
  expect(show(opts)).toBe(0);
  expect(list(opts)).toBe(0);
  expect(grantFixture({ ...opts, dryRun: true })).toBe(0);
  expect(fs.existsSync(empty)).toBe(false);
  expect(grantFixture({ env: { CAWS_HOME: empty, DSH_SESSION_ID: 'fixture-agent' } })).toBe(1);
  expect(fs.existsSync(empty)).toBe(false);
});

test('read commands use the selected surface and payload identity, never a foreign harness shadow', () => {
  expect(grantFixture()).toBe(0);
  let observed;
  const env = {
    CAWS_HOME: home,
    CAWS_AGENT_SURFACE: 'codex',
    CODEX_THREAD_ID: 'fixture-session',
    CLAUDE_SESSION_ID: 'foreign',
  };
  expect(
    show({
      ...options(),
      session: undefined,
      env,
      json: true,
      out: (s) => {
        observed = JSON.parse(s);
      },
    })
  ).toBe(0);
  expect(observed.session_id).toBe('fixture-session');
  expect(observed.active).toBe(true);
  expect(
    show({
      ...options(),
      session: undefined,
      env: { ...env, CODEX_THREAD_ID: 'foreign', HOOK_SESSION_ID: 'fixture-session' },
      json: true,
      out: (s) => {
        observed = JSON.parse(s);
      },
    })
  ).toBe(0);
  expect(observed.active).toBe(true);
});

function legacyRecord(vendor, sid = 'fixture-session') {
  const file = path.join(a, vendor, 'hooks/state', `guard-reprieve-${sid}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      session_id: sid,
      created_at: '2026-01-01T00:00:00Z',
      expires_at: '2099-01-01T00:00:00Z',
      approved_by: 'fixture-human',
      reason: 'isolated legacy migration fixture',
      handlers: ['guard.sh'],
    })
  );
  return file;
}

function humanCli(args) {
  return spawnSync(
    process.execPath,
    [path.resolve(__dirname, '../../dist/index.js'), 'reprieve', ...args],
    {
      cwd: a,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: path.join(root, 'user'), CAWS_HOME: home },
    }
  );
}

test('human show and list discover a legacy grant that the actual dispatcher honors without creating global state', () => {
  legacyRecord('.codex');
  const observed = humanCli(['show', '--session', 'fixture-session', '--json']);
  expect(observed.status).toBe(0);
  expect(JSON.parse(observed.stdout).active).toBe(true);
  const listed = humanCli(['list', '--json']);
  expect(listed.status).toBe(0);
  expect(JSON.parse(listed.stdout).reprieves.map((r) => [r.session_id, r.active])).toEqual([
    ['fixture-session', true],
  ]);
  const allowed = dispatch(a);
  expect(allowed.status).toBe(0);
  expect(allowed.stderr).toContain('[reprieve] guard.sh skipped for session fixture-session');
  expect(fs.existsSync(path.join(home, 'state/sessions'))).toBe(false);
});

test('ambiguous legacy session copies require a surface, while global presence remains decisive', () => {
  legacyRecord('.codex');
  legacyRecord('.claude');
  for (const args of [
    ['show', '--session', 'fixture-session', '--json'],
    ['list', '--json'],
  ]) {
    const ambiguous = humanCli(args);
    expect(ambiguous.status).toBe(1);
    expect(ambiguous.stderr).toMatch(/ambiguous legacy.*--surface/i);
  }
  const explicit = humanCli([
    'show',
    '--session',
    'fixture-session',
    '--surface',
    'codex',
    '--json',
  ]);
  expect(explicit.status).toBe(0);
  expect(JSON.parse(explicit.stdout).active).toBe(true);
  expect(grantFixture()).toBe(0);
  const global = humanCli(['show', '--session', 'fixture-session', '--json']);
  expect(global.status).toBe(0);
  expect(JSON.parse(global.stdout).active).toBe(true);
  const listed = humanCli(['list', '--json']);
  expect(listed.status).toBe(0);
  expect(JSON.parse(listed.stdout).reprieves.map((r) => r.session_id)).toEqual(['fixture-session']);
  const revoked = humanCli([
    'revoke',
    '--session',
    'fixture-session',
    '--reason',
    'fixture complete',
    '--json',
  ]);
  expect(revoked.status).toBe(0);
  expect(JSON.parse(revoked.stdout).revoked).toBe(true);
  expect(dispatch(a).status).toBe(2);
});

test('list includes distinct unambiguous legacy sessions across surfaces', () => {
  legacyRecord('.codex', 'codex-fixture');
  legacyRecord('.claude', 'claude-fixture');
  fs.mkdirSync(path.join(home, 'state/sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state/sessions/.DS_Store'), 'unrelated directory metadata');
  const listed = humanCli(['list', '--json']);
  expect(listed.status).toBe(0);
  expect(JSON.parse(listed.stdout).reprieves.map((r) => [r.session_id, r.active])).toEqual([
    ['claude-fixture', true],
    ['codex-fixture', true],
  ]);
});

test('revocation suppresses conflicting legacy copies without guessing which one was active', () => {
  const codex = legacyRecord('.codex');
  const claude = legacyRecord('.claude');
  const before = [codex, claude].map((file) => fs.readFileSync(file));
  const revoked = humanCli([
    'revoke',
    '--session',
    'fixture-session',
    '--reason',
    'suppress both fixture copies',
    '--json',
  ]);
  expect(revoked.status).toBe(0);
  expect(JSON.parse(revoked.stdout).revoked).toBe(true);
  expect(revoked.stderr).toMatch(/ambiguous legacy/i);
  expect([codex, claude].map((file) => fs.readFileSync(file))).toEqual(before);
  expect(dispatch(a).status).toBe(2);
  const listed = humanCli(['list', '--json']);
  expect(listed.status).toBe(0);
  expect(JSON.parse(listed.stdout).reprieves.map((r) => r.active)).toEqual([false]);
});

test('revoke --json on an absent grant emits one JSON object and prevents later legacy fallback', () => {
  const revoked = humanCli([
    'revoke',
    '--session',
    'fixture-session',
    '--reason',
    'fixture revocation',
    '--json',
  ]);
  expect(revoked.status).toBe(0);
  const record = JSON.parse(revoked.stdout);
  expect(record).toEqual({
    ok: true,
    revoked: true,
    session_id: 'fixture-session',
    file: recordPath('fixture-session'),
  });
  legacyRecord('.codex');
  const observed = humanCli(['show', '--session', 'fixture-session', '--json']);
  expect(observed.status).toBe(0);
  expect(JSON.parse(observed.stdout).active).toBe(false);
  expect(dispatch(a).status).toBe(2);
});
