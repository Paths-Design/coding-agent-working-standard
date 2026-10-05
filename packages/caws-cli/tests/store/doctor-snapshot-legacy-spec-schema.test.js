'use strict';

/**
 * CAWS-SPEC-SCHEMA-AUTHORITY-UNSTATED-001 — the OBSERVATION half.
 *
 * The original defect lived in the store, not the kernel: the snapshot
 * stat'ed only `.caws/working-spec.schema.json`, so the identical dead
 * schema at `.caws/schemas/working-spec.schema.json` produced no finding.
 * A kernel test that hands `inspectProjectState` a ready-made path list
 * cannot catch that — it asserts the rule, not what the store looked at.
 *
 * So this suite drives the REAL filesystem through the REAL CLI: it writes
 * the file to disk and asserts `caws doctor` reports it. This is the test
 * that fails against the pre-fix code.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
const RULE = 'doctor.init.legacy_working_spec_schema_present';

afterAll(() => {
  cleanupAll();
});

function runDoctor(repoRoot) {
  const result = spawnSync(process.execPath, [CLI, 'doctor', '--repair-plan', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, CAWS_QUIET: '1' },
  });
  return JSON.parse(result.stdout);
}

/** Findings for the legacy-schema rule, with the subject each one names. */
function legacySchemaSubjects(repoRoot) {
  return runDoctor(repoRoot)
    .items.filter((item) => item.source_rule === RULE)
    .map((item) => item.subject);
}

/** An initialized repo: `.caws/` present so init-residue rules are evaluated
 *  at all (an uninitialized repo takes a different branch entirely). */
function initializedRepo() {
  const repoRoot = makeTempRepo();
  const result = spawnSync(process.execPath, [CLI, 'init', '--agent-surface', 'none'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, CAWS_QUIET: '1' },
  });
  if (result.status !== 0) {
    throw new Error(`fixture init failed (${result.status}): ${result.stderr}`);
  }
  return repoRoot;
}

function writeLegacySchema(repoRoot, ...segments) {
  const abs = path.join(repoRoot, '.caws', ...segments);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // Content is irrelevant — presence is the defect. A plausible v10 body
  // keeps the fixture honest about what an operator would actually have.
  fs.writeFileSync(
    abs,
    JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' }, null, 2)
  );
  return ['.caws', ...segments].join('/');
}

describe('doctor observes the legacy spec schema wherever it sits (CAWS-SPEC-SCHEMA-AUTHORITY-UNSTATED-001)', () => {
  test('a clean initialized repo reports no legacy-schema finding', () => {
    // Baseline: proves the assertions below detect the FILE, not merely the
    // fact that doctor emits findings in an initialized repo.
    expect(legacySchemaSubjects(initializedRepo())).toEqual([]);
  });

  test('A1: the schemas/ copy is observed and named', () => {
    const repoRoot = initializedRepo();
    const relPath = writeLegacySchema(repoRoot, 'schemas', 'working-spec.schema.json');

    // The pre-fix store stat'ed only the root path, so this returned [].
    expect(legacySchemaSubjects(repoRoot)).toEqual([relPath]);
  });

  test('A2: the root copy is still observed and named', () => {
    const repoRoot = initializedRepo();
    const relPath = writeLegacySchema(repoRoot, 'working-spec.schema.json');

    expect(legacySchemaSubjects(repoRoot)).toEqual([relPath]);
  });

  test('both copies are observed, each named once', () => {
    const repoRoot = initializedRepo();
    const rootPath = writeLegacySchema(repoRoot, 'working-spec.schema.json');
    const nestedPath = writeLegacySchema(repoRoot, 'schemas', 'working-spec.schema.json');

    expect(legacySchemaSubjects(repoRoot).sort()).toEqual([rootPath, nestedPath].sort());
  });

  test('the finding is an error and its repair names the file on disk', () => {
    const repoRoot = initializedRepo();
    const relPath = writeLegacySchema(repoRoot, 'schemas', 'working-spec.schema.json');

    const item = runDoctor(repoRoot).items.find((i) => i.source_rule === RULE);
    expect(item.severity).toBe('error');
    // Telling the operator to remove a path that does not exist is the
    // failure mode a shared hard-coded message would reintroduce.
    expect(item.message).toContain(relPath);
    expect(item.next_command || item.refusal_reason || '').toBeDefined();
  });

  test('an unrelated schema file in .caws/schemas/ is not flagged', () => {
    const repoRoot = initializedRepo();
    writeLegacySchema(repoRoot, 'schemas', 'waivers.schema.json');

    // Only the legacy SPEC schema is dead authority; the other schemas under
    // .caws/schemas/ are live and must not be swept up by a directory-level
    // match. (protected-paths overmatch is a repeat failure class here.)
    expect(legacySchemaSubjects(repoRoot)).toEqual([]);
  });
});
