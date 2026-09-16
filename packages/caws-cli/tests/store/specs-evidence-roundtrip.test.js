'use strict';

/**
 * Evidence mechanical-field round-trip (CAWS-SPECS-VERIFY-ACS-REDERIVE-001, A15).
 *
 * The five machine-checkable evidence fields — test_nodeid, command,
 * exit_code, artifact_path, commit_sha — are accepted by recordSpecEvidence,
 * serialized by renderEvidenceEntry, and forwarded by the CLI. Before this
 * slice nothing READ them, and nothing proved they survived a write/read
 * cycle. A re-derivation gate built on an unproven writer would silently read
 * `undefined` and report every criterion as narrative-only.
 *
 * Drives the REAL compiled writer and reads back through the REAL compiled
 * kernel parser — not a regex over the YAML — so the assertion is on the typed
 * field the gate consumes, with the exact value that went in.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createSpec, recordSpecEvidence } = require('../../dist/store/specs-writer');
const { loadEvents } = require('../../dist/store/events-store');
const { initProject } = require('../../dist/store/init-store');
const { readYamlSource } = require('../../dist/store/yaml-store');
const { parseAndValidateSpec, isOk } = require('../../dist/kernel');

const ACTOR = { kind: 'agent', id: 'jest', platform: 'jest' };
const FIXED_NOW = () => new Date('2026-09-16T12:00:00.000Z');

const repos = [];
afterEach(() => {
  for (const repo of repos.splice(0)) {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

function mkRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  const r = initProject(root);
  if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
  repos.push(root);
  return { root, caws: path.join(root, '.caws') };
}

/** createSpec always emits a default A1, so the seeded draft has one criterion. */
function seedSpec(caws, id) {
  const r = createSpec(caws, {
    id,
    title: 'roundtrip fixture',
    mode: 'chore',
    riskTier: 3,
    actor: ACTOR,
  });
  if (!r.ok || r.value.kind !== 'success') {
    throw new Error('seed spec failed: ' + JSON.stringify(r));
  }
}

/** Read the spec back the way the close gate will: bytes -> kernel parser -> typed Spec. */
function loadTyped(caws, id) {
  const src = readYamlSource(path.join(caws, 'specs', `${id}.yaml`));
  if (!src.ok) throw new Error('readYamlSource failed: ' + JSON.stringify(src.errors));
  const parsed = parseAndValidateSpec(src.value);
  if (!isOk(parsed)) throw new Error('parse failed: ' + JSON.stringify(parsed.errors));
  return parsed.value;
}

function lastEvent(caws) {
  const r = loadEvents(caws);
  if (!r.ok) throw new Error('loadEvents failed');
  return r.value.events[r.value.events.length - 1];
}

// Values chosen to be hostile to a naive serializer: a pytest nodeid with `::`
// and brackets, a command carrying flags and a bare `--`, an abbreviated sha,
// and exit_code 0 — the falsy value a truthiness guard would drop.
const FULL = {
  testNodeid: 'tests/unit/test_gate.py::TestGate::test_refuses[case-1]',
  command: 'python3 -m pytest -q -- tests/unit/test_gate.py',
  exitCode: 0,
  artifactPath: 'docs/reports/gate-run.md',
  commitSha: 'd7f2267d90',
};

describe('evidence mechanical fields round-trip (A15)', () => {
  test('all five fields survive write -> YAML -> kernel parser with exact values', () => {
    const { caws } = mkRepo('ev-rt-full-');
    seedSpec(caws, 'EV-RT-001');

    const r = recordSpecEvidence(caws, {
      id: 'EV-RT-001',
      criterionId: 'A1',
      status: 'pass',
      evidenceRef: 'gate run',
      ...FULL,
      now: FIXED_NOW,
      actor: ACTOR,
    });
    expect(r.ok).toBe(true);

    const spec = loadTyped(caws, 'EV-RT-001');
    expect(spec.evidence).toHaveLength(1);
    const entry = spec.evidence[0];
    expect(entry.criterion_id).toBe('A1');
    expect(entry.status).toBe('pass');
    expect(entry.test_nodeid).toBe(FULL.testNodeid);
    expect(entry.command).toBe(FULL.command);
    expect(entry.exit_code).toBe(0);
    expect(entry.artifact_path).toBe(FULL.artifactPath);
    expect(entry.commit_sha).toBe(FULL.commitSha);
    // The sha must come back as a string, not a YAML-coerced number — a
    // digit-only abbreviated sha like 1234567 would otherwise parse as an int.
    expect(typeof entry.commit_sha).toBe('string');
  });

  test('a digit-only abbreviated commit_sha is not coerced to a number', () => {
    const { caws } = mkRepo('ev-rt-sha-');
    seedSpec(caws, 'EV-RT-002');
    recordSpecEvidence(caws, {
      id: 'EV-RT-002',
      criterionId: 'A1',
      status: 'pass',
      evidenceRef: 'x',
      commitSha: '1234567',
      now: FIXED_NOW,
      actor: ACTOR,
    });
    const entry = loadTyped(caws, 'EV-RT-002').evidence[0];
    expect(entry.commit_sha).toBe('1234567');
    expect(typeof entry.commit_sha).toBe('string');
  });

  test('a non-zero exit_code round-trips as a number', () => {
    const { caws } = mkRepo('ev-rt-exit-');
    seedSpec(caws, 'EV-RT-003');
    recordSpecEvidence(caws, {
      id: 'EV-RT-003',
      criterionId: 'A1',
      status: 'fail',
      evidenceRef: 'x',
      command: 'npm test',
      exitCode: 1,
      now: FIXED_NOW,
      actor: ACTOR,
    });
    const entry = loadTyped(caws, 'EV-RT-003').evidence[0];
    expect(entry.exit_code).toBe(1);
    expect(typeof entry.exit_code).toBe('number');
  });

  test('the ac_recorded event mirrors all five fields with the same values', () => {
    const { caws } = mkRepo('ev-rt-event-');
    seedSpec(caws, 'EV-RT-004');
    recordSpecEvidence(caws, {
      id: 'EV-RT-004',
      criterionId: 'A1',
      status: 'pass',
      evidenceRef: 'x',
      ...FULL,
      now: FIXED_NOW,
      actor: ACTOR,
    });
    const ev = lastEvent(caws);
    expect(ev.event).toBe('ac_recorded');
    expect(ev.data.test_nodeid).toBe(FULL.testNodeid);
    expect(ev.data.command).toBe(FULL.command);
    expect(ev.data.exit_code).toBe(0);
    expect(ev.data.artifact_path).toBe(FULL.artifactPath);
    expect(ev.data.commit_sha).toBe(FULL.commitSha);
  });

  test('omitted mechanical fields are absent on read-back, not undefined/null keys', () => {
    const { caws } = mkRepo('ev-rt-absent-');
    seedSpec(caws, 'EV-RT-005');
    recordSpecEvidence(caws, {
      id: 'EV-RT-005',
      criterionId: 'A1',
      status: 'pass',
      evidenceRef: 'narrative only',
      now: FIXED_NOW,
      actor: ACTOR,
    });
    const entry = loadTyped(caws, 'EV-RT-005').evidence[0];
    for (const key of ['test_nodeid', 'command', 'exit_code', 'artifact_path', 'commit_sha']) {
      expect(Object.prototype.hasOwnProperty.call(entry, key)).toBe(false);
    }
    const yaml = fs.readFileSync(path.join(caws, 'specs', 'EV-RT-005.yaml'), 'utf8');
    expect(yaml).not.toMatch(/exit_code:/);
    expect(yaml).not.toMatch(/commit_sha:/);
  });

  test('re-recording a criterion replaces the whole entry — a stale citation does not survive an upsert', () => {
    // The record is the whole claim. If a second record omits commit_sha, the
    // first record's sha must not linger as a citation for evidence it no
    // longer describes.
    const { caws } = mkRepo('ev-rt-upsert-');
    seedSpec(caws, 'EV-RT-006');
    const base = { id: 'EV-RT-006', criterionId: 'A1', now: FIXED_NOW, actor: ACTOR };
    recordSpecEvidence(caws, { ...base, status: 'pass', evidenceRef: 'first', ...FULL });
    recordSpecEvidence(caws, {
      ...base,
      status: 'pass',
      evidenceRef: 'second',
      testNodeid: 'tests/unit/test_other.py::test_b',
    });
    const spec = loadTyped(caws, 'EV-RT-006');
    expect(spec.evidence).toHaveLength(1);
    const entry = spec.evidence[0];
    expect(entry.evidence_ref).toBe('second');
    expect(entry.test_nodeid).toBe('tests/unit/test_other.py::test_b');
    expect(Object.prototype.hasOwnProperty.call(entry, 'commit_sha')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(entry, 'command')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(entry, 'exit_code')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(entry, 'artifact_path')).toBe(false);
  });
});
