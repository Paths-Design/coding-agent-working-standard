/**
 * Setup file for Jest tests to handle CI environment issues
 * Runs after Jest environment is initialized, handles directory management
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');

// Save the original working directory at test suite start
const ORIGINAL_CWD = process.cwd();
const SAFE_DIRECTORY = path.join(__dirname, '..'); // packages/caws-cli directory

// Before each test, ensure we're in a valid directory
beforeEach(() => {
  try {
    const currentDir = process.cwd();
    if (!fs.existsSync(currentDir)) {
      // Restore to safe directory
      if (fs.existsSync(ORIGINAL_CWD)) {
        process.chdir(ORIGINAL_CWD);
      } else {
        process.chdir(SAFE_DIRECTORY);
      }
    }
  } catch (error) {
    // Can't determine current directory, restore to safe
    try {
      if (fs.existsSync(ORIGINAL_CWD)) {
        process.chdir(ORIGINAL_CWD);
      } else {
        process.chdir(SAFE_DIRECTORY);
      }
    } catch (e) {
      // Can't recover
    }
  }
});

// After each test, ensure we're in a valid directory
afterEach(() => {
  try {
    const currentDir = process.cwd();
    // Check if current directory still exists
    if (!fs.existsSync(currentDir)) {
      // Directory was deleted, restore to safe directory
      try {
        if (fs.existsSync(ORIGINAL_CWD)) {
          process.chdir(ORIGINAL_CWD);
        } else {
          process.chdir(SAFE_DIRECTORY);
        }
      } catch (error) {
        // Can't restore, continue
      }
    }
  } catch (error) {
    // Current directory doesn't exist, restore to safe directory
    try {
      if (fs.existsSync(ORIGINAL_CWD)) {
        process.chdir(ORIGINAL_CWD);
      } else {
        process.chdir(SAFE_DIRECTORY);
      }
    } catch (e) {
      // Can't recover, continue anyway
    }
  }
});
