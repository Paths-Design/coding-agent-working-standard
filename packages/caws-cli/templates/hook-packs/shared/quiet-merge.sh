#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: shared
# hook_pack_version: 1
# caws_min_major: 11
# lineage_refs: 22,26
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
# Worktree lifecycle CWD hook (legacy filename: quiet-merge.sh)
#
# When an agent's CWD is inside the worktree being destroyed, the process
#    loses its CWD and crashes (posix_spawn ENOENT on PostToolUse hooks).
#
# The fix rewrites a proven standalone literal lifecycle invocation to
# `cd <repo-root> && <command>`. Mentions and compound source are untouched:
# earlier guards checked their targets in the original execution directory.
# It intentionally does not pipe, redirect, summarize, or append a confirmation
# command: the governed command's stdout, stderr, and exit status are authority
# signals and must survive byte-for-byte shell execution semantics.
#
# IMPORTANT: This hook MUST be the last PreToolUse hook for Bash commands
# that intercepts input. It emits updatedInput which replaces any prior
# hook's updatedInput. Order in dispatch/pre_tool_use.sh: after the blocking
# guards and advisory scanners, so a real refusal is decided before this
# allow-with-rewrite response is considered.
#
# Promoted from Sterling per CAWS-HOOK-PACK-PROMOTE-001 and
# docs/reports/sterling_hook_port_audit_001.md. Companion to cwd-guard.sh
# (entry 22) for the worktree-destroyed-while-inside class.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/parse-input.sh
source "$SCRIPT_DIR/lib/parse-input.sh"
# shellcheck source=lib/caws-state.sh
# Provides resolve_canonical_dir (HOOK-LIB-CONSOLIDATION-001 T2a). Guard the
# source: a fatal `source <missing>` under `set -euo pipefail` is NOT caught by
# `|| true` (CAWS-HOOK-SOURCE-GUARD-FAIL-SOFT-001). quiet-merge is a CWD input
# rewriter with NO block authority, so a missing lib fails SOFT but LOUD
# (diagnostic + exit 0) rather than silently dying or blocking the merge.
if ! { [[ -f "$SCRIPT_DIR/lib/caws-state.sh" ]] && source "$SCRIPT_DIR/lib/caws-state.sh"; }; then
  echo "[quiet-merge] CAWS hook infrastructure incomplete: lib/caws-state.sh is missing — lifecycle-command CWD safety is skipped. Restore the shared hook libs with: caws init --adopt" >&2
  exit 0
fi
# shellcheck source=lib/agent-surface.sh
if ! { [[ -f "$SCRIPT_DIR/lib/agent-surface.sh" ]] && source "$SCRIPT_DIR/lib/agent-surface.sh"; }; then
  echo "[quiet-merge] CAWS hook infrastructure incomplete: lib/agent-surface.sh is missing — lifecycle-command CWD safety is skipped. Restore the shared hook libs with: caws init --adopt" >&2
  exit 0
fi
parse_hook_input

TOOL_NAME="$HOOK_TOOL_NAME"
COMMAND="$HOOK_COMMAND"

# Only intercept Bash tool
if [[ "$TOOL_NAME" != "Bash" ]] || [[ -z "$COMMAND" ]]; then
  exit 0
fi

# Resolve repo root (may differ from CAWS_PROJECT_DIR in worktrees).
# Shared helper — HOOK-LIB-CONSOLIDATION-001 T2a.
PROJECT_DIR="$(resolve_canonical_dir "${CAWS_PROJECT_DIR:-.}")"

# A cheap candidate filter is not a syntax certificate. The pinned parser below
# must establish the complete invocation, including quoted data and neighbors.
if [[ "$COMMAND" == *caws* ]]; then
  # Surfaces without an updatedInput contract (kimi-code: none documented)
  # cannot rewrite the command — pass it through unrewritten. This hook does
  # not have block authority, so lack of rewrite support must not deny access.
  if [[ "${CAWS_SUPPORTS_UPDATED_INPUT:-1}" != "1" ]]; then
    exit 0
  fi
  if [[ -z "${HOOK_CWD:-}" || ! -d "$HOOK_CWD" ]]; then
    exit 0
  fi
  EXPECTED_CWD="$(cd -- "$HOOK_CWD" && pwd -P)" || exit 0
  if [[ -n "${HOOK_PAYLOAD_FILE:-}" ]]; then
    if [[ ! -f "$HOOK_PAYLOAD_FILE" || ! -r "$HOOK_PAYLOAD_FILE" ]]; then
      echo '[quiet-merge] Original payload is unavailable; lifecycle CWD rewrite skipped.' >&2
      exit 0
    fi
  elif [[ -z "${HOOK_INPUT_JSON:-}" ]]; then
    HOOK_INPUT_JSON="$(cat)" || exit 0
    export -n HOOK_INPUT_JSON 2>/dev/null || true
  fi
  original_payload() {
    if [[ -n "${HOOK_PAYLOAD_FILE:-}" ]]; then cat "$HOOK_PAYLOAD_FILE"
    else printf '%s' "${HOOK_INPUT_JSON:-}"; fi
  }
  if ! command -v "${CAWS_BIN:-caws}" >/dev/null 2>&1 ||
      ! FACTS="$(original_payload | "${CAWS_BIN:-caws}" hooks mutation-view --json \
        --cwd "$EXPECTED_CWD" --project "$PROJECT_DIR")"; then
    echo '[quiet-merge] Lifecycle source/context could not be proved; CWD rewrite skipped.' >&2
    exit 0
  fi
  if ! printf '%s' "$FACTS" | jq -se --arg command "$COMMAND" --arg cwd "$EXPECTED_CWD" '
      length==1 and .[0].schema=="caws.shell_mutation_view.v1" and
      .[0].execution.command==$command and .[0].execution.cwd==$cwd and
      (.[0].issues|type)=="array" and (.[0].issues|length)==0 and
      (.[0].singleLifecycle=="merge" or .[0].singleLifecycle=="destroy")
    ' >/dev/null 2>&1; then
    exit 0
  fi
  # Always prepend cd to repo root for CWD safety (critical for subagents
  # whose CWD is inside the worktree being destroyed)
  printf -v QUOTED_PROJECT '%q' "$PROJECT_DIR"
  SAFE_CMD="cd $QUOTED_PROJECT && $COMMAND"
  # Hosts that enforce the updatedInput contract (observed live: "PreToolUse
  # hook returned updatedInput without permissionDecision:allow") reject a
  # rewrite that carries no explicit decision. The rewrite is an allow-with-
  # modification by construction, so say so.
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"quiet-merge: reroot merge/destroy for CWD safety without changing command output or status","updatedInput":{"command":%s}}}' "$(printf '%s' "$SAFE_CMD" | jq -Rs .)"
  exit 0
fi

exit 0
