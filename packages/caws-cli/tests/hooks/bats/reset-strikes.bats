#!/usr/bin/env bats
# reset-strikes.sh — session lookup across BOTH strike-file shapes
# (CAWS-RESET-STRIKES-SESSION-LOOKUP-001).
#
# Strike state lives in two shapes, and the session id is encoded differently
# in each:
#
#   live   $HOME/.caws/state/sessions/<sid>/strikes.json   -> sid in the DIRECTORY
#   legacy <repo>/<vendor>/logs/guard-strikes-<sid>.json   -> sid in the FILENAME
#
# collect_strike_files returns both, and the script's own header calls the
# session-global store "the live source — resets target it". But `--session`
# filtered with `grep "guard-strikes-<sid>.json$"`, a pattern the live path can
# never match. So the one mode a human is told to run — the block message prints
# `--session <id>` with the id already filled in — could only ever reach the
# legacy files, and exited 1 with "No strike file found for session" against a
# live strike file sitting right there. The same filename-parsing assumption
# mislabelled the live store as `session=strikes` in the listing.
#
# These tests plant real files in both shapes under an isolated HOME and drive
# the installed script the way a human does.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

RESET="$CAWS_TEST_HOOKS_DIR/reset-strikes.sh"

SID_LIVE="11111111-2222-3333-4444-555555555555"
SID_LEGACY="66666666-7777-8888-9999-000000000000"

# The live session-global store: session id is the DIRECTORY name.
plant_live_strikes() {
  local sid="$1"
  local dir="$CAWS_TEST_HOME/.caws/state/sessions/$sid"
  mkdir -p "$dir"
  printf '{"shortcut_language":3}\n' > "$dir/strikes.json"
  echo "$dir/strikes.json"
}

# The legacy repo-local store: session id is embedded in the FILENAME.
plant_legacy_strikes() {
  local sid="$1"
  local dir="$CAWS_TEST_REPO/.claude/logs"
  mkdir -p "$dir"
  printf '{"scope_guard":2}\n' > "$dir/guard-strikes-${sid}.json"
  echo "$dir/guard-strikes-${sid}.json"
}

# Run the reset from inside the test repo, as a human would.
#
# HOME must be set HERE. helpers.bash exports it only inside the subshell that
# performs the pack install, so a test that omits it runs the script against the
# developer's REAL ~/.caws/state/sessions — which for this script means a reset
# could delete a live peer session's strike file. The isolation test below is
# the tripwire for that.
run_reset() {
  run bash -c "cd '$CAWS_TEST_REPO' && HOME='$CAWS_TEST_HOME' CAWS_HOME='$CAWS_TEST_HOME/.caws' '$RESET' $*"
}

setup() {
  rm -rf "$CAWS_TEST_HOME/.caws/state/sessions" "$CAWS_TEST_REPO/.claude/logs"
}

@test "isolation: the suite never reads the developer's real session store" {
  # Tripwire. Without HOME set per-invocation these tests operate on real
  # machine state, and --session/--all would delete other live sessions'
  # strike files. Plant exactly one fixture session and assert the listing
  # sees that and nothing else.
  plant_live_strikes "$SID_LIVE" >/dev/null

  run_reset
  [ "$status" -eq 0 ]
  [[ "$output" == *"$SID_LIVE"* ]]
  # The real store lives under the invoking user's home, never under the
  # fixture home. If this substring shows up, isolation has broken.
  [[ "$output" != *"$HOME/.caws/state/sessions"* ]]
}

@test "A1: --session resets the LIVE session-global store" {
  local f
  f="$(plant_live_strikes "$SID_LIVE")"
  [ -f "$f" ]

  run_reset --session "$SID_LIVE"
  [ "$status" -eq 0 ]
  # The file the script's own header calls "the live source" must be gone.
  [ ! -f "$f" ]
}

@test "A2: --session still resets a LEGACY repo-local strike file" {
  local f
  f="$(plant_legacy_strikes "$SID_LEGACY")"
  [ -f "$f" ]

  run_reset --session "$SID_LEGACY"
  [ "$status" -eq 0 ]
  [ ! -f "$f" ]
}

@test "A2b: --session targets ONLY the named session, not every strike file" {
  local live other
  live="$(plant_live_strikes "$SID_LIVE")"
  other="$(plant_live_strikes "$SID_LEGACY")"

  run_reset --session "$SID_LIVE"
  [ "$status" -eq 0 ]
  [ ! -f "$live" ]
  # A filter that collapsed to "reset everything" would pass A1 while being
  # catastrophically wrong for a human resetting one wedged session.
  [ -f "$other" ]
}

@test "A3: listing labels the live store with the real session id" {
  plant_live_strikes "$SID_LIVE" >/dev/null

  run_reset
  [ "$status" -eq 0 ]
  [[ "$output" == *"session=$SID_LIVE"* ]]
  # The filename-derived bug printed the literal basename instead.
  [[ "$output" != *"session=strikes"* ]]
}

@test "A4: an unknown session still fails, and names the sessions that DO have strikes" {
  plant_live_strikes "$SID_LIVE" >/dev/null

  run_reset --session "deadbeef-0000-0000-0000-000000000000"
  [ "$status" -ne 0 ]
  # Still a refusal — the fix must not turn a typo into a silent no-op success.
  [[ "$output" == *"No strike file found"* ]]
  # But the operator should not have to guess what to type instead.
  [[ "$output" == *"$SID_LIVE"* ]]
}

@test "A4b: with no strike files at all, --session says so without inventing candidates" {
  run_reset --session "$SID_LIVE"
  [ "$status" -ne 0 ]
  [[ "$output" == *"No strike file found"* ]]
}

@test "--guard restricts the reset to one guard key in the live store" {
  local dir="$CAWS_TEST_HOME/.caws/state/sessions/$SID_LIVE"
  mkdir -p "$dir"
  printf '{"shortcut_language":3,"scope_guard":1}\n' > "$dir/strikes.json"

  run_reset --session "$SID_LIVE" --guard shortcut_language
  [ "$status" -eq 0 ]
  # The file survives because another guard key remains...
  [ -f "$dir/strikes.json" ]
  # ...and only the named guard was cleared.
  run bash -c "jq -r 'has(\"shortcut_language\")' '$dir/strikes.json'"
  [ "$output" = "false" ]
  run bash -c "jq -r '.scope_guard' '$dir/strikes.json'"
  [ "$output" = "1" ]
}
