/**
 * @fileoverview CAWSFIX-11 — scope.schema.json version field is optional
 *
 * Verifies that:
 *   A1: A standalone .caws/scope.json with version=1 and allowedDirectories
 *       passes schema validation and produces NO "scope.json schema violation"
 *       warning from validateWorkingSpecWithSuggestions.
 *   A2: A standalone .caws/scope.json WITHOUT the version field passes
 *       schema validation (CAWSFIX-11 decision: lift the version requirement;
 *       runtime in src/config/lite-scope.js already defaults version to 1).
 *   A3: A feature spec whose inline `scope:` block has no version key does
 *       NOT trigger the scope.json schema-violation warning path — because
 *       validateWorkingSpecWithSuggestions only applies scope.schema.json
 *       when a standalone .caws/scope.json file exists on disk.
 *
 * These tests import the real schema file and the real
 * validateWorkingSpecWithSuggestions function; nothing is mocked.
 *
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const {
  validateWorkingSpecWithSuggestions,
} = require('../../src/validation/spec-validation');
const { createValidator } = require('../../src/utils/schema-validator');

const SCHEMA_PATH = path.join(
  __dirname,
  '..',
  '..',
  'templates',
  '.caws',
  'schemas',
  'scope.schema.json'
);

/** Build a minimally-valid working spec (no inline scope.version key). */
function makeValidSpec() {
  return {
    id: 'FIX-0001',
    title: 'Test spec for CAWSFIX-11 inline scope block',
    risk_tier: 3,
    mode: 'fix',
    blast_radius: { modules: ['src/'], data_migration: false },
    operational_rollback_slo: '5m',
    scope: {
      in: ['src/'],
      out: ['node_modules/'],
    },
    invariants: ['system is stable'],
    acceptance: [
      { id: 'A1', given: 'g', when: 'w', then: 't' },
    ],
    non_functional: { a11y: [], perf: { api_p95_ms: 250 }, security: [] },
    contracts: [{ type: 'openapi', path: 'api.yaml' }],
  };
}

/** Collect all warning messages whose instancePath is scope.json-related. */
function scopeJsonWarnings(result) {
  return (result.warnings || []).filter((w) =>
    typeof w.message === 'string' && w.message.startsWith('scope.json schema violation')
  );
}

describe('CAWSFIX-11 — scope.schema.json version is optional', () => {
  let testDir;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawsfix-11-'));
    fs.ensureDirSync(path.join(testDir, '.caws'));
  });

  afterEach(() => {
    fs.removeSync(testDir);
  });

  describe('A1 — standalone scope.json with version=1 still validates', () => {
    test('explicit version=1 + allowedDirectories passes schema validation', () => {
      const validate = createValidator(SCHEMA_PATH);
      const result = validate({
        version: 1,
        allowedDirectories: ['src/', 'tests/'],
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    test('version=1 scope.json on disk produces no scope.json violation warning from validateWorkingSpecWithSuggestions', () => {
      fs.writeJsonSync(
        path.join(testDir, '.caws', 'scope.json'),
        { version: 1, allowedDirectories: ['src/'] }
      );

      const result = validateWorkingSpecWithSuggestions(makeValidSpec(), {
        projectRoot: testDir,
      });

      // Evidence: no warning whose message starts with "scope.json schema violation"
      expect(scopeJsonWarnings(result)).toEqual([]);
    });
  });

  describe('A2 — standalone scope.json WITHOUT version still validates (new behavior)', () => {
    test('missing version + allowedDirectories passes schema validation', () => {
      const validate = createValidator(SCHEMA_PATH);
      const result = validate({
        allowedDirectories: ['src/', 'tests/'],
      });
      // CAWSFIX-11 decision (Option B in spec): version is no longer required
      // on standalone scope.json. Pre-versioning files validate cleanly.
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    test('version-less scope.json on disk produces no scope.json violation warning', () => {
      fs.writeJsonSync(
        path.join(testDir, '.caws', 'scope.json'),
        { allowedDirectories: ['src/'] } // no version key
      );

      const result = validateWorkingSpecWithSuggestions(makeValidSpec(), {
        projectRoot: testDir,
      });

      // Evidence: the specific D3 reproduction warning is absent
      const violations = scopeJsonWarnings(result);
      expect(violations).toEqual([]);
    });

    test('invalid version value (not 1) still fails schema validation', () => {
      const validate = createValidator(SCHEMA_PATH);
      // version is optional but, when present, must be exactly 1 (const: 1)
      const result = validate({
        version: 2,
        allowedDirectories: ['src/'],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test('schema still requires allowedDirectories', () => {
      const validate = createValidator(SCHEMA_PATH);
      const result = validate({ version: 1 });
      expect(result.valid).toBe(false);
      // Evidence: error message references the missing property
      const messages = result.errors.map((e) => e.message).join('|');
      expect(messages).toMatch(/allowedDirectories/);
    });
  });

  describe('A3 — inline scope block in a working spec does not trigger scope.json schema path', () => {
    test('spec with inline scope (no version key) and NO standalone scope.json produces no scope.json violation warning', () => {
      // Intentionally do NOT create .caws/scope.json in testDir.
      // The scope-schema check in spec-validation.js is gated on
      // fs.existsSync(scopeJsonPath), so it must not run here.
      expect(fs.existsSync(path.join(testDir, '.caws', 'scope.json'))).toBe(false);

      const spec = makeValidSpec();
      // Inline scope has no `version` key — that's the D3 reproduction shape.
      expect(spec.scope).not.toHaveProperty('version');

      const result = validateWorkingSpecWithSuggestions(spec, {
        projectRoot: testDir,
      });

      // Evidence: no scope.json-labelled warning anywhere
      expect(scopeJsonWarnings(result)).toEqual([]);
    });

    test('even if we also have a version-less standalone scope.json, no violation warning is emitted', () => {
      fs.writeJsonSync(
        path.join(testDir, '.caws', 'scope.json'),
        { allowedDirectories: ['src/'] }
      );

      const spec = makeValidSpec();
      // Still no inline version key on spec.scope
      expect(spec.scope).not.toHaveProperty('version');

      const result = validateWorkingSpecWithSuggestions(spec, {
        projectRoot: testDir,
      });

      // Evidence: the D3 reproduction warning does not appear
      const violations = scopeJsonWarnings(result);
      expect(violations).toEqual([]);
    });
  });
});
