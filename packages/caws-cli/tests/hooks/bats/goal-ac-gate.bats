#!/usr/bin/env bats
# CAWS-GOAL-AC-STOP-GATE-01 — behavioral tests for the acceptance stop gate.
#
# The gate is the AUTHORITY half of the goal design: it executes
# `caws specs verify-acs --json` and reads the real verdicts, rather than
# reading a rendering of a check in a transcript. These tests pin that it
# blocks on unproven acceptance, stays inert without a binding, fails LOUD
# rather than silently passing, and can never trap a session.
#
# `caws` is stubbed per test via CAWS_BIN so each verdict shape is exercised
# deterministically without standing up a real spec + evidence chain.

load helpers

setup_file() {
  caws_install_pack_once
}

teardown_file() {
  caws_teardown_pack
}

setup() {
  GOAL_SESSION_DIR="$CAWS_TEST_REPO/.caws/sessions/$CAWS_TEST_SESSION_ID"
  mkdir -p "$GOAL_SESSION_DIR"
  BINDING="$GOAL_SESSION_DIR/goal.json"
  rm -f "$BINDING"
  STUB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/caws-goal-stub-XXXXXX")"
}

teardown() {
  rm -rf "$STUB_DIR"
  rm -f "$BINDING"
}

# Write a fake `caws` whose `specs verify-acs ... --json` prints $1 and exits $2.
make_caws_stub() {
  local payload="$1" code="${2:-0}"
  printf '%s' "$payload" > "$STUB_DIR/payload.json"
  cat > "$STUB_DIR/caws" <<STUB
#!/bin/bash
cat "$STUB_DIR/payload.json"
exit $code
STUB
  chmod +x "$STUB_DIR/caws"
}

write_binding() {
  printf '{"spec_id":"%s"}' "${1:-SPEC-UNDER-TEST-01}" > "$BINDING"
}

run_gate() {
  run env CLAUDE_CODE_SESSION_ID="$CAWS_TEST_SESSION_ID" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    CAWS_BIN="$STUB_DIR/caws" \
    PATH="$STUB_DIR:$PATH" \
    bash -c "printf '%s' '{\"session_id\":\"$CAWS_TEST_SESSION_ID\"}' | bash '$CAWS_TEST_HOOKS_DIR/goal-ac-gate.sh'"
}

report_unmet() {
  printf '{"schema":"verify-acs.v1","id":"SPEC-UNDER-TEST-01","criteria":[{"id":"A1","verdict":"verified"},{"id":"A2","verdict":"not_rederived","reason":"no_evidence"}]}'
}

report_all_verified() {
  printf '{"schema":"verify-acs.v1","id":"SPEC-UNDER-TEST-01","criteria":[{"id":"A1","verdict":"verified"},{"id":"A2","verdict":"verified"}]}'
}

# --- A3: opt-in. No binding must leave the stop chain exactly as it was. ---

@test "A3: with no goal binding the gate is inert (exit 0, no stdout)" {
  make_caws_stub "$(report_unmet)" 0
  run_gate
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

# --- A1: unmet acceptance blocks the stop and names what is unmet. ---

@test "A1: an unmet criterion blocks the stop and names the criterion id and verdict" {
  write_binding
  make_caws_stub "$(report_unmet)" 0
  run_gate
  [ "$status" -eq 0 ]
  # It is a hard control decision, not advisory context.
  [[ "$output" == *'"decision":"block"'* ]]
  # The reason must name the specific unmet criterion and its verdict verbatim,
  # so the agent learns WHICH bar is unproven, not merely that one is.
  [[ "$output" == *'A2=not_rederived'* ]]
  [[ "$output" == *'no_evidence'* ]]
  # A criterion that IS verified must not be reported as unmet.
  [[ "$output" != *'A1=verified'* ]]
}

@test "A1: not_rederived is treated as unmet, never as a pass" {
  write_binding
  make_caws_stub '{"schema":"verify-acs.v1","criteria":[{"id":"A1","verdict":"not_rederived","reason":"narrative_only"}]}' 0
  run_gate
  [[ "$output" == *'"decision":"block"'* ]]
  [[ "$output" == *'A1=not_rederived'* ]]
}

@test "A1: a refuted criterion blocks" {
  write_binding
  make_caws_stub '{"schema":"verify-acs.v1","criteria":[{"id":"A1","verdict":"refuted","reason":"commit_missing"}]}' 1
  run_gate
  [[ "$output" == *'"decision":"block"'* ]]
  [[ "$output" == *'A1=refuted'* ]]
}

# --- A2: fully verified acceptance releases the stop silently. ---

@test "A2: every criterion verified emits no control decision and exits 0" {
  write_binding
  make_caws_stub "$(report_all_verified)" 0
  run_gate
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "A2: a met goal resets the consecutive-block counter" {
  write_binding
  make_caws_stub "$(report_unmet)" 0
  run_gate
  [[ "$output" == *'"decision":"block"'* ]]
  make_caws_stub "$(report_all_verified)" 0
  run_gate
  grep -q '"consecutive_blocks": 0' "$BINDING"
}

# --- A4: an unreadable gate must fail LOUD, never pass the stop silently. ---

@test "A4: verify-acs producing no report blocks and names the failure plus the escape" {
  write_binding
  make_caws_stub '' 1
  run_gate
  [[ "$output" == *'"decision":"block"'* ]]
  [[ "$output" == *'produced no report'* ]]
  [[ "$output" == *'caws goal clear'* ]]
}

@test "A4: a malformed verify-acs report blocks rather than passing" {
  write_binding
  make_caws_stub 'not json at all' 0
  run_gate
  [[ "$output" == *'"decision":"block"'* ]]
  [[ "$output" == *'PARSE_ERROR'* ]]
  [[ "$output" == *'caws goal clear'* ]]
}

@test "A4: a report declaring no criteria blocks rather than passing vacuously" {
  write_binding
  make_caws_stub '{"schema":"verify-acs.v1","criteria":[]}' 0
  run_gate
  [[ "$output" == *'"decision":"block"'* ]]
  [[ "$output" == *'NO_CRITERIA'* ]]
}

@test "A4: a binding naming no spec_id blocks and says how to re-set it" {
  printf '{}' > "$BINDING"
  make_caws_stub "$(report_unmet)" 0
  run_gate
  [[ "$output" == *'"decision":"block"'* ]]
  [[ "$output" == *'caws goal set'* ]]
  [[ "$output" == *'caws goal clear'* ]]
}

# --- A5: bounded. A goal can never trap a session. ---

@test "A5: after the block budget is exhausted the gate releases the stop with a warning" {
  write_binding
  make_caws_stub "$(report_unmet)" 0
  # Budget is 3 by default: blocks 1..3 block, the 4th releases.
  run_gate; [[ "$output" == *'"decision":"block"'* ]]
  run_gate; [[ "$output" == *'"decision":"block"'* ]]
  run_gate; [[ "$output" == *'"decision":"block"'* ]]
  run_gate
  [ "$status" -eq 0 ]
  [[ "$output" != *'"decision":"block"'* ]]
  # It must still say loudly that the bar was never met.
  [[ "$output" == *'still UNMET'* ]]
  [[ "$output" == *'A2=not_rederived'* ]]
}

@test "A5: the block counter reports its position so the agent can see the budget" {
  write_binding
  make_caws_stub "$(report_unmet)" 0
  run_gate
  [[ "$output" == *'Block 1 of 3'* ]]
  run_gate
  [[ "$output" == *'Block 2 of 3'* ]]
}

@test "A5: a CHANGED unmet set resets the budget so real progress is never punished" {
  write_binding
  make_caws_stub "$(report_unmet)" 0
  run_gate; run_gate; run_gate
  # Third block exhausts nothing yet, but the counter is at 3.
  grep -q '"consecutive_blocks": 3' "$BINDING"
  # Now a DIFFERENT criterion is unmet -> evidence moved -> budget restarts.
  make_caws_stub '{"schema":"verify-acs.v1","criteria":[{"id":"A9","verdict":"not_rederived","reason":"no_evidence"}]}' 0
  run_gate
  [[ "$output" == *'"decision":"block"'* ]]
  [[ "$output" == *'Block 1 of 3'* ]]
}

@test "A5: the budget is overridable for repos that want a different bound" {
  write_binding
  make_caws_stub "$(report_unmet)" 0
  run env CLAUDE_CODE_SESSION_ID="$CAWS_TEST_SESSION_ID" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    CAWS_BIN="$STUB_DIR/caws" \
    CAWS_GOAL_MAX_CONSECUTIVE_BLOCKS=1 \
    bash -c "printf '%s' '{\"session_id\":\"$CAWS_TEST_SESSION_ID\"}' | bash '$CAWS_TEST_HOOKS_DIR/goal-ac-gate.sh'"
  [[ "$output" == *'Block 1 of 1'* ]]
}
