#!/usr/bin/env bats
# qwen-code vendor adapter — shim, surface resolution, and wiring
# (CAWS-HOOK-PACK-QWEN-CODE-001).
#
# Covers the pieces of the qwen-code pack that pure jest layout/fingerprint
# tests cannot:
#   - the pack files install (shim executable at its destPath, doctrine doc,
#     repo-local .qwen/settings.json wiring + example);
#   - agent-surface.sh resolves qwen-code to .qwen / ask / QWEN.md /
#     no-updatedInput;
#   - caws-qwen-hook.sh is INERT outside CAWS repos (the wiring may ride
#     along in any repo that copies .qwen/settings.json — inertness elsewhere
#     is the safety invariant), maps events to dispatchers, and resolves the
#     git root when launched from a subdir;
#   - quiet-merge emits no updatedInput under the qwen-code surface
#     (documented but not enforced in Qwen 0.21.x) while claude-code still
#     rewrites (regression gate);
#   - session-id.sh resolves QWEN_CODE_SESSION_ID.
#
# Unlike kimi, there are NO vendor lib overrides to test: Qwen enforces deny
# and exit-2 blocks natively (verified live on 0.21.4), so the shared emit /
# run-handlers libs are used unchanged.

load helpers

setup_file() {
  [[ -f "$CLI_DIST_ENTRY" ]] || {
    echo "caws-cli dist not built at $CLI_DIST_ENTRY" >&2
    return 1
  }
  local repo
  repo="$(mktemp -d "${TMPDIR:-/tmp}/caws-bats-qwen-XXXXXX")"
  git -C "$repo" init -q -b main
  git -C "$repo" config user.name 'CAWS Test'
  git -C "$repo" config user.email 'test@caws.invalid'
  git -C "$repo" config commit.gpgsign false
  git -C "$repo" commit -q --allow-empty -m 'root commit'
  ( cd "$repo" && CI=true NO_COLOR=1 node "$CLI_DIST_ENTRY" init --agent-surface qwen-code >/dev/null 2>&1 )
  export CAWS_TEST_REPO="$repo"
  export CAWS_TEST_HOOKS_DIR="$repo/.caws/hooks"
  export QWEN_VENDOR_DIR="$repo/.qwen"
  export QWEN_SHIM="$repo/.qwen/hooks/caws-qwen-hook.sh"
}
teardown_file() {
  caws_teardown_pack
}

# --- install layout -----------------------------------------------------------

@test "qwen pack: shim, doctrine doc, and parse-input override install at their destPaths" {
  [[ -x "$QWEN_SHIM" ]]
  [[ -f "$QWEN_VENDOR_DIR/CAWS-HOOKS.md" ]]
  [[ -f "$QWEN_VENDOR_DIR/hooks/lib/parse-input.sh" ]]
}

@test "qwen pack: init wires .qwen/settings.json and writes the example" {
  [[ -f "$QWEN_VENDOR_DIR/settings.json" ]]
  [[ -f "$QWEN_VENDOR_DIR/settings.json.example" ]]
  # All five events present, each entry pointing at the shim.
  for event in PreToolUse PostToolUse SessionStart Stop PreCompact; do
    grep -q "\"$event\"" "$QWEN_VENDOR_DIR/settings.json"
  done
  grep -q 'caws-qwen-hook.sh' "$QWEN_VENDOR_DIR/settings.json"
}

@test "qwen pack: init creates QWEN.md carrying the managed doctrine import" {
  [[ -f "$CAWS_TEST_REPO/QWEN.md" ]]
  grep -q '@.qwen/CAWS-HOOKS.md' "$CAWS_TEST_REPO/QWEN.md"
}

@test "qwen pack: matchers use runtime tool ids" {
  grep -q 'run_shell_command' "$QWEN_VENDOR_DIR/settings.json"
  grep -q 'write_file' "$QWEN_VENDOR_DIR/settings.json"
  # Claude display names must not leak into qwen matchers.
  ! grep -q '"matcher": "Bash' "$QWEN_VENDOR_DIR/settings.json"
}

# --- agent-surface resolution ---------------------------------------------------

@test "agent-surface: qwen-code resolves vendor dir, ask vocab, no updatedInput, QWEN.md" {
  run env -i PATH="$PATH" \
    CAWS_AGENT_SURFACE="qwen-code" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    bash -c "source '$CAWS_TEST_HOOKS_DIR/lib/agent-surface.sh' >/dev/null 2>&1; \
      printf '%s|%s|%s|%s|%s\n' \"\$CAWS_VENDOR_DIR\" \"\$CAWS_PERMISSION_VOCAB\" \
        \"\$CAWS_PLATFORM_FLAG\" \"\$CAWS_INSTRUCTION_FILES\" \"\$CAWS_SUPPORTS_UPDATED_INPUT\""
  assert_success
  assert_output ".qwen|ask|qwen-code|QWEN.md|0"
}

# --- parse-input override: tool-name normalization --------------------------------

@test "parse-input override: qwen runtime ids normalize to canonical guard names" {
  run env -i PATH="$PATH" \
    CAWS_AGENT_SURFACE="qwen-code" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_SHARED_LIB_DIR="$CAWS_TEST_HOOKS_DIR/lib" \
    bash -c "source '$QWEN_VENDOR_DIR/hooks/lib/parse-input.sh'
      printf '%s' '{\"tool_name\":\"write_file\",\"cwd\":\"$CAWS_TEST_REPO\",\"session_id\":\"norm-probe\",\"hook_event_name\":\"PreToolUse\",\"tool_input\":{\"file_path\":\"x.ts\"}}' > /tmp/qwen-norm-in.\$\$.json
      HOOK_INPUT_JSON=\"\$(cat /tmp/qwen-norm-in.\$\$.json)\"
      rm -f /tmp/qwen-norm-in.\$\$.json
      parse_hook_input
      first=\"\$HOOK_TOOL_NAME|\$HOOK_ORIGINAL_TOOL_NAME\"
      HOOK_INPUT_JSON='{\"tool_name\":\"run_shell_command\",\"session_id\":\"s\",\"tool_input\":{\"command\":\"ls\"}}'
      unset HOOK_TOOL_NAME
      parse_hook_input
      printf '%s|%s\n' \"\$first\" \"\$HOOK_TOOL_NAME\""
  assert_success
  assert_output "Write|write_file|Bash"
}

@test "parse-input override: unknown tool ids pass through unchanged (fail-open)" {
  run env -i PATH="$PATH" \
    CAWS_AGENT_SURFACE="qwen-code" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_SHARED_LIB_DIR="$CAWS_TEST_HOOKS_DIR/lib" \
    bash -c "source '$QWEN_VENDOR_DIR/hooks/lib/parse-input.sh'
      HOOK_INPUT_JSON='{\"tool_name\":\"web_fetch\",\"session_id\":\"s\",\"tool_input\":{}}'
      parse_hook_input
      printf '%s\n' \"\$HOOK_TOOL_NAME\""
  assert_success
  assert_output "web_fetch"
}

# --- session identity -------------------------------------------------------------

@test "session-id: QWEN_CODE_SESSION_ID resolves through the canonical chain" {
  run env -i PATH="$PATH" \
    QWEN_CODE_SESSION_ID="b9d53b04-qwen-probe" \
    bash -c "source '$CAWS_TEST_HOOKS_DIR/lib/session-id.sh'; resolve_caws_session_id"
  assert_success
  assert_output "b9d53b04-qwen-probe"
}

@test "session-id: the hook payload id still outranks QWEN_CODE_SESSION_ID" {
  run env -i PATH="$PATH" \
    QWEN_CODE_SESSION_ID="env-session" \
    bash -c "source '$CAWS_TEST_HOOKS_DIR/lib/session-id.sh'; resolve_caws_session_id 'payload-session'"
  assert_success
  assert_output "payload-session"
}

# --- shim: inert outside CAWS repos (the safety invariant) ---------------------

@test "shim: inert in a git repo with no .caws/hooks (exit 0, no output)" {
  local bare_repo
  bare_repo="$(mktemp -d "${TMPDIR:-/tmp}/caws-shim-bare-XXXXXX")"
  git -C "$bare_repo" init -q -b main
  run env -i PATH="$PATH" \
    bash -c "cd '$bare_repo' && printf '%s' '{}' | '$QWEN_SHIM' PreToolUse"
  assert_success
  assert_output ""
  rm -rf "$bare_repo"
}

@test "shim: inert outside any git repo (exit 0, no output)" {
  local outside
  outside="$(mktemp -d "${TMPDIR:-/tmp}/caws-shim-norepo-XXXXXX")"
  run env -i PATH="$PATH" \
    bash -c "cd '$outside' && printf '%s' '{}' | '$QWEN_SHIM' PreToolUse"
  assert_success
  assert_output ""
  rm -rf "$outside"
}

@test "shim: unknown event fails open (exit 0, no output)" {
  run env -i PATH="$PATH" \
    bash -c "cd '$CAWS_TEST_REPO' && printf '%s' '{}' | '$QWEN_SHIM' NotAnEvent"
  assert_success
  assert_output ""
}

# --- shim: dispatch + git-root resolution ---------------------------------------

@test "shim: dispatches with surface env and resolves git root from a subdirectory (A3)" {
  # Spy repo: a CAWS-looking tree whose dispatcher records its environment and
  # stdin instead of running guards.
  local spy_repo="$CAWS_TEST_REPO"
  local subdir="$spy_repo/packages/some-pkg"
  mkdir -p "$subdir"
  local spy_out="$spy_repo/spy-out.txt"
  cat > "$spy_repo/.caws/hooks/dispatch/pre_tool_use.sh.spy" <<'SPY'
#!/bin/bash
payload="$(cat)"
printf '%s|%s|%s\n' "$CAWS_AGENT_SURFACE" "$CAWS_PROJECT_DIR" "$payload" > "$CAWS_SPY_OUT"
SPY
  # Swap in the spy (keep the real dispatcher; restore after).
  mv "$spy_repo/.caws/hooks/dispatch/pre_tool_use.sh" "$spy_repo/.caws/hooks/dispatch/pre_tool_use.sh.real"
  cp "$spy_repo/.caws/hooks/dispatch/pre_tool_use.sh.spy" "$spy_repo/.caws/hooks/dispatch/pre_tool_use.sh"
  chmod +x "$spy_repo/.caws/hooks/dispatch/pre_tool_use.sh"

  local root_real
  root_real="$(cd "$spy_repo" && git rev-parse --show-toplevel)"
  run env -i PATH="$PATH" CAWS_SPY_OUT="$spy_out" \
    bash -c "cd '$subdir' && printf '%s' '{\"tool_name\":\"run_shell_command\"}' | '$QWEN_SHIM' PreToolUse"

  # Restore the real dispatcher before asserting (teardown safety).
  mv -f "$spy_repo/.caws/hooks/dispatch/pre_tool_use.sh.real" "$spy_repo/.caws/hooks/dispatch/pre_tool_use.sh"
  rm -f "$spy_repo/.caws/hooks/dispatch/pre_tool_use.sh.spy"

  assert_success
  run cat "$spy_out"
  assert_output "qwen-code|$root_real|{\"tool_name\":\"run_shell_command\"}"
  rm -f "$spy_out"
}

# --- quiet-merge degrade ---------------------------------------------------------

@test "quiet-merge: no updatedInput envelope under the qwen-code surface" {
  run env -i PATH="$PATH" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="qwen-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c "printf '%s' '{\"tool_name\":\"run_shell_command\",\"tool_input\":{\"command\":\"caws worktree merge wt-x\"}}' | bash '$CAWS_TEST_HOOKS_DIR/quiet-merge.sh'"
  assert_success
  refute_output --partial 'updatedInput'
}

@test "quiet-merge: still rewrites under claude-code (regression guard for the gate)" {
  run env -i PATH="$PATH" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c "printf '%s' '{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"caws worktree merge wt-x\"}}' | bash '$CAWS_TEST_HOOKS_DIR/quiet-merge.sh'"
  assert_success
  assert_output --partial 'updatedInput'
}
