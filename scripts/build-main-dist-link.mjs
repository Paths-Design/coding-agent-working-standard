#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

const DEFAULT_OUTPUT = path.join(repoRoot, 'dist', 'main');
const CLI_PACKAGE = path.join(repoRoot, 'packages', 'caws-cli');
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
    '  --no-global-link   Do not npm-link the local CLI into the active Node prefix',
    '  --help             Show this help',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = {
    outputDir: DEFAULT_OUTPUT,
    install: 'auto',
    build: true,
    globalLink: true,
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
    } else if (arg === '--no-global-link') {
      opts.globalLink = false;
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

function runCapture(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
  });
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

function existingCawsBin() {
  const result = runCapture('sh', ['-lc', 'which -a caws 2>/dev/null || true']);
  const candidates = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return candidates.find((candidate) => {
    const resolved = path.resolve(candidate);
    return !resolved.startsWith(repoRoot) && !resolved.includes(`${path.sep}node_modules${path.sep}.bin${path.sep}`);
  }) ?? null;
}

function firstWritablePathDir() {
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    if (entry.length === 0) continue;
    try {
      fs.accessSync(entry, fs.constants.W_OK);
      return entry;
    } catch {
      // Keep scanning PATH.
    }
  }
  return null;
}

function linkGlobalShim() {
  const existing = existingCawsBin();
  const linkPath = existing ?? path.join(firstWritablePathDir() ?? '', 'caws');
  if (!linkPath || linkPath === 'caws') {
    throw new Error('could not find a writable PATH directory for the global caws shim');
  }
  const parent = path.dirname(linkPath);
  fs.accessSync(parent, fs.constants.W_OK);
  removeIfExists(linkPath);
  fs.symlinkSync(CLI_BIN, linkPath, 'file');
  console.log(`linked ${linkPath} -> ${CLI_BIN}`);
}

function linkGlobalCli() {
  requirePath(path.join(CLI_PACKAGE, 'package.json'), 'CLI package metadata');
  requirePath(CLI_BIN, 'CLI bin output');
  console.log('$ npm link --workspace @paths.design/caws-cli');
  const result = spawnSync('npm', ['link', '--workspace', '@paths.design/caws-cli'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status === 0) return;

  console.log('npm link failed; falling back to a direct caws shim on PATH.');
  linkGlobalShim();
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

  if (opts.globalLink) {
    linkGlobalCli();
  } else {
    console.log('skipping global npm link by request.');
  }

  console.log(`build-main-dist-link complete: ${path.relative(repoRoot, opts.outputDir)}`);
}

try {
  main();
} catch (err) {
  console.error(`build-main-dist-link: ${err.message}`);
  process.exit(1);
}
