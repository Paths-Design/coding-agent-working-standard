#!/bin/bash
# CAWS Quality Check Hook for Claude Code
# Runs CAWS quality validation after file edits
# @author @darianrosebrook

set -euo pipefail

# Read JSON input from Claude Code
INPUT=$(cat)

# Extract file info from PostToolUse input
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')

# Only run on Write/Edit of source files
if [[ "$TOOL_NAME" != "Write" ]] && [[ "$TOOL_NAME" != "Edit" ]]; then
  exit 0
fi

# Skip non-source files and node_modules/dist
if [[ ! "$FILE_PATH" =~ \.(js|ts|jsx|tsx|py|go|rs|java|mjs|cjs)$ ]] || \
   [[ "$FILE_PATH" =~ node_modules ]] || \
   [[ "$FILE_PATH" =~ dist/ ]] || \
   [[ "$FILE_PATH" =~ build/ ]]; then
  exit 0
fi

# Determine project directory
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

# Check if we're in a CAWS project
if [[ ! -f "$PROJECT_DIR/.caws/working-spec.yaml" ]]; then
  exit 0
fi

# Check if CAWS CLI is available
if ! command -v caws &> /dev/null; then
  # Suggest installing CAWS
  echo '{
    "hookSpecificOutput": {
      "hookEventName": "PostToolUse",
      "additionalContext": "CAWS CLI not available. Consider installing with: npm install -g @caws/cli"
    }
  }'
  exit 0
fi

# Run CAWS quality gates in quiet mode for quick feedback
if caws quality-gates --context=commit --quiet 2>/dev/null; then
  # Quality check passed - provide positive feedback
  echo '{
    "hookSpecificOutput": {
      "hookEventName": "PostToolUse",
      "additionalContext": "Quality gates passed for this change."
    }
  }'
else
  # Quality check failed - provide feedback to Claude
  # Run again to get violations summary
  VIOLATIONS=$(caws quality-gates --context=commit --json 2>/dev/null | jq -r '.violations[:3] | .[] | "- \(.gate): \(.message)"' 2>/dev/null || echo "Run 'caws quality-gates' for details")

  echo '{
    "decision": "block",
    "reason": "Quality gate violations detected. Please address the following issues before continuing:\n'"$VIOLATIONS"'\n\nRun '\''caws quality-gates'\'' for full details."
  }'
fi

exit 0
