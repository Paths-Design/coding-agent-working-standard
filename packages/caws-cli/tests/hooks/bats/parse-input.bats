#!/usr/bin/env bats
# parse-input/runtime-paths — shared hook input parser failure visibility.
#
# Malformed vendor hook JSON must remain fail-open (hooks should not wedge the
# user's tool call because the harness payload was bad), but it must be visible
# and honest so agents do not confuse "no guard output" with a permitted command.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

run_pre_tool_dispatcher_raw() {
  local payload="$1"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    bash -c "printf '%s' '$payload' | bash '$CAWS_TEST_HOOKS_DIR/dispatch/pre_tool_use.sh'"
}

@test "parse-input: malformed dispatcher payload fails open but emits CAWS parse diagnostic" {
  run_pre_tool_dispatcher_raw '{not json'

  assert_success
  assert_output --partial '[CAWS hook parse] malformed hook input JSON'
  assert_output --partial 'failing open with an empty payload'
  assert_output --partial 'Expected vendor hook payload JSON on stdin'
  assert_output --partial 'Parser:'
  refute_output --partial '{not json'
  refute_output --partial 'Traceback'
  refute_output --partial '"decision": "block"'
}

@test "parse-input: valid dispatcher payload emits no parser diagnostic" {
  run_pre_tool_dispatcher_raw "$(hook_envelope Bash '' 'git status')"

  assert_success
  refute_output --partial '[CAWS hook parse]'
  refute_output --partial '"decision": "block"'
}

# Drive the PreToolUse dispatcher with a payload that carries session_id,
# under a given CAWS_AGENT_SURFACE. CAWS-RESOLVER-PLATFORM-FROM-ENVELOPE-001
# (A5): the durable session envelope written by _write_durable_session_envelope
# must carry a `platform` field sourced from CAWS_PLATFORM_FLAG.
#
# NOTE: the payload MUST include `cwd` (set to the temp repo). parse_hook_input
# extracts HOOK_CWD from data.cwd, and the envelope writer resolves the
# canonical repo_root via `cd "$HOOK_CWD" && git rev-parse --git-common-dir`;
# without cwd it returns early (no envelope written).
run_envelope_write() {
  local surface="$1" sid="$2"
  local payload
  payload="$(jq -nc --arg sid "$sid" --arg cwd "$CAWS_TEST_REPO" \
    '{tool_name:"Bash", tool_input:{file_path:"", command:"git status"}, session_id:$sid, cwd:$cwd}')"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="$surface" \
    HOOK_EVENT_NAME="PreToolUse" \
    bash -c "printf '%s' '$payload' | bash '$CAWS_TEST_HOOKS_DIR/dispatch/pre_tool_use.sh'"
}

envelope_platform() {
  local sid="$1" envfile
  envfile="$CAWS_TEST_REPO/.caws/sessions/$sid/.session-envelope.json"
  python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    print(json.load(f).get("platform", "<MISSING>"))
' "$envfile" 2>/dev/null
}

@test "parse-input: durable envelope records platform per surface (A5)" {
  local sid="bats_a5_zcode"
  run_envelope_write "zcode" "$sid"
  assert_success
  [[ -f "$CAWS_TEST_REPO/.caws/sessions/$sid/.session-envelope.json" ]]
  [ "$(envelope_platform "$sid")" = "zcode" ]

  sid="bats_a5_codex"
  run_envelope_write "codex" "$sid"
  assert_success
  [ "$(envelope_platform "$sid")" = "codex" ]

  sid="bats_a5_claude"
  run_envelope_write "claude-code" "$sid"
  assert_success
  [ "$(envelope_platform "$sid")" = "claude-code" ]

  sid="bats_a5_opencode"
  run_envelope_write "opencode" "$sid"
  assert_success
  [ "$(envelope_platform "$sid")" = "opencode" ]
}

@test "parse-input: parse_hook_input survives a no-agent-ancestor walk under set -euo pipefail (CAWS-DEFECT-HOOK-AGENT-PID-FAILOPEN-01)" {
  # Root cause of the bash-write-guard silent-death cluster: with a real
  # session_id and CAWS_AGENT_PROCESS_NAMES naming a process ABSENT from the
  # PID tree (bats/CI/plain terminal), _write_agent_pid_record's unguarded
  # read-group hit EOF and aborted the whole guard with exit 1 and zero
  # output. This drives parse_hook_input directly under the same
  # `set -euo pipefail` posture every guard script runs with.
  local payload
  payload="$(jq -nc --arg cwd "$CAWS_TEST_REPO" \
    '{tool_name:"Bash", tool_input:{command:"git status"}, session_id:"bats_failopen", cwd:$cwd}')"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_PROCESS_NAMES="caws-nonexistent-agent-ancestor" \
    HOOK_EVENT_NAME="PreToolUse" \
    bash -c '
      set -euo pipefail
      source "$1/lib/parse-input.sh"
      printf "%s" "$2" | parse_hook_input
    ' _ "$CAWS_TEST_HOOKS_DIR" "$payload"
  assert_success
}

@test "parse-input: read_session_id_from_agent_pid miss still returns cleanly under set -e (A2)" {
  # The sibling read-group in agent-pid.sh: a no-match walk must let the
  # function reach its own `return 1` miss path (checked here in an if
  # condition) instead of dying mid-function on the read-group EOF.
  run env \
    bash -c '
      set -euo pipefail
      source "$1/lib/agent-pid.sh"
      if read_session_id_from_agent_pid "$2/.caws" "caws-nonexistent-agent-ancestor"; then
        echo unexpected-hit
        exit 9
      fi
      echo miss-returned-cleanly
    ' _ "$CAWS_TEST_HOOKS_DIR" "$CAWS_TEST_REPO"
  assert_success
  assert_output --partial 'miss-returned-cleanly'
  refute_output --partial 'unexpected-hit'
}

@test "parse-input: durable envelope platform defaults to claude-code when CAWS_PLATFORM_FLAG unset (A5 back-compat)" {
  # Simulate a wiring that has not sourced agent-surface.sh: surface is
  # unknown, so CAWS_PLATFORM_FLAG is unset and the default fires.
  local sid="bats_a5_default" payload
  payload="$(jq -nc --arg sid "$sid" --arg cwd "$CAWS_TEST_REPO" \
    '{tool_name:"Bash", tool_input:{file_path:"", command:"git status"}, session_id:$sid, cwd:$cwd}')"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    HOOK_EVENT_NAME="PreToolUse" \
    bash -c "printf '%s' '$payload' | bash '$CAWS_TEST_HOOKS_DIR/dispatch/pre_tool_use.sh'"
  assert_success
  [[ -f "$CAWS_TEST_REPO/.caws/sessions/$sid/.session-envelope.json" ]]
  [ "$(envelope_platform "$sid")" = "claude-code" ]
}

# CAWS-HOOKS-AGENT-PID-PROGRESSIVE-REAP-001 — _reap_stale_agent_pid_records
# unit coverage. Drives the function directly (source + call), independent
# of the resolver/dispatcher chain, since bats has no real agent ancestor
# in its PID tree for _write_agent_pid_record to walk to.

# Backdate a file's mtime by $2 days (fractional allowed) via python3's
# os.utime — portable across the BSD/GNU `touch`/`date` split this repo
# already works around elsewhere.
_bats_backdate() {
  python3 -c '
import os, sys, time
path, days = sys.argv[1], float(sys.argv[2])
t = time.time() - days * 86400
os.utime(path, (t, t))
' "$1" "$2"
}

_bats_write_agent_pid_json() {
  local path="$1" pid="$2"
  printf '{"agent_pid": %s, "session_id": "s", "surface": "claude-code", "repo_root": "r", "created_at": "x", "last_seen_at": "x", "started_at": null}\n' "$pid" > "$path"
}

@test "reap: records under 3 days old are never touched regardless of pid liveness" {
  # BATS_TEST_TMPDIR is unique per test (bats-core) — deliberately NOT the
  # shared $CAWS_TEST_REPO/.caws/sessions, since the reap's own rate-limit
  # marker is stateful and would otherwise leak across tests in this file
  # and make every test after the first a silent no-op.
  local sdir="$BATS_TEST_TMPDIR/sessions"
  mkdir -p "$sdir"
  _bats_write_agent_pid_json "$sdir/agent-pid-999999.json" 999999
  _bats_backdate "$sdir/agent-pid-999999.json" 1

  run bash -c '
    set -euo pipefail
    source "$1/lib/parse-input.sh"
    _reap_stale_agent_pid_records "$2"
  ' _ "$CAWS_TEST_HOOKS_DIR" "$sdir"
  assert_success
  [[ -f "$sdir/agent-pid-999999.json" ]]
}

@test "reap: 3-7 day band deletes only when the recorded pid is confirmed dead (kill -0)" {
  local sdir="$BATS_TEST_TMPDIR/sessions"
  mkdir -p "$sdir"

  # A live pid: a background sleep this test owns and cleans up. Redirected
  # away from the test shell's stdout/stderr — otherwise `run`'s output
  # capture below blocks until this backgrounded process's inherited fds
  # close too (a classic `cmd & | capture` hang), not just the tracked command.
  sleep 60 >/dev/null 2>&1 &
  local live_pid=$!

  # A dead pid: a subprocess that has already exited and been reaped.
  ( exit 0 ) >/dev/null 2>&1 &
  local dead_pid=$!
  wait "$dead_pid" || true

  _bats_write_agent_pid_json "$sdir/agent-pid-${live_pid}.json" "$live_pid"
  _bats_backdate "$sdir/agent-pid-${live_pid}.json" 5
  _bats_write_agent_pid_json "$sdir/agent-pid-${dead_pid}.json" "$dead_pid"
  _bats_backdate "$sdir/agent-pid-${dead_pid}.json" 5

  run bash -c '
    set -euo pipefail
    source "$1/lib/parse-input.sh"
    _reap_stale_agent_pid_records "$2"
  ' _ "$CAWS_TEST_HOOKS_DIR" "$sdir"
  assert_success

  kill "$live_pid" 2>/dev/null || true
  wait "$live_pid" 2>/dev/null || true

  [[ -f "$sdir/agent-pid-${live_pid}.json" ]]
  [[ ! -f "$sdir/agent-pid-${dead_pid}.json" ]]
}

@test "reap: records past the 7-day hard cutoff are deleted unconditionally, even for a live pid" {
  local sdir="$BATS_TEST_TMPDIR/sessions"
  mkdir -p "$sdir"

  sleep 60 >/dev/null 2>&1 &
  local live_pid=$!
  _bats_write_agent_pid_json "$sdir/agent-pid-${live_pid}.json" "$live_pid"
  _bats_backdate "$sdir/agent-pid-${live_pid}.json" 10

  run bash -c '
    set -euo pipefail
    source "$1/lib/parse-input.sh"
    _reap_stale_agent_pid_records "$2"
  ' _ "$CAWS_TEST_HOOKS_DIR" "$sdir"
  assert_success

  kill "$live_pid" 2>/dev/null || true
  wait "$live_pid" 2>/dev/null || true

  [[ ! -f "$sdir/agent-pid-${live_pid}.json" ]]
}

@test "reap: orphaned .tmp atomic-write remnants older than 60 minutes are swept; fresh ones survive" {
  local sdir="$BATS_TEST_TMPDIR/sessions"
  mkdir -p "$sdir"
  : > "$sdir/.agent-pid-11111.tmp.old"
  _bats_backdate "$sdir/.agent-pid-11111.tmp.old" 0.1
  : > "$sdir/.agent-pid-22222.tmp.fresh"

  run bash -c '
    set -euo pipefail
    source "$1/lib/parse-input.sh"
    _reap_stale_agent_pid_records "$2"
  ' _ "$CAWS_TEST_HOOKS_DIR" "$sdir"
  assert_success

  [[ ! -f "$sdir/.agent-pid-11111.tmp.old" ]]
  [[ -f "$sdir/.agent-pid-22222.tmp.fresh" ]]
}

@test "reap: rate-limited to once per hour via the marker file — a second call in the same window is a no-op" {
  local sdir="$BATS_TEST_TMPDIR/sessions"
  mkdir -p "$sdir"
  _bats_write_agent_pid_json "$sdir/agent-pid-31111.json" 31111
  _bats_backdate "$sdir/agent-pid-31111.json" 10

  run bash -c '
    set -euo pipefail
    source "$1/lib/parse-input.sh"
    _reap_stale_agent_pid_records "$2"
  ' _ "$CAWS_TEST_HOOKS_DIR" "$sdir"
  assert_success
  [[ ! -f "$sdir/agent-pid-31111.json" ]]
  [[ -f "$sdir/.agent-pid-reap-marker" ]]

  # Second seed, past the hard cutoff too — but the marker is fresh (just
  # written), so this call must be a rate-limited no-op and leave it alone.
  _bats_write_agent_pid_json "$sdir/agent-pid-32222.json" 32222
  _bats_backdate "$sdir/agent-pid-32222.json" 10

  run bash -c '
    set -euo pipefail
    source "$1/lib/parse-input.sh"
    _reap_stale_agent_pid_records "$2"
  ' _ "$CAWS_TEST_HOOKS_DIR" "$sdir"
  assert_success
  [[ -f "$sdir/agent-pid-32222.json" ]]
}

