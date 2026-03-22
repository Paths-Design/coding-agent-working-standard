/**
 * @fileoverview God object detection gate
 * Flags large files that exceed line-count thresholds.
 * Test files use a higher threshold since large integration tests are normal.
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');

const name = 'god_object';

const SOURCE_EXTENSIONS = ['.js', '.ts', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.rb', '.cs'];

/** Directories and patterns that are always excluded (generated/vendored content) */
const DEFAULT_EXCLUDE_DIRS = [
  'dist/', 'dist-bundle/', 'build/', '.next/', 'out/',
  'node_modules/', '__pycache__/', '.nuxt/', 'coverage/',
  'vendor/', '.cache/',
];

/** File patterns that are always excluded */
const DEFAULT_EXCLUDE_PATTERNS = ['.min.', '.bundle.', '.generated.'];

/** Patterns that identify test files (get higher thresholds) */
const TEST_PATTERNS = [
  '.test.', '.spec.', '_test.', '_spec.',
  'tests/', 'test/', '__tests__/', '__test__/',
  'proving-grounds/', 'fixtures/',
];

/** Default multiplier for test file thresholds (2x = test files get double the threshold) */
const TEST_THRESHOLD_MULTIPLIER = 2;

/**
 * Check if a file should be excluded from god-object analysis.
 * @param {string} filePath - Relative file path
 * @returns {boolean} Whether the file is excluded
 */
function isExcluded(filePath) {
  for (const dir of DEFAULT_EXCLUDE_DIRS) {
    if (filePath.startsWith(dir) || filePath.includes('/' + dir)) return true;
  }
  for (const pat of DEFAULT_EXCLUDE_PATTERNS) {
    if (filePath.includes(pat)) return true;
  }
  return false;
}

/**
 * Check if a file is a test file.
 * @param {string} filePath - Relative file path
 * @returns {boolean}
 */
function isTestFile(filePath) {
  const lower = filePath.toLowerCase();
  return TEST_PATTERNS.some(pat => lower.includes(pat));
}

/**
 * Run the god object detection gate
 * @param {Object} params - Gate parameters
 * @param {string[]} params.stagedFiles - Staged file paths
 * @param {string} params.projectRoot - Project root
 * @param {Object} [params.thresholds] - Override thresholds
 * @param {number} [params.thresholds.warning=1750] - Warning line threshold
 * @param {number} [params.thresholds.critical=2000] - Critical/fail line threshold
 * @returns {Promise<Object>} Gate result with status and messages
 */
async function run({ stagedFiles, projectRoot, thresholds }) {
  const baseWarning = thresholds?.warning || 1750;
  const baseCritical = thresholds?.critical || 2000;
  const messages = [];
  let hasCritical = false;
  let hasWarning = false;

  const sourceFiles = stagedFiles.filter(f =>
    SOURCE_EXTENSIONS.some(ext => f.endsWith(ext)) && !isExcluded(f)
  );

  for (const file of sourceFiles) {
    try {
      const fullPath = path.resolve(projectRoot, file);
      if (!fs.existsSync(fullPath)) continue;

      const content = fs.readFileSync(fullPath, 'utf8');
      const lineCount = content.split('\n').length;

      // Test files get a higher threshold — large integration tests are normal
      const mult = isTestFile(file) ? TEST_THRESHOLD_MULTIPLIER : 1;
      const warningThreshold = baseWarning * mult;
      const criticalThreshold = baseCritical * mult;

      if (lineCount >= criticalThreshold) {
        hasCritical = true;
        const label = mult > 1 ? 'CRITICAL (test file)' : 'CRITICAL';
        messages.push(`${label}: ${file} has ${lineCount} lines (threshold: ${criticalThreshold})`);
      } else if (lineCount >= warningThreshold) {
        hasWarning = true;
        const label = mult > 1 ? 'WARNING (test file)' : 'WARNING';
        messages.push(`${label}: ${file} has ${lineCount} lines (threshold: ${warningThreshold})`);
      }
    } catch (err) {
      messages.push(`WARNING: Could not read ${file}: ${err.message}`);
    }
  }

  if (hasCritical) {
    return { status: 'fail', messages };
  }
  if (hasWarning) {
    return { status: 'warn', messages };
  }
  return { status: 'pass', messages };
}

module.exports = { name, run };
