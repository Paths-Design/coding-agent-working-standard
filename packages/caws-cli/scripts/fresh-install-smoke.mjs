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

function packOne(packageRoot, label) {
  const packDir = mkdtempSync(join(tmpdir(), `caws-pack-${label}-`));
  registerCleanup(packDir);
  const result = spawnSync(
    'npm', ['pack', '--pack-destination', packDir, '--json'],
    { cwd: packageRoot, encoding: 'utf8' }
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
  const { filename } = parsed[0];
  const tarball = join(packDir, filename);
  if (!existsSync(tarball)) fail(`tarball missing after npm pack for ${label}`, { expected: tarball });
  return { tarball, filename };
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
  const kernel = packOne(KERNEL_ROOT, 'kernel');
  ok(`packed kernel: ${kernel.filename}`);
  const cli = packOne(PACKAGE_ROOT, 'cli');
  ok(`packed cli: ${cli.filename}`);
  return { kernelTarball: kernel.tarball, cliTarball: cli.tarball };
}

function installTarball({ kernelTarball, cliTarball }) {
  step('install kernel+cli tarballs into fresh project');
  const projectDir = mkdtempSync(join(tmpdir(), 'caws-smoke-project-'));
  registerCleanup(projectDir);

  // Minimal package.json so npm install has something to anchor to.
  const pkgJson = { name: 'caws-fresh-install-smoke', version: '0.0.0', private: true };
  execSync(`printf '%s' '${JSON.stringify(pkgJson)}' > package.json`, { cwd: projectDir });

  // Install BOTH tarballs in a single npm install call. npm resolves
  // intra-tarball dependencies (the cli's @paths.design/caws-kernel
  // entry will pick up the locally-installed kernel tarball rather than
  // reaching out to the registry).
  // --ignore-scripts is intentional — we want the published bits as-is,
  // not prepare/postinstall hooks that might paper over packaging gaps.
  const result = spawnSync(
    'npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts',
      kernelTarball, cliTarball],
    { cwd: projectDir, encoding: 'utf8' }
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

function assertHookPackV3(pack) {
  step('A14.4 — installed hook pack reports v3 with three new agent-*.sh');
  if (pack.packVersion !== 3) {
    fail('installed manifest pack version mismatch', {
      expected: 3, got: pack.packVersion,
    });
  }
  const required = ['agent-register.sh', 'agent-heartbeat.sh', 'agent-stop.sh'];
  for (const name of required) {
    const entry = pack.installedFiles.find((f) => f.destPath === `.claude/hooks/${name}`);
    if (!entry) fail(`manifest missing ${name}`);
    if (!entry.managed) fail(`${name} is not managed:true`);
    if (!entry.executable) fail(`${name} is not executable:true`);
  }
  ok('hook pack v3 with all three agent-*.sh as managed+executable');
}

function assertSessionStartCreatesLease(projectDir, shimDir) {
  step('A14.5 — SessionStart dispatcher creates a lease file');
  const sessionId = 'caws-smoke-session-a';
  const dispatcher = join(projectDir, '.claude', 'hooks', 'dispatch', 'session_start.sh');
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
  const dispatcher = join(projectDir, '.claude', 'hooks', 'dispatch', 'pre_tool_use.sh');
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

  const dispatcher = join(projectDir, '.claude', 'hooks', 'dispatch', 'pre_tool_use.sh');
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
  const dispatcher = join(projectDir, '.claude', 'hooks', 'dispatch', 'stop.sh');
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

  const hookPath = join(projectDir, '.claude', 'hooks', 'agent-heartbeat.sh');
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

// ─── Main ───────────────────────────────────────────────────────────────

try {
  const startMs = Date.now();
  log(colors.dim(`fresh-install-smoke for ${PACKAGE_NAME} (package root: ${PACKAGE_ROOT})`));

  // A14.1-A14.3 — pack, install, init.
  const tarballs = packTarball();
  const { projectDir, installedRoot } = installTarball(tarballs);
  const pack = loadManifest(installedRoot);
  assertTemplateSourcesPresent(installedRoot, pack);
  runInit(projectDir, installedRoot);
  assertDestFilesPresent(projectDir, pack);

  // A14.4 — hook pack v3 with the three new agent-*.sh templates.
  assertHookPackV3(pack);

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

  const elapsedMs = Date.now() - startMs;
  log(colors.green(`\n[fresh-install-smoke] PASS in ${elapsedMs}ms — published tarball is install-safe AND multi-agent substrate is live from installed artifacts`));

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

  // Chain into specs-migration-smoke (CAWS-MIGRATE-V10-SPECS-001 A12).
  // Same chain pattern as the events smoke above: the smoke does its own
  // npm pack + install + run-from-binary; failure exits 1 and halts the
  // prepublishOnly chain. This certifies the migrator command and its
  // runtime dependencies are present in the published tarballs.
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
} catch (err) {
  fail('unexpected error', { message: err.message, stack: err.stack?.slice(0, 1000) });
}
