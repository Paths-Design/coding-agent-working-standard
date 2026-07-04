'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runEventsRotateCommand } = require('../../dist/shell');
const { initProject } = require('../../dist/store/init-store');
const { appendEvent } = require('../../dist/store/events-store');

const repos = [];
const ACTOR = { kind: 'agent', id: 'test-agent', session_id: 'session-1' };
const FIXED = new Date('2026-07-04T12:00:00.000Z');

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

function seedCleanV11(cawsDir) {
  const result = appendEvent(cawsDir, {
    event: 'test_recorded',
    ts: '2026-07-04T00:00:00.000Z',
    actor: ACTOR,
    spec_id: 'ROTATE-001',
    data: { command: 'npm test', exit_code: 0 },
  });
  if (!result.ok) throw new Error('appendEvent failed: ' + JSON.stringify(result.errors));
  return result.value;
}

function readEvents(cawsDir) {
  return fs.readFileSync(path.join(cawsDir, 'events.jsonl'), 'utf8');
}

function runRotate(repoRoot, opts = {}) {
  const out = [];
  const err = [];
  const code = runEventsRotateCommand({
    cwd: repoRoot,
    reason: 'maintenance preview',
    now: () => FIXED,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function rotateRepo() {
  const repoRoot = mkRepo('caws-events-rotate-dry-run-');
  const caws = setupCaws(repoRoot);
  seedCleanV11(caws);
  return { repoRoot, caws };
}

describe('caws events rotate --dry-run', () => {
  test('json dry-run previews archive, digest, stats, and genesis without mutating events', () => {
    const { repoRoot, caws } = rotateRepo();
    const before = readEvents(caws);

    const result = runRotate(repoRoot, { dryRun: true, allowClean: true, json: true });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload.ok).toBe(true);
    expect(payload.dry_run).toBe(true);
    expect(payload.read_only).toBe(true);
    expect(payload.archive).toBe('events.jsonl.archive-2026-07-04T12-00-00-000Z');
    expect(payload.archive_path).toBe('.caws/events.jsonl.archive-2026-07-04T12-00-00-000Z');
    expect(payload.prior_file_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(payload.prior_line_count).toBe(1);
    expect(payload.prior_chain_status).toBe('parseable_unverified');
    expect(payload.actor_shape_stats).toEqual({ v10_string_actor: 0, v11_object_actor: 1, unparseable: 0 });
    expect(payload.genesis_event.event).toBe('chain_rotated');
    expect(payload.genesis_event.data.prior_file_path).toBe(payload.archive);
    expect(payload.genesis_event.data.prior_file_digest).toBe(payload.prior_file_digest);
    expect(readEvents(caws)).toBe(before);
    expect(fs.existsSync(path.join(caws, payload.archive))).toBe(false);
  });

  test('dry-run refuses a clean v11 chain without --allow-clean and preserves bytes', () => {
    const { repoRoot, caws } = rotateRepo();
    const before = readEvents(caws);

    const result = runRotate(repoRoot, { dryRun: true, json: true });

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.out);
    expect(payload.ok).toBe(false);
    expect(payload.dry_run).toBe(true);
    expect(payload.read_only).toBe(true);
    expect(payload.reason).toContain('clean v11 chain');
    expect(readEvents(caws)).toBe(before);
  });

  test('dry-run prediction matches applied chain_rotated payload for same timestamp', () => {
    const { repoRoot, caws } = rotateRepo();
    const before = readEvents(caws);

    const dryRun = runRotate(repoRoot, { dryRun: true, allowClean: true, json: true });
    const apply = runRotate(repoRoot, { allowClean: true });

    expect(dryRun.code).toBe(0);
    expect(apply.code).toBe(0);
    const plan = JSON.parse(dryRun.out);
    const genesis = JSON.parse(readEvents(caws).trim());
    expect(genesis.event).toBe('chain_rotated');
    expect(genesis.data.prior_file_path).toBe(plan.archive);
    expect(genesis.data.prior_file_digest).toBe(plan.prior_file_digest);
    expect(genesis.data.prior_line_count).toBe(plan.prior_line_count);
    expect(genesis.data.prior_chain_status).toBe(plan.prior_chain_status);
    expect(genesis.data.actor_shape_stats).toEqual(plan.actor_shape_stats);
    expect(fs.readFileSync(path.join(caws, plan.archive), 'utf8')).toBe(before);
  });
});
