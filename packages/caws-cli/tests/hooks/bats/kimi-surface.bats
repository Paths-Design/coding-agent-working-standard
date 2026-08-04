#!/usr/bin/env bats
# kimi-code vendor adapter — shim, surface resolution, and lib overrides
# (CAWS-HOOK-PACK-KIMI-CODE-001).
#
# Covers the pieces of the kimi-code pack that pure jest layout/fingerprint
# tests cannot:
#   - the pack files install (shim executable at its destPath);
#   - agent-surface.sh resolves kimi-code to .kimi-code / deny / no-updatedInput;
#   - caws-kimi-hook.sh is INERT outside CAWS repos (the user-level wiring is
#     global — inertness everywhere else is the safety invariant), maps events
#     to dispatchers, and resolves the git root when launched from a subdir;
#   - the emit override maps ask -> deny and mirrors block/ask reasons to
#     stderr (Kimi's block-reason channel on exit 2);
#   - the run-handlers override ranks deny as priority-3 (immediate block) and
#     promotes a non-zero aggregate to the blocking exit 2 (Kimi has no
#     non-blocking error tier — exit 1 is not enforced, verified live);
#   - the parse-input override normalizes tool_input.path -> HOOK_FILE_PATH
#     and tool_call_id -> HOOK_TOOL_USE_ID (kimi field names; without it every
#     path-based guard silently admits every kimi file edit);
#   - quiet-merge emits no updatedInput under the kimi-code surface.

load helpers

setup_file() {
  [[ -f "$CLI_DIST_ENTRY" ]] || {
    echo "caws-cli dist not built at $CLI_DIST_ENTRY" >&2
    return 1
  }
  local repo
  repo="$(mktemp -d "${TMPDIR:-/tmp}/caws-bats-kimi-XXXXXX")"
  git -C "$repo" init -q -b main
  git -C "$repo" config user.name 'CAWS Test'
  git -C "$repo" config user.email 'test@caws.invalid'
  git -C "$repo" config commit.gpgsign false
  git -C "$repo" commit -q --allow-empty -m 'root commit'
  ( cd "$repo" && CI=true NO_COLOR=1 node "$CLI_DIST_ENTRY" init --agent-surface kimi-code >/dev/null 2>&1 )
  export CAWS_TEST_REPO="$repo"
  export CAWS_TEST_HOOKS_DIR="$repo/.caws/hooks"
  export KIMI_VENDOR_DIR="$repo/.kimi-code"
  export KIMI_SHIM="$repo/.kimi-code/hooks/caws-kimi-hook.sh"
}
teardown_file() {
  caws_teardown_pack
}

# --- install layout -----------------------------------------------------------

@test "kimi pack: shim, AGENTS.md, and lib overrides install at their destPaths" {
  [[ -x "$KIMI_SHIM" ]]
  [[ -f "$KIMI_VENDOR_DIR/AGENTS.md" ]]
  [[ -f "$KIMI_VENDOR_DIR/hooks/lib/emit.sh" ]]
  [[ -f "$KIMI_VENDOR_DIR/hooks/lib/run-handlers.sh" ]]
  [[ -f "$KIMI_VENDOR_DIR/hooks/lib/parse-input.sh" ]]
  [[ -f "$KIMI_VENDOR_DIR/caws-hooks.toml.example" ]]
}

@test "kimi pack: init without --wire-user-config does NOT write the user-level config" {
  # The install ran without the flag; no config.toml may appear under a
  # KIMI_CODE_HOME pointing at the repo (it would be the merge target).
  [[ ! -f "$CAWS_TEST_REPO/config.toml" ]]
}

# --- agent-surface resolution ---------------------------------------------------

@test "agent-surface: kimi-code resolves vendor dir, deny vocab, no updatedInput, AGENTS.md" {
  run env -i PATH="$PATH" \
    CAWS_AGENT_SURFACE="kimi-code" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    bash -c "source '$CAWS_TEST_HOOKS_DIR/lib/agent-surface.sh' >/dev/null 2>&1; \
      printf '%s|%s|%s|%s|%s\n' \"\$CAWS_VENDOR_DIR\" \"\$CAWS_PERMISSION_VOCAB\" \
        \"\$CAWS_PLATFORM_FLAG\" \"\$CAWS_INSTRUCTION_FILES\" \"\$CAWS_SUPPORTS_UPDATED_INPUT\""
  assert_success
  assert_output ".kimi-code|deny|kimi-code|AGENTS.md|0"
}

# --- shim: inert outside CAWS repos (the safety invariant) ---------------------

@test "shim: inert in a git repo with no .caws/hooks (exit 0, no output)" {
  local bare_repo
  bare_repo="$(mktemp -d "${TMPDIR:-/tmp}/caws-shim-bare-XXXXXX")"
  git -C "$bare_repo" init -q -b main
  run env -i PATH="$PATH" \
    bash -c "cd '$bare_repo' && printf '%s' '{}' | '$KIMI_SHIM' PreToolUse"
  assert_success
  assert_output ""
  rm -rf "$bare_repo"
}

@test "shim: inert outside any git repo (exit 0, no output)" {
  local outside
  outside="$(mktemp -d "${TMPDIR:-/tmp}/caws-shim-norepo-XXXXXX")"
  run env -i PATH="$PATH" \
    bash -c "cd '$outside' && printf '%s' '{}' | '$KIMI_SHIM' PreToolUse"
  assert_success
  assert_output ""
  rm -rf "$outside"
}

@test "shim: unknown event fails open (exit 0, no output)" {
  run env -i PATH="$PATH" \
    bash -c "cd '$CAWS_TEST_REPO' && printf '%s' '{}' | '$KIMI_SHIM' NotAnEvent"
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
    bash -c "cd '$subdir' && printf '%s' '{\"tool_name\":\"Bash\"}' | '$KIMI_SHIM' PreToolUse"

  # Restore the real dispatcher before asserting (teardown safety).
  mv -f "$spy_repo/.caws/hooks/dispatch/pre_tool_use.sh.real" "$spy_repo/.caws/hooks/dispatch/pre_tool_use.sh"
  rm -f "$spy_repo/.caws/hooks/dispatch/pre_tool_use.sh.spy"

  assert_success
  run cat "$spy_out"
  assert_output "kimi-code|$root_real|{\"tool_name\":\"Bash\"}"
  rm -f "$spy_out"
}

# --- emit override ------------------------------------------------------------

@test "kimi emit: emit_ask degrades to deny and mirrors the reason to stderr" {
  run env -i PATH="$PATH" bash -c "
    source '$KIMI_VENDOR_DIR/hooks/lib/emit.sh'
    emit_ask 'human review required' 2>/tmp/kimi-emit-err.\$\$ | grep -q '\"permissionDecision\": \"deny\"' || exit 1
    grep -q 'human review required' /tmp/kimi-emit-err.\$\$ || { rm -f /tmp/kimi-emit-err.\$\$; exit 2; }
    rm -f /tmp/kimi-emit-err.\$\$
  "
  assert_success
}

@test "kimi emit: emit_block keeps the stdout envelope AND writes the reason to stderr" {
  run env -i PATH="$PATH" bash -c "
    source '$KIMI_VENDOR_DIR/hooks/lib/emit.sh'
    out=\"\$(emit_block 'scope refused' 2>/tmp/kimi-block-err.\$\$)\" || exit 1
    printf '%s' \"\$out\" | grep -q '\"decision\": \"block\"' || { rm -f /tmp/kimi-block-err.\$\$; exit 2; }
    grep -q 'scope refused' /tmp/kimi-block-err.\$\$ || { rm -f /tmp/kimi-block-err.\$\$; exit 3; }
    rm -f /tmp/kimi-block-err.\$\$
  "
  assert_success
}

@test "kimi emit: no emit_updated_input is defined (no updatedInput contract)" {
  run env -i PATH="$PATH" bash -c "
    source '$KIMI_VENDOR_DIR/hooks/lib/emit.sh'
    declare -F emit_updated_input >/dev/null 2>&1 && exit 1
    exit 0
  "
  assert_success
}

# --- parse-input override -----------------------------------------------------

@test "kimi parse-input: tool_input.path normalizes to HOOK_FILE_PATH (kimi Edit/Write schema)" {
  # The dogfood escape: kimi's file tools send tool_input.path, not the Claude
  # file_path the shared parser reads — every path guard was blind without
  # this override.
  run env -i PATH="$PATH" \
    CAWS_SHARED_LIB_DIR="$CAWS_TEST_HOOKS_DIR/lib" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    bash -c "
      source '$KIMI_VENDOR_DIR/hooks/lib/parse-input.sh'
      export HOOK_INPUT_JSON='{\"hook_event_name\":\"PreToolUse\",\"session_id\":\"session_bats\",\"cwd\":\"/tmp\",\"tool_name\":\"Edit\",\"tool_input\":{\"path\":\".kimi-code/hooks/lib/emit.sh\",\"old_string\":\"a\",\"new_string\":\"b\"},\"tool_call_id\":\"tool_abc\"}'
      parse_hook_input
      printf '%s|%s\n' \"\$HOOK_FILE_PATH\" \"\$HOOK_TOOL_USE_ID\"
    "
  assert_success
  assert_output ".kimi-code/hooks/lib/emit.sh|tool_abc"
}

@test "kimi parse-input: Claude file_path wins when both present; pathless tools stay empty" {
  run env -i PATH="$PATH" \
    CAWS_SHARED_LIB_DIR="$CAWS_TEST_HOOKS_DIR/lib" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    bash -c "
      source '$KIMI_VENDOR_DIR/hooks/lib/parse-input.sh'
      (
        export HOOK_INPUT_JSON='{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"claude.txt\",\"path\":\"kimi.txt\"}}'
        parse_hook_input
        printf 'both=%s\n' \"\$HOOK_FILE_PATH\"
      )
      (
        export HOOK_INPUT_JSON='{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls\"}}'
        parse_hook_input
        printf 'bash=[%s]\n' \"\$HOOK_FILE_PATH\"
      )
    "
  assert_success
  assert_output $'both=claude.txt\nbash=[]'
}

@test "shim: a protected hook edit carrying kimi's tool_input.path is blocked end-to-end" {
  # Regression for the live dogfood escape: same payload shape kimi actually
  # sends for an Edit, from a subdirectory, must block with exit 2 and cite
  # the protected path on stderr.
  local subdir="$CAWS_TEST_REPO/packages/some-pkg"
  mkdir -p "$subdir"
  run env -i PATH="$PATH" \
    bash -c "cd '$subdir' && printf '%s' '{\"hook_event_name\":\"PreToolUse\",\"session_id\":\"session_bats\",\"cwd\":\"'$subdir'\",\"tool_name\":\"Edit\",\"tool_input\":{\"path\":\".kimi-code/hooks/lib/emit.sh\",\"old_string\":\"a\",\"new_string\":\"b\"},\"tool_call_id\":\"tool_1\"}' | '$KIMI_SHIM' PreToolUse"
  assert_failure 2
  assert_output --partial '.kimi-code/hooks/lib/emit.sh is protected'
}

# --- run-handlers override ------------------------------------------------------

@test "kimi run-handlers: deny ranks priority-3 (immediate block) alongside block" {
  run env -i PATH="$PATH" bash -c "
    source '$KIMI_VENDOR_DIR/hooks/lib/run-handlers.sh'
    deny=\"\$(_rh_stdout_priority '{\"hookSpecificOutput\":{\"permissionDecision\":\"deny\"}}')\"
    block=\"\$(_rh_stdout_priority '{\"decision\":\"block\"}')\"
    ctx=\"\$(_rh_stdout_priority '{\"hookSpecificOutput\":{\"additionalContext\":\"x\"}}')\"
    printf '%s|%s|%s\n' \"\$deny\" \"\$block\" \"\$ctx\"
  "
  assert_success
  assert_output "3|3|1"
}

@test "kimi run-handlers: a handler exiting 1 is promoted to the blocking exit 2" {
  # Kimi has no non-blocking error tier (verified live: a PreToolUse hook
  # exiting 1 does NOT stop the tool call). The override must promote the
  # non-zero aggregate to exit 2 so guard refusals like protected-paths.sh's
  # fail-closed exit-1 arm cannot fail open on this surface.
  local fake_hooks
  fake_hooks="$(mktemp -d "${TMPDIR:-/tmp}/caws-bats-kimi-rh-XXXXXX")"
  printf '#!/bin/bash\nexit 1\n' > "$fake_hooks/exit-one.sh"
  chmod +x "$fake_hooks/exit-one.sh"
  printf '#!/bin/bash\nexit 0\n' > "$fake_hooks/clean.sh"
  chmod +x "$fake_hooks/clean.sh"
  run env -i PATH="$PATH" bash -c "
    source '$KIMI_VENDOR_DIR/hooks/lib/run-handlers.sh'
    export HOOKS_DIR='$fake_hooks' HOOK_INPUT_JSON='{}'
    run_handlers clean.sh exit-one.sh
    printf 'rc=%d\n' \"\$?\"
  "
  rm -rf "$fake_hooks"
  assert_success
  assert_output "rc=2"
}

@test "kimi run-handlers: an all-clean chain still returns 0" {
  local fake_hooks
  fake_hooks="$(mktemp -d "${TMPDIR:-/tmp}/caws-bats-kimi-rh-XXXXXX")"
  printf '#!/bin/bash\nexit 0\n' > "$fake_hooks/clean.sh"
  chmod +x "$fake_hooks/clean.sh"
  run env -i PATH="$PATH" bash -c "
    source '$KIMI_VENDOR_DIR/hooks/lib/run-handlers.sh'
    export HOOKS_DIR='$fake_hooks' HOOK_INPUT_JSON='{}'
    run_handlers clean.sh
    printf 'rc=%d\n' \"\$?\"
  "
  rm -rf "$fake_hooks"
  assert_success
  assert_output "rc=0"
}

# --- quiet-merge degrade ---------------------------------------------------------

@test "quiet-merge: no updatedInput envelope under the kimi-code surface" {
  run env -i PATH="$PATH" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="kimi-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c "printf '%s' '{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"caws worktree merge wt-x\"}}' | bash '$CAWS_TEST_HOOKS_DIR/quiet-merge.sh'"
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
