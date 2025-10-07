#!/bin/bash
# CAWS Quality Check Hook
# Runs CAWS quality validation after file edits
# @author @darianrosebrook

set -e

# Read input from Cursor
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.file_path // ""')

# Only run on source files
if [[ "$FILE_PATH" =~ \.(js|ts|jsx|tsx|py|go|rs|java)$ ]] && [[ ! "$FILE_PATH" =~ node_modules ]] && [[ ! "$FILE_PATH" =~ dist ]]; then

  # Check if CAWS is available
  if command -v caws &> /dev/null; then

    # Check if we're in a CAWS project
    if [[ -f ".caws/working-spec.yaml" ]]; then

      echo "🔍 Running CAWS quality check..." >&2

      # Run CAWS evaluation in quiet mode for fast feedback
      if caws agent evaluate .caws/working-spec.yaml --quiet 2>/dev/null; then
        echo '{"userMessage": "✅ CAWS quality check passed", "agentMessage": "Quality standards maintained"}'
      else
        # Get detailed feedback
        EVALUATION=$(caws agent evaluate .caws/working-spec.yaml --json 2>/dev/null || echo '{"success": false, "error": "Evaluation failed"}')

        # Parse the evaluation result
        SUCCESS=$(echo "$EVALUATION" | jq -r '.success // false')
        SCORE=$(echo "$EVALUATION" | jq -r '.evaluation.quality_score // 0')

        if [[ "$SUCCESS" == "true" ]] && (( $(echo "$SCORE > 0.75" | bc -l) )); then
          echo '{"userMessage": "✅ CAWS quality standards met", "agentMessage": "Code meets quality requirements"}'
        else
          FAILED_GATES=$(echo "$EVALUATION" | jq -r '.evaluation.criteria[] | select(.status == "failed") | .name' | tr '\n' ', ' | sed 's/, $//')

          echo '{
            "userMessage": "⚠️ CAWS quality issues detected. Run: caws agent evaluate",
            "agentMessage": "Quality gates failed: '"$FAILED_GATES"'",
            "suggestions": [
              "Run caws agent evaluate for detailed feedback",
              "Consider creating a waiver if justified: caws waivers create",
              "Address failing quality gates before proceeding"
            ]
          }'
        fi
      fi
    fi
  fi
fi
