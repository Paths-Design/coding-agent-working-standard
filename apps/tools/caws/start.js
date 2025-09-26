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
TODO: Brief description of the feature and its business value.

## Requirements
- TODO: List specific requirements

## Implementation Plan
- TODO: Step-by-step implementation plan

## Blast Radius
- Modules: TODO: List affected modules
- Data migration: TODO: yes/no
- Cross-service contracts: TODO: List affected contracts

## Operational Rollback SLO
- TODO: Time and method to rollback if needed

## Testing Strategy
- TODO: How this will be tested

## Success Metrics
- TODO: How success will be measured
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
TODO: Specific test cases to implement

## Edge Cases
TODO: Edge cases to cover

## Regression Tests
TODO: Existing functionality to verify
`;

const refactorPlanTemplate = `# Refactor Plan for ${changeTitle}

## Overview
TODO: What is being refactored and why.

## Current State
TODO: Describe current implementation issues.

## Target State
TODO: Describe desired architecture after refactor.

## Migration Strategy
TODO: How to migrate without breaking changes.

## Codemod Plan
- TODO: What transformations are needed
- TODO: Files to be modified
- TODO: Rollback strategy

## Testing Strategy
- TODO: How to verify behavior preservation
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

  // TODO: Add your transformation logic here
  // Example: project.addSourceFilesAtPaths("src/**/*.ts");

  console.log('Codemod transformations:');
  console.log('TODO: Implement specific transformations');

  if (!dryRun) {
    project.saveSync();
    console.log('✅ Transformations applied');
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
  process.exit(1);
}
