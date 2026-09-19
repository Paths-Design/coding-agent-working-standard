#!/usr/bin/env bats
# scope-guard.sh — kernel-delegated scope enforcement
# (CAWS-SCOPE-SHOW-JSON-CONTRACT-001).
#
# The guard no longer re-parses spec YAML inline. The DECISION comes from
# `caws scope check` (exit 0/1) and the DIAGNOSTIC from `caws scope show --json`
# (the stable contract). These tests assert:
#   1. STRUCTURAL: the installed scope-guard.sh carries NO inline node -e /
#      js-yaml spec re-parser, and DOES delegate to `caws scope show --json`.
#   2. BEHAVIORAL: against a real bound spec in the temp repo, an in-scope Write
#      is admitted (exit 0, silent) and an out-of-scope Write is refused
#      (emits a scope-progression message), driven entirely through the CLI.
#   3. FAIL-CLOSED: a refused path with the CLI unavailable refuses rather than
#      silently admitting — it does not resurrect an inline parser.
#
# Latch/strike state lands inside the sandboxed temp repo (CAWS_PROJECT_DIR),
# never the real session.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

# Run the installed scope-guard with a stub `caws` on PATH that scripts the
# CLI contract (CAWS_STUB_CHECK_EXIT = exit code of `caws scope check`,
# CAWS_STUB_JSON = stdout of `caws scope show … --json`). This isolates the
# hook's CONTRACT-CONSUMPTION from real spec/CLI setup: the slice's behavioral
# claim is "the hook maps the CLI's answer onto admit/refuse", which is exactly
# what the stub exercises. A relative REL_PATH avoids the foreign-repo guard.
_run_scope_guard_with_stub() {
  local rel_path="$1" check_exit="$2" json="$3" show_exit="${4:-0}"
  local stubdir
  stubdir="$(mktemp -d "${TMPDIR:-/tmp}/caws-stub-XXXXXX")"
  cat > "$stubdir/caws" <<STUB
#!/usr/bin/env bash
# args: scope check <path>  |  scope show <path> --json
if [[ "\$1" == "scope" && "\$2" == "check" ]]; then exit ${check_exit}; fi
if [[ "\$1" == "scope" && "\$2" == "show" ]]; then printf '%s' '${json}'; exit ${show_exit}; fi
exit 0
STUB
  chmod +x "$stubdir/caws"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    PATH="$stubdir:$PATH" \
    bash -c "printf '%s' '$(hook_envelope Edit "$rel_path")' | bash '$CAWS_TEST_HOOKS_DIR/scope-guard.sh'"
  rm -rf "$stubdir"
}

@test "scope-guard: installed hook carries NO inline node -e / js-yaml spec re-parser" {
  # The whole point of the slice: the parallel evaluator is gone.
  run grep -nE "node -e|require\\('js-yaml'\\)|yaml\\.load" "$CAWS_TEST_HOOKS_DIR/scope-guard.sh"
  # grep finds the only remaining mentions in the cross-repo block MESSAGE text
  # ("...node -e / python write..."), never an actual `node -e` invocation.
  refute_line --partial "yaml.load"
  refute_line --partial "require('js-yaml')"
}

@test "scope-guard: installed hook delegates the diagnostic to caws scope show --json" {
  run grep -c "caws scope show \"\$REL_PATH\" --json" "$CAWS_TEST_HOOKS_DIR/scope-guard.sh"
  assert_success
  assert_output "1"
}

@test "scope-guard: an in-scope path is admitted (caws scope check exit 0 -> silent exit 0)" {
  # check exit 0 = kernel-authoritative ADMIT; the hook short-circuits.
  _run_scope_guard_with_stub "packages/in/ok.ts" 0 ""
  assert_success
  refute_output --partial 'not in the defined scope'
}

@test "scope-guard: a top-level admitted file stays silent" {
  _run_scope_guard_with_stub "package.json" 0 ""
  assert_success
  assert_output ""
}

@test "scope-guard: a top-level rejected file follows the nested-path scope contract" {
  local json='{"decision":"reject","rule":"scope.reject.scope_out","path":"package.json","bindingState":"bound","mode":"authoritative","boundSpecId":"FIX-1","matchedPattern":"package.json"}'
  _run_scope_guard_with_stub "package.json" 1 "$json"
  assert_output --partial 'out-of-scope'
  assert_output --partial 'FIX-1'
}

@test "scope-guard: a top-level file with unreadable scope diagnostics fails closed" {
  _run_scope_guard_with_stub "package.json" 1 "not json"
  assert_output --partial '"decision": "block"'
  assert_output --partial 'could not render the structured diagnostic'
}

@test "scope-guard: a failed diagnostic command cannot supply an admission" {
  local json='{"decision":"admit","rule":"scope.admit.scope_in","path":"package.json","bindingState":"bound","mode":"authoritative","boundSpecId":"FIX-1"}'
  _run_scope_guard_with_stub "package.json" 1 "$json" 2
  assert_output --partial '"decision": "block"'
  assert_output --partial 'could not render the structured diagnostic'
}

@test "scope-guard: an out-of-scope reject is surfaced from the JSON contract (authoritative)" {
  local json='{"decision":"reject","rule":"scope.reject.scope_out","path":"packages/out/x.ts","bindingState":"bound","mode":"authoritative","boundSpecId":"FIX-1","matchedPattern":"packages/out"}'
  _run_scope_guard_with_stub "packages/out/x.ts" 1 "$json"
  [[ -n "$output" ]]
  assert_output --partial 'out-of-scope'
  assert_output --partial 'packages/out'
}

@test "scope-guard: a not-in-scope reject is surfaced (authoritative, names bound spec)" {
  local json='{"decision":"reject","rule":"scope.reject.root_not_allowed","path":"packages/elsewhere/y.ts","bindingState":"bound","mode":"authoritative","boundSpecId":"FIX-1"}'
  _run_scope_guard_with_stub "packages/elsewhere/y.ts" 1 "$json"
  assert_output --partial 'not in the defined scope'
  assert_output --partial 'FIX-1'
}

@test "scope-guard: a one_sided binding (malformed/missing bound spec) refuses authoritatively" {
  local json='{"decision":"no_authority","rule":"scope.no_authority.binding_one_sided","path":"packages/x/z.ts","bindingState":"one_sided","mode":"union"}'
  _run_scope_guard_with_stub "packages/x/z.ts" 1 "$json"
  assert_output --partial 'did not load'
}

@test "scope-guard: fails closed (hard block) when the JSON diagnostic is unparseable" {
  # check refuses (exit 1) but `scope show --json` returns garbage: the hook must
  # emit a hard block, NOT silently admit and NOT resurrect an inline parser.
  # This exercises the shared _scope_env_block fail-closed path (the same path
  # the missing-`caws` branch uses) deterministically, without fighting the
  # lib-sourcing toolchain deps an isolated PATH would strip.
  _run_scope_guard_with_stub "packages/elsewhere/nope.ts" 1 "this is not json"
  assert_output --partial '"decision": "block"'
  assert_output --partial 'could not render the structured diagnostic'
}

# CAWS-DEFECT-SCOPE-GUARD-FOREIGN-WORKTREE-CONTAINMENT-BYPASS-01. A write into
# ANOTHER repository's linked worktree must take the foreign-repo containment
# block on the first attempt. resolve_worktree_root is a path-shape match, so
# before the fix the foreign worktree was adopted as WORK_DIR, the path went
# worktree-relative, and the guard ran THIS repo's scope evaluation on the OTHER
# repo's file — the strike ramp instead of the hard block. The stub ADMITs on
# purpose: if the containment branch is skipped, the guard exits 0 silently, so
# a silent pass here IS the defect, not a success.
@test "scope-guard: a write into ANOTHER repository's linked worktree is hard-blocked as foreign (no strike ramp)" {
  # Harness file paths are normalized; mktemp under a trailing-slash TMPDIR
  # (macOS) yields `T//caws-…`, which would trip the foreign block on the
  # double slash alone and make this test pass for the wrong reason.
  local foreign
  foreign="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/caws-bats-foreign-XXXXXX")" && pwd)"
  mkdir -p "$foreign/.caws/worktrees/wt-x/src"
  printf 'export const x = 1;\n' > "$foreign/.caws/worktrees/wt-x/src/f.ts"
  _run_scope_guard_with_stub "$foreign/.caws/worktrees/wt-x/src/f.ts" 0 ""
  rm -rf "$foreign"
  assert_equal "$status" 2
  assert_output --partial '"decision": "block"'
  assert_output --partial 'DIFFERENT repository'
  # The block names the foreign repository the worktree belongs to.
  assert_output --partial "linked worktree of $foreign"
  # No strike ramp: the containment block exits before the strike counter.
  refute_output --partial 'strike 1 of 3'
}

# Positive control for the ownership check: a write into one of THIS
# repository's own linked worktrees must still adopt that worktree as WORK_DIR
# and be evaluated worktree-relative. The refusal names `src/f.ts` — not the
# `.caws/worktrees/...` path (which the `.caws/` allow-prefix would silently
# admit) and not a foreign-repository block.
@test "scope-guard: a write into THIS repository's own linked worktree stays worktree-relative (not foreign)" {
  local json='{"decision":"reject","rule":"scope.reject.root_not_allowed","path":"src/f.ts","bindingState":"bound","mode":"authoritative","boundSpecId":"FIX-1"}'
  local own
  own="$(cd "$CAWS_TEST_REPO" && pwd)"
  mkdir -p "$own/.caws/worktrees/wt-own/src"
  printf 'export const x = 1;\n' > "$own/.caws/worktrees/wt-own/src/f.ts"
  _run_scope_guard_with_stub "$own/.caws/worktrees/wt-own/src/f.ts" 1 "$json"
  refute_output --partial 'DIFFERENT repository'
  assert_output --partial "for 'src/f.ts'"
}

# --- CLAIM-ORACLE-DIRECTORY-CONTAINMENT-001 (shell-copy containment) ---------
# scope-guard.sh consumes the shell-embedded matcher in lib/caws-state.sh. It
# must answer the same matrix the oracle .cjs is pinned to by
# tests/hooks/pytest/test_worktree_claim_oracle.py: directory entries claim
# their subtree, the "/" boundary is respected, and an all-slash entry claims
# nothing.

_matcher_verdict() { # $1 = pattern, $2 = path -> prints "true"|"false"
  env -i PATH="$PATH" HOOKS="$CAWS_TEST_HOOKS_DIR" PATTERN="$1" TARGET="$2" bash -c '
    source "$HOOKS/lib/caws-state.sh" >/dev/null 2>&1
    node -e "$CAWS_NODE_GLOB_TO_SCOPE_REGEXP
process.stdout.write(String(globToRegExp(process.env.PATTERN).test(process.env.TARGET)))"
  ' 2>/dev/null
}

@test "scope-glob shell copy: directory entries claim their subtree (CONTAIN A1)" {
  [ "$(_matcher_verdict 'packages/dir/' 'packages/dir/file.py')" = "true" ]
  [ "$(_matcher_verdict 'packages/dir' 'packages/dir/file.py')" = "true" ]
}

@test "scope-glob shell copy: the / boundary is respected (CONTAIN A2)" {
  [ "$(_matcher_verdict 'packages/dir' 'packages/directory/file.py')" = "false" ]
}

@test "scope-glob shell copy: an all-slash entry claims nothing (CONTAIN A3)" {
  [ "$(_matcher_verdict '/' 'packages/dir/file.py')" = "false" ]
}

# ─── FILE_PATH normalization (CAWS-DEFECT-SCOPE-GUARD-FILE-PATH-NOT-NORMALIZED-01)
#
# PROJECT_DIR is `cd && pwd`-normalized at line 234; FILE_PATH was taken from
# the envelope verbatim. Containment then compared a normalized prefix against
# an unnormalized path, so an absolute path INSIDE the governed project could
# fail `$FILE_PATH == $PROJECT_DIR/*` and take the foreign hard block — exit 2,
# "There is no in-band override", for a file in the agent's own repo.
#
# The file already states the rule it failed to apply: owned_worktree_root()
# says "Compare like with like" and normalizes its candidate. This applies the
# same rule to FILE_PATH.
#
# The oracle is the BLOCK TEXT, not the exit status: an admitted Write exits 0
# silently, and so does a guard that skipped the branch for an unrelated reason
# — so every arm asserts on 'DIFFERENT repository' presence or absence.

@test "scope-guard: an in-repo path with a REDUNDANT SEPARATOR is not foreign" {
  # The reported reproduction: a TMPDIR ending in '/' yields '…/T//repo/x.ts'.
  # Lexically that is the same file; to the unfixed prefix test it was another
  # repository.
  _run_scope_guard_with_stub "$CAWS_TEST_REPO//src/app.ts" 0 ""
  refute_output --partial 'DIFFERENT repository'
  assert_equal "$status" 0
}

@test "scope-guard: an in-repo path with '.' and '..' segments is not foreign" {
  # Resolves back inside the project, so it must be adjudicated on its merits.
  _run_scope_guard_with_stub "$CAWS_TEST_REPO/./src/../src/app.ts" 0 ""
  refute_output --partial 'DIFFERENT repository'
  assert_equal "$status" 0
}

@test "scope-guard: normalization does not require the target to EXIST" {
  # A Write creates a file that is not on disk yet, and may create its parent
  # too. A resolution strategy depending on the path existing would fail on
  # exactly the tool this guard must govern.
  _run_scope_guard_with_stub "$CAWS_TEST_REPO//does/not/exist/yet.ts" 0 ""
  refute_output --partial 'DIFFERENT repository'
  assert_equal "$status" 0
}

@test "scope-guard: a normalized in-repo path is still REFUSED when the kernel refuses" {
  # Non-vacuity for the three arms above. They assert the foreign branch is
  # skipped; this proves skipping it does not admit everything — the path still
  # reaches the kernel decision and a refusal still refuses.
  _run_scope_guard_with_stub "$CAWS_TEST_REPO//src/app.ts" 1 \
    '{"decision":"refuse","reason":"not in the defined scope","spec":"TEST-001"}'
  refute_output --partial 'DIFFERENT repository'
  assert_output --partial 'not in the defined scope'
}

@test "scope-guard: '..' that ESCAPES the project is still foreign after normalization" {
  # The containment half of the invariant: the fix may only NARROW the foreign
  # set. A path that resolves outside must still take the hard block, and
  # normalization is what makes this case DETECTABLE rather than a string
  # comparison that happened to fail.
  local outside
  outside="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/caws-bats-outside-XXXXXX")" && pwd)"
  mkdir -p "$outside/src"
  _run_scope_guard_with_stub "$CAWS_TEST_REPO/../$(basename "$outside")/src/f.ts" 0 ""
  rm -rf "$outside"
  assert_equal "$status" 2
  assert_output --partial 'DIFFERENT repository'
}

@test "scope-guard: a foreign path with a redundant separator is still foreign" {
  # The other direction of the same invariant: normalization must not turn a
  # genuinely foreign path into an in-repo one. This is the arm that would fail
  # if the fix collapsed separators by, say, stripping the project prefix
  # loosely instead of comparing normalized absolute paths.
  local foreign
  foreign="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/caws-bats-foreign2-XXXXXX")" && pwd)"
  mkdir -p "$foreign/src"
  _run_scope_guard_with_stub "$foreign//src/f.ts" 0 ""
  rm -rf "$foreign"
  assert_equal "$status" 2
  assert_output --partial 'DIFFERENT repository'
}
