#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

const DEFAULT_OUTPUT = path.join(repoRoot, 'dist', 'main');
const CLI_DIST = path.join(repoRoot, 'packages', 'caws-cli', 'dist');
const CLI_BIN = path.join(CLI_DIST, 'index.js');

function usage() {
  return [
    'Usage: node scripts/build-main-dist-link.mjs [options]',
    '',
    'Build the current checkout and create stable symlinks under dist/main.',
    '',
    'Options:',
    '  --output <dir>     Output directory for symlinks (default: dist/main)',
    '  --install          Always run npm ci before building',
    '  --skip-install     Do not install dependencies, even if node_modules is absent',
    '  --skip-build       Only refresh symlinks; requires existing package dist',
    '  --help             Show this help',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = {
    outputDir: DEFAULT_OUTPUT,
    install: 'auto',
    build: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--output') {
      const next = argv[i + 1];
      if (!next) throw new Error('--output requires a directory');
      opts.outputDir = path.resolve(repoRoot, next);
      i += 1;
    } else if (arg.startsWith('--output=')) {
      opts.outputDir = path.resolve(repoRoot, arg.slice('--output='.length));
    } else if (arg === '--install') {
      opts.install = 'always';
    } else if (arg === '--skip-install') {
      opts.install = 'never';
    } else if (arg === '--skip-build') {
      opts.build = false;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return opts;
}

function run(cmd, args) {
  console.log(`$ ${[cmd, ...args].join(' ')}`);
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function requirePath(target, label) {
  if (!fs.existsSync(target)) {
    throw new Error(`${label} not found: ${path.relative(repoRoot, target)}`);
  }
}

function removeIfExists(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    throw new Error(`failed to remove ${target}: ${err.message}`);
  }
}

function symlinkRelative(target, linkPath, type) {
  removeIfExists(linkPath);
  const relativeTarget = path.relative(path.dirname(linkPath), target);
  fs.symlinkSync(relativeTarget, linkPath, type);
  console.log(`linked ${path.relative(repoRoot, linkPath)} -> ${relativeTarget}`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }

  const nodeModules = path.join(repoRoot, 'node_modules');
  if (opts.install === 'never' && opts.build && !fs.existsSync(nodeModules)) {
    throw new Error('node_modules not found; rerun without --skip-install or pass --install first');
  }

  if (opts.install === 'always' || (opts.install === 'auto' && !fs.existsSync(nodeModules))) {
    run('npm', ['ci']);
  } else if (opts.install === 'auto') {
    console.log('node_modules present; skipping npm ci (use --install to force).');
  } else {
    console.log('skipping dependency install by request.');
  }

  if (opts.build) {
    run('npm', ['run', 'build']);
  } else {
    console.log('skipping build by request.');
  }

  requirePath(CLI_DIST, 'CLI dist directory');
  requirePath(CLI_BIN, 'CLI bin output');

  fs.mkdirSync(opts.outputDir, { recursive: true });
  symlinkRelative(CLI_DIST, path.join(opts.outputDir, 'caws-cli-dist'), 'dir');
  symlinkRelative(CLI_BIN, path.join(opts.outputDir, 'caws'), 'file');

  console.log(`build-main-dist-link complete: ${path.relative(repoRoot, opts.outputDir)}`);
}

try {
  main();
} catch (err) {
  console.error(`build-main-dist-link: ${err.message}`);
  process.exit(1);
}
