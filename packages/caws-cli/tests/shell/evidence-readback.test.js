'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  runEvidenceListCommand,
  runEvidenceShowCommand,
} = require('../../dist/shell/commands/evidence');
const { initProject } = require('../../dist/store/init-store');
const { appendEvent } = require('../../dist/store/events-store');

const repos = [];
const ACTOR = { kind: 'agent', id: 'test-agent', session_id: 'session-1' };

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

function append(cawsDir, body) {
  const result = appendEvent(cawsDir, {
    ts: body.ts ?? '2026-07-04T12:00:00.000Z',
    actor: ACTOR,
    ...body,
  });
  if (!result.ok) throw new Error('appendEvent failed: ' + JSON.stringify(result.errors));
  return result.value;
}

function fixtureRepo() {
  const repoRoot = mkRepo('caws-evidence-readback-');
  const caws = setupCaws(repoRoot);
  const test = append(caws, {
    event: 'test_recorded',
    spec_id: 'EVIDENCE-001',
    data: { command: 'npm test', exit_code: 0, passed: 3, failed: 0 },
  });
  const gate = append(caws, {
    event: 'gate_evaluated',
    spec_id: 'EVIDENCE-001',
    data: { gate_id: 'budget_limit', mode: 'block', result: 'pass', violations: [] },
  });
  const ac = append(caws, {
    event: 'ac_recorded',
    spec_id: 'EVIDENCE-001',
    data: { criterion_id: 'A1', status: 'pass', evidence_ref: 'npm test' },
  });
  const other = append(caws, {
    event: 'test_recorded',
    spec_id: 'OTHER-001',
    data: { command: 'npm test -- other', exit_code: 0 },
  });
  return { repoRoot, caws, test, gate, ac, other };
}

function runList(repoRoot, opts = {}) {
  const out = [];
  const err = [];
  const code = runEvidenceListCommand({
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
  const code = runEvidenceShowCommand({
    cwd: repoRoot,
    ref,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('caws evidence list/show readback', () => {
  test('list filters typed evidence by spec and kind without mutating events', () => {
    const { repoRoot, caws } = fixtureRepo();
    const before = readEvents(caws);

    const all = runList(repoRoot, { specId: 'EVIDENCE-001', json: true });
    const tests = runList(repoRoot, { specId: 'EVIDENCE-001', kind: 'test', json: true });

    expect(all.code).toBe(0);
    expect(tests.code).toBe(0);
    const allPayload = JSON.parse(all.out);
    const testPayload = JSON.parse(tests.out);
    expect(allPayload.read_only).toBe(true);
    expect(allPayload.count).toBe(3);
    expect(allPayload.events.map((event) => event.type)).toEqual(['test', 'gate', 'ac']);
    expect(allPayload.events.every((event) => event.spec_id === 'EVIDENCE-001')).toBe(true);
    expect(testPayload.count).toBe(1);
    expect(testPayload.events[0].type).toBe('test');
    expect(testPayload.events[0].data.command).toBe('npm test');
    expect(readEvents(caws)).toBe(before);
  });

  test('show resolves sequence number, exact hash, and unique hash prefix without mutating', () => {
    const { repoRoot, caws, test, gate, ac } = fixtureRepo();
    const before = readEvents(caws);

    const bySeq = runShow(repoRoot, String(test.seq), { json: true });
    const byHash = runShow(repoRoot, gate.event_hash, { json: true });
    const byPrefix = runShow(repoRoot, ac.event_hash.slice(0, 18), { json: true });

    expect(bySeq.code).toBe(0);
    expect(byHash.code).toBe(0);
    expect(byPrefix.code).toBe(0);
    expect(JSON.parse(bySeq.out).event.seq).toBe(test.seq);
    expect(JSON.parse(byHash.out).event.hash).toBe(gate.event_hash);
    expect(JSON.parse(byPrefix.out).event.hash).toBe(ac.event_hash);
    expect(readEvents(caws)).toBe(before);
  });

  test('show distinguishes not found and ambiguous references', () => {
    const { repoRoot, test } = fixtureRepo();

    const missing = runShow(repoRoot, 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
    const ambiguous = runShow(repoRoot, test.event_hash.slice(0, 7));

    expect(missing.code).toBe(1);
    expect(missing.err).toContain('not found');
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err).toContain('ambiguous');
  });
});
