/**
 * @fileoverview TODO/FIXME scanning gate
 * Scans for TODO, FIXME, HACK, XXX patterns.
 * Context-aware: commit context scans staged diff, cli/edit context scans file content.
 * @author @darianrosebrook
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const name = 'todo_detection';

const TODO_PATTERN = /\b(TODO|FIXME|HACK|XXX)\b/g;

/** Directories to skip when scanning files directly */
const EXCLUDE_DIRS = ['node_modules/', 'dist/', 'dist-bundle/', 'build/', '.next/', 'coverage/', 'vendor/', '__pycache__/'];

/** Extensions to scan */
const SOURCE_EXTENSIONS = ['.js', '.ts', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.rb', '.cs', '.sh', '.yaml', '.yml'];

/**
 * Check if a file should be excluded from scanning.
 * @param {string} filePath - Relative file path
 * @returns {boolean}
 */
function isExcluded(filePath) {
  for (const dir of EXCLUDE_DIRS) {
    if (filePath.startsWith(dir) || filePath.includes('/' + dir)) return true;
  }
  return false;
}

/**
 * Scan staged diff for newly-added TODO markers.
 * Used in commit context — only flags markers being added, not pre-existing ones.
 */
function scanStagedDiff(projectRoot) {
  const messages = [];
  let totalCount = 0;

  const diff = execSync('git diff --cached -U0', {
    cwd: projectRoot,
    encoding: 'utf8',
  });

  let currentFile = null;
  let lineNum = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      continue;
    }
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
      if (match) {
        lineNum = parseInt(match[1], 10) - 1;
      }
      continue;
    }
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

  return { totalCount, messages };
}

/**
 * Scan file contents directly for TODO markers.
 * Used in cli/edit context — reports all existing markers in the given files.
 */
function scanFiles(stagedFiles, projectRoot) {
  const messages = [];
  let totalCount = 0;

  const filesToScan = stagedFiles.filter(f =>
    SOURCE_EXTENSIONS.some(ext => f.endsWith(ext)) && !isExcluded(f)
  );

  for (const file of filesToScan) {
    try {
      const fullPath = path.resolve(projectRoot, file);
      if (!fs.existsSync(fullPath)) continue;

      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const matches = lines[i].match(TODO_PATTERN);
        if (matches) {
          for (const m of matches) {
            totalCount++;
            messages.push(`${file}:${i + 1}: ${m} found`);
          }
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return { totalCount, messages };
}

/**
 * Run the TODO detection gate
 * @param {Object} params - Gate parameters
 * @param {string[]} params.stagedFiles - File paths to check
 * @param {string} params.projectRoot - Project root
 * @param {string} [params.context] - Execution context (commit, cli, edit)
 * @returns {Promise<Object>} Gate result with status and messages
 */
async function run({ stagedFiles, projectRoot, context }) {
  try {
    let result;

    if (context === 'commit') {
      // Commit context: scan only newly-added lines in staged diff
      result = scanStagedDiff(projectRoot);
    } else {
      // CLI/edit context: scan file contents directly
      result = scanFiles(stagedFiles, projectRoot);
    }

    if (result.totalCount > 0) {
      result.messages.unshift(`Found ${result.totalCount} TODO/FIXME/HACK/XXX marker(s)${context === 'commit' ? ' in staged changes' : ''}`);
      return { status: 'warn', messages: result.messages };
    }

    return { status: 'pass', messages: [] };
  } catch (err) {
    return {
      status: 'warn',
      messages: [`Cannot scan for TODO markers: ${err.message}`],
    };
  }
}

module.exports = { name, run };
