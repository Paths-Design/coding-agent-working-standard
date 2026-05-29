/**
 * @fileoverview HOOK-LIB-CONSOLIDATION-001 T3a / AC A4 — canonical
 * Claude Code hook-output envelope emitters.
 *
 * Proves lib/emit.sh's three emitters produce the exact JSON envelope
 * shapes Claude Code expects, on BOTH the jq path and the no-jq printf
 * fallback path, and that they JSON-escape message content correctly
 * (the old inline `echo '{...}'` emitters did not, so a message
 * containing a double-quote or backslash produced invalid JSON).
 *
 * Before T3a, 12 hooks hand-rolled these envelopes under 5+ function
 * names. lib/emit.sh is now the single definition; every hook delegates
 * to it. This harness locks the contract those delegations depend on.
 *
 * File under test: the shipped template lib/emit.sh.
 *
 * @author @darianrosebrook
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const HOOK_DIR = path.join(
  REPO_ROOT,
  'packages',
  'caws-cli',
  'templates',
  'hook-packs',
  'claude-code'
);
const LIB = path.join(HOOK_DIR, 'lib', 'emit.sh');

/**
 * Source emit.sh and call one emitter, returning the parsed JSON object.
 * @param call  the emit_* invocation, e.g. `emit_block "$MSG"`
 * @param msg   value bound to env MSG (so message content is never
 *              shell-quoted into the script)
 * @param event optional value bound to env EV
 * @param noJq  when true, run with jq removed from PATH (fallback path)
 */
function emit(call, msg, event, noJq) {
  const body = [
    `source "${LIB}"`,
    call, // references "$MSG" / "$EV"
  ].join('\n');
  // Optionally strip jq's dir from PATH to exercise the printf fallback.
  let pathEnv = process.env.PATH;
  if (noJq) {
    const which = spawnSync('bash', ['-lc', 'command -v jq'], { encoding: 'utf8' });
    const jqDir = which.stdout.trim() ? path.dirname(which.stdout.trim()) : null;
    if (jqDir) {
      pathEnv = pathEnv
        .split(':')
        .filter((d) => d !== jqDir)
        .join(':');
    }
  }
  const r = spawnSync('bash', ['-c', body], {
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, PATH: pathEnv, MSG: msg, EV: event || '' },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`emit failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout); // throws if invalid JSON — that's the assertion
}

describe('HOOK-LIB-CONSOLIDATION-001 T3a — canonical emit envelopes', () => {
  describe.each([
    ['jq path', false],
    ['no-jq fallback', true],
  ])('%s', (_label, noJq) => {
    it('emit_block produces { decision: "block", reason }', () => {
      const d = emit('emit_block "$MSG"', 'stop right there', undefined, noJq);
      expect(d).toEqual({ decision: 'block', reason: 'stop right there' });
    });

    it('emit_ask produces the PreToolUse permissionDecision:ask envelope', () => {
      const d = emit('emit_ask "$MSG"', 'are you sure?', undefined, noJq);
      expect(d).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: 'are you sure?',
        },
      });
    });

    it('emit_additional_context defaults to PreToolUse', () => {
      const d = emit('emit_additional_context "$MSG"', 'fyi advisory', undefined, noJq);
      expect(d).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: 'fyi advisory',
        },
      });
    });

    it('emit_additional_context honors a PostToolUse event arg', () => {
      const d = emit('emit_additional_context "$MSG" "$EV"', 'post note', 'PostToolUse', noJq);
      expect(d).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: 'post note',
        },
      });
    });

    it('escapes double-quotes, backslashes, and newlines in the message', () => {
      // The exact failure mode the old inline `echo '{...}'` emitters had:
      // a message with a literal " or \ produced invalid JSON. parse alone
      // proves validity; the deep-equal proves the content round-trips.
      const tricky = 'he said "hi" and used a \\ backslash\nthen a newline\tand a tab';
      const d = emit('emit_additional_context "$MSG"', tricky, undefined, noJq);
      expect(d.hookSpecificOutput.additionalContext).toBe(tricky);
    });
  });
});
