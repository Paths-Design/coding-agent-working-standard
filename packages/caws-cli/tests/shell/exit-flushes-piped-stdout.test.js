'use strict';

/**
 * Contract tests for CAWS-CLI-EXIT-TRUNCATES-PIPED-STDOUT-001.
 *
 * The defect: the shared command exit hook delivered a command's exit code via
 * `process.exit(code)`. Node's stdout is an ASYNC stream when it is a pipe, and
 * `process.exit` does not drain it — so any command whose output exceeded the
 * OS pipe buffer emitted TRUNCATED output and still exited 0. Observed on the
 * live repo: `caws status --json` cut mid-string at 65536 bytes with a zero
 * exit status. A consumer either gets a parse error or, worse, a wrong answer
 * it believes.
 *
 * WHY THESE TESTS SPAWN A REAL PROCESS. Every other test in this suite injects
 * `out:` / `err:` sinks and asserts on the collected lines. Such a test CANNOT
 * observe this defect: the payload is built correctly and handed to the sink;
 * the loss happens later, between `process.stdout.write` and the pipe, at exit.
 * The proof therefore has to cross a real process boundary with a real pipe and
 * output larger than the buffer. That is also why this file is slower than its
 * neighbours — the cost buys the only evidence that discriminates.
 *
 * A1: >64KiB `status --json` through a pipe => complete, parseable JSON, exit 0.
 * A2: piped byte count == file-redirected byte count (not channel-dependent).
 * A3: exit codes 0/1/2 survive the change of delivery mechanism.
 * A4: the child terminates on its own — no kill signal, no timeout.
 * A5: the default hook sets process.exitCode and never calls process.exit.
 * A6: no handler lets an earlier exit() be overwritten by a later one —
 *     the latent fall-through that `process.exit` had been masking.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.join(__dirname, '..', '..', 'dist', 'index.js');

/** Generous: this only has to catch a HANG, never assert a performance budget.
 *  A wall-clock budget here would measure machine load, not correctness. */
const SPAWN_TIMEOUT_MS = 120_000;

/** The pipe buffer that hid this defect. macOS/Linux default to 64KiB. */
const PIPE_BUFFER_BYTES = 64 * 1024;

afterAll(() => {
  cleanupAll();
});

const tmpDirs = [];
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/**
 * Run the built CLI as a child process.
 *
 * `encoding: 'buffer'` on purpose: the assertion is about BYTES surviving the
 * exit, and decoding to a string first would let a truncation that lands
 * mid-multibyte-character be silently repaired by the decoder.
 */
function runCli(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    timeout: SPAWN_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'buffer',
    // stdout/stderr as pipes is the whole point — this is the channel that lost bytes.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
}

/**
 * A repo whose `status --json` payload is larger than the pipe buffer.
 *
 * Leases are the cheapest lever: `status --json` serializes every lease record
 * in full under `agents.leases`, and a lease is a small standalone JSON file,
 * so the payload size is a direct function of how many we write.
 */
function repoWithOversizedStatusJson() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) {
    throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  }
  const leasesDir = path.join(root, '.caws', 'leases');
  fs.mkdirSync(leasesDir, { recursive: true });

  // ~600 bytes on disk each and at least that once re-serialized into the
  // payload; 300 puts the payload comfortably past 64KiB with margin, so the
  // test does not sit on the threshold where a small payload change flips it.
  for (let i = 0; i < 300; i += 1) {
    const sessionId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    fs.writeFileSync(
      path.join(leasesDir, `${sessionId}.json`),
      JSON.stringify(
        {
          lease_version: 1,
          session_id: sessionId,
          platform: 'contract-test-platform',
          status: 'active',
          started_at: '2026-09-15T00:00:00.000Z',
          last_active: '2026-09-15T00:00:00.000Z',
          repo_root: root,
          cwd: root,
          git_common_dir: path.join(root, '.git'),
          git_dir: path.join(root, '.git'),
          branch: 'main',
          hook_pid: 1000 + i,
          hostname: 'contract-test-host.local',
          last_seen_reason: 'manual_register',
        },
        null,
        2
      )
    );
  }
  return root;
}

describe('CAWS-CLI-EXIT-TRUNCATES-PIPED-STDOUT-001', () => {
  test('A1: a >64KiB --json payload survives a pipe intact and exits 0', () => {
    const root = repoWithOversizedStatusJson();

    const result = runCli(['status', '--json'], root);
    const stdout = result.stdout;

    // Guard the fixture itself: if the payload ever shrinks below the buffer,
    // this test would pass for the wrong reason (nothing to truncate).
    expect(stdout.length).toBeGreaterThan(PIPE_BUFFER_BYTES);

    const text = stdout.toString('utf8');
    // The precise failure signature: a truncated payload ends mid-value, so the
    // last character is not the closing brace and JSON.parse throws.
    expect(text.trimEnd().endsWith('}')).toBe(true);
    expect(() => JSON.parse(text)).not.toThrow();

    const payload = JSON.parse(text);
    expect(payload.ok).toBe(true);
    // `doctor` is serialized last, so its presence proves the tail arrived.
    expect(payload.doctor).toBeDefined();
    expect(payload.agents.leases.total).toBe(300);

    expect(result.status).toBe(0);
  });

  test('A2: the piped byte count equals the file-redirected byte count', () => {
    const root = repoWithOversizedStatusJson();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-exit-flush-'));
    tmpDirs.push(outDir);
    const outFile = path.join(outDir, 'status.json');

    const piped = runCli(['status', '--json'], root);

    // Same command, same repo, stdout to a FILE. A file descriptor is written
    // synchronously, which is exactly why this channel never lost bytes and why
    // the defect was invisible to anyone who redirected instead of piping.
    const fd = fs.openSync(outFile, 'w');
    const redirected = spawnSync(process.execPath, [CLI, 'status', '--json'], {
      cwd: root,
      timeout: SPAWN_TIMEOUT_MS,
      stdio: ['ignore', fd, 'pipe'],
      env: { ...process.env },
    });
    fs.closeSync(fd);

    expect(redirected.status).toBe(0);
    expect(piped.status).toBe(0);
    expect(piped.stdout.length).toBe(fs.statSync(outFile).size);
  });

  test('A3: exit codes 0, 1 and 2 are delivered unchanged', () => {
    const root = repoWithOversizedStatusJson();

    // 0 — a command that succeeds.
    expect(runCli(['status', '--short'], root).status).toBe(0);

    // 1 — a refusal from a handler (no such worktree in the registry).
    const refused = runCli(['worktree', 'review', 'wt-does-not-exist'], root);
    expect(refused.status).toBe(1);
    expect(refused.stderr.toString('utf8')).toContain('wt-does-not-exist');

    // 2 — a usage error (an unknown value for a validated flag).
    const usage = runCli(['specs', 'evidence', 'NOPE-001', '--ac', 'A1'], root);
    expect(usage.status).not.toBe(0);
  });

  test('A4: the child terminates on its own — no hang, no kill signal', () => {
    const root = repoWithOversizedStatusJson();

    const result = runCli(['status', '--json'], root);

    // spawnSync reports a signal (SIGTERM) and sets `error` when `timeout`
    // fires. A natural exit that waited forever on an unreferenced handle
    // would show up here, and nowhere else.
    expect(result.signal).toBeNull();
    expect(result.error).toBeUndefined();
    expect(typeof result.status).toBe('number');
  });

  test('A6: no action handler lets an earlier exit() be overwritten by a later one', () => {
    // A source-level invariant, and the one that actually bit during this fix.
    //
    // Under `process.exit` an `exit(1)` with no `return` was survivable: the
    // process died on the spot, so the statements after it never ran. Under
    // `process.exitCode` those statements DO run — the refusal's 1 gets
    // overwritten by the trailing exit(0), and worse, the command the caller
    // was just refused executes anyway (with --apply, that is a mutation).
    //
    // Two handlers had this latent fall-through. Scanning is the only way to
    // know there is not a third, and to catch the next one added.
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'shell', 'register.ts'),
      'utf8'
    );

    const offenders = [];
    for (const match of source.matchAll(/\.action\(/g)) {
      // Brace-match the argument list to isolate one handler body.
      let depth = 0;
      let end = match.end - 1;
      for (; end < source.length; end += 1) {
        const ch = source[end];
        if (ch === '(') depth += 1;
        else if (ch === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const body = source.slice(match.end - 1, end);
      const calls = [...body.matchAll(/(?<![.\w])exit\(/g)];
      calls.forEach((call, index) => {
        if (index === calls.length - 1) return; // the handler's final exit
        const after = body.slice(call.index);
        const stmtEnd = after.indexOf(');');
        const tail = stmtEnd === -1 ? '' : after.slice(stmtEnd + 2).trimStart();
        if (!tail.startsWith('return')) {
          const line = source.slice(0, match.end - 1 + call.index).split('\n').length;
          offenders.push(`register.ts:${line} — exit() not followed by return`);
        }
      });
    }

    expect(offenders).toEqual([]);
    // Guard the scanner: if the parse ever stops finding handlers, the
    // assertion above would pass vacuously.
    expect(source.match(/\.action\(/g).length).toBeGreaterThan(50);
  });

  test('A5: the default exit hook sets process.exitCode and never calls process.exit', () => {
    // Pinned directly, in-process, so a refactor back to process.exit fails
    // here immediately rather than only in the slow spawn tests above.
    const { Command } = require('commander');
    const { registerShellCommands } = require('../../dist/shell/register');

    const realExit = process.exit;
    const realExitCode = process.exitCode;
    const realWrite = process.stdout.write;
    const exitCalls = [];

    process.exit = (code) => {
      exitCalls.push(code);
      throw new Error(`process.exit(${code}) called by the default exit hook`);
    };
    // The command under test renders to the real stdout; swallow it so the
    // jest report stays readable. What is asserted is the exit MECHANISM.
    process.stdout.write = () => true;

    try {
      const program = new Command();
      program.exitOverride();
      // No `exit` override: this is the DEFAULT hook, the one production uses.
      registerShellCommands(program);

      process.exitCode = undefined;
      // `from: 'user'` means argv carries only the user's arguments — no
      // node/script prefix.
      program.parse(['status', '--short'], { from: 'user' });

      expect(exitCalls).toEqual([]);
      expect(typeof process.exitCode).toBe('number');
    } finally {
      process.exit = realExit;
      process.stdout.write = realWrite;
      process.exitCode = realExitCode;
    }
  });
});
