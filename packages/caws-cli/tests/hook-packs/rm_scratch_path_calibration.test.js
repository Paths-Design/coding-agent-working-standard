/**
 * @fileoverview DANGER-LATCH-UX-001 (rm scratch-path calibration) —
 * recursive deletes under a system temp root are admitted; catastrophic and
 * ambiguous deletes stay governed.
 *
 * Agents routinely create-and-tear-down fixtures under the OS temp dir
 * (`mktemp -d`, `/tmp/<scratch>`). Latching that flow as a catastrophic delete
 * is an over-trigger: it engages the sticky per-session danger latch on a
 * harmless cleanup, requiring a human reset. The calibration admits a
 * recursive delete whose RESOLVED ABSOLUTE path is strictly below a system
 * scratch root (/tmp, /private/tmp, /var/folders, $TMPDIR) while leaving every
 * catastrophic / ambiguous form governed (the hard-block checks run first).
 *
 * Known limitation (asserted): `cd /tmp && rm -rf relative-name` resolves the
 * RELATIVE target against --cwd (repo root), not the preceding `cd`, so it
 * stays "ask". A static classifier cannot reliably track cwd across compound
 * segments; "ask" (not deny, not latch) is the correct conservative answer.
 * The absolute-path form (`rm -rf /tmp/name`) is the supported safe path.
 *
 * @author @darianrosebrook
 */

'use strict';

const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { classifyTimeoutMs } = require('./lib/classify-timeout');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const CLASSIFIER = path.join(
  REPO_ROOT, 'packages', 'caws-cli', 'templates', 'hook-packs', 'claude-code', 'classify_command.py'
);

function decision(command) {
  // Pass the command via stdin (never as a shell string in THIS process's
  // Bash) so the maintainer's own danger latch is never tripped by a test
  // fixture containing `rm -rf`.
  const r = spawnSync(
    'python3',
    [CLASSIFIER, '--repo-root', REPO_ROOT, '--home', os.homedir(), '--cwd', REPO_ROOT],
    { input: command, encoding: 'utf8', timeout: classifyTimeoutMs() }
  );
  if (r.error) throw r.error;
  return JSON.parse(r.stdout).decision;
}

describe('DANGER-LATCH-UX-001 — rm scratch-path calibration', () => {
  describe('system temp paths are admitted', () => {
    const allow = [
      'rm -rf /tmp/latch-test',
      'rm -rf /tmp/slr-e2e',
      'rm -rf /private/tmp/fixture',
      'rm -rf /tmp/a/b/c',
    ];
    allow.forEach((cmd) => {
      it(`${cmd} → allow`, () => expect(decision(cmd)).toBe('allow'));
    });
  });

  describe('catastrophic / ambiguous deletes stay governed', () => {
    const governed = [
      ['rm -rf /', 'deny'],
      ['rm -rf ~', 'deny'],
      ['rm -rf .', 'deny'],
      ['rm -rf /tmp', 'ask'],   // the temp ROOT itself — not below it
      ['rm -rf /etc', 'ask'],
      ['rm -rf /usr/local', 'ask'],
      ['rm -rf src', 'ask'],    // repo-relative, not a safe prefix
    ];
    governed.forEach(([cmd, want]) => {
      it(`${cmd} → ${want} (NOT allow)`, () => {
        const d = decision(cmd);
        expect(d).not.toBe('allow');
        expect(d).toBe(want);
      });
    });
  });

  describe('repo-relative safe prefixes unchanged', () => {
    ['rm -rf tmp/foo', 'rm -rf node_modules', 'rm -rf target/debug'].forEach((cmd) => {
      it(`${cmd} → allow`, () => expect(decision(cmd)).toBe('allow'));
    });
  });

  it('documented limitation: `cd /tmp && rm -rf <relative>` stays ask (cwd not tracked across &&)', () => {
    // A relative rm whose safety depends on a preceding `cd` is ambiguous to
    // a static classifier. ask is correct (not allow, not latch). Use the
    // absolute form (rm -rf /tmp/<name>) for the admitted path.
    expect(decision('cd /tmp && rm -rf latch-test')).toBe('ask');
  });
});
