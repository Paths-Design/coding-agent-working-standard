/**
 * @fileoverview Tests for CAWS tools functionality
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const yaml = require('js-yaml');

// Helper function to get template tool path via dependency
function getTemplateToolPath(toolName) {
  try {
    return require.resolve(`@caws/template/apps/tools/caws/${toolName}`);
  } catch (error) {
    // Fallback to relative path for local development
    return path.join(__dirname, '../../caws-template/apps/tools/caws', toolName);
  }
}

describe('CAWS Tools', () => {
  const testDir = path.join(__dirname, 'test-tools');
  const workingSpecPath = path.join(testDir, '.caws/working-spec.yaml');

  beforeAll(() => {
    // Create test directory
    fs.mkdirSync(testDir, { recursive: true });
    fs.mkdirSync(path.join(testDir, '.caws'), { recursive: true });
    fs.mkdirSync(path.join(testDir, '.agent'), { recursive: true });

    // Create package.json for attest tool
    const packageJson = {
      name: 'test-tools',
      version: '1.0.0',
      description: 'Test project for CAWS tools',
    };
    fs.writeFileSync(path.join(testDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    // Create a valid working spec for testing
    const validSpec = {
      id: 'TEST-001',
      title: 'Test Project for Tools',
      risk_tier: 2,
      mode: 'feature',
      change_budget: {
        max_files: 25,
        max_loc: 1000,
      },
      blast_radius: {
        modules: ['core', 'api'],
        data_migration: false,
      },
      operational_rollback_slo: '5m',
      threats: ['Test threat 1', 'Test threat 2'],
      scope: {
        in: ['test files'],
        out: ['other files'],
      },
      invariants: ['System remains stable'],
      acceptance: [
        {
          id: 'A1',
          given: 'Current system state',
          when: 'Feature is used',
          then: 'Expected behavior occurs',
        },
      ],
      non_functional: {
        a11y: ['keyboard navigation'],
        perf: { api_p95_ms: 250 },
        security: ['input validation'],
      },
      contracts: [
        {
          type: 'openapi',
          path: 'test.yaml',
        },
      ],
      observability: {
        logs: ['test.log'],
        metrics: ['test_metric'],
        traces: ['test_trace'],
      },
      migrations: ['Test migration'],
      rollback: ['Test rollback'],
    };

    fs.writeFileSync(workingSpecPath, yaml.dump(validSpec));
  });

  afterAll(() => {
    // Clean up test directory
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('Validate Tool', () => {
    test('should validate a correct working spec', () => {
      const validatePath = getTemplateToolPath('validate.js');
      const output = execSync(
        `node ${validatePath} ${workingSpecPath}`,
        { encoding: 'utf8', cwd: testDir }
      );
      expect(output).toContain('✅ Working specification is valid');
    });

    test('should show summary for valid spec', () => {
      const validatePath = getTemplateToolPath('validate.js');
      const output = execSync(
        `node ${validatePath} ${workingSpecPath}`,
        { encoding: 'utf8', cwd: testDir }
      );
      expect(output).toContain('ID: TEST-001');
      expect(output).toContain('Title: Test Project for Tools');
      expect(output).toContain('Risk Tier: 2');
      expect(output).toContain('Mode: feature');
      expect(output).toContain('📊 Scope Analysis:');
      expect(output).toContain('📝 Quality Metrics:');
      expect(output).toContain('Files in scope: 1');
      expect(output).toContain('Acceptance criteria: 1');
    });

    test('should fail with missing spec file', () => {
      expect(() => {
        const validatePath = getTemplateToolPath('validate.js');
      execSync(`node ${validatePath} missing.yaml`, {
          encoding: 'utf8',
          cwd: testDir,
        });
      }).toThrow();
    });
  });

  describe('Gates Tool', () => {
    test('should show tier policy', () => {
      const gatesPath = getTemplateToolPath('gates.js');
      const output = execSync(`node ${gatesPath} tier 1`, {
        encoding: 'utf8',
        cwd: testDir,
      });
      expect(output).toContain('📋 Tier 1 Policy Analysis:');
      expect(output).toContain('Branch Coverage: ≥90%');
      expect(output).toContain('Mutation Score: ≥70%');
      expect(output).toContain('Max Files: 40');
      expect(output).toContain('🔍 Current Project Analysis:');
      expect(output).toContain('Max LOC: 1500');
      expect(output).toContain('Requires Contracts: true');
      expect(output).toContain('Manual Review: Required');
    });

    test('should enforce coverage gate', () => {
      const output = execSync(
        `node ${getTemplateToolPath('gates.js')} coverage "2" 0.85`,
        {
          encoding: 'utf8',
          cwd: testDir,
        }
      );
      expect(output).toContain('✅ Branch coverage gate passed:');
    });

    test('should fail coverage gate when below threshold', () => {
      expect(() => {
        const gatesPath = getTemplateToolPath('gates.js');
        execSync(`node ${gatesPath} coverage 2 0.75`, {
          encoding: 'utf8',
          cwd: testDir,
        });
      }).toThrow();
    });

    test('should enforce mutation gate', () => {
      const output = execSync(
        `node ${getTemplateToolPath('gates.js')} mutation "2" 0.60`,
        {
          encoding: 'utf8',
          cwd: testDir,
        }
      );
      expect(output).toContain('✅ Mutation gate passed:');
    });

    test('should fail mutation gate when below threshold', () => {
      expect(() => {
        const gatesPath = getTemplateToolPath('gates.js');
        execSync(`node ${gatesPath} mutation 2 0.40`, {
          encoding: 'utf8',
          cwd: testDir,
        });
      }).toThrow();
    });

    test('should enforce trust score gate', () => {
      const gatesPath = getTemplateToolPath('gates.js');
      const output = execSync(`node ${gatesPath} trust "2" 85`, {
        encoding: 'utf8',
        cwd: testDir,
      });
      expect(output).toContain('✅ Trust score gate passed:');
    });

    test('should fail trust score gate when below threshold', () => {
      expect(() => {
        const gatesPath = getTemplateToolPath('gates.js');
        execSync(`node ${gatesPath} trust 2 75`, {
          encoding: 'utf8',
          cwd: testDir,
        });
      }).toThrow();
    });

    test('should enforce budget gate', () => {
      const output = execSync(
        `node ${getTemplateToolPath('gates.js')} budget "2" 20 800`,
        {
          encoding: 'utf8',
          cwd: testDir,
        }
      );
      expect(output).toContain('✅ Budget gate passed:');
    });

    test('should fail budget gate when files exceed limit', () => {
      expect(() => {
        const gatesPath = getTemplateToolPath('gates.js');
        execSync(`node ${gatesPath} budget "2" 30 800`, {
          encoding: 'utf8',
          cwd: testDir,
        });
      }).toThrow();
    });

    test('should fail budget gate when LOC exceed limit', () => {
      expect(() => {
        const gatesPath = getTemplateToolPath('gates.js');
        execSync(`node ${gatesPath} budget "2" 20 1200`, {
          encoding: 'utf8',
          cwd: testDir,
        });
      }).toThrow();
    });
  });

  describe('Attest Tool', () => {
    test('should generate SBOM', () => {
      const attestPath = getTemplateToolPath('attest.js');
      const output = execSync(`node ${attestPath} bundle`, {
        encoding: 'utf8',
        cwd: testDir,
      });

      // Extract JSON from output (it contains status messages before JSON)
      // The JSON starts after the "✅ Attestation saved..." messages
      const jsonMatch = output.match(/(\{[\s\S]*\})/);
      expect(jsonMatch).toBeTruthy();

      const bundle = JSON.parse(jsonMatch[1]);

      expect(bundle).toHaveProperty('sbom');
      expect(bundle.sbom).toHaveProperty('spdxId', 'SPDXRef-DOCUMENT');
      expect(bundle.sbom).toHaveProperty('spdxVersion', 'SPDX-2.3');
      expect(bundle.sbom).toHaveProperty('name');
      expect(bundle.sbom).toHaveProperty('packages');
      expect(bundle.sbom.packages).toBeInstanceOf(Array);
    });

    test('should generate SLSA attestation', () => {
      const attestPath = getTemplateToolPath('attest.js');
      const output = execSync(`node ${attestPath} bundle`, {
        encoding: 'utf8',
        cwd: testDir,
      });

      // Extract JSON from output
      const jsonMatch = output.match(/(\{[\s\S]*\})/);
      expect(jsonMatch).toBeTruthy();

      const bundle = JSON.parse(jsonMatch[1]);

      expect(bundle).toHaveProperty('slsa');
      expect(bundle.slsa).toHaveProperty('_type', 'https://in-toto.io/Statement/v0.1');
      expect(bundle.slsa).toHaveProperty('predicateType', 'https://slsa.dev/provenance/v0.2');
      expect(bundle.slsa.predicate).toHaveProperty('builder');
      expect(bundle.slsa.predicate).toHaveProperty('buildType');
    });

    test('should generate in-toto attestation', () => {
      const attestPath = getTemplateToolPath('attest.js');
      const output = execSync(`node ${attestPath} bundle`, {
        encoding: 'utf8',
        cwd: testDir,
      });

      // Extract JSON from output
      const jsonMatch = output.match(/(\{[\s\S]*\})/);
      expect(jsonMatch).toBeTruthy();

      const bundle = JSON.parse(jsonMatch[1]);

      expect(bundle).toHaveProperty('intoto');
      expect(bundle.intoto).toHaveProperty('_type', 'https://in-toto.io/Statement/v0.1');
      expect(bundle.intoto).toHaveProperty('predicateType', 'https://caws.dev/attestation/v1');
      expect(bundle.intoto.predicate).toHaveProperty('generator');
      expect(bundle.intoto.predicate.generator).toHaveProperty('name', 'caws-cli');
    });
  });
});
