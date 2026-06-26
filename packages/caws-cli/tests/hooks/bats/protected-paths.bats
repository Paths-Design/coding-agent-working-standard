#!/usr/bin/env bats
# protected-paths.sh — hook-script edit protection (failure-lineage E23: the
# doctrine "hooks cannot be edited by an agent" had no enforcement).
#
# CAWS-TEST-HOOKS-BASH-001. Blocks Write/Edit to guard SCRIPTS under
# <vendor>/hooks/ (fail-closed: an unrecognized extension defaults to
# protected), but ADMITS *.md docs under the same dir
# (CAWS-PROTECTED-PATHS-DOCS-NOT-SCRIPTS-001 — the installer-managed CLAUDE.md /
# README.md are documentation, not guard artifacts). Tests assert the
# script-vs-doc partition by exit code.
#
# CAWS_AGENT_SURFACE=claude-code => CAWS_VENDOR_DIR=.claude, so the protected
# dir is .claude/hooks/.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

@test "protected-paths: editing a guard SCRIPT under .claude/hooks/ is blocked" {
  run_guard protected-paths.sh "$(hook_envelope Edit '.claude/hooks/scope-guard.sh')"
  assert_failure
  assert_output --partial 'protected'
}

@test "protected-paths: a NEW unknown-extension file under .claude/hooks/ is blocked (fail-closed)" {
  run_guard protected-paths.sh "$(hook_envelope Write '.claude/hooks/sneaky')"
  assert_failure
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
