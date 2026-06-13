#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: shared
# hook_pack_version: 1
# caws_min_major: 11
# lineage_refs: (new in shared-core-001)
# do_not_edit_directly: update via `caws init`
# Surface resolver — derives harness-specific values from CAWS_AGENT_SURFACE.
#
# WHY THIS EXISTS. The shared core must not branch on a hardcoded harness name
# or read a harness-specific env var directly (architecture invariant from
# docs/architecture/hook-pack-shared-core.md §"Dependency-injection environment
# contract"). All harness specifics reach shared scripts through an injected
# environment set by the vendor wiring at hook-invocation time.
#
# This file is the single point that maps the injected CAWS_AGENT_SURFACE into
# the derived values every shared hook needs:
#
#   CAWS_VENDOR_DIR     — the harness's dot-directory name (e.g. ".claude",
#                         ".codex"). No trailing slash.
#   CAWS_LOG_DIR        — absolute path to the harness's log directory
#                         ($CAWS_PROJECT_DIR/<vendor>/logs). Requires
#                         CAWS_PROJECT_DIR to be non-empty; otherwise empty.
#   CAWS_PLATFORM_FLAG  — the value to pass as --platform to any CAWS CLI
#                         invocations that accept it (e.g. "claude-code",
#                         "codex").
#   CAWS_PERMISSION_VOCAB — "ask" when the harness supports a PreToolUse "ask"
#                         decision (Claude Code), "deny" when it does not
#                         (Codex maps ask->deny). Used by emit.sh to select
#                         the correct permission-decision vocabulary.
#
# PROJECT ROOT RESOLUTION (back-compat fallback chain):
#   CAWS_PROJECT_DIR is the canonical env var injected by the vendor wiring.
#   If it is not set (not-yet-migrated wiring), this resolver falls back to:
#     1. CLAUDE_PROJECT_DIR  (legacy Claude Code wiring)
#     2. CODEX_PROJECT_DIR   (legacy Codex wiring)
#     3. .  (cwd — last resort)
#   The resolved value is re-exported as CAWS_PROJECT_DIR so all downstream
#   scripts can use the single canonical name.
#
# SURFACES:
#   claude-code  — Claude Code (Anthropic CLI). Default when CAWS_AGENT_SURFACE
#                  is unset, preserving back-compat for any existing wiring that
#                  does not yet inject the surface identity.
#   codex        — OpenAI Codex CLI.
#   (future)     — cursor, windsurf, vscode, idea, ... Add a case arm below.
#
# IDEMPOTENT: safe to source multiple times.
#
# FAIL-OPEN: unknown surface falls through to the claude-code defaults so a
# misconfigured wiring does not become a hard block.

if [[ -n "${_CAWS_AGENT_SURFACE_SH_LOADED:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
_CAWS_AGENT_SURFACE_SH_LOADED=1

# ---------------------------------------------------------------------------
# 1. Resolve CAWS_PROJECT_DIR with the back-compat fallback chain.
# ---------------------------------------------------------------------------
if [[ -z "${CAWS_PROJECT_DIR:-}" ]]; then
  if [[ -n "${CLAUDE_PROJECT_DIR:-}" ]]; then
    CAWS_PROJECT_DIR="${CLAUDE_PROJECT_DIR}"
  elif [[ -n "${CODEX_PROJECT_DIR:-}" ]]; then
    CAWS_PROJECT_DIR="${CODEX_PROJECT_DIR}"
  else
    CAWS_PROJECT_DIR="."
  fi
fi
export CAWS_PROJECT_DIR

# ---------------------------------------------------------------------------
# 2. Default CAWS_AGENT_SURFACE when unset (back-compat: old wiring did not
#    inject this variable; default to claude-code to preserve behavior).
# ---------------------------------------------------------------------------
: "${CAWS_AGENT_SURFACE:=claude-code}"
export CAWS_AGENT_SURFACE

# ---------------------------------------------------------------------------
# 3. Derive per-surface values.
# ---------------------------------------------------------------------------
case "$CAWS_AGENT_SURFACE" in
  claude-code)
    CAWS_VENDOR_DIR=".claude"
    CAWS_PLATFORM_FLAG="claude-code"
    CAWS_PERMISSION_VOCAB="ask"
    ;;
  codex)
    CAWS_VENDOR_DIR=".codex"
    CAWS_PLATFORM_FLAG="codex"
    # Codex has no PreToolUse "ask" decision; map ask -> deny.
    CAWS_PERMISSION_VOCAB="deny"
    ;;
  cursor)
    CAWS_VENDOR_DIR=".cursor"
    CAWS_PLATFORM_FLAG="cursor"
    CAWS_PERMISSION_VOCAB="ask"
    ;;
  windsurf)
    CAWS_VENDOR_DIR=".windsurf"
    CAWS_PLATFORM_FLAG="windsurf"
    CAWS_PERMISSION_VOCAB="ask"
    ;;
  *)
    # Unknown surface — fall through to claude-code defaults so a
    # misconfigured wiring does not become a hard block. Emit a warning to
    # stderr so the operator can investigate, but do NOT exit non-zero.
    printf '[agent-surface.sh] WARNING: unknown CAWS_AGENT_SURFACE=%s; defaulting to claude-code values\n' \
      "$CAWS_AGENT_SURFACE" >&2
    CAWS_VENDOR_DIR=".claude"
    CAWS_PLATFORM_FLAG="claude-code"
    CAWS_PERMISSION_VOCAB="ask"
    ;;
esac

# ---------------------------------------------------------------------------
# 4. Derive CAWS_LOG_DIR from the resolved project dir and vendor dir.
# ---------------------------------------------------------------------------
if [[ -n "${CAWS_PROJECT_DIR:-}" && "${CAWS_PROJECT_DIR}" != "." ]]; then
  CAWS_LOG_DIR="${CAWS_PROJECT_DIR}/${CAWS_VENDOR_DIR}/logs"
else
  # Project dir is "." (relative fallback) or empty — use a relative path.
  # Individual hooks that need an absolute log dir must resolve cwd themselves.
  CAWS_LOG_DIR="${CAWS_VENDOR_DIR}/logs"
fi

export CAWS_VENDOR_DIR CAWS_PLATFORM_FLAG CAWS_PERMISSION_VOCAB CAWS_LOG_DIR
