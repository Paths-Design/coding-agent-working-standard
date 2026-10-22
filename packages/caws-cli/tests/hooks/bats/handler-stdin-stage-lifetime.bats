#!/usr/bin/env bats
# CAWS-HANDLER-STDIN-STAGE-LIFETIME-001 — a staged inline payload must not
# outlive the handler it feeds.
#
# Root cause this file pins: run_handlers staged every inline payload over 32768
# characters to one dispatch-scoped caws-handler-stdin-* file and never removed it
# on any path; the CAWS_TEMP_FILES list it was appended to has no consumer. Every
# large dispatch left a full copy of the tool payload in TMPDIR.
#
# The file is self-contained: it needs bats-core, bash, jq and coreutils, but no
# built CLI and no installed pack. CAWS_STAGE_RUN_HANDLERS selects the
# run-handlers.sh under test and defaults to the shipped template, so a pinned
# copy of any revision can be checked without touching the source tree.
#
# Not covered, and not claimed: a signal delivered while mktemp -d runs, before the
# stage name is known, can leave one empty directory; a KILL between the payload
# write and its unlink can leave the payload file; a KILL after the unlink can leave
# only the empty directory. A payload that cannot be unlinked (its private
# directory altered after creation) stays on disk while its handler runs and is
# named on stderr; that case is pinned below as a reported failure, not a pass.

setup() {
  RUN_HANDLERS="${CAWS_STAGE_RUN_HANDLERS:-$BATS_TEST_DIRNAME/../../../templates/hook-packs/shared/lib/run-handlers.sh}"
  [ -f "$RUN_HANDLERS" ]
  STAGE_PACK="$BATS_TEST_TMPDIR/stage-pack"
  STAGE_TMP="$BATS_TEST_TMPDIR/stage-tmp"
  OUT_DIR="$BATS_TEST_TMPDIR/stage-out"
  mkdir -p "$STAGE_PACK" "$STAGE_TMP" "$OUT_DIR"
  cat > "$STAGE_PACK/reader.sh" <<'EOF'
#!/bin/bash
if [ -p /dev/stdin ]; then kind=pipe; else kind=file; fi
cat > "$OUT_DIR/reader-$$.bytes"
printf '%s\n' "$kind" > "$OUT_DIR/reader-$$.kind"
ls -A "$TMPDIR" > "$OUT_DIR/reader-$$.tmp"
find "$TMPDIR" -type f > "$OUT_DIR/reader-$$.files"
exit 0
EOF
  printf '#!/bin/bash\nexit 0\n' > "$STAGE_PACK/early-exit.sh"
  cat > "$STAGE_PACK/sleeper.sh" <<'EOF'
#!/bin/bash
ls -A "$TMPDIR" > "$OUT_DIR/sleeper.tmp"
echo $$ > "$OUT_DIR/sleeper.pid"
exec sleep 30
EOF
  chmod +x "$STAGE_PACK"/*.sh
}

# Ends only processes this test started and recorded, and only while each pid still
# runs the command it was recorded for, so a failed assertion cannot strand them and
# a reused pid is never signalled.
teardown() {
  _end_owned "$OUT_DIR/dispatcher.pid" 'run_handlers sleeper.sh'
  _end_owned "$OUT_DIR/sleeper.pid" 'sleep 30'
  # The non-writable-TMPDIR case removes write permission from STAGE_TMP, which
  # this test created; restore it so bats can remove the test directory.
  [ ! -d "$STAGE_TMP" ] || chmod u+w "$STAGE_TMP"
}

_end_owned() { # $1 = pid file, $2 = substring the process command line must contain
  [ -s "$1" ] || return 0
  local pid cmd
  pid=$(cat "$1")
  cmd=$(ps -o command= -p "$pid" 2>/dev/null) || return 0
  [[ "$cmd" == *"$2"* ]] || return 0
  kill -KILL "$pid" 2>/dev/null || true
}

# Runs run_handlers over the given handlers under the dispatcher's shell options,
# with HOOK_INPUT_JSON preset so only the stdin decision is observed.
_chain() { # $1 = payload, rest = handlers
  local payload="$1"; shift
  run env HOOKS_DIR="$STAGE_PACK" HOOK_INPUT_JSON="$payload" TMPDIR="$STAGE_TMP" \
    OUT_DIR="$OUT_DIR" RUN_HANDLERS="$RUN_HANDLERS" PATH="${STAGE_PATH:-$PATH}" \
    /bin/bash -c 'set -uo pipefail; source "$RUN_HANDLERS"; run_handlers "$@"' _ "$@"
}

_no_stage_in() { # $1 = directory or listing file; fails when a stage name appears
  local listing
  if [ -d "$1" ]; then listing=$(ls -A "$1"); else listing=$(cat "$1"); fi
  if printf '%s\n' "$listing" | grep -q 'caws-handler-stdin-'; then
    echo "stage file present in $1: $listing" >&2
    return 1
  fi
}

_payload() { # a >32768-character JSON payload with escapes and multibyte text
  jq -nc '{tool_name:"Bash",tool_input:{command:"stage"},
           tool_response:{data:("A%s \\ \"q\" é日本 \n" * 2400)}}'
}

@test "every reader gets the exact payload from a file and no stage outlives the chain" {
  local big expected
  big=$(_payload)
  [ "${#big}" -gt 32768 ]
  expected="$BATS_TEST_TMPDIR/expected.bytes"
  printf '%s' "$big" > "$expected"
  _chain "$big" reader.sh early-exit.sh reader.sh
  [ "$status" -eq 0 ]
  [[ "$output" != *'Broken pipe'* ]]
  local readers=("$OUT_DIR"/reader-*.bytes)
  [ "${#readers[@]}" -eq 2 ]
  # Each reader starts at offset zero of a regular file holding the payload with
  # nothing appended; a descriptor shared between readers would leave one empty.
  cmp "$expected" "${readers[0]}"
  cmp "$expected" "${readers[1]}"
  for k in "$OUT_DIR"/reader-*.kind; do [ "$(cat "$k")" = file ]; done
  _no_stage_in "$STAGE_TMP"
}

@test "no stage file exists while a handler runs" {
  _chain "$(_payload)" reader.sh reader.sh
  [ "$status" -eq 0 ]
  local listings=("$OUT_DIR"/reader-*.tmp)
  [ "${#listings[@]}" -eq 2 ]
  for l in "${listings[@]}"; do _no_stage_in "$l"; done
}

@test "TERM or KILL to the dispatcher while a handler runs leaves no stage" {
  local big sig dpid
  big=$(_payload)
  for sig in TERM KILL; do
    rm -f "$OUT_DIR/sleeper.pid" "$OUT_DIR/sleeper.tmp"
    env HOOKS_DIR="$STAGE_PACK" HOOK_INPUT_JSON="$big" TMPDIR="$STAGE_TMP" OUT_DIR="$OUT_DIR" \
      RUN_HANDLERS="$RUN_HANDLERS" \
      /bin/bash -c 'set -uo pipefail; source "$RUN_HANDLERS"; run_handlers sleeper.sh' \
      > "$OUT_DIR/dispatch-$sig.out" 2>&1 3>&- &
    dpid=$!
    echo "$dpid" > "$OUT_DIR/dispatcher.pid"
    for _ in $(seq 1 100); do [ -s "$OUT_DIR/sleeper.pid" ] && break; sleep 0.1; done
    [ -s "$OUT_DIR/sleeper.pid" ]
    kill -"$sig" "$dpid"
    wait "$dpid" || true
    kill "$(cat "$OUT_DIR/sleeper.pid")" 2>/dev/null || true
    _no_stage_in "$OUT_DIR/sleeper.tmp"
    _no_stage_in "$STAGE_TMP"
  done
}

@test "an inherited payload file and caller CAWS_TEMP_FILES entries are never deleted" {
  local big foreign_payload foreign_listed
  big=$(_payload)
  foreign_payload="$BATS_TEST_TMPDIR/foreign-payload.json"
  foreign_listed="$BATS_TEST_TMPDIR/foreign-listed.tmp"
  printf '%s' "$big" > "$foreign_payload"
  printf 'not created by run_handlers' > "$foreign_listed"
  # Spill path: handlers read the inherited file, which stays in place.
  run env HOOKS_DIR="$STAGE_PACK" HOOK_INPUT_JSON="$big" HOOK_PAYLOAD_FILE="$foreign_payload" \
    TMPDIR="$STAGE_TMP" OUT_DIR="$OUT_DIR" FOREIGN="$foreign_listed" RUN_HANDLERS="$RUN_HANDLERS" \
    /bin/bash -c 'set -uo pipefail; CAWS_TEMP_FILES=("$FOREIGN"); source "$RUN_HANDLERS"; run_handlers reader.sh early-exit.sh'
  [ "$status" -eq 0 ]
  [ -f "$foreign_payload" ]
  [ -f "$foreign_listed" ]
  cmp "$foreign_payload" "$OUT_DIR"/reader-*.bytes
  # Staged inline path: a caller's CAWS_TEMP_FILES list is left alone.
  rm -f "$OUT_DIR"/reader-*
  run env HOOKS_DIR="$STAGE_PACK" HOOK_INPUT_JSON="$big" TMPDIR="$STAGE_TMP" OUT_DIR="$OUT_DIR" \
    FOREIGN="$foreign_listed" RUN_HANDLERS="$RUN_HANDLERS" \
    /bin/bash -c 'set -uo pipefail; CAWS_TEMP_FILES=("$FOREIGN"); source "$RUN_HANDLERS"; run_handlers reader.sh'
  [ "$status" -eq 0 ]
  [ -f "$foreign_listed" ]
  _no_stage_in "$STAGE_TMP"
}

@test "a stage that cannot be created falls back to the pipe and still delivers" {
  local big expected real_mktemp stub
  big=$(_payload)
  expected="$BATS_TEST_TMPDIR/expected.bytes"
  printf '%s' "$big" > "$expected"
  real_mktemp=$(command -v mktemp)
  stub="$BATS_TEST_TMPDIR/mktemp-stub"
  mkdir -p "$stub"
  # Only the stage template fails; every other mktemp in run_handlers works.
  printf '#!/bin/bash\ncase "$*" in *caws-handler-stdin-*) exit 1 ;; esac\nexec %q "$@"\n' \
    "$real_mktemp" > "$stub/mktemp"
  chmod +x "$stub/mktemp"
  STAGE_PATH="$stub:$PATH" _chain "$big" reader.sh
  [ "$status" -eq 0 ]
  cmp "$expected" "$OUT_DIR"/reader-*.bytes
  [ "$(cat "$OUT_DIR"/reader-*.kind)" = pipe ]
  _no_stage_in "$STAGE_TMP"
}

@test "32768 characters use the pipe and one more character is staged" {
  local at_bound over_bound
  at_bound=$(head -c 32768 /dev/zero | tr '\0' 'x')
  over_bound="${at_bound}x"
  _chain "$at_bound" reader.sh
  [ "$status" -eq 0 ]
  [ "$(cat "$OUT_DIR"/reader-*.kind)" = pipe ]
  [ "$(wc -c < "$OUT_DIR"/reader-*.bytes | tr -d ' ')" = 32768 ]
  rm -f "$OUT_DIR"/reader-*
  _chain "$over_bound" reader.sh
  [ "$status" -eq 0 ]
  [ "$(cat "$OUT_DIR"/reader-*.kind)" = file ]
  [ "$(wc -c < "$OUT_DIR"/reader-*.bytes | tr -d ' ')" = 32769 ]
  _no_stage_in "$STAGE_TMP"
}

@test "TMPDIR that stops accepting removals leaves no payload file and names the empty stage directory" {
  # Root removes entries from a non-writable directory, so the case cannot be
  # produced for uid 0.
  [ "$(id -u)" != 0 ] || skip "needs a non-root user"
  local big expected real_mktemp stub left
  big=$(_payload)
  expected="$BATS_TEST_TMPDIR/expected.bytes"
  printf '%s' "$big" > "$expected"
  real_mktemp=$(command -v mktemp)
  stub="$BATS_TEST_TMPDIR/mktemp-stub"
  mkdir -p "$stub"
  # The stage is created normally; then TMPDIR (which this test owns) stops
  # accepting removals, as a hostile or misconfigured parent directory would.
  printf '#!/bin/bash\ncase "$*" in *caws-handler-stdin-*) f=$(%q "$@") || exit 1; chmod a-w "$(dirname "$f")"; echo "$f"; exit 0 ;; esac\nexec %q "$@"\n' \
    "$real_mktemp" "$real_mktemp" > "$stub/mktemp"
  chmod +x "$stub/mktemp"
  STAGE_PATH="$stub:$PATH" _chain "$big" reader.sh
  [ "$status" -eq 0 ]
  cmp "$expected" "$OUT_DIR"/reader-*.bytes
  # No payload pathname while the handler ran, and none afterwards.
  [ ! -s "$(ls "$OUT_DIR"/reader-*.files)" ]
  [ -z "$(find "$STAGE_TMP" -type f)" ]
  # What remains is one empty stage directory, named on stderr.
  left=$(ls -A "$STAGE_TMP")
  [[ "$left" == caws-handler-stdin-* ]]
  [ -d "$STAGE_TMP/$left" ]
  [ -z "$(ls -A "$STAGE_TMP/$left")" ]
  [[ "$output" == *"[caws run-handlers] could not remove handler stdin stage directory $STAGE_TMP/$left"* ]]
}

@test "a payload that cannot be unlinked is named on stderr and its handler still runs" {
  local big expected real_rm stub
  big=$(_payload)
  expected="$BATS_TEST_TMPDIR/expected.bytes"
  printf '%s' "$big" > "$expected"
  real_rm=$(command -v rm)
  stub="$BATS_TEST_TMPDIR/rm-stub"
  mkdir -p "$stub"
  # Stands in for a private directory altered after creation: only the payload
  # inside a stage directory refuses removal; every other rm works.
  printf '#!/bin/bash\nfor a in "$@"; do case "$a" in */caws-handler-stdin-*/payload) exit 1 ;; esac; done\nexec %q "$@"\n' \
    "$real_rm" > "$stub/rm"
  chmod +x "$stub/rm"
  STAGE_PATH="$stub:$PATH" _chain "$big" reader.sh
  [ "$status" -eq 0 ]
  cmp "$expected" "$OUT_DIR"/reader-*.bytes
  # The failure is explicit, not hidden: the payload was present while the handler
  # ran, is still present, and was named on stderr before and after the handler.
  [ -s "$(ls "$OUT_DIR"/reader-*.files)" ]
  [ -n "$(find "$STAGE_TMP" -type f -name payload)" ]
  [ "$(printf '%s\n' "$output" | grep -c '\[caws run-handlers\] could not remove handler stdin stage ')" -ge 2 ]
}
