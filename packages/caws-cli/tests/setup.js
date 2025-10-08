/**
 * Setup file for Jest tests to handle CI environment issues
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');

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
  }
});

// Mock process.cwd to handle CI issues
const originalCwd = process.cwd;
process.cwd = () => {
  try {
    return originalCwd();
  } catch (error) {
    // Fallback to a safe directory
    return path.join(__dirname, '..', '..');
  }
};
