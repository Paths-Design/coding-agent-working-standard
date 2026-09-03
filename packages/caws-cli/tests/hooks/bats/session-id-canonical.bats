#!/usr/bin/env bats
# lib/session-id.sh — canonical normalization + surface pinning + PID anchor
# (CAWS-DEFECT-SESSION-IDENTITY-ENV-SHADOWING-01).
#
# The defect, proven live: with both DSH_SESSION_ID and CLAUDE_SESSION_ID set,
# the claude var silently rewrote "self" for a dsh process. The resolver now
# (1) pins the dispatching surface's own var via CAWS_AGENT_SURFACE, (2) reads
# the canonical CAWS_SESSION_ID before the per-surface chain, and (3) treats
# the LIVE agent-PID record as the trust anchor that outranks env
# disagreement — with a loud stderr note naming both ids.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

SID="$CAWS_TEST_HOOKS_DIR/lib/session-id.sh"

resolve_env() {
  run env -i PATH="$PATH" HOME="$HOME" "$@" \
    bash -c "source '$SID' >/dev/null 2>&1; printf '%s\n' \"\$(resolve_caws_session_id)\""
}

@test "canonical: surface pin defeats a foreign shadow var (A1)" {
  resolve_env CAWS_AGENT_SURFACE=dsh DSH_SESSION_ID=dsh-true CLAUDE_SESSION_ID=claude-stray
  assert_success
  assert_output "dsh-true"
}

@test "canonical: pin without its var falls through to the operator override" {
  resolve_env CAWS_AGENT_SURFACE=dsh CLAUDE_SESSION_ID=op-override
  assert_success
  assert_output "op-override"
}

@test "canonical: CAWS_SESSION_ID is read before the per-surface chain" {
  resolve_env CAWS_SESSION_ID=canonical-id DSH_SESSION_ID=dsh-id CLAUDE_SESSION_ID=claude-id
  assert_success
  assert_output "canonical-id"
}

@test "canonical: caws_normalize_session_env exports the canonical var (direct call)" {
  run env -i PATH="$PATH" HOME="$HOME" DSH_SESSION_ID=dsh-9 \
    bash -c "source '$SID' >/dev/null 2>&1; caws_normalize_session_env >/dev/null; printf '%s\n' \"\${CAWS_SESSION_ID:-unset}\""
  assert_success
  assert_output "dsh-9"
}

@test "canonical: normalize refuses to canonicalize 'unknown' (no invented identity)" {
  run env -i PATH="$PATH" HOME="$HOME" \
    bash -c "source '$SID' >/dev/null 2>&1; caws_normalize_session_env >/dev/null; printf '%s\n' \"\${CAWS_SESSION_ID:-unset}\""
  assert_success
  assert_output "unset"
}

@test "canonical: env disagreement with a LIVE pid record -> record wins + stderr names both (A3)" {
  # Plant a live, start-time-guarded agent-PID record for this bash process
  # tree, then resolve with a CONFLICTING env var: the record must win and
  # the stderr warning must name both ids. Scratch output lives under the
  # test repo (never /tmp).
  run env -i PATH="$PATH" HOME="$HOME" CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_PROCESS_NAMES=bash DSH_SESSION_ID=env-says-id \
    bash -c '
      sid="'"$CAWS_TEST_HOOKS_DIR"'/lib/session-id.sh"
      apid="$(dirname "$sid")/agent-pid.sh"
      source "$apid" >/dev/null 2>&1 || true
      agent_pid="$(resolve_agent_pid bash)"
      [[ -n "$agent_pid" ]] || exit 77
      start_epoch=$(ps -o lstart= -p "$agent_pid" | { read -r a b c d e; date -d "$a $b $c $d $e" +%s 2>/dev/null || date -jf "%a %b %d %T %Y" "$a $b $c $d $e" +%s; })
      sess_dir="$CAWS_PROJECT_DIR/.caws/sessions"
      mkdir -p "$sess_dir"
      printf "{\"agent_pid\":%s,\"session_id\":\"pid-record-id\",\"surface\":\"dsh\",\"last_seen_at\":\"%s\",\"started_at\":%s}\n" \
        "$agent_pid" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$start_epoch" \
        > "$sess_dir/agent-pid-${agent_pid}.json"
      source "$sid" >/dev/null 2>&1
      out="$(resolve_caws_session_id 2>"$sess_dir/.si-warn")"
      warn="$(cat "$sess_dir/.si-warn" 2>/dev/null || true)"
      rm -f "$sess_dir/.si-warn" "$sess_dir/agent-pid-${agent_pid}.json"
      printf "ID:%s\nWARN:%s\n" "$out" "$warn"
    '
  assert_success
  # The PID record wins over the env var, and the warning names both ids.
  assert_output --regexp 'ID:pid-record-id'
  assert_output --regexp 'WARN:.*env-says-id.*pid-record-id'
}
