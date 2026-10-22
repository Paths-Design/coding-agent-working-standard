#!/usr/bin/env bats
# lib/agent-surface.sh — CAWS_PROJECT_DIR root resolution
# (HOOK-PROJECT-DIR-ROOT-NOT-CWD-01).
#
# Some harnesses (zcode) inject the session CWD as CLAUDE_PROJECT_DIR rather
# than the repo root; when that CWD is a package-bearing subdirectory, the old
# verbatim adoption made CAWS_PROJECT_DIR the subdir and fragmented every
# derived path (CAWS_LOG_DIR, heartbeat lease cache, audit log) into a stray
# <subdir>/.caws or <subdir>/.zcode. The resolver now normalizes each vendor
# *_PROJECT_DIR candidate to its git repo root via `git rev-parse
# --show-toplevel` before adopting it — the same invariant the codex dispatcher
# already binds (hook-install.ts codexCommand: CAWS_PROJECT_DIR=$REPO_ROOT).
#
# These tests source the INSTALLED lib (the copy `caws init` stamps from the
# built dist) so they exercise the pack the consumer actually runs, and assert
# CAWS_PROJECT_DIR after resolution. The temp repo (CAWS_TEST_REPO) is itself a
# git repo, so show-toplevel resolves to it.

load helpers

setup_file() {
  if [[ "${CAWS_AGENT_SURFACE_SOURCE_TESTS:-}" == 1 ]]; then
    # Source-unit fixtures deliberately provision no installed hook pack.
    export CAWS_TEST_REPO="$BATS_FILE_TMPDIR/source-unit-repo"
    export CAWS_TEST_HOME="$BATS_FILE_TMPDIR/source-unit-home"
    export CAWS_TEST_HOOKS_DIR="$CAWS_TEST_REPO/installed-pack-not-provisioned"
    mkdir -p "$CAWS_TEST_REPO" "$CAWS_TEST_HOME" "$BATS_FILE_TMPDIR/empty-template"
    env -i PATH="$PATH" HOME="$CAWS_TEST_HOME" \
      GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 \
      GIT_TEMPLATE_DIR="$BATS_FILE_TMPDIR/empty-template" \
      git -C "$CAWS_TEST_REPO" init -q -b source-unit
    return
  fi
  caws_install_pack_once
}
teardown_file() {
  # --no-tempdir-cleanup retains source-unit evidence in Bats' run directory;
  # ordinary installed-pack teardown stays unchanged.
  [[ "${CAWS_AGENT_SURFACE_SOURCE_TESTS:-}" == 1 ]] && return 0
  caws_teardown_pack
}

setup() {
  if [[ "${CAWS_AGENT_SURFACE_SOURCE_TESTS:-}" == 1 ]]; then
    AS_LIB="$CAWS_TEST_HOOKS_DIR/lib/agent-surface.sh"
    [[ "$BATS_TEST_DESCRIPTION" == 'source caws_source_lib:'* ]] || {
      printf '%s\n' 'SOURCE-UNIT mode cannot run installed-pack tests' >&2
      return 1
    }
    return 0
  fi
AS_LIB="$CAWS_TEST_HOOKS_DIR/lib/agent-surface.sh"

# git rev-parse --show-toplevel returns the realpath-resolved root (on macOS
# this resolves /tmp -> /private/tmp). Normalize the expected repo root the
# same way so assertions compare canonical-to-canonical, not symlink-text.
CAWS_TEST_REPO_REAL="$(cd "$CAWS_TEST_REPO" && git rev-parse --show-toplevel)"

# The inline node-ish script run under bash -c. Sourcing the lib prints
# CAWS_PROJECT_DIR on stdout. Kept as a single literal so it survives the
# env/bash word-splitting boundary intact (the run_guard pattern).
RESOLVE_CMD="source '$AS_LIB' >/dev/null 2>&1; printf '%s\n' \"\${CAWS_PROJECT_DIR:-}\""

}

# These controls source the authoritative template directly. They make no
# installed-pack claim and run independently of the legacy init bootstrap.
_source_lookup_fixture() {
  LOOKUP_TEMPLATE="$CLI_PKG_ROOT/templates/hook-packs/shared/lib/agent-surface.sh"
  LOOKUP_ROOT="$BATS_TEST_TMPDIR/source-lookup"
  LOOKUP_REAL_PYTHON="$(command -v python3)"
  LOOKUP_CALL=0
  mkdir -p "$LOOKUP_ROOT"/{bin,no-python,policy,adapter,shared,home,machine/surfaces/codex/lib}
  printf 'LOOKUP_RESULT=user\n' > "$LOOKUP_ROOT/machine/surfaces/codex/lib/probe.sh"
  printf 'LOOKUP_RESULT=adapter\n' > "$LOOKUP_ROOT/adapter/probe.sh"
  printf 'LOOKUP_RESULT=shared\n' > "$LOOKUP_ROOT/shared/probe.sh"
  cat > "$LOOKUP_ROOT/bin/python3" <<'PYTHON_BOUNDARY'
#!/bin/bash
printf '%s\n' "${!#}" >> "$LOOKUP_ROOT/python-calls"
exec "$LOOKUP_REAL_PYTHON" "$@"
PYTHON_BOUNDARY
  chmod +x "$LOOKUP_ROOT/bin/python3"
}

_source_lookup_run() {
  local map="$1" program="$2"
  shift 2
  local -a mapping=()
  [[ "$map" == __UNSET__ ]] || mapping=("CAWS_MACHINE_LIBRARIES=$map")
  LOOKUP_CALL=$((LOOKUP_CALL + 1))
  printf '%s\n' "$map" > "$LOOKUP_ROOT/case-$LOOKUP_CALL.map"
  run env -i PATH="$LOOKUP_ROOT/bin:/usr/bin:/bin" \
    HOME="$LOOKUP_ROOT/home" CAWS_HOME="$LOOKUP_ROOT/machine" \
    CAWS_AGENT_SURFACE=codex CAWS_TRAP_KILL=0 CAWS_MACHINE_RUNTIME=1 \
    CAWS_PROJECT_DIR="$LOOKUP_ROOT/policy" CAWS_MACHINE_POLICY_ROOT="$LOOKUP_ROOT/policy" \
    CAWS_MACHINE_ADAPTER_LIB_DIR="$LOOKUP_ROOT/adapter" CAWS_SHARED_LIB_DIR="$LOOKUP_ROOT/shared" \
    LOOKUP_TEMPLATE="$LOOKUP_TEMPLATE" LOOKUP_ROOT="$LOOKUP_ROOT" \
    LOOKUP_REAL_PYTHON="$LOOKUP_REAL_PYTHON" LOOKUP_NAME=probe.sh \
    "${mapping[@]}" "$@" /bin/bash -c 'source "$LOOKUP_TEMPLATE" || exit 98
'"$program"
  printf '%s\n' "$status" > "$LOOKUP_ROOT/case-$LOOKUP_CALL.status"
  printf '%s\n' "$output" > "$LOOKUP_ROOT/case-$LOOKUP_CALL.output"
  if [[ -f "$LOOKUP_ROOT/parser.stderr" ]]; then
    cp "$LOOKUP_ROOT/parser.stderr" "$LOOKUP_ROOT/case-$LOOKUP_CALL.stderr"
  fi
}

@test "source caws_source_lib: exact empty map works without Python and preserves fresh user adapter shared tiers" {
  _source_lookup_fixture
  _source_lookup_run '{}' '
    PATH="$LOOKUP_ROOT/no-python"
    if command -v python3 >/dev/null 2>&1; then exit 97; fi
    caws_source_lib "$LOOKUP_NAME" || exit 96
    printf "%s\n" "$LOOKUP_RESULT"
    /bin/rm "$CAWS_HOME/surfaces/codex/lib/probe.sh"
    caws_source_lib "$LOOKUP_NAME" || exit 95
    printf "%s\n" "$LOOKUP_RESULT"
    /bin/rm "$CAWS_MACHINE_ADAPTER_LIB_DIR/probe.sh"
    caws_source_lib "$LOOKUP_NAME" || exit 94
    printf "%s\n" "$LOOKUP_RESULT"
    printf "LOOKUP_RESULT=fresh\n" > "$CAWS_SHARED_LIB_DIR/probe.sh"
    caws_source_lib "$LOOKUP_NAME" || exit 93
    printf "%s\n" "$LOOKUP_RESULT"'
  assert_success
  assert_output $'user\nadapter\nshared\nfresh'
  [ ! -e "$LOOKUP_ROOT/python-calls" ]
}

@test "source caws_source_lib: nonempty maps preserve quoted keys paths and per-call override selection" {
  _source_lookup_fixture
  local name="probe ' quoted.sh" first="local overrides/one's file.sh" second="local overrides/two's file.sh"
  mkdir -p "$LOOKUP_ROOT/policy/local overrides"
  printf 'LOOKUP_RESULT=override-one\n' > "$LOOKUP_ROOT/policy/$first"
  printf 'LOOKUP_RESULT=override-two\n' > "$LOOKUP_ROOT/policy/$second"
  local first_map second_map
  first_map="$("$LOOKUP_REAL_PYTHON" -c 'import json,sys; print(json.dumps({sys.argv[1]:sys.argv[2]}))' "$name" "$first")"
  second_map="$("$LOOKUP_REAL_PYTHON" -c 'import json,sys; print(json.dumps({sys.argv[1]:sys.argv[2]}))' "$name" "$second")"
  _source_lookup_run "$first_map" '
    caws_source_lib "$LOOKUP_NAME" || exit 96
    printf "%s\n" "$LOOKUP_RESULT"
    export CAWS_MACHINE_LIBRARIES="$LOOKUP_SECOND_MAP"
    caws_source_lib "$LOOKUP_NAME" || exit 95
    printf "%s\n" "$LOOKUP_RESULT"' LOOKUP_NAME="$name" LOOKUP_SECOND_MAP="$second_map"
  assert_success
  assert_output $'override-one\noverride-two'
  [ "$(cat "$LOOKUP_ROOT/python-calls")" = "$name"$'\n'"$name" ]
}

@test "source caws_source_lib: whitespace and unset maps retain the Python parser and fallback" {
  _source_lookup_fixture
  local map
  for map in ' {} ' __UNSET__; do
    _source_lookup_run "$map" 'caws_source_lib "$LOOKUP_NAME" || exit 96; printf "%s\n" "$LOOKUP_RESULT"'
    assert_success
    assert_output user
  done
  [ "$(cat "$LOOKUP_ROOT/python-calls")" = $'probe.sh\nprobe.sh' ]
}

@test "source caws_source_lib: empty malformed and nonobject maps cannot fall through to an existing library" {
  _source_lookup_fixture
  local map
  for map in '' '{' '[]' 'null' '"{}"' '1'; do
    _source_lookup_run "$map" '
      caws_source_lib "$LOOKUP_NAME" 2>"$LOOKUP_ROOT/parser.stderr"
      code=$?
      printf "%s|%s\n" "$code" "${LOOKUP_RESULT-unset}"
      exit "$code"'
    assert_failure 1
    assert_output '1|unset'
    [ -s "$LOOKUP_ROOT/parser.stderr" ]
  done
  [ "$(wc -l < "$LOOKUP_ROOT/python-calls" | tr -d ' ')" -eq 6 ]
}

@test "source caws_source_lib: nonempty map without Python refuses rather than selecting a fallback" {
  _source_lookup_fixture
  _source_lookup_run '{"probe.sh":"explicit.sh"}' '
    PATH="$LOOKUP_ROOT/no-python"
    caws_source_lib "$LOOKUP_NAME" 2>"$LOOKUP_ROOT/parser.stderr"
    code=$?
    printf "%s|%s\n" "$code" "${LOOKUP_RESULT-unset}"
    exit "$code"'
  assert_failure 1
  assert_output '1|unset'
  [ -s "$LOOKUP_ROOT/parser.stderr" ]
  [ ! -e "$LOOKUP_ROOT/python-calls" ]
}

@test "source caws_source_lib: legacy runtime does not acquire machine map requirements" {
  _source_lookup_fixture
  _source_lookup_run '{' '
    CAWS_MACHINE_RUNTIME=0
    PATH="$LOOKUP_ROOT/no-python"
    caws_source_lib "$LOOKUP_NAME" || exit 96
    printf "%s\n" "$LOOKUP_RESULT"'
  assert_success
  assert_output shared
  [ ! -e "$LOOKUP_ROOT/python-calls" ]
}

@test "agent-surface: CLAUDE_PROJECT_DIR at a subdir resolves to the repo root (A1, zcode scenario)" {
  local subdir="$CAWS_TEST_REPO/packages/caws-cli/templates"
  mkdir -p "$subdir"
  run env -i \
    PATH="$PATH" \
    CAWS_AGENT_SURFACE="claude-code" \
    CLAUDE_PROJECT_DIR="$subdir" \
    bash -c "$RESOLVE_CMD"
  assert_success
  assert_output "$CAWS_TEST_REPO_REAL"
  refute_output --partial '/templates'
}

@test "agent-surface: CODEX_PROJECT_DIR at a subdir resolves to the repo root (A2)" {
  local subdir="$CAWS_TEST_REPO/packages/caws-cli/src"
  mkdir -p "$subdir"
  run env -i \
    PATH="$PATH" \
    CAWS_AGENT_SURFACE="claude-code" \
    CODEX_PROJECT_DIR="$subdir" \
    bash -c "$RESOLVE_CMD"
  assert_success
  assert_output "$CAWS_TEST_REPO_REAL"
  refute_output --partial '/src'
}

@test "agent-surface: vendor dir already at the root is unchanged — idempotent, no regression (A3)" {
  # Claude Code / Codex inject the root itself; show-toplevel of the root is
  # the root, so resolution must be a no-op.
  run env -i \
    PATH="$PATH" \
    CAWS_AGENT_SURFACE="claude-code" \
    CLAUDE_PROJECT_DIR="$CAWS_TEST_REPO" \
    bash -c "$RESOLVE_CMD"
  assert_success
  assert_output "$CAWS_TEST_REPO_REAL"
}

@test "agent-surface: a pre-set CAWS_PROJECT_DIR is respected, not overridden (A4)" {
  # The codex dispatcher already binds CAWS_PROJECT_DIR=$REPO_ROOT; that must
  # win and the vendor chain must never be consulted. Even though the vendor
  # dir here points at a subdir, the pre-set value is what we expect back.
  run env -i \
    PATH="$PATH" \
    CAWS_AGENT_SURFACE="claude-code" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CLAUDE_PROJECT_DIR="$CAWS_TEST_REPO/packages/caws-cli/templates" \
    bash -c "$RESOLVE_CMD"
  assert_success
  assert_output "$CAWS_TEST_REPO"
}

@test "agent-surface: no vendor dir set falls back to '.' (last resort, unchanged)" {
  run env -i \
    PATH="$PATH" \
    CAWS_AGENT_SURFACE="claude-code" \
    bash -c "$RESOLVE_CMD"
  assert_success
  assert_output "."
}

@test "agent-surface: a vendor dir outside any repo is kept verbatim (fail-open, not downgraded to '.')" {
  # git-absent / not-a-repo must keep the raw candidate rather than collapse to
  # ".", so a real vendor signal is never silently lost.
  local outside
  outside="$(mktemp -d "${TMPDIR:-/tmp}/caws-norepo-XXXXXX")"
  run env -i \
    PATH="$PATH" \
    CAWS_AGENT_SURFACE="claude-code" \
    CLAUDE_PROJECT_DIR="$outside" \
    bash -c "$RESOLVE_CMD"
  assert_success
  assert_output "$outside"
  rm -rf "$outside"
}

# ─── caws_run_cli (CAWS-HOOKS-CLI-CWD-LEAK-001) ────────────────────────────
#
# A hook that shells out to `"$CAWS_BIN" <cmd>` directly inherits whatever cwd
# the calling process happens to have — invisible in ordinary harness use
# (PWD naturally sits inside the repo the harness drives), but wrong the
# moment CAWS_PROJECT_DIR names a DIFFERENT directory than the inherited cwd,
# which is exactly what happened here: agent-heartbeat.sh/-register.sh/-stop.sh
# registered real leases/session records against whatever repo the bats
# process's true cwd sat in, not the isolated fixture. caws_run_cli fixes this
# by `cd`-ing into CAWS_PROJECT_DIR before invoking the binary.
#
# A fake CAWS_BIN that just records its cwd — proves the mechanism directly,
# independent of the real CLI's own behavior.
FAKE_CAWS_BIN_SRC='#!/bin/bash
pwd > "$CAPTURE_FILE"'

@test "agent-surface: caws_run_cli invokes the binary from CAWS_PROJECT_DIR, not the inherited cwd" {
  local fake_bin="$BATS_TEST_TMPDIR/fake-caws"
  printf '%s\n' "$FAKE_CAWS_BIN_SRC" >"$fake_bin"
  chmod +x "$fake_bin"

  local capture="$BATS_TEST_TMPDIR/captured-pwd"
  local inherited_cwd="$BATS_TEST_TMPDIR/inherited"
  mkdir -p "$inherited_cwd"

  # CAWS_TEST_REPO stands in for CAWS_PROJECT_DIR, deliberately DIFFERENT
  # from the process's real cwd (inherited_cwd) — the exact leak scenario.
  run env -i \
    PATH="$PATH" \
    CAWS_BIN="$fake_bin" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAPTURE_FILE="$capture" \
    bash -c 'cd "$1" && source "$2/lib/agent-surface.sh" >/dev/null 2>&1 && caws_run_cli whatever-args' \
    _ "$inherited_cwd" "$CAWS_TEST_HOOKS_DIR"
  assert_success
  # Normalize CAWS_TEST_REPO the SAME way the fake binary computes its own
  # answer (plain `cd && pwd`, no -P): CAWS_TEST_REPO itself carries a
  # double slash (mktemp concatenates a trailing-slash $TMPDIR verbatim) and
  # is not realpath-resolved, so comparing against it — or against the
  # realpath-resolved CAWS_TEST_REPO_REAL — both spuriously mismatch a
  # correct cd on pure string spelling, not on actual directory identity.
  local expected
  expected="$(cd "$CAWS_TEST_REPO" && pwd)"
  [ "$(cat "$capture")" = "$expected" ]
}

@test "agent-surface: caws_run_cli falls open to the plain invocation when CAWS_PROJECT_DIR is unset" {
  local fake_bin="$BATS_TEST_TMPDIR/fake-caws"
  printf '%s\n' "$FAKE_CAWS_BIN_SRC" >"$fake_bin"
  chmod +x "$fake_bin"

  local capture="$BATS_TEST_TMPDIR/captured-pwd"
  local inherited_cwd="$BATS_TEST_TMPDIR/inherited"
  mkdir -p "$inherited_cwd"
  local inherited_real
  inherited_real="$(cd "$inherited_cwd" && pwd)"

  run env -i \
    PATH="$PATH" \
    CAWS_BIN="$fake_bin" \
    CAPTURE_FILE="$capture" \
    bash -c 'cd "$1" && source "$2/lib/agent-surface.sh" >/dev/null 2>&1 && caws_run_cli whatever-args' \
    _ "$inherited_cwd" "$CAWS_TEST_HOOKS_DIR"
  assert_success
  # agent-surface.sh's own resolution falls CAWS_PROJECT_DIR back to "." when
  # unset (§1 above), so caws_run_cli's "." branch is what fires here.
  [ "$(cat "$capture")" = "$inherited_real" ]
}

# ---------------------------------------------------------------------------
# CAWS-DEFECT-BATS-TRAP-KILLS-LIVE-AGENT-01 — test-harness attestation.
#
# Under bats the guard is a CHILD OF THE AGENT'S OWN BASH TOOL, so the trap's
# ancestor walk resolves the live `claude` process running the suite, and the
# claude-code surface enables the kill by default. A latch armed in one test
# plus a denied attempt in the next then SIGTERMs the developer's session.
# The attestation marker (.caws/hooks/.test-harness, written by helpers.bash)
# disarms the kill plane for fixtures only; .caws/hooks/ is a protected path,
# so an agent cannot mint it inside a governed repo.
# ---------------------------------------------------------------------------

# Sets TRAP_PLANE (stdout, exactly "<CAWS_TRAP_KILL>|<CAWS_AGENT_PROCESS_NAMES>")
# and TRAP_STDERR (a file holding the lib's diagnostics), after sourcing the
# installed lib against the given project dir with the given extra env.
# Splitting the streams keeps both assertable: a --partial match on merged
# output cannot distinguish "1|python3" from "1|python3 codex".
_resolve_trap_plane() {
  local project_dir="$1"; shift
  TRAP_STDERR="$BATS_TEST_TMPDIR/trap-stderr.$$"
  TRAP_PLANE="$(env -u CLAUDE_CODE_SESSION_ID "$@" \
    CAWS_PROJECT_DIR="$project_dir" \
    CAWS_AGENT_SURFACE="claude-code" \
    bash -c "source '$project_dir/.caws/hooks/lib/agent-surface.sh' >/dev/null; \
             printf '%s|%s' \"\${CAWS_TRAP_KILL:-}\" \"\${CAWS_AGENT_PROCESS_NAMES:-}\"" \
    2>"$TRAP_STDERR")"
}

# A copy of the fixture .caws tree with the attestation marker REMOVED — i.e.
# what a real consumer repo looks like.
_unattested_repo() {
  local dir
  dir="$(mktemp -d "${TMPDIR:-/tmp}/caws-bats-unattested-XXXXXX")"
  cp -R "$CAWS_TEST_REPO/.caws" "$dir/.caws"
  rm -f "$dir/.caws/hooks/.test-harness"
  printf '%s' "$dir"
}

@test "agent-surface: without the attestation the claude-code kill plane is armed (A1)" {
  # The falsification control for A2/A3: production behavior must be untouched.
  # If this ever goes green-by-default the attestation has leaked into real repos.
  local plain; plain="$(_unattested_repo)"
  [ ! -f "$plain/.caws/hooks/.test-harness" ]
  _resolve_trap_plane "$plain"
  rm -rf "$plain"
  [ "$TRAP_PLANE" = "1|claude" ]
}

@test "agent-surface: the attestation disarms the kill and clears the surface target (A2)" {
  [ -f "$CAWS_TEST_HOOKS_DIR/.test-harness" ]
  _resolve_trap_plane "$CAWS_TEST_REPO"
  # Kill default off AND no resolvable target: two independent holds, so a test
  # that presets CAWS_TRAP_KILL=1 still cannot reach a live agent process.
  [ "$TRAP_PLANE" = "0|" ]
  # Silence is load-bearing, not cosmetic: bats merges a guard's stderr into the
  # same capture its decision envelope lands in, so a diagnostic emitted on this
  # ordinary path prepends itself to every JSON assertion in the suite (it broke
  # quiet-merge and scan-secrets exactly this way). Clearing the surface default
  # is the expected case and must say nothing.
  refute grep -q 'refusing live agent process name' "$TRAP_STDERR"
}

@test "agent-surface: the attestation refuses a live agent name even when preset (A3)" {
  # The hostile path: a test (or a stale env) explicitly aims the trap at the
  # live harness process while forcing kill mode on.
  _resolve_trap_plane "$CAWS_TEST_REPO" \
    CAWS_TRAP_KILL=1 CAWS_AGENT_PROCESS_NAMES="claude python3 codex"
  # The sacrificial name survives; both live-surface names are dropped. Exact
  # equality, not a substring: "1|python3" must not be satisfied by
  # "1|python3 codex" — that would pass while a live name was still aimable.
  [ "$TRAP_PLANE" = "1|python3" ]
  grep -q 'refusing live agent process name as trap target: claude' "$TRAP_STDERR"
  grep -q 'refusing live agent process name as trap target: codex' "$TRAP_STDERR"
}

@test "agent-surface: every surface arm's process names are covered by the live-name set (A4)" {
  # Drift guard: a new surface arm whose process name is absent from
  # CAWS_AGENT_LIVE_PROCESS_NAMES would be aimable at under the attestation,
  # silently re-opening the hazard. Enumerate the arms from the installed lib.
  local lib="$CAWS_TEST_HOOKS_DIR/lib/agent-surface.sh"
  local live
  live="$(env -u CLAUDE_CODE_SESSION_ID CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    bash -c "source '$lib' >/dev/null 2>&1; printf '%s' \"\$CAWS_AGENT_LIVE_PROCESS_NAMES\"")"
  [ -n "$live" ]

  # Case-arm assignments are indented inside the `case` block; the shared
  # constant and the preserve-block assignment are at column 0.
  local arm_names
  # Literal assignments only: the preserve block assigns from a variable
  # ("$_CAWS_AGENT_PROCESS_NAMES_PRESET"), which names no surface.
  arm_names="$(grep -E '^[[:space:]]+CAWS_AGENT_PROCESS_NAMES="[^$]' "$lib" \
    | sed -E 's/^[[:space:]]*CAWS_AGENT_PROCESS_NAMES="([^"]*)".*/\1/')"

  local found=0 name
  for name in $arm_names; do
    found=$((found + 1))
    case " $live " in
      *" $name "*) ;;
      *) fail "surface process name '$name' is missing from CAWS_AGENT_LIVE_PROCESS_NAMES" ;;
    esac
  done
  # Guards the extraction itself: a regex that matched nothing would pass the
  # loop vacuously. Surfaces today contribute well over ten distinct names.
  [ "$found" -ge 10 ]
}
