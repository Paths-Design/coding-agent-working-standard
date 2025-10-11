/**
 * @fileoverview Cursor Hooks Scaffolding
 * Functions for setting up Cursor IDE hooks for CAWS
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');

// Import detection utilities
const { detectCAWSSetup } = require('../utils/detection');

/**
 * Scaffold Cursor hooks for a CAWS project
 * @param {string} projectDir - Project directory path
 * @param {string[]} levels - Hook levels to enable
 */
async function scaffoldCursorHooks(projectDir, levels = ['safety', 'quality', 'scope', 'audit']) {
  try {
    const cursorDir = path.join(projectDir, '.cursor');
    const cursorHooksDir = path.join(cursorDir, 'hooks');

    // Create .cursor directory structure
    await fs.ensureDir(cursorDir);
    await fs.ensureDir(cursorHooksDir);
    await fs.ensureDir(path.join(cursorDir, 'logs'));

    // Determine template directory - prefer bundled templates
    const setup = detectCAWSSetup(projectDir);
    const bundledTemplateDir = path.join(__dirname, '../../templates');
    const templateDir = fs.existsSync(bundledTemplateDir)
      ? bundledTemplateDir
      : setup.templateDir || path.resolve(__dirname, '../templates');

    const cursorTemplateDir = path.join(templateDir, '.cursor');
    const cursorHooksTemplateDir = path.join(cursorTemplateDir, 'hooks');

    if (!fs.existsSync(cursorTemplateDir)) {
      console.warn(chalk.yellow('⚠️  Cursor hooks templates not found'));
      console.warn(chalk.blue('💡 Skipping Cursor hooks setup'));
      return;
    }

    // Map levels to hook scripts
    const hookMapping = {
      safety: ['scan-secrets.sh', 'block-dangerous.sh'],
      quality: ['format.sh', 'validate-spec.sh'],
      scope: ['scope-guard.sh', 'naming-check.sh'],
      audit: ['audit.sh'],
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
      'format.sh',
      'scan-secrets.sh',
      'block-dangerous.sh',
      'scope-guard.sh',
      'naming-check.sh',
    ];

    for (const script of allHookScripts) {
      if (enabledHooks.has(script)) {
        const sourcePath = path.join(cursorHooksTemplateDir, script);
        const destPath = path.join(cursorHooksDir, script);

        if (fs.existsSync(sourcePath)) {
          await fs.copy(sourcePath, destPath);
          // Make executable
          await fs.chmod(destPath, 0o755);
        }
      }
    }

    // Generate hooks.json based on enabled hooks
    const hooksConfig = {
      version: 1,
      hooks: {},
    };

    // Build hooks configuration based on enabled levels
    if (levels.includes('safety')) {
      hooksConfig.hooks.beforeShellExecution = [
        { command: './.cursor/hooks/block-dangerous.sh' },
        { command: './.cursor/hooks/audit.sh' },
      ];
      hooksConfig.hooks.beforeMCPExecution = [{ command: './.cursor/hooks/audit.sh' }];
      hooksConfig.hooks.beforeReadFile = [{ command: './.cursor/hooks/scan-secrets.sh' }];
    }

    if (levels.includes('quality')) {
      hooksConfig.hooks.afterFileEdit = hooksConfig.hooks.afterFileEdit || [];
      hooksConfig.hooks.afterFileEdit.push(
        { command: './.cursor/hooks/format.sh' },
        { command: './.cursor/hooks/validate-spec.sh' }
      );
    }

    if (levels.includes('scope')) {
      hooksConfig.hooks.afterFileEdit = hooksConfig.hooks.afterFileEdit || [];
      hooksConfig.hooks.afterFileEdit.push({ command: './.cursor/hooks/naming-check.sh' });
      hooksConfig.hooks.beforeSubmitPrompt = [
        { command: './.cursor/hooks/scope-guard.sh' },
        { command: './.cursor/hooks/audit.sh' },
      ];
    }

    if (levels.includes('audit')) {
      // Add audit to all events
      if (!hooksConfig.hooks.afterFileEdit) {
        hooksConfig.hooks.afterFileEdit = [];
      }
      hooksConfig.hooks.afterFileEdit.push({ command: './.cursor/hooks/audit.sh' });

      hooksConfig.hooks.stop = [{ command: './.cursor/hooks/audit.sh' }];
    }

    // Write hooks.json
    await fs.writeFile(path.join(cursorDir, 'hooks.json'), JSON.stringify(hooksConfig, null, 2));

    // Copy README
    const readmePath = path.join(cursorTemplateDir, 'README.md');
    if (fs.existsSync(readmePath)) {
      await fs.copy(readmePath, path.join(cursorDir, 'README.md'));
    }

    // Copy rules directory if it exists
    const rulesTemplateDir = path.join(cursorTemplateDir, 'rules');
    const rulesDestDir = path.join(cursorDir, 'rules');
    if (fs.existsSync(rulesTemplateDir)) {
      try {
        await fs.ensureDir(rulesDestDir);
        await fs.copy(rulesTemplateDir, rulesDestDir);
        const ruleFiles = fs.readdirSync(rulesTemplateDir).filter((file) => file.endsWith('.mdc'));
        console.log(chalk.green('✅ Cursor rules configured'));
        console.log(chalk.gray(`   Rules: ${ruleFiles.length} rule files installed`));
      } catch (error) {
        console.warn(chalk.yellow('⚠️  Failed to copy Cursor rules:'), error.message);
      }
    }

    console.log(chalk.green('✅ Cursor hooks configured'));
    console.log(chalk.gray(`   Enabled: ${levels.join(', ')}`));
    console.log(
      chalk.gray(`   Scripts: ${Array.from(enabledHooks).length} hook scripts installed`)
    );
    console.log(chalk.blue('💡 Restart Cursor to activate hooks'));
  } catch (error) {
    console.error(chalk.yellow('⚠️  Failed to setup Cursor hooks:'), error.message);
    console.log(chalk.blue('💡 You can manually copy .cursor/ directory later'));
  }
}

module.exports = {
  scaffoldCursorHooks,
};
