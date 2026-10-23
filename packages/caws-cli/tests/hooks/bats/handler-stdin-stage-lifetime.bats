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
find "$TMPDIR" -path '*/caws-handler-stdin-*/*' -type f > "$OUT_DIR/reader-$$.files"
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

# Substring assertions as simple commands. Under /bin/bash 3.2 a false `[[ ... ]]`
# that is not the test's last line does not fail the test (set -e ignores it), so
# every pattern check here goes through these functions instead.
_has() { # $1 = text, $2 = required substring
  case "$1" in *"$2"*) return 0 ;; esac
  echo "expected to find: $2" >&2
  return 1
}
_lacks() { # $1 = text, $2 = forbidden substring
  case "$1" in *"$2"*) echo "found forbidden: $2" >&2; return 1 ;; esac
  return 0
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
  _lacks "$output" 'Broken pipe'
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
  printf '#!/bin/bash\nif [ "$#" -eq 0 ]; then exec %q "$TMPDIR/dispatcher-XXXXXX"; fi\ncase "$*" in *caws-handler-stdin-*) f=$(%q "$@") || exit 1; chmod a-w "$(dirname "$f")"; echo "$f"; exit 0 ;; esac\nexec %q "$@"\n' \
    "$real_mktemp" "$real_mktemp" "$real_mktemp" > "$stub/mktemp"
  chmod +x "$stub/mktemp"
  STAGE_PATH="$stub:$PATH" _chain "$big" reader.sh
  [ "$status" -eq 0 ]
  cmp "$expected" "$OUT_DIR"/reader-*.bytes
  # No payload pathname while the handler ran, and none afterwards.
  [ ! -s "$(ls "$OUT_DIR"/reader-*.files)" ]
  _has "$(cat "$OUT_DIR"/reader-*.tmp)" "dispatcher-"
  [ -z "$(find "$STAGE_TMP" -path '*/caws-handler-stdin-*/*' -type f)" ]
  # What remains is one empty stage directory, named on stderr.
  # GNU mktemp also places dispatcher stderr captures in TMPDIR. They are not
  # payload stages and remain independently owned by the dispatcher.
  left=$(find "$STAGE_TMP" -mindepth 1 -maxdepth 1 -type d -name 'caws-handler-stdin-*' -exec basename {} \;)
  [ "${left#caws-handler-stdin-}" != "$left" ]
  [ -d "$STAGE_TMP/$left" ]
  [ -z "$(ls -A "$STAGE_TMP/$left")" ]
  _has "$output" "[caws run-handlers] could not remove handler stdin stage directory $STAGE_TMP/$left"
}

@test "a payload whose first unlink fails is named, its handler still runs, and the retry after the handler removes it" {
  local big expected real_rm stub
  big=$(_payload)
  expected="$BATS_TEST_TMPDIR/expected.bytes"
  printf '%s' "$big" > "$expected"
  real_rm=$(command -v rm)
  stub="$BATS_TEST_TMPDIR/rm-stub"
  mkdir -p "$stub"
  # Stands in for a private directory altered after creation and restored later:
  # the FIRST removal of a stage payload is refused, every later one works. Only
  # a removal attempted after the handler can therefore succeed, so "payload seen
  # by the handler" plus "payload absent afterwards" proves the post-handler retry.
  printf '#!/bin/bash\nfor a in "$@"; do case "$a" in */caws-handler-stdin-*/payload) if [ ! -e "$RM_STUB_ONCE" ]; then : > "$RM_STUB_ONCE"; exit 1; fi ;; esac; done\nexec %q "$@"\n' \
    "$real_rm" > "$stub/rm"
  chmod +x "$stub/rm"
  RM_STUB_ONCE="$BATS_TEST_TMPDIR/rm-refused-once" STAGE_PATH="$stub:$PATH" _chain "$big" reader.sh
  [ "$status" -eq 0 ]
  cmp "$expected" "$OUT_DIR"/reader-*.bytes
  [ -e "$BATS_TEST_TMPDIR/rm-refused-once" ]
  # The handler saw the payload (its first unlink was refused) and was still run.
  [ -s "$(ls "$OUT_DIR"/reader-*.files)" ]
  # The retry after the handler removed the payload and its directory.
  [ -z "$(find "$STAGE_TMP" -type f -name payload)" ]
  _no_stage_in "$STAGE_TMP"
  # The refused unlink was reported exactly once; the directory report shares the
  # prefix but names "stage directory", so the payload report is matched by path.
  [ "$(printf '%s\n' "$output" | grep -cF "[caws run-handlers] could not remove handler stdin stage $STAGE_TMP/")" -eq 1 ]
}

@test "a payload whose unlink keeps failing is reported before and after its handler, which still runs" {
  local big expected real_rm stub attempts foreign
  big=$(_payload)
  expected="$BATS_TEST_TMPDIR/expected.bytes"
  printf '%s' "$big" > "$expected"
  foreign="$STAGE_TMP/foreign.txt"
  printf 'not ours' > "$foreign"
  real_rm=$(command -v rm)
  stub="$BATS_TEST_TMPDIR/rm-stub"
  attempts="$BATS_TEST_TMPDIR/unlink-attempts"
  mkdir -p "$stub"
  # Every removal of the stage payload is refused. Each refusal records whether
  # the handler had already written its bytes, which places the attempt before
  # or after the handler without relying on report order.
  printf '#!/bin/bash\nfor a in "$@"; do case "$a" in */caws-handler-stdin-*/payload) if ls "$OUT_DIR"/reader-*.bytes >/dev/null 2>&1; then echo after-handler; else echo before-handler; fi >> "$ATTEMPTS"; exit 1 ;; esac; done\nexec %q "$@"\n' \
    "$real_rm" > "$stub/rm"
  chmod +x "$stub/rm"
  ATTEMPTS="$attempts" STAGE_PATH="$stub:$PATH" _chain "$big" reader.sh
  [ "$status" -eq 0 ]
  cmp "$expected" "$OUT_DIR"/reader-*.bytes
  # One refused attempt before the handler and at least one after it.
  [ "$(head -1 "$attempts")" = before-handler ]
  [ "$(grep -c '^after-handler$' "$attempts")" -ge 1 ]
  # The payload remains, is reported for each refused attempt, and nothing that
  # run_handlers did not create was removed.
  [ -n "$(find "$STAGE_TMP" -type f -name payload)" ]
  [ "$(printf '%s\n' "$output" | grep -cF "[caws run-handlers] could not remove handler stdin stage $STAGE_TMP/")" -ge 2 ]
  [ "$(cat "$foreign")" = 'not ours' ]
}

@test "a stage directory replaced by a link during the handler is left in place and named, never followed" {
  local big expected real_rm stub decoy
  big=$(_payload)
  expected="$BATS_TEST_TMPDIR/expected.bytes"
  printf '%s' "$big" > "$expected"
  decoy="$BATS_TEST_TMPDIR/decoy"
  mkdir -p "$decoy"
  printf 'foreign' > "$decoy/payload"
  real_rm=$(command -v rm)
  stub="$BATS_TEST_TMPDIR/rm-stub"
  mkdir -p "$stub"
  # The first removal of the stage payload is refused (so the handler runs as a
  # child and the retry happens), and that refusal also swaps the stage directory
  # for a link to the decoy, as a same-uid actor could between the two attempts.
  printf '#!/bin/bash\nfor a in "$@"; do case "$a" in */caws-handler-stdin-*/payload) if [ ! -e "$RM_STUB_ONCE" ]; then : > "$RM_STUB_ONCE"; d="${a%%/payload}"; mv "$d" "$d.moved"; ln -s %q "$d"; exit 1; fi ;; esac; done\nexec %q "$@"\n' \
    "$decoy" "$real_rm" > "$stub/rm"
  chmod +x "$stub/rm"
  RM_STUB_ONCE="$BATS_TEST_TMPDIR/rm-refused-once" STAGE_PATH="$stub:$PATH" _chain "$big" reader.sh
  [ "$status" -eq 0 ]
  cmp "$expected" "$OUT_DIR"/reader-*.bytes
  # The decoy was never touched through the replaced path.
  [ "$(cat "$decoy/payload")" = foreign ]
  # The replacement was reported, and the moved stage was left in place.
  _has "$output" "[caws run-handlers] handler stdin stage $STAGE_TMP/caws-handler-stdin-"
  _has "$output" " was replaced by a link; left in place"
  [ -n "$(find "$STAGE_TMP" -type f -name payload -path '*.moved/*')" ]
}

@test "exec child and pipe paths preserve nonzero handler bytes output and recorded status" {
  local big real_rm real_mktemp stub mode
  big=$(_payload)
  printf '%s' "$big" > "$BATS_TEST_TMPDIR/expected.bytes"
  real_rm=$(command -v rm)
  real_mktemp=$(command -v mktemp)
  stub="$BATS_TEST_TMPDIR/fallback-tools"
  mkdir "$stub"
  printf '#!/bin/bash\ncase "$*" in *caws-handler-stdin-*) [ "$STAGE_MODE" != pipe ] || exit 1 ;; esac\nexec %q "$@"\n' "$real_mktemp" > "$stub/mktemp"
  printf '#!/bin/bash\nfor a in "$@"; do case "$a" in */caws-handler-stdin-*/payload) if [ "$STAGE_MODE" = child ] && [ ! -e "$RM_STUB_ONCE" ]; then : > "$RM_STUB_ONCE"; exit 1; fi ;; esac; done\nexec %q "$@"\n' "$real_rm" > "$stub/rm"
  cat > "$STAGE_PACK/nonzero.sh" <<'EOF'
#!/bin/bash
cat > "$OUT_DIR/nonzero.bytes"
printf 'handler-output\n'
printf 'handler-error\n' >&2
exit 23
EOF
  chmod +x "$stub/mktemp" "$stub/rm" "$STAGE_PACK/nonzero.sh"
  for mode in exec child pipe; do
    run env HOOKS_DIR="$STAGE_PACK" HOOK_INPUT_JSON="$big" TMPDIR="$STAGE_TMP" \
      OUT_DIR="$OUT_DIR" RUN_HANDLERS="$RUN_HANDLERS" PATH="$stub:$PATH" \
      STAGE_MODE="$mode" RM_STUB_ONCE="$BATS_TEST_TMPDIR/first-unlink" \
      /bin/bash -c 'set -uo pipefail; source "$RUN_HANDLERS";
        _rh_record_execution() {
          printf "%s\n%s\n" "$4" "$6" > "$OUT_DIR/recorded-result";
          cat "$5" > "$OUT_DIR/recorded-stderr";
        }; run_handlers nonzero.sh'
    cmp "$BATS_TEST_TMPDIR/expected.bytes" "$OUT_DIR/nonzero.bytes"
    [ "$(cat "$OUT_DIR/recorded-result")" = $'23\nhandler-output' ]
    [ "$(cat "$OUT_DIR/recorded-stderr")" = handler-error ]
    _no_stage_in "$STAGE_TMP"
    cp "$OUT_DIR/recorded-result" "$OUT_DIR/$mode-result"
    cp "$OUT_DIR/nonzero.bytes" "$OUT_DIR/$mode-bytes"
    if [ "$mode" = child ]; then
      [ -f "$BATS_TEST_TMPDIR/first-unlink" ]
      _has "$output" 'could not remove handler stdin stage'
    fi
  done
}

@test "overlapping dispatches share TMPDIR without sharing stage paths or payloads" {
  local big real_mktemp stub peer first second
  big=$(_payload)
  real_mktemp=$(command -v mktemp)
  stub="$BATS_TEST_TMPDIR/observed-mktemp"
  mkdir "$stub"
  printf '#!/bin/bash\nf=$(%q "$@") || exit 1\ncase "$*" in *caws-handler-stdin-*) printf "%%s\\n" "$f" >> "$OUT_DIR/stage-paths" ;; esac\nprintf "%%s\\n" "$f"\n' "$real_mktemp" > "$stub/mktemp"
  cat > "$STAGE_PACK/overlap.sh" <<'EOF'
#!/bin/bash
cat > "$OUT_DIR/$PEER.bytes"
: > "$OUT_DIR/$PEER.ready"
for attempt in $(seq 1 100); do
  if [ -f "$OUT_DIR/A.ready" ] && [ -f "$OUT_DIR/B.ready" ]; then
    : > "$OUT_DIR/$PEER.overlapped"
    exit 0
  fi
  sleep 0.02
done
exit 91
EOF
  chmod +x "$stub/mktemp" "$STAGE_PACK/overlap.sh"
  for peer in A B; do
    printf '%s' "$peer$big" > "$OUT_DIR/$peer.expected"
    env HOOKS_DIR="$STAGE_PACK" HOOK_INPUT_JSON="$peer$big" TMPDIR="$STAGE_TMP" \
      OUT_DIR="$OUT_DIR" RUN_HANDLERS="$RUN_HANDLERS" PATH="$stub:$PATH" PEER="$peer" \
      /bin/bash -c 'set -uo pipefail; source "$RUN_HANDLERS"; run_handlers overlap.sh' \
      > "$OUT_DIR/$peer.stdout" 2> "$OUT_DIR/$peer.stderr" 3>&- &
    if [ "$peer" = A ]; then first=$!; else second=$!; fi
  done
  wait "$first"
  wait "$second"
  for peer in A B; do
    [ -f "$OUT_DIR/$peer.overlapped" ]
    cmp "$OUT_DIR/$peer.expected" "$OUT_DIR/$peer.bytes"
    [ ! -s "$OUT_DIR/$peer.stderr" ]
  done
  [ "$(wc -l < "$OUT_DIR/stage-paths" | tr -d ' ')" = 2 ]
  [ "$(sort -u "$OUT_DIR/stage-paths" | wc -l | tr -d ' ')" = 2 ]
  while IFS= read -r stage; do [ ! -e "$stage" ]; done < "$OUT_DIR/stage-paths"
  _no_stage_in "$STAGE_TMP"
}
