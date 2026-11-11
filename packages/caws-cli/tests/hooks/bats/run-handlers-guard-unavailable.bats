#!/usr/bin/env bats
# CAWS-GUARD-UNAVAILABLE-BLOCKS-001 — on the enforcing PreToolUse chain a guard
# that cannot reach a verdict must not let a mutating tool call through, and the
# refusal must say which guard failed, that the agent did not cause it, and what
# to do next.
#
# Only exit 2 (or a block decision on stdout) blocks a tool call. A guard that
# crashed with exit 1, or was missing from the pack, therefore used to count as
# "no objection": the call ran with that guard silently absent.

load helpers

bats_require_minimum_version 1.5.0

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

setup() {
  FAKE_HOOKS="$(mktemp -d "${TMPDIR:-/tmp}/caws-bats-unavail-XXXXXX")"
  MARKER="$FAKE_HOOKS/later-ran"
  cat > "$FAKE_HOOKS/ok.sh" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
exit 0
EOF
  cat > "$FAKE_HOOKS/crash.sh" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
echo "jq: command not found" >&2
exit 1
EOF
  cat > "$FAKE_HOOKS/crash127.sh" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
exit 127
EOF
  cat > "$FAKE_HOOKS/deny.sh" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
echo "policy refusal" >&2
exit 2
EOF
  cat > "$FAKE_HOOKS/later.sh" <<EOF
#!/usr/bin/env bash
cat >/dev/null
: > "$MARKER"
exit 0
EOF
  cat > "$FAKE_HOOKS/not-executable.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$FAKE_HOOKS/ok.sh" "$FAKE_HOOKS/crash.sh" "$FAKE_HOOKS/crash127.sh" \
    "$FAKE_HOOKS/deny.sh" "$FAKE_HOOKS/later.sh"
}

teardown() {
  rm -rf "$FAKE_HOOKS"
}

# chain <tool-name> <flags> <handlers...> [-- ENV=value ...]
# Runs run_handlers with stdout and stderr kept apart: $output is stdout (the
# decision the harness reads) and $stderr is the diagnostic channel.
chain() {
  local tool="$1" flags="$2"; shift 2
  local -a handlers=() extra=()
  local seen_sep=0 arg
  for arg in "$@"; do
    if [[ "$arg" == "--" ]]; then seen_sep=1; continue; fi
    if (( seen_sep )); then extra+=("$arg"); else handlers+=("$arg"); fi
  done
  local -a envargs=(
    PATH="$PATH"
    CAWS_HOME="$BATS_TEST_TMPDIR/caws-home"
    HOOK_SESSION_ID="unavail-$$-${BATS_TEST_NUMBER}"
    HOOK_TOOL_NAME="$tool"
    HOOK_EVENT_NAME="PreToolUse"
  )
  if ((${#extra[@]})); then envargs+=("${extra[@]}"); fi
  run --separate-stderr env -i "${envargs[@]}" bash -c "
    source '$CAWS_TEST_HOOKS_DIR/lib/run-handlers.sh'
    export HOOKS_DIR='$FAKE_HOOKS' HOOK_INPUT_JSON='{}'
    run_handlers $flags ${handlers[*]}
  "
}

reason() {
  printf '%s' "$output" | jq -r '.reason'
}

@test "a guard that exits 1 blocks a Bash call and the reason names the guard, its status and its output" {
  chain Bash --short-circuit-on-block ok.sh crash.sh
  [ "$status" -eq 2 ]
  [ "$(printf '%s' "$output" | jq -r '.decision')" = "block" ]
  local r; r="$(reason)"
  [[ "$r" == *"crash.sh exited with status 1 without reaching a verdict"* ]] || fail "reason lacks guard and status: $r"
  [[ "$r" == *"jq: command not found"* ]] || fail "reason lacks the guard's own output: $r"
  [[ "$r" == *"Your command did not cause this"* ]] || fail "reason does not clear the agent: $r"
  # The runner can vouch only for itself: an earlier guard in the same dispatch
  # may have recorded a strike, so the reason must not claim none exists.
  [[ "$r" == *"this refusal adds no strike and arms no latch"* ]] || fail "reason does not state the strike outcome: $r"
  [[ "$r" != *"no strike or latch was recorded"* ]] || fail "reason claims no strike exists at all: $r"
  [[ "$r" == *"stop and report this message to the user"* ]] || fail "reason gives no next step: $r"
  [[ "$r" == *"Bash tool call is refused"* ]] || fail "reason does not name the refused tool: $r"
}

@test "Write and Edit are blocked the same way as Bash" {
  local tool
  for tool in Write Edit MultiEdit NotebookEdit; do
    chain "$tool" --short-circuit-on-block crash.sh
    [ "$status" -eq 2 ] || fail "$tool was not blocked (status $status)"
    [[ "$(reason)" == *"$tool tool call is refused"* ]] || fail "$tool reason: $(reason)"
  done
}

@test "an exit status that is neither 0 nor 2 blocks, whatever its value" {
  chain Bash --short-circuit-on-block crash127.sh
  [ "$status" -eq 2 ]
  [[ "$(reason)" == *"crash127.sh exited with status 127 without reaching a verdict"* ]] || fail "$(reason)"
}

@test "a missing guard blocks a mutating call and the reason names the guard and its expected path" {
  chain Write --short-circuit-on-block ok.sh absent-guard.sh
  [ "$status" -eq 2 ]
  local r; r="$(reason)"
  [[ "$r" == *"absent-guard.sh is missing or not executable at $FAKE_HOOKS/absent-guard.sh"* ]] || fail "$r"
  [[ "$r" == *"Your command did not cause this"* ]] || fail "$r"
}

@test "a guard file without the executable bit blocks a mutating call" {
  chain Edit --short-circuit-on-block not-executable.sh
  [ "$status" -eq 2 ]
  [[ "$(reason)" == *"not-executable.sh is missing or not executable"* ]] || fail "$(reason)"
}

@test "handlers after an unavailable guard do not run on a mutating call" {
  chain Bash --short-circuit-on-block crash.sh later.sh
  [ "$status" -eq 2 ]
  [ ! -e "$MARKER" ] || fail "a later handler ran after the chain was already refused"
}

@test "Read, Glob and Grep are not blocked by a crashed guard, and stderr names the fault" {
  local tool
  for tool in Read Glob Grep; do
    chain "$tool" --short-circuit-on-block crash.sh later.sh
    [ "$status" -eq 0 ] || fail "$tool was refused (status $status)"
    [ -z "$output" ] || fail "$tool produced a decision on stdout: $output"
    [[ "$stderr" == *"guard unavailable: crash.sh exited with status 1 without reaching a verdict"* ]] || fail "$tool stderr: $stderr"
    [[ "$stderr" == *"$tool is read-only, so it is not blocked"* ]] || fail "$tool stderr: $stderr"
    [ -e "$MARKER" ] || fail "$tool: the rest of the chain did not run"
    rm -f "$MARKER"
  done
}

@test "Read is not blocked by a missing guard, and stderr names it" {
  chain Read --short-circuit-on-block absent-guard.sh
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [[ "$stderr" == *"guard unavailable: absent-guard.sh is missing or not executable"* ]] || fail "$stderr"
}

@test "a call with no tool name is treated as mutating" {
  chain "" --short-circuit-on-block ok.sh
  [ "$status" -eq 2 ]
  local r; r="$(reason)"
  [[ "$r" == *"hook payload carried no tool name"* ]] || fail "$r"
  [[ "$r" == *"unidentified tool call is refused"* ]] || fail "$r"
}

@test "an unparsed payload with no parser available blocks the enforcing chain and passes a non-enforcing one" {
  # No HOOK_INPUT_JSON, and FAKE_HOOKS has no lib/parse-input.sh.
  run --separate-stderr env -i PATH="$PATH" CAWS_HOME="$BATS_TEST_TMPDIR/caws-home" bash -c "
    source '$CAWS_TEST_HOOKS_DIR/lib/run-handlers.sh'
    export HOOKS_DIR='$FAKE_HOOKS'
    run_handlers --short-circuit-on-block ok.sh
  "
  [ "$status" -eq 2 ]
  [[ "$(reason)" == *"the hook payload parser is missing at $FAKE_HOOKS/lib/parse-input.sh"* ]] || fail "$(reason)"

  run --separate-stderr env -i PATH="$PATH" CAWS_HOME="$BATS_TEST_TMPDIR/caws-home" bash -c "
    source '$CAWS_TEST_HOOKS_DIR/lib/run-handlers.sh'
    export HOOKS_DIR='$FAKE_HOOKS'
    run_handlers ok.sh
  "
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "a guard that prints a block decision and then exits 1 keeps its own decision" {
  cat > "$FAKE_HOOKS/deny-then-crash.sh" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
printf '%s\n' '{"decision":"block","reason":"GUARD-OWN-VERDICT"}'
exit 1
EOF
  chmod +x "$FAKE_HOOKS/deny-then-crash.sh"
  chain Bash --short-circuit-on-block deny-then-crash.sh
  [ "$status" -eq 2 ]
  [ "$(reason)" = "GUARD-OWN-VERDICT" ] || fail "the guard's verdict was replaced: $output"
}

@test "the payload's event name cannot disarm the chain its dispatcher selected" {
  # The dispatcher chose the enforcing chain; the event name is payload input.
  local event
  for event in "" Stop SessionEnd PostToolUse BeforeTool pre_tool_use; do
    chain Bash --short-circuit-on-block crash.sh later.sh -- HOOK_EVENT_NAME="$event"
    [ "$status" -eq 2 ] || fail "event '$event' disarmed the chain (status $status)"
    [ ! -e "$MARKER" ] || fail "event '$event': the chain continued past an unavailable guard"
  done
}

@test "a crashed or missing advisory handler is reported and does not refuse the call" {
  local name
  for name in agent-heartbeat.sh cwd-guard.sh scan-secrets.sh quiet-merge.sh; do
    cp "$FAKE_HOOKS/crash.sh" "$FAKE_HOOKS/$name"
    chain Bash --short-circuit-on-block "$name" later.sh
    [ "$status" -eq 0 ] || fail "$name crash refused the call (status $status)"
    [ -z "$output" ] || fail "$name crash produced a decision: $output"
    [[ "$stderr" == *"advisory handler unavailable: $name exited with status 1"* ]] || fail "$name: $stderr"
    [ -e "$MARKER" ] || fail "$name crash stopped the chain"
    rm -f "$MARKER" "$FAKE_HOOKS/$name"

    chain Write --short-circuit-on-block "$name" later.sh
    [ "$status" -eq 0 ] || fail "missing $name refused the call (status $status)"
    [[ "$stderr" == *"advisory handler unavailable: $name is missing or not executable"* ]] || fail "$name: $stderr"
    [ -e "$MARKER" ] || fail "missing $name stopped the chain"
    rm -f "$MARKER"
  done
}

@test "a handler with a refusal path is a guard even though most of its output is advisory" {
  cp "$FAKE_HOOKS/crash.sh" "$FAKE_HOOKS/shortcut-language-check.sh"
  chain Write --short-circuit-on-block shortcut-language-check.sh
  [ "$status" -eq 2 ]
  [[ "$(reason)" == *"shortcut-language-check.sh exited with status 1"* ]] || fail "$(reason)"
}

@test "dry-run reports a missing parser and does not block" {
  run --separate-stderr env -i PATH="$PATH" CAWS_HOME="$BATS_TEST_TMPDIR/caws-home" CAWS_HOOK_DRY_RUN=1 bash -c "
    source '$CAWS_TEST_HOOKS_DIR/lib/run-handlers.sh'
    export HOOKS_DIR='$FAKE_HOOKS'
    run_handlers --short-circuit-on-block ok.sh
  "
  [ "$status" -eq 0 ]
  [ -z "$output" ] || fail "dry-run produced a decision: $output"
  [[ "$stderr" == *"[DRY-RUN] the hook payload parser is missing at $FAKE_HOOKS/lib/parse-input.sh and would have blocked"* ]] || fail "$stderr"
}

@test "dry-run reports a crashed and a missing guard and blocks neither" {
  chain Bash --short-circuit-on-block crash.sh absent-guard.sh later.sh -- CAWS_HOOK_DRY_RUN=1
  [ "$status" -eq 0 ]
  [ -z "$output" ] || fail "dry-run produced a decision: $output"
  [[ "$stderr" == *"[DRY-RUN] crash.sh would have exited 1"* ]] || fail "$stderr"
  [[ "$stderr" == *"[DRY-RUN] absent-guard.sh is missing or not executable and would have blocked"* ]] || fail "$stderr"
  [ -e "$MARKER" ] || fail "dry-run stopped the chain"
}

@test "a genuine exit-2 refusal keeps its own status and gains no guard-unavailable text" {
  chain Bash --short-circuit-on-block deny.sh
  [ "$status" -eq 2 ]
  [[ "$output" != *"guard unavailable"* ]] || fail "a policy refusal was relabelled: $output"
  [[ "$stderr" == *"policy refusal"* ]] || fail "$stderr"
  [[ "$stderr" != *"guard unavailable"* ]] || fail "$stderr"
}

@test "a chain run without the enforcing flag keeps a crashed handler's status and does not block" {
  chain Bash "" ok.sh crash.sh later.sh
  [ "$status" -eq 1 ]
  [ -z "$output" ] || fail "a non-enforcing chain produced a decision: $output"
  [[ "$stderr" != *"guard unavailable"* ]] || fail "$stderr"
  [ -e "$MARKER" ] || fail "the rest of a non-enforcing chain did not run"
}

@test "a chain run without the enforcing flag still skips a missing handler" {
  chain Bash "" absent-guard.sh later.sh
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ -e "$MARKER" ]
}

@test "the block decision stays valid JSON when the guard's output holds quotes, backslashes and control bytes" {
  cat > "$FAKE_HOOKS/noisy.sh" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
printf 'bad "quote" and \\ backslash and \033[31mcolor\033[0m and tab\there\n' >&2
exit 1
EOF
  chmod +x "$FAKE_HOOKS/noisy.sh"
  chain Bash --short-circuit-on-block noisy.sh
  [ "$status" -eq 2 ]
  local r; r="$(reason)" || fail "stdout is not valid JSON: $output"
  [[ "$r" == *'bad "quote" and \ backslash'* ]] || fail "$r"
}
