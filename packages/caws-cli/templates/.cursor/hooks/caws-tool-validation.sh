#!/bin/bash
# CAWS Tool Validation Hook
# Validates MCP tool calls against CAWS security policies
# @author @darianrosebrook

set -e

# Read input from Cursor
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
TOOL_ARGS=$(echo "$INPUT" | jq -r '.arguments // "{}"')

# Only validate CAWS-related tools
if [[ "$TOOL_NAME" =~ ^caws_ ]]; then

  echo "🔍 Validating CAWS tool call: $TOOL_NAME" >&2

  # Check if CAWS CLI is available
  if ! command -v caws &> /dev/null; then
    echo '{
      "userMessage": "❌ CAWS CLI not available",
      "agentMessage": "Cannot execute CAWS tools - CLI not installed",
      "block": true,
      "suggestions": [
        "Install CAWS CLI: npm install -g @caws/cli",
        "Check PATH includes CAWS CLI"
      ]
    }'
    exit 1
  fi

  # Check if we're in a CAWS project
  if [[ ! -f ".caws/working-spec.yaml" ]]; then
    echo '{
      "userMessage": "⚠️ Not in a CAWS project",
      "agentMessage": "CAWS tools require .caws/working-spec.yaml",
      "suggestions": [
        "Initialize CAWS project: caws init",
        "Create working spec: caws scaffold"
      ]
    }'
  fi

  # Validate tool-specific arguments
  case "$TOOL_NAME" in
    "caws_waiver_create")
      # Check waiver creation permissions
      IMPACT_LEVEL=$(echo "$TOOL_ARGS" | jq -r '.impactLevel // "low"')

      if [[ "$IMPACT_LEVEL" == "critical" ]]; then
        echo '{
          "userMessage": "🚨 Critical waiver requires approval",
          "agentMessage": "Critical impact waivers need human approval",
          "block": false,
          "warnings": [
            "Critical waivers require code owner review",
            "Waiver will be flagged for manual approval"
          ]
        }'
      fi

      # Check expiration time
      EXPIRES_AT=$(echo "$TOOL_ARGS" | jq -r '.expiresAt // ""')
      if [[ -n "$EXPIRES_AT" ]]; then
        EXPIRE_TIME=$(date -j -f "%Y-%m-%dT%H:%M:%S%Z" "$EXPIRES_AT" +%s 2>/dev/null || echo "")
        CURRENT_TIME=$(date +%s)
        DAYS_DIFF=$(( (EXPIRE_TIME - CURRENT_TIME) / 86400 ))

        if [[ $DAYS_DIFF -gt 90 ]]; then
          echo '{
            "userMessage": "⚠️ Waiver expiration too far in future",
            "agentMessage": "Waivers cannot exceed 90 days expiration",
            "suggestions": [
              "Reduce expiration time to within 90 days",
              "Consider shorter waiver periods for better security"
            ]
          }'
        fi
      fi
      ;;

    "caws_evaluate"|"caws_iterate")
      # These are generally safe to run
      echo '{"userMessage": "✅ CAWS quality tool validated", "agentMessage": "Tool execution approved"}'
      ;;

    *)
      # Unknown CAWS tool - allow but warn
      echo '{
        "userMessage": "⚠️ Unknown CAWS tool",
        "agentMessage": "Tool '"'"$TOOL_NAME"'"' not recognized - proceeding with caution",
        "suggestions": [
          "Verify tool name and arguments",
          "Check CAWS CLI documentation"
        ]
      }'
      ;;
  esac

elif [[ "$TOOL_NAME" =~ (exec|shell|run|terminal) ]]; then
  # Generic shell execution - check for dangerous commands
  COMMAND=$(echo "$TOOL_ARGS" | jq -r '.command // .cmd // ""')

  DANGEROUS_COMMANDS=("rm -rf" "rm -rf /" "format" "mkfs" "dd" "fdisk" ">" "sudo" "chmod 777")

  for dangerous in "${DANGEROUS_COMMANDS[@]}"; do
    if [[ "$COMMAND" =~ $dangerous ]]; then
      echo '{
        "userMessage": "🚫 Dangerous command blocked",
        "agentMessage": "Command contains dangerous operations: '"'"$dangerous"'"'",
        "block": true,
        "suggestions": [
          "Avoid destructive operations",
          "Use safer alternatives",
          "Get explicit approval for dangerous commands"
        ]
      }'
      exit 1
    fi
  done
fi
