#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: claude-code
# hook_pack_version: 3
# caws_min_major: 11
# lineage_refs: 19
# do_not_edit_directly: update via `caws init --agent-surface claude-code`
#
# PreToolUse handler — heartbeats the current session's lease and surfaces
# parallel-agent presence to the calling agent
# (MULTI-AGENT-ACTIVITY-REGISTRY-001).
#
# Sourcing: invoked by dispatch/pre_tool_use.sh (FIRST in the handler
# list) after parse-input.sh has populated HOOK_SESSION_ID. The dispatcher
# runs with --short-circuit-on-block; this handler must never block.
#
# Behavior:
#   - Refuses on empty/unknown HOOK_SESSION_ID.
#   - Invokes `caws agents heartbeat --session-id <id> --platform claude-code
#     --throttle 30000 --reason pre_tool_use --json --include-active-summary`.
#   - Parses CAWS-native JSON. When active_agent_count > 1, wraps the
#     active_agents list into Claude Code's hookSpecificOutput.
#     additionalContext envelope and emits it on stdout. When the count
#     is 1 (self only), emits nothing — silent in the common case.
#   - Throttled invocations still return an active_agents summary, so
#     parallel-presence surfacing fires every tool call even when the
#     write was skipped.
#
# IO BOUNDARY: this script is the ONLY surface that emits Claude Code's
# hookSpecificOutput.additionalContext envelope for lease state. The CLI
# emits CAWS-native JSON only. A Cursor or terminal integration would
# rewrite this script to emit its own protocol-specific output while
# reusing the same `caws agents heartbeat --json --include-active-summary`
# command verbatim.
#
# FAIL-CLOSED-NON-BLOCKING: if the CLI is absent, fails, or returns
# malformed JSON, this hook exits 0 silently. Heartbeat is observability
# and parallel-agent surfacing; a failure must never block the tool call.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib/parse-input.sh
source "$SCRIPT_DIR/lib/parse-input.sh" 2>/dev/null || exit 0
parse_hook_input || exit 0

if [[ -z "${HOOK_SESSION_ID:-}" || "$HOOK_SESSION_ID" == "unknown" ]]; then
  exit 0
fi

CAWS_BIN="${CAWS_BIN:-caws}"
if ! command -v "$CAWS_BIN" >/dev/null 2>&1; then
  exit 0
fi

# Capture both stdout (JSON) and stderr (diagnostics). On any CLI error,
# fall through to silent exit.
CLI_OUT="$(
  "$CAWS_BIN" agents heartbeat \
    --session-id "$HOOK_SESSION_ID" \
    --platform claude-code \
    --throttle 30000 \
    --reason pre_tool_use \
    --json \
    --include-active-summary \
  2>/dev/null
)" || exit 0

if [[ -z "$CLI_OUT" ]]; then
  exit 0
fi

# Extract the active_agent_count. If jq can't parse the output, fall
# through to silent exit (fail-closed-non-blocking).
ACTIVE_COUNT="$(printf '%s' "$CLI_OUT" | jq -r '.active_agent_count // 0' 2>/dev/null)"
if [[ -z "$ACTIVE_COUNT" || "$ACTIVE_COUNT" == "null" ]]; then
  exit 0
fi

# Common case: self only (or zero). Silent.
if [[ "$ACTIVE_COUNT" -le 1 ]]; then
  exit 0
fi

# N>1: surface other-session presence to the agent via Claude Code's
# hookSpecificOutput.additionalContext envelope. The summary lists peers
# (excluding self) with bound_worktree / bound_spec_id / git_dir_kind /
# branch / last_active_age_ms — exactly what the agent needs to know
# before proceeding with a tool call.
PEER_SUMMARY="$(printf '%s' "$CLI_OUT" | jq -r '
  .active_agents
  | map(select(.is_self == false))
  | map(
      "• " + .session_id +
      " (" + (.bound_worktree // "no worktree") + ")" +
      (if .bound_spec_id then " — spec " + .bound_spec_id else "" end) +
      " — git_dir_kind=" + (.git_dir_kind // "unknown") +
      " — branch=" + (.branch // "-") +
      " — last active " + ((.last_active_age_ms // 0) / 1000 | floor | tostring) + "s ago"
    )
  | join("\n")
' 2>/dev/null)"

if [[ -z "$PEER_SUMMARY" ]]; then
  exit 0
fi

# Compose the additionalContext envelope. Use jq to build the JSON so
# embedded newlines and quotes in PEER_SUMMARY are encoded correctly.
ADDITIONAL_CONTEXT="MULTI-AGENT NOTICE: ${ACTIVE_COUNT} agents active in this repo (including this session). Other active sessions:
${PEER_SUMMARY}

Coordinate via 'caws agents list' and 'caws status' before mutating shared state. Authority remains in .caws/worktrees.json (ownership) and .caws/specs/<id>.yaml (scope) — leases are visibility only."

jq -nc \
  --arg ctx "$ADDITIONAL_CONTEXT" \
  '{
     hookSpecificOutput: {
       hookEventName: "PreToolUse",
       additionalContext: $ctx
     }
   }' 2>/dev/null || exit 0

exit 0
