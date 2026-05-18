#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: claude-code
# hook_pack_version: 2
# caws_min_major: 11
# lineage_refs: 4,8,13
# do_not_edit_directly: update via `caws init --agent-surface claude-code`
#
# CAWS Worktree Write Guard for Claude Code (v11-shape, intentionally
# fail-open for v11.1).
#
# This hook fires on Write/Edit and currently allows all writes from the
# main checkout. Worktree-first enforcement returns when worktree lifecycle
# is restored in CLI-WORKTREE-001 (Slice 6). Until then, this hook serves
# as the managed-install seat for the worktree-write enforcement surface
# and asserts the always-allowed allowlist so .caws/, .claude/, docs/,
# scripts/, tmp/, and tests/ writes are never inadvertently blocked by a
# future enforcement pass that forgets the allowlist.
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
  Write|Edit) ;;
  *) exit 0 ;;
esac

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
PROJECT_DIR="$(cd "$PROJECT_DIR" 2>/dev/null && pwd || printf '%s\n' "$PROJECT_DIR")"

if command -v git >/dev/null 2>&1; then
  GIT_COMMON_DIR=$(cd "$PROJECT_DIR" && git rev-parse --git-common-dir 2>/dev/null || echo "")
  if [[ -n "$GIT_COMMON_DIR" ]] && [[ "$GIT_COMMON_DIR" != ".git" ]]; then
    CANDIDATE=$(cd "$PROJECT_DIR" && cd "$GIT_COMMON_DIR/.." 2>/dev/null && pwd || echo "")
    if [[ -n "$CANDIDATE" ]] && [[ -d "$CANDIDATE/.caws" ]]; then
      PROJECT_DIR="$CANDIDATE"
    fi
  fi
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
