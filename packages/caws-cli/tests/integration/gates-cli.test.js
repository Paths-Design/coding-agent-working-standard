/**
 * @fileoverview Integration tests for `caws gates run` CLI command
 * Exercises the gates pipeline end-to-end via child_process.execFileSync,
 * verifying JSON and text output, exit codes, and gate pass/fail behavior.
 * @author @darianrosebrook
 */

const path = require('path');
const fs = require('fs-extra');
const { execSync, execFileSync } = require('child_process');
const yaml = require('js-yaml');
const { createTemplateRepo, cloneFixture, cleanupTemplate } = require('../helpers/git-fixture');

const cliPath = path.join(__dirname, '../../src/index.js');

// CAWSFIX-22: policy schema requires edit_rules; shared fixture for test policies
const EDIT_RULES = { policy_and_code_same_pr: false, min_approvers_for_budget_raise: 2 };

/**
 * Build a minimal schema-valid working-spec.yaml object.
 * The v10 schema requires id, title, risk_tier, mode, blast_radius,
 * operational_rollback_slo, scope, invariants, acceptance, non_functional, contracts.
 */
function buildValidSpec(overrides = {}) {
  return {
    id: 'TS-001',
    title: 'Integration test spec fixture',
    risk_tier: 2,
    mode: 'feature',
    blast_radius: { modules: ['src'] },
    operational_rollback_slo: '30m',
    scope: { in: ['src/**'], out: [] },
    invariants: ['No regressions in existing tests'],
    acceptance: [{ id: 'A1', given: 'a project', when: 'gates run', then: 'report is produced' }],
    non_functional: {},
    contracts: [],
    ...overrides,
  };
}

/**
 * Create a temp directory with a git repo, .caws/policy.yaml, and .caws/working-spec.yaml.
 * Returns the directory path. Caller must clean up.
 */
// Shared git template — created once per test suite
let _gatesCLITemplate = null;

function createTestProject(overrides = {}) {
  if (!_gatesCLITemplate) {
    _gatesCLITemplate = createTemplateRepo();
  }
  const dir = cloneFixture(_gatesCLITemplate, 'caws-gates-cli-');

  // Create .caws directory
  fs.ensureDirSync(path.join(dir, '.caws'));

  // Default policy with all gates in warn mode (so they pass)
  const defaultPolicy = {
    version: 1,
    risk_tiers: {
      1: { max_files: 25, max_loc: 1000 },
      2: { max_files: 50, max_loc: 2000 },
      3: { max_files: 100, max_loc: 5000 },
    },
    edit_rules: EDIT_RULES,
    gates: {
      scope_boundary: { enabled: true, mode: 'warn' },
      budget_limit: { enabled: true, mode: 'warn' },
      god_object: { enabled: true, mode: 'warn' },
      todo_detection: { enabled: true, mode: 'warn' },
      spec_completeness: { enabled: true, mode: 'warn' },
    },
  };

  const policy = overrides.policy || defaultPolicy;
  fs.writeFileSync(
    path.join(dir, '.caws', 'policy.yaml'),
    yaml.dump(policy)
  );

  const spec = overrides.spec || buildValidSpec();
  fs.writeFileSync(
    path.join(dir, '.caws', 'working-spec.yaml'),
    yaml.dump(spec)
  );

  return dir;
}

/**
 * Run the CLI gates command and return { stdout, stderr, exitCode }.
 * Handles non-zero exit codes via try/catch since execSync throws.
 */
function runGatesCli(projectDir, extraArgs = []) {
  const args = ['gates', 'run', ...extraArgs];
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args], {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (error) {
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      exitCode: error.status || 1,
    };
  }
}

/**
 * Extract JSON from CLI stdout.
 * The CLI may emit non-JSON lines before and after the JSON block
 * (e.g. "Detecting CAWS setup..." preamble, schema warnings, etc.).
 * This finds and parses the first complete JSON object in the output.
 */
function extractJson(stdout) {
  // Find the first '{' that starts a JSON object
  const jsonStart = stdout.indexOf('{');
  if (jsonStart === -1) {
    throw new Error(`No JSON object found in stdout: ${stdout.slice(0, 200)}`);
  }
  // Find the matching closing brace by counting braces
  let depth = 0;
  let jsonEnd = -1;
  for (let i = jsonStart; i < stdout.length; i++) {
    if (stdout[i] === '{') depth++;
    else if (stdout[i] === '}') {
      depth--;
      if (depth === 0) {
        jsonEnd = i + 1;
        break;
      }
    }
  }
  if (jsonEnd === -1) {
    throw new Error(`Unclosed JSON object in stdout: ${stdout.slice(jsonStart, jsonStart + 200)}`);
  }
  return JSON.parse(stdout.slice(jsonStart, jsonEnd));
}

describe('gates CLI integration', () => {
  let testDir;

  afterAll(() => {
    if (_gatesCLITemplate) {
      cleanupTemplate(_gatesCLITemplate);
      _gatesCLITemplate = null;
    }
  });

  afterEach(async () => {
    if (testDir) {
      await fs.remove(testDir);
      testDir = null;
    }
  });

  describe('all gates pass', () => {
    test('exits 0 with passed=true when all gates are in warn mode and project is clean', () => {
      testDir = createTestProject();

      const result = runGatesCli(testDir, ['--context=cli', '--json']);
      expect(result.exitCode).toBe(0);

      const report = extractJson(result.stdout);
      expect(report.passed).toBe(true);
      expect(Array.isArray(report.gates)).toBe(true);
      expect(report.summary.blocked).toBe(0);
    });

    test('exits 0 with commit context and no staged files', () => {
      testDir = createTestProject();

      const result = runGatesCli(testDir, ['--context=commit', '--json']);
      expect(result.exitCode).toBe(0);

      const report = extractJson(result.stdout);
      expect(report.passed).toBe(true);
    });
  });

  describe('budget exceeded (block mode)', () => {
    test('exits 1 when staged file count exceeds tier-1 budget in block mode', () => {
      testDir = createTestProject({
        policy: {
          version: 1,
          risk_tiers: {
            1: { max_files: 3, max_loc: 50 },
            2: { max_files: 5, max_loc: 100 },
            3: { max_files: 100, max_loc: 5000 },
          },
          edit_rules: EDIT_RULES,
          gates: {
            budget_limit: { enabled: true, mode: 'block' },
          },
        },
        spec: buildValidSpec({
          risk_tier: 1,
          scope: { in: ['src/**'], out: [] },
        }),
      });

      // Create and stage more files than tier-1 allows (max_files: 3)
      fs.ensureDirSync(path.join(testDir, 'src'));
      for (let i = 0; i < 10; i++) {
        fs.writeFileSync(path.join(testDir, 'src', `file${i}.js`), `// file ${i}\nconst x = ${i};\n`);
      }
      execSync('git add .', { cwd: testDir, stdio: 'pipe' });

      const result = runGatesCli(testDir, ['--context=commit', '--json']);
      expect(result.exitCode).toBe(1);

      const report = extractJson(result.stdout);
      expect(report.passed).toBe(false);
      expect(report.summary.blocked).toBeGreaterThanOrEqual(1);

      // Find the budget_limit gate result
      const budgetGate = report.gates.find(g => g.name === 'budget_limit');
      expect(budgetGate).toBeDefined();
      expect(budgetGate.status).toBe('fail');
      expect(budgetGate.mode).toBe('block');
      expect(budgetGate.messages.length).toBeGreaterThan(0);
    });
  });

  describe('JSON output structure', () => {
    test('JSON output has passed, gates, summary, and timestamp fields', () => {
      testDir = createTestProject();

      const result = runGatesCli(testDir, ['--json']);
      expect(result.exitCode).toBe(0);

      const report = extractJson(result.stdout);

      // Required top-level fields
      expect(report).toHaveProperty('passed');
      expect(report).toHaveProperty('gates');
      expect(report).toHaveProperty('summary');
      expect(report).toHaveProperty('timestamp');

      // Summary structure
      expect(report.summary).toHaveProperty('blocked');
      expect(report.summary).toHaveProperty('warned');
      expect(report.summary).toHaveProperty('passed');
      expect(report.summary).toHaveProperty('skipped');
      expect(report.summary).toHaveProperty('waived');

      // Timestamp is valid ISO date
      expect(new Date(report.timestamp).toISOString()).toBe(report.timestamp);
    });

    test('each gate entry has name, mode, status, waived, messages, and duration', () => {
      testDir = createTestProject();

      const result = runGatesCli(testDir, ['--json']);
      const report = extractJson(result.stdout);

      expect(report.gates.length).toBeGreaterThan(0);

      for (const gate of report.gates) {
        expect(gate).toHaveProperty('name');
        expect(gate).toHaveProperty('mode');
        expect(gate).toHaveProperty('status');
        expect(gate).toHaveProperty('waived');
        expect(gate).toHaveProperty('messages');
        expect(gate).toHaveProperty('duration');
        expect(typeof gate.name).toBe('string');
        expect(typeof gate.duration).toBe('number');
        expect(Array.isArray(gate.messages)).toBe(true);
      }
    });
  });

  describe('non-JSON (text) output', () => {
    test('produces human-readable text output without --json flag', () => {
      testDir = createTestProject();

      const result = runGatesCli(testDir, ['--context=cli']);
      expect(result.exitCode).toBe(0);

      // Text output should contain the report header and summary
      expect(result.stdout).toContain('Quality Gates Report');
      expect(result.stdout).toContain('Summary:');
    });

    test('text output is not valid JSON', () => {
      testDir = createTestProject();

      const result = runGatesCli(testDir, ['--context=cli']);
      expect(result.exitCode).toBe(0);

      // The full stdout should not parse as JSON (even though
      // there may be some braces in the text, the complete output is not JSON)
      expect(() => JSON.parse(result.stdout)).toThrow();
    });
  });

  describe('scope boundary violation in block mode', () => {
    test('exits 1 when staged file is out of scope with block mode', () => {
      testDir = createTestProject({
        policy: {
          version: 1,
          risk_tiers: {
            1: { max_files: 25, max_loc: 1000 },
            2: { max_files: 50, max_loc: 2000 },
            3: { max_files: 100, max_loc: 5000 },
          },
          edit_rules: EDIT_RULES,
          gates: {
            scope_boundary: { enabled: true, mode: 'block' },
          },
        },
        spec: buildValidSpec({
          scope: { in: ['src/**'], out: [] },
        }),
      });

      // Stage a file outside the allowed scope
      fs.ensureDirSync(path.join(testDir, 'vendor'));
      fs.writeFileSync(path.join(testDir, 'vendor', 'lib.js'), '// out of scope\n');
      execSync('git add .', { cwd: testDir, stdio: 'pipe' });

      const result = runGatesCli(testDir, ['--context=commit', '--json']);
      expect(result.exitCode).toBe(1);

      const report = extractJson(result.stdout);
      expect(report.passed).toBe(false);

      const scopeGate = report.gates.find(g => g.name === 'scope_boundary');
      expect(scopeGate).toBeDefined();
      expect(scopeGate.status).toBe('fail');
      expect(scopeGate.mode).toBe('block');
    });
  });

  describe('quiet mode', () => {
    test('--quiet suppresses text output on success', () => {
      testDir = createTestProject();

      const result = runGatesCli(testDir, ['--quiet']);
      expect(result.exitCode).toBe(0);

      // In quiet mode, the gates command should not produce the full report text
      expect(result.stdout).not.toContain('Quality Gates Report');
    });
  });
});
