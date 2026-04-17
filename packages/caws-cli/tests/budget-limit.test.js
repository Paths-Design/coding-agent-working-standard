/**
 * @fileoverview CAWSFIX-06 — budget-limit gate context semantics
 *
 * Covers acceptance criteria A1 and A2 from .caws/specs/CAWSFIX-06.yaml:
 *   A1: CLI context → gate returns status 'skipped' (not 'pass') with an
 *       explanation that budgets apply to changes, not to full-repo scans.
 *       Pipeline counts this under `skipped`, not `passed`.
 *   A2: Commit context with violations → gate returns 'fail' with the
 *       violation message, as it did before this change.
 *
 * Tests use real git repos + real policy.yaml files; no mocks for the SUT.
 *
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const yaml = require('js-yaml');

const budgetLimit = require('../src/gates/budget-limit');
const { evaluateGates } = require('../src/gates/pipeline');
const { createTemplateRepo, cloneFixture, cleanupTemplate } = require('./helpers/git-fixture');

let _template = null;

function newRepo() {
  if (!_template) _template = createTemplateRepo();
  return cloneFixture(_template, 'caws-budget-limit-test-');
}

function writePolicy(repoDir, extra = {}) {
  const policy = {
    version: 1,
    risk_tiers: {
      1: { max_files: 25, max_loc: 1000 },
      2: { max_files: 50, max_loc: 2000 },
      3: { max_files: 100, max_loc: 5000 },
    },
    gates: {
      budget_limit: { enabled: true, mode: 'block' },
    },
    ...extra,
  };
  fs.mkdirSync(path.join(repoDir, '.caws'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, '.caws', 'policy.yaml'), yaml.dump(policy));
  return policy;
}

afterAll(() => {
  if (_template) {
    cleanupTemplate(_template);
    _template = null;
  }
});

describe('CAWSFIX-06: budget-limit gate context semantics', () => {
  // ------------------------------------------------------------------
  // A1: CLI context → skipped
  // ------------------------------------------------------------------
  describe('A1: cli context returns skipped (not pass)', () => {
    let repoDir;
    beforeEach(() => {
      repoDir = newRepo();
      writePolicy(repoDir);
    });
    afterEach(async () => {
      await fs.remove(repoDir);
    });

    test('gate returns status=skipped when context=cli', async () => {
      const result = await budgetLimit.run({
        stagedFiles: Array.from({ length: 500 }, (_, i) => `f${i}.js`),
        spec: { risk_tier: 2 },
        policy: {},
        projectRoot: repoDir,
        riskTier: 2,
        context: 'cli',
      });
      expect(result.status).toBe('skipped');
    });

    test('skipped message explains budgets apply to changes, not full repo', async () => {
      const result = await budgetLimit.run({
        stagedFiles: ['ignored.js'],
        spec: { risk_tier: 2 },
        policy: {},
        projectRoot: repoDir,
        riskTier: 2,
        context: 'cli',
      });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toMatch(/skipped in CLI context/i);
      expect(result.messages[0]).toMatch(/budget applies to changes, not full repo/i);
    });

    test('pipeline summary counts budget_limit under skipped, not passed', async () => {
      const report = await evaluateGates({
        projectRoot: repoDir,
        stagedFiles: ['any-file.js'],
        spec: { id: 'TEST-1', risk_tier: 2 },
        context: 'cli',
      });

      const budgetResult = report.gates.find((g) => g.name === 'budget_limit');
      expect(budgetResult).toBeDefined();
      expect(budgetResult.status).toBe('skipped');

      // Summary accounting: skipped incremented, passed did NOT include budget.
      expect(report.summary.skipped).toBeGreaterThanOrEqual(1);
      // The gate MUST NOT contribute to passed.
      const passedGates = report.gates.filter((g) => g.status === 'pass').map((g) => g.name);
      expect(passedGates).not.toContain('budget_limit');
    });
  });

  // ------------------------------------------------------------------
  // A2: commit context with violations → fail (unchanged behavior)
  // ------------------------------------------------------------------
  describe('A2: commit context with violations still fails', () => {
    let repoDir;
    beforeEach(() => {
      repoDir = newRepo();
      writePolicy(repoDir);
    });
    afterEach(async () => {
      await fs.remove(repoDir);
    });

    test('gate returns status=fail when staged files exceed budget (commit context)', async () => {
      // Tier 2 max_files = 50; stage 60.
      for (let i = 0; i < 60; i++) {
        fs.writeFileSync(path.join(repoDir, `f${i}.js`), `// f${i}\n`);
      }
      execSync('git add .', { cwd: repoDir, stdio: 'pipe' });

      const stagedFiles = Array.from({ length: 60 }, (_, i) => `f${i}.js`);
      const result = await budgetLimit.run({
        stagedFiles,
        spec: { risk_tier: 2 },
        policy: {},
        projectRoot: repoDir,
        riskTier: 2,
        context: 'commit',
      });

      expect(result.status).toBe('fail');
      expect(result.messages.length).toBeGreaterThan(0);
      expect(result.messages.some((m) => /file count|exceeds budget/i.test(m))).toBe(true);
    });

    test('gate returns status=fail with no explicit context (defaults to commit-like behavior)', async () => {
      // Absence of context should NOT silently skip — that regression is the whole point of A1.
      for (let i = 0; i < 60; i++) {
        fs.writeFileSync(path.join(repoDir, `f${i}.js`), `// f${i}\n`);
      }
      execSync('git add .', { cwd: repoDir, stdio: 'pipe' });

      const stagedFiles = Array.from({ length: 60 }, (_, i) => `f${i}.js`);
      const result = await budgetLimit.run({
        stagedFiles,
        spec: { risk_tier: 2 },
        policy: {},
        projectRoot: repoDir,
        riskTier: 2,
        // context omitted
      });

      expect(result.status).toBe('fail');
    });

    test('staged-file counting is not regressed (pass path still works in commit context)', async () => {
      // Stage 3 files — well within tier 2 max_files of 50.
      for (let i = 0; i < 3; i++) {
        fs.writeFileSync(path.join(repoDir, `file${i}.js`), `// file ${i}\n`);
      }
      execSync('git add .', { cwd: repoDir, stdio: 'pipe' });

      const result = await budgetLimit.run({
        stagedFiles: ['file0.js', 'file1.js', 'file2.js'],
        spec: { risk_tier: 2 },
        policy: {},
        projectRoot: repoDir,
        riskTier: 2,
        context: 'commit',
      });

      expect(result.status).toBe('pass');
      expect(result.messages).toHaveLength(0);
    });
  });
});
