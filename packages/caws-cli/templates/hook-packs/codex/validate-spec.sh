#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: codex
# hook_pack_version: 6
# caws_min_major: 11
# lineage_refs: 8,13
# do_not_edit_directly: update via `caws init --agent-surface codex`
# CAWS Spec Validation Hook for Codex
# Validates a .caws/specs/*.yaml file when it's edited (YAML syntax +
# terminal-status AC coverage). OPT-IN: not wired into the default
# post_tool_use HANDLERS array. Promoted from Sterling per
# HOOK-PACK-DIVERGENCE-RECONCILE-001 — the v11-correct version that does
# NOT call the removed `caws validate` command (the caws-local copy did,
# producing misleading block output).
# @author @darianrosebrook

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/parse-input.sh
source "$SCRIPT_DIR/lib/parse-input.sh"
# shellcheck source=lib/emit.sh
# Canonical Codex envelope emitters (HOOK-LIB-CONSOLIDATION-001 T3a).
source "$SCRIPT_DIR/lib/emit.sh" 2>/dev/null || true
parse_hook_input

FILE_PATH="$HOOK_FILE_PATH"

# Thin adapter over the canonical lib/emit.sh PostToolUse additionalContext
# primitive. Was a bespoke python3 json.dumps copy (HOOK-LIB-CONSOLIDATION-001
# T3a) — the emitted JSON is byte-identical (verified).
emit_post_context() { emit_additional_context "$1" "PostToolUse"; }

# Only validate CAWS YAML files
if [[ "$FILE_PATH" != *".caws/"* ]] || ([[ "$FILE_PATH" != *.yaml ]] && [[ "$FILE_PATH" != *.yml ]]); then
  exit 0
fi

PROJECT_DIR="${CODEX_PROJECT_DIR:-.}"

# First, validate YAML syntax using Node.js if available.
#
# CAWS-VALIDATE-SPEC-JSYAML-CONFLATION-001: `js-yaml` is loaded inside its own
# try/catch and distinguished from a genuine parse failure. When the parser
# dependency cannot be resolved from this hook's node execution context, the
# script prints a `__CAWS_NO_JSYAML__` sentinel and exits 0 — it MUST NOT claim
# a "YAML syntax error" for a spec it never actually parsed (that misled authors
# into "fixing" valid YAML). A real parse failure (parser present, yaml.load
# throws) still produces the syntax-error message below.
if command -v node >/dev/null 2>&1; then
  if ! YAML_CHECK=$(node - "$FILE_PATH" <<'NODE' 2>&1
    let yaml;
    try {
      yaml = require('js-yaml');
    } catch (_depErr) {
      // Validator dependency unavailable in this execution context — an
      // environment condition, NOT a spec authoring error. Signal and skip.
      console.log('__CAWS_NO_JSYAML__');
      process.exit(0);
    }
    try {
      const fs = require('fs');
      const content = fs.readFileSync(process.argv[2], 'utf8');
      yaml.load(content);
      console.log('valid');
    } catch (error) {
      console.error(error.message);
      if (error.mark) {
        console.error('Line: ' + (error.mark.line + 1) + ', Column: ' + (error.mark.column + 1));
      }
      process.exit(1);
    }
NODE
  ); then
    emit_post_context "Spec validation failed for ${FILE_PATH}: YAML syntax error.

${YAML_CHECK}

Please fix the syntax before relying on this spec. Common issues: indentation, inconsistent arrays, or duplicate keys."
    exit 0
  fi
  # The node script exited 0. If js-yaml could not be loaded it printed the
  # sentinel — the parser never ran, so neither the syntax check nor the
  # downstream test_nodeids check below can run. Exit cleanly and silently
  # rather than emitting a misleading error.
  if [[ "$YAML_CHECK" == *"__CAWS_NO_JSYAML__"* ]]; then
    exit 0
  fi
fi

# V2: Check test_nodeids coverage for terminal-status specs
# Specs at proven/complete/completed should have test_nodeids on every AC
if command -v node >/dev/null 2>&1; then
  if NODEIDS_CHECK=$(node - "$FILE_PATH" <<'NODE' 2>/dev/null
    const yaml = require('js-yaml');
    const fs = require('fs');
    const doc = yaml.load(fs.readFileSync(process.argv[2], 'utf8'));
    const status = (doc.status || '').toLowerCase();
    const terminal = ['proven', 'complete', 'completed'];
    if (!terminal.includes(status)) process.exit(0);
    const acs = doc.acceptance_criteria || doc.acceptance || [];
    const missing = acs
      .filter(ac => !ac.test_nodeids && !ac.evidence)
      .map(ac => ac.id);
    if (missing.length > 0) {
      // Output the bare advisory text; the bash caller wraps it in the
      // canonical envelope via lib/emit.sh (HOOK-LIB-CONSOLIDATION-001 T3a).
      console.log('Spec ' + doc.id + ' has status ' + JSON.stringify(status) +
        ' but these ACs lack test_nodeids or evidence: ' + missing.join(', ') +
        '. Terminal-status specs should have mechanical links to their proof tests. ' +
        'Add test_nodeids: [\"path/to/test.py::TestClass\"] to each AC, or evidence: for doc-only ACs.');
    }
NODE
  ) && [[ -n "$NODEIDS_CHECK" ]]; then
    emit_additional_context "$NODEIDS_CHECK" "PostToolUse"
  fi
fi

# NOTE (CAWS-1117-COMPAT-BOOTSTRAP-01 A1):
# `caws validate <file> --quiet --suggestions` was removed in v11. There
# is no per-file v11 analog — `caws doctor` runs project-wide drift
# detection and would noisily report unrelated state. Per A3, bootstrap
# failures must not emit misleading "Spec validation failed" blocks
# carrying unknown-command stderr.
#
# Decision: short-circuit cleanly. The local node YAML syntax check
# (above) and the terminal-state test_nodeids check (above) cover the
# per-file validations this hook previously offered on the v10 surface.
# Project-wide schema drift is the user's responsibility to inspect via
# `caws doctor` at session boundaries; the PostToolUse path is not the
# right place to surface dozens of unrelated spec migrations.

exit 0
