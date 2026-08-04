#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: kimi-code
# hook_pack_version: 1
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
# Kimi Code hook-output envelope emitters (kimi-code override).
#
# This file overrides the shared lib/emit.sh for the kimi-code surface. It is
# sourced by caws_source_lib (defined in shared/lib/agent-surface.sh) in
# preference to the shared default when:
#   $CAWS_PROJECT_DIR/$CAWS_VENDOR_DIR/hooks/lib/emit.sh
# exists (i.e. .kimi-code/hooks/lib/emit.sh is present in the consumer repo).
#
# Kimi-specific differences from the shared baseline (contract verified live
# against kimi 0.31.1 — see tmp/kimi-hook-probe-findings.md in the CAWS repo):
#   1. emit_ask emits "deny" instead of "ask" — Kimi's PreToolUse does not
#      treat permissionDecision "ask" as blocking (observed: tool executed
#      under ask). Conservatively emit deny so a guard's ask-level escalation
#      does not fail open. Codex adapter precedent.
#   2. emit_block ALSO writes the reason to stderr — Kimi surfaces the block
#      reason from the hook's stderr on exit 2, not from the stdout envelope.
#      The stdout envelope is kept (tolerated; harmless if ignored).
#   3. emit_ask likewise mirrors its reason to stderr, because the kimi
#      run-handlers override treats deny as priority-3 (immediate return 2),
#      and stderr is the channel Kimi reads on exit 2.
#   4. No emit_updated_input — Kimi has no documented updatedInput contract;
#      quiet-merge.sh passes commands through unrewritten on this surface.
#
# Kimi tolerates the hookEventName field inside hookSpecificOutput (verified),
# so the envelopes keep the shared shape.

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

# emit_block: stdout envelope (shared shape) + the reason on stderr, which is
# the channel Kimi surfaces as the block reason on exit 2.
emit_block() {
  local reason="${1:-}"
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg msg "$reason" '{ decision: "block", reason: $msg }'
  else
    printf '{ "decision": "block", "reason": "%s" }\n' "$(_emit_json_escape "$reason")"
  fi
  printf '%s\n' "$reason" >&2
}

# emit_ask: Kimi has no blocking PreToolUse "ask" decision (verified live:
# ask degrades to allow). Conservatively emit "deny" so a guard's ask-level
# escalation does not fail open. Reason mirrored to stderr because the kimi
# run-handlers override short-circuits deny with return 2.
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
  printf '%s\n' "$reason" >&2
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
