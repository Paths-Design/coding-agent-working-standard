'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const CLI = path.resolve(__dirname, '../../dist/index.js');
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
let root, env;

function run(args, cwd = root, extra = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...env, ...extra },
    encoding: 'utf8',
  });
}
function succeeded(result) {
  expect({ status: result.status, error: result.status ? result.stderr : '' }).toEqual({
    status: 0,
    error: '',
  });
}
function registry() {
  return fs.readFileSync(path.join(root, '.caws/worktrees.json'), 'utf8');
}
function capsules() {
  const dir = path.join(root, '.caws/sessions');
  return fs.existsSync(dir)
    ? Object.fromEntries(
        fs
          .readdirSync(dir)
          .filter((p) => p.endsWith('.json'))
          .map((p) => [p, fs.readFileSync(path.join(dir, p), 'utf8')])
      )
    : {};
}
function cachedOwner(owner) {
  const dir = path.join(root, '.caws/sessions', owner);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.session-envelope.json'),
    JSON.stringify({
      session_id: owner,
      repo_root: root,
      last_seen_at: new Date().toISOString(),
      platform: 'none',
    })
  );
}
function governanceBytes() {
  return Object.fromEntries(
    ['worktrees.json', 'events.jsonl', 'claims/bridge.json'].map((name) => {
      const file = path.join(root, '.caws', name);
      return [name, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null];
    })
  );
}
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "caws create ' ; ")));
  const bin = path.join(root, 'fixture-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'caws'),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(CLI)} "$@"\n`,
    { mode: 0o755 }
  );
  // Select the real built CLI through PATH, preserve HOME, and explicitly
  // isolate machine state and Git configuration. No ambient agent identity.
  env = {
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin`,
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
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['commit', '-q', '--allow-empty', '-m', 'fixture'],
  ])
    succeeded(spawnSync('git', args, { cwd: root, env, encoding: 'utf8' }));
  succeeded(run(['init', '--agent-surface', 'none']));
  succeeded(
    run(
      [
        'specs',
        'create',
        'ENTER-001',
        '--title',
        'Fixture continuity',
        '--mode',
        'chore',
        '--risk-tier',
        '3',
        '--scope-in',
        'src',
      ],
      root,
      { CAWS_SESSION_ID: 'spec-author' }
    )
  );
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test.each(['empty cache', 'existing capsule'])(
  'creation with %s prints an executable continuation with no second mint at entry',
  (source) => {
    if (source === 'existing capsule')
      succeeded(
        run([
          'specs',
          'create',
          'PRE-001',
          '--title',
          'Earlier session command',
          '--mode',
          'chore',
          '--risk-tier',
          '3',
          '--scope-in',
          'other',
        ])
      );
    const created = run(['worktree', 'create', 'wt-enter', '--spec', 'ENTER-001']);
    succeeded(created);
    expect(created.stdout).not.toContain('Next: cd ');
    const beforeRegistry = registry();
    const owner = JSON.parse(beforeRegistry)['wt-enter'].owner.session_id;
    const beforeCapsules = capsules();
    expect(Object.keys(beforeCapsules)).toHaveLength(1);
    const line = created.stdout.split('\n').find((s) => s.startsWith('Continue in this shell: '));
    expect(line).toBeDefined();
    const command = line.slice('Continue in this shell: '.length);
    const claim = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', command], {
      cwd: os.tmpdir(),
      env,
      encoding: 'utf8',
    });
    succeeded(claim);
    expect(claim.stdout).toContain(`OWNED (you) — ${owner}`);
    expect(registry()).toBe(beforeRegistry);
    expect(capsules()).toEqual(beforeCapsules);
  }
);

test('claim without the continuation refuses without creating a second identity', () => {
  succeeded(run(['worktree', 'create', 'wt-enter', '--spec', 'ENTER-001']));
  const beforeRegistry = registry(),
    beforeCapsules = capsules();
  const result = run(['claim'], path.join(root, '.caws/worktrees/wt-enter'));
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('session identity');
  expect(result.stderr).not.toContain('run a write-class command');
  expect(registry()).toBe(beforeRegistry);
  expect(capsules()).toEqual(beforeCapsules);
});

test.each([1, 2])(
  'claim cannot infer its caller from %i fresh envelopes and the cwd owner',
  (count) => {
    succeeded(run(['worktree', 'create', 'wt-enter', '--spec', 'ENTER-001']));
    const before = registry();
    const owner = JSON.parse(before)['wt-enter'].owner.session_id;
    for (const id of [owner, 'neighbor'].slice(0, count)) {
      const dir = path.join(root, '.caws/sessions', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.session-envelope.json'),
        JSON.stringify({
          session_id: id,
          repo_root: root,
          last_seen_at: new Date().toISOString(),
          platform: 'none',
        })
      );
    }
    const beforeCapsules = capsules();
    const result = run(['claim'], path.join(root, '.caws/worktrees/wt-enter'));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('session identity');
    expect(registry()).toBe(before);
    expect(capsules()).toEqual(beforeCapsules);
  }
);

test.each(['explicit-foreign', undefined])(
  'ensure refuses caller %s without borrowing a capsule or minting',
  (caller) => {
    succeeded(run(['worktree', 'create', 'wt-enter', '--spec', 'ENTER-001']));
    const before = registry(),
      beforeCapsules = capsules();
    const result = run(['worktree', 'ensure', 'wt-enter', '--spec', 'ENTER-001'], root, {
      CAWS_SESSION_ID: caller,
    });
    expect(result.status).toBe(caller ? 1 : 2);
    expect(registry()).toBe(before);
    expect(capsules()).toEqual(beforeCapsules);
  }
);

test('existing ensure carries the actual caller into its executable continuation', () => {
  const created = run(['worktree', 'create', 'wt-enter', '--spec', 'ENTER-001']);
  succeeded(created);
  const owner = JSON.parse(registry())['wt-enter'].owner.session_id;
  const ensured = run(['worktree', 'ensure', 'wt-enter', '--spec', 'ENTER-001'], root, {
    CAWS_SESSION_ID: owner,
  });
  succeeded(ensured);
  const before = registry(),
    beforeCapsules = capsules();
  const line = ensured.stdout.split('\n').find((s) => s.startsWith('Continue in this shell: '));
  expect(line).toBeDefined();
  const entered = spawnSync(
    '/bin/bash',
    ['--noprofile', '--norc', '-c', line.slice('Continue in this shell: '.length)],
    {
      cwd: os.tmpdir(),
      env,
      encoding: 'utf8',
    }
  );
  succeeded(entered);
  expect(entered.stdout).toContain(`OWNED (you) — ${owner}`);
  expect(registry()).toBe(before);
  expect(capsules()).toEqual(beforeCapsules);
});

test.each(['bind', 'destroy', 'untrack', 'merge'])(
  '%s refuses a foreign caller with the owner cached',
  (verb) => {
    succeeded(run(['worktree', 'create', 'wt-enter', '--spec', 'ENTER-001']));
    cachedOwner(JSON.parse(registry())['wt-enter'].owner.session_id);
    const before = governanceBytes(),
      beforeCapsules = capsules();
    const args = ['worktree', verb, 'wt-enter'];
    if (verb === 'bind') args.push('--spec', 'ENTER-001');
    if (verb === 'untrack') args.push('--reason', 'fixture ownership refusal');
    const result = run(args, root, { CAWS_SESSION_ID: 'foreign-caller' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/foreign|another session|owned by/);
    expect(governanceBytes()).toEqual(before);
    expect(capsules()).toEqual(beforeCapsules);
    expect(fs.existsSync(path.join(root, '.caws/worktrees/wt-enter'))).toBe(true);
  }
);

test('bridge scope and status cannot infer a caller from the owner envelope', () => {
  const ownerEnv = { CAWS_SESSION_ID: 'bridge-owner' };
  succeeded(run(['specs', 'activate', 'ENTER-001'], root, ownerEnv));
  succeeded(run(['claim', '--spec', 'ENTER-001'], root, ownerEnv));
  cachedOwner('bridge-owner');
  const before = governanceBytes(),
    beforeCapsules = capsules();
  const ownScope = run(['scope', 'show', 'src/file.ts', '--json'], root, ownerEnv);
  succeeded(ownScope);
  expect(JSON.parse(ownScope.stdout).decision).toBe('admit');
  for (const caller of [undefined, 'foreign-caller']) {
    const scope = run(['scope', 'show', 'src/file.ts', '--json'], root, {
      CAWS_SESSION_ID: caller,
    });
    succeeded(scope);
    expect(JSON.parse(scope.stdout).decision).toBe('no_authority');
    const status = run(['status', '--json'], root, { CAWS_SESSION_ID: caller });
    succeeded(status);
    expect(JSON.parse(status.stdout).agents.self_session_id).toBe(caller ?? null);
  }
  expect(governanceBytes()).toEqual(before);
  expect(capsules()).toEqual(beforeCapsules);
});

test('explicit takeover with no caller context creates and carries a new identity', () => {
  succeeded(run(['worktree', 'create', 'wt-enter', '--spec', 'ENTER-001']));
  const priorOwner = JSON.parse(registry())['wt-enter'].owner.session_id;
  cachedOwner(priorOwner);
  const cwd = path.join(root, '.caws/worktrees/wt-enter');
  const takeover = run(['claim', '--takeover'], cwd);
  succeeded(takeover);
  const record = JSON.parse(registry())['wt-enter'];
  expect(record.owner.session_id).not.toBe(priorOwner);
  expect(record.prior_owners.map((o) => o.session_id)).toContain(priorOwner);
  const line = takeover.stdout.split('\n').find((s) => s.startsWith('Continue in this shell: '));
  expect(line).toBeDefined();
  const before = governanceBytes(),
    beforeCapsules = capsules();
  const continued = spawnSync(
    '/bin/bash',
    ['--noprofile', '--norc', '-c', `${line.slice('Continue in this shell: '.length)}; caws claim`],
    {
      cwd,
      env,
      encoding: 'utf8',
    }
  );
  succeeded(continued);
  expect(continued.stdout).toContain(`OWNED (you) — ${record.owner.session_id}`);
  expect(governanceBytes()).toEqual(before);
  expect(capsules()).toEqual(beforeCapsules);
});

test('a newly minted bridge prints context that grants scope and can release the bridge', () => {
  succeeded(run(['specs', 'activate', 'ENTER-001'], root, { CAWS_SESSION_ID: 'spec-author' }));
  const acquired = run(['claim', '--spec', 'ENTER-001']);
  succeeded(acquired);
  const line = acquired.stdout.split('\n').find((s) => s.startsWith('Continue in this shell: '));
  expect(line).toBeDefined();
  const prefix = line.slice('Continue in this shell: '.length);
  const scoped = spawnSync(
    '/bin/bash',
    ['--noprofile', '--norc', '-c', `${prefix}; caws scope show src/file.ts --json`],
    {
      cwd: root,
      env,
      encoding: 'utf8',
    }
  );
  succeeded(scoped);
  expect(JSON.parse(scoped.stdout).decision).toBe('admit');
  const released = spawnSync(
    '/bin/bash',
    ['--noprofile', '--norc', '-c', `${prefix}; caws claim --release --spec ENTER-001`],
    {
      cwd: root,
      env,
      encoding: 'utf8',
    }
  );
  succeeded(released);
  const rescoped = spawnSync(
    '/bin/bash',
    ['--noprofile', '--norc', '-c', `${prefix}; caws scope show src/file.ts --json`],
    {
      cwd: root,
      env,
      encoding: 'utf8',
    }
  );
  succeeded(rescoped);
  expect(JSON.parse(rescoped.stdout).decision).toBe('no_authority');
});

test.each(['capsule', 'capsule and fresh envelope'])(
  'a different explicit session cannot borrow the owner %s',
  (neighbor) => {
    succeeded(run(['worktree', 'create', 'wt-enter', '--spec', 'ENTER-001']));
    if (neighbor.includes('envelope')) {
      const owner = JSON.parse(registry())['wt-enter'].owner.session_id;
      const dir = path.join(root, '.caws/sessions', owner);
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, '.session-envelope.json'),
        JSON.stringify({
          session_id: owner,
          repo_root: root,
          last_seen_at: new Date().toISOString(),
          platform: 'none',
        })
      );
    }
    const beforeRegistry = registry(),
      beforeCapsules = capsules();
    const result = run(['claim'], path.join(root, '.caws/worktrees/wt-enter'), {
      CAWS_SESSION_ID: 'foreign-session',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('foreign_owner_blocked');
    expect(registry()).toBe(beforeRegistry);
    expect(capsules()).toEqual(beforeCapsules);
  }
);

test('native identity survives create and enter without a fallback export', () => {
  const native = { CODEX_THREAD_ID: 'native-owner', CAWS_AGENT_SURFACE: 'codex' };
  const created = run(['worktree', 'create', 'wt-enter', '--spec', 'ENTER-001'], root, native);
  succeeded(created);
  const line = created.stdout.split('\n').find((s) => s.startsWith('Next: cd '));
  expect(line).toBeDefined();
  expect(created.stdout).not.toContain('export CAWS_SESSION_ID=');
  const claim = spawnSync(
    '/bin/bash',
    ['--noprofile', '--norc', '-c', line.slice('Next: '.length)],
    {
      cwd: os.tmpdir(),
      env: { ...env, ...native },
      encoding: 'utf8',
    }
  );
  succeeded(claim);
  expect(claim.stdout).toContain('OWNED (you) — native-owner');
  expect(capsules()).toEqual({});
});
