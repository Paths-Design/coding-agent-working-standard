/**
 * @fileoverview Claude Code Hooks Scaffolding
 * Functions for setting up Claude Code hooks for CAWS projects
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');

// Import detection utilities
const { detectCAWSSetup, findPackageRoot } = require('../utils/detection');

/**
 * Scaffold Claude Code hooks for a CAWS project
 * Creates .claude/settings.json with hooks and .claude/hooks/ directory with scripts
 *
 * @param {string} projectDir - Project directory path
 * @param {string[]} levels - Hook levels to enable: 'safety', 'quality', 'scope', 'audit'
 */
async function scaffoldClaudeHooks(projectDir, levels = ['safety', 'quality', 'scope', 'audit']) {
  try {
    const claudeDir = path.join(projectDir, '.claude');
    const claudeHooksDir = path.join(claudeDir, 'hooks');

    // Create .claude directory structure
    await fs.ensureDir(claudeDir);
    await fs.ensureDir(claudeHooksDir);

    // Determine template directory - prefer bundled templates
    const setup = detectCAWSSetup(projectDir);

    // Find package root using shared utility
    const packageRoot = findPackageRoot(__dirname);

    // Try templates relative to package root first (works in both dev and global install)
    const bundledTemplateDir = path.join(packageRoot, 'templates');
    const fallbackTemplateDir = path.join(__dirname, '../../templates');
    const templateDir = fs.existsSync(bundledTemplateDir)
      ? bundledTemplateDir
      : fs.existsSync(fallbackTemplateDir)
      ? fallbackTemplateDir
      : setup.templateDir || path.resolve(__dirname, '../templates');

    const claudeTemplateDir = path.join(templateDir, '.claude');
    const claudeHooksTemplateDir = path.join(claudeTemplateDir, 'hooks');

    if (!fs.existsSync(claudeTemplateDir)) {
      console.warn(chalk.yellow('Claude Code hooks templates not found'));
      console.warn(chalk.blue('Skipping Claude Code hooks setup'));
      return;
    }

    // Map levels to hook scripts
    const hookMapping = {
      safety: ['block-dangerous.sh', 'scan-secrets.sh', 'worktree-guard.sh', 'worktree-write-guard.sh', 'stop-worktree-check.sh', 'session-caws-status.sh'],
      quality: ['quality-check.sh', 'validate-spec.sh'],
      scope: ['scope-guard.sh', 'naming-check.sh'],
      audit: ['audit.sh', 'session-log.sh'],
      lite: ['block-dangerous.sh', 'scope-guard.sh', 'lite-sprawl-check.sh', 'simplification-guard.sh'],
    };

    // Determine which hooks to enable
    const enabledHooks = new Set();
    levels.forEach((level) => {
      const hooks = hookMapping[level] || [];
      hooks.forEach((hook) => enabledHooks.add(hook));
    });

    // Always enable audit.sh if any hooks are enabled
    if (enabledHooks.size > 0) {
      enabledHooks.add('audit.sh');
    }

    // Copy enabled hook scripts
    const allHookScripts = [
      'audit.sh',
      'validate-spec.sh',
      'quality-check.sh',
      'scan-secrets.sh',
      'block-dangerous.sh',
      'scope-guard.sh',
      'naming-check.sh',
      'lite-sprawl-check.sh',
      'simplification-guard.sh',
      'worktree-guard.sh',
      'worktree-write-guard.sh',
      'stop-worktree-check.sh',
      'session-caws-status.sh',
      'session-log.sh',
    ];

    for (const script of allHookScripts) {
      if (enabledHooks.has(script)) {
        const sourcePath = path.join(claudeHooksTemplateDir, script);
        const destPath = path.join(claudeHooksDir, script);

        if (fs.existsSync(sourcePath)) {
          await fs.copy(sourcePath, destPath);
          // Make executable
          await fs.chmod(destPath, 0o755);
        }
      }
    }

    // Generate settings.json with hooks configuration
    const settings = generateClaudeSettings(levels, enabledHooks);

    // Check for existing settings and merge
    const settingsPath = path.join(claudeDir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        const existingSettings = await fs.readJSON(settingsPath);
        // Merge hooks, preserving existing non-hook settings
        settings.hooks = {
          ...existingSettings.hooks,
          ...settings.hooks,
        };
        // Preserve other settings
        Object.keys(existingSettings).forEach((key) => {
          if (key !== 'hooks' && !(key in settings)) {
            settings[key] = existingSettings[key];
          }
        });
      } catch (error) {
        console.warn(chalk.yellow('Could not merge existing settings:'), error.message);
      }
    }

    // Write settings.json
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));

    // Copy README if it exists
    const readmePath = path.join(claudeTemplateDir, 'README.md');
    if (fs.existsSync(readmePath)) {
      await fs.copy(readmePath, path.join(claudeDir, 'README.md'));
    }

    // Copy rules directory if it exists
    const rulesTemplateDir = path.join(claudeTemplateDir, 'rules');
    if (fs.existsSync(rulesTemplateDir)) {
      const rulesDir = path.join(claudeDir, 'rules');
      await fs.ensureDir(rulesDir);
      await fs.copy(rulesTemplateDir, rulesDir, { overwrite: false });
    }

    console.log(chalk.green('Claude Code hooks configured'));
    console.log(chalk.gray(`   Enabled: ${levels.join(', ')}`));
    console.log(
      chalk.gray(`   Scripts: ${Array.from(enabledHooks).length} hook scripts installed`)
    );
    console.log(chalk.blue('Hooks will activate on next Claude Code session'));
  } catch (error) {
    console.error(chalk.yellow('Failed to setup Claude Code hooks:'), error.message);
    console.log(chalk.blue('You can manually copy .claude/ directory later'));
  }
}

/**
 * Generate Claude Code settings with hooks configuration
 * @param {string[]} levels - Enabled hook levels
 * @param {Set<string>} enabledHooks - Set of enabled hook script names
 * @returns {Object} Settings object for settings.json
 */
function generateClaudeSettings(levels, _enabledHooks) {
  const settings = {
    hooks: {},
  };

  // Build hooks configuration based on enabled levels
  // Claude Code uses different event names and matcher patterns

  if (levels.includes('safety')) {
    // Block dangerous bash commands
    settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];
    settings.hooks.PreToolUse.push({
      matcher: 'Bash',
      hooks: [
        {
          type: 'command',
          command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/block-dangerous.sh',
          timeout: 10,
        },
        {
          type: 'command',
          command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/worktree-guard.sh',
          timeout: 10,
        },
      ],
    });

    // Scan for secrets on file read
    settings.hooks.PreToolUse.push({
      matcher: 'Read',
      hooks: [
        {
          type: 'command',
          command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/scan-secrets.sh',
          timeout: 10,
        },
      ],
    });

    // Block Write/Edit on base branch while worktrees are active
    settings.hooks.PreToolUse.push({
      matcher: 'Write|Edit',
      hooks: [
        {
          type: 'command',
          command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/worktree-write-guard.sh',
          timeout: 10,
        },
      ],
    });

    // Worktree status warning on session start
    settings.hooks.SessionStart = settings.hooks.SessionStart || [];
    settings.hooks.SessionStart.push({
      hooks: [
        {
          type: 'command',
          command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/session-caws-status.sh session-start',
          timeout: 10,
        },
      ],
    });

    // Worktree cleanup reminder on session end
    settings.hooks.Stop = settings.hooks.Stop || [];
    settings.hooks.Stop.push({
      hooks: [
        {
          type: 'command',
          command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/stop-worktree-check.sh',
          timeout: 10,
        },
      ],
    });
  }

  if (levels.includes('quality')) {
    // Run quality checks after file edits
    settings.hooks.PostToolUse = settings.hooks.PostToolUse || [];
    settings.hooks.PostToolUse.push({
      matcher: 'Write|Edit',
      hooks: [
        {
          type: 'command',
          command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/quality-check.sh',
          timeout: 30,
        },
        {
          type: 'command',
          command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/validate-spec.sh',
          timeout: 15,
        },
      ],
    });
  }

  if (levels.includes('scope')) {
    // Scope guard before file writes
    settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];
    settings.hooks.PreToolUse.push({
      matcher: 'Write|Edit',
      hooks: [
        {
          type: 'command',
          command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/scope-guard.sh',
          timeout: 10,
        },
      ],
    });

    // Naming check after edits
    settings.hooks.PostToolUse = settings.hooks.PostToolUse || [];
    settings.hooks.PostToolUse.push({
      matcher: 'Write|Edit',
      hooks: [
        {
          type: 'command',
          command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/naming-check.sh',
          timeout: 10,
        },
      ],
    });
  }

  if (levels.includes('lite')) {
    // Lite mode: sprawl check on Write, simplification guard on Edit
    settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];
    settings.hooks.PreToolUse.push({
      matcher: 'Write',
      hooks: [
        {
          type: 'command',
          command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/lite-sprawl-check.sh',
          timeout: 10,
        },
      ],
    });
    settings.hooks.PreToolUse.push({
      matcher: 'Edit',
      hooks: [
        {
          type: 'command',
          command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/simplification-guard.sh',
          timeout: 10,
        },
      ],
    });
  }

  if (levels.includes('audit')) {
    // Session audit logging
    settings.hooks.SessionStart = settings.hooks.SessionStart || [];
    settings.hooks.SessionStart.push({
      hooks: [
        {
          type: 'command',
          command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/audit.sh session-start',
          timeout: 5,
        },
        {
          type: 'command',
          command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/session-log.sh',
          timeout: 10,
        },
      ],
    });

    settings.hooks.Stop = settings.hooks.Stop || [];
    settings.hooks.Stop.push({
      hooks: [
        {
          type: 'command',
          command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/audit.sh stop',
          timeout: 5,
        },
        {
          type: 'command',
          command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/session-log.sh',
          timeout: 15,
        },
      ],
    });

    // Session transcript generation on context compaction
    settings.hooks.PreCompact = settings.hooks.PreCompact || [];
    settings.hooks.PreCompact.push({
      hooks: [
        {
          type: 'command',
          command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/session-log.sh',
          timeout: 15,
        },
      ],
    });

    // Audit tool usage
    settings.hooks.PostToolUse = settings.hooks.PostToolUse || [];
    settings.hooks.PostToolUse.push({
      matcher: 'Write|Edit|Bash',
      hooks: [
        {
          type: 'command',
          command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/audit.sh tool-use',
          timeout: 5,
        },
      ],
    });
  }

  return settings;
}

/**
 * Check if Claude Code hooks are already configured
 * @param {string} projectDir - Project directory
 * @returns {boolean} True if hooks are configured
 */
function hasClaudeHooks(projectDir) {
  const settingsPath = path.join(projectDir, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    return false;
  }

  try {
    const settings = fs.readJSONSync(settingsPath);
    return settings.hooks && Object.keys(settings.hooks).length > 0;
  } catch {
    return false;
  }
}

/**
 * List configured Claude Code hooks
 * @param {string} projectDir - Project directory
 * @returns {Object} Hook configuration or null
 */
function getClaudeHooksConfig(projectDir) {
  const settingsPath = path.join(projectDir, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    return null;
  }

  try {
    const settings = fs.readJSONSync(settingsPath);
    return settings.hooks || null;
  } catch {
    return null;
  }
}

module.exports = {
  scaffoldClaudeHooks,
  generateClaudeSettings,
  hasClaudeHooks,
  getClaudeHooksConfig,
};
