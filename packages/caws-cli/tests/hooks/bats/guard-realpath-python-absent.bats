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
# reach every reachable caller: all worktree-write-guard normalizations, and the
# bash-write-guard project root, static mutation target and Git metadata
# normalizations. The bash-write-guard dynamic-prefix normalization is not
# reachable: analysis tokens carry no lexically proven prefix, so a dynamic
# operand is held for approval first. A separate test pins that conservative
# ask and fails if prefixes are ever projected.
#
# Path identity: guards compare paths as exact bytes, and a legitimate root may
# end in a line feed, which command substitution strips. The identity cases
# build each root's expected bytes in the fixture and run every scenario at an
# ordinary root first as the control. A root the Bash analysis transport
# cannot carry must be refused naming that, never admitted or misattributed.
#
# The same holds for the other tools the guards decide with: without git the
# canonical root and ownership are unknown, and without node
# worktree-write-guard cannot read the registry or the canonical scope claims.
# Either is refused naming the tool, never read as nothing to govern.
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

# Usage: rp_make_layout <physical-root> [<branch>] [<registry-base-branch>]
# A governed repository at exactly <physical-root> on <branch> (default main):
# tracked .caws content (so linked worktrees carry a .caws directory, as real
# ones do), an untracked registry, and linked worktrees s-wt and f-wt owned by
# different sessions, registered against <registry-base-branch> (default
# <branch>).
rp_make_layout() {
  local root="$1" branch="${2:-main}"
  local base="${3:-$branch}"
  mkdir "$root"
  git -C "$root" init -q -b "$branch"
  mkdir -p "$root/.caws/worktrees"
  printf 'version: 1\n' > "$root/.caws/policy.yaml"
  printf '.caws/worktrees/\n.caws/worktrees.json\n' > "$root/.gitignore"
  git -C "$root" add .gitignore .caws/policy.yaml
  git -C "$root" -c user.name='CAWS Test' -c user.email=test@caws.invalid \
    -c commit.gpgsign=false commit -q -m 'root commit'
  git -C "$root" worktree add -q -b caws/s-wt "$root/.caws/worktrees/s-wt"
  git -C "$root" worktree add -q -b caws/f-wt "$root/.caws/worktrees/f-wt"
  jq -n --arg r "$root" --arg b "$base" '{
      "s-wt": {name: "s-wt", branch: "caws/s-wt", baseBranch: $b,
               path: ($r + "/.caws/worktrees/s-wt"), spec_id: "FIX-S-1",
               owner: {session_id: "rp-session-s"}},
      "f-wt": {name: "f-wt", branch: "caws/f-wt", baseBranch: $b,
               path: ($r + "/.caws/worktrees/f-wt"), spec_id: "FIX-F-1",
               owner: {session_id: "rp-session-f"}}
    }' > "$root/.caws/worktrees.json"
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
  # exact realpath program, and answers only the RP_FAIL_NTH-th such call per
  # RP_FAIL_MODE: exit<N> fails with status N; lf, lflf, empty, relative and
  # nodelim exit 0 having written something other than one absolute path and
  # its single record delimiter.
  mkdir -p "$CAWS_TEST_HOME/counting-python"
  cat > "$CAWS_TEST_HOME/counting-python/python3" <<'SHIM'
#!/bin/bash
program='import os, sys; sys.stdout.buffer.write(os.fsencode(os.path.realpath(sys.argv[1])) + b"\n")'
if [[ "$1" == -c && "$2" == "$program" && -n "${RP_COUNT_FILE:-}" ]]; then
  n=$(( $(cat "$RP_COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
  printf '%s\n' "$n" > "$RP_COUNT_FILE"
  printf '%s\t%s\n' "$n" "$3" >> "$RP_COUNT_FILE.paths"
  if [[ "$n" == "${RP_FAIL_NTH:-0}" ]]; then
    case "${RP_FAIL_MODE:-exit1}" in
      lf) printf '\n'; exit 0 ;;
      lflf) printf '\n\n'; exit 0 ;;
      empty) exit 0 ;;
      relative) printf 'relative/leaf\n'; exit 0 ;;
      nodelim) printf '%s' "$3"; exit 0 ;;
      exit*) exit "${RP_FAIL_MODE#exit}" ;;
    esac
  fi
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

  # A git that is on PATH but exits 1 for every call.
  mkdir -p "$CAWS_TEST_HOME/failing-git"
  printf '#!/bin/sh\nexit 1\n' > "$CAWS_TEST_HOME/failing-git/git"
  chmod +x "$CAWS_TEST_HOME/failing-git/git"

  # A tool farm with python3 and the core tools but without git.
  mkdir -p "$CAWS_TEST_HOME/no-git"
  for tool in bash sh env node jq python3 cat sed awk grep cut tr head tail \
    dirname basename mktemp date readlink rm mkdir mv cp printf wc sort uniq \
    uname id ps stat touch ls find xargs tee sleep; do
    source="$(command -v "$tool" 2>/dev/null || true)"
    case "$source" in /*) ln -s "$source" "$CAWS_TEST_HOME/no-git/$tool" ;; esac
  done

  # A tool farm with git, python3 and the core tools but without node.
  mkdir -p "$CAWS_TEST_HOME/no-node"
  for tool in bash sh env git jq python3 cat sed awk grep cut tr head tail \
    dirname basename mktemp date readlink rm mkdir mv cp printf wc sort uniq \
    uname id ps stat touch ls find xargs tee sleep; do
    source="$(command -v "$tool" 2>/dev/null || true)"
    case "$source" in /*) ln -s "$source" "$CAWS_TEST_HOME/no-node/$tool" ;; esac
  done
  # The farm alone does not hide an installed node: runtime-paths.sh looks
  # again in $HOME/.nvm and the standard bin directories. Node absence as the
  # guards see it is a machine where that discovery finds nothing too, so the
  # guard tree under test is copied with only the discovery replaced (it runs
  # when the file is sourced, so it returns at its own definition).
  cp -R "$(guard_dir)" "$CAWS_TEST_HOME/node-hidden"
  sed 's/^ensure_hook_runtime_path() {$/ensure_hook_runtime_path() { return 0/' \
    "$(guard_dir)/runtime-paths.sh" > "$CAWS_TEST_HOME/node-hidden/runtime-paths.sh"

  # Identity-drop control: replace the checked shell normalizer with the
  # best-effort reader. Its unresolved result is checked directly; the
  # independent ownership oracle must retain the foreign-write refusal.
  cp -R "$(guard_dir)" "$CAWS_TEST_HOME/identity-drop"
  printf '\ncaws_guard_realpath_into() { printf -v "$1" "%%s" "$(_realpath "$2")"; }\n' \
    >> "$CAWS_TEST_HOME/identity-drop/lib/caws-state.sh"

  # Path identity: two repositories with the same layout, one at an ordinary
  # physical path and one whose physical path ends in a line feed, each with an
  # ordinary alias. The expected root bytes are built here, never derived from
  # a normalizer under test. Command substitution strips trailing line feeds,
  # so a root capture that is not byte-faithful names a different directory.
  local id_base
  id_base="$(cd "$CAWS_TEST_HOME" && pwd -P)/identity"
  mkdir "$id_base"
  export RP_PLAIN_REPO="$id_base/plain"
  export RP_LF_REPO="$id_base/repo"$'\n'
  export RP_QUOTE_REPO="$id_base/o'brien"
  export RP_GLOB_REPO="$id_base/glob[1]"
  rp_make_layout "$RP_PLAIN_REPO"
  rp_make_layout "$RP_LF_REPO"
  rp_make_layout "$RP_QUOTE_REPO"
  rp_make_layout "$RP_GLOB_REPO"
  # A branch name containing an apostrophe, and registries naming another base
  # branch, so base-branch enforcement must count worktrees from git.
  export RP_QUOTE_BRANCH_REPO="$id_base/branch-quote"
  export RP_FALLBACK_PLAIN_REPO="$id_base/fallback-plain"
  export RP_FALLBACK_LF_REPO="$id_base/fallback"$'\n'
  rp_make_layout "$RP_QUOTE_BRANCH_REPO" "it's"
  rp_make_layout "$RP_FALLBACK_PLAIN_REPO" main elsewhere
  rp_make_layout "$RP_FALLBACK_LF_REPO" main elsewhere
  # Git discovery that fails although a .git entry exists: a nested project
  # directory inside s-wt, and a layout whose s-wt admin directory is gone
  # (as after a prune) while the checkout remains. A directory outside every
  # repository is the ungoverned control.
  mkdir -p "$RP_PLAIN_REPO/.caws/worktrees/s-wt/src/nested"
  export RP_ADMIN_REPO="$id_base/admin-loss"
  rp_make_layout "$RP_ADMIN_REPO"
  rm -rf "$RP_ADMIN_REPO/.git/worktrees/s-wt"
  export RP_NONREPO="$id_base/nonrepo"
  mkdir "$RP_NONREPO"
  # A canonical path claimed by f-wt's active spec, which only the claim
  # oracle (node) can read.
  export RP_CLAIM_REPO="$id_base/claim"
  rp_make_layout "$RP_CLAIM_REPO"
  mkdir -p "$RP_CLAIM_REPO/.caws/specs"
  printf 'id: FIX-F-1\nlifecycle_state: active\nworktree: f-wt\nscope:\n  in:\n    - src/claimed.ts\n' \
    > "$RP_CLAIM_REPO/.caws/specs/FIX-F-1.yaml"

  # A git without `worktree list -z` (before 2.36): that one form fails as
  # git does for an unknown option; every other call goes to the real git.
  export RP_REAL_GIT
  RP_REAL_GIT="$(command -v git)"
  mkdir -p "$CAWS_TEST_HOME/git-without-z"
  cat > "$CAWS_TEST_HOME/git-without-z/git" <<'SHIM'
#!/bin/bash
args=" $* "
if [[ "$args" == *" worktree list "* && "$args" == *" -z "* ]]; then
  echo "error: unknown switch \`z'" >&2
  exit 129
fi
exec "$RP_REAL_GIT" "$@"
SHIM
  chmod +x "$CAWS_TEST_HOME/git-without-z/git"

  # Git that answers every query but the guards' exact `rev-parse
  # --git-common-dir` (failing, or naming a directory that does not exist);
  # the analyzer's multi-option query is a different call and still answers.
  mkdir -p "$CAWS_TEST_HOME/partial-git" "$CAWS_TEST_HOME/bogus-common-git"
  cat > "$CAWS_TEST_HOME/partial-git/git" <<'SHIM'
#!/bin/bash
[[ $# -eq 2 && "$1" == rev-parse && "$2" == --git-common-dir ]] && exit 128
exec "$RP_REAL_GIT" "$@"
SHIM
  cat > "$CAWS_TEST_HOME/bogus-common-git/git" <<'SHIM'
#!/bin/bash
if [[ $# -eq 2 && "$1" == rev-parse && "$2" == --git-common-dir ]]; then
  printf '/nonexistent-caws-common/.git\n'; exit 0
fi
exec "$RP_REAL_GIT" "$@"
SHIM
  chmod +x "$CAWS_TEST_HOME/partial-git/git" "$CAWS_TEST_HOME/bogus-common-git/git"

  # Instrumentation for base-branch enforcement: a caws that records, NUL
  # terminated, the path worktree-write-guard hands to `scope contention` and
  # answers clear; every other subcommand goes to the real CLI.
  export RP_REAL_CAWS
  RP_REAL_CAWS="$(command -v caws || true)"
  mkdir -p "$CAWS_TEST_HOME/contention-caws"
  cat > "$CAWS_TEST_HOME/contention-caws/caws" <<'SHIM'
#!/bin/bash
if [[ "${1:-}" == scope && "${2:-}" == contention ]]; then
  printf '%s\0' "${3-}" >> "$RP_CONTENTION_LOG"
  printf '{"status":"clear"}\n'
  exit 0
fi
[[ -n "${RP_REAL_CAWS:-}" ]] || exit 127
exec "$RP_REAL_CAWS" "$@"
SHIM
  chmod +x "$CAWS_TEST_HOME/contention-caws/caws"
  ln -s "$RP_PLAIN_REPO" "$id_base/plain-alias"
  ln -s "$RP_LF_REPO" "$id_base/lf-alias"
  export RP_PLAIN_ALIAS="$id_base/plain-alias"
  export RP_LF_ALIAS="$id_base/lf-alias"

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
    RP_FAIL_MODE="${RP_FAIL_MODE:-exit1}" \
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

# Usage: rp_sweep <mode> <guard.sh> <session> <payload-json> <expected-pass-status> <label>...
# Runs the scenario with every normalization passing through, then once per
# normalization with only that one answered per <mode> (see the counting shim).
# Every such run must refuse 2 naming the cause. Each <label> must name a
# refusal some run produced, proving that caller ran.
rp_sweep() {
  local mode="$1" guard="$2" session="$3" payload="$4" expected="$5"
  shift 5
  local count n labels="" label cause
  case "$mode" in
    exit*) cause="python3-exit-${mode#exit}" ;;
    lf) cause=empty-result ;;
    lflf|relative) cause=non-absolute-result ;;
    empty|nodelim) cause=no-record-delimiter ;;
  esac
  export RP_FAIL_MODE="$mode"
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
    assert_output --partial "[caws-guard-realpath] cannot normalize: $cause"
    assert_output --partial "[${guard%.sh}] cannot normalize the "
    # The refusal names the input it could not normalize, never an empty path.
    refute_output --partial "path ''"
    labels+="$output"$'\n'
  done
  unset RP_COUNT_FILE RP_FAIL_MODE
  for label in "$@"; do
    [[ "$labels" == *"cannot normalize the $label path"* ]] ||
      { printf 'no refusal from the %s normalization\n' "$label"; false; }
  done
}

# Usage: id_guard <guard.sh> <repo> <operating-dir> <tool> <file-path-or-command>
# Session rp-session-s (RP_ID_SESSION overrides) operates at <operating-dir>
# and targets f-wt, which rp-session-f owns. The payload carries every path
# byte-faithfully. RP_ID_NODE_PATH lets the claim oracle resolve js-yaml.
id_guard() {
  local guard="$1" repo="$2" op="$3" tool="$4" arg="$5" payload file="" cmd=""
  # RP_ID_CWD moves the session's working directory away from its project;
  # RP_ID_NO_CWD=1 sends a payload without cwd (the process still runs there).
  local cwd="${RP_ID_CWD:-$op}" hook_cwd
  hook_cwd="$cwd"
  [[ "${RP_ID_NO_CWD:-0}" == 1 ]] && hook_cwd=""
  case "$tool" in
    Write)
      file="$arg"
      payload="$(jq -nc --arg f "$arg" --arg c "$hook_cwd" \
        '{tool_name: "Write", tool_input: {file_path: $f, content: "x"}} + (if $c == "" then {} else {cwd: $c} end)')" ;;
    Bash)
      cmd="$arg"
      payload="$(jq -nc --arg k "$arg" --arg c "$hook_cwd" \
        '{tool_name: "Bash", tool_input: {command: $k}} + (if $c == "" then {} else {cwd: $c} end)')" ;;
  esac
  run env -i \
    HOME="$CAWS_TEST_HOME" CAWS_HOME="$CAWS_TEST_HOME/.caws" PATH="${RP_ID_PATH:-$PATH}" \
    CAWS_BIN="$RP_CLI" RP_CONTENTION_LOG="${RP_CONTENTION_LOG:-}" RP_REAL_CAWS="$RP_REAL_CAWS" \
    RP_REAL_GIT="$RP_REAL_GIT" ${RP_ID_NODE_PATH:+"NODE_PATH=$RP_ID_NODE_PATH"} \
    CLAUDE_CODE_SESSION_ID="${RP_ID_SESSION:-rp-session-s}" HOOK_SESSION_ID="${RP_ID_SESSION:-rp-session-s}" \
    CLAUDE_PROJECT_DIR="$op" CAWS_PROJECT_DIR="$op" \
    CAWS_AGENT_SURFACE="${RP_ID_SURFACE:-claude-code}" HOOK_EVENT_NAME=PreToolUse \
    HOOK_PERMISSION_MODE="${RP_ID_MODE:-default}" HOOK_INPUT_JSON="$payload" \
    HOOK_TOOL_NAME="$tool" HOOK_FILE_PATH="$file" HOOK_COMMAND="$cmd" \
    HOOK_CWD="$hook_cwd" \
    bash -c 'cd "$1" && bash "$2" </dev/null' _ "$cwd" "$(guard_dir)/$guard"
  printf '# %s surface=%s op=%q cwd=%q hook_cwd=%q status=%s\n# output=%s\n' "$guard" \
    "${RP_ID_SURFACE:-claude-code}" "$op" "$cwd" "$hook_cwd" "$status" "$output" >&3
  [[ ! -e "$repo/.caws/worktrees/f-wt/src" ]]
}

# Usage: id_case <guard.sh> <canonical|alias|linked> <Write|Bash> <same|transport-hold>
# Runs one scenario against the ordinary-path repository, then the identical
# scenario against the repository whose root ends in a line feed. The ordinary
# run is the control: it must refuse, or the fixture proves nothing. With
# `same` the line-feed run must produce the control's exact refusal, which
# names no root. With `transport-hold` the operating directory's physical path
# holds the line feed, which the Bash analysis transport cannot carry (the
# analyzer resolves an alias to that path), and the run must be refused naming
# exactly that physical path.
id_case() {
  local guard="$1" kind="$2" tool="$3" expect="$4" variant repo alias op physical target cmd control="" hold
  for variant in plain lf; do
    if [[ "$variant" == plain ]]; then repo="$RP_PLAIN_REPO"; alias="$RP_PLAIN_ALIAS"
    else repo="$RP_LF_REPO"; alias="$RP_LF_ALIAS"; fi
    case "$kind" in
      canonical) op="$repo"; physical="$repo"; target="$op/.caws/worktrees/f-wt/src/payload.ts"
        cmd='touch .caws/worktrees/f-wt/src/payload.ts' ;;
      alias) op="$alias"; physical="$repo"; target="$op/.caws/worktrees/f-wt/src/payload.ts"
        cmd='touch .caws/worktrees/f-wt/src/payload.ts' ;;
      linked) op="$repo/.caws/worktrees/s-wt"; physical="$op"; target="$repo/.caws/worktrees/f-wt/src/payload.ts"
        cmd='touch ../f-wt/src/payload.ts' ;;
    esac
    if [[ "$tool" == Write ]]; then
      id_guard "$guard" "$repo" "$op" Write "$target"
    else
      id_guard "$guard" "$repo" "$op" Bash "$cmd"
    fi
    [ "$status" -eq 2 ] || { printf '%s %s %s: %s run exited %s\n' "$guard" "$kind" "$tool" "$variant" "$status"; false; }
    if [[ "$variant" == plain ]]; then
      [[ "$output" == *"BLOCKED"*"owned by a DIFFERENT session"* ]] ||
        { printf 'control did not reach the ownership refusal\n'; false; }
      control="$output"
    elif [[ "$expect" == same ]]; then
      [ "$output" = "$control" ] || { printf 'line-feed run differs from the control\n'; false; }
    else
      hold="[bash-write-guard] the operating directory's physical path $(printf '%q' "$physical") contains a carriage return, line feed or tab, which the command mutation analysis transport cannot carry as a coordinate, so this command's write targets cannot be established. Failing CLOSED."
      [ "${lines[0]}" = "$hold" ] || { printf 'line-feed run was not held for the transport\n'; false; }
      [ "${#lines[@]}" -eq 2 ]
      [[ "${lines[1]}" == '{"decision":"block","reason":"CAWS bash-write-guard: the operating directory contains a carriage return, line feed or tab'* ]]
    fi
  done
}

# Usage: rp_expect_into <helper> <option-or-empty> <input> <expected> [<input> <expected>]...
# Calls <helper> <var> <input> [<option>] for each pair and requires the
# assigned bytes to equal <expected>, which the fixture constructed.
rp_expect_into() {
  local helper="$1" option="$2"
  shift 2
  run bash -c '
    source "$1/lib/caws-state.sh"; helper="$2"; option="$3"; shift 3
    while (($#)); do
      v=unassigned
      if [[ -n "$option" ]]; then "$helper" v "$1" "$option"; else "$helper" v "$1"; fi ||
        { printf "status %s for %q\n" "$?" "$1"; exit 1; }
      printf "%q -> %q\n" "$1" "$v"
      [[ "$v" == "$2" ]] || { printf "expected %q\n" "$2"; exit 1; }
      shift 2
    done' _ "$(guard_dir)" "$helper" "$option" "$@"
  printf '# %s\n' "${lines[@]}" >&3
  [ "$status" -eq 0 ]
}

# Usage: rp_refusal <PATH> <helper> <var-name> <input> <expected-status> <expected-stderr>
# A refused call must leave the caller's variable exactly as it was.
rp_refusal() {
  local path_value="$1" helper="$2" name="$3" input="$4" want_status="$5" want_stderr="$6"
  run --separate-stderr env PATH="$path_value" RP_REAL_PYTHON="$RP_REAL_PYTHON" \
    RP_COUNT_FILE="${RP_COUNT_FILE:-}" RP_FAIL_NTH="${RP_FAIL_NTH:-0}" RP_FAIL_MODE="${RP_FAIL_MODE:-exit1}" \
    bash -c 'source "$1/lib/caws-state.sh"
      if [[ "$3" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then printf -v "$3" %s untouched; fi
      "$2" "$3" "$4"; s=$?
      if [[ "$3" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then printf "status=%s value=%s" "$s" "${!3}"
      else printf "status=%s" "$s"; fi' _ "$(guard_dir)" "$helper" "$name" "$input"
  printf '# %s %q %q: %s stderr=%q\n' "$helper" "$name" "$input" "$output" "$stderr" >&3
  if [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    [ "$output" = "status=$want_status value=untouched" ]
  else
    [ "$output" = "status=$want_status" ]
  fi
  [ "$stderr" = "$want_stderr" ]
}

@test "precondition: the identity roots exist at exactly their constructed bytes" {
  [[ -d "$RP_PLAIN_REPO/.git" && -d "$RP_LF_REPO/.git" ]]
  [[ "$RP_LF_REPO" == *$'\n' ]]
  # The root without its final byte names nothing: a capture that strips it
  # cannot be mistaken for the repository.
  [[ ! -e "${RP_LF_REPO%$'\n'}" ]]
  local resolved
  resolved="$(cd -P "$RP_LF_ALIAS" && printf '%sx' "$PWD")"
  [[ "${resolved%x}" == "$RP_LF_REPO" ]]
  resolved="$(git -C "$RP_LF_REPO/.caws/worktrees/s-wt" rev-parse --git-common-dir && printf x)"
  printf '# lf root=%q\n# lf linked common dir=%q\n' "$RP_LF_REPO" "${resolved%x}" >&3
  [[ "${resolved%x}" == "$RP_LF_REPO/.git"$'\n' ]]
}

@test "path identity: a root ending in a line feed reaches the caller with that byte" {
  rp_expect_into caws_guard_realpath_into "" \
    "$RP_LF_REPO" "$RP_LF_REPO" \
    "$RP_LF_ALIAS" "$RP_LF_REPO" \
    "$RP_LF_REPO/.git/.." "$RP_LF_REPO" \
    "$RP_LF_ALIAS/.caws/worktrees/f-wt/src/payload.ts" "$RP_LF_REPO/.caws/worktrees/f-wt/src/payload.ts" \
    "$RP_LF_REPO/.caws/missing-leaf"$'\n' "$RP_LF_REPO/.caws/missing-leaf"$'\n'
  rp_expect_into caws_physical_dir_into "" \
    "$RP_LF_ALIAS" "$RP_LF_REPO" \
    "$RP_PLAIN_ALIAS" "$RP_PLAIN_REPO"
  rp_expect_into caws_git_path_into --git-common-dir \
    "$RP_LF_REPO/.caws/worktrees/s-wt" "$RP_LF_REPO/.git"
  rp_expect_into caws_git_path_into --git-dir \
    "$RP_LF_REPO/.caws/worktrees/s-wt" "$RP_LF_REPO/.git/worktrees/s-wt"
  # git's record ends in a line feed after the root's own: only one is removed.
  rp_expect_into caws_git_path_into --show-toplevel \
    "$RP_LF_REPO" "$RP_LF_REPO"
  rp_expect_into caws_resolve_canonical_dir_into "" \
    "$RP_LF_REPO/.caws/worktrees/s-wt" "$RP_LF_REPO" \
    "$RP_PLAIN_REPO/.caws/worktrees/s-wt" "$RP_PLAIN_REPO" \
    "$RP_LF_REPO" "$RP_LF_REPO" \
    "$CAWS_TEST_HOME/no-python" "$CAWS_TEST_HOME/no-python"
}

@test "path identity: the capture helpers assign nothing when they have no answer" {
  rp_refusal "$PATH" caws_physical_dir_into result "$CAWS_TEST_HOME/missing-dir" 1 ""
  rp_refusal "$PATH" caws_git_path_into result "$CAWS_TEST_HOME/no-python" 1 ""
  rp_refusal "$PATH" caws_git_path_into result "" 1 ""
}

@test "path identity: worktree-write-guard refuses a foreign payload write from a line-feed canonical root" {
  id_case worktree-write-guard.sh canonical Write same
}

@test "path identity: worktree-write-guard refuses a foreign payload write through an alias of a line-feed root" {
  id_case worktree-write-guard.sh alias Write same
}

@test "path identity: worktree-write-guard refuses a foreign payload write from a worktree of a line-feed root" {
  id_case worktree-write-guard.sh linked Write same
}

@test "path identity: bash-write-guard holds a line-feed canonical operating directory for the analysis transport" {
  id_case bash-write-guard.sh canonical Bash transport-hold
}

@test "path identity: bash-write-guard holds an alias of a line-feed root, which the analyzer resolves to that root" {
  id_case bash-write-guard.sh alias Bash transport-hold
}

@test "path identity: bash-write-guard holds a line-feed worktree operating directory for the analysis transport" {
  id_case bash-write-guard.sh linked Bash transport-hold
}

# Usage: id_base_branch <repo>
# A canonical-root Write of src/new.ts under base-branch enforcement, first at
# the ordinary root (the control) and then at <repo>. Each run must hand
# exactly src/new.ts to scope contention and reach the control's verdict, the
# root's own bytes abstracted. The control's verdict names the registry's
# worktrees in registry order (s-wt, f-wt); the git worktree list fallback,
# which answers only when the registry read fails, names them f-wt, s-wt.
id_base_branch() {
  local variant="$1" repo observed expected="" log="$BATS_TEST_TMPDIR/contention.log"
  printf 'src/new.ts\0' > "$BATS_TEST_TMPDIR/contention.expected"
  for repo in "$RP_PLAIN_REPO" "$variant"; do
    rm -f "$log"
    RP_ID_PATH="$CAWS_TEST_HOME/contention-caws:$PATH" RP_CONTENTION_LOG="$log" \
      id_guard worktree-write-guard.sh "$repo" "$repo" Write "$repo/src/new.ts"
    observed="$status:${output//"$repo"/<ROOT>}"
    printf '# contention argument: %s\n' "$(od -c "$log" 2>/dev/null | head -2 | tr '\n' ' ')" >&3
    if [[ -z "$expected" ]]; then
      expected="$observed"
      [[ "$output" == *'"permissionDecision": "ask"'* && "$output" == *"s-wt, f-wt"* ]] ||
        { printf 'control did not reach base-branch enforcement\n'; false; }
    fi
    cmp -s "$BATS_TEST_TMPDIR/contention.expected" "$log" ||
      { printf 'root %q handed scope contention a different path\n' "$repo"; false; }
    [ "$observed" = "$expected" ] || { printf 'root %q: %s\nexpected: %s\n' "$repo" "$observed" "$expected"; false; }
  done
}

@test "path identity: base-branch enforcement reads the registry for a root containing an apostrophe" {
  id_base_branch "$RP_QUOTE_REPO"
}

@test "path identity: bash-write-guard governs a line-feed project root from an ordinary working directory outside it" {
  # The working directory is an ordinary path, so nothing is held for the
  # transport and the project root alone decides whether the guard governs.
  # The control's target is refused by ownership. The line-feed root's target
  # holds that line feed, which the operand carrier cannot transport, so it is
  # escalated as unrepresentable: asked when asking is possible, refused when
  # it is not, never admitted.
  local target
  mkdir -p "$CAWS_TEST_HOME/outside"
  target="$RP_PLAIN_REPO/.caws/worktrees/f-wt/src/payload.ts"
  RP_ID_CWD="$CAWS_TEST_HOME/outside" \
    id_guard bash-write-guard.sh "$RP_PLAIN_REPO" "$RP_PLAIN_REPO" Bash "touch \"$target\""
  [ "$status" -eq 2 ]
  assert_output --partial "BLOCKED: this Bash command mutates worktree 'f-wt''s payload"
  target="$RP_LF_REPO/.caws/worktrees/f-wt/src/payload.ts"
  RP_ID_CWD="$CAWS_TEST_HOME/outside" \
    id_guard bash-write-guard.sh "$RP_LF_REPO" "$RP_LF_REPO" Bash "touch \"$target\""
  [ "$status" -eq 0 ]
  assert_output --partial '"permissionDecision": "ask"'
  assert_output --partial "ask_unrepresentable_target: 1 operand(s) contain a newline or tab"
  RP_ID_CWD="$CAWS_TEST_HOME/outside" RP_ID_MODE=bypassPermissions \
    id_guard bash-write-guard.sh "$RP_LF_REPO" "$RP_LF_REPO" Bash "touch \"$target\""
  [ "$status" -eq 2 ]
  assert_output --partial "ask_unrepresentable_target"
}

@test "path identity: base-branch enforcement strips a root containing a bracket expression literally" {
  id_base_branch "$RP_GLOB_REPO"
}

@test "path identity: base-branch enforcement keeps a root ending in a line feed" {
  id_base_branch "$RP_LF_REPO"
}

@test "path identity: base-branch enforcement reads the registry for a branch containing an apostrophe" {
  local repo="$RP_QUOTE_BRANCH_REPO"
  RP_ID_PATH="$CAWS_TEST_HOME/contention-caws:$PATH" RP_CONTENTION_LOG="$BATS_TEST_TMPDIR/contention.log" \
    id_guard worktree-write-guard.sh "$repo" "$repo" Write "$repo/src/new.ts"
  [ "$status" -eq 0 ]
  # Registry order; the git worktree list fallback would name f-wt first.
  assert_output --partial "2 active worktree(s) on 'it's': s-wt, f-wt."
}

@test "path identity: the git worktree fallback counts a line-feed root's worktrees as it counts an ordinary root's" {
  # Both registries name another base branch, so both runs count from git.
  local repo observed expected=""
  for repo in "$RP_FALLBACK_PLAIN_REPO" "$RP_FALLBACK_LF_REPO"; do
    RP_ID_PATH="$CAWS_TEST_HOME/contention-caws:$PATH" RP_CONTENTION_LOG="$BATS_TEST_TMPDIR/contention.log" \
      id_guard worktree-write-guard.sh "$repo" "$repo" Write "$repo/src/new.ts"
    observed="$status:${output//"$repo"/<ROOT>}"
    if [[ -z "$expected" ]]; then
      expected="$observed"
      assert_output --partial "2 active worktree(s) on 'main': f-wt, s-wt."
    fi
    [ "$observed" = "$expected" ] || { printf 'root %q: %s\nexpected: %s\n' "$repo" "$observed" "$expected"; false; }
  done
}

@test "path identity: without worktree list -z an ordinary root is counted from the line form and a line-feed root is asked about" {
  local no_z="$CAWS_TEST_HOME/git-without-z:$CAWS_TEST_HOME/contention-caws:$PATH"
  RP_ID_PATH="$no_z" RP_CONTENTION_LOG="$BATS_TEST_TMPDIR/contention.log" \
    id_guard worktree-write-guard.sh "$RP_FALLBACK_PLAIN_REPO" "$RP_FALLBACK_PLAIN_REPO" Write "$RP_FALLBACK_PLAIN_REPO/src/new.ts"
  [ "$status" -eq 0 ]
  assert_output --partial "2 active worktree(s) on 'main': f-wt, s-wt."
  RP_ID_PATH="$no_z" RP_CONTENTION_LOG="$BATS_TEST_TMPDIR/contention.log" \
    id_guard worktree-write-guard.sh "$RP_FALLBACK_LF_REPO" "$RP_FALLBACK_LF_REPO" Write "$RP_FALLBACK_LF_REPO/src/new.ts"
  [ "$status" -eq 0 ]
  assert_output --partial '"permissionDecision": "ask"'
  assert_output --partial "contains a line feed and this git cannot list worktrees NUL-terminated"
  refute_output --partial "active worktree(s)"
}

# Usage: rp_git_case <guard.sh> <Write|Bash>
# Git is how the guards find the canonical root and worktree ownership. With
# git, ownership decides: the foreign write is refused from the canonical root
# and from s-wt, and the owner's own write passes. Without git that discovery
# is impossible, so every run, the owner's included, must be refused naming
# git rather than read as an ungoverned directory.
rp_git_case() {
  local guard="$1" tool="$2" repo="$RP_PLAIN_REPO" op target path_value expected label
  local self="$RP_PLAIN_REPO/.caws/worktrees/s-wt"
  local foreign="$repo/.caws/worktrees/f-wt/src/payload.ts" own="$self/src/own.ts"
  label="${guard%.sh}"
  for path_value in "$PATH" "$CAWS_TEST_HOME/no-git"; do
    for op in "$repo" "$self"; do
      for target in "$foreign" "$own"; do
        [[ "$op" == "$repo" && "$target" == "$own" ]] && continue
        if [[ "$tool" == Write ]]; then
          RP_ID_PATH="$path_value" id_guard "$guard" "$repo" "$op" Write "$target"
        else
          RP_ID_PATH="$path_value" id_guard "$guard" "$repo" "$op" Bash "touch \"$target\""
        fi
        if [[ "$path_value" != "$PATH" ]]; then
          [ "$status" -eq 2 ] || { printf 'no git, %s -> %s exited %s\n' "$op" "$target" "$status"; false; }
          assert_output --partial "[$label] git is not available on PATH, so the canonical checkout and worktree ownership cannot be determined. Failing CLOSED"
          assert_output --partial '{"decision":"block"'
        elif [[ "$target" == "$foreign" ]]; then
          [ "$status" -eq 2 ] || { printf 'with git, %s -> foreign exited %s\n' "$op" "$status"; false; }
          assert_output --partial "owned by a DIFFERENT session"
        else
          [ "$status" -eq 0 ] || { printf 'with git, the owner write exited %s\n' "$status"; false; }
          refute_output --partial "BLOCKED"
        fi
      done
    done
  done
}

@test "git unavailable: worktree-write-guard refuses naming git instead of reading an ungoverned directory" {
  run env -i PATH="$CAWS_TEST_HOME/no-git" bash -c 'command -v git'
  [ "$status" -ne 0 ]
  rp_git_case worktree-write-guard.sh Write
}

@test "git unavailable: bash-write-guard refuses naming git instead of reading an ungoverned directory" {
  rp_git_case bash-write-guard.sh Bash
}

# Usage: rp_git_failed_case <guard.sh> <Write|Bash> <repo> <operating-dir> <PATH> <target>
# The run must be refused naming the failed git discovery.
rp_git_failed_case() {
  local guard="$1" tool="$2" repo="$3" op="$4" path_value="$5" target="$6" arg="$6"
  [[ "$tool" == Bash ]] && arg="touch \"$target\""
  RP_ID_PATH="$path_value" id_guard "$guard" "$repo" "$op" "$tool" "$arg"
  [ "$status" -eq 2 ] || { printf '%s from %q exited %s\n' "$guard" "$op" "$status"; false; }
  assert_output --partial "[${guard%.sh}] git could not determine the repository for"
  assert_output --partial "although a .git entry exists at"
  assert_output --partial '{"decision":"block"'
}

@test "git failing: both guards refuse when git cannot answer for a directory that holds a .git entry" {
  local repo="$RP_PLAIN_REPO" self="$RP_PLAIN_REPO/.caws/worktrees/s-wt"
  local failing="$CAWS_TEST_HOME/failing-git:$PATH"
  local foreign="$repo/.caws/worktrees/f-wt/src/payload.ts" own="$self/src/own.ts"
  # With working git, ownership decides (controls).
  id_guard worktree-write-guard.sh "$repo" "$self" Write "$foreign"
  [ "$status" -eq 2 ]
  assert_output --partial "owned by a DIFFERENT session"
  # A git that fails: the foreign write and, as the price of failing closed,
  # the owner's own write are refused.
  rp_git_failed_case worktree-write-guard.sh Write "$repo" "$self" "$failing" "$foreign"
  rp_git_failed_case worktree-write-guard.sh Write "$repo" "$self" "$failing" "$own"
  rp_git_failed_case bash-write-guard.sh Bash "$repo" "$self" "$failing" "$foreign"
  rp_git_failed_case bash-write-guard.sh Bash "$repo" "$self" "$failing" "$own"
  # A project directory nested below the worktree root: the .git entry is an
  # ancestor's, and it must still be found.
  rp_git_failed_case worktree-write-guard.sh Write "$repo" "$self/src/nested" "$failing" "$foreign"
  rp_git_failed_case bash-write-guard.sh Bash "$repo" "$self/src/nested" "$failing" "$foreign"
}

@test "git failing: a worktree whose admin directory is gone is refused with working git" {
  local repo="$RP_ADMIN_REPO" self="$RP_ADMIN_REPO/.caws/worktrees/s-wt"
  run git -C "$self" rev-parse --git-dir
  [ "$status" -ne 0 ]
  rp_git_failed_case worktree-write-guard.sh Write "$repo" "$self" "$PATH" "$repo/.caws/worktrees/f-wt/src/payload.ts"
  rp_git_failed_case worktree-write-guard.sh Write "$repo" "$self" "$PATH" "$self/src/own.ts"
  rp_git_failed_case bash-write-guard.sh Bash "$repo" "$self" "$PATH" "$repo/.caws/worktrees/f-wt/src/payload.ts"
}

@test "git failing: a git that answers --git-dir but fails --git-common-dir is refused, not read as an unlinked worktree" {
  local repo="$RP_PLAIN_REPO" self="$RP_PLAIN_REPO/.caws/worktrees/s-wt"
  local partial="$CAWS_TEST_HOME/partial-git:$PATH" own="$RP_PLAIN_REPO/.caws/worktrees/s-wt/src/own.ts"
  # The shim fails only the guards' exact query: --git-dir and the analyzer's
  # multi-option query still answer.
  run env PATH="$partial" RP_REAL_GIT="$RP_REAL_GIT" bash -c 'cd "$1" && git rev-parse --git-dir &&
    ! git rev-parse --git-common-dir &&
    git --no-pager -C . rev-parse --path-format=absolute --absolute-git-dir --git-common-dir' _ "$self"
  [ "$status" -eq 0 ]
  # With working git, a session that does not own s-wt is refused by ownership.
  RP_ID_SESSION=rp-session-f id_guard bash-write-guard.sh "$repo" "$self" Bash "touch \"$own\""
  [ "$status" -eq 2 ]
  assert_output --partial "BLOCKED: this Bash command mutates worktree 's-wt''s payload"
  RP_ID_SESSION=rp-session-f id_guard worktree-write-guard.sh "$repo" "$self" Write "$own"
  [ "$status" -eq 2 ]
  assert_output --partial "owned by a DIFFERENT session"
  # With only the common-dir query failing, the worktree must not become the
  # project root (it has no registry): both guards refuse naming the failure.
  RP_ID_SESSION=rp-session-f rp_git_failed_case bash-write-guard.sh Bash "$repo" "$self" "$partial" "$own"
  RP_ID_SESSION=rp-session-f rp_git_failed_case worktree-write-guard.sh Write "$repo" "$self" "$partial" "$own"
}

@test "caws_resolve_canonical_dir_into: a failed common-dir query or an unenterable common dir assigns nothing" {
  local self="$RP_PLAIN_REPO/.caws/worktrees/s-wt"
  # Git failed where a .git entry exists: status 3, caller value unchanged.
  rp_refusal "$CAWS_TEST_HOME/partial-git:$PATH" caws_resolve_canonical_dir_into v "$self" 3 ''
  # Git named a common directory that cannot be entered: status 2.
  rp_refusal "$CAWS_TEST_HOME/bogus-common-git:$PATH" caws_resolve_canonical_dir_into v "$self" 2 ''
  # Control: working git resolves the worktree to its canonical root.
  rp_expect_into caws_resolve_canonical_dir_into '' "$self" "$RP_PLAIN_REPO"
}

@test "git failing: a directory outside every repository stays ungoverned" {
  local d
  # Precondition: no .git entry on the directory or any ancestor.
  d="$RP_NONREPO"
  while :; do
    [[ ! -e "$d/.git" ]] || { printf 'unexpected .git at %q\n' "$d"; false; }
    [[ "$d" == / ]] && break
    d="${d%/*}"; [[ -n "$d" ]] || d=/
  done
  RP_ID_PATH="$CAWS_TEST_HOME/failing-git:$PATH" \
    id_guard worktree-write-guard.sh "$RP_NONREPO" "$RP_NONREPO" Write "$RP_NONREPO/notes.txt"
  [ "$status" -eq 0 ]
  refute_output --partial "git could not determine"
  RP_ID_PATH="$CAWS_TEST_HOME/failing-git:$PATH" \
    id_guard bash-write-guard.sh "$RP_NONREPO" "$RP_NONREPO" Bash "touch notes.txt"
  [ "$status" -eq 0 ]
  refute_output --partial "git could not determine"
}

RP_NODE_REFUSAL="[worktree-write-guard] node is not available on PATH, so the worktree registry and canonical scope claims cannot be read. Failing CLOSED (refusing the write). Restore node on PATH."

# Usage: rp_no_node <id_guard arguments>
# id_guard where node is absent as the guard sees it (see setup_file).
rp_no_node() {
  CAWS_GUARD_REALPATH_DIR="$CAWS_TEST_HOME/node-hidden" RP_ID_PATH="$CAWS_TEST_HOME/no-node" id_guard "$@"
}

@test "node unavailable: precondition: the guard's own runtime discovery finds no node and the core tools remain" {
  local discover='source "$1/runtime-paths.sh"; ensure_hook_runtime_path; command -v node'
  run env -i HOME="$CAWS_TEST_HOME" PATH="$CAWS_TEST_HOME/no-node" bash -c "$discover" _ "$CAWS_TEST_HOME/node-hidden"
  [ "$status" -ne 0 ]
  [ -z "$output" ]
  # Diagnostic only (machine dependent): what the shipped discovery finds.
  run env -i HOME="$CAWS_TEST_HOME" PATH="$CAWS_TEST_HOME/no-node" bash -c "$discover" _ "$(guard_dir)"
  printf '# shipped discovery with the farm PATH: status=%s node=%s\n' "$status" "${output:-none}" >&3
  # Only the discovery differs from the tree under test.
  run diff -r "$(guard_dir)" "$CAWS_TEST_HOME/node-hidden"
  [ "$(grep -c -E '^(diff -r |Only in )' <<<"$output")" -eq 1 ]
  [ "${lines[0]}" = "diff -r $(guard_dir)/runtime-paths.sh $CAWS_TEST_HOME/node-hidden/runtime-paths.sh" ]
  local tool
  for tool in bash git python3 jq cat sed grep cut tr head dirname; do
    [[ -x "$CAWS_TEST_HOME/no-node/$tool" ]]
  done
}

@test "node unavailable: worktree-write-guard refuses a canonical write another worktree claims instead of skipping the claim check" {
  local repo="$RP_CLAIM_REPO" target="$RP_CLAIM_REPO/src/claimed.ts"
  local self="$repo/.caws/worktrees/s-wt" owner="$repo/.caws/worktrees/f-wt" op
  # With node the claim decides: f-wt's scope.in claims src/claimed.ts, so
  # the write from s-wt is refused and the claimant's own write passes.
  RP_ID_NODE_PATH="$_REPO_NM" id_guard worktree-write-guard.sh "$repo" "$self" Write "$target"
  [ "$status" -eq 2 ]
  assert_output --partial "BLOCKED canonical path '$target': claimed:f-wt:src/claimed.ts"
  RP_ID_NODE_PATH="$_REPO_NM" RP_ID_SESSION=rp-session-f \
    id_guard worktree-write-guard.sh "$repo" "$owner" Write "$target"
  [ "$status" -eq 0 ]
  refute_output --partial "BLOCKED"
  # Without node neither the claim nor the claimant can be read: both writes
  # are refused naming node, the claimant's included.
  rp_no_node worktree-write-guard.sh "$repo" "$self" Write "$target"
  [ "$status" -eq 2 ]
  assert_output --partial "$RP_NODE_REFUSAL"
  assert_output --partial '{"decision":"block"'
  RP_ID_SESSION=rp-session-f rp_no_node worktree-write-guard.sh "$repo" "$owner" Write "$target"
  [ "$status" -eq 2 ]
  assert_output --partial "$RP_NODE_REFUSAL"
}

@test "node unavailable: base-branch enforcement refuses instead of admitting silently" {
  local repo="$RP_CLAIM_REPO"
  # With node, a base-branch write while worktrees are active is asked about.
  RP_ID_PATH="$CAWS_TEST_HOME/contention-caws:$PATH" RP_CONTENTION_LOG="$BATS_TEST_TMPDIR/contention.log" \
    id_guard worktree-write-guard.sh "$repo" "$repo" Write "$repo/src/new.ts"
  [ "$status" -eq 0 ]
  assert_output --partial '"permissionDecision": "ask"'
  assert_output --partial "2 active worktree(s) on 'main': s-wt, f-wt."
  rp_no_node worktree-write-guard.sh "$repo" "$repo" Write "$repo/src/new.ts"
  [ "$status" -eq 2 ]
  assert_output --partial "$RP_NODE_REFUSAL"
  assert_output --partial '{"decision":"block"'
}

@test "node unavailable: a directory without a worktree registry stays ungoverned" {
  [[ ! -e "$RP_NONREPO/.caws/worktrees.json" ]]
  rp_no_node worktree-write-guard.sh "$RP_NONREPO" "$RP_NONREPO" Write "$RP_NONREPO/notes.txt"
  [ "$status" -eq 0 ]
  refute_output --partial "node is not available"
}

@test "node unavailable: an empty state directory preserves the no-registry base state" {
  local root="$BATS_TEST_TMPDIR/empty-state"
  mkdir -p "$root/.caws"
  rp_no_node worktree-write-guard.sh "$root" "$root" Write "$root/notes.txt"
  [ "$status" -eq 0 ]
  refute_output --partial "node is not available"
}

@test "node unavailable: an inaccessible state directory cannot prove registry absence" {
  local root="$BATS_TEST_TMPDIR/opaque-state"
  mkdir -p "$root/.caws"
  printf '{}\n' > "$root/.caws/worktrees.json"
  chmod 000 "$root/.caws"
  rp_no_node worktree-write-guard.sh "$root" "$root" Write "$root/notes.txt"
  chmod 700 "$root/.caws"
  [ "$status" -eq 2 ]
  assert_output --partial "$RP_NODE_REFUSAL"
  [[ -f "$root/.caws/worktrees.json" ]]
}

@test "node unavailable: a failed directory census cannot become an empty allow" {
  local probe="$BATS_TEST_TMPDIR/failing-find"
  mkdir "$probe"
  printf '#!/bin/sh\nexit 7\n' > "$probe/find"
  chmod +x "$probe/find"
  CAWS_GUARD_REALPATH_DIR="$CAWS_TEST_HOME/node-hidden" \
    RP_ID_PATH="$probe:$CAWS_TEST_HOME/no-node" \
    id_guard worktree-write-guard.sh "$RP_NONREPO" "$RP_NONREPO" Write "$RP_NONREPO/notes.txt"
  [ "$status" -eq 2 ]
  assert_output --partial "$RP_NODE_REFUSAL"
}

@test "relative target: worktree-write-guard resolves a relative Write against the payload cwd before adjudicating ownership" {
  local repo="$RP_PLAIN_REPO" self="$RP_PLAIN_REPO/.caws/worktrees/s-wt"
  # Control: the absolute spelling of the foreign target is refused.
  id_guard worktree-write-guard.sh "$repo" "$self" Write "$repo/.caws/worktrees/f-wt/src/payload.ts"
  [ "$status" -eq 2 ]
  assert_output --partial "owned by a DIFFERENT session"
  # From s-wt the relative spelling names the same foreign file.
  id_guard worktree-write-guard.sh "$repo" "$self" Write "../f-wt/src/payload.ts"
  [ "$status" -eq 2 ]
  assert_output --partial "owned by a DIFFERENT session"
  # The owner's own relative write is admitted.
  id_guard worktree-write-guard.sh "$repo" "$self" Write "src/own.ts"
  [ "$status" -eq 0 ]
  refute_output --partial "BLOCKED"
  # The coordinate is the payload cwd, not the session's project directory:
  # with the project at the canonical root and the cwd in s-wt, the relative
  # target still names f-wt's payload (against the root it would name a path
  # outside the repository).
  RP_ID_CWD="$self" id_guard worktree-write-guard.sh "$repo" "$repo" Write "../f-wt/src/payload.ts"
  [ "$status" -eq 2 ]
  assert_output --partial "owned by a DIFFERENT session"
}

@test "relative target: with no payload cwd a relative Write is asked about where the payload contract carries cwd" {
  local repo="$RP_PLAIN_REPO" self="$RP_PLAIN_REPO/.caws/worktrees/s-wt"
  RP_ID_NO_CWD=1 id_guard worktree-write-guard.sh "$repo" "$self" Write "../f-wt/src/payload.ts"
  [ "$status" -eq 0 ]
  assert_output --partial '"permissionDecision": "ask"'
  assert_output --partial "operating cwd could not be resolved for the relative path '../f-wt/src/payload.ts'"
  RP_ID_NO_CWD=1 RP_ID_MODE=bypassPermissions \
    id_guard worktree-write-guard.sh "$repo" "$self" Write "../f-wt/src/payload.ts"
  [ "$status" -eq 2 ]
  assert_output --partial "operating cwd could not be resolved"
  # A surface whose payload contract is unverified keeps resolving against the
  # session's project directory, which here names the same foreign file.
  RP_ID_NO_CWD=1 RP_ID_SURFACE=zcode id_guard worktree-write-guard.sh "$repo" "$self" Write "../f-wt/src/payload.ts"
  [ "$status" -eq 2 ]
  assert_output --partial "owned by a DIFFERENT session"
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

@test "caws_guard_realpath_into: python success assigns exactly the path the existing normalizer resolves" {
  run bash -c '
    source "$1/lib/caws-state.sh"
    cd "$2"
    shift 2
    for p in "$@"; do
      v=unassigned
      # Status and value together: a success value with a refusal status would
      # make every guard refuse a path it could have normalized.
      caws_guard_realpath_into v "$p" || { printf "status %s for %q\n" "$?" "$p"; exit 1; }
      # _realpath prints the path and one line feed. The sentinel keeps every
      # byte, so ref is its exact path, not a copy a capture stripped.
      ref="$(_realpath "$p"; printf x)"; ref="${ref%x}"; ref="${ref%?}"
      printf "%q -> %q\n" "$p" "$v"
      [[ "$v" == "$ref" ]] || { printf "differs from %q\n" "$ref"; exit 1; }
    done
  ' _ "$(guard_dir)" "$RP_SELF" \
    "$RP_DOTDOT_TARGET" \
    "$CAWS_TEST_HOME/repo-alias/.caws/worktrees/f-wt/src/new" \
    "$CAWS_TEST_HOME/repo-alias/../link-dotdot-leaf" \
    "/tmp/caws-guard-realpath-missing-leaf" \
    "relative/leaf" \
    "$RP_REPO/ends-with-newline"$'\n' \
    "$RP_LF_ALIAS"
  printf '# %s\n' "${lines[@]}" >&3
  [ "$status" -eq 0 ]
}

@test "caws_guard_realpath_into: resolves dotdot, a symlinked ancestor and dotdot after a symlink by the filesystem" {
  # dotdot after a symlink climbs from the link's target, not lexically.
  [ "$(dirname "$RP_REPO")/link-dotdot-leaf" != "$CAWS_TEST_HOME/link-dotdot-leaf" ]
  rp_expect_into caws_guard_realpath_into "" \
    "$RP_DOTDOT_TARGET" "$RP_TARGET" \
    "$CAWS_TEST_HOME/repo-alias/.caws/worktrees/f-wt/src/new" "$RP_REPO/.caws/worktrees/f-wt/src/new" \
    "$CAWS_TEST_HOME/repo-alias/../link-dotdot-leaf" "$(dirname "$RP_REPO")/link-dotdot-leaf"
}

@test "caws_guard_realpath_into: an empty path is refused with its class" {
  rp_refusal "$PATH" caws_guard_realpath_into result "" 2 \
    "[caws-guard-realpath] cannot normalize: empty-path"
}

@test "caws_guard_realpath_into: python3 absent is refused with its class" {
  rp_refusal "$CAWS_TEST_HOME/no-python" caws_guard_realpath_into result "$RP_TARGET" 2 \
    "[caws-guard-realpath] cannot normalize: python3-unavailable"
}

@test "caws_guard_realpath_into: a failing python3 is refused with the interpreter's own exit status" {
  rp_refusal "$CAWS_TEST_HOME/failing-python:$PATH" caws_guard_realpath_into result "$RP_TARGET" 2 \
    "[caws-guard-realpath] cannot normalize: python3-exit-1"
  RP_COUNT_FILE="$BATS_TEST_TMPDIR/helper-count" RP_FAIL_NTH=1 RP_FAIL_MODE=exit7 \
    rp_refusal "$CAWS_TEST_HOME/counting-python:$PATH" caws_guard_realpath_into result "$RP_TARGET" 2 \
    "[caws-guard-realpath] cannot normalize: python3-exit-7"
}

@test "caws_guard_realpath_into: a python3 success that is not one absolute path record is refused by class" {
  local mode cause
  for mode in lf lflf relative empty nodelim; do
    case "$mode" in
      lf) cause=empty-result ;;
      lflf|relative) cause=non-absolute-result ;;
      empty|nodelim) cause=no-record-delimiter ;;
    esac
    rm -f "$BATS_TEST_TMPDIR/helper-count" "$BATS_TEST_TMPDIR/helper-count.paths"
    RP_COUNT_FILE="$BATS_TEST_TMPDIR/helper-count" RP_FAIL_NTH=1 RP_FAIL_MODE="$mode" \
      rp_refusal "$CAWS_TEST_HOME/counting-python:$PATH" caws_guard_realpath_into result "$RP_TARGET" 2 \
      "[caws-guard-realpath] cannot normalize: $cause"
  done
}

@test "out-parameters: invalid names and each helper's own local prefix are refused" {
  local name
  for name in "" 1x a-b "x y" 'a$b'; do
    rp_refusal "$PATH" caws_guard_realpath_into "$name" "$RP_TARGET" 2 \
      "[caws-guard-realpath] cannot normalize: invalid-out-parameter"
  done
  # printf -v into a name the helper also declares local would assign the
  # local and leave the caller's variable unchanged; the caller's value
  # surviving is asserted alongside the refusal.
  rp_refusal "$PATH" caws_guard_realpath_into _caws_rp_out "$RP_TARGET" 2 \
    "[caws-guard-realpath] cannot normalize: invalid-out-parameter"
  rp_refusal "$PATH" caws_physical_dir_into _caws_pd_out "$RP_REPO" 2 ""
  rp_refusal "$PATH" caws_git_path_into _caws_gp_out "$RP_SELF" 2 ""
  rp_refusal "$PATH" caws_resolve_canonical_dir_into _caws_cd_common "$RP_SELF" 2 ""
}

@test "out-parameters: a caller's variable sharing a common or another helper's name is assigned" {
  run bash -c '
    source "$1/lib/caws-state.sh"
    for name in out status p path var v field count _caws_gp_out _caws_cd_common; do
      unset -v "$name"
      caws_guard_realpath_into "$name" "$2" || { printf "realpath %s: status %s\n" "$name" "$?"; exit 1; }
      [[ "${!name}" == "$3" ]] || { printf "realpath %s: %q\n" "$name" "${!name}"; exit 1; }
    done
    # The canonical resolver calls caws_git_path_into with its own local as
    # the out-parameter; names of the other helpers pass through it.
    for name in out common candidate start _caws_gp_out _caws_rp_out; do
      unset -v "$name"
      caws_resolve_canonical_dir_into "$name" "$4" || { printf "resolve %s: status %s\n" "$name" "$?"; exit 1; }
      [[ "${!name}" == "$5" ]] || { printf "resolve %s: %q\n" "$name" "${!name}"; exit 1; }
    done
    printf "assigned\n"' _ "$(guard_dir)" "$RP_DOTDOT_TARGET" "$RP_TARGET" "$RP_SELF" "$RP_REPO"
  printf '# %s\n' "${lines[@]}" >&3
  [ "$status" -eq 0 ]
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
  assert_output --partial "[worktree-write-guard] cannot normalize the git common dir path"
  assert_output --partial '{"decision":"block"'
}

@test "identity-drop control: the legacy reader returns an unresolved spelling with success" {
  run env PATH="$CAWS_TEST_HOME/failing-python:$PATH" bash -c '
    source "$1/lib/caws-state.sh"
    caws_guard_realpath_into value "$2"
    printf "%s" "$value"' _ "$CAWS_TEST_HOME/identity-drop" "$RP_DOTDOT_TARGET"
  [ "$status" -eq 0 ]
  [[ "$output" == "$RP_DOTDOT_TARGET" ]]
  [[ "$output" != "$RP_TARGET" ]]
}

@test "worktree-write-guard identity-drop control: the independent oracle retains foreign ownership" {
  rp_guard "$CAWS_TEST_HOME/identity-drop" worktree-write-guard.sh \
    "$CAWS_TEST_HOME/failing-python:$PATH" rp-session-s "$(write_payload "$RP_TARGET")"
  [ "$status" -eq 2 ]
  assert_output --partial "owned by a DIFFERENT session"
  rp_guard "$CAWS_TEST_HOME/identity-drop" worktree-write-guard.sh \
    "$CAWS_TEST_HOME/no-python" rp-session-s "$(write_payload "$RP_TARGET")"
  [ "$status" -eq 2 ]
  assert_output --partial "owned by a DIFFERENT session"
}

rp_leaf_identity_control() {
  local guard="$1" tool="$2" link="$RP_SELF/src/$2-identity-link" argument
  local reference_before reference_after
  mkdir -p "$RP_SELF/src" "$(dirname "$RP_TARGET")"
  printf 'referent-control\n' > "$RP_TARGET"
  ln -s "$RP_TARGET" "$link"
  reference_before="$("$RP_REAL_PYTHON" -c 'import os,sys; s=os.stat(sys.argv[1]); print(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns)' "$RP_TARGET")"
  if [[ "$tool" == Write ]]; then
    argument="$(write_payload "$link")"
  else
    argument="$(bash_payload "touch \"$link\"")"
  fi
  rp_guard "$(guard_dir)" "$guard" "$PATH" rp-session-s "$argument"
  [ "$status" -eq 2 ]
  assert_output --partial "owned by a DIFFERENT session"
  # The file oracle preserves final entries intentionally. A referent-write
  # consumer therefore still needs its own checked normalization of this leaf.
  rp_guard "$CAWS_TEST_HOME/identity-drop" "$guard" \
    "$CAWS_TEST_HOME/failing-python:$PATH" rp-session-s "$argument"
  [ "$status" -eq 0 ]
  refute_output --partial "BLOCKED"
  rp_guard "$CAWS_TEST_HOME/identity-drop" "$guard" \
    "$CAWS_TEST_HOME/no-python" rp-session-s "$argument"
  [ "$status" -eq 0 ]
  refute_output --partial "BLOCKED"
  [[ -L "$link" ]]
  [[ "$(cat "$RP_TARGET")" == referent-control ]]
  reference_after="$("$RP_REAL_PYTHON" -c 'import os,sys; s=os.stat(sys.argv[1]); print(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns)' "$RP_TARGET")"
  [[ "$reference_after" == "$reference_before" ]]
}

@test "worktree-write-guard identity-drop leaf control: unchecked referent normalization admits the foreign write" {
  rp_leaf_identity_control worktree-write-guard.sh Write
}

@test "worktree-write-guard sweep: each normalization on the foreign-payload path refuses when it alone fails" {
  rp_sweep exit1 worktree-write-guard.sh rp-session-s "$(write_payload "$RP_TARGET")" 2 \
    "git common dir" "git dir" "canonical root" "write target"
}

@test "worktree-write-guard sweep: each normalization on the canonical-claim path refuses when it alone fails" {
  rp_sweep exit1 worktree-write-guard.sh rp-session-s "$(write_payload "$RP_REPO/src/claimed.ts")" 0 \
    "write target" "operating directory"
}

@test "worktree-write-guard sweep: a relative target is normalized once against the payload cwd" {
  rp_sweep exit1 worktree-write-guard.sh rp-session-s "$(write_payload "src/claimed.ts")" 0 \
    "write target"
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
  assert_output --partial "[bash-write-guard] cannot normalize the project root path"
  assert_output --partial '{"decision":"block"'
}

@test "bash-write-guard identity-drop control: the independent oracle retains foreign ownership" {
  rp_guard "$CAWS_TEST_HOME/identity-drop" bash-write-guard.sh \
    "$CAWS_TEST_HOME/failing-python:$PATH" rp-session-s "$(bash_payload "touch $RP_DOTDOT_TARGET")"
  [ "$status" -eq 2 ]
  assert_output --partial "owned by a DIFFERENT session"
  rp_guard "$CAWS_TEST_HOME/identity-drop" bash-write-guard.sh \
    "$CAWS_TEST_HOME/no-python" rp-session-s "$(bash_payload "touch $RP_DOTDOT_TARGET")"
  [ "$status" -eq 2 ]
  assert_output --partial "owned by a DIFFERENT session"
}

@test "bash-write-guard identity-drop leaf control: unchecked referent normalization admits the foreign mutation" {
  rp_leaf_identity_control bash-write-guard.sh Bash
}

@test "bash-write-guard sweep: the static mutation target refuses when its normalization alone fails" {
  rp_sweep exit1 bash-write-guard.sh rp-session-s "$(bash_payload "touch $RP_DOTDOT_TARGET")" 2 \
    "project root" "mutation target"
}

# Analysis tokens carry no lexically proven prefix (bash-mutation-analysis.sh
# caws_bash_load_analysis_tokens), so a dynamic operand is held for approval
# and its prefix is never normalized. If prefixes are ever projected, this
# test fails and the dynamic-prefix refusal must be swept like the others.
@test "bash-write-guard sweep: a dynamic operand is held for approval and every normalization it reaches refuses alone" {
  local payload
  payload="$(bash_payload "touch $RP_REPO/.caws/worktrees/f-wt/src/\$RP_UNSET_NAME")"
  rp_sweep exit1 bash-write-guard.sh rp-session-s "$payload" 0 "project root"
  RP_FAIL_NTH=0 rp_guard "$(guard_dir)" bash-write-guard.sh "$PATH" rp-session-s "$payload"
  [ "$status" -eq 0 ]
  assert_output --partial '"permissionDecision": "ask"'
  assert_output --partial "ask_dynamic_unconfined"
  refute_output --partial "dynamic mutation prefix"
}

@test "bash-write-guard sweep: Git metadata refuses when its normalization alone fails" {
  rp_sweep exit1 bash-write-guard.sh rp-session-s \
    "$(bash_payload "git -C $RP_REPO/.caws/worktrees/f-wt add README.md")" 2 \
    "project root" "git metadata"
}

# A normalization that "succeeds" with only line feeds hands its caller an empty
# value once command substitution strips them. An empty project root, target or
# metadata coordinate must refuse like a failed one, never reach a prefix arm.
@test "worktree-write-guard LF-only success sweep: foreign-payload path refuses at each normalization" {
  rp_sweep lf worktree-write-guard.sh rp-session-s "$(write_payload "$RP_TARGET")" 2 \
    "git common dir" "git dir" "canonical root" "write target"
}

@test "worktree-write-guard LF-only success sweep: canonical-claim paths refuse at each normalization" {
  rp_sweep lflf worktree-write-guard.sh rp-session-s "$(write_payload "$RP_REPO/src/claimed.ts")" 0 \
    "write target" "operating directory"
  rp_sweep lf worktree-write-guard.sh rp-session-s "$(write_payload "src/claimed.ts")" 0 \
    "write target"
}

@test "bash-write-guard LF-only success sweep: root, target and Git metadata refuse at each normalization" {
  rp_sweep lf bash-write-guard.sh rp-session-s "$(bash_payload "touch $RP_DOTDOT_TARGET")" 2 \
    "project root" "mutation target"
  rp_sweep lflf bash-write-guard.sh rp-session-s \
    "$(bash_payload "git -C $RP_REPO/.caws/worktrees/f-wt add README.md")" 2 \
    "project root" "git metadata"
  rp_sweep empty bash-write-guard.sh rp-session-s "$(bash_payload "touch $RP_DOTDOT_TARGET")" 2 \
    "project root" "mutation target"
}

@test "contract: every normalization in both write guards is checked and assigned without a capture" {
  local guard file lines unchecked
  for guard in worktree-write-guard.sh bash-write-guard.sh; do
    file="$(guard_dir)/$guard"
    # Command substitution would strip a trailing line feed from the path.
    run grep -n -E '\$\((_realpath|caws_guard_realpath|abspath|resolve_canonical_dir|caws_resolve_canonical_dir)' "$file"
    [ "$status" -eq 1 ] || { printf '%s captures a path:\n%s\n' "$guard" "$output"; false; }
    lines="$(grep -E '(^|[^_[:alnum:]])(caws_guard_realpath_into|abspath_into|caws_resolve_canonical_dir_into) [A-Za-z_]' "$file")"
    [[ -n "$lines" ]]
    unchecked="$(printf '%s\n' "$lines" | grep -v -E '\|\| _(wwg|bwg)_(normalize|resolve)_refuse ' || true)"
    [[ -z "$unchecked" ]] || { printf '%s unchecked:\n%s\n' "$guard" "$unchecked"; false; }
  done
}
