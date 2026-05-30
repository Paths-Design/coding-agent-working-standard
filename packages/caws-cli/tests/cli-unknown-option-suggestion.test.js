/**
 * @fileoverview CAWS-CLI-UNKNOWN-OPTION-NEAREST-FLAG-001 (Event 1) — an
 * unknown-option error surfaces the nearest valid flag for that command, with
 * a single non-duplicated guidance block and exit code 1.
 *
 * Finding during implementation: Commander itself already emits a native
 * "(Did you mean --<flag>?)" suggestion for an unknown option, drawn from the
 * failing command's own options. The custom handler in index.js was printing a
 * REDUNDANT second "Unknown option:" block, duplicated across two code paths.
 * The fix de-duplicates those into one helper that adds only the actionable
 * --help/docs pointers (no re-announcement), so the friction-probe's "no
 * nearest-flag hint" is satisfied by Commander and the output is no longer
 * doubled.
 *
 * Strategy: spawn the real built CLI (`node dist/index.js <args>`) and assert
 * the captured stderr + exit code. execFileSync throws on non-zero exit; we
 * read err.status / err.stderr.
 *
 * @author @darianrosebrook
 */

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'dist', 'index.js');

/** Run the CLI and capture {code, stdout, stderr} whether it exits 0 or not. */
function runCli(args) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return {
      code: e.status == null ? -1 : e.status,
      stdout: e.stdout || '',
      stderr: e.stderr || '',
    };
  }
}

describe('CAWS-CLI-UNKNOWN-OPTION-NEAREST-FLAG-001: nearest-flag on unknown option', () => {
  // A1: a one-char typo of a real option surfaces that option (Commander's
  // native suggestion) and exits 1.
  it('A1: `init --agent-surfac` → suggests --agent-surface, exit 1', () => {
    const r = runCli(['init', '--agent-surfac']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unknown option/i);
    // Commander's native "did you mean" names the right flag for THIS command.
    expect(r.stderr).toMatch(/did you mean[^)]*--agent-surface/i);
  });

  // A1 (second real flag): `--adop` → --adopt.
  it('A1: `init --adop` → suggests --adopt, exit 1', () => {
    const r = runCli(['init', '--adop']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/did you mean[^)]*--adopt/i);
  });

  // A3 (de-dup): the unknown-option output must NOT contain a redundant second
  // "Unknown option:" announcement — that was the copy-pasted custom block.
  // Commander says it once; the custom helper adds only the help/docs pointer.
  it('A3: no duplicated "Unknown option:" re-announcement', () => {
    const r = runCli(['init', '--agent-surfac']);
    // The capitalized custom re-announcement ("Unknown option: --x") must be gone.
    expect(r.stderr).not.toMatch(/Unknown option:\s*--/);
    // But the actionable guidance is still present, exactly once.
    const helpHits = (r.stderr.match(/--help for available options/g) || []).length;
    expect(helpHits).toBe(1);
  });

  // A2 / A4: a far-off typo yields no flag suggestion, and Commander never
  // surfaces an unrelated command's flag. (--takeover is a claim/worktree flag,
  // not an init flag, so init must not suggest it.)
  it('A2/A4: `init --takever` → unknown option, no cross-command --takeover suggestion', () => {
    const r = runCli(['init', '--takever']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unknown option/i);
    expect(r.stderr).not.toMatch(/--takeover/);
  });

  // The actionable guidance (docs pointer) is preserved.
  it('preserves the docs pointer in the guidance', () => {
    const r = runCli(['init', '--agent-surfac']);
    expect(r.stderr).toMatch(/Documentation:/);
  });
});
