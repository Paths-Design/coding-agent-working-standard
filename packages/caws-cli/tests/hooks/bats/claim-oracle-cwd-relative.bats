#!/usr/bin/env bats
# bash-write-guard.sh + lib/worktree-claim-oracle.cjs — a path's verdict must
# not depend on how the caller spells it, and an unresolvable operating cwd must
# never be answered as if the relative path were known
# (CAWS-DEFECT-CLAIM-ORACLE-CWD-RELATIVE-PATH-01).
#
# The guard resolves a relative mutation target against the payload cwd. When
# that cwd is absent (or names a directory that does not exist) it fell back to
# the canonical root, so a relative target that really meant another worktree's
# file was classified as an unclaimed canonical path and passed. The relative
# spelling carries no answer without a cwd; the guard must ask instead.
#
# The seeded registry has one active worktree, wt-seed, owned by the session
# "owner-session", whose bound spec claims packages/seed/src. Each test drives
# the installed guard with a Bash envelope and asserts exit status and message.

load helpers

setup_file() {
  caws_install_pack_once
  # The installed pack sits in a temp dir where require('js-yaml') cannot
  # resolve, which would degrade every canonical claim check to a skipped
  # advisory. Point node at the repository's modules so the oracle reads the
  # seeded spec for real.
  NODE_PATH="$(cd "$BATS_TEST_DIRNAME/../../../../.." && pwd)/node_modules"
  export NODE_PATH
  # Mutation runs apply one literal replacement to one installed file
  # (CLAIM_MUTATE_FILE is relative to the hooks dir). A FROM absent from that
  # file fails setup, so a mutant that changes nothing cannot "survive". The
  # splice is prefix + TO + suffix: bash 3.2 keeps the quotes of a quoted
  # replacement inside ${body/from/to}.
  if [[ -n "${CLAIM_MUTATE_FROM:-}" ]]; then
    local target="$CAWS_TEST_HOOKS_DIR/${CLAIM_MUTATE_FILE:?}" body from
    from="$CLAIM_MUTATE_FROM"
    body="$(cat "$target")"
    [[ "$body" == *"$from"* ]] || {
      echo "mutation FROM not found in $target" >&2
      return 1
    }
    printf '%s%s%s\n' "${body%%"$from"*}" "${CLAIM_MUTATE_TO:-}" "${body#*"$from"}" >"$target"
  fi
}
teardown_file() {
  caws_teardown_pack
}

WT=wt-seed
CLAIMED_REL="packages/seed/src/a.ts"

_seed() {
  mkdir -p "$CAWS_TEST_REPO/.caws/worktrees/$WT/packages/seed/src" "$CAWS_TEST_REPO/.caws/specs"
  cat >"$CAWS_TEST_REPO/.caws/worktrees.json" <<JSON
{"$WT":{"name":"$WT","spec_id":"SEED-001","path":"$CAWS_TEST_REPO/.caws/worktrees/$WT","owner":{"session_id":"owner-session"},"baseBranch":"main"}}
JSON
  cat >"$CAWS_TEST_REPO/.caws/specs/SEED-001.yaml" <<YAML
id: SEED-001
lifecycle_state: active
worktree: $WT
scope:
  in:
    - packages/seed/src
YAML
}

setup() {
  _seed
  WT_ROOT="$(cd "$CAWS_TEST_REPO/.caws/worktrees/$WT" && pwd -P)"
  REPO_ROOT="$(cd "$CAWS_TEST_REPO" && pwd -P)"
}

# _bwg <session> <cwd|-> <command> — run the guard. cwd "-" omits cwd from the
# payload and from the environment entirely. The surface is BWG_SURFACE
# (default claude-code, a surface whose payload contract carries cwd).
_bwg() {
  local sid="$1" cwd="$2" command="$3" envelope
  if [[ "$cwd" == "-" ]]; then
    envelope="$(jq -nc --arg c "$command" --arg s "$sid" \
      '{tool_name:"Bash", tool_input:{command:$c}, session_id:$s}')"
    run env -u HOOK_CWD NODE_PATH="$NODE_PATH" \
      CAWS_PROJECT_DIR="$CAWS_TEST_REPO" CAWS_AGENT_SURFACE="${BWG_SURFACE:-claude-code}" \
      HOOK_SESSION_ID="$sid" CAWS_GUARD_NO_ASK=0 \
      bash -c "printf '%s' '$envelope' | bash '$CAWS_TEST_HOOKS_DIR/bash-write-guard.sh'"
  else
    envelope="$(jq -nc --arg c "$command" --arg s "$sid" --arg d "$cwd" \
      '{tool_name:"Bash", tool_input:{command:$c}, session_id:$s, cwd:$d}')"
    run env NODE_PATH="$NODE_PATH" \
      CAWS_PROJECT_DIR="$CAWS_TEST_REPO" CAWS_AGENT_SURFACE="${BWG_SURFACE:-claude-code}" \
      HOOK_CWD="$cwd" HOOK_SESSION_ID="$sid" CAWS_GUARD_NO_ASK=0 \
      bash -c "printf '%s' '$envelope' | bash '$CAWS_TEST_HOOKS_DIR/bash-write-guard.sh'"
  fi
  # Runtime artifact for the evidence reader (fd 3 is bats' pass-through).
  echo "# guard[$sid cwd=$cwd] $command => status=$status output=$(printf '%s' "${output:-<empty>}" | tr '\n' ' ')" >&3
}

# --- A1: the owner's own file passes under every spelling --------------------

@test "claim-oracle-cwd: the owner writing its worktree file passes cwd-relative and worktree-absolute alike" {
  _bwg owner-session "$WT_ROOT" "echo x > $CLAIMED_REL"
  assert_success
  assert_output ''
  _bwg owner-session "$WT_ROOT" "echo x > $WT_ROOT/$CLAIMED_REL"
  assert_success
  assert_output ''
}

@test "claim-oracle-cwd: a non-owner is blocked on the cwd-relative spelling of the same worktree file" {
  _bwg other-session "$WT_ROOT" "echo x > $CLAIMED_REL"
  assert_equal "$status" 2
  assert_output --partial "BLOCKED: this Bash command mutates worktree 'wt-seed''s payload"
  _bwg other-session "$WT_ROOT" "echo x > $WT_ROOT/$CLAIMED_REL"
  assert_equal "$status" 2
  assert_output --partial "BLOCKED: this Bash command mutates worktree 'wt-seed''s payload"
}

# --- A2: the cross-lane guard stays armed ------------------------------------

@test "claim-oracle-cwd: a canonical-checkout session writing a path the worktree claims is still blocked" {
  _bwg other-session "$REPO_ROOT" "echo x > $CLAIMED_REL"
  assert_equal "$status" 2
  assert_output --partial "BLOCKED: this Bash command mutates 'wt-seed:packages/seed/src', claimed by an active worktree's scope.in."
}

@test "claim-oracle-cwd: the canonical-absolute spelling of a claimed path is blocked identically" {
  _bwg other-session "$REPO_ROOT" "echo x > $REPO_ROOT/$CLAIMED_REL"
  assert_equal "$status" 2
  assert_output --partial "BLOCKED: this Bash command mutates 'wt-seed:packages/seed/src', claimed by an active worktree's scope.in."
}

# --- A3: an unresolvable cwd fails closed ------------------------------------

# _assert_cwd_ask <relative-path> — the guard answered with a permission ASK
# (exit 0, decision JSON) naming the unresolved cwd and the path.
_assert_cwd_ask() {
  local rel="$1" out="$output" decision reason
  assert_success
  decision="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision')"
  reason="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecisionReason')"
  assert_equal "$decision" "ask"
  [[ "$reason" == *"ask_uncertain: the operating cwd could not be resolved for the relative path '$rel'"* ]] ||
    fail "expected the cwd-unresolved reason for '$rel', got: $reason"
}

@test "claim-oracle-cwd: a relative target with no cwd asks instead of passing as a canonical path" {
  _bwg owner-session - "echo x > scratch.txt"
  _assert_cwd_ask scratch.txt
}

@test "claim-oracle-cwd: a relative target whose cwd names a missing directory asks" {
  _bwg owner-session "$REPO_ROOT/does-not-exist" "echo x > scratch.txt"
  _assert_cwd_ask scratch.txt
}

@test "claim-oracle-cwd: an allowlisted relative path with no cwd still asks (the allowlist cannot be applied to an unknown root)" {
  _bwg owner-session - "echo x > docs/note.txt"
  _assert_cwd_ask docs/note.txt
}

# --- the fail-closed answer is scoped to surfaces whose payload carries cwd ----
#
# On a surface whose contract is unverified (zcode, dsh) an absent cwd is the
# normal case; asking would refuse every relative write there, so those keep
# the prior behavior: the relative target is resolved against the project root
# and adjudicated, with nothing new on stdout.

@test "claim-oracle-cwd: every surface whose payload carries cwd asks on a relative target with no cwd" {
  local surface
  for surface in claude-code codex opencode qwen-code kimi-code; do
    BWG_SURFACE="$surface" _bwg owner-session - "echo x > scratch.txt"
    _assert_cwd_ask scratch.txt
  done
}

@test "claim-oracle-cwd: zcode keeps the prior pass behavior for a relative target with no cwd" {
  BWG_SURFACE=zcode _bwg owner-session - "echo x > scratch.txt"
  assert_success
  assert_output ''
}

@test "claim-oracle-cwd: dsh keeps the prior pass behavior for a relative target with no cwd" {
  BWG_SURFACE=dsh _bwg owner-session - "echo x > scratch.txt"
  assert_success
  assert_output ''
}

@test "claim-oracle-cwd: an unrecognized surface keeps the prior pass behavior and emits no ask" {
  BWG_SURFACE=some-new-harness _bwg owner-session - "echo x > scratch.txt"
  assert_success
  refute_output --partial 'permissionDecision'
  refute_output --partial 'operating cwd could not be resolved'
}

@test "claim-oracle-cwd: zcode with a cwd naming a missing directory keeps the prior pass behavior" {
  BWG_SURFACE=zcode _bwg owner-session "$REPO_ROOT/does-not-exist" "echo x > scratch.txt"
  assert_success
  assert_output ''
}

@test "claim-oracle-cwd: zcode still blocks a foreign-payload target given by absolute path with no cwd" {
  BWG_SURFACE=zcode _bwg other-session - "echo x > $WT_ROOT/$CLAIMED_REL"
  assert_equal "$status" 2
  assert_output --partial "BLOCKED: this Bash command mutates worktree 'wt-seed''s payload"
}

# --- the oracle itself: the unresolved-cwd flag changes only relative answers -

_oracle() {
  run env NODE_PATH="$NODE_PATH" CAWS_ORACLE_PROJECT_DIR="$REPO_ROOT" CAWS_ORACLE_CURRENT_BRANCH="" \
    CAWS_ORACLE_REL_PATH="$1" CAWS_ORACLE_SESSION_ID="owner-session" \
    CAWS_ORACLE_CWD_UNRESOLVED="${2:-}" \
    node "$CAWS_TEST_HOOKS_DIR/lib/worktree-claim-oracle.cjs"
  echo "# oracle[path=$1 cwd_unresolved=${2:-}] => $output" >&3
}

@test "claim-oracle-cwd: the oracle answers ask_uncertain for a relative path when the cwd is flagged unresolved" {
  _oracle scratch.txt 1
  assert_output "ask_uncertain:cwd-unresolved:scratch.txt"
}

@test "claim-oracle-cwd: the oracle keeps its repo-relative reading when the cwd is not flagged" {
  _oracle scratch.txt
  assert_output "pass:unclaimed"
}

@test "claim-oracle-cwd: the oracle ignores the unresolved flag for an absolute path" {
  _oracle "$REPO_ROOT/scratch.txt" 1
  assert_output "pass:unclaimed"
}

@test "claim-oracle-cwd: an absolute target with no cwd is unaffected and adjudicated normally" {
  _bwg owner-session - "echo x > $REPO_ROOT/scratch.txt"
  assert_success
  assert_output ''
}

@test "claim-oracle-cwd: an absolute foreign-payload target with no cwd is still blocked for a non-owner" {
  _bwg other-session - "echo x > $WT_ROOT/$CLAIMED_REL"
  assert_equal "$status" 2
  assert_output --partial "BLOCKED: this Bash command mutates worktree 'wt-seed''s payload"
}

@test "claim-oracle-cwd: a relative target with a resolved cwd is unaffected by the cwd check" {
  _bwg owner-session "$REPO_ROOT" "echo x > scratch.txt"
  assert_success
  assert_output ''
}
