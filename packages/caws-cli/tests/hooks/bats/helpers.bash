#!/usr/bin/env bash
# Shared bats harness for CAWS hook-guard behavioral tests.
#
# CAWS-TEST-HOOKS-BASH-001. Each .bats file sources this. It:
#   - locates bats-support / bats-assert from the repo node_modules,
#   - installs the hook pack ONCE per file (setup_file) into an isolated temp
#     repo under the OS temp dir, via the LOCAL built dist CLI (not global caws),
#   - exposes CAWS_TEST_HOOKS_DIR (the installed .caws/hooks/),
#   - provides run_guard: pipe a JSON envelope to a guard with the right env.
#
# Guards read a JSON envelope on stdin: {tool_name, tool_input:{file_path,command}}
# -> HOOK_TOOL_NAME / HOOK_FILE_PATH / HOOK_COMMAND. They emit JSON on stdout
# (emit_block -> {"decision":"block",...}; emit_additional_context ->
# {"hookSpecificOutput":{"additionalContext":...}}). Tests assert exit code +
# stdout.

# --- locate the repo root + node_modules (resolve through this file's path) ---
# This file: packages/caws-cli/tests/hooks/bats/helpers.bash
_HELPERS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# -> packages/caws-cli
CLI_PKG_ROOT="$(cd "$_HELPERS_DIR/../../.." && pwd)"
# The repo root that owns node_modules: the canonical checkout. A linked
# worktree's node_modules is a symlink to it; resolve via the package root's
# node_modules symlink target, falling back to git-common-dir's parent.
_REPO_NM="$CLI_PKG_ROOT/node_modules"
if [[ ! -d "$_REPO_NM/bats-support" ]]; then
  # Fall back to the monorepo root node_modules (two levels up from caws-cli).
  _REPO_NM="$(cd "$CLI_PKG_ROOT/../.." && pwd)/node_modules"
fi

# shellcheck disable=SC1091
load "$_REPO_NM/bats-support/load.bash"
# shellcheck disable=SC1091
load "$_REPO_NM/bats-assert/load.bash"

CLI_DIST_ENTRY="$CLI_PKG_ROOT/dist/index.js"

# Install the hook pack once per .bats file into an isolated temp repo.
# Sets, for every test in the file:
#   CAWS_TEST_REPO       the temp repo root (an initialized git repo + .caws/)
#   CAWS_TEST_HOOKS_DIR  the installed shared-core hooks dir (.caws/hooks)
caws_install_pack_once() {
  [[ -f "$CLI_DIST_ENTRY" ]] || {
    echo "caws-cli dist not built at $CLI_DIST_ENTRY (run: turbo run build --filter=@paths.design/caws-cli --force)" >&2
    return 1
  }
  local repo
  repo="$(mktemp -d "${TMPDIR:-/tmp}/caws-bats-XXXXXX")"
  git -C "$repo" init -q -b main
  git -C "$repo" config user.name 'CAWS Test'
  git -C "$repo" config user.email 'test@caws.invalid'
  git -C "$repo" config commit.gpgsign false
  git -C "$repo" commit -q --allow-empty -m 'root commit'
  ( cd "$repo" && CI=true NO_COLOR=1 node "$CLI_DIST_ENTRY" init --agent-surface claude-code >/dev/null 2>&1 )
  export CAWS_TEST_REPO="$repo"
  export CAWS_TEST_HOOKS_DIR="$repo/.caws/hooks"
}

caws_teardown_pack() {
  [[ -n "${CAWS_TEST_REPO:-}" && -d "$CAWS_TEST_REPO" ]] && rm -rf "$CAWS_TEST_REPO"
}

# Build a hook-input envelope JSON. Usage: hook_envelope <tool> <file_path> <command>
hook_envelope() {
  local tool="$1" file_path="${2:-}" command="${3:-}"
  printf '{"tool_name":"%s","tool_input":{"file_path":"%s","command":"%s"}}' \
    "$tool" "$file_path" "$command"
}

# Build a content-bearing Write/Edit envelope (for content scanners like
# scan-secrets, which read tool_input.content). Usage:
#   hook_envelope_content <tool> <file_path> <content>
# Content is JSON-escaped via jq so synthetic secrets with quotes/newlines are safe.
hook_envelope_content() {
  local tool="$1" file_path="$2" content="$3"
  jq -nc --arg t "$tool" --arg f "$file_path" --arg c "$content" \
    '{tool_name:$t, tool_input:{file_path:$f, content:$c}}'
}

# Run an installed guard with a JSON envelope on stdin and the guard env set.
# Usage: run_guard <guard-basename.sh> <envelope-json>
# Populates bats' $status and $output (stdout+stderr merged by `run`).
run_guard() {
  local guard="$1" envelope="$2"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c "printf '%s' '$envelope' | bash '$CAWS_TEST_HOOKS_DIR/$guard'"
}

# Run an installed guard against an ISOLATED COPY of the hooks dir with one
# shared lib deleted, to reproduce the missing-load-bearing-lib failure class
# (CAWS-HOOK-SOURCE-GUARD-FAIL-SOFT-001 — a guard that sources a missing lib
# under `set -euo pipefail` must NOT silently die / fail open).
#
# Usage: run_guard_missing_lib <guard-basename.sh> <lib-basename.sh> <envelope-json>
#
# The copy is per-invocation and torn down by the next mktemp/teardown of the
# OS temp dir; the shared per-file install (CAWS_TEST_HOOKS_DIR) is never
# mutated, so other tests in the file see the complete pack.
run_guard_missing_lib() {
  local guard="$1" missing_lib="$2" envelope="$3"
  local broken_repo broken_hooks
  broken_repo="$(mktemp -d "${TMPDIR:-/tmp}/caws-bats-broken-XXXXXX")"
  # Copy the whole installed .caws tree so vendor/state paths resolve, then
  # remove exactly the one lib under test.
  cp -R "$CAWS_TEST_REPO/.caws" "$broken_repo/.caws"
  broken_hooks="$broken_repo/.caws/hooks"
  rm -f "$broken_hooks/lib/$missing_lib"
  run env \
    CAWS_PROJECT_DIR="$broken_repo" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$broken_repo" \
    bash -c "printf '%s' '$envelope' | bash '$broken_hooks/$guard'"
  rm -rf "$broken_repo"
}
