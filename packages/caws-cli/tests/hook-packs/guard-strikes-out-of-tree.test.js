/**
 * @fileoverview CAWS-GUARD-STRIKE-FILE-OUT-OF-TREE-001 — guard-strikes.sh
 * writes per-worktree strike state OUTSIDE the worktree working tree.
 *
 * Friction-probe Event 5: the scope guard wrote its strike-state JSON to
 * `<worktree>/tmp/guard-strikes-*.json`, a tracked working-tree path. A
 * routine `git add -A` from inside the worktree then swept the runtime file
 * into the feature commit.
 *
 * Strategy: source the SHIPPED template guard-strikes.sh in a real bash
 * subprocess, set up a fake linked-worktree layout (a directory whose `.git`
 * is a FILE containing `gitdir: <path>`), call guard_strikes_file with a
 * worktree-shaped cwd_hint, and assert the resolved path is under the gitdir,
 * NOT under `<worktree>/tmp`. Then verify the strike file, once written, is
 * not visible to `git status` / `git add -A` in the worktree.
 *
 * @author @darianrosebrook
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const GUARD_STRIKES = path.join(
  __dirname,
  '..',
  '..',
  'templates',
  'hook-packs',
  'claude-code',
  'guard-strikes.sh'
);

/**
 * Pick a bash whose `[[ =~ ]]` populates BASH_REMATCH for a capture group
 * followed by an alternation — the construct guard-strikes.sh's worktree-path
 * regex relies on. macOS ships bash 3.2 at /bin/bash, where that capture comes
 * back EMPTY; the Claude Code hook dispatcher runs under a modern (4+) bash, so
 * 3.2 is not a production configuration. Prefer a Homebrew bash 5; fall back to
 * PATH `bash` only if it proves capable. Returns null if none qualifies.
 */
function findCapableBash() {
  const candidates = [
    '/opt/homebrew/bin/bash',
    '/usr/local/bin/bash',
    'bash',
  ];
  for (const b of candidates) {
    const probe = spawnSync(
      b,
      [
        '-c',
        'p=/x/.caws/worktrees/n; [[ "$p" =~ ^(.*/\\.caws/worktrees/[^/]+)($|/) ]] && printf %s "${BASH_REMATCH[1]}"',
      ],
      { encoding: 'utf8' }
    );
    if (probe.status === 0 && probe.stdout === '/x/.caws/worktrees/n') {
      return b;
    }
  }
  return null;
}

const CAPABLE_BASH = findCapableBash();

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

/**
 * Source guard-strikes.sh in bash and run `guard_strikes_file <session> <cwd_hint>`,
 * returning the resolved strike-file path (stdout, trimmed).
 *
 * guard_strikes_file's signature is (session_id=$1, cwd_hint=$2) — matching how
 * guard_record_strike invokes it (`guard_strikes_file "$session_id" "$cwd_hint"`).
 */
function resolveStrikeFile({ projectDir, sessionId, cwdHint }) {
  const script = `
    set -euo pipefail
    export CLAUDE_PROJECT_DIR=${JSON.stringify(projectDir)}
    source ${JSON.stringify(GUARD_STRIKES)}
    guard_strikes_file ${JSON.stringify(sessionId)} ${JSON.stringify(cwdHint)}
  `;
  const r = spawnSync(CAPABLE_BASH, ['-c', script], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`guard_strikes_file failed (${r.status}): ${r.stderr}`);
  }
  return r.stdout.trim();
}

/**
 * Build a fake canonical repo with one linked worktree whose `.git` is a file
 * pointing at `<canonical>/.git/worktrees/<name>`. Returns the layout paths.
 */
function makeFakeWorktreeLayout(name) {
  const canonical = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-strike-canon-'));
  // The real gitdir for the linked worktree.
  const gitdir = path.join(canonical, '.git', 'worktrees', name);
  fs.mkdirSync(gitdir, { recursive: true });
  // The worktree checkout dir + its `.git` FILE.
  const worktree = path.join(canonical, '.caws', 'worktrees', name);
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitdir}\n`, 'utf8');
  return { canonical, gitdir, worktree };
}

const maybe = CAPABLE_BASH ? describe : describe.skip;
if (!CAPABLE_BASH) {
  // Never silently pass: announce why the suite is skipped so a CI without a
  // bash 4+ is visibly degraded rather than falsely green.
  // eslint-disable-next-line no-console
  console.warn(
    '[guard-strikes-out-of-tree] SKIPPED: no bash whose BASH_REMATCH populates ' +
      'the worktree-path capture (macOS /bin/bash is 3.2). Install a bash 4+ to run.'
  );
}

maybe('CAWS-GUARD-STRIKE-FILE-OUT-OF-TREE-001: strike file lands under the gitdir', () => {
  let layout;
  afterEach(() => {
    if (layout) rmrf(layout.canonical);
    layout = null;
  });

  // A1: inside a linked worktree, the strike file resolves under the gitdir,
  // never under <worktree>/tmp.
  it('A1: cwd inside a worktree → strike file under <gitdir>/caws-guard-strikes, not <worktree>/tmp', () => {
    layout = makeFakeWorktreeLayout('wt-a');
    const resolved = resolveStrikeFile({
      projectDir: layout.canonical,
      sessionId: 'sess-1234',
      cwdHint: layout.worktree,
    });
    expect(resolved.startsWith(layout.gitdir)).toBe(true);
    expect(resolved).toContain('caws-guard-strikes');
    // The old leak location must NOT be used.
    expect(resolved.startsWith(path.join(layout.worktree, 'tmp'))).toBe(false);
    expect(resolved).not.toContain(`${path.sep}.caws${path.sep}worktrees${path.sep}wt-a${path.sep}tmp`);
  });

  // A1 (consequence): the resolved strike path is OUTSIDE the worktree working
  // tree, so a `git add -A` from inside the worktree cannot stage it — the
  // exact leak the old `<worktree>/tmp/` location caused (friction Event 5).
  //
  // We model a real linked worktree: a true canonical git repo, `git worktree
  // add` to create the linked checkout (which writes the genuine `.git` FILE +
  // gitdir), then assert the strike file lands under that gitdir and is not
  // visible to `git status` / `git add -A` in the worktree.
  it('A1: a strike file at the resolved path is not stageable from the worktree', () => {
    const canonical = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-strike-real-'));
    try {
      execFileSync('git', ['init', '--quiet', canonical]);
      execFileSync('git', ['-C', canonical, 'config', 'user.email', 't@t.co']);
      execFileSync('git', ['-C', canonical, 'config', 'user.name', 'T']);
      fs.writeFileSync(path.join(canonical, 'README'), 'x\n', 'utf8');
      execFileSync('git', ['-C', canonical, 'add', 'README']);
      execFileSync('git', ['-C', canonical, 'commit', '--quiet', '-m', 'init']);

      // Real linked worktree at .caws/worktrees/wt-real — git writes the
      // canonical `.git` FILE (`gitdir: <canonical>/.git/worktrees/wt-real`).
      const wt = path.join(canonical, '.caws', 'worktrees', 'wt-real');
      execFileSync('git', ['-C', canonical, 'worktree', 'add', '--quiet', wt]);
      expect(fs.statSync(path.join(wt, '.git')).isFile()).toBe(true); // linked form

      const resolved = resolveStrikeFile({
        projectDir: canonical,
        sessionId: 'sess-real',
        cwdHint: wt,
      });
      // Lands under the worktree's real gitdir, outside the working tree.
      expect(resolved).toContain(
        path.join('.git', 'worktrees', 'wt-real', 'caws-guard-strikes')
      );
      fs.writeFileSync(resolved, '{"scope_guard":1}\n', 'utf8');

      // Control: a file written INTO the worktree shows up; the strike file
      // does not (proves git status is live AND the strike file is invisible).
      fs.writeFileSync(path.join(wt, 'control.txt'), 'visible\n', 'utf8');
      const status = execFileSync('git', ['-C', wt, 'status', '--porcelain'], {
        encoding: 'utf8',
      });
      expect(status).toContain('control.txt');
      expect(status.includes('guard-strikes')).toBe(false);
      expect(status.includes('caws-guard-strikes')).toBe(false);
    } finally {
      // Worktree prune then rm so git's bookkeeping doesn't complain.
      try {
        execFileSync('git', ['-C', canonical, 'worktree', 'prune'], {
          stdio: 'ignore',
        });
      } catch {
        /* best-effort */
      }
      rmrf(canonical);
    }
  });

  // A2: from the main checkout (no linked-worktree .git file), the strike file
  // falls back to the canonical .claude/logs location.
  it('A2: cwd on the main checkout → canonical .claude/logs fallback', () => {
    const canonical = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-strike-main-'));
    try {
      const resolved = resolveStrikeFile({
        projectDir: canonical,
        sessionId: 'sess-main',
        cwdHint: canonical, // not a .caws/worktrees/<name> path
      });
      expect(resolved).toBe(
        path.join(canonical, '.claude', 'logs', 'guard-strikes-sess-main.json')
      );
    } finally {
      rmrf(canonical);
    }
  });

  // A3: a worktree whose .git file is missing/unparseable → fall back to the
  // canonical .claude/logs location, never failing closed.
  it('A3: worktree with unparseable .git → canonical .claude/logs fallback', () => {
    layout = makeFakeWorktreeLayout('wt-bad');
    // Corrupt the .git pointer (no gitdir: line).
    fs.writeFileSync(path.join(layout.worktree, '.git'), 'garbage\n', 'utf8');
    const resolved = resolveStrikeFile({
      projectDir: layout.canonical,
      sessionId: 'sess-bad',
      cwdHint: layout.worktree,
    });
    expect(resolved).toBe(
      path.join(layout.canonical, '.claude', 'logs', 'guard-strikes-sess-bad.json')
    );
  });
});
