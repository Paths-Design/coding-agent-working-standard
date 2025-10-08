/**
 * CAWS Evaluate Command
 *
 * Evaluates work against CAWS quality standards and provides
 * actionable feedback on meeting acceptance criteria.
 *
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const chalk = require('chalk');
const { initializeGlobalSetup } = require('../config');

/**
 * Evaluate command handler
 *
 * @param {string} specFile - Path to working spec file
 * @param {object} options - Command options
 */
async function evaluateCommand(specFile = '.caws/working-spec.yaml', options = {}) {
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

    console.log(chalk.blue('\n📊 Evaluating CAWS Quality Standards\n'));
    console.log('─'.repeat(60));

    // Evaluation results
    const results = {
      score: 0,
      maxScore: 0,
      checks: [],
      recommendations: [],
      warnings: [],
    };

    // 1. Check working spec validity
    results.maxScore += 10;
    if (spec.id && spec.title && spec.risk_tier && spec.mode) {
      results.score += 10;
      results.checks.push({ name: 'Working Spec Structure', status: 'pass', points: 10 });
    } else {
      results.checks.push({ name: 'Working Spec Structure', status: 'fail', points: 0 });
      results.warnings.push('Working spec missing required fields');
    }

    // 2. Check acceptance criteria
    results.maxScore += 15;
    if (spec.acceptance && spec.acceptance.length > 0) {
      const validCriteria = spec.acceptance.filter((a) => a.id && a.given && a.when && a.then);
      const criteriaScore = Math.floor((validCriteria.length / spec.acceptance.length) * 15);
      results.score += criteriaScore;
      results.checks.push({
        name: 'Acceptance Criteria',
        status: criteriaScore === 15 ? 'pass' : 'partial',
        points: criteriaScore,
        detail: `${validCriteria.length}/${spec.acceptance.length} complete`,
      });

      if (criteriaScore < 15) {
        results.recommendations.push(
          'Complete all acceptance criteria with Given-When-Then format'
        );
      }
    } else {
      results.checks.push({ name: 'Acceptance Criteria', status: 'fail', points: 0 });
      results.warnings.push('No acceptance criteria defined');
    }

    // 3. Check scope definition
    results.maxScore += 10;
    if (spec.scope && spec.scope.in && spec.scope.in.length > 0) {
      results.score += 10;
      results.checks.push({ name: 'Scope Definition', status: 'pass', points: 10 });
    } else {
      results.checks.push({ name: 'Scope Definition', status: 'fail', points: 0 });
      results.warnings.push('Scope not clearly defined');
    }

    // 4. Check change budget
    results.maxScore += 10;
    if (spec.change_budget && spec.change_budget.max_files && spec.change_budget.max_loc) {
      results.score += 10;
      results.checks.push({ name: 'Change Budget', status: 'pass', points: 10 });
    } else {
      results.checks.push({ name: 'Change Budget', status: 'fail', points: 0 });
      results.recommendations.push('Define change budget (max_files, max_loc)');
    }

    // 5. Check invariants
    results.maxScore += 10;
    if (spec.invariants && spec.invariants.length > 0) {
      results.score += 10;
      results.checks.push({ name: 'System Invariants', status: 'pass', points: 10 });
    } else {
      results.checks.push({ name: 'System Invariants', status: 'partial', points: 5 });
      results.recommendations.push('Define system invariants to maintain');
    }

    // 6. Check non-functional requirements
    results.maxScore += 15;
    let nfrScore = 0;
    if (spec.non_functional) {
      if (spec.non_functional.a11y && spec.non_functional.a11y.length > 0) nfrScore += 5;
      if (spec.non_functional.perf && spec.non_functional.perf.api_p95_ms) nfrScore += 5;
      if (spec.non_functional.security && spec.non_functional.security.length > 0) nfrScore += 5;
    }
    results.score += nfrScore;
    results.checks.push({
      name: 'Non-Functional Requirements',
      status: nfrScore === 15 ? 'pass' : 'partial',
      points: nfrScore,
    });

    if (nfrScore < 15) {
      results.recommendations.push('Define a11y, performance, and security requirements');
    }

    // 7. Check rollback plan
    results.maxScore += 10;
    if (spec.rollback && spec.rollback.length > 0) {
      results.score += 10;
      results.checks.push({ name: 'Rollback Plan', status: 'pass', points: 10 });
    } else {
      results.checks.push({ name: 'Rollback Plan', status: 'fail', points: 0 });
      results.recommendations.push('Document rollback procedures');
    }

    // 8. Check observability
    results.maxScore += 10;
    if (
      spec.observability &&
      (spec.observability.logs?.length > 0 ||
        spec.observability.metrics?.length > 0 ||
        spec.observability.traces?.length > 0)
    ) {
      results.score += 10;
      results.checks.push({ name: 'Observability', status: 'pass', points: 10 });
    } else {
      results.checks.push({ name: 'Observability', status: 'partial', points: 3 });
      results.recommendations.push('Define logging, metrics, and tracing strategy');
    }

    // 9. Risk tier appropriateness
    results.maxScore += 10;
    const hasCriticalScope = spec.blast_radius?.modules?.some(
      (m) => m.includes('auth') || m.includes('payment') || m.includes('billing')
    );
    const hasDataMigration = spec.blast_radius?.data_migration === true;

    if (hasCriticalScope || hasDataMigration) {
      if (spec.risk_tier === 1) {
        results.score += 10;
        results.checks.push({ name: 'Risk Tier Appropriateness', status: 'pass', points: 10 });
      } else {
        results.checks.push({ name: 'Risk Tier Appropriateness', status: 'fail', points: 0 });
        results.warnings.push(`Risk tier ${spec.risk_tier} may be too low for critical changes`);
      }
    } else {
      results.score += 10;
      results.checks.push({ name: 'Risk Tier Appropriateness', status: 'pass', points: 10 });
    }

    // Display results
    console.log('\n📋 Quality Checks:\n');
    results.checks.forEach((check) => {
      const icon = check.status === 'pass' ? '✅' : check.status === 'partial' ? '⚠️' : '❌';
      const detail = check.detail ? ` (${check.detail})` : '';
      console.log(
        `${icon} ${check.name}: ${check.points}/${results.maxScore / results.checks.length}${detail}`
      );
    });

    // Calculate percentage
    const percentage = Math.round((results.score / results.maxScore) * 100);
    const grade =
      percentage >= 90
        ? 'A'
        : percentage >= 80
          ? 'B'
          : percentage >= 70
            ? 'C'
            : percentage >= 60
              ? 'D'
              : 'F';

    console.log('\n' + '─'.repeat(60));
    console.log(
      chalk.bold(
        `\n📊 Overall Score: ${results.score}/${results.maxScore} (${percentage}%) - Grade: ${grade}\n`
      )
    );

    // Display warnings
    if (results.warnings.length > 0) {
      console.log(chalk.yellow('⚠️  Warnings:\n'));
      results.warnings.forEach((warning) => {
        console.log(chalk.yellow(`   • ${warning}`));
      });
      console.log();
    }

    // Display recommendations
    if (results.recommendations.length > 0) {
      console.log(chalk.blue('💡 Recommendations:\n'));
      results.recommendations.forEach((rec) => {
        console.log(chalk.blue(`   • ${rec}`));
      });
      console.log();
    }

    // Risk tier specific guidance
    console.log(chalk.bold(`\n🎯 Risk Tier ${spec.risk_tier} Requirements:\n`));

    const tierRequirements = {
      1: {
        coverage: '90%+',
        mutation: '70%+',
        contracts: 'Required',
        review: 'Manual code review required',
      },
      2: {
        coverage: '80%+',
        mutation: '50%+',
        contracts: 'Required for external APIs',
        review: 'Optional',
      },
      3: {
        coverage: '70%+',
        mutation: '30%+',
        contracts: 'Optional',
        review: 'Optional',
      },
    };

    const req = tierRequirements[spec.risk_tier] || tierRequirements[2];
    console.log(`   Branch Coverage: ${req.coverage}`);
    console.log(`   Mutation Score: ${req.mutation}`);
    console.log(`   Contract Tests: ${req.contracts}`);
    console.log(`   Code Review: ${req.review}`);

    console.log(chalk.blue('\n📚 Next Steps:\n'));
    console.log('   1. Address warnings and recommendations above');
    console.log('   2. Implement acceptance criteria with tests');
    console.log('   3. Run: caws validate to check spec validity');
    console.log('   4. Run: caws diagnose for health checks');
    console.log('   5. Ensure test coverage meets risk tier requirements');

    // Exit with appropriate code
    if (percentage < 70) {
      console.log(
        chalk.red('\n⚠️  Quality score below 70% - improvements needed before proceeding\n')
      );
      process.exit(1);
    } else if (percentage < 90) {
      console.log(chalk.yellow('\n⚠️  Quality score acceptable but improvements recommended\n'));
    } else {
      console.log(chalk.green('\n✅ Excellent quality score - ready to proceed!\n'));
    }
  } catch (error) {
    console.error(chalk.red(`\n❌ Evaluation failed: ${error.message}`));
    if (options.verbose) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

module.exports = { evaluateCommand };
