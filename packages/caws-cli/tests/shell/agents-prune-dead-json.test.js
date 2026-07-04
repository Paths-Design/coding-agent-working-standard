'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { runAgentsPruneCommand } = require('../../dist/shell/commands/agents');
const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  return root;
}

function writeLease(root, sessionId, overrides = {}) {
  const cawsDir = path.join(root, '.caws');
  const leasesDir = path.join(cawsDir, 'leases');
  fs.mkdirSync(leasesDir, { recursive: true });
  const lease = {
    lease_version: 1,
    session_id: sessionId,
    platform: 'codex',
    status: 'active',
    started_at: '2026-07-04T10:00:00.000Z',
    last_active: '2026-07-04T10:00:00.000Z',
    repo_root: root,
    cwd: root,
    git_common_dir: path.join(root, '.git'),
    git_dir: path.join(root, '.git'),
    branch: 'main',
    pid: 0,
    hostname: os.hostname(),
    last_seen_reason: 'manual_register',
    ...overrides,
  };
  fs.writeFileSync(path.join(leasesDir, `${sessionId}.json`), JSON.stringify(lease, null, 2) + '\n');
}

function leaseNames(root) {
  const leasesDir = path.join(root, '.caws', 'leases');
  if (!fs.existsSync(leasesDir)) return [];
  return fs.readdirSync(leasesDir).sort();
}

function readBytes(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function leaseSnapshot(root) {
  const leasesDir = path.join(root, '.caws', 'leases');
  return Object.fromEntries(
    leaseNames(root).map((name) => [name, readBytes(path.join(leasesDir, name))])
  );
}

function runPrune(root, opts = {}) {
  const out = [];
  const err = [];
  const code = runAgentsPruneCommand({
    cwd: root,
    now: () => new Date('2026-07-04T12:00:00.000Z'),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('caws agents prune --dead --json', () => {
  test('dry-run emits CAWS-native JSON without requiring --status or mutating leases', () => {
    const root = mkRepo();
    writeLease(root, 'dead-a');
    writeLease(root, 'fresh-a', {
      last_active: '2026-07-04T11:45:00.000Z',
      pid: 0,
    });
    writeLease(root, 'foreign-a', {
      hostname: 'another-host',
      last_active: '2026-07-04T09:00:00.000Z',
      pid: 0,
    });
    writeLease(root, 'stopped-a', {
      status: 'stopped',
      stopped_at: '2026-07-04T10:15:00.000Z',
      last_active: '2026-07-04T09:00:00.000Z',
      pid: 0,
    });
    const before = leaseSnapshot(root);

    const result = runPrune(root, { dead: true, json: true });
    const json = JSON.parse(result.out);

    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(json).toMatchObject({
      ok: true,
      dry_run: true,
      mode: 'dead',
      candidates: ['dead-a'],
      deleted: [],
      skipped_foreign_host: ['foreign-a'],
    });
    expect(Array.isArray(json.diagnostics)).toBe(true);
    expect(leaseSnapshot(root)).toEqual(before);
  });

  test('apply deletes only dead-process candidates and reports deleted ids as JSON', () => {
    const root = mkRepo();
    writeLease(root, 'dead-b');
    writeLease(root, 'fresh-b', {
      last_active: '2026-07-04T11:45:00.000Z',
      pid: 0,
    });
    writeLease(root, 'foreign-b', {
      hostname: 'another-host',
      last_active: '2026-07-04T09:00:00.000Z',
      pid: 0,
    });
    writeLease(root, 'stopped-b', {
      status: 'stopped',
      stopped_at: '2026-07-04T10:15:00.000Z',
      last_active: '2026-07-04T09:00:00.000Z',
      pid: 0,
    });

    const result = runPrune(root, { dead: true, apply: true, json: true });
    const json = JSON.parse(result.out);

    expect(result.code).toBe(0);
    expect(json).toMatchObject({
      ok: true,
      dry_run: false,
      mode: 'dead',
      candidates: ['dead-b'],
      deleted: ['dead-b'],
      skipped_foreign_host: ['foreign-b'],
    });
    expect(leaseNames(root)).toEqual(['foreign-b.json', 'fresh-b.json', 'stopped-b.json']);
  });
});
