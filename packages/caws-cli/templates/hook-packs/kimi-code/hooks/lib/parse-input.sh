#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: kimi-code
# hook_pack_version: 2
# caws_min_major: 11
# lineage_refs: 8,16
# edit_stance: YOURS TO EDIT. This is a starting hook, not a locked one — shape it
#   to your repo: tune thresholds, add checks, remove what does not fit. Your edits
#   are preserved: caws init treats a changed hook as intended growth and will not
#   clobber it — it shows a diff and asks (--adopt keeps yours; --overwrite --force
#   takes the upstream template). The CAWS-MANAGED-HOOK marker above is only how caws
#   init finds hooks it can offer updates for; it is NOT a keep-out sign. CAWS owns the
#   failure-class invariant (the why/what a guard protects); you own the how. The one
#   edit to avoid: gutting a guard to dodge a block instead of fixing the cause. Grow
#   everything else freely.
# Kimi Code hook input parser (kimi-code override).
#
# This file overrides the shared lib/parse-input.sh for the kimi-code surface.
# It is sourced by caws_source_lib (defined in shared/lib/agent-surface.sh) in
# preference to the shared default when:
#   $CAWS_PROJECT_DIR/$CAWS_VENDOR_DIR/hooks/lib/parse-input.sh
# exists (i.e. .kimi-code/hooks/lib/parse-input.sh is present in the consumer
# repo).
#
# Kimi-specific difference from the shared baseline (field-name normalization):
#   Kimi's file-targeting tools (Read/Write/Edit/Glob/Grep) carry the target
#   in tool_input.path; the Claude schema the shared parser reads is
#   tool_input.file_path. Without normalization HOOK_FILE_PATH is empty for
#   EVERY kimi file tool call, and the path-based guards (protected-paths,
#   scope-guard, worktree-write-guard) silently admit everything — verified
#   live against 0.31.1 (an Edit on .kimi-code/hooks/lib/emit.sh went through
#   unblocked while the lease chain proved the wiring had fired). Likewise
#   tool_call_id stands in for the Claude tool_use_id (audit.sh accuracy).
#
# Implementation: source the shared parser, snapshot its parse_hook_input
# under a private name, and wrap it — the whole extraction (and the durable
# session envelope write) stays shared; only the two renames are kimi-side.
# Codex adapter precedent (its override normalizes apply_patch -> Edit/Write).

if [[ -n "${_KIMI_PARSE_INPUT_LOADED:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
_KIMI_PARSE_INPUT_LOADED=1

# Locate the shared parser. The dispatcher exports CAWS_SHARED_LIB_DIR before
# sourcing this file; fall back to the canonical installed layout otherwise.
_kimi_pi_shared="${CAWS_SHARED_LIB_DIR:-${CAWS_PROJECT_DIR:-.}/.caws/hooks/lib}/parse-input.sh"
if [[ -f "$_kimi_pi_shared" ]]; then
  # shellcheck disable=SC1090
  source "$_kimi_pi_shared"
else
  # Broken install: the shared parser carries the envelope write and every
  # HOOK_* extraction. Define a fail-open stub so handlers see empty tool
  # fields and short-circuit on their own matcher predicates, never blocking
  # on a parser problem (shared fail-open posture).
  parse_hook_input() { return 0; }
  return 0 2>/dev/null || exit 0
fi
unset _kimi_pi_shared

# Snapshot the shared implementation under a private name so the wrapper
# below can call it without recursion.
# Note the explicit " () ": bash 3.2 (macOS default) prints declare -f output
# with the opening brace on the next line, and command substitution strips the
# leading newline — gluing the brace to the name without it.
eval "_kimi_shared_parse_hook_input () $(declare -f parse_hook_input | tail -n +2)"

parse_hook_input() {
  _kimi_shared_parse_hook_input "$@"

  # tool_input.path -> HOOK_FILE_PATH when the Claude field is absent.
  # Cheap guard first: nothing to do when a path is already populated or the
  # tool-input JSON carries no "path" key at all (e.g. Bash).
  if [[ -z "${HOOK_FILE_PATH:-}" && "${HOOK_TOOL_INPUT_JSON:-}" == *'"path"'* ]]; then
    local _kimi_path
    _kimi_path=$(printf '%s' "$HOOK_TOOL_INPUT_JSON" | python3 -c '
import json, sys
try:
    d = json.loads(sys.stdin.read() or "{}")
except Exception:
    d = {}
v = d.get("path") if isinstance(d, dict) else None
print(v if isinstance(v, str) else "")
' 2>/dev/null || true)
    if [[ -n "$_kimi_path" ]]; then
      HOOK_FILE_PATH="$_kimi_path"
      export HOOK_FILE_PATH
    fi
  fi

  # tool_call_id -> HOOK_TOOL_USE_ID (audit.sh reads the Claude name).
  if [[ -z "${HOOK_TOOL_USE_ID:-}" && "${HOOK_INPUT_JSON:-}" == *'"tool_call_id"'* ]]; then
    local _kimi_call_id
    _kimi_call_id=$(printf '%s' "$HOOK_INPUT_JSON" | python3 -c '
import json, sys
try:
    d = json.loads(sys.stdin.read() or "{}")
except Exception:
    d = {}
v = d.get("tool_call_id") if isinstance(d, dict) else None
print(v if isinstance(v, str) else "")
' 2>/dev/null || true)
    if [[ -n "$_kimi_call_id" ]]; then
      HOOK_TOOL_USE_ID="$_kimi_call_id"
      export HOOK_TOOL_USE_ID
    fi
  fi
}
