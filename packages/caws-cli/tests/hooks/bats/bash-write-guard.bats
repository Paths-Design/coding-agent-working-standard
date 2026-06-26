#!/usr/bin/env bats
# bash-write-guard.sh — Bash-mutation worktree-ownership routing via the
# worktree-claim-oracle, with the js-yaml DEGRADE behavior
# (CAWS-HOOKPACK-ORACLE-JSYAML-DEGRADE-001).
#
# When js-yaml is unresolvable in the hook pack, the oracle's cross-worktree
# canonical-claim check cannot run. That is a TOOLCHAIN FAULT, not an ownership
# signal: a benign canonical mutation must be ALLOWED (with a one-line advisory),
# NOT turned into an approval prompt on every mutation. The foreign-worktree-
# PAYLOAD block is yaml-free and must STILL hard-block. These tests drive the
# installed guard with js-yaml made unresolvable via a node --require blocker
# injected through NODE_OPTIONS.

load helpers

setup_file() {
  caws_install_pack_once
  # A node preload that makes require('js-yaml') throw MODULE_NOT_FOUND, so the
  # oracle subprocess behaves as if js-yaml were not installed in the pack.
  CAWS_JSYAML_BLOCKER="$(mktemp -t jsyaml-block.XXXXXX.cjs)"
  cat > "$CAWS_JSYAML_BLOCKER" <<'JS'
const Module = require('module');
const _orig = Module._load;
Module._load = function (request) {
  if (request === 'js-yaml') {
    const e = new Error("Cannot find module 'js-yaml'");
    e.code = 'MODULE_NOT_FOUND';
    throw e;
  }
  return _orig.apply(this, arguments);
};
JS
  export CAWS_JSYAML_BLOCKER
}
teardown_file() {
  caws_teardown_pack
  [[ -n "${CAWS_JSYAML_BLOCKER:-}" ]] && rm -f "$CAWS_JSYAML_BLOCKER"
}

# Seed an active worktree with a bound spec so the oracle's canonical-claim path
# is reached (findClaimants must read spec YAML — which js-yaml-blocked fails).
_seed_active_worktree() {
  local wt="wt-seed" spec="SEED-001" owner="${1:-other-session}"
  mkdir -p "$CAWS_TEST_REPO/.caws/worktrees/$wt" "$CAWS_TEST_REPO/.caws/specs"
  cat > "$CAWS_TEST_REPO/.caws/worktrees.json" <<JSON
{"$wt":{"name":"$wt","spec_id":"$spec","path":"$CAWS_TEST_REPO/.caws/worktrees/$wt","owner":{"session_id":"$owner"},"baseBranch":"main"}}
JSON
  cat > "$CAWS_TEST_REPO/.caws/specs/$spec.yaml" <<YAML
id: $spec
lifecycle_state: active
worktree: $wt
scope:
  in:
    - packages/seed/src
YAML
}

# Run bash-write-guard with js-yaml blocked in the oracle subprocess.
_run_bwg_nojsyaml() {
  local command="$1" sid="${2:-my-session}"
  local envelope
  envelope="$(jq -nc --arg c "$command" --arg s "$sid" \
    '{tool_name:"Bash", tool_input:{command:$c}, session_id:$s}')"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    HOOK_SESSION_ID="$sid" \
    NODE_OPTIONS="--require $CAWS_JSYAML_BLOCKER" \
    CAWS_GUARD_NO_ASK=0 \
    bash -c "printf '%s' '$envelope' | bash '$CAWS_TEST_HOOKS_DIR/bash-write-guard.sh'"
}

# --- A2: benign canonical mutation, js-yaml absent -> ALLOW (exit 0), advisory ---
@test "bash-write-guard: a benign canonical mutation DEGRADES to allow (not ask) when js-yaml is absent (A2)" {
  _seed_active_worktree
  # A redirect mutation onto a canonical, unclaimed path — a target the oracle
  # parses but cannot claim-check without js-yaml.
  _run_bwg_nojsyaml "echo hi > some/canonical/scratch.txt"
  assert_success                                   # exit 0 — the mutation flows
  refute_output --partial 'Approve only if'        # NOT the ask prompt
  assert_output --partial 'cross-worktree scope.in claim check was SKIPPED'  # advisory shown
  assert_output --partial 'toolchain fault'
}

# --- A3: foreign worktree-payload mutation, js-yaml absent -> STILL hard-blocks ---
@test "bash-write-guard: a foreign worktree-payload mutation still HARD-BLOCKS when js-yaml is absent (A3)" {
  _seed_active_worktree "foreign-session"
  # Mutating another session's worktree payload — the yaml-free isolation block.
  _run_bwg_nojsyaml "echo x > $CAWS_TEST_REPO/.caws/worktrees/wt-seed/file.txt" "my-session"
  assert_failure                                   # exit 2 — hard block
  assert_output --partial 'BLOCKED'
  assert_output --partial "wt-seed"
}

# --- read-only command never reaches the oracle (no advisory, clean pass) ---
@test "bash-write-guard: a read-only command is a clean pass even with js-yaml absent (no advisory)" {
  _seed_active_worktree
  _run_bwg_nojsyaml "wc -l some/file.txt"
  assert_success
  refute_output --partial 'SKIPPED'                # never reached the oracle
}

# --- missing load-bearing SHELL lib must fail CLOSED (distinct from js-yaml degrade) ---
# CAWS-HOOK-SOURCE-GUARD-FAIL-SOFT-001. The js-yaml DEGRADE above is about the
# ORACLE subprocess's runtime dep and is a deliberate ALLOW-with-advisory. THIS
# is the prior shell-source defect: `source caws-state.sh 2>/dev/null || exit 0`
# fail-OPEN, run BEFORE the oracle. A missing shell state lib must refuse, not
# silently exit 0 and admit a Bash mutation.

@test "bash-write-guard: with caws-state.sh missing, a Bash mutation does NOT silently admit (exit 0) — fails CLOSED" {
  local envelope
  envelope="$(jq -nc --arg c "echo hi > some/canonical/scratch.txt" --arg s "my-session" \
    '{tool_name:"Bash", tool_input:{command:$c}, session_id:$s}')"
  run_guard_missing_lib bash-write-guard.sh caws-state.sh "$envelope"
  refute [ "$status" -eq 0 ]
  assert_output --partial 'caws-state.sh'
}
