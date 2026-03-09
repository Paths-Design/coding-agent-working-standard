#!/bin/bash
# Cursor Hook: Secret & PII Scanner
# 
# Purpose: Prevent reading files with secrets or sensitive information
# Event: beforeReadFile
# 
# @author @darianrosebrook

set -euo pipefail

# Read input from Cursor
INPUT=$(cat)

# Extract file path and content
FILE_PATH=$(echo "$INPUT" | jq -r '.file_path // ""')
CONTENT=$(echo "$INPUT" | jq -r '.content // ""')

# Block reading of environment files
if [[ "$FILE_PATH" =~ \.(env|env\.local|env\.development|env\.production|env\.test)$ ]]; then
  echo '{"permission":"deny","userMessage":"⚠️ Blocked: Environment files contain secrets. Use placeholder values instead."}' 2>/dev/null
  exit 0
fi

# Block reading of key files
if [[ "$FILE_PATH" =~ \.(pem|key|p12|pfx|cert|crt)$ ]]; then
  echo '{"permission":"deny","userMessage":"⚠️ Blocked: Certificate/key files should not be read by AI."}' 2>/dev/null
  exit 0
fi

# Scan content for common secret patterns
# bearer requires 20+ chars to avoid false positives on short tokens in docs
# AKIA prefix is specific to AWS access keys
if echo "$CONTENT" | grep -qiE "(api[_-]?key\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{16,}|secret[_-]?key\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{16,}|password\s*[:=]\s*['\"]?[^\s'\"]{8,}|private[_-]?key\s*[:=]|access[_-]?token\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{16,}|[Bb]earer\s+[A-Za-z0-9_\-\.]{20,}|AKIA[0-9A-Z]{16})"; then
  # Don't block, but warn
  echo '{"permission":"allow","userMessage":"⚠️ Warning: Potential secrets detected in file. Ensure they are not committed.","agentMessage":"This file may contain secrets. Use placeholder values or environment variables."}' 2>/dev/null
  exit 0
fi

# Check for common PII patterns (SSN, credit card)
# SSN: exactly 3-2-4 digit pattern (not inside longer numbers)
# Credit card: require at least a Luhn-plausible 13-19 digit sequence with separators
if echo "$CONTENT" | grep -qE "(^|[^0-9])[0-9]{3}-[0-9]{2}-[0-9]{4}($|[^0-9])" || \
   echo "$CONTENT" | grep -qE "(^|[^0-9])[0-9]{4}[- ][0-9]{4}[- ][0-9]{4}[- ][0-9]{4}($|[^0-9])"; then
  echo '{"permission":"allow","userMessage":"⚠️ Warning: Potential PII detected. Ensure compliance with data protection policies.","agentMessage":"This file may contain PII (SSN, credit card). Use anonymized test data."}' 2>/dev/null
  exit 0
fi

# Allow by default
echo '{"permission":"allow"}' 2>/dev/null
exit 0

