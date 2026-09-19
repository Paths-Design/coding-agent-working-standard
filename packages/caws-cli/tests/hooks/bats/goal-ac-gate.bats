#!/usr/bin/env bats
# CAWS-GOAL-AC-STOP-GATE-01 — behavioral tests for the acceptance stop gate.
#
# The gate is the AUTHORITY half of the goal design: it EXECUTES
# `caws specs verify-acs --json` and reads the real verdicts, rather than
# reading a rendering of a check in a transcript. These tests pin that it
# blocks on unproven acceptance, stays inert without a binding, fails LOUD
# rather than silently passing, and can never trap a session.
#
# `caws` is stubbed per test via CAWS_BIN so each verdict shape is exercised
# deterministically without standing up a real spec + evidence chain.
#
# ASSERTIONS USE bats-assert, NEVER BARE `[[ ]]`. This harness fails a test
# only on its LAST command, so a bare intermediate `[[ ]]` is silently vacuous:
# an earlier version of this file passed 13/14 under a mutant that disabled the
# gate entirely, because every failing assertion sat above the last line.
# assert_output/refute_output abort at the failing assertion itself.

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
  # The block budget lives in a sidecar, not in the binding: the counter must
  # survive a binding the gate cannot parse, and must be maintainable without
  # python3 so that bounding still holds when the interpreter is what failed.
  COUNTER="$GOAL_SESSION_DIR/goal-blocks"
  rm -f "$BINDING" "$COUNTER"
  STUB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/caws-goal-stub-XXXXXX")"
}

teardown() {
  rm -rf "$STUB_DIR"
  rm -f "$BINDING" "$COUNTER"
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

# Optional $1 overrides the consecutive-block budget.
run_gate() {
  _run_target "$CAWS_TEST_HOOKS_DIR/goal-ac-gate.sh" "${1:-3}" "$PATH"
}

# Same, but through the REAL Stop dispatcher rather than the handler directly.
# A block that the handler emits but run_handlers does not forward is a block
# that never reaches Claude Code, so the handler-level tests alone cannot show
# the gate works end to end.
run_gate_via_dispatcher() {
  _run_target "$CAWS_TEST_HOOKS_DIR/dispatch/stop.sh" "${1:-3}" "${2:-$PATH}"
}

# Same, but with a caller-supplied PATH (used to remove or shadow python3).
run_gate_with_path() {
  _run_target "$CAWS_TEST_HOOKS_DIR/goal-ac-gate.sh" "${2:-3}" "$1"
}

_run_target() {
  local target="$1" budget="$2" path="$3"
  run env CLAUDE_CODE_SESSION_ID="$CAWS_TEST_SESSION_ID" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    CAWS_BIN="$STUB_DIR/caws" \
    PATH="$path" \
    CAWS_GOAL_MAX_CONSECUTIVE_BLOCKS="$budget" \
    bash -c "printf '%s' '{\"session_id\":\"$CAWS_TEST_SESSION_ID\"}' | bash '$target'"
}

# A PATH identical to the current one except that nothing named python3* is
# reachable. Mirroring real PATH entries (rather than hand-listing the few
# binaries the gate needs) keeps the fixture honest: the gate and the libs it
# sources still find everything else they actually use, so a block here is
# attributable to the missing interpreter and not to a starved PATH.
make_python3_free_path() { _make_path_without 'python3*' nopy; }
make_jq_free_path() { _make_path_without 'jq' nojq; }

_make_path_without() {
  local exclude="$1" mirror entry bin base
  mirror="$STUB_DIR/$2"
  mkdir -p "$mirror"
  while IFS= read -r entry; do
    [[ -d "$entry" ]] || continue
    for bin in "$entry"/*; do
      [[ -e "$bin" ]] || continue
      base="$(basename "$bin")"
      # shellcheck disable=SC2254
      case "$base" in $exclude) continue ;; esac
      [[ -e "$mirror/$base" ]] || ln -s "$bin" "$mirror/$base" 2>/dev/null
    done
  done < <(printf '%s' "$PATH" | tr ':' '\n')
  printf '%s' "$mirror"
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
  assert_success
  refute_output
}

# --- A1: unmet acceptance blocks the stop and names what is unmet. ---

@test "A1: an unmet criterion blocks the stop and names its id and verdict" {
  write_binding
  make_caws_stub "$(report_unmet)" 0
  run_gate
  assert_success
  assert_output --partial '"decision":"block"'
  assert_output --partial 'A2=not_rederived'
  assert_output --partial 'no_evidence'
  refute_output --partial 'A1=verified'
}

@test "A1: not_rederived is treated as unmet, never as a pass" {
  write_binding
  make_caws_stub '{"schema":"verify-acs.v1","criteria":[{"id":"A1","verdict":"not_rederived","reason":"narrative_only"}]}' 0
  run_gate
  assert_output --partial '"decision":"block"'
  assert_output --partial 'A1=not_rederived'
}

@test "A1: a refuted criterion blocks" {
  write_binding
  make_caws_stub '{"schema":"verify-acs.v1","criteria":[{"id":"A1","verdict":"refuted","reason":"commit_missing"}]}' 1
  run_gate
  assert_output --partial '"decision":"block"'
  assert_output --partial 'A1=refuted'
}

@test "A1: the block reason routes to the evidence writer and the escape" {
  write_binding
  make_caws_stub "$(report_unmet)" 0
  run_gate
  assert_output --partial 'caws specs evidence'
  assert_output --partial 'caws goal clear'
}

# --- A2: fully verified acceptance releases the stop silently. ---

@test "A2: every criterion verified emits no control decision and exits 0" {
  write_binding
  make_caws_stub "$(report_all_verified)" 0
  run_gate
  assert_success
  refute_output
}

@test "A2: a met goal resets the consecutive-block counter" {
  write_binding
  make_caws_stub "$(report_unmet)" 0
  run_gate
  assert_output --partial '"decision":"block"'
  make_caws_stub "$(report_all_verified)" 0
  run_gate
  refute_output
  # A met goal must clear the budget, not merely stop spending it: a later
  # regression has to get a full budget of blocks, not the remainder of an old
  # one.
  run test -e "$COUNTER"
  assert_failure
}

# --- A4: an unreadable gate must fail LOUD, never pass the stop silently. ---

@test "A4: verify-acs producing no report blocks and names the failure plus the escape" {
  write_binding
  make_caws_stub '' 1
  run_gate
  assert_output --partial '"decision":"block"'
  assert_output --partial 'produced no report'
  assert_output --partial 'caws goal clear'
}

@test "A4: a malformed verify-acs report blocks rather than passing" {
  write_binding
  make_caws_stub 'not json at all' 0
  run_gate
  assert_output --partial '"decision":"block"'
  assert_output --partial 'PARSE_ERROR'
  assert_output --partial 'caws goal clear'
}

@test "A4: a report declaring no criteria blocks rather than passing vacuously" {
  write_binding
  make_caws_stub '{"schema":"verify-acs.v1","criteria":[]}' 0
  run_gate
  assert_output --partial '"decision":"block"'
  assert_output --partial 'NO_CRITERIA'
}

@test "A4: a binding naming no spec_id blocks and says how to re-set it" {
  printf '{}' > "$BINDING"
  make_caws_stub "$(report_unmet)" 0
  run_gate
  assert_output --partial '"decision":"block"'
  assert_output --partial 'caws goal set'
  assert_output --partial 'caws goal clear'
}

# --- A5: bounded. A goal can never trap a session. ---

@test "A5: after the block budget is exhausted the gate releases the stop with a warning" {
  write_binding
  make_caws_stub "$(report_unmet)" 0
  run_gate
  assert_output --partial '"decision":"block"'
  run_gate
  assert_output --partial '"decision":"block"'
  run_gate
  assert_output --partial '"decision":"block"'
  run_gate
  assert_success
  refute_output --partial '"decision":"block"'
  assert_output --partial 'still blocking after 3 consecutive stops'
  assert_output --partial 'A2=not_rederived'
}

@test "A5: the block counter reports its position so the agent can see the budget" {
  write_binding
  make_caws_stub "$(report_unmet)" 0
  run_gate
  assert_output --partial 'Block 1 of 3'
  run_gate
  assert_output --partial 'Block 2 of 3'
}

@test "A5: a CHANGED unmet set resets the budget so real progress is never punished" {
  write_binding
  make_caws_stub "$(report_unmet)" 0
  run_gate
  run_gate
  run_gate
  run cat "$COUNTER"
  assert_output --partial '3'
  make_caws_stub '{"schema":"verify-acs.v1","criteria":[{"id":"A9","verdict":"not_rederived","reason":"no_evidence"}]}' 0
  run_gate
  assert_output --partial '"decision":"block"'
  assert_output --partial 'Block 1 of 3'
}

@test "A5: the budget is overridable for repos that want a different bound" {
  write_binding
  make_caws_stub "$(report_unmet)" 0
  run_gate 1
  assert_output --partial 'Block 1 of 1'
  run_gate 1
  assert_success
  refute_output --partial '"decision":"block"'
  assert_output --partial 'still blocking after 1 consecutive stops'
}

# --- Fail-closed paths: the gate must not release the stop through its own
# --- error handling. Each of these was a fail-OPEN path found in review.

@test "a non-numeric block budget falls back to the default and keeps blocking" {
  write_binding
  make_caws_stub "$(report_unmet)" 0
  # `(( COUNT > $notanumber ))` under `set -u` does not evaluate false — bash
  # resolves the bare word as an unset variable name and a non-interactive
  # shell EXITS, killing the handler before it can emit. That would let a typo
  # in one env var silently disable the gate.
  run_gate 'three'
  assert_output --partial '"decision":"block"'
  assert_output --partial 'Block 1 of 3'
  assert_output --partial 'not a positive integer'
  assert_output --partial 'stays ACTIVE'
}

@test "a zero block budget is refused rather than disabling the gate" {
  write_binding
  make_caws_stub "$(report_unmet)" 0
  run_gate 0
  assert_output --partial '"decision":"block"'
  assert_output --partial 'Block 1 of 3'
}

@test "a present-but-broken python3 still blocks instead of releasing the stop" {
  write_binding
  make_caws_stub "$(report_unmet)" 0
  # Not hypothetical: a broken venv, a missing stdlib or a wrong-arch shim all
  # produce an interpreter that resolves on PATH and then fails. If the block
  # emitter itself depended on python3, this case would print nothing at all
  # and the stop would be released — a guard failing open through its own
  # error path.
  printf '#!/bin/bash\nexit 1\n' > "$STUB_DIR/python3"
  chmod +x "$STUB_DIR/python3"
  run_gate_with_path "$STUB_DIR:$PATH"
  assert_output --partial '"decision":"block"'
  refute_output --partial '"decision": "block"'
}

@test "a missing python3 blocks rather than silently not enforcing the goal" {
  write_binding
  make_caws_stub "$(report_unmet)" 0
  local nopy
  nopy="$(make_python3_free_path)"
  run_gate_with_path "$nopy"
  assert_output --partial '"decision":"block"'
  assert_output --partial 'python3 was not found'
  assert_output --partial 'Not evaluating is not the same as passing'
}

@test "a missing python3 is still BOUNDED and releases after the budget" {
  write_binding
  make_caws_stub "$(report_unmet)" 0
  local nopy
  nopy="$(make_python3_free_path)"
  # Fail-closed is only safe if it is also bounded. The counter is pure bash
  # for exactly this case: the thing that broke must not be the thing the
  # escape depends on.
  run_gate_with_path "$nopy" 1
  assert_output --partial '"decision":"block"'
  run_gate_with_path "$nopy" 1
  assert_success
  refute_output --partial '"decision":"block"'
  assert_output --partial 'still blocking after 1 consecutive stops'
}

@test "a persistent gate FAILURE is bounded, not just a persistent unmet set" {
  write_binding
  # A gate failure (verify-acs produces nothing) blocks — but an unbounded
  # refusal on a broken gate would strand the session with no in-band exit,
  # which is the same trap A5 forbids for unmet criteria.
  make_caws_stub '' 1
  run_gate 1
  assert_output --partial '"decision":"block"'
  assert_output --partial 'produced no report'
  run_gate 1
  assert_success
  refute_output --partial '"decision":"block"'
  assert_output --partial 'still blocking after 1 consecutive stops'
}

@test "an unreadable binding blocks bounded and does not spend the unmet budget" {
  printf 'not json' > "$BINDING"
  make_caws_stub "$(report_unmet)" 0
  run_gate 2
  assert_output --partial 'caws goal set'
  assert_output --partial 'Block 1 of 2'
  run_gate 2
  assert_output --partial 'Block 2 of 2'
  run_gate 2
  refute_output --partial '"decision":"block"'
}

# --- End to end: the decision must survive the real dispatcher. ---

@test "E2E: the block reaches stdout through the real Stop dispatcher" {
  write_binding
  make_caws_stub "$(report_unmet)" 0
  # run_handlers forwards at most one control decision, choosing by priority
  # across every handler in the chain. The handler-level tests cannot show that
  # the gate's block wins that selection rather than being overwritten by a
  # finalizer's advisory output.
  run_gate_via_dispatcher
  assert_output --partial '"decision":"block"'
  assert_output --partial 'A2=not_rederived'
}

@test "E2E: a met goal leaves the Stop dispatcher emitting no control decision" {
  write_binding
  make_caws_stub "$(report_all_verified)" 0
  run_gate_via_dispatcher
  refute_output --partial '"decision":"block"'
}

@test "E2E: the block survives the dispatcher on a host without jq" {
  write_binding
  make_caws_stub "$(report_unmet)" 0
  # run_handlers ranks each handler's stdout with `jq -r '.decision ...'` to
  # decide which control decision to forward. jq is not a declared dependency
  # of the pack, so this pins what happens to a refusal when the ranker cannot
  # read it: the gate's block must still reach the harness, because a guard
  # that silently degrades to "no decision" on a thin host is a guard that is
  # not enforcing anything there.
  local nojq
  nojq="$(make_jq_free_path)"
  run_gate_via_dispatcher 3 "$nojq"
  assert_output --partial '"decision":"block"'
  assert_output --partial 'A2=not_rederived'
}

@test "E2E: with no binding the Stop dispatcher is unchanged by this feature" {
  make_caws_stub "$(report_unmet)" 0
  run_gate_via_dispatcher
  refute_output --partial '"decision":"block"'
  refute_output --partial 'goal-ac-gate'
}
