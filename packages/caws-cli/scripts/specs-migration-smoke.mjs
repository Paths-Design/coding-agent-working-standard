#!/usr/bin/env node
// specs-migration-smoke.mjs
//
// Release gate for CAWS-MIGRATE-V10-SPECS-001 (A12 / acceptance gate
// per spec invariant 12 "functional completeness is not unit tests pass").
// Proves the published kernel + CLI tarballs together contain every
// artifact needed to run the v10→v11 specs migration end-to-end against
// the installed binary — NOT against worktree dist, NOT against source.
//
// What it certifies:
//   1. npm pack BOTH packages (kernel first, then CLI).
//   2. Inspect tarball contents and assert load-bearing files are
//      present in BOTH tarballs:
//        kernel: dist/spec/migrate-v10.js + .d.ts
//                dist/spec/index.js (re-exports migrateSpecV10, etc.)
//        CLI:    dist/store/specs-migration.js + .d.ts
//                dist/shell/commands/specs.js  (contains runSpecsMigrateCommand)
//      These are the regression class this smoke prevents: a missing
//      kernel module silently breaks transformer authority; a missing
//      store/shell file leaves the surface unregistered.
//   3. Install both tarballs into a fresh scratch project (no global
//      install, no source-tree resolution).
//   4. Hand-author a small v10 spec corpus (3 files: 1 happy, 1 refused,
//      1 lifecycle-mapped) plus an operator mapping.json fixture.
//   5. Execute the real installed `caws` binary at every step:
//        a. caws specs migrate --help                     — command registered
//        b. caws specs migrate --from v10                 — dry-run, no FS changes
//        c. caws specs migrate --from v10 --apply         — refuses (any refused)
//        d. caws specs migrate --from v10 --apply --partial
//                                                          — writes happy, skips refused
//        e. caws specs migrate --from v10 --apply --partial
//             --lifecycle-mapping <path>                  — lifecycle-mapped now lands
//        f. caws specs migrate --from v10 --json          — JSON output shape
//   6. Assert exit codes, stdout markers, durable report on disk,
//      byte-identity of refused fixtures, and on-disk migrated YAML
//      shape at every step.
//
// Build-before-pack contract:
//   This script does NOT run build itself. The caller (CI's
//   prepublishOnly chain) must run `npm run build` in the workspace
//   first. Running build inside a smoke would mask packaging
//   regressions caused by build skips. The fresh-install-smoke chain
//   currently calls this script as its third stage, after the events
//   smoke; both rely on the same pre-pack build invariant.
//
// Exits 0 on full success, 1 on any failure with a structured
// diagnostic naming the failed step + the assertion that failed.

import { execSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_ROOT = resolve(__dirname, '..');
const KERNEL_ROOT = resolve(CLI_ROOT, '..', 'caws-kernel');
const CLI_PACKAGE_NAME = '@paths.design/caws-cli';
const KERNEL_PACKAGE_NAME = '@paths.design/caws-kernel';

// ─── Output helpers (mirrors events-migration-smoke.mjs) ─────────────────

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
  log(colors.red(`\n[specs-migration-smoke] FAIL: ${msg}`));
  for (const [k, v] of Object.entries(details)) {
    log(`  ${colors.dim(k + ':')} ${v}`);
  }
  process.exit(1);
}
function ok(msg) {
  log(colors.green(`[specs-migration-smoke] ${msg}`));
}
function step(msg) {
  log(colors.yellow(`\n→ ${msg}`));
}

// ─── Cleanup ─────────────────────────────────────────────────────────────

const cleanupPaths = new Set();
function registerCleanup(path) { cleanupPaths.add(path); }
function cleanup() {
  for (const path of cleanupPaths) {
    try { rmSync(path, { recursive: true, force: true }); } catch {}
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

// ─── Pack + tarball inspection ───────────────────────────────────────────

function packPackage(packageRoot, packageName) {
  step(`npm pack ${packageName}`);
  const packDir = mkdtempSync(join(tmpdir(), 'caws-specs-pack-'));
  registerCleanup(packDir);

  const result = spawnSync(
    'npm', ['pack', '--pack-destination', packDir, '--json'],
    { cwd: packageRoot, encoding: 'utf8' },
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
  } catch {
    fail('npm pack stdout is not JSON', { stdout: result.stdout.slice(0, 500) });
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    fail('npm pack returned unexpected shape', {
      got: JSON.stringify(parsed).slice(0, 500),
    });
  }
  const tarball = join(packDir, parsed[0].filename);
  if (!existsSync(tarball)) {
    fail('tarball missing after npm pack', { expected: tarball });
  }
  ok(`packed ${parsed[0].filename}`);
  return tarball;
}

function assertTarballContains(tarball, expectedFiles, label) {
  step(`assert ${label} tarball contains migrator artifacts`);
  const result = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
  if (result.status !== 0) {
    fail('tar -tzf failed', { tarball, stderr: result.stderr.trim() });
  }
  const entries = new Set(result.stdout.split('\n').filter(Boolean));
  const missing = [];
  for (const f of expectedFiles) {
    if (!entries.has(`package/${f}`)) missing.push(f);
  }
  if (missing.length > 0) {
    fail(`${label} tarball missing required migrator files`, {
      missing: missing.join(', '),
      hint: 'Check package.json:files and that dist/ was built before npm pack. Migrator artifacts must ship under dist/.',
    });
  }
  ok(`${label} tarball contains all ${expectedFiles.length} required migrator file(s)`);
}

function installTarballs(cliTarball, kernelTarball) {
  step('install both tarballs into fresh scratch project');
  const projectDir = mkdtempSync(join(tmpdir(), 'caws-specs-smoke-'));
  registerCleanup(projectDir);

  writeFileSync(
    join(projectDir, 'package.json'),
    JSON.stringify({
      name: 'caws-specs-migration-smoke',
      version: '0.0.0',
      private: true,
    }, null, 2),
  );

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
    { cwd: projectDir, encoding: 'utf8' },
  );
  if (installResult.status !== 0) {
    fail('npm install of tarballs failed', {
      exitCode: installResult.status,
      stderr: installResult.stderr.trim().slice(0, 2000),
    });
  }

  for (const name of [KERNEL_PACKAGE_NAME, CLI_PACKAGE_NAME]) {
    const root = join(projectDir, 'node_modules', name);
    if (!existsSync(root)) {
      fail(`installed package root missing: ${name}`, { expected: root });
    }
  }

  const cawsBin = join(projectDir, 'node_modules', '.bin', 'caws');
  if (!existsSync(cawsBin)) {
    fail('caws binary missing from node_modules/.bin/', { expected: cawsBin });
  }
  ok(`installed kernel + CLI into ${projectDir}; binary at .bin/caws`);
  return { projectDir, cawsBin };
}

// ─── Caws invocation helpers ─────────────────────────────────────────────

function runCaws(cawsBin, args, cwd) {
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

// ─── Fixture authoring ──────────────────────────────────────────────────

function setupScratchRepo(parentDir) {
  step('initialize scratch repo with .caws/ + 3-spec v10 corpus + mapping');
  const repoDir = join(parentDir, 'fixture-repo');
  mkdirSync(repoDir);
  execSync('git init -q', { cwd: repoDir });
  execSync('git config user.email smoke@local', { cwd: repoDir });
  execSync('git config user.name Smoke', { cwd: repoDir });
  execSync('git commit --allow-empty -q -m init', { cwd: repoDir });

  const cawsDir = join(repoDir, '.caws');
  mkdirSync(join(cawsDir, 'specs'), { recursive: true });

  // Spec 1 — happy: every safe rename + risk_tier coercion + bare-date.
  writeFileSync(join(cawsDir, 'specs', 'SMOKE-HAPPY-001.yaml'), `id: SMOKE-HAPPY-001
title: smoke happy path
status: active
type: feature
mode: feature
acceptance_criteria:
  - id: A1
    given: x
    when: y
    then: z
created: '2026-01-01'
risk_tier: T3
blast_radius:
  modules:
    - pkg/foo
scope:
  in:
    - pkg/foo/bar.ts
non_functional:
  a11y:
    - keyboard navigation
contracts: []
invariants:
  - smoke fixture invariant
`);

  // Spec 2 — refused: blast_radius.modules: [].
  writeFileSync(join(cawsDir, 'specs', 'SMOKE-REFUSED-001.yaml'), `id: SMOKE-REFUSED-001
title: smoke refused (empty modules)
status: active
type: feature
mode: feature
acceptance_criteria: []
risk_tier: 2
blast_radius:
  modules: []
scope:
  in:
    - pkg/x/a.ts
non_functional: {}
contracts: []
invariants:
  - smoke fixture invariant
`);

  // Spec 3 — lifecycle-mapped: refused without mapping, migrates with it.
  writeFileSync(join(cawsDir, 'specs', 'SMOKE-LIFECYCLE-001.yaml'), `id: SMOKE-LIFECYCLE-001
title: smoke lifecycle mapped
status: superseded
type: feature
mode: feature
acceptance_criteria:
  - id: A1
    given: x
    when: y
    then: z
created: '2026-04-01T00:00:00.000Z'
risk_tier: 3
blast_radius:
  modules:
    - pkg/x
scope:
  in:
    - pkg/x/y.ts
non_functional: {}
contracts: []
invariants:
  - smoke lifecycle mapping fixture
`);

  // Operator mapping file (lives OUTSIDE .caws/specs/ so it does not
  // appear as a non_yaml observation in the scan).
  const mappingPath = join(repoDir, 'lifecycle-mapping.json');
  writeFileSync(
    mappingPath,
    JSON.stringify({
      'SMOKE-LIFECYCLE-001': {
        lifecycle_state: 'archived',
        resolution: 'superseded',
        closure_notes: 'superseded by SMOKE-HAPPY-001 (smoke test)',
      },
    }, null, 2),
  );

  ok(`scratch repo at ${repoDir}; 3 specs + mapping.json on disk`);
  return { repoDir, cawsDir, mappingPath };
}

function readSpec(cawsDir, name) {
  return readFileSync(join(cawsDir, 'specs', name), 'utf8');
}

// ─── End-to-end smoke ────────────────────────────────────────────────────

function runEndToEndSmoke(cawsBin, repoDir, cawsDir, mappingPath) {
  // Step a — command registration.
  step('caws specs migrate --help (command registration)');
  const help = runCaws(cawsBin, ['specs', 'migrate', '--help'], repoDir);
  assertExit(help, 0, 'specs migrate --help');
  assertStdoutMatches(help, /--from <version>/, 'specs migrate --help');
  assertStdoutMatches(help, /--apply/, 'specs migrate --help');
  assertStdoutMatches(help, /--partial/, 'specs migrate --help');
  assertStdoutMatches(help, /--lifecycle-mapping/, 'specs migrate --help');
  assertStdoutMatches(help, /--json/, 'specs migrate --help');
  ok('specs migrate --help: all flags registered on installed binary');

  // Step b — dry-run, no FS changes.
  step('caws specs migrate --from v10 (dry-run)');
  const happyBefore = readSpec(cawsDir, 'SMOKE-HAPPY-001.yaml');
  const refusedBefore = readSpec(cawsDir, 'SMOKE-REFUSED-001.yaml');
  const lifecycleBefore = readSpec(cawsDir, 'SMOKE-LIFECYCLE-001.yaml');

  const dry = runCaws(cawsBin, ['specs', 'migrate', '--from', 'v10'], repoDir);
  assertExit(dry, 0, 'specs migrate dry-run');
  assertStdoutMatches(dry, /\[dry-run\]/, 'specs migrate dry-run');
  assertStdoutMatches(dry, /migrated_with_warnings=1/, 'specs migrate dry-run');
  assertStdoutMatches(dry, /refused=2/, 'specs migrate dry-run');
  assertStdoutMatches(dry, /total=3/, 'specs migrate dry-run');
  assertStdoutMatches(dry, /\(dry-run; not persisted\)/, 'specs migrate dry-run');
  // Files byte-identical: dry-run is read-only.
  if (readSpec(cawsDir, 'SMOKE-HAPPY-001.yaml') !== happyBefore)
    fail('dry-run modified SMOKE-HAPPY-001.yaml — "no FS changes" is a lie');
  if (readSpec(cawsDir, 'SMOKE-REFUSED-001.yaml') !== refusedBefore)
    fail('dry-run modified SMOKE-REFUSED-001.yaml');
  if (readSpec(cawsDir, 'SMOKE-LIFECYCLE-001.yaml') !== lifecycleBefore)
    fail('dry-run modified SMOKE-LIFECYCLE-001.yaml');
  if (existsSync(join(cawsDir, 'migrations')))
    fail('dry-run created .caws/migrations/ — "not persisted" is a lie');
  ok('dry-run: all spec bytes preserved, no .caws/migrations/');

  // Step c — apply WITHOUT --partial refuses.
  step('caws specs migrate --from v10 --apply (no --partial: refuse on any refused)');
  const applyNoPartial = runCaws(
    cawsBin, ['specs', 'migrate', '--from', 'v10', '--apply'], repoDir,
  );
  assertExit(applyNoPartial, 1, 'apply no-partial');
  if (readSpec(cawsDir, 'SMOKE-HAPPY-001.yaml') !== happyBefore)
    fail('apply (no --partial) wrote SMOKE-HAPPY-001.yaml — should have refused entirely');
  if (existsSync(join(cawsDir, 'migrations')))
    fail('apply (no --partial) created .caws/migrations/ — should have refused entirely');
  ok('apply no-partial: refused; happy.yaml byte-identical; no report dir');

  // Step d — apply --partial writes happy, skips refused.
  step('caws specs migrate --from v10 --apply --partial');
  const applyPartial = runCaws(
    cawsBin, ['specs', 'migrate', '--from', 'v10', '--apply', '--partial'], repoDir,
  );
  assertExit(applyPartial, 0, 'apply --partial');
  assertStdoutMatches(applyPartial, /\[apply\]/, 'apply --partial');
  assertStdoutMatches(applyPartial, /migrated_with_warnings=1/, 'apply --partial');
  assertStdoutMatches(applyPartial, /refused=2/, 'apply --partial');
  assertStdoutMatches(applyPartial, /report: \.caws\/migrations\/v10-specs\//, 'apply --partial');
  // Happy migrated, others byte-identical.
  const happyAfter = readSpec(cawsDir, 'SMOKE-HAPPY-001.yaml');
  if (happyAfter === happyBefore) {
    fail('SMOKE-HAPPY-001.yaml not rewritten by --apply --partial');
  }
  if (!happyAfter.includes('lifecycle_state:'))
    fail('SMOKE-HAPPY-001.yaml not in v11 shape (no lifecycle_state)');
  if (happyAfter.includes('\nstatus:'))
    fail('SMOKE-HAPPY-001.yaml still has v10 status field after migration');
  if (!happyAfter.includes("'2026-01-01T00:00:00.000Z'"))
    fail('SMOKE-HAPPY-001.yaml did not get bare-date coerced to ISO');
  if (readSpec(cawsDir, 'SMOKE-REFUSED-001.yaml') !== refusedBefore)
    fail('SMOKE-REFUSED-001.yaml was modified despite refused verdict');
  if (readSpec(cawsDir, 'SMOKE-LIFECYCLE-001.yaml') !== lifecycleBefore)
    fail('SMOKE-LIFECYCLE-001.yaml was modified despite refused (no mapping) verdict');
  ok('apply --partial: happy migrated on disk; refused fixtures byte-identical');

  // Verify report on disk.
  const reportsDir = join(cawsDir, 'migrations', 'v10-specs');
  if (!existsSync(reportsDir))
    fail('apply --partial did not create .caws/migrations/v10-specs/');
  const reports = readdirSync(reportsDir);
  if (reports.length !== 1)
    fail(`expected exactly 1 report file, found ${reports.length}`, {
      files: reports.join(', '),
    });
  const reportJson = JSON.parse(readFileSync(join(reportsDir, reports[0]), 'utf8'));
  if (reportJson.schema_version !== 1)
    fail('report schema_version is not 1', { got: reportJson.schema_version });
  if (reportJson.distribution.migrated_with_warnings !== 1)
    fail('report distribution mismatch', {
      got: JSON.stringify(reportJson.distribution),
    });
  if (reportJson.distribution.refused !== 2)
    fail('report refused count mismatch', {
      got: JSON.stringify(reportJson.distribution),
    });
  if (reportJson.distribution.post_write_validation_failed !== 0)
    fail('post_write_validation_failed should be 0 on the smoke corpus', {
      got: JSON.stringify(reportJson.distribution),
    });
  ok(`report on disk: schema_version=1, distribution matches, PWF=0`);

  // Step e — apply --partial with --lifecycle-mapping. Restore the
  // lifecycle spec from original v10 bytes (step d did not touch it
  // because it was refused without mapping). The happy spec is now
  // v11-shape on disk from step d's successful migration; the scan
  // will silently exclude it (already-v11 idempotency guard from
  // commit 2). So this run sees only 2 v10 specs: the restored
  // lifecycle one (now migrates with mapping) and the refused one
  // (still empty modules). That is the truthful operator state after
  // a partial apply.
  step('caws specs migrate --apply --partial --lifecycle-mapping (lifecycle-mapped now lands)');
  writeFileSync(join(cawsDir, 'specs', 'SMOKE-LIFECYCLE-001.yaml'), lifecycleBefore);
  const applyMapped = runCaws(
    cawsBin,
    [
      'specs', 'migrate',
      '--from', 'v10',
      '--apply', '--partial',
      '--lifecycle-mapping', mappingPath,
    ],
    repoDir,
  );
  assertExit(applyMapped, 0, 'apply --partial with mapping');
  // Distribution: total=2 (happy is now v11, silently excluded),
  // migrated_with_warnings=1 (lifecycle), refused=1 (empty modules).
  assertStdoutMatches(applyMapped, /migrated_with_warnings=1/, 'apply mapped');
  assertStdoutMatches(applyMapped, /refused=1/, 'apply mapped');
  assertStdoutMatches(applyMapped, /total=2/, 'apply mapped');
  const lifecycleAfter = readSpec(cawsDir, 'SMOKE-LIFECYCLE-001.yaml');
  if (!lifecycleAfter.includes('lifecycle_state: archived'))
    fail('SMOKE-LIFECYCLE-001.yaml missing lifecycle_state: archived after mapped apply');
  if (!lifecycleAfter.includes('resolution: superseded'))
    fail('SMOKE-LIFECYCLE-001.yaml missing resolution: superseded after mapped apply');
  if (!lifecycleAfter.includes('closure_notes: superseded by SMOKE-HAPPY-001'))
    fail('SMOKE-LIFECYCLE-001.yaml missing closure_notes after mapped apply');
  ok('apply mapped: lifecycle-mapped on disk with archived + resolution + closure_notes');

  // Step f — --json mode emits parseable JSON with the contract shape.
  step('caws specs migrate --from v10 --json (JSON output shape)');
  const jsonResult = runCaws(
    cawsBin, ['specs', 'migrate', '--from', 'v10', '--json'], repoDir,
  );
  assertExit(jsonResult, 0, 'specs migrate --json');
  let parsed;
  try {
    parsed = JSON.parse(jsonResult.stdout);
  } catch (e) {
    fail('--json output is not parseable JSON', {
      error: e.message,
      stdoutHead: jsonResult.stdout.slice(0, 500),
    });
  }
  if (parsed.ok !== true)
    fail('--json output ok field is not true', { got: parsed.ok });
  if (parsed.report?.schema_version !== 1)
    fail('--json output report.schema_version != 1');
  if (!Array.isArray(parsed.report?.entries))
    fail('--json output report.entries is not an array');
  ok('--json output: parseable, schema_version=1, entries array present');
}

// ─── Main ────────────────────────────────────────────────────────────────

const startMs = Date.now();
try {
  // Pack BOTH. Kernel first because CLI's runtime deps on it.
  const kernelTarball = packPackage(KERNEL_ROOT, KERNEL_PACKAGE_NAME);
  const cliTarball = packPackage(CLI_ROOT, CLI_PACKAGE_NAME);

  // The load-bearing artifacts for the migrator surface. If any of
  // these are missing from the tarball, install will succeed but the
  // command will fail at runtime — exactly the regression class this
  // smoke prevents.
  assertTarballContains(kernelTarball, [
    'dist/spec/migrate-v10.js',
    'dist/spec/migrate-v10.d.ts',
    'dist/spec/index.js',
    'dist/spec/index.d.ts',
  ], 'kernel');

  assertTarballContains(cliTarball, [
    'dist/store/specs-migration.js',
    'dist/store/specs-migration.d.ts',
    'dist/shell/commands/specs.js',
    'dist/shell/index.js',
  ], 'CLI');

  // Install + run.
  const { projectDir, cawsBin } = installTarballs(cliTarball, kernelTarball);
  const { repoDir, cawsDir, mappingPath } = setupScratchRepo(projectDir);
  runEndToEndSmoke(cawsBin, repoDir, cawsDir, mappingPath);

  const elapsedMs = Date.now() - startMs;
  log(colors.green(
    `\n[specs-migration-smoke] PASS in ${elapsedMs}ms — published tarballs contain the migrator and run end-to-end from install`,
  ));
} catch (err) {
  fail('unexpected error', { message: err.message, stack: err.stack?.slice(0, 1000) });
}
