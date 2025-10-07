#!/bin/bash
# Cursor Hook: Dangerous Command Blocker
# 
# Purpose: Block or ask permission for risky shell commands
# Event: beforeShellExecution
# 
# @author @darianrosebrook

set -euo pipefail

# Read input from Cursor
INPUT=$(cat)

# Extract command and cwd
COMMAND=$(echo "$INPUT" | jq -r '.command // ""')
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')

# Hard blocks - never allow these
HARD_BLOCKS=(
  "rm -rf /"
  "rm -rf /*"
  "rm -rf ~"
  "rm -rf $HOME"
  "> /dev/sda"
  "dd if="
  "mkfs"
  "format c:"
  "del /f /s /q"
  "DROP DATABASE"
  "TRUNCATE TABLE"
)

for blocked in "${HARD_BLOCKS[@]}"; do
  if [[ "$COMMAND" == *"$blocked"* ]]; then
    echo '{"permission":"deny","userMessage":"⚠️ BLOCKED: Dangerous command detected. This operation could cause data loss.","agentMessage":"This command is blocked for safety. If you need to perform this operation, run it manually."}' 2>/dev/null
    exit 0
  fi
done

# Ask permission for risky operations
ASK_PERMISSION=(
  "rm -rf"
  "git push --force"
  "git reset --hard"
  "npm publish"
  "docker rmi"
  "docker system prune"
  "kubectl delete"
  "terraform destroy"
  "DROP TABLE"
  "DELETE FROM"
  "UPDATE.*SET"
)

for risky in "${ASK_PERMISSION[@]}"; do
  if echo "$COMMAND" | grep -qiE "$risky"; then
    echo '{"permission":"ask","userMessage":"⚠️ Risky operation: '"$COMMAND"'. Approve to continue.","agentMessage":"This is a potentially destructive operation. User approval required."}' 2>/dev/null
    exit 0
  fi
done

# Block git operations that skip hooks
if echo "$COMMAND" | grep -qE "(--no-verify|--no-gpg-sign)"; then
  echo '{"permission":"ask","userMessage":"⚠️ This command skips git hooks. Approve to continue.","agentMessage":"Skipping hooks bypasses quality gates. Use with caution."}' 2>/dev/null
  exit 0
fi

# Block force push to main/master
if echo "$COMMAND" | grep -qE "git push.*(--force|-f).*\s+(origin\s+)?(main|master)"; then
  echo '{"permission":"deny","userMessage":"⚠️ BLOCKED: Force push to main/master is not allowed.","agentMessage":"Force pushing to main/master can cause data loss for other developers."}' 2>/dev/null
  exit 0
fi

# Allow by default
echo '{"permission":"allow"}' 2>/dev/null
exit 0

