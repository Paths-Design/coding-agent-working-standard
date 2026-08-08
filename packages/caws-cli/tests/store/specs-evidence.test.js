'use strict';

/**
 * recordSpecEvidence + the AC-evidence-completeness close gate (WARN MODE)
 * (CAWS-SPEC-AC-EVIDENCE-AUTHORITY-01).
 *
 * The close gate ships in WARN MODE initially: unsatisfied ACs produce an
 * advisory warning on the close outcome, but the close PROCEEDS (does not
 * refuse). This ships the authority surface without breaking the existing
 * close/merge corpus; the flip to BLOCK is a follow-up slice.
 *
 * Drives the REAL compiled writers against REAL .caws state in temp dirs.
 * Pins: dual-write (spec block + ac_recorded event), idempotent per
 * criterion_id, refuses on closed/unknown-ac/waived-without-reason (the record
 * op's own validation), and the close gate's warn-mode behavior.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  createSpec,
  recordSpecEvidence,
  closeSpec,
} = require('../../dist/store/specs-writer');
const { loadEvents } = require('../../dist/store/events-store');
const { initProject } = require('../../dist/store/init-store');

const ACTOR = { kind: 'agent', id: 'jest', platform: 'jest' };

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

function readSpec(caws, id) {
  return fs.readFileSync(path.join(caws, 'specs', `${id}.yaml`), 'utf8');
}

function seedActiveSpec(caws, id, acIds) {
  const acceptance = acIds
    .map((ac) => `  - id: ${ac}\n    given: 'g'\n    when: 'w'\n    then: 't'`)
    .join('\n');
  const r = createSpec(caws, { id, title: 'evidence fixture', mode: 'chore', riskTier: 3, actor: ACTOR });
  if (!r.ok || r.value.kind !== 'success') {
    throw new Error('seed spec failed: ' + JSON.stringify(r));
  }
  const specPath = path.join(caws, 'specs', `${id}.yaml`);
  let body = fs.readFileSync(specPath, 'utf8');
  body = body.replace(/acceptance:[\s\S]*?non_functional:/, `acceptance:\n${acceptance}\nnon_functional:`);
  fs.writeFileSync(specPath, body);
}

const FIXED_NOW = () => new Date('2026-08-07T20:00:00.000Z');

describe('recordSpecEvidence (CAWS-SPEC-AC-EVIDENCE-AUTHORITY-01)', () => {
  test('dual-writes: patches the spec evidence block AND appends an ac_recorded event', () => {
    const { root, caws } = mkRepo('ev-dual-');
    seedActiveSpec(caws, 'EV-DUAL-001', ['A1']);
    execFileSync('git', ['-C', root, 'add', '-A']);
    execFileSync('git', ['-C', root, 'commit', '--quiet', '--no-verify', '-m', 'seed']);

    const eventsBefore = loadEvents(caws);
    const countBefore = eventsBefore.ok ? eventsBefore.value.events.length : 0;

    const r = recordSpecEvidence(caws, {
      id: 'EV-DUAL-001',
      criterionId: 'A1',
      status: 'pass',
      evidenceRef: 'npm test',
      now: FIXED_NOW,
      actor: ACTOR,
    });

    expect(r.ok).toBe(true);
    const specBody = readSpec(caws, 'EV-DUAL-001');
    expect(specBody).toContain('evidence:');
    expect(specBody).toContain('criterion_id: A1');
    expect(specBody).toContain('status: pass');
    expect(specBody).toMatch(/evidence_ref:.*npm test/);
    const eventsAfter = loadEvents(caws);
    const countAfter = eventsAfter.ok ? eventsAfter.value.events.length : 0;
    expect(countAfter).toBe(countBefore + 1);
    const newEvent = eventsAfter.value.events[countAfter - 1];
    expect(newEvent.event).toBe('ac_recorded');
    expect(newEvent.data.criterion_id).toBe('A1');
    expect(newEvent.data.status).toBe('pass');
    expect(newEvent.data.evidence_ref).toBe('npm test');
  });

  test('idempotent per criterion_id: recording again UPSERTS, does not duplicate', () => {
    const { caws } = mkRepo('ev-idem-');
    seedActiveSpec(caws, 'EV-IDEM-001', ['A1']);
    const base = { id: 'EV-IDEM-001', criterionId: 'A1', now: FIXED_NOW, actor: ACTOR };
    recordSpecEvidence(caws, { ...base, status: 'fail', evidenceRef: 'first run' });
    recordSpecEvidence(caws, { ...base, status: 'pass', evidenceRef: 'second run' });

    const specBody = readSpec(caws, 'EV-IDEM-001');
    expect((specBody.match(/criterion_id: A1/g) || []).length).toBe(1);
    expect(specBody).toContain('status: pass');
    expect(specBody).toMatch(/evidence_ref:.*second run/);
  });

  test('refuses on a closed spec (lifecycle frozen)', () => {
    const { caws } = mkRepo('ev-closed-');
    seedActiveSpec(caws, 'EV-CLOSED-001', ['A1']);
    recordSpecEvidence(caws, {
      id: 'EV-CLOSED-001',
      criterionId: 'A1',
      status: 'pass',
      evidenceRef: 'npm test',
      now: FIXED_NOW,
      actor: ACTOR,
    });
    const closed = closeSpec(caws, { id: 'EV-CLOSED-001', reason: 'done', resolution: 'completed', now: FIXED_NOW, actor: ACTOR });
    expect(closed.ok).toBe(true);

    const r = recordSpecEvidence(caws, {
      id: 'EV-CLOSED-001',
      criterionId: 'A1',
      status: 'pass',
      evidenceRef: 'again',
      now: FIXED_NOW,
      actor: ACTOR,
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toMatch(/lifecycle_state "closed"/);
    expect(r.errors[0].message).toContain('frozen');
  });

  test('refuses an unknown criterion_id (not in acceptance[])', () => {
    const { caws } = mkRepo('ev-unknown-');
    seedActiveSpec(caws, 'EV-UNK-001', ['A1']);
    const r = recordSpecEvidence(caws, {
      id: 'EV-UNK-001',
      criterionId: 'A99',
      status: 'pass',
      evidenceRef: 'npm test',
      now: FIXED_NOW,
      actor: ACTOR,
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toContain('A99');
    expect(r.errors[0].message).toMatch(/not a declared acceptance criterion/);
  });

  test('refuses waived without waiver_reason', () => {
    const { caws } = mkRepo('ev-waiver-');
    seedActiveSpec(caws, 'EV-WAIV-001', ['A1']);
    const r = recordSpecEvidence(caws, {
      id: 'EV-WAIV-001',
      criterionId: 'A1',
      status: 'waived',
      now: FIXED_NOW,
      actor: ACTOR,
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toContain('waived');
    expect(r.errors[0].message).toContain('waiver-reason');
  });

  test('waived WITH waiver_reason is accepted and carries the reason on the spec block', () => {
    const { caws } = mkRepo('ev-waivok-');
    seedActiveSpec(caws, 'EV-WAIVOK-001', ['A1']);
    const r = recordSpecEvidence(caws, {
      id: 'EV-WAIVOK-001',
      criterionId: 'A1',
      status: 'waived',
      waiverReason: 'manual UI criterion; no automated test',
      now: FIXED_NOW,
      actor: ACTOR,
    });
    expect(r.ok).toBe(true);
    const specBody = readSpec(caws, 'EV-WAIVOK-001');
    expect(specBody).toContain('waiver_reason');
    expect(specBody).toContain('manual UI criterion');
  });
});

describe('AC-evidence-completeness close gate — WARN MODE (CAWS-SPEC-AC-EVIDENCE-AUTHORITY-01)', () => {
  // WARN-MODE: the gate records unsatisfied ACs as an advisory on the close
  // outcome but does NOT refuse (the close proceeds). This ships the authority
  // surface without breaking the existing close/merge corpus; the flip to BLOCK
  // is a follow-up slice. These tests pin the warn-mode contract: unsatisfied
  // ACs produce a warning on a SUCCESSFUL close; satisfied ACs close cleanly.

  test('close PROCEEDS with a warning when a declared AC has no evidence', () => {
    const { caws } = mkRepo('close-nov-');
    seedActiveSpec(caws, 'CLOSE-NOV-001', ['A1', 'A2']);
    const r = closeSpec(caws, { id: 'CLOSE-NOV-001', reason: 'done', resolution: 'completed', now: FIXED_NOW, actor: ACTOR });
    expect(r.ok).toBe(true);
    const warnings = (r.value.kind === 'success' && r.value.warnings) || [];
    expect(warnings.join('\n')).toMatch(/acceptance criterion/);
    expect(warnings.join('\n')).toContain('A1');
    expect(warnings.join('\n')).toContain('A2');
    expect(warnings.join('\n')).toContain('caws specs evidence');
  });

  test('close PROCEEDS with a warning naming only the unevidenced AC (not the satisfied one)', () => {
    const { caws } = mkRepo('close-partial-');
    seedActiveSpec(caws, 'CLOSE-PART-001', ['A1', 'A2']);
    recordSpecEvidence(caws, {
      id: 'CLOSE-PART-001', criterionId: 'A1', status: 'pass', evidenceRef: 'npm test', now: FIXED_NOW, actor: ACTOR,
    });
    const r = closeSpec(caws, { id: 'CLOSE-PART-001', reason: 'done', resolution: 'completed', now: FIXED_NOW, actor: ACTOR });
    expect(r.ok).toBe(true);
    const warnings = (r.value.kind === 'success' && r.value.warnings) || [];
    expect(warnings.join('\n')).toContain('A2');
    expect(warnings.join('\n')).not.toMatch(/A1: no evidence/);
  });

  test('close ADMITS CLEANLY (no warning) when every AC has pass evidence', () => {
    const { caws } = mkRepo('close-pass-');
    seedActiveSpec(caws, 'CLOSE-PASS-001', ['A1', 'A2']);
    const base = { id: 'CLOSE-PASS-001', status: 'pass', evidenceRef: 'npm test', now: FIXED_NOW, actor: ACTOR };
    recordSpecEvidence(caws, { ...base, criterionId: 'A1' });
    recordSpecEvidence(caws, { ...base, criterionId: 'A2' });
    const r = closeSpec(caws, { id: 'CLOSE-PASS-001', reason: 'all ACs evidenced', resolution: 'completed', now: FIXED_NOW, actor: ACTOR });
    expect(r.ok).toBe(true);
    const warnings = (r.value.kind === 'success' && r.value.warnings) || [];
    expect(warnings.length).toBe(0);
  });

  test('close ADMITS CLEANLY (no warning) when unsatisfied ACs are waived with a reason', () => {
    const { caws } = mkRepo('close-waiv-');
    seedActiveSpec(caws, 'CLOSE-WAIV-001', ['A1', 'A2']);
    recordSpecEvidence(caws, {
      id: 'CLOSE-WAIV-001', criterionId: 'A1', status: 'pass', evidenceRef: 'npm test', now: FIXED_NOW, actor: ACTOR,
    });
    recordSpecEvidence(caws, {
      id: 'CLOSE-WAIV-001', criterionId: 'A2', status: 'waived', waiverReason: 'no automated test; manually verified', now: FIXED_NOW, actor: ACTOR,
    });
    const r = closeSpec(caws, { id: 'CLOSE-WAIV-001', reason: 'A1 evidenced; A2 waived', resolution: 'completed', now: FIXED_NOW, actor: ACTOR });
    expect(r.ok).toBe(true);
    const warnings = (r.value.kind === 'success' && r.value.warnings) || [];
    expect(warnings.length).toBe(0);
  });

  test('close PROCEEDS with a warning when an AC has fail evidence (fail does not satisfy closure)', () => {
    const { caws } = mkRepo('close-fail-');
    seedActiveSpec(caws, 'CLOSE-FAIL-001', ['A1']);
    recordSpecEvidence(caws, {
      id: 'CLOSE-FAIL-001', criterionId: 'A1', status: 'fail', evidenceRef: 'npm test', now: FIXED_NOW, actor: ACTOR,
    });
    const r = closeSpec(caws, { id: 'CLOSE-FAIL-001', reason: 'done', resolution: 'completed', now: FIXED_NOW, actor: ACTOR });
    expect(r.ok).toBe(true);
    const warnings = (r.value.kind === 'success' && r.value.warnings) || [];
    expect(warnings.join('\n')).toContain('A1');
    expect(warnings.join('\n')).toContain('fail');
  });
});
