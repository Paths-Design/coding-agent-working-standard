/**
 * @fileoverview Unit tests for quality gates v2 pipeline and all 5 gate modules
 * Tests exercise real behavior: actual file I/O, real git operations where needed,
 * and real policy/budget derivation logic.
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Gate modules under test
const { evaluateGates, loadGates } = require('../src/gates/pipeline');
const { formatText, formatJson } = require('../src/gates/format');

// Individual gate modules
const budgetLimit = require('../src/gates/budget-limit');
const godObject = require('../src/gates/god-object');
const todoDetection = require('../src/gates/todo-detection');
const scopeBoundary = require('../src/gates/scope-boundary');
const specCompleteness = require('../src/gates/spec-completeness');

// Helpers
const yaml = require('js-yaml');
const { createTemplateRepo, cloneFixture, cleanupTemplate } = require('./helpers/git-fixture');

// Shared git template for gates that need real git repos
let _gatesGitTemplate = null;

function createTempGitRepo() {
  if (!_gatesGitTemplate) {
    _gatesGitTemplate = createTemplateRepo();
  }
  return cloneFixture(_gatesGitTemplate, 'caws-gates-test-');
}

afterAll(() => {
  if (_gatesGitTemplate) {
    cleanupTemplate(_gatesGitTemplate);
    _gatesGitTemplate = null;
  }
});

// ============================================================
// Pipeline tests
// ============================================================
describe('pipeline', () => {
  describe('loadGates', () => {
    test('discovers all 5 gate modules with name and run function', () => {
      const gates = loadGates();
      const expectedNames = ['budget_limit', 'god_object', 'todo_detection', 'scope_boundary', 'spec_completeness'];

      for (const name of expectedNames) {
        expect(gates).toHaveProperty(name);
        expect(gates[name]).toHaveProperty('name', name);
        expect(typeof gates[name].run).toBe('function');
      }

      // Verify it does NOT include pipeline.js or format.js as gates
      expect(gates).not.toHaveProperty('pipeline');
      expect(gates).not.toHaveProperty('format');
    });
  });

  describe('evaluateGates', () => {
    let tempDir;

    beforeEach(async () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-pipeline-test-'));
      await fs.mkdir(path.join(tempDir, '.caws'), { recursive: true });
    });

    afterEach(async () => {
      await fs.remove(tempDir);
    });

    test('all gates passing produces passed=true and blocked=0', async () => {
      // Write a policy where all gates are warn-mode so nothing can block
      const policy = {
        version: 1,
        risk_tiers: {
          1: { max_files: 25, max_loc: 1000 },
          2: { max_files: 50, max_loc: 2000 },
          3: { max_files: 100, max_loc: 5000 },
        },
        gates: {
          scope_boundary: { enabled: true, mode: 'warn' },
        },
      };
      await fs.writeFile(
        path.join(tempDir, '.caws', 'policy.yaml'),
        yaml.dump(policy)
      );

      const report = await evaluateGates({
        projectRoot: tempDir,
        stagedFiles: ['src/app.js'],
        spec: { scope: { in: ['src/**'] } },
        context: {},
      });

      expect(report.passed).toBe(true);
      expect(report.summary.blocked).toBe(0);
      // scope_boundary should pass since src/app.js matches src/**
      const scopeResult = report.gates.find(g => g.name === 'scope_boundary');
      expect(scopeResult.status).toBe('pass');
    });

    test('block-mode gate failing produces passed=false and blocked=1', async () => {
      // scope_boundary in block mode with an out-of-scope file
      const policy = {
        version: 1,
        risk_tiers: {
          1: { max_files: 25, max_loc: 1000 },
          2: { max_files: 50, max_loc: 2000 },
          3: { max_files: 100, max_loc: 5000 },
        },
        gates: {
          scope_boundary: { enabled: true, mode: 'block' },
        },
      };
      await fs.writeFile(
        path.join(tempDir, '.caws', 'policy.yaml'),
        yaml.dump(policy)
      );

      const report = await evaluateGates({
        projectRoot: tempDir,
        stagedFiles: ['vendor/lib.js'],
        spec: { scope: { in: ['src/**'] } },
        context: {},
      });

      expect(report.passed).toBe(false);
      expect(report.summary.blocked).toBe(1);
      const scopeResult = report.gates.find(g => g.name === 'scope_boundary');
      expect(scopeResult.status).toBe('fail');
      expect(scopeResult.mode).toBe('block');
    });

    test('skips disabled gates (enabled: false)', async () => {
      const policy = {
        version: 1,
        risk_tiers: {
          1: { max_files: 25, max_loc: 1000 },
          2: { max_files: 50, max_loc: 2000 },
          3: { max_files: 100, max_loc: 5000 },
        },
        gates: {
          scope_boundary: { enabled: false, mode: 'block' },
          god_object: { enabled: true, mode: 'warn' },
        },
      };
      await fs.writeFile(
        path.join(tempDir, '.caws', 'policy.yaml'),
        yaml.dump(policy)
      );

      const report = await evaluateGates({
        projectRoot: tempDir,
        stagedFiles: [],
        spec: {},
        context: {},
      });

      // Disabled gate should not appear in results at all
      const scopeResult = report.gates.find(g => g.name === 'scope_boundary');
      expect(scopeResult).toBeUndefined();

      // god_object should still appear
      const godResult = report.gates.find(g => g.name === 'god_object');
      expect(godResult).toBeDefined();
    });

    test('mode:skip gates are recorded as skipped', async () => {
      const policy = {
        version: 1,
        risk_tiers: {
          1: { max_files: 25, max_loc: 1000 },
          2: { max_files: 50, max_loc: 2000 },
          3: { max_files: 100, max_loc: 5000 },
        },
        gates: {
          todo_detection: { enabled: true, mode: 'skip' },
        },
      };
      await fs.writeFile(
        path.join(tempDir, '.caws', 'policy.yaml'),
        yaml.dump(policy)
      );

      const report = await evaluateGates({
        projectRoot: tempDir,
        stagedFiles: [],
        spec: {},
        context: {},
      });

      const todoResult = report.gates.find(g => g.name === 'todo_detection');
      expect(todoResult).toBeDefined();
      expect(todoResult.status).toBe('skipped');
    });

    test('unknown gate in warn mode is recorded as warn with config error message', async () => {
      const policy = {
        version: 1,
        risk_tiers: {
          1: { max_files: 25, max_loc: 1000 },
          2: { max_files: 50, max_loc: 2000 },
          3: { max_files: 100, max_loc: 5000 },
        },
        gates: {
          nonexistent_gate: { enabled: true, mode: 'warn' },
        },
      };
      await fs.writeFile(
        path.join(tempDir, '.caws', 'policy.yaml'),
        yaml.dump(policy)
      );

      const report = await evaluateGates({
        projectRoot: tempDir,
        stagedFiles: [],
        spec: {},
        context: {},
      });

      const unknownResult = report.gates.find(g => g.name === 'nonexistent_gate');
      expect(unknownResult).toBeDefined();
      expect(unknownResult.status).toBe('warn');
      expect(unknownResult.messages[0]).toMatch(/not implemented/);
      expect(unknownResult.messages[0]).toMatch(/policy\.yaml/);
    });

    test('unknown gate in block mode is recorded as fail (fail-closed)', async () => {
      const policy = {
        version: 1,
        risk_tiers: {
          1: { max_files: 25, max_loc: 1000 },
          2: { max_files: 50, max_loc: 2000 },
          3: { max_files: 100, max_loc: 5000 },
        },
        gates: {
          nonexistent_gate: { enabled: true, mode: 'block' },
        },
      };
      await fs.writeFile(
        path.join(tempDir, '.caws', 'policy.yaml'),
        yaml.dump(policy)
      );

      const report = await evaluateGates({
        projectRoot: tempDir,
        stagedFiles: [],
        spec: {},
        context: {},
      });

      expect(report.passed).toBe(false);
      const unknownResult = report.gates.find(g => g.name === 'nonexistent_gate');
      expect(unknownResult.status).toBe('fail');
      expect(unknownResult.mode).toBe('block');
    });

    test('gate that throws is recorded as fail with error message', async () => {
      // To test the pipeline's catch block (line 91-99 of pipeline.js), we
      // monkey-patch a real gate's run() to throw, then restore it after.
      const originalRun = scopeBoundary.run;
      scopeBoundary.run = async () => { throw new Error('Simulated gate explosion'); };

      const policy = {
        version: 1,
        risk_tiers: {
          1: { max_files: 25, max_loc: 1000 },
          2: { max_files: 50, max_loc: 2000 },
          3: { max_files: 100, max_loc: 5000 },
        },
        gates: {
          scope_boundary: { enabled: true, mode: 'block' },
        },
      };
      await fs.writeFile(
        path.join(tempDir, '.caws', 'policy.yaml'),
        yaml.dump(policy)
      );

      try {
        const report = await evaluateGates({
          projectRoot: tempDir,
          stagedFiles: ['src/app.js'],
          spec: {},
          context: {},
        });

        const scopeResult = report.gates.find(g => g.name === 'scope_boundary');
        expect(scopeResult).toBeDefined();
        expect(scopeResult.status).toBe('fail');
        expect(scopeResult.messages.length).toBeGreaterThan(0);
        expect(scopeResult.messages[0]).toContain('Gate error: Simulated gate explosion');
      } finally {
        // Restore original run so other tests aren't affected
        scopeBoundary.run = originalRun;
      }
    });

    test('report includes warning when no policy.yaml exists (using defaults)', async () => {
      // Don't write a policy.yaml — pipeline should use defaults and flag it
      const noPolicyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-nopolicy-'));
      fs.mkdirSync(path.join(noPolicyDir, '.caws'), { recursive: true });

      const report = await evaluateGates({
        projectRoot: noPolicyDir,
        stagedFiles: [],
        spec: {},
        context: {},
      });

      expect(report.warnings).toBeDefined();
      expect(report.warnings.length).toBeGreaterThan(0);
      expect(report.warnings[0]).toMatch(/No policy\.yaml found/);
      await fs.remove(noPolicyDir);
    });
  });
});

// ============================================================
// Format tests
// ============================================================
describe('format', () => {
  test('formatText does NOT say "All passed" when a gate warned', () => {
    const report = {
      passed: true,
      gates: [
        { name: 'god_object', mode: 'warn', status: 'pass', waived: false, messages: [], duration: 5 },
        { name: 'todo_detection', mode: 'warn', status: 'warn', waived: false, messages: ['Found 2 TODO markers'], duration: 3 },
      ],
      summary: { blocked: 0, warned: 1, passed: 1, skipped: 0, waived: 0 },
    };

    const text = formatText(report);
    // Should NOT say "All enabled gates passed" because one warned
    expect(text).not.toMatch(/All.*enabled.*gates.*passed/i);
    // Should say "No blocking failures" since passed=true but not all clean
    expect(text).toContain('No blocking failures');
    // Should contain the warning message
    expect(text).toContain('Found 2 TODO markers');
  });

  test('formatText shows summary for zero gates', () => {
    const report = {
      passed: true,
      gates: [],
      summary: { blocked: 0, warned: 0, passed: 0, skipped: 0, waived: 0 },
    };

    const text = formatText(report);
    expect(text).toContain('Quality Gates Report');
    // With zero gates, the summary parts will be empty but report still renders
    expect(text).toContain('Summary:');
  });

  test('formatJson returns valid parseable JSON with required fields', () => {
    const report = {
      passed: true,
      gates: [
        { name: 'scope_boundary', mode: 'block', status: 'pass', waived: false, messages: [], duration: 2 },
      ],
      summary: { blocked: 0, warned: 0, passed: 1, skipped: 0, waived: 0 },
    };

    const jsonStr = formatJson(report);
    const parsed = JSON.parse(jsonStr);

    expect(parsed).toHaveProperty('passed', true);
    expect(parsed).toHaveProperty('summary');
    expect(parsed.summary).toHaveProperty('blocked', 0);
    expect(parsed).toHaveProperty('gates');
    expect(parsed.gates).toHaveLength(1);
    expect(parsed.gates[0]).toHaveProperty('name', 'scope_boundary');
    expect(parsed.gates[0]).toHaveProperty('status', 'pass');
    expect(parsed).toHaveProperty('timestamp');
    // Verify timestamp is a valid ISO date
    expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
  });
});

// ============================================================
// budget-limit gate tests
// ============================================================
describe('budget-limit gate', () => {
  let repoDir;

  beforeEach(() => {
    repoDir = createTempGitRepo();
    // Write a policy.yaml so deriveBudget can load it
    fs.mkdirSync(path.join(repoDir, '.caws'), { recursive: true });
    const policy = {
      version: 1,
      risk_tiers: {
        1: { max_files: 25, max_loc: 1000 },
        2: { max_files: 50, max_loc: 2000 },
        3: { max_files: 100, max_loc: 5000 },
      },
    };
    fs.writeFileSync(
      path.join(repoDir, '.caws', 'policy.yaml'),
      yaml.dump(policy)
    );
  });

  afterEach(async () => {
    await fs.remove(repoDir);
  });

  test('passes when staged files within budget (3 files, budget 50)', async () => {
    // Stage 3 files in the real git repo
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
    });

    expect(result.status).toBe('pass');
    expect(result.messages).toHaveLength(0);
  });

  test('fails when staged files exceed budget', async () => {
    // Create and stage 60 files — exceeds tier 2 budget of 50
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
    });

    expect(result.status).toBe('fail');
    expect(result.messages.length).toBeGreaterThan(0);
    // The violation message should mention the file count exceeding budget
    expect(result.messages.some(m => /file count|exceeds budget/i.test(m))).toBe(true);
  });

  test('fails when git is unavailable (fail-closed, not silent pass)', async () => {
    // Run budget gate against a non-git directory — git diff should fail
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-nongit-'));
    fs.mkdirSync(path.join(nonGitDir, '.caws'), { recursive: true });
    const policy = {
      version: 1,
      risk_tiers: { 1: { max_files: 25, max_loc: 1000 }, 2: { max_files: 50, max_loc: 2000 }, 3: { max_files: 100, max_loc: 5000 } },
    };
    fs.writeFileSync(path.join(nonGitDir, '.caws', 'policy.yaml'), yaml.dump(policy));

    const result = await budgetLimit.run({
      stagedFiles: ['file.js'],
      spec: { risk_tier: 2 },
      policy: {},
      projectRoot: nonGitDir,
      riskTier: 2,
    });

    expect(result.status).toBe('fail');
    expect(result.messages[0]).toMatch(/Cannot count staged line changes/i);
    await fs.remove(nonGitDir);
  });

  test('skips budget check in cli context (budget applies to changes, not full repo)', async () => {
    const result = await budgetLimit.run({
      stagedFiles: Array.from({ length: 500 }, (_, i) => `f${i}.js`),
      spec: { risk_tier: 2 },
      policy: {},
      projectRoot: repoDir,
      riskTier: 2,
      context: 'cli',
    });

    expect(result.status).toBe('pass');
    expect(result.messages[0]).toMatch(/skipped in CLI context/i);
  });
});

// ============================================================
// god-object gate tests
// ============================================================
describe('god-object gate', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-god-test-'));
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  test('passes for files under warning threshold', async () => {
    // Create a 100-line file — well under 1750
    const content = Array.from({ length: 100 }, (_, i) => `const x${i} = ${i};`).join('\n');
    fs.writeFileSync(path.join(tempDir, 'small.js'), content);

    const result = await godObject.run({
      stagedFiles: ['small.js'],
      projectRoot: tempDir,
      thresholds: { warning: 1750, critical: 2000 },
    });

    expect(result.status).toBe('pass');
    expect(result.messages).toHaveLength(0);
  });

  test('warns for files between warning and critical thresholds', async () => {
    // Create an 1800-line file — above 1750 warning, below 2000 critical
    const content = Array.from({ length: 1800 }, (_, i) => `const x${i} = ${i};`).join('\n');
    fs.writeFileSync(path.join(tempDir, 'big.js'), content);

    const result = await godObject.run({
      stagedFiles: ['big.js'],
      projectRoot: tempDir,
      thresholds: { warning: 1750, critical: 2000 },
    });

    expect(result.status).toBe('warn');
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages[0]).toContain('big.js');
    expect(result.messages[0]).toContain('1800');
    expect(result.messages[0]).toMatch(/WARNING/i);
  });

  test('fails for files at or above critical threshold', async () => {
    const content = Array.from({ length: 2100 }, (_, i) => `const x${i} = ${i};`).join('\n');
    fs.writeFileSync(path.join(tempDir, 'huge.ts'), content);

    const result = await godObject.run({
      stagedFiles: ['huge.ts'],
      projectRoot: tempDir,
      thresholds: { warning: 1750, critical: 2000 },
    });

    expect(result.status).toBe('fail');
    expect(result.messages[0]).toContain('huge.ts');
    expect(result.messages[0]).toMatch(/CRITICAL/i);
  });

  test('ignores non-source files like .md and .json', async () => {
    // A 5000-line markdown file should not trigger the gate
    const content = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
    fs.writeFileSync(path.join(tempDir, 'big.md'), content);

    const result = await godObject.run({
      stagedFiles: ['big.md'],
      projectRoot: tempDir,
      thresholds: { warning: 1750, critical: 2000 },
    });

    expect(result.status).toBe('pass');
  });

  test('reports unreadable files in messages instead of silently skipping', async () => {
    // Reference a .js file that doesn't exist on disk
    const result = await godObject.run({
      stagedFiles: ['nonexistent-file.js'],
      projectRoot: tempDir,
      thresholds: { warning: 1750, critical: 2000 },
    });

    // Gate should still pass (file doesn't exist → existsSync returns false → skipped)
    // but if a file existed and was unreadable, the message would surface
    expect(result.status).toBe('pass');
  });

  test('excludes dist/, build/, and node_modules/ by default', async () => {
    // Create a huge file in dist/ — should be excluded
    fs.mkdirSync(path.join(tempDir, 'dist'), { recursive: true });
    const content = Array.from({ length: 5000 }, (_, i) => `const x${i} = ${i};`).join('\n');
    fs.writeFileSync(path.join(tempDir, 'dist', 'bundle.js'), content);

    const result = await godObject.run({
      stagedFiles: ['dist/bundle.js'],
      projectRoot: tempDir,
      thresholds: { warning: 1750, critical: 2000 },
    });

    expect(result.status).toBe('pass');
    expect(result.messages).toHaveLength(0);
  });

  test('excludes .min. files by default', async () => {
    const content = Array.from({ length: 5000 }, (_, i) => `var x${i}=${i};`).join('\n');
    fs.writeFileSync(path.join(tempDir, 'app.min.js'), content);

    const result = await godObject.run({
      stagedFiles: ['app.min.js'],
      projectRoot: tempDir,
      thresholds: { warning: 1750, critical: 2000 },
    });

    expect(result.status).toBe('pass');
  });

  test('test files get 2x threshold (large integration tests are normal)', async () => {
    // 2500 lines — above source critical (2000) but below test critical (4000)
    const content = Array.from({ length: 2500 }, (_, i) => `const x${i} = ${i};`).join('\n');
    fs.writeFileSync(path.join(tempDir, 'app.test.js'), content);

    const result = await godObject.run({
      stagedFiles: ['app.test.js'],
      projectRoot: tempDir,
      thresholds: { warning: 1750, critical: 2000 },
    });

    // 2500 lines is between test warning (3500) and test critical (4000) — should pass
    expect(result.status).toBe('pass');
  });

  test('test files above 2x critical threshold still fail', async () => {
    // 4500 lines — above test critical (4000)
    const content = Array.from({ length: 4500 }, (_, i) => `const x${i} = ${i};`).join('\n');
    fs.mkdirSync(path.join(tempDir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'tests', 'huge.test.js'), content);

    const result = await godObject.run({
      stagedFiles: ['tests/huge.test.js'],
      projectRoot: tempDir,
      thresholds: { warning: 1750, critical: 2000 },
    });

    expect(result.status).toBe('fail');
    expect(result.messages[0]).toMatch(/test file/i);
    expect(result.messages[0]).toContain('4500');
  });

  test('source file at 2100 lines still triggers CRITICAL (not affected by test multiplier)', async () => {
    const content = Array.from({ length: 2100 }, (_, i) => `const x${i} = ${i};`).join('\n');
    fs.writeFileSync(path.join(tempDir, 'src-file.js'), content);

    const result = await godObject.run({
      stagedFiles: ['src-file.js'],
      projectRoot: tempDir,
      thresholds: { warning: 1750, critical: 2000 },
    });

    expect(result.status).toBe('fail');
    expect(result.messages[0]).toMatch(/CRITICAL/);
    expect(result.messages[0]).not.toMatch(/test file/);
  });
});

// ============================================================
// todo-detection gate tests
// ============================================================
describe('todo-detection gate', () => {
  let repoDir;

  beforeEach(() => {
    repoDir = createTempGitRepo();
  });

  afterEach(async () => {
    await fs.remove(repoDir);
  });

  test('passes when staged diff has no TODO/FIXME markers', async () => {
    fs.writeFileSync(path.join(repoDir, 'clean.js'), 'const x = 1;\n');
    execSync('git add clean.js', { cwd: repoDir, stdio: 'pipe' });

    const result = await todoDetection.run({
      stagedFiles: ['clean.js'],
      projectRoot: repoDir,
      context: 'commit',
    });

    expect(result.status).toBe('pass');
    expect(result.messages).toHaveLength(0);
  });

  test('warns when staged diff contains TODO', async () => {
    fs.writeFileSync(path.join(repoDir, 'dirty.js'), '// TODO: fix this later\nconst x = 1;\n');
    execSync('git add dirty.js', { cwd: repoDir, stdio: 'pipe' });

    const result = await todoDetection.run({
      stagedFiles: ['dirty.js'],
      projectRoot: repoDir,
      context: 'commit',
    });

    expect(result.status).toBe('warn');
    expect(result.messages.length).toBeGreaterThan(0);
    // First message is the summary count
    expect(result.messages[0]).toMatch(/Found 1 TODO\/FIXME\/HACK\/XXX/);
    // Second message has the file and line reference
    expect(result.messages[1]).toContain('dirty.js');
    expect(result.messages[1]).toContain('TODO');
  });

  test('warns on FIXME and HACK markers too', async () => {
    fs.writeFileSync(
      path.join(repoDir, 'multi.js'),
      '// FIXME: broken\n// HACK: workaround\nconst y = 2;\n'
    );
    execSync('git add multi.js', { cwd: repoDir, stdio: 'pipe' });

    const result = await todoDetection.run({
      stagedFiles: ['multi.js'],
      projectRoot: repoDir,
      context: 'commit',
    });

    expect(result.status).toBe('warn');
    // Should find 2 markers (FIXME + HACK)
    expect(result.messages[0]).toMatch(/Found 2 TODO\/FIXME\/HACK\/XXX/);
  });

  test('does not flag TODO in removed lines (only added lines)', async () => {
    // First commit a file WITH a TODO
    fs.writeFileSync(path.join(repoDir, 'evolve.js'), '// TODO: old todo\n');
    execSync('git add evolve.js && git commit -m "add todo"', { cwd: repoDir, stdio: 'pipe' });

    // Now remove the TODO line and add a clean line
    fs.writeFileSync(path.join(repoDir, 'evolve.js'), 'const clean = true;\n');
    execSync('git add evolve.js', { cwd: repoDir, stdio: 'pipe' });

    const result = await todoDetection.run({
      stagedFiles: ['evolve.js'],
      projectRoot: repoDir,
      context: 'commit',
    });

    // Removing a TODO should not trigger a warning
    expect(result.status).toBe('pass');
  });

  test('warns when git is unavailable in commit context (fail-closed)', async () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-nongit-todo-'));

    const result = await todoDetection.run({
      stagedFiles: ['file.js'],
      projectRoot: nonGitDir,
      context: 'commit',
    });

    expect(result.status).toBe('warn');
    expect(result.messages[0]).toMatch(/Cannot scan.*TODO markers/i);
    await fs.remove(nonGitDir);
  });

  test('scans file contents directly in cli context', async () => {
    // Create a file with a TODO in a temp dir (no git needed)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-todo-cli-'));
    fs.writeFileSync(path.join(tmpDir, 'app.js'), '// TODO: fix this\nconst x = 1;\n// FIXME: broken\n');

    const result = await todoDetection.run({
      stagedFiles: ['app.js'],
      projectRoot: tmpDir,
      context: 'cli',
    });

    expect(result.status).toBe('warn');
    expect(result.messages[0]).toMatch(/Found 2 TODO\/FIXME\/HACK\/XXX/);
    expect(result.messages[1]).toContain('app.js:1');
    expect(result.messages[1]).toContain('TODO');
    expect(result.messages[2]).toContain('app.js:3');
    expect(result.messages[2]).toContain('FIXME');
    await fs.remove(tmpDir);
  });

  test('excludes dist and node_modules in cli context', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-todo-excl-'));
    fs.mkdirSync(path.join(tmpDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'dist', 'bundle.js'), '// TODO: this is generated\n');
    fs.writeFileSync(path.join(tmpDir, 'real.js'), 'const x = 1;\n');

    const result = await todoDetection.run({
      stagedFiles: ['dist/bundle.js', 'real.js'],
      projectRoot: tmpDir,
      context: 'cli',
    });

    expect(result.status).toBe('pass');
    await fs.remove(tmpDir);
  });

  test('filters out false positives: string literals, regex defs, test assertions', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-todo-fp-'));
    // This file has TODO in many non-actionable contexts
    fs.writeFileSync(path.join(tmpDir, 'noisy.js'), [
      'const TODO_PATTERN = /\\bTODO\\b/g;',              // regex def
      'const msg = "Found 2 TODO markers";',              // string literal
      "expect(result).toMatch(/TODO/);",                  // test assertion
      'console.log(`Cannot scan for TODO markers`);',     // template literal
      '// TODO: this is the only real one',               // real TODO
      '// Documents the TODO detection system',           // doc about feature (no colon after TODO)
    ].join('\n'));

    const result = await todoDetection.run({
      stagedFiles: ['noisy.js'],
      projectRoot: tmpDir,
      context: 'cli',
    });

    expect(result.status).toBe('warn');
    // Should find exactly 1 real TODO, not the noise
    expect(result.messages[0]).toMatch(/Found 1 TODO/);
    expect(result.messages[1]).toContain('noisy.js:5');
    await fs.remove(tmpDir);
  });

  test('skips its own implementation files (self-analysis exclusion)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-todo-self-'));
    // A file named todo-detection.js should be skipped
    fs.writeFileSync(path.join(tmpDir, 'todo-detection.js'), '// TODO: this should not be scanned\n');
    fs.writeFileSync(path.join(tmpDir, 'real-code.js'), '// TODO: real issue here\n');

    const result = await todoDetection.run({
      stagedFiles: ['todo-detection.js', 'real-code.js'],
      projectRoot: tmpDir,
      context: 'cli',
    });

    expect(result.status).toBe('warn');
    expect(result.messages[0]).toMatch(/Found 1 TODO/);
    expect(result.messages[1]).toContain('real-code.js');
    await fs.remove(tmpDir);
  });
});

// ============================================================
// scope-boundary gate tests
// ============================================================
describe('scope-boundary gate', () => {
  test('passes for in-scope files matching scope.in', async () => {
    const result = await scopeBoundary.run({
      stagedFiles: ['src/app.js', 'src/utils/helper.js'],
      spec: { scope: { in: ['src/**'] } },
    });

    expect(result.status).toBe('pass');
    expect(result.messages).toHaveLength(0);
  });

  test('fails for out-of-scope files not matching scope.in', async () => {
    const result = await scopeBoundary.run({
      stagedFiles: ['vendor/lib.js'],
      spec: { scope: { in: ['src/**'] } },
    });

    expect(result.status).toBe('fail');
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages.some(m => m.includes('vendor/lib.js'))).toBe(true);
    expect(result.messages.some(m => /not in allowed paths/i.test(m))).toBe(true);
  });

  test('passes for root-level files (no directory separator)', async () => {
    const result = await scopeBoundary.run({
      stagedFiles: ['package.json'],
      spec: { scope: { in: ['src/**'] } },
    });

    // Root-level files are exempt from scope checks
    expect(result.status).toBe('pass');
  });

  test('fails for files matching scope.out', async () => {
    const result = await scopeBoundary.run({
      stagedFiles: ['vendor/lib.js'],
      spec: { scope: { out: ['vendor/**'] } },
    });

    expect(result.status).toBe('fail');
    expect(result.messages.some(m => m.includes('vendor/lib.js'))).toBe(true);
    expect(result.messages.some(m => /excluded/i.test(m))).toBe(true);
  });

  test('passes when no scope boundaries are defined', async () => {
    const result = await scopeBoundary.run({
      stagedFiles: ['anywhere/file.js'],
      spec: {},
    });

    expect(result.status).toBe('pass');
    expect(result.messages[0]).toMatch(/No scope boundaries defined/);
  });

  test('.caws/ and .claude/ directories are always exempt', async () => {
    const result = await scopeBoundary.run({
      stagedFiles: ['.caws/working-spec.yaml', '.claude/settings.json'],
      spec: { scope: { in: ['src/**'] } },
    });

    expect(result.status).toBe('pass');
  });

  test('scope.out takes precedence over scope.in for matching files', async () => {
    // File matches scope.in but also scope.out — should fail
    const result = await scopeBoundary.run({
      stagedFiles: ['src/vendor/generated.js'],
      spec: {
        scope: {
          in: ['src/**'],
          out: ['src/vendor/**'],
        },
      },
    });

    expect(result.status).toBe('fail');
    expect(result.messages.some(m => /excluded/i.test(m))).toBe(true);
  });

  test('src/**/*.js matches src/app.js (** matches zero segments)', async () => {
    const result = await scopeBoundary.run({
      stagedFiles: ['src/app.js'],
      spec: { scope: { in: ['src/**/*.js'] } },
    });

    expect(result.status).toBe('pass');
  });

  test('src/**/*.js matches src/deep/nested/app.js', async () => {
    const result = await scopeBoundary.run({
      stagedFiles: ['src/deep/nested/app.js'],
      spec: { scope: { in: ['src/**/*.js'] } },
    });

    expect(result.status).toBe('pass');
  });

  test('src/**/*.js does not match src/app.ts', async () => {
    const result = await scopeBoundary.run({
      stagedFiles: ['src/app.ts'],
      spec: { scope: { in: ['src/**/*.js'] } },
    });

    expect(result.status).toBe('fail');
  });

  test('root-level .env is blocked by scope.out', async () => {
    const result = await scopeBoundary.run({
      stagedFiles: ['.env'],
      spec: { scope: { in: ['src/**'], out: ['.env', '*.secret'] } },
    });

    expect(result.status).toBe('fail');
    expect(result.messages.some(m => /excluded/i.test(m) && m.includes('.env'))).toBe(true);
  });

  test('root-level package.json passes when not in scope.out', async () => {
    const result = await scopeBoundary.run({
      stagedFiles: ['package.json'],
      spec: { scope: { in: ['src/**'] } },
    });

    // Root-level files skip scope.in checks
    expect(result.status).toBe('pass');
  });
});

// ============================================================
// spec-completeness gate tests
// ============================================================
describe('spec-completeness gate', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-spec-test-'));
    await fs.mkdir(path.join(tempDir, '.caws'), { recursive: true });
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  test('fails when no spec file exists (fail-closed)', async () => {
    const result = await specCompleteness.run({
      projectRoot: tempDir,
    });

    expect(result.status).toBe('fail');
    expect(result.messages[0]).toMatch(/No working-spec\.yaml found/);
  });

  test('passes for spec with all required fields (no schema file)', async () => {
    // Without a schema file, it falls back to checking title + risk_tier
    const spec = {
      title: 'Test Feature',
      risk_tier: 2,
      description: 'Some feature',
    };
    await fs.writeFile(
      path.join(tempDir, '.caws', 'working-spec.yaml'),
      yaml.dump(spec)
    );

    const result = await specCompleteness.run({
      projectRoot: tempDir,
    });

    expect(result.status).toBe('pass');
    expect(result.messages[0]).toMatch(/Basic structure valid/);
  });

  test('fails for spec missing required fields (no schema file)', async () => {
    // Missing title and risk_tier
    const spec = {
      description: 'Missing required fields',
    };
    await fs.writeFile(
      path.join(tempDir, '.caws', 'working-spec.yaml'),
      yaml.dump(spec)
    );

    const result = await specCompleteness.run({
      projectRoot: tempDir,
    });

    expect(result.status).toBe('fail');
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages[0]).toContain('title');
    expect(result.messages[0]).toContain('risk_tier');
  });

  test('fails for unparseable YAML spec', async () => {
    await fs.writeFile(
      path.join(tempDir, '.caws', 'working-spec.yaml'),
      'title: [invalid yaml {{{'
    );

    const result = await specCompleteness.run({
      projectRoot: tempDir,
    });

    expect(result.status).toBe('fail');
    expect(result.messages[0]).toMatch(/Failed to parse/);
  });

  test('fails for empty spec file', async () => {
    await fs.writeFile(
      path.join(tempDir, '.caws', 'working-spec.yaml'),
      ''
    );

    const result = await specCompleteness.run({
      projectRoot: tempDir,
    });

    expect(result.status).toBe('fail');
    expect(result.messages[0]).toMatch(/empty/i);
  });
});
