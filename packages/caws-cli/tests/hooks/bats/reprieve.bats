#!/usr/bin/env bats
# reprieve.sh — session-scoped guard reprieve dispatch behavior
# (CAWS-GUARD-REPRIEVE-SESSION-SCOPED-001).
#
# Drives the installed PreToolUse DISPATCHER (not a single guard) so the
# reprieve skip in run-handlers.sh is exercised end-to-end. The reprieve state
# file is written directly (mirroring the shape `caws reprieve grant` produces)
# rather than via the CLI, so the bats suite depends only on the hook pack, not
# on dist being current. A1–A5 pin: skip-on-match, foreign-session block,
# expiry-clears, missing-lib no-op, and the skip-log observability signal.

load helpers

setup_file() {
  caws_install_pack_once
}

teardown_file() {
  caws_teardown_pack
}

# Write a reprieve state file for a session, mirroring `caws reprieve grant`'s
# JSON shape + the shared sanitize_session filename transform. $1 = session id,
# $2 = expires_at (ISO), $3 = handlers (comma-sep). The file lands at
# ${CAWS_VENDOR_DIR}/hooks/state/guard-reprieve-<sanitized>.json — the same path
# lib/reprieve.sh's caws_reprieve_file computes.
write_reprieve() {
  local sid="$1" expires="$2" handlers_csv="$3"
  local state_dir="$CAWS_TEST_REPO/.claude/hooks/state"
  mkdir -p "$state_dir"
  # sanitize_session: everything outside [A-Za-z0-9._-] → _
  local safe_sid
  safe_sid="$(printf '%s' "$sid" | tr -c 'A-Za-z0-9._-' '_')"
  # Build the handlers JSON array from the comma-separated list.
  local handlers_json
  handlers_json="$(printf '%s' "$handlers_csv" | python3 -c '
import json, sys
print(json.dumps([h.strip() for h in sys.stdin.read().split(",") if h.strip()]))
')"
  cat >"$state_dir/guard-reprieve-$safe_sid.json" <<JSON
{
  "session_id": "$sid",
  "created_at": "2026-07-15T00:00:00Z",
  "expires_at": "$expires",
  "approved_by": "bats-test",
  "reason": "bats reprieve test",
  "handlers": $handlers_json
}
JSON
}

# Drive the installed PreToolUse dispatcher with a Write into the vendor hooks
# dir (the path protected-paths.sh blocks) + a given session id in the payload.
# $1 = session id. Sets bats $status / $output / $lines.
#
# The target file is a hook script under the INSTALLED pack's vendor hooks dir
# ($CAWS_TEST_REPO/.claude/hooks/...). protected-paths.sh blocks edits there;
# scope-guard admits it because it is inside the repo. We point at the vendor
# hooks dir (not .caws/hooks) because that is where CAWS_VENDOR_DIR=.claude
# resolves and where the reprieve state file also lives.
run_pretooluse_with_session() {
  local sid="$1"
  # Target a hook SCRIPT under the vendor hooks dir (.claude/hooks/). protected-
  # paths.sh matches this path (it is under CAWS_VENDOR_DIR=.claude/hooks/ and is
  # a *.sh — not a *.md doc), so the guard would block the edit absent a
  # reprieve. scope-guard admits it (inside the repo). The file need not exist
  # for the guard to evaluate the path.
  local target="$CAWS_TEST_REPO/.claude/hooks/a-guarded-handler.sh"
  # Write the envelope to a temp file to avoid nested-quoting issues inside
  # bats' `run` + bash -c (the JSON contains quotes that break inline printf).
  local env_file
  env_file="$(mktemp)"
  jq -nc --arg sid "$sid" --arg fp "$target" '{
    tool_name: "Write",
    tool_input: { file_path: $fp },
    session_id: $sid
  }' >"$env_file"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    bash "$CAWS_TEST_HOOKS_DIR/dispatch/pre_tool_use.sh" <"$env_file"
  rm -f "$env_file"
}

# ─── A1: a reprieved session skips protected-paths.sh ──────────────────────

# ─── A1: a reprieved session skips protected-paths.sh ──────────────────────
#
# A1 asserts the reprieve CONSULT directly (caws_is_handler_reprieved against
# the installed lib) rather than the full dispatcher, because the dispatcher's
# HANDLERS chain runs scope-guard (a non-reprieved guard) BEFORE protected-paths,
# and scope-guard's repo-boundary check refuses a synthetic cross-repo path
# before protected-paths is reached. The consult is the unit the reprieve
# governs; the dispatcher integration is covered by A2/A3/A5/A7 (which assert
# the guard's BLOCKED message appears / is absent through the real dispatch).

@test "A1 — reprieved session: caws_is_handler_reprieved admits the named handler" {
  write_reprieve "sess-a1-001" "2099-01-01T00:00:00Z" "protected-paths.sh"
  # Call the consult directly against the installed lib. Bats' `run` captures
  # stdout+stderr into $output; we export the env the lib needs (project + vendor
  # dir) and source caws-state.sh (for sanitize_session) + reprieve.sh.
  local result
  result="$(CAWS_PROJECT_DIR="$CAWS_TEST_REPO" CAWS_VENDOR_DIR=.claude \
    HOOKS_DIR="$CAWS_TEST_HOOKS_DIR" bash -c '
      source "$HOOKS_DIR/lib/caws-state.sh" 2>/dev/null || true
      source "$HOOKS_DIR/lib/reprieve.sh"
      if caws_is_handler_reprieved protected-paths.sh sess-a1-001; then
        echo "REPRIEVED expires=$CAWS_REPRIEVE_EXPIRES_AT reason=$CAWS_REPRIEVE_REASON"
      else
        echo "NOT-REPRIEVED"
      fi
  ' 2>&1)"
  echo "result=$result" >&3
  grep -Fq "REPRIEVED expires=2099-01-01T00:00:00Z" <<<"$result"
}

# A1-integration: the dispatcher actually emits the [reprieve] skip log when
# the reprieve names the handler. To isolate the skip from scope-guard's
# repo-boundary block (which runs earlier and refuses a synthetic cross-repo
# path before protected-paths is reached), this reprieve names BOTH
# scope-guard.sh and protected-paths.sh — so neither guard blocks, and the
# [reprieve] skip lines for both appear in the dispatch output.
@test "A1-integration — dispatcher emits [reprieve] skip logs for reprieved handlers" {
  write_reprieve "sess-a1-int" "2099-01-01T00:00:00Z" "scope-guard.sh,protected-paths.sh"
  run_pretooluse_with_session "sess-a1-int"
  grep -Fq "[reprieve] scope-guard.sh skipped for session sess-a1-int" <<<"$output"
  grep -Fq "[reprieve] protected-paths.sh skipped for session sess-a1-int" <<<"$output"
}

# ─── A2: a foreign session is NOT reprieved (partition holds) ──────────────

@test "A2 — foreign session: protected-paths.sh RUNS and the edit is refused" {
  # Grant a reprieve to sess-a2-owned, but run as sess-a2-foreign.
  write_reprieve "sess-a2-owned" "2099-01-01T00:00:00Z" "protected-paths.sh"
  run_pretooluse_with_session "sess-a2-foreign"
  # protected-paths.sh ran and refused the hook-script edit (exit 1, warning —
  # not a hard block, but the guard's "BLOCKED" message must appear). Critically
  # there is NO [reprieve] skip line for the foreign session.
  grep -Fq "BLOCKED" <<<"$output"
  ! grep -Fq "[reprieve] protected-paths.sh skipped for session sess-a2-foreign" <<<"$output"
}

# ─── A3: an expired reprieve is treated as absent ──────────────────────────

@test "A3 — expired reprieve: protected-paths.sh RUNS (expiry derived on read)" {
  write_reprieve "sess-a3-001" "2020-01-01T00:00:00Z" "protected-paths.sh"
  run_pretooluse_with_session "sess-a3-001"
  # The expired reprieve did not skip the guard: the BLOCKED message appears,
  # and no [reprieve] skip line was emitted.
  grep -Fq "BLOCKED" <<<"$output"
  ! grep -Fq "[reprieve] protected-paths.sh skipped" <<<"$output"
}

# ─── A7: the default (no reprieve file) is today's behavior ────────────────

@test "A7 — no reprieve file: protected-paths.sh runs normally (no skip log)" {
  run_pretooluse_with_session "sess-a7-noreprieve"
  grep -Fq "BLOCKED" <<<"$output"
  ! grep -Fq "[reprieve]" <<<"$output"
}

# ─── A5: a missing reprieve lib degrades safely (no-op, no crash) ──────────

@test "A5 — missing lib/reprieve.sh: dispatcher does not crash; guards run normally" {
  # Use the missing-lib harness: a copy of the hooks dir with reprieve.sh
  # removed. Even with a reprieve file in place, the guard must run (the check
  # is guarded by declare -F and is a no-op when the lib is absent).
  write_reprieve "sess-a5-001" "2099-01-01T00:00:00Z" "protected-paths.sh"
  local broken_repo broken_hooks envelope
  broken_repo="$(mktemp -d "${TMPDIR:-/tmp}/caws-bats-reprieve-broken-XXXXXX")"
  cp -R "$CAWS_TEST_REPO/.caws" "$broken_repo/.caws"
  cp -R "$CAWS_TEST_REPO/.claude" "$broken_repo/.claude"
  broken_hooks="$broken_repo/.caws/hooks"
  rm -f "$broken_hooks/lib/reprieve.sh"
  local env_file
  env_file="$(mktemp)"
  jq -nc --arg fp "$broken_repo/.claude/hooks/a-guarded-handler.sh" '{
    tool_name: "Write",
    tool_input: { file_path: $fp },
    session_id: "sess-a5-001"
  }' >"$env_file"
  run env \
    CAWS_PROJECT_DIR="$broken_repo" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$broken_repo" \
    bash "$broken_hooks/dispatch/pre_tool_use.sh" <"$env_file"
  rm -f "$env_file"
  rm -rf "$broken_repo"
  # The guard ran (BLOCKED appears); the missing reprieve lib did not crash the
  # dispatcher and did not skip the guard.
  grep -Fq "BLOCKED" <<<"$output"
  ! grep -Fq "[reprieve]" <<<"$output"
}
