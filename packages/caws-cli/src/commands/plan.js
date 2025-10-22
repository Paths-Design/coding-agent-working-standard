/**
 * @fileoverview CAWS Plan Command
 * Automated plan generation from specifications (multi-spec aware)
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const { safeAsync, outputResult } = require('../error-handler');

// Import spec resolution system
const { resolveSpec } = require('../utils/spec-resolver');

/**
 * Plan templates for different spec types
 */
const PLAN_TEMPLATES = {
  feature: {
    sections: [
      'Overview',
      'Acceptance Criteria Analysis',
      'Implementation Strategy',
      'Testing Strategy',
      'Risk Assessment',
      'Dependencies',
      'Timeline',
      'Success Metrics',
    ],
    defaultTasks: [
      'Set up development environment',
      'Implement core functionality',
      'Add error handling',
      'Write comprehensive tests',
      'Update documentation',
      'Performance optimization',
      'Security review',
      'Final validation',
    ],
  },
  fix: {
    sections: [
      'Problem Analysis',
      'Root Cause Investigation',
      'Solution Design',
      'Implementation Plan',
      'Testing Strategy',
      'Rollback Plan',
      'Verification',
    ],
    defaultTasks: [
      'Reproduce the issue',
      'Identify root cause',
      'Design fix approach',
      'Implement solution',
      'Write regression tests',
      'Update documentation',
      'Deploy and verify',
    ],
  },
  refactor: {
    sections: [
      'Current State Analysis',
      'Refactoring Goals',
      'Approach Strategy',
      'Implementation Plan',
      'Testing Strategy',
      'Performance Impact',
      'Migration Plan',
    ],
    defaultTasks: [
      'Analyze current code',
      'Design new architecture',
      'Plan incremental changes',
      'Implement refactoring',
      'Update tests',
      'Performance validation',
      'Documentation update',
    ],
  },
};

/**
 * Load spec for plan generation
 * @param {string} specId - Spec identifier
 * @returns {Promise<Object|null>} Spec data or null
 */
async function loadSpecForPlanning(specId) {
  try {
    const resolved = await resolveSpec({
      specId,
      warnLegacy: false,
    });
    return resolved.spec;
  } catch (error) {
    return null;
  }
}

/**
 * Generate and display implementation plan
 * @param {Object} spec - Spec data
 * @param {string} specId - Spec identifier
 * @param {Object} options - Command options
 */
async function generateAndDisplayPlan(spec, specId, options) {
  // Generate plan
  const plan = generateImplementationPlan(spec);

  // Determine output path
  const outputPath = options.output || `.caws/plans/${specId}-plan.md`;

  // Write plan to file
  await writePlanToFile(plan, outputPath);

  // Display plan summary
  displayGeneratedPlan(plan);

  console.log(chalk.green(`✅ Plan generated: ${outputPath}`));

  return outputResult({
    command: 'plan generate',
    specId,
    outputPath,
    planSections: plan.sections.length,
    tasks: plan.tasks.length,
  });
}

/**
 * Generate implementation tasks from acceptance criteria
 * @param {Array} criteria - Acceptance criteria
 * @returns {Array} Generated tasks
 */
function generateTasksFromCriteria(criteria) {
  const tasks = [];

  criteria.forEach((criterion, index) => {
    const criterionId = criterion.id || `A${index + 1}`;
    const description = criterion.description || criterion.title || `Implement ${criterionId}`;

    // Break down complex criteria into multiple tasks
    if (description.includes('and') || description.includes('then') || description.length > 100) {
      // Split into multiple tasks
      const parts = description.split(/[.;]/).filter((part) => part.trim().length > 0);
      parts.forEach((part, partIndex) => {
        tasks.push({
          id: `${criterionId}.${partIndex + 1}`,
          title: part.trim(),
          criterion: criterionId,
          type: 'implementation',
          estimatedHours: 2,
          dependencies: partIndex > 0 ? [`${criterionId}.${partIndex}`] : [],
        });
      });
    } else {
      // Single task for simple criteria
      tasks.push({
        id: criterionId,
        title: description,
        criterion: criterionId,
        type: 'implementation',
        estimatedHours: 3,
        dependencies: [],
      });
    }
  });

  return tasks;
}

/**
 * Generate testing tasks for acceptance criteria
 * @param {Array} criteria - Acceptance criteria
 * @returns {Array} Generated test tasks
 */
function generateTestTasks(criteria) {
  const tasks = [];

  criteria.forEach((criterion, index) => {
    const criterionId = criterion.id || `A${index + 1}`;

    tasks.push({
      id: `test-${criterionId}`,
      title: `Write tests for ${criterionId}`,
      criterion: criterionId,
      type: 'testing',
      estimatedHours: 2,
      dependencies: [criterionId],
    });

    tasks.push({
      id: `integration-${criterionId}`,
      title: `Integration tests for ${criterionId}`,
      criterion: criterionId,
      type: 'testing',
      estimatedHours: 1,
      dependencies: [`test-${criterionId}`],
    });
  });

  return tasks;
}

/**
 * Generate implementation plan from spec
 * @param {Object} spec - Spec data
 * @returns {Object} Generated plan
 */
function generateImplementationPlan(spec) {
  const template = PLAN_TEMPLATES[spec.type] || PLAN_TEMPLATES.feature;

  // Generate tasks from acceptance criteria
  const implementationTasks = generateTasksFromCriteria(spec.acceptance_criteria || []);
  const testTasks = generateTestTasks(spec.acceptance_criteria || []);

  // Combine all tasks
  const allTasks = [
    ...template.defaultTasks.map((task, index) => ({
      id: `setup-${index + 1}`,
      title: task,
      type: 'setup',
      estimatedHours: 1,
      dependencies: [],
    })),
    ...implementationTasks,
    ...testTasks,
  ];

  // Calculate timeline
  const totalHours = allTasks.reduce((sum, task) => sum + task.estimatedHours, 0);
  const estimatedDays = Math.ceil(totalHours / 8); // Assuming 8-hour work days

  // Generate plan content
  const planContent = {
    spec_id: spec.id,
    title: `Implementation Plan: ${spec.title}`,
    generated_at: new Date().toISOString(),
    sections: template.sections,
    tasks: allTasks,
    timeline: {
      total_hours: totalHours,
      estimated_days: estimatedDays,
      parallel_execution: true,
    },
    risks: [
      {
        level: 'low',
        description: 'Standard implementation risks',
        mitigation: 'Follow established patterns and conduct thorough testing',
      },
    ],
  };

  return planContent;
}

/**
 * Write plan to file
 * @param {Object} plan - Plan data
 * @param {string} outputPath - Output file path
 * @returns {Promise<void>}
 */
async function writePlanToFile(plan, outputPath) {
  const planDir = path.dirname(outputPath);
  await fs.ensureDir(planDir);

  const markdownContent = generatePlanMarkdown(plan);
  await fs.writeFile(outputPath, markdownContent);
}

/**
 * Generate markdown content from plan
 * @param {Object} plan - Plan data
 * @returns {string} Markdown content
 */
function generatePlanMarkdown(plan) {
  let content = `# ${plan.title}\n\n`;
  content += `**Generated:** ${new Date(plan.generated_at).toLocaleString()}\n`;
  content += `**Spec ID:** ${plan.spec_id}\n\n`;

  // Overview section
  content += `## Overview\n\n`;
  content += `This plan outlines the implementation strategy for the specified requirements.\n`;
  content += `**Timeline:** ${plan.timeline.estimated_days} days (${plan.timeline.total_hours} hours)\n\n`;

  // Tasks section
  content += `## Implementation Tasks\n\n`;

  // Group tasks by type
  const setupTasks = plan.tasks.filter((task) => task.type === 'setup');
  const implementationTasks = plan.tasks.filter((task) => task.type === 'implementation');
  const testTasks = plan.tasks.filter((task) => task.type === 'testing');

  if (setupTasks.length > 0) {
    content += `### Setup (${setupTasks.length} tasks)\n\n`;
    setupTasks.forEach((task) => {
      content += `- [ ] **${task.id}** - ${task.title} (${task.estimatedHours}h)\n`;
    });
    content += '\n';
  }

  if (implementationTasks.length > 0) {
    content += `### Implementation (${implementationTasks.length} tasks)\n\n`;
    implementationTasks.forEach((task) => {
      const deps =
        task.dependencies.length > 0 ? ` (depends on: ${task.dependencies.join(', ')})` : '';
      content += `- [ ] **${task.id}** - ${task.title} (${task.estimatedHours}h)${deps}\n`;
    });
    content += '\n';
  }

  if (testTasks.length > 0) {
    content += `### Testing (${testTasks.length} tasks)\n\n`;
    testTasks.forEach((task) => {
      const deps =
        task.dependencies.length > 0 ? ` (depends on: ${task.dependencies.join(', ')})` : '';
      content += `- [ ] **${task.id}** - ${task.title} (${task.estimatedHours}h)${deps}\n`;
    });
    content += '\n';
  }

  // Risk assessment
  content += `## Risk Assessment\n\n`;
  plan.risks.forEach((risk, index) => {
    content += `### ${risk.level.toUpperCase()} Risk ${index + 1}\n`;
    content += `${risk.description}\n\n`;
    content += `**Mitigation:** ${risk.mitigation}\n\n`;
  });

  // Success metrics
  content += `## Success Metrics\n\n`;
  content += `- All acceptance criteria implemented and tested\n`;
  content += `- Code coverage meets project standards\n`;
  content += `- Performance requirements satisfied\n`;
  content += `- No breaking changes to existing functionality\n`;
  content += `- Documentation updated\n\n`;

  return content;
}

/**
 * Display generated plan
 * @param {Object} plan - Plan data
 */
function displayGeneratedPlan(plan) {
  console.log(chalk.bold.cyan(`\n📋 Generated Implementation Plan`));
  console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  console.log(chalk.bold(`Title: ${plan.title}`));
  console.log(chalk.gray(`Spec: ${plan.spec_id}`));
  console.log(chalk.gray(`Generated: ${new Date(plan.generated_at).toLocaleString()}`));
  console.log('');

  // Task summary
  const setupTasks = plan.tasks.filter((task) => task.type === 'setup').length;
  const implementationTasks = plan.tasks.filter((task) => task.type === 'implementation').length;
  const testTasks = plan.tasks.filter((task) => task.type === 'testing').length;

  console.log(chalk.bold('Task Breakdown:'));
  if (setupTasks > 0) console.log(chalk.gray(`   Setup: ${setupTasks} tasks`));
  if (implementationTasks > 0)
    console.log(chalk.gray(`   Implementation: ${implementationTasks} tasks`));
  if (testTasks > 0) console.log(chalk.gray(`   Testing: ${testTasks} tasks`));

  console.log(
    chalk.gray(
      `   Total: ${plan.tasks.length} tasks, ${plan.timeline.total_hours} hours, ${plan.timeline.estimated_days} days`
    )
  );
  console.log('');

  // Next steps
  console.log(chalk.bold.yellow('💡 Next Steps:'));
  console.log(chalk.yellow('   1. Review and customize the generated plan'));
  console.log(chalk.yellow('   2. Update task priorities and dependencies'));
  console.log(chalk.yellow('   3. Start implementation following the task order'));
  console.log(chalk.yellow('   4. Update progress: caws progress update --criterion-id A1'));
  console.log('');
}

/**
 * Plan command handler
 * @param {string} action - Action to perform (generate)
 * @param {Object} options - Command options
 */
async function planCommand(action, options = {}) {
  return safeAsync(
    async () => {
      switch (action) {
        case 'generate': {
          const specId = options.specId || options.spec;

          if (!specId) {
            // Try to auto-detect single spec
            const { checkMultiSpecStatus } = require('../utils/spec-resolver');
            const status = await checkMultiSpecStatus();

            if (status.specCount === 1) {
              // Use the single spec automatically
              const registry = await require('../utils/spec-resolver').loadSpecsRegistry();
              const singleSpecId = Object.keys(registry.specs)[0];
              console.log(chalk.blue(`📋 Auto-detected single spec: ${singleSpecId}`));

              const spec = await loadSpecForPlanning(singleSpecId);
              if (!spec) {
                throw new Error(`Auto-detected spec '${singleSpecId}' could not be loaded`);
              }

              await generateAndDisplayPlan(spec, singleSpecId, options);
            } else if (status.specCount > 1) {
              throw new Error(
                'Multiple specs detected. Please specify which one: caws plan generate --spec-id <id>\n' +
                  'Available specs: ' +
                  Object.keys(status.registry?.specs || {}).join(', ')
              );
            } else {
              throw new Error('No specs found. Create a spec first: caws specs create <id>');
            }
          } else {
            // Load spec for planning
            const spec = await loadSpecForPlanning(specId);
            if (!spec) {
              throw new Error(`Spec '${specId}' not found`);
            }

            return await generateAndDisplayPlan(spec, specId, options);
          }
          break;
        }

        default:
          throw new Error(`Unknown plan action: ${action}. Use: generate`);
      }
    },
    `plan ${action}`,
    true
  );
}

module.exports = {
  planCommand,
  generateImplementationPlan,
  writePlanToFile,
  generatePlanMarkdown,
  displayGeneratedPlan,
  PLAN_TEMPLATES,
};
