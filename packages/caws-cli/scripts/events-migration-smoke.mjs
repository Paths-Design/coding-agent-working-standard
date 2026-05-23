#!/usr/bin/env node
// events-migration-smoke.mjs
//
// Release gate for CAWS-MIGRATE-V10-EVENTS-001: proves the published
// kernel + CLI tarballs together contain every artifact needed to run
// the v10→v11 event-log migration end-to-end against the installed
// binary (NOT against source).
//
// This smoke is the final acceptance gate per the slice's invariants:
//   - npm pack BOTH packages (kernel + CLI, in that order — kernel
//     ships the chain_rotated payload schema; CLI depends on it).
//   - Inspect tarball contents and assert the load-bearing files:
//       * kernel: dist/schemas/events/chain_rotated.v1.json
//       * CLI:   dist/shell/commands/events.js
//     These are the regression class this slice was built to prevent:
//     a missing schema file silently breaks payload validation; a
//     missing shell command file leaves the surface unregistered.
//   - Install both tarballs into a fresh scratch project (no global
//     install, no source-tree resolution).
//   - Hand-author a v10 events.jsonl + a v11 spec fixture in .caws/.
//   - Execute the real installed `caws` binary (node_modules/.bin/caws)
//     for every step of the migration lifecycle:
//       1. caws events --help            — command group is registered
//       2. caws events migrate --from v10 (dry-run, no FS changes)
//       3. caws events migrate --from v10 --apply --reason "smoke"
//       4. caws events verify-archive    — happy path
//       5. Tamper the archive (append bytes)
//       6. caws events verify-archive    — digest mismatch detected
//   - Assert exit codes, stdout markers, and final FS state at every
//     step. The script exits 0 only when every assertion passed.
//
// Build-before-pack: npm pack uses whatever is in dist/. If the
// caller did not run `npm run build` first, the tarball contents may
// not reflect source. This script does NOT run build itself
// (intentional — running build inside a smoke would mask packaging
// regressions caused by build skips). The README/CHANGELOG should
// document that build is a prerequisite; CI's prepublishOnly chain
// runs build then this smoke in sequence.
//
// Exits 0 on full success, 1 on any failure with a structured
// diagnostic naming the failed step + the assertion that failed.

import { execSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_ROOT = resolve(__dirname, '..');
const KERNEL_ROOT = resolve(CLI_ROOT, '..', 'caws-kernel');
const CLI_PACKAGE_NAME = '@paths.design/caws-cli';
const KERNEL_PACKAGE_NAME = '@paths.design/caws-kernel';

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
  log(colors.red(`\n[events-migration-smoke] FAIL: ${msg}`));
  for (const [k, v] of Object.entries(details)) {
    log(`  ${colors.dim(k + ':')} ${v}`);
  }
  process.exit(1);
}

function ok(msg) {
  log(colors.green(`[events-migration-smoke] ${msg}`));
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

// ─── Pack + tarball inspection ───────────────────────────────────────────

function packPackage(packageRoot, packageName) {
  step(`npm pack ${packageName}`);
  const packDir = mkdtempSync(join(tmpdir(), 'caws-pack-'));
  registerCleanup(packDir);

  const result = spawnSync(
    'npm', ['pack', '--pack-destination', packDir, '--json'],
    { cwd: packageRoot, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    fail(`npm pack ${packageName} failed`, {
      exitCode: result.status,
      stderr: result.stderr.trim().slice(0, 1000),
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    fail('npm pack stdout is not JSON', { stdout: result.stdout.slice(0, 500) });
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    fail('npm pack returned unexpected shape', {
      got: JSON.stringify(parsed).slice(0, 500),
    });
  }
  const { filename } = parsed[0];
  const tarball = join(packDir, filename);
  if (!existsSync(tarball)) {
    fail('tarball missing after npm pack', { expected: tarball });
  }
  ok(`packed ${filename}`);
  return tarball;
}

function assertTarballContains(tarball, expectedFiles) {
  // Use `tar -tzf` to list contents and grep for the expected paths.
  // The npm-pack tarball layout is package/<path>, so we look for
  // package/<path> for each expected entry.
  step(`assert tarball contains required files: ${tarball}`);
  const result = spawnSync(
    'tar', ['-tzf', tarball],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    fail('tar -tzf failed', { tarball, stderr: result.stderr.trim() });
  }
  const entries = new Set(result.stdout.split('\n').filter(Boolean));
  const missing = [];
  for (const file of expectedFiles) {
    if (!entries.has(`package/${file}`)) {
      missing.push(file);
    }
  }
  if (missing.length > 0) {
    fail(`tarball ${tarball} missing required files`, {
      missing: missing.join(', '),
      hint: 'Check package.json:files and that dist/ was built before npm pack',
    });
  }
  ok(`tarball contains all ${expectedFiles.length} required file(s)`);
}

function installTarballs(cliTarball, kernelTarball) {
  step('install both tarballs into fresh project');
  const projectDir = mkdtempSync(join(tmpdir(), 'caws-events-smoke-'));
  registerCleanup(projectDir);

  const pkgJson = {
    name: 'caws-events-migration-smoke',
    version: '0.0.0',
    private: true,
  };
  writeFileSync(
    join(projectDir, 'package.json'),
    JSON.stringify(pkgJson, null, 2)
  );

  // Install kernel first, then CLI. The CLI's package.json declares
  // a dep on @paths.design/caws-kernel by version range; we want the
  // local tarball to satisfy it, so install kernel by tarball first.
  const installResult = spawnSync(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      kernelTarball,
      cliTarball,
    ],
    { cwd: projectDir, encoding: 'utf8' }
  );
  if (installResult.status !== 0) {
    fail('npm install of tarballs failed', {
      exitCode: installResult.status,
      stderr: installResult.stderr.trim().slice(0, 2000),
    });
  }

  // Sanity: both packages are installed.
  for (const name of [KERNEL_PACKAGE_NAME, CLI_PACKAGE_NAME]) {
    const root = join(projectDir, 'node_modules', name);
    if (!existsSync(root)) {
      fail(`installed package root missing: ${name}`, { expected: root });
    }
  }

  // The caws binary is at node_modules/.bin/caws (symlink).
  const cawsBin = join(projectDir, 'node_modules', '.bin', 'caws');
  if (!existsSync(cawsBin)) {
    fail('caws binary missing from node_modules/.bin/', { expected: cawsBin });
  }
  ok(`installed caws-kernel + caws-cli into ${projectDir}`);
  return { projectDir, cawsBin };
}

// ─── Caws invocation helpers ─────────────────────────────────────────────

function runCaws(cawsBin, args, cwd) {
  // Use the installed binary directly. This is the whole point of the
  // smoke — execute the published artifact, not source.
  return spawnSync(cawsBin, args, { cwd, encoding: 'utf8' });
}

function assertExit(result, expected, label) {
  if (result.status !== expected) {
    fail(`${label}: expected exit ${expected}, got ${result.status}`, {
      stdout: result.stdout.trim().slice(0, 2000),
      stderr: result.stderr.trim().slice(0, 2000),
    });
  }
}

function assertStdoutMatches(result, pattern, label) {
  if (!pattern.test(result.stdout)) {
    fail(`${label}: stdout did not match ${pattern}`, {
      stdout: result.stdout.trim().slice(0, 2000),
    });
  }
}

function assertStderrMatches(result, pattern, label) {
  if (!pattern.test(result.stderr)) {
    fail(`${label}: stderr did not match ${pattern}`, {
      stderr: result.stderr.trim().slice(0, 2000),
    });
  }
}

// ─── Fixture helpers ─────────────────────────────────────────────────────

function setupScratchRepo(parentDir) {
  step('initialize scratch repo with .caws/ + v10 fixture');
  const repoDir = join(parentDir, 'fixture-repo');
  mkdirSync(repoDir);
  execSync('git init -q', { cwd: repoDir });
  execSync('git config user.email smoke@local', { cwd: repoDir });
  execSync('git config user.name Smoke', { cwd: repoDir });
  execSync('git commit --allow-empty -q -m init', { cwd: repoDir });

  const cawsDir = join(repoDir, '.caws');
  mkdirSync(cawsDir, { recursive: true });
  mkdirSync(join(cawsDir, 'specs'), { recursive: true });

  // v11 spec so the half-upgrade refusal does not fire.
  writeFileSync(
    join(cawsDir, 'specs', 'SMOKE-1.yaml'),
    `id: SMOKE-1
title: A12 smoke fixture
risk_tier: 3
mode: chore
lifecycle_state: active
created_at: '2026-05-23T00:00:00.000Z'
updated_at: '2026-05-23T00:00:00.000Z'
blast_radius:
  modules: []
  data_migration: false
scope:
  in: ['.caws/specs/SMOKE-1.yaml']
  out: []
invariants:
  - 'A12 smoke fixture'
acceptance:
  - id: A1
    given: 'x'
    when: 'y'
    then: 'z'
non_functional: {}
contracts: []
`
  );

  // 3-line v10-shape events.jsonl. The actor is a string, which the
  // v11 strict envelope rejects — proving the tolerant scan path is
  // what handles this.
  const v10Lines = [];
  for (let seq = 1; seq <= 3; seq++) {
    v10Lines.push(JSON.stringify({
      seq,
      ts: '2026-04-11T01:00:00.000Z',
      session_id: 'standalone',
      actor: 'cli',
      event: 'validation_completed',
      spec_id: 'X-1',
      data: { passed: true },
      prev_hash: seq === 1 ? '' : `sha256:${String(seq - 1).padStart(64, '0')}`,
      event_hash: `sha256:${String(seq).padStart(64, '0')}`,
    }));
  }
  const eventsContent = v10Lines.join('\n') + '\n';
  writeFileSync(join(cawsDir, 'events.jsonl'), eventsContent);

  // Record ground-truth digest + line count for later assertions.
  const digest =
    'sha256:' + createHash('sha256').update(eventsContent).digest('hex');
  const expectedLineCount = 3;
  ok(`scratch repo at ${repoDir}; events.jsonl digest=${digest}, lines=${expectedLineCount}`);
  return { repoDir, expectedDigest: digest, expectedLineCount };
}

function findArchive(cawsDir) {
  const entries = execSync(
    `ls -1 "${cawsDir}" | grep '^events.jsonl.archive-' || true`,
    { encoding: 'utf8' }
  ).trim().split('\n').filter(Boolean);
  if (entries.length !== 1) {
    fail(`expected exactly 1 archive in ${cawsDir}, found ${entries.length}`, {
      entries: entries.join(', '),
    });
  }
  return join(cawsDir, entries[0]);
}

// ─── End-to-end smoke ────────────────────────────────────────────────────

function runEndToEndSmoke(cawsBin, repoDir, expectedDigest, expectedLineCount) {
  const cawsDir = join(repoDir, '.caws');

  // Step 1: events --help
  step('caws events --help');
  const help = runCaws(cawsBin, ['events', '--help'], repoDir);
  assertExit(help, 0, 'events --help');
  assertStdoutMatches(help, /migrate/, 'events --help');
  assertStdoutMatches(help, /rotate/, 'events --help');
  assertStdoutMatches(help, /verify-archive/, 'events --help');
  ok('events --help: migrate, rotate, verify-archive all registered');

  // Step 2: dry-run
  step('caws events migrate --from v10 (dry-run)');
  const eventsBytesBefore = readFileSync(join(cawsDir, 'events.jsonl'));
  const dry = runCaws(cawsBin, ['events', 'migrate', '--from', 'v10'], repoDir);
  assertExit(dry, 0, 'migrate dry-run');
  assertStdoutMatches(dry, /\[dry-run\] plan: rotate/, 'migrate dry-run');
  assertStdoutMatches(dry, /detection: all_v10, 3 lines/, 'migrate dry-run');
  assertStdoutMatches(dry, /No filesystem changes/, 'migrate dry-run');
  const eventsBytesAfterDry = readFileSync(join(cawsDir, 'events.jsonl'));
  if (!eventsBytesBefore.equals(eventsBytesAfterDry)) {
    fail('dry-run modified events.jsonl — "no filesystem changes" is a lie', {
      sizeBefore: eventsBytesBefore.length,
      sizeAfter: eventsBytesAfterDry.length,
    });
  }
  ok('dry-run: events.jsonl byte-identical, no archive created');

  // Step 3: apply
  step('caws events migrate --from v10 --apply --reason "A12 smoke"');
  const apply = runCaws(
    cawsBin,
    ['events', 'migrate', '--from', 'v10', '--apply', '--reason', 'A12 smoke'],
    repoDir
  );
  assertExit(apply, 0, 'migrate --apply');
  assertStdoutMatches(apply, /applied\. chain_rotated genesis written/, 'migrate --apply');
  assertStdoutMatches(apply, /event_hash=sha256:[0-9a-f]{64}/, 'migrate --apply');
  assertStdoutMatches(apply, /archive=events\.jsonl\.archive-/, 'migrate --apply');

  // Concrete check: archive file exists and byte-matches the original
  // events.jsonl (the bytes we captured before any rotation).
  const archivePath = findArchive(cawsDir);
  const archiveBytes = readFileSync(archivePath);
  if (!archiveBytes.equals(eventsBytesBefore)) {
    fail('archive bytes differ from pre-rotation events.jsonl', {
      preRotationSize: eventsBytesBefore.length,
      archiveSize: archiveBytes.length,
    });
  }
  const archiveDigest =
    'sha256:' + createHash('sha256').update(archiveBytes).digest('hex');
  if (archiveDigest !== expectedDigest) {
    fail('archive digest does not match pre-rotation digest', {
      expected: expectedDigest,
      actual: archiveDigest,
    });
  }
  ok(`apply: archive byte-equals pre-rotation events.jsonl (${archiveDigest})`);

  // Step 4: verify-archive happy
  step('caws events verify-archive (happy)');
  const verifyHappy = runCaws(cawsBin, ['events', 'verify-archive'], repoDir);
  assertExit(verifyHappy, 0, 'verify-archive happy');
  assertStdoutMatches(
    verifyHappy,
    /verified\. archive matches chain_rotated payload/,
    'verify-archive happy'
  );
  assertStdoutMatches(
    verifyHappy,
    new RegExp(`sha256: ${expectedDigest.replace(/\./g, '\\.')}`),
    'verify-archive happy'
  );
  assertStdoutMatches(
    verifyHappy,
    new RegExp(`lines: ${expectedLineCount}`),
    'verify-archive happy'
  );
  ok('verify-archive (happy): sha256 + line count match committed payload');

  // Step 5: tamper
  step('tamper archive and re-verify');
  appendFileSync(archivePath, 'A12_TAMPER\n');
  const tamperedDigest =
    'sha256:' +
    createHash('sha256').update(readFileSync(archivePath)).digest('hex');
  if (tamperedDigest === expectedDigest) {
    fail('tampered archive somehow has the same digest as the original', {
      expected: expectedDigest,
      actual: tamperedDigest,
    });
  }

  // Step 6: verify-archive tamper detection
  const verifyTamper = runCaws(cawsBin, ['events', 'verify-archive'], repoDir);
  assertExit(verifyTamper, 1, 'verify-archive tamper');
  assertStderrMatches(
    verifyTamper,
    /store\.events\.archive\.digest_mismatch/,
    'verify-archive tamper'
  );
  assertStderrMatches(
    verifyTamper,
    new RegExp(`Expected ${expectedDigest.replace(/\./g, '\\.')}`),
    'verify-archive tamper'
  );
  assertStderrMatches(
    verifyTamper,
    new RegExp(`got ${tamperedDigest.replace(/\./g, '\\.')}`),
    'verify-archive tamper'
  );
  ok('verify-archive (tamper): expected vs actual digests both correct in diagnostic');
}

// ─── Main ───────────────────────────────────────────────────────────────

try {
  const startMs = Date.now();
  log(colors.dim(`events-migration-smoke for CAWS-MIGRATE-V10-EVENTS-001`));
  log(colors.dim(`  CLI root:    ${CLI_ROOT}`));
  log(colors.dim(`  Kernel root: ${KERNEL_ROOT}`));

  // 1. Pack both packages.
  const kernelTarball = packPackage(KERNEL_ROOT, KERNEL_PACKAGE_NAME);
  const cliTarball = packPackage(CLI_ROOT, CLI_PACKAGE_NAME);

  // 2. Inspect tarball contents — assert the load-bearing files.
  assertTarballContains(kernelTarball, [
    'dist/schemas/events/chain_rotated.v1.json',
    'dist/evidence/validate.js',
    'dist/evidence/types.js',
  ]);
  assertTarballContains(cliTarball, [
    'dist/shell/commands/events.js',
    'dist/shell/index.js',
    'dist/store/events-store.js',
    'dist/store/events-migration.js',
  ]);

  // 3. Install both into a scratch project.
  const { projectDir, cawsBin } = installTarballs(cliTarball, kernelTarball);

  // 4. Build fixture (scratch repo with v10 events.jsonl + v11 spec).
  const { repoDir, expectedDigest, expectedLineCount } = setupScratchRepo(
    projectDir
  );

  // 5. End-to-end smoke against the installed binary.
  runEndToEndSmoke(cawsBin, repoDir, expectedDigest, expectedLineCount);

  const elapsedMs = Date.now() - startMs;
  log(
    colors.green(
      `\n[events-migration-smoke] PASS in ${elapsedMs}ms — installed tarballs run the full migration lifecycle correctly`
    )
  );
} catch (err) {
  fail('unexpected error', {
    message: err.message,
    stack: err.stack?.slice(0, 1000),
  });
}
