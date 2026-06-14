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
