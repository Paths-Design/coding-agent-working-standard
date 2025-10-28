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
  echo "🔍 Validating CAWS working spec..." >&2

  # Check if CAWS CLI is available
  if command -v caws &> /dev/null; then
    # Run CAWS validation with suggestions
    if VALIDATION=$(caws validate "$FILE_PATH" --quiet 2>&1); then
      echo '{"userMessage":"✅ CAWS spec validation passed","agentMessage":"Working specification is valid and complete."}' 2>/dev/null
    else
      # Get suggestions for fixing the spec
      SUGGESTIONS=$(caws validate "$FILE_PATH" --suggestions 2>/dev/null | head -5 | tr '\n' '; ' | sed 's/; $//' || echo "Run caws validate --suggestions for details")

      echo '{
        "userMessage": "⚠️ CAWS spec validation failed. Run: caws validate --suggestions",
        "agentMessage": "The working-spec.yaml file has validation errors. Please review and fix before continuing.",
        "suggestions": [
          "Run caws validate --suggestions for detailed error messages",
          "Check required fields: id, title, risk_tier, mode",
          "Ensure acceptance criteria are properly defined",
          "Verify scope boundaries are appropriate"
        ]
      }' 2>/dev/null
    fi
  else
    echo '{"userMessage":"⚠️ CAWS CLI not available for validation","agentMessage":"Install CAWS CLI for automatic spec validation: npm install -g @caws/cli"}' 2>/dev/null
  fi
fi

# Allow the edit
exit 0

