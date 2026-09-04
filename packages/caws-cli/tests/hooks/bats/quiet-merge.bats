#!/usr/bin/env bats
# quiet-merge updatedInput runtime contract (CAWS-CODEX-HOOK-RUNTIME-CONTRACT-001).
#
# quiet-merge rewrites `caws worktree merge|destroy` commands via an
# updatedInput envelope on surfaces with CAWS_SUPPORTS_UPDATED_INPUT=1. Hosts
# that enforce the contract reject a rewrite carrying no explicit permission
# decision (observed live: "PreToolUse hook returned updatedInput without
# permissionDecision:allow"). These tests pin the envelope shape:
# permissionDecision "allow" + reason + updatedInput, and the no-rewrite
# behavior on opted-out surfaces stays intact. The emitted command is executed
# against a failing stand-in so a trailing successful command, a pipeline that
# loses the governed status, or stderr suppression makes this suite fail.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

assert_rewrite_preserves_governed_failure() {
  local governed_command="$1"
  local rewritten fake_bin

  run_guard "quiet-merge.sh" "$(hook_envelope 'Bash' '' "$governed_command")"
  assert_success
  rewritten="$(printf '%s' "$output" | jq -r '.hookSpecificOutput.updatedInput.command')"

  fake_bin="$(mktemp -d "${TMPDIR:-/tmp}/caws-quiet-merge-bin-XXXXXX")"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "governed stdout: %s\\n" "$*"' \
    'printf "governed stderr: %s\\n" "$*" >&2' \
    'exit 23' > "$fake_bin/caws"
  chmod +x "$fake_bin/caws"

  run env PATH="$fake_bin:$PATH" bash -c "$rewritten"
  rm -rf "$fake_bin"

  assert_failure 23
  assert_output --partial "governed stdout:"
  assert_output --partial "governed stderr:"
}

@test "quiet-merge: rewrite envelope carries permissionDecision allow alongside updatedInput" {
  run_guard "quiet-merge.sh" "$(hook_envelope 'Bash' '' 'caws worktree merge wt-x')"
  assert_success
  assert_output --partial '"permissionDecision":"allow"'
  assert_output --partial '"permissionDecisionReason"'
  assert_output --partial '"updatedInput"'
  # The envelope is valid JSON with the expected decision (jq is a hook-pack
  # dependency — quiet-merge itself shells out to it).
  decision="$(printf '%s' "$output" | jq -r '.hookSpecificOutput.permissionDecision')"
  [[ "$decision" == "allow" ]]
  rewritten="$(printf '%s' "$output" | jq -r '.hookSpecificOutput.updatedInput.command')"
  [[ "$rewritten" == "cd \"$CAWS_TEST_REPO\" && caws worktree merge wt-x" ]]
  [[ "$rewritten" != *'2>/dev/null'* ]]
  [[ "$rewritten" != *'git log'* ]]
}

@test "quiet-merge: rewritten merge preserves a governed failure status and diagnostics" {
  assert_rewrite_preserves_governed_failure 'caws worktree merge wt-x'
}

@test "quiet-merge: rewritten destroy preserves a governed failure status and diagnostics" {
  assert_rewrite_preserves_governed_failure 'caws worktree destroy wt-x'
}

@test "quiet-merge: destroy commands get the same allow+rewrite envelope" {
  run_guard "quiet-merge.sh" "$(hook_envelope 'Bash' '' 'caws worktree destroy wt-x')"
  assert_success
  assert_output --partial '"permissionDecision":"allow"'
  assert_output --partial '"updatedInput"'
}

@test "quiet-merge: non-merge Bash commands pass through silently (no envelope)" {
  run_guard "quiet-merge.sh" "$(hook_envelope 'Bash' '' 'git status')"
  assert_success
  refute_output --partial 'updatedInput'
  refute_output --partial 'permissionDecision'
}

@test "quiet-merge: already-piped merge commands are not rewritten" {
  run_guard "quiet-merge.sh" "$(hook_envelope 'Bash' '' 'caws worktree merge wt-x | tail -3')"
  assert_success
  refute_output --partial 'updatedInput'
}

@test "quiet-merge: no envelope under the kimi-code surface (opt-out preserved)" {
  run env -i PATH="$PATH" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="kimi-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c "printf '%s' '{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"caws worktree merge wt-x\"}}' | bash '$CAWS_TEST_HOOKS_DIR/quiet-merge.sh'"
  assert_success
  refute_output --partial 'updatedInput'
  refute_output --partial 'permissionDecision'
}
