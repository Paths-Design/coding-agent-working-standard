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
 * Finite Node write operands reach the normal ownership checks. Other
 * interpreter source is weak evidence: path literals it may WRITE to, taken from
 * inline -c/-e code, heredoc bodies, or an untracked script named on the command
 * line, reach the cross-repository check and block there. A payload counts as a
 * write payload only when it holds BOTH a write verb of that language AND a
 * path literal that is not merely the operand of a read. Evidence can refuse a
 * foreign write and never authorizes one; launching a program is otherwise the
 * same limited-recognizer residual as any other command. "Inside a DIFFERENT git
 * repository" is what keeps /tmp scratch and reads of a sibling legal.
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

  test('a script that reads a sibling and writes its own project is not a foreign write', () => {
    const target = path.join(fx.projectDir, 'not-written.txt');
    const script = writeScript(fx, '.tmp/read-executable.js', [
      "const fs = require('node:fs');",
      `const api = require('${fx.sibling}/api.js');`,
      `fs.readFileSync(${JSON.stringify(path.join(fx.sibling, 'README.md'))});`,
      `fs.writeFileSync(${JSON.stringify(target)}, 'owned');`,
    ]);
    const result = runGuard('node ' + shellQuote(script), fx);
    expect(fs.existsSync(target)).toBe(false);
    expect(result).toEqual({ exit: 0, stdout: '', stderr: '' });
  });

  test.each([
    [
      'the same path is also written',
      (dir) => [
        `fs.readFileSync('${dir}/README.md');`,
        `fs.writeFileSync('${dir}/README.md', 'x');`,
      ],
    ],
    [
      'the write target is named before it is used',
      (dir) => [
        `const target = '${dir}/README.md';`,
        "fs.writeFileSync(target, fs.readFileSync('README.md'));",
      ],
    ],
    [
      'a resolved path is written through',
      (dir) => [`fs.writeFileSync(fs.realpathSync('${dir}/README.md'), 'x');`],
    ],
  ])('a read in a script does not excuse its foreign write: %s', (_name, body) => {
    const script = writeScript(fx, '.tmp/read-then-write.js', [
      "const fs = require('node:fs');",
      ...body(fx.sibling),
    ]);
    const result = runGuard('node ' + shellQuote(script), fx);
    expect(result.exit).toBe(2);
    expect(result.stderr).toMatch(/DIFFERENT repository/);
    expect(result.stderr).toContain(fx.sibling);
    expect(fs.readFileSync(path.join(fx.sibling, 'README.md'), 'utf8')).toBe('sibling\n');
  });

  test('a script the project tracks is reviewed code and is not scanned', () => {
    const script = writeScript(fx, 'scripts/sync.js', [
      `require('node:fs').writeFileSync('${fx.sibling}/x.md', 'x');`,
    ]);
    const untracked = runGuard('node ' + script, fx);
    expect(untracked.exit).toBe(2);
    expect(untracked.stderr).toMatch(/DIFFERENT repository/);
    execFileSync('git', ['add', '--', script], { cwd: fx.projectDir });
    expect(runGuard('node ' + script, fx)).toEqual({ exit: 0, stdout: '', stderr: '' });
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
    expect(res.stderr).toMatch(/DIFFERENT repository/);
    expect(res.stderr).toContain(fx.sibling);
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
    expect(res.stderr).toMatch(/DIFFERENT repository/);
    expect(res.stderr).toContain(fx.sibling);
  });

  test('a python script writing a sibling repo via an absolute literal blocks', () => {
    writeScript(fx, '.tmp/fix_abs.py', [`open("${fx.sibling}/x.md", "w").write("x")`]);
    const res = runGuard('python3 .tmp/fix_abs.py', fx);
    expect(res.exit).toBe(2);
    expect(res.stderr).toMatch(/DIFFERENT repository/);
    expect(res.stderr).toContain(fx.sibling);
  });

  test('python -c inline code writing a sibling repo blocks', () => {
    const res = runGuard(`python3 -c "open('${fx.sibling}/x.md','w').write('x')"`, fx);
    expect(res.exit).toBe(2);
    expect(res.stderr).toMatch(/DIFFERENT repository/);
    expect(res.stderr).toContain(fx.sibling);
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
    expect(res.stderr).toMatch(/DIFFERENT repository/);
    expect(res.stderr).toContain(fx.sibling);
  });
});

describe('bash-write-guard: what the interpreter scan must keep legal', () => {
  const admitted = { exit: 0, stdout: '', stderr: '' };
  let fx;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  test('a python script writing only in-project scratch is permitted', () => {
    writeScript(fx, '.tmp/in_project.py', [
      'from pathlib import Path',
      'Path(".tmp/out.json").write_text("x")',
    ]);
    expect(runGuard('python3 .tmp/in_project.py', fx)).toEqual(admitted);
  });

  test('a python script writing /tmp is permitted: no enclosing git repository', () => {
    writeScript(fx, '.tmp/to_tmp.py', [
      'from pathlib import Path',
      'Path("/tmp/bwg-interp-out.md").write_text("x")',
    ]);
    expect(runGuard('python3 .tmp/to_tmp.py', fx)).toEqual(admitted);
  });

  test('a read-only open of a sibling file is permitted: no write verb, so no co-occurrence', () => {
    writeScript(fx, '.tmp/read_foreign.py', [`print(open("${fx.sibling}/README.md").read())`]);
    expect(runGuard('python3 .tmp/read_foreign.py', fx)).toEqual(admitted);
  });

  test('a python heredoc writing /tmp is permitted', () => {
    const cmd = [
      "python3 <<'EOF'",
      'from pathlib import Path',
      "Path('/tmp/bwg-interp-heredoc.md').write_text('x')",
      'EOF',
    ].join('\n');
    expect(runGuard(cmd, fx)).toEqual(admitted);
  });

  test('a python -c with a slash-bearing string but no write verb is permitted', () => {
    expect(runGuard('python3 -c "print(\'hello/world\')"', fx)).toEqual(admitted);
  });

  test('launching a program raises no approval request in a mode that could ask', () => {
    writeScript(fx, '.tmp/readonly.mjs', ["console.log('apparent readonly source')"]);
    expect(runGuard('node .tmp/readonly.mjs', fx, 'default')).toEqual(admitted);
  });

  test('a write whose target is never named uses the human ask channel when available', () => {
    const command = `python3 -c "import sys; open(sys.argv[1], 'w')"`;
    const res = runGuard(command, fx, 'default');
    expect(res.exit).toBe(0);
    const output = JSON.parse(res.stdout).hookSpecificOutput;
    expect(output.permissionDecision).toBe('ask');
    expect(output.permissionDecisionReason).toContain('mutation-interpreter-effects');
    expect(runGuard(command, fx).exit).toBe(2);
  });

  test('`node` appearing inside a path is not an interpreter invocation', () => {
    // ./node_modules/.bin/tsc must not be taken for the `node` command and drag
    // the whole command text through the node write-verb scan.
    const command = `./node_modules/.bin/tsc --note "writeFileSync('${fx.sibling}/x.md')"`;
    expect(runGuard(command, fx)).toEqual(admitted);
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
