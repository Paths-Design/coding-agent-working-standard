/**
 * CAWS Workflow Command
 *
 * Provides workflow-specific guidance for development tasks.
 * Supports TDD, refactor, and feature development workflows.
 *
 * @author @darianrosebrook
 */

const chalk = require('chalk');

/**
 * Workflow templates with steps and guidance
 */
const WORKFLOW_TEMPLATES = {
  tdd: {
    name: 'Test-Driven Development',
    steps: [
      'Define requirements and acceptance criteria',
      'Write failing test',
      'Implement minimal code to pass test',
      'Run CAWS validation',
      'Refactor while maintaining tests',
      'Repeat for next requirement',
    ],
    guidance: {
      1: 'Start by clearly defining what the code should do. Use CAWS working spec to document requirements.',
      2: 'Write a test that captures the desired behavior but will initially fail.',
      3: 'Implement only the minimal code needed to make the test pass.',
      4: 'Run CAWS evaluation to ensure quality standards are maintained.',
      5: 'Improve code structure while keeping all tests passing.',
      6: 'Move to the next requirement and repeat the cycle.',
    },
    recommendations: {
      1: ['caws evaluate --feedback-only', 'Ensure spec completeness'],
      2: ['Write failing test first', 'caws validate for basic checks'],
      3: ['Implement minimal solution', 'Run tests to verify'],
      4: ['caws evaluate', 'Address any quality issues'],
      5: ['Refactor safely', 'Re-run CAWS validation'],
      6: ['caws iterate for next steps', 'Continue TDD cycle'],
    },
  },
  refactor: {
    name: 'Refactoring Workflow',
    steps: [
      'Establish baseline quality metrics',
      'Apply refactoring changes',
      'Run comprehensive validation',
      'Address any quality gate failures',
      'Document changes and rationale',
    ],
    guidance: {
      1: 'Run CAWS evaluation to establish current quality baseline.',
      2: 'Make your refactoring changes incrementally.',
      3: 'Run full CAWS validation to ensure no quality degradation.',
      4: 'Address any failing quality gates with waivers if necessary.',
      5: 'Update documentation and provenance records.',
    },
    recommendations: {
      1: ['caws evaluate', 'Establish quality baseline'],
      2: ['Apply changes incrementally', 'caws validate frequently'],
      3: ['caws evaluate', 'Full quality assessment'],
      4: ['Create waivers if needed', 'Document rationale'],
      5: ['Update provenance', 'caws provenance update'],
    },
  },
  feature: {
    name: 'Feature Development',
    steps: [
      'Create working specification',
      'Design and plan implementation',
      'Implement core functionality',
      'Add comprehensive testing',
      'Run full quality validation',
      'Prepare for integration',
    ],
    guidance: {
      1: 'Define clear requirements, acceptance criteria, and risk assessment.',
      2: 'Break down the feature into manageable tasks.',
      3: 'Implement core functionality with error handling.',
      4: 'Add unit, integration, and contract tests.',
      5: 'Run complete CAWS validation and address issues.',
      6: 'Ensure documentation and provenance are complete.',
    },
    recommendations: {
      1: ['caws init --interactive', 'Create comprehensive spec'],
      2: ['caws iterate', 'Get implementation guidance'],
      3: ['caws evaluate', 'Validate progress'],
      4: ['Add comprehensive tests', 'Run test suite'],
      5: ['caws validate', 'Final quality gates'],
      6: ['caws provenance update', 'Prepare for integration'],
    },
  },
};

/**
 * Generate workflow guidance
 *
 * @param {string} workflowType - Type of workflow (tdd, refactor, feature)
 * @param {number} currentStep - Current step number (1-based)
 * @param {object} context - Optional context information
 * @returns {object} Workflow guidance
 */
function generateWorkflowGuidance(workflowType, currentStep, context = {}) {
  const template = WORKFLOW_TEMPLATES[workflowType];

  if (!template) {
    return {
      error: `Unknown workflow type: ${workflowType}`,
      available_types: Object.keys(WORKFLOW_TEMPLATES),
    };
  }

  const step = parseInt(currentStep, 10);
  if (isNaN(step) || step < 1 || step > template.steps.length) {
    return {
      error: `Invalid step number: ${currentStep}. Must be between 1 and ${template.steps.length}`,
      total_steps: template.steps.length,
    };
  }

  const currentGuidance = template.guidance[step] || 'Continue with the next logical step.';
  const nextStep = step < template.steps.length ? step + 1 : null;

  return {
    workflow_type: workflowType,
    workflow_name: template.name,
    current_step: step,
    total_steps: template.steps.length,
    step_description: template.steps[step - 1] || 'Unknown step',
    guidance: currentGuidance,
    next_step: nextStep,
    next_step_description: nextStep ? template.steps[nextStep - 1] : null,
    all_steps: template.steps,
    caws_recommendations: template.recommendations[step] || ['caws evaluate'],
    context: context.description || null,
  };
}

/**
 * Workflow command handler
 *
 * @param {string} workflowType - Type of workflow
 * @param {object} options - Command options
 */
async function workflowCommand(workflowType, options = {}) {
  try {
    const step = parseInt(options.step || '1', 10);
    let context = {};

    // Parse context if provided
    if (options.currentState) {
      try {
        context =
          typeof options.currentState === 'string'
            ? JSON.parse(options.currentState)
            : options.currentState;
      } catch (e) {
        console.warn(chalk.yellow('⚠️  Invalid context JSON, ignoring'));
      }
    }

    // Generate guidance
    const guidance = generateWorkflowGuidance(workflowType, step, context);

    // Handle errors
    if (guidance.error) {
      console.error(chalk.red(`\n❌ ${guidance.error}`));
      if (guidance.available_types) {
        console.log(chalk.blue('\n💡 Available workflow types:'));
        guidance.available_types.forEach((type) => {
          console.log(chalk.blue(`   • ${type}`));
        });
      }
      if (guidance.total_steps) {
        console.log(chalk.blue(`\n💡 Valid steps: 1-${guidance.total_steps}`));
      }
      process.exit(1);
    }

    // Display guidance
    console.log(chalk.bold('\n🔄 CAWS Workflow Guidance\n'));
    console.log('─'.repeat(60));
    console.log(chalk.bold(`\nWorkflow: ${guidance.workflow_name} (${guidance.workflow_type})`));
    console.log(
      chalk.bold(
        `Step ${guidance.current_step}/${guidance.total_steps}: ${guidance.step_description}`
      )
    );

    if (guidance.context) {
      console.log(chalk.gray(`\nContext: ${guidance.context}`));
    }

    console.log(chalk.bold('\n📋 Guidance:\n'));
    console.log(`   ${guidance.guidance}`);

    console.log(chalk.bold('\n✅ CAWS Recommendations:\n'));
    guidance.caws_recommendations.forEach((rec) => {
      console.log(chalk.blue(`   • ${rec}`));
    });

    // Show next step if available
    if (guidance.next_step) {
      console.log(chalk.bold('\n⏭️  Next Step:\n'));
      console.log(chalk.gray(`   Step ${guidance.next_step}: ${guidance.next_step_description}`));
      console.log(
        chalk.gray(`\n   Run: caws workflow ${workflowType} --step ${guidance.next_step}`)
      );
    } else {
      console.log(chalk.bold('\n🎉 Workflow Complete!\n'));
      console.log(chalk.green('   All steps in this workflow have been completed.'));
      console.log(chalk.blue('\n   💡 Run: caws evaluate to check final quality'));
    }

    // Show all steps for reference
    console.log(chalk.bold('\n📊 All Steps:\n'));
    guidance.all_steps.forEach((stepDesc, idx) => {
      const stepNum = idx + 1;
      const icon =
        stepNum === guidance.current_step ? '▶️ ' : stepNum < guidance.current_step ? '✅ ' : '⬜ ';
      const color =
        stepNum === guidance.current_step
          ? chalk.bold
          : stepNum < guidance.current_step
            ? chalk.green
            : chalk.gray;
      console.log(color(`   ${icon}${stepNum}. ${stepDesc}`));
    });

    console.log('\n' + '─'.repeat(60) + '\n');
  } catch (error) {
    console.error(chalk.red(`\n❌ Workflow guidance failed: ${error.message}`));
    console.error(chalk.gray(error.stack));
    process.exit(1);
  }
}

module.exports = {
  workflowCommand,
  generateWorkflowGuidance,
  WORKFLOW_TEMPLATES,
};
