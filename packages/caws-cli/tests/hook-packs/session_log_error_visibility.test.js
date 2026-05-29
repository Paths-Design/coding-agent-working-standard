/**
 * @fileoverview SESSION-LOG-ERROR-VISIBILITY-001 — errored/blocked commands
 * are surfaced in the session-log handoff regardless of the keyword filter.
 *
 * The session-log renderer filters its `commands_of_interest` handoff and the
 * markdown `## Commands` list to a curated MEANINGFUL_COMMAND_KW allowlist
 * (git/caws/test/etc.) capped at the last 20. Before this fix, a command that
 * was NOT on the allowlist but ERRORED — e.g. a bare `git worktree list` that
 * tripped the danger latch, or an `ls` into a missing worktree dir — vanished
 * from the handoff entirely. A continuing agent then had to reconstruct the
 * failure from raw transcript JSONL.
 *
 * Fix: `command_is_of_interest()` returns true for allowlisted commands OR any
 * errored command. The handoff projection also now carries `is_error` and
 * `duration_s` so a continuing agent can see WHICH commands failed.
 *
 * Strategy: import the shipped template renderer via python3 and exercise the
 * predicate directly (it is a pure, side-effect-free module-level function).
 *
 * @author @darianrosebrook
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

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

/** Call command_is_of_interest(entry) in the shipped renderer; return bool. */
function isOfInterest(entry) {
  const py = [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("slr", ${JSON.stringify(RENDERER)})`,
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    'entry = json.loads(sys.argv[1])',
    'sys.stdout.write("1" if m.command_is_of_interest(entry) else "0")',
  ].join('\n');
  const r = spawnSync('python3', ['-c', py, JSON.stringify(entry)], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`renderer import/predicate failed: ${r.stderr}`);
  return r.stdout.trim() === '1';
}

describe('SESSION-LOG-ERROR-VISIBILITY-001 — command_is_of_interest', () => {
  const TABLE = [
    [{ command: 'git status' }, true, 'allowlisted git command'],
    [{ command: 'caws status' }, true, 'allowlisted caws command'],
    [{ command: 'pytest tests/' }, true, 'allowlisted test command'],
    [{ command: 'ls -la' }, false, 'non-allowlisted, no error → dropped (curation intact)'],
    [{ command: 'cat foo', is_error: false }, false, 'non-allowlisted, explicit no-error'],
    // The core fix: non-allowlisted BUT errored commands are surfaced.
    [{ command: 'ls /missing/worktree', is_error: true }, true, 'non-allowlisted errored → surfaced'],
    [{ command: 'git worktree list', is_error: true }, true, 'the latch-trip case → surfaced'],
    [{ command: 'some-random-tool --flag', is_error: true }, true, 'arbitrary errored tool → surfaced'],
    [{}, false, 'empty entry'],
  ];

  for (const [entry, want, note] of TABLE) {
    it(`${note}: ${JSON.stringify(entry)} → ${want}`, () => {
      expect(isOfInterest(entry)).toBe(want);
    });
  }

  it('curation is preserved: a non-erroring non-allowlisted command stays dropped', () => {
    // Guard against the over-correction of "surface everything" — the
    // allowlist+cap exists on purpose to keep handoffs small.
    expect(isOfInterest({ command: 'echo hello', is_error: false })).toBe(false);
  });
});
