#!/bin/bash
# Cursor Hook: CAWS Spec Validation
# 
# Purpose: Validate working-spec.yaml when it's edited
# Event: afterFileEdit
# 
# @author @darianrosebrook

set -euo pipefail

# Read input from Cursor
INPUT=$(cat)

# Extract file path from input
FILE_PATH=$(echo "$INPUT" | jq -r '.file_path // ""')

# Only validate if working-spec.yaml was edited
if [[ "$FILE_PATH" == *"working-spec.yaml"* ]] || [[ "$FILE_PATH" == *"working-spec.yml"* ]]; then
  # Run CAWS validation
  if [ -f "apps/tools/caws/validate.js" ]; then
    if ! node apps/tools/caws/validate.js --quiet 2>/dev/null; then
      echo '{"userMessage":"⚠️ CAWS spec validation failed. Run: caws validate --suggestions","agentMessage":"The working-spec.yaml file has validation errors. Please review and fix before continuing."}' 2>/dev/null
      exit 0
    fi
  else
    # Fallback: try caws CLI
    if command -v caws &> /dev/null; then
      if ! caws validate --quiet 2>/dev/null; then
        echo '{"userMessage":"⚠️ CAWS spec validation failed. Run: caws validate --suggestions","agentMessage":"The working-spec.yaml file has validation errors."}' 2>/dev/null
        exit 0
      fi
    fi
  fi
fi

# Allow the edit
exit 0

