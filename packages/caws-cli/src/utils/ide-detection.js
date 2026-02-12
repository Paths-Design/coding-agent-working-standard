/**
 * @fileoverview IDE Detection and Selection Utilities
 * Detects active IDEs from environment variables and provides
 * selection/parsing helpers for the --ide CLI flag.
 * @author @darianrosebrook
 */

const chalk = require('chalk');

/**
 * Registry of supported IDE integrations.
 * Each entry maps an ID to its display name, description, and detection env vars.
 */
const IDE_REGISTRY = {
  cursor: {
    id: 'cursor',
    name: 'Cursor',
    description: 'AI-first IDE with hooks, rules, and audit logs',
    envVars: ['CURSOR_TRACE_DIR'],
  },
  claude: {
    id: 'claude',
    name: 'Claude Code',
    description: 'Claude Code with safety hooks and settings',
    envVars: ['CLAUDE_PROJECT_DIR'],
  },
  vscode: {
    id: 'vscode',
    name: 'VS Code',
    description: 'Visual Studio Code settings and debug configs',
    envVars: ['VSCODE_PID', 'VSCODE_IPC_HOOK'],
  },
  intellij: {
    id: 'intellij',
    name: 'IntelliJ IDEA',
    description: 'IntelliJ run configurations for CAWS',
    envVars: ['IDEA_INITIAL_DIRECTORY'],
  },
  windsurf: {
    id: 'windsurf',
    name: 'Windsurf',
    description: 'Windsurf workflow for CAWS-guided development',
    envVars: ['WINDSURF_WORKSPACE'],
  },
  copilot: {
    id: 'copilot',
    name: 'GitHub Copilot',
    description: 'GitHub Copilot CAWS integration instructions',
    envVars: [], // No reliable env var; paired with vscode
  },
  junie: {
    id: 'junie',
    name: 'JetBrains Junie',
    description: 'Junie AI agent guidelines for JetBrains IDEs',
    envVars: [], // Paired with intellij
  },
};

const ALL_IDE_IDS = Object.keys(IDE_REGISTRY);

/**
 * Detect currently active IDEs from environment variables.
 * @returns {string[]} Array of detected IDE identifiers
 */
function detectActiveIDEs() {
  const detected = [];
  for (const [id, config] of Object.entries(IDE_REGISTRY)) {
    if (config.envVars.length > 0 && config.envVars.some((v) => process.env[v])) {
      detected.push(id);
    }
  }
  return detected;
}

/**
 * Get recommended IDE set based on detection and natural pairings.
 * - Cursor detected -> also recommend Claude Code
 * - VS Code detected -> also recommend Copilot
 * - Nothing detected -> default to cursor + claude (AI-first set)
 * @returns {string[]} Array of recommended IDE identifiers
 */
function getRecommendedIDEs() {
  const detected = detectActiveIDEs();

  if (detected.length > 0) {
    const recommended = new Set(detected);
    if (detected.includes('cursor')) recommended.add('claude');
    if (detected.includes('vscode')) recommended.add('copilot');
    if (detected.includes('intellij')) recommended.add('junie');
    return Array.from(recommended);
  }

  return ['cursor', 'claude'];
}

/**
 * Parse an IDE selection from a CLI flag value or prompt answer.
 * @param {string|string[]} input - Comma-separated string or array of IDE ids
 * @returns {string[]} Normalized, validated array of IDE identifiers
 */
function parseIDESelection(input) {
  if (!input) return [];

  let ids;
  if (typeof input === 'string') {
    ids = input.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  } else if (Array.isArray(input)) {
    ids = input.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  } else {
    return [];
  }

  if (ids.includes('all')) return [...ALL_IDE_IDS];
  if (ids.includes('none')) return [];

  const valid = ids.filter((id) => id in IDE_REGISTRY);
  const invalid = ids.filter((id) => !(id in IDE_REGISTRY));

  if (invalid.length > 0) {
    console.warn(chalk.yellow(`Warning: Unknown IDE identifiers: ${invalid.join(', ')}`));
    console.warn(chalk.blue(`Valid options: ${ALL_IDE_IDS.join(', ')}, all, none`));
  }

  return valid;
}

module.exports = {
  IDE_REGISTRY,
  ALL_IDE_IDS,
  detectActiveIDEs,
  getRecommendedIDEs,
  parseIDESelection,
};
