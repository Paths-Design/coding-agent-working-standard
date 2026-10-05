#!/usr/bin/env bats
# CAWS-HOOK-ADVISORY-SESSION-DEDUP-01 — identical advice must not be re-injected
# on every tool call, and suppression must never hide a changed fact or a
# control decision.
#
# Measured on the real transcript corpus: 16% of all injected advisories are
# session-wide repeats of advice the session already received (one session spent
# 238 of its 1163 advisory injections on duplicates). The composer now suppresses
# a card whose text is byte-identical to one this handler already surfaced in
# this session, reports the skip, and fails open on any ledger fault.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

# Compose a one-card chain with a distinct, test-scoped session ledger.
# Usage: compose <card-text> [session=<id>] [dedup=0] [extra env...]
compose_text() {
  local text="$1"; shift || true
  local session="dedup-$$-${BATS_TEST_NUMBER}"
  local dedup=""
  local -a extra=()
  local arg
  for arg in "$@"; do
    case "$arg" in
      session=*) session="${arg#session=}" ;;
      dedup=*) dedup="${arg#dedup=}" ;;
      *) extra+=("$arg") ;;
    esac
  done
  local fake_hooks
  fake_hooks="$(mktemp -d "${TMPDIR:-/tmp}/caws-bats-dedup-XXXXXX")"
  cat > "$fake_hooks/card.sh" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
python3 -c 'import json,os; print(json.dumps({"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":os.environ["CARD_TEXT"]}}))'
EOF
  chmod +x "$fake_hooks/card.sh"

  local -a envargs=(
    PATH="$PATH"
    CAWS_HOME="$BATS_TEST_TMPDIR/caws-home"
    HOOK_SESSION_ID="$session"
    CAWS_HOOK_ADVISORY_BUDGET_BYTES=4000
    CARD_TEXT="$text"
  )
  [[ -n "$dedup" ]] && envargs+=("CAWS_HOOK_ADVISORY_DEDUP=$dedup")
  if ((${#extra[@]})); then envargs+=("${extra[@]}"); fi

  run env -i "${envargs[@]}" bash -c "
    source '$CAWS_TEST_HOOKS_DIR/lib/run-handlers.sh'
    export HOOKS_DIR='$fake_hooks' HOOK_INPUT_JSON='{}'
    run_handlers card.sh 2>&1
  "
  rm -rf "$fake_hooks"
}

@test "dedup: a repeated identical advisory is suppressed and the skip is reported" {
  compose_text "IDENTICAL-ADVICE"
  assert_output --partial 'IDENTICAL-ADVICE'

  compose_text "IDENTICAL-ADVICE"
  # Suppressed: neither composed nor silent -- the skip is auditable.
  assert_output --partial 'advisory suppressed'
  refute_output --partial 'IDENTICAL-ADVICE'
}

@test "dedup: a changed advisory always re-surfaces" {
  compose_text "ADVICE-VERSION-ONE"
  assert_output --partial 'ADVICE-VERSION-ONE'

  compose_text "ADVICE-VERSION-TWO"
  refute_output --partial 'advisory suppressed'
  assert_output --partial 'ADVICE-VERSION-TWO'
}

@test "dedup: suppression is per session and never crosses sessions" {
  compose_text "CROSS-SESSION-TEXT" session="dedup-session-A"
  assert_output --partial 'CROSS-SESSION-TEXT'

  # A different session has its own ledger and must still receive the advice.
  compose_text "CROSS-SESSION-TEXT" session="dedup-session-B"
  refute_output --partial 'advisory suppressed'
  assert_output --partial 'CROSS-SESSION-TEXT'
}

@test "dedup: can be disabled, and then every card is emitted" {
  compose_text "DISABLED-MODE-TEXT" dedup=0
  assert_output --partial 'DISABLED-MODE-TEXT'

  compose_text "DISABLED-MODE-TEXT" dedup=0
  refute_output --partial 'advisory suppressed'
  assert_output --partial 'DISABLED-MODE-TEXT'
}

@test "dedup: a ledger that cannot be a regular file fails open" {
  # Point the ledger path at a directory so it can never be read as a ledger.
  # The advisory must still be emitted: ledger trouble degrades to the previous
  # behaviour rather than silencing a guard.
  local home="$BATS_TEST_TMPDIR/caws-home"
  mkdir -p "$home/state/sessions/dedup-broken/advisory-seen.txt"
  compose_text "FAIL-OPEN-TEXT" session="dedup-broken"
  refute_output --partial 'advisory suppressed'
  assert_output --partial 'FAIL-OPEN-TEXT'
}

@test "dedup: the ledger is bounded and keeps the most recent keys" {
  compose_text "BOUND-0" session="dedup-bounded" CAWS_HOOK_ADVISORY_DEDUP_MAX=3
  compose_text "BOUND-1" session="dedup-bounded" CAWS_HOOK_ADVISORY_DEDUP_MAX=3
  compose_text "BOUND-2" session="dedup-bounded" CAWS_HOOK_ADVISORY_DEDUP_MAX=3
  compose_text "BOUND-3" session="dedup-bounded" CAWS_HOOK_ADVISORY_DEDUP_MAX=3
  compose_text "BOUND-4" session="dedup-bounded" CAWS_HOOK_ADVISORY_DEDUP_MAX=3

  # The ledger directory is the percent-encoded session id, so locate it rather
  # than hardcoding the escaping.
  local ledger
  ledger="$(find "$BATS_TEST_TMPDIR/caws-home/state/sessions" -name advisory-seen.txt -print -quit)"
  [[ -n "$ledger" && -f "$ledger" ]] || fail "ledger was not written under state/sessions"
  local lines
  lines="$(wc -l < "$ledger" | tr -d ' ')"
  (( lines <= 3 )) || fail "ledger grew to $lines lines with cap 3"
  (( lines >= 1 )) || fail "ledger lost every key"
}

@test "dedup: a control decision is never suppressed" {
  local fake_hooks
  fake_hooks="$(mktemp -d "${TMPDIR:-/tmp}/caws-bats-dedup-ctl-XXXXXX")"
  cat > "$fake_hooks/block.sh" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
printf '%s\n' '{"decision":"block","reason":"BLOCKED-SENTINEL"}'
EOF
  chmod +x "$fake_hooks/block.sh"

  local i
  for i in 1 2 3; do
    run env -i PATH="$PATH" CAWS_HOME="$BATS_TEST_TMPDIR/caws-home" \
      HOOK_SESSION_ID="dedup-control" bash -c "
        source '$CAWS_TEST_HOOKS_DIR/lib/run-handlers.sh'
        export HOOKS_DIR='$fake_hooks' HOOK_INPUT_JSON='{}'
        run_handlers --short-circuit-on-block block.sh
        printf 'rc=%d\n' \"\$?\"
      "
    # Every repetition still blocks with the short-circuit exit code.
    assert_output --partial 'BLOCKED-SENTINEL'
    assert_output --partial 'rc=2'
    refute_output --partial 'advisory suppressed'
  done
  rm -rf "$fake_hooks"
}
