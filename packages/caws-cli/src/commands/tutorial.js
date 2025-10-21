/**
 * @fileoverview CAWS Tutorial Command
 * Interactive guided learning for AI agents and developers
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const { safeAsync, outputResult } = require('../error-handler');

/**
 * Tutorial steps for different user types
 */
const TUTORIALS = {
  agent: {
    name: 'AI Agent Onboarding',
    description: 'Complete guide for AI agents working with CAWS',
    icon: '🤖',
    steps: [
      {
        id: 'welcome',
        title: 'Welcome to CAWS',
        content: `
Welcome to CAWS (Coding Agent Workflow System)!

CAWS helps AI agents and developers collaborate effectively by providing:
• 📋 Structured specifications and requirements
• 🔍 Automated validation and quality gates
• 📊 Progress tracking and status monitoring
• 🔄 Change management and archival
• 🏗️ Multi-tier complexity modes

This tutorial will guide you through the essential CAWS workflow.
        `,
        action: 'Press Enter to continue...',
      },
      {
        id: 'first-steps',
        title: 'Your First Steps',
        content: `
Every CAWS session should start with validation:

1. ✅ Always validate first: \`caws validate\`
2. 📊 Check current status: \`caws status --visual\`
3. 🎯 Get guidance: \`caws iterate --current-state "Starting implementation"\`

These commands ensure you're working with validated specifications and understand the current project state.
        `,
        action: 'Try: caws validate',
        verify: 'validation',
      },
      {
        id: 'modes',
        title: 'Understanding Modes',
        content: `
CAWS adapts to your project needs with three complexity tiers:

🟢 **Simple Mode** (70% coverage, 30% mutation)
   • Perfect for small projects and prototyping
   • Minimal commands and features
   • Quick setup and iteration

🟡 **Standard Mode** (80% coverage, 50% mutation)
   • Balanced approach for most projects
   • Quality gates and provenance tracking
   • Change management and archival

🔴 **Enterprise Mode** (90% coverage, 70% mutation)
   • Full compliance and audit trails
   • Advanced monitoring and reporting
   • Maximum quality assurance

Check your current mode: \`caws mode current\`
Switch modes: \`caws mode set --interactive\`
        `,
        action: 'Try: caws mode current',
        verify: 'mode_check',
      },
      {
        id: 'specs-system',
        title: 'Multi-Spec Organization',
        content: `
CAWS uses a multi-spec system for better organization:

📁 **Individual spec files** instead of monolithic specs
🎯 **Type-based organization** (feature, fix, refactor, etc.)
📊 **Visual progress tracking** across all specs
🔄 **Concurrent development** support

Commands:
• \`caws specs list\` - View all specs
• \`caws specs create <id>\` - Create new spec
• \`caws specs show <id>\` - View spec details
• \`caws specs update <id>\` - Update spec status

Each spec contains:
• Acceptance criteria with progress tracking
• Risk tier and complexity mode
• Contract definitions and validation
        `,
        action: 'Try: caws specs list',
        verify: 'specs_list',
      },
      {
        id: 'workflow',
        title: 'Development Workflow',
        content: `
Follow this proven TDD workflow:

1. 📋 **Plan**: Create/update specs with acceptance criteria
2. ✅ **Validate**: Ensure specs are valid and complete
3. 🧪 **Test First**: Write failing tests for each criterion
4. 🔨 **Implement**: Make tests pass incrementally
5. 📊 **Track Progress**: Update acceptance criteria status
6. 🔍 **Quality Gates**: Run validation and quality checks
7. 📦 **Archive**: Complete and archive finished work

Key commands:
• \`caws progress update --criterion-id A1 --status completed\`
• \`caws validate\` - Validate current work
• \`caws status --visual\` - Check progress
• \`caws archive <change-id>\` - Complete work
        `,
        action: 'Try: caws status --visual',
        verify: 'status_check',
      },
      {
        id: 'quality-gates',
        title: 'Quality Assurance',
        content: `
CAWS enforces quality through multiple gates:

🔍 **Validation Gates**
• Spec format and completeness
• Contract compliance
• Risk tier requirements

🧪 **Testing Gates**
• Test coverage thresholds
• Mutation testing scores
• Integration test passing

📊 **Progress Gates**
• Acceptance criteria completion
• Spec status validation
• Change budget compliance

⚡ **Quick Checks**
• \`caws validate\` - Spec validation
• \`caws diagnose\` - Health checks (if in standard/enterprise mode)
• \`caws evaluate\` - Quality evaluation
        `,
        action: 'Try: caws validate',
        verify: 'quality_check',
      },
      {
        id: 'common-patterns',
        title: 'Common Patterns & Best Practices',
        content: `
🚫 **Avoid These**:
• ❌ Don't start implementation before validation
• ❌ Don't create duplicate files (enhanced-*, new-*)
• ❌ Don't exceed change budgets
• ❌ Don't skip quality gates

✅ **Do These**:
• ✅ Always validate first: \`caws validate\`
• ✅ Use multi-spec system for organization
• ✅ Write tests before implementation (TDD)
• ✅ Update progress: \`caws progress update\`
• ✅ Archive completed work: \`caws archive\`

📚 **Get Help**:
• \`caws --help\` - All commands
• \`caws workflow guidance\` - Workflow-specific help
• \`docs/agents/full-guide.md\` - Complete documentation
        `,
        action: 'Try: caws --help',
        verify: 'help_check',
      },
      {
        id: 'completion',
        title: 'Tutorial Complete!',
        content: `
🎉 Congratulations! You've completed the CAWS agent tutorial.

**Key Takeaways**:
• CAWS provides structure and validation for AI-human collaboration
• Start every session with validation and status checks
• Use the multi-spec system for better organization
• Follow TDD practices with comprehensive testing
• Respect quality gates and change budgets
• Archive completed work for clean project history

**Next Steps**:
1. Explore the multi-spec system: \`caws specs create my-feature\`
2. Practice the workflow with a small feature
3. Use mode switching to match your project needs
4. Read the full documentation for advanced features

Remember: CAWS exists to make AI-human collaboration reliable and high-quality. Follow the rules, validate often, and deliver excellent results!

💡 Pro tip: Use \`caws status --visual\` regularly to stay oriented
        `,
        action: 'Tutorial complete! Try: caws specs create my-feature',
      },
    ],
  },

  developer: {
    name: 'Developer Quick Start',
    description: 'Fast track for developers new to CAWS',
    icon: '👨‍💻',
    steps: [
      {
        id: 'welcome-dev',
        title: 'Welcome Developer!',
        content: `
Welcome to CAWS! This quick start will get you up and running fast.

CAWS helps development teams by providing:
• 📋 Clear specification management
• 🔄 Structured change workflows
• 📊 Progress visibility for stakeholders
• 🏗️ Quality gates and validation
• 🤝 Better AI-human collaboration

Let's get you started!
        `,
        action: 'Press Enter to continue...',
      },
      {
        id: 'setup',
        title: 'Project Setup',
        content: `
First, ensure CAWS is properly initialized:

1. Initialize CAWS: \`caws init .\`
2. Choose your complexity mode: \`caws mode set --interactive\`
3. Set up git hooks: \`caws hooks install\`
4. Initialize provenance: \`caws provenance init\`

For existing projects, use: \`caws scaffold\`

Choose a mode that fits your project:
• 🟢 Simple: Small projects, quick prototyping
• 🟡 Standard: Most teams and projects
• 🔴 Enterprise: Large teams, compliance requirements
        `,
        action: 'Try: caws mode current',
        verify: 'mode_setup',
      },
      {
        id: 'create-spec',
        title: 'Create Your First Spec',
        content: `
Create a spec for your feature or fix:

\`caws specs create user-login --type feature --title "User Login System"\`

This creates:
• A new spec file in \`.caws/specs/user-login.yaml\`
• Basic structure with acceptance criteria template
• Automatic registration in the specs registry

View all specs: \`caws specs list\`
View spec details: \`caws specs show user-login\`
        `,
        action: 'Try: caws specs list',
        verify: 'first_spec',
      },
      {
        id: 'define-criteria',
        title: 'Define Acceptance Criteria',
        content: `
Edit your spec file to add acceptance criteria:

\`\`\`yaml
# .caws/specs/user-login.yaml
acceptance_criteria:
  - id: A1
    title: User can login with valid credentials
    description: Users should be able to authenticate using email/password
    completed: false
  - id: A2
    title: Invalid credentials show error
    description: Invalid login attempts should display appropriate error messages
    completed: false
\`\`\`

Each criterion should be:
• ✅ Testable and verifiable
• 📏 Specific and measurable
• 🎯 Focused on user value
        `,
        action: 'Edit your spec file and add acceptance criteria',
        verify: 'criteria_defined',
      },
      {
        id: 'workflow',
        title: 'Development Workflow',
        content: `
Follow this workflow for each acceptance criterion:

1. **Write failing tests first** (TDD approach)
2. **Implement the minimum** to make tests pass
3. **Update progress**: \`caws progress update --criterion-id A1 --status completed\`
4. **Validate**: \`caws validate\`
5. **Run quality gates** (if in standard/enterprise mode)

Repeat for each criterion until the spec is complete.

Track progress: \`caws status --visual\`
Get guidance: \`caws iterate --current-state "Working on A1"\`
        `,
        action: 'Try: caws progress update --criterion-id A1 --status in_progress',
        verify: 'workflow_started',
      },
      {
        id: 'completion',
        title: 'Complete and Archive',
        content: `
When all acceptance criteria are completed:

1. **Final validation**: \`caws validate\`
2. **Quality checks**: \`caws diagnose\` (if enabled)
3. **Archive the work**: \`caws archive user-login\`

This:
• ✅ Validates all criteria are met
• 📦 Moves completed work to archive
• 📊 Updates provenance chain
• 🎯 Provides completion summary

View archived work: Check \`.caws/archive/\` directory
        `,
        action: 'Complete your spec and try: caws archive <spec-id>',
        verify: 'archival_complete',
      },
    ],
  },
};

/**
 * Display tutorial step
 * @param {Object} step - Tutorial step
 * @param {number} stepNumber - Step number (1-based)
 * @param {number} totalSteps - Total number of steps
 */
function displayTutorialStep(step, stepNumber, totalSteps) {
  console.log(chalk.bold.cyan(`\n📚 Step ${stepNumber}/${totalSteps}: ${step.title}`));
  console.log(chalk.cyan('━'.repeat(60)));

  // Display content with proper formatting
  const lines = step.content.trim().split('\n');
  lines.forEach((line) => {
    if (
      line.startsWith('•') ||
      line.startsWith('✅') ||
      line.startsWith('❌') ||
      line.startsWith('📋') ||
      line.startsWith('🔍')
    ) {
      console.log(chalk.gray(line));
    } else if (line.startsWith('🟢') || line.startsWith('🟡') || line.startsWith('🔴')) {
      console.log(line);
    } else if (line.includes('`')) {
      console.log(chalk.cyan(line));
    } else {
      console.log(line);
    }
  });

  if (step.action) {
    console.log(chalk.yellow(`\n💡 ${step.action}`));
  }

  console.log('');
}

/**
 * Interactive tutorial session
 * @param {string} tutorialType - Type of tutorial (agent, developer)
 * @returns {Promise<void>}
 */
async function runInteractiveTutorial(tutorialType) {
  const tutorial = TUTORIALS[tutorialType];
  if (!tutorial) {
    throw new Error(
      `Unknown tutorial type: ${tutorialType}. Available: ${Object.keys(TUTORIALS).join(', ')}`
    );
  }

  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(chalk.bold.green(`\n🚀 Starting ${tutorial.icon} ${tutorial.name}`));
  console.log(chalk.green(tutorial.description));
  console.log(chalk.gray(`Total steps: ${tutorial.steps.length}\n`));

  for (let i = 0; i < tutorial.steps.length; i++) {
    const step = tutorial.steps[i];
    const stepNumber = i + 1;

    displayTutorialStep(step, stepNumber, tutorial.steps.length);

    // Wait for user input (except for the last step)
    if (i < tutorial.steps.length - 1) {
      await new Promise((resolve) => {
        console.log(chalk.blue('Press Enter to continue...'));
        rl.on('line', () => {
          resolve();
        });
      });
    }
  }

  rl.close();

  // Final message
  console.log(chalk.bold.green(`\n🎉 ${tutorial.icon} ${tutorial.name} Complete!`));
  console.log(chalk.green('You can always run this tutorial again with:'));
  console.log(chalk.cyan(`caws tutorial ${tutorialType}`));
  console.log('');
}

/**
 * Tutorial command handler
 * @param {string} tutorialType - Type of tutorial to run
 * @param {Object} options - Command options
 */
async function tutorialCommand(tutorialType, options = {}) {
  return safeAsync(
    async () => {
      if (!tutorialType) {
        // Show available tutorials
        console.log(chalk.bold.cyan('\n📚 Available CAWS Tutorials'));
        console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

        Object.entries(TUTORIALS).forEach(([type, tutorial]) => {
          console.log(`${tutorial.icon} ${chalk.green(type.padEnd(12))} - ${tutorial.description}`);
        });

        console.log(chalk.gray('\nUsage: caws tutorial <type>'));
        console.log(chalk.gray('Example: caws tutorial agent'));

        return outputResult({
          command: 'tutorial',
          action: 'list',
          available: Object.keys(TUTORIALS),
        });
      }

      if (!TUTORIALS[tutorialType]) {
        throw new Error(
          `Unknown tutorial: ${tutorialType}. Available: ${Object.keys(TUTORIALS).join(', ')}`
        );
      }

      // Run the interactive tutorial
      await runInteractiveTutorial(tutorialType);

      return outputResult({
        command: 'tutorial',
        tutorial: tutorialType,
        steps: TUTORIALS[tutorialType].steps.length,
        completed: true,
      });
    },
    `tutorial ${tutorialType}`,
    true
  );
}

module.exports = {
  tutorialCommand,
  TUTORIALS,
  runInteractiveTutorial,
};
