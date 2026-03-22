#!/bin/bash
# CAWS Scope Guard Hook for Claude Code
# Validates file edits against scope boundaries from working-spec + feature specs
# Specs with terminal status (completed, closed, archived) are skipped
# @author @darianrosebrook

set -euo pipefail

# Read JSON input from Claude Code
INPUT=$(cat)

# Extract file path from PreToolUse input
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')

# Only check Write/Edit operations
if [[ "$TOOL_NAME" != "Write" ]] && [[ "$TOOL_NAME" != "Edit" ]]; then
  exit 0
fi

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
SPEC_FILE="$PROJECT_DIR/.caws/working-spec.yaml"
SCOPE_FILE="$PROJECT_DIR/.caws/scope.json"

# Check if any spec infrastructure exists
if [[ ! -f "$SPEC_FILE" ]] && [[ ! -f "$SCOPE_FILE" ]] && [[ ! -d "$PROJECT_DIR/.caws/specs" ]]; then
  exit 0
fi

# Get relative path from project root (portable — macOS realpath lacks --relative-to)
if [[ "$FILE_PATH" == "$PROJECT_DIR"/* ]]; then
  REL_PATH="${FILE_PATH#$PROJECT_DIR/}"
else
  REL_PATH="$FILE_PATH"
fi

# Lite mode: check scope.json if no working-spec.yaml
if [[ ! -f "$SPEC_FILE" ]] && [[ -f "$SCOPE_FILE" ]]; then
  if command -v node >/dev/null 2>&1; then
    LITE_CHECK=$(node -e "
      const fs = require('fs');
      const path = require('path');

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
        return new RegExp(re);
      }

      try {
        const scope = JSON.parse(fs.readFileSync('$SCOPE_FILE', 'utf8'));
        const filePath = '$REL_PATH';
        const dirs = scope.allowedDirectories || [];
        const banned = scope.bannedPatterns || {};

        // Check banned file patterns
        const basename = path.basename(filePath);
        const bannedFiles = banned.files || [];
        for (const pattern of bannedFiles) {
          const regex = globToRegex(pattern);
          if (regex.test(basename)) {
            console.log('banned:' + pattern);
            process.exit(0);
          }
        }

        // Check banned doc patterns
        const bannedDocs = banned.docs || [];
        for (const pattern of bannedDocs) {
          const regex = globToRegex(pattern);
          if (regex.test(basename)) {
            console.log('banned:' + pattern);
            process.exit(0);
          }
        }

        // Check allowed directories
        if (dirs.length > 0) {
          const normalized = filePath.replace(/\\\\\\\\/g, '/');
          let found = false;
          for (const dir of dirs) {
            const d = dir.replace(/\\/$/, '');
            if (normalized.startsWith(d + '/') || normalized === d) { found = true; break; }
          }
          // Allow root-level files and .caws/ directory
          if (!normalized.includes('/') || normalized.startsWith('.caws/')) found = true;
          if (!found) {
            console.log('not_allowed');
            process.exit(0);
          }
        }
        console.log('allowed');
      } catch (error) {
        console.log('error:' + error.message);
      }
    " 2>&1)


    if [[ "$LITE_CHECK" == error:* ]]; then
      ERROR_MSG="${LITE_CHECK#error:}"
      echo "BLOCKED: Scope check failed — cannot verify file is in scope" >&2
      echo "  Error: $ERROR_MSG" >&2
      exit 2
    fi

    if [[ "$LITE_CHECK" == banned:* ]]; then
      PATTERN="${LITE_CHECK#banned:}"
      echo "BLOCKED: $REL_PATH matches banned pattern ($PATTERN) in .caws/scope.json"
      echo "  Scope allows: files not matching banned patterns"
      echo "  To modify scope, update bannedPatterns in .caws/scope.json"
      exit 2
    fi

    if [[ "$LITE_CHECK" == "not_allowed" ]]; then
      ALLOWED_DIRS=$(node -e "const s=JSON.parse(require('fs').readFileSync('$SCOPE_FILE','utf8')); console.log((s.allowedDirectories||[]).join(', '))" 2>/dev/null || echo "unknown")
      echo "BLOCKED: $REL_PATH is outside allowed directories"
      echo "  Scope allows: $ALLOWED_DIRS"
      echo "  To modify scope, update allowedDirectories in .caws/scope.json"
      exit 2
    fi

    # File is allowed - exit normally
    exit 0
  fi
fi

# Use Node.js to parse YAML and check scope across working spec + active feature specs
SPECS_DIR="$PROJECT_DIR/.caws/specs"

if command -v node >/dev/null 2>&1; then
  SCOPE_CHECK=$(node -e "
    const yaml = require('js-yaml');
    const fs = require('fs');
    const path = require('path');

    // Convert glob pattern to regex, handling **, *, ?, [abc], {a,b}
    function globToRegex(pattern) {
      let i = 0, re = '';
      while (i < pattern.length) {
        const c = pattern[i];
        if (c === '*' && pattern[i+1] === '*') {
          re += '.*'; i += 2;
          if (pattern[i] === '/') i++; // skip trailing slash after **
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
      return new RegExp(re);
    }

    try {
      const filePath = '$REL_PATH';

      // Terminal statuses: specs that are done — scope no longer enforced
      const TERMINAL = new Set(['completed', 'closed', 'archived']);

      // Smart allowlist: root-level files, .caws/, .claude/ always pass
      if (!filePath.includes('/') || filePath.startsWith('.caws/') || filePath.startsWith('.claude/')) {
        console.log('in_scope');
        process.exit(0);
      }

      // Collect all active specs (working-spec + feature specs)
      const specs = [];

      // Load working-spec.yaml if present
      const mainSpec = '$SPEC_FILE';
      if (fs.existsSync(mainSpec)) {
        try {
          const s = yaml.load(fs.readFileSync(mainSpec, 'utf8'));
          if (s && !TERMINAL.has(s.status)) {
            specs.push({ source: 'working-spec', spec: s });
          }
        } catch (_) {}
      }

      // Load feature specs from .caws/specs/
      const specsDir = '$SPECS_DIR';
      if (fs.existsSync(specsDir)) {
        for (const f of fs.readdirSync(specsDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))) {
          try {
            const s = yaml.load(fs.readFileSync(path.join(specsDir, f), 'utf8'));
            if (s && !TERMINAL.has(s.status)) {
              specs.push({ source: f, spec: s });
            }
          } catch (_) {}
        }
      }

      // No active specs — allow everything
      if (specs.length === 0) {
        console.log('in_scope');
        process.exit(0);
      }

      // Check scope.out across ALL active specs — any match blocks
      for (const { source, spec } of specs) {
        for (const pattern of (spec.scope?.out || [])) {
          const regex = globToRegex(pattern);
          if (regex.test(filePath)) {
            console.log('out_of_scope:' + source + ':' + pattern);
            process.exit(0);
          }
        }
      }

      // Union all scope.in patterns — file must match at least one
      const allInScope = specs.flatMap(({ spec }) => spec.scope?.in || []);
      if (allInScope.length > 0) {
        let found = false;
        for (const pattern of allInScope) {
          const regex = globToRegex(pattern);
          if (regex.test(filePath)) {
            found = true;
            break;
          }
        }
        if (!found) {
          console.log('not_in_scope');
          process.exit(0);
        }
      }

      console.log('in_scope');
    } catch (error) {
      console.log('error:' + error.message);
    }
  " 2>&1)


  if [[ "$SCOPE_CHECK" == error:* ]]; then
    ERROR_MSG="${SCOPE_CHECK#error:}"
    echo "BLOCKED: Scope check failed — cannot verify file is in scope" >&2
    echo "  Error: $ERROR_MSG" >&2
    echo "  Fix the spec file or scope configuration before editing files" >&2
    exit 2
  fi

  if [[ "$SCOPE_CHECK" == out_of_scope:* ]]; then
    DETAIL="${SCOPE_CHECK#out_of_scope:}"
    SOURCE="${DETAIL%%:*}"
    PATTERN="${DETAIL#*:}"
    echo "BLOCKED: $REL_PATH is excluded by scope.out in $SOURCE (pattern: $PATTERN)"
    echo "  Scope allows: files not matching scope.out patterns"
    echo "  To modify scope, update the spec's scope.out field"
    exit 2
  fi

  if [[ "$SCOPE_CHECK" == "not_in_scope" ]]; then
    echo "BLOCKED: $REL_PATH is not in the defined scope.in of any active spec"
    echo "  Scope allows: files matching scope.in patterns in active specs"
    echo "  To modify scope, update the spec's scope.in field"
    exit 2
  fi
fi

# File is in scope or scope couldn't be checked - allow
exit 0
