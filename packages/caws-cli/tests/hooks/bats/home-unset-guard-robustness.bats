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
  # Assert the ordinary command is actually ADMITTED and the danger latch
  # stays UNARMED, not merely "no crash message" -- the pre-fix behavior was
  # worse than a crash: the classifier failure was caught and re-surfaced as
  # a fail-closed BLOCK that armed the danger latch for an ordinary `ls`.
  rm -f "$CAWS_TEST_REPO/.claude/hooks/state/danger-latch-"*.json 2>/dev/null || true
  run env -i PATH="$PATH" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" CAWS_AGENT_SURFACE="claude-code" HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c "printf '%s' '$(hook_envelope Bash "" "ls")' | bash '$CAWS_TEST_HOOKS_DIR/dispatch/pre_tool_use.sh'"
  refute_output --partial 'HOME: unbound variable'
  refute_output --partial '"decision":"block"'
  refute_output --partial 'danger latch'
  run bash -c "ls '$CAWS_TEST_REPO/.claude/hooks/state/'danger-latch-*.json 2>/dev/null"
  assert_output ""
}

@test "CODE INVARIANT: block-dangerous.sh omits --home rather than passing an empty string when HOME is unset" {
  # classify_command.py's own --home default (Path.home()) can resolve a
  # real home via the passwd database even when $HOME is unset in the
  # environment; an explicit empty string instead resolves to the CURRENT
  # DIRECTORY there (verified: Path("").resolve() == cwd), which would
  # silently weaken the "recursive delete targets ancestor of home
  # directory" hard-block for any raw ~-prefixed multi-segment target by
  # comparing against the wrong reference path. Confirm the guard never
  # constructs the vulnerable form.
  run grep -c -- '--home "\${HOME:-}"' "$CAWS_TEST_HOOKS_DIR/block-dangerous.sh"
  assert_output "0"
  run grep -c -- '+=(--home "\$HOME")' "$CAWS_TEST_HOOKS_DIR/block-dangerous.sh"
  assert_output "2"
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


# --- CAWS-HOOKPACK-HOME-UNSET-ROOT-AUTHORITY-ALIAS-001 ---------------------
#
# Merely "does not crash" was not enough: the CAWS_HOME_UNBOUND_VARIABLE fix
# above degraded several ${HOME:-} fallbacks to a ROOT-BASED path ("/",
# "/.claude", "/.caws") instead of "no home-tier authority exists" -- and
# because scope-guard.sh consults absolute ALLOW_PREFIXES entries BEFORE its
# foreign-repo containment refusal, that aliasing let an absolute write
# outside the governed repo bypass containment entirely. Each test below is
# a hostile control (proves the bug when present) paired with a positive
# control (proves the legitimate case still works after the fix).

@test "HOSTILE: scope-guard.sh does NOT admit a foreign absolute path via the home-vendor-dir allow-prefix when HOME is unset" {
  # Pre-fix: "${HOME:-}/${CAWS_VENDOR_DIR}/" with HOME unset is the ABSOLUTE
  # prefix "/.claude/". The foreign-repo containment block at scope-guard.sh
  # consults absolute ALLOW_PREFIXES entries before refusing, so a write to
  # /.claude/pwned-outside-repo.sh (a path outside this session's repo
  # entirely) was silently ADMITTED (exit 0) instead of BLOCKED (exit 2).
  run env -i PATH="$PATH" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" CAWS_AGENT_SURFACE="claude-code" HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c "printf '%s' '$(hook_envelope Edit "/.claude/pwned-outside-repo.sh")' | bash '$CAWS_TEST_HOOKS_DIR/scope-guard.sh'"
  assert_failure 2
  assert_output --partial 'DIFFERENT repository'
}

@test "POSITIVE CONTROL: scope-guard.sh still honors the home-vendor-dir allow-prefix when HOME is real" {
  local fake_home="$CAWS_TEST_REPO/.fake-home-scope-guard"
  mkdir -p "$fake_home"
  run env -i PATH="$PATH" HOME="$fake_home" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" CAWS_AGENT_SURFACE="claude-code" HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c "printf '%s' '$(hook_envelope Edit "$fake_home/.claude/legit-state.json")' | bash '$CAWS_TEST_HOOKS_DIR/scope-guard.sh'"
  assert_success
}

@test "HOSTILE: protected-paths.sh does NOT flag an unrelated absolute /.caws/bin/ path as protected machine-home state when HOME is unset" {
  # Pre-fix: machine_home="${CAWS_HOME:-${HOME:-}/.caws}" with both unset is
  # the absolute path "/.caws", so "$machine_home/bin/"* became "/.caws/bin/"*
  # -- an unrelated real filesystem path (e.g. on a container where /.caws
  # exists for an unrelated reason) would be wrongly BLOCKED as protected
  # machine-home state it has no relationship to. Confirm this false-positive
  # is closed: an absolute /.caws/bin/ path is admitted, not flagged.
  run env -i PATH="$PATH" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" CAWS_AGENT_SURFACE="claude-code" HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c "printf '%s' '$(hook_envelope_content Edit "/.caws/bin/unrelated-tool" "harmless")' | bash '$CAWS_TEST_HOOKS_DIR/protected-paths.sh'"
  refute_output --partial 'is protected'
  assert_success
}

@test "HOSTILE: reprieve.sh's state-dir lookup fails closed (not a root path) when HOME and CAWS_HOME are absent" {
  run env -i PATH="$PATH" bash -c "
    source '$CAWS_TEST_HOOKS_DIR/lib/reprieve.sh'
    caws_reprieve_state_dir 'some-session-id'
  "
  assert_failure
  refute_output --partial '/state/sessions/'
}

@test "POSITIVE CONTROL: reprieve.sh's state-dir lookup resolves correctly under a real HOME" {
  local fake_home="$CAWS_TEST_REPO/.fake-home-reprieve"
  mkdir -p "$fake_home"
  run env -i PATH="$PATH" HOME="$fake_home" bash -c "
    source '$CAWS_TEST_HOOKS_DIR/lib/reprieve.sh'
    caws_reprieve_state_dir 'some-session-id'
  "
  assert_success
  assert_output "${fake_home}/.caws/state/sessions/some-session-id"
}

@test "CODE INVARIANT: agent-surface.sh no longer aliases an absent home to a root-based machine-user override path" {
  run grep -c '\${CAWS_HOME:-\${HOME:-\?}\?/\.caws}' "$CAWS_TEST_HOOKS_DIR/lib/agent-surface.sh"
  assert_output "0"
}

# CAWS-HOOKPACK-AGENT-SURFACE-MACHINE-RUNTIME-HOME-CONTROL-001: the code
# invariant above proves the vulnerable pattern is gone, but not that the
# machine-runtime user-home tier still functions -- that branch is only
# entered under CAWS_MACHINE_RUNTIME=1, which none of the reachability tests
# above exercise. Drive caws_source_lib through that branch directly.

@test "HOSTILE: caws_source_lib's machine-runtime user tier is skipped (not root-probed) when HOME and CAWS_HOME are absent" {
  # An OUTCOME-only assertion here is vacuous: both the buggy and fixed
  # versions fall through to the adapter tier, because a real root-relative
  # /surfaces/.../lib/probe.sh cannot exist without root (proven empirically
  # by tracing the pre-fix code: it correctly falls through too, just via a
  # root-path check we cannot make legitimately succeed OR fail on demand).
  # The actual difference is CONTROL FLOW: the fixed version never
  # constructs or tests a machine_user path when no home is known; the
  # pre-fix version does (against a literal "/.caws/surfaces/..." target).
  # Assert on the trace, which is what genuinely discriminates the two.
  local adapter_dir="$CAWS_TEST_REPO/.fake-adapter-lib"
  mkdir -p "$adapter_dir"
  printf 'MARKER=adapter\n' > "$adapter_dir/probe.sh"
  run env -i PATH="$PATH" CAWS_MACHINE_RUNTIME=1 CAWS_MACHINE_LIBRARIES='{}' \
    CAWS_AGENT_SURFACE=claude-code CAWS_MACHINE_ADAPTER_LIB_DIR="$adapter_dir" \
    CAWS_SHARED_LIB_DIR="$CAWS_TEST_HOOKS_DIR/lib" \
    bash -xc "
      source '$CAWS_TEST_HOOKS_DIR/lib/agent-surface.sh'
      caws_source_lib probe.sh
      printf 'MARKER=%s\n' \"\$MARKER\"
    "
  assert_success
  assert_output --partial 'MARKER=adapter'
  refute_output --partial '/.caws/surfaces/'
  refute_output --partial "'/surfaces/"
}

@test "POSITIVE CONTROL: caws_source_lib's machine-runtime user tier still wins over the adapter fallback under a real HOME" {
  local adapter_dir="$CAWS_TEST_REPO/.fake-adapter-lib2"
  mkdir -p "$adapter_dir"
  printf 'MARKER=adapter\n' > "$adapter_dir/probe.sh"
  local fake_home="$CAWS_TEST_REPO/.fake-home-machine-runtime"
  mkdir -p "$fake_home/.caws/surfaces/claude-code/lib"
  printf 'MARKER=user-override\n' > "$fake_home/.caws/surfaces/claude-code/lib/probe.sh"
  run env -i PATH="$PATH" HOME="$fake_home" CAWS_MACHINE_RUNTIME=1 CAWS_MACHINE_LIBRARIES='{}' \
    CAWS_AGENT_SURFACE=claude-code CAWS_MACHINE_ADAPTER_LIB_DIR="$adapter_dir" \
    CAWS_SHARED_LIB_DIR="$CAWS_TEST_HOOKS_DIR/lib" \
    bash -c "
      source '$CAWS_TEST_HOOKS_DIR/lib/agent-surface.sh'
      caws_source_lib probe.sh
      printf 'MARKER=%s\n' \"\$MARKER\"
    "
  assert_success
  assert_output --partial 'MARKER=user-override'
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
