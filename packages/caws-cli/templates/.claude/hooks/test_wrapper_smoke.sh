#!/bin/bash
# Smoke tests for block-dangerous.sh shell wrapper.
# Feeds synthetic PreToolUse JSON and asserts the output JSON shape.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/block-dangerous.sh"

PASS=0
FAIL=0

run_test() {
  local name="$1"
  local command="$2"
  local expected_decision="$3"
  local project_dir
  project_dir="$(mktemp -d)"
  mkdir -p "$project_dir/.claude/hooks/state"

  local input
  input=$(jq -n --arg cmd "$command" --arg session "smoke-$RANDOM" '{
    session_id: $session,
    tool_name: "Bash",
    tool_input: { command: $cmd }
  }')

  local output
  output=$(cd "$project_dir" && printf '%s' "$input" | CLAUDE_PROJECT_DIR="$project_dir" bash "$HOOK" 2>/dev/null) || true

  if [[ -z "$output" ]]; then
    # No output = allow (hook exits 0 with no JSON)
    if [[ "$expected_decision" == "allow" ]]; then
      echo "  [PASS] $name"
      PASS=$((PASS + 1))
    else
      echo "  [FAIL] $name: expected=$expected_decision, got=allow (no output)"
      FAIL=$((FAIL + 1))
    fi
    return
  fi

  local decision
  decision=$(printf '%s' "$output" | jq -r '.decision // .hookSpecificOutput.permissionDecision // "missing"')
  if [[ "$decision" == "block" ]]; then
    decision="deny"
  fi
  local reason
  reason=$(printf '%s' "$output" | jq -r '.hookSpecificOutput.permissionDecisionReason // ""')
  local event
  event=$(printf '%s' "$output" | jq -r '.hookSpecificOutput.hookEventName // "missing"')

  # Verify JSON shape. Block decisions use Claude's top-level decision shape;
  # permission prompts use hookSpecificOutput.
  if [[ "$event" != "PreToolUse" ]] && [[ "$expected_decision" != "allow" ]] && [[ "$decision" != "deny" ]]; then
    echo "  [FAIL] $name: hookEventName=$event, expected=PreToolUse"
    FAIL=$((FAIL + 1))
    return
  fi

  if [[ "$decision" == "$expected_decision" ]]; then
    echo "  [PASS] $name (reason: $reason)"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] $name: expected=$expected_decision, got=$decision (reason: $reason)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Wrapper smoke tests ==="

# Allow cases
run_test "normal command" "ls -la" "allow"
run_test "cargo test" "cargo test --workspace" "allow"
run_test "safe rm" "rm -rf target/debug" "allow"

# Deny cases
run_test "rm root" "rm -rf /" "deny"
run_test "dd zero" "dd if=/dev/zero of=/dev/sda" "deny"

# Ask cases
run_test "git reset hard" "git reset --hard" "ask"
run_test "rm src" "rm -rf src/" "ask"
run_test "git init" "git init" "ask"
run_test "git bare init" "git --bare init" "ask"
run_test "nested git init" "bash -lc 'git --bare init'" "ask"
run_test "env split git init" "env -S \"git --bare init\"" "ask"
run_test "git alias init" "git -c alias.x=init x" "ask"
run_test "quoted git init mention" "echo \"git init\"" "allow"

TRUSTED_PROJECT="$(mktemp -d)"
TRUSTED_NONCE="trusted-smoke-123"
mkdir -p "$TRUSTED_PROJECT/.claude/hooks/state"
touch "$TRUSTED_PROJECT/.claude/hooks/state/allow-git-init-$TRUSTED_NONCE"
TRUSTED_INPUT=$(jq -n '{
  session_id: "smoke-trusted",
  tool_name: "Bash",
  tool_input: { command: "git --bare init" }
}')
TRUSTED_OUTPUT=$(cd "$TRUSTED_PROJECT" && printf '%s' "$TRUSTED_INPUT" | \
  CLAUDE_PROJECT_DIR="$TRUSTED_PROJECT" \
  CAWS_TRUSTED_WORKTREE_CREATE_CONTEXT=1 \
  CAWS_TRUSTED_HOOK_NONCE="$TRUSTED_NONCE" \
  bash "$HOOK" 2>/dev/null) || true
if [[ -z "$TRUSTED_OUTPUT" ]]; then
  echo "  [PASS] trusted git init token allows git init"
  PASS=$((PASS + 1))
else
  echo "  [FAIL] trusted git init token should allow, got: $TRUSTED_OUTPUT"
  FAIL=$((FAIL + 1))
fi

# Second invocation with the SAME nonce: token must be consumed,
# so this attempt should ask (and latch).
SECOND_TRUSTED_PROJECT="$(mktemp -d)"
SECOND_TRUSTED_OUTPUT=$(cd "$SECOND_TRUSTED_PROJECT" && printf '%s' "$TRUSTED_INPUT" | \
  CLAUDE_PROJECT_DIR="$SECOND_TRUSTED_PROJECT" \
  CAWS_TRUSTED_WORKTREE_CREATE_CONTEXT=1 \
  CAWS_TRUSTED_HOOK_NONCE="$TRUSTED_NONCE" \
  bash "$HOOK" 2>/dev/null) || true
SECOND_TRUSTED_DECISION=$(printf '%s' "$SECOND_TRUSTED_OUTPUT" | jq -r '.hookSpecificOutput.permissionDecision // .decision // "missing"')
if [[ "$SECOND_TRUSTED_DECISION" == "ask" ]]; then
  echo "  [PASS] trusted token is one-shot (second invocation asks)"
  PASS=$((PASS + 1))
else
  echo "  [FAIL] trusted token reused: second invocation should ask, got: $SECOND_TRUSTED_DECISION"
  FAIL=$((FAIL + 1))
fi

# Token consumed in the original project too — re-running git init there
# should now ask, not allow.
TRUSTED_INPUT_RETRY=$(jq -n '{
  session_id: "smoke-trusted-retry",
  tool_name: "Bash",
  tool_input: { command: "git --bare init" }
}')
TRUSTED_RETRY_OUTPUT=$(cd "$TRUSTED_PROJECT" && printf '%s' "$TRUSTED_INPUT_RETRY" | \
  CLAUDE_PROJECT_DIR="$TRUSTED_PROJECT" \
  CAWS_TRUSTED_WORKTREE_CREATE_CONTEXT=1 \
  CAWS_TRUSTED_HOOK_NONCE="$TRUSTED_NONCE" \
  bash "$HOOK" 2>/dev/null) || true
TRUSTED_RETRY_DECISION=$(printf '%s' "$TRUSTED_RETRY_OUTPUT" | jq -r '.hookSpecificOutput.permissionDecision // .decision // "missing"')
if [[ "$TRUSTED_RETRY_DECISION" == "ask" ]]; then
  echo "  [PASS] trusted token is one-shot (retry in same project asks)"
  PASS=$((PASS + 1))
else
  echo "  [FAIL] trusted token retry: expected ask, got: $TRUSTED_RETRY_DECISION"
  FAIL=$((FAIL + 1))
fi

# Latch behavior: first dangerous command asks, second Bash command blocks.
LATCH_PROJECT="$(mktemp -d)"
LATCH_SESSION="smoke-latch"
FIRST_INPUT=$(jq -n --arg session "$LATCH_SESSION" '{
  session_id: $session,
  tool_name: "Bash",
  tool_input: { command: "git init" }
}')
SECOND_INPUT=$(jq -n --arg session "$LATCH_SESSION" '{
  session_id: $session,
  tool_name: "Bash",
  tool_input: { command: "git status" }
}')
FIRST_OUTPUT=$(cd "$LATCH_PROJECT" && printf '%s' "$FIRST_INPUT" | CLAUDE_PROJECT_DIR="$LATCH_PROJECT" bash "$HOOK" 2>/dev/null) || true
SECOND_OUTPUT=$(cd "$LATCH_PROJECT" && printf '%s' "$SECOND_INPUT" | CLAUDE_PROJECT_DIR="$LATCH_PROJECT" bash "$HOOK" 2>/dev/null) || true
FIRST_DECISION=$(printf '%s' "$FIRST_OUTPUT" | jq -r '.hookSpecificOutput.permissionDecision // "missing"')
SECOND_DECISION=$(printf '%s' "$SECOND_OUTPUT" | jq -r '.decision // "missing"')
if [[ "$FIRST_DECISION" == "ask" ]] && [[ "$SECOND_DECISION" == "block" ]]; then
  echo "  [PASS] danger latch blocks subsequent Bash"
  PASS=$((PASS + 1))
else
  echo "  [FAIL] danger latch: first=$FIRST_DECISION second=$SECOND_DECISION"
  FAIL=$((FAIL + 1))
fi

# Non-Bash tool should pass through (no output)
NON_BASH_INPUT='{"tool_name":"Read","tool_input":{"file_path":"/etc/passwd"}}'
NON_BASH_OUTPUT=$(printf '%s' "$NON_BASH_INPUT" | bash "$HOOK" 2>/dev/null) || true
if [[ -z "$NON_BASH_OUTPUT" ]]; then
  echo "  [PASS] non-Bash tool passthrough"
  PASS=$((PASS + 1))
else
  echo "  [FAIL] non-Bash tool should produce no output, got: $NON_BASH_OUTPUT"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== reset-danger-latch.sh ergonomics ==="

# These tests intentionally invoke reset-danger-latch.sh with cases that
# exit non-zero (exit 2 is the expected outcome for several scenarios).
# `set -e` would kill the test runner the first time a sub-bash returns
# non-zero, so disable it for this block.
set +e

RESET_SCRIPT="$SCRIPT_DIR/reset-danger-latch.sh"

reset_test() {
  local name="$1"
  local expected_exit="$2"
  local actual_exit="$3"
  local expected_pattern="$4"
  local actual_output="$5"

  if [[ "$actual_exit" != "$expected_exit" ]]; then
    echo "  [FAIL] $name: expected exit $expected_exit, got $actual_exit"
    echo "         output: $actual_output"
    FAIL=$((FAIL + 1))
    return
  fi
  if [[ -n "$expected_pattern" ]] && ! printf '%s' "$actual_output" | grep -qE -- "$expected_pattern"; then
    echo "  [FAIL] $name: output did not match /$expected_pattern/"
    echo "         output: $actual_output"
    FAIL=$((FAIL + 1))
    return
  fi
  echo "  [PASS] $name"
  PASS=$((PASS + 1))
}

# Case A: --current with no session env and no latches present
T_A=$(mktemp -d)
mkdir -p "$T_A/.claude/hooks/state" "$T_A/.claude/logs"
A_OUT=$(CLAUDE_PROJECT_DIR="$T_A" CLAUDE_SESSION_ID="" HOOK_SESSION_ID="" \
  bash "$RESET_SCRIPT" --current --reason "smoke A" 2>&1); A_EXIT=$?
reset_test "reset --current with no env+no latch -> exit 2" "2" "$A_EXIT" "No danger latch files found" "$A_OUT"

# Case B: --current with no session env and exactly one latch present
T_B=$(mktemp -d)
mkdir -p "$T_B/.claude/hooks/state" "$T_B/.claude/logs"
echo '{}' > "$T_B/.claude/hooks/state/danger-latch-solo.json"
B_OUT=$(CLAUDE_PROJECT_DIR="$T_B" CLAUDE_SESSION_ID="" HOOK_SESSION_ID="" \
  bash "$RESET_SCRIPT" --current --reason "smoke B" 2>&1); B_EXIT=$?
reset_test "reset --current with no env+one latch -> exit 0" "0" "$B_EXIT" "Reset 1 danger latch" "$B_OUT"
if [[ -f "$T_B/.claude/hooks/state/danger-latch-solo.json" ]]; then
  echo "  [FAIL] reset --current did not unlink the inferred latch"
  FAIL=$((FAIL + 1))
fi

# Case C: --current with no session env and multiple latches present
T_C=$(mktemp -d)
mkdir -p "$T_C/.claude/hooks/state" "$T_C/.claude/logs"
echo '{}' > "$T_C/.claude/hooks/state/danger-latch-one.json"
echo '{}' > "$T_C/.claude/hooks/state/danger-latch-two.json"
C_OUT=$(CLAUDE_PROJECT_DIR="$T_C" CLAUDE_SESSION_ID="" HOOK_SESSION_ID="" \
  bash "$RESET_SCRIPT" --current --reason "smoke C" 2>&1); C_EXIT=$?
reset_test "reset --current with no env+multi-latch -> exit 2 listing both" "2" "$C_EXIT" "Multiple latches found" "$C_OUT"
# Both latches must still be present.
if [[ ! -f "$T_C/.claude/hooks/state/danger-latch-one.json" ]] || [[ ! -f "$T_C/.claude/hooks/state/danger-latch-two.json" ]]; then
  echo "  [FAIL] reset --current with multi-latch must not delete anything"
  FAIL=$((FAIL + 1))
fi

# Case D: --session with id that does not match any latch
T_D=$(mktemp -d)
mkdir -p "$T_D/.claude/hooks/state" "$T_D/.claude/logs"
D_OUT=$(CLAUDE_PROJECT_DIR="$T_D" \
  bash "$RESET_SCRIPT" --session "no-such-session" --reason "smoke D" 2>&1); D_EXIT=$?
reset_test "reset --session for nonexistent latch -> exit 2 with diagnostic" "2" "$D_EXIT" "No danger latch matched" "$D_OUT"

# Case E: --current WITH session env id (legacy/normal path) still works
T_E=$(mktemp -d)
mkdir -p "$T_E/.claude/hooks/state" "$T_E/.claude/logs"
echo '{}' > "$T_E/.claude/hooks/state/danger-latch-explicit.json"
E_OUT=$(CLAUDE_PROJECT_DIR="$T_E" CLAUDE_SESSION_ID="explicit" \
  bash "$RESET_SCRIPT" --current --reason "smoke E" 2>&1); E_EXIT=$?
reset_test "reset --current WITH session env -> exit 0" "0" "$E_EXIT" "Reset 1 danger latch" "$E_OUT"

# Case F: --all is still rejected
F_OUT=$(bash "$RESET_SCRIPT" --all --reason "smoke F" 2>&1); F_EXIT=$?
reset_test "reset --all -> exit 2 (still rejected)" "2" "$F_EXIT" "--all is no longer supported" "$F_OUT"

echo ""
echo "=========================================="
echo "Results: $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
else
  echo "ALL WRAPPER SMOKE TESTS PASSED"
  exit 0
fi
