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
 * The closure: python/node invocations are scanned for write targets that
 * appear as PATH LITERALS in inline -c/-e code, heredoc bodies, or the content
 * of a script file named on the command line. The predicate is CO-OCCURRENCE —
 * a payload counts as a write payload only when it holds BOTH a write verb of
 * that language AND a slash-bearing path fragment. Co-occurrence is what keeps
 * reads legal, and "inside a DIFFERENT git repository" is what keeps /tmp
 * scratch legal.
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

/**
 * A fake project with a .caws registry, plus a sibling git repo under a fake
 * $HOME. The sibling sits under HOME on purpose: the observed bypass composed
 * its target from `Path.home() / "Desktop/Projects/<sibling>/..."`, so a
 * literal that is neither absolute nor cwd-relative has to resolve too.
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
  return { root, projectDir, home, sibling };
}

/** Run the template guard as a standalone handler with a fake session env. */
function runGuard(command, fixture) {
  const env = {
    ...process.env,
    HOOK_TOOL_NAME: 'Bash',
    HOOK_COMMAND: command,
    HOOK_CWD: fixture.projectDir,
    CAWS_PROJECT_DIR: fixture.projectDir,
    CAWS_AGENT_SURFACE: 'claude-code',
    HOME: fixture.home,
  };
  try {
    const stdout = execFileSync('bash', [BASH_GUARD], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
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
});

describe('bash-write-guard: interpreter-mediated writes', () => {
  let fx;
  beforeEach(() => {
    fx = makeFixture();
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
  });

  test('a python script writing a sibling repo via an absolute literal blocks', () => {
    writeScript(fx, '.tmp/fix_abs.py', [`open("${fx.sibling}/x.md", "w").write("x")`]);
    const res = runGuard('python3 .tmp/fix_abs.py', fx);
    expect(res.exit).toBe(2);
    expect(res.stderr).toMatch(/DIFFERENT repository/);
  });

  test('python -c inline code writing a sibling repo blocks', () => {
    const res = runGuard(`python3 -c "open('${fx.sibling}/x.md','w').write('x')"`, fx);
    expect(res.exit).toBe(2);
    expect(res.stderr).toMatch(/DIFFERENT repository/);
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
  });
});

describe('bash-write-guard: what the interpreter scan must keep legal', () => {
  let fx;
  beforeEach(() => {
    fx = makeFixture();
  });

  test('a python script writing only in-project scratch is permitted', () => {
    writeScript(fx, '.tmp/in_project.py', [
      'from pathlib import Path',
      'Path(".tmp/out.json").write_text("x")',
    ]);
    const res = runGuard('python3 .tmp/in_project.py', fx);
    expect(res.exit).toBe(0);
  });

  test('a python script writing /tmp is permitted: no enclosing git repository', () => {
    writeScript(fx, '.tmp/to_tmp.py', [
      'from pathlib import Path',
      'Path("/tmp/bwg-interp-out.md").write_text("x")',
    ]);
    const res = runGuard('python3 .tmp/to_tmp.py', fx);
    expect(res.exit).toBe(0);
  });

  test('a read-only open of a sibling file is permitted: no write verb, so no co-occurrence', () => {
    writeScript(fx, '.tmp/read_foreign.py', [`print(open("${fx.sibling}/README.md").read())`]);
    const res = runGuard('python3 .tmp/read_foreign.py', fx);
    expect(res.exit).toBe(0);
  });

  test('a python heredoc writing /tmp is permitted', () => {
    const cmd = [
      "python3 <<'EOF'",
      'from pathlib import Path',
      "Path('/tmp/bwg-interp-heredoc.md').write_text('x')",
      'EOF',
    ].join('\n');
    const res = runGuard(cmd, fx);
    expect(res.exit).toBe(0);
  });

  test('a python -c with a slash-bearing string but no write verb is permitted', () => {
    const res = runGuard('python3 -c "print(\'hello/world\')"', fx);
    expect(res.exit).toBe(0);
  });

  test('`node` appearing inside a path is not an interpreter invocation', () => {
    // ./node_modules/.bin/tsc must not be tokenized as the `node` command and
    // drag the whole command text through the node write-verb scan.
    const res = runGuard('./node_modules/.bin/tsc --noEmit', fx);
    expect(res.exit).toBe(0);
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
