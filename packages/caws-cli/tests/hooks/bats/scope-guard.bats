#!/usr/bin/env bats
# scope-guard.sh — kernel-delegated scope enforcement
# (CAWS-SCOPE-SHOW-JSON-CONTRACT-001).
#
# The guard no longer re-parses spec YAML inline. The DECISION comes from
# `caws scope check` (exit 0/1) and the DIAGNOSTIC from `caws scope show --json`
# (the stable contract). These tests assert:
#   1. STRUCTURAL: the installed scope-guard.sh carries NO inline node -e /
#      js-yaml spec re-parser, and DOES delegate to `caws scope show --json`.
#   2. BEHAVIORAL: against a real bound spec in the temp repo, an in-scope Write
#      is admitted (exit 0, silent) and an out-of-scope Write is refused
#      (emits a scope-progression message), driven entirely through the CLI.
#   3. FAIL-CLOSED: a refused path with the CLI unavailable refuses rather than
#      silently admitting — it does not resurrect an inline parser.
#
# Latch/strike state lands inside the sandboxed temp repo (CAWS_PROJECT_DIR),
# never the real session.

load helpers

setup_file() {
  caws_install_pack_once
  # Installation substitutes the pack-version header. Every other byte must
  # come from this checkout's template, including on the old-guard control run.
  diff -u <(sed '/^# hook_pack_version:/d' "$CLI_PKG_ROOT/templates/hook-packs/shared/scope-guard.sh") \
    <(sed '/^# hook_pack_version:/d' "$CAWS_TEST_HOOKS_DIR/scope-guard.sh")
  printf '# fixture scope-guard body matches checkout; sha256=%s\n' \
    "$(sed '/^# hook_pack_version:/d' "$CAWS_TEST_HOOKS_DIR/scope-guard.sh" | shasum -a 256)"
}
teardown_file() {
  caws_teardown_pack
}

setup() {
  # All guard and CLI processes belong to explicit disposable fixtures, never
  # the runner's native session or global strike home.
  export HOME="$BATS_TEST_TMPDIR/home"
  export CAWS_HOME="$HOME/.caws"
  mkdir -p "$HOME"
  export CAWS_AGENT_SURFACE=claude-code
  export CAWS_TEST_SESSION_ID="scope-fixture-$BATS_TEST_NUMBER"
  export CLAUDE_CODE_SESSION_ID="$CAWS_TEST_SESSION_ID"
  unset CAWS_SESSION_ID CLAUDE_SESSION_ID CODEX_THREAD_ID HOOK_SESSION_ID
  unset CAWS_PROJECT_DIR CAWS_MACHINE_POLICY_ROOT HOOK_CWD CAWS_HOOKS_DIR CAWS_LOG_DIR
  unset CAWS_MACHINE_RUNTIME CAWS_MACHINE_LIBRARIES CAWS_MACHINE_ADAPTER_LIB_DIR CAWS_SHARED_LIB_DIR
  cd "$CAWS_TEST_REPO"
}

_assert_hard_block_without_strike() {
  assert_equal "$status" 2
  assert_output --partial '"decision": "block"'
  refute_output --partial 'strike 1 of 3'
  assert [ ! -e "$HOME/.caws/state/sessions/$CAWS_TEST_SESSION_ID/strikes.json" ]
}

# Run the installed scope-guard with a stub `caws` on PATH that scripts the
# CLI contract (CAWS_STUB_CHECK_EXIT = exit code of `caws scope check`,
# CAWS_STUB_JSON = stdout of `caws scope show … --json`). This isolates the
# hook's CONTRACT-CONSUMPTION from real spec/CLI setup: the slice's behavioral
# claim is "the hook maps the CLI's answer onto admit/refuse", which is exactly
# what the stub exercises. A relative REL_PATH avoids the foreign-repo guard.
_run_scope_guard_with_stub() {
  local rel_path="$1" check_exit="$2" json="$3" show_exit="${4:-0}"
  local stubdir
  stubdir="$(mktemp -d "${TMPDIR:-/tmp}/caws-stub-XXXXXX")"
  cat > "$stubdir/caws" <<STUB
#!/usr/bin/env bash
# args: scope check <path>  |  scope show <path> --json
if [[ "\$1" == "scope" && "\$2" == "check" ]]; then exit ${check_exit}; fi
if [[ "\$1" == "scope" && "\$2" == "show" ]]; then printf '%s' '${json}'; exit ${show_exit}; fi
exit 0
STUB
  chmod +x "$stubdir/caws"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    PATH="$stubdir:$PATH" \
    bash -c 'cd "$1" && printf "%s" "$2" | bash "$3"' _ \
    "$CAWS_TEST_REPO" "$(hook_envelope Edit "$rel_path")" "$CAWS_TEST_HOOKS_DIR/scope-guard.sh"
  rm -rf "$stubdir"
}

@test "scope-guard: installed hook carries NO inline node -e / js-yaml spec re-parser" {
  # The whole point of the slice: the parallel evaluator is gone. The hook must
  # contain no js-yaml re-parser and no `node -e` at all — not in code, and not
  # in message prose either, because prose that names a Bash route is exactly
  # what overclaimed the boundary before CAWS-BASH-GUARD-INTERPRETER-WRITE-01.
  #
  # This asserts on the captured OUTPUT, not via refute_line. Zero matches is
  # the intended state, and an empty stream leaves `lines` unset, so a
  # refute_line form errors ("parameter null or not set") instead of passing —
  # it could only ever succeed while some match survived, which made the old
  # assertion depend on the very sentence this slice deleted.
  run grep -nE "node -e|require\\('js-yaml'\\)|yaml\\.load" "$CAWS_TEST_HOOKS_DIR/scope-guard.sh"
  assert_failure # grep exit 1 == no matching lines
  assert_output ""
}

@test "scope-guard: installed hook delegates the diagnostic to caws scope show --json" {
  run grep -c "caws scope show \"\$REL_PATH\" --json" "$CAWS_TEST_HOOKS_DIR/scope-guard.sh"
  assert_success
  assert_output "1"
}

@test "scope-guard: an in-scope path is admitted (caws scope check exit 0 -> silent exit 0)" {
  # check exit 0 = kernel-authoritative ADMIT; the hook short-circuits.
  _run_scope_guard_with_stub "packages/in/ok.ts" 0 ""
  assert_success
  refute_output --partial 'not in the defined scope'
}

@test "scope-guard: a top-level admitted file stays silent" {
  _run_scope_guard_with_stub "package.json" 0 ""
  assert_success
  assert_output ""
}

@test "scope-guard: a top-level rejected file follows the nested-path scope contract" {
  local json='{"decision":"reject","rule":"scope.reject.scope_out","path":"package.json","bindingState":"bound","mode":"authoritative","boundSpecId":"FIX-1","matchedPattern":"package.json"}'
  _run_scope_guard_with_stub "package.json" 1 "$json"
  _assert_hard_block_without_strike
  assert_output --partial 'out-of-scope'
  assert_output --partial 'FIX-1'
}

@test "scope-guard: a top-level file with unreadable scope diagnostics fails closed" {
  _run_scope_guard_with_stub "package.json" 1 "not json"
  _assert_hard_block_without_strike
  assert_output --partial 'could not render the structured diagnostic'
}

@test "scope-guard: a failed diagnostic command cannot supply an admission" {
  local json='{"decision":"admit","rule":"scope.admit.scope_in","path":"package.json","bindingState":"bound","mode":"authoritative","boundSpecId":"FIX-1"}'
  _run_scope_guard_with_stub "package.json" 1 "$json" 2
  _assert_hard_block_without_strike
  assert_output --partial 'could not render the structured diagnostic'
}

@test "scope-guard: an out-of-scope reject is surfaced from the JSON contract (authoritative)" {
  local json='{"decision":"reject","rule":"scope.reject.scope_out","path":"packages/out/x.ts","bindingState":"bound","mode":"authoritative","boundSpecId":"FIX-1","matchedPattern":"packages/out"}'
  _run_scope_guard_with_stub "packages/out/x.ts" 1 "$json"
  _assert_hard_block_without_strike
  assert_output --partial 'out-of-scope'
  assert_output --partial 'packages/out'
}

@test "scope-guard: a not-in-scope reject is surfaced (authoritative, names bound spec)" {
  local json='{"decision":"reject","rule":"scope.reject.root_not_allowed","path":"packages/elsewhere/y.ts","bindingState":"bound","mode":"authoritative","boundSpecId":"FIX-1"}'
  _run_scope_guard_with_stub "packages/elsewhere/y.ts" 1 "$json"
  assert_success
  assert_output --partial 'strike 1 of 3'
  refute_output --partial '"decision": "block"'
  assert_output --partial 'not in the defined scope'
  assert_output --partial 'FIX-1'
}

@test "scope-guard: a one_sided binding (malformed/missing bound spec) refuses authoritatively" {
  local json='{"decision":"no_authority","rule":"scope.no_authority.binding_one_sided","path":"packages/x/z.ts","bindingState":"one_sided","mode":"union"}'
  _run_scope_guard_with_stub "packages/x/z.ts" 1 "$json"
  _assert_hard_block_without_strike
  assert_output --partial 'did not load'
}

@test "scope-guard: union scope.out retains the first-strike advisory" {
  local json='{"decision":"reject","rule":"scope.reject.scope_out","path":"outside.txt","bindingState":"unbound","mode":"union","matchedPattern":"outside.txt"}'
  _run_scope_guard_with_stub "outside.txt" 1 "$json"
  assert_success
  assert_output --partial 'strike 1 of 3'
  assert_output --partial 'Mode: union'
  refute_output --partial '"decision": "block"'
}

# These fixtures create actual Git-linked sparse lanes through the built CLI.
# The direct CLI controls establish authority before a guard can pass/fail;
# a silent exit caused by unknown cwd or missing setup is never an oracle.
_scope_cli() {
  (cd "$SCOPE_REPO" && "$CAWS_TEST_CLI" "$@")
}

_create_sparse_scope_fixture() {
  local surface="${1:-claude-code}"
  SCOPE_REPO="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$SCOPE_REPO"
  SCOPE_REPO="$(cd "$SCOPE_REPO" && pwd -P)"
  git -C "$SCOPE_REPO" init -q -b main
  git -C "$SCOPE_REPO" config user.name 'CAWS Test'
  git -C "$SCOPE_REPO" config user.email 'test@caws.invalid'
  git -C "$SCOPE_REPO" config commit.gpgsign false
  git -C "$SCOPE_REPO" commit -q --allow-empty -m root
  run _scope_cli init --agent-surface "$surface"
  assert_success
  run _scope_cli specs create SCOPE-1 --title 'Sparse scope fixture' --mode fix \
    --scope-in allowed.txt --scope-in protected.txt
  assert_success
  run _scope_cli specs amend-scope SCOPE-1 --add-out protected.txt
  assert_success
  run _scope_cli worktree create sparse --spec SCOPE-1 --base-branch main --branch caws/sparse
  assert_success
  SCOPE_LEAF="$SCOPE_REPO/.caws/worktrees/sparse"
  [ -f "$SCOPE_LEAF/.git" ]
  [ ! -e "$SCOPE_LEAF/.caws" ]
  assert_equal "$(git -C "$SCOPE_LEAF" config core.sparseCheckout)" true
  assert_equal "$(jq -r '.sparse.owner.session_id' "$SCOPE_REPO/.caws/worktrees.json")" "$CAWS_TEST_SESSION_ID"
  assert_equal "$(jq -r '.sparse.specId' "$SCOPE_REPO/.caws/worktrees.json")" SCOPE-1
  run bash -c 'cd "$1" && "$2" scope show protected.txt --json' _ "$SCOPE_LEAF" "$CAWS_TEST_CLI"
  assert_success
  assert_equal "$(printf '%s' "$output" | jq -r '[.decision,.rule,.bindingState,.mode,.boundSpecId] | join("|")')" \
    'reject|scope.reject.scope_out|bound|authoritative|SCOPE-1'
  run bash -c 'cd "$1" && "$2" scope check allowed.txt' _ "$SCOPE_LEAF" "$CAWS_TEST_CLI"
  assert_success
  assert_output --partial scope.admit.scope_in
  printf 'sentinel\n' > "$SCOPE_LEAF/protected.txt"
}

_run_sparse_guard() {
  local tool="$1" target="${2:-protected.txt}" envelope
  envelope="$(jq -nc --arg tool "$tool" --arg cwd "$SCOPE_LEAF" --arg sid "$CAWS_TEST_SESSION_ID" \
    --arg path "$SCOPE_LEAF/$target" '{tool_name:$tool,cwd:$cwd,session_id:$sid,tool_input:{file_path:$path}}')"
  # The simulated tool effect happens only if the guard admits. Preserve the
  # guard's exact status so an exit-0 block envelope cannot mask this failure.
  run env CAWS_PROJECT_DIR="$SCOPE_LEAF" CAWS_MACHINE_POLICY_ROOT="$SCOPE_REPO" \
    HOOK_CWD="$SCOPE_LEAF" PATH="$CAWS_TEST_HOME/bin:$PATH" \
    bash -c 'cd "$1"; printf "%s" "$2" | bash "$3"; rc=$?; if [ "$rc" -eq 0 ] && [ "$4" = protected.txt ]; then printf "changed\n" > "$4"; fi; exit "$rc"' _ \
    "$SCOPE_LEAF" "$envelope" "$CAWS_TEST_HOOKS_DIR/scope-guard.sh" "$target"
  if [[ "$target" == protected.txt ]]; then
    printf '# guarded %s: exit=%s sentinel=%s\n' "$tool" "$status" "$(cat "$SCOPE_LEAF/protected.txt")"
  fi
}

@test "scope-guard: a real sparse leaf admits its bound scope.in file" {
  _create_sparse_scope_fixture
  _run_sparse_guard Write allowed.txt
  assert_success
  assert_output ""
  assert [ ! -e "$HOME/.caws/state/sessions/$CAWS_TEST_SESSION_ID/strikes.json" ]
}

@test "scope-guard: first Write in a real sparse leaf blocks scope.out before effect" {
  _create_sparse_scope_fixture
  _run_sparse_guard Write
  _assert_hard_block_without_strike
  assert_output --partial 'out-of-scope'
  assert_output --partial SCOPE-1
  assert_equal "$(cat "$SCOPE_LEAF/protected.txt")" sentinel
}

@test "scope-guard: first Edit in a real sparse leaf blocks scope.out before effect" {
  _create_sparse_scope_fixture
  _run_sparse_guard Edit
  _assert_hard_block_without_strike
  assert_output --partial 'out-of-scope'
  assert_equal "$(cat "$SCOPE_LEAF/protected.txt")" sentinel
}

@test "scope-guard: malformed canonical policy visibly blocks a sparse leaf" {
  _create_sparse_scope_fixture
  printf 'invalid: [\n' > "$SCOPE_REPO/.caws/policy.yaml"
  _run_sparse_guard Write
  _assert_hard_block_without_strike
  assert_output --partial 'could not render the structured diagnostic'
  assert_equal "$(cat "$SCOPE_LEAF/protected.txt")" sentinel
}

@test "scope-guard: broken canonical bound spec visibly blocks a sparse leaf" {
  _create_sparse_scope_fixture
  printf 'invalid: [\n' > "$SCOPE_REPO/.caws/specs/SCOPE-1.yaml"
  _run_sparse_guard Write
  _assert_hard_block_without_strike
  assert_output --partial 'did not load'
  assert_equal "$(cat "$SCOPE_LEAF/protected.txt")" sentinel
}

@test "scope-guard: missing known canonical specs visibly blocks a sparse leaf" {
  _create_sparse_scope_fixture
  mv "$SCOPE_REPO/.caws/specs" "$BATS_TEST_TMPDIR/held-specs"
  _run_sparse_guard Write
  _assert_hard_block_without_strike
  assert_output --partial 'canonical governance'
  assert_equal "$(cat "$SCOPE_LEAF/protected.txt")" sentinel
}

@test "scope-guard: an ordinary ungoverned Git project remains a silent no-op" {
  local plain="$BATS_TEST_TMPDIR/plain" envelope
  git init -q "$plain"
  envelope="$(jq -nc --arg cwd "$plain" --arg sid "$CAWS_TEST_SESSION_ID" \
    '{tool_name:"Write",cwd:$cwd,session_id:$sid,tool_input:{file_path:"plain.txt"}}')"
  run env CAWS_PROJECT_DIR="$plain" bash -c 'cd "$1" && printf "%s" "$2" | bash "$3"' _ \
    "$plain" "$envelope" "$CAWS_TEST_HOOKS_DIR/scope-guard.sh"
  assert_success
  assert_output ""
}

@test "scope-guard: an ungoverned linked Git worktree remains a silent no-op" {
  local plain="$BATS_TEST_TMPDIR/plain" leaf="$BATS_TEST_TMPDIR/plain-linked" envelope
  git init -q -b main "$plain"
  git -C "$plain" -c user.name='CAWS Test' -c user.email=test@caws.invalid \
    -c commit.gpgsign=false commit -q --allow-empty -m root
  git -C "$plain" worktree add -q -b linked "$leaf"
  [ -f "$leaf/.git" ]
  [ ! -e "$plain/.caws" ]
  [ ! -e "$leaf/.caws" ]
  envelope="$(jq -nc --arg cwd "$leaf" --arg sid "$CAWS_TEST_SESSION_ID" \
    '{tool_name:"Write",cwd:$cwd,session_id:$sid,tool_input:{file_path:"plain.txt"}}')"
  run env CAWS_PROJECT_DIR="$leaf" CAWS_MACHINE_POLICY_ROOT="$plain" \
    bash -c 'cd "$1" && printf "%s" "$2" | bash "$3"' _ \
    "$leaf" "$envelope" "$CAWS_TEST_HOOKS_DIR/scope-guard.sh"
  assert_success
  assert_output ""
}

_run_cache_only_ungoverned_guard() {
  local linked="$1" tool="$2" plain="$BATS_TEST_TMPDIR/cache-only" leaf envelope
  git init -q -b main "$plain"
  mkdir -p "$plain/.caws"
  printf '{}\n' > "$plain/.caws/duplication-cache.json"
  leaf="$plain"
  if [[ "$linked" == yes ]]; then
    git -C "$plain" -c user.name='CAWS Test' -c user.email=test@caws.invalid \
      -c commit.gpgsign=false commit -q --allow-empty -m root
    leaf="$BATS_TEST_TMPDIR/cache-linked"
    git -C "$plain" worktree add -q -b linked "$leaf"
    [ -f "$leaf/.git" ]
    [ ! -e "$leaf/.caws" ]
  fi
  assert_equal "$(ls -A "$plain/.caws")" duplication-cache.json
  envelope="$(jq -nc --arg cwd "$leaf" --arg sid "$CAWS_TEST_SESSION_ID" --arg tool "$tool" \
    '{tool_name:$tool,cwd:$cwd,session_id:$sid,tool_input:{file_path:"plain.txt"}}')"
  run env CAWS_PROJECT_DIR="$leaf" CAWS_MACHINE_POLICY_ROOT="$plain" \
    bash -c 'cd "$1" && printf "%s" "$2" | bash "$3"' _ \
    "$leaf" "$envelope" "$CAWS_TEST_HOOKS_DIR/scope-guard.sh"
}

@test "scope-guard: cache-only .caws residue does not adopt an ungoverned Git project" {
  _run_cache_only_ungoverned_guard no Write
  assert_success
  assert_output ""
}

@test "scope-guard: cache-only canonical residue does not adopt an ungoverned linked checkout" {
  _run_cache_only_ungoverned_guard yes Edit
  assert_success
  assert_output ""
}

@test "scope-guard: known governing artifacts without valid specs block beside a cache" {
  local marker plain envelope
  for marker in policy.yaml specs worktrees.json claims/bridge.json; do
    plain="$BATS_TEST_TMPDIR/known-${marker//\//-}"
    git init -q "$plain"
    mkdir -p "$plain/.caws/claims"
    printf '{}\n' > "$plain/.caws/duplication-cache.json"
    # Invalid contents/types retain the adoption signal; they cannot silently
    # demote a previously governed project to cache-only status.
    printf 'invalid\n' > "$plain/.caws/$marker"
    envelope="$(jq -nc --arg cwd "$plain" --arg sid "$CAWS_TEST_SESSION_ID" \
      '{tool_name:"Write",cwd:$cwd,session_id:$sid,tool_input:{file_path:"plain.txt"}}')"
    run env CAWS_PROJECT_DIR="$plain" CAWS_MACHINE_POLICY_ROOT="$plain" \
      bash -c 'cd "$1" && printf "%s" "$2" | bash "$3"' _ \
      "$plain" "$envelope" "$CAWS_TEST_HOOKS_DIR/scope-guard.sh"
    _assert_hard_block_without_strike
    assert_output --partial 'canonical governance'
  done
}

_create_codex_patch_fixture() {
  _create_sparse_scope_fixture codex
  run _scope_cli specs amend-scope SCOPE-1 --add 'allowed two.txt' --add renamed.txt
  assert_success
  printf 'original\n' > "$SCOPE_LEAF/allowed.txt"
  printf 'second\n' > "$SCOPE_LEAF/allowed two.txt"
  [ -f "$SCOPE_REPO/.codex/hooks/lib/parse-input.sh" ]
}

_run_codex_patch_guard() {
  local patch="$1" effect="${2:-multi}" source="${3:-allowed.txt}" dest="${4:-protected.txt}" envelope
  envelope="$(jq -nc --arg cwd "$SCOPE_LEAF" --arg sid "$CAWS_TEST_SESSION_ID" --arg patch "$patch" \
    '{tool_name:"apply_patch",hook_event_name:"PreToolUse",cwd:$cwd,session_id:$sid,tool_input:{command:$patch}}')"
  # Use the installed Codex parser, as the dispatcher does, and replay the
  # ORIGINAL envelope on stdin to the single handler invocation. The fixture
  # supplies only explicit simulated effects; it never executes the patch.
  run env -u CLAUDE_CODE_SESSION_ID CAWS_AGENT_SURFACE=codex CODEX_THREAD_ID="$CAWS_TEST_SESSION_ID" \
    CAWS_PROJECT_DIR="$SCOPE_LEAF" CAWS_MACHINE_POLICY_ROOT="$SCOPE_REPO" \
    CAWS_SHARED_LIB_DIR="$CAWS_TEST_HOOKS_DIR/lib" PATH="$CAWS_TEST_HOME/bin:$PATH" \
    bash -c '
      cd "$1" || exit 97
      source "$2/runtime-paths.sh"
      source "$3"
      HOOK_INPUT_JSON="$4"
      parse_hook_input || exit 97
      [ "$HOOK_ORIGINAL_TOOL_NAME" = apply_patch ] || exit 97
      printf "%s" "$4" | bash "$2/scope-guard.sh"
      rc=$?
      if [ "$rc" -eq 0 ]; then
        case "$5" in
          multi) printf "changed\n" > allowed.txt; printf "changed\n" > protected.txt ;;
          rename) mv "$6" "$7" ;;
          admitted) printf "changed\n" > allowed.txt; printf "changed\n" > "allowed two.txt" ;;
          foreign) printf "changed\n" > "$7" ;;
        esac
      fi
      exit "$rc"
    ' _ "$SCOPE_LEAF" "$CAWS_TEST_HOOKS_DIR" "$SCOPE_REPO/.codex/hooks/lib/parse-input.sh" \
    "$envelope" "$effect" "$source" "$dest"
  printf '# Codex patch: exit=%s allowed=%s protected=%s\n' "$status" \
    "$(cat "$SCOPE_LEAF/allowed.txt" 2>/dev/null || true)" "$(cat "$SCOPE_LEAF/protected.txt" 2>/dev/null || true)"
}

_assert_patch_unchanged() {
  _assert_hard_block_without_strike
  assert_equal "$(cat "$SCOPE_LEAF/allowed.txt")" original
  assert_equal "$(cat "$SCOPE_LEAF/protected.txt")" sentinel
}

@test "scope-guard Codex patch: admitted first cannot bypass protected later" {
  _create_codex_patch_fixture
  _run_codex_patch_guard $'*** Begin Patch\n*** Update File: allowed.txt\n@@\n-original\n+changed\n*** Update File: protected.txt\n@@\n-sentinel\n+changed\n*** End Patch'
  _assert_patch_unchanged
  assert_output --partial 'out-of-scope'
}

@test "scope-guard Codex patch: protected first blocks admitted later" {
  _create_codex_patch_fixture
  _run_codex_patch_guard $'*** Begin Patch\n*** Update File: protected.txt\n@@\n-sentinel\n+changed\n*** Update File: allowed.txt\n@@\n-original\n+changed\n*** End Patch'
  _assert_patch_unchanged
}

@test "scope-guard Codex patch: file-transported original payload retains later targets" {
  _create_codex_patch_fixture
  export CAWS_HOOK_INLINE_PAYLOAD_MAX_BYTES=1
  _run_codex_patch_guard $'*** Begin Patch\n*** Add File: allowed.txt\n+one\n*** Delete File: protected.txt\n*** End Patch'
  _assert_patch_unchanged
}

@test "scope-guard Codex patch: exempt docs first cannot bypass protected Delete" {
  _create_codex_patch_fixture
  _run_codex_patch_guard $'*** Begin Patch\n*** Add File: docs/note.md\n+note\n*** Delete File: protected.txt\n*** End Patch'
  _assert_patch_unchanged
}

@test "scope-guard Codex patch: admitted rename source cannot bypass protected destination" {
  _create_codex_patch_fixture
  _run_codex_patch_guard $'*** Begin Patch\n*** Update File: allowed.txt\n*** Move to: protected.txt\n@@\n-original\n+original\n*** End Patch' rename
  _assert_patch_unchanged
  assert_output --partial protected.txt
}

@test "scope-guard Codex patch: protected rename source blocks admitted destination" {
  _create_codex_patch_fixture
  _run_codex_patch_guard $'*** Begin Patch\n*** Update File: protected.txt\n*** Move to: renamed.txt\n@@\n-sentinel\n+sentinel\n*** End Patch' rename protected.txt renamed.txt
  _assert_patch_unchanged
  [ ! -e "$SCOPE_LEAF/renamed.txt" ]
}

@test "scope-guard Codex patch: all-admitted multi-file targets include space paths" {
  _create_codex_patch_fixture
  _run_codex_patch_guard $'*** Begin Patch\n*** Update File: allowed.txt\n@@\n-original\n+changed\n*** Update File: allowed two.txt\n@@\n-second\n+changed\n*** End Patch' admitted
  assert_success
  assert_output ""
  assert_equal "$(cat "$SCOPE_LEAF/allowed.txt")" changed
  assert_equal "$(cat "$SCOPE_LEAF/allowed two.txt")" changed
  assert_equal "$(cat "$SCOPE_LEAF/protected.txt")" sentinel
}

@test "scope-guard Codex patch: admitted rename to a space path proceeds" {
  _create_codex_patch_fixture
  _run_codex_patch_guard $'*** Begin Patch\n*** Update File: allowed.txt\n*** Move to: allowed two.txt\n@@\n-original\n+original\n*** End Patch' rename allowed.txt 'allowed two.txt'
  assert_success
  assert_output ""
  [ ! -e "$SCOPE_LEAF/allowed.txt" ]
  assert_equal "$(cat "$SCOPE_LEAF/allowed two.txt")" original
  assert_equal "$(cat "$SCOPE_LEAF/protected.txt")" sentinel
}

@test "scope-guard Codex patch: prefixed content resembling metadata is not a target" {
  _create_codex_patch_fixture
  _run_codex_patch_guard $'*** Begin Patch\n*** Add File: allowed.txt\n+*** Delete File: protected.txt\n+*** Move to: protected.txt\n*** End Patch' none
  assert_success
  assert_output ""
  assert_equal "$(cat "$SCOPE_LEAF/protected.txt")" sentinel
}

@test "scope-guard Codex patch: malformed empty and unrepresentable inventories hard-block" {
  _create_codex_patch_fixture
  local patch
  for patch in '' $'*** Begin Patch\n*** End Patch' \
    $'*** Begin Patch\n*** Add File: allowed.txt\n+content' \
    $'*** Begin Patch\n*** Update File: allowed.txt\n*** Move to: \n@@\n-original\n+new\n*** End Patch' \
    $'*** Begin Patch\n*** Add File: allowed.txt\n+ok\n*** Move to: protected.txt\n*** End Patch' \
    $'*** Begin Patch\n*** Add File: allowed\tname.txt\n+content\n*** End Patch'; do
    _run_codex_patch_guard "$patch"
    _assert_patch_unchanged
    assert_output --partial 'target inventory'
  done
}

@test "scope-guard Codex patch: multiple advisory targets consume one strike per tool" {
  _create_codex_patch_fixture
  _run_codex_patch_guard $'*** Begin Patch\n*** Add File: unmatched-one.txt\n+one\n*** Add File: unmatched-two.txt\n+two\n*** End Patch' none
  assert_success
  assert_output --partial 'strike 1 of 3'
  refute_output --partial 'strike 2 of 3'
}

@test "scope-guard Codex patch: advisory first cannot bypass hard refusal or consume a strike" {
  _create_codex_patch_fixture
  _run_codex_patch_guard $'*** Begin Patch\n*** Add File: unmatched.txt\n+one\n*** Delete File: protected.txt\n*** End Patch'
  _assert_patch_unchanged
}

@test "scope-guard Codex patch: admitted first cannot bypass foreign target" {
  _create_codex_patch_fixture
  local foreign="$BATS_TEST_TMPDIR/foreign.txt" patch
  printf 'foreign-sentinel\n' > "$foreign"
  patch="$(printf '*** Begin Patch\n*** Add File: allowed.txt\n+one\n*** Delete File: %s\n*** End Patch' "$foreign")"
  _run_codex_patch_guard "$patch" foreign allowed.txt "$foreign"
  _assert_patch_unchanged
  assert_output --partial 'DIFFERENT repository'
  assert_equal "$(cat "$foreign")" foreign-sentinel
}

@test "scope-guard Codex patch: exempt first cannot bypass later authority load fault" {
  _create_codex_patch_fixture
  printf 'invalid: [\n' > "$SCOPE_REPO/.caws/policy.yaml"
  _run_codex_patch_guard $'*** Begin Patch\n*** Add File: docs/note.md\n+one\n*** Delete File: protected.txt\n*** End Patch'
  _assert_patch_unchanged
  assert_output --partial 'could not render the structured diagnostic'
}

@test "scope-guard: fails closed (hard block) when the JSON diagnostic is unparseable" {
  # check refuses (exit 1) but `scope show --json` returns garbage: the hook must
  # emit a hard block, NOT silently admit and NOT resurrect an inline parser.
  # This exercises the shared _scope_env_block fail-closed path (the same path
  # the missing-`caws` branch uses) deterministically, without fighting the
  # lib-sourcing toolchain deps an isolated PATH would strip.
  _run_scope_guard_with_stub "packages/elsewhere/nope.ts" 1 "this is not json"
  _assert_hard_block_without_strike
  assert_output --partial 'could not render the structured diagnostic'
}

# CAWS-DEFECT-SCOPE-GUARD-FOREIGN-WORKTREE-CONTAINMENT-BYPASS-01. A write into
# ANOTHER repository's linked worktree must take the foreign-repo containment
# block on the first attempt. resolve_worktree_root is a path-shape match, so
# before the fix the foreign worktree was adopted as WORK_DIR, the path went
# worktree-relative, and the guard ran THIS repo's scope evaluation on the OTHER
# repo's file — the strike ramp instead of the hard block. The stub ADMITs on
# purpose: if the containment branch is skipped, the guard exits 0 silently, so
# a silent pass here IS the defect, not a success.
@test "scope-guard: a write into ANOTHER repository's linked worktree is hard-blocked as foreign (no strike ramp)" {
  # Harness file paths are normalized; mktemp under a trailing-slash TMPDIR
  # (macOS) yields `T//caws-…`, which would trip the foreign block on the
  # double slash alone and make this test pass for the wrong reason.
  local foreign
  foreign="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/caws-bats-foreign-XXXXXX")" && pwd)"
  mkdir -p "$foreign/.caws/worktrees/wt-x/src"
  printf 'export const x = 1;\n' > "$foreign/.caws/worktrees/wt-x/src/f.ts"
  _run_scope_guard_with_stub "$foreign/.caws/worktrees/wt-x/src/f.ts" 0 ""
  rm -rf "$foreign"
  assert_equal "$status" 2
  assert_output --partial '"decision": "block"'
  assert_output --partial 'DIFFERENT repository'
  # The block names the foreign repository the worktree belongs to.
  assert_output --partial "linked worktree of $foreign"
  # No strike ramp: the containment block exits before the strike counter.
  refute_output --partial 'strike 1 of 3'
}

# Positive control for the ownership check: a write into one of THIS
# repository's own linked worktrees must still adopt that worktree as WORK_DIR
# and be evaluated worktree-relative. The refusal names `src/f.ts` — not the
# `.caws/worktrees/...` path (which the `.caws/` allow-prefix would silently
# admit) and not a foreign-repository block.
@test "scope-guard: a write into THIS repository's own linked worktree stays worktree-relative (not foreign)" {
  local json='{"decision":"reject","rule":"scope.reject.root_not_allowed","path":"src/f.ts","bindingState":"bound","mode":"authoritative","boundSpecId":"FIX-1"}'
  local own
  own="$(cd "$CAWS_TEST_REPO" && pwd)"
  mkdir -p "$own/.caws/worktrees/wt-own/src"
  printf 'export const x = 1;\n' > "$own/.caws/worktrees/wt-own/src/f.ts"
  _run_scope_guard_with_stub "$own/.caws/worktrees/wt-own/src/f.ts" 1 "$json"
  refute_output --partial 'DIFFERENT repository'
  assert_output --partial "for 'src/f.ts'"
}

# --- CLAIM-ORACLE-DIRECTORY-CONTAINMENT-001 (shell-copy containment) ---------
# scope-guard.sh consumes the shell-embedded matcher in lib/caws-state.sh. It
# must answer the same matrix the oracle .cjs is pinned to by
# tests/hooks/pytest/test_worktree_claim_oracle.py: directory entries claim
# their subtree, the "/" boundary is respected, and an all-slash entry claims
# nothing.

_matcher_verdict() { # $1 = pattern, $2 = path -> prints "true"|"false"
  env -i PATH="$PATH" HOOKS="$CAWS_TEST_HOOKS_DIR" PATTERN="$1" TARGET="$2" bash -c '
    source "$HOOKS/lib/caws-state.sh" >/dev/null 2>&1
    node -e "$CAWS_NODE_GLOB_TO_SCOPE_REGEXP
process.stdout.write(String(globToRegExp(process.env.PATTERN).test(process.env.TARGET)))"
  ' 2>/dev/null
}

@test "scope-glob shell copy: directory entries claim their subtree (CONTAIN A1)" {
  [ "$(_matcher_verdict 'packages/dir/' 'packages/dir/file.py')" = "true" ]
  [ "$(_matcher_verdict 'packages/dir' 'packages/dir/file.py')" = "true" ]
}

@test "scope-glob shell copy: the / boundary is respected (CONTAIN A2)" {
  [ "$(_matcher_verdict 'packages/dir' 'packages/directory/file.py')" = "false" ]
}

@test "scope-glob shell copy: an all-slash entry claims nothing (CONTAIN A3)" {
  [ "$(_matcher_verdict '/' 'packages/dir/file.py')" = "false" ]
}

# ─── FILE_PATH normalization (CAWS-DEFECT-SCOPE-GUARD-FILE-PATH-NOT-NORMALIZED-01)
#
# PROJECT_DIR is `cd && pwd`-normalized at line 234; FILE_PATH was taken from
# the envelope verbatim. Containment then compared a normalized prefix against
# an unnormalized path, so an absolute path INSIDE the governed project could
# fail `$FILE_PATH == $PROJECT_DIR/*` and take the foreign hard block — exit 2,
# "There is no in-band override", for a file in the agent's own repo.
#
# The file already states the rule it failed to apply: owned_worktree_root()
# says "Compare like with like" and normalizes its candidate. This applies the
# same rule to FILE_PATH.
#
# The oracle is the BLOCK TEXT, not the exit status: an admitted Write exits 0
# silently, and so does a guard that skipped the branch for an unrelated reason
# — so every arm asserts on 'DIFFERENT repository' presence or absence.

@test "scope-guard: an in-repo path with a REDUNDANT SEPARATOR is not foreign" {
  # The reported reproduction: a TMPDIR ending in '/' yields '…/T//repo/x.ts'.
  # Lexically that is the same file; to the unfixed prefix test it was another
  # repository.
  _run_scope_guard_with_stub "$CAWS_TEST_REPO//src/app.ts" 0 ""
  refute_output --partial 'DIFFERENT repository'
  assert_equal "$status" 0
}

@test "scope-guard: an in-repo path with '.' and '..' segments is not foreign" {
  # Resolves back inside the project, so it must be adjudicated on its merits.
  _run_scope_guard_with_stub "$CAWS_TEST_REPO/./src/../src/app.ts" 0 ""
  refute_output --partial 'DIFFERENT repository'
  assert_equal "$status" 0
}

@test "scope-guard: normalization does not require the target to EXIST" {
  # A Write creates a file that is not on disk yet, and may create its parent
  # too. A resolution strategy depending on the path existing would fail on
  # exactly the tool this guard must govern.
  _run_scope_guard_with_stub "$CAWS_TEST_REPO//does/not/exist/yet.ts" 0 ""
  refute_output --partial 'DIFFERENT repository'
  assert_equal "$status" 0
}

@test "scope-guard: a normalized in-repo path is still REFUSED when the kernel refuses" {
  # Non-vacuity for the three arms above. They assert the foreign branch is
  # skipped; this proves skipping it does not admit everything — the path still
  # reaches the kernel decision and a refusal still refuses.
  _run_scope_guard_with_stub "$CAWS_TEST_REPO//src/app.ts" 1 \
    '{"decision":"refuse","reason":"not in the defined scope","spec":"TEST-001"}'
  refute_output --partial 'DIFFERENT repository'
  assert_output --partial 'not in the defined scope'
}

@test "scope-guard: '..' that ESCAPES the project is still foreign after normalization" {
  # The containment half of the invariant: the fix may only NARROW the foreign
  # set. A path that resolves outside must still take the hard block, and
  # normalization is what makes this case DETECTABLE rather than a string
  # comparison that happened to fail.
  local outside
  outside="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/caws-bats-outside-XXXXXX")" && pwd)"
  mkdir -p "$outside/src"
  _run_scope_guard_with_stub "$CAWS_TEST_REPO/../$(basename "$outside")/src/f.ts" 0 ""
  rm -rf "$outside"
  assert_equal "$status" 2
  assert_output --partial 'DIFFERENT repository'
}

@test "scope-guard: a foreign path with a redundant separator is still foreign" {
  # The other direction of the same invariant: normalization must not turn a
  # genuinely foreign path into an in-repo one. This is the arm that would fail
  # if the fix collapsed separators by, say, stripping the project prefix
  # loosely instead of comparing normalized absolute paths.
  local foreign
  foreign="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/caws-bats-foreign2-XXXXXX")" && pwd)"
  mkdir -p "$foreign/src"
  _run_scope_guard_with_stub "$foreign//src/f.ts" 0 ""
  rm -rf "$foreign"
  assert_equal "$status" 2
  assert_output --partial 'DIFFERENT repository'
}
