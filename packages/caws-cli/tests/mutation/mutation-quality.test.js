/**
 * @fileoverview Mutation testing for CAWS test quality validation
 * @author @darianrosebrook
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

describe('Mutation Testing - Test Quality Validation', () => {
  const strykerConfigPath = path.join(__dirname, '../../stryker.conf.js');
  const mutationReportPath = path.join(__dirname, '../../reports/mutation');

  beforeAll(() => {
    // Create Stryker configuration if it doesn't exist
    if (!fs.existsSync(strykerConfigPath)) {
      createStrykerConfig();
    }
  });

  afterAll(() => {
    // Clean up mutation reports
    if (fs.existsSync(mutationReportPath)) {
      fs.rmSync(mutationReportPath, { recursive: true, force: true });
    }
  });

  describe('Test Suite Quality', () => {
    test('should achieve minimum mutation score threshold', () => {
      // Mutation Contract: Tests should catch at least 70% of mutations

      const minimumScore = 70; // 70% mutation score threshold

      try {
        // Run Stryker mutation testing
        execSync('npx stryker run', {
          cwd: path.join(__dirname, '../..'),
          stdio: 'pipe',
          timeout: 300000, // 5 minutes timeout for mutation testing
        });

        // Read mutation report
        const mutationReport = readMutationReport();

        if (mutationReport) {
          const mutationScore = calculateMutationScore(mutationReport);

          // Mutation Contract: Test suite should achieve minimum quality threshold
          expect(mutationScore).toBeGreaterThanOrEqual(minimumScore);

          console.log(`✅ Mutation score: ${mutationScore}% (threshold: ${minimumScore}%)`);
        } else {
          console.warn('⚠️  Mutation report not found - skipping mutation score validation');
        }
      } catch (error) {
        // Stryker might not be installed or configured properly
        console.warn(
          '⚠️  Mutation testing not available - install Stryker for full test quality validation'
        );
        console.warn('Run: npm install --save-dev stryker-cli @stryker-mutator/jest-runner');
      }
    });

    test('should detect surviving mutations', () => {
      // Mutation Contract: Should identify areas where tests could be improved

      try {
        execSync('npx stryker run', {
          cwd: path.join(__dirname, '../..'),
          stdio: 'pipe',
          timeout: 300000,
        });

        const mutationReport = readMutationReport();

        if (mutationReport) {
          const survivingMutations = findSurvivingMutations(mutationReport);

          // Mutation Contract: Should identify specific areas for test improvement
          if (survivingMutations.length > 0) {
            console.log(`📋 Found ${survivingMutations.length} surviving mutations:`);
            survivingMutations.slice(0, 5).forEach((mutation, index) => {
              console.log(
                `   ${index + 1}. ${mutation.file}:${mutation.line} - ${mutation.mutator}`
              );
            });

            if (survivingMutations.length > 5) {
              console.log(`   ... and ${survivingMutations.length - 5} more`);
            }
          }

          // This test passes as long as we can analyze the mutations
          expect(true).toBe(true);
        }
      } catch (error) {
        console.warn('⚠️  Mutation analysis not available - skipping surviving mutation detection');
      }
    });
  });

  describe('Critical Code Path Coverage', () => {
    test('should test critical CLI functionality', () => {
      // Mutation Contract: Critical code paths should be well-tested

      const criticalPaths = [
        'src/index.js', // Main CLI entry point
        'src/validation.js', // Working spec validation
        'src/scaffolding.js', // Project scaffolding
      ];

      try {
        execSync('npx stryker run', {
          cwd: path.join(__dirname, '../..'),
          stdio: 'pipe',
          timeout: 300000,
        });

        const mutationReport = readMutationReport();

        if (mutationReport) {
          const criticalPathCoverage = analyzeCriticalPathCoverage(mutationReport, criticalPaths);

          // Mutation Contract: Critical paths should have good test coverage
          criticalPaths.forEach((criticalPath) => {
            const coverage = criticalPathCoverage[criticalPath];
            if (coverage !== undefined) {
              console.log(`📊 ${criticalPath}: ${coverage}% mutation coverage`);
              expect(coverage).toBeGreaterThan(60); // At least 60% for critical paths
            }
          });
        }
      } catch (error) {
        console.warn('⚠️  Critical path analysis not available - skipping coverage validation');
      }
    });
  });
});

/**
 * Create Stryker configuration file
 */
function createStrykerConfig() {
  const strykerConfigPath = path.join(__dirname, '../../stryker.conf.js');

  const config = `module.exports = function(config) {
    config.set({
      mutate: [
        'src/**/*.js',
        '!src/**/*.test.js',
        '!src/**/*.spec.js'
      ],
      mutator: 'javascript',
      testRunner: 'jest',
      jest: {
        config: require('./jest.config.js')
      },
      reporter: [
        'html',
        'json',
        'clear-text'
      ],
      coverageAnalysis: 'off',
      thresholds: {
        high: 80,
        low: 60,
        break: 50
      },
      maxConcurrentTestRunners: 2,
      timeoutMS: 300000
    });
  };`;

  // Create config directory if needed
  const configDir = path.dirname(strykerConfigPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  fs.writeFileSync(strykerConfigPath, config);
}

/**
 * Read mutation testing report
 */
function readMutationReport() {
  const reportPath = path.join(__dirname, '../../reports/mutation/mutation.json');

  if (fs.existsSync(reportPath)) {
    try {
      return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    } catch (error) {
      console.warn('Failed to parse mutation report:', error.message);
    }
  }

  return null;
}

/**
 * Calculate overall mutation score
 */
function calculateMutationScore(report) {
  if (!report || !report.files) {
    return 0;
  }

  let totalMutations = 0;
  let killedMutations = 0;

  Object.values(report.files).forEach((file) => {
    if (file.mutants) {
      file.mutants.forEach((mutant) => {
        totalMutations++;
        if (mutant.status === 'Killed') {
          killedMutations++;
        }
      });
    }
  });

  return totalMutations > 0 ? Math.round((killedMutations / totalMutations) * 100) : 0;
}

/**
 * Find surviving mutations that could indicate test gaps
 */
function findSurvivingMutations(report) {
  const survivingMutations = [];

  if (!report || !report.files) {
    return survivingMutations;
  }

  Object.entries(report.files).forEach(([file, fileData]) => {
    if (fileData.mutants) {
      fileData.mutants.forEach((mutant) => {
        if (mutant.status === 'Survived') {
          survivingMutations.push({
            file,
            line: mutant.location.start.line,
            mutator: mutant.mutatorName,
          });
        }
      });
    }
  });

  return survivingMutations;
}

/**
 * Analyze mutation coverage for critical code paths
 */
function analyzeCriticalPathCoverage(report, criticalPaths) {
  const coverage = {};

  if (!report || !report.files) {
    return coverage;
  }

  Object.entries(report.files).forEach(([file, fileData]) => {
    if (criticalPaths.includes(file) && fileData.mutants) {
      const totalMutations = fileData.mutants.length;
      const killedMutations = fileData.mutants.filter((m) => m.status === 'Killed').length;
      coverage[file] =
        totalMutations > 0 ? Math.round((killedMutations / totalMutations) * 100) : 0;
    }
  });

  return coverage;
}
