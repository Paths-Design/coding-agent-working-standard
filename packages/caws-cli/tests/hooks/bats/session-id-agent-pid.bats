#!/usr/bin/env bats
# lib/session-id.sh — agent-PID correlation tier
# (CAWS-AGENT-PID-SESSION-CORRELATION-001).
#
# The shell resolver gained a tier between the env chain and the capsule
# fallback: resolve_caws_session_id consults the agent-PID record keyed by the
# caller's own agent process PID. This is the canonical-checkout identity
# bridge for harnesses that export no session-id env var.
#
# The record is written by parse-input.sh's _write_agent_pid_record (every
# hook event) and read by read_session_id_from_agent_pid in lib/agent-pid.sh.
# These tests plant records and assert the resolver picks them up / fail-opens.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

SID="$CAWS_TEST_HOOKS_DIR/lib/session-id.sh"
APID="$CAWS_TEST_HOOKS_DIR/lib/agent-pid.sh"

# A stable ancestor name shared by every test subshell. Each `bash -c`
# subshell's tree converges on the parent shell (zsh here) at depth ~2, so a
# record planted for that PID is visible from any sibling subshell. 'zsh' is
# the interactive shell under which bats runs in this environment; the name is
# parameterized so the tests are not hardcoded to one host shell.
STABLE_ANCESTOR="${BATS_TEST_SHELL_ANCHOR:-zsh}"

# Print the PID of the stable ancestor (the common parent of all test
# subshells), or empty if not found. Computed by walking the tree.
stable_ancestor_pid() {
  env -i PATH="$PATH" bash -c "source '$APID' >/dev/null 2>&1; resolve_agent_pid '$STABLE_ANCESTOR'" 2>/dev/null || true
}

# Resolve with a controlled env (no identity vars) so only the agent-PID /
# capsule tiers can fire. processNames selects the agent-ancestor match set.
resolve_under() {
  local caws_project_dir="$1"; shift
  local names="$1"; shift
  run env -i PATH="$PATH" HOME="$HOME" CAWS_PROJECT_DIR="$caws_project_dir" \
    CAWS_AGENT_PROCESS_NAMES="$names" \
    bash -c "source '$APID' >/dev/null 2>&1; source '$SID' >/dev/null 2>&1; printf '%s\n' \"\$(resolve_caws_session_id)\""
}

@test "session-id: no env vars + a valid agent-PID record -> reads its session_id (A7-1)" {
  local anchor_pid
  anchor_pid="$(stable_ancestor_pid)"
  [[ -n "$anchor_pid" ]] || skip "no '$STABLE_ANCESTOR' ancestor found in this environment"

  local sess_dir="$CAWS_TEST_REPO/.caws/sessions"
  mkdir -p "$sess_dir"
  local now start_epoch
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  start_epoch=$(ps -o lstart= -p "$anchor_pid" 2>/dev/null | { read -r a b c d e; date -d "$a $b $c $d $e" +%s 2>/dev/null || date -jf '%a %b %d %T %Y' "$a $b $c $d $e" +%s 2>/dev/null || echo ""; } || echo "")
  printf '{"agent_pid":%s,"session_id":"sess-via-agent-pid","surface":"zcode","last_seen_at":"%s","started_at":%s}\n' \
    "$anchor_pid" "$now" "${start_epoch:-null}" > "$sess_dir/agent-pid-${anchor_pid}.json"

  resolve_under "$CAWS_TEST_REPO" "$STABLE_ANCESTOR"
  assert_success
  assert_output "sess-via-agent-pid"
}

@test "session-id: a stale-but-alive agent-PID record STILL resolves (A7-3, no freshness gate)" {
  # REFINEMENT (CAWS-AGENT-PID-SESSION-CORRELATION-001): this tier has NO
  # freshness window. A record is valid as long as its named PID is alive
  # (the walk reached it) and its start time matches — regardless of age.
  # Plant a record with an ancient last_seen_at but a MATCHING start time;
  # it must still resolve. This is the "leave and return after any gap" case.
  local anchor_pid
  anchor_pid="$(stable_ancestor_pid)"
  [[ -n "$anchor_pid" ]] || skip "no '$STABLE_ANCESTOR' ancestor found"

  local sess_dir="$CAWS_TEST_REPO/.caws/sessions"
  mkdir -p "$sess_dir"
  local start_epoch
  start_epoch=$(ps -o lstart= -p "$anchor_pid" 2>/dev/null | { read -r a b c d e; date -d "$a $b $c $d $e" +%s 2>/dev/null || date -jf '%a %b %d %T %Y' "$a $b $c $d $e" +%s 2>/dev/null || echo ""; } || echo "")
  # last_seen_at 10 days ago, but started_at matches the LIVE process.
  printf '{"agent_pid":%s,"session_id":"sess-long-idle","last_seen_at":"2026-07-01T00:00:00Z","started_at":%s}\n' \
    "$anchor_pid" "${start_epoch:-null}" > "$sess_dir/agent-pid-${anchor_pid}.json"

  resolve_under "$CAWS_TEST_REPO" "$STABLE_ANCESTOR"
  assert_success
  assert_output "sess-long-idle"
}

@test "session-id: empty process names (unknown surface) -> skips the tier (A7-5)" {
  # No CAWS_AGENT_PROCESS_NAMES -> the agent-PID tier is a no-op. Plant a
  # record anyway to prove it is NOT consulted when names is empty.
  local sess_dir="$CAWS_TEST_REPO/.caws/sessions"
  mkdir -p "$sess_dir"
  printf '{"agent_pid":1,"session_id":"sess-should-not-resolve","last_seen_at":"%s","started_at":null}\n' \
    "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" > "$sess_dir/agent-pid-1.json"

  resolve_under "$CAWS_TEST_REPO" ""
  assert_success
  assert_output "unknown"
}

@test "session-id: an env var wins over the agent-PID record (precedence)" {
  local anchor_pid
  anchor_pid="$(stable_ancestor_pid)"
  [[ -n "$anchor_pid" ]] || skip "no '$STABLE_ANCESTOR' ancestor found"

  local sess_dir="$CAWS_TEST_REPO/.caws/sessions"
  mkdir -p "$sess_dir"
  printf '{"agent_pid":%s,"session_id":"sess-via-pid","last_seen_at":"%s","started_at":null}\n' \
    "$anchor_pid" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" > "$sess_dir/agent-pid-${anchor_pid}.json"

  # CAWS_SESSION_ID is set -> it wins at tier 1.7, the agent-PID tier (2.4)
  # never fires.
  run env -i PATH="$PATH" HOME="$HOME" CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_PROCESS_NAMES="$STABLE_ANCESTOR" CAWS_SESSION_ID=env-wins \
    bash -c "source '$APID' >/dev/null 2>&1; source '$SID' >/dev/null 2>&1; printf '%s\n' \"\$(resolve_caws_session_id)\""
  assert_success
  assert_output "env-wins"
}
