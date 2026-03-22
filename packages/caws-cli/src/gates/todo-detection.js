/**
 * @fileoverview TODO/FIXME scanning gate
 * Detects actionable TODO, FIXME, HACK, XXX markers in comments.
 * Filters out false positives: string literals, regex definitions, test assertions,
 * and documentation about the TODO system itself.
 * Context-aware: commit context scans staged diff, cli/edit context scans file content.
 * @author @darianrosebrook
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const name = 'todo_detection';

const TODO_MARKERS = /\b(TODO|FIXME|HACK|XXX)\b/g;

/**
 * Comment patterns for languages we scan.
 * A line is a "comment TODO" if the TODO marker appears after a comment introducer.
 */
const COMMENT_TODO = /(?:\/\/|#|\/?\*|\{\/\*)\s*\b(TODO|FIXME|HACK|XXX)\b/;

/**
 * Patterns that indicate the line is ABOUT the TODO system, not an actual TODO.
 * These are lines where TODO appears as data, not as intent.
 */
const FALSE_POSITIVE_PATTERNS = [
  /TODO_PATTERN/,                       // regex variable name
  /TODO\/FIXME/,                        // describing the pattern itself
  /\btoMatch\b|\btoContain\b|\bexpect\(/,  // test assertions
  /writeFileSync.*TODO/,                // test fixture data
  /\bdescribe\(.*TODO|\btest\(.*TODO|\bit\(.*TODO/,  // test names
  /Pattern.*TODO|regex.*TODO/i,         // documentation about patterns
  /["'`].*\bTODO\b.*["'`]/,            // string literals containing TODO
];

/** Directories to skip when scanning files directly */
const EXCLUDE_DIRS = ['node_modules/', 'dist/', 'dist-bundle/', 'build/', '.next/', 'coverage/', 'vendor/', '__pycache__/'];

/** Files that are part of the TODO detection system itself — skip to avoid self-analysis */
const SELF_FILES = ['todo-detection.js', 'todo_detection.js', 'todo_analyzer.py', 'todo-analyzer'];

/** Extensions to scan */
const SOURCE_EXTENSIONS = ['.js', '.ts', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.rb', '.cs', '.sh'];

/**
 * Check if a file should be excluded from scanning.
 * @param {string} filePath - Relative file path
 * @returns {boolean}
 */
function isExcluded(filePath) {
  for (const dir of EXCLUDE_DIRS) {
    if (filePath.startsWith(dir) || filePath.includes('/' + dir)) return true;
  }
  // Skip the gate's own implementation files
  const basename = path.basename(filePath);
  for (const self of SELF_FILES) {
    if (basename === self || basename.includes(self)) return true;
  }
  return false;
}

/**
 * Check if a line contains a real TODO comment (not a false positive).
 * Returns the marker name if real, null if false positive.
 * @param {string} line - Source line
 * @returns {string|null} The marker found, or null
 */
function findRealTodo(line) {
  const trimmed = line.trim();

  // Must contain a marker at all
  TODO_MARKERS.lastIndex = 0;
  if (!TODO_MARKERS.test(trimmed)) return null;

  // Filter out false positives
  for (const fp of FALSE_POSITIVE_PATTERNS) {
    if (fp.test(trimmed)) return null;
  }

  // Must look like a comment containing the marker — not just any line with TODO in it
  if (!COMMENT_TODO.test(trimmed)) return null;

  // Extract which marker
  TODO_MARKERS.lastIndex = 0;
  const match = TODO_MARKERS.exec(trimmed);
  return match ? match[1] : null;
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
      const content = line.slice(1); // remove the leading +
      const marker = findRealTodo(content);
      if (marker) {
        totalCount++;
        messages.push(`${currentFile}:${lineNum}: ${marker} found`);
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
        const marker = findRealTodo(lines[i]);
        if (marker) {
          totalCount++;
          messages.push(`${file}:${i + 1}: ${marker} found`);
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
