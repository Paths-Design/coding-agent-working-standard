/**
 * @fileoverview SESSION-LOG-ERROR-VISIBILITY-001 — errored/blocked commands
 * remain visible for a continuing agent.
 *
 * Original fix: the renderer's HANDOFF projection (commands_of_interest) and
 * the session.txt `## Commands` list filtered to a MEANINGFUL_COMMAND_KW
 * allowlist; an errored-but-non-allowlisted command (a latch-tripping
 * `git worktree list`, an `ls` into a missing dir) vanished. The
 * `command_is_of_interest` predicate was widened to surface any errored
 * command in those aggregate views.
 *
 * HOOK-SESSION-LOG-RENDER-CLEANUP-001 removed the aggregate views
 * (session.json / handoff.json / session.txt) as write-only duplication — so
 * the predicate and its keyword-curation no longer exist. The error-visibility
 * INVARIANT is preserved on the surviving surface: every command the agent ran
 * (allowlisted or not, errored or not) is recorded verbatim in its turn's
 * `commands` list, each carrying `is_error` and (when known) `duration_s` and
 * `output_preview`. A continuing agent reads the turn file directly — strictly
 * MORE visibility than the curated handoff, with nothing dropped.
 *
 * Strategy: import the shipped renderer via python3, feed a synthetic turn
 * through build_turn_payload, and assert every command (especially the errored
 * non-allowlisted ones) is present with its is_error flag.
 *
 * @author @darianrosebrook
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { classifyTimeoutMs } = require('./lib/classify-timeout');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const RENDERER = path.join(
  REPO_ROOT,
  'packages',
  'caws-cli',
  'templates',
  'hook-packs',
  'claude-code',
  'session_log_renderer.py'
);

/**
 * Build a turn payload from a list of command entries via the shipped
 * renderer's build_turn_payload, and return its `commands` array.
 */
function turnCommands(commands) {
  const py = [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("slr", ${JSON.stringify(RENDERER)})`,
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    'turn = m.new_turn("do some work", "2026-01-01T00:00:00Z")',
    'turn["commands"] = json.loads(sys.argv[1])',
    'payload = m.build_turn_payload(turn, 1)',
    'sys.stdout.write(json.dumps((payload.get("refs") or {}).get("commands") or []))',
  ].join('\n');
  const r = spawnSync('python3', ['-c', py, JSON.stringify(commands)], {
    encoding: 'utf8',
    timeout: classifyTimeoutMs(),
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`renderer build_turn_payload failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

describe('SESSION-LOG-ERROR-VISIBILITY-001 — errored commands survive in the turn payload', () => {
  const INPUT = [
    { command: 'git status', is_error: false },
    { command: 'ls -la', is_error: false },
    { command: 'ls /missing/worktree', is_error: true },
    { command: 'git worktree list', is_error: true },
    { command: 'some-random-tool --flag', is_error: true, duration_s: 0.4 },
  ];

  let commands;
  beforeAll(() => {
    commands = turnCommands(INPUT);
  });

  it('records EVERY command verbatim (no allowlist curation, nothing dropped)', () => {
    const got = commands.map((c) => c.command).sort();
    expect(got).toEqual(INPUT.map((c) => c.command).sort());
  });

  it('the errored non-allowlisted commands are present and carry is_error=true', () => {
    for (const cmd of ['ls /missing/worktree', 'git worktree list', 'some-random-tool --flag']) {
      const entry = commands.find((c) => c.command === cmd);
      expect(entry).toBeDefined();
      expect(entry.is_error).toBe(true);
    }
  });

  it('non-errored commands keep is_error=false (the flag is faithful, not forced)', () => {
    const ok = commands.find((c) => c.command === 'git status');
    expect(ok).toBeDefined();
    expect(ok.is_error).toBe(false);
  });

  it('duration_s is preserved when present', () => {
    const timed = commands.find((c) => c.command === 'some-random-tool --flag');
    expect(timed.duration_s).toBe(0.4);
  });
});
