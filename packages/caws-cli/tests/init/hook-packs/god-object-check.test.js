/**
 * Behavior tests for the pack-bundled god-object-check.sh advisory hook
 * (QG-HOOKS-EXTRACT-001 A1/A5/A8).
 *
 * Invokes the template hook script directly with a synthesized Claude Code
 * PostToolUse payload on stdin (matching the parse-input.sh contract). The
 * hook is advisory: it emits a hookSpecificOutput.additionalContext warning
 * when the written/edited file's SLOC meets the threshold and ALWAYS exits 0;
 * it produces no output for files under the threshold or for skipped paths.
 *
 * These tests assert real behavior (exit code + emitted advisory text), not
 * just script presence. They do NOT import or execute any
 * external quality package (A9).
 */

'use strict';

const fs = require('fs');
const os = require('os');
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
const HOOK = path.join(PACK_DIR, 'god-object-check.sh');

/** Write a file with `lines` non-comment, non-blank source lines. */
function writeSourceFile(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-god-'));
  const file = path.join(dir, 'subject.ts');
  fs.writeFileSync(file, Array.from({ length: lines }, () => 'const x = 1;').join('\n') + '\n');
  return { dir, file };
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

describe('god-object-check.sh', () => {
  it('A1: flags a file whose SLOC exceeds the threshold, exits 0', () => {
    const { dir, file } = writeSourceFile(2100);
    try {
      const r = runHook(
        {
          tool_name: 'Write',
          tool_input: { file_path: file, content: 'x' },
          session_id: 'god-pos',
          cwd: dir,
        },
        { CAWS_GOD_OBJECT_LOC: '2000' }
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/God-object advisory/);
      expect(r.stdout).toMatch(/2100 SLOC/);
      expect(r.stdout).toMatch(/PostToolUse/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A1 negative: a file under the threshold produces no output', () => {
    const { dir, file } = writeSourceFile(50);
    try {
      const r = runHook(
        {
          tool_name: 'Write',
          tool_input: { file_path: file, content: 'x' },
          session_id: 'god-neg',
          cwd: dir,
        },
        { CAWS_GOD_OBJECT_LOC: '2000' }
      );
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('threshold is configurable via CAWS_GOD_OBJECT_LOC', () => {
    const { dir, file } = writeSourceFile(120);
    try {
      const r = runHook(
        {
          tool_name: 'Write',
          tool_input: { file_path: file, content: 'x' },
          session_id: 'god-cfg',
          cwd: dir,
        },
        { CAWS_GOD_OBJECT_LOC: '100' }
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/120 SLOC/);
      expect(r.stdout).toMatch(/>= 100 threshold/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A5: skips files under node_modules/ (no output)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-god-nm-'));
    const nm = path.join(dir, 'node_modules', 'pkg');
    fs.mkdirSync(nm, { recursive: true });
    const file = path.join(nm, 'big.js');
    fs.writeFileSync(file, Array.from({ length: 5000 }, () => 'const x = 1;').join('\n'));
    try {
      const r = runHook({
        tool_name: 'Write',
        tool_input: { file_path: file, content: 'x' },
        session_id: 'god-skip',
        cwd: dir,
      });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores non-mutating tools (e.g. Read)', () => {
    const { dir, file } = writeSourceFile(3000);
    try {
      const r = runHook({
        tool_name: 'Read',
        tool_input: { file_path: file },
        session_id: 'god-read',
        cwd: dir,
      });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
