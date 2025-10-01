#!/usr/bin/env node

/**
 * @fileoverview Cleanup script to remove test directories
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');

// Patterns for test directories to clean up
const TEST_DIR_PATTERNS = [
  /^test-accessibility-spec-\d+$/,
  /^test-tools-integration-\d+$/,
  /^test-integration-workflow$/,
  /^test-e2e-complete-project$/,
  /^test-perf-init$/,
  /^test-perf-scaffold$/,
  /^test-memory-check$/,
  /^test-cpu-monitor$/,
  /^test-project$/,
  /^test-caws-project$/,
  /^test-cli-contract$/,
  /^test-manual$/,
  /^test-e2e-existing-project$/,
  /^test-e2e-error-recovery$/,
  /^test-e2e-feature-project$/,
  /^test-e2e-refactor-project$/,
  /^test-e2e-fix-project$/,
];

// Directories to search for test folders
const SEARCH_DIRS = [
  path.join(__dirname, '../tests/integration'),
  path.join(__dirname, '../tests/e2e'),
  path.join(__dirname, '../tests/axe'),
  path.join(__dirname, '../tests/contract'),
  path.join(__dirname, '..'),
];

let totalCleaned = 0;
let totalErrors = 0;

console.log('🧹 Cleaning up test directories...\n');

SEARCH_DIRS.forEach((searchDir) => {
  if (!fs.existsSync(searchDir)) {
    return;
  }

  try {
    const items = fs.readdirSync(searchDir);

    items.forEach((item) => {
      // Check if item matches any test pattern
      const isTestDir = TEST_DIR_PATTERNS.some((pattern) => pattern.test(item));

      if (isTestDir) {
        const itemPath = path.join(searchDir, item);

        try {
          const stats = fs.statSync(itemPath);
          if (stats.isDirectory()) {
            console.log(`  Removing: ${path.relative(path.join(__dirname, '..'), itemPath)}`);
            fs.rmSync(itemPath, { recursive: true, force: true });
            totalCleaned++;
          }
        } catch (err) {
          console.error(`  ❌ Failed to remove ${item}:`, err.message);
          totalErrors++;
        }
      }
    });
  } catch (err) {
    console.error(`  ❌ Error reading directory ${searchDir}:`, err.message);
  }
});

console.log(`\n✅ Cleanup complete!`);
console.log(`   Cleaned: ${totalCleaned} directories`);
if (totalErrors > 0) {
  console.log(`   ⚠️  Errors: ${totalErrors}`);
  process.exit(1);
} else {
  console.log(`   No errors\n`);
}
