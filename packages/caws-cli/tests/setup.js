/**
 * Setup file for Jest tests to handle CI environment issues
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');

// Save the original working directory at test suite start
const ORIGINAL_CWD = process.cwd();
const SAFE_DIRECTORY = path.join(__dirname, '..'); // packages/caws-cli directory

// Ensure working directory exists and is valid
beforeAll(() => {
  const cwd = process.cwd();

  // If working directory doesn't exist (CI issue), create it
  if (!fs.existsSync(cwd)) {
    console.log('⚠️  Working directory does not exist in test, creating...');
    fs.mkdirSync(cwd, { recursive: true });
  }

  // Ensure we're in the right directory
  try {
    process.chdir(cwd);
  } catch (error) {
    console.log('⚠️  Could not change to working directory:', error.message);
    // Try to go to a safe directory
    try {
      process.chdir(SAFE_DIRECTORY);
    } catch (e) {
      // Can't recover, continue anyway
    }
  }
});

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
    // Can't get current directory, restore to safe
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

// Mock process.cwd to handle CI issues
const originalCwd = process.cwd.bind(process);
process.cwd = () => {
  try {
    const cwd = originalCwd();
    // Verify the directory exists
    if (!fs.existsSync(cwd)) {
      // Fallback to a safe directory
      return SAFE_DIRECTORY;
    }
    return cwd;
  } catch (error) {
    // Fallback to a safe directory
    return SAFE_DIRECTORY;
  }
};
