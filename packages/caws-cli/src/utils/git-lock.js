/**
 * @fileoverview Git Lock Detection Utilities
 * Functions for detecting and handling git locks
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');

/**
 * Check for git lock files
 * @param {string} projectRoot - Project root directory
 * @returns {Object} Lock status information
 */
function checkGitLock(projectRoot) {
  const lockFile = path.join(projectRoot, '.git', 'index.lock');
  const headLockFile = path.join(projectRoot, '.git', 'HEAD.lock');

  const result = {
    locked: false,
    stale: false,
    lockFiles: [],
    message: null,
    suggestion: null,
  };

  // Check index.lock
  if (fs.existsSync(lockFile)) {
    const lockAge = Date.now() - fs.statSync(lockFile).mtimeMs;
    const lockAgeMinutes = Math.floor(lockAge / 60000);

    result.locked = true;
    result.lockFiles.push({
      path: '.git/index.lock',
      age: lockAgeMinutes,
      stale: lockAgeMinutes > 5,
    });

    if (lockAgeMinutes > 5) {
      // Stale lock (older than 5 minutes)
      result.stale = true;
      result.message = `Stale git lock detected (${lockAgeMinutes} minutes old). This may indicate a crashed git process.`;
      result.suggestion = 'Remove stale lock: rm .git/index.lock';
    } else {
      // Active lock
      result.message =
        'Git lock detected. Another git process may be running.';
      result.suggestion =
        'Wait for the other process to complete, or check for running git/editor processes';
    }
  }

  // Check HEAD.lock
  if (fs.existsSync(headLockFile)) {
    const lockAge = Date.now() - fs.statSync(headLockFile).mtimeMs;
    const lockAgeMinutes = Math.floor(lockAge / 60000);

    result.locked = true;
    result.lockFiles.push({
      path: '.git/HEAD.lock',
      age: lockAgeMinutes,
      stale: lockAgeMinutes > 5,
    });

    if (lockAgeMinutes > 5) {
      result.stale = true;
      if (!result.message) {
        result.message = `Stale git lock detected (${lockAgeMinutes} minutes old).`;
        result.suggestion = 'Remove stale lock: rm .git/HEAD.lock';
      }
    }
  }

  return result;
}

/**
 * Format git lock error message
 * @param {Object} lockStatus - Lock status from checkGitLock
 * @returns {string} Formatted error message
 */
function formatGitLockError(lockStatus) {
  if (!lockStatus.locked) {
    return null;
  }

  let message = '⚠️  Git lock detected\n';
  message += `   ${lockStatus.message}\n`;

  if (lockStatus.lockFiles.length > 0) {
    message += '\n   Lock files:\n';
    for (const lockFile of lockStatus.lockFiles) {
      message += `   - ${lockFile.path} (${lockFile.age} minutes old)`;
      if (lockFile.stale) {
        message += ' [STALE]';
      }
      message += '\n';
    }
  }

  if (lockStatus.suggestion) {
    message += `\n   💡 ${lockStatus.suggestion}\n`;
  }

  if (lockStatus.stale) {
    message +=
      '\n   ⚠️  Warning: Removing stale locks may cause data loss if another process is actually running.\n';
    message += '   Check for running git/editor processes before removing locks.\n';
  }

  return message;
}

module.exports = {
  checkGitLock,
  formatGitLockError,
};

