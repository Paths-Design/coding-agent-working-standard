#!/usr/bin/env bats
# The four tier-2 guard-config adopters, driven end to end.
#
# CAWS-HOOKS-GUARD-CONFIG-TIER2-01.
#
# guard-config.bats pins the LOADER (does the parse reach the accessor?). This
# file pins the GUARDS (does the accessor change a verdict?). Those are
# genuinely different failure modes: a loader whose output nothing consumes is
# a feature that reports success and does nothing, which is the class this
# repo's release stance singles out as the most dangerous.
#
# Every behavioral arm below is a CONTROLLED comparison — identical envelope,
# identical fixture, the configuration document as the ONLY variable, with the
# no-config baseline asserted explicitly. Without that baseline an "admitted
# with config" assertion passes just as happily against a guard that admits
# everything.
#
# The scope-guard arms stub `caws scope check` to REFUSE unconditionally, so
# ALLOW_PREFIXES is the only thing in the guard that can produce an admission.
# That is what makes the admission attributable to the configured prefix and
# nothing else.
#
# NOTE ON THE ORACLE. scope-guard exits 0 for a REFUSAL as well as an
# admission — a refusal is carried as block JSON on stdout, because that is
# what a PreToolUse hook has to emit for the harness to act on it. Exit status
# therefore does NOT discriminate the two, and asserting on it reads every
# refusal as a pass. The discriminator is the OUTPUT: an admission is silent.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

REASON='this repo keeps its Rust core in native/, which has no src/ directory'

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

clear_yaml_policy() {
  rm -f "$CAWS_TEST_REPO/.caws/policy.yaml"
}

# A policy granting scope-guard one additional prefix.
scope_prefix_policy() {
  printf '{"version":1,"surfaces":{},"guards":{"scope-guard.sh":{"additional_allow_prefixes":[{"prefix":"%s","reason":"%s"}]}}}' \
    "$1" "$REASON"
}

# Run the installed scope-guard against a stub `caws` that REFUSES every path.
# Any exit 0 therefore came from ALLOW_PREFIXES, not from the kernel.
_scope_guard_refusing_kernel() {
  local rel_path="$1"
  local stubdir
  stubdir="$(mktemp -d "${TMPDIR:-/tmp}/caws-stub-XXXXXX")"
  cat > "$stubdir/caws" <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "scope" && "$2" == "check" ]]; then exit 1; fi
if [[ "$1" == "scope" && "$2" == "show" ]]; then
  printf '%s' '{"decision":"reject","rule":"scope.reject.root_not_allowed","path":"x","mode":"authoritative","boundSpecId":"TEST-001","bindingState":"bound"}'
  exit 0
fi
exit 0
STUB
  chmod +x "$stubdir/caws"
  run env \
    CLAUDE_CODE_SESSION_ID="$CAWS_TEST_SESSION_ID" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    PATH="$stubdir:$PATH" \
    bash -c "printf '%s' '$(hook_envelope Edit "$rel_path")' | bash '$CAWS_TEST_HOOKS_DIR/scope-guard.sh'"
  rm -rf "$stubdir"
}

# The two oracles. An admission is SILENT; a refusal carries block text naming
# the bound spec. Asserting the refusal's content (not merely "non-empty")
# keeps these from passing on an unrelated failure such as a bash error.
assert_scope_admitted() {
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
assert_scope_refused() {
  [[ "$output" == *"not in the defined scope"* ]]
  [[ "$output" == *"TEST-001"* ]]
}

# Ask the shared allowlist lib directly. Returns the function's own exit code,
# which is the verdict both write guards consume.
_write_allowlisted() {
  local file_path="$1"
  run env CAWS_PROJECT_DIR="$CAWS_TEST_REPO" bash -c '
    set -euo pipefail
    export CAWS_PROJECT_DIR="$1"
    CAWS_VENDOR_DIR=".claude"
    CAWS_INSTRUCTION_FILES=""
    source "$2/lib/write-allowlist.sh"
    caws_is_write_allowlisted "$3" "$1"
  ' _ "$CAWS_TEST_REPO" "$CAWS_TEST_HOOKS_DIR" "$file_path"
}

# ─────────────────────────────────────────────────────────────────────────────
# A1: the configuration is the only variable, and it changes the verdict
# ─────────────────────────────────────────────────────────────────────────────

@test "baseline: with no config, a path the kernel refuses is refused" {
  clear_policy
  _scope_guard_refusing_kernel "native/core.rs"
  assert_scope_refused
}

@test "the SAME envelope is admitted once the repo declares the prefix" {
  write_policy "$(scope_prefix_policy 'native/')"
  _scope_guard_refusing_kernel "native/core.rs"
  assert_scope_admitted
}

@test "the declared prefix admits its subtree only, not every refused path" {
  # Guards against the failure where a configured entry is read as a blanket
  # "config present, stop checking" rather than as one more prefix.
  write_policy "$(scope_prefix_policy 'native/')"
  _scope_guard_refusing_kernel "src/unrelated.ts"
  assert_scope_refused
}

@test "the prefix boundary is respected: native-adjacent/ is NOT under native/" {
  write_policy "$(scope_prefix_policy 'native/')"
  _scope_guard_refusing_kernel "native-adjacent/core.rs"
  assert_scope_refused
}

@test "an INVALID document applies zero prefixes, so the verdict reverts to refusal" {
  # Fail-closed is only cheap because append-only makes "apply nothing" the
  # stricter outcome. This asserts the direction of that degradation.
  write_policy '{"version":1,"surfaces":{},"guards":{"scope-guard.sh":{"additional_allow_prefixes":[{"prefix":"native/"}]}}}'
  _scope_guard_refusing_kernel "native/core.rs"
  assert_scope_refused
}

# ─────────────────────────────────────────────────────────────────────────────
# The invariants configuration must never be able to break
# ─────────────────────────────────────────────────────────────────────────────

@test "worktree payload still DENIES with a config present (the ordering invariant)" {
  # The .caws/worktrees/<name>/<payload> exclusion sits BEFORE the config arm
  # in write-allowlist.sh, so no declared prefix can re-admit a payload path
  # by ordering. Reserved-prefix validation refuses `.caws` as well, so the
  # property holds twice; this arm pins the ordering half, which is the half
  # that would break silently under a refactor.
  write_policy "$(scope_prefix_policy 'native/')"
  _write_allowlisted "$CAWS_TEST_REPO/.caws/worktrees/wt-a/payload.txt"
  [ "$status" -ne 0 ]
}

@test "a repo-relative prefix cannot admit an absolute path in ANOTHER repository" {
  # scope-guard honors ABSOLUTE allow-prefixes ahead of foreign-repo
  # containment. Config entries are validated repo-relative precisely so they
  # can never reach that loop; this drives the real guard to prove it.
  write_policy "$(scope_prefix_policy 'native/')"
  local foreign
  foreign="$(mktemp -d "${TMPDIR:-/tmp}/caws-foreign-XXXXXX")"
  mkdir -p "$foreign/native"
  _scope_guard_refusing_kernel "$foreign/native/core.rs"
  rm -rf "$foreign"
  [ "$status" -eq 2 ]
  [[ "$output" == *"DIFFERENT repository"* ]]
}

@test "a config naming a reserved prefix is rejected whole, admitting nothing" {
  write_policy "$(scope_prefix_policy '.caws/')"
  _scope_guard_refusing_kernel "native/core.rs"
  assert_scope_refused
}

# ─────────────────────────────────────────────────────────────────────────────
# lib/write-allowlist.sh — one arm, both write guards
# ─────────────────────────────────────────────────────────────────────────────

@test "write-allowlist: an undeclared path is not allowlisted" {
  clear_policy
  _write_allowlisted "$CAWS_TEST_REPO/native/core.rs"
  [ "$status" -ne 0 ]
}

@test "write-allowlist: the declared prefix is allowlisted, absolute form" {
  write_policy '{"version":1,"surfaces":{},"guards":{"write-allowlist.sh":{"additional_allow_prefixes":[{"prefix":"native/","reason":"'"$REASON"'"}]}}}'
  _write_allowlisted "$CAWS_TEST_REPO/native/core.rs"
  [ "$status" -eq 0 ]
}

@test "write-allowlist: the declared prefix is allowlisted, repo-relative form too" {
  # Both guards pass paths in both shapes depending on the envelope, so a
  # config honored in only one form would work for Write and not for Bash.
  write_policy '{"version":1,"surfaces":{},"guards":{"write-allowlist.sh":{"additional_allow_prefixes":[{"prefix":"native/","reason":"'"$REASON"'"}]}}}'
  _write_allowlisted "native/core.rs"
  [ "$status" -eq 0 ]
}

@test "write-allowlist: scope-guard's prefixes do NOT leak into the allowlist" {
  # Each guard reads its OWN key. A shared bucket would mean a prefix declared
  # for scope governance silently also bypassed the write guards.
  write_policy "$(scope_prefix_policy 'native/')"
  _write_allowlisted "$CAWS_TEST_REPO/native/core.rs"
  [ "$status" -ne 0 ]
}

# ─────────────────────────────────────────────────────────────────────────────
# A5: non_governed_zones keep their meaning across the transport swap
# ─────────────────────────────────────────────────────────────────────────────

@test "a policy.yaml non-governed zone is still honored by scope-guard" {
  # The inline awk that used to read this moved into lib/guard-config.py. The
  # key, its semantics and its normalization are unchanged; this arm is what
  # proves the move was a transport swap and not a behavior change.
  clear_policy
  write_yaml_policy 'non_governed_zones:
  - vendor/**
'
  _scope_guard_refusing_kernel "vendor/thirdparty.ts"
  clear_yaml_policy
  assert_scope_admitted
}

@test "a non-governed zone does not admit paths outside it" {
  clear_policy
  write_yaml_policy 'non_governed_zones:
  - vendor/**
'
  _scope_guard_refusing_kernel "src/app.ts"
  clear_yaml_policy
  assert_scope_refused
}

@test "zones and configured prefixes compose: both are honored at once" {
  write_policy "$(scope_prefix_policy 'native/')"
  write_yaml_policy 'non_governed_zones:
  - vendor/**
'
  _scope_guard_refusing_kernel "vendor/thirdparty.ts"
  local zone_output="$output"
  _scope_guard_refusing_kernel "native/core.rs"
  clear_yaml_policy
  [ -z "$zone_output" ]
  assert_scope_admitted
}

@test "scope-guard says so out loud when zones are declared but the loader is gone" {
  # Unhonored zones refuse MORE than the repo declared. That is safe, but it
  # reads as a scope bug to whoever hits it, and a guard that is silently
  # stricter than its own policy file is what pushes a team to fork it.
  clear_policy
  write_yaml_policy 'non_governed_zones:
  - vendor/**
'
  run_guard_missing_lib scope-guard.sh guard-config.sh "$(hook_envelope Edit "$CAWS_TEST_REPO/vendor/thirdparty.ts")"
  clear_yaml_policy
  [[ "$output" == *"non_governed_zones are NOT honored"* ]]
  [[ "$output" == *"caws init --adopt"* ]]
}

# ─────────────────────────────────────────────────────────────────────────────
# A6: env > config > shipped default
# ─────────────────────────────────────────────────────────────────────────────

# Drive god-object-check over a Write and report the threshold it announced.
_god_object_threshold() {
  local abs="$CAWS_TEST_REPO/big.ts"
  local i
  : > "$abs"
  for ((i = 1; i <= 40; i++)); do printf 'line%d\n' "$i" >> "$abs"; done
  local envelope
  envelope="$(jq -nc --arg f "$abs" '{tool_name:"Write", tool_input:{file_path:$f}}')"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    ${1:+CAWS_GOD_OBJECT_LOC="$1"} \
    bash -c "printf '%s' '$envelope' | bash '$CAWS_TEST_HOOKS_DIR/god-object-check.sh'"
}

@test "god-object: with no config and no env, the shipped default 2000 governs" {
  clear_policy
  # A 40-line file is under 2000, so the advisory must be silent. That silence
  # IS the assertion: it pins which threshold was in force.
  _god_object_threshold ""
  [ -z "$output" ]
}

@test "god-object: a configured threshold still ABOVE the file size stays silent" {
  write_policy '{"version":1,"surfaces":{},"guards":{"god-object-check.sh":{"thresholds":{"loc":100}}}}'
  _god_object_threshold ""
  # 100 is the schema minimum and still above 40, so still silent — this is the
  # control for the arm below, proving the next one is not firing by accident.
  [ -z "$output" ]
}

@test "god-object: ENV outranks CONFIG (existing settings.json tuning keeps working)" {
  write_policy '{"version":1,"surfaces":{},"guards":{"god-object-check.sh":{"thresholds":{"loc":100}}}}'
  _god_object_threshold "10"
  [[ "$output" == *"threshold: 10"* ]]
  [[ "$output" != *"threshold: 100"* ]]
}

@test "god-object: CONFIG outranks the shipped default when no env is set" {
  # The env var is absent here, so a `threshold: 100` in the message can only
  # have come from the configuration document.
  write_policy '{"version":1,"surfaces":{},"guards":{"god-object-check.sh":{"thresholds":{"loc":100}}}}'
  local abs="$CAWS_TEST_REPO/huge.ts"
  local i
  : > "$abs"
  for ((i = 1; i <= 150; i++)); do printf 'line%d\n' "$i" >> "$abs"; done
  local envelope
  envelope="$(jq -nc --arg f "$abs" '{tool_name:"Write", tool_input:{file_path:$f}}')"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c "printf '%s' '$envelope' | bash '$CAWS_TEST_HOOKS_DIR/god-object-check.sh'"
  [[ "$output" == *"threshold: 100"* ]]
}

@test "loc-delta: CONFIG outranks the shipped default" {
  write_policy '{"version":1,"surfaces":{},"guards":{"loc-delta-check.sh":{"thresholds":{"delta":20}}}}'
  local abs="$CAWS_TEST_REPO/edited.ts"
  local new_string old_string envelope i
  new_string=""
  for ((i = 1; i <= 60; i++)); do new_string="${new_string}line${i}"$'\n'; done
  old_string="x"
  printf '%s' "$new_string" > "$abs"
  envelope="$(jq -nc --arg f "$abs" --arg o "$old_string" --arg n "$new_string" \
    '{tool_name:"Edit", tool_input:{file_path:$f, old_string:$o, new_string:$n}}')"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c "printf '%s' '$envelope' | bash '$CAWS_TEST_HOOKS_DIR/loc-delta-check.sh'"
  [[ "$output" == *"threshold: 20"* ]]
}

@test "loc-delta: ENV outranks CONFIG" {
  write_policy '{"version":1,"surfaces":{},"guards":{"loc-delta-check.sh":{"thresholds":{"delta":20}}}}'
  local abs="$CAWS_TEST_REPO/edited2.ts"
  local new_string old_string envelope i
  new_string=""
  for ((i = 1; i <= 60; i++)); do new_string="${new_string}line${i}"$'\n'; done
  old_string="x"
  printf '%s' "$new_string" > "$abs"
  envelope="$(jq -nc --arg f "$abs" --arg o "$old_string" --arg n "$new_string" \
    '{tool_name:"Edit", tool_input:{file_path:$f, old_string:$o, new_string:$n}}')"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    CAWS_LOC_DELTA_WARN_THRESHOLD="15" \
    bash -c "printf '%s' '$envelope' | bash '$CAWS_TEST_HOOKS_DIR/loc-delta-check.sh'"
  [[ "$output" == *"threshold: 15"* ]]
  [[ "$output" != *"threshold: 20"* ]]
}

@test "loc-delta: the threshold key is 'delta'; 'loc' is refused and applies nothing" {
  # The guard's FILENAME contains "loc", which is what makes `loc` the tempting
  # and wrong key. It bounds a per-edit delta, so it spells it the same way
  # god-object-check.sh does. A document using the wrong name must not quietly
  # half-work: the whole document is invalid and the shipped default governs.
  write_policy '{"version":1,"surfaces":{},"guards":{"loc-delta-check.sh":{"thresholds":{"loc":20}}}}'
  local abs="$CAWS_TEST_REPO/edited3.ts"
  local new_string old_string envelope i
  new_string=""
  for ((i = 1; i <= 60; i++)); do new_string="${new_string}line${i}"$'\n'; done
  old_string="x"
  printf '%s' "$new_string" > "$abs"
  envelope="$(jq -nc --arg f "$abs" --arg o "$old_string" --arg n "$new_string" \
    '{tool_name:"Edit", tool_input:{file_path:$f, old_string:$o, new_string:$n}}')"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c "printf '%s' '$envelope' | bash '$CAWS_TEST_HOOKS_DIR/loc-delta-check.sh'"
  [[ "$output" != *"threshold: 20"* ]]
}

# ─────────────────────────────────────────────────────────────────────────────
# Degradation: a pack without the loader keeps its SHIPPED behavior
# ─────────────────────────────────────────────────────────────────────────────

@test "scope-guard without the loader still refuses what the kernel refuses" {
  # A REPO-RELATIVE path, deliberately: an absolute one is adjudicated by the
  # foreign-repo containment block first, which refuses for its own reasons
  # and would let this arm pass without the scope path running at all.
  write_policy "$(scope_prefix_policy 'native/')"
  run_guard_missing_lib scope-guard.sh guard-config.sh "$(hook_envelope Edit "native/core.rs")"
  [[ "$output" == *'"decision": "block"'* ]]
}

@test "write-allowlist without the loader still allowlists its SHIPPED paths" {
  # Degraded, not disarmed: losing the config must not lose the shipped table.
  write_policy "$(scope_prefix_policy 'native/')"
  run env CAWS_PROJECT_DIR="$CAWS_TEST_REPO" bash -c '
    set -euo pipefail
    export CAWS_PROJECT_DIR="$1"
    CAWS_VENDOR_DIR=".claude"
    CAWS_INSTRUCTION_FILES=""
    tmp="$(mktemp -d)"
    cp -R "$2"/. "$tmp/"
    rm -f "$tmp/lib/guard-config.sh"
    source "$tmp/lib/write-allowlist.sh"
    caws_is_write_allowlisted "$1/docs/readme.md" "$1"
  ' _ "$CAWS_TEST_REPO" "$CAWS_TEST_HOOKS_DIR"
  [ "$status" -eq 0 ]
}

# ─────────────────────────────────────────────────────────────────────────────
# The single-parse claim, driven through the real dispatcher
# ─────────────────────────────────────────────────────────────────────────────

@test "a whole pre_tool_use dispatch spawns the parser EXACTLY once" {
  # This is the measurement the entire design rests on and the one thing the
  # accessors cannot tell you: caws_guard_config_load is idempotent WITHIN a
  # process, but each guard is its own process, so per-process idempotence
  # would still mean one spawn per adopting guard. The claim is that
  # run-handlers.sh parses once and the guards inherit it through exported
  # env — cross-process, which only a real dispatch can show.
  #
  # If this ever reads 4 instead of 1, the feature still WORKS and only the
  # cost regresses, which is exactly why it would otherwise go unnoticed:
  # nothing else in the suite would turn red.
  local counter="$CAWS_TEST_REPO/.parse-count"
  local real="$CAWS_TEST_HOOKS_DIR/lib/guard-config.py"
  local saved="$CAWS_TEST_REPO/.guard-config.py.real"
  write_policy "$(scope_prefix_policy 'native/')"
  cp "$real" "$saved"
  : > "$counter"
  # The wrapper must be PYTHON, not bash: guard-config.sh invokes the parser as
  # `python3 "$script"`, so the shebang is never consulted. A bash stub here
  # fails to parse, the loader reports `unavailable` with stderr suppressed,
  # and the counter reads 0 -- indistinguishable from "the chain never ran".
  cat > "$real" <<COUNTER
import os, sys
open("$counter", "a").write("x")
os.execv(sys.executable, [sys.executable, "$saved"] + sys.argv[1:])
COUNTER

  run env \
    CLAUDE_CODE_SESSION_ID="$CAWS_TEST_SESSION_ID" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c "printf '%s' '$(hook_envelope Edit "native/core.rs")' | bash '$CAWS_TEST_HOOKS_DIR/dispatch/pre_tool_use.sh'"

  local spawns dispatch_output
  spawns="$(wc -c < "$counter" | tr -d ' ')"
  dispatch_output="$output"

  # Control: the SAME dispatch with the configuration removed. This is what
  # makes the count meaningful rather than merely small -- it shows the chain
  # reaches a guard that CONSULTS the document, so "1" is one shared parse and
  # not "nobody looked".
  clear_policy
  : > "$counter"
  run env \
    CLAUDE_CODE_SESSION_ID="$CAWS_TEST_SESSION_ID" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c "printf '%s' '$(hook_envelope Edit "native/core.rs")' | bash '$CAWS_TEST_HOOKS_DIR/dispatch/pre_tool_use.sh'"
  local unconfigured_output="$output"

  cp "$saved" "$real"
  rm -f "$counter" "$saved"

  # pre_tool_use runs THREE adopting guards -- scope-guard.sh directly, plus
  # worktree-write-guard.sh and bash-write-guard.sh through write-allowlist.sh.
  # Per-guard parsing would read 3 or more here.
  [ "$spawns" = "1" ]
  # And the config demonstrably reached a guard inside that single parse: the
  # same envelope through the same chain flips from blocked to admitted.
  #
  # The oracle is the DECISION, not the refusal prose. Which refusal text the
  # unconfigured run produces depends on fixture state the earlier arms leave
  # behind (whether `caws scope show --json` can render a diagnostic for this
  # repo at all), so asserting the wording made this arm order-dependent.
  [[ "$dispatch_output" != *'"decision": "block"'* ]]
  [[ "$unconfigured_output" == *'"decision": "block"'* ]]
}
