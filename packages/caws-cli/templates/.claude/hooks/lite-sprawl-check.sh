#!/bin/bash
# CAWS Lite-Mode Sprawl Check Hook
# Checks for file sprawl patterns (banned names, venv dirs, doc sprawl)
# @author @darianrosebrook

set -euo pipefail

# Read JSON input from Claude Code
INPUT=$(cat)

# Extract tool info
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')

# Only check Write operations (new file creation)
if [[ "$TOOL_NAME" != "Write" ]]; then
  exit 0
fi

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
SCOPE_FILE="$PROJECT_DIR/.caws/scope.json"

# Only active in lite mode (scope.json present, no working-spec.yaml)
if [[ ! -f "$SCOPE_FILE" ]]; then
  exit 0
fi

# Get relative path
# Get relative path (portable — macOS realpath lacks --relative-to)
if [[ "$FILE_PATH" == "$PROJECT_DIR"/* ]]; then
  REL_PATH="${FILE_PATH#$PROJECT_DIR/}"
else
  REL_PATH="$FILE_PATH"
fi
BASENAME=$(basename "$REL_PATH")

# Use Node.js to check banned patterns
if command -v node >/dev/null 2>&1; then
  SPRAWL_CHECK=$(node -e "
    const fs = require('fs');
    const path = require('path');
    try {
      const scope = JSON.parse(fs.readFileSync('$SCOPE_FILE', 'utf8'));
      const filePath = '$REL_PATH';
      const basename = '$BASENAME';
      const banned = scope.bannedPatterns || {};

      function globToRegex(pattern) {
        let i = 0, re = '';
        while (i < pattern.length) {
          const c = pattern[i];
          if (c === '*' && pattern[i+1] === '*') {
            re += '.*'; i += 2;
            if (pattern[i] === '/') i++;
          } else if (c === '*') {
            re += '[^/]*'; i++;
          } else if (c === '?') {
            re += '[^/]'; i++;
          } else if (c === '[') {
            const end = pattern.indexOf(']', i);
            if (end > i) { re += pattern.slice(i, end + 1); i = end + 1; }
            else { re += '\\\\['; i++; }
          } else if (c === '{') {
            const end = pattern.indexOf('}', i);
            if (end > i) {
              const alts = pattern.slice(i + 1, end).split(',').map(a => a.trim());
              re += '(?:' + alts.join('|') + ')'; i = end + 1;
            } else { re += '\\\\{'; i++; }
          } else if ('.+^$|()'.includes(c)) {
            re += '\\\\' + c; i++;
          } else {
            re += c; i++;
          }
        }
        return new RegExp('^' + re + '$');
      }
      function matchGlob(str, pattern) {
        return globToRegex(pattern).test(str);
      }

      // Check banned file patterns
      for (const p of (banned.files || [])) {
        if (matchGlob(basename, p)) {
          console.log('banned_file:' + p);
          process.exit(0);
        }
      }

      // Check banned doc patterns
      for (const p of (banned.docs || [])) {
        if (matchGlob(basename, p)) {
          console.log('banned_doc:' + p);
          process.exit(0);
        }
      }

      // Check banned directory patterns
      const parts = filePath.split('/');
      for (const part of parts) {
        for (const p of (banned.directories || [])) {
          if (matchGlob(part, p)) {
            console.log('banned_dir:' + p + ':' + part);
            process.exit(0);
          }
        }
      }

      console.log('ok');
    } catch (error) {
      console.log('error:' + error.message);
    }
  " 2>&1)

  if [[ "$SPRAWL_CHECK" == banned_file:* ]]; then
    PATTERN="${SPRAWL_CHECK#banned_file:}"
    echo "BLOCKED: File name matches banned sprawl pattern: $PATTERN" >&2
    echo "File: $REL_PATH" >&2
    echo "Banned patterns prevent shadow files like *-enhanced.*, *-final.*, *-v2.*, *-copy.*" >&2
    echo "Instead, modify the original file directly." >&2
    exit 2
  fi

  if [[ "$SPRAWL_CHECK" == banned_doc:* ]]; then
    PATTERN="${SPRAWL_CHECK#banned_doc:}"
    echo "BLOCKED: Doc file matches banned sprawl pattern: $PATTERN" >&2
    echo "File: $REL_PATH" >&2
    echo "Avoid creating many summary/recap/plan files. Update existing documentation instead." >&2
    exit 2
  fi

  if [[ "$SPRAWL_CHECK" == banned_dir:* ]]; then
    IFS=':' read -r _ PATTERN DIR_NAME <<< "$SPRAWL_CHECK"
    echo "BLOCKED: Directory matches banned pattern: $PATTERN (directory: $DIR_NAME)" >&2
    echo "File: $REL_PATH" >&2
    echo "Use the designated venv path instead of creating new virtual environments." >&2
    exit 2
  fi
fi

# Allow the operation
exit 0
