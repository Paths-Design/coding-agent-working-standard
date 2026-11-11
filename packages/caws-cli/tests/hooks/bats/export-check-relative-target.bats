#!/usr/bin/env bats
# duplicate-export-check.sh — returns on every target shape
# (CAWS-DUPLICATE-EXPORT-RELATIVE-PATH-HANG-001).
#
# The handler walks from the written file up to the directory holding
# package.json. A relative target used to make that walk run forever, holding
# the PostToolUse chain until the harness timed it out. Every case here runs
# the handler under a wall-clock limit, so a walk that does not end fails the
# case instead of hanging the suite.

load helpers

setup_file() {
  caws_install_pack_once
  mkdir -p "$CAWS_TEST_REPO/pkg/src"
  printf '{"name":"fixture"}\n' > "$CAWS_TEST_REPO/pkg/package.json"
  printf 'export function sharedThing() {}\n' > "$CAWS_TEST_REPO/pkg/src/existing.ts"
  printf 'export function sharedThing() {}\n' > "$CAWS_TEST_REPO/pkg/src/fresh.ts"
  mkdir -p "$CAWS_TEST_HOME/no-package/deep"
  printf 'export function sharedThing() {}\n' > "$CAWS_TEST_HOME/no-package/deep/lone.ts"
}
teardown_file() {
  caws_teardown_pack
}

# Runs a command in its own process group and ends the whole group at the
# limit, exiting 124. Ending only the outer shell would leave a looping handler
# holding this test's output pipe, and the suite would wait on it.
_BOUNDED='setpgrp(0,0); my $limit = shift; my $pid = fork;
if (!$pid) { exec @ARGV; exit 127 }
$SIG{ALRM} = sub { $SIG{TERM} = "IGNORE"; kill("TERM", -$$); sleep 1; kill("KILL", $pid); exit 124 };
alarm $limit; waitpid($pid, 0); exit($? >> 8);'

# _run_write <file_path as the harness sends it> <payload cwd>
#   The handler runs from a directory with no package.json in or above it. From
#   inside a package, the unresolved walk found that package.json at "." and
#   ended by accident, which is how the fault stayed hidden.
_run_write() {
  local envelope
  envelope="$(jq -nc --arg f "$1" --arg c "$2" \
    '{tool_name:"Write", cwd:$c, tool_input:{file_path:$f, content:""}}')"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    CAWS_HOME="$CAWS_TEST_HOME/.caws" \
    perl -e "$_BOUNDED" 20 \
    bash -c "cd '$CAWS_TEST_HOME/no-package' && printf '%s' '$envelope' | bash '$CAWS_TEST_HOOKS_DIR/duplicate-export-check.sh'"
}

@test "duplicate-export: a relative target returns and reports the duplicate in its package" {
  _run_write "src/fresh.ts" "$CAWS_TEST_REPO/pkg"
  [ "$status" -eq 0 ]
  [[ "$output" == *"'sharedThing' also in $CAWS_TEST_REPO/pkg/src/existing.ts"* ]]
}

@test "duplicate-export: a bare relative filename returns" {
  _run_write "x.ts" "$CAWS_TEST_HOME/no-package/deep"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "duplicate-export: a relative target with no package.json above it exits silently" {
  _run_write "deep/lone.ts" "$CAWS_TEST_HOME/no-package"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "duplicate-export: an absolute target still reports the duplicate" {
  _run_write "$CAWS_TEST_REPO/pkg/src/fresh.ts" "$CAWS_TEST_REPO"
  [ "$status" -eq 0 ]
  [[ "$output" == *"'sharedThing' also in $CAWS_TEST_REPO/pkg/src/existing.ts"* ]]
}

@test "duplicate-export: an absolute target with no package.json above it exits silently" {
  _run_write "$CAWS_TEST_HOME/no-package/deep/lone.ts" "$CAWS_TEST_HOME"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
