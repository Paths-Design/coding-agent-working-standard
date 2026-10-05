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

# Self-provisioned anchor (CAWS-TEST-SUITE-REPAIR-001): the agent-PID tier is
# an identity trust anchor, so its tests must run to an assertion on EVERY
# runner. The earlier design resolved an ambient ancestor (zsh by default)
# and SKIPPED when the host shell had none — which is exactly the CI
# condition, so the PID-correlation tier shipped with zero CI coverage. Now
# each anchor-dependent test spawns a sacrificial python3 "agent process"
# (the same technique block-dangerous.bats uses for the verified-kill path):
# the wrapper plants the agent-PID record for ITS OWN pid (real start time
# from ps) and runs the resolver as its direct descendant, so the ancestor
# walk always finds it. The match set carries both comm spellings: Homebrew's
# python3 runs as comm "Python", Linux distros report "python3"/"python3.11".
SACRIFICIAL_NAMES="python3 python3.11 Python"

# Resolve with a controlled env (no identity vars) so only the agent-PID /
# capsule tiers can fire. processNames selects the agent-ancestor match set.
resolve_under() {
  local caws_project_dir="$1"; shift
  local names="$1"; shift
  run env -i PATH="$PATH" HOME="$HOME" CAWS_PROJECT_DIR="$caws_project_dir" \
    CAWS_AGENT_PROCESS_NAMES="$names" \
    bash -c "source '$APID' >/dev/null 2>&1; source '$SID' >/dev/null 2>&1; printf '%s\n' \"\$(resolve_caws_session_id)\""
}

# Resolve as a descendant of a sacrificial python3 anchor that plants its own
# record first. Args: proj names session_id last_seen_at [surface]
# [KEY=VALUE extra env]. stdout/stderr are the resolver's own, merged by bats
# into $output — the ENV-SHADOWING warning rides the same capture as before.
resolve_as_sacrificial_agent() {
  local proj="$1" names="$2" record_sid="$3" seen_at="$4" surface="${5:-}" extra_kv="${6:-}"
  python3 - "$proj" "$names" "$record_sid" "$seen_at" "$surface" "$extra_kv" "$APID" "$SID" <<'PYEOF'
import json, os, subprocess, sys
proj, names, record_sid, seen_at, surface, extra_kv, apid, sidlib = sys.argv[1:9]
pid = os.getpid()
# Real start epoch of the live anchor process, via the same ps extraction the
# old fixtures used — the record's liveness proof must be genuine.
start = subprocess.run(
    ["bash", "-c",
     'ps -o lstart= -p "$1" 2>/dev/null | { read -r a b c d e; date -d "$a $b $c $d $e" +%s 2>/dev/null || date -jf "%a %b %d %T %Y" "$a $b $c $d $e" +%s 2>/dev/null || echo ""; }',
     "bash", str(pid)],
    capture_output=True, text=True).stdout.strip()
record = {"agent_pid": pid, "session_id": record_sid, "last_seen_at": seen_at}
if surface:
    record["surface"] = surface
record["started_at"] = int(start) if start else None
sessions = os.path.join(proj, ".caws", "sessions")
os.makedirs(sessions, exist_ok=True)
with open(os.path.join(sessions, "agent-pid-%d.json" % pid), "w") as fh:
    json.dump(record, fh)
# Controlled env, matching the old `env -i` shape: no identity vars except
# the ones this call deliberately supplies.
env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"),
       "HOME": os.environ.get("HOME", ""),
       "CAWS_PROJECT_DIR": proj,
       "CAWS_AGENT_PROCESS_NAMES": names}
if extra_kv:
    key, _, value = extra_kv.partition("=")
    env[key] = value
resolver = ('source "$1" >/dev/null 2>&1; source "$2" >/dev/null 2>&1; '
            "printf '%s\\n' \"$(resolve_caws_session_id)\"")
r = subprocess.run(["bash", "-c", resolver, "bash", apid, sidlib], env=env)
sys.exit(r.returncode)
PYEOF
}

@test "session-id: no env vars + a valid agent-PID record -> reads its session_id (A7-1)" {
  run resolve_as_sacrificial_agent "$CAWS_TEST_REPO" "$SACRIFICIAL_NAMES" \
    sess-via-agent-pid "$(date -u +%Y-%m-%dT%H:%M:%SZ)" zcode
  assert_success
  assert_output "sess-via-agent-pid"
}

@test "session-id: a stale-but-alive agent-PID record STILL resolves (A7-3, no freshness gate)" {
  # REFINEMENT (CAWS-AGENT-PID-SESSION-CORRELATION-001): this tier has NO
  # freshness window. A record is valid as long as its named PID is alive
  # (the walk reached it) and its start time matches — regardless of age.
  # Plant a record with an ancient last_seen_at but the anchor's REAL start
  # time; it must still resolve. This is the "leave and return after any
  # gap" case.
  run resolve_as_sacrificial_agent "$CAWS_TEST_REPO" "$SACRIFICIAL_NAMES" \
    sess-long-idle "2026-07-01T00:00:00Z"
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

@test "session-id: a live agent-PID record OUTRANKS env disagreement (PID anchor, ENV-SHADOWING-01)" {
  # CAWS_SESSION_ID disagrees with the LIVE record; the record is the
  # trust anchor, so it wins and a stderr warning names both ids.
  run resolve_as_sacrificial_agent "$CAWS_TEST_REPO" "$SACRIFICIAL_NAMES" \
    sess-via-pid "$(date -u +%Y-%m-%dT%H:%M:%SZ)" zcode "CAWS_SESSION_ID=env-wins"
  assert_success
  # The PID record wins AND the warning names both ids (stderr rides
  # the combined capture inside the command substitution).
  assert_output --partial 'sess-via-pid'
  assert_output --partial 'Warning: session identity disagreement'
  assert_output --partial 'env-wins'
}
