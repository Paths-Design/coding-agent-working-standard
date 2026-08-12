'use strict';

/**
 * --acceptance parses at label boundaries, not at every semicolon
 * (CAWS-DEFECT-SPECS-CREATE-AUTHORING-01, Sterling ledger N14).
 *
 * The defect this suite pins: parseStructuredAcceptance split the value on
 * EVERY ';', then required Object.keys(labeled).length === parts.length. A
 * clause whose own prose contains a semicolon therefore produced an unlabeled
 * fourth fragment and was refused — with a message asserting the fields were
 * missing when all three were present and correctly labeled. Measured in
 * Sterling: 4 refusals across 2 specs in one session, each worked around by
 * rephrasing to avoid punctuation.
 *
 * The fix splits at the given:/when:/then: label anchors, so a semicolon inside
 * a clause body is ordinary prose.
 */

const fs = require('fs');
const path = require('path');

const { runSpecsCreateCommand } = require('../../dist/shell/commands/specs');
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

function runCreate(root, id, opts = {}) {
  const out = [];
  const err = [];
  const code = runSpecsCreateCommand({
    cwd: root,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'specs-create-semicolon-test' },
    id,
    title: 'semicolon fixture',
    mode: 'chore',
    riskTier: '3',
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => new Date('2026-08-12T00:00:00.000Z'),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function readSpec(cawsDir, id) {
  const p = path.join(cawsDir, 'specs', `${id}.yaml`);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

describe('caws specs create --acceptance: clause-internal semicolons are prose', () => {
  test('a semicolon inside the then: clause is preserved, not treated as a separator', () => {
    const { root, cawsDir } = mkRepo();

    // This is the exact shape that failed in Sterling: three labels, all
    // present, with the then: body carrying its own semicolon.
    const result = runCreate(root, 'SEMI-001', {
      acceptance: [
        'given: the 13 classes holding ROUTE_NOT_ADJUDICATED at slice start; ' +
          'when: the slice closes; ' +
          'then: zero classes hold ROUTE_NOT_ADJUDICATED, each carrying its governing decision; mutation kill required',
      ],
    });

    expect(result.code).toBe(0);
    const spec = readSpec(cawsDir, 'SEMI-001');
    expect(spec).toContain('given: ');
    // HEADLINE: the clause-internal semicolon survives inside the then: text.
    expect(spec).toContain('mutation kill required');
    expect(spec).toContain('each carrying its governing decision; mutation kill required');
    // And the given/when clauses are not polluted by the trailing fragment.
    expect(spec).toContain('the 13 classes holding ROUTE_NOT_ADJUDICATED at slice start');
    expect(spec).toContain('the slice closes');
  });

  test('semicolons in the given: and when: clauses parse too', () => {
    const { root, cawsDir } = mkRepo();

    const result = runCreate(root, 'SEMI-002', {
      acceptance: [
        'given: a spec exists; it is active; ' +
          'when: the gate runs; the policy is loaded; ' +
          'then: the disposition is PASS',
      ],
    });

    expect(result.code).toBe(0);
    const spec = readSpec(cawsDir, 'SEMI-002');
    expect(spec).toContain('a spec exists; it is active');
    expect(spec).toContain('the gate runs; the policy is loaded');
    expect(spec).toContain('the disposition is PASS');
  });

  test('a trailing semicolon after the last clause is tolerated', () => {
    const { root, cawsDir } = mkRepo();

    const result = runCreate(root, 'SEMI-003', {
      acceptance: ['given: a; when: b; then: c;'],
    });

    expect(result.code).toBe(0);
    const spec = readSpec(cawsDir, 'SEMI-003');
    expect(spec).toMatch(/then:\s*'?c'?/);
  });

  test('labels are matched case-insensitively, as before the fix', () => {
    const { root, cawsDir } = mkRepo();

    const result = runCreate(root, 'SEMI-004', {
      acceptance: ['Given: alpha; When: beta; Then: gamma'],
    });

    expect(result.code).toBe(0);
    const spec = readSpec(cawsDir, 'SEMI-004');
    expect(spec).toContain('alpha');
    expect(spec).toContain('beta');
    expect(spec).toContain('gamma');
  });
});

describe('genuinely malformed structured values are still refused', () => {
  // The fix widens what parses. It must not stop rejecting real malformations,
  // or a typo'd label silently becomes free-text prose in the then: field.
  test('a value with given: and then: but no when: is refused', () => {
    const { root, cawsDir } = mkRepo();

    const result = runCreate(root, 'SEMI-101', {
      acceptance: ['given: something; then: another thing'],
    });

    expect(result.code).not.toBe(0);
    expect(result.err).toContain('--acceptance');
    expect(readSpec(cawsDir, 'SEMI-101')).toBeNull();
  });

  test('a label with an empty body is refused', () => {
    const { root, cawsDir } = mkRepo();

    const result = runCreate(root, 'SEMI-102', {
      acceptance: ['given: a; when: ; then: c'],
    });

    expect(result.code).not.toBe(0);
    expect(readSpec(cawsDir, 'SEMI-102')).toBeNull();
  });

  test('plain free text with no labels still becomes the then: field', () => {
    const { root, cawsDir } = mkRepo();

    const result = runCreate(root, 'SEMI-103', {
      acceptance: ['the refusal corridor emits a typed decision; no bare strings remain'],
    });

    expect(result.code).toBe(0);
    const spec = readSpec(cawsDir, 'SEMI-103');
    // Free text keeps its semicolon and lands whole in then:.
    expect(spec).toContain('the refusal corridor emits a typed decision; no bare strings remain');
    expect(spec).toContain('The spec implementation is complete.');
  });
});
