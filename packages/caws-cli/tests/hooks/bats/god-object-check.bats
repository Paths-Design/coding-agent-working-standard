#!/usr/bin/env bats
# god-object-check.sh — SLOC advisory with HYSTERESIS
# (CAWS-GOD-OBJECT-CHECK-HYSTERESIS-001).
#
# The advisory flags a file over CAWS_GOD_OBJECT_LOC, but must NOT re-warn on
# every small edit to an already-over file (noise trains the agent to ignore the
# one signal an advisory carries). For an Edit, it warns only when the edit is
# itself SIGNAL: it CROSSED the threshold, or added a LARGE delta. A small edit
# to an already-over file is silent. A Write of a whole over-threshold file still
# warns. The hook is always exit 0 (advisory, never a block).
#
# These tests use a small CAWS_GOD_OBJECT_LOC so fixtures stay tiny: threshold
# 10, large-delta threshold 5 (CAWS_GOD_OBJECT_DELTA). SLOC = non-blank,
# non-comment lines.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

# Write a file of exactly N source lines (each "lineK") into the test repo.
_make_file_with_sloc() {
  local rel="$1" n="$2" i
  local abs="$CAWS_TEST_REPO/$rel"
  : > "$abs"
  for ((i = 1; i <= n; i++)); do printf 'line%d\n' "$i" >> "$abs"; done
}

# Run god-object-check on an Edit of $rel with the given old/new strings. The
# file on disk is the POST-edit state (PostToolUse fires after the write); the
# old/new strings encode the delta the hook uses for hysteresis.
_run_edit() {
  local rel="$1" old_string="$2" new_string="$3" env_loc="${4:-10}" env_delta="${5:-5}"
  local abs="$CAWS_TEST_REPO/$rel"
  local envelope
  envelope="$(jq -nc --arg f "$abs" --arg o "$old_string" --arg n "$new_string" \
    '{tool_name:"Edit", tool_input:{file_path:$f, old_string:$o, new_string:$n}}')"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    CAWS_GOD_OBJECT_LOC="$env_loc" \
    CAWS_GOD_OBJECT_DELTA="$env_delta" \
    bash -c "printf '%s' '$envelope' | bash '$CAWS_TEST_HOOKS_DIR/god-object-check.sh'"
}

_run_write() {
  local rel="$1" env_loc="${2:-10}"
  local abs="$CAWS_TEST_REPO/$rel"
  local envelope
  envelope="$(jq -nc --arg f "$abs" '{tool_name:"Write", tool_input:{file_path:$f, content:"x"}}')"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    CAWS_GOD_OBJECT_LOC="$env_loc" \
    bash -c "printf '%s' '$envelope' | bash '$CAWS_TEST_HOOKS_DIR/god-object-check.sh'"
}

# --- A1: small edit to an already-over file is SILENT (the core fix) ---
@test "god-object: a small Edit to an already-over file emits NO advisory (A1)" {
  # File ends at 12 SLOC (threshold 10). The edit replaced a 1-line region with
  # a 3-line region: delta +2 (< large-delta 5). PRE = 12 - 2 = 10 = threshold,
  # so it did NOT cross (pre at-or-under but... pre==threshold means it was AT
  # the threshold, not over). To make this an ALREADY-OVER case, use a +2 delta
  # where PRE is also over: file at 14, delta +2 -> PRE 12 (already over 10).
  _make_file_with_sloc over.js 14
  _run_edit over.js "old1" "$(printf 'n1\nn2\nn3')"   # old 1 sloc, new 3 sloc -> delta +2
  assert_success
  refute_output --partial 'god-object-check'
}

# --- A2: an Edit that CROSSES the threshold WARNS ---
@test "god-object: an Edit crossing the threshold emits the advisory (A2)" {
  # File ends at 12 SLOC. The edit added a 4-line region replacing a 0-line
  # region: delta +4. PRE = 12 - 4 = 8 (<= threshold 10) -> CROSSED -> warn.
  _make_file_with_sloc crossed.js 12
  _run_edit crossed.js "" "$(printf 'n1\nn2\nn3\nn4')"
  assert_success
  assert_output --partial 'god-object-check'
  assert_output --partial '~12 source lines'
}

# --- A3: a LARGE-delta Edit to an already-over file WARNS ---
@test "god-object: a large-delta Edit to an already-over file emits the advisory (A3)" {
  # File ends at 20 SLOC. Edit replaced 1 line with 7: delta +6 (>= large 5).
  # PRE = 20 - 6 = 14 (already over 10) but the large growth is still signal.
  _make_file_with_sloc bigadd.js 20
  _run_edit bigadd.js "old1" "$(printf 'n1\nn2\nn3\nn4\nn5\nn6\nn7')"
  assert_success
  assert_output --partial 'god-object-check'
}

# --- under-threshold result is always silent ---
@test "god-object: an Edit leaving the file under threshold is silent" {
  _make_file_with_sloc small.js 5
  _run_edit small.js "old1" "$(printf 'n1\nn2')"
  assert_success
  refute_output --partial 'god-object-check'
}

# --- a shrinking edit to an already-over file is silent (delta negative) ---
@test "god-object: an Edit that SHRINKS an already-over file is silent" {
  # File ends at 13 SLOC. Edit replaced 5 lines with 1: delta -4. PRE = 17.
  # Already over before and after, edit reduced size -> not signal -> silent.
  _make_file_with_sloc shrink.js 13
  _run_edit shrink.js "$(printf 'o1\no2\no3\no4\no5')" "n1"
  assert_success
  refute_output --partial 'god-object-check'
}

# --- A4: a Write of a whole over-threshold file still warns ---
@test "god-object: a Write of a whole over-threshold file emits the advisory (A4 Write path)" {
  _make_file_with_sloc written.js 15
  _run_write written.js
  assert_success
  assert_output --partial 'god-object-check'
}

# --- exit 0 invariant under every branch (advisory, never a block) ---
@test "god-object: always exits 0 (advisory) — warn case" {
  _make_file_with_sloc e1.js 20
  _run_edit e1.js "" "$(printf 'n1\nn2\nn3\nn4\nn5\nn6')"
  assert_success
}
@test "god-object: always exits 0 (advisory) — silent case" {
  _make_file_with_sloc e2.js 14
  _run_edit e2.js "old1" "$(printf 'n1\nn2')"
  assert_success
}

# --- fallback: an Edit with no derivable payload delta defaults to warn ---
# (never MISSES a real over-threshold file; the safe-but-noisier branch)
@test "god-object: an over-threshold Edit with empty new_string falls back to warn" {
  _make_file_with_sloc fb.js 13
  # empty new_string (a deletion-shaped payload) -> hysteresis not applied ->
  # default warn for an over-threshold file.
  _run_edit fb.js "old1" ""
  assert_success
  assert_output --partial 'god-object-check'
}
