'use strict';

/**
 * CAWS-AGENTS-FORK-IDENTITY-001 — CLI parse path + kernel write path.
 *
 * Pins the fork-aware lease surface end to end: harness_session_kind +
 * forked_from written and carried forward across throttled heartbeats,
 * hook_pid replacing the legacy pid on fresh writes (with pid fallback for
 * legacy leases), heartbeat flag validation, the agents-list conjoined
 * advisory, and the hook template's namespace boundary + env passthrough.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
const HOOK_TEMPLATE = path.resolve(
  __dirname,
  '..',
  '..',
  'templates',
  'hook-packs',
  'shared',
  'agent-heartbeat.sh'
);

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  return root;
}

function spawnCli(root, args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'fork-identity-test', ...env },
  });
}

function readLease(root, sid) {
  return JSON.parse(fs.readFileSync(path.join(root, '.caws', 'leases', `${sid}.json`), 'utf8'));
}

function writeLease(root, sid, overrides = {}) {
  const leasesDir = path.join(root, '.caws', 'leases');
  fs.mkdirSync(leasesDir, { recursive: true });
  fs.writeFileSync(
    path.join(leasesDir, `${sid}.json`),
    JSON.stringify(
      {
        lease_version: 1,
        session_id: sid,
        platform: 'test',
        status: 'active',
        started_at: '2026-07-04T10:00:00.000Z',
        last_active: '2026-07-04T10:00:05.000Z',
        repo_root: root,
        cwd: root,
        git_common_dir: path.join(root, '.git'),
        git_dir: path.join(root, '.git'),
        hostname: os.hostname(),
        last_seen_reason: 'manual_register',
        ...overrides,
      },
      null,
      2
    ) + '\n'
  );
}

test('A1: heartbeat --session-kind fork --forked-from writes the fields; follow-up without flags carries them forward', () => {
  const root = mkRepo();
  const first = spawnCli(root, [
    'agents', 'heartbeat', '--session-id', 'fork-sess', '--platform', 'test',
    '--session-kind', 'fork', '--forked-from', 'parent-sess',
  ]);
  expect(first.status).toBe(0);
  let lease = readLease(root, 'fork-sess');
  expect(lease.harness_session_kind).toBe('fork');
  expect(lease.forked_from).toBe('parent-sess');
  expect(typeof lease.hook_pid).toBe('number');
  expect(lease.pid).toBeUndefined();
  // Throttled-style follow-up: context omits the fork fields.
  const second = spawnCli(root, [
    'agents', 'heartbeat', '--session-id', 'fork-sess', '--platform', 'test', '--reason', 'claim',
  ]);
  expect(second.status).toBe(0);
  lease = readLease(root, 'fork-sess');
  expect(lease.harness_session_kind).toBe('fork');
  expect(lease.forked_from).toBe('parent-sess');
});

test('A2: a legacy pid-only lease still feeds the dead-oracle fallback', () => {
  const root = mkRepo();
  // Legacy shape: pid only, no hook_pid, last_active long past the TTL.
  writeLease(root, 'legacy-sess', {
    pid: 0, // dead pid — the oracle selects dead-pid stale leases
    last_active: '2026-07-04T10:00:00.000Z',
    started_at: '2026-07-04T09:00:00.000Z',
  });
  const r = spawnCli(root, ['agents', 'prune', '--dead', '--json']);
  expect(r.status).toBe(0);
  const parsed = JSON.parse(r.stdout);
  expect(parsed.candidates).toContain('legacy-sess');
});

test('A3: invalid --session-kind and orphaned --forked-from are refused', () => {
  const root = mkRepo();
  const badKind = spawnCli(root, [
    'agents', 'heartbeat', '--session-id', 's1', '--platform', 'test', '--session-kind', 'bogus',
  ]);
  expect(badKind.status).toBe(1);
  expect(badKind.stderr).toMatch(/session-kind accepts exactly/);
  const orphan = spawnCli(root, [
    'agents', 'heartbeat', '--session-id', 's1', '--platform', 'test', '--forked-from', 'p',
  ]);
  expect(orphan.status).toBe(1);
  expect(orphan.stderr).toMatch(/only meaningful with --session-kind fork/);
});

test('A4: agents list flags overlapping same-host leases as a possible conjoined pair', () => {
  const root = mkRepo();
  writeLease(root, 'a-sess', {
    started_at: '2026-07-04T10:00:00.000Z',
    last_active: '2026-07-04T11:00:00.000Z',
    harness_session_kind: 'main',
  });
  writeLease(root, 'b-sess', {
    started_at: '2026-07-04T10:30:00.000Z',
    last_active: '2026-07-04T11:30:00.000Z',
    harness_session_kind: 'fork',
    forked_from: 'a-sess',
  });
  const text = spawnCli(root, ['agents', 'list']);
  expect(text.status).toBe(0);
  expect(text.stdout).toMatch(/conjoined-hint: (a-sess <=> b-sess|b-sess <=> a-sess)/);
  const json = spawnCli(root, ['agents', 'list', '--json']);
  expect(json.status).toBe(0);
  const parsed = JSON.parse(json.stdout);
  expect(parsed.conjoined_pairs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ a: 'a-sess', b: 'b-sess' }),
    ])
  );
  // Display-only: no lease file was modified by listing.
  expect(readLease(root, 'a-sess').last_active).toBe('2026-07-04T11:00:00.000Z');
});

test('A5: the hook template teaches the namespace boundary and passes fork identity through', () => {
  const src = fs.readFileSync(HOOK_TEMPLATE, 'utf8');
  expect(src).toMatch(/Harness display names \(ListAgents and similar\) are NOT CAWS addresses/);
  expect(src).toMatch(/\$\{CAWS_SESSION_KIND:\+--session-kind "\$CAWS_SESSION_KIND"\}/);
  expect(src).toMatch(/\$\{CAWS_FORKED_FROM:\+--forked-from "\$CAWS_FORKED_FROM"\}/);
});
