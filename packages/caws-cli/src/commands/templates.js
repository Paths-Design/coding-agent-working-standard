/**
 * @fileoverview CAWS Templates Command
 * Discover and manage project templates
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');

/**
 * Built-in template definitions
 */
const BUILTIN_TEMPLATES = {
  'typescript-library': {
    name: 'TypeScript Library',
    description: 'Production-ready TypeScript library with Jest testing',
    category: 'TypeScript',
    tier: 2,
    features: ['TypeScript', 'Jest', 'ESLint', 'Prettier', 'Publishing'],
    path: 'templates/typescript/library',
  },
  'typescript-api': {
    name: 'TypeScript API',
    description: 'REST API with Express and TypeScript',
    category: 'TypeScript',
    tier: 1,
    features: ['TypeScript', 'Express', 'Jest', 'OpenAPI', 'Docker'],
    path: 'templates/typescript/api',
  },
  'typescript-monorepo': {
    name: 'TypeScript Monorepo',
    description: 'Multi-package TypeScript monorepo with Turbo',
    category: 'TypeScript',
    tier: 2,
    features: ['TypeScript', 'Turborepo', 'Jest', 'Changesets'],
    path: 'templates/typescript/monorepo',
  },
  'javascript-package': {
    name: 'JavaScript Package',
    description: 'NPM package with modern JavaScript',
    category: 'JavaScript',
    tier: 3,
    features: ['JavaScript', 'Jest', 'ESLint', 'Publishing'],
    path: 'templates/javascript/package',
  },
  'react-component-lib': {
    name: 'React Component Library',
    description: 'Reusable React component library with Storybook',
    category: 'React',
    tier: 2,
    features: ['React', 'TypeScript', 'Storybook', 'Jest', 'Publishing'],
    path: 'templates/react/component-library',
  },
  'vscode-extension': {
    name: 'VS Code Extension',
    description: 'VS Code extension with TypeScript',
    category: 'Extension',
    tier: 2,
    features: ['TypeScript', 'VS Code API', 'Jest', 'Publishing'],
    path: 'templates/vscode-extension',
  },
};

/**
 * Get template directory path
 * @returns {string|null} Template directory path or null
 */
function getTemplateDir() {
  const possiblePaths = [
    path.join(__dirname, '../../templates'),
    path.join(process.cwd(), 'packages/caws-cli/templates'),
    path.join(process.cwd(), 'templates'),
  ];

  for (const testPath of possiblePaths) {
    if (fs.existsSync(testPath)) {
      return testPath;
    }
  }

  return null;
}

/**
 * Check which templates actually exist
 * @returns {Object} Available templates
 */
function getAvailableTemplates() {
  const templateDir = getTemplateDir();
  const available = {};

  for (const [id, template] of Object.entries(BUILTIN_TEMPLATES)) {
    const templatePath = templateDir
      ? path.join(templateDir, template.path.replace('templates/', ''))
      : null;

    available[id] = {
      ...template,
      available: templatePath ? fs.existsSync(templatePath) : false,
      fullPath: templatePath,
    };
  }

  return available;
}

/**
 * List all available templates
 */
function listTemplates() {
  const templates = getAvailableTemplates();
  const categories = {};

  // Group by category
  for (const [id, template] of Object.entries(templates)) {
    if (!categories[template.category]) {
      categories[template.category] = [];
    }
    categories[template.category].push({ id, ...template });
  }

  console.log(chalk.bold.cyan('\n📦 Available CAWS Templates\n'));

  // Display by category
  for (const [category, categoryTemplates] of Object.entries(categories)) {
    console.log(chalk.bold.white(`${category}:`));

    for (const template of categoryTemplates) {
      const status = template.available ? chalk.green('✅') : chalk.gray('⏳');
      console.log(`${status} ${chalk.bold(template.id.padEnd(25))} - ${template.description}`);
      console.log(chalk.gray(`   Usage: caws init --template=${template.id} my-project`));
      console.log(chalk.gray(`   Features: ${template.features.join(', ')}`));
      console.log('');
    }
  }

  const totalAvailable = Object.values(templates).filter((t) => t.available).length;
  const totalTemplates = Object.keys(templates).length;

  if (totalAvailable < totalTemplates) {
    console.log(chalk.yellow(`\n⏳ ${totalTemplates - totalAvailable} templates coming soon`));
  }

  console.log(chalk.blue('\n📚 Learn more:'));
  console.log(chalk.blue('   caws templates --help'));
  console.log(chalk.blue('   docs/guides/template-usage.md'));

  console.log('');
}

/**
 * Show detailed template information
 * @param {string} templateId - Template ID
 */
function showTemplateInfo(templateId) {
  const templates = getAvailableTemplates();
  const template = templates[templateId];

  if (!template) {
    console.error(chalk.red(`\n❌ Template not found: ${templateId}`));
    console.error(chalk.yellow('\n💡 Available templates:'));
    console.error(chalk.yellow(`   ${Object.keys(templates).join(', ')}`));
    console.error(chalk.yellow('\n💡 Try: caws templates list'));
    process.exit(1);
  }

  console.log(chalk.bold.cyan(`\n📦 Template: ${template.name}\n`));
  console.log(chalk.white(`Description: ${template.description}`));
  console.log(chalk.white(`Category: ${template.category}`));
  console.log(chalk.white(`Risk Tier: ${template.tier}`));
  console.log(
    chalk.white(
      `Status: ${template.available ? chalk.green('Available') : chalk.yellow('Coming Soon')}`
    )
  );

  console.log(chalk.bold.white('\nFeatures:'));
  template.features.forEach((feature) => {
    console.log(chalk.gray(`   • ${feature}`));
  });

  console.log(chalk.bold.white('\nUsage:'));
  console.log(chalk.cyan(`   caws init --template=${templateId} my-project`));
  console.log(chalk.cyan(`   cd my-project`));
  console.log(chalk.cyan(`   npm install`));
  console.log(chalk.cyan(`   npm test`));

  if (template.available && template.fullPath) {
    console.log(chalk.bold.white('\nTemplate Location:'));
    console.log(chalk.gray(`   ${template.fullPath}`));
  }

  console.log('');
}

/**
 * Templates command handler
 * @param {string} subcommand - Subcommand (list, info)
 * @param {Object} options - Command options
 */
async function templatesCommand(subcommand = 'list', options = {}) {
  try {
    switch (subcommand) {
      case 'list':
        listTemplates();
        break;

      case 'info':
        if (!options.name) {
          console.error(chalk.red('\n❌ Template name required'));
          console.error(chalk.yellow('💡 Usage: caws templates info <template-name>'));
          console.error(chalk.yellow('💡 Try: caws templates list to see available templates'));
          process.exit(1);
        }
        showTemplateInfo(options.name);
        break;

      default:
        listTemplates();
    }
  } catch (error) {
    console.error(chalk.red('\n❌ Error:'), error.message);
    console.error(chalk.yellow('\n💡 Try: caws templates list'));
    process.exit(1);
  }
}

module.exports = {
  templatesCommand,
  listTemplates,
  showTemplateInfo,
  getAvailableTemplates,
  BUILTIN_TEMPLATES,
};
