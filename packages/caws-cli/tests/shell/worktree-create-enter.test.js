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

test.each(['minted', 'capsule'])(
  'the exact %s continuation enters with the created identity and no second mint',
  (source) => {
    if (source === 'capsule')
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
  expect(registry()).toBe(beforeRegistry);
  expect(capsules()).toEqual(beforeCapsules);
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
  expect(created.stdout).toContain('Next: cd .caws/worktrees/wt-enter');
  expect(created.stdout).not.toContain('export CAWS_SESSION_ID=');
  const claim = run(['claim'], path.join(root, '.caws/worktrees/wt-enter'), native);
  succeeded(claim);
  expect(claim.stdout).toContain('OWNED (you) — native-owner');
  expect(capsules()).toEqual({});
});
