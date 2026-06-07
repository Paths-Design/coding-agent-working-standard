'use strict';

const { spawnSync, execFileSync } = require('child_process');
const path = require('path');

const PACK_ROOT = path.resolve(
  __dirname,
  '..',
  '..',
  'templates',
  'hook-packs',
  'codex'
);

function runBash(script, input) {
  return execFileSync('bash', ['-lc', script], {
    cwd: PACK_ROOT,
    input,
    encoding: 'utf8',
  });
}

describe('Codex hook parser/emitter contract', () => {
  it('parses Bash payloads into CAWS hook variables', () => {
    const payload = JSON.stringify({
      session_id: 'sess-1',
      cwd: '/repo',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git status --short' },
    });
    const out = runBash(
      'source lib/parse-input.sh; parse_hook_input; printf "%s\\n%s\\n%s\\n" "$HOOK_TOOL_NAME" "$HOOK_COMMAND" "$HOOK_SESSION_ID"',
      payload
    ).trim().split('\n');
    expect(out).toEqual(['Bash', 'git status --short', 'sess-1']);
  });

  it('maps Codex apply_patch payloads to Write/Edit file variables', () => {
    const payload = JSON.stringify({
      session_id: 'sess-2',
      cwd: '/repo',
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: {
        command:
          '*** Begin Patch\n*** Add File: src/new-file.ts\n+export const x = 1;\n*** End Patch\n',
      },
    });
    const out = runBash(
      'source lib/parse-input.sh; parse_hook_input; printf "%s\\n%s\\n%s\\n%s\\n" "$HOOK_ORIGINAL_TOOL_NAME" "$HOOK_TOOL_NAME" "$HOOK_FILE_PATH" "$HOOK_FILE_PATHS"',
      payload
    ).trim().split('\n');
    expect(out).toEqual(['apply_patch', 'Write', 'src/new-file.ts', 'src/new-file.ts']);
  });

  it('fails open on malformed input', () => {
    const out = runBash(
      'source lib/parse-input.sh; parse_hook_input; printf "%s\\n%s\\n" "$HOOK_TOOL_NAME" "$HOOK_SESSION_ID"',
      '{not json'
    ).split('\n').slice(0, 2);
    expect(out).toEqual(['', 'unknown']);
  });

  it('emits Codex-supported block, conservative ask, context, and updatedInput envelopes', () => {
    const script = [
      'source lib/emit.sh',
      'emit_block "blocked"; echo "---"',
      'emit_ask "needs approval"; echo "---"',
      'emit_additional_context "context" "PostToolUse"; echo "---"',
      'emit_updated_input "echo rewritten"',
    ].join('; ');
    const parts = runBash(script, '').trim().split('\n---\n').map((s) => JSON.parse(s));
    expect(parts[0]).toEqual({ decision: 'block', reason: 'blocked' });
    expect(parts[1].hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'needs approval',
    });
    expect(parts[2].hookSpecificOutput).toEqual({
      hookEventName: 'PostToolUse',
      additionalContext: 'context',
    });
    expect(parts[3].hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { command: 'echo rewritten' },
    });
  });

  it('dispatcher refuses apply_patch edits to relative .codex hook scripts', () => {
    const payload = JSON.stringify({
      session_id: 'sess-protected',
      cwd: PACK_ROOT,
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: {
        command:
          '*** Begin Patch\n*** Update File: .codex/hooks/block-dangerous.sh\n@@\n-echo old\n+echo new\n*** End Patch\n',
      },
    });
    const result = spawnSync(
      path.join(PACK_ROOT, 'caws_dispatch', 'pre_tool_use.sh'),
      [],
      {
        cwd: PACK_ROOT,
        input: payload,
        encoding: 'utf8',
      }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.codex/hooks/block-dangerous.sh is protected');
  });
});
