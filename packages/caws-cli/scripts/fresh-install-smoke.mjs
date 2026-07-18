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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, '..');
const KERNEL_ROOT = resolve(__dirname, '..', '..', 'caws-kernel');
const PACKAGE_NAME = '@paths.design/caws-cli';
const KERNEL_NAME = '@paths.design/caws-kernel';
const PACK_ID = 'claude-code';
const PACKS = {
  'claude-code': {
    manifestFile: 'manifest-claude-code.js',
    exportName: 'CLAUDE_CODE_PACK',
  },
  codex: {
    manifestFile: 'manifest-codex.js',
    exportName: 'CODEX_PACK',
  },
  // CAWS-HOOK-PACK-SHARED-CORE-001: the real hook logic (oracle, agent-*.sh,
  // guards, dispatchers, libs) lives in the `shared` pack and installs under
  // .caws/hooks/. The vendor packs (claude-code/codex) are now thin adapters.
  // `caws init --agent-surface <vendor>` installs BOTH shared + vendor
  // (init.ts: installHookPack(SHARED_PACK) then installHookPack(vendor)).
  shared: {
    manifestFile: 'manifest-shared.js',
    exportName: 'SHARED_PACK',
  },
};

function enabledPackIds() {
  const raw = process.env.CAWS_SMOKE_PACKS ?? process.env.CAWS_SMOKE_PACK ?? PACK_ID;
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const invalid = ids.filter((id) => !PACKS[id]);
  if (invalid.length > 0) {
    fail('unknown CAWS_SMOKE_PACKS value', {
      got: invalid.join(', '),
      allowed: Object.keys(PACKS).join(', '),
    });
  }
  return ids.length > 0 ? ids : [PACK_ID];
}

function smokeParentDir() {
  return process.env.CAWS_SMOKE_PROJECT_PARENT
    ? resolve(process.env.CAWS_SMOKE_PROJECT_PARENT)
    : tmpdir();
}

function makeSmokeDir(prefix) {
  const parent = smokeParentDir();
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, prefix));
}

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
  if (process.env.CAWS_SMOKE_KEEP_ON_FAIL) {
    log(colors.yellow(`[fresh-install-smoke] CAWS_SMOKE_KEEP_ON_FAIL set — preserving:`));
    for (const path of cleanupPaths) log(`  ${path}`);
    cleanupPaths.clear();
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
let smokeNpmCacheDir = null;
function npmEnv() {
  if (!smokeNpmCacheDir) {
    smokeNpmCacheDir = process.env.CAWS_SMOKE_NPM_CACHE
      ? resolve(process.env.CAWS_SMOKE_NPM_CACHE)
      : mkdtempSync(join(tmpdir(), 'caws-smoke-npm-cache-'));
    mkdirSync(smokeNpmCacheDir, { recursive: true });
    registerCleanup(smokeNpmCacheDir);
  }
  return {
    ...process.env,
    npm_config_cache: smokeNpmCacheDir,
    npm_config_update_notifier: 'false',
  };
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

function preserveCleanupPathsOnSuccess() {
  if (!process.env.CAWS_SMOKE_KEEP_ON_SUCCESS) return;
  log(colors.yellow(`[fresh-install-smoke] CAWS_SMOKE_KEEP_ON_SUCCESS set — preserving:`));
  for (const path of cleanupPaths) log(`  ${path}`);
  cleanupPaths.clear();
}

// ─── Pipeline steps ──────────────────────────────────────────────────────

function packOne(packageRoot, label) {
  const packDir = mkdtempSync(join(tmpdir(), `caws-pack-${label}-`));
  registerCleanup(packDir);
  const result = spawnSync(
    'npm', ['pack', '--pack-destination', packDir, '--json'],
    { cwd: packageRoot, encoding: 'utf8', env: npmEnv() }
  );
  if (result.status !== 0) {
    fail(`npm pack failed for ${label}`, {
      exitCode: result.status, stderr: result.stderr.trim(),
    });
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch { fail(`npm pack stdout is not JSON for ${label}`, { stdout: result.stdout.slice(0, 500) }); }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    fail(`npm pack returned unexpected shape for ${label}`, { got: JSON.stringify(parsed).slice(0, 500) });
  }
  const { filename, files = [] } = parsed[0];
  const tarball = join(packDir, filename);
  if (!existsSync(tarball)) fail(`tarball missing after npm pack for ${label}`, { expected: tarball });
  return { tarball, filename, files };
}

function buildKernelForPack() {
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: KERNEL_ROOT,
    encoding: 'utf8',
    env: npmEnv(),
  });
  if (result.status !== 0) {
    fail('kernel build failed before npm pack', {
      exitCode: result.status,
      stdout: result.stdout.trim().slice(0, 1000),
      stderr: result.stderr.trim().slice(0, 1000),
    });
  }
}

function packTarball() {
  // Pack BOTH the kernel and the CLI from this worktree. The published
  // CLI tarball depends on the latest registry-published kernel by
  // version range, but the multi-agent slice's CLI code requires kernel
  // symbols (registerAgentSession, heartbeatAgentSession,
  // stopAgentSession, summarizeActiveAgents) that don't exist in any
  // released kernel yet. Installing only the CLI tarball would resolve
  // the kernel from npm and the CLI would crash at runtime with
  // "(0, caws_kernel_1.registerAgentSession) is not a function".
  //
  // Both tarballs are needed for the smoke to faithfully model what a
  // user gets when both packages release together.
  step('npm pack (kernel + cli)');
  buildKernelForPack();
  const kernel = packOne(KERNEL_ROOT, 'kernel');
  ok(`packed kernel: ${kernel.filename}`);
  const cli = packOne(PACKAGE_ROOT, 'cli');
  ok(`packed cli: ${cli.filename}`);
  return { kernelTarball: kernel.tarball, cliTarball: cli.tarball, cliFiles: cli.files };
}

function installTarball({ kernelTarball, cliTarball }) {
  step('install kernel+cli tarballs into fresh project');
  const projectDir = makeSmokeDir('caws-smoke-project-');
  registerCleanup(projectDir);

  // Minimal package.json so npm install has something to anchor to.
  const pkgJson = { name: 'caws-fresh-install-smoke', version: '0.0.0', private: true };
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify(pkgJson));

  // Install BOTH tarballs in a single npm install call. npm resolves
  // intra-tarball dependencies (the cli's @paths.design/caws-kernel
  // entry will pick up the locally-installed kernel tarball rather than
  // reaching out to the registry).
  // --ignore-scripts is intentional — we want the published bits as-is,
  // not prepare/postinstall hooks that might paper over packaging gaps.
  const result = spawnSync(
    'npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts',
      kernelTarball, cliTarball],
    { cwd: projectDir, encoding: 'utf8', env: npmEnv() }
  );
  if (result.status !== 0) {
    fail('npm install of tarballs failed', {
      exitCode: result.status,
      stderr: result.stderr.trim().slice(0, 1000),
    });
  }

  const installedRoot = join(projectDir, 'node_modules', PACKAGE_NAME);
  if (!existsSync(installedRoot)) {
    fail('installed cli package root missing', { expected: installedRoot });
  }
  const installedKernel = join(projectDir, 'node_modules', KERNEL_NAME);
  if (!existsSync(installedKernel)) {
    fail('installed kernel package root missing', { expected: installedKernel });
  }

  // Verify the installed kernel actually exports registerAgentSession.
  // If npm resolution picked up a registry copy instead of our tarball
  // (e.g. semver mismatch), the CLI will crash at runtime — better to
  // fail fast here with a clear diagnostic.
  const probe = spawnSync('node', ['-e',
    `const k = require(${JSON.stringify(installedKernel)}); ` +
    `process.stdout.write(typeof k.registerAgentSession);`,
  ], { encoding: 'utf8' });
  if (probe.stdout !== 'function') {
    fail('installed kernel does not export registerAgentSession', {
      installedKernel,
      gotType: probe.stdout,
      stderr: probe.stderr.trim().slice(0, 500),
      hint: 'npm may have resolved kernel from registry instead of the local tarball — check the cli tarball\'s package.json:dependencies version range',
    });
  }
  ok(`installed ${KERNEL_NAME} + ${PACKAGE_NAME} into ${projectDir}`);
  return { projectDir, installedRoot, installedKernel };
}

function loadManifest(installedRoot, packId = PACK_ID) {
  step('load manifest from installed package');
  const spec = PACKS[packId];
  const manifestPath = join(installedRoot, 'dist', 'init', 'hook-packs', spec.manifestFile);
  if (!existsSync(manifestPath)) {
    fail('manifest file missing in installed package', {
      expected: manifestPath,
      hint: 'dist/ may be missing or incomplete in the published tarball',
    });
  }
  // Use require() via child_process for clean ESM/CJS interop with the compiled CJS manifest.
  const result = spawnSync(
    'node',
    ['-e', `const m = require(${JSON.stringify(manifestPath)}); process.stdout.write(JSON.stringify(m[${JSON.stringify(spec.exportName)}]));`],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    fail('failed to load installed manifest', { stderr: result.stderr.trim() });
  }
  const pack = JSON.parse(result.stdout);
  if (!Array.isArray(pack.installedFiles) || pack.installedFiles.length === 0) {
    fail('manifest installedFiles is empty or missing', { got: pack });
  }
  ok(`${packId} manifest declares ${pack.installedFiles.length} files`);
  return pack;
}

function assertTemplateSourcesPresent(installedRoot, pack, packId = PACK_ID) {
  step('assert template sources present in installed package');
  const packRoot = join(installedRoot, 'templates', 'hook-packs', packId);
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

function runInit(projectDir, installedRoot, packId = PACK_ID) {
  step(`git init + caws init --agent-surface ${packId}`);
  // Initialize a git repo so init doesn't refuse.
  if (!existsSync(join(projectDir, '.git'))) {
    execSync('git init -q', { cwd: projectDir });
    execSync('git config user.email smoke@local', { cwd: projectDir });
    execSync('git config user.name Smoke', { cwd: projectDir });
    execSync('git commit --allow-empty -q -m init', { cwd: projectDir });
  }

  const cli = join(installedRoot, 'dist', 'index.js');
  const result = spawnSync(
    'node', [cli, 'init', '--agent-surface', packId],
    { cwd: projectDir, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    fail(`caws init --agent-surface ${packId} exited non-zero`, {
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

// ─── Multi-agent lease substrate smoke (MULTI-AGENT-ACTIVITY-REGISTRY-001) ──
//
// These checks prove the v3 hook pack's three new agent-*.sh templates
// actually work end-to-end when installed from the tarball. They guard
// against silent breakage in three failure modes:
//
//   - SessionStart hook never runs (no lease ever created)
//   - PreToolUse hook never surfaces peers (parallel agents invisible)
//   - Stop hook never marks the lease stopped (zombie leases linger)
//
// All three require the installed `caws` binary to be invocable from a
// hook script. We materialize a tiny PATH shim pointing at the installed
// dist/index.js so `command -v caws` resolves and the hook can use it.

function setupCliShim(installedRoot) {
  const shimDir = mkdtempSync(join(tmpdir(), 'caws-smoke-shim-'));
  registerCleanup(shimDir);
  const cli = join(installedRoot, 'dist', 'index.js');
  const shim = join(shimDir, 'caws');
  writeFileSync(shim, `#!/bin/bash\nexec node ${JSON.stringify(cli)} "$@"\n`);
  chmodSync(shim, 0o755);
  return shimDir;
}

function pathWithShim(shimDir) {
  return `${shimDir}:${process.env.PATH}`;
}

// jq must NOT be required by the hook pack. To prove that, we materialize
// an isolated PATH that contains only:
//   1. The CLI shim directory (so `caws` resolves).
//   2. A small whitelist of essential POSIX dirs (/usr/bin, /bin) — these
//      provide `dirname`, `cd`, `mkdir`, `node` (when symlinked), etc.
//      that the hook script itself needs. We assert jq is NOT present in
//      these dirs; if it is (some macOS Homebrew installs put jq into
//      /usr/local/bin), the test SKIPS rather than producing a false
//      positive.
// We deliberately do NOT use a filter-out approach over the full PATH —
// that's fragile, since jq can be symlinked into many places and
// dropping a directory might also drop essential binaries.
function pathWithoutJq(shimDir) {
  const minimalDirs = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  // node may live in nvm/homebrew dirs; preserve only the directory
  // containing the current node binary, IF it does not also contain jq.
  const nodeDir = dirname(process.execPath);
  if (!existsSync(join(nodeDir, 'jq'))) {
    minimalDirs.push(nodeDir);
  }
  const present = minimalDirs.filter((d) => existsSync(d));
  // Final safety: confirm none of these still has jq.
  for (const d of present) {
    if (existsSync(join(d, 'jq'))) {
      // jq is somewhere essential; this environment can't isolate it.
      // Return null to signal "skip the assertion".
      return null;
    }
  }
  return `${shimDir}:${present.join(':')}`;
}

function runDispatcher(projectDir, dispatcherPath, payload, env) {
  const result = spawnSync('bash', [dispatcherPath], {
    cwd: projectDir,
    encoding: 'utf8',
    input: JSON.stringify(payload),
    env: { ...process.env, ...env },
  });
  return result;
}

function readLease(projectDir, sessionId) {
  const leasePath = join(projectDir, '.caws', 'leases', `${sessionId}.json`);
  if (!existsSync(leasePath)) return null;
  try {
    return JSON.parse(readFileSync(leasePath, 'utf8'));
  } catch {
    return null;
  }
}

function assertSharedAgentHooks(sharedPack) {
  step('A14.4 — installed SHARED pack carries the three agent-*.sh (managed+executable)');
  // CAWS-HOOK-PACK-SHARED-CORE-001: the three agent-*.sh moved from the
  // claude-code pack (.claude/hooks/, where they were introduced in pack v3)
  // to the SHARED pack (.caws/hooks/). The version floor that used to gate this
  // (claude-code >= 3) no longer applies — the shared pack has its own
  // versioning (v1). What MUST hold is structural: the three agent hooks are
  // declared, managed, executable, and rooted under .caws/hooks/.
  if (typeof sharedPack.packVersion !== 'number' || sharedPack.packVersion < 1) {
    fail('installed shared manifest pack version below the v1 floor', {
      minimum: 1, got: sharedPack.packVersion,
    });
  }
  const required = ['agent-register.sh', 'agent-heartbeat.sh', 'agent-stop.sh'];
  for (const name of required) {
    const entry = sharedPack.installedFiles.find((f) => f.destPath === `.caws/hooks/${name}`);
    if (!entry) fail(`shared manifest missing ${name} at .caws/hooks/${name}`);
    if (!entry.managed) fail(`${name} is not managed:true`);
    if (!entry.executable) fail(`${name} is not executable:true`);
  }
  ok(`shared pack v${sharedPack.packVersion} carries all three agent-*.sh under .caws/hooks/ (managed+executable)`);
}

function assertOracleRunsUnderTypeModule(projectDir) {
  // FIX-HOOKPACK-CONSUMER-INSTALL-001 A1/A6 — the regression this slice fixes.
  // The worktree-claim-oracle is CommonJS (require()). It shipped as .js; in a
  // consumer repo whose package.json declares "type":"module", Node loads a .js
  // file as ESM and crashes (ReferenceError: require is not defined), so both
  // write-guards fail closed with error_fail_closed:oracle-spawn on every
  // worktree-path write. The pre-existing smoke never caught this because its
  // scratch package.json is CommonJS-default. Here we set "type":"module" and
  // prove the INSTALLED oracle still runs.
  step('A1/A6 — ownership oracle runs under a consumer "type":"module" repo');

  // CAWS-HOOK-PACK-SHARED-CORE-001: the oracle moved from the claude-code pack
  // (.claude/hooks/lib/) to the shared pack (.caws/hooks/lib/).
  const oracle = join(projectDir, '.caws', 'hooks', 'lib', 'worktree-claim-oracle.cjs');
  if (!existsSync(oracle)) {
    fail('installed oracle not found at the .cjs path', {
      expected: oracle,
      hint: 'shared pack manifest destPath must be lib/worktree-claim-oracle.cjs (installs under .caws/hooks/)',
    });
  }

  // Flip the scratch repo to ESM for the duration of this check, then restore.
  const pkgPath = join(projectDir, 'package.json');
  const original = readFileSync(pkgPath, 'utf8');
  let restored = false;
  const restore = () => {
    if (!restored) {
      writeFileSync(pkgPath, original);
      restored = true;
    }
  };
  try {
    const pkg = JSON.parse(original);
    pkg.type = 'module';
    writeFileSync(pkgPath, JSON.stringify(pkg));

    const r = spawnSync('node', [oracle], {
      cwd: projectDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        CAWS_ORACLE_PROJECT_DIR: projectDir,
        CAWS_ORACLE_CURRENT_BRANCH: '',
        CAWS_ORACLE_REL_PATH: join(projectDir, 'README.md'),
        CAWS_ORACLE_SESSION_ID: 'caws-smoke-typemodule',
      },
    });

    // The .cjs extension forces CommonJS regardless of the host package type,
    // so require() resolves and the oracle prints a decision. The bug (a .js
    // oracle) would instead crash with a non-zero exit and the ESM error on
    // stderr, and stdout would be empty.
    const decision = (r.stdout || '').trim().split('\n')[0];
    const validOutcome = /^(pass|block_claimed|block_foreign_worktree|ask_uncertain|error_fail_closed)\b/;
    if (r.status !== 0 || !validOutcome.test(decision)) {
      fail('oracle did not run under "type":"module" — the .cjs fix is not in effect', {
        exitCode: r.status,
        stdout: (r.stdout || '').trim().slice(0, 400),
        stderr: (r.stderr || '').trim().slice(0, 400),
        hint: 'a .js (not .cjs) oracle would crash here with "require is not defined in ES module scope"',
      });
    }
    ok(`oracle ran under "type":"module": ${decision} (exit 0, no ESM crash)`);
  } finally {
    restore();
  }
}

function assertSessionStartCreatesLease(projectDir, shimDir) {
  step('A14.5 — SessionStart dispatcher creates a lease file');
  const sessionId = 'caws-smoke-session-a';
  const dispatcher = join(projectDir, '.caws', 'hooks', 'dispatch','session_start.sh');
  const r = runDispatcher(projectDir, dispatcher, {
    hook_event_name: 'SessionStart',
    session_id: sessionId,
    cwd: projectDir,
  }, { PATH: pathWithShim(shimDir) });
  // The dispatcher fans out to a handler chain (audit, session-log,
  // agent-register). A non-zero exit from a sibling handler (e.g.
  // session-log.sh's python renderer being unreachable) does not
  // invalidate this check — the lease IS the contract for
  // MULTI-AGENT-ACTIVITY-REGISTRY-001. We assert lease creation
  // directly; the sibling handler's exit code is incidental and
  // belongs to a separate slice.
  const lease = readLease(projectDir, sessionId);
  if (!lease) {
    fail('SessionStart did not create lease file', {
      expected: join(projectDir, '.caws', 'leases', `${sessionId}.json`),
      dispatcherExitCode: r.status,
      dispatcherStderr: r.stderr.trim().slice(0, 1000),
    });
  }
  if (lease.status !== 'active') {
    fail('lease created but status is not "active"', { got: lease.status });
  }
  // Record (don't fail on) sibling-handler noise so the failure-mode is
  // visible during smoke runs.
  if (r.status !== 0) {
    log(colors.dim(`  [info] dispatcher max_exit=${r.status} (sibling handler noise — lease created OK)`));
  }
  ok(`SessionStart created .caws/leases/${sessionId}.json with status=active`);
  return sessionId;
}

function assertPreToolUseSilentAtN1(projectDir, shimDir, sessionId) {
  step('A14.6 — PreToolUse is silent when only one lease exists');
  const dispatcher = join(projectDir, '.caws', 'hooks', 'dispatch','pre_tool_use.sh');
  const r = runDispatcher(projectDir, dispatcher, {
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    tool_name: 'Bash',
    tool_input: { command: 'echo test' },
    cwd: projectDir,
  }, { PATH: pathWithShim(shimDir) });
  // The contract for A14.6 is "stdout contains no envelope tokens" —
  // dispatcher exit code is incidental (sibling handlers may return
  // non-zero for unrelated reasons).
  if (r.stdout.includes('hookSpecificOutput') || r.stdout.includes('additionalContext')) {
    fail('PreToolUse emitted hookSpecificOutput at N=1 (expected silent)', {
      stdout: r.stdout.trim().slice(0, 1000),
    });
  }
  ok('PreToolUse silent at N=1 (no hookSpecificOutput in stdout)');
}

function seedPeerLeaseAndAssertEnvelope(projectDir, installedRoot, shimDir, selfSessionId) {
  step('A14.7 — PreToolUse emits envelope naming peer at N>1');
  const peerId = 'caws-smoke-peer';

  // Seed the peer via the actual CLI to exercise the same write path the
  // real hook uses.
  const cli = join(installedRoot, 'dist', 'index.js');
  const reg = spawnSync('node', [cli, 'agents', 'register',
    '--session-id', peerId,
    '--platform', 'claude-code',
    '--reason', 'manual_register',
  ], { cwd: projectDir, encoding: 'utf8' });
  if (reg.status !== 0) {
    fail('failed to seed peer lease via caws agents register', {
      stderr: reg.stderr.trim().slice(0, 1000),
    });
  }

  const dispatcher = join(projectDir, '.caws', 'hooks', 'dispatch','pre_tool_use.sh');
  const r = runDispatcher(projectDir, dispatcher, {
    hook_event_name: 'PreToolUse',
    session_id: selfSessionId,
    tool_name: 'Bash',
    tool_input: { command: 'echo test' },
    cwd: projectDir,
  }, { PATH: pathWithShim(shimDir) });
  // Contract: dispatcher stdout names the peer. Exit code is incidental.
  if (!r.stdout.includes('hookSpecificOutput')) {
    fail('PreToolUse did not emit hookSpecificOutput envelope at N=2', {
      stdout: r.stdout.trim().slice(0, 2000),
      stderr: r.stderr.trim().slice(0, 1000),
    });
  }
  if (!r.stdout.includes(peerId)) {
    fail('PreToolUse envelope does not name the peer session', {
      expectedPeerId: peerId,
      stdout: r.stdout.trim().slice(0, 2000),
    });
  }
  if (r.stdout.includes(selfSessionId)) {
    fail('PreToolUse envelope leaked the self session id (should be excluded)', {
      selfSessionId,
      stdout: r.stdout.trim().slice(0, 2000),
    });
  }
  ok(`PreToolUse N>1 envelope names peer "${peerId}" and excludes self "${selfSessionId}"`);
  return peerId;
}

function assertStopMarksLeaseStopped(projectDir, shimDir, sessionId) {
  step('A14.8 — Stop dispatcher flips lease to stopped with stopped_at');
  const dispatcher = join(projectDir, '.caws', 'hooks', 'dispatch','stop.sh');
  const r = runDispatcher(projectDir, dispatcher, {
    hook_event_name: 'Stop',
    session_id: sessionId,
    cwd: projectDir,
  }, { PATH: pathWithShim(shimDir) });
  // Contract: lease flips to stopped. Dispatcher exit code is incidental.
  const lease = readLease(projectDir, sessionId);
  if (!lease) {
    fail('lease file disappeared after Stop dispatcher', {
      dispatcherExitCode: r.status,
      dispatcherStderr: r.stderr.trim().slice(0, 1000),
    });
  }
  if (lease.status !== 'stopped') {
    fail('Stop did not flip lease.status to "stopped"', { got: lease.status });
  }
  if (!lease.stopped_at) {
    fail('Stop did not set lease.stopped_at');
  }
  ok(`Stop flipped lease.status=stopped with stopped_at=${lease.stopped_at}`);
}

function assertAgentsPanelRendersBeforeDoctor(projectDir, installedRoot) {
  step('A14.9 — caws status renders Agents panel before Doctor');
  const cli = join(installedRoot, 'dist', 'index.js');
  const r = spawnSync('node', [cli, 'status'], {
    cwd: projectDir, encoding: 'utf8',
  });
  if (r.status !== 0 && r.status !== 1) {
    // status exits 1 when there are warnings; both are non-fatal here.
    fail('caws status exited unexpectedly', {
      exitCode: r.status,
      stderr: r.stderr.trim().slice(0, 1000),
    });
  }
  const out = r.stdout || '';
  const agentsIdx = out.toLowerCase().indexOf('agents');
  const doctorIdx = out.toLowerCase().indexOf('doctor');
  if (agentsIdx === -1) {
    fail('caws status output does not include an Agents section', {
      stdout: out.slice(0, 2000),
    });
  }
  if (doctorIdx === -1) {
    // Doctor panel may not render if there are no findings; tolerate
    // its absence but still record that the Agents panel exists.
    ok('Agents panel present in caws status (Doctor panel absent — tolerated)');
    return;
  }
  if (agentsIdx >= doctorIdx) {
    fail('Agents panel appears AFTER Doctor panel in caws status', {
      agentsIdx, doctorIdx,
    });
  }
  ok(`Agents panel renders at offset ${agentsIdx} before Doctor at ${doctorIdx}`);
}

function assertCliStaysHookProtocolFree(projectDir, installedRoot) {
  step('A14.10 — installed CLI emits zero hook-protocol tokens');
  const cli = join(installedRoot, 'dist', 'index.js');
  const r = spawnSync('node', [cli, 'agents', 'heartbeat',
    '--session-id', 'caws-smoke-protocol-check',
    '--platform', 'claude-code',
    '--throttle', '0',
    '--json',
    '--include-active-summary',
  ], { cwd: projectDir, encoding: 'utf8' });
  if (r.status !== 0) {
    fail('caws agents heartbeat exited non-zero', {
      exitCode: r.status, stderr: r.stderr.trim().slice(0, 1000),
    });
  }
  const forbidden = ['hookSpecificOutput', 'hookEventName', 'permissionDecision', 'additionalContext'];
  const combined = `${r.stdout}\n${r.stderr}`;
  const leaks = forbidden.filter((tok) => combined.includes(tok));
  if (leaks.length > 0) {
    fail('installed CLI leaked hook-protocol tokens', {
      leaks, output: combined.slice(0, 2000),
    });
  }
  // Also assert the JSON parses cleanly so we know we actually saw output.
  try {
    JSON.parse(r.stdout);
  } catch {
    fail('installed CLI did not emit valid JSON', { stdout: r.stdout.slice(0, 1000) });
  }
  ok('installed CLI stdout is CAWS-native JSON with zero hook-protocol tokens');
}

// A14.12 — CAWS-V11-INSTALLED-ARTIFACT-SMOKE-EXTEND-001: removed/renamed/
// replaced/deferred v10.2 commands, invoked through the installed binary,
// must exit 1 with disposition-appropriate typed migration guidance — and
// must NEVER exit 0 or dispatch a v11 handler. This promotes the Slice-2
// classifier (CAWS-REMOVED-COMMAND-DIAGNOSTICS-001) from source-unit
// evidence to installed-artifact release-gate evidence: the smoke runs in
// prepublishOnly, so a tarball whose binary fails to refuse a removed
// command blocks the publish.
//
// Exit code is read from the spawned process .status directly — NEVER via
// a shell pipe, which reports the LAST pipeline stage's code and would mask
// a wrong CLI exit (a real footgun observed while capturing these
// expectations). Expected substrings were captured verbatim from the built
// binary.
function assertLegacyCommandDiagnostics(projectDir, installedRoot) {
  step('A14.12 — installed binary refuses legacy v10.2 commands (exit 1 + typed guidance)');
  const cli = join(installedRoot, 'dist', 'index.js');

  // Each case: argv, the disposition it exercises, substrings that MUST be
  // present in stderr, and substrings that MUST be absent.
  const cases = [
    {
      argv: ['validate'],
      disposition: 'replaced',
      mustInclude: ['replaced in v11', 'caws doctor'],
      mustExclude: [],
    },
    {
      argv: ['archive', 'SOME-ID'],
      disposition: 'renamed',
      mustInclude: ['renamed to caws specs archive', 'caws specs archive'],
      mustExclude: [],
    },
    {
      argv: ['sidecar', 'gaps'],
      disposition: 'removed',
      mustInclude: ['removed in v11'],
      // removed-without-replacement: no "Use instead:" block.
      mustExclude: ['Use instead:'],
    },
    {
      argv: ['session', 'start'],
      disposition: 'deferred',
      mustInclude: ['deferred to v11.3+'],
      mustExclude: [],
    },
    // NOTE: `caws worktree prune` was previously listed here as a deferred-
    // to-v11.2 command expecting exit 1. It has since SHIPPED as a live
    // read-only cleanup-planning command (exit 0, dry-run by default, --apply
    // for the apply-capable classes). It is no longer a removed/deferred
    // command and must not be asserted as one — doing so is a stale-
    // assertion false-fail. Removed from this legacy-refusal list.
    {
      argv: ['statuz'],
      disposition: 'typo (fuzzy suggester, not legacy)',
      mustInclude: ['Did you mean: caws status'],
      // A genuine typo must NOT be classified as a legacy command.
      mustExclude: ['replaced in v11', 'removed in v11', 'renamed to', 'deferred to'],
    },
  ];

  for (const c of cases) {
    const r = spawnSync('node', [cli, ...c.argv], {
      cwd: projectDir,
      encoding: 'utf8',
    });
    const label = `caws ${c.argv.join(' ')} (${c.disposition})`;

    // 1. Exit code MUST be 1 — the refusal contract. Read from .status,
    //    never a shell pipe.
    if (r.status !== 1) {
      fail(`${label}: expected exit 1, got ${r.status}`, {
        exitCode: r.status,
        stdout: (r.stdout || '').trim().slice(0, 1000),
        stderr: (r.stderr || '').trim().slice(0, 1000),
        hint: 'Legacy commands must refuse with exit 1, never alias-execute or exit 0.',
      });
    }

    const combined = `${r.stdout || ''}\n${r.stderr || ''}`;

    // 2. Required typed guidance present.
    const missing = c.mustInclude.filter((s) => !combined.includes(s));
    if (missing.length > 0) {
      fail(`${label}: missing required diagnostic substring(s)`, {
        missing,
        output: combined.trim().slice(0, 1500),
      });
    }

    // 3. Forbidden substrings absent.
    const leaked = c.mustExclude.filter((s) => combined.includes(s));
    if (leaked.length > 0) {
      fail(`${label}: diagnostic contained forbidden substring(s)`, {
        leaked,
        output: combined.trim().slice(0, 1500),
      });
    }
  }

  ok(`installed binary refuses all ${cases.length} legacy/typo cases with exit 1 + typed guidance`);
}

// A14.13 — WORKTREE-REPAIR-INSTALLED-SMOKE-001: prove the PRUNE-REPAIR-
// WORKTREE-001 coupled CLI/kernel surface survives a real tarball install.
//
// The release footgun this guards: the CLI's `caws worktree repair` consumes
// kernel symbols added in the same train — DOCTOR_RULES.WORKTREE_EVENT_WITHOUT_
// CONTROL_PLANE_BINDING and the worktree_pruned / spec_binding_cleared event
// vocabulary. Source tests pass, but if the published CLI resolves a registry-
// STALE kernel that predates those symbols, `decideRepair`'s switch silently
// mis-classifies and the lifecycle event validation rejects the new events.
// This asserts the INSTALLED kernel (from the local tarball) actually carries
// them — the same class as the existing registerAgentSession symbol probe.
//
// All reads are from the installed package via require()/.status directly,
// never a shell pipe (a wrong exit cannot be masked).
function assertWorktreeRepairCoupledSurface(projectDir, installedRoot, installedKernel) {
  step('A14.13 — worktree repair CLI surface + coupled kernel event/rule are installed');
  const cli = join(installedRoot, 'dist', 'index.js');

  // A1: caws worktree repair --help exits 0 through the installed binary and
  // renders the repair description (proves the new CLI leaf is in the tarball).
  const help = spawnSync('node', [cli, 'worktree', 'repair', '--help'], {
    cwd: projectDir, encoding: 'utf8',
  });
  if (help.status !== 0) {
    fail('caws worktree repair --help exited non-zero on the installed binary', {
      exitCode: help.status,
      stdout: (help.stdout || '').trim().slice(0, 1000),
      stderr: (help.stderr || '').trim().slice(0, 1000),
      hint: 'the worktree repair leaf may be missing from the published dist',
    });
  }
  const helpOut = `${help.stdout || ''}`;
  // The leaf description names the half-state vocabulary. Assert a stable token
  // (not the whole string) so wording tweaks don't make this brittle.
  if (!/repair/i.test(helpOut) || !/(half-state|ghost|matrix)/i.test(helpOut)) {
    fail('caws worktree repair --help did not render the repair description', {
      stdout: helpOut.trim().slice(0, 1000),
      hint: 'expected the repair leaf help with half-state/ghost/matrix wording',
    });
  }
  ok('caws worktree repair --help renders on the installed binary (exit 0)');

  // A2 + A3: probe the INSTALLED kernel for the coupled rule + event vocabulary
  // and that validateEventBody enforces the new event schemas. Run as a single
  // node -e against the installed kernel so we test exactly what npm resolved.
  const probeSrc = `
    const k = require(${JSON.stringify(installedKernel)});
    const out = { steps: [] };
    // A2a: the doctor rule decideRepair consumes must exist and be a string.
    const rule = k.DOCTOR_RULES && k.DOCTOR_RULES.WORKTREE_EVENT_WITHOUT_CONTROL_PLANE_BINDING;
    out.rule = typeof rule === 'string' && rule.length > 0 ? rule : null;
    // A3: validateEventBody accepts well-formed repair events and rejects a bad h_class.
    // spec_binding_cleared is in the kernel's REQUIRES-spec-id class, so a
    // TOP-LEVEL spec_id is mandatory (the real clearSpecBinding writer sets it);
    // worktree_pruned takes spec_id as OPTIONAL (only when a binding was cleared).
    const base = (event, data, extra) => ({
      event, ts: '2026-06-15T00:00:00.000Z',
      actor: { kind: 'agent', id: 'smoke', session_id: 'smoke' },
      ...(extra || {}),
      data,
    });
    const pruned = k.validateEventBody(base('worktree_pruned', {
      worktree_name: 'wt-x', h_class: 'ghost_registry', reason: 'smoke',
    }));
    const cleared = k.validateEventBody(base('spec_binding_cleared', {
      spec_id: 'S-1', cleared_worktree_name: 'wt-x',
      h_class: 'ghost_spec_binding', reason: 'smoke',
    }, { spec_id: 'S-1' }));
    const badHClass = k.validateEventBody(base('worktree_pruned', {
      worktree_name: 'wt-x', h_class: 'not_a_real_class', reason: 'smoke',
    }));
    out.prunedOk = pruned && pruned.ok === true;
    out.clearedOk = cleared && cleared.ok === true;
    out.badRejected = badHClass && badHClass.ok === false;
    process.stdout.write(JSON.stringify(out));
  `;
  const probe = spawnSync('node', ['-e', probeSrc], { encoding: 'utf8' });
  if (probe.status !== 0) {
    fail('installed-kernel coupled-surface probe crashed', {
      exitCode: probe.status,
      stderr: (probe.stderr || '').trim().slice(0, 1000),
      hint: 'the installed kernel may predate the repair event vocabulary or validateEventBody export',
    });
  }
  let result;
  try {
    result = JSON.parse(probe.stdout);
  } catch {
    fail('installed-kernel probe did not emit JSON', { stdout: (probe.stdout || '').slice(0, 800) });
  }
  if (!result.rule) {
    fail('installed kernel is missing DOCTOR_RULES.WORKTREE_EVENT_WITHOUT_CONTROL_PLANE_BINDING', {
      installedKernel,
      hint: 'npm likely resolved a registry-stale kernel — check the cli tarball dependency range',
    });
  }
  if (!result.prunedOk || !result.clearedOk) {
    fail('installed kernel rejected a well-formed repair event', {
      prunedOk: result.prunedOk, clearedOk: result.clearedOk,
      hint: 'worktree_pruned / spec_binding_cleared schema missing from the published kernel',
    });
  }
  if (!result.badRejected) {
    fail('installed kernel ACCEPTED a worktree_pruned event with an out-of-enum h_class', {
      hint: 'the h_class enum / additionalProperties:false schema did not ship or is not enforced',
    });
  }
  ok(`installed kernel carries the repair rule (${result.rule}) and enforces both event schemas (bad h_class rejected)`);
}

function assertHeartbeatWorksWithoutJq(projectDir, installedRoot, shimDir, selfSessionId) {
  step('A14.11 — heartbeat hook composes envelope without jq on PATH');
  const pathNoJq = pathWithoutJq(shimDir);
  if (pathNoJq === null) {
    log(colors.yellow(
      '  [skip] jq present in /usr/bin or /bin — cannot construct an isolated PATH; ' +
      'skipping the negative assertion. The hook code does not invoke jq directly ' +
      '(verified by static grep in tests), so this skip is a test-environment ' +
      'limitation rather than evidence of a jq dependency.'
    ));
    return;
  }

  // Seed a peer so the heartbeat actually wants to emit an envelope.
  const peerId = 'caws-smoke-no-jq-peer';
  const cli = join(installedRoot, 'dist', 'index.js');
  const reg = spawnSync('node', [cli, 'agents', 'register',
    '--session-id', peerId, '--platform', 'claude-code', '--reason', 'manual_register',
  ], { cwd: projectDir, encoding: 'utf8' });
  if (reg.status !== 0) {
    fail('failed to seed no-jq peer', { stderr: reg.stderr.trim().slice(0, 500) });
  }

  const hookPath = join(projectDir, '.caws', 'hooks', 'agent-heartbeat.sh');
  // Sanity-check: jq is actually not reachable on this PATH.
  const jqCheck = spawnSync('bash', ['-c', 'command -v jq || echo NOT_FOUND'], {
    encoding: 'utf8', env: { PATH: pathNoJq },
  });
  if (!jqCheck.stdout.includes('NOT_FOUND')) {
    fail('jq is still reachable on stripped PATH (test setup bug)', {
      pathNoJq, jqCheck: jqCheck.stdout.trim(),
    });
  }

  const r = spawnSync('bash', [hookPath], {
    cwd: projectDir,
    encoding: 'utf8',
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: selfSessionId,
      tool_name: 'Bash',
      tool_input: { command: 'echo test' },
      cwd: projectDir,
    }),
    env: { PATH: pathNoJq, HOME: process.env.HOME || '/tmp' },
  });
  if (r.status !== 0) {
    fail('heartbeat hook exited non-zero without jq', {
      exitCode: r.status, stderr: r.stderr.trim().slice(0, 1500),
    });
  }
  if (!r.stdout.includes('hookSpecificOutput')) {
    fail('heartbeat hook produced no envelope without jq on PATH', {
      stdout: r.stdout.trim().slice(0, 2000),
      stderr: r.stderr.trim().slice(0, 2000),
      hint: 'envelope must be composed via node, not jq — visibility cannot depend on jq',
    });
  }
  if (!r.stdout.includes(peerId)) {
    fail('jq-absent envelope does not name the peer', { stdout: r.stdout.slice(0, 1000) });
  }
  ok('heartbeat hook composes envelope correctly with jq absent from PATH');
}

// ─── Codex hook-pack tarball smoke ───────────────────────────────────────

function assertCliTarballContainsCodexArtifacts(cliFiles) {
  step('Codex artifact proof — cli tarball file list');
  const paths = cliFiles.map((file) => file.path);
  const required = [
    'dist/init/hook-packs/manifest-codex.js',
    'dist/init/hook-packs/manifest-shared.js',
    'templates/hook-packs/codex/hooks.json',
    'templates/hook-packs/codex/hooks/lib/parse-input.sh',
    'templates/hook-packs/codex/hooks/lib/emit.sh',
    'templates/hook-packs/codex/hooks/lib/run-handlers.sh',
    'templates/hook-packs/shared/dispatch/pre_tool_use.sh',
    'templates/hook-packs/shared/protected-paths.sh',
  ];
  const missing = required.filter((path) => !paths.includes(path));
  if (missing.length > 0) {
    fail('cli tarball is missing Codex runtime artifacts', {
      missing: JSON.stringify(missing, null, 2),
      hint: 'package.json:files must include dist/** and templates/hook-packs/**',
    });
  }
  for (const path of required) {
    log(colors.dim(`  artifact tarball:${path}`));
  }
  ok(`cli tarball includes ${required.length} Codex adapter/shared-core artifacts`);
}

function collectCodexCommands(hooksJson) {
  const commands = [];
  const events = hooksJson?.hooks ?? {};
  for (const [eventName, entries] of Object.entries(events)) {
    for (const entry of entries ?? []) {
      for (const hook of entry.hooks ?? []) {
        if (hook?.type === 'command' && typeof hook.command === 'string') {
          commands.push({ eventName, command: hook.command });
        }
      }
    }
  }
  return commands;
}

function assertCodexHooksJson(projectDir) {
  step('Codex artifact proof — installed hooks.json');
  const hooksPath = join(projectDir, '.codex', 'hooks.json');
  if (!existsSync(hooksPath)) {
    fail('installed Codex hooks.json missing', { expected: hooksPath });
  }
  const raw = readFileSync(hooksPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail('installed Codex hooks.json is not valid JSON', {
      path: hooksPath,
      error: err.message,
    });
  }

  const topLevelKeys = Object.keys(parsed).sort();
  if (topLevelKeys.length !== 1 || topLevelKeys[0] !== 'hooks') {
    fail('installed Codex hooks.json contains unsupported top-level keys', {
      keys: topLevelKeys,
    });
  }

  const commands = collectCodexCommands(parsed);
  if (commands.length !== 5) {
    fail('installed Codex hooks.json should have one command dispatcher per event', {
      got: commands.length,
      commands: JSON.stringify(commands, null, 2),
    });
  }

  const placeholders = commands.filter(({ command }) => command.includes('__CAWS_CODEX_'));
  if (placeholders.length > 0) {
    fail('installed Codex hooks.json still contains unresolved placeholders', {
      placeholders: JSON.stringify(placeholders, null, 2),
    });
  }

  const eventToDispatcher = new Map([
    ['SessionStart', 'session_start.sh'],
    ['PreToolUse', 'pre_tool_use.sh'],
    ['PostToolUse', 'post_tool_use.sh'],
    ['PreCompact', 'pre_compact.sh'],
    ['Stop', 'stop.sh'],
  ]);
  const badCommands = commands.filter(({ eventName, command }) => {
    const dispatcher = eventToDispatcher.get(eventName);
    return (
      !dispatcher ||
      !command.includes('git rev-parse --show-toplevel') ||
      !command.includes('CAWS_AGENT_SURFACE=codex') ||
      !command.includes('CAWS_PROJECT_DIR="$REPO_ROOT"') ||
      !command.includes('CODEX_PROJECT_DIR="$REPO_ROOT"') ||
      !command.includes(`"$REPO_ROOT/.caws/hooks/dispatch/${dispatcher}"`) ||
      command.includes('.codex/hooks/caws_dispatch') ||
      command.includes(projectDir)
    );
  });
  if (badCommands.length > 0) {
    fail('installed Codex hook command does not use runtime-root shared-core dispatch', {
      projectDir,
      badCommands: JSON.stringify(badCommands, null, 2),
    });
  }

  for (const { eventName, command } of commands) {
    log(colors.dim(`  artifact hooks.json:${eventName}: ${command}`));
  }
  ok('installed hooks.json has Codex-valid schema and five runtime-root shared-core dispatcher commands');
}

function assertCodexProtectedPathDispatcher(projectDir) {
  step('Codex artifact proof — installed hooks.json command blocks protected hook edit');
  const hooksPath = join(projectDir, '.codex', 'hooks.json');
  const parsed = JSON.parse(readFileSync(hooksPath, 'utf8'));
  const preToolUse = collectCodexCommands(parsed).find(({ eventName }) => eventName === 'PreToolUse');
  if (!preToolUse) {
    fail('installed Codex hooks.json has no PreToolUse command', { hooksPath });
  }
  const payload = {
    session_id: 'caws-smoke-codex-protected',
    cwd: projectDir,
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: {
      command:
        '*** Begin Patch\n' +
        '*** Update File: .codex/hooks/lib/emit.sh\n' +
        '@@\n' +
        '-echo old\n' +
        '+echo new\n' +
        '*** End Patch\n',
    },
  };
  const subdir = join(projectDir, 'subdir');
  mkdirSync(subdir, { recursive: true });
  const result = spawnSync('bash', ['-lc', preToolUse.command], {
    cwd: subdir,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  log(colors.dim(`  artifact dispatcher_exit=${result.status}`));
  log(colors.dim(`  artifact dispatcher_stderr=${result.stderr.trim().slice(0, 500)}`));
  if (result.status !== 1) {
    fail('Codex PreToolUse dispatcher did not fail closed for a protected hook edit', {
      exitCode: result.status,
      stdout: result.stdout.trim().slice(0, 1000),
      stderr: result.stderr.trim().slice(0, 1000),
    });
  }
  if (!result.stderr.includes('.codex/hooks/lib/emit.sh is protected')) {
    fail('Codex protected-path dispatcher did not cite the protected hook path', {
      stderr: result.stderr.trim().slice(0, 1000),
    });
  }
  ok('installed Codex hooks.json command blocked a relative .codex/hooks edit with concrete protected-path evidence');
}

function runCodexTarballSmoke(tarballs) {
  step('Codex pack — install from local tarballs into a fresh project');
  assertCliTarballContainsCodexArtifacts(tarballs.cliFiles);
  const { projectDir, installedRoot } = installTarball(tarballs);
  const pack = loadManifest(installedRoot, 'codex');
  assertTemplateSourcesPresent(installedRoot, pack, 'codex');
  runInit(projectDir, installedRoot, 'codex');
  assertDestFilesPresent(projectDir, pack);
  assertCodexHooksJson(projectDir);
  assertCodexProtectedPathDispatcher(projectDir);
  ok(`Codex tarball smoke project: ${projectDir}`);
}

// ─── Main ───────────────────────────────────────────────────────────────

try {
  const startMs = Date.now();
  const packIds = enabledPackIds();
  log(colors.dim(`fresh-install-smoke for ${PACKAGE_NAME} (package root: ${PACKAGE_ROOT})`));
  log(colors.dim(`enabled hook packs: ${packIds.join(', ')}`));

  // A14.1-A14.3 — pack, install, init.
  const tarballs = packTarball();

  if (packIds.includes(PACK_ID)) {
    const { projectDir, installedRoot, installedKernel } = installTarball(tarballs);
    // CAWS-HOOK-PACK-SHARED-CORE-001: `caws init --agent-surface claude-code`
    // installs BOTH the shared pack (real hook logic, under .caws/hooks/) and
    // the thin claude-code vendor adapter (docs, under .claude/hooks/). The
    // smoke must verify BOTH manifests' template sources + materialized dest
    // files — the shared pack is where the oracle/agent/dispatcher hooks live.
    const pack = loadManifest(installedRoot);
    const sharedPack = loadManifest(installedRoot, 'shared');
    assertTemplateSourcesPresent(installedRoot, pack);
    assertTemplateSourcesPresent(installedRoot, sharedPack, 'shared');
    runInit(projectDir, installedRoot);
    assertDestFilesPresent(projectDir, pack);
    assertDestFilesPresent(projectDir, sharedPack);

    // FIX-HOOKPACK-CONSUMER-INSTALL-001 A1/A6 — the oracle must run in an ESM
    // consumer repo (the regression this slice fixes). Runs against the installed
    // shared pack (.caws/hooks/lib/), before the lease-substrate checks.
    assertOracleRunsUnderTypeModule(projectDir);

    // A14.4 — the shared pack carries the three agent-*.sh under .caws/hooks/.
    assertSharedAgentHooks(sharedPack);

    // A14.5-A14.8 — multi-agent lease substrate end-to-end through the
    // installed dispatchers.
    const shimDir = setupCliShim(installedRoot);
    const selfId = assertSessionStartCreatesLease(projectDir, shimDir);
    assertPreToolUseSilentAtN1(projectDir, shimDir, selfId);
    seedPeerLeaseAndAssertEnvelope(projectDir, installedRoot, shimDir, selfId);
    assertStopMarksLeaseStopped(projectDir, shimDir, selfId);

    // A14.9 — caws status renders Agents panel before Doctor.
    assertAgentsPanelRendersBeforeDoctor(projectDir, installedRoot);

    // A14.10 — installed CLI is hook-protocol-free.
    assertCliStaysHookProtocolFree(projectDir, installedRoot);

    // A14.11 — heartbeat hook works without jq on PATH.
    assertHeartbeatWorksWithoutJq(projectDir, installedRoot, shimDir, selfId);

    // A14.12 — installed binary refuses legacy v10.2 commands with exit 1 +
    // typed migration guidance (CAWS-V11-INSTALLED-ARTIFACT-SMOKE-EXTEND-001).
    assertLegacyCommandDiagnostics(projectDir, installedRoot);

    // A14.13 — worktree repair CLI surface + coupled kernel event/rule
    // vocabulary are present in the installed tarballs
    // (WORKTREE-REPAIR-INSTALLED-SMOKE-001).
    assertWorktreeRepairCoupledSurface(projectDir, installedRoot, installedKernel);
  }

  if (packIds.includes('codex')) {
    runCodexTarballSmoke(tarballs);
  }

  const elapsedMs = Date.now() - startMs;
  log(colors.green(`\n[fresh-install-smoke] PASS in ${elapsedMs}ms — requested hook-pack tarball smoke(s) proved installed runtime artifacts`));

  // Chain into the events-migration smoke (CAWS-MIGRATE-V10-EVENTS-001
  // A12). This script (fresh-install-smoke.mjs) is already wired into
  // prepublishOnly via packages/caws-cli/package.json:scripts, so
  // appending the events smoke here means a fresh publish runs both
  // smokes in sequence without touching the governed package.json.
  //
  // The events smoke packs BOTH kernel and CLI tarballs, installs them
  // into its own scratch project, and runs the full migrate → verify
  // lifecycle against the installed binary. Failure exits 1 with a
  // structured diagnostic; the prepublishOnly chain then halts the
  // publish.
  if (packIds.includes(PACK_ID)) {
    step('chain into events-migration-smoke (A12)');
    const eventsSmokePath = join(__dirname, 'events-migration-smoke.mjs');
    const eventsResult = spawnSync('node', [eventsSmokePath], {
      stdio: 'inherit',
    });
    if (eventsResult.status !== 0) {
      fail('events-migration-smoke failed', {
        exitCode: eventsResult.status,
        hint: 'See its output above for the specific assertion that failed.',
      });
    }
    log(colors.green(`\n[fresh-install-smoke] events-migration-smoke chained successfully`));
  }

  // Chain into specs-migration-smoke (CAWS-MIGRATE-V10-SPECS-001 A12).
  // Same chain pattern as the events smoke above: the smoke does its own
  // npm pack + install + run-from-binary; failure exits 1 and halts the
  // prepublishOnly chain. This certifies the migrator command and its
  // runtime dependencies are present in the published tarballs.
  if (packIds.includes(PACK_ID)) {
    step('chain into specs-migration-smoke (A12)');
    const specsSmokePath = join(__dirname, 'specs-migration-smoke.mjs');
    const specsResult = spawnSync('node', [specsSmokePath], {
      stdio: 'inherit',
    });
    if (specsResult.status !== 0) {
      fail('specs-migration-smoke failed', {
        exitCode: specsResult.status,
        hint: 'See its output above for the specific assertion that failed.',
      });
    }
    log(colors.green(`\n[fresh-install-smoke] specs-migration-smoke chained successfully`));
  }
  preserveCleanupPathsOnSuccess();
} catch (err) {
  fail('unexpected error', { message: err.message, stack: err.stack?.slice(0, 1000) });
}
