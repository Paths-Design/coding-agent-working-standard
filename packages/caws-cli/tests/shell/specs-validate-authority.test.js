'use strict';

/**
 * CAWS-SPEC-SCHEMA-AUTHORITY-UNSTATED-001 — `caws specs validate` states the
 * authority it applied.
 *
 * A bare "is valid" arbitrates nothing. A project carrying a legacy
 * `working-spec.schema.json` gives the operator two candidate authorities:
 * the CLI says the spec is fine, the local schema rejects the same shape,
 * and neither names itself. The observed failure is an agent trying to
 * reconcile a project-local schema against spec shapes it does not describe.
 * Printing the authority on BOTH verdicts removes the ambiguity at the exact
 * moment someone is looking for it — the failure path especially, since that
 * is where a reader is most likely to "fix" a spec against a dead file.
 *
 * Runs the COMPILED dist/ CLI as a real process, so the assertion covers the
 * wiring (Commander route -> handler -> stdout/stderr channel), not just the
 * handler's return value.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

const AUTHORITY_FRAGMENT = 'Authority: the kernel spec schema (spec.v1)';
const NOT_CONSULTED_FRAGMENT = 'NOT consulted';

let tmpDirs = [];

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-validate-authority-'));
  tmpDirs.push(dir);
  return dir;
}

function runValidate(filePath) {
  return spawnSync(process.execPath, [CLI, 'specs', 'validate', filePath], {
    encoding: 'utf8',
    env: { ...process.env, CAWS_QUIET: '1' },
  });
}

/** A minimal spec that satisfies the kernel schema. */
function validSpecYaml() {
  return [
    'id: CAWS-VALIDATE-AUTHORITY-FIXTURE-001',
    "title: 'Fixture spec for the validate authority note'",
    'risk_tier: 3',
    'mode: chore',
    'lifecycle_state: draft',
    'blast_radius:',
    '  modules:',
    '    - fixture',
    '  data_migration: false',
    'operational_rollback_slo: 5m',
    'scope:',
    '  in:',
    '    - packages/caws-cli/src/fixture.ts',
    '  out: []',
    'invariants:',
    "  - 'The fixture exists only to exercise the validator.'",
    'acceptance:',
    '  - id: A1',
    "    given: 'a fixture spec'",
    "    when: 'it is validated'",
    "    then: 'the verdict names its authority'",
    // Schema-required KEY. Tier 3 / chore does not require contract ENTRIES,
    // but the field itself must be present — an easy distinction to miss.
    'contracts: []',
    'non_functional: {}',
    '',
  ].join('\n');
}

describe('caws specs validate names its schema authority (CAWS-SPEC-SCHEMA-AUTHORITY-UNSTATED-001)', () => {
  test('A3: a passing verdict names the kernel schema and disclaims project-local files', () => {
    const dir = tmpDir();
    const specPath = path.join(dir, 'fixture.yaml');
    fs.writeFileSync(specPath, validSpecYaml());

    const result = runValidate(specPath);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('is valid (CAWS-VALIDATE-AUTHORITY-FIXTURE-001)');
    expect(result.stdout).toContain(AUTHORITY_FRAGMENT);
    // Naming the winner is not enough; the note must say the local file
    // loses, because that is the specific belief being corrected.
    expect(result.stdout).toContain('working-spec.schema.json');
    expect(result.stdout).toContain(NOT_CONSULTED_FRAGMENT);
  });

  test('a failing verdict states the same authority, on stderr with the diagnostics', () => {
    const dir = tmpDir();
    const specPath = path.join(dir, 'invalid.yaml');
    // Wrong shape for vNext: change_budget is an explicitly forbidden
    // surface, so this fails schema validation rather than YAML parsing.
    fs.writeFileSync(
      specPath,
      validSpecYaml() + 'change_budget:\n  max_files: 10\n  max_loc: 100\n'
    );

    const result = runValidate(specPath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is invalid');
    expect(result.stderr).toContain(AUTHORITY_FRAGMENT);
  });

  test('the authority note is absent when no verdict was reached', () => {
    // An unreadable file produced no verdict, so claiming an authority would
    // assert something the command never did. This keeps the note honest
    // rather than decorative.
    const dir = tmpDir();
    const result = runValidate(path.join(dir, 'does-not-exist.yaml'));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot read file');
    expect(result.stderr).not.toContain(AUTHORITY_FRAGMENT);
  });
});
