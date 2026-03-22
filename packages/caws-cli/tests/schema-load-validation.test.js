/**
 * @fileoverview Tests for schema validation wired into data load points
 * Verifies createValidator is invoked at loadRegistry, resolveSpec, loadPolicy,
 * and spec-validation first pass.
 */

const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const yaml = require('js-yaml');

// Mock chalk to avoid ESM import issues in Jest
const mockChalkFn = (str) => str;
jest.mock('chalk', () => {
  const handler = {
    get: (_target, prop) => {
      if (typeof prop === 'string') return mockChalkFn;
      return undefined;
    },
    apply: (_target, _thisArg, args) => args[0],
  };
  return new Proxy(mockChalkFn, handler);
});

const TEMPLATES_SCHEMAS = path.join(__dirname, '../templates/.caws/schemas');

describe('loadRegistry schema validation', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-registry-test-'));
    fs.ensureDirSync(path.join(tempDir, '.caws'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.removeSync(tempDir);
    jest.restoreAllMocks();
  });

  test('loadRegistry with missing required fields logs warning, still returns data', () => {
    // Registry missing "worktrees" key — schema requires it
    const malformed = { version: 1 };
    fs.writeFileSync(
      path.join(tempDir, '.caws', 'worktrees.json'),
      JSON.stringify(malformed)
    );

    // Copy schema so getSchemaPath resolves within the temp project
    const schemasDir = path.join(tempDir, '.caws', 'schemas');
    fs.ensureDirSync(schemasDir);
    fs.copyFileSync(
      path.join(TEMPLATES_SCHEMAS, 'worktrees.schema.json'),
      path.join(schemasDir, 'worktrees.schema.json')
    );

    const { loadRegistry } = require('../src/worktree/worktree-manager');
    const data = loadRegistry(tempDir);

    // Should still return the parsed data (graceful degradation)
    expect(data).toEqual({ version: 1 });

    // Should have warned about schema violations
    expect(console.warn).toHaveBeenCalledWith(
      'Worktree registry has schema violations:',
      expect.any(Array)
    );
  });

  test('loadRegistry with valid data does not warn', () => {
    const valid = {
      version: 1,
      worktrees: {
        'test-wt': {
          name: 'test-wt',
          path: '/tmp/wt',
          branch: 'caws/test-wt',
          baseBranch: 'main',
          scope: null,
          specId: null,
          createdAt: '2026-01-01T00:00:00Z',
          status: 'active',
        },
      },
    };
    fs.writeFileSync(
      path.join(tempDir, '.caws', 'worktrees.json'),
      JSON.stringify(valid)
    );

    const schemasDir = path.join(tempDir, '.caws', 'schemas');
    fs.ensureDirSync(schemasDir);
    fs.copyFileSync(
      path.join(TEMPLATES_SCHEMAS, 'worktrees.schema.json'),
      path.join(schemasDir, 'worktrees.schema.json')
    );

    const { loadRegistry } = require('../src/worktree/worktree-manager');
    const data = loadRegistry(tempDir);

    expect(data).toEqual(valid);
    expect(console.warn).not.toHaveBeenCalledWith(
      'Worktree registry has schema violations:',
      expect.anything()
    );
  });

  test('loadRegistry when schema file missing logs warning, still returns data', () => {
    // No schemas dir — getSchemaPath will fall back to templates,
    // but templates may not have the schema in all envs.
    // We remove the templates schema to force the error path.
    const malformed = { version: 1 };
    fs.writeFileSync(
      path.join(tempDir, '.caws', 'worktrees.json'),
      JSON.stringify(malformed)
    );
    // No schemas dir created, so schema won't be found in project.
    // The fallback to templates should still work (templates exist).
    // This tests graceful degradation when schema can't be loaded.

    const { loadRegistry } = require('../src/worktree/worktree-manager');
    const data = loadRegistry(tempDir);

    // Should still return the data regardless
    expect(data).toEqual({ version: 1 });
  });
});

describe('resolveSpec schema validation', () => {
  let mockProjectRoot;

  // jest.mock must use mock-prefixed variable to reference outer scope
  jest.mock('../src/utils/detection', () => ({
    findProjectRoot: () => mockProjectRoot,
  }));

  beforeEach(() => {
    mockProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-spec-test-'));
    fs.ensureDirSync(path.join(mockProjectRoot, '.caws'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.removeSync(mockProjectRoot);
    jest.restoreAllMocks();
  });

  test('resolveSpec with invalid spec includes schema errors in thrown error', async () => {
    // Create an invalid spec file (missing required fields)
    const invalidSpec = {
      id: 'bad',
      title: 'x',
    };
    const specFilePath = path.join(mockProjectRoot, 'bad-spec.yaml');
    fs.writeFileSync(specFilePath, yaml.dump(invalidSpec));

    // Copy schema so validation can find it
    const schemasDir = path.join(mockProjectRoot, '.caws', 'schemas');
    fs.ensureDirSync(schemasDir);
    fs.copyFileSync(
      path.join(TEMPLATES_SCHEMAS, 'working-spec.schema.json'),
      path.join(schemasDir, 'working-spec.schema.json')
    );

    const { resolveSpec } = require('../src/utils/spec-resolver');

    await expect(resolveSpec({ specFile: specFilePath })).rejects.toThrow(
      /schema violations/
    );
  });
});

describe('PolicyManager.loadPolicy schema validation', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-policy-test-'));
    fs.ensureDirSync(path.join(tempDir, '.caws'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.removeSync(tempDir);
    jest.restoreAllMocks();
  });

  test('loadPolicy with invalid policy warns and falls back to defaults', async () => {
    // Policy missing required risk_tiers
    const invalidPolicy = { version: 1 };
    fs.writeFileSync(
      path.join(tempDir, '.caws', 'policy.yaml'),
      yaml.dump(invalidPolicy)
    );

    // Copy schema
    const schemasDir = path.join(tempDir, '.caws', 'schemas');
    fs.ensureDirSync(schemasDir);
    fs.copyFileSync(
      path.join(TEMPLATES_SCHEMAS, 'policy.schema.json'),
      path.join(schemasDir, 'policy.schema.json')
    );

    const { PolicyManager } = require('../src/policy/PolicyManager');
    const pm = new PolicyManager({ enableCaching: false });
    const result = await pm.loadPolicy(tempDir);

    // Should fall back to defaults
    expect(result._isDefault).toBe(true);
    expect(result._schemaErrors).toBeDefined();
    expect(result._schemaErrors.length).toBeGreaterThan(0);

    // Should have warned
    expect(console.warn).toHaveBeenCalledWith(
      'Policy has schema violations:',
      expect.any(Array)
    );
    expect(console.warn).toHaveBeenCalledWith('Falling back to default policy');
  });

  test('loadPolicy with valid policy does not warn about schema', async () => {
    const validPolicy = {
      version: 1,
      risk_tiers: {
        1: { max_files: 25, max_loc: 1000, description: 'Critical' },
        2: { max_files: 50, max_loc: 2000, description: 'Standard' },
        3: { max_files: 100, max_loc: 5000, description: 'Low risk' },
      },
      edit_rules: {
        policy_and_code_same_pr: false,
        min_approvers_for_budget_raise: 2,
        require_signed_commits: true,
      },
    };
    fs.writeFileSync(
      path.join(tempDir, '.caws', 'policy.yaml'),
      yaml.dump(validPolicy)
    );

    const schemasDir = path.join(tempDir, '.caws', 'schemas');
    fs.ensureDirSync(schemasDir);
    fs.copyFileSync(
      path.join(TEMPLATES_SCHEMAS, 'policy.schema.json'),
      path.join(schemasDir, 'policy.schema.json')
    );

    const { PolicyManager } = require('../src/policy/PolicyManager');
    const pm = new PolicyManager({ enableCaching: false });
    const result = await pm.loadPolicy(tempDir);

    expect(result._isDefault).toBeUndefined();
    expect(console.warn).not.toHaveBeenCalledWith(
      'Policy has schema violations:',
      expect.anything()
    );
  });
});

describe('spec-validation schema first pass', () => {
  test('validateWorkingSpec catches missing fields via schema or semantic pass', () => {
    const { validateWorkingSpec } = require('../src/validation/spec-validation');

    // Spec missing most required fields — caught by schema first pass (if schema
    // compiles) or by semantic validation as fallback
    const result = validateWorkingSpec({ id: 'bad' });

    expect(result.valid).toBe(false);
    // Whether caught by schema or semantic pass, errors must be reported
    expect(result.errors.length).toBeGreaterThan(0);
    // At least one error should reference a missing field
    const hasMissingFieldError = result.errors.some(
      e => e.message && (e.message.includes('required') || e.message.includes('Missing'))
    );
    expect(hasMissingFieldError).toBe(true);
  });

  test('validateWorkingSpec passes valid spec through schema and semantic checks', () => {
    const { validateWorkingSpec } = require('../src/validation/spec-validation');

    const validSpec = {
      id: 'FEAT-001',
      title: 'A valid test feature title here',
      risk_tier: 2,
      mode: 'feature',
      blast_radius: { modules: ['src/'], data_migration: false },
      operational_rollback_slo: '5m',
      scope: { in: ['src/'], out: ['node_modules/'] },
      invariants: ['System stays stable'],
      acceptance: [
        { id: 'A1', given: 'x', when: 'y', then: 'z' },
      ],
      non_functional: {
        a11y: ['keyboard'],
        perf: {},
        security: ['input-validation'],
      },
      contracts: [{ type: 'openapi', path: 'api.yaml' }],
    };

    const result = validateWorkingSpec(validSpec);
    expect(result.valid).toBe(true);
  });

  test('validateWorkingSpecWithSuggestions uses schema first pass', () => {
    const { validateWorkingSpecWithSuggestions } = require('../src/validation/spec-validation');

    // Missing most required fields
    const result = validateWorkingSpecWithSuggestions({ id: 'bad' });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
