#!/usr/bin/env node

/**
 * CAWS Start Script - Scaffolds change specs, plans, and tests by mode
 *
 * @param {string} id - Change ID (e.g., FEAT-1234)
 * @param {string} mode - Change mode (feature|refactor|fix)
 * @param {string} title - Change title/description
 * @param {string} tier - Risk tier (1|2|3, defaults to 2)
 */
const fs = require('fs');
const path = require('path');

const [, , id, mode = 'feature', title = '', tier = '2'] = process.argv;

// Validate inputs
if (!id || !mode) {
  console.error('Usage: node start.js <id> <mode> [title] [tier]');
  console.error('Example: node start.js FEAT-1234 feature "Apply coupon at checkout" 2');
  process.exit(1);
}

if (!['feature', 'refactor', 'fix'].includes(mode)) {
  console.error('Mode must be one of: feature, refactor, fix');
  process.exit(1);
}

if (!['1', '2', '3'].includes(tier)) {
  console.error('Tier must be one of: 1, 2, 3');
  process.exit(1);
}

const changeTitle = title || `Implement ${id}`;
const changeId = id.toUpperCase();

// Create directory structure
const cawsDir = path.join(process.cwd(), '.caws');
const specsDir = path.join(cawsDir, 'specs');
const docsDir = path.join(process.cwd(), 'docs', changeId);
const codemodDir = path.join(docsDir, 'codemod');

// Ensure directories exist
[cawsDir, specsDir, docsDir, codemodDir].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Templates
const workingSpecTemplate = {
  id: changeId,
  mode,
  title: changeTitle,
  tier: parseInt(tier),
  scope: {
    in: [`docs/${changeId}/`, 'src/'],
    out: ['node_modules/', 'dist/', '.git/'],
  },
  change_budget: {
    max_files: mode === 'fix' ? 5 : 25,
    max_loc: mode === 'fix' ? 100 : 1000,
  },
  status: 'draft',
};

const featurePlanTemplate = `# ${changeTitle}

## Overview
Brief description of the feature and its business value. Explain why this feature is needed and what problem it solves for users.

## Requirements
- Functional requirements for the feature
- Non-functional requirements (performance, security, etc.)
- Acceptance criteria

## Implementation Plan
1. Step-by-step implementation plan
2. Dependencies and prerequisites
3. Risk mitigation strategies

## Blast Radius
- Modules: List of modules that will be affected
- Data migration: yes/no - whether data changes are required
- Cross-service contracts: List of contracts that need updates

## Operational Rollback SLO
- Time and method to rollback if needed (e.g., feature flags, database rollbacks)

## Testing Strategy
- Unit tests for new functionality
- Integration tests for cross-module interactions
- E2E tests for user workflows

## Success Metrics
- How success will be measured (e.g., user adoption, performance improvements)
`;

const testPlanTemplate = `# Test Plan for ${changeTitle}

## Mode Matrix
| Test Class | Required | Notes |
|------------|----------|-------|
| Unit | Yes | Core functionality tests |
| Contract | Yes | API contract validation |
| Integration | Yes | Cross-module integration |
| E2E smoke | Yes | Critical user journeys |
| Mutation | Yes | Code quality gates |
| A11y/Perf | Yes | Accessibility and performance |

## Test Cases
- Specific test cases to implement for this feature
- Include happy path, error conditions, and boundary cases

## Edge Cases
- Edge cases to cover (null values, large inputs, race conditions)
- Error handling scenarios

## Regression Tests
- Existing functionality to verify hasn't been broken
- Integration points with other systems
`;

const refactorPlanTemplate = `# Refactor Plan for ${changeTitle}

## Overview
What is being refactored and why. Explain the business or technical drivers for this refactoring.

## Current State
Describe current implementation issues. What problems does the current code have?

## Target State
Describe desired architecture after refactor. What will the code look like after refactoring?

## Migration Strategy
How to migrate without breaking changes. Feature flags, gradual rollout, etc.

## Codemod Plan
- What transformations are needed to update the codebase
- Files to be modified and in what order
- Rollback strategy if something goes wrong

## Testing Strategy
- How to verify behavior preservation during and after refactoring
- Regression testing approach
`;

const codemodTemplate = `/**
 * Codemod for ${changeTitle}
 *
 * This script performs automated refactoring transformations.
 * Run with: npm run codemod:dry to preview, npm run codemod:apply to execute.
 */

const tsMorph = require('ts-morph');

function applyCodemod(dryRun = true) {
  const project = new tsMorph.Project();

  // Load source files to transform
  project.addSourceFilesAtPaths("src/**/*.ts");

  console.log('Codemod transformations:');
  console.log('- Analyzing source files...');

  // Example transformation: find and update specific patterns
  const sourceFiles = project.getSourceFiles();

  for (const sourceFile of sourceFiles) {
    // Add your specific transformation logic here
    console.log(`Processing: ${sourceFile.getFilePath()}`);
  }

  if (!dryRun) {
    project.saveSync();
    console.log('✅ Transformations applied successfully');
  } else {
    console.log('🔍 Dry run - no changes made');
  }
}

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--apply');

  applyCodemod(dryRun);
}

module.exports = { applyCodemod };
`;

// Write files
try {
  // Working spec
  const workingSpecPath = path.join(cawsDir, 'working-spec.yaml');
  if (!fs.existsSync(workingSpecPath)) {
    fs.writeFileSync(
      workingSpecPath,
      `# CAWS Working Specification
# This file defines the current change being worked on

${Object.entries(workingSpecTemplate)
  .map(
    ([key, value]) =>
      `${key}: ${typeof value === 'object' ? JSON.stringify(value, null, 2) : value}`
  )
  .join('\n')}
`
    );
  } else {
    console.log('⚠️  Working spec already exists, not overwriting');
  }

  // Feature/Refactor plan
  const planPath = path.join(docsDir, `${mode}.plan.md`);
  const planTemplate = mode === 'refactor' ? refactorPlanTemplate : featurePlanTemplate;
  fs.writeFileSync(planPath, planTemplate);

  // Test plan
  const testPlanPath = path.join(docsDir, 'test-plan.md');
  fs.writeFileSync(testPlanPath, testPlanTemplate);

  // Codemod (for refactor mode)
  if (mode === 'refactor') {
    const codemodPath = path.join(codemodDir, 'refactor.ts');
    fs.writeFileSync(codemodPath, codemodTemplate);
  }

  console.log(`✅ CAWS scaffold created successfully!`);
  console.log(`📁 Change ID: ${changeId}`);
  console.log(`🏷️  Mode: ${mode}`);
  console.log(`📝 Title: ${changeTitle}`);
  console.log(`⚡ Tier: ${tier}`);
  console.log('');
  console.log('Next steps:');
  console.log('1. Edit .caws/working-spec.yaml with your specific details');
  console.log(`2. Edit docs/${changeId}/${mode}.plan.md with your implementation plan`);
  console.log(`3. Edit docs/${changeId}/test-plan.md with your testing strategy`);
  if (mode === 'refactor') {
    console.log(`4. Implement codemod in docs/${changeId}/codemod/refactor.ts`);
  }
  console.log('5. Run npm run caws:validate to check your spec');
  console.log('6. Run npm run caws:verify to run all gates');
} catch (error) {
  console.error('❌ Error creating CAWS scaffold:', error.message);

  // Provide helpful debugging information
  if (error.code === 'EACCES') {
    console.error('💡 This might be a permissions issue. Try running with elevated privileges.');
  } else if (error.code === 'ENOENT') {
    console.error(
      '💡 Some required directories could not be created. Check your file system permissions.'
    );
  } else if (error.code === 'ENOSPC') {
    console.error('💡 Not enough disk space to create scaffold files.');
  }

  console.error('🔍 Debug info:', {
    nodeVersion: process.version,
    platform: process.platform,
    cwd: process.cwd(),
    args: process.argv.slice(2),
  });

  process.exit(1);
}
