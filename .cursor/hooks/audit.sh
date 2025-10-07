#!/bin/bash
# Cursor Hook: Audit Trail
# 
# Purpose: Log all Cursor AI events for provenance tracking
# Event: All (beforeShellExecution, beforeMCPExecution, beforeReadFile, 
#        afterFileEdit, beforeSubmitPrompt, stop)
# 
# @author @darianrosebrook

set -euo pipefail

# Read input from Cursor
INPUT=$(cat)

# Create log directory if it doesn't exist
LOG_DIR=".cursor/logs"
mkdir -p "$LOG_DIR"

# Log file with date rotation
LOG_FILE="$LOG_DIR/audit-$(date +%Y-%m-%d).log"

# Extract key information
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // "unknown"')
CONVERSATION_ID=$(echo "$INPUT" | jq -r '.conversation_id // "none"')
GENERATION_ID=$(echo "$INPUT" | jq -r '.generation_id // "none"')

# Create audit entry
AUDIT_ENTRY=$(cat <<EOF
{
  "timestamp": "$TIMESTAMP",
  "event": "$HOOK_EVENT",
  "conversation_id": "$CONVERSATION_ID",
  "generation_id": "$GENERATION_ID",
  "details": $INPUT
}
EOF
)

# Append to audit log
echo "$AUDIT_ENTRY" >> "$LOG_FILE"

# Try to update CAWS provenance if available
if [ -f "apps/tools/caws/provenance.js" ]; then
  node apps/tools/caws/provenance.js log-event \
    --event="$HOOK_EVENT" \
    --conversation="$CONVERSATION_ID" \
    --generation="$GENERATION_ID" \
    2>/dev/null || true
fi

# Always allow - this is observation only
echo '{"permission":"allow"}' 2>/dev/null || true
exit 0

