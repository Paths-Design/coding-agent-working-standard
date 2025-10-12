/**
 * Pre-setup file that runs before Jest environment is initialized
 * Handles process.cwd override to prevent ENOENT errors
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');

// Safe directory fallback
const SAFE_DIRECTORY = path.join(__dirname, '..'); // packages/caws-cli directory

// Create a wrapper for process.cwd that never fails
const originalCwd = process.cwd.bind(process);
const safeCwd = () => {
  try {
    const cwd = originalCwd();
    if (fs.existsSync(cwd)) {
      return cwd;
    }
    // Directory doesn't exist, return safe directory
    return SAFE_DIRECTORY;
  } catch (error) {
    // Can't get cwd, return safe directory
    return SAFE_DIRECTORY;
  }
};

// Override process.cwd globally before Jest initializes
Object.defineProperty(process, 'cwd', {
  writable: true,
  configurable: true,
  value: safeCwd,
});
