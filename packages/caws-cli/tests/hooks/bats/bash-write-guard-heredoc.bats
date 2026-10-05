#!/usr/bin/env bats
# bash-write-guard.sh + lib/heredoc.sh —
# GUARD-HEREDOC-BODY-READ-AS-COMMAND-001.
#
# A heredoc BODY is payload the command carries, not command text. The guard
# tokenizes the command string to find mutation targets, so before this slice a
# body containing a redirect/tee/rm verb was read as a command and routed to the
# worktree-claim oracle — refusing a command whose only real mutation was the
# file it redirected into.
#
# The neutralization is a SAFELIST, not blanket blanking, because a heredoc fed
# to an interpreter IS code. A2 is the load-bearing test for that direction: if
# someone "simplifies" the helper into blanking every body, A2 must go red.
#
# FALSIFIABILITY NOTE. The control (A1b) uses the FOREIGN WORKTREE PAYLOAD path,
# which blocks yaml-free in this harness. A claim expressed only through a spec's
# scope.in cannot block here (the fixture pack has no resolvable js-yaml, so the
# oracle degrades to allow-with-advisory) — an A1 built on that path would pass
# whether or not body neutralization existed. The control exists to make that
# mistake impossible to ship.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

# A worktree owned by another session. Its payload subtree is the yaml-free
# isolation block: mutating a file beneath it HARD-BLOCKS regardless of js-yaml.
_seed_foreign_worktree() {
  local wt="wt-seed" spec="SEED-001" owner="${1:-other-session}"
  mkdir -p "$CAWS_TEST_REPO/.caws/worktrees/$wt" "$CAWS_TEST_REPO/.caws/specs"
  cat > "$CAWS_TEST_REPO/.caws/worktrees.json" <<JSON
{"$wt":{"name":"$wt","spec_id":"$spec","path":"$CAWS_TEST_REPO/.caws/worktrees/$wt","owner":{"session_id":"$owner"},"baseBranch":"main"}}
JSON
}

_foreign_payload() {
  printf '%s' "$CAWS_TEST_REPO/.caws/worktrees/wt-seed/file.txt"
}

_run_bwg() {
  local command="$1" sid="${2:-my-session}" envelope
  envelope="$(jq -nc --arg c "$command" --arg s "$sid" \
    '{tool_name:"Bash", tool_input:{command:$c}, session_id:$s}')"
  run_guard bash-write-guard.sh "$envelope"
}

_run_blank() {
  local input="$1"
  run bash -c "source '$CAWS_TEST_HOOKS_DIR/lib/heredoc.sh'; caws_blank_heredoc_bodies \"\$1\"" _ "$input"
}

# ── guard-level (end to end through the real oracle) ────────────────────────

@test "A1b control: a redirect to a foreign worktree payload DOES block (the block path is live)" {
  _seed_foreign_worktree
  _run_bwg "echo x > $(_foreign_payload)"
  assert_failure
  assert_output --partial 'BLOCKED'
  assert_output --partial 'wt-seed'
}

@test "A1: the same redirect inside a cat heredoc BODY is not read as a target" {
  _seed_foreign_worktree
  _run_bwg "$(printf 'cat > notes.md <<%s\nDocumenting the old flow: echo x > %s\n%s\n' "'EOF'" "$(_foreign_payload)" EOF)"
  assert_success
  refute_output --partial 'BLOCKED'
}

@test "A1c: the same redirect inside a tee heredoc BODY is not read as a target" {
  _seed_foreign_worktree
  _run_bwg "$(printf 'tee notes.md <<%s\nExample: rm %s\n%s\n' "'EOF'" "$(_foreign_payload)" EOF)"
  assert_success
  refute_output --partial 'BLOCKED'
}

@test "A3: a sibling mutation OUTSIDE the heredoc is still adjudicated (no hiding behind a body)" {
  _seed_foreign_worktree
  _run_bwg "$(printf 'echo x > %s && cat > notes.md <<%s\nharmless\n%s\n' "$(_foreign_payload)" "'EOF'" EOF)"
  assert_failure
  assert_output --partial 'BLOCKED'
}

# ── helper-level (the transformation itself) ────────────────────────────────

@test "A2: an interpreter-fed heredoc keeps its body fully visible (the safelist is not a bypass)" {
  _run_blank "$(printf 'bash <<%s\ngit push --force origin main\n%s\n' "'EOF'" EOF)"
  assert_success
  assert_output --partial 'git push --force origin main'
}

@test "A2b: an unrecognized command's heredoc body stays visible (fail-closed direction)" {
  _run_blank "$(printf 'mystery-tool <<%s\nrm -rf /important\n%s\n' "'EOF'" EOF)"
  assert_success
  assert_output --partial 'rm -rf /important'
}

@test "A4: input with no heredoc is returned byte-identically" {
  _run_blank 'echo hi > f.txt'
  assert_success
  assert_output 'echo hi > f.txt'
}

@test "A4b: an unterminated heredoc is blanked to end-of-input without error" {
  _run_blank "$(printf 'cat > f <<%s\nsecret payload\n' "'EOF'")"
  assert_success
  refute_output --partial 'secret payload'
}

@test "A5: a body line that merely starts with the delimiter does not close the heredoc" {
  _run_blank "$(printf 'cat > f <<%s\nEOFX\nstill body text\n%s\n' "'EOF'" EOF)"
  assert_success
  refute_output --partial 'still body text'
}
