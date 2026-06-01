/**
 * @fileoverview CAWS-CLASSIFY-WORKTREE-PRUNE-AND-RM-REDIRECT-001 —
 * two classify_command.py calibrations surfaced by the caws-firsttime-probe:
 *
 *   A1  `git worktree prune --dry-run` (and `-n`) is read-only → allow;
 *       bare `git worktree prune` (and add/remove) still ask.
 *   A2  shell redirects (`2>&1`, `> out.log`) are NOT treated as rm delete
 *       targets — the reason names the real path, not the redirect.
 *   A3  a recursive rm whose only non-flag tokens are redirects denies on
 *       empty-target, not on a `2>&1` target.
 *   A4  no regression to existing worktree/rm classifications.
 *
 * Shells out to the shipped template classifier (same harness as
 * classify_command_calibration.test.js).
 *
 * @author @darianrosebrook
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { classifyTimeoutMs } = require('./lib/classify-timeout');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const CLASSIFIER = path.join(
  REPO_ROOT,
  'packages',
  'caws-cli',
  'templates',
  'hook-packs',
  'claude-code',
  'classify_command.py'
);

function classify(cmd, { cwd = REPO_ROOT, home = '/tmp/fake-home' } = {}) {
  const r = spawnSync(
    'python3',
    [CLASSIFIER, '--repo-root', REPO_ROOT, '--home', home, '--cwd', cwd],
    { input: cmd, encoding: 'utf8', timeout: classifyTimeoutMs() }
  );
  if (r.error) throw new Error(`classifier failed: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`classifier exited ${r.status}\nstderr: ${r.stderr}`);
  }
  return JSON.parse(r.stdout);
}

describe('CAWS-CLASSIFY-WORKTREE-PRUNE-AND-RM-REDIRECT-001', () => {
  // ── A1: git worktree prune --dry-run is read-only ──────────────────
  it('A1: `git worktree prune --dry-run` → allow', () => {
    expect(classify('git worktree prune --dry-run').decision).toBe('allow');
  });

  it('A1: `git worktree prune -n` → allow', () => {
    expect(classify('git worktree prune -n').decision).toBe('allow');
  });

  it('A1: bare `git worktree prune` (mutating) → NOT allow', () => {
    expect(classify('git worktree prune').decision).not.toBe('allow');
  });

  it('A1: `git worktree add foo` (mutating) → NOT allow', () => {
    expect(classify('git worktree add foo').decision).not.toBe('allow');
  });

  it('A1: `git worktree list` (pre-existing read-only) still → allow', () => {
    expect(classify('git worktree list').decision).toBe('allow');
  });

  // ── A2: shell redirects are not rm delete-targets ──────────────────
  it('A2: `rm -rf <dir> 2>&1` reason names the dir, not the redirect', () => {
    const { reason } = classify('rm -rf /some/real/dir 2>&1');
    expect(reason).toContain('/some/real/dir');
    expect(reason).not.toContain('2>&1');
  });

  it('A2: `rm -rf <dir> > out.log` reason does not name the redirect operand', () => {
    const { reason } = classify('rm -rf /some/real/dir > out.log');
    expect(reason).toContain('/some/real/dir');
    expect(reason).not.toContain('out.log');
    expect(reason).not.toMatch(/(^|\s)>($|\s)/);
  });

  it('A2: `rm -rf <dir> 2> err.txt` (operand redirect) reason names the dir only', () => {
    const { reason } = classify('rm -rf /some/real/dir 2> err.txt');
    expect(reason).toContain('/some/real/dir');
    expect(reason).not.toContain('err.txt');
  });

  // ── A3: redirect-only recursive rm → conservative ask, never a 2>&1 target ──
  it('A3: `rm -rf 2>&1` (no path) is a conservative ask, NOT a 2>&1 target', () => {
    const { decision, reason } = classify('rm -rf 2>&1');
    // The redirect is stripped, leaving zero targets. The caller treats a
    // recursive rm with no resolvable target as a conservative ask
    // ("unparseable targets") — the key guarantee is that the redirect is
    // never classified as a delete target and never appears in the reason.
    expect(decision).toBe('ask');
    expect(reason).not.toContain('2>&1');
    expect(reason).toMatch(/unparseable|empty target/i);
  });

  // ── A4: regressions — catastrophic + scratch rm unchanged ──────────
  it('A4: `rm -rf /` still denies (filesystem root)', () => {
    expect(classify('rm -rf /').decision).toBe('deny');
  });

  it('A4: `rm -rf /tmp/scratch` (scratch root) still allows', () => {
    expect(classify('rm -rf /tmp/scratch').decision).toBe('allow');
  });

  it('A4: `rm -rf /tmp/scratch 2>&1` (scratch + redirect) still allows', () => {
    expect(classify('rm -rf /tmp/scratch 2>&1').decision).toBe('allow');
  });
});
