/**
 * Behavior tests for the pack-bundled loc-delta-check.sh hook
 * (QG-HOOKS-EXTRACT-001 A4/A5/A8).
 *
 * Advisory-only (never blocks; always exit 0). On Edit, computes the
 * newline delta between new_string and old_string in the tool payload and
 * warns when it exceeds CAWS_LOC_DELTA_WARN_THRESHOLD (default 300). When the
 * payload lacks old_string/new_string, it exits 0 silently (no false positive
 * from missing data). The hook does NOT import or execute any
 * packages/quality-gates module (A9).
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const PACK_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'templates',
  'hook-packs',
  'claude-code'
);
const HOOK = path.join(PACK_DIR, 'loc-delta-check.sh');

function manyLines(n) {
  return Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
}

function runHook(payload, extraEnv = {}) {
  const result = spawnSync('bash', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  return {
    code: result.status === null ? -1 : result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe('loc-delta-check.sh', () => {
  it('A4: warns when an edit adds more than the threshold of lines', () => {
    const r = runHook({
      tool_name: 'Edit',
      tool_input: {
        file_path: 'src/big.ts',
        old_string: 'a\nb',
        new_string: manyLines(400),
      },
      session_id: 'loc-pos',
      cwd: process.cwd(),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/LOC-delta advisory/);
    expect(r.stdout).toMatch(/> 300 threshold/);
  });

  it('A4 negative: a bounded edit produces no output', () => {
    const r = runHook({
      tool_name: 'Edit',
      tool_input: {
        file_path: 'src/small.ts',
        old_string: 'a\nb',
        new_string: 'a\nb\nc\nd\ne',
      },
      session_id: 'loc-neg',
      cwd: process.cwd(),
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('A4: threshold is configurable via CAWS_LOC_DELTA_WARN_THRESHOLD', () => {
    const r = runHook(
      {
        tool_name: 'Edit',
        tool_input: {
          file_path: 'src/mid.ts',
          old_string: 'x',
          new_string: manyLines(60),
        },
        session_id: 'loc-cfg',
        cwd: process.cwd(),
      },
      { CAWS_LOC_DELTA_WARN_THRESHOLD: '50' }
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/LOC-delta advisory/);
    expect(r.stdout).toMatch(/> 50 threshold/);
  });

  it('exits silently when the payload lacks old_string/new_string', () => {
    const r = runHook({
      tool_name: 'Edit',
      tool_input: { file_path: 'src/mystery.ts' },
      session_id: 'loc-missing',
      cwd: process.cwd(),
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('ignores Write (fires on Edit only)', () => {
    const r = runHook({
      tool_name: 'Write',
      tool_input: { file_path: 'src/new.ts', content: manyLines(500) },
      session_id: 'loc-write',
      cwd: process.cwd(),
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('A5: skips files under build/ output', () => {
    const r = runHook({
      tool_name: 'Edit',
      tool_input: {
        file_path: 'packages/demo/build/out.js',
        old_string: 'a',
        new_string: manyLines(400),
      },
      session_id: 'loc-build',
      cwd: process.cwd(),
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });
});
