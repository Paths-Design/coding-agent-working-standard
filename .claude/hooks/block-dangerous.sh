#!/bin/bash
# Active checkout wrapper for the shipped CAWS dangerous-command hook.
#
# Keep the enforcement logic in the package template so this repository's
# dispatcher path exercises the same hook that CAWS installs into other repos.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
TEMPLATE_HOOK="$PROJECT_DIR/packages/caws-cli/templates/.claude/hooks/block-dangerous.sh"

if [[ ! -x "$TEMPLATE_HOOK" ]]; then
  jq -n --arg msg "CAWS dangerous-command hook template is unavailable; Bash safety cannot verify this command." '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: $msg
    }
  }'
  exit 0
fi

exec "$TEMPLATE_HOOK"
