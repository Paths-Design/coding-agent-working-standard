#!/bin/bash
# CAWS Scope Guard Hook for Claude Code
# Validates file edits against the working spec's scope boundaries
# @author @darianrosebrook

set -euo pipefail

# Read JSON input from Claude Code
INPUT=$(cat)

# Extract file path from PreToolUse input
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')

# Only check Write/Edit operations
if [[ "$TOOL_NAME" != "Write" ]] && [[ "$TOOL_NAME" != "Edit" ]]; then
  exit 0
fi

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
SPEC_FILE="$PROJECT_DIR/.caws/working-spec.yaml"

# Check if spec file exists
if [[ ! -f "$SPEC_FILE" ]]; then
  exit 0
fi

# Get relative path from project root
REL_PATH=$(realpath --relative-to="$PROJECT_DIR" "$FILE_PATH" 2>/dev/null || echo "$FILE_PATH")

# Use Node.js to parse YAML and check scope
if command -v node >/dev/null 2>&1; then
  SCOPE_CHECK=$(node -e "
    const yaml = require('js-yaml');
    const fs = require('fs');
    const path = require('path');

    try {
      const spec = yaml.load(fs.readFileSync('$SPEC_FILE', 'utf8'));
      const filePath = '$REL_PATH';

      // Check if file is explicitly out of scope
      const outOfScope = spec.scope?.out_of_scope || [];
      for (const pattern of outOfScope) {
        // Simple glob-like matching
        const regex = new RegExp(pattern.replace(/\*/g, '.*').replace(/\?/g, '.'));
        if (regex.test(filePath)) {
          console.log('out_of_scope:' + pattern);
          process.exit(0);
        }
      }

      // Check if file is in scope (if scope is explicitly defined)
      const inScope = spec.scope?.files || spec.scope?.directories || [];
      if (inScope.length > 0) {
        let found = false;
        for (const pattern of inScope) {
          const regex = new RegExp(pattern.replace(/\*/g, '.*').replace(/\?/g, '.'));
          if (regex.test(filePath)) {
            found = true;
            break;
          }
        }
        if (!found) {
          console.log('not_in_scope');
          process.exit(0);
        }
      }

      console.log('in_scope');
    } catch (error) {
      console.log('error:' + error.message);
    }
  " 2>&1)

  if [[ "$SCOPE_CHECK" == out_of_scope:* ]]; then
    PATTERN="${SCOPE_CHECK#out_of_scope:}"
    echo '{
      "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "ask",
        "permissionDecisionReason": "This file ('"$REL_PATH"') is marked as out-of-scope in the working spec (pattern: '"$PATTERN"'). Editing it may cause scope creep. Please confirm this edit is intentional."
      }
    }'
    exit 0
  fi

  if [[ "$SCOPE_CHECK" == "not_in_scope" ]]; then
    echo '{
      "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "ask",
        "permissionDecisionReason": "This file ('"$REL_PATH"') is not in the defined scope of the working spec. Editing it may cause scope creep. Please confirm this edit is intentional."
      }
    }'
    exit 0
  fi
fi

# File is in scope or scope couldn't be checked - allow
exit 0
