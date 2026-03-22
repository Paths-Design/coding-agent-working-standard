/**
 * @fileoverview God object detection gate
 * Flags large files that exceed line-count thresholds.
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');

const name = 'god_object';

const SOURCE_EXTENSIONS = ['.js', '.ts', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.rb', '.cs'];

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
  const warningThreshold = thresholds?.warning || 1750;
  const criticalThreshold = thresholds?.critical || 2000;
  const messages = [];
  let hasCritical = false;
  let hasWarning = false;

  const sourceFiles = stagedFiles.filter(f =>
    SOURCE_EXTENSIONS.some(ext => f.endsWith(ext))
  );

  for (const file of sourceFiles) {
    try {
      const fullPath = path.resolve(projectRoot, file);
      if (!fs.existsSync(fullPath)) continue;

      const content = fs.readFileSync(fullPath, 'utf8');
      const lineCount = content.split('\n').length;

      if (lineCount >= criticalThreshold) {
        hasCritical = true;
        messages.push(`CRITICAL: ${file} has ${lineCount} lines (threshold: ${criticalThreshold})`);
      } else if (lineCount >= warningThreshold) {
        hasWarning = true;
        messages.push(`WARNING: ${file} has ${lineCount} lines (threshold: ${warningThreshold})`);
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
