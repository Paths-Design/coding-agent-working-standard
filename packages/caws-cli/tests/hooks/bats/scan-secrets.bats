#!/usr/bin/env bats
# scan-secrets.sh — secret-bearing-content advisory (failure-lineage E24:
# reading/writing secret-bearing files without a redaction reminder).
#
# CAWS-TEST-HOOKS-BASH-001. Advisory (exit 0); scans Write/Edit tool_input
# content for high-confidence secret patterns (private key material, AWS access
# keys AKIA..., GitHub tokens ghp_...). Tests use SYNTHETIC secrets only (clearly
# fake, pattern-matching) and assert the advisory fires on a hit and stays silent
# on clean content — proving the redaction-reminder path stays live (E24).

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

@test "scan-secrets: a synthetic AWS access key triggers the advisory" {
  # AKIA + 16 uppercase/digits — fake but matches the AKIA[0-9A-Z]{16} pattern.
  run_guard scan-secrets.sh "$(hook_envelope_content Write 'src/cfg.ts' 'const k = "AKIAIOSFODNN7EXAMPLE";')"
  assert_success
  assert_output --partial 'scan-secrets:'
  assert_output --partial 'AWS access key'
}

@test "scan-secrets: a synthetic GitHub token triggers the advisory" {
  # ghp_ + 36+ chars — fake but matches gh[pousr]_[A-Za-z0-9_]{36,}.
  run_guard scan-secrets.sh "$(hook_envelope_content Write 'src/cfg.ts' 'token = ghp_0123456789012345678901234567890123456789')"
  assert_output --partial 'GitHub token'
}

@test "scan-secrets: PRIVATE_KEY material triggers the advisory" {
  run_guard scan-secrets.sh "$(hook_envelope_content Write 'src/key.ts' '-----BEGIN PRIVATE_KEY-----')"
  assert_output --partial 'private key material'
}

@test "scan-secrets: clean content is silent (no advisory)" {
  run_guard scan-secrets.sh "$(hook_envelope_content Write 'src/cfg.ts' 'export const greeting = "hello world";')"
  assert_success
  refute_output --partial 'scan-secrets:'
}

@test "scan-secrets: a non-Write/Edit tool is ignored" {
  run_guard scan-secrets.sh "$(hook_envelope Bash '' 'echo hi')"
  assert_success
  refute_output --partial 'scan-secrets:'
}

@test "scan-secrets: content under a node_modules path is skipped (no advisory even with a key)" {
  # The skip pattern is */node_modules/* — needs a leading path segment.
  run_guard scan-secrets.sh "$(hook_envelope_content Write 'vendor/node_modules/pkg/x.js' 'AKIAIOSFODNN7EXAMPLE')"
  assert_success
  refute_output --partial 'scan-secrets:'
}
