'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  runEventsListCommand,
  runEventsRotateCommand,
  runEventsShowCommand,
} = require('../../dist/shell');
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

function append(cawsDir, body) {
  const result = appendEvent(cawsDir, {
    ts: body.ts ?? '2026-07-04T00:00:00.000Z',
    actor: ACTOR,
    ...body,
  });
  if (!result.ok) throw new Error('appendEvent failed: ' + JSON.stringify(result.errors));
  return result.value;
}

function readEvents(cawsDir) {
  return fs.readFileSync(path.join(cawsDir, 'events.jsonl'), 'utf8');
}

function runList(repoRoot, opts = {}) {
  const out = [];
  const err = [];
  const code = runEventsListCommand({
    cwd: repoRoot,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function runShow(repoRoot, ref, opts = {}) {
  const out = [];
  const err = [];
  const code = runEventsShowCommand({
    cwd: repoRoot,
    ref,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function fixtureRepo() {
  const repoRoot = mkRepo('caws-events-log-discovery-');
  const caws = setupCaws(repoRoot);
  append(caws, {
    event: 'test_recorded',
    spec_id: 'EVENTS-001',
    data: { command: 'npm test', exit_code: 0 },
  });
  append(caws, {
    event: 'gate_evaluated',
    spec_id: 'EVENTS-001',
    data: { gate_id: 'budget_limit', mode: 'block', result: 'pass', violations: [] },
  });
  const rotateOut = [];
  const rotateErr = [];
  const rotateCode = runEventsRotateCommand({
    cwd: repoRoot,
    reason: 'maintenance',
    allowClean: true,
    now: () => FIXED,
    out: (line) => rotateOut.push(line),
    err: (line) => rotateErr.push(line),
  });
  if (rotateCode !== 0) {
    throw new Error(`rotate failed: ${rotateErr.join('\n')}\n${rotateOut.join('\n')}`);
  }
  const acceptance = append(caws, {
    event: 'ac_recorded',
    spec_id: 'EVENTS-001',
    ts: '2026-07-04T12:01:00.000Z',
    data: { criterion_id: 'A1', status: 'pass', evidence_ref: 'npm test' },
  });
  return { repoRoot, caws, acceptance };
}

describe('caws events list/show discovery', () => {
  test('list summarizes verified chain, latest event, and rotation archive status without mutating', () => {
    const { repoRoot, caws } = fixtureRepo();
    const before = readEvents(caws);

    const result = runList(repoRoot, { json: true });

    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const payload = JSON.parse(result.out);
    expect(payload.read_only).toBe(true);
    expect(payload.chain_valid).toBe(true);
    expect(payload.event_count).toBe(2);
    expect(payload.counts_by_event).toEqual({ chain_rotated: 1, ac_recorded: 1 });
    expect(payload.latest_event.event).toBe('ac_recorded');
    expect(payload.rotation_count).toBe(1);
    expect(payload.latest_rotation.archive_present).toBe(true);
    expect(payload.latest_rotation.archive_path).toBe(
      '.caws/events.jsonl.archive-2026-07-04T12-00-00-000Z'
    );
    expect(payload.latest_rotation.archive_digest_matches).toBe(true);
    expect(payload.latest_rotation.archive_line_count_matches).toBe(true);
    expect(payload.latest_rotation.prior_line_count).toBe(2);
    expect(payload.recent_events.map((event) => event.event)).toEqual([
      'chain_rotated',
      'ac_recorded',
    ]);
    expect(readEvents(caws)).toBe(before);
  });

  test('show resolves latest-rotation and ordinary refs after chain verification', () => {
    const { repoRoot, caws, acceptance } = fixtureRepo();
    const before = readEvents(caws);

    const rotation = runShow(repoRoot, 'latest-rotation', { json: true });
    const bySeq = runShow(repoRoot, String(acceptance.seq), { json: true });
    const byPrefix = runShow(repoRoot, acceptance.event_hash.slice(0, 18), { json: true });

    expect(rotation.code).toBe(0);
    expect(bySeq.code).toBe(0);
    expect(byPrefix.code).toBe(0);
    const rotationPayload = JSON.parse(rotation.out);
    expect(rotationPayload.event.event).toBe('chain_rotated');
    expect(rotationPayload.rotation.archive_present).toBe(true);
    expect(rotationPayload.rotation.archive_digest_matches).toBe(true);
    expect(JSON.parse(bySeq.out).event.event).toBe('ac_recorded');
    expect(JSON.parse(byPrefix.out).event.hash).toBe(acceptance.event_hash);
    expect(readEvents(caws)).toBe(before);
  });

  test('show distinguishes missing and ambiguous references without mutating', () => {
    const { repoRoot, caws } = fixtureRepo();
    const before = readEvents(caws);

    const missing = runShow(
      repoRoot,
      'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    );
    const ambiguous = runShow(repoRoot, 'sha256:');

    expect(missing.code).toBe(1);
    expect(missing.err).toContain('not found');
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err).toContain('ambiguous');
    expect(readEvents(caws)).toBe(before);
  });
});
