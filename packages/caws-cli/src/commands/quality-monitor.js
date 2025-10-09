/**
 * CAWS Quality Monitor Command
 *
 * Monitors code quality impact in real-time based on development actions.
 * Provides actionable recommendations for maintaining quality standards.
 *
 * @author @darianrosebrook
 */

const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Analyze quality impact of an action
 *
 * @param {string} action - Type of action (file_saved, code_edited, test_run)
 * @param {array} files - Files affected by the action
 * @param {object} context - Additional context information
 * @returns {object} Quality analysis
 */
function analyzeQualityImpact(action, files = [], context = {}) {
  const analysis = {
    action,
    files_affected: files?.length || 0,
    quality_impact: 'unknown',
    recommendations: [],
    risk_level: 'low',
    timestamp: new Date().toISOString(),
  };

  // Analyze based on action type
  switch (action) {
    case 'file_saved':
      analysis.quality_impact = 'code_change';
      analysis.recommendations = [
        'Run CAWS validation: caws evaluate',
        'Check for linting issues',
        'Verify test coverage if applicable',
      ];
      break;

    case 'code_edited':
      analysis.quality_impact = 'implementation_change';
      analysis.recommendations = [
        'Run unit tests for affected files',
        'Check CAWS quality gates',
        'Update documentation if public APIs changed',
      ];
      analysis.risk_level = files?.length > 5 ? 'medium' : 'low';

      // Add file-specific recommendations
      if (files.length > 0) {
        const hasTests = files.some((f) => f.includes('test') || f.includes('spec'));
        const hasConfig = files.some((f) => f.includes('config') || f.includes('.json'));

        if (hasTests) {
          analysis.recommendations.push('Run full test suite to ensure consistency');
        }
        if (hasConfig) {
          analysis.risk_level = 'high';
          analysis.recommendations.unshift('Configuration changed - validate carefully');
        }
      }
      break;

    case 'test_run':
      analysis.quality_impact = 'validation_complete';
      analysis.recommendations = [
        'Review test results',
        'Address any failing tests',
        'Update CAWS working spec if needed',
      ];
      break;

    default:
      analysis.quality_impact = 'unknown_action';
      analysis.recommendations = ['Run CAWS evaluation to assess impact'];
  }

  // Load working spec to check risk tier
  try {
    const specPath = path.join(process.cwd(), '.caws/working-spec.yaml');
    if (fs.existsSync(specPath)) {
      const spec = yaml.load(fs.readFileSync(specPath, 'utf8'));
      const projectTier = spec.risk_tier;

      analysis.project_tier = projectTier;

      // Add context-specific recommendations for high-risk projects
      if (projectTier <= 2) {
        analysis.recommendations.unshift('High-risk project (Tier ' + projectTier + '): Run comprehensive validation');
        if (analysis.risk_level === 'low') {
          analysis.risk_level = 'medium';
        } else if (analysis.risk_level === 'medium') {
          analysis.risk_level = 'high';
        }
      }

      // Add tier-specific quality gates
      if (projectTier === 1) {
        analysis.quality_gates = [
          'Branch coverage ≥ 90%',
          'Mutation score ≥ 70%',
          'All contract tests passing',
          'Manual code review required',
        ];
      } else if (projectTier === 2) {
        analysis.quality_gates = [
          'Branch coverage ≥ 80%',
          'Mutation score ≥ 50%',
          'Contract tests passing (if applicable)',
        ];
      } else {
        analysis.quality_gates = [
          'Branch coverage ≥ 70%',
          'Mutation score ≥ 30%',
        ];
      }
    }
  } catch (error) {
    // Ignore if we can't load spec
  }

  // Add context-based recommendations
  if (context.project_tier) {
    analysis.project_tier = context.project_tier;
  }

  return analysis;
}

/**
 * Quality monitor command handler
 *
 * @param {string} action - Type of action to monitor
 * @param {object} options - Command options
 */
async function qualityMonitorCommand(action, options = {}) {
  try {
    // Parse files if provided
    let files = [];
    if (options.files) {
      files = typeof options.files === 'string' 
        ? options.files.split(',').map((f) => f.trim())
        : options.files;
    }

    // Parse context if provided
    let context = {};
    if (options.context) {
      try {
        context = typeof options.context === 'string' 
          ? JSON.parse(options.context)
          : options.context;
      } catch (e) {
        console.warn(chalk.yellow('⚠️  Invalid context JSON, ignoring'));
      }
    }

    // Validate action
    const validActions = ['file_saved', 'code_edited', 'test_run'];
    if (!validActions.includes(action)) {
      console.error(chalk.red(`\n❌ Invalid action: ${action}`));
      console.log(chalk.blue('\n💡 Valid actions:'));
      validActions.forEach((a) => {
        console.log(chalk.blue(`   • ${a}`));
      });
      process.exit(1);
    }

    // Analyze quality impact
    const analysis = analyzeQualityImpact(action, files, context);

    // Display results
    console.log(chalk.bold('\n🔍 CAWS Quality Monitor\n'));
    console.log('─'.repeat(60));

    // Action info
    console.log(chalk.bold(`\nAction: ${action}`));
    console.log(chalk.gray(`Time: ${new Date(analysis.timestamp).toLocaleString()}`));

    if (analysis.files_affected > 0) {
      console.log(chalk.bold(`\nFiles Affected: ${analysis.files_affected}`));
      if (files.length > 0 && files.length <= 10) {
        files.forEach((file) => {
          console.log(chalk.gray(`   • ${file}`));
        });
      } else if (files.length > 10) {
        files.slice(0, 10).forEach((file) => {
          console.log(chalk.gray(`   • ${file}`));
        });
        console.log(chalk.gray(`   ... and ${files.length - 10} more`));
      }
    }

    // Quality impact
    const impactColor =
      analysis.quality_impact === 'validation_complete'
        ? chalk.green
        : analysis.quality_impact === 'code_change'
          ? chalk.yellow
          : chalk.blue;

    console.log(chalk.bold('\n📊 Quality Impact:'));
    console.log(impactColor(`   ${analysis.quality_impact}`));

    // Risk level
    const riskColor =
      analysis.risk_level === 'high'
        ? chalk.red
        : analysis.risk_level === 'medium'
          ? chalk.yellow
          : chalk.green;

    console.log(chalk.bold('\n⚠️  Risk Level:'));
    console.log(riskColor(`   ${analysis.risk_level.toUpperCase()}`));

    // Project tier
    if (analysis.project_tier) {
      console.log(chalk.bold(`\n🎯 Project Tier: ${analysis.project_tier}`));
    }

    // Quality gates
    if (analysis.quality_gates && analysis.quality_gates.length > 0) {
      console.log(chalk.bold('\n🚪 Quality Gates to Check:\n'));
      analysis.quality_gates.forEach((gate) => {
        console.log(chalk.gray(`   □ ${gate}`));
      });
    }

    // Recommendations
    console.log(chalk.bold('\n💡 Recommendations:\n'));
    analysis.recommendations.forEach((rec, idx) => {
      const icon = idx === 0 ? '⚡' : '  •';
      console.log(chalk.blue(`   ${icon} ${rec}`));
    });

    // Suggested commands
    console.log(chalk.bold('\n📚 Suggested Commands:\n'));
    switch (action) {
      case 'file_saved':
      case 'code_edited':
        console.log(chalk.gray('   caws evaluate       - Check quality score'));
        console.log(chalk.gray('   caws validate       - Run validation'));
        console.log(chalk.gray('   caws diagnose       - Health check'));
        break;
      case 'test_run':
        console.log(chalk.gray('   caws status         - Project status'));
        console.log(chalk.gray('   caws iterate        - Next steps'));
        break;
    }

    console.log('\n' + '─'.repeat(60) + '\n');
  } catch (error) {
    console.error(chalk.red(`\n❌ Quality monitoring failed: ${error.message}`));
    console.error(chalk.gray(error.stack));
    process.exit(1);
  }
}

module.exports = {
  qualityMonitorCommand,
  analyzeQualityImpact,
};

