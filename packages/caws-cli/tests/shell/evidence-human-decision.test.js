'use strict';

/**
 * HUMAN-DECISION-EVIDENCE-001 contract tests.
 *
 * A1: `caws evidence record --type human_decision` appends a
 *     human_decision_recorded event (exit 0, seq + hash printed, chain valid).
 * A2: `caws evidence schema --type human_decision` prints the payload schema:
 *     required decision/decision_class, the closed decision_class enum, and a
 *     runnable example.
 * A3: `caws evidence list --spec <id> --type human_decision` filters to the new
 *     kind (excludes test/gate); an invalid --type is refused naming the full
 *     test|gate|ac|human_decision set.
 * A4: schema-first: a malformed payload (missing decision, out-of-enum
 *     decision_class, or an unknown top-level field) is rejected by append.
 * A5: existing evidence kinds still validate (test_recorded still appends).
 *
 * Runs the real command surfaces against on-disk git+caws repos, injected
 * sinks (same pattern as evidence-record-ac-redirect.test.js).
 */

const path = require('path');

const {
  runEvidenceRecordCommand,
  runEvidenceListCommand,
  runEvidenceSchemaCommand,
} = require('../../dist/shell/commands/evidence');
const { verifyChain } = require('../../dist/kernel');
const { loadEvents } = require('../../dist/store/events-store');
const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  return { root, cawsDir: path.join(root, '.caws') };
}

function runRecord(root, opts) {
  const out = [];
  const err = [];
  const code = runEvidenceRecordCommand({
    cwd: root,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'human-decision-test' },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => new Date('2026-08-25T12:00:00.000Z'),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function runList(root, opts) {
  const out = [];
  const err = [];
  const code = runEvidenceListCommand({
    cwd: root,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function runSchema(root, opts) {
  const out = [];
  const err = [];
  const code = runEvidenceSchemaCommand({
    cwd: root,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function lastEvent(cawsDir) {
  const loaded = loadEvents(cawsDir);
  if (!loaded.ok) throw new Error('loadEvents failed: ' + loaded.errors.map((e) => e.message).join('; '));
  const verified = verifyChain(loaded.value.events);
  if (!verified.ok) throw new Error('verifyChain failed after append');
  return loaded.value.events[loaded.value.events.length - 1];
}

describe('HUMAN-DECISION-EVIDENCE-001', () => {
  test('A1: record human_decision appends human_decision_recorded (chain-valid)', () => {
    const { root, cawsDir } = mkRepo();
    const r = runRecord(root, {
      kind: 'human_decision',
      specId: 'FEAT-43',
      data: { decision: 'approve-approach', decision_class: 'approval' },
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('recorded human_decision_recorded');
    expect(r.out).toContain('spec=');

    const ev = lastEvent(cawsDir);
    expect(ev.event).toBe('human_decision_recorded');
    expect(ev.spec_id).toBe('FEAT-43');
    expect(ev.data.decision).toBe('approve-approach');
    expect(ev.data.decision_class).toBe('approval');
  });

  test('A2: evidence schema prints required fields, enum, and a runnable example', () => {
    const { root } = mkRepo();
    const r = runSchema(root, { kind: 'human_decision' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('decision');
    expect(r.out).toContain('decision_class');
    expect(r.out).toContain('approval');
    expect(r.out).toContain('caws evidence record --type human_decision');
  });

  test('A3: list filters to human_decision only; invalid type names the full set', () => {
    const { root, cawsDir } = mkRepo();
    expect(
      runRecord(root, { kind: 'human_decision', specId: 'FEAT-44', data: { decision: 'd', decision_class: 'direction' } }).code
    ).toBe(0);
    expect(
      runRecord(root, { kind: 'test', specId: 'FEAT-44', data: { command: 'npm test', exit_code: 0 } }).code
    ).toBe(0);

    const listed = runList(root, { specId: 'FEAT-44', kind: 'human_decision' });
    expect(listed.code).toBe(0);
    expect(listed.out).toContain('1 event(s)');
    expect(listed.out).toContain('human_decision');

    const invalid = runList(root, { specId: 'FEAT-44', kind: 'bogus' });
    expect(invalid.code).toBe(1);
    expect(invalid.err).toContain('expected test|gate|ac|human_decision');
    expect(cawsDir).toBeTruthy();
  });

  test('A4: schema-first — malformed payloads are rejected by append', () => {
    const { root } = mkRepo();
    // Missing required `decision`.
    expect(
      runRecord(root, { kind: 'human_decision', specId: 'FEAT-45', data: { decision_class: 'approval' } }).code
    ).toBe(1);
    // decision_class outside the closed enum.
    expect(
      runRecord(root, { kind: 'human_decision', specId: 'FEAT-45', data: { decision: 'x', decision_class: 'maybe' } }).code
    ).toBe(1);
    // Unknown top-level field (additionalProperties: false).
    expect(
      runRecord(root, { kind: 'human_decision', specId: 'FEAT-45', data: { decision: 'x', decision_class: 'approval', extra: 1 } }).code
    ).toBe(1);
  });

  test('A5: existing evidence kinds still validate (test_recorded appends)', () => {
    const { root } = mkRepo();
    const r = runRecord(root, { kind: 'test', specId: 'FEAT-46', data: { command: 'npm test', exit_code: 0 } });
    expect(r.code).toBe(0);
    expect(r.out).toContain('recorded test_recorded');
  });
});
