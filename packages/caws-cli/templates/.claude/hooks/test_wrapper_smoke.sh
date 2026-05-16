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
echo "=========================================="
echo "Results: $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
else
  echo "ALL WRAPPER SMOKE TESTS PASSED"
  exit 0
fi
