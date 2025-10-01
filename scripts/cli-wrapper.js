#!/usr/bin/env node

/**
 * CAWS CLI Wrapper
 * Builds and runs the CAWS CLI with proper argument passing
 * @author @darianrosebrook
 */

const { spawn } = require('child_process');
const path = require('path');

async function runCLI() {
  try {
    // Build the CLI first
    console.log('🔨 Building CAWS CLI...');
    await new Promise((resolve, reject) => {
      const build = spawn('npm', ['run', 'build'], {
        cwd: path.join(__dirname, '../packages/caws-cli'),
        stdio: 'inherit',
      });

      build.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Build failed with code ${code}`));
        }
      });
    });

    // Run the CLI with all arguments passed to this script
    const args = process.argv.slice(2);
    const cliPath = path.join(__dirname, '../packages/caws-cli/dist/index.js');

    console.log(`🚀 Running CAWS CLI: node ${cliPath} ${args.join(' ')}`);

    const cli = spawn('node', [cliPath, ...args], {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..'),
    });

    cli.on('close', (code) => {
      process.exit(code);
    });
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

runCLI();
