#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: claude-code
# hook_pack_version: 8
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
# RUNTIME DEPENDENCIES: bash + node. node is already required by the CAWS
# CLI itself (which is a Node binary), so depending on it here adds no new
# runtime surface area. We do NOT depend on jq — jq is not guaranteed
# present on every install target (it is absent from many container base
# images and minimal CI runners), and a missing jq would silently drop
# every parallel-agent notice. The product goal is "agents see each
# other": that visibility cannot depend on a shell utility outside the
# CAWS toolchain.
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

# Parse the CAWS-native JSON and, when active_agent_count > 1, compose
# Claude Code's hookSpecificOutput.additionalContext envelope. A single
# node invocation does the whole pipeline: parse → filter peers → format
# bullet list → wrap envelope → emit. Malformed input, parse errors, or
# any thrown exception fall through to silent exit (fail-closed-non-
# blocking). Node is already a hard CAWS dependency — the CLI binary
# IS node — so this adds no new runtime surface vs. jq.
printf '%s' "$CLI_OUT" | node -e '
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { process.exit(0); }
    const count = Number(parsed && parsed.active_agent_count);
    if (!Number.isFinite(count) || count <= 1) process.exit(0);
    const agents = Array.isArray(parsed.active_agents) ? parsed.active_agents : [];
    const peers = agents.filter((a) => a && a.is_self !== true);
    if (peers.length === 0) process.exit(0);
    const bullets = peers.map((a) => {
      const worktree = a.bound_worktree || "no worktree";
      const spec = a.bound_spec_id ? " — spec " + a.bound_spec_id : "";
      const kind = a.git_dir_kind || "unknown";
      const branch = a.branch || "-";
      const ageMs = Number(a.last_active_age_ms);
      const ageSec = Number.isFinite(ageMs) ? Math.floor(ageMs / 1000) : 0;
      return "• " + (a.session_id || "<unknown>") +
        " (" + worktree + ")" + spec +
        " — git_dir_kind=" + kind +
        " — branch=" + branch +
        " — last active " + ageSec + "s ago";
    }).join("\n");
    const ctx = "MULTI-AGENT NOTICE: " + count +
      " agents active in this repo (including this session). Other active sessions:\n" +
      bullets + "\n\n" +
      "Coordinate via '\''caws agents list'\'' and '\''caws status'\'' before " +
      "mutating shared state. Authority remains in .caws/worktrees.json " +
      "(ownership) and .caws/specs/<id>.yaml (scope) — leases are " +
      "visibility only.";
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: ctx,
      },
    }));
  });
' 2>/dev/null || exit 0

exit 0
