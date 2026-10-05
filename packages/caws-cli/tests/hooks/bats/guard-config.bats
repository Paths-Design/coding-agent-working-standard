#!/usr/bin/env bats
# guard-config — the tier-2 configuration loader and its env transport.
#
# CAWS-HOOKS-GUARD-CONFIG-TIER2-01.
#
# Two properties carry the whole design and both are pinned here:
#
#   1. The PARSE and the ACCESSORS agree. `guard-config.py` writes variable
#      names through its `mangle()`, and `guard-config.sh` reads them back
#      through `caws_guard_mangle`. A divergence between the two is SILENT —
#      every lookup misses, every guard quietly reverts to its shipped table,
#      and nothing reports it. So the parity is asserted directly.
#
#   2. Failure degrades to the SHIPPED table, never to permission. Every key is
#      append-only, so applying zero configured entries is strictly the
#      stricter outcome. That is what lets the loader be absolute about
#      all-or-nothing without risking a fail-open.
#
# The transport is indexed (`..._COUNT` + `..._0`, `..._1`) rather than
# whitespace-delimited because `policy.non_governed_zones` is read line-wise
# today and a zone may legitimately contain a space. A space-delimited
# transport would silently split it into two zones — a scope change disguised
# as a refactor.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

GUARD_CONFIG_PY() { printf '%s' "$CAWS_TEST_HOOKS_DIR/lib/guard-config.py"; }
GUARD_CONFIG_SH() { printf '%s' "$CAWS_TEST_HOOKS_DIR/lib/guard-config.sh"; }

write_policy() {
  mkdir -p "$CAWS_TEST_REPO/.caws/hooks"
  printf '%s' "$1" > "$CAWS_TEST_REPO/.caws/hooks/hook-policy.json"
}

clear_policy() {
  rm -f "$CAWS_TEST_REPO/.caws/hooks/hook-policy.json"
}

write_yaml_policy() {
  mkdir -p "$CAWS_TEST_REPO/.caws"
  printf '%s' "$1" > "$CAWS_TEST_REPO/.caws/policy.yaml"
}

# Load the config in a subshell and echo one accessor result.
accessor() {
  local fn="$1"; shift
  bash -c '
    set -euo pipefail
    export CAWS_GUARD_CONFIG_PY="$1"
    source "$2"
    caws_guard_config_load "$3"
    fn="$4"; shift 4
    "$fn" "$@"
  ' _ "$(GUARD_CONFIG_PY)" "$(GUARD_CONFIG_SH)" "$CAWS_TEST_REPO" "$fn" "$@"
}

REASON='the Rust core lives under native/ and this repo has no src/ directory'

# ── the lib is installed at all ────────────────────────────────────────────

@test "both halves of the loader are installed by the shared pack" {
  [ -f "$(GUARD_CONFIG_PY)" ]
  [ -f "$(GUARD_CONFIG_SH)" ]
}

@test "the emitter and the accessor agree on variable naming" {
  # A silent divergence here disables every configured entry without a word.
  local from_py from_sh
  from_py="$(python3 -c '
import sys
sys.path.insert(0, sys.argv[1])
import importlib.util
spec = importlib.util.spec_from_file_location("gc", sys.argv[2])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print(mod.mangle("scope-guard.sh"))
print(mod.mangle("god-object-check.sh"))
print(mod.mangle("loc"))
' "$CAWS_TEST_HOOKS_DIR/lib" "$(GUARD_CONFIG_PY)")"
  from_sh="$(bash -c '
    source "$1"
    caws_guard_mangle "scope-guard.sh"; echo
    caws_guard_mangle "god-object-check.sh"; echo
    caws_guard_mangle "loc"; echo
  ' _ "$(GUARD_CONFIG_SH)")"
  [ "$from_py" = "$from_sh" ]
  [ "$from_py" = "SCOPE_GUARD_SH
GOD_OBJECT_CHECK_SH
LOC" ]
}

# ── the happy path ─────────────────────────────────────────────────────────

@test "a declared prefix reaches the accessor" {
  write_policy '{"version":1,"surfaces":{},"guards":{"scope-guard.sh":{"additional_allow_prefixes":[{"prefix":"native/","reason":"'"$REASON"'"}]}}}'
  run accessor caws_guard_prefixes scope-guard.sh
  [ "$status" -eq 0 ]
  [ "$output" = "native/" ]
}

@test "several prefixes come back in declaration order, one per line" {
  write_policy '{"version":1,"surfaces":{},"guards":{"scope-guard.sh":{"additional_allow_prefixes":[{"prefix":"native/","reason":"'"$REASON"'"},{"prefix":"workbench/","reason":"'"$REASON"'"}]}}}'
  run accessor caws_guard_prefixes scope-guard.sh
  [ "$output" = "native/
workbench/" ]
}

@test "a prefix declared for ONE guard is not visible to another" {
  write_policy '{"version":1,"surfaces":{},"guards":{"scope-guard.sh":{"additional_allow_prefixes":[{"prefix":"native/","reason":"'"$REASON"'"}]}}}'
  run accessor caws_guard_prefixes write-allowlist.sh
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "a configured threshold overrides the shipped default" {
  write_policy '{"version":1,"surfaces":{},"guards":{"god-object-check.sh":{"thresholds":{"loc":2500}}}}'
  run accessor caws_guard_threshold god-object-check.sh loc 2000
  [ "$output" = "2500" ]
}

@test "an unconfigured threshold returns the shipped default unchanged" {
  clear_policy
  run accessor caws_guard_threshold god-object-check.sh loc 2000
  [ "$output" = "2000" ]
}

# ── fail-closed: one bad entry applies ZERO entries ────────────────────────

@test "a malformed document applies NOTHING and reports invalid" {
  write_policy '{"version":1,"surfaces":{},"guards":'
  run accessor caws_guard_prefixes scope-guard.sh
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  run bash -c '
    export CAWS_GUARD_CONFIG_PY="$1"
    source "$2"; caws_guard_config_load "$3"
    printf "%s" "$CAWS_GUARD_CONFIG_STATUS"
  ' _ "$(GUARD_CONFIG_PY)" "$(GUARD_CONFIG_SH)" "$CAWS_TEST_REPO"
  [ "$output" = "invalid" ]
}

@test "ONE bad prefix discards the GOOD one beside it" {
  # Partial application would leave the repo running a configuration nobody
  # authored and nobody can predict by reading the file.
  write_policy '{"version":1,"surfaces":{},"guards":{"scope-guard.sh":{"additional_allow_prefixes":[{"prefix":"native/","reason":"'"$REASON"'"},{"prefix":"/etc/","reason":"'"$REASON"'"}]}}}'
  run accessor caws_guard_prefixes scope-guard.sh
  [ -z "$output" ]
}

@test "a bad entry in one guard discards a VALID entry in a different guard" {
  write_policy '{"version":1,"surfaces":{},"guards":{"scope-guard.sh":{"additional_allow_prefixes":[{"prefix":"native/","reason":"'"$REASON"'"}]},"god-object-check.sh":{"thresholds":{"loc":999999999}}}}'
  run accessor caws_guard_prefixes scope-guard.sh
  [ -z "$output" ]
}

@test "an absolute prefix is refused — it would bypass foreign-repo containment" {
  write_policy '{"version":1,"surfaces":{},"guards":{"scope-guard.sh":{"additional_allow_prefixes":[{"prefix":"/tmp/","reason":"'"$REASON"'"}]}}}'
  run accessor caws_guard_prefixes scope-guard.sh
  [ -z "$output" ]
}

@test "a reserved prefix is refused, so the config cannot widen its own governance plane" {
  write_policy '{"version":1,"surfaces":{},"guards":{"scope-guard.sh":{"additional_allow_prefixes":[{"prefix":".caws/hooks/","reason":"'"$REASON"'"}]}}}'
  run accessor caws_guard_prefixes scope-guard.sh
  [ -z "$output" ]
}

@test "a decision-naming key nested deep in the document is refused" {
  write_policy '{"version":1,"surfaces":{},"guards":{"scope-guard.sh":{"additional_allow_prefixes":[{"prefix":"native/","reason":"'"$REASON"'","verdict":"allow"}]}}}'
  run accessor caws_guard_prefixes scope-guard.sh
  [ -z "$output" ]
}

@test "an absent policy is 'absent', which is NOT the same state as 'invalid'" {
  clear_policy
  run bash -c '
    export CAWS_GUARD_CONFIG_PY="$1"
    source "$2"; caws_guard_config_load "$3"
    printf "%s" "$CAWS_GUARD_CONFIG_STATUS"
  ' _ "$(GUARD_CONFIG_PY)" "$(GUARD_CONFIG_SH)" "$CAWS_TEST_REPO"
  [ "$output" = "absent" ]
}

# ── the loader degrades rather than disarming ──────────────────────────────

@test "a MISSING parser leaves the accessors working and reports unavailable" {
  clear_policy
  run bash -c '
    export CAWS_GUARD_CONFIG_PY="/nonexistent/guard-config.py"
    source "$1"; caws_guard_config_load "$2"
    printf "%s|" "$CAWS_GUARD_CONFIG_STATUS"
    caws_guard_prefixes scope-guard.sh
    printf "|%s" "$(caws_guard_threshold god-object-check.sh loc 2000)"
  ' _ "$(GUARD_CONFIG_SH)" "$CAWS_TEST_REPO"
  [ "$status" -eq 0 ]
  [ "$output" = "unavailable||2000" ]
}

@test "'unavailable' is distinguishable from 'absent': unparsed must not read as verified-empty" {
  clear_policy
  local absent unavailable
  absent="$(bash -c '
    export CAWS_GUARD_CONFIG_PY="$1"; source "$2"; caws_guard_config_load "$3"
    printf "%s" "$CAWS_GUARD_CONFIG_STATUS"' _ "$(GUARD_CONFIG_PY)" "$(GUARD_CONFIG_SH)" "$CAWS_TEST_REPO")"
  unavailable="$(bash -c '
    export CAWS_GUARD_CONFIG_PY="/nonexistent"; source "$1"; caws_guard_config_load "$2"
    printf "%s" "$CAWS_GUARD_CONFIG_STATUS"' _ "$(GUARD_CONFIG_SH)" "$CAWS_TEST_REPO")"
  [ "$absent" != "$unavailable" ]
}

@test "the load is idempotent: a second call does not re-spawn the parser" {
  write_policy '{"version":1,"surfaces":{},"guards":{"scope-guard.sh":{"additional_allow_prefixes":[{"prefix":"native/","reason":"'"$REASON"'"}]}}}'
  # Second load points at a BROKEN parser. If it re-ran, the status would flip
  # to unavailable and the prefix would vanish; idempotence keeps both.
  run bash -c '
    export CAWS_GUARD_CONFIG_PY="$1"
    source "$2"; caws_guard_config_load "$3"
    export CAWS_GUARD_CONFIG_PY="/nonexistent"
    caws_guard_config_load "$3"
    printf "%s|" "$CAWS_GUARD_CONFIG_STATUS"; caws_guard_prefixes scope-guard.sh
  ' _ "$(GUARD_CONFIG_PY)" "$(GUARD_CONFIG_SH)" "$CAWS_TEST_REPO"
  [ "$output" = "ok|native/" ]
}

@test "only the CAWS_GUARD_ namespace is exported: a rogue line cannot set PATH" {
  clear_policy
  local fake="$CAWS_TEST_REPO/fake-guard-config.py"
  printf '%s\n' \
    'import sys' \
    'sys.stdout.write("PATH=/pwned\n")' \
    'sys.stdout.write("CAWS_GUARD_CONFIG_STATUS=ok\n")' \
    'sys.stdout.write("CAWS_GUARD_ZONE_COUNT=0\n")' > "$fake"
  run bash -c '
    export CAWS_GUARD_CONFIG_PY="$1"
    source "$2"; caws_guard_config_load "$3"
    printf "%s" "$PATH"
  ' _ "$fake" "$(GUARD_CONFIG_SH)" "$CAWS_TEST_REPO"
  [ "$output" != "/pwned" ]
}

# ── non_governed_zones: the transport swap must not change semantics ───────

@test "policy.non_governed_zones reaches the accessor with the shipped normalization" {
  write_yaml_policy 'non_governed_zones:
  - vendor/**
  - "third_party/*"
  - generated
'
  run accessor caws_guard_zones
  [ "$output" = "vendor/
third_party/
generated/" ]
}

@test "a zone list ENDS at the next top-level key, exactly as the awk block did" {
  write_yaml_policy 'non_governed_zones:
  - vendor/
gates:
  - not_a_zone
'
  run accessor caws_guard_zones
  [ "$output" = "vendor/" ]
}

@test "a trailing comment is stripped from a zone" {
  write_yaml_policy 'non_governed_zones:
  - vendor/   # generated protobuf output
'
  run accessor caws_guard_zones
  [ "$output" = "vendor/" ]
}

@test "a zone containing a SPACE survives the transport intact" {
  # This is why the transport is indexed rather than whitespace-delimited: the
  # awk block read zones line-wise, so a spaced zone worked before this change
  # and must still work after it.
  write_yaml_policy 'non_governed_zones:
  - "my generated files/"
'
  run accessor caws_guard_zones
  [ "$output" = "my generated files/" ]
}

@test "zones are honored in a repo with NO hook-policy.json at all" {
  # policy.yaml and hook-policy.json are independent sources. A repo that never
  # adopted the hook policy must keep its non-governed zones.
  clear_policy
  write_yaml_policy 'non_governed_zones:
  - vendor/
'
  run accessor caws_guard_zones
  [ "$output" = "vendor/" ]
}

@test "no policy.yaml means no zones, and no error" {
  rm -f "$CAWS_TEST_REPO/.caws/policy.yaml"
  run accessor caws_guard_zones
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

# ── bash 3.2 (what macOS actually ships) ───────────────────────────────────

@test "the accessors work under /bin/bash 3.2, not merely under a modern bash" {
  # The suite normally runs under whatever `bash` is on PATH (often Homebrew
  # bash 5). The guards do not: on macOS they run under /bin/bash 3.2, which
  # has no associative arrays and no `${var^^}`. Asserting only under bash 5
  # would prove the wrong thing about the shipping environment.
  [ -x /bin/bash ]
  write_policy '{"version":1,"surfaces":{},"guards":{"scope-guard.sh":{"additional_allow_prefixes":[{"prefix":"native/","reason":"'"$REASON"'"}]},"god-object-check.sh":{"thresholds":{"loc":2500}}}}'
  write_yaml_policy 'non_governed_zones:
  - vendor/**
'
  run /bin/bash -c '
    export CAWS_GUARD_CONFIG_PY="$1"
    source "$2"
    caws_guard_config_load "$3"
    printf "%s|" "${BASH_VERSION%%.*}"
    printf "%s|" "$(caws_guard_mangle "scope-guard.sh")"
    printf "%s|" "$(caws_guard_prefixes scope-guard.sh)"
    printf "%s|" "$(caws_guard_threshold god-object-check.sh loc 2000)"
    printf "%s" "$(caws_guard_zones)"
  ' _ "$(GUARD_CONFIG_PY)" "$(GUARD_CONFIG_SH)" "$CAWS_TEST_REPO"
  [ "$status" -eq 0 ]
  [ "$output" = "3|SCOPE_GUARD_SH|native/|2500|vendor/" ]
}
