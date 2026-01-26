#!/bin/bash
# CAWS Dangerous Command Blocker for Claude Code
# Blocks potentially destructive shell commands
# @author @darianrosebrook

set -euo pipefail

# Read JSON input from Claude Code
INPUT=$(cat)

# Extract tool info
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

# Only check Bash tool
if [[ "$TOOL_NAME" != "Bash" ]] || [[ -z "$COMMAND" ]]; then
  exit 0
fi

# Dangerous command patterns
DANGEROUS_PATTERNS=(
  # Destructive file operations
  'rm -rf /'
  'rm -rf ~'
  'rm -rf \*'
  'rm -rf \.'
  'rm -rf /\*'
  'dd if=/dev/zero'
  'dd if=/dev/random'
  'mkfs\.'
  'fdisk'
  '> /dev/sd'

  # Fork bombs and resource exhaustion
  ':\(\)\{:\|:\&\};:'
  'while true.*fork'

  # Credential/secret exposure
  'cat.*\.env'
  'cat.*/etc/passwd'
  'cat.*/etc/shadow'
  'cat.*id_rsa'
  'cat.*\.ssh/'
  'cat.*credentials'
  'cat.*\.aws/'

  # Network exfiltration
  'curl.*\|.*sh'
  'wget.*\|.*sh'
  'curl.*\|.*bash'
  'wget.*\|.*bash'

  # Permission escalation
  'chmod 777'
  'chmod -R 777'
  'chmod.*\+s'

  # History manipulation
  'history -c'
  'rm.*\.bash_history'
  'rm.*\.zsh_history'

  # System modification
  'shutdown'
  'reboot'
  'init 0'
  'init 6'
)

# Check command against dangerous patterns
for pattern in "${DANGEROUS_PATTERNS[@]}"; do
  if echo "$COMMAND" | grep -qiE "$pattern"; then
    # Output to stderr for Claude to see
    echo "BLOCKED: Command matches dangerous pattern: $pattern" >&2
    echo "Command was: $COMMAND" >&2

    # Exit code 2 blocks the tool and shows stderr to Claude
    exit 2
  fi
done

# Check for sudo without specific allowed commands
if echo "$COMMAND" | grep -qE '^sudo\s' && ! echo "$COMMAND" | grep -qE 'sudo (npm|yarn|pnpm|brew|apt-get|apt|dnf|yum)'; then
  echo "BLOCKED: sudo commands require explicit approval" >&2
  echo "If this command is safe, please run it manually in your terminal" >&2
  exit 2
fi

# Allow the command
exit 0
