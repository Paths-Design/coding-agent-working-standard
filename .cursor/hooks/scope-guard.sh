#!/bin/bash
# Cursor Hook: Scope Guard
# 
# Purpose: Check if files being worked on are within working-spec scope
# Event: beforeSubmitPrompt
# 
# @author @darianrosebrook

set -euo pipefail

# Read input from Cursor
INPUT=$(cat)

# Extract attachments
ATTACHMENTS=$(echo "$INPUT" | jq -r '.attachments // []')

# Only check if we have file attachments and a working spec
if [ ! -f ".caws/working-spec.yaml" ] && [ ! -f ".caws/working-spec.yml" ]; then
  # No spec file, allow by default
  echo '{"continue":true}' 2>/dev/null
  exit 0
fi

# Check if scope-guard tool exists
if [ -f "apps/tools/caws/scope-guard.js" ]; then
  # Extract file paths from attachments
  FILE_PATHS=$(echo "$ATTACHMENTS" | jq -r '.[] | select(.type=="file") | .file_path' 2>/dev/null || echo "")
  
  if [ -n "$FILE_PATHS" ]; then
    # Check each file against scope
    OUT_OF_SCOPE=()
    while IFS= read -r file; do
      if [ -n "$file" ]; then
        if ! node apps/tools/caws/scope-guard.js check "$file" 2>/dev/null; then
          OUT_OF_SCOPE+=("$file")
        fi
      fi
    done <<< "$FILE_PATHS"
    
    # If any files are out of scope, warn but don't block
    if [ ${#OUT_OF_SCOPE[@]} -gt 0 ]; then
      FILES_LIST=$(printf '%s\n' "${OUT_OF_SCOPE[@]}")
      echo '{"continue":true,"userMessage":"⚠️ Warning: Some attached files may be outside working-spec scope:\n'"$FILES_LIST"'","agentMessage":"Some files are outside the defined scope in working-spec.yaml. Consider updating the scope or removing these files."}' 2>/dev/null
      exit 0
    fi
  fi
fi

# Allow by default
echo '{"continue":true}' 2>/dev/null
exit 0

