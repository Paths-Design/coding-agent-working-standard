#!/usr/bin/env bats
# local-chain.sh — the compiled chain sidecar for project-wired surfaces.
#
# CAWS-REPO-HOOK-POLICY-PROJECT-WIRED-01. Machine-routed surfaces (claude-code,
# codex) resolve their handler chain through the launcher and can read a repo
# policy; project-wired surfaces (qwen-code, kimi-code, opencode, zcode, dsh)
# exec dispatch/<event>.sh directly with a literal HANDLERS array baked in at
# init time. Without this lib a repo's committed policy would govern two
# harnesses and silently not the other five.
#
# The fail posture is deliberately ASYMMETRIC and both halves are pinned here:
# an ABSENT sidecar degrades to the stock array (a repo that never opts in pays
# nothing), while a MALFORMED sidecar blocks with exit 2 rather than running a
# partial guard chain — dropping the line you could not parse is precisely how
# a guard silently stops running.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

setup() {
  DISPATCH="$CAWS_TEST_HOOKS_DIR/dispatch"
  mkdir -p "$DISPATCH"
  rm -f "$DISPATCH"/*.chain
}

teardown() {
  rm -f "$DISPATCH"/*.chain
}

# Drive the lib directly: source it, call caws_local_chain, print the result.
# Runs in a subshell so an `exit 2` from the refusal path is observable as a
# status rather than killing the test run.
run_chain() {
  local event="$1"
  run bash -c "
    set -uo pipefail
    export CAWS_HOOKS_DIR='$CAWS_TEST_HOOKS_DIR'
    export CAWS_PROJECT_DIR='$CAWS_TEST_REPO'
    source '$CAWS_TEST_HOOKS_DIR/lib/local-chain.sh'
    if caws_local_chain '$event'; then
      printf 'CHAIN:%s\n' \"\${CAWS_LOCAL_CHAIN[*]:-}\"
      printf 'OVERRIDE:%s\n' \"\$(caws_local_chain_override scope-guard.sh)\"
    else
      printf 'NOCHAIN\n'
    fi
  "
}

write_chain() {
  local event="$1"; shift
  printf '# caws hook chain v1 surface=opencode event=%s policy-sha256=abc pack=83\n' "$event" \
    > "$DISPATCH/$event.chain"
  local line
  for line in "$@"; do
    printf '%s\n' "$line" >> "$DISPATCH/$event.chain"
  done
}

@test "local-chain: an ABSENT sidecar returns non-zero so the caller keeps its stock array" {
  run_chain pre_tool_use
  assert_success
  assert_output --partial 'NOCHAIN'
}

@test "local-chain: a compiled sidecar yields the declared sequence in order" {
  # Order IS the semantics: a guard spliced into the wrong position adjudicates
  # against different state than the one it was meant to precede.
  write_chain pre_tool_use 'block-dangerous.sh' 'scope-guard.sh' 'protected-paths.sh'
  run_chain pre_tool_use
  assert_success
  assert_output --partial 'CHAIN:block-dangerous.sh scope-guard.sh protected-paths.sh'
}

@test "local-chain: an override target resolves against the project dir" {
  write_chain pre_tool_use "$(printf 'scope-guard.sh\t.caws/hooks/ext/scope-guard.local.sh')"
  run_chain pre_tool_use
  assert_success
  assert_output --partial "OVERRIDE:$CAWS_TEST_REPO/.caws/hooks/ext/scope-guard.local.sh"
}

@test "local-chain: a handler with no override reports an EMPTY override, not a stale one" {
  # Discrimination control for the arm above: without it, the override lookup
  # could return a constant and both tests would still pass.
  write_chain pre_tool_use 'scope-guard.sh'
  run_chain pre_tool_use
  assert_success
  assert_output --partial 'OVERRIDE:'
  refute_output --partial 'OVERRIDE:/'
}

@test "local-chain: an entry carrying arguments is admitted" {
  write_chain stop 'session-log.sh stop'
  run_chain stop
  assert_success
  assert_output --partial 'CHAIN:session-log.sh stop'
}

@test "local-chain: a sidecar with no version header is REFUSED, not treated as a chain" {
  # Without the header check, any file that happened to land at this path would
  # be read as a guard chain.
  printf 'scope-guard.sh\n' > "$DISPATCH/pre_tool_use.chain"
  run_chain pre_tool_use
  assert_failure 2
  assert_output --partial 'caws hook chain v1'
}

@test "local-chain: a malformed handler token BLOCKS with exit 2 rather than skipping the line" {
  write_chain pre_tool_use 'not-a-shell-script'
  run_chain pre_tool_use
  assert_failure 2
  assert_output --partial 'malformed handler entry'
  assert_output --partial '"decision":"block"'
}

@test "local-chain: an ABSOLUTE override target is refused" {
  # A committed file must never be able to point the guard plane at an
  # arbitrary path on the filesystem.
  write_chain pre_tool_use "$(printf 'scope-guard.sh\t/etc/evil.sh')"
  run_chain pre_tool_use
  assert_failure 2
  assert_output --partial 'repo-relative'
}

@test "local-chain: a TRAVERSING override target is refused" {
  write_chain pre_tool_use "$(printf 'scope-guard.sh\t../../etc/evil.sh')"
  run_chain pre_tool_use
  assert_failure 2
  assert_output --partial 'traverse'
}

@test "local-chain: a GLOB override target is refused" {
  write_chain pre_tool_use "$(printf 'scope-guard.sh\t.caws/hooks/ext/*.sh')"
  run_chain pre_tool_use
  assert_failure 2
  assert_output --partial 'glob'
}

@test "local-chain: a stray comment is refused — the file is machine-generated" {
  write_chain pre_tool_use '# hand-edited note' 'scope-guard.sh'
  run_chain pre_tool_use
  assert_failure 2
  assert_output --partial 'unexpected comment'
}

@test "local-chain: a chain for ANOTHER event does not leak into this one" {
  write_chain stop 'session-log.sh stop'
  run_chain pre_tool_use
  assert_success
  assert_output --partial 'NOCHAIN'
}

@test "local-chain: a header-only sidecar is a deliberate EMPTY chain, not a fallback to stock" {
  # The header is what makes emptiness explicit. Falling back to stock here
  # would silently ignore a repo that deliberately compiled an empty chain.
  write_chain pre_tool_use
  run_chain pre_tool_use
  assert_success
  assert_output --partial 'CHAIN:'
  refute_output --partial 'NOCHAIN'
}

# --- end-to-end: the DISPATCHER honors the compiled chain -------------------
# The arms above exercise the parser. These drive the real shared dispatcher,
# which is the only thing that proves the trailer actually replaces the stock
# HANDLERS array and that run-handlers resolves the override target. A parser
# that works while the dispatcher ignores it would pass every test above.

dispatch_pre_tool_use() {
  run env CLAUDE_CODE_SESSION_ID="$CAWS_TEST_SESSION_ID" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c "printf '%s' '{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"x.ts\"}}' | bash '$CAWS_TEST_HOOKS_DIR/dispatch/pre_tool_use.sh'"
}

@test "local-chain e2e: a compiled chain makes the dispatcher run the OVERRIDE target" {
  mkdir -p "$CAWS_TEST_REPO/.caws/hooks/ext"
  cat > "$CAWS_TEST_REPO/.caws/hooks/ext/marker.sh" <<'EOF'
#!/bin/bash
printf 'marker-ran\n' >> "$CAWS_PROJECT_DIR/chain-marker.log"
exit 0
EOF
  chmod 755 "$CAWS_TEST_REPO/.caws/hooks/ext/marker.sh"
  rm -f "$CAWS_TEST_REPO/chain-marker.log"
  write_chain pre_tool_use "$(printf 'marker.sh\t.caws/hooks/ext/marker.sh')"

  dispatch_pre_tool_use
  assert_success
  # The marker ran => the compiled chain replaced the stock array AND
  # run-handlers resolved the repo-relative override target.
  [ -f "$CAWS_TEST_REPO/chain-marker.log" ]
}

@test "local-chain e2e: WITHOUT a chain the same marker never runs" {
  # Discrimination control. Without this, the arm above would pass even if the
  # dispatcher ran every handler it could find regardless of the sidecar.
  mkdir -p "$CAWS_TEST_REPO/.caws/hooks/ext"
  cat > "$CAWS_TEST_REPO/.caws/hooks/ext/marker.sh" <<'EOF'
#!/bin/bash
printf 'marker-ran\n' >> "$CAWS_PROJECT_DIR/chain-marker.log"
exit 0
EOF
  chmod 755 "$CAWS_TEST_REPO/.caws/hooks/ext/marker.sh"
  rm -f "$CAWS_TEST_REPO/chain-marker.log"
  rm -f "$DISPATCH/pre_tool_use.chain"

  dispatch_pre_tool_use
  assert_success
  [ ! -f "$CAWS_TEST_REPO/chain-marker.log" ]
}

@test "local-chain e2e: a MALFORMED chain blocks the dispatcher with exit 2" {
  # The fail-closed half of the asymmetry, proven at the dispatcher rather than
  # at the lib: a sidecar that cannot be parsed must stop the call, not quietly
  # fall back to stock and report success.
  write_chain pre_tool_use 'not-a-shell-script'
  dispatch_pre_tool_use
  assert_failure 2
  assert_output --partial '"decision":"block"'
}
