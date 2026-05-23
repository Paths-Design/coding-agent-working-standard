/**
 * Negative invariant — proves the CAWS CLI is hook-protocol-agnostic
 * (MULTI-AGENT-ACTIVITY-REGISTRY-001, spec invariant 5).
 *
 * Acceptance bar:
 *   - `caws agents heartbeat --json --include-active-summary` emits
 *     CAWS-native JSON only. The output MUST NOT contain Claude Code's
 *     hook protocol strings: 'hookSpecificOutput', 'hookEventName',
 *     'permissionDecision', or 'additionalContext'.
 *
 *   - The Claude Code envelope is composed by agent-heartbeat.sh
 *     wrapping the CAWS JSON. Any future Cursor / terminal / Windsurf
 *     integration must be able to consume the same CAWS JSON and emit
 *     its own protocol-specific output.
 *
 *   - Changing Claude Code's hook envelope format MUST NOT require
 *     changing kernel lease logic, store lease writes, or any CLI
 *     command source. That boundary is what makes the substrate
 *     reusable across agent surfaces.
 *
 * The test asserts the runtime invariant on actual stdout from the
 * built CLI (the runtime artifact). A companion source-tree grep
 * is intentionally NOT included here — the runtime artifact is the
 * authoritative surface; doctrine doc-comments referencing the
 * envelope name (e.g., "the CLI never emits hookSpecificOutput") are
 * a feature, not a leak. See commit 5 preflight notes.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('node:child_process');

const {
  runAgentsHeartbeatCommand,
  runAgentsRegisterCommand,
} = require('../../dist/shell');

function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-cli-no-envelope-'));
  execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, '.gitignore'), '');
  execFileSync('git', ['-C', dir, 'add', '.gitignore'], { stdio: 'ignore' });
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'],
    { stdio: 'ignore' }
  );
  fs.mkdirSync(path.join(dir, '.caws'));
  return dir;
}

function capture(fn) {
  const out = [];
  const err = [];
  const NOW = new Date('2026-05-23T10:00:00.000Z');
  const code = fn({
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    now: () => NOW,
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

const FORBIDDEN_TOKENS = [
  'hookSpecificOutput',
  'hookEventName',
  'permissionDecision',
  'additionalContext',
];

describe('caws agents — CLI never emits Claude Code hook envelope', () => {
  let repo;
  afterEach(() => repo && fs.rmSync(repo, { recursive: true, force: true }));

  it('heartbeat --json --include-active-summary stdout contains no protocol tokens (N=1, throttled and unthrottled)', () => {
    repo = mkRepo();
    // Register a self lease so the heartbeat has something to update.
    capture((io) =>
      runAgentsRegisterCommand({
        ...io,
        cwd: repo,
        sessionId: 'caws-no-envelope-self',
        platform: 'claude-code',
        json: true,
      })
    );

    const r = capture((io) =>
      runAgentsHeartbeatCommand({
        ...io,
        cwd: repo,
        sessionId: 'caws-no-envelope-self',
        platform: 'claude-code',
        json: true,
        includeActiveSummary: true,
        reason: 'pre_tool_use',
      })
    );
    expect(r.code).toBe(0);

    for (const token of FORBIDDEN_TOKENS) {
      expect(r.stdout).not.toContain(token);
      expect(r.stderr).not.toContain(token);
    }

    // It MUST be valid CAWS-native JSON.
    const payload = JSON.parse(r.stdout);
    expect(payload.session_id).toBe('caws-no-envelope-self');
    expect(typeof payload.active_agent_count).toBe('number');
    expect(Array.isArray(payload.active_agents)).toBe(true);
  });

  it('heartbeat --json --include-active-summary stdout contains no protocol tokens (N>1, peer present)', () => {
    repo = mkRepo();
    capture((io) =>
      runAgentsRegisterCommand({
        ...io,
        cwd: repo,
        sessionId: 'caws-no-envelope-peer',
        platform: 'claude-code',
        json: true,
      })
    );
    capture((io) =>
      runAgentsRegisterCommand({
        ...io,
        cwd: repo,
        sessionId: 'caws-no-envelope-self',
        platform: 'claude-code',
        json: true,
      })
    );

    const r = capture((io) =>
      runAgentsHeartbeatCommand({
        ...io,
        cwd: repo,
        sessionId: 'caws-no-envelope-self',
        platform: 'claude-code',
        json: true,
        includeActiveSummary: true,
        reason: 'pre_tool_use',
      })
    );
    expect(r.code).toBe(0);

    for (const token of FORBIDDEN_TOKENS) {
      expect(r.stdout).not.toContain(token);
      expect(r.stderr).not.toContain(token);
    }

    const payload = JSON.parse(r.stdout);
    expect(payload.active_agent_count).toBe(2);
    // Self and peer both present in active_agents.
    const sessionIds = payload.active_agents.map((a) => a.session_id).sort();
    expect(sessionIds).toEqual(['caws-no-envelope-peer', 'caws-no-envelope-self']);
  });

  it('register --json --include-active-summary stdout contains no protocol tokens', () => {
    repo = mkRepo();
    const r = capture((io) =>
      runAgentsRegisterCommand({
        ...io,
        cwd: repo,
        sessionId: 'caws-no-envelope-reg',
        platform: 'claude-code',
        json: true,
        includeActiveSummary: true,
      })
    );
    expect(r.code).toBe(0);
    for (const token of FORBIDDEN_TOKENS) {
      expect(r.stdout).not.toContain(token);
      expect(r.stderr).not.toContain(token);
    }
  });
});
