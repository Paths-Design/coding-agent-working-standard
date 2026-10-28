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
  caws_install_pack_once codex
}
teardown_file() {
  caws_teardown_pack
}

run_codex_scan() {
  local envelope="$1"
  shift
  run env -i HOME="$CAWS_TEST_HOME" PATH="$PATH" LC_ALL="${LC_ALL:-C}" \
    CAWS_HOME="$CAWS_TEST_HOME/.caws" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" CAWS_AGENT_SURFACE=codex \
    CAWS_SESSION_ID="$CAWS_TEST_SESSION_ID" \
    CAWS_SCAN_GREP_COUNT="${CAWS_SCAN_GREP_COUNT:-}" \
    /bin/bash -c 'cd "$1" && source "$1/.codex/hooks/lib/parse-input.sh" && HOOK_INPUT_JSON="$2" && parse_hook_input && exec /bin/bash "${@:4}" "$3"' _ \
    "$CAWS_TEST_REPO" "$envelope" "$CAWS_TEST_HOOKS_DIR/scan-secrets.sh" "$@"
}

scan_context() {
  printf '%s' "$output" | jq -r '.hookSpecificOutput.additionalContext'
}

@test "scan-secrets: line and category order retain repeats without leaking synthetic values" {
  local content context expected
  content=$'private_key AKIAIOSFODNN7EXAMPLE ghp_0123456789012345678901234567890123456789\nPRIVATE_KEY ghp_0123456789012345678901234567890123456789\nAKIAIOSFODNN7EXAMPLE AKIAIOSFODNN7EXAMPLE'
  run_codex_scan "$(hook_envelope_content Write 'src/cfg.ts' "$content")"
  assert_success
  context="$(scan_context)"
  expected="$(cat <<'EXPECTED'
scan-secrets: possible secret detected in 'cfg.ts':
  • private key material
  • possible AWS access key
  • possible GitHub token
  • private key material
  • possible GitHub token
  • possible AWS access key
Do not commit credentials. Use environment variables or a secrets manager. (Advisory — allowed.)
EXPECTED
)"
  assert_equal "$context" "$expected"
  [[ "$context" != *'AKIAIOSFODNN7EXAMPLE'* ]]
  [[ "$context" != *'ghp_0123456789012345678901234567890123456789'* ]]
}

@test "scan-secrets: token thresholds and case remain distinct from private-key nocasematch" {
  local content context
  content=$'Private_Key\nakiaIOSFODNN7EXAMPLE\nGhP_0123456789012345678901234567890123456789\nAKIA123456789012345\nghp_01234567890123456789012345678901234\nghz_0123456789012345678901234567890123456789'
  run_codex_scan "$(hook_envelope_content Write 'src/cfg.ts' "$content")"
  assert_success
  assert_output ''
  run_codex_scan "$(hook_envelope_content Write 'src/cfg.ts' "$content")" -O nocasematch
  assert_success
  context="$(scan_context)"
  [[ "$context" == *'private key material'* ]]
  [[ "$context" != *'AWS access key'* ]]
  [[ "$context" != *'GitHub token'* ]]
  content=$'AKIA1234567890123456 ghp_012345678901234567890123456789012345\nPrivate_Key\nakia1234567890123456 GhP_012345678901234567890123456789012345'
  run_codex_scan "$(hook_envelope_content Write 'src/cfg.ts' "$content")" -O nocasematch
  assert_success
  context="$(scan_context)"
  assert_equal "$(printf '%s' "$context" | grep -c 'AWS access key')" 1
  assert_equal "$(printf '%s' "$context" | grep -c 'GitHub token')" 1
  assert_equal "$(printf '%s' "$context" | grep -c 'private key material')" 1
}

@test "scan-secrets: new_string and existing-file fallback preserve content precedence" {
  local target envelope
  target="$BATS_TEST_TMPDIR/existing.ts"
  printf '%s\n' 'AKIAIOSFODNN7EXAMPLE' > "$target"
  envelope="$(jq -nc --arg f "$target" '{tool_name:"Edit",tool_input:{file_path:$f,new_string:"PRIVATE_KEY"}}')"
  run_codex_scan "$envelope"
  assert_success
  assert_output --partial 'private key material'
  refute_output --partial 'AWS access key'
  envelope="$(jq -nc --arg f "$target" '{tool_name:"Edit",tool_input:{file_path:$f,content:"clean",new_string:"PRIVATE_KEY"}}')"
  run_codex_scan "$envelope"
  assert_success
  assert_output ''
  envelope="$(jq -nc --arg f "$target" '{tool_name:"Edit",tool_input:{file_path:$f}}')"
  run_codex_scan "$envelope"
  assert_success
  assert_output --partial 'AWS access key'
}

@test "scan-secrets: existing-file patch scan has no per-line grep subprocesses and reaches the last line" {
  local real_path wrapper target patch envelope line_count index
  real_path="$PATH"
  wrapper="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$wrapper"
  cat > "$wrapper/grep" <<'SH'
#!/bin/bash
for argument in "$@"; do
  case "$argument" in
    'AKIA[0-9A-Z]{16}'|'gh[pousr]_[A-Za-z0-9_]{36,}')
      printf 'scan\n' >> "$CAWS_SCAN_GREP_COUNT" ;;
  esac
done
exec /usr/bin/grep "$@"
SH
  chmod +x "$wrapper/grep"
  export CAWS_SCAN_GREP_COUNT="$BATS_TEST_TMPDIR/grep-count"
  PATH="$wrapper:$real_path"
  target="$BATS_TEST_TMPDIR/existing.ts"
  for line_count in 1 128 5301; do
    : > "$CAWS_SCAN_GREP_COUNT"
    : > "$target"
    for ((index=1; index<line_count; index++)); do printf '%s\n' 'ordinary source text é 漢字' >> "$target"; done
    printf '%s\n' 'AKIAIOSFODNN7EXAMPLE' >> "$target"
    patch="$(printf '*** Begin Patch\n*** Update File: %s\n@@\n-old\n+new\n*** End Patch\n' "$target")"
    envelope="$(jq -nc --arg cwd "$CAWS_TEST_REPO" --arg sid "$CAWS_TEST_SESSION_ID" --arg command "$patch" '{session_id:$sid,cwd:$cwd,tool_name:"apply_patch",tool_input:{command:$command}}')"
    run_codex_scan "$envelope"
    assert_success
    assert_output --partial 'AWS access key'
    [[ ! -s "$CAWS_SCAN_GREP_COUNT" ]] || {
      printf 'scanner launched %s grep processes for %s lines\n' "$(wc -l < "$CAWS_SCAN_GREP_COUNT")" "$line_count" >&2
      return 1
    }
    assert_equal "$(wc -l < "$target" | tr -d ' ')" "$line_count"
  done
  PATH="$real_path"
}

@test "scan-secrets: Codex PreToolUse advisory names its invoking event and redacts the value" {
  local synthetic_key envelope event context
  synthetic_key='AKIAIOSFODNN7EXAMPLE'
  envelope="$(hook_envelope_content Write 'src/cfg.ts' "const key = '$synthetic_key';")"

  run env -i PATH="$PATH" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="codex" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c "printf '%s' '$envelope' | bash '$CAWS_TEST_HOOKS_DIR/scan-secrets.sh'"

  assert_success
  event="$(printf '%s' "$output" | jq -r '.hookSpecificOutput.hookEventName')"
  context="$(printf '%s' "$output" | jq -r '.hookSpecificOutput.additionalContext')"
  assert_equal "$event" "PreToolUse"
  [[ "$context" == *"possible AWS access key"* ]] || return 1
  [[ "$context" != *"$synthetic_key"* ]] || return 1
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
