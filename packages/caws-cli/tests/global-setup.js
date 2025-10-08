/**
 * Global setup for Jest tests to handle CI environment issues
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');

module.exports = async () => {
  // Ensure we have a valid working directory
  const cwd = process.cwd();
  
  // If working directory doesn't exist (CI issue), create it
  if (!fs.existsSync(cwd)) {
    console.log('⚠️  Working directory does not exist, creating...');
    fs.mkdirSync(cwd, { recursive: true });
  }
  
  // Ensure we're in the right directory
  process.chdir(cwd);
  
  console.log(`✅ Jest global setup complete - working directory: ${cwd}`);
};
