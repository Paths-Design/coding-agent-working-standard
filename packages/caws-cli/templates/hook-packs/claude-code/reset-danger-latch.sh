#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: claude-code
# hook_pack_version: 1
# caws_min_major: 11
# lineage_refs: 17
# do_not_edit_directly: update via `caws init --agent-surface claude-code`
# Active checkout wrapper for the shipped CAWS danger-latch reset tool.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
TEMPLATE_RESET="$PROJECT_DIR/packages/caws-cli/templates/.claude/hooks/reset-danger-latch.sh"

if [[ ! -x "$TEMPLATE_RESET" ]]; then
  echo "reset-danger-latch.sh template is unavailable: $TEMPLATE_RESET" >&2
  exit 2
fi

exec "$TEMPLATE_RESET" "$@"
