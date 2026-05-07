#!/bin/bash
# CAWS Simplification Guard Hook
# Detects when files are being stubbed out (large deletions + stub content)
# @author @darianrosebrook

set -euo pipefail

# Read JSON input from Claude Code
INPUT=$(cat)

# Extract tool info
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')

# Only check Edit operations (modifications to existing files)
if [[ "$TOOL_NAME" != "Edit" ]]; then
  exit 0
fi

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

# Get relative path (portable — macOS realpath lacks --relative-to)
if [[ "$FILE_PATH" == "$PROJECT_DIR"/* ]]; then
  REL_PATH="${FILE_PATH#$PROJECT_DIR/}"
else
  REL_PATH="$FILE_PATH"
fi

# Only check code files
case "$REL_PATH" in
  *.js|*.jsx|*.ts|*.tsx|*.mjs|*.cjs|*.py|*.rs|*.go|*.java|*.kt|*.swift|*.rb|*.php|*.c|*.cpp|*.h)
    ;;
  *)
    exit 0
    ;;
esac

# Check if the file exists in git (skip new files)
if ! git show "HEAD:$REL_PATH" >/dev/null 2>&1; then
  exit 0
fi

# Compare staged version with HEAD
if command -v node >/dev/null 2>&1; then
  SIMP_CHECK=$(node -e "
    const { execFileSync } = require('child_process');
    try {
      const headContent = execFileSync('git', ['show', 'HEAD:$REL_PATH'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const currentContent = require('fs').readFileSync('$FILE_PATH', 'utf8');

      const countLOC = (c) => c.split('\\n').filter(l => l.trim() && !l.trim().startsWith('//') && !l.trim().startsWith('#')).length;
      const headLOC = countLOC(headContent);
      const currentLOC = countLOC(currentContent);

      if (headLOC < 10) { console.log('ok'); process.exit(0); }

      const decrease = (headLOC - currentLOC) / headLOC;

      // Check for stub patterns in new content
      const stubPatterns = [/^\\s*pass\\s*$/m, /^\\s*\\.\\.\\.\\s*$/m, /raise\\s+NotImplementedError/,
        /throw\\s+new\\s+Error.*not implemented/i, /\\/\\/\\s*TODO\\s*$/m, /#\\s*TODO\\s*$/m];
      const hasStubs = stubPatterns.some(p => p.test(currentContent));

      if (decrease >= 0.3 && hasStubs) {
        console.log('simplified:' + Math.round(decrease * 100) + ':' + headLOC + ':' + currentLOC);
      } else {
        console.log('ok');
      }
    } catch (error) {
      console.log('ok');
    }
  " 2>&1)

  if [[ "$SIMP_CHECK" == simplified:* ]]; then
    IFS=':' read -r _ PERCENT OLD_LOC NEW_LOC <<< "$SIMP_CHECK"
    echo '{
      "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "ask",
        "permissionDecisionReason": "WARNING: This edit would reduce '"$REL_PATH"' by '"$PERCENT"'% ('"$OLD_LOC"' → '"$NEW_LOC"' LOC) and introduces stub patterns (pass, TODO, NotImplementedError). This looks like a simplification — implementations should be modified, not replaced with stubs. Please confirm this is intentional."
      }
    }'
    exit 0
  fi
fi

# Allow the edit
exit 0
