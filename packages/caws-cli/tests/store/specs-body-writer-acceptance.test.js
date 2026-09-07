'use strict';

/**
 * `caws specs amend` acceptance-criteria amendment (CAWS-SPEC-AMEND-ACCEPTANCE-001).
 *
 * The scenario this closes: agents fixing a wrong AC on an existing spec had no
 * governed verb, so they encoded the correction as an invariant or spun a
 * successor spec — ceremony the command surface was supposed to absorb. The
 * load-bearing rule is the evidence coupling: a recorded status proved the
 * TEXT THAT EXISTED when it was recorded, so rewriting a criterion's text must
 * reset that criterion's evidence entry to unchecked IN THE SAME TRANSACTION
 * (and removing a criterion deletes its entry outright — an orphaned
 * criterion_id is rejected by semantic validation).
 *
 * Coverage map to the governing spec:
 *  A1  set-ac: exact-field rewrite, sibling byte-preservation, evidence reset,
 *      set_acceptance + reset_evidence (with previous_status) + reason on ONE
 *      spec_body_amended event.
 *  A2  add-ac: full-criterion append, added_acceptance in full; add-ac refuses
 *      an existing id.
 *  A3  remove-ac: criterion + evidence deleted together, removed_acceptance +
 *      removed_evidence; last-remaining-criterion refusal.
 *  A4  closed specs: substantive rewrite refused (reopen pointer); the full
 *      scaffold discharge fills all three fields and records the acceptance
 *      discharge; the discharge refuses over recorded evidence.
 *  A5  one transaction per accepted amend; kernel-schema-valid event
 *      (a schema breach surfaces as partial_failure_recovered, i.e. exit 1);
 *      the write auto-commits.
 *
 * SUT: compiled writer via the shell command surface (dist/), so every test
 * exercises the same path the CLI takes, evidence recording and close included.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { initProject } = require('../../dist/store/init-store');
const { loadSpecs } = require('../../dist/store/specs-store');
const {
  runSpecsAmendCommand,
  runSpecsEvidenceCommand,
  runSpecsCloseCommand,
  runSpecsActivateCommand,
} = require('../../dist/shell/commands/specs');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const NOW = () => new Date('2026-08-12T12:00:00.000Z');
const NOW_ISO = '2026-08-12T12:00:00.000Z';

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const r = initProject(root);
  if (!r.ok) throw new Error('initProject failed');
  return { root, cawsDir: path.join(root, '.caws') };
}

function specYaml(id, { state = 'draft', acs, closed = false } = {}) {
  const acceptance =
    acs !== undefined && acs.length > 0
      ? acs
          .map(
            (a) => `  - id: ${a.id}
    given: '${String(a.given).replace(/'/g, "''")}'
    when: '${String(a.when).replace(/'/g, "''")}'
    then: '${String(a.then).replace(/'/g, "''")}'`
          )
          .join('\n')
      : `  - id: A1
    given: 'TODO'
    when: 'TODO'
    then: 'TODO'`;
  return `id: ${id}
title: '${id}'
risk_tier: 3
mode: chore
lifecycle_state: ${state}
${closed ? `resolution: completed\nclosure_notes: 'done'\n` : ''}created_at: '2026-07-30T00:00:00.000Z'
updated_at: '2026-07-30T00:00:00.000Z'
blast_radius:
  modules:
    - 'tests'
  data_migration: false
operational_rollback_slo: 5m
scope:
  in:
    - tests
  out: []
invariants:
  - 'first invariant'
acceptance:
${acceptance}
non_functional: {}
contracts: []
`;

}

function writeSpec(cawsDir, id, opts) {
  const specPath = path.join(cawsDir, 'specs', `${id}.yaml`);
  fs.writeFileSync(specPath, specYaml(id, opts));
  return specPath;
}

function amend(root, id, opts = {}) {
  const out = [];
  const err = [];
  const code = runSpecsAmendCommand({
    id,
    cwd: root,
    now: NOW,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'test-session' },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function recordEvidence(root, id, ac, status, extra = {}) {
  const out = [];
  const err = [];
  const code = runSpecsEvidenceCommand({
    id,
    ac,
    status,
    cwd: root,
    now: NOW,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'test-session' },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...extra,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function activateSpec(root, id) {
  const out = [];
  const err = [];
  const code = runSpecsActivateCommand({
    id,
    cwd: root,
    now: NOW,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'test-session' },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function closeSpec(root, id) {
  const out = [];
  const err = [];
  const code = runSpecsCloseCommand({
    id,
    resolution: 'completed',
    closureNotes: 'test closure',
    cwd: root,
    now: NOW,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'test-session' },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** The governed route to a closed spec: draft -> activate -> close. */
function closeThroughLifecycle(root, id) {
  expect(activateSpec(root, id).code).toBe(0);
  const r = closeSpec(root, id);
  expect(r.code).toBe(0);
}

function readRaw(cawsDir, id) {
  return fs.readFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), 'utf8');
}

function readEvents(cawsDir) {
  const p = path.join(cawsDir, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

function amendedEvents(cawsDir) {
  return readEvents(cawsDir).filter((e) => e.event === 'spec_body_amended');
}

/** Extract the raw acceptance block (from the `acceptance:` key to the next top-level key). */
function acceptanceBlock(raw) {
  const start = raw.indexOf('acceptance:');
  const end = raw.indexOf('non_functional:', start);
  return raw.slice(start, end);
}

function loadCleanSpec(cawsDir, id) {
  const loaded = loadSpecs(cawsDir);
  expect(loaded.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return loaded.specs.find((s) => s.id === id);
}

const TWO_ACS = [
  { id: 'A1', given: 'the parser rejects an orphan evidence entry', when: 'a criterion is removed', then: 'its evidence entry is removed with it' },
  { id: 'A2', given: 'fixture given two', when: 'fixture when two', then: 'fixture then two' },
];

describe('A1: --set-ac rewrites exactly the supplied fields and resets the criterion evidence', () => {
  test('field rewrite + evidence reset + set_acceptance/reset_evidence/reason on one event', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'ACC-001', { acs: TWO_ACS });
    const ev = recordEvidence(root, 'ACC-001', 'A1', 'pass', {
      evidenceRef: 'npm test',
      command: 'npm test',
      exitCode: 0,
    });
    expect(ev.code).toBe(0);
    const before = readRaw(cawsDir, 'ACC-001');

    const r = amend(root, 'ACC-001', {
      setAc: 'A1',
      then: 'the evidence entry is deleted in the same transaction',
      reason: 'the original then described the old design',
    });
    expect(r.code).toBe(0);

    const after = readRaw(cawsDir, 'ACC-001');
    // The supplied field is rewritten inline.
    expect(after).toContain("    then: 'the evidence entry is deleted in the same transaction'");
    // Unsupplied fields of A1 are byte-preserved.
    expect(after).toContain("    given: 'the parser rejects an orphan evidence entry'");
    expect(after).toContain("    when: 'a criterion is removed'");
    // The sibling criterion is byte-preserved.
    const slice = (raw) => raw.slice(raw.indexOf('  - id: A2'), raw.indexOf('non_functional:'));
    expect(slice(after)).toBe(slice(before));

    // Parsed evidence: reset to unchecked, recorded_at freshened, and the old
    // claim's proof fields (evidence_ref/command/exit_code) GONE.
    const spec = loadCleanSpec(cawsDir, 'ACC-001');
    expect(spec.evidence).toEqual([
      { criterion_id: 'A1', status: 'unchecked', recorded_at: NOW_ISO },
    ]);
    // Byte-level proof the old evidence_ref is gone (the parsed check above
    // could pass with the old ref stranded in a malformed extra key).
    expect(after).not.toContain('npm test');

    // Exactly one event, carrying the whole story.
    const events = amendedEvents(cawsDir);
    expect(events).toHaveLength(1);
    expect(events[0].data.set_acceptance).toEqual([{ id: 'A1', fields: ['then'] }]);
    expect(events[0].data.reset_evidence).toEqual([{ criterion_id: 'A1', previous_status: 'pass' }]);
    expect(events[0].data.reason).toBe('the original then described the old design');
    expect(events[0].data.previous_lifecycle_state).toBe('draft');
  });

  test('re-supplying identical text is refused (no change) and does not reset evidence', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'ACC-002', { acs: TWO_ACS });
    expect(recordEvidence(root, 'ACC-002', 'A1', 'pass', { evidenceRef: 'npm test' }).code).toBe(0);
    const before = readRaw(cawsDir, 'ACC-002');
    const eventsBefore = amendedEvents(cawsDir).length;

    const r = amend(root, 'ACC-002', {
      setAc: 'A1',
      when: 'a criterion is removed',
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('No change');
    // Bytes identical, evidence still pass, no event appended.
    expect(readRaw(cawsDir, 'ACC-002')).toBe(before);
    const spec = loadCleanSpec(cawsDir, 'ACC-002');
    expect(spec.evidence[0].status).toBe('pass');
    expect(amendedEvents(cawsDir)).toHaveLength(eventsBefore);
  });
});

describe('A2: --add-ac appends a criterion; A3: --remove-ac deletes criterion + evidence together', () => {
  test('add-ac appends the full criterion and the new id immediately accepts evidence', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'ACC-003', { acs: TWO_ACS });

    const r = amend(root, 'ACC-003', {
      addAc: 'A3',
      given: 'a new claim',
      when: 'the command runs',
      then: 'the criterion is declared and auditable',
    });
    expect(r.code).toBe(0);

    const raw = readRaw(cawsDir, 'ACC-003');
    expect(raw).toContain("  - id: A3\n    given: 'a new claim'");
    const spec = loadCleanSpec(cawsDir, 'ACC-003');
    expect(spec.acceptance.map((a) => a.id)).toEqual(['A1', 'A2', 'A3']);
    expect(spec.acceptance[2]).toEqual({
      id: 'A3',
      given: 'a new claim',
      when: 'the command runs',
      then: 'the criterion is declared and auditable',
    });
    const events = amendedEvents(cawsDir);
    expect(events).toHaveLength(1);
    expect(events[0].data.added_acceptance).toEqual([
      { id: 'A3', given: 'a new claim', when: 'the command runs', then: 'the criterion is declared and auditable' },
    ]);
    // The new id is a declared criterion: evidence recording succeeds (the
    // orphan rule would refuse evidence against an undeclared id).
    expect(recordEvidence(root, 'ACC-003', 'A3', 'pass', { evidenceRef: 'probe' }).code).toBe(0);
  });

  test('remove-ac deletes the criterion AND its evidence entry; event carries both, in full', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'ACC-004', { acs: TWO_ACS });
    expect(recordEvidence(root, 'ACC-004', 'A1', 'pass', { evidenceRef: 'npm test' }).code).toBe(0);

    const r = amend(root, 'ACC-004', { removeAc: 'A1' });
    expect(r.code).toBe(0);

    const raw = readRaw(cawsDir, 'ACC-004');
    expect(raw).not.toContain('id: A1');
    // Removing the ONLY entry normalizes the block to the flow empty
    // sequence — a bare `evidence:` key would parse as null and fail
    // document revalidation ("Expected array.").
    expect(raw).toContain('evidence: []');
    const spec = loadCleanSpec(cawsDir, 'ACC-004');
    expect(spec.acceptance.map((a) => a.id)).toEqual(['A2']);
    // No orphaned evidence: A1's entry is gone, A2 (unevidenced) has none.
    expect(spec.evidence).toEqual([]);
    const events = amendedEvents(cawsDir);
    expect(events).toHaveLength(1);
    expect(events[0].data.removed_acceptance).toEqual([TWO_ACS[0]]);
    expect(events[0].data.removed_evidence).toEqual([{ criterion_id: 'A1', previous_status: 'pass' }]);
  });

  test('removing the last remaining criterion is refused (schema minItems 1)', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'ACC-005', {
      acs: [{ id: 'A1', given: 'only', when: 'one', then: 'criterion' }],
    });
    const before = readRaw(cawsDir, 'ACC-005');

    const r = amend(root, 'ACC-005', { removeAc: 'A1' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('only acceptance criterion');
    expect(readRaw(cawsDir, 'ACC-005')).toBe(before);
    expect(amendedEvents(cawsDir)).toHaveLength(0);
  });
});

describe('hostile paths: every refusal writes nothing', () => {
  const refusals = [
    {
      name: '--set-ac on an unknown id points at --add-ac',
      opts: { setAc: 'A9', then: 'x' },
      message: 'No criterion A9',
      also: 'Declare it first with --add-ac A9',
    },
    {
      name: '--add-ac on an existing id points at --set-ac',
      opts: { addAc: 'A1', given: 'g', when: 'w', then: 't' },
      message: 'already exists',
      also: 'Rewrite it with --set-ac A1',
    },
    {
      name: 'two AC ops in one invocation are mutually exclusive',
      opts: { setAc: 'A1', removeAc: 'A2', then: 'x' },
      message: 'mutually exclusive',
    },
    {
      name: 'bare --given/--when/--then without a target is refused',
      opts: { given: 'g' },
      message: 'require an acceptance target',
    },
    {
      name: '--set-ac without any field flag is refused',
      opts: { setAc: 'A1' },
      message: 'needs at least one of --given/--when/--then',
    },
    {
      name: '--add-ac with only some fields is refused',
      opts: { addAc: 'A3', given: 'g', when: 'w' },
      message: 'needs all three of --given/--when/--then',
    },
    {
      name: 'an id outside ^A\\d+$ is refused',
      opts: { setAc: 'B1', then: 'x' },
      message: 'must match A<digits>',
    },
    {
      name: 'an empty field value is refused',
      opts: { setAc: 'A1', then: '   ' },
      message: 'must be non-empty',
    },
  ];

  for (const refusal of refusals) {
    test(refusal.name, () => {
      const { root, cawsDir } = mkRepo();
      writeSpec(cawsDir, 'REF-001', { acs: TWO_ACS });
      const before = readRaw(cawsDir, 'REF-001');

      const r = amend(root, 'REF-001', refusal.opts);
      expect(r.code).toBe(1);
      expect(r.err).toContain(refusal.message);
      if (refusal.also !== undefined) expect(r.err).toContain(refusal.also);
      // The load-bearing assertion: bytes AND event stream untouched.
      expect(readRaw(cawsDir, 'REF-001')).toBe(before);
      expect(amendedEvents(cawsDir)).toHaveLength(0);
    });
  }
});

describe('A4: closed specs — rewrite refused, scaffold discharge narrow', () => {
  test('rewriting substantive AC text on a closed spec is refused with the reopen pointer', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'ACC-006', { state: 'closed', closed: true, acs: TWO_ACS });
    const before = readRaw(cawsDir, 'ACC-006');

    const r = amend(root, 'ACC-006', { setAc: 'A1', then: 'retroactive edit' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('is closed');
    expect(r.err).toContain('caws specs reopen ACC-006');
    expect(readRaw(cawsDir, 'ACC-006')).toBe(before);
    expect(amendedEvents(cawsDir)).toHaveLength(0);
  });

  test('add-ac and remove-ac on a closed spec are refused outright', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'ACC-007', { state: 'closed', closed: true, acs: TWO_ACS });
    const before = readRaw(cawsDir, 'ACC-007');

    const add = amend(root, 'ACC-007', { addAc: 'A3', given: 'g', when: 'w', then: 't' });
    expect(add.code).toBe(1);
    expect(add.err).toContain('rewrites the concluded record');
    const remove = amend(root, 'ACC-007', { removeAc: 'A2' });
    expect(remove.code).toBe(1);
    expect(remove.err).toContain('rewrites the concluded record');
    expect(readRaw(cawsDir, 'ACC-007')).toBe(before);
    expect(amendedEvents(cawsDir)).toHaveLength(0);
  });

  test('the full scaffold discharge fills all three TODO fields and records the acceptance discharge', () => {
    const { root, cawsDir } = mkRepo();
    // Closed via the governed path (activate -> close; close is warn-mode on
    // AC evidence, so a closed spec with an unevidenced scaffold criterion is
    // reachable — that reachability is what makes the discharge live).
    writeSpec(cawsDir, 'ACC-008', {});
    closeThroughLifecycle(root, 'ACC-008');
    const before = readRaw(cawsDir, 'ACC-008');
    expect(before).toContain("    given: 'TODO'");

    const r = amend(root, 'ACC-008', {
      setAc: 'A1',
      given: 'a concluded spec with an unfilled criterion',
      when: 'the discharge runs',
      then: 'the blank is filled and the discharge is on the event',
    });
    expect(r.code).toBe(0);

    const spec = loadCleanSpec(cawsDir, 'ACC-008');
    expect(spec.acceptance[0].given).toBe('a concluded spec with an unfilled criterion');
    const events = amendedEvents(cawsDir);
    expect(events).toHaveLength(1);
    expect(events[0].data.discharged_scaffold_fields).toEqual(['acceptance']);
    expect(events[0].data.set_acceptance).toEqual([
      { id: 'A1', fields: ['given', 'when', 'then'] },
    ]);
  });

  test('the discharge refuses when the criterion carries evidence (a closed evidence block is frozen)', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'ACC-009', {});
    expect(recordEvidence(root, 'ACC-009', 'A1', 'waived', { waiverReason: 'not separately verified' }).code).toBe(0);
    closeThroughLifecycle(root, 'ACC-009');
    const before = readRaw(cawsDir, 'ACC-009');

    const r = amend(root, 'ACC-009', {
      setAc: 'A1',
      given: 'g',
      when: 'w',
      then: 't',
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('create scaffold');
    expect(r.err).toContain('carries a recorded evidence entry');
    expect(readRaw(cawsDir, 'ACC-009')).toBe(before);
    expect(amendedEvents(cawsDir)).toHaveLength(0);
  });
});

describe('A5: one transaction, schema-valid event, auto-commit', () => {
  test('an accepted AC amendment lands as one audited commit on a clean tree', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'ACC-010', { acs: TWO_ACS });
    // Evidence recorded BEFORE the fixture commit, so the amend's audit
    // commit below captures the reset (a clean tree is what autoCommit needs).
    expect(recordEvidence(root, 'ACC-010', 'A1', 'pass', {
      evidenceRef: 'npm test',
      command: 'npm test',
      exitCode: 0,
    }).code).toBe(0);
    // Commit the fixture so amend's autoCommit sees a clean tree (a dirty tree
    // makes the audit commit refuse, which is its own tested behavior).
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root });

    const r = amend(root, 'ACC-010', {
      setAc: 'A1',
      then: 'rewritten under audit',
      reason: 'fixture drift',
    });
    expect(r.code).toBe(0);

    const subject = execFileSync('git', ['log', '--format=%s', '-1'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    expect(subject).toBe('chore(caws): amend ACC-010');
    // The committed content IS the amended content (transaction, not
    // working-tree-only edit).
    const committed = execFileSync('git', ['show', `HEAD:.caws/specs/ACC-010.yaml`], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(committed).toContain("    then: 'rewritten under audit'");
    // The evidence reset is visible in the committed YAML: the criterion's
    // entry is back to unchecked with no proof fields.
    expect(committed).toContain('status: unchecked');
    expect(committed).not.toContain('npm test');
  });

  test('a long field value folds to >- and round-trips through the parser; sibling folded text is preserved', () => {
    const { root, cawsDir } = mkRepo();
    const longThen =
      'the amended criterion text is long enough to exceed the inline limit and must therefore be rendered as a folded block scalar that the parser round-trips exactly';
    writeSpec(cawsDir, 'ACC-011', { acs: TWO_ACS });

    const first = amend(root, 'ACC-011', { setAc: 'A1', then: longThen });
    expect(first.code).toBe(0);
    const raw1 = readRaw(cawsDir, 'ACC-011');
    expect(raw1).toContain('    then: >-');
    // Continuation lines are indented 6.
    expect(raw1).toMatch(/\n {6}the amended criterion text is long/);
    const spec1 = loadCleanSpec(cawsDir, 'ACC-011');
    expect(spec1.acceptance[0].then).toBe(longThen);

    // A second amendment to a DIFFERENT field must preserve the folded block
    // byte-for-byte (folded prose is never re-flowed by a sibling edit).
    const foldedBlock = raw1.slice(raw1.indexOf('    then: >-'), raw1.indexOf('  - id: A2'));
    const second = amend(root, 'ACC-011', { setAc: 'A1', given: 'short given' });
    expect(second.code).toBe(0);
    const raw2 = readRaw(cawsDir, 'ACC-011');
    expect(raw2.slice(raw2.indexOf('    then: >-'), raw2.indexOf('  - id: A2'))).toBe(foldedBlock);
    // The folded rewrite DID reset evidence (text changed)…
    expect(amendedEvents(cawsDir)).toHaveLength(2);
    // …and the second amendment changed only `given`.
    expect(amendedEvents(cawsDir)[1].data.set_acceptance).toEqual([{ id: 'A1', fields: ['given'] }]);
  });
});
