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

test('CLI grant is consumed by actual dispatch in the granting repo; exact session, handler and repo stay enforced', () => {
  // Granted from repo `a` (options() defaults to it).
  expect(grantFixture()).toBe(0);
  expect(fs.existsSync(recordPath('fixture-session'))).toBe(true);

  const allowed = dispatch(a);
  expect(allowed.status).toBe(0);
  expect(allowed.stderr).toContain('[reprieve] guard.sh skipped for session fixture-session');

  // CAWS-REPRIEVE-BOUNDARY-AND-REPO-SCOPE-01: repo `b` is a different
  // repository, so the same record does not lift its guard. The three
  // dimensions are independent and each is checked against the same record.
  const elsewhere = dispatch(b);
  expect(elsewhere.status).toBe(2);
  expect(JSON.parse(elsewhere.stdout).reason).toBe('fixture guard');

  for (const repo of [a, b]) {
    const foreign = dispatch(repo, 'foreign-session');
    expect(foreign.status).toBe(2);
    expect(JSON.parse(foreign.stdout).reason).toBe('fixture guard');
  }
  expect(grantFixture({ handlers: 'another-guard.sh' })).toBe(0);
  expect(dispatch(a).status).toBe(2);
});

test('an --all-repos grant is consumed by dispatch in BOTH repos', () => {
  // The reach narrowing must be the flag's doing, not a dispatch regression:
  // the same fixture with --all-repos restores the cross-repo skip.
  expect(grantFixture({ allRepos: true })).toBe(0);
  expect('repo_root' in JSON.parse(fs.readFileSync(recordPath('fixture-session'), 'utf8'))).toBe(
    false
  );
  for (const repo of [a, b]) {
    const allowed = dispatch(repo);
    expect(allowed.status).toBe(0);
    expect(allowed.stderr).toContain('[reprieve] guard.sh skipped for session fixture-session');
  }
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

const DETACHED_READER_SHELL = [
  'set -u',
  'cd "$1" || exit 91',
  'source ./lib/reprieve.sh || exit 92',
  'cd "$2" || exit 93',
  'if command -v python3 >/dev/null 2>&1; then exit 94; fi',
  'CAWS_REPRIEVE_SESSION_ID=stale-session',
  'CAWS_REPRIEVE_EXPIRES_AT=stale-expiry',
  'CAWS_REPRIEVE_REASON=stale-reason',
  'reader_session="$4"',
  'if [[ "${5:-}" == invalid-utf8-session ]]; then reader_session="$(printf \'\\377\\220\\377\')"; fi',
  'if caws_is_handler_reprieved "$3" "$reader_session"; then result=0; else result=$?; fi',
  'printf \'%s\\000\' "$result" "$CAWS_REPRIEVE_SESSION_ID" "$CAWS_REPRIEVE_EXPIRES_AT" "$CAWS_REPRIEVE_REASON" "${NODE_OPTIONS-unset}" "${NODE_PATH-unset}" "$REPRIEVE_CALLER_TOKEN"',
].join('\n');

function executable(name) {
  const found = spawnSync('/bin/sh', ['-c', 'command -v "$1"', '-', name], {
    encoding: 'utf8',
  });
  expect(found.status).toBe(0);
  return fs.realpathSync(found.stdout.trim());
}

function detachedReaderFixture() {
  const pointer = JSON.parse(fs.readFileSync(path.join(home, 'state/adapter-runtime.json')));
  const runtime = path.join(home, 'lib/runtimes', pointer.digest);
  const reader = path.join(runtime, 'lib/reprieve-reader.cjs');
  expect(fs.lstatSync(reader).isFile()).toBe(true);
  const tools = path.join(root, 'detached-tools');
  const unrelated = path.join(root, 'unrelated-working-directory');
  fs.mkdirSync(tools);
  fs.mkdirSync(unrelated);
  for (const name of ['git', 'dirname', 'tr', 'cut'])
    fs.symlinkSync(executable(name), path.join(tools, name));
  const node = path.join(tools, 'node');
  const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
  fs.writeFileSync(
    node,
    '#!/bin/bash\n' +
      'printf \'%s\\000\' "${NODE_OPTIONS-unset}" "${NODE_PATH-unset}" "$REPRIEVE_CALLER_TOKEN" > "$REPRIEVE_NODE_ENV_CAPTURE"\n' +
      'exec ' +
      quote(process.execPath) +
      ' "$@"\n',
    { mode: 0o755 }
  );
  const preload = path.join(root, 'hostile-preload.cjs');
  const preloadMarker = path.join(root, 'preload-executed');
  fs.writeFileSync(
    preload,
    "require('node:fs').writeFileSync(process.env.REPRIEVE_PRELOAD_MARKER, 'executed');\n"
  );
  const capture = path.join(root, 'reader-child-environment.bin');
  const nodeOptions = '--require=' + JSON.stringify(preload);
  const nodePath = path.join(root, 'caller-module-search');
  const token = 'unrelated caller environment survives';
  const environment = {
    HOME: path.join(root, 'detached-user'),
    PATH: tools,
    CAWS_HOME: home,
    CAWS_PROJECT_DIR: a,
    CAWS_VENDOR_DIR: '.codex',
    NODE_OPTIONS: nodeOptions,
    NODE_PATH: nodePath,
    REPRIEVE_CALLER_TOKEN: token,
    REPRIEVE_NODE_ENV_CAPTURE: capture,
    REPRIEVE_PRELOAD_MARKER: preloadMarker,
  };
  return {
    runtime,
    reader,
    node,
    unrelated,
    capture,
    preloadMarker,
    nodeOptions,
    nodePath,
    token,
    environment,
  };
}

function writeDetachedRecord(overrides = {}) {
  const record = {
    session_id: 'fixture-session',
    created_at: '2026-01-01T00:00:00Z',
    expires_at: '2099-01-01T00:00:00.123456+00:00',
    approved_by: 'fixture-human',
    reason: 'detached\treader reason',
    handlers: ['guard.sh'],
    repo_root: a,
    ...overrides,
  };
  const file = recordPath('fixture-session');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record));
  return record;
}

function detachedRead(
  fixture,
  label,
  { invalidSessionBytes = false, recordFile = recordPath('fixture-session') } = {}
) {
  const argv = [
    '-c',
    DETACHED_READER_SHELL,
    'detached-reprieve',
    fixture.runtime,
    fixture.unrelated,
    'guard.sh',
    'fixture-session',
    invalidSessionBytes ? 'invalid-utf8-session' : 'valid-utf8-session',
  ];
  const result = spawnSync('/bin/bash', argv, {
    cwd: root,
    env: fixture.environment,
    encoding: 'utf8',
    timeout: 5000,
  });
  // Optional raw evidence lives outside the disposable fixture and source tree.
  const retained = process.env.CAWS_REPRIEVE_TEST_ARTIFACTS;
  if (retained) {
    fs.mkdirSync(path.resolve(retained), { recursive: true });
    const output = fs.mkdtempSync(path.join(path.resolve(retained), 'detached-reprieve-'));
    fs.writeFileSync(path.join(output, 'stdout.bin'), result.stdout ?? '');
    fs.writeFileSync(path.join(output, 'stderr.bin'), result.stderr ?? '');
    fs.writeFileSync(
      path.join(output, 'observation.json'),
      JSON.stringify(
        {
          label,
          executable: '/bin/bash',
          argv,
          cwd: root,
          status: result.status,
          signal: result.signal,
          error: result.error?.message ?? null,
          readerPresent: fs.existsSync(fixture.reader),
          nodePresent: fs.existsSync(fixture.node),
          preloadExecuted: fs.existsSync(fixture.preloadMarker),
          recordBytes: fs.readFileSync(recordFile).toString('base64'),
          childEnvironmentBytes: fs.existsSync(fixture.capture)
            ? fs.readFileSync(fixture.capture).toString('base64')
            : null,
        },
        null,
        2
      ) + '\n'
    );
  }
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(fs.existsSync(fixture.preloadMarker)).toBe(false);
  const fields = result.stdout.split('\0');
  expect(fields).toHaveLength(8);
  expect(fields.slice(4)).toEqual([fixture.nodeOptions, fixture.nodePath, fixture.token, '']);
  return fields.slice(0, 4);
}

test('installed sibling reader survives relative sourcing then chdir with Python unavailable and Node preload controls isolated', () => {
  const fixture = detachedReaderFixture();
  const record = writeDetachedRecord();
  const file = recordPath('fixture-session');
  const before = fs.readFileSync(file);
  expect(detachedRead(fixture, 'valid-grant')).toEqual([
    '0',
    record.session_id,
    record.expires_at,
    record.reason,
  ]);
  expect(fs.readFileSync(fixture.capture).toString().split('\0')).toEqual([
    '',
    '',
    fixture.token,
    '',
  ]);
  expect(fs.readFileSync(file)).toEqual(before);
});

test.each(['wrong-session', 'wrong-handler', 'wrong-repo', 'revoked', 'expired', 'malformed'])(
  'detached installed reader declines %s without reviving a valid legacy record or retaining stale globals',
  (kind) => {
    const fixture = detachedReaderFixture();
    legacyRecord('.codex');
    const overrides = {
      'wrong-session': { session_id: 'foreign-session' },
      'wrong-handler': { handlers: ['another-guard.sh'] },
      'wrong-repo': { repo_root: b },
      revoked: { revoked_at: null },
      expired: { expires_at: '2000-01-01T00:00:00Z' },
    };
    writeDetachedRecord(overrides[kind]);
    const file = recordPath('fixture-session');
    if (kind === 'malformed') fs.writeFileSync(file, '{broken');
    const before = fs.readFileSync(file);
    expect(detachedRead(fixture, kind)).toEqual(['1', '', '', '']);
    expect(fs.readFileSync(fixture.capture).toString().split('\0')).toEqual([
      '',
      '',
      fixture.token,
      '',
    ]);
    expect(fs.readFileSync(file)).toEqual(before);
  }
);

test.each(['reader', 'node'])(
  'detached installed reader declines a skip when the %s is missing',
  (missing) => {
    const fixture = detachedReaderFixture();
    writeDetachedRecord();
    fs.unlinkSync(fixture[missing]);
    expect(detachedRead(fixture, 'missing-' + missing)).toEqual(['1', '', '', '']);
    expect(fs.existsSync(fixture.capture)).toBe(false);
  }
);

test('malformed session bytes cannot alias the replacement-character session of a different grant', () => {
  const fixture = detachedReaderFixture();
  const record = writeDetachedRecord({ session_id: '\ufffd\ufffd\ufffd' });
  const aliasFile = path.join(home, 'state/sessions/___/guard-reprieve-___.json');
  fs.mkdirSync(path.dirname(aliasFile), { recursive: true });
  fs.writeFileSync(aliasFile, JSON.stringify(record));
  const before = fs.readFileSync(aliasFile);
  expect(
    detachedRead(fixture, 'invalid-session-byte-alias', {
      invalidSessionBytes: true,
      recordFile: aliasFile,
    })
  ).toEqual(['1', '', '', '']);
  // The record exists and the child ran: refusal cannot pass vacuously by
  // selecting no file or failing to resolve the reader executable.
  expect(fs.existsSync(fixture.capture)).toBe(true);
  expect(fs.readFileSync(aliasFile)).toEqual(before);
});
