#!/usr/bin/env bats
# Write guards must never compare an unresolved path. When the shared path
# normalizer cannot run (python3 absent from PATH, or present but failing),
# worktree-write-guard and bash-write-guard refuse with exit 2 instead of
# admitting a write into a worktree owned by a different session
# (CAWS-DEFECT-REALPATH-PYTHON-ABSENT-FAIL-OPEN-01).
#
# HOOK_* is precomputed, as the typed engine's handler executor does, so
# parse-input.sh takes its fast path and never runs python3; the original
# payload still travels in HOOK_INPUT_JSON. Between cases only the
# availability of path normalization varies.
#
# A global python3 failure stops at each guard's FIRST normalization, so the
# sweeps below fail one normalization at a time (the Nth call of the exact
# realpath program, all other python3 use passes through) across scenarios that
# reach every caller, including late Bash target, dynamic-prefix and Git
# metadata normalization.
#
# CAWS_GUARD_REALPATH_DIR selects the guard tree under test (default: the pack
# installed by helpers.bash); CAWS_GUARD_REALPATH_CLI the CLI providing
# `hooks mutation-view` (default: helpers.bash's built entry);
# CAWS_GUARD_REALPATH_HELPERS selects helpers.bash when this file runs from
# outside tests/hooks/bats.

bats_require_minimum_version 1.5.0
load "${CAWS_GUARD_REALPATH_HELPERS:-helpers}"

guard_dir() {
  printf '%s\n' "${CAWS_GUARD_REALPATH_DIR:-$CAWS_TEST_HOOKS_DIR}"
}

setup_file() {
  caws_install_pack_once claude-code
  local repo
  repo="$(cd "$CAWS_TEST_REPO" && pwd -P)"
  git -C "$repo" worktree add -q -b caws/s-wt "$repo/.caws/worktrees/s-wt"
  git -C "$repo" worktree add -q -b caws/f-wt "$repo/.caws/worktrees/f-wt"
  jq -n --arg r "$repo" '{
      "s-wt": {name: "s-wt", branch: "caws/s-wt", baseBranch: "main",
               path: ($r + "/.caws/worktrees/s-wt"), spec_id: "FIX-S-1",
               owner: {session_id: "rp-session-s"}},
      "f-wt": {name: "f-wt", branch: "caws/f-wt", baseBranch: "main",
               path: ($r + "/.caws/worktrees/f-wt"), spec_id: "FIX-F-1",
               owner: {session_id: "rp-session-f"}}
    }' > "$repo/.caws/worktrees.json"
  ln -s "$repo" "$CAWS_TEST_HOME/repo-alias"

  export RP_REAL_PYTHON
  RP_REAL_PYTHON="$(command -v python3)"

  # python3 resolves on PATH but every invocation fails.
  mkdir -p "$CAWS_TEST_HOME/failing-python"
  printf '#!/bin/sh\nexit 1\n' > "$CAWS_TEST_HOME/failing-python/python3"
  chmod +x "$CAWS_TEST_HOME/failing-python/python3"

  # python3 that forwards to the real interpreter, counts each call of the
  # exact realpath program, and fails only the RP_FAIL_NTH-th such call.
  mkdir -p "$CAWS_TEST_HOME/counting-python"
  cat > "$CAWS_TEST_HOME/counting-python/python3" <<'SHIM'
#!/bin/bash
program='import os, sys; print(os.path.realpath(sys.argv[1]))'
if [[ "$1" == -c && "$2" == "$program" && -n "${RP_COUNT_FILE:-}" ]]; then
  n=$(( $(cat "$RP_COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
  printf '%s\n' "$n" > "$RP_COUNT_FILE"
  printf '%s\t%s\n' "$n" "$3" >> "$RP_COUNT_FILE.paths"
  [[ "$n" == "${RP_FAIL_NTH:-0}" ]] && exit 1
fi
exec "$RP_REAL_PYTHON" "$@"
SHIM
  chmod +x "$CAWS_TEST_HOME/counting-python/python3"

  # A tool farm without python3; the precondition test proves its contents.
  mkdir -p "$CAWS_TEST_HOME/no-python"
  local tool source
  for tool in bash sh env git node jq cat sed awk grep cut tr head tail \
    dirname basename mktemp date readlink rm mkdir mv cp printf wc sort uniq \
    uname id ps stat touch ls find xargs tee sleep; do
    source="$(command -v "$tool" 2>/dev/null || true)"
    case "$source" in /*) ln -s "$source" "$CAWS_TEST_HOME/no-python/$tool" ;; esac
  done

  # Identity-drop control: the guard tree under test with the checked
  # normalizer replaced by the best-effort one. It must reproduce the
  # unrepaired admission, or the refusal assertions below prove nothing.
  cp -R "$(guard_dir)" "$CAWS_TEST_HOME/identity-drop"
  printf '\ncaws_guard_realpath() { _realpath "$@"; }\n' \
    >> "$CAWS_TEST_HOME/identity-drop/lib/caws-state.sh"

  export RP_CLI="${CAWS_GUARD_REALPATH_CLI:-$CLI_DIST_ENTRY}"
  export RP_REPO="$repo"
  export RP_SELF="$repo/.caws/worktrees/s-wt"
  export RP_TARGET="$repo/.caws/worktrees/f-wt/src/payload.ts"
  # The same foreign target spelled through the operating worktree: only
  # normalization reveals that it names f-wt rather than s-wt.
  export RP_DOTDOT_TARGET="$repo/.caws/worktrees/s-wt/../f-wt/src/payload.ts"
}

teardown_file() {
  caws_teardown_pack
}

write_payload() {
  jq -nc --arg f "$1" --arg c "$RP_SELF" \
    '{tool_name: "Write", tool_input: {file_path: $f, content: "x"}, cwd: $c}'
}

bash_payload() {
  jq -nc --arg k "$1" --arg c "$RP_SELF" \
    '{tool_name: "Bash", tool_input: {command: $k}, cwd: $c}'
}

# Usage: rp_guard <guard-dir> <guard.sh> <PATH> <session> <payload-json>
rp_guard() {
  local dir="$1" guard="$2" path_value="$3" session="$4" payload="$5"
  local tool file cmd
  tool="$(jq -r '.tool_name' <<<"$payload")"
  file="$(jq -r '.tool_input.file_path // ""' <<<"$payload")"
  cmd="$(jq -r '.tool_input.command // ""' <<<"$payload")"
  run env -i \
    HOME="$CAWS_TEST_HOME" CAWS_HOME="$CAWS_TEST_HOME/.caws" PATH="$path_value" \
    CAWS_BIN="$RP_CLI" RP_REAL_PYTHON="$RP_REAL_PYTHON" \
    RP_COUNT_FILE="${RP_COUNT_FILE:-}" RP_FAIL_NTH="${RP_FAIL_NTH:-0}" \
    CLAUDE_CODE_SESSION_ID="$session" HOOK_SESSION_ID="$session" \
    CLAUDE_PROJECT_DIR="$RP_SELF" CAWS_PROJECT_DIR="$RP_SELF" \
    CAWS_AGENT_SURFACE=claude-code HOOK_EVENT_NAME=PreToolUse \
    HOOK_PERMISSION_MODE=default HOOK_INPUT_JSON="$payload" \
    HOOK_TOOL_NAME="$tool" HOOK_FILE_PATH="$file" HOOK_COMMAND="$cmd" \
    HOOK_CWD="$RP_SELF" \
    bash -c 'cd "$1" && bash "$2" </dev/null' _ "$RP_SELF" "$dir/$guard"
  printf '# %s session=%s fail_nth=%s status=%s\n# output=%s\n' \
    "$guard" "$session" "${RP_FAIL_NTH:-}" "$status" "$output" >&3
  # The guards adjudicate and never write: no target directory may appear.
  [[ ! -e "$RP_REPO/.caws/worktrees/f-wt/src" ]]
  [[ ! -e "$RP_REPO/src" ]]
}

# Usage: rp_sweep <guard.sh> <session> <payload-json> <expected-pass-status> <label>...
# Runs the scenario with every normalization passing through, then once per
# normalization with only that one failing. Every failing run must refuse 2.
# Each <label> must name a refusal some run produced, proving that caller ran.
rp_sweep() {
  local guard="$1" session="$2" payload="$3" expected="$4"
  shift 4
  local count n labels="" label
  export RP_COUNT_FILE="$BATS_TEST_TMPDIR/count.$guard"
  rm -f "$RP_COUNT_FILE" "$RP_COUNT_FILE.paths"
  RP_FAIL_NTH=0 rp_guard "$(guard_dir)" "$guard" "$CAWS_TEST_HOME/counting-python:$PATH" "$session" "$payload"
  [ "$status" -eq "$expected" ]
  count="$(cat "$RP_COUNT_FILE")"
  printf '# %s normalizations:\n%s\n' "$count" "$(sed 's/^/#   /' "$RP_COUNT_FILE.paths")" >&3
  [ "$count" -ge 1 ]
  for ((n = 1; n <= count; n++)); do
    rm -f "$RP_COUNT_FILE" "$RP_COUNT_FILE.paths"
    RP_FAIL_NTH="$n" rp_guard "$(guard_dir)" "$guard" "$CAWS_TEST_HOME/counting-python:$PATH" "$session" "$payload"
    [ "$status" -eq 2 ] || { printf 'normalization %s of %s did not refuse\n' "$n" "$count"; false; }
    assert_output --partial "[caws-guard-realpath] cannot normalize: python3-exit-1"
    assert_output --partial "[${guard%.sh}] cannot normalize the "
    # The refusal names the input it could not normalize, never an empty path.
    refute_output --partial "path ''"
    labels+="$output"$'\n'
  done
  unset RP_COUNT_FILE
  for label in "$@"; do
    [[ "$labels" == *"cannot normalize the $label path"* ]] ||
      { printf 'no refusal from the %s normalization\n' "$label"; false; }
  done
}

@test "precondition: the linked worktree has an absolute common dir distinct from its git dir" {
  [ "$(git -C "$RP_SELF" rev-parse --git-common-dir)" = "$RP_REPO/.git" ]
  [ "$(git -C "$RP_SELF" rev-parse --git-dir)" = "$RP_REPO/.git/worktrees/s-wt" ]
}

@test "precondition: the tool farm lacks python3 and carries the core tools" {
  run env -i PATH="$CAWS_TEST_HOME/no-python" bash -c 'command -v python3'
  [ "$status" -ne 0 ]
  local tool
  for tool in bash git node jq cat sed grep cut tr head dirname; do
    [[ -x "$CAWS_TEST_HOME/no-python/$tool" ]]
  done
}

@test "precondition: the analysis CLI provides hooks mutation-view" {
  run "$RP_CLI" hooks mutation-view --help
  [ "$status" -eq 0 ]
}

@test "caws_guard_realpath: python success is byte-identical to the existing normalizer" {
  run bash -c '
    source "$1/lib/caws-state.sh"
    cd "$2"
    shift 2
    for p in "$@"; do
      # Bytes and exit status together: a success value with a refusal status
      # would make every guard refuse a path it could have normalized.
      raw="$(caws_guard_realpath "$p"; printf "x%s" "$?")"
      ref="$(python3 -c "import os, sys; print(os.path.realpath(sys.argv[1]))" "$p"; printf "x%s" "$?")"
      [[ "$raw" == "$ref" ]] || { printf "raw stdout or status differs for %q\n" "$p"; exit 1; }
      [[ "$raw" == *x0 ]] || { printf "status %s for %q\n" "${raw##*x}" "$p"; exit 1; }
      observed="$(caws_guard_realpath "$p")" ||
        { printf "caller-observed status %s for %q\n" "$?" "$p"; exit 1; }
      [[ "$observed" == "$(_realpath "$p")" ]] ||
        { printf "caller-observed value differs for %q\n" "$p"; exit 1; }
    done
  ' _ "$(guard_dir)" "$RP_SELF" \
    "$RP_DOTDOT_TARGET" \
    "$CAWS_TEST_HOME/repo-alias/.caws/worktrees/f-wt/src/new" \
    "$CAWS_TEST_HOME/repo-alias/../link-dotdot-leaf" \
    "/tmp/caws-guard-realpath-missing-leaf" \
    "relative/leaf" \
    "$RP_REPO/ends-with-newline"$'\n'
  [ "$status" -eq 0 ]
}

@test "caws_guard_realpath: resolves dotdot, a symlinked ancestor and dotdot after a symlink by the filesystem" {
  run bash -c 'set -e; source "$1/lib/caws-state.sh"
    caws_guard_realpath "$2"; echo; caws_guard_realpath "$3"; echo; caws_guard_realpath "$4"' \
    _ "$(guard_dir)" "$RP_DOTDOT_TARGET" "$CAWS_TEST_HOME/repo-alias/.caws/worktrees/f-wt/src/new" \
    "$CAWS_TEST_HOME/repo-alias/../link-dotdot-leaf"
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "$RP_TARGET" ]
  [ "${lines[1]}" = "$RP_REPO/.caws/worktrees/f-wt/src/new" ]
  # dotdot after a symlink climbs from the link's target, not lexically.
  [ "${lines[2]}" = "$(dirname "$RP_REPO")/link-dotdot-leaf" ]
  [ "${lines[2]}" != "$CAWS_TEST_HOME/link-dotdot-leaf" ]
}

@test "caws_guard_realpath: an empty path is refused with its class" {
  run --separate-stderr bash -c 'source "$1/lib/caws-state.sh"; caws_guard_realpath ""' _ "$(guard_dir)"
  [ "$status" -eq 2 ]
  [ -z "$output" ]
  [ "$stderr" = "[caws-guard-realpath] cannot normalize: empty-path" ]
}

@test "caws_guard_realpath: python3 absent is refused with its class" {
  run --separate-stderr env -i PATH="$CAWS_TEST_HOME/no-python" \
    bash -c 'source "$1/lib/caws-state.sh"; caws_guard_realpath "$2"' _ "$(guard_dir)" "$RP_TARGET"
  [ "$status" -eq 2 ]
  [ -z "$output" ]
  [ "$stderr" = "[caws-guard-realpath] cannot normalize: python3-unavailable" ]
}

@test "caws_guard_realpath: a failing python3 is refused with its exit status" {
  run --separate-stderr env PATH="$CAWS_TEST_HOME/failing-python:$PATH" \
    bash -c 'set -e; source "$1/lib/caws-state.sh"; caws_guard_realpath "$2"' _ "$(guard_dir)" "$RP_TARGET"
  [ "$status" -eq 2 ]
  [ -z "$output" ]
  [ "$stderr" = "[caws-guard-realpath] cannot normalize: python3-exit-1" ]
}

@test "worktree-write-guard: python3 present blocks a foreign-owned payload write" {
  rp_guard "$(guard_dir)" worktree-write-guard.sh "$PATH" rp-session-s "$(write_payload "$RP_TARGET")"
  [ "$status" -eq 2 ]
  assert_output --partial "BLOCKED: this is a write into worktree 'f-wt''s payload"
}

@test "worktree-write-guard: python3 present admits the owning session" {
  rp_guard "$(guard_dir)" worktree-write-guard.sh "$PATH" rp-session-f "$(write_payload "$RP_TARGET")"
  [ "$status" -eq 0 ]
  refute_output --partial "BLOCKED"
}

@test "worktree-write-guard: a failing python3 refuses instead of comparing an unresolved path" {
  rp_guard "$(guard_dir)" worktree-write-guard.sh "$CAWS_TEST_HOME/failing-python:$PATH" rp-session-s \
    "$(write_payload "$RP_TARGET")"
  [ "$status" -eq 2 ]
  assert_output --partial "[caws-guard-realpath] cannot normalize: python3-exit-1"
  assert_output --partial "[worktree-write-guard] cannot normalize the "
}

@test "worktree-write-guard: python3 absent refuses instead of comparing an unresolved path" {
  rp_guard "$(guard_dir)" worktree-write-guard.sh "$CAWS_TEST_HOME/no-python" rp-session-s \
    "$(write_payload "$RP_TARGET")"
  refute_output --partial "command not found"
  [ "$status" -eq 2 ]
  assert_output --partial "[caws-guard-realpath] cannot normalize: python3-unavailable"
}

@test "worktree-write-guard identity-drop control: unchecked normalization admits the foreign write" {
  rp_guard "$CAWS_TEST_HOME/identity-drop" worktree-write-guard.sh \
    "$CAWS_TEST_HOME/failing-python:$PATH" rp-session-s "$(write_payload "$RP_TARGET")"
  [ "$status" -eq 0 ]
  refute_output --partial "BLOCKED"
  rp_guard "$CAWS_TEST_HOME/identity-drop" worktree-write-guard.sh \
    "$CAWS_TEST_HOME/no-python" rp-session-s "$(write_payload "$RP_TARGET")"
  [ "$status" -eq 0 ]
  refute_output --partial "BLOCKED"
}

@test "worktree-write-guard sweep: each normalization on the foreign-payload path refuses when it alone fails" {
  rp_sweep worktree-write-guard.sh rp-session-s "$(write_payload "$RP_TARGET")" 2 \
    "git common dir" "git dir" "canonical root" "spec-materialization target" "allowlist target"
}

@test "worktree-write-guard sweep: each normalization on the canonical-claim path refuses when it alone fails" {
  rp_sweep worktree-write-guard.sh rp-session-s "$(write_payload "$RP_REPO/src/claimed.ts")" 0 \
    "operating directory" "canonical-claim target"
}

@test "worktree-write-guard sweep: a relative target reaches the relative canonical-claim normalization" {
  rp_sweep worktree-write-guard.sh rp-session-s "$(write_payload "src/claimed.ts")" 0 \
    "spec-materialization target" "operating directory" "canonical-claim target"
}

@test "bash-write-guard: python3 present blocks a foreign-owned payload mutation spelled through dotdot" {
  rp_guard "$(guard_dir)" bash-write-guard.sh "$PATH" rp-session-s "$(bash_payload "touch $RP_DOTDOT_TARGET")"
  [ "$status" -eq 2 ]
  assert_output --partial "BLOCKED: this Bash command mutates worktree 'f-wt''s payload"
}

@test "bash-write-guard: python3 present admits the owning session" {
  rp_guard "$(guard_dir)" bash-write-guard.sh "$PATH" rp-session-f "$(bash_payload "touch $RP_DOTDOT_TARGET")"
  [ "$status" -eq 0 ]
  refute_output --partial "BLOCKED"
}

@test "bash-write-guard: a failing python3 refuses instead of comparing an unresolved path" {
  rp_guard "$(guard_dir)" bash-write-guard.sh "$CAWS_TEST_HOME/failing-python:$PATH" rp-session-s \
    "$(bash_payload "touch $RP_DOTDOT_TARGET")"
  [ "$status" -eq 2 ]
  assert_output --partial "[caws-guard-realpath] cannot normalize: python3-exit-1"
  assert_output --partial "[bash-write-guard] cannot normalize the project root path"
}

@test "bash-write-guard: python3 absent refuses instead of comparing an unresolved path" {
  rp_guard "$(guard_dir)" bash-write-guard.sh "$CAWS_TEST_HOME/no-python" rp-session-s \
    "$(bash_payload "touch $RP_DOTDOT_TARGET")"
  refute_output --partial "command not found"
  [ "$status" -eq 2 ]
  assert_output --partial "[caws-guard-realpath] cannot normalize: python3-unavailable"
}

@test "bash-write-guard identity-drop control: unchecked normalization admits the foreign mutation" {
  rp_guard "$CAWS_TEST_HOME/identity-drop" bash-write-guard.sh \
    "$CAWS_TEST_HOME/failing-python:$PATH" rp-session-s "$(bash_payload "touch $RP_DOTDOT_TARGET")"
  [ "$status" -eq 0 ]
  refute_output --partial "BLOCKED"
  rp_guard "$CAWS_TEST_HOME/identity-drop" bash-write-guard.sh \
    "$CAWS_TEST_HOME/no-python" rp-session-s "$(bash_payload "touch $RP_DOTDOT_TARGET")"
  [ "$status" -eq 0 ]
  refute_output --partial "BLOCKED"
}

@test "bash-write-guard sweep: the static mutation target refuses when its normalization alone fails" {
  rp_sweep bash-write-guard.sh rp-session-s "$(bash_payload "touch $RP_DOTDOT_TARGET")" 2 \
    "project root" "mutation target"
}

# Analysis tokens carry no lexically proven prefix (bash-mutation-analysis.sh
# caws_bash_load_analysis_tokens), so a dynamic operand is held for approval
# and its prefix is never normalized. If prefixes are ever projected, this
# test fails and the dynamic-prefix refusal must be swept like the others.
@test "bash-write-guard sweep: a dynamic operand is held for approval and every normalization it reaches refuses alone" {
  local payload
  payload="$(bash_payload "touch $RP_REPO/.caws/worktrees/f-wt/src/\$RP_UNSET_NAME")"
  rp_sweep bash-write-guard.sh rp-session-s "$payload" 0 "project root"
  RP_FAIL_NTH=0 rp_guard "$(guard_dir)" bash-write-guard.sh "$PATH" rp-session-s "$payload"
  [ "$status" -eq 0 ]
  assert_output --partial '"permissionDecision": "ask"'
  assert_output --partial "ask_dynamic_unconfined"
  refute_output --partial "dynamic mutation prefix"
}

@test "bash-write-guard sweep: Git metadata refuses when its normalization alone fails" {
  rp_sweep bash-write-guard.sh rp-session-s \
    "$(bash_payload "git -C $RP_REPO/.caws/worktrees/f-wt add README.md")" 2 \
    "project root" "git metadata"
}

@test "contract: every normalization in both write guards is checked" {
  local guard file lines unchecked
  for guard in worktree-write-guard.sh bash-write-guard.sh; do
    file="$(guard_dir)/$guard"
    run grep -n -F '$(_realpath ' "$file"
    [ "$status" -eq 1 ]
    lines="$(grep -E '\$\((caws_guard_realpath|abspath) ' "$file")"
    [[ -n "$lines" ]]
    unchecked="$(printf '%s\n' "$lines" | grep -v -E '\|\| _(wwg|bwg)_normalize_refuse ' || true)"
    [[ -z "$unchecked" ]] || { printf '%s unchecked:\n%s\n' "$guard" "$unchecked"; false; }
  done
}
