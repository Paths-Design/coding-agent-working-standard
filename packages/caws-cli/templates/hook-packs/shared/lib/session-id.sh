#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: shared
# hook_pack_version: 1
# caws_min_major: 11
# lineage_refs: (new — CAWS-SESSION-RESOLVER-GUARD-DIVERGENCE-001)
# edit_stance: YOURS TO EDIT. This is a starting hook, not a locked one — shape it
#   to your repo: tune thresholds, add checks, remove what does not fit. Your edits
#   are preserved: caws init treats a changed hook as intended growth and will not
#   clobber it — it shows a diff and asks (--adopt keeps yours; --overwrite --force
#   takes the upstream template). The CAWS-MANAGED-HOOK marker above is only how caws
#   init finds hooks it can offer updates for; it is NOT a keep-out sign. CAWS owns the
#   failure-class invariant (the why/what a guard protects); you own the how. The one
#   edit to avoid: gutting a guard to dodge a block instead of fixing the cause. Grow
#   everything else freely.
# Session-id resolver — the SHELL-SIDE single source of truth for "what is the
# current session id?" across every hook that needs to compare against a
# worktree owner.
#
# WHY THIS EXISTS (CAWS-SESSION-RESOLVER-GUARD-DIVERGENCE-001). Before this lib,
# three shell surfaces each re-implemented their own session-id precedence, and a
# fourth (the write guards) passed ONLY HOOK_SESSION_ID to the ownership oracle.
# The TS resolver (resolve-session.ts) used yet another, broader chain. The four
# chains disagreed, so the surface that STAMPED an owner (worktree create, via the
# resolver) and the surface that CHECKED an owner (the guards, via the oracle)
# read different sources — and whenever they disagreed the rightful owner was
# treated as foreign (false block_foreign_worktree), or, worse, a foreign session
# could be treated as owner-self. This lib is the shell half of the fix: ONE
# env-var precedence every shell surface consults, mirroring the resolver's chain.
#
# THE CANONICAL PRECEDENCE (env vars only; shell cannot scan disk):
#   1. CLAUDE_SESSION_ID     — operator override (deliberate; always wins)
#   2. CLAUDE_CODE_SESSION_ID — Claude Code harness UUID; survives the agent-Bash
#                               tool boundary (HOOK_SESSION_ID does not)
#   3. CODEX_THREAD_ID        — Codex harness per-thread id; survives the tool
#                               boundary. THE fix for the codex incident: codex
#                               exports this, not CLAUDE_*_SESSION_ID.
#   4. CAWS_SESSION_ID        — generic CAWS escape hatch (any harness)
#   5. HOOK_SESSION_ID        — the hook-envelope id (set only inside the hook's
#                               own shell; does NOT propagate to agent-Bash)
#   6. CURSOR_TRACE_ID        — cursor low-stability fallback
#   → "unknown" sentinel when nothing is set (the resolver refuses this literal).
#
# This MUST stay in lockstep with resolve-session.ts's env-var tiers
# (claude_env → claude_code_env → codex_thread_env → caws_env → hook_env →
# cursor_env). If you add a source to one, add it to the other.
#
# SURFACE DISPATCH. Each harness exports a DIFFERENT per-session id under a
# DIFFERENT env var. Rather than branch on a hardcoded harness name (architecture
# invariant: the shared core must not), this chain simply consults every known
# per-surface var in priority order. The first non-empty, non-"unknown" value
# wins — and because each harness only sets its OWN var, there is no collision
# across concurrent surfaces in the same shell.
#
# IDEMPOTENT: safe to source multiple times.

if [[ -n "${_CAWS_SESSION_ID_SH_LOADED:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
_CAWS_SESSION_ID_SH_LOADED=1

# resolve_caws_session_id — print the current session id per the canonical
# precedence, or "unknown" if no source is set. Reads ONLY env vars; performs no
# disk access. Pure function (no side effects, no exports) so callers can compose
# it. Callers that need the id as a variable: s="$(resolve_caws_session_id)".
#
# A non-empty first positional arg ($1) overrides the entire chain — used by
# surfaces that have an authoritative stdin-payload session_id (block-dangerous.sh
# reads it from the hook JSON) that should win over env. When $1 is empty or
# "unknown", the env chain is consulted instead.
resolve_caws_session_id() {
  local payload_id="${1:-}"
  # The hook payload's session_id is the most authoritative when present (it is
  # what the harness stamped on THIS tool call). Mirror block-dangerous.sh's
  # historical behavior of preferring it over env.
  if [[ -n "$payload_id" && "$payload_id" != "unknown" ]]; then
    printf '%s\n' "$payload_id"
    return 0
  fi
  if [[ -n "${CLAUDE_SESSION_ID:-}" ]]; then
    printf '%s\n' "$CLAUDE_SESSION_ID"
    return 0
  fi
  if [[ -n "${CLAUDE_CODE_SESSION_ID:-}" && "${CLAUDE_CODE_SESSION_ID}" != "unknown" ]]; then
    printf '%s\n' "$CLAUDE_CODE_SESSION_ID"
    return 0
  fi
  if [[ -n "${CODEX_THREAD_ID:-}" && "${CODEX_THREAD_ID}" != "unknown" ]]; then
    printf '%s\n' "$CODEX_THREAD_ID"
    return 0
  fi
  if [[ -n "${CAWS_SESSION_ID:-}" && "${CAWS_SESSION_ID}" != "unknown" ]]; then
    printf '%s\n' "$CAWS_SESSION_ID"
    return 0
  fi
  if [[ -n "${HOOK_SESSION_ID:-}" && "${HOOK_SESSION_ID}" != "unknown" ]]; then
    printf '%s\n' "$HOOK_SESSION_ID"
    return 0
  fi
  if [[ -n "${CURSOR_TRACE_ID:-}" ]]; then
    printf '%s\n' "$CURSOR_TRACE_ID"
    return 0
  fi
  printf '%s\n' "unknown"
}

# resolve_caws_session_id_with_payload — convenience wrapper for guards that
# have HOOK_SESSION_ID already populated from the hook payload but ALSO need to
# fall back to the boundary-crossing vars when HOOK_SESSION_ID is absent (the
# agent-Bash case). Prints the resolved id. Identical to resolve_caws_session_id
# with HOOK_SESSION_ID as the payload argument; kept as a named entry point so
# call sites read clearly.
resolve_caws_session_id_with_payload() {
  resolve_caws_session_id "${1:-${HOOK_SESSION_ID:-}}"
}
