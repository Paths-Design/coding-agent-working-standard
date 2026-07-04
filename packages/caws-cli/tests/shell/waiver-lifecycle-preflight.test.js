'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  runWaiverCreateCommand,
  runWaiverPruneCommand,
} = require('../../dist/shell');
const { initProject } = require('../../dist/store/init-store');
const { loadWaivers } = require('../../dist/store/waivers-store');

const repos = [];
const NOW = new Date('2026-07-04T12:00:00.000Z');

afterAll(() => {
  for (const r of repos) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function mkRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  repos.push(root);
  return root;
}

function setupCaws(repoRoot) {
  const r = initProject(repoRoot);
  if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
  return path.join(repoRoot, '.caws');
}

function readEvents(cawsDir) {
  const p = path.join(cawsDir, 'events.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function readWaiver(cawsDir, id) {
  const p = path.join(cawsDir, 'waivers', `${id}.yaml`);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function runCreate(repoRoot, opts = {}) {
  const out = [];
  const err = [];
  const code = runWaiverCreateCommand({
    cwd: repoRoot,
    id: opts.id ?? 'VALID-001',
    title: opts.title ?? 'Valid waiver',
    gates: opts.gates ?? ['budget_limit'],
    reason: opts.reason ?? 'Testing waiver preflight',
    approvedBy: opts.approvedBy ?? 'reviewer@example.com',
    expiresAt: opts.expiresAt ?? '2026-07-05T00:00:00.000Z',
    now: () => NOW,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function runPrune(repoRoot, opts = {}) {
  const out = [];
  const err = [];
  const code = runWaiverPruneCommand({
    cwd: repoRoot,
    status: 'expired',
    now: () => NOW,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function fixtureRepo() {
  const repoRoot = mkRepo('caws-waiver-lifecycle-');
  const caws = setupCaws(repoRoot);
  const expired = runCreate(repoRoot, {
    id: 'EXPIRED-001',
    expiresAt: '2026-07-01T00:00:00.000Z',
  });
  const active = runCreate(repoRoot, {
    id: 'ACTIVE-001',
    expiresAt: '2026-07-05T00:00:00.000Z',
  });
  if (expired.code !== 0) throw new Error(`expired create failed: ${expired.err}`);
  if (active.code !== 0) throw new Error(`active create failed: ${active.err}`);
  return { repoRoot, caws };
}

describe('caws waiver create --dry-run and prune', () => {
  test('create --dry-run validates without writing a waiver file or events', () => {
    const repoRoot = mkRepo('caws-waiver-create-dry-run-');
    const caws = setupCaws(repoRoot);
    const beforeEvents = readEvents(caws);

    const result = runCreate(repoRoot, { id: 'DRYRUN-001', dryRun: true, json: true });

    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const payload = JSON.parse(result.out);
    expect(payload.dry_run).toBe(true);
    expect(payload.read_only).toBe(true);
    expect(payload.would_write).toBe(true);
    expect(payload.waiver.id).toBe('DRYRUN-001');
    expect(readWaiver(caws, 'DRYRUN-001')).toBe(null);
    expect(readEvents(caws)).toBe(beforeEvents);
  });

  test('create --dry-run reports duplicate ids before writing', () => {
    const { repoRoot, caws } = fixtureRepo();
    const before = readWaiver(caws, 'ACTIVE-001');
    const beforeEvents = readEvents(caws);

    const result = runCreate(repoRoot, { id: 'ACTIVE-001', dryRun: true });

    expect(result.code).toBe(1);
    expect(result.err).toContain('already exists');
    expect(readWaiver(caws, 'ACTIVE-001')).toBe(before);
    expect(readEvents(caws)).toBe(beforeEvents);
  });

  test('prune dry-run plans only expired active waivers without mutating files', () => {
    const { repoRoot, caws } = fixtureRepo();
    const beforeExpired = readWaiver(caws, 'EXPIRED-001');
    const beforeActive = readWaiver(caws, 'ACTIVE-001');
    const beforeEvents = readEvents(caws);

    const result = runPrune(repoRoot, { json: true });

    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const payload = JSON.parse(result.out);
    expect(payload.dry_run).toBe(true);
    expect(payload.read_only).toBe(true);
    expect(payload.count).toBe(1);
    expect(payload.targets.map((target) => target.id)).toEqual(['EXPIRED-001']);
    expect(readWaiver(caws, 'EXPIRED-001')).toBe(beforeExpired);
    expect(readWaiver(caws, 'ACTIVE-001')).toBe(beforeActive);
    expect(readEvents(caws)).toBe(beforeEvents);
  });

  test('prune --apply revokes only expired active waivers', () => {
    const { repoRoot, caws } = fixtureRepo();
    const beforeEvents = readEvents(caws);

    const result = runPrune(repoRoot, {
      apply: true,
      reason: 'expired cleanup',
      revokedBy: 'operator@example.com',
      json: true,
    });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload.dry_run).toBe(false);
    expect(payload.count).toBe(1);
    expect(payload.revoked.map((waiver) => waiver.id)).toEqual(['EXPIRED-001']);
    const loaded = loadWaivers(caws);
    const expired = loaded.waivers.find((waiver) => waiver.id === 'EXPIRED-001');
    const active = loaded.waivers.find((waiver) => waiver.id === 'ACTIVE-001');
    expect(expired.status).toBe('revoked');
    expect(expired.revocation.revoked_by).toBe('operator@example.com');
    expect(expired.revocation.reason).toBe('expired cleanup');
    expect(active.status).toBe('active');
    expect(readEvents(caws)).toBe(beforeEvents);
  });

  test('prune rejects unsupported status selectors before mutation', () => {
    const { repoRoot, caws } = fixtureRepo();
    const beforeExpired = readWaiver(caws, 'EXPIRED-001');

    const result = runPrune(repoRoot, { status: 'revoked' });

    expect(result.code).toBe(1);
    expect(result.err).toContain('expected expired');
    expect(readWaiver(caws, 'EXPIRED-001')).toBe(beforeExpired);
  });
});
