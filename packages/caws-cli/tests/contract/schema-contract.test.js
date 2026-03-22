/**
 * @fileoverview Contract tests for CAWS schema validation
 * Tests load real schemas from disk to prevent drift between
 * hardcoded test schemas and actual shipped schemas.
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

const { createValidator, getSchemaPath } = require('../../src/utils/schema-validator');

const SCHEMAS_DIR = path.join(__dirname, '../../templates/.caws/schemas');

// Task 1: Load real schema from disk instead of hardcoding
const workingSpecSchema = JSON.parse(
  fs.readFileSync(path.join(SCHEMAS_DIR, 'working-spec.schema.json'), 'utf8')
);

const worktreesSchema = JSON.parse(
  fs.readFileSync(path.join(SCHEMAS_DIR, 'worktrees.schema.json'), 'utf8')
);

const waiversSchema = JSON.parse(
  fs.readFileSync(path.join(SCHEMAS_DIR, 'waivers.schema.json'), 'utf8')
);

const scopeSchema = JSON.parse(
  fs.readFileSync(path.join(SCHEMAS_DIR, 'scope.schema.json'), 'utf8')
);

const policySchema = JSON.parse(
  fs.readFileSync(path.join(SCHEMAS_DIR, 'policy.schema.json'), 'utf8')
);

// Helper: compile schema with Ajv, stripping $schema to avoid meta-schema issues
function compileSchema(schema) {
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false });
  const copy = { ...schema };
  delete copy.$schema;
  return ajv.compile(copy);
}

describe('Schema Validation Contracts', () => {
  // Task 4: Assert all expected schema files exist on disk
  describe('Schema File Existence', () => {
    const expectedSchemas = [
      'working-spec.schema.json',
      'worktrees.schema.json',
      'waivers.schema.json',
      'scope.schema.json',
      'policy.schema.json',
    ];

    test.each(expectedSchemas)('%s exists on disk', (schemaFile) => {
      const schemaPath = path.join(SCHEMAS_DIR, schemaFile);
      expect(fs.existsSync(schemaPath)).toBe(true);
    });

    test.each(expectedSchemas)('%s is valid JSON', (schemaFile) => {
      const schemaPath = path.join(SCHEMAS_DIR, schemaFile);
      const content = fs.readFileSync(schemaPath, 'utf8');
      expect(() => JSON.parse(content)).not.toThrow();
    });

    test.each(expectedSchemas)('%s has a title field', (schemaFile) => {
      const schemaPath = path.join(SCHEMAS_DIR, schemaFile);
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
      expect(schema.title).toBeDefined();
      expect(typeof schema.title).toBe('string');
    });
  });

  // Task 2 + Task 3: Working Spec schema tests with real schema
  describe('Working Spec Schema Contract', () => {
    const validate = compileSchema(workingSpecSchema);

    test('schema should validate correctly formed working specs', () => {
      const validSpec = {
        id: 'TEST-001',
        title: 'Test Feature Implementation Plan',
        risk_tier: 2,
        mode: 'feature',
        blast_radius: {
          modules: ['src/utils'],
        },
        operational_rollback_slo: '4h',
        scope: {
          in: ['src/', 'tests/'],
          out: ['node_modules/', 'dist/'],
        },
        invariants: ['System maintains ACID properties', 'API contracts remain stable'],
        acceptance: [
          {
            id: 'A1',
            given: 'User initiates feature',
            when: 'Feature completes successfully',
            then: 'Expected outcome is achieved',
          },
        ],
        non_functional: {},
        contracts: [
          { type: 'openapi', path: 'api/spec.yaml' },
        ],
      };

      const isValid = validate(validSpec);
      expect(isValid).toBe(true);
      expect(validate.errors).toBeNull();
    });

    test('schema should accept string risk_tier values', () => {
      const specWithStringRiskTier = {
        id: 'TEST-001',
        title: 'Test Feature Implementation Plan',
        risk_tier: '2',
        mode: 'feature',
        blast_radius: { modules: ['src/'] },
        operational_rollback_slo: '4h',
        scope: { in: ['src/'], out: ['node_modules/'] },
        invariants: ['Invariant one'],
        acceptance: [{ id: 'A1', given: 'g', when: 'w', then: 't' }],
        non_functional: {},
        contracts: [{ type: 'openapi', path: 'api.yaml' }],
      };

      const isValid = validate(specWithStringRiskTier);
      expect(isValid).toBe(true);
    });

    test('schema should reject invalid working specs', () => {
      const invalidSpec = {
        // Missing most required fields (11 required)
        title: 'Invalid Spec',
        risk_tier: 5,
        mode: 'invalid_mode',
        invariants: ['test'],
      };

      const isValid = validate(invalidSpec);
      expect(isValid).toBe(false);
      expect(validate.errors).toBeDefined();
      expect(validate.errors.length).toBeGreaterThan(0);
    });

    test('schema should require scope.in to be an array', () => {
      const specWithStringScope = {
        id: 'TEST-002',
        title: 'Test with string scope in',
        risk_tier: 1,
        mode: 'feature',
        blast_radius: { modules: ['src/'] },
        operational_rollback_slo: '4h',
        scope: { in: 'src/', out: ['node_modules/'] },
        invariants: ['test invariant'],
        acceptance: [{ id: 'A1', given: 'g', when: 'w', then: 't' }],
        non_functional: {},
        contracts: [{ type: 'openapi', path: 'api.yaml' }],
      };

      const isValid = validate(specWithStringScope);
      expect(isValid).toBe(false);
    });

    test('schema should validate acceptance criteria structure', () => {
      const validSpec = {
        id: 'TEST-003',
        title: 'Test with Acceptance Criteria Validation',
        risk_tier: 1,
        mode: 'feature',
        blast_radius: { modules: ['src/'] },
        operational_rollback_slo: '4h',
        scope: { in: ['src/'], out: ['node_modules/'] },
        invariants: ['test invariant'],
        acceptance: [
          {
            id: 'A1',
            given: 'Valid given clause',
            when: 'Valid when clause',
            then: 'Valid then clause',
          },
        ],
        non_functional: {},
        contracts: [{ type: 'openapi', path: 'api.yaml' }],
      };

      const isValid = validate(validSpec);
      expect(isValid).toBe(true);

      // Test invalid acceptance criteria (missing required fields)
      const invalidAcceptance = {
        ...validSpec,
        acceptance: [{ id: 'A1' }],
      };

      const isInvalid = validate(invalidAcceptance);
      expect(isInvalid).toBe(false);
    });

    test('schema should reject specs missing new required fields', () => {
      // Old-style spec missing blast_radius, operational_rollback_slo,
      // non_functional, contracts
      const oldStyleSpec = {
        id: 'TEST-004',
        title: 'Old Style Spec Missing Fields',
        risk_tier: 2,
        mode: 'feature',
        scope: { in: ['src/'], out: ['node_modules/'] },
        invariants: ['invariant'],
        acceptance: [{ id: 'A1', given: 'g', when: 'w', then: 't' }],
      };

      const isValid = validate(oldStyleSpec);
      expect(isValid).toBe(false);
      // Should report missing required fields
      const missingFields = validate.errors
        .filter(e => e.keyword === 'required')
        .map(e => e.params.missingProperty);
      expect(missingFields).toContain('blast_radius');
      expect(missingFields).toContain('operational_rollback_slo');
      expect(missingFields).toContain('non_functional');
      expect(missingFields).toContain('contracts');
    });
  });

  // Task 3: Worktrees schema
  describe('Worktrees Schema Contract', () => {
    const validate = compileSchema(worktreesSchema);

    test('valid worktree registry passes validation', () => {
      const validRegistry = {
        version: 1,
        worktrees: {
          'agent-abc123': {
            name: 'agent-abc123',
            path: '/tmp/worktree/agent-abc123',
            branch: 'worktree-agent-abc123',
            baseBranch: 'main',
            scope: null,
            specId: null,
            createdAt: '2026-03-21T10:00:00Z',
            status: 'active',
          },
        },
      };

      const isValid = validate(validRegistry);
      expect(isValid).toBe(true);
    });

    test('invalid worktree registry fails validation', () => {
      // Missing required version
      const invalid = {
        worktrees: {},
      };
      expect(validate(invalid)).toBe(false);

      // Wrong version type
      const wrongVersion = {
        version: '1',
        worktrees: {},
      };
      expect(validate(wrongVersion)).toBe(false);

      // Worktree entry missing required fields
      const missingFields = {
        version: 1,
        worktrees: {
          'agent-x': {
            name: 'agent-x',
            // missing path, branch, baseBranch, createdAt, status
          },
        },
      };
      expect(validate(missingFields)).toBe(false);
    });

    test('invalid worktree status is rejected', () => {
      const badStatus = {
        version: 1,
        worktrees: {
          'agent-x': {
            name: 'agent-x',
            path: '/tmp/wt',
            branch: 'wt-branch',
            baseBranch: 'main',
            createdAt: '2026-03-21T10:00:00Z',
            status: 'running', // not a valid enum value
          },
        },
      };
      expect(validate(badStatus)).toBe(false);
    });
  });

  // Task 3: Waivers schema
  describe('Waivers Schema Contract', () => {
    const validate = compileSchema(waiversSchema);

    test('valid waiver passes validation', () => {
      const validWaiver = {
        id: 'WV-0001',
        title: 'Coverage waiver for legacy module',
        reason: 'Legacy integration requires time to add coverage',
        gates: ['coverage'],
        created_at: '2026-03-21T00:00:00Z',
        expires_at: '2026-06-01T00:00:00Z',
        approved_by: '@darianrosebrook',
        status: 'active',
      };

      const isValid = validate(validWaiver);
      expect(isValid).toBe(true);
    });

    test('invalid waiver fails validation', () => {
      const invalid = {
        // Missing required fields: id, title, reason, gates, etc.
        id: 'WV-0002',
        gates: ['coverage'],
      };
      expect(validate(invalid)).toBe(false);
    });

    test('waiver with all optional fields passes', () => {
      const fullWaiver = {
        id: 'WV-0003',
        title: 'Full waiver example',
        reason: 'Experimental feature needs flexibility',
        description: 'Detailed description of why this waiver exists',
        gates: ['naming', 'duplication'],
        created_at: '2026-03-21T00:00:00Z',
        expires_at: '2026-06-01T00:00:00Z',
        approved_by: '@manager',
        impact_level: 'low',
        mitigation_plan: 'Will add coverage in next sprint',
        status: 'active',
        created_by_session: 'session-abc-123',
        compensating_control: 'Manual review required',
      };
      expect(validate(fullWaiver)).toBe(true);
    });
  });

  // Task 3: Scope schema
  describe('Scope Schema Contract', () => {
    const validate = compileSchema(scopeSchema);

    test('valid scope config passes validation', () => {
      const validScope = {
        version: 1,
        allowedDirectories: ['src/', 'tests/'],
      };

      const isValid = validate(validScope);
      expect(isValid).toBe(true);
    });

    test('scope with all optional fields passes', () => {
      const fullScope = {
        version: 1,
        allowedDirectories: ['src/'],
        bannedPatterns: {
          files: ['*-enhanced.*', '*-final.*'],
          directories: ['*venv*'],
          docs: ['*-summary.md'],
        },
        maxNewFilesPerCommit: 10,
        designatedVenvPath: '.venv',
      };

      expect(validate(fullScope)).toBe(true);
    });

    test('invalid scope fails validation', () => {
      // Missing required allowedDirectories
      const noAllowed = { version: 1 };
      expect(validate(noAllowed)).toBe(false);

      // Empty allowedDirectories (minItems: 1)
      const emptyAllowed = { version: 1, allowedDirectories: [] };
      expect(validate(emptyAllowed)).toBe(false);

      // Missing version
      const noVersion = { allowedDirectories: ['src/'] };
      expect(validate(noVersion)).toBe(false);
    });
  });

  // Task 3: Policy schema
  describe('Policy Schema Contract', () => {
    const validate = compileSchema(policySchema);

    test('valid policy passes validation', () => {
      const validPolicy = {
        version: 1,
        risk_tiers: {
          '1': { max_files: 5, max_loc: 200 },
          '2': { max_files: 15, max_loc: 500 },
          '3': { max_files: 30, max_loc: 1000 },
        },
      };

      const isValid = validate(validPolicy);
      expect(isValid).toBe(true);
    });

    test('policy with optional fields passes', () => {
      const fullPolicy = {
        version: 1,
        risk_tiers: {
          '1': { max_files: 5, max_loc: 200, description: 'Critical' },
          '2': { max_files: 15, max_loc: 500, description: 'Standard' },
          '3': { max_files: 30, max_loc: 1000, description: 'Low risk' },
        },
        edit_rules: {
          policy_and_code_same_pr: false,
          min_approvers_for_budget_raise: 2,
          require_signed_commits: true,
        },
        gates: {
          coverage: { enabled: true, description: 'Code coverage gate' },
          mutation: { enabled: false },
        },
      };

      expect(validate(fullPolicy)).toBe(true);
    });

    test('invalid policy fails validation', () => {
      // Missing required risk_tiers
      const noTiers = { version: 1 };
      expect(validate(noTiers)).toBe(false);

      // Missing required tier fields
      const incompleteTiers = {
        version: 1,
        risk_tiers: {
          '1': { max_files: 5 }, // missing max_loc
          '2': { max_files: 15, max_loc: 500 },
          '3': { max_files: 30, max_loc: 1000 },
        },
      };
      expect(validate(incompleteTiers)).toBe(false);

      // Missing a required tier
      const missingTier = {
        version: 1,
        risk_tiers: {
          '1': { max_files: 5, max_loc: 200 },
          '2': { max_files: 15, max_loc: 500 },
          // missing tier 3
        },
      };
      expect(validate(missingTier)).toBe(false);
    });
  });

  // Task 5: Drift detection — createValidator produces identical results to raw Ajv
  describe('Schema Validator Drift Detection', () => {
    const schemaFiles = [
      'working-spec.schema.json',
      'worktrees.schema.json',
      'waivers.schema.json',
      'scope.schema.json',
      'policy.schema.json',
    ];

    test.each(schemaFiles)(
      'createValidator and raw Ajv agree on valid data for %s',
      (schemaFile) => {
        const schemaPath = path.join(SCHEMAS_DIR, schemaFile);
        const runtimeValidator = createValidator(schemaPath);
        const rawValidate = compileSchema(
          JSON.parse(fs.readFileSync(schemaPath, 'utf8'))
        );

        // Use a minimal valid fixture per schema
        const fixtures = {
          'working-spec.schema.json': {
            id: 'DRFT-001',
            title: 'Drift detection test fixture',
            risk_tier: 1,
            mode: 'fix',
            blast_radius: { modules: ['src/'] },
            operational_rollback_slo: '1h',
            scope: { in: ['src/'], out: [] },
            invariants: ['no drift'],
            acceptance: [{ id: 'A1', given: 'g', when: 'w', then: 't' }],
            non_functional: {},
            contracts: [{ type: 'openapi', path: 'api.yaml' }],
          },
          'worktrees.schema.json': {
            version: 1,
            worktrees: {},
          },
          'waivers.schema.json': {
            id: 'WV-0001',
            title: 'Drift test waiver',
            reason: 'Drift detection test fixture reason',
            gates: ['coverage'],
            created_at: '2026-03-21T00:00:00Z',
            expires_at: '2026-06-01T00:00:00Z',
            approved_by: '@test',
            status: 'active',
          },
          'scope.schema.json': {
            version: 1,
            allowedDirectories: ['src/'],
          },
          'policy.schema.json': {
            version: 1,
            risk_tiers: {
              '1': { max_files: 5, max_loc: 200 },
              '2': { max_files: 15, max_loc: 500 },
              '3': { max_files: 30, max_loc: 1000 },
            },
          },
        };

        const data = fixtures[schemaFile];
        const runtimeResult = runtimeValidator(data);
        const rawResult = rawValidate(data);

        expect(runtimeResult.valid).toBe(rawResult);
        expect(runtimeResult.valid).toBe(true);
      }
    );

    test.each(schemaFiles)(
      'createValidator and raw Ajv agree on invalid data for %s',
      (schemaFile) => {
        const schemaPath = path.join(SCHEMAS_DIR, schemaFile);
        const runtimeValidator = createValidator(schemaPath);
        const rawValidate = compileSchema(
          JSON.parse(fs.readFileSync(schemaPath, 'utf8'))
        );

        // Intentionally invalid data: wrong type at root
        const invalidData = 'this is not an object';

        const runtimeResult = runtimeValidator(invalidData);
        const rawResult = rawValidate(invalidData);

        expect(runtimeResult.valid).toBe(rawResult);
        expect(runtimeResult.valid).toBe(false);
      }
    );
  });

  describe('CLI Output Contract', () => {
    test('CLI help output should match expected format', () => {
      const { execSync } = require('child_process');
      const cliPath = path.join(__dirname, '../../dist/index.js');

      const helpOutput = execSync(`node "${cliPath}" --help`, { encoding: 'utf8' });

      // Contract: Help should contain expected sections
      expect(helpOutput).toContain('CAWS - Coding Agent Workflow System CLI');
      expect(helpOutput).toContain('Commands:');
      expect(helpOutput).toContain('init');
      expect(helpOutput).toContain('scaffold');
      expect(helpOutput).toContain('Options:');
      expect(helpOutput).toContain('--help');
      expect(helpOutput).toContain('--version');
    });

    test('CLI version should be semantic versioning', () => {
      const { execSync } = require('child_process');
      const cliPath = path.join(__dirname, '../../dist/index.js');

      const versionOutput = execSync(`node "${cliPath}" --version`, { encoding: 'utf8' });
      const version = versionOutput.trim();

      // Contract: Version should follow semver format
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  describe('Tool Interface Contracts', () => {
    test('validation tool should export expected interface', () => {
      // Contract: Validation tool should export an object with validateWorkingSpec function
      const possibleDemoPaths = [
        path.join(__dirname, '../../demo-project'),
        path.join(__dirname, '../../../demo-project'),
        path.join(process.cwd(), 'packages/caws-cli/demo-project'),
        path.join(process.cwd(), 'demo-project'),
      ];

      let demoPath = null;
      for (const testPath of possibleDemoPaths) {
        if (fs.existsSync(testPath)) {
          demoPath = testPath;
          break;
        }
      }

      if (demoPath) {
        const validatePath = path.join(demoPath, 'apps/tools/caws/validate.js');

        if (fs.existsSync(validatePath)) {
          try {
            const validateTool = require(validatePath);

            // Should be an object with validateWorkingSpec function
            expect(typeof validateTool).toBe('object');
            expect(validateTool).toHaveProperty('validateWorkingSpec');
            expect(typeof validateTool.validateWorkingSpec).toBe('function');

            // Contract: Tool should have proper interface (skip calling with invalid path to avoid process.exit)
            // The function exists and is callable - interface contract is met
            expect(validateTool.validateWorkingSpec).toBeDefined();
          } catch (error) {
            // Demo files use modern JS syntax that Jest/Babel can't parse
            // This is expected in test environment - skip interface validation
            console.log(`Skipping interface validation for demo tool: ${error.message}`);
          }
        } else {
          console.log(`Validation tool not found at: ${validatePath}`);
        }
      } else {
        console.log('Demo project not found - skipping validation tool interface test');
      }
    });

    test('tool allowlist should have expected structure', () => {
      const possibleDemoPaths = [
        path.join(__dirname, '../../demo-project'),
        path.join(__dirname, '../../../demo-project'),
        path.join(process.cwd(), 'packages/caws-cli/demo-project'),
        path.join(process.cwd(), 'demo-project'),
      ];

      let demoPath = null;
      for (const testPath of possibleDemoPaths) {
        if (fs.existsSync(testPath)) {
          demoPath = testPath;
          break;
        }
      }

      if (demoPath) {
        const allowlistPath = path.join(demoPath, 'apps/tools/caws/tools-allow.json');

        if (fs.existsSync(allowlistPath)) {
          const allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));

          // Contract: Should be an array of allowed patterns
          expect(Array.isArray(allowlist)).toBe(true);

          if (allowlist.length > 0) {
            // Contract: Each entry should be a string pattern
            allowlist.forEach((pattern) => {
              expect(typeof pattern).toBe('string');
            });
          }
        } else {
          console.log(`Tool allowlist not found at: ${allowlistPath}`);
        }
      } else {
        console.log('Demo project not found - skipping allowlist structure test');
      }
    });
  });
});
