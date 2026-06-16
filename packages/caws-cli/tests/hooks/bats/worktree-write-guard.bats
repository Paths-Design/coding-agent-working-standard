#!/usr/bin/env bats
# worktree-write-guard.sh — cross-worktree scope-claim isolation, now delegating
# the spec-contention check to `caws scope contention` (CAWS-SCOPE-CONTENTION-CMD-001).
#
# The guard's claim/clear/undetermined behavior is proven at the kernel
# (evaluateContention) and CLI (scope contention) layers. These tests pin the
# HOOK-level invariants the slice changes:
#   1. STRUCTURAL: the installed hook carries NO inline js-yaml spec re-parser,
#      DOES delegate to `caws scope contention --json`, and STILL retains its
#      two JSON-only registry reads (IS_REGISTERED_WORKTREE / WT_INFO — out of
#      scope for this slice; they read worktrees.json, not specs).
#   2. TOKEN MAPPING: a stubbed `caws scope contention --json` returning each
#      status (claimed / clear / undetermined) maps onto the guard's existing
#      refusal/advisory behavior (claimed -> block exit 2; clear/undetermined
#      -> not a hard block).

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

GUARD() { echo "$CAWS_TEST_HOOKS_DIR/worktree-write-guard.sh"; }

@test "wt-write-guard: installed hook carries NO inline js-yaml spec re-parser" {
  # grep finding nothing (non-zero exit) IS the success condition.
  run grep -nE "require\\('js-yaml'\\)|require\\(\"js-yaml\"\\)|yaml\\.load" "$(GUARD)"
  assert_failure
}

@test "wt-write-guard: installed hook delegates contention to caws scope contention --json" {
  run grep -c "caws scope contention" "$(GUARD)"
  assert_success
  # one invocation + the doctrine comment line referencing the command
  [ "$output" -ge 1 ]
}

@test "wt-write-guard: the JSON-only registry reads are retained (out of scope for this slice)" {
  run grep -cE "IS_REGISTERED_WORKTREE=\\\$\\(node|WT_INFO=\\\$\\(node" "$(GUARD)"
  assert_success
  assert_output "2"
}

# --- token-mapping via a stubbed `caws scope contention` ---------------------
#
# Drive the installed guard with a stub `caws` on PATH that returns a scripted
# `scope contention --json` payload and a scripted `worktree list`/registry so
# the guard reaches the contention branch. We assert the guard's DISPOSITION
# (hard block vs not) for each contention status, isolating the token mapping
# from real multi-worktree git setup.

_run_guard_with_contention() {
  local rel="$1" json="$2"
  local stubdir
  stubdir="$(mktemp -d "${TMPDIR:-/tmp}/caws-wgstub-XXXXXX")"
  # A registry with one active worktree on the current branch so WT_COUNT>0 and
  # the guard reaches the contention check. The stub `caws` short-circuits the
  # actual contention computation with the scripted JSON.
  mkdir -p "$CAWS_TEST_REPO/.caws/worktrees/wt-x"
  printf '{"wt-x":{"specId":"X-1","baseBranch":"main","path":"%s/.caws/worktrees/wt-x"}}\n' \
    "$CAWS_TEST_REPO" > "$CAWS_TEST_REPO/.caws/worktrees.json"
  cat > "$stubdir/caws" <<STUB
#!/usr/bin/env bash
if [[ "\$1" == "scope" && "\$2" == "contention" ]]; then printf '%s' '${json}'; exit 0; fi
exit 0
STUB
  chmod +x "$stubdir/caws"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    CAWS_GUARD_NO_ASK=1 \
    PATH="$stubdir:$PATH" \
    bash -c "printf '%s' '$(hook_envelope Edit "$rel")' | bash '$(GUARD)'"
  rm -rf "$stubdir"
}

# Disposition is distinguished by the MESSAGE, not the exit code: under
# CAWS_GUARD_NO_ASK=1 a base-branch write falls back to a hard block in every
# case, so the meaningful assertion is WHICH refusal fired — the claimed-path
# contention block (names the owning worktree) vs the generic base-branch
# advisory that explicitly reports the path is NOT claimed / contention undetermined.

@test "wt-write-guard: contention status=claimed -> the worktree-claim refusal fires, naming the worktree" {
  local json='{"path":"packages/owned/x.ts","status":"claimed","claimants":[{"worktreeName":"wt-x","specId":"X-1","matchedPattern":"packages/owned"}]}'
  _run_guard_with_contention "packages/owned/x.ts" "$json"
  assert_equal "$status" 2
  assert_output --partial "wt-x"
  assert_output --partial "claimed by an active worktree"
}

@test "wt-write-guard: contention status=clear -> generic advisory says the path is NOT claimed" {
  local json='{"path":"packages/free/y.ts","status":"clear","claimants":[]}'
  _run_guard_with_contention "packages/free/y.ts" "$json"
  assert_output --partial "No active worktree's scope.in claims this file"
  refute_output --partial "claimed by an active worktree"
}

@test "wt-write-guard: contention status=undetermined -> advisory reports contention undetermined" {
  local json='{"path":"packages/q/z.ts","status":"undetermined","reason":"missing-specId","worktreeName":"wt-x"}'
  _run_guard_with_contention "packages/q/z.ts" "$json"
  assert_output --partial "undetermined"
  refute_output --partial "claimed by an active worktree"
}
