/**
 * @fileoverview Spec Types and Status Constants
 * Defines spec types, statuses, and their metadata for consistent display
 * @author @darianrosebrook
 */

const chalk = require('chalk');

/**
 * Spec types and their metadata
 */
const SPEC_TYPES = {
  feature: {
    color: chalk.green,
    icon: '',
    description: 'New feature development',
  },
  fix: {
    color: chalk.red,
    icon: '',
    description: 'Bug fixes and patches',
  },
  refactor: {
    color: chalk.blue,
    icon: '',
    description: 'Code refactoring and improvements',
  },
  chore: {
    color: chalk.gray,
    icon: '',
    description: 'Maintenance and cleanup',
  },
  docs: {
    color: chalk.cyan,
    icon: '',
    description: 'Documentation updates',
  },
};

/**
 * Spec statuses and lifecycle metadata.
 * Terminal statuses mean the spec is done — its scope restrictions
 * should NOT be enforced by the scope guard.
 */
const SPEC_STATUSES = {
  draft: { label: 'Draft', color: chalk.yellow, terminal: false },
  active: { label: 'Active', color: chalk.green, terminal: false },
  in_progress: { label: 'In Progress', color: chalk.green, terminal: false },
  completed: { label: 'Completed', color: chalk.blue, terminal: true },
  closed: { label: 'Closed', color: chalk.gray, terminal: true },
  archived: { label: 'Archived', color: chalk.gray, terminal: true },
};

/**
 * Status keys that indicate a spec is done (scope no longer enforced).
 */
const TERMINAL_STATUSES = Object.entries(SPEC_STATUSES)
  .filter(([, v]) => v.terminal)
  .map(([k]) => k);

module.exports = {
  SPEC_TYPES,
  SPEC_STATUSES,
  TERMINAL_STATUSES,
};
