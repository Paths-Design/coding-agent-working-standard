#!/usr/bin/env bats
# CAWS-HOOKPACK-BASH32-EMPTY-HANDLER-CI-REGRESSION-001.
#
# Regression guard for CAWS-HOOKPACK-DISPATCH-EMPTY-HANDLERS-CRASH-001: every
# shared/codex/kimi-code run-handlers.sh and the shared dispatch scripts must
# return exit 0 (fail-open) when every handler for an event is disabled, even
# on bash 3.2 (the version macOS ships at /bin/bash by default, frozen there
# for GPLv2 licensing reasons; GitHub's macos-latest runners inherit this).
#
# This file is meant to run on a real macOS runner and is intentionally
# CANDIDATE-ONLY vs INSTRUMENT-ONLY: the first two tests are a positive
# control. If /bin/bash on the runner is ever upgraded (Apple relents, or the
# runner image changes), those two tests FAIL LOUDLY instead of the suite
# silently passing without ever exercising the vulnerable code path. A test
# suite is only as strong as its ability to fail for the right reason.

load ../bats/helpers

bats_require_minimum_version 1.5.0

setup_file() {
  # shellcheck disable=SC2034
  BATS32_BASH="/bin/bash"
  if [[ ! -x "$BATS32_BASH" ]]; then
    echo "no executable $BATS32_BASH on this runner -- this regression guard requires it" >&2
    return 1
  fi

  # CLI_PKG_ROOT / CLI_DIST_ENTRY come from `load helpers` above.
  if [[ ! -f "$CLI_DIST_ENTRY" ]]; then
    echo "caws-cli dist not built at $CLI_DIST_ENTRY (run: turbo run build --filter=@paths.design/caws-cli --force)" >&2
    return 1
  fi

  # CAWS-CLI-INIT-SYSTEM-SURFACE-HOME-OVERRIDE-001: isolate CAWS_HOME so this
  # install is hermetic against a runner/developer machine that has adopted
  # the system runtime for codex (which would make `caws init` skip
  # installing the project-local pack this test needs). caws_install_pack_once
  # (helpers.bash) does not isolate CAWS_HOME, so this file installs its own
  # fixture rather than sharing that helper.
  BATS32_HOME="$(mktemp -d "${TMPDIR:-/tmp}/caws-bash32-home-XXXXXX")"
  BATS32_REPO="$(mktemp -d "${TMPDIR:-/tmp}/caws-bash32-repo-XXXXXX")"
  git -C "$BATS32_REPO" init -q -b main
  git -C "$BATS32_REPO" config user.name 'CAWS Test'
  git -C "$BATS32_REPO" config user.email 'test@caws.invalid'
  git -C "$BATS32_REPO" config commit.gpgsign false
  git -C "$BATS32_REPO" commit -q --allow-empty -m 'root commit'
  ( cd "$BATS32_REPO" && CI=true NO_COLOR=1 CAWS_HOME="$BATS32_HOME" "$BATS32_BASH" -c \
      "node '$CLI_DIST_ENTRY' init --agent-surface codex" >/dev/null 2>&1 )

  export BATS32_BASH BATS32_HOME BATS32_REPO
  export BATS32_HOOKS_DIR="$BATS32_REPO/.caws/hooks"

  if [[ ! -x "$BATS32_HOOKS_DIR/dispatch/post_tool_use.sh" ]]; then
    echo "caws init did not install $BATS32_HOOKS_DIR/dispatch/post_tool_use.sh -- setup failed" >&2
    return 1
  fi

  # Dynamically derive the current handler set from the live installed
  # dispatcher, so this test never needs manual updates when handlers are
  # added/removed/reordered. Extracts the first whitespace-delimited token
  # (script basename) from each active (non-comment) entry inside
  # _ALL_HANDLERS=( ... ).
  BATS32_ALL_HANDLERS="$(
    awk '/^_ALL_HANDLERS=\(/{flag=1; next} /^\)/{flag=0} flag' \
      "$BATS32_HOOKS_DIR/dispatch/post_tool_use.sh" \
      | grep -v '^[[:space:]]*#' \
      | grep -v '^[[:space:]]*$' \
      | sed -E 's/^[[:space:]]*"?([^"[:space:]]+).*/\1/'
  )"
  if [[ -z "$BATS32_ALL_HANDLERS" ]]; then
    echo "could not derive any active handlers from $BATS32_HOOKS_DIR/dispatch/post_tool_use.sh -- extraction pattern is stale" >&2
    return 1
  fi
  BATS32_DISABLED_HANDLERS="$(printf '%s\n' "$BATS32_ALL_HANDLERS" | paste -sd: -)"
  export BATS32_ALL_HANDLERS BATS32_DISABLED_HANDLERS
}

teardown_file() {
  [[ -n "${BATS32_REPO:-}" ]] && rm -rf "$BATS32_REPO"
  [[ -n "${BATS32_HOME:-}" ]] && rm -rf "$BATS32_HOME"
}

@test "environment sanity: /bin/bash on this runner is the historically vulnerable 3.2.x (Apple's GPLv2 freeze)" {
  run "$BATS32_BASH" --version
  assert_success
  assert_output --regexp 'version 3\.2\.[0-9]+'
}

@test "positive control: expanding an empty array under set -u crashes on this /bin/bash (proves the instrument is live, not vacuous)" {
  # bash 3.2's own exit code for an unbound-variable trap under `set -u` is
  # 127 ("command not found" is bash 3.2's generic error-path exit code, not
  # a real "command not found" here) -- assert it exactly, not just "any
  # failure", so this control cannot be satisfied by an unrelated error.
  run -127 "$BATS32_BASH" -c 'set -uo pipefail; ARR=(); echo "${ARR[@]}"'
  assert_output --partial 'unbound variable'
}

@test "run_handlers with zero handler args exits 0 (shared lib guards the internal entries[@] loop)" {
  run "$BATS32_BASH" -c "
    set -uo pipefail
    HOOKS_DIR='$BATS32_HOOKS_DIR'
    HOOK_INPUT_JSON='{}'
    source '$BATS32_HOOKS_DIR/lib/run-handlers.sh'
    run_handlers
  "
  assert_success
}

@test "run_handlers --short-circuit-on-block with zero handler args exits 0" {
  run "$BATS32_BASH" -c "
    set -uo pipefail
    HOOKS_DIR='$BATS32_HOOKS_DIR'
    HOOK_INPUT_JSON='{}'
    source '$BATS32_HOOKS_DIR/lib/run-handlers.sh'
    run_handlers --short-circuit-on-block
  "
  assert_success
}

@test "post_tool_use.sh with every currently-registered handler disabled exits 0 (the actually-reachable all-disabled configuration)" {
  local payload='{"hook_event_name":"PostToolUse","tool_name":"Read","session_id":"bash32-regression","tool_input":{},"tool_response":{}}'
  run bash -c "
    echo '$payload' | CAWS_DISABLED_HANDLERS='$BATS32_DISABLED_HANDLERS' '$BATS32_BASH' '$BATS32_HOOKS_DIR/dispatch/post_tool_use.sh'
  "
  assert_success
  refute_output --partial 'unbound variable'
}
