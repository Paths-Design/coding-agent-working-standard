'use strict';

/**
 * Interpreter-mediated cross-repo write gate
 * (CAWS-BASH-GUARD-INTERPRETER-WRITE-01, under
 * CAWS-DEFECT-BASH-WRITE-GUARD-CROSS-REPO-01).
 *
 * The boundary half of this defect (a target NAMED on the command line —
 * `sed -i`, `cp`, `tee`, a redirect — resolving inside a different git
 * repository) already blocks: `foreign_repo_root` runs ahead of the allowlist
 * and the claim oracle. Those cases are pinned here as regression cover, not
 * as new behavior.
 *
 * What did NOT block, and is the subject of this suite: a mutation performed
 * INSIDE an interpreter names no write target on the shell command line, so
 * the recognizer extracts nothing and the guard adjudicates an empty candidate
 * set. Observed live in session 1aa3f0bd (2026-09-18T00:54:39Z): a session
 * rooted in `agent-config` wrote `cat > /tmp/apply-fix.mjs` whose body carried
 * a `deepseek-harness` path, then ran `node /tmp/apply-fix.mjs`.
 * bash-write-guard returned exit 0 on both calls and the foreign-repo write
 * landed — while the same session's Bash heredoc to an absolute foreign path
 * was refused with exit 2. Writing the scratch script is permitted by design
 * (see the guard's own `/tmp` rationale); executing it was never adjudicated.
 *
 * Interpreter admission requires explicit bounded source effects. Finite Node
 * write operands reach the normal ownership checks; unknown effects and all
 * file-entry scripts remain held. Python has no admitted profile in this
 * version. Script bytes read before launch cannot authorize later execution.
 *
 * Bash-driven: the SUT is a shell script, so every behavioral assertion spawns
 * the real guard and reads its real exit code and stderr. A guard's refusal
 * oracle is its output, not merely a non-zero status, so the blocking cases
 * assert the refusal text names the foreign repository too.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI_PKG_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATES = path.join(CLI_PKG_ROOT, 'templates', 'hook-packs', 'shared');
const BASH_GUARD = path.join(TEMPLATES, 'bash-write-guard.sh');
const SCOPE_GUARD = path.join(TEMPLATES, 'scope-guard.sh');

function shellQuote(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * A fake project with a .caws registry and a sibling git repo. These synthetic
 * complete-context fixtures exercise the component, not the native Codex gate.
 */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bwg-interp-'));
  const projectDir = path.join(root, 'proj');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(projectDir, '.caws'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.tmp'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.caws', 'worktrees.json'), '[]');
  execFileSync('git', ['init', '-q'], { cwd: projectDir });
  const sibling = path.join(home, 'Desktop', 'Projects', 'agent-config');
  fs.mkdirSync(sibling, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: sibling });
  fs.writeFileSync(path.join(sibling, 'README.md'), 'sibling\n');
  const cli = path.join(root, 'caws');
  fs.writeFileSync(
    cli,
    '#!/bin/sh\nexec ' +
      shellQuote(process.execPath) +
      ' ' +
      shellQuote(path.join(CLI_PKG_ROOT, 'dist/index.js')) +
      ' "$@"\n',
    { mode: 0o755 }
  );
  return { root, projectDir, home, sibling, cli };
}

/** Run the template guard as a standalone handler with a fake session env. */
function runGuard(command, fixture, permissionMode = 'bypassPermissions') {
  const env = {
    ...process.env,
    HOOK_TOOL_NAME: 'Bash',
    HOOK_COMMAND: command,
    HOOK_CWD: fixture.projectDir,
    HOOK_PERMISSION_MODE: permissionMode,
    CAWS_PROJECT_DIR: fixture.projectDir,
    CAWS_BIN: fixture.cli,
    CAWS_AGENT_SURFACE: 'claude-code',
    HOME: fixture.home,
  };
  try {
    const stdout = execFileSync('bash', [BASH_GUARD], {
      env,
      encoding: 'utf8',
      input: JSON.stringify({
        tool_name: 'Bash',
        cwd: fixture.projectDir,
        session_id: 'interpreter-fixture-session',
        permission_mode: permissionMode,
        tool_input: { command },
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exit: 0, stdout, stderr: '' };
  } catch (e) {
    return {
      exit: typeof e.status === 'number' ? e.status : -1,
      stdout: (e.stdout || '').toString(),
      stderr: (e.stderr || '').toString(),
    };
  }
}

/** Write a script into the project's scratch dir; returns its project-relative path. */
function writeScript(fixture, relPath, lines) {
  const abs = path.join(fixture.projectDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${lines.join('\n')}\n`);
  return relPath;
}

describe('bash-write-guard: cross-repo boundary for targets named on the command line', () => {
  let fx;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  test('sed -i into a sibling repo blocks and names that repository', () => {
    const res = runGuard(`sed -i '' 's/a/b/' ${fx.sibling}/CLAUDE.md`, fx);
    expect(res.exit).toBe(2);
    expect(res.stderr).toMatch(/DIFFERENT repository/);
    expect(res.stderr).toContain(fx.sibling);
  });

  test('a redirect into /tmp is permitted: no enclosing git repository', () => {
    const res = runGuard('echo scratch > /tmp/bwg-scratch-named.txt', fx);
    expect(res.exit).toBe(0);
  });

  test('foreign repository path identity: the walker retains an LF-ending ancestor', () => {
    const sibling = `${fx.sibling}\n`;
    fs.mkdirSync(sibling);
    execFileSync('git', ['init', '-q'], { cwd: sibling });
    const physical = fs.realpathSync(sibling);
    const target = path.join(physical, 'not-written.txt');
    const observed = execFileSync(
      'bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        'source "$1"; caws_foreign_repo_root "$2" "$3"',
        '_',
        path.join(TEMPLATES, 'lib/bash-mutation-targets.sh'),
        target,
        fs.realpathSync(fx.projectDir),
      ],
      { encoding: 'utf8' }
    );
    expect(observed).toBe(physical);
    expect(fs.existsSync(target)).toBe(false);
  });

  test('foreign repository path identity: a normal alias cannot hide an LF-ending sibling', () => {
    const alias = path.join(fx.root, 'foreign-alias');
    fs.symlinkSync(fx.sibling, alias);
    const target = path.join(alias, 'not-written.txt');
    const control = runGuard(`touch ${shellQuote(target)}`, fx);
    expect(control.exit).toBe(2);
    expect(control.stderr).toContain('DIFFERENT repository');
    expect(control.stderr).toContain(fs.realpathSync(fx.sibling));

    const sibling = `${fx.sibling}\n`;
    fs.mkdirSync(sibling);
    execFileSync('git', ['init', '-q'], { cwd: sibling });
    fs.unlinkSync(alias);
    fs.rmSync(fx.sibling, { recursive: true, force: true });
    fs.symlinkSync(sibling, alias);
    expect(fs.existsSync(fx.sibling)).toBe(false);
    const observed = runGuard(`touch ${shellQuote(target)}`, fx);
    expect(fs.existsSync(path.join(sibling, 'not-written.txt'))).toBe(false);
    expect(observed.exit).toBe(2);
    expect(observed.stderr).toContain('DIFFERENT repository');
    expect(observed.stderr).toContain(fs.realpathSync(sibling));
  });
});

describe('bash-write-guard: interpreter-mediated writes', () => {
  let fx;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  test('an executable read in an opaque file is held without inventing a foreign write', () => {
    const target = path.join(fx.projectDir, 'not-written.txt');
    const script = writeScript(fx, '.tmp/read-executable.js', [
      "const fs = require('node:fs');",
      `fs.readFileSync(${JSON.stringify(path.join(fx.sibling, 'README.md'))});`,
      `fs.writeFileSync(${JSON.stringify(target)}, 'owned');`,
    ]);
    const result = runGuard('node ' + shellQuote(script), fx);
    expect(fs.existsSync(target)).toBe(false);
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain('mutation-interpreter-effects');
    expect(result.stderr).not.toContain('DIFFERENT repository');
  });

  test('the observed bypass blocks: node runs a scratch script whose body writes a sibling repo', () => {
    // The exact live shape from session 1aa3f0bd — the path lives in the
    // script file, never in the command text.
    writeScript(fx, '.tmp/apply-fix.mjs', [
      "import { writeFileSync } from 'node:fs'",
      `writeFileSync('${fx.sibling}/packages/core/index.ts', 'mutated')`,
    ]);
    const res = runGuard('node .tmp/apply-fix.mjs', fx);
    expect(res.exit).toBe(2);
    expect(res.stderr).toContain('mutation-interpreter-effects');
    expect(fs.existsSync(path.join(fx.sibling, 'packages/core/index.ts'))).toBe(false);
  });

  test('a python script composing its target from Path.home() blocks', () => {
    writeScript(fx, '.tmp/fix_foreign.py', [
      'from pathlib import Path',
      'p = Path.home() / "Desktop/Projects/agent-config/SKILL.md"',
      'p.write_text("x")',
    ]);
    const res = runGuard('python3 .tmp/fix_foreign.py', fx);
    expect(res.exit).toBe(2);
    expect(res.stderr).toContain('mutation-interpreter-effects');
  });

  test('a python script writing a sibling repo via an absolute literal blocks', () => {
    writeScript(fx, '.tmp/fix_abs.py', [`open("${fx.sibling}/x.md", "w").write("x")`]);
    const res = runGuard('python3 .tmp/fix_abs.py', fx);
    expect(res.exit).toBe(2);
    expect(res.stderr).toContain('mutation-interpreter-effects');
  });

  test('python -c inline code writing a sibling repo blocks', () => {
    const res = runGuard(`python3 -c "open('${fx.sibling}/x.md','w').write('x')"`, fx);
    expect(res.exit).toBe(2);
    expect(res.stderr).toContain('mutation-interpreter-effects');
  });

  test('node -e writeFileSync into a sibling repo blocks', () => {
    const res = runGuard(`node -e "require('fs').writeFileSync('${fx.sibling}/x.md','x')"`, fx);
    expect(res.exit).toBe(2);
    expect(res.stderr).toMatch(/DIFFERENT repository/);
  });

  test('a python heredoc body writing a sibling repo blocks', () => {
    const cmd = [
      "python3 <<'EOF'",
      'from pathlib import Path',
      `Path('${fx.sibling}/y.md').write_text('x')`,
      'EOF',
    ].join('\n');
    const res = runGuard(cmd, fx);
    expect(res.exit).toBe(2);
    expect(res.stderr).toContain('mutation-interpreter-effects');
  });
});

describe('bash-write-guard: admitted source profiles and unresolved source selection', () => {
  let fx;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  test('an in-project Python file remains held without execution custody', () => {
    writeScript(fx, '.tmp/in_project.py', [
      'from pathlib import Path',
      'Path(".tmp/out.json").write_text("x")',
    ]);
    const res = runGuard('python3 .tmp/in_project.py', fx);
    expect(res.exit).toBe(2);
    expect(res.stderr).toContain('mutation-interpreter-effects');
  });

  test('a Python file remains held even if its source only names /tmp', () => {
    writeScript(fx, '.tmp/to_tmp.py', [
      'from pathlib import Path',
      'Path("/tmp/bwg-interp-out.md").write_text("x")',
    ]);
    const res = runGuard('python3 .tmp/to_tmp.py', fx);
    expect(res.exit).toBe(2);
    expect(res.stderr).toContain('mutation-interpreter-effects');
  });

  test('apparently readonly file bytes cannot authorize Python execution', () => {
    writeScript(fx, '.tmp/read_foreign.py', [`print(open("${fx.sibling}/README.md").read())`]);
    const res = runGuard('python3 .tmp/read_foreign.py', fx);
    expect(res.exit).toBe(2);
    expect(res.stderr).toContain('mutation-interpreter-effects');
  });

  test('Python heredoc effects remain unresolved without a bounded profile', () => {
    const cmd = [
      "python3 <<'EOF'",
      'from pathlib import Path',
      "Path('/tmp/bwg-interp-heredoc.md').write_text('x')",
      'EOF',
    ].join('\n');
    const res = runGuard(cmd, fx);
    expect(res.exit).toBe(2);
    expect(res.stderr).toContain('mutation-interpreter-effects');
  });

  test('absence of Python write verbs does not grant permission', () => {
    const res = runGuard('python3 -c "print(\'hello/world\')"', fx);
    expect(res.exit).toBe(2);
    expect(res.stderr).toContain('mutation-interpreter-effects');
  });

  test('unknown file-entry execution uses the existing human ask channel when available', () => {
    writeScript(fx, '.tmp/readonly.mjs', ["console.log('apparent readonly source')"]);
    const res = runGuard('node .tmp/readonly.mjs', fx, 'default');
    expect(res.exit).toBe(0);
    const output = JSON.parse(res.stdout).hookSpecificOutput;
    expect(output.permissionDecision).toBe('ask');
    expect(output.permissionDecisionReason).toContain('mutation-interpreter-effects');
  });

  test('`node` appearing inside a path is not an interpreter invocation', () => {
    // This arbitrary executable stays unresolved under the command profile;
    // the path spelling must not manufacture a Node invocation or effects.
    const res = runGuard('./node_modules/.bin/tsc --noEmit', fx);
    expect(res.exit).toBe(2);
    expect(res.stderr).toContain('executable-path');
    expect(res.stderr).not.toContain('mutation-interpreter-effects');
  });
});

describe('scope-guard: the cross-repo refusal states only what is enforced', () => {
  const guard = fs.readFileSync(SCOPE_GUARD, 'utf8');

  test('the blanket claim that every Bash route hits the same boundary is gone', () => {
    // The shipped text asserted "node -e / python write ... hit the same
    // boundary". Interpreter payloads did not, and a refusal that overclaims
    // in the permissive direction teaches the reader the rest is negotiable.
    expect(guard).not.toMatch(/those hit the same boundary/);
  });

  test('the refusal names the residual as a gap, never as an available route', () => {
    expect(guard).toMatch(/residual gap, not an admitted route/);
  });
});
