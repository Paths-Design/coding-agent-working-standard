#!/usr/bin/env bats
# CAWS-DEFECT-HOOK-PAYLOAD-ENV-E2BIG-01 — the dispatcher must survive a payload
# larger than the kernel argument-list limit.
#
# Root cause this file pins: parse-input.sh exported the whole sanitized payload
# into the process environment. A multi-megabyte tool response (a base64 image,
# a large command dump) pushed the environment past ARG_MAX, so every fork in
# the dispatch chain failed with `Argument list too long` and surfaced as
# `Required runtime library failed: session-id.sh` — the first fork, not the
# cause. These tests assert the observable contract, not the implementation:
# the dispatch completes, the payload is recoverable byte-for-byte, and the
# inline variables are explicitly marked absent rather than silently partial.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

# Run the installed pre-tool dispatcher with a payload read from a FILE, so a
# multi-megabyte envelope never becomes part of a shell command line.
run_dispatcher_from_file() {
  local payload_file="$1"
  shift
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    "$@" \
    bash -c "cat '$payload_file' | bash '$CAWS_TEST_HOOKS_DIR/dispatch/pre_tool_use.sh'"
}

# Parse an envelope with the installed parser in ONE process and report what the
# transport published. Usage: parse_payload <envelope-file> [extra env k=v]
# Sets $output to the repr line printed by the probe.
parse_payload() {
  local payload_file="$1"
  shift
  local probe="$BATS_TEST_TMPDIR/probe-$$.sh"
  {
    printf '%s\n' 'set -uo pipefail'
    printf '%s\n' "source '$CAWS_TEST_REPO/.caws/hooks/runtime-paths.sh'"
    printf '%s\n' "source '$CAWS_TEST_REPO/.caws/hooks/lib/agent-surface.sh'"
    printf '%s\n' "source '$CAWS_TEST_REPO/.caws/hooks/lib/parse-input.sh'"
    printf '%s\n' "parse_hook_input"
    printf '%s\n' 'printf "payload_file=%s\n" "${HOOK_PAYLOAD_FILE:-}"'
    printf '%s\n' 'printf "truncated=%s\n" "${HOOK_PAYLOAD_TRUNCATED:-}"'
    printf '%s\n' 'printf "inline_input_len=%s\n" "${#HOOK_TOOL_INPUT_JSON}"'
    printf '%s\n' 'printf "inline_response_len=%s\n" "${#HOOK_TOOL_RESPONSE_JSON}"'
    printf '%s\n' 'printf "inline_valid=%s\n" "$(printf "%s" "${HOOK_TOOL_INPUT_JSON}" | jq -er ".command" 2>/dev/null || echo INVALID)"'
    printf '%s\n' 'printf "payload_bytes=%s\n" "$(wc -c < "$HOOK_PAYLOAD_FILE" 2>/dev/null | tr -d " ")"'
    printf '%s\n' 'printf "payload_sha256=%s\n" "$(shasum -a 256 "$HOOK_PAYLOAD_FILE" 2>/dev/null | cut -d" " -f1)"'
    printf '%s\n' 'printf "payload_marker=%s\n" "$(jq -r ".tool_response.marker // empty" "$HOOK_PAYLOAD_FILE" 2>/dev/null)"'
    printf '%s\n' 'printf "tool_name=%s\n" "${HOOK_TOOL_NAME:-}"'
    printf '%s\n' 'printf "command=%s\n" "${HOOK_COMMAND:-}"'
  } > "$probe"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    TMPDIR="$BATS_TEST_TMPDIR" \
    "$@" \
    bash -c "cat '$payload_file' | bash '$probe'"
}

@test "payload transport: a 2MB tool response does not fail the dispatch with E2BIG" {
  local payload_file="$BATS_TEST_TMPDIR/big-envelope.json"
  jq -nc '{tool_name:"Bash", tool_input:{command:"git status"},
    tool_response:{data:("iVBORw0KGgo" + ("A" * 2000000))}}' > "$payload_file"

  run_dispatcher_from_file "$payload_file"

  # The defect's exact signature. Both the kernel message and the machine
  # adapter's downstream "required library failed" promotion must be absent.
  refute_output --partial 'Argument list too long'
  refute_output --partial 'Required runtime library failed'
}

@test "payload transport: a large payload publishes the file and suppresses the inline copies" {
  local payload_file="$BATS_TEST_TMPDIR/large-envelope.json"
  jq -nc '{tool_name:"Bash", tool_input:{command:"git status"},
    tool_response:{data:("B" * 2000000)}}' > "$payload_file"

  parse_payload "$payload_file"

  assert_success
  # A payload file is published, and the truncation marker states that the
  # inline representation is absent by design. Zero-length inline copies are the
  # point: a handler that cannot read the file must not consume a partial value.
  assert_line 'truncated=1'
  assert_line 'inline_input_len=0'
  assert_line 'inline_response_len=0'
  refute_line 'payload_file='
  # Scalar extraction must still work from the file: matcher predicates and
  # guard decisions depend on these, so the fix must not degrade to "no data".
  assert_output --partial 'tool_name=Bash'
  assert_output --partial 'command=git status'
}

@test "payload transport: the published file reproduces the payload byte-for-byte" {
  local marker="CANARY-BYTE-EXACTNESS-0123456789"
  local payload_file="$BATS_TEST_TMPDIR/canary-envelope.json"
  # The parser's sanitizer canonicalizes through json.dumps, so the fixture is
  # written with the same encoder. Byte-exactness then means "no tool content
  # was lost", not "the transport reformatted the envelope".
  python3 - "$payload_file" "$marker" <<'PY'
import json, sys
path, marker = sys.argv[1], sys.argv[2]
payload = {
    "tool_name": "Bash",
    "tool_input": {"command": "git status"},
    "tool_response": {"data": "C" * 2000000, "marker": marker},
}
# Match json.dumps defaults so the parser's re-serialization is identical.
with open(path, "w") as fh:
    fh.write(json.dumps(payload))
PY

  local source_bytes source_sha
  source_bytes="$(wc -c < "$payload_file" | tr -d ' ')"
  source_sha="$(shasum -a 256 "$payload_file" | cut -d' ' -f1)"

  parse_payload "$payload_file"
  assert_success
  # Same length and same digest as the source envelope. A truncation that
  # happened to keep the JSON parseable would fail this, and the marker proves
  # the TAIL of a 2MB response survived rather than only its head.
  assert_line "payload_bytes=$source_bytes"
  assert_line "payload_sha256=$source_sha"
  assert_line "payload_marker=$marker"
}

@test "payload transport: a small payload keeps the historical inline representation" {
  local payload_file="$BATS_TEST_TMPDIR/small-envelope.json"
  jq -nc '{tool_name:"Bash", tool_input:{command:"git status"}}' > "$payload_file"

  parse_payload "$payload_file"

  assert_success
  assert_line 'truncated=0'
  assert_line 'payload_file='
  # Inline mode must preserve the full JSON objects the existing consumers read.
  assert_line 'inline_valid=git status'
  assert_output --partial 'tool_name=Bash'
}

@test "payload transport: a zero inline maximum forces file transport" {
  local payload_file="$BATS_TEST_TMPDIR/forced-envelope.json"
  jq -nc '{tool_name:"Bash", tool_input:{command:"git status"}}' > "$payload_file"

  parse_payload "$payload_file" CAWS_HOOK_INLINE_PAYLOAD_MAX_BYTES=0

  assert_success
  assert_output --partial 'truncated=1'
  assert_output --partial 'tool_name=Bash'
}
