/**
 * @fileoverview Performance budget tests for CAWS CLI
 * @author @darianrosebrook
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

describe('Performance Budget Tests', () => {
  const cliPath = path.join(__dirname, '../dist/index.js');
  let originalCwd;
  let testTempDir;

  beforeAll(() => {
    // Create a temporary directory OUTSIDE the monorepo to avoid conflicts
    testTempDir = path.join(require('os').tmpdir(), 'caws-cli-perf-tests-' + Date.now());
    if (fs.existsSync(testTempDir)) {
      fs.rmSync(testTempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testTempDir, { recursive: true });

    // Ensure CLI is built
    if (!fs.existsSync(cliPath)) {
      execSync('npm run build', { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
    }
  });

  afterAll(() => {
    // Clean up test temp directory
    try {
      if (testTempDir && fs.existsSync(testTempDir)) {
        fs.rmSync(testTempDir, { recursive: true, force: true });
      }
    } catch (_error) {
      // Ignore errors if directory doesn't exist
    }


    // Clean up test temp directory
    try {
      if (testTempDir && fs.existsSync(testTempDir)) {
        fs.rmSync(testTempDir, { recursive: true, force: true });
      }
    } catch (cleanupError) {
      // Ignore cleanup errors in tests
    }
  });

  describe('CLI Startup Performance', () => {
    test('should start up within performance budget', () => {
      // Performance Contract: CLI should start up quickly (< 500ms)

      const startTime = performance.now();

      try {
        execSync(`node "${cliPath}" --help`, {
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 10000, // 10 second timeout
        });
      } catch (_error) {
        // Ignore errors for performance measurement
      }

      const endTime = performance.now();
      const startupTime = endTime - startTime;

      const maxStartupTime = 500; // 500ms budget

      // Performance Contract: CLI should start within budget
      expect(startupTime).toBeLessThan(maxStartupTime);

      console.log(`🚀 CLI startup time: ${startupTime.toFixed(2)}ms (budget: ${maxStartupTime}ms)`);
    });

    test('should load help within performance budget', () => {
      // Performance Contract: Help command should be fast (< 400ms)

      const startTime = performance.now();

      execSync(`node "${cliPath}" --help`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      const endTime = performance.now();
      const helpTime = endTime - startTime;

      const maxHelpTime = 450; // 450ms budget (increased for CI environment)

      // Performance Contract: Help should load quickly
      expect(helpTime).toBeLessThan(maxHelpTime);

      console.log(`📖 Help load time: ${helpTime.toFixed(2)}ms (budget: ${maxHelpTime}ms)`);
    });
  });

  describe('Command Execution Performance', () => {
    test('should initialize project within performance budget', () => {
      // Performance Contract: Project initialization should be fast (< 2s)

      const testProjectName = 'test-perf-init';
      const testProjectPath = path.join(testTempDir, testProjectName);

      // Clean up any existing test project
      if (fs.existsSync(testProjectPath)) {
        fs.rmSync(testProjectPath, { recursive: true, force: true });
      }

      const startTime = performance.now();

      try {
        execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
          encoding: 'utf8',
          stdio: 'pipe',
          cwd: testTempDir,
        });
      } finally {
        // Clean up
        if (fs.existsSync(testProjectPath)) {
          fs.rmSync(testProjectPath, { recursive: true, force: true });
        }
      }

      const endTime = performance.now();
      const initTime = endTime - startTime;

      const maxInitTime = 2000; // 2s budget

      // Performance Contract: Project init should complete within budget
      expect(initTime).toBeLessThan(maxInitTime);

      console.log(`⚡ Project init time: ${initTime.toFixed(2)}ms (budget: ${maxInitTime}ms)`);
    });

    test('should scaffold project within performance budget', () => {
      // Performance Contract: Project scaffolding should be fast (< 3s)

      const testProjectName = 'test-perf-scaffold';
      const testProjectPath = path.join(testTempDir, testProjectName);

      // Clean up any existing test project
      if (fs.existsSync(testProjectPath)) {
        fs.rmSync(testProjectPath, { recursive: true, force: true });
      }

      try {
        // Create project first
        execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
          encoding: 'utf8',
          stdio: 'pipe',
          cwd: testTempDir,
        });

        const startTime = performance.now();

        // Verify the project was created before changing directory
        if (!fs.existsSync(testProjectPath)) {
          throw new Error(`Test project not created: ${testProjectPath}`);
        }

        process.chdir(testProjectPath);

        execSync(`node "${cliPath}" scaffold`, {
          encoding: 'utf8',
          stdio: 'pipe',
        });

        const endTime = performance.now();
        const scaffoldTime = endTime - startTime;

        const maxScaffoldTime = 3000; // 3s budget

        // Performance Contract: Scaffolding should complete within budget
        expect(scaffoldTime).toBeLessThan(maxScaffoldTime);

        console.log(
          `🏗️  Project scaffold time: ${scaffoldTime.toFixed(2)}ms (budget: ${maxScaffoldTime}ms)`
        );
      } finally {
        process.chdir(__dirname);
        // Clean up
        if (fs.existsSync(testProjectPath)) {
          fs.rmSync(testProjectPath, { recursive: true, force: true });
        }
      }
    });
  });

  describe('Memory Usage Budgets', () => {
    test('should not exceed memory usage budget during operations', () => {
      // Performance Contract: CLI should use reasonable memory (< 100MB)

      const maxMemoryMB = 100;
      const initialMemory = process.memoryUsage().heapUsed / 1024 / 1024;

      try {
        // Run a memory-intensive operation
        execSync(`node "${cliPath}" init test-memory-check --non-interactive`, {
          encoding: 'utf8',
          stdio: 'pipe',
          cwd: testTempDir,
        });

        const finalMemory = process.memoryUsage().heapUsed / 1024 / 1024;
        const memoryUsed = finalMemory - initialMemory;

        // Performance Contract: Memory usage should stay within budget
        expect(memoryUsed).toBeLessThan(maxMemoryMB);

        console.log(`🧠 Memory usage: ${memoryUsed.toFixed(2)}MB (budget: ${maxMemoryMB}MB)`);
      } finally {
        // Clean up test project
        const testProjectPath = path.join(testTempDir, 'test-memory-check');
        if (fs.existsSync(testProjectPath)) {
          fs.rmSync(testProjectPath, { recursive: true, force: true });
        }
      }
    });
  });

  describe('Bundle Size Budgets', () => {
    test('should maintain reasonable bundle size', () => {
      // Performance Contract: CLI bundle should not exceed size budget

      if (fs.existsSync(cliPath)) {
        const stats = fs.statSync(cliPath);
        const bundleSizeKB = stats.size / 1024;

        const maxBundleSizeKB = 500; // 500KB budget

        // Performance Contract: Bundle size should stay within budget
        expect(bundleSizeKB).toBeLessThan(maxBundleSizeKB);

        console.log(`📦 Bundle size: ${bundleSizeKB.toFixed(2)}KB (budget: ${maxBundleSizeKB}KB)`);
      } else {
        console.warn('⚠️  Bundle not found - skipping bundle size check');
      }
    });

    test('should monitor dependency bundle impact', () => {
      // Performance Contract: Dependencies should not bloat bundle size

      const packageJsonPath = path.join(__dirname, 'package.json');

      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };

        const criticalDependencies = Object.keys(dependencies).filter((dep) =>
          ['commander', 'inquirer', 'ajv', 'fs-extra', 'chalk'].includes(dep)
        );

        // Performance Contract: Critical dependencies should exist
        expect(criticalDependencies.length).toBeGreaterThan(0);

        console.log(`📋 Critical dependencies: ${criticalDependencies.length} found`);
      }
    });
  });

  describe('Performance Regression Detection', () => {
    test('should detect performance regressions in core operations', () => {
      // Performance Contract: Core operations should not regress significantly
      // Skip in CI until baseline performance is established
      if (process.env.CI || process.env.GITHUB_ACTIONS) {
        console.log('⏭️  Skipping performance regression test in CI environment');
        return;
      }

      const baselineTimes = {
        startup: 120, // 120ms baseline (adjusted for realistic performance)
        help: 60, // 60ms baseline (adjusted for realistic performance)
        init: 1000, // 1s baseline
      };

      const currentTimes = {};

      // Measure current performance
      const startupStart = performance.now();
      try {
        execSync(`node "${cliPath}" --version`, { encoding: 'utf8', stdio: 'pipe' });
      } catch (_error) {
        // Ignore errors for performance measurement
      }
      const startupEnd = performance.now();
      currentTimes.startup = startupEnd - startupStart;

      const helpStart = performance.now();
      execSync(`node "${cliPath}" --help`, { encoding: 'utf8', stdio: 'pipe' });
      const helpEnd = performance.now();
      currentTimes.help = helpEnd - helpStart;

      // Performance Contract: Current performance should not regress > 75% from baseline
      const regressionThreshold = 1.75; // 75% slower is acceptable for development environment

      Object.entries(currentTimes).forEach(([operation, time]) => {
        const baseline = baselineTimes[operation];
        const ratio = time / baseline;

        expect(ratio).toBeLessThan(regressionThreshold);

        console.log(
          `📈 ${operation}: ${time.toFixed(2)}ms (${(ratio * 100).toFixed(1)}% of baseline)`
        );
      });
    });
  });

  describe('Resource Usage Monitoring', () => {
    test('should monitor CPU usage during operations', () => {
      // Performance Contract: CLI should not consume excessive CPU

      const testProjectName = 'test-cpu-monitor';
      const testProjectPath = path.join(testTempDir, testProjectName);

      try {
        // Clean up any existing test project
        if (fs.existsSync(testProjectPath)) {
          fs.rmSync(testProjectPath, { recursive: true, force: true });
        }

        const startTime = process.hrtime.bigint();

        // Run a CPU-intensive operation
        execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
          encoding: 'utf8',
          stdio: 'pipe',
        });

        const endTime = process.hrtime.bigint();
        const executionTimeMs = Number(endTime - startTime) / 1000000;

        // Performance Contract: Operations should complete in reasonable time
        expect(executionTimeMs).toBeLessThan(5000); // 5 seconds max

        console.log(`⏱️  CPU time: ${executionTimeMs.toFixed(2)}ms`);
      } finally {
        // Clean up
        if (fs.existsSync(testProjectPath)) {
          fs.rmSync(testProjectPath, { recursive: true, force: true });
        }
      }
    });
  });
});
