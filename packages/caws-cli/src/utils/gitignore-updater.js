/**
 * @fileoverview Gitignore Updater Utility
 * Updates .gitignore to properly handle CAWS runtime files vs source files
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');

/**
 * CAWS .gitignore entries
 *
 * Strategy: Track shared/collaborative files, ignore local-only runtime data
 *
 * TRACKED (shared with team):
 * - .caws/working-spec.yaml (main spec)
 * - .caws/specs/*.yaml (feature specs)
 * - .caws/policy.yaml (team policy)
 * - .caws/waivers/*.yaml (project-wide waivers)
 * - .caws/provenance/ (audit trails for compliance)
 * - .caws/changes/ (change tracking for team visibility)
 * - .caws/archive/ (archived changes for history)
 * - .caws/plans/*.md (implementation plans)
 *
 * IGNORED (local-only):
 * - .agent/ (agent runtime tracking, local to each developer)
 * - Temporary files (*.tmp, *.bak)
 * - Logs (caws.log, debug logs)
 * - Local overrides (caws.local.*)
 */
const CAWS_GITIGNORE_ENTRIES = `
# CAWS Local Runtime Data (developer-specific, should not be tracked)
# ====================================================================
# Note: Specs, policy, waivers, provenance, and plans ARE tracked for team collaboration
# Only local agent tracking, generated tools, and temporary files are ignored

# Agent runtime tracking (local to each developer)
.agent/

# CAWS tools (now in .caws/tools/)
.caws/tools/
# Legacy location (for backward compatibility)
apps/tools/caws/

# Temporary CAWS files
**/*.caws.tmp
**/*.working-spec.bak
.caws/*.tmp
.caws/*.bak

# CAWS logs (local debugging)
caws-debug.log*
**/caws.log
.caws/*.log

# Local development overrides (developer-specific)
caws.local.*
.caws/local.*
`;

/**
 * Update .gitignore to include CAWS runtime file exclusions
 * @param {string} projectRoot - Project root directory
 * @param {Object} options - Options
 * @param {boolean} options.force - Force update even if entries exist
 * @returns {Promise<boolean>} Whether .gitignore was updated
 */
async function updateGitignore(projectRoot, options = {}) {
  const { force = false } = options;
  const gitignorePath = path.join(projectRoot, '.gitignore');

  try {
    // Read existing .gitignore or create empty
    let existingContent = '';
    if (await fs.pathExists(gitignorePath)) {
      existingContent = await fs.readFile(gitignorePath, 'utf8');
    }

    // Check if CAWS entries already exist (check for either old or new header)
    const hasCawsEntries =
      existingContent.includes('# CAWS Local Runtime Data') ||
      existingContent.includes('# CAWS Runtime Data');

    if (hasCawsEntries && !force) {
      // Already has CAWS entries, skip
      return false;
    }

    // If old entries exist, replace them with new ones
    if (existingContent.includes('# CAWS Runtime Data') && force) {
      // Remove old CAWS entries (between "# CAWS Runtime Data" and next major section)
      const lines = existingContent.split('\n');
      const startIndex = lines.findIndex((line) => line.includes('# CAWS Runtime Data'));
      if (startIndex !== -1) {
        // Find the end of CAWS section (next major section starting with #)
        let endIndex = startIndex + 1;
        while (
          endIndex < lines.length &&
          (lines[endIndex].trim() === '' ||
            lines[endIndex].startsWith('#') ||
            lines[endIndex].startsWith('.caws/') ||
            lines[endIndex].startsWith('.agent/') ||
            lines[endIndex].includes('caws') ||
            lines[endIndex].includes('CAWS'))
        ) {
          endIndex++;
        }
        // Remove old section and insert new one
        const before = lines.slice(0, startIndex).join('\n');
        const after = lines.slice(endIndex).join('\n');
        existingContent = [before, after].filter(Boolean).join('\n');
      }
    }

    // Append CAWS entries
    const updatedContent = existingContent.trim() + '\n' + CAWS_GITIGNORE_ENTRIES.trim() + '\n';

    await fs.writeFile(gitignorePath, updatedContent, 'utf8');

    return true;
  } catch (error) {
    console.warn(chalk.yellow(`⚠️  Could not update .gitignore: ${error.message}`));
    return false;
  }
}

/**
 * Verify .gitignore has proper CAWS entries
 * @param {string} projectRoot - Project root directory
 * @returns {Promise<boolean>} Whether .gitignore has CAWS entries
 */
async function verifyGitignore(projectRoot) {
  const gitignorePath = path.join(projectRoot, '.gitignore');

  if (!(await fs.pathExists(gitignorePath))) {
    return false;
  }

  const content = await fs.readFile(gitignorePath, 'utf8');
  return content.includes('# CAWS Local Runtime Data') || content.includes('# CAWS Runtime Data');
}

module.exports = {
  updateGitignore,
  verifyGitignore,
  CAWS_GITIGNORE_ENTRIES,
};
