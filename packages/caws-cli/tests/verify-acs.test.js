/**
 * @fileoverview Tests for verify-acs command
 */

const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const { extractACs, detectTestRunner, verifySpec, checkEvidence } = require('../src/commands/verify-acs');

describe('verify-acs', () => {
  describe('extractACs', () => {
    test('extracts from acceptance_criteria field', () => {
      const spec = {
        acceptance_criteria: [
          { id: 'AC-1', description: 'Login works', test_nodeids: ['tests/auth.test.js::LoginSuite'] },
          { id: 'AC-2', description: 'Logout works' },
        ],
      };
      const acs = extractACs(spec);
      expect(acs).toHaveLength(2);
      expect(acs[0].id).toBe('AC-1');
      expect(acs[0].test_nodeids).toEqual(['tests/auth.test.js::LoginSuite']);
      expect(acs[1].id).toBe('AC-2');
      expect(acs[1].test_nodeids).toBeFalsy();
    });

    test('extracts from acceptance field (given/when/then)', () => {
      const spec = {
        acceptance: [
          { id: 'A1', given: 'a user', when: 'they login', then: 'they see dashboard' },
        ],
      };
      const acs = extractACs(spec);
      expect(acs).toHaveLength(1);
      expect(acs[0].id).toBe('A1');
      expect(acs[0].narrative).toContain('Given a user');
    });

    test('merges both fields by AC ID', () => {
      const spec = {
        acceptance: [
          { id: 'A1', given: 'a user', when: 'they login', then: 'dashboard shown' },
        ],
        acceptance_criteria: [
          { id: 'A1', description: 'Login shows dashboard', test_nodeids: ['tests/login.test.js::Dashboard'] },
        ],
      };
      const acs = extractACs(spec);
      expect(acs).toHaveLength(1);
      expect(acs[0].id).toBe('A1');
      expect(acs[0].test_nodeids).toEqual(['tests/login.test.js::Dashboard']);
      expect(acs[0].description).toBe('Login shows dashboard');
    });

    test('does not merge different IDs', () => {
      const spec = {
        acceptance: [
          { id: 'A1', then: 'something' },
        ],
        acceptance_criteria: [
          { id: 'AC-01', description: 'different thing' },
        ],
      };
      const acs = extractACs(spec);
      expect(acs).toHaveLength(2);
    });

    test('handles spec with no ACs', () => {
      const acs = extractACs({});
      expect(acs).toHaveLength(0);
    });

    test('handles test_command field', () => {
      const spec = {
        acceptance_criteria: [
          { id: 'AC-1', description: 'Works', test_command: 'npm test -- --grep "auth"' },
        ],
      };
      const acs = extractACs(spec);
      expect(acs[0].test_command).toBe('npm test -- --grep "auth"');
    });

    test('handles evidence field', () => {
      const spec = {
        acceptance_criteria: [
          { id: 'AC-1', description: 'Proven', evidence: 'test-results/load-report.json' },
        ],
      };
      const acs = extractACs(spec);
      expect(acs[0].evidence).toBe('test-results/load-report.json');
    });
  });

  describe('detectTestRunner', () => {
    let tmpDir;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'caws-verify-'));
    });

    afterEach(async () => {
      await fs.remove(tmpDir);
    });

    test('detects jest from jest.config.js', async () => {
      await fs.writeFile(path.join(tmpDir, 'jest.config.js'), 'module.exports = {};');
      expect(detectTestRunner(tmpDir)).toBe('jest');
    });

    test('detects jest from package.json', async () => {
      await fs.writeJSON(path.join(tmpDir, 'package.json'), { jest: { testMatch: ['**/*.test.js'] } });
      expect(detectTestRunner(tmpDir)).toBe('jest');
    });

    test('detects pytest from conftest.py', async () => {
      await fs.writeFile(path.join(tmpDir, 'conftest.py'), '');
      expect(detectTestRunner(tmpDir)).toBe('pytest');
    });

    test('detects cargo from Cargo.toml', async () => {
      await fs.writeFile(path.join(tmpDir, 'Cargo.toml'), '[package]');
      expect(detectTestRunner(tmpDir)).toBe('cargo');
    });

    test('detects go from go.mod', async () => {
      await fs.writeFile(path.join(tmpDir, 'go.mod'), 'module example.com/foo');
      expect(detectTestRunner(tmpDir)).toBe('go');
    });

    test('returns unknown when no runner detected', () => {
      expect(detectTestRunner(tmpDir)).toBe('unknown');
    });
  });

  describe('verifySpec', () => {
    let tmpDir;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'caws-verify-'));
    });

    afterEach(async () => {
      await fs.remove(tmpDir);
    });

    test('marks narrative-only ACs as unchecked', () => {
      const spec = {
        id: 'TEST-001',
        title: 'Test Spec',
        acceptance_criteria: [
          { id: 'AC-1', description: 'Something works' },
        ],
      };
      const result = verifySpec(spec, tmpDir);
      expect(result.specId).toBe('TEST-001');
      expect(result.results).toHaveLength(1);
      expect(result.results[0].status).toBe('unchecked');
      expect(result.results[0].method).toBe('narrative');
    });

    test('verifies test_nodeids by file existence for unknown runner', async () => {
      await fs.ensureDir(path.join(tmpDir, 'tests'));
      await fs.writeFile(path.join(tmpDir, 'tests/auth.test.js'), 'describe("Auth", () => {});');
      const spec = {
        id: 'TEST-002',
        title: 'File Check',
        acceptance_criteria: [
          { id: 'AC-1', description: 'Auth tested', test_nodeids: ['tests/auth.test.js'] },
          { id: 'AC-2', description: 'Missing test', test_nodeids: ['tests/nonexistent.test.js'] },
        ],
      };
      const result = verifySpec(spec, tmpDir, { runner: 'unknown' });
      expect(result.results[0].status).toBe('PASS');
      expect(result.results[1].status).toBe('FAIL');
    });

    test('verifies evidence by file existence', async () => {
      await fs.ensureDir(path.join(tmpDir, 'test-results'));
      await fs.writeFile(path.join(tmpDir, 'test-results/report.json'), '{}');
      const spec = {
        id: 'TEST-003',
        title: 'Evidence Check',
        acceptance_criteria: [
          { id: 'AC-1', description: 'Has evidence', evidence: 'test-results/report.json' },
          { id: 'AC-2', description: 'Missing evidence', evidence: 'test-results/missing.json' },
        ],
      };
      const result = verifySpec(spec, tmpDir);
      expect(result.results[0].status).toBe('PASS');
      expect(result.results[1].status).toBe('FAIL');
    });

    test('test_command takes priority over test_nodeids', async () => {
      const spec = {
        id: 'TEST-004',
        title: 'Priority Check',
        acceptance_criteria: [
          {
            id: 'AC-1',
            description: 'Both fields',
            test_command: 'echo "ok"',
            test_nodeids: ['tests/nonexistent.test.js'],
          },
        ],
      };
      const result = verifySpec(spec, tmpDir);
      expect(result.results[0].method).toBe('test_command');
      expect(result.results[0].status).toBe('PASS');
    });

    test('test_command failure reports FAIL', () => {
      const spec = {
        id: 'TEST-005',
        title: 'Command Fail',
        acceptance_criteria: [
          { id: 'AC-1', description: 'Fails', test_command: 'exit 1' },
        ],
      };
      const result = verifySpec(spec, tmpDir);
      expect(result.results[0].status).toBe('FAIL');
      expect(result.results[0].method).toBe('test_command');
    });
  });

  describe('checkEvidence', () => {
    let tmpDir;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'caws-verify-'));
    });

    afterEach(async () => {
      await fs.remove(tmpDir);
    });

    test('finds evidence by direct path', async () => {
      await fs.ensureDir(path.join(tmpDir, 'reports'));
      await fs.writeFile(path.join(tmpDir, 'reports/load.json'), '{}');
      const result = checkEvidence('reports/load.json', tmpDir);
      expect(result.found).toBe(true);
    });

    test('returns not found for missing evidence', () => {
      const result = checkEvidence('reports/missing.json', tmpDir);
      expect(result.found).toBe(false);
    });

    test('searches test-results directory by ID', async () => {
      await fs.ensureDir(path.join(tmpDir, 'test-results'));
      await fs.writeFile(path.join(tmpDir, 'test-results/lc-001-report.json'), '{}');
      const result = checkEvidence('lc-001', tmpDir);
      expect(result.found).toBe(true);
    });
  });
});
