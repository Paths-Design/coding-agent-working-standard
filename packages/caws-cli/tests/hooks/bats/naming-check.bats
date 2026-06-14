#!/usr/bin/env bats
# naming-check.sh — shadow-file advisory (failure-lineage E2 shadow-file
# proliferation, E25 "no shadow files" was doctrine with no hook).
#
# CAWS-TEST-HOOKS-BASH-001. The guard is ADVISORY (always exit 0); when a
# Write/Edit targets a shadow-file name (*-enhanced, *-new, *-v2, *-final,
# *-copy, _ variants), it emits an additionalContext message. Tests assert the
# actual emitted text + exit 0, and that a normal filename is silent. This is
# the guard the "see, tainted" incident bent — pinned here so prod can never be
# bent to a test again.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

@test "naming-check: a shadow file (*-v2) is flagged (advisory, exit 0)" {
  run_guard naming-check.sh "$(hook_envelope Write 'src/foo-v2.ts')"
  assert_success
  assert_output --partial 'naming-check:'
  assert_output --partial 'shadow'
}

@test "naming-check: *-enhanced is flagged" {
  run_guard naming-check.sh "$(hook_envelope Write 'src/parser-enhanced.ts')"
  assert_success
  assert_output --partial 'shadow'
}

@test "naming-check: *-copy is flagged" {
  run_guard naming-check.sh "$(hook_envelope Write 'src/config-copy.json')"
  assert_output --partial 'shadow'
}

@test "naming-check: a NORMAL filename is silent (no shadow advisory)" {
  run_guard naming-check.sh "$(hook_envelope Write 'src/parser.ts')"
  assert_success
  refute_output --partial 'shadow'
}

@test "naming-check: a non-Write/Edit tool is ignored (exit 0, no advisory)" {
  run_guard naming-check.sh "$(hook_envelope Bash '' 'ls -la')"
  assert_success
  refute_output --partial 'shadow'
}

@test "naming-check: an empty file_path is ignored (exit 0)" {
  run_guard naming-check.sh "$(hook_envelope Write '')"
  assert_success
  refute_output --partial 'shadow'
}
