#!/bin/bash
# CAWS Scope Guard Hook
# Prevents agents from accessing files outside CAWS-defined scope
# @author @darianrosebrook

set -e

# Read input from Cursor
INPUT=$(cat)
ACTION=$(echo "$INPUT" | jq -r '.action // ""')
FILE_PATH=$(echo "$INPUT" | jq -r '.file_path // ""')

# Check if CAWS is available and we have a working spec
if command -v caws &> /dev/null && [[ -f ".caws/working-spec.yaml" ]]; then

  # For file access actions, check scope
  if [[ "$ACTION" == "read_file" ]] || [[ "$ACTION" == "edit_file" ]] || [[ -n "$FILE_PATH" ]]; then

    # Get scope information from CAWS spec
    SCOPE_CHECK=$(caws validate .caws/working-spec.yaml --scope-check "$FILE_PATH" 2>/dev/null || echo "unknown")

    if [[ "$SCOPE_CHECK" == "out_of_scope" ]]; then
      echo '{
        "userMessage": "🚫 File access blocked by CAWS scope guard",
        "agentMessage": "Cannot access '"$FILE_PATH"' - outside CAWS defined scope",
        "block": true,
        "suggestions": [
          "Check CAWS working spec scope definition",
          "Update scope in .caws/working-spec.yaml if needed",
          "Create waiver for scope violation: caws waivers create --reason=scope_violation"
        ]
      }'
      exit 1
    elif [[ "$SCOPE_CHECK" == "scope_warning" ]]; then
      echo '{
        "userMessage": "⚠️ File access outside primary scope",
        "agentMessage": "File '"$FILE_PATH"' is outside primary scope but allowed",
        "suggestions": [
          "Consider if this file should be in primary scope",
          "Update .caws/working-spec.yaml scope if needed"
        ]
      }'
    fi
  fi

  # For prompt submissions, check working spec compliance
  if [[ "$ACTION" == "submit_prompt" ]]; then
    PROMPT_CONTENT=$(echo "$INPUT" | jq -r '.prompt // ""')

    # Check if prompt mentions files outside scope
    if [[ -n "$PROMPT_CONTENT" ]]; then
      MENTIONED_FILES=$(echo "$PROMPT_CONTENT" | grep -oE '\b[a-zA-Z0-9_/.-]+\.(js|ts|jsx|tsx|py|go|rs|java|yaml|json|md)\b' | sort | uniq || true)

      OUT_OF_SCOPE=""
      for file in $MENTIONED_FILES; do
        if [[ -f "$file" ]] && ! caws validate .caws/working-spec.yaml --scope-check "$file" 2>/dev/null | grep -q "in_scope"; then
          OUT_OF_SCOPE="$OUT_OF_SCOPE $file"
        fi
      done

      if [[ -n "$OUT_OF_SCOPE" ]]; then
        echo '{
          "userMessage": "⚠️ Prompt references files outside CAWS scope",
          "agentMessage": "Prompt mentions out-of-scope files: '"$OUT_OF_SCOPE"'",
          "suggestions": [
            "Focus on files within CAWS defined scope",
            "Update working spec scope if additional files needed",
            "Remove out-of-scope file references from prompt"
          ]
        }'
      fi
    fi
  fi
fi
