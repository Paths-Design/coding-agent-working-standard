#!/bin/bash
# CAWS Scope Guard Hook
# Prevents agents from accessing files outside CAWS-defined scope
# @author @darianrosebrook

set -e

# Read input from Cursor
INPUT=$(cat)
ACTION=$(echo "$INPUT" | jq -r '.action // ""')
FILE_PATH=$(echo "$INPUT" | jq -r '.file_path // ""')

# Check if CAWS is available and we have a CAWS project (per-feature specs under .caws/specs/)
if command -v caws &> /dev/null && [[ -d ".caws/specs" ]]; then

  # AGENT GUARDRAILS - Prevent policy bypass attempts
  if [[ "$ACTION" == "edit_file" ]] || [[ "$ACTION" == "create_file" ]]; then
    if [[ "$FILE_PATH" == ".caws/policy.yaml" ]]; then
      echo '{
        "userMessage": "🚫 Policy file editing blocked by agent guardrails",
        "agentMessage": "Agents cannot edit .caws/policy.yaml - requires human dual control",
        "block": true,
        "suggestions": [
          "Policy changes must be approved by humans with Gatekeeper role",
          "Create a separate PR for policy changes",
          "For budget exceptions: caws waivers create --title=\"Budget exception\" --reason=architectural_refactor --gates=budget_limit",
          "Contact @gatekeepers for policy modifications"
        ]
      }'
      exit 1
    fi

    if [[ "$FILE_PATH" == "CODEOWNERS" ]]; then
      echo '{
        "userMessage": "🚫 CODEOWNERS editing blocked by agent guardrails",
        "agentMessage": "Agents cannot modify CODEOWNERS - governance changes require approval",
        "block": true,
        "suggestions": [
          "CODEOWNERS changes require governance review",
          "Contact repository maintainers for ownership changes",
          "For approval workflows: caws waivers create --reason=governance_change"
        ]
      }'
      exit 1
    fi

    if [[ "$FILE_PATH" == .caws/specs/*.yaml ]] || [[ "$FILE_PATH" == .caws/specs/*.yml ]]; then
      # Check if trying to add change_budget to any feature spec
      FILE_CONTENT=$(echo "$INPUT" | jq -r '.content // ""')
      if echo "$FILE_CONTENT" | grep -q "change_budget"; then
        echo '{
          "userMessage": "🚫 Budget editing blocked by agent guardrails",
          "agentMessage": "Agents cannot introduce change_budget fields - budgets are derived automatically",
          "block": true,
          "suggestions": [
            "Check current budget status: caws burnup --spec-id <id>",
            "For budget exceptions: caws waivers create --title=\"Scope expansion\" --reason=architectural_refactor --gates=budget_limit --expires-at=\"2025-12-31T23:59:59Z\"",
            "Add waiver_ids to the spec instead: [\"WV-XXXX\"]",
            "Validate waiver: caws validate --spec-id <id>"
          ]
        }'
        exit 1
      fi
    fi
  fi

  # For file access actions, check scope against the bound feature spec
  if [[ "$ACTION" == "read_file" ]] || [[ "$ACTION" == "edit_file" ]] || [[ -n "$FILE_PATH" ]]; then

    # Get scope information from CAWS (uses the bound spec resolved from worktree)
    SCOPE_CHECK=$(caws scope check "$FILE_PATH" 2>/dev/null || echo "unknown")

    if [[ "$SCOPE_CHECK" == "out_of_scope" ]]; then
      echo '{
        "userMessage": "🚫 File access blocked by CAWS scope guard",
        "agentMessage": "Cannot access '"$FILE_PATH"' - outside the bound feature spec scope",
        "block": true,
        "suggestions": [
          "Check current scope: caws scope show",
          "Update scope.in in the bound feature spec under .caws/specs/<id>.yaml",
          "For scope exceptions: caws waivers create --title=\"Scope expansion\" --reason=architectural_refactor --gates=scope_boundary --description=\"Need access to '"$FILE_PATH"' for implementation\"",
          "Validate changes: caws validate --spec-id <id>"
        ]
      }'
      exit 1
    elif [[ "$SCOPE_CHECK" == "scope_warning" ]]; then
      echo '{
        "userMessage": "⚠️ File access outside primary scope",
        "agentMessage": "File '"$FILE_PATH"' is outside primary scope but allowed",
        "suggestions": [
          "Check if needed in primary scope: edit .caws/specs/<id>.yaml scope.in",
          "Consider scope implications: caws evaluate",
          "Document scope decision in spec invariants",
          "Validate scope changes: caws validate --spec-id <id>"
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
        if [[ -f "$file" ]] && ! caws scope check "$file" 2>/dev/null | grep -q "in_scope"; then
          OUT_OF_SCOPE="$OUT_OF_SCOPE $file"
        fi
      done

      if [[ -n "$OUT_OF_SCOPE" ]]; then
        echo '{
          "userMessage": "⚠️ Prompt references files outside CAWS scope",
          "agentMessage": "Prompt mentions out-of-scope files: '"$OUT_OF_SCOPE"'",
          "suggestions": [
            "Check current scope definition: caws scope show",
            "Update scope.in in the bound feature spec under .caws/specs/<id>.yaml",
            "For scope exceptions: caws waivers create --title=\"Scope expansion\" --reason=architectural_refactor --gates=scope_boundary",
            "Refocus prompt on in-scope files or request scope update approval",
            "Validate scope changes: caws validate --spec-id <id>"
          ]
        }'
      fi
    fi
  fi
fi
