#!/usr/bin/env bats
# CAWS-HOOKPACK-UNGUARDED-HOME-UNBOUND-VARIABLE-001
#
# Several shared hook-pack scripts run under `set -euo pipefail` and
# dereferenced $HOME bare, or nested it unguarded inside a CAWS_HOME fallback
# (${CAWS_HOME:-${HOME}/.caws}) — so a minimal environment with no HOME (a
# container, a stripped CI runner, `env -i`) made them abort with
# "HOME: unbound variable" instead of degrading gracefully. In block-dangerous.sh
# this is more than a crash: the classifier failure is caught and re-surfaced
# as a fail-closed BLOCK that also ARMS THE DANGER LATCH for an ordinary `ls`.
#
# Each test below drives a REAL envelope through the actual dispatch path (or
# the exact reachability condition) that reaches the fixed line — an earlier
# draft of this file asserted on bare `source guard.sh </dev/null`, which
# looked plausible but never reached the buggy lines (they sit behind a
# tool-name/event/PATH-content check later in each script's control flow).
# Reachability was re-verified with `bash -x` before trusting any assertion
# here.
#
# The reprieve.sh / protected-paths.sh chain is proven fixed by the
# PRE-EXISTING kimi-surface.bats test "shim: a protected hook edit carrying
# kimi's tool_input.path is blocked end-to-end" (already run with `env -i`,
# unmodified by this spec) flipping from failing to passing — see this
# spec's AC2 evidence, not a new test here.

bats_require_minimum_version 1.5.0

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

# Positive control: prove this bash really does crash on an unset variable
# under `set -u` before trusting any "did not crash" assertion below.
@test "environment sanity: set -u really does crash on a truly unset variable" {
  run ! bash -c 'set -uo pipefail; unset TOTALLY_UNSET_PROBE_VAR; echo "$TOTALLY_UNSET_PROBE_VAR"'
  assert_output --partial 'unbound variable'
}

@test "block-dangerous.sh: a Bash command through the real PreToolUse dispatch does not crash with HOME unset" {
  # tool_name=Bash reaches classify_decision's `--home "$HOME"` at
  # block-dangerous.sh line ~164 (self-filters away for non-Bash tools).
  run env -i PATH="$PATH" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" CAWS_AGENT_SURFACE="claude-code" HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c "printf '%s' '$(hook_envelope Bash "" "ls")' | bash '$CAWS_TEST_HOOKS_DIR/dispatch/pre_tool_use.sh'"
  refute_output --partial 'HOME: unbound variable'
}

@test "scope-guard.sh: an Edit through the real PreToolUse dispatch does not crash with HOME unset" {
  # tool_name=Edit self-filters block-dangerous.sh away and reaches
  # scope-guard.sh's ALLOW_PREFIXES array (the line that used bare $HOME).
  run env -i PATH="$PATH" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" CAWS_AGENT_SURFACE="claude-code" HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c "printf '%s' '$(hook_envelope Edit "src/some-file.ts")' | bash '$CAWS_TEST_HOOKS_DIR/dispatch/pre_tool_use.sh'"
  refute_output --partial 'HOME: unbound variable'
}

@test "plan-transcript-finalize.sh: a Stop event with a real transcript_path does not crash with HOME unset" {
  # plan-transcript-finalize.sh exits before its $HOME line unless
  # HOOK_TRANSCRIPT_PATH names a file that actually exists -- supply one.
  local transcript="$CAWS_TEST_REPO/fake-transcript.jsonl"
  printf '{}\n' > "$transcript"
  run env -i PATH="$PATH" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" CAWS_AGENT_SURFACE="claude-code" HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c "printf '%s' '{\"hook_event_name\":\"Stop\",\"session_id\":\"home_unset_probe\",\"cwd\":\"$CAWS_TEST_REPO\",\"transcript_path\":\"$transcript\"}' | bash '$CAWS_TEST_HOOKS_DIR/dispatch/stop.sh'"
  refute_output --partial 'HOME: unbound variable'
}

@test "plan-transcript-snapshot.sh: an ExitPlanMode event with a matching transcript does not crash with HOME unset" {
  # Reaching this file's $HOME line needs tool_name=ExitPlanMode, a real
  # transcript file, a plan-file reference inside it matching the guard's
  # regex, AND that referenced plan file existing on disk.
  local plans_dir="$CAWS_TEST_REPO/.caws/plans"
  mkdir -p "$plans_dir"
  local plan_file="$plans_dir/probe-plan.md"
  printf '# plan\n' > "$plan_file"
  local transcript="$CAWS_TEST_REPO/exit-plan-transcript.jsonl"
  printf '{"file_path":"%s"}\n' "$plan_file" > "$transcript"
  run env -i PATH="$PATH" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" CAWS_AGENT_SURFACE="claude-code" HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c "printf '%s' '{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"home_unset_probe\",\"cwd\":\"$CAWS_TEST_REPO\",\"tool_name\":\"ExitPlanMode\",\"transcript_path\":\"$transcript\"}' | bash '$CAWS_TEST_HOOKS_DIR/dispatch/post_tool_use.sh'"
  refute_output --partial 'HOME: unbound variable'
}

@test "session-log.sh: a Stop event through the real dispatch does not crash with HOME unset" {
  run env -i PATH="$PATH" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" CAWS_AGENT_SURFACE="claude-code" HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c "printf '%s' '{\"hook_event_name\":\"Stop\",\"session_id\":\"home_unset_probe\",\"cwd\":\"$CAWS_TEST_REPO\"}' | bash '$CAWS_TEST_HOOKS_DIR/dispatch/stop.sh'"
  refute_output --partial 'HOME: unbound variable'
}

@test "runtime-paths.sh: node-path rediscovery with HOME unset does not crash when node is off PATH" {
  # ensure_hook_runtime_path only reaches the $HOME/.nvm probe when `node` is
  # NOT already found on PATH -- reproduce that precondition directly. Its
  # caller (pre_tool_use.sh) runs under `set -uo pipefail`, and that option is
  # a shell-process state, not scoped to the sourcing script -- so it must be
  # enabled here too, or this exercises a laxer mode than production ever runs.
  run env -i PATH="/usr/bin:/bin" bash -c "
    set -uo pipefail
    source '$CAWS_TEST_HOOKS_DIR/runtime-paths.sh'
    ensure_hook_runtime_path
  "
  refute_output --partial 'HOME: unbound variable'
}

@test "audit.sh: the CWD-recovery fallback line survives HOME unset" {
  # audit.sh's HOME reference lives on the CWD-resilience recovery line,
  # which only runs when `pwd` itself fails -- reproducing a truly gone CWD
  # breaks bash's OWN process spawn (getcwd() fails before any script runs),
  # so exercise the exact installed line directly instead: extract it from
  # the real installed file (not a hand-copied duplicate) and run it under
  # the same `set -uo pipefail` audit.sh itself declares.
  local cd_line
  cd_line=$(grep -m1 'cd "\${CAWS_PROJECT_DIR' "$CAWS_TEST_HOOKS_DIR/audit.sh")
  [ -n "$cd_line" ]
  run env -i PATH="$PATH" bash -c "set -uo pipefail; $cd_line; pwd"
  assert_success
  refute_output --partial 'HOME: unbound variable'
}
