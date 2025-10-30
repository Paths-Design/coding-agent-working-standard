#!/usr/bin/env node

/**
 * CAWS Pre-Release Smoke Tests
 *
 * Quick smoke tests to verify critical functionality before release
 *
 * @author @darianrosebrook
 */

import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..');

function runCommand(cmd, description) {
  try {
    console.log(`\n🧪 ${description}...`);
    execSync(cmd, {
      cwd: ROOT_DIR,
      stdio: 'pipe',
      timeout: 30000,
    });
    console.log(`✅ ${description} passed`);
    return true;
  } catch (error) {
    console.error(`❌ ${description} failed`);
    console.error(`   Command: ${cmd}`);
    console.error(`   Error: ${error.message}`);
    return false;
  }
}

function main() {
  console.log('🚀 CAWS Pre-Release Smoke Tests\n');
  console.log('=====================================\n');

  const tests = [
    {
      cmd: 'node packages/caws-cli/dist/index.js --version',
      desc: 'CLI version check',
    },
    {
      cmd: 'node packages/caws-cli/dist/index.js --help',
      desc: 'CLI help command',
    },
    {
      cmd: 'node packages/caws-cli/dist/index.js validate --help',
      desc: 'CLI validate command',
    },
    {
      cmd: 'node packages/caws-cli/dist/index.js status --help',
      desc: 'CLI status command',
    },
    {
      cmd: 'node packages/caws-cli/dist/index.js waivers --help',
      desc: 'CLI waivers command',
    },
    {
      cmd: 'node packages/caws-cli/dist/index.js waivers list',
      desc: 'CLI waivers list',
    },
    {
      cmd: 'node packages/quality-gates/run-quality-gates.mjs --help',
      desc: 'Quality gates help',
    },
    {
      cmd: 'node scripts/release-check.mjs',
      desc: 'Release verification script',
    },
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    if (runCommand(test.cmd, test.desc)) {
      passed++;
    } else {
      failed++;
    }
  }

  console.log('\n=====================================\n');
  console.log(`📊 Test Results: ${passed} passed, ${failed} failed\n`);

  if (failed > 0) {
    console.log('❌ Smoke tests failed - do not proceed with release');
    process.exit(1);
  } else {
    console.log('✅ All smoke tests passed - ready for release');
    process.exit(0);
  }
}

main();
