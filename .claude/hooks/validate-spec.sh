#!/bin/bash
# CAWS Spec Validation Hook for Claude Code
# Validates per-feature specs under .caws/specs/ when they're edited
# @author @darianrosebrook

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/parse-input.sh
source "$SCRIPT_DIR/lib/parse-input.sh"
parse_hook_input

FILE_PATH="$HOOK_FILE_PATH"

# Only validate CAWS YAML files
if [[ "$FILE_PATH" != *".caws/"* ]] || ([[ "$FILE_PATH" != *.yaml ]] && [[ "$FILE_PATH" != *.yml ]]); then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

# First, validate YAML syntax using Node.js if available
if command -v node >/dev/null 2>&1; then
  YAML_CHECK=$(node -e "
    try {
      const yaml = require('js-yaml');
      const fs = require('fs');
      const content = fs.readFileSync('$FILE_PATH', 'utf8');
      yaml.load(content);
      console.log('valid');
    } catch (error) {
      console.error(error.message);
      if (error.mark) {
        console.error('Line: ' + (error.mark.line + 1) + ', Column: ' + (error.mark.column + 1));
      }
      process.exit(1);
    }
  " 2>&1)

  if [ $? -ne 0 ]; then
    echo '{
      "decision": "block",
      "reason": "YAML syntax error in spec file:\n'"$YAML_CHECK"'\n\nPlease fix the syntax before continuing. Common issues:\n- Check indentation (YAML uses 2 spaces)\n- Ensure arrays use consistent format\n- Remove duplicate keys"
    }'
    exit 0
  fi
fi

# V2: Check test_nodeids coverage for terminal-status specs
# Specs at proven/complete/completed should have test_nodeids on every AC
if command -v node >/dev/null 2>&1; then
  NODEIDS_CHECK=$(node -e "
    const yaml = require('js-yaml');
    const fs = require('fs');
    const doc = yaml.load(fs.readFileSync('$FILE_PATH', 'utf8'));
    const status = (doc.status || '').toLowerCase();
    const terminal = ['proven', 'complete', 'completed'];
    if (!terminal.includes(status)) process.exit(0);
    const acs = doc.acceptance_criteria || doc.acceptance || [];
    const missing = acs
      .filter(ac => !ac.test_nodeids && !ac.evidence)
      .map(ac => ac.id);
    if (missing.length > 0) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: 'Spec ' + doc.id + ' has status ' + JSON.stringify(status) +
            ' but these ACs lack test_nodeids or evidence: ' + missing.join(', ') +
            '. Terminal-status specs should have mechanical links to their proof tests. ' +
            'Add test_nodeids: [\"path/to/test.py::TestClass\"] to each AC, or evidence: for doc-only ACs.'
        }
      }));
    }
  " 2>&1)

  if [[ -n "$NODEIDS_CHECK" ]]; then
    echo "$NODEIDS_CHECK"
  fi
fi

# Run CAWS CLI validation if available
if command -v caws &> /dev/null; then
  if VALIDATION=$(caws validate "$FILE_PATH" --quiet 2>&1); then
    echo '{
      "hookSpecificOutput": {
        "hookEventName": "PostToolUse",
        "additionalContext": "Spec validation passed. The specification is valid and complete."
      }
    }'
  else
    # Get suggestions
    SUGGESTIONS=$(caws validate "$FILE_PATH" --suggestions 2>/dev/null | head -5 | tr '\n' ' ' || echo "Run 'caws validate --suggestions' for details")

    echo '{
      "decision": "block",
      "reason": "Spec validation failed:\n'"$VALIDATION"'\n\nSuggestions:\n'"$SUGGESTIONS"'"
    }'
  fi
else
  # Basic validation without CAWS CLI
  echo '{
    "hookSpecificOutput": {
      "hookEventName": "PostToolUse",
      "additionalContext": "CAWS CLI not available for full spec validation. Install with: npm install -g @caws/cli"
    }
  }'
fi

exit 0
