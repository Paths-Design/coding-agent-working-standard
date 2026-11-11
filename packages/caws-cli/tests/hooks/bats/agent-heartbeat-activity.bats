#!/usr/bin/env bats
# agent-heartbeat.sh — activity stamp, CLI-free calls, bounded CLI
# (CAWS-HEARTBEAT-ACTIVITY-STAMP-001).
#
# The handler runs on every tool call. These cases pin when it starts the CLI
# and when it must not, by recording every CLI invocation through a stub that
# then runs the real CLI, so the lease and mailbox state are the real ones.

load helpers

setup_file() {
  caws_install_pack_once
  export HB_STUB_DIR="$CAWS_TEST_HOME/hb-stub"
  mkdir -p "$HB_STUB_DIR"
  cat > "$HB_STUB_DIR/caws-recording" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$HB_CLI_LOG"
exec "$CAWS_TEST_CLI" "$@"
STUB
  cat > "$HB_STUB_DIR/caws-hangs" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$HB_CLI_LOG"
exec sleep 47
STUB
  chmod +x "$HB_STUB_DIR/caws-recording" "$HB_STUB_DIR/caws-hangs"
}
teardown_file() {
  caws_teardown_pack
}

setup() {
  HB_SESSION="hb-activity-$BATS_TEST_NUMBER"
  export HB_CLI_LOG="$CAWS_TEST_HOME/hb-cli-$BATS_TEST_NUMBER.log"
  : > "$HB_CLI_LOG"
  HB_LEASES="$CAWS_TEST_REPO/.caws/leases"
}

# _hb_run <payload-json> [VAR=value ...]
#   Runs the handler standalone, the way a harness without a dispatcher does.
_hb_run() {
  local payload="$1"
  shift
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    CAWS_HOME="$CAWS_TEST_HOME/.caws" \
    CAWS_BIN="$HB_STUB_DIR/caws-recording" \
    HB_CLI_LOG="$HB_CLI_LOG" \
    "$@" \
    bash -c "printf '%s' '$payload' | bash '$CAWS_TEST_HOOKS_DIR/agent-heartbeat.sh'"
}

_hb_main_payload() {
  jq -nc --arg s "$HB_SESSION" '{session_id:$s, tool_name:"Read", tool_input:{file_path:"x"}}'
}
_hb_subagent_payload() {
  jq -nc --arg s "$HB_SESSION" '{session_id:$s, agent_id:"agent-1", tool_name:"Read", tool_input:{file_path:"x"}}'
}

_hb_cli_calls() {
  grep -c "$1" "$HB_CLI_LOG" || true
}

# Establishes a lease and a completed full heartbeat for HB_SESSION, then
# clears the CLI log so a case sees only what its own call started.
_hb_prime() {
  _hb_run "$(_hb_main_payload)"
  [ "$status" -eq 0 ]
  [ -f "$HB_LEASES/$HB_SESSION.json" ]
  : > "$HB_CLI_LOG"
}

@test "heartbeat-activity: the first call of a session runs the full heartbeat and records it" {
  _hb_run "$(_hb_main_payload)"
  [ "$status" -eq 0 ]
  [ "$(_hb_cli_calls '^agents heartbeat ')" -eq 1 ]
  [ "$(_hb_cli_calls '^message poll ')" -eq 1 ]
  [ -f "$HB_LEASES/$HB_SESSION.json" ]
  [ -f "$HB_LEASES/$HB_SESSION.active" ]
  run cat "$HB_LEASES/$HB_SESSION.hb"
  [[ "$output" =~ ^[0-9]+$ ]]
}

@test "heartbeat-activity: a call soon after a full heartbeat starts no CLI, prints nothing, and advances the stamp" {
  _hb_prime
  touch -t 202001010000 "$HB_LEASES/$HB_SESSION.active"
  touch "$CAWS_TEST_HOME/reference-$BATS_TEST_NUMBER"
  touch -t 202001010001 "$CAWS_TEST_HOME/reference-$BATS_TEST_NUMBER"
  _hb_run "$(_hb_main_payload)"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ ! -s "$HB_CLI_LOG" ]
  [ "$HB_LEASES/$HB_SESSION.active" -nt "$CAWS_TEST_HOME/reference-$BATS_TEST_NUMBER" ]
}

@test "heartbeat-activity: a dispatcher-parsed call that owes nothing exits before reading its piped payload" {
  _hb_prime
  _hb_run "$(_hb_main_payload)" HOOK_TOOL_NAME=Read HOOK_SESSION_ID="$HB_SESSION"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ ! -s "$HB_CLI_LOG" ]
}

@test "heartbeat-activity: a mailbox change since the last poll starts only the poll" {
  _hb_prime
  touch -t 202001010000 "$HB_LEASES/$HB_SESSION.mail"
  touch -t 202101010000 "$CAWS_TEST_REPO/.caws/messages.jsonl"
  _hb_run "$(_hb_main_payload)"
  [ "$status" -eq 0 ]
  [ "$(_hb_cli_calls '^agents heartbeat ')" -eq 0 ]
  [ "$(_hb_cli_calls '^message poll ')" -eq 1 ]
  # The poll mark moved, so the same mailbox state does not poll again.
  : > "$HB_CLI_LOG"
  _hb_run "$(_hb_main_payload)"
  [ ! -s "$HB_CLI_LOG" ]
}

@test "heartbeat-activity: a subagent call never polls and leaves the poll mark for the main thread" {
  _hb_prime
  touch -t 202001010000 "$HB_LEASES/$HB_SESSION.mail"
  touch -t 202101010000 "$CAWS_TEST_REPO/.caws/messages.jsonl"
  _hb_run "$(_hb_subagent_payload)"
  [ "$status" -eq 0 ]
  [ ! -s "$HB_CLI_LOG" ]
  # Still older than the mailbox: the main thread's next call polls.
  [ "$CAWS_TEST_REPO/.caws/messages.jsonl" -nt "$HB_LEASES/$HB_SESSION.mail" ]
  _hb_run "$(_hb_main_payload)"
  [ "$(_hb_cli_calls '^message poll ')" -eq 1 ]
}

@test "heartbeat-activity: a lease rewritten since the last full heartbeat runs the full heartbeat again" {
  _hb_prime
  # Replace the lease file with identical content, in the same second as the
  # heartbeat that preceded it: the way an atomic lease write lands.
  cp "$HB_LEASES/$HB_SESSION.json" "$HB_LEASES/$HB_SESSION.json.tmp"
  mv "$HB_LEASES/$HB_SESSION.json.tmp" "$HB_LEASES/$HB_SESSION.json"
  _hb_run "$(_hb_main_payload)"
  [ "$status" -eq 0 ]
  [ "$(_hb_cli_calls '^agents heartbeat ')" -eq 1 ]
}

@test "heartbeat-activity: a message landing in the same second as the last poll is polled again" {
  _hb_prime
  touch -t 202101010000 "$HB_LEASES/$HB_SESSION.mail" "$CAWS_TEST_REPO/.caws/messages.jsonl"
  _hb_run "$(_hb_main_payload)"
  [ "$(_hb_cli_calls '^agents heartbeat ')" -eq 0 ]
  [ "$(_hb_cli_calls '^message poll ')" -eq 1 ]
}

@test "heartbeat-activity: a stop marks the lease stopped and the next call reactivates it" {
  _hb_prime
  ( cd "$CAWS_TEST_REPO" && "$CAWS_TEST_CLI" agents stop --session-id "$HB_SESSION" --platform claude-code >/dev/null 2>&1 )
  run jq -r .status "$HB_LEASES/$HB_SESSION.json"
  [ "$output" = "stopped" ]
  # The CLI throttles its own lease rewrite on the recorded last_active, so
  # age that record past the throttle the way elapsed time would.
  jq '.last_active = "2020-01-01T00:00:00.000Z"' "$HB_LEASES/$HB_SESSION.json" > "$HB_LEASES/$HB_SESSION.json.tmp"
  mv "$HB_LEASES/$HB_SESSION.json.tmp" "$HB_LEASES/$HB_SESSION.json"
  _hb_run "$(_hb_main_payload)"
  [ "$status" -eq 0 ]
  [ "$(_hb_cli_calls '^agents heartbeat ')" -eq 1 ]
  run jq -r .status "$HB_LEASES/$HB_SESSION.json"
  [ "$output" = "active" ]
}

@test "heartbeat-activity: a full heartbeat older than the interval runs again" {
  _hb_prime
  printf '%s\n' "$(( $(date +%s) - 3600 ))" > "$HB_LEASES/$HB_SESSION.hb"
  _hb_run "$(_hb_main_payload)"
  [ "$status" -eq 0 ]
  [ "$(_hb_cli_calls '^agents heartbeat ')" -eq 1 ]
  [ "$(_hb_cli_calls '^message poll ')" -eq 1 ]
}

@test "heartbeat-activity: a full-heartbeat record dated in the future is not trusted" {
  _hb_prime
  printf '%s\n' "$(( $(date +%s) + 3600 ))" > "$HB_LEASES/$HB_SESSION.hb"
  _hb_run "$(_hb_main_payload)"
  [ "$(_hb_cli_calls '^agents heartbeat ')" -eq 1 ]
}

@test "heartbeat-activity: an unparseable full-heartbeat record runs the full heartbeat" {
  _hb_prime
  printf 'soon\n' > "$HB_LEASES/$HB_SESSION.hb"
  _hb_run "$(_hb_main_payload)"
  [ "$(_hb_cli_calls '^agents heartbeat ')" -eq 1 ]
}

@test "heartbeat-activity: a session id that is not a safe filename writes no sidecar" {
  HB_SESSION='../escape'
  # A lease-shaped file where the unchecked id would resolve, so only the id
  # check stands between this call and a sidecar outside the lease directory.
  printf '{}' > "$CAWS_TEST_REPO/.caws/escape.json"
  _hb_run "$(_hb_main_payload)"
  [ "$status" -eq 0 ]
  [ ! -e "$CAWS_TEST_REPO/.caws/escape.active" ]
  [ ! -e "$CAWS_TEST_REPO/.caws/escape.hb" ]
  run bash -c "ls '$HB_LEASES' | grep -c 'escape' || true"
  [ "$output" = "0" ]
}

@test "heartbeat-activity: a CLI that never returns is ended at the deadline and the call proceeds" {
  local started ended
  started="$(date +%s)"
  _hb_run "$(_hb_main_payload)" CAWS_BIN="$HB_STUB_DIR/caws-hangs" CAWS_HEARTBEAT_CLI_DEADLINE_SECONDS=1
  ended="$(date +%s)"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ "$(_hb_cli_calls '^agents heartbeat ')" -eq 1 ]
  [ "$(( ended - started ))" -lt 10 ]
  # The hung CLI is gone, not left running behind the handler.
  run pgrep -f "sleep 47"
  [ "$status" -ne 0 ]
}
