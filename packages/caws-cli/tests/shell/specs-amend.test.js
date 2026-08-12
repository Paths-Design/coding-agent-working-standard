'use strict';

/**
 * `caws specs amend` — the discharge path (Sterling ledger N16, A4-A6).
 *
 * `--module`/`--invariant` on create only help specs that do not exist yet.
 * Measured in this repo when the slice was written: 12 spec files still carried
 * the scaffolded default, 7 of them closed. Their only route out was a hand
 * edit of the YAML, which bypasses the audit trail the spec files exist to
 * provide — so the create flags alone would have left the defect standing for
 * every spec already written.
 *
 * The closed-spec rule is the load-bearing part. A closed spec is the audit
 * record of concluded work; if amend could freely rewrite it, this command
 * would be a retroactive-edit tool and strictly worse than the defect. So
 * filling an entry that is still the scaffolded default is admitted, and
 * removing or rewriting a substantive entry is refused.
 *
 * SUT: compiled writer + command, plus one spawned dist/index.js run.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { initProject } = require('../../dist/store/init-store');
const { runSpecsAmendCommand } = require('../../dist/shell/commands/specs');
const {
  MODULES_PLACEHOLDER,
  INVARIANTS_PLACEHOLDER,
} = require('../../dist/store/specs-writer');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

afterAll(() => {
  cleanupAll();
});

function specBody(id, lifecycleState, modules, invariants, extraTopLevel = '') {
  const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
  return `id: ${id}
title: '${id}'
risk_tier: 3
mode: chore
lifecycle_state: ${lifecycleState}
${extraTopLevel}created_at: '2026-07-30T00:00:00.000Z'
updated_at: '2026-07-30T00:00:00.000Z'
blast_radius:
  modules:
${modules.map((m) => `    - ${q(m)}`).join('\n')}
  data_migration: false
operational_rollback_slo: 5m
scope:
  in:
    - tests
  out: []
invariants:
${invariants.map((i) => `  - ${q(i)}`).join('\n')}
acceptance:
  - id: A1
    given: fixture
    when: fixture
    then: fixture
non_functional: {}
contracts: []
`;
}

function setupRepo(id, lifecycleState, modules, invariants, extraTopLevel = '') {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed');
  const cawsDir = path.join(root, '.caws');
  const specPath = path.join(cawsDir, 'specs', `${id}.yaml`);
  fs.writeFileSync(specPath, specBody(id, lifecycleState, modules, invariants, extraTopLevel));
  return { root, cawsDir, specPath };
}

function runAmend(cwd, id, opts = {}) {
  const out = [];
  const err = [];
  const code = runSpecsAmendCommand({
    cwd,
    now: () => new Date('2026-08-12T12:00:00.000Z'),
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'test-session' },
    id,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
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

describe('A4: an existing draft or active spec can discharge its scaffold', () => {
  test('adding to a scaffold-only field REPLACES the scaffold rather than appending', () => {
    const { root, cawsDir, specPath } = setupRepo(
      'AMEND-A4-001',
      'active',
      [MODULES_PLACEHOLDER],
      [INVARIANTS_PLACEHOLDER]
    );

    const result = runAmend(root, 'AMEND-A4-001', {
      addModule: ['packages/alpha'],
      addInvariant: ['ordering survives retries'],
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain('amended AMEND-A4-001');

    const yaml = fs.readFileSync(specPath, 'utf8');
    expect(yaml).toContain("- 'packages/alpha'");
    expect(yaml).toContain("- 'ordering survives retries'");
    // HEADLINE: filling a blank must not keep the blank beside the content.
    expect(yaml).not.toContain(MODULES_PLACEHOLDER);
    expect(yaml).not.toContain(INVARIANTS_PLACEHOLDER);

    const amended = readEvents(cawsDir).filter((e) => e.event === 'spec_body_amended');
    expect(amended).toHaveLength(1);
    expect(amended[0].data.discharged_scaffold_fields).toEqual([
      'blast_radius.modules',
      'invariants',
    ]);
    expect(amended[0].data.resulting_modules).toEqual(['packages/alpha']);
    expect(amended[0].data.previous_lifecycle_state).toBe('active');
  });

  test('a draft spec supports add and remove of substantive entries', () => {
    const { root, cawsDir, specPath } = setupRepo(
      'AMEND-A4-002',
      'draft',
      ['packages/old', 'packages/keep'],
      ['first invariant']
    );

    const result = runAmend(root, 'AMEND-A4-002', {
      addModule: ['packages/new'],
      removeModule: ['packages/old'],
    });
    expect(result.code).toBe(0);

    const yaml = fs.readFileSync(specPath, 'utf8');
    expect(yaml).toContain("- 'packages/keep'");
    expect(yaml).toContain("- 'packages/new'");
    expect(yaml).not.toContain("- 'packages/old'");

    const amended = readEvents(cawsDir).filter((e) => e.event === 'spec_body_amended');
    expect(amended[0].data.added_modules).toEqual(['packages/new']);
    expect(amended[0].data.removed_modules).toEqual(['packages/old']);
    // Nothing was scaffolded here, so nothing was discharged.
    expect(amended[0].data.discharged_scaffold_fields).toBeUndefined();
  });

  test('removal matches the logical value regardless of on-disk quoting', () => {
    // The bug class behind CAWS-CLI-AMEND-SCOPE-REMOVE-OUT-QUOTED-NOOP-001: a
    // raw-text comparison keeps the quotes, never matches, and reports success
    // while the entry persists.
    const { root, specPath } = setupRepo(
      'AMEND-A4-003',
      'active',
      ['packages/quoted', 'packages/keep'],
      ['inv']
    );

    expect(runAmend(root, 'AMEND-A4-003', { removeModule: ["'packages/quoted'"] }).code).toBe(0);
    const yaml = fs.readFileSync(specPath, 'utf8');
    expect(yaml).not.toContain('packages/quoted');
    expect(yaml).toContain("- 'packages/keep'");
  });

  test('a no-op amendment is refused rather than reported as success', () => {
    const { root, specPath } = setupRepo('AMEND-A4-004', 'active', ['packages/a'], ['inv']);
    const before = fs.readFileSync(specPath, 'utf8');

    const result = runAmend(root, 'AMEND-A4-004', { addModule: ['packages/a'] });
    expect(result.code).toBe(1);
    expect(result.err).toContain('No change');
    expect(fs.readFileSync(specPath, 'utf8')).toBe(before);
  });

  test('supplying no flags at all is refused', () => {
    const { root } = setupRepo('AMEND-A4-005', 'active', ['packages/a'], ['inv']);
    const result = runAmend(root, 'AMEND-A4-005');
    expect(result.code).toBe(1);
    expect(result.err).toContain('requires at least one of');
  });
});

describe('A5: a closed spec may have a blank filled, never a claim rewritten', () => {
  test('filling a scaffolded field on a closed spec is admitted', () => {
    const { root, cawsDir, specPath } = setupRepo(
      'AMEND-A5-001',
      'closed',
      [MODULES_PLACEHOLDER],
      ['a real invariant'],
      "resolution: completed\nclosure_notes: 'done'\n"
    );

    const result = runAmend(root, 'AMEND-A5-001', { addModule: ['packages/discharged'] });
    expect(result.code).toBe(0);

    const yaml = fs.readFileSync(specPath, 'utf8');
    expect(yaml).toContain("- 'packages/discharged'");
    expect(yaml).not.toContain(MODULES_PLACEHOLDER);
    // The closure itself is untouched — this is a correction, not a reopening.
    expect(yaml).toContain('lifecycle_state: closed');
    expect(yaml).toMatch(/^resolution: completed$/m);

    const amended = readEvents(cawsDir).filter((e) => e.event === 'spec_body_amended');
    expect(amended[0].data.discharged_scaffold_fields).toEqual(['blast_radius.modules']);
    expect(amended[0].data.previous_lifecycle_state).toBe('closed');
  });

  test('adding to a field that already holds real content is refused', () => {
    const { root, cawsDir, specPath } = setupRepo(
      'AMEND-A5-002',
      'closed',
      ['packages/real'],
      ['a real invariant'],
      "resolution: completed\n"
    );
    const before = fs.readFileSync(specPath, 'utf8');

    const result = runAmend(root, 'AMEND-A5-002', { addModule: ['packages/sneaky'] });
    expect(result.code).toBe(1);
    expect(result.err).toContain('only fill a field still holding its scaffolded default');
    expect(result.err).toContain('blast_radius.modules');
    // The remediation names the governed way to change a concluded spec.
    expect(result.err).toContain('caws specs reopen AMEND-A5-002');

    // Byte-identical, and no event: a refused amendment writes nothing.
    expect(fs.readFileSync(specPath, 'utf8')).toBe(before);
    expect(readEvents(cawsDir).filter((e) => e.event === 'spec_body_amended')).toHaveLength(0);
  });

  test('removing a substantive entry from a closed spec is refused', () => {
    const { root, specPath } = setupRepo(
      'AMEND-A5-003',
      'closed',
      ['packages/a', 'packages/b'],
      ['inv'],
      "resolution: completed\n"
    );
    const before = fs.readFileSync(specPath, 'utf8');

    const result = runAmend(root, 'AMEND-A5-003', { removeModule: ['packages/a'] });
    expect(result.code).toBe(1);
    expect(fs.readFileSync(specPath, 'utf8')).toBe(before);
  });

  test('the same rewrite IS allowed once the spec is active', () => {
    // Proves the refusal above is about lifecycle state, not about the edit
    // being malformed — without this the A5 tests could pass for the wrong
    // reason.
    const { root, specPath } = setupRepo('AMEND-A5-004', 'active', ['packages/real'], ['inv']);

    expect(runAmend(root, 'AMEND-A5-004', { addModule: ['packages/also'] }).code).toBe(0);
    expect(fs.readFileSync(specPath, 'utf8')).toContain("- 'packages/also'");
  });
});

describe('A6: an archived body is a tombstone', () => {
  test('amending an archived spec is refused and points at restore', () => {
    const root = makeTempRepo();
    initProject(root);
    const cawsDir = path.join(root, '.caws');
    const archiveDir = path.join(cawsDir, 'specs', '.archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    const archivedPath = path.join(archiveDir, 'AMEND-A6-001.yaml');
    fs.writeFileSync(
      archivedPath,
      specBody('AMEND-A6-001', 'archived', [MODULES_PLACEHOLDER], ['inv'])
    );
    const before = fs.readFileSync(archivedPath, 'utf8');

    const result = runAmend(root, 'AMEND-A6-001', { addModule: ['packages/nope'] });
    expect(result.code).toBe(1);
    expect(result.err).toContain('tombstone');
    expect(result.err).toContain('caws specs restore AMEND-A6-001');

    // The archived body is untouched — rewriting it would falsify the record.
    expect(fs.readFileSync(archivedPath, 'utf8')).toBe(before);
  });
});

describe('the Commander wiring is real, not just the handler', () => {
  test('a spawned CLI run forwards every repeatable flag', () => {
    const { root, cawsDir, specPath } = setupRepo(
      'AMEND-CLI-001',
      'active',
      [MODULES_PLACEHOLDER],
      [INVARIANTS_PLACEHOLDER]
    );

    const run = spawnSync(
      process.execPath,
      [
        CLI, 'specs', 'amend', 'AMEND-CLI-001',
        '--add-module', 'packages/one', '--add-module', 'packages/two',
        '--add-invariant', 'holds under load',
      ],
      { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'test-session' } }
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('amended AMEND-CLI-001');

    const yaml = fs.readFileSync(specPath, 'utf8');
    expect(yaml).toContain("- 'packages/one'");
    expect(yaml).toContain("- 'packages/two'");
    expect(yaml).toContain("- 'holds under load'");

    const amended = readEvents(cawsDir).filter((e) => e.event === 'spec_body_amended');
    expect(amended[0].data.resulting_modules).toEqual(['packages/one', 'packages/two']);
  });

  test('the amended spec still passes caws specs validate', () => {
    const { root } = setupRepo('AMEND-CLI-002', 'active', [MODULES_PLACEHOLDER], ['inv']);
    expect(runAmend(root, 'AMEND-CLI-002', { addModule: ['packages/valid'] }).code).toBe(0);

    // Not vacuous: the raw-byte patch must leave a kernel-valid document, not
    // merely plausible-looking text.
    const validate = spawnSync(
      process.execPath,
      [CLI, 'specs', 'validate', '.caws/specs/AMEND-CLI-002.yaml'],
      { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'test-session' } }
    );
    expect(validate.status).toBe(0);
    expect(validate.stdout).toContain('is valid');
  });
});
