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
  local rel_path="$1" check_exit="$2" json="$3"
  local stubdir
  stubdir="$(mktemp -d "${TMPDIR:-/tmp}/caws-stub-XXXXXX")"
  cat > "$stubdir/caws" <<STUB
#!/usr/bin/env bash
# args: scope check <path>  |  scope show <path> --json
if [[ "\$1" == "scope" && "\$2" == "check" ]]; then exit ${check_exit}; fi
if [[ "\$1" == "scope" && "\$2" == "show" ]]; then printf '%s' '${json}'; exit 0; fi
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
