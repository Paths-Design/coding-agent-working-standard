#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: codex
# hook_pack_version: 7
# caws_min_major: 11
# lineage_refs: 8,16
# edit_stance: this repo OWNS and may grow this hook. Edits are expected and
#   preserved — `caws init` refuses to overwrite a changed managed hook (re-run
#   with --adopt to keep yours, or --overwrite to pull this upstream template).
#   CAWS owns the failure-class invariant (the why/what you must not silently
#   weaken); you own the how. Do not edit it to BYPASS the guard; do grow it.
# Codex hook-output envelope emitters (codex override).
#
# This file overrides the shared lib/emit.sh for the codex surface. It is
# sourced by caws_source_lib (defined in shared/lib/agent-surface.sh) in
# preference to the shared default when:
#   $CAWS_PROJECT_DIR/$CAWS_VENDOR_DIR/hooks/lib/emit.sh
# exists (i.e. .codex/hooks/lib/emit.sh is present in the consumer repo).
#
# Codex-specific differences from the shared baseline:
#   1. emit_ask emits "deny" instead of "ask" — Codex PreToolUse does not
#      support the permissionDecision "ask" value; conservatively emit deny
#      with an approval reason so a guard's ask-level escalation does not
#      fail open.
#   2. emit_updated_input is added — used by the quiet-merge handler and
#      apply_patch normalization to rewrite the command in the hook output
#      (Codex PreToolUse "allow" + updatedInput contract).
#
# PATH NOTE: de-harnessing.
# The codex emit.sh previously referenced CODEX_PROJECT_DIR and .codex/
# hardcoded paths. This override uses the surface resolver env vars
# (CAWS_VENDOR_DIR, CAWS_PROJECT_DIR) injected by agent-surface.sh, since
# those are set before any guard hook is invoked. The only genuine logic
# differences vs. the shared baseline are:
#   - emit_ask -> deny decision
#   - emit_updated_input function (new)
# Those are preserved exactly from the codex version.

# Guard against double-sourcing.
if [[ -n "${_CAWS_EMIT_SH_LOADED:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
_CAWS_EMIT_SH_LOADED=1

# _emit_json_escape <string>
#   Escape a string for embedding in a JSON double-quoted value. Used by
#   the printf fallback path only (jq does its own escaping).
_emit_json_escape() {
  local s="${1:-}"
  s="${s//\\/\\\\}"   # backslash first
  s="${s//\"/\\\"}"   # double quote
  s="${s//$'\n'/\\n}" # newline
  s="${s//$'\t'/\\t}" # tab
  s="${s//$'\r'/\\r}" # carriage return
  printf '%s' "$s"
}

emit_block() {
  local reason="${1:-}"
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg msg "$reason" '{ decision: "block", reason: $msg }'
  else
    printf '{ "decision": "block", "reason": "%s" }\n' "$(_emit_json_escape "$reason")"
  fi
}

# emit_ask: Codex does not support PreToolUse permissionDecision "ask".
# Conservatively emit "deny" so a guard's ask-level escalation does not fail open.
emit_ask() {
  local reason="${1:-}"
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg msg "$reason" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: $msg
      }
    }'
  else
    printf '{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "%s" } }\n' \
      "$(_emit_json_escape "$reason")"
  fi
}

# emit_updated_input: Codex-specific. Used by apply_patch rewriting (quiet-merge
# and the apply_patch normalization path) to return an "allow" decision with a
# rewritten command via the updatedInput envelope.
emit_updated_input() {
  local command="${1:-}"
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg cmd "$command" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: $cmd }
      }
    }'
  else
    printf '{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "allow", "updatedInput": { "command": "%s" } } }\n' \
      "$(_emit_json_escape "$command")"
  fi
}

emit_additional_context() {
  local message="${1:-}"
  local event="${2:-PreToolUse}"
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg msg "$message" --arg ev "$event" '{
      hookSpecificOutput: {
        hookEventName: $ev,
        additionalContext: $msg
      }
    }'
  else
    printf '{ "hookSpecificOutput": { "hookEventName": "%s", "additionalContext": "%s" } }\n' \
      "$(_emit_json_escape "$event")" "$(_emit_json_escape "$message")"
  fi
}
