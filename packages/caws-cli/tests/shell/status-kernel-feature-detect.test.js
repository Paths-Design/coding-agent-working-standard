/**
 * CAWS-STATUS-AGENTS-SUMMARIZE-ACTIVE-AGENTS-01 regression tests.
 *
 * Asserts that runStatusCommand and runAgentsListCommand do NOT throw
 * a Node "is not a function" error when the kernel does not export
 * `summarizeActiveAgents` — the symptom of Bug-001/002 from
 * USER-E2E-SETUP-REHEARSAL-001.
 *
 * Strategy:
 *   The kernel import in @paths.design/caws-kernel is overridden via
 *   `jest.doMock` BEFORE the shell layer is required. The mock
 *   exposes every kernel symbol the shell layer needs EXCEPT
 *   `summarizeActiveAgents`, which is explicitly omitted to simulate
 *   the pre-1.1.0 kernel pairing.
 *
 *   The CLI's defensive guard (callSummarizeActiveAgentsSafe in
 *   status.ts and agents.ts) MUST detect the missing symbol and
 *   route to a typed empty ActivitySummary + a stderr diagnostic,
 *   never to a runtime crash.
 *
 * Evidence captured by this suite:
 *   - actual stderr text (asserts the documented diagnostic appears)
 *   - exit codes (asserts status/agents-list don't crash)
 *   - that the rest of the command output renders (status panel /
 *     agents-list empty rendering) instead of being truncated mid-flight
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Build a temp git repo + .caws/ state that's just enough for status
 * and agents list to render. Returns { repoRoot, cawsDir }.
 */
function setupRepo(prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(root, 'README.md'), '# test\n');
  execFileSync('git', ['-C', root, 'add', 'README.md']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'init']);

  const cawsDir = path.join(root, '.caws');
  fs.mkdirSync(cawsDir);
  fs.mkdirSync(path.join(cawsDir, 'specs'));
  fs.mkdirSync(path.join(cawsDir, 'waivers'));
  // Minimal policy.yaml so loadPolicy doesn't error.
  fs.writeFileSync(
    path.join(cawsDir, 'policy.yaml'),
    "schema_version: 1\ngates:\n  coverage_threshold:\n    mode: warn\n"
  );
  fs.writeFileSync(path.join(cawsDir, 'worktrees.json'), '{}\n');
  fs.writeFileSync(path.join(cawsDir, 'agents.json'), '{}\n');
  return { repoRoot: root, cawsDir };
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Load the shell layer with @paths.design/caws-kernel overridden to
 * a copy that LACKS summarizeActiveAgents. Returns the live shell
 * module exports so callers can invoke runStatusCommand /
 * runAgentsListCommand against the broken-kernel scenario.
 *
 * Uses jest.isolateModulesAsync (modern) or jest.isolateModules
 * (sync) so each test gets a fresh module cache.
 */
function loadShellWithBrokenKernel() {
  let shell;
  jest.isolateModules(() => {
    // Resolve the real kernel module first to inherit its non-target
    // exports (so the rest of the CLI still works). The kernel sits at
    // packages/caws-kernel/dist/index.js relative to this file:
    //   tests/shell/<file>.js -> packages/caws-cli/tests/shell -> packages/caws-cli -> packages
    //   -> packages/caws-kernel/dist/index.js
    const kernelDistPath = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'caws-kernel',
      'dist',
      'index.js'
    );
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const realKernel = require(kernelDistPath);
    const brokenKernel = { ...realKernel };
    // Strip the symbol the guard checks for.
    brokenKernel.summarizeActiveAgents = undefined;

    jest.doMock('@paths.design/caws-kernel', () => brokenKernel);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    shell = require('../../dist/shell');
  });
  return shell;
}

function captureRun(fn, opts) {
  const out = [];
  const err = [];
  const code = fn({
    ...opts,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

describe('CAWS-STATUS-AGENTS-SUMMARIZE-ACTIVE-AGENTS-01 — kernel feature-detect', () => {
  let repoRoot;
  let cawsDir;

  beforeEach(() => {
    ({ repoRoot, cawsDir } = setupRepo('caws-status-fd-'));
  });

  afterEach(() => {
    rmrf(repoRoot);
    jest.resetModules();
  });

  test('A1: runStatusCommand does NOT throw when kernel lacks summarizeActiveAgents', () => {
    const shell = loadShellWithBrokenKernel();
    const result = captureRun(shell.runStatusCommand, {
      cwd: repoRoot,
    });
    // Print concrete runtime artifacts so the test output itself
    // shows what the guard produced (runtime-artifact discipline).
    // Visible when jest runs with --verbose or when test output is
    // streamed.
    // eslint-disable-next-line no-console
    console.log('[A1 ARTIFACT] runStatusCommand exit code:', result.code);
    // eslint-disable-next-line no-console
    console.log('[A1 ARTIFACT] runStatusCommand stderr (first 500 chars):');
    // eslint-disable-next-line no-console
    console.log(result.stderr.slice(0, 500));
    // eslint-disable-next-line no-console
    console.log('[A1 ARTIFACT] runStatusCommand stdout (first 300 chars):');
    // eslint-disable-next-line no-console
    console.log(result.stdout.slice(0, 300));

    // Must not have crashed — exit code is a number (status returns
    // 0 on success, 1 on findings, 2 on composition failure; any of
    // these is acceptable here — we're asserting on non-crash, not on
    // a specific value).
    expect(typeof result.code).toBe('number');
    // The defensive guard's typed diagnostic surfaced on stderr.
    expect(result.stderr).toMatch(
      /kernel does not export summarizeActiveAgents/
    );
    // The diagnostic names the recovery path.
    expect(result.stderr).toMatch(/npm install -g @paths\.design\/caws-cli@latest/);
    // The rest of the status panel still rendered (not truncated
    // mid-flight by an exception): stdout is non-empty.
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  test('A2: runAgentsListCommand does NOT throw when kernel lacks summarizeActiveAgents', () => {
    const shell = loadShellWithBrokenKernel();
    const result = captureRun(shell.runAgentsListCommand, {
      cwd: repoRoot,
    });
    // eslint-disable-next-line no-console
    console.log('[A2 ARTIFACT] runAgentsListCommand exit code:', result.code);
    // eslint-disable-next-line no-console
    console.log('[A2 ARTIFACT] runAgentsListCommand stderr:');
    // eslint-disable-next-line no-console
    console.log(result.stderr);
    // eslint-disable-next-line no-console
    console.log('[A2 ARTIFACT] runAgentsListCommand stdout:');
    // eslint-disable-next-line no-console
    console.log(result.stdout || '(empty stdout)');

    expect(typeof result.code).toBe('number');
    expect(result.stderr).toMatch(
      /kernel does not export summarizeActiveAgents/
    );
    expect(result.stderr).toMatch(/npm install -g @paths\.design\/caws-cli@latest/);
    // Empty-list rendering should still succeed; no agents -> empty
    // output or "no agents" line. Either is acceptable, but stdout
    // MUST be a string (not undefined from a crash).
    expect(typeof result.stdout).toBe('string');
  });

  test('A3: runAgentsListCommand --json does NOT throw when kernel lacks summarizeActiveAgents', () => {
    const shell = loadShellWithBrokenKernel();
    const result = captureRun(shell.runAgentsListCommand, {
      cwd: repoRoot,
      json: true,
    });
    // eslint-disable-next-line no-console
    console.log('[A3 ARTIFACT] --json exit code:', result.code);
    // eslint-disable-next-line no-console
    console.log('[A3 ARTIFACT] --json stderr:');
    // eslint-disable-next-line no-console
    console.log(result.stderr);
    // eslint-disable-next-line no-console
    console.log('[A3 ARTIFACT] --json stdout:');
    // eslint-disable-next-line no-console
    console.log(result.stdout || '(empty)');

    expect(typeof result.code).toBe('number');
    expect(result.stderr).toMatch(
      /kernel does not export summarizeActiveAgents/
    );
    // JSON output is still emitted; the fallback empty summary
    // produces a parseable JSON document.
    if (result.stdout.length > 0) {
      // Find the first { ... } block in stdout and parse it.
      const jsonStart = result.stdout.indexOf('{');
      if (jsonStart >= 0) {
        const parsed = JSON.parse(result.stdout.slice(jsonStart));
        // eslint-disable-next-line no-console
        console.log('[A3 ARTIFACT] parsed JSON:', JSON.stringify(parsed, null, 2));
        expect(parsed).toHaveProperty('ok', true);
        // counts.active should be 0 in the fallback.
        if (parsed.counts) {
          expect(parsed.counts.active).toBe(0);
        }
      }
    }
  });

  test('A4: negative invariant — the exact rehearsal-symptom string never appears', () => {
    // Bug-001/002's actual crash signature:
    //   (0 , caws_kernel_1.summarizeActiveAgents) is not a function
    // It is a Node TypeError message. If the guard ever stops working
    // and the symptom reappears, the test must catch it. Use a
    // try/catch around the call — Node will throw, capture the
    // message, and FAIL the test with a specific assertion.
    const shell = loadShellWithBrokenKernel();
    let captured = null;
    try {
      const result = captureRun(shell.runStatusCommand, { cwd: repoRoot });
      captured = result;
    } catch (e) {
      // If we reach here, the guard FAILED — the kernel-missing
      // case re-introduced the crash.
      throw new Error(
        `Bug-001/002 regression: runStatusCommand threw instead of guarding. ` +
          `Original error: ${e.message}`
      );
    }
    expect(captured).not.toBeNull();
    // The exact Node crash text must NOT appear anywhere in stdout/stderr.
    const combined = captured.stdout + '\n' + captured.stderr;
    expect(combined).not.toMatch(
      /caws_kernel_\d+\.summarizeActiveAgents.*is not a function/
    );
    expect(combined).not.toMatch(
      /TypeError.*summarizeActiveAgents/
    );
  });
});
