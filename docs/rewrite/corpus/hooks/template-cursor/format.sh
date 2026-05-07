#!/bin/bash
# Cursor Hook: Auto-formatting
# 
# Purpose: Run formatters after file edits
# Event: afterFileEdit
# 
# @author @darianrosebrook

set -euo pipefail

# Read input from Cursor
INPUT=$(cat)

# Extract file path
FILE_PATH=$(echo "$INPUT" | jq -r '.file_path // ""')

# Only format source code files
if [[ "$FILE_PATH" =~ \.(js|ts|jsx|tsx|json|md|yml|yaml)$ ]]; then
  # Try prettier if available
  if command -v prettier &> /dev/null; then
    prettier --write "$FILE_PATH" 2>/dev/null || true
  elif [ -f "node_modules/.bin/prettier" ]; then
    node_modules/.bin/prettier --write "$FILE_PATH" 2>/dev/null || true
  fi
  
  # Try eslint for JS/TS files
  if [[ "$FILE_PATH" =~ \.(js|ts|jsx|tsx)$ ]]; then
    if command -v eslint &> /dev/null; then
      eslint --fix "$FILE_PATH" 2>/dev/null || true
    elif [ -f "node_modules/.bin/eslint" ]; then
      node_modules/.bin/eslint --fix "$FILE_PATH" 2>/dev/null || true
    fi
  fi
fi

# Always allow - formatting is non-blocking
exit 0

