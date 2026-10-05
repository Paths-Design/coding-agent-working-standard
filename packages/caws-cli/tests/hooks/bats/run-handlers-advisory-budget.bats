#!/usr/bin/env bats
# CAWS-HOOK-ADVISORY-BUDGET-TIERS-01 — advisory composition must not let one
# oversized card starve every later handler.
#
# The previous composer measured the CUMULATIVE candidate context against the
# budget: when one card pushed that total past the budget it was omitted whole,
# and because the total never shrank, every subsequent handler's advisory was
# dropped for that invocation too. These tests pin the replacement contract:
# admit per card against the bytes still available, truncate-to-fit with an
# explicit elided-byte marker, LEAVE ROOM for the cards behind this one, report
# each card's OWN size when declining, and never truncate a control decision.
#
# The first cut of this fix passed a two-card test while still starving the third
# card (truncation consumed the entire remaining budget). An adversarial review
# caught it, so the suite now asserts a THREE-card chain and the kept/elided
# arithmetic rather than only "card 2 was not dropped".

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

teardown() {
  if [[ -n "${_alignment_root:-}" && -z "${CAWS_TEST_ARTIFACT_DIR:-}" ]]; then
    rm -rf "$_alignment_root"
  fi
}

# Compose a chain of stub handlers and report what the composer emitted.
# Usage: compose <card-bytes>... [BUDGET=<bytes>]
# Each positional argument is one handler emitting a card of that many bytes of
# a repeated letter unique to its position: card 0 emits 'A'*n, card 1 'B'*n, …
compose() {
  local fake_hooks budget
  fake_hooks="$(mktemp -d "${TMPDIR:-/tmp}/caws-bats-rh-XXXXXX")"
  budget="${BUDGET:-32768}"
  local i=0 entries=""
  local letters=(A B C D E F)
  for size in "$@"; do
    local letter="${letters[$i]}"
    cat > "$fake_hooks/card-$i.sh" <<EOF
#!/usr/bin/env bash
cat >/dev/null
python3 -c 'import json; print(json.dumps({"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"$letter"*$size}}))'
EOF
    chmod +x "$fake_hooks/card-$i.sh"
    entries="$entries card-$i.sh"
    i=$((i + 1))
  done
  run env -i PATH="$PATH" CAWS_HOOK_ADVISORY_BUDGET_BYTES="$budget" bash -c "
    source '$CAWS_TEST_HOOKS_DIR/lib/run-handlers.sh'
    export HOOKS_DIR='$fake_hooks' HOOK_INPUT_JSON='{}'
    out=\"\$(run_handlers${entries})\"
    # Measure the composed context itself; jq adds a trailing newline.
    ctx=\"\$(printf '%s' \"\$out\" | jq -r '.hookSpecificOutput.additionalContext')\"
    printf 'composed_bytes=%s\n' \"\$(printf '%s' \"\$ctx\" | wc -c | tr -d ' ')\"
    for L in A B C D E; do
      printf 'has_%s=%s\n' \"\$L\" \"\$(printf '%s' \"\$ctx\" | grep -c \"\$L\" || true)\"
    done
    printf '%s' \"\$out\"
  "
  rm -rf "$fake_hooks"
}

# The composed byte count reported by the last compose call.
composed_bytes() {
  printf '%s' "$output" | sed -n 's/^composed_bytes=//p' | tail -1
}

@test "advisory budget: an oversized second card is truncated to fit, not dropped" {
  BUDGET=2000 compose 1500 1500

  # The defect dropped card 2 whole and blamed "whole-card budget 3002".
  refute_output --partial 'whole-card budget'
  assert_output --partial 'advisory truncated'
  local composed
  composed="$(composed_bytes)"
  (( composed <= 2000 )) || fail "composed $composed bytes exceeds the 2000 budget"
}

@test "advisory budget: truncation leaves room so a THIRD card is still admitted" {
  # The starvation class this slice exists to remove. 1000+2000+1000 EXACTLY fits
  # the 3000-byte budget, yet greedy admission starves card 3: card 1 fits whole,
  # card 2 is oversized and used to take every remaining byte, leaving card 3
  # nothing. With a per-card share cap the oversized card is bounded and all three
  # are represented. A two-card test cannot see this.
  BUDGET=3000 compose 1000 2000 1000

  assert_line 'has_A=1'
  assert_line 'has_B=1'
  assert_line 'has_C=1'
  local composed
  composed="$(composed_bytes)"
  (( composed <= 3000 )) || fail "composed $composed bytes exceeds the 3000 budget"
}

@test "advisory budget: a card larger than the whole budget is admitted truncated with honest arithmetic" {
  BUDGET=1000 compose 9000

  assert_output --partial 'advisory truncated'
  # kept + elided must reconstruct the original card size exactly.
  local line kept elided
  line="$(printf '%s' "$output" | grep -o 'card [0-9]* bytes = [0-9]* kept + [0-9]* elided' | tail -1)"
  [[ -n "$line" ]] || fail "no kept/elided diagnostic: $line"
  kept="$(printf '%s' "$line" | sed -n 's/.*= \([0-9]*\) kept.*/\1/p')"
  elided="$(printf '%s' "$line" | sed -n 's/.*+ \([0-9]*\) elided.*/\1/p')"
  (( kept + elided == 9000 )) || fail "kept $kept + elided $elided != 9000"
  local composed
  composed="$(composed_bytes)"
  (( composed <= 1000 )) || fail "composed $composed bytes exceeds the 1000 budget"
}

@test "advisory budget: multi-byte content does not overshoot the byte budget" {
  local fake_hooks
  fake_hooks="$(mktemp -d "${TMPDIR:-/tmp}/caws-bats-rh-utf8-XXXXXX")"
  # 400 emoji at 4 bytes each = 1600 bytes. A character-indexed cut would emit
  # hundreds of characters, far over the byte budget; the composer must measure
  # and cut in bytes. The budget is deliberately large enough that a card IS
  # emitted: a budget that emits nothing would pass this test vacuously.
  cat > "$fake_hooks/utf8.sh" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
python3 -c 'import json; print(json.dumps({"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":chr(0x1F600)*400}}))'
EOF
  chmod +x "$fake_hooks/utf8.sh"

  run env -i PATH="$PATH" LC_ALL=en_US.UTF-8 CAWS_HOOK_ADVISORY_BUDGET_BYTES=600 bash -c "
    source '$CAWS_TEST_HOOKS_DIR/lib/run-handlers.sh'
    export HOOKS_DIR='$fake_hooks' HOOK_INPUT_JSON='{}'
    out=\"\$(run_handlers utf8.sh)\"
    ctx=\"\$(printf '%s' \"\$out\" | jq -r '.hookSpecificOutput.additionalContext // empty')\"
    printf 'composed_bytes=%s\n' \"\$(printf '%s' \"\$ctx\" | wc -c | tr -d ' ')\"
    printf 'content_present=%s\n' \"\$(printf '%s' \"\$ctx\" | grep -c '😀' || true)\"
    printf 'replacement_char=%s\n' \"\$(printf '%s' \"\$ctx\" | grep -c $'\\xef\\xbf\\xbd' || true)\"
  "
  rm -rf "$fake_hooks"

  # Truncation must keep real content, not strip the card to nothing.
  assert_line 'content_present=1'
  local composed
  composed="$(composed_bytes)"
  (( composed <= 600 )) || fail "composed $composed bytes exceeds the 600 budget"
  # A multi-byte character must not be split into a replacement character.
  assert_line 'replacement_char=0'
}

@test "advisory budget: the byte cut is character-aligned and reconstructs the card" {
  # Regression guard for two coupled defects an adversarial review found in the
  # first byte-cut revision: (1) the walk-back statement had been joined onto
  # the assignment line, so it became an env prefix to a missing command and
  # never ran, emitting a split character; (2) the walk-back predicate stripped
  # COMPLETE characters rather than only continuation bytes, yielding a
  # marker-only card. These checks fail if either returns: a replacement
  # character means the walk-back did not run, and a body that is not a byte
  # prefix of the source means the cut split a character.
  local fake_hooks
  local artifact_parent="${CAWS_TEST_ARTIFACT_DIR:-${TMPDIR:-/tmp}}"
  mkdir -p "$artifact_parent"
  fake_hooks="$(mktemp -d "$artifact_parent/caws-bats-rh-align-XXXXXX")"
  _alignment_root="$fake_hooks"
  cat > "$fake_hooks/utf8.sh" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
python3 -c 'import json; print(json.dumps({"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":chr(0x1F600)*400}}))'
EOF
  chmod +x "$fake_hooks/utf8.sh"

  # Sweep adjacent budgets across several complete characters. The composer
  # reserves room for other cards, so the whole budget is not the helper's
  # byte limit; three adjacent whole budgets can produce the same prefix.
  local budget
  for budget in {600..620}; do
    run env -i PATH="$PATH" LC_ALL=en_US.UTF-8 CAWS_HOOK_ADVISORY_BUDGET_BYTES="$budget" bash -c "
      source '$CAWS_TEST_HOOKS_DIR/lib/run-handlers.sh'
      export HOOKS_DIR='$fake_hooks' HOOK_INPUT_JSON='{}'
      out=\"\$(run_handlers utf8.sh)\"
      printf '%s' \"\$out\" > '$fake_hooks/budget-$budget.json'
      printf '%s' \"\$out\" | jq -j '.hookSpecificOutput.additionalContext // empty' > '$fake_hooks/budget-$budget.context'
    " 2>"$fake_hooks/budget-$budget.stderr"
    assert_success
    # Read exact bytes from the artifact. A line-prefixed Base64 transport
    # loses all but the first line on platforms whose encoder wraps output.
    python3 - "$budget" "$fake_hooks/budget-$budget.context" <<'PY' >"$fake_hooks/budget-$budget.assertion.json" || fail "budget $budget: alignment/reconstruction check failed; artifacts: $fake_hooks"
import hashlib, json, pathlib, re, sys
budget = int(sys.argv[1])
raw = pathlib.Path(sys.argv[2]).read_bytes()
ctx = raw.decode("utf-8", "strict")
orig = "\U0001F600" * 400
emitted = len(ctx.encode("utf-8"))
assert emitted <= budget, f"emitted {emitted} exceeds budget {budget}"
assert "\ufffd" not in ctx, "replacement character present (walk-back did not run)"
assert "[truncated:" in ctx, "no truncation marker"
match = re.fullmatch(r"(.+)\u2026 \[truncated: ([0-9]+) bytes elided\]", ctx, re.S)
assert match, "malformed truncation marker"
body = match[1]
assert body, "marker-only card: no content kept"
assert orig.encode("utf-8").startswith(body.encode("utf-8")), (
    "kept body is not a byte prefix of the card: the cut split a character"
)
assert len(body.encode()) + int(match[2]) == len(orig.encode()), "kept/elided arithmetic lost bytes"
print(json.dumps({"budget": budget, "emitted": emitted, "body_bytes": len(body.encode()),
                  "aligned": True, "sha256": hashlib.sha256(raw).hexdigest()}))
PY
  done
}

@test "advisory budget: a declined card reports its OWN size, not a cumulative total" {
  # 900 + 900 against 1000: card 1 fits, card 2 cannot fit meaningfully.
  BUDGET=1000 compose 900 900

  if printf '%s' "$output" | grep -q 'optional advisory omitted'; then
    # The old message printed the cumulative candidate (1802). The new one names
    # the offending card so an operator can tell which guard is too large.
    assert_output --partial 'card 900 bytes'
    refute_output --partial 'whole-card budget'
  else
    assert_output --partial 'advisory truncated'
  fi
}

@test "advisory budget: a hard control decision is forwarded verbatim, never truncated" {
  local fake_hooks
  fake_hooks="$(mktemp -d "${TMPDIR:-/tmp}/caws-bats-rh-block-XXXXXX")"
  # `decision: block` is the shared-core control vocabulary (priority 3).
  # `permissionDecision: deny` reaches that priority only through the codex
  # override, so codex-surface coverage owns that form.
  cat > "$fake_hooks/block.sh" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
printf '%s\n' '{"decision":"block","reason":"BLOCKED-BY-CONTROL-DECISION"}'
EOF
  chmod +x "$fake_hooks/block.sh"

  run env -i PATH="$PATH" CAWS_HOOK_ADVISORY_BUDGET_BYTES=4000 bash -c "
    source '$CAWS_TEST_HOOKS_DIR/lib/run-handlers.sh'
    export HOOKS_DIR='$fake_hooks' HOOK_INPUT_JSON='{}'
    run_handlers --short-circuit-on-block block.sh
    printf 'rc=%d\n' \"\$?\"
  "
  rm -rf "$fake_hooks"

  assert_output --partial 'BLOCKED-BY-CONTROL-DECISION'
  assert_output --partial 'rc=2'
  refute_output --partial 'truncated'
}

@test "advisory budget: a helper emitting an invalid byte is rejected, not composed" {
  # An adversarial review broke the earlier validation with a stub interpreter
  # that emitted a single invalid byte (0xF0). That response is bounded,
  # non-empty, and a byte prefix of the source, so only a UTF-8 validity check
  # catches it. The composer must omit the card rather than let a replacement
  # character into an advisory an agent reads.
  local fake_hooks
  fake_hooks="$(mktemp -d "${TMPDIR:-/tmp}/caws-bats-rh-utf8bad-XXXXXX")"
  cat > "$fake_hooks/utf8.sh" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
python3 -c 'import json; print(json.dumps({"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":chr(0x1F600)*400}}))'
EOF
  chmod +x "$fake_hooks/utf8.sh"

  run env -i PATH="$PATH" LC_ALL=en_US.UTF-8 CAWS_HOOK_ADVISORY_BUDGET_BYTES=1000 bash -c "
    source '$CAWS_TEST_HOOKS_DIR/lib/run-handlers.sh'
    # A stub interpreter that emits one invalid UTF-8 byte.
    python3() { printf '\360'; return 0; }
    export HOOKS_DIR='$fake_hooks' HOOK_INPUT_JSON='{}'
    out=\"\$(run_handlers utf8.sh 2>/dev/null)\"
    ctx=\"\$(printf '%s' \"\$out\" | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null)\"
    printf 'replacement=%s\n' \"\$(printf '%s' \"\$ctx\" | grep -c $'\\xef\\xbf\\xbd' || true)\"
  "
  rm -rf "$fake_hooks"

  assert_line 'replacement=0'
}

@test "advisory budget: an empty truncation result omits the card instead of a marker alone" {
  # A helper that produces nothing (failure, or a limit below one character)
  # must not be turned into a card whose entire body is the elision marker. The
  # assertion is on BOTH the absence of a marker and the presence of the
  # omission diagnostic, so removing the zero-output guard fails this test.
  local fake_hooks
  fake_hooks="$(mktemp -d "${TMPDIR:-/tmp}/caws-bats-rh-empty-XXXXXX")"
  cat > "$fake_hooks/utf8.sh" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
python3 -c 'import json; print(json.dumps({"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":chr(0x1F600)*400}}))'
EOF
  chmod +x "$fake_hooks/utf8.sh"

  run env -i PATH="$PATH" LC_ALL=en_US.UTF-8 CAWS_HOOK_ADVISORY_BUDGET_BYTES=1000 bash -c "
    source '$CAWS_TEST_HOOKS_DIR/lib/run-handlers.sh'
    # A stub interpreter that succeeds but emits nothing.
    python3() { cat >/dev/null; return 0; }
    export HOOKS_DIR='$fake_hooks' HOOK_INPUT_JSON='{}'
    out=\"\$(run_handlers utf8.sh 2>&1)\"
    ctx=\"\$(printf '%s' \"\$out\" | tail -1 | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null)\"
    printf 'ctx_bytes=%s\n' \"\$(printf '%s' \"\$ctx\" | wc -c | tr -d ' ')\"
    printf 'marker_count=%s\n' \"\$(printf '%s' \"\$out\" | grep -c 'truncated:' || true)\"
    printf 'omitted_count=%s\n' \"\$(printf '%s' \"\$out\" | grep -c 'optional advisory omitted' || true)\"
  "
  rm -rf "$fake_hooks"

  # No composed content, no marker, and the omission is reported.
  assert_line 'ctx_bytes=0'
  assert_line 'marker_count=0'
  assert_line 'omitted_count=1'
}

@test "advisory budget: a budget too small for content declines instead of emitting a bare marker" {
  BUDGET=40 compose 5000

  # 40 bytes cannot hold a truncation marker plus content, so the composer must
  # decline rather than emit marker-only text or exceed the budget.
  assert_output --partial 'optional advisory omitted'
  refute_output --partial 'advisory truncated'
  local composed
  composed="$(composed_bytes)"
  (( composed <= 40 )) || fail "composed $composed bytes exceeds the 40 budget"
}
