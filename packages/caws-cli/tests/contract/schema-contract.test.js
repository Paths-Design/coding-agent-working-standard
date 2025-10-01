/**
 * @fileoverview Contract tests for CAWS schema validation
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

describe('Schema Validation Contracts', () => {
  // Define the working spec schema contract
  const workingSpecSchema = {
    type: 'object',
    required: ['id', 'title', 'risk_tier', 'mode', 'scope', 'invariants', 'acceptance'],
    properties: {
      id: {
        type: 'string',
        pattern: '^[A-Z]+-\\d+$',
        description: 'Project identifier in format PREFIX-NUMBER',
      },
      title: {
        type: 'string',
        minLength: 1,
        description: 'Human-readable project title',
      },
      risk_tier: {
        type: 'number',
        enum: [1, 2, 3],
        description: 'Risk level: 1=low, 2=medium, 3=high',
      },
      mode: {
        type: 'string',
        enum: ['feature', 'refactor', 'fix', 'doc', 'chore'],
        description: 'Type of change being made',
      },
      scope: {
        type: 'object',
        required: ['in', 'out'],
        properties: {
          in: {
            type: ['string', 'array'],
            description: 'Files/directories included in scope',
          },
          out: {
            type: ['string', 'array'],
            description: 'Files/directories excluded from scope',
          },
        },
      },
      invariants: {
        type: 'array',
        items: { type: 'string' },
        description: 'System invariants that must be maintained',
      },
      acceptance: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'given', 'when', 'then'],
          properties: {
            id: { type: 'string' },
            given: { type: 'string' },
            when: { type: 'string' },
            then: { type: 'string' },
          },
        },
        description: 'Acceptance criteria for the change',
      },
      threats: {
        type: 'array',
        items: { type: 'string' },
        description: 'Potential threats or risks',
      },
      migrations: {
        type: 'array',
        items: { type: 'string' },
        description: 'Database or data migration steps',
      },
      rollback: {
        type: 'array',
        items: { type: 'string' },
        description: 'Rollback procedures if needed',
      },
    },
  };

  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(workingSpecSchema);

  describe('Working Spec Schema Contract', () => {
    test('schema should validate correctly formed working specs', () => {
      const validSpec = {
        id: 'TEST-001',
        title: 'Test Feature Implementation',
        risk_tier: 2,
        mode: 'feature',
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
      };

      const isValid = validate(validSpec);
      expect(isValid).toBe(true);
      expect(validate.errors).toBeNull();
    });

    test('schema should reject invalid working specs', () => {
      const invalidSpec = {
        // Missing required fields
        title: 'Invalid Spec',
        // Invalid risk tier
        risk_tier: 5,
        // Invalid mode
        mode: 'invalid_mode',
        // Missing scope
        invariants: ['test'],
      };

      const isValid = validate(invalidSpec);
      expect(isValid).toBe(false);
      expect(validate.errors).toBeDefined();
      expect(validate.errors.length).toBeGreaterThan(0);
    });

    test('schema should validate acceptance criteria structure', () => {
      const specWithAcceptance = {
        id: 'TEST-002',
        title: 'Test with Acceptance Criteria',
        risk_tier: 1,
        mode: 'feature',
        scope: { in: 'src/', out: 'node_modules/' },
        invariants: ['test'],
        acceptance: [
          {
            id: 'A1',
            given: 'Valid given clause',
            when: 'Valid when clause',
            then: 'Valid then clause',
          },
        ],
      };

      const isValid = validate(specWithAcceptance);
      expect(isValid).toBe(true);

      // Test invalid acceptance criteria
      const invalidAcceptance = {
        ...specWithAcceptance,
        acceptance: [
          {
            // Missing required fields
            id: 'A1',
          },
        ],
      };

      const isInvalid = validate(invalidAcceptance);
      expect(isInvalid).toBe(false);
    });
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
      const validatePath = path.join(__dirname, '../../demo-project/apps/tools/caws/validate.js');

      if (fs.existsSync(validatePath)) {
        const validateTool = require(validatePath);

        // Should be an object with validateWorkingSpec function
        expect(typeof validateTool).toBe('object');
        expect(validateTool).toHaveProperty('validateWorkingSpec');
        expect(typeof validateTool.validateWorkingSpec).toBe('function');

        // Should accept a file path parameter and return an object
        const result = validateTool.validateWorkingSpec('/nonexistent/path.yaml');
        expect(result).toBeDefined();
        expect(typeof result).toBe('object');
        expect(result).toHaveProperty('success');
        expect(typeof result.success).toBe('boolean');
      }
    });

    test('tool allowlist should have expected structure', () => {
      const allowlistPath = path.join(
        __dirname,
        '../../demo-project/apps/tools/caws/tools-allow.json'
      );

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
      }
    });
  });
});
