#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: kimi-code
# hook_pack_version: 2
# caws_min_major: 11
# lineage_refs: 8,11,16,17,19,22,23,24,26
# edit_stance: YOURS TO EDIT. This is a starting hook, not a locked one — shape it
#   to your repo: tune thresholds, add checks, remove what does not fit. Your edits
#   are preserved: caws init treats a changed hook as intended growth and will not
#   clobber it — it shows a diff and asks (--adopt keeps yours; --overwrite --force
#   takes the upstream template). The CAWS-MANAGED-HOOK marker above is only how caws
#   init finds hooks it can offer updates for; it is NOT a keep-out sign. CAWS owns the
#   failure-class invariant (the why/what a guard protects); you own the how. The one
#   edit to avoid: gutting a guard to dodge a block instead of fixing the cause. Grow
#   everything else freely.
#
# caws-kimi-hook.sh <EventName> — the kimi-code vendor adapter shim.
#
# WHY THIS EXISTS. Kimi Code has no project-level hook config: [[hooks]] entries
# live ONLY in the user-level $KIMI_CODE_HOME/config.toml and fire for EVERY
# project the user opens, with cwd = the session's launch directory. The wiring
# therefore points every CAWS event at this one shim, which:
#
#   1. Resolves the active git root at INVOCATION time (codex precedent;
#      HOOK-PROJECT-DIR-ROOT-NOT-CWD-01 — kimi may be launched from a
#      subdirectory of the repo, and a subdirectory CAWS_PROJECT_DIR would
#      fragment every derived path: logs, leases, audit).
#   2. No-ops silently (exit 0, no output) when the resolved root has no CAWS
#      shared core — the wiring is user-global, so it must be inert in every
#      non-CAWS repo. This is the same fail-open posture as the opencode
#      plugin's missing-.caws/hooks path.
#   3. Maps the kimi event name to the shared dispatcher and execs it with the
#      surface identity injected (CAWS_AGENT_SURFACE / CAWS_PROJECT_DIR) — the
#      ONLY channel through which surface specifics reach the shared core
#      (docs/architecture/hook-pack-shared-core.md DI contract).
#
# Stdin (the kimi hook payload) passes through to the dispatcher unchanged.
# Kimi's payload is Claude-compatible (verified live on 0.31.1):
#   {hook_event_name, session_id, cwd, tool_name, tool_input, tool_call_id}
#
# FAIL-OPEN everywhere: any anomaly (unknown event, missing dispatcher, git
# absent) exits 0 so a wiring hiccup never blocks a legitimate tool call.
# Deliberately NOT `set -e`.

set -uo pipefail

EVENT="${1:-}"

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)"

DISPATCH_DIR="$ROOT/.caws/hooks/dispatch"

# Inert outside CAWS repos: no shared core installed -> allow, no output.
[[ -d "$DISPATCH_DIR" ]] || exit 0

case "$EVENT" in
  PreToolUse)   DISPATCHER="pre_tool_use.sh" ;;
  PostToolUse)  DISPATCHER="post_tool_use.sh" ;;
  SessionStart) DISPATCHER="session_start.sh" ;;
  Stop)         DISPATCHER="stop.sh" ;;
  PreCompact)   DISPATCHER="pre_compact.sh" ;;
  *)            exit 0 ;; # unknown event: fail open
esac

[[ -x "$DISPATCH_DIR/$DISPATCHER" ]] || exit 0

export CAWS_AGENT_SURFACE="kimi-code"
export CAWS_PROJECT_DIR="$ROOT"
exec "$DISPATCH_DIR/$DISPATCHER"
