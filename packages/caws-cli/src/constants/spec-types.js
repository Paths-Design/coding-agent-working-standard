/**
 * @fileoverview Spec Types Constants
 * Defines spec types and their metadata for consistent display
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

module.exports = {
  SPEC_TYPES,
};
