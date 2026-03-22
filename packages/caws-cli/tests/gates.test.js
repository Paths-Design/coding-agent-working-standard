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

/**
 * Create a minimal temp git repo for tests that need real git operations.
 * Returns the repo path. Caller must clean up.
 */
function createTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-gates-test-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  // Initial commit so HEAD exists
  fs.writeFileSync(path.join(dir, '.gitkeep'), '');
  execSync('git add .gitkeep && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

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

    test('unknown gate names are recorded as skipped with "Gate not implemented"', async () => {
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
      expect(unknownResult.status).toBe('skipped');
      expect(unknownResult.messages).toContain('Gate not implemented');
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
    });

    // Removing a TODO should not trigger a warning
    expect(result.status).toBe('pass');
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

  test('passes when no spec file exists (nothing to validate)', async () => {
    const result = await specCompleteness.run({
      projectRoot: tempDir,
    });

    expect(result.status).toBe('pass');
    expect(result.messages[0]).toMatch(/No spec found/);
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
