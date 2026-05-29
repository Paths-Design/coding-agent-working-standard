/**
 * Behavior tests for the pack-bundled shortcut-language-check.sh hook
 * (QG-HOOKS-EXTRACT-001 A2/A5/A8).
 *
 * Unlike the other three advisory hooks, this one escalates through the
 * existing guard-strikes mechanism: strike 1 -> warn (additionalContext),
 * strike 2 -> ask (permissionDecision), strike 3 -> block (decision: block).
 * Strikes are keyed by (session_id, guard_name) in a per-session JSON file,
 * so each test uses a unique session_id to isolate its strike count.
 *
 * Test files (*.test.* / *.spec.*) are exempt. Clean prose produces no strike.
 * The hook does NOT import or execute any packages/quality-gates module (A9).
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
const HOOK = path.join(PACK_DIR, 'shortcut-language-check.sh');

/** Each test gets its own CLAUDE_PROJECT_DIR so guard-strikes state is
 *  isolated to that temp repo (the strike file lands under
 *  <project>/.claude/logs/). */
function freshProjectDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'caws-shortcut-'));
}

function runHook(payload, projectDir) {
  const result = spawnSync('bash', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
  return {
    code: result.status === null ? -1 : result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe('shortcut-language-check.sh', () => {
  let projectDir;
  beforeEach(() => {
    projectDir = freshProjectDir();
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('A2: flags a TODO marker in a non-test source file (strike 1 warn)', () => {
    const r = runHook(
      {
        tool_name: 'Write',
        tool_input: {
          file_path: path.join(projectDir, 'src/foo.ts'),
          content: 'function x() {\n  // TODO implement this\n  return null;\n}',
        },
        session_id: 'sc-todo-1',
        cwd: projectDir,
      },
      projectDir
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Shortcut-language advisory/);
    expect(r.stdout).toMatch(/strike 1 of 3/);
    expect(r.stdout).toMatch(/additionalContext/);
  });

  it('A2: flags "not implemented" placeholder language', () => {
    const r = runHook(
      {
        tool_name: 'Edit',
        tool_input: {
          file_path: path.join(projectDir, 'src/bar.ts'),
          new_string: 'export function f() { throw new Error("not implemented"); }',
        },
        session_id: 'sc-notimpl-1',
        cwd: projectDir,
      },
      projectDir
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Shortcut-language advisory/);
  });

  it('A2: escalates warn -> ask -> block across three strikes', () => {
    const payload = {
      tool_name: 'Write',
      tool_input: {
        file_path: path.join(projectDir, 'src/baz.ts'),
        content: '// FIXME: placeholder, implement later',
      },
      session_id: 'sc-escalate',
      cwd: projectDir,
    };
    const s1 = runHook(payload, projectDir);
    const s2 = runHook(payload, projectDir);
    const s3 = runHook(payload, projectDir);

    expect(s1.stdout).toMatch(/strike 1 of 3/);
    expect(s1.stdout).toMatch(/additionalContext/);

    expect(s2.stdout).toMatch(/strike 2 of 3/);
    expect(s2.stdout).toMatch(/permissionDecision/);
    expect(s2.stdout).toMatch(/ask/);

    expect(s3.stdout).toMatch(/strike 3/);
    expect(s3.stdout).toMatch(/"decision":\s*"block"/);
  });

  it('A2 negative: clean source produces no strike', () => {
    const r = runHook(
      {
        tool_name: 'Write',
        tool_input: {
          file_path: path.join(projectDir, 'src/clean.ts'),
          content: 'export function add(a, b) { return a + b; }',
        },
        session_id: 'sc-clean',
        cwd: projectDir,
      },
      projectDir
    );
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('A2 negative: TODO in a *.test.* file is exempt (no strike)', () => {
    const r = runHook(
      {
        tool_name: 'Write',
        tool_input: {
          file_path: path.join(projectDir, 'src/foo.test.ts'),
          content: '// TODO add more cases\nit.todo("handles edge case");',
        },
        session_id: 'sc-testfile',
        cwd: projectDir,
      },
      projectDir
    );
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('A5: TODO in a markdown doc is not a strike (prose, not code)', () => {
    const r = runHook(
      {
        tool_name: 'Write',
        tool_input: {
          file_path: path.join(projectDir, 'docs/notes.md'),
          content: '# Notes\n\nTODO: write this section later.',
        },
        session_id: 'sc-md',
        cwd: projectDir,
      },
      projectDir
    );
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });
});
