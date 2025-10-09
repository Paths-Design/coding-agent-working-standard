/**
 * CAWS Iterate Command
 *
 * Provides iterative development guidance based on current progress
 * and working spec state.
 *
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const chalk = require('chalk');
const { initializeGlobalSetup } = require('../config');

/**
 * Iterate command handler
 *
 * @param {string} specFile - Path to working spec file
 * @param {object} options - Command options
 */
async function iterateCommand(specFile = '.caws/working-spec.yaml', options = {}) {
  try {
    console.log('🔍 Detecting CAWS setup...');
    const setup = initializeGlobalSetup();

    if (setup.hasWorkingSpec) {
      console.log(`✅ Detected ${setup.setupType} CAWS setup`);
      console.log(`   Capabilities: ${setup.capabilities.join(', ')}`);
    }

    // Load working spec
    const specPath = path.isAbsolute(specFile) ? specFile : path.join(process.cwd(), specFile);

    if (!fs.existsSync(specPath)) {
      console.error(chalk.red(`\n❌ Working spec not found: ${specFile}`));
      console.error(chalk.yellow('💡 Run: caws init to create a working spec'));
      process.exit(1);
    }

    const specContent = fs.readFileSync(specPath, 'utf8');
    const spec = yaml.load(specContent);

    // Parse current state from options
    const currentState = options.currentState ? JSON.parse(options.currentState) : {};
    const stateDescription = currentState.description || 'Starting implementation';

    console.log(chalk.blue('\n🔄 Iterative Development Guidance\n'));
    console.log('─'.repeat(60));
    console.log(chalk.bold(`\nProject: ${spec.title}`));
    console.log(`ID: ${spec.id} | Tier: ${spec.risk_tier} | Mode: ${spec.mode}`);
    console.log(`Current State: ${stateDescription}\n`);

    // Analyze progress based on mode
    const guidance = generateGuidance(spec, currentState, options);

    // Display guidance
    console.log(chalk.blue('📋 Current Phase:\n'));
    console.log(`   ${guidance.phase}\n`);

    console.log(chalk.blue('✅ Completed Steps:\n'));
    guidance.completed.forEach((step) => {
      console.log(chalk.green(`   ✓ ${step}`));
    });

    console.log(chalk.blue('\n🎯 Next Actions:\n'));
    guidance.nextActions.forEach((action, index) => {
      console.log(chalk.yellow(`   ${index + 1}. ${action}`));
    });

    if (guidance.blockers.length > 0) {
      console.log(chalk.red('\n⚠️  Blockers:\n'));
      guidance.blockers.forEach((blocker) => {
        console.log(chalk.red(`   ⚠️  ${blocker}`));
      });
    }

    console.log(chalk.blue('\n💡 Recommendations:\n'));
    guidance.recommendations.forEach((rec) => {
      console.log(chalk.blue(`   • ${rec}`));
    });

    // Acceptance criteria checklist with detailed progress
    if (spec.acceptance && spec.acceptance.length > 0) {
      console.log(chalk.blue('\n📊 Acceptance Criteria Progress:\n'));

      let totalTestsWritten = 0;
      let totalTestsPassing = 0;
      let totalCoverage = 0;
      let criteriaWithProgress = 0;

      spec.acceptance.forEach((criterion, _index) => {
        // Support both old format (boolean completed) and new format (detailed progress)
        let status = '⬜';
        let progressInfo = '';

        if (criterion.status) {
          // New detailed format
          switch (criterion.status) {
            case 'completed':
              status = '✅';
              break;
            case 'in_progress':
              status = '🔄';
              break;
            case 'pending':
            default:
              status = '⬜';
              break;
          }

          // Show detailed progress if available
          if (criterion.tests) {
            const written = criterion.tests.written || 0;
            const passing = criterion.tests.passing || 0;
            progressInfo = ` (${passing}/${written} tests passing`;

            if (criterion.coverage !== undefined) {
              progressInfo += `, ${criterion.coverage.toFixed(1)}% coverage`;
            }
            progressInfo += ')';

            totalTestsWritten += written;
            totalTestsPassing += passing;
            if (criterion.coverage !== undefined) {
              totalCoverage += criterion.coverage;
              criteriaWithProgress++;
            }
          }

          if (criterion.last_updated) {
            const lastUpdate = new Date(criterion.last_updated).toLocaleDateString();
            progressInfo += ` - updated ${lastUpdate}`;
          }
        } else if (criterion.completed) {
          // Backward compatibility with old boolean format
          status = '✅';
        }

        console.log(`   ${status} ${criterion.id}: ${criterion.then}`);
        if (progressInfo) {
          console.log(chalk.gray(`      ${progressInfo}`));
        }
      });

      // Calculate overall progress
      const completed = spec.acceptance.filter(
        (a) => a.status === 'completed' || a.completed
      ).length;
      const inProgress = spec.acceptance.filter((a) => a.status === 'in_progress').length;
      const total = spec.acceptance.length;
      const completionProgress = Math.round((completed / total) * 100);

      console.log(
        chalk.bold(
          `\n   Overall Progress: ${completed}/${total} completed (${completionProgress}%)`
        )
      );
      if (inProgress > 0) {
        console.log(chalk.yellow(`   In Progress: ${inProgress} criteria`));
      }

      // Show test progress if available
      if (totalTestsWritten > 0) {
        const testProgress = Math.round((totalTestsPassing / totalTestsWritten) * 100);
        console.log(
          `   Test Progress: ${totalTestsPassing}/${totalTestsWritten} tests passing (${testProgress}%)`
        );
      }

      // Show coverage progress if available
      if (criteriaWithProgress > 0) {
        const avgCoverage = totalCoverage / criteriaWithProgress;
        console.log(`   Average Coverage: ${avgCoverage.toFixed(1)}%`);
      }
    }

    // Quality gates reminder
    console.log(chalk.blue('\n🔒 Quality Gates (Risk Tier ' + spec.risk_tier + '):\n'));
    const gates = getQualityGates(spec.risk_tier);
    gates.forEach((gate) => {
      console.log(`   □ ${gate}`);
    });

    console.log(chalk.blue('\n📚 Useful Commands:\n'));
    console.log('   caws evaluate       - Check quality score');
    console.log('   caws validate       - Validate working spec');
    console.log('   caws status         - View project health');
    console.log('   caws diagnose       - Run health checks');
    console.log('   npm test            - Run test suite');
    console.log('   npm run coverage    - Check test coverage\n');
  } catch (error) {
    console.error(chalk.red(`\n❌ Iteration guidance failed: ${error.message}`));
    if (options.verbose) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

/**
 * Generate guidance based on spec and current state
 */
function generateGuidance(spec, _currentState, _options) {
  const mode = spec.mode;
  const riskTier = spec.risk_tier;

  // Default guidance structure
  const guidance = {
    phase: 'Implementation',
    completed: [],
    nextActions: [],
    blockers: [],
    recommendations: [],
  };

  // Mode-specific guidance
  if (mode === 'feature') {
    guidance.phase = 'Feature Development';
    guidance.completed = ['Working specification created', 'Acceptance criteria defined'];
    guidance.nextActions = [
      'Write failing tests for first acceptance criterion',
      'Implement minimum code to pass tests',
      'Refactor and ensure all tests pass',
      'Move to next acceptance criterion',
    ];
    guidance.recommendations = [
      'Follow TDD cycle: Red → Green → Refactor',
      'Keep changes within scope boundaries',
      'Update working spec as requirements evolve',
      `Maintain ${riskTier === 1 ? '90%+' : riskTier === 2 ? '80%+' : '70%+'} test coverage`,
    ];
  } else if (mode === 'refactor') {
    guidance.phase = 'Refactoring';
    guidance.completed = ['Working specification created', 'Baseline tests established'];
    guidance.nextActions = [
      'Ensure all existing tests pass',
      'Make small, incremental refactoring changes',
      'Run tests after each change',
      'Update documentation as needed',
    ];
    guidance.recommendations = [
      'No behavior changes - tests must still pass',
      'Use codemod scripts for large-scale changes',
      'Generate semantic diff report',
      'Keep commits small and atomic',
    ];
    guidance.blockers = [
      !spec.contracts?.length ? 'No contracts defined to prove unchanged behavior' : null,
    ].filter(Boolean);
  } else if (mode === 'fix') {
    guidance.phase = 'Bug Fix';
    guidance.completed = ['Working specification created', 'Bug reproduced'];
    guidance.nextActions = [
      'Write failing test that reproduces the bug',
      'Implement minimal fix',
      'Verify test passes',
      'Add regression tests',
    ];
    guidance.recommendations = [
      'Keep fix scope minimal',
      'Document root cause in working spec',
      'Add edge case tests to prevent recurrence',
      'Consider if similar bugs exist elsewhere',
    ];
  } else if (mode === 'doc') {
    guidance.phase = 'Documentation';
    guidance.completed = ['Working specification created'];
    guidance.nextActions = [
      'Update README with current information',
      'Add code examples and usage snippets',
      'Update API documentation',
      'Review and update troubleshooting guides',
    ];
    guidance.recommendations = [
      'Use Mermaid for diagrams',
      'Include code examples that actually work',
      'Keep docs in sync with code',
      'Add links to related documentation',
    ];
  } else if (mode === 'chore') {
    guidance.phase = 'Maintenance';
    guidance.completed = ['Working specification created'];
    guidance.nextActions = [
      'Update dependencies to latest versions',
      'Run tests to ensure compatibility',
      'Update CI/CD configurations',
      'Commit changes with descriptive message',
    ];
    guidance.recommendations = [
      'Review changelogs for breaking changes',
      'Test locally before committing',
      'Update lockfiles',
      'Document any configuration changes',
    ];
  }

  // Check for common blockers
  if (!fs.existsSync(path.join(process.cwd(), 'package.json'))) {
    guidance.blockers.push('No package.json found');
  }

  if (spec.change_budget && !spec.change_budget.max_files) {
    guidance.blockers.push('Change budget not defined');
  }

  return guidance;
}

/**
 * Get quality gates for risk tier
 */
function getQualityGates(riskTier) {
  const gates = {
    1: [
      'Branch coverage ≥ 90%',
      'Mutation score ≥ 70%',
      'All contract tests passing',
      'Manual code review completed',
      'No SAST/secret scan violations',
      'Performance budgets met',
    ],
    2: [
      'Branch coverage ≥ 80%',
      'Mutation score ≥ 50%',
      'Contract tests passing (if external APIs)',
      'E2E smoke tests passing',
      'No security violations',
    ],
    3: [
      'Branch coverage ≥ 70%',
      'Mutation score ≥ 30%',
      'Integration happy-path tests passing',
      'Linting passing',
    ],
  };

  return gates[riskTier] || gates[2];
}

module.exports = { iterateCommand };
