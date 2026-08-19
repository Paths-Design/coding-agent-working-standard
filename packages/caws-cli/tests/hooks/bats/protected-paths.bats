#!/usr/bin/env bats
# protected-paths.sh — hook-script edit protection (failure-lineage E23: the
# doctrine "hooks cannot be edited by an agent" had no enforcement).
#
# CAWS-TEST-HOOKS-BASH-001. Blocks Write/Edit to guard SCRIPTS under
# .caws/hooks/ (the shared pack's real install directory for every agent
# surface) and <vendor>/hooks/ (fail-closed: an unrecognized extension
# defaults to protected), but ADMITS *.md docs under either dir
# (CAWS-PROTECTED-PATHS-DOCS-NOT-SCRIPTS-001 — the installer-managed CLAUDE.md /
# README.md are documentation, not guard artifacts). Tests assert the
# script-vs-doc partition by exit code, and assert the BLOCK cases against the
# exact status 2 the Claude Code PreToolUse protocol treats as a block (a
# bare assert_failure also passes on exit 1, which does not actually block).
#
# CAWS_AGENT_SURFACE=claude-code => CAWS_VENDOR_DIR=.claude, so the vendor
# protected dir is .claude/hooks/. CAWS_TEST_HOOKS_DIR (the real, installed
# guard directory every test in this file exercises via run_guard) is
# .caws/hooks/ regardless of surface — see the .caws/hooks/ coverage tests
# below for the distinction.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

@test "protected-paths: editing a guard SCRIPT under .claude/hooks/ is blocked with exit 2" {
  run_guard protected-paths.sh "$(hook_envelope Edit '.claude/hooks/scope-guard.sh')"
  # Exact status, not just non-zero: the Claude Code PreToolUse protocol
  # treats ONLY exit 2 as a block, so a plain assert_failure (which also
  # passes on exit 1) would not have caught the exit-1 defect this guard
  # used to have on its fail-closed branch.
  assert_failure 2
  assert_output --partial 'protected'
}

@test "protected-paths: a NEW unknown-extension file under .claude/hooks/ is blocked (fail-closed) with exit 2" {
  run_guard protected-paths.sh "$(hook_envelope Write '.claude/hooks/sneaky')"
  assert_failure 2
}

# --- .caws/hooks/ coverage (CAWS-HOOKPACK-PROTECTED-PATHS-CAWS-HOOKS-COVERAGE-01) ---
# The shared pack installs every executable guard to .caws/hooks/ for every
# agent surface, independent of CAWS_VENDOR_DIR. CAWS_TEST_HOOKS_DIR (set by
# caws_install_pack_once) is exactly this real install directory, so these
# tests target the actual path a live guard script lives at, not just the
# vendor-dir convention the earlier tests above exercise.

@test "protected-paths: editing a guard SCRIPT under .caws/hooks/ (the real install dir) is blocked with exit 2" {
  run_guard protected-paths.sh "$(hook_envelope Edit '.caws/hooks/scope-guard.sh')"
  # Before the .caws/hooks/ coverage fix, _hooks_prefix_match never matched
  # this path (it only checked the vendor-dir clause), so this Write/Edit
  # was silently admitted despite targeting a real, installed guard script.
  assert_failure 2
  assert_output --partial 'protected'
}

@test "protected-paths: a *.md doc under .caws/hooks/ is still admitted after the coverage fix" {
  run_guard protected-paths.sh "$(hook_envelope Edit '.caws/hooks/CLAUDE.md')"
  assert_success
  refute_output --partial '"decision": "block"'
}

@test "protected-paths: a *.md doc under .claude/hooks/ is ADMITTED (docs-not-scripts)" {
  run_guard protected-paths.sh "$(hook_envelope Edit '.claude/hooks/CLAUDE.md')"
  assert_success
  refute_output --partial '"decision": "block"'
}

@test "protected-paths: a README.md under .claude/hooks/ is admitted" {
  run_guard protected-paths.sh "$(hook_envelope Write '.claude/hooks/README.md')"
  assert_success
}

@test "protected-paths: a file OUTSIDE the hooks dir is admitted" {
  run_guard protected-paths.sh "$(hook_envelope Edit 'src/index.ts')"
  assert_success
}

@test "protected-paths: a non-Write/Edit tool is ignored" {
  run_guard protected-paths.sh "$(hook_envelope Bash '' 'cat .claude/hooks/scope-guard.sh')"
  assert_success
}

# --- missing load-bearing lib must fail CLOSED, not silently admit a hook edit ---
# CAWS-HOOK-SOURCE-GUARD-FAIL-SOFT-001. protected-paths sources agent-surface.sh
# for CAWS_VENDOR_DIR (the protected-dir prefix). Under `set -euo pipefail` the
# old `source <missing> 2>/dev/null || true` died at the source line, so a Write
# to a guard script silently passed — defeating the hook-edit protection.

@test "protected-paths: with agent-surface.sh missing, an edit to a guard SCRIPT does NOT silently pass — fails CLOSED" {
  run_guard_missing_lib protected-paths.sh agent-surface.sh "$(hook_envelope Edit '.claude/hooks/scope-guard.sh')"
  refute [ "$status" -eq 0 ]
  assert_output --partial 'agent-surface.sh'
}
