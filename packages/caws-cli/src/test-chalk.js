#!/usr/bin/env node

const chalk = require('chalk');

console.log(chalk.green('✅ CAWS CLI with Chalk is working!'));
console.log(chalk.cyan('🚀 Initializing project...'));
console.log(chalk.red('❌ Error:'), 'Something went wrong');
console.log(chalk.yellow('⚠️  Warning:'), 'Git not found');
console.log(chalk.blue('💡 Tip:'), 'Run with --help for more information');
console.log(chalk.bold('Next steps:'));
console.log('1. Install dependencies');
console.log('2. Run tests');
console.log('3. Set up CI/CD');
