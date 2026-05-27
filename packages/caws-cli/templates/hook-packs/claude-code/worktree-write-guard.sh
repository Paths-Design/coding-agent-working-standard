#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: claude-code
# hook_pack_version: 9
# caws_min_major: 11
# lineage_refs: 4,8,13
# do_not_edit_directly: update via `caws init --agent-surface claude-code`
#
# CAWS Worktree Write Guard for Claude Code.
#
# Two responsibilities:
#
#   1. Canonical-spec-materialization refusal
#      (WORKTREE-SPEC-CANONICAL-ACCESS-GUARD-001 A1/A2).
#      From inside a linked worktree (git rev-parse --git-common-dir !=
#      git rev-parse --git-dir, after realpath normalization), refuse
#      Read/Write/Edit tool calls whose file_path resolves under
#      <linked-worktree>/.caws/specs/*. Such files would be private
#      materialized copies of canonical spec authority, divergent from
#      the canonical .caws/specs bytes, silently consulted by anything
#      that walks cwd upward. The refusal MUST fire BEFORE the broad
#      .caws/* allowlist below, otherwise the allowlist would exit 0
#      first and the slice would appear implemented while the target
#      path still bypassed the guard. The canonical checkout itself
#      (git_common_dir == git_dir) IS spec authority and is allowed
#      through this predicate; this refusal targets the linked-worktree
#      materialization class only.
#
#   2. Base-branch write enforcement (intentionally fail-open for
#      v11.1, restored in CLI-WORKTREE-001). The hook serves as the
#      managed-install seat for the worktree-write enforcement surface
#      and asserts the always-allowed allowlist so .caws/, .claude/,
#      docs/, scripts/, tmp/, and tests/ writes are never inadvertently
#      blocked by a future enforcement pass that forgets the allowlist.
#
# Worktree-active enforcement (when restored) must read the worktrees
# registry under both shapes:
#   v11 direct-key: { "<name>": { ... } }
#   v10 nested:     { "worktrees": { "<name>": { ... } } }
# and accept both specId (v10) and spec_id (v11) on entries.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/parse-input.sh
source "$SCRIPT_DIR/lib/parse-input.sh"
parse_hook_input

TOOL_NAME="$HOOK_TOOL_NAME"
FILE_PATH="$HOOK_FILE_PATH"

case "$TOOL_NAME" in
  Read|Write|Edit) ;;
  *) exit 0 ;;
esac

# WORKTREE_ROOT: where the agent is operating from. This is the cwd
# whose .caws/specs/* path is the refusal target. Kept distinct from
# CANONICAL_ROOT below — these MUST NOT be conflated for the spec-path
# predicate.
WORKTREE_ROOT="${CLAUDE_PROJECT_DIR:-.}"
WORKTREE_ROOT="$(cd "$WORKTREE_ROOT" 2>/dev/null && pwd -P || printf '%s\n' "$WORKTREE_ROOT")"

# _realpath: best-effort realpath. macOS lacks `readlink -f` by default;
# python3 is available on every supported runner (CI matrix verified).
# Falls back to the original path if realpath cannot resolve.
_realpath() {
  local p="$1"
  if [[ -z "$p" ]]; then
    printf '%s\n' ""
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import os, sys; print(os.path.realpath(sys.argv[1]))" "$p" 2>/dev/null || printf '%s\n' "$p"
  else
    printf '%s\n' "$p"
  fi
}

# Linked-worktree detection via git as primary signal. CAWS registry
# (.caws/worktrees.json) is consulted ONLY for diagnostic enrichment;
# a registry desync MUST NOT suppress the refusal (I3).
IS_LINKED_WORKTREE=0
CANONICAL_ROOT=""
if command -v git >/dev/null 2>&1; then
  GIT_COMMON_DIR_RAW="$(cd "$WORKTREE_ROOT" 2>/dev/null && git rev-parse --git-common-dir 2>/dev/null || printf '')"
  GIT_DIR_RAW="$(cd "$WORKTREE_ROOT" 2>/dev/null && git rev-parse --git-dir 2>/dev/null || printf '')"
  if [[ -n "$GIT_COMMON_DIR_RAW" ]] && [[ -n "$GIT_DIR_RAW" ]]; then
    # Resolve relative paths against WORKTREE_ROOT before realpath.
    case "$GIT_COMMON_DIR_RAW" in
      /*) GIT_COMMON_DIR_ABS="$GIT_COMMON_DIR_RAW" ;;
      *)  GIT_COMMON_DIR_ABS="$WORKTREE_ROOT/$GIT_COMMON_DIR_RAW" ;;
    esac
    case "$GIT_DIR_RAW" in
      /*) GIT_DIR_ABS="$GIT_DIR_RAW" ;;
      *)  GIT_DIR_ABS="$WORKTREE_ROOT/$GIT_DIR_RAW" ;;
    esac
    GIT_COMMON_DIR="$(_realpath "$GIT_COMMON_DIR_ABS")"
    GIT_DIR="$(_realpath "$GIT_DIR_ABS")"
    if [[ -n "$GIT_COMMON_DIR" ]] && [[ "$GIT_COMMON_DIR" != "$GIT_DIR" ]]; then
      IS_LINKED_WORKTREE=1
      # CANONICAL_ROOT = parent of GIT_COMMON_DIR. Used for allowlist
      # rewriting only; NOT used for the spec-path refusal predicate.
      CANONICAL_CANDIDATE="$(_realpath "$GIT_COMMON_DIR/..")"
      if [[ -n "$CANONICAL_CANDIDATE" ]] && [[ -d "$CANONICAL_CANDIDATE/.caws" ]]; then
        CANONICAL_ROOT="$CANONICAL_CANDIDATE"
      fi
    fi
  fi
fi

# Canonical-spec-materialization refusal (I1: BEFORE the allowlist).
#
# Predicate: tool_name in {Read,Write,Edit} (already gated above)
#            AND is_linked_worktree (via git signal)
#            AND FILE_PATH resolves under <WORKTREE_ROOT>/.caws/specs/.
#
# WORKTREE_ROOT is the cwd-as-resolved-via-CLAUDE_PROJECT_DIR. NOT
# CANONICAL_ROOT, NOT a PROJECT_DIR that has been rewritten upward. The
# refused path lives under the LINKED worktree's tree.
if [[ "$IS_LINKED_WORKTREE" == "1" ]] && [[ -n "$FILE_PATH" ]]; then
  # WORKTREE_ROOT is already realpath-normalized (pwd -P above), so
  # SPEC_ROOT inherits that normalization. We MUST also normalize
  # FILE_PATH_ABS through _realpath so the comparison is symlink-
  # immune. On macOS, /tmp -> /private/tmp; without normalization, an
  # agent-supplied /tmp/.../.caws/specs/X.yaml would NOT prefix-match
  # SPEC_ROOT=/private/tmp/.../.caws/specs because the literal strings
  # diverge. python3 os.path.realpath resolves the existing prefix
  # even when the leaf does not exist (Write tool case).
  SPEC_ROOT="$WORKTREE_ROOT/.caws/specs"
  case "$FILE_PATH" in
    /*) FILE_PATH_ABS="$FILE_PATH" ;;
    *)  FILE_PATH_ABS="$WORKTREE_ROOT/$FILE_PATH" ;;
  esac
  FILE_PATH_ABS="$(_realpath "$FILE_PATH_ABS")"
  case "$FILE_PATH_ABS" in
    "$SPEC_ROOT"/*|"$SPEC_ROOT")
      echo "[worktree-write-guard.sh] BLOCKED: $FILE_PATH" >&2
      echo "[worktree-write-guard.sh] Refusing $TOOL_NAME against a linked-worktree .caws/specs/ path." >&2
      echo "[worktree-write-guard.sh]" >&2
      echo "[worktree-write-guard.sh] Linked worktrees must not use worktree-local .caws/specs/ files as authority." >&2
      echo "[worktree-write-guard.sh] That path would be a private materialized copy, not canonical spec authority." >&2
      echo "[worktree-write-guard.sh] CAWS resolves spec reads through the canonical control plane regardless of cwd." >&2
      echo "[worktree-write-guard.sh]" >&2
      echo "[worktree-write-guard.sh] To read a spec from any cwd (including this worktree), use:" >&2
      echo "[worktree-write-guard.sh]   caws specs show <id>" >&2
      echo "[worktree-write-guard.sh]" >&2
      echo "[worktree-write-guard.sh] To check scope from any cwd, use:" >&2
      echo "[worktree-write-guard.sh]   caws scope show <path>" >&2
      echo "[worktree-write-guard.sh]   caws scope check <path>" >&2
      echo "[worktree-write-guard.sh]" >&2
      echo "[worktree-write-guard.sh] If sparse-checkout was disabled in this worktree and you need to restore" >&2
      echo "[worktree-write-guard.sh] the canonical-only invariant, run from the canonical checkout:" >&2
      echo "[worktree-write-guard.sh]   caws worktree repair-sparse <name>" >&2
      exit 2
      ;;
  esac
fi

# Legacy allowlist preserved from v11.1 fail-open base-branch enforcement.
# For the allowlist, use PROJECT_DIR rewritten toward the canonical checkout
# (the historical behavior) so that .caws/ etc. paths under canonical also
# match when the agent is operating from inside a linked worktree.
PROJECT_DIR="$WORKTREE_ROOT"
if [[ -n "$CANONICAL_ROOT" ]]; then
  PROJECT_DIR="$CANONICAL_ROOT"
fi

# Always-allowed paths bypass any future enforcement.
# User-global Claude state lives outside the repo; .caws/, .claude/, docs/,
# scripts/, tmp/, .archive/, and .githooks/ are coordination/governance
# surfaces, not application code.
if [[ -n "$FILE_PATH" ]]; then
  case "$FILE_PATH" in
    "${HOME:-}"/.claude/*) exit 0 ;;
    "$PROJECT_DIR"/.caws/*|.caws/*) exit 0 ;;
    "$PROJECT_DIR"/.claude/*|.claude/*) exit 0 ;;
    "$PROJECT_DIR"/.gitignore|.gitignore) exit 0 ;;
    "$PROJECT_DIR"/.tmp/*|.tmp/*) exit 0 ;;
    "$PROJECT_DIR"/tmp/*|tmp/*) exit 0 ;;
    "$PROJECT_DIR"/.archive/*|.archive/*) exit 0 ;;
    "$PROJECT_DIR"/.githooks/*|.githooks/*) exit 0 ;;
    "$PROJECT_DIR"/.github/*|.github/*) exit 0 ;;
    "$PROJECT_DIR"/docs/*|docs/*) exit 0 ;;
  esac
fi

# Fail-open until CLI-WORKTREE-001 (Slice 6) restores worktree lifecycle.
# When that lands, this hook gains worktree-active enforcement using the
# dual-shape registry helpers that scope-guard.sh and worktree-guard.sh
# already use.
exit 0
