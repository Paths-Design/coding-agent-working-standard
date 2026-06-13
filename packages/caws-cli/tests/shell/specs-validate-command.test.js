/**
 * CAWS-SPECS-VALIDATE-FILE-CMD-001 — A1..A4 verification.
 *
 * `caws specs validate <file>` validates a spec YAML FILE on disk using the
 * CLI's own bundled parser + the kernel parse->shape->semantics pipeline.
 * The point of the command is that the parser lives in CAWS tooling, NOT
 * embedded in shell hooks via `node -e require('js-yaml')` — so validation
 * works for any consumer project regardless of language.
 *
 *   A1: a valid spec file        → exit 0, echoes the parsed id
 *   A2: genuine YAML syntax error → exit 1, spec.yaml.* rule WITH location
 *   A3: parses but schema-invalid → exit 1, spec.schema.* rule (layers run)
 *   A4: missing/unreadable file   → exit 1, honest file error, NOT a false
 *                                   "YAML syntax error" for an unparsed file
 *
 * The command is path-shaped (takes a file path, not a spec id), does not
 * resolve .caws/, and does not mutate anything — so no repo fixture is needed;
 * a temp file on disk is the whole input.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { runSpecsValidateCommand } = require('../../dist/shell');

// A minimal spec body that passes parse + shape + semantics. Mirrors the
// shape the kernel validators require (blast_radius, non_functional, a
// non-empty scope.in / invariants / acceptance, and a contract for tier 2).
const VALID_SPEC = `id: VALIDATE-FIXTURE-001
title: A valid fixture spec for the validate command test
risk_tier: 2
mode: feature
lifecycle_state: active
blast_radius:
  modules:
    - test-fixture
  data_migration: false
operational_rollback_slo: 5m
scope:
  in:
    - some/path.ts
  out: []
invariants:
  - The fixture is structurally valid so A1 proves the happy path.
acceptance:
  - id: A1
    given: a valid spec file
    when: validate runs
    then: it exits 0
non_functional:
  reliability:
    - the fixture validates clean
contracts:
  - name: fixture
    type: behavior
    description: a placeholder contract so the tier-2 spec loads
`;

function writeTmp(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-validate-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return { dir, file };
}

function rmrf(p) {
  if (p && fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function capture(opts) {
  const out = [];
  const err = [];
  const code = runSpecsValidateCommand({
    ...opts,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

describe('caws specs validate <file> (CAWS-SPECS-VALIDATE-FILE-CMD-001)', () => {
  const created = [];
  afterEach(() => {
    while (created.length) rmrf(created.pop());
  });

  test('A1: a valid spec file exits 0 and echoes the parsed id', () => {
    const { dir, file } = writeTmp('valid.yaml', VALID_SPEC);
    created.push(dir);

    const { code, stdout, stderr } = capture({ file });

    expect(code).toBe(0);
    // The id appears in stdout — proving the parser actually ran and read the
    // file, not a no-op that always reports "valid".
    expect(stdout).toContain('VALIDATE-FIXTURE-001');
    expect(stdout).toContain('valid');
    expect(stderr).toBe('');
  });

  test('A2: a genuine YAML syntax error exits 1 with a spec.yaml.* rule and a location', () => {
    // Bad indentation — a real parse-layer failure.
    const { dir, file } = writeTmp('bad-syntax.yaml', 'id: X\n  bad: indentation\n :::\n');
    created.push(dir);

    const { code, stdout, stderr } = capture({ file });

    expect(code).toBe(1);
    // Parse-layer namespace, NOT a schema/semantic rule.
    expect(stderr).toMatch(/spec\.yaml\./);
    // Location is surfaced (line:column) so the author can find it.
    expect(stderr).toMatch(/\(\d+:\d+\)/);
    expect(stdout).toBe('');
  });

  test('A3: a parseable but schema-invalid file exits 1 with a spec.schema.* rule (layers run)', () => {
    // Parses as YAML, but has an unknown top-level field — a schema-layer
    // failure. Proves the shape/semantic layers run, not just YAML parsing.
    const badSchema =
      VALID_SPEC.replace(
        'lifecycle_state: active\n',
        'lifecycle_state: active\nbogus_field: nope\n'
      );
    const { dir, file } = writeTmp('bad-schema.yaml', badSchema);
    created.push(dir);

    const { code, stdout, stderr } = capture({ file });

    expect(code).toBe(1);
    expect(stderr).toMatch(/spec\.schema\./);
    expect(stderr).toContain('bogus_field');
    // Distinct from a parse failure — the YAML itself parsed fine.
    expect(stderr).not.toMatch(/spec\.yaml\.parse_failed/);
    expect(stdout).toBe('');
  });

  test('A4: a missing file exits 1 with an honest file error, NOT a false YAML syntax error', () => {
    const missing = path.join(os.tmpdir(), 'caws-validate-does-not-exist-12345.yaml');
    // Defensive: ensure it really is absent.
    rmrf(missing);

    const { code, stdout, stderr } = capture({ file: missing });

    expect(code).toBe(1);
    expect(stderr).toContain('cannot read file');
    expect(stderr).toMatch(/ENOENT|no such file/i);
    // The conflation this command eliminates: a missing file must NEVER be
    // reported as a YAML syntax / parse error, because the parser never ran.
    expect(stderr).not.toMatch(/spec\.yaml\.parse_failed/);
    expect(stderr).not.toMatch(/YAML syntax error/i);
    expect(stdout).toBe('');
  });
});
