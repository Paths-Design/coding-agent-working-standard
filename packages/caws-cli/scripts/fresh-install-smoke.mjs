#!/usr/bin/env node
// fresh-install-smoke.mjs
//
// Release gate for @paths.design/caws-cli: proves the published tarball
// contains every runtime asset the v11 hook-pack installer requires.
//
// Pipeline:
//   1. npm pack inside packages/caws-cli/ -> tarball at /tmp/...
//   2. install tarball into a fresh temp project (no global install).
//   3. run `caws init --agent-surface claude-code` against an empty git repo.
//   4. for every file declared in the installed manifest-claude-code.js,
//      assert (a) the template source exists inside the installed package
//      under templates/hook-packs/claude-code/<sourcePath>, and (b) the
//      destination file landed at <project>/<destPath>.
//
// Why this script exists:
//   v11.1.0 shipped with package.json:files = ["dist", "README.md"], which
//   excluded templates/hook-packs/ from the tarball even though the v11.1
//   --agent-surface claude-code installer reads from it at runtime. Every
//   fresh install hit ENOENT on .claude/hooks/scope-guard.sh. v11.1.1
//   restores the narrow allowlist; this script makes the regression class
//   impossible to ship again.
//
// Exits 0 on full success, 1 on any failure with a structured diagnostic
// naming the missing path and the manifest entry that required it.

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, '..');
const PACKAGE_NAME = '@paths.design/caws-cli';
const PACK_ID = 'claude-code';

// ─── Output helpers ──────────────────────────────────────────────────────

const colors = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function fail(msg, details = {}) {
  log(colors.red(`\n[fresh-install-smoke] FAIL: ${msg}`));
  for (const [k, v] of Object.entries(details)) {
    log(`  ${colors.dim(k + ':')} ${v}`);
  }
  process.exit(1);
}

function ok(msg) {
  log(colors.green(`[fresh-install-smoke] ${msg}`));
}

function step(msg) {
  log(colors.yellow(`\n→ ${msg}`));
}

// ─── Cleanup registration ────────────────────────────────────────────────

const cleanupPaths = new Set();
function registerCleanup(path) {
  cleanupPaths.add(path);
}
function cleanup() {
  for (const path of cleanupPaths) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

// ─── Pipeline steps ──────────────────────────────────────────────────────

function packTarball() {
  step('npm pack');
  // --pack-destination keeps repo dir clean; --json gives machine-readable output.
  const packDir = mkdtempSync(join(tmpdir(), 'caws-pack-'));
  registerCleanup(packDir);

  const result = spawnSync(
    'npm', ['pack', '--pack-destination', packDir, '--json'],
    { cwd: PACKAGE_ROOT, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    fail('npm pack failed', { exitCode: result.status, stderr: result.stderr.trim() });
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    fail('npm pack stdout is not JSON', { stdout: result.stdout.slice(0, 500) });
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    fail('npm pack returned unexpected shape', { got: JSON.stringify(parsed).slice(0, 500) });
  }
  const { filename } = parsed[0];
  const tarball = join(packDir, filename);
  if (!existsSync(tarball)) {
    fail('tarball missing after npm pack', { expected: tarball });
  }
  ok(`packed ${filename}`);
  return tarball;
}

function installTarball(tarball) {
  step('install tarball into fresh project');
  const projectDir = mkdtempSync(join(tmpdir(), 'caws-smoke-project-'));
  registerCleanup(projectDir);

  // Minimal package.json so npm install has something to anchor to.
  const pkgJson = { name: 'caws-fresh-install-smoke', version: '0.0.0', private: true };
  execSync(`printf '%s' '${JSON.stringify(pkgJson)}' > package.json`, { cwd: projectDir });

  // --no-audit --no-fund keeps output focused; --ignore-scripts is intentional —
  // we want to install the published bits as-is, not run prepare/postinstall
  // hooks that might paper over packaging gaps.
  const result = spawnSync(
    'npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', tarball],
    { cwd: projectDir, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    fail('npm install of tarball failed', {
      exitCode: result.status,
      stderr: result.stderr.trim().slice(0, 1000),
    });
  }

  const installedRoot = join(projectDir, 'node_modules', PACKAGE_NAME);
  if (!existsSync(installedRoot)) {
    fail('installed package root missing', { expected: installedRoot });
  }
  ok(`installed ${PACKAGE_NAME} into ${projectDir}`);
  return { projectDir, installedRoot };
}

function loadManifest(installedRoot) {
  step('load manifest from installed package');
  const manifestPath = join(installedRoot, 'dist', 'init', 'hook-packs', 'manifest-claude-code.js');
  if (!existsSync(manifestPath)) {
    fail('manifest file missing in installed package', {
      expected: manifestPath,
      hint: 'dist/ may be missing or incomplete in the published tarball',
    });
  }
  // Use require() via child_process for clean ESM/CJS interop with the compiled CJS manifest.
  const result = spawnSync(
    'node',
    ['-e', `const m = require(${JSON.stringify(manifestPath)}); process.stdout.write(JSON.stringify(m.CLAUDE_CODE_PACK));`],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    fail('failed to load installed manifest', { stderr: result.stderr.trim() });
  }
  const pack = JSON.parse(result.stdout);
  if (!Array.isArray(pack.installedFiles) || pack.installedFiles.length === 0) {
    fail('manifest installedFiles is empty or missing', { got: pack });
  }
  ok(`manifest declares ${pack.installedFiles.length} files`);
  return pack;
}

function assertTemplateSourcesPresent(installedRoot, pack) {
  step('assert template sources present in installed package');
  const packRoot = join(installedRoot, 'templates', 'hook-packs', PACK_ID);
  const missing = [];
  for (const file of pack.installedFiles) {
    const sourcePath = join(packRoot, file.sourcePath);
    if (!existsSync(sourcePath)) {
      missing.push({ sourcePath, manifestDestPath: file.destPath });
    }
  }
  if (missing.length > 0) {
    fail(`${missing.length} template source(s) missing from published tarball`, {
      packRoot,
      missing: JSON.stringify(missing, null, 2),
      remediation: 'Check packages/caws-cli/package.json:files — must include templates/hook-packs/**',
    });
  }
  ok(`all ${pack.installedFiles.length} template sources present under ${packRoot}`);
}

function runInit(projectDir, installedRoot) {
  step('git init + caws init --agent-surface claude-code');
  // Initialize a git repo so init doesn't refuse.
  execSync('git init -q', { cwd: projectDir });
  execSync('git config user.email smoke@local && git config user.name Smoke', { cwd: projectDir });
  execSync('git commit --allow-empty -q -m init', { cwd: projectDir });

  const cli = join(installedRoot, 'dist', 'index.js');
  const result = spawnSync(
    'node', [cli, 'init', '--agent-surface', PACK_ID],
    { cwd: projectDir, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    fail('caws init --agent-surface claude-code exited non-zero', {
      exitCode: result.status,
      stdout: result.stdout.trim().slice(0, 2000),
      stderr: result.stderr.trim().slice(0, 2000),
    });
  }
  ok('caws init succeeded');
}

function assertDestFilesPresent(projectDir, pack) {
  step('assert installed hook files present in project');
  const missing = [];
  for (const file of pack.installedFiles) {
    const destPath = join(projectDir, file.destPath);
    if (!existsSync(destPath)) {
      missing.push({ destPath, manifestSourcePath: file.sourcePath });
      continue;
    }
    if (file.executable) {
      const mode = statSync(destPath).mode & 0o111;
      if (mode === 0) {
        missing.push({
          destPath,
          manifestSourcePath: file.sourcePath,
          issue: 'expected executable bit but found 0o000',
        });
      }
    }
  }
  if (missing.length > 0) {
    fail(`${missing.length} hook destination file(s) missing or wrong-mode after caws init`, {
      missing: JSON.stringify(missing, null, 2),
    });
  }
  ok(`all ${pack.installedFiles.length} hook files materialized correctly`);
}

// ─── Main ───────────────────────────────────────────────────────────────

try {
  const startMs = Date.now();
  log(colors.dim(`fresh-install-smoke for ${PACKAGE_NAME} (package root: ${PACKAGE_ROOT})`));

  const tarball = packTarball();
  const { projectDir, installedRoot } = installTarball(tarball);
  const pack = loadManifest(installedRoot);
  assertTemplateSourcesPresent(installedRoot, pack);
  runInit(projectDir, installedRoot);
  assertDestFilesPresent(projectDir, pack);

  const elapsedMs = Date.now() - startMs;
  log(colors.green(`\n[fresh-install-smoke] PASS in ${elapsedMs}ms — published tarball is install-safe`));
} catch (err) {
  fail('unexpected error', { message: err.message, stack: err.stack?.slice(0, 1000) });
}
