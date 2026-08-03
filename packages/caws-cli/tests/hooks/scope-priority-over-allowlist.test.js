'use strict';

/**
 * Scope-priority-over-allowlist regression gate
 * (CAWS-GUARD-SCOPE-PRIORITY-001).
 *
 * The defect this suite pins: the write allowlist (docs/*, .caws/*, etc.) fired
 * UNCONDITIONALLY before the scope-contention check, so a worktree's scope.in
 * claim on docs/** was silently ignored — scope.in was not authoritative for
 * allowlisted paths. An agent who trusted a doc-heavy spec's scope.in would get
 * burned: the claim was a lie.
 *
 * The fix: scope.in OVERRIDES the allowlist. If caws scope contention reports
 * the path as CLAIMED by an active worktree, the write blocks (foreign session)
 * regardless of the allowlist prefix. If CLEAR (no claim) or UNDETERMINED
 * (toolchain fault), the allowlist permits — coordination edits still work.
 *
 * This suite verifies the guard SOURCES reflect the gating (the allowlist no
 * longer exits unconditionally; it defers to the scope verdict) and that the
 * allowlist helper's path verdicts are unchanged (the helper still returns the
 * same allow/deny answer — the gating happens in the guard, not the helper).
 */

const fs = require('fs');
const path = require('path');

const CLI_PKG_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATES = path.join(CLI_PKG_ROOT, 'templates', 'hook-packs', 'shared');
const WT_GUARD = path.join(TEMPLATES, 'worktree-write-guard.sh');
const BASH_GUARD = path.join(TEMPLATES, 'bash-write-guard.sh');

describe('worktree-write-guard: allowlist defers to scope.in (scope priority)', () => {
  const guard = fs.readFileSync(WT_GUARD, 'utf8');

  test('the allowlist no longer exits 0 unconditionally', () => {
    // The old code had `caws_is_write_allowlisted ... exit 0`. The fix records
    // a flag (_PATH_ALLOWLISTED=1) instead, so the path reaches the scope check.
    expect(guard).toMatch(/_PATH_ALLOWLISTED=1/);
    // The unconditional exit 0 inside the allowlist block is gone.
    expect(guard).not.toMatch(/caws_is_write_allowlisted[^\n]*\n[^\n]*exit 0/);
  });

  test('the allowlist gates on SPEC_CONTENTION_CHECK after the scope check', () => {
    // After the scope-contention check computes SPEC_CONTENTION_CHECK, an
    // allowlisted path exits 0 ONLY on clear/unknown — NOT on claimed.
    expect(guard).toMatch(/_PATH_ALLOWLISTED.*==.*1/);
    expect(guard).toMatch(/SPEC_CONTENTION_CHECK/);
    // The claimed case falls through (does NOT exit 0); clear/unknown exits 0.
    expect(guard).toMatch(/claimed:\*\)/);
  });

  test('the guard references CAWS-GUARD-SCOPE-PRIORITY-001 (the gating rationale)', () => {
    expect(guard).toMatch(/CAWS-GUARD-SCOPE-PRIORITY-001/);
  });
});

describe('bash-write-guard: allowlist defers to oracle claim verdict (scope priority)', () => {
  const guard = fs.readFileSync(BASH_GUARD, 'utf8');

  test('the allowlist records a per-target flag instead of skipping the oracle', () => {
    // The old code had `continue` (skip oracle entirely) for allowlisted paths.
    // The fix records _CAND_ALLOWLISTED and still runs the oracle, so a CLAIM
    // on a docs/** path still escalates (block_claimed).
    expect(guard).toMatch(/_CAND_ALLOWLISTED/);
    // The unconditional `continue` for allowlisted paths is gone.
    expect(guard).not.toMatch(/caws_is_write_allowlisted[^\n]*\n[^\n]*continue/);
  });

  test('an allowlisted path does NOT escalate on ask/error (only on claim/ownership)', () => {
    // In the ask_uncertain|error_fail_closed case, an allowlisted path skips
    // escalation (the allowlist permits on non-claim verdicts). Only
    // block_claimed/block_foreign_worktree escalate regardless of allowlist.
    expect(guard).toMatch(/_CAND_ALLOWLISTED.*==.*1/);
  });

  test('the guard references CAWS-GUARD-SCOPE-PRIORITY-001', () => {
    expect(guard).toMatch(/CAWS-GUARD-SCOPE-PRIORITY-001/);
  });
});

describe('caws_is_write_allowlisted: verdicts unchanged (gating is in the guard, not the helper)', () => {
  // The helper still returns the same allow/deny answer. The scope-priority
  // gating happens in the GUARD (which consults scope contention / the oracle
  // AFTER the helper), not in the helper itself. This re-confirms the helper
  // is a pure path-classification function.
  const { execFileSync } = require('child_process');
  const ALLOWLIST_LIB = path.join(TEMPLATES, 'lib', 'write-allowlist.sh');
  const AGENT_SURFACE = path.join(TEMPLATES, 'lib', 'agent-surface.sh');

  function probe(surface, filePath) {
    const script = `
      unset _CAWS_AGENT_SURFACE_SH_LOADED
      export CAWS_AGENT_SURFACE=${JSON.stringify(surface)}
      export HOME="/fake/home"
      source ${JSON.stringify(AGENT_SURFACE)} 2>/dev/null
      source ${JSON.stringify(ALLOWLIST_LIB)}
      if caws_is_write_allowlisted ${JSON.stringify(filePath)} "/fake/proj"; then echo ALLOW; else echo DENY; fi
    `;
    return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
  }

  test('docs/* still ALLOWS at the helper level (the guard gates, not the helper)', () => {
    expect(probe('zcode', '/fake/proj/docs/foo.md')).toBe('ALLOW');
  });

  test('.caws/* (non-payload) still ALLOWS at the helper level', () => {
    expect(probe('zcode', '/fake/proj/.caws/policy.yaml')).toBe('ALLOW');
  });

  test('payload still DENIES at the helper level (ownership-checked by oracle)', () => {
    expect(probe('zcode', '/fake/proj/.caws/worktrees/wt-a/payload.txt')).toBe('DENY');
  });

  test('src/* still DENIES at the helper level', () => {
    expect(probe('zcode', '/fake/proj/src/foo.ts')).toBe('DENY');
  });
});
