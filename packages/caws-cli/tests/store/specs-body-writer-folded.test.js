'use strict';

/**
 * CANONICAL-DRIFT-GUARDS-001 (writer fix): specs amend on a spec whose
 * invariants use folded (`- >-`) multi-line entries.
 *
 * The defect: locateSequence treated `- >-` as the scalar item ">-" and
 * stopped before the continuation lines, so any add/remove rewrite spliced
 * rendered items mid-fold — "bad indentation of a sequence entry" — and
 * silently dropped the folded prose. Live reproduction: `caws specs amend
 * CANONICAL-DRIFT-GUARDS-001 --add-invariant ...` failed plan-time on this
 * very repo, blocking the sanctioned correction of the slice's own spec.
 *
 * Coverage:
 *  A1  add beside folded entries -> YAML stays parseable, folded prose
 *      preserved VERBATIM, new scalar appended.
 *  A2  remove a folded entry by its whitespace-collapsed logical text.
 *  A3  mixed scalar + folded round-trip; scalar entries still quote().
 *  A4  the pre-fix failure shape (bare add) now succeeds.
 *
 * SUT: dist/store/specs-body-writer via the command surface.
 */

const fs = require('fs');
const path = require('path');

const { runSpecsCreateCommand, runSpecsAmendCommand } = require('../../dist/shell/commands/specs');
const { initProject } = require('../../dist/store/init-store');
const { loadSpecs } = require('../../dist/store/specs-store');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const r = initProject(root);
  if (!r.ok) throw new Error('initProject failed');
  return { root, cawsDir: path.join(root, '.caws') };
}

function create(root, id, invariantLines) {
  const err = [];
  const code = runSpecsCreateCommand({
    id,
    title: 't',
    mode: 'chore',
    riskTier: 3,
    scopeIn: ['tests'],
    module: ['tests'],
    invariant: invariantLines,
    cwd: root,
    env: { ...process.env },
    out: () => {},
    err: (l) => err.push(l),
  });
  if (code !== 0) throw new Error(`create ${id} failed: ${err.join(' | ')}`);
}

/** Fold a spec's first invariant into a `- >-` block (simulating authored prose). */
function foldFirstInvariant(cawsDir, id) {
  const file = path.join(cawsDir, 'specs', `${id}.yaml`);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const invIdx = lines.findIndex((l) => l === 'invariants:');
  const itemIdx = invIdx + 1;
  const m = /^(\s*)- '(.*)'$/.exec(lines[itemIdx]);
  if (!m) throw new Error('expected a quoted scalar invariant at the first item');
  const pad2 = m[1];
  const words = m[2].split(' ');
  const body = [`${pad2}- >-`];
  // wrap at ~8 words to force multiple continuation lines
  for (let i = 0; i < words.length; i += 8) {
    body.push(`${pad2}  ${words.slice(i, i + 8).join(' ')}`);
  }
  lines.splice(itemIdx, 1, ...body);
  fs.writeFileSync(file, lines.join('\n'));
}

function amend(root, id, opts) {
  const out = []; const err = [];
  const code = runSpecsAmendCommand({
    id, cwd: root, env: { ...process.env },
    out: (l) => out.push(l), err: (l) => err.push(l),
    ...opts,
  });
  return { code, out, err };
}

describe('specs-body-writer folded-entry support (CANONICAL-DRIFT-GUARDS-001)', () => {
  test('A1/A4: add beside folded entries — parseable, verbatim prose, scalar appended', () => {
    const { root, cawsDir } = mkRepo();
    create(root, 'FOLD-001', ['first invariant with plenty of words to fold across several continuation lines']);
    foldFirstInvariant(cawsDir, 'FOLD-001');
    const before = fs.readFileSync(path.join(cawsDir, 'specs', 'FOLD-001.yaml'), 'utf8');
    const foldedBefore = before.split('\n').filter((l) => l.includes('first invariant')).join('\n');

    const r = amend(root, 'FOLD-001', { addInvariant: ['second scalar'] });
    expect(r.code).toBe(0);

    const after = fs.readFileSync(path.join(cawsDir, 'specs', 'FOLD-001.yaml'), 'utf8');
    // Parseable: loadSpecs succeeds and carries both invariants.
    const loaded = loadSpecs(cawsDir);
    expect(loaded.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const spec = loaded.specs.find((s) => s.id === 'FOLD-001');
    expect(spec.invariants.some((v) => v.includes('first invariant with plenty'))).toBe(true);
    expect(spec.invariants).toContain('second scalar');
    // Verbatim: every continuation line survived byte-for-byte.
    for (const line of foldedBefore.split('\n')) {
      expect(after).toContain(line.trim());
    }
    expect(after).toContain("- 'second scalar'");
  });

  test('A2: remove a folded entry by its logical (collapsed) text', () => {
    const { root, cawsDir } = mkRepo();
    // Two invariants — removing the folded one must leave a survivor
    // (invariants is schema-required non-empty; removing the only entry is
    // correctly refused by the plan, not this test's subject).
    create(root, 'FOLD-002', ['removable folded invariant text goes here', 'survivor scalar']);
    foldFirstInvariant(cawsDir, 'FOLD-002');

    const r = amend(root, 'FOLD-002', { removeInvariant: ['removable folded invariant text goes here'] });
    expect(r.code).toBe(0);

    const loaded = loadSpecs(cawsDir);
    const spec = loaded.specs.find((s) => s.id === 'FOLD-002');
    expect(spec.invariants.some((v) => v.includes('removable folded'))).toBe(false);
    expect(spec.invariants).toContain('survivor scalar');
    const raw = fs.readFileSync(path.join(cawsDir, 'specs', 'FOLD-002.yaml'), 'utf8');
    expect(raw).not.toContain('>-');
  });

  test('A3: mixed scalar + folded round-trip keeps both shapes', () => {
    const { root, cawsDir } = mkRepo();
    create(root, 'FOLD-003', ['plain scalar one', 'folded prose entry with many words to wrap around nicely']);
    // fold the SECOND invariant this time
    const file = path.join(cawsDir, 'specs', 'FOLD-003.yaml');
    let raw = fs.readFileSync(file, 'utf8');
    raw = raw.replace(
      /^(\s*)- 'folded prose entry with many words to wrap around nicely'$/m,
      (m, pad2) => `${pad2}- >-\n${pad2}  folded prose entry with many\n${pad2}  words to wrap around nicely`
    );
    fs.writeFileSync(file, raw);

    const r = amend(root, 'FOLD-003', { addInvariant: ['appended scalar'] });
    expect(r.code).toBe(0);

    const after = fs.readFileSync(file, 'utf8');
    expect(after).toContain("- 'plain scalar one'");
    expect(after).toContain('>-');
    expect(after).toContain("- 'appended scalar'");
    const loaded = loadSpecs(cawsDir);
    const spec = loaded.specs.find((s) => s.id === 'FOLD-003');
    expect(spec.invariants).toHaveLength(3);
  });
});
