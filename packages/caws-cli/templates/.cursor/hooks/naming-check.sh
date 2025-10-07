#!/bin/bash
# Cursor Hook: Naming Conventions
# 
# Purpose: Enforce CAWS naming conventions (no enhanced-, -copy, etc.)
# Event: afterFileEdit
# 
# @author @darianrosebrook

set -euo pipefail

# Read input from Cursor
INPUT=$(cat)

# Extract file path
FILE_PATH=$(echo "$INPUT" | jq -r '.file_path // ""')

# Get just the filename
FILENAME=$(basename "$FILE_PATH")

# Check for banned naming patterns
BANNED_PATTERNS=(
  "enhanced-"
  "-enhanced"
  "unified-"
  "-unified"
  "better-"
  "-better"
  "new-"
  "-new"
  "next-"
  "-next"
  "final-"
  "-final"
  "-copy"
  "copy-"
  "-revamp"
  "revamp-"
  "-improved"
  "improved-"
)

for pattern in "${BANNED_PATTERNS[@]}"; do
  if [[ "$FILENAME" == *"$pattern"* ]]; then
    # Extract the pattern for the message
    echo '{"userMessage":"⚠️ Naming violation: File contains banned pattern '"'$pattern'"'. Use purpose-driven names instead.","agentMessage":"This file uses a generic naming pattern ('"$pattern"'). Please rename with a specific, purpose-driven name that describes what the file does."}' 2>/dev/null
    exit 0
  fi
done

# Check for duplicate module patterns (e.g., both processor.ts and enhanced-processor.ts)
if [[ "$FILENAME" =~ ^(enhanced|unified|better|new|next|final|improved)- ]]; then
  BASE_NAME=$(echo "$FILENAME" | sed -E 's/^(enhanced|unified|better|new|next|final|improved)-//')
  DIR_PATH=$(dirname "$FILE_PATH")
  
  # Check if base file exists
  if [ -f "$DIR_PATH/$BASE_NAME" ]; then
    echo '{"userMessage":"⚠️ Duplicate module detected: Both '"$FILENAME"' and '"$BASE_NAME"' exist. Merge into canonical name.","agentMessage":"Found duplicate modules. Please merge '"$FILENAME"' into '"$BASE_NAME"' and remove the duplicate."}' 2>/dev/null
    exit 0
  fi
fi

# Allow by default
exit 0

