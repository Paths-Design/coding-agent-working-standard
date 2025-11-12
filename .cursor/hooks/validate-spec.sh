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

# Validate if any CAWS YAML file was edited (.caws/**/*.yaml or .caws/**/*.yml)
if [[ "$FILE_PATH" == *".caws/"* ]] && ([[ "$FILE_PATH" == *.yaml ]] || [[ "$FILE_PATH" == *.yml ]]); then
  echo "🔍 Validating CAWS spec file..." >&2

  # First, validate YAML syntax
  if command -v node >/dev/null 2>&1; then
    # Check YAML syntax using Node.js
    YAML_SYNTAX_VALID=$(node -e "
      const yaml = require('js-yaml');
      const fs = require('fs');
      try {
        const content = fs.readFileSync('$FILE_PATH', 'utf8');
        yaml.load(content);
        process.exit(0);
      } catch (error) {
        console.error('YAML syntax error:', error.message);
        if (error.mark) {
          console.error('Line:', error.mark.line + 1, 'Column:', error.mark.column + 1);
        }
        process.exit(1);
      }
    " 2>&1)

    if [ $? -ne 0 ]; then
      echo '{
        "userMessage": "⚠️ YAML syntax error detected",
        "agentMessage": "The spec file has invalid YAML syntax. Fix syntax errors before continuing.",
        "suggestions": [
          "Check indentation (YAML uses 2 spaces)",
          "Ensure all array items use consistent format",
          "Remove duplicate keys",
          "Consider using '\''caws specs create <id>'\'' instead of manual creation"
        ]
      }' 2>/dev/null
      exit 0
    fi
  fi

  # Check if CAWS CLI is available for semantic validation
  if command -v caws &> /dev/null; then
    # Run CAWS validation with suggestions
    if VALIDATION=$(caws validate "$FILE_PATH" --quiet 2>&1); then
      echo '{"userMessage":"✅ CAWS spec validation passed","agentMessage":"Specification is valid and complete."}' 2>/dev/null
    else
      # Get suggestions for fixing the spec
      SUGGESTIONS=$(caws validate "$FILE_PATH" --suggestions 2>/dev/null | head -5 | tr '\n' '; ' | sed 's/; $//' || echo "Run caws validate --suggestions for details")

      echo '{
        "userMessage": "⚠️ CAWS spec validation failed. Run: caws validate --suggestions",
        "agentMessage": "The spec file has validation errors. Please review and fix before continuing.",
        "suggestions": [
          "Run caws validate --suggestions for detailed error messages",
          "Check required fields: id, title, risk_tier, mode",
          "Ensure acceptance criteria are properly defined",
          "Verify scope boundaries are appropriate",
          "Consider using '\''caws specs create <id>'\'' for proper structure"
        ]
      }' 2>/dev/null
    fi
  else
    echo '{"userMessage":"⚠️ CAWS CLI not available for validation","agentMessage":"Install CAWS CLI for automatic spec validation: npm install -g @caws/cli"}' 2>/dev/null
  fi
fi

# Allow the edit
exit 0

