/**
 * @fileoverview TODO/FIXME scanning gate
 * Scans staged file diffs for TODO, FIXME, HACK, XXX patterns.
 * @author @darianrosebrook
 */

const { execSync } = require('child_process');

const name = 'todo_detection';

const TODO_PATTERN = /\b(TODO|FIXME|HACK|XXX)\b/g;

/**
 * Run the TODO detection gate
 * @param {Object} params - Gate parameters
 * @param {string[]} params.stagedFiles - Staged file paths
 * @param {string} params.projectRoot - Project root
 * @param {Object} [params.thresholds] - Threshold config (unused currently)
 * @returns {Promise<Object>} Gate result with status and messages
 */
async function run({ stagedFiles, projectRoot }) {
  const messages = [];
  let totalCount = 0;

  try {
    // Get the staged diff to only catch newly-added TODOs
    const diff = execSync('git diff --cached -U0', {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    let currentFile = null;
    let lineNum = 0;

    for (const line of diff.split('\n')) {
      // Track current file from diff headers
      if (line.startsWith('+++ b/')) {
        currentFile = line.slice(6);
        continue;
      }
      // Track line numbers from hunk headers
      if (line.startsWith('@@')) {
        const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
        if (match) {
          lineNum = parseInt(match[1], 10) - 1;
        }
        continue;
      }
      // Only check added lines (not removed or context)
      if (line.startsWith('+') && !line.startsWith('+++')) {
        lineNum++;
        const matches = line.match(TODO_PATTERN);
        if (matches) {
          for (const m of matches) {
            totalCount++;
            messages.push(`${currentFile}:${lineNum}: ${m} found`);
          }
        }
      } else if (!line.startsWith('-')) {
        lineNum++;
      }
    }
  } catch (err) {
    // Fail-closed: if git diff fails, we cannot verify staged changes
    return {
      status: 'warn',
      messages: [`Cannot scan staged changes for TODO markers: ${err.message}`],
    };
  }

  if (totalCount > 0) {
    messages.unshift(`Found ${totalCount} TODO/FIXME/HACK/XXX marker(s) in staged changes`);
    return { status: 'warn', messages };
  }

  return { status: 'pass', messages };
}

module.exports = { name, run };
