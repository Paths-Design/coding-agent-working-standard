#!/usr/bin/env bats
# CAWS-DEFECT-RUNHANDLERS-STDIN-EPIPE-NOISE-001 — handler stdin must not be
# streamed through a pipe whose reader may exit before draining.
#
# Root cause this file pins: run-handlers.sh fed every handler via
# `printf '%s' "$HOOK_INPUT_JSON" | handler`. Handlers run in dispatcher
# fast-path (HOOK_* pre-parsed) and legitimately never read stdin, so any
# payload larger than the kernel pipe buffer left the writer blocked and
# then broken: one `printf: write error: Broken pipe` per handler per
# dispatch, surfaced on the dispatcher's stderr. A large tool payload turned
# every dispatch into a wall of pipe noise.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

setup() {
  caws_session_isolation_begin
  caws_enter_fixture
}

# Byte-exact stdin delivery through run_handlers itself, with a probe handler
# in a minimal HOOKS_DIR (no lib/: run_handlers sources parse-input only when
# HOOK_INPUT_JSON is unset, and the session-id/reprieve/guard-config sources
# are all `[[ -f ]]`-guarded, so a bare handler dir is a hermetic harness).
# HOOK_INPUT_JSON is pre-set so the parser stage is skipped and the test
# observes exactly the run_handlers stdin-feeding decision.
_run_chain_with_payload() { # $1 = payload string, $2 = count file
  local fake_dir="$BATS_TEST_TMPDIR/fake-pack-$$"
  mkdir -p "$fake_dir"
  printf '#!/bin/bash\nwc -c < /dev/stdin > "$COUNT_FILE" 2>/dev/null\nexit 0\n' \
    > "$fake_dir/echo-size.sh"
  chmod +x "$fake_dir/echo-size.sh"
  mkdir -p "$BATS_TEST_TMPDIR/chain-tmp"
  run env COUNT_FILE="$2" HOOKS_DIR="$fake_dir" HOOK_INPUT_JSON="$1" \
    TMPDIR="$BATS_TEST_TMPDIR/chain-tmp" \
    bash -c 'source "'"$CAWS_TEST_HOOKS_DIR"'/lib/run-handlers.sh"; run_handlers echo-size.sh'
}

# CAWS-HANDLER-STDIN-STAGE-LIFETIME-001 — a staged inline payload must not
# outlive the handler it feeds. Each test gets an empty TMPDIR so any stage
# left behind is visible by name, and probe handlers record what they saw.
_stage_pack() { # creates $STAGE_PACK with probe handlers; $OUT_DIR collects records
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

# Runs run_handlers over the given handlers under the dispatcher's shell
# options, with HOOK_INPUT_JSON preset so only the stdin decision is observed.
_stage_chain() { # $1 = payload, rest = handlers
  local payload="$1"; shift
  run env HOOKS_DIR="$STAGE_PACK" HOOK_INPUT_JSON="$payload" TMPDIR="$STAGE_TMP" \
    OUT_DIR="$OUT_DIR" PATH="${STAGE_PATH:-$PATH}" \
    bash -c 'set -uo pipefail; source "'"$CAWS_TEST_HOOKS_DIR"'/lib/run-handlers.sh"; run_handlers "$@"' \
    _ "$@"
}

_no_stage_in() { # $1 = directory or listing file; fails when a stage name appears
  local listing
  if [ -d "$1" ]; then listing=$(ls -A "$1"); else listing=$(cat "$1"); fi
  if printf '%s\n' "$listing" | grep -q 'caws-handler-stdin-'; then
    echo "stage file present in $1: $listing" >&2
    return 1
  fi
}

_stage_payload() { # a >32768-character JSON payload with escapes and multibyte text
  jq -nc '{tool_name:"Bash",tool_input:{command:"stage"},
           tool_response:{data:("A%s \\ \"q\" é日本 \n" * 2400)}}'
}

@test "handler stdin: a >64KiB inline payload reaches the handler intact, no broken-pipe stderr" {
  # 100000 bytes is above every kernel pipe buffer (so the old `printf |
  # handler` form is guaranteed to EPIPE) but below the 131072-byte inline
  # ceiling (so parse-input keeps the payload inline and run-handlers must
  # stage it itself). Pre-fix this prints one "write error: Broken pipe"
  # and strands a short read in the handler.
  local big count_file
  big=$(jq -nc '{tool_name:"Bash",tool_input:{command:"big"},tool_response:{data:("A" * 100000)}}')
  count_file="$BATS_TEST_TMPDIR/count-inline-$$"
  _run_chain_with_payload "$big" "$count_file"
  assert_success
  refute_output --partial 'write error: Broken pipe'
  [ -f "$count_file" ]
  [ "$(tr -d ' ' < "$count_file")" = "${#big}" ]
}

@test "handler stdin: a >131072-byte file-transport payload reaches the handler intact, no broken-pipe stderr" {
  # Above the inline ceiling parse-input already moves the payload to
  # HOOK_PAYLOAD_FILE; run-handlers must feed handlers from that file rather
  # than re-serializing the (unexported) inline string through a pipe.
  local big count_file
  big=$(jq -nc '{tool_name:"Bash",tool_input:{command:"bigger"},tool_response:{data:("B" * 200000)}}')
  count_file="$BATS_TEST_TMPDIR/count-file-$$"
  _run_chain_with_payload "$big" "$count_file"
  assert_success
  refute_output --partial 'write error: Broken pipe'
  [ -f "$count_file" ]
  [ "$(tr -d ' ' < "$count_file")" = "${#big}" ]
}

@test "handler stdin: the installed pre_tool dispatch stays quiet and succeeds on a 100KiB payload" {
  # Dispatch-level pin over the real handler chain: no per-handler pipe
  # noise reaches the dispatcher's stderr (this is the user-visible
  # signature from the defect) and the chain still completes successfully.
  local payload_file="$BATS_TEST_TMPDIR/envelope-dispatch-$$"
  jq -nc '{tool_name:"Bash",session_id:"stdin-dispatch-1",
           tool_input:{command:"git status"},
           tool_response:{data:("C" * 100000)},
           cwd:"'"$CAWS_TEST_REPO"'"}' > "$payload_file"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    TMPDIR="$BATS_TEST_TMPDIR" \
    bash -c "cat '$payload_file' | bash '$CAWS_TEST_HOOKS_DIR/dispatch/pre_tool_use.sh'"
  assert_success
  refute_output --partial 'write error: Broken pipe'
}

@test "handler stdin: the installed pre_tool dispatch stays quiet on a 200KiB payload" {
  # File-transport band over the real chain: the E2BIG survival contract is
  # pinned by parse-input-payload-transport.bats; this adds the noise
  # contract for the same band.
  local payload_file="$BATS_TEST_TMPDIR/envelope-dispatch-big-$$"
  jq -nc '{tool_name:"Bash",session_id:"stdin-dispatch-2",
           tool_input:{command:"git status"},
           tool_response:{data:("D" * 200000)},
           cwd:"'"$CAWS_TEST_REPO"'"}' > "$payload_file"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    TMPDIR="$BATS_TEST_TMPDIR" \
    bash -c "cat '$payload_file' | bash '$CAWS_TEST_HOOKS_DIR/dispatch/pre_tool_use.sh'"
  assert_success
  refute_output --partial 'write error: Broken pipe'
}

@test "handler stdin stage: every reader gets the exact payload from a file and no stage outlives the chain" {
  _stage_pack
  local big expected
  big=$(_stage_payload)
  [ "${#big}" -gt 32768 ]
  expected="$BATS_TEST_TMPDIR/expected.bytes"
  printf '%s' "$big" > "$expected"
  _stage_chain "$big" reader.sh early-exit.sh reader.sh
  assert_success
  refute_output --partial 'Broken pipe'
  local readers=("$OUT_DIR"/reader-*.bytes)
  [ "${#readers[@]}" -eq 2 ]
  # Each reader starts at offset zero of a regular file holding the payload
  # with nothing appended; a shared descriptor would leave the second empty.
  cmp "$expected" "${readers[0]}"
  cmp "$expected" "${readers[1]}"
  for k in "$OUT_DIR"/reader-*.kind; do [ "$(cat "$k")" = file ]; done
  _no_stage_in "$STAGE_TMP"
}

@test "handler stdin stage: no stage file exists while a handler runs" {
  _stage_pack
  _stage_chain "$(_stage_payload)" reader.sh reader.sh
  assert_success
  local listings=("$OUT_DIR"/reader-*.tmp)
  [ "${#listings[@]}" -eq 2 ]
  for l in "${listings[@]}"; do _no_stage_in "$l"; done
}

@test "handler stdin stage: TERM or KILL to the dispatcher while a handler runs leaves no stage" {
  _stage_pack
  local big sig dpid
  big=$(_stage_payload)
  for sig in TERM KILL; do
    rm -f "$OUT_DIR/sleeper.pid" "$OUT_DIR/sleeper.tmp"
    env HOOKS_DIR="$STAGE_PACK" HOOK_INPUT_JSON="$big" TMPDIR="$STAGE_TMP" OUT_DIR="$OUT_DIR" \
      bash -c 'set -uo pipefail; source "'"$CAWS_TEST_HOOKS_DIR"'/lib/run-handlers.sh"; run_handlers sleeper.sh' \
      > "$OUT_DIR/dispatch-$sig.out" 2>&1 3>&- &
    dpid=$!
    for _ in $(seq 1 100); do [ -s "$OUT_DIR/sleeper.pid" ] && break; sleep 0.1; done
    [ -s "$OUT_DIR/sleeper.pid" ]
    kill -"$sig" "$dpid"
    wait "$dpid" || true
    kill "$(cat "$OUT_DIR/sleeper.pid")" 2>/dev/null || true
    _no_stage_in "$OUT_DIR/sleeper.tmp"
    _no_stage_in "$STAGE_TMP"
  done
}

@test "handler stdin stage: an inherited payload file and caller CAWS_TEMP_FILES entries are never deleted" {
  _stage_pack
  local big foreign_payload foreign_listed
  big=$(_stage_payload)
  foreign_payload="$BATS_TEST_TMPDIR/foreign-payload.json"
  foreign_listed="$BATS_TEST_TMPDIR/foreign-listed.tmp"
  printf '%s' "$big" > "$foreign_payload"
  printf 'not created by run_handlers' > "$foreign_listed"
  # Spill path: handlers read the inherited file, which stays in place.
  run env HOOKS_DIR="$STAGE_PACK" HOOK_INPUT_JSON="$big" HOOK_PAYLOAD_FILE="$foreign_payload" \
    TMPDIR="$STAGE_TMP" OUT_DIR="$OUT_DIR" FOREIGN="$foreign_listed" \
    bash -c 'set -uo pipefail; CAWS_TEMP_FILES=("$FOREIGN"); source "'"$CAWS_TEST_HOOKS_DIR"'/lib/run-handlers.sh"; run_handlers reader.sh early-exit.sh'
  assert_success
  [ -f "$foreign_payload" ]
  [ -f "$foreign_listed" ]
  cmp "$foreign_payload" "$OUT_DIR"/reader-*.bytes
  # Staged inline path: a caller's CAWS_TEMP_FILES list is left alone.
  rm -f "$OUT_DIR"/reader-*
  run env HOOKS_DIR="$STAGE_PACK" HOOK_INPUT_JSON="$big" TMPDIR="$STAGE_TMP" OUT_DIR="$OUT_DIR" \
    FOREIGN="$foreign_listed" \
    bash -c 'set -uo pipefail; CAWS_TEMP_FILES=("$FOREIGN"); source "'"$CAWS_TEST_HOOKS_DIR"'/lib/run-handlers.sh"; run_handlers reader.sh'
  assert_success
  [ -f "$foreign_listed" ]
  _no_stage_in "$STAGE_TMP"
}

@test "handler stdin stage: a stage that cannot be created falls back to the pipe and still delivers" {
  _stage_pack
  local big expected real_mktemp stub
  big=$(_stage_payload)
  expected="$BATS_TEST_TMPDIR/expected.bytes"
  printf '%s' "$big" > "$expected"
  real_mktemp=$(command -v mktemp)
  stub="$BATS_TEST_TMPDIR/mktemp-stub"
  mkdir -p "$stub"
  # Only the stage template fails; every other mktemp in run_handlers works.
  printf '#!/bin/bash\ncase "$*" in *caws-handler-stdin-*) exit 1 ;; esac\nexec %q "$@"\n' \
    "$real_mktemp" > "$stub/mktemp"
  chmod +x "$stub/mktemp"
  STAGE_PATH="$stub:$PATH" _stage_chain "$big" reader.sh
  assert_success
  cmp "$expected" "$OUT_DIR"/reader-*.bytes
  [ "$(cat "$OUT_DIR"/reader-*.kind)" = pipe ]
  _no_stage_in "$STAGE_TMP"
}

@test "handler stdin stage: 32768 characters use the pipe and one more character is staged" {
  _stage_pack
  local at_bound over_bound
  at_bound=$(head -c 32768 /dev/zero | tr '\0' 'x')
  over_bound="${at_bound}x"
  _stage_chain "$at_bound" reader.sh
  assert_success
  [ "$(cat "$OUT_DIR"/reader-*.kind)" = pipe ]
  [ "$(wc -c < "$OUT_DIR"/reader-*.bytes | tr -d ' ')" = 32768 ]
  rm -f "$OUT_DIR"/reader-*
  _stage_chain "$over_bound" reader.sh
  assert_success
  [ "$(cat "$OUT_DIR"/reader-*.kind)" = file ]
  [ "$(wc -c < "$OUT_DIR"/reader-*.bytes | tr -d ' ')" = 32769 ]
  _no_stage_in "$STAGE_TMP"
}
