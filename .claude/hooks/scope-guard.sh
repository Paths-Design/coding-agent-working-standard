#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: claude-code
# hook_pack_version: 4
# caws_min_major: 11
# lineage_refs: 8,11,12,16
# do_not_edit_directly: update via `caws init --agent-surface claude-code`
#
# CAWS Scope Guard Hook for Claude Code (v11-shape).
# Validates file edits against scope boundaries from per-feature specs under .caws/specs/.
#
# Lifecycle resolution (v11-shape, with v10 fallback):
#   lifecycle_state first, status second.
#   Terminal (not enforced): closed, archived, completed.
#   active: participates in union enforcement.
#   draft: does NOT participate in union-wide blocking unless authoritative/bound.
#   Both fields missing: treat as active (legacy compatibility).
#
# Worktree registry shape compatibility:
#   v11 direct-key: { "<name>": { ... } }
#   v10 nested:     { "worktrees": { "<name>": { ... } } }
#   Bound id key:   specId (v10) OR spec_id (v11) — both accepted.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/parse-input.sh
source "$SCRIPT_DIR/lib/parse-input.sh"
# shellcheck source=guard-strikes.sh
source "$SCRIPT_DIR/guard-strikes.sh"
parse_hook_input

# Back-compat aliases kept to minimize diff in the scope-resolution logic below.
FILE_PATH="$HOOK_FILE_PATH"
TOOL_NAME="$HOOK_TOOL_NAME"
SESSION_ID="$HOOK_SESSION_ID"

# Only check Write/Edit operations
if [[ "$TOOL_NAME" != "Write" ]] && [[ "$TOOL_NAME" != "Edit" ]]; then
  exit 0
fi

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

emit_scope_progression() {
  local detail="$1"
  # Strike-level diagnostic triage: strike 1 fires often (any agent
  # touching the edge of its lane) and the edit proceeds — keep the
  # message short so it informs without burying. Strike 2 escalates to
  # user-approval and adds the spec/binding-fix options. Strike 3 is the
  # hard block and surfaces the full reset-strikes + binding guidance.
  local fix_options="Fix options: (1) edit a file already in scope, (2) update the bound spec's scope.in if this path should be in scope, (3) ask the user."
  local hard_block_guidance="If prior strikes from earlier edits are cornering this session and the scope is now correct, ask the user to run: bash .claude/hooks/reset-strikes.sh --current (or --session <uuid>) to clear stale strike state. Verify the worktree binding: the spec must declare 'worktree: <name>' and .caws/worktrees.json must map that same worktree name to the correct 'specId' (v10) or 'spec_id' (v11). On CAWS v11.0 the worktree lifecycle CLI is not yet restored; on v11.1+ use 'caws worktree bind'. Do not edit .claude/hooks/, .claude/logs/guard-strikes-*.json, or other guard state to bypass this check."

  guard_enforce_progressive_strikes \
    "$SESSION_ID" \
    "scope_guard" \
    "$WORK_DIR" \
    "Scope guard strike 1 of 3 for '$REL_PATH'. This edit proceeds, but a second out-of-scope edit will require user approval. $detail" \
    "Scope guard strike 2 of 3 for '$REL_PATH'. Blocked — asking the user for approval. $detail $fix_options" \
    "Scope guard strike 3 of 3 for '$REL_PATH'. Hard-blocked until scope is corrected. $detail $fix_options $hard_block_guidance"
}

resolve_worktree_root() {
  local candidate="${1:-}"

  if [[ -n "$candidate" ]] && [[ "$candidate" =~ ^(.*\/\.caws\/worktrees\/[^/]+)($|/) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return 0
  fi

  return 1
}

# Always-allowed paths bypass scope checks entirely.
ALLOW_PREFIXES=(
  "$HOME/.claude/"
  ".caws/"
  ".claude/"
  "docs/"
  "tests/"
  "scripts/"
  "tmp/"
  ".archive/"
)

# Policy-declared non-governed zones (CAWSFIX-26 / ledger D9).
POLICY_FILE="${CLAUDE_PROJECT_DIR:-.}/.caws/policy.yaml"
if [[ -f "$POLICY_FILE" ]]; then
  while IFS= read -r raw_zone; do
    [[ -z "$raw_zone" ]] && continue
    raw_zone="${raw_zone%\"}"; raw_zone="${raw_zone#\"}"
    raw_zone="${raw_zone%\'}"; raw_zone="${raw_zone#\'}"
    raw_zone="${raw_zone%/\*\*}"
    raw_zone="${raw_zone%/\*}"
    [[ "$raw_zone" != */ ]] && raw_zone="${raw_zone}/"
    ALLOW_PREFIXES+=("$raw_zone")
  done < <(awk '
    /^non_governed_zones:[[:space:]]*$/ { in_zones = 1; next }
    /^[^[:space:]#-]/ && in_zones { in_zones = 0 }
    in_zones && /^[[:space:]]+-[[:space:]]+/ {
      sub(/^[[:space:]]+-[[:space:]]+/, "")
      sub(/[[:space:]]+#.*$/, "")
      print
    }
  ' "$POLICY_FILE" 2>/dev/null)
fi

WORK_DIR="${HOOK_CWD:-${CLAUDE_PROJECT_DIR:-.}}"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

FILE_WORKTREE_ROOT="$(resolve_worktree_root "$FILE_PATH" || true)"
CWD_WORKTREE_ROOT="$(resolve_worktree_root "$HOOK_CWD" || true)"
PROJECT_WORKTREE_ROOT="$(resolve_worktree_root "$PROJECT_DIR" || true)"

if [[ -n "$FILE_WORKTREE_ROOT" ]]; then
  WORK_DIR="$FILE_WORKTREE_ROOT"
elif [[ -n "$CWD_WORKTREE_ROOT" ]]; then
  WORK_DIR="$CWD_WORKTREE_ROOT"
elif [[ -n "$PROJECT_WORKTREE_ROOT" ]]; then
  WORK_DIR="$PROJECT_WORKTREE_ROOT"
fi

PROJECT_DIR="$(cd "$PROJECT_DIR" 2>/dev/null && pwd || printf '%s\n' "$PROJECT_DIR")"
WORK_DIR="$(cd "$WORK_DIR" 2>/dev/null && pwd || printf '%s\n' "$WORK_DIR")"
WORKTREE_NAME=""
if [[ "$WORK_DIR" =~ \/\.caws\/worktrees\/([^/]+)$ ]]; then
  WORKTREE_NAME="${BASH_REMATCH[1]}"
fi

if [[ -d "$WORK_DIR/.caws/specs" ]]; then
  SCOPE_FILE="$WORK_DIR/.caws/scope.json"
  SPECS_BASE="$WORK_DIR"
else
  SCOPE_FILE="$PROJECT_DIR/.caws/scope.json"
  SPECS_BASE="$PROJECT_DIR"
fi

if [[ ! -f "$SCOPE_FILE" ]] && [[ ! -d "$SPECS_BASE/.caws/specs" ]]; then
  exit 0
fi

if [[ "$FILE_PATH" == "$WORK_DIR"/* ]]; then
  REL_PATH="${FILE_PATH#$WORK_DIR/}"
elif [[ "$FILE_PATH" == "$PROJECT_DIR"/* ]]; then
  REL_PATH="${FILE_PATH#$PROJECT_DIR/}"
else
  REL_PATH="$FILE_PATH"
fi

if [[ "$REL_PATH" != */* ]]; then
  exit 0
fi
for prefix in "${ALLOW_PREFIXES[@]}"; do
  if [[ "$FILE_PATH" == "${prefix}"* ]] || [[ "$REL_PATH" == "${prefix}"* ]]; then
    exit 0
  fi
done

# Lite mode: scope.json (no .caws/specs/)
if [[ ! -d "$SPECS_BASE/.caws/specs" ]] && [[ -f "$SCOPE_FILE" ]]; then
  if command -v node >/dev/null 2>&1; then
    LITE_CHECK=$(node -e "
      var fs = require('fs');
      var path = require('path');
      try {
        var scope = JSON.parse(fs.readFileSync('$SCOPE_FILE', 'utf8'));
        var filePath = '$REL_PATH';
        var dirs = scope.allowedDirectories || [];
        var banned = scope.bannedPatterns || {};

        var basename = path.basename(filePath);
        var bannedFiles = banned.files || [];
        for (var i = 0; i < bannedFiles.length; i++) {
          var regex = new RegExp(bannedFiles[i].replace(/\\*/g, '.*').replace(/\\?/g, '.'));
          if (regex.test(basename)) {
            console.log('banned:' + bannedFiles[i]);
            process.exit(0);
          }
        }

        var bannedDocs = banned.docs || [];
        for (var i = 0; i < bannedDocs.length; i++) {
          var regex = new RegExp(bannedDocs[i].replace(/\\*/g, '.*').replace(/\\?/g, '.'));
          if (regex.test(basename)) {
            console.log('banned:' + bannedDocs[i]);
            process.exit(0);
          }
        }

        if (dirs.length > 0) {
          var normalized = filePath.replace(/\\\\\\\\/g, '/');
          var found = false;
          for (var i = 0; i < dirs.length; i++) {
            var d = dirs[i].replace(/\\/$/, '');
            if (normalized.startsWith(d + '/') || normalized === d) { found = true; break; }
          }
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

    if [[ "$LITE_CHECK" == banned:* ]]; then
      PATTERN="${LITE_CHECK#banned:}"
      emit_scope_progression "This file matches banned pattern '$PATTERN' in .caws/scope.json."
      exit 0
    fi

    if [[ "$LITE_CHECK" == "not_allowed" ]]; then
      emit_scope_progression "This file is outside the allowed directories in .caws/scope.json."
      exit 0
    fi

    exit 0
  fi
fi

# Full mode: per-feature specs under .caws/specs/ (v11-shape aware)
SPECS_DIR="$SPECS_BASE/.caws/specs"

if command -v node >/dev/null 2>&1; then
  SCOPE_CHECK=$(node -e "
    var yaml = require('js-yaml');
    var fs = require('fs');
    var path = require('path');

    try {
      var filePath = '$REL_PATH';
      var projectDir = '$PROJECT_DIR';
      var worktreeName = '$WORKTREE_NAME';

      // v11-shape lifecycle resolution.
      // Read lifecycle_state first, fall back to status, then 'active'.
      function lifecycleOf(s) {
        return (s && (s.lifecycle_state || s.status)) || 'active';
      }
      // Terminal: not enforced at all.
      var TERMINAL = { closed: 1, archived: 1, completed: 1 };
      // Draft: does not participate in union-wide blocking. Only enforces
      // scope when it is the authoritative/bound spec.
      function isDraft(state) { return state === 'draft'; }

      // Collect all non-terminal per-feature specs under .caws/specs/.
      // Draft specs are collected but separately tagged.
      var specs = [];

      var specsDir = '$SPECS_DIR';
      if (fs.existsSync(specsDir)) {
        var files = fs.readdirSync(specsDir).filter(function(f) { return f.endsWith('.yaml') || f.endsWith('.yml'); });
        for (var fi = 0; fi < files.length; fi++) {
          try {
            var s = yaml.load(fs.readFileSync(path.join(specsDir, files[fi]), 'utf8'));
            if (!s) continue;
            var state = lifecycleOf(s);
            if (TERMINAL[state]) continue;
            specs.push({ source: files[fi], spec: s, state: state });
          } catch (_) {}
        }
      }

      if (specs.length === 0) {
        console.log('in_scope');
        process.exit(0);
      }

      // Authoritative binding lookup (v10 + v11 registry shape compat).
      function worktreeEntry(registry, name) {
        if (!registry) return null;
        if (registry.worktrees && registry.worktrees[name]) return registry.worktrees[name];
        if (registry[name] && typeof registry[name] === 'object') return registry[name];
        return null;
      }
      function boundSpecIdOf(entry) {
        if (!entry) return null;
        return entry.specId || entry.spec_id || null;
      }

      var authoritativeSpec = null;
      if (worktreeName) {
        try {
          var registryPath = path.join(projectDir, '.caws', 'worktrees.json');
          if (fs.existsSync(registryPath)) {
            var registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
            var entry = worktreeEntry(registry, worktreeName);
            var boundId = boundSpecIdOf(entry);
            if (boundId) {
              for (var si = 0; si < specs.length; si++) {
                var candidate = specs[si].spec || {};
                if (candidate.id === boundId && candidate.worktree === worktreeName) {
                  authoritativeSpec = specs[si];
                  break;
                }
              }
            }
          }
        } catch (_) {}
      }

      var mode = authoritativeSpec ? 'authoritative' : 'union';
      var specsToCheck;
      if (authoritativeSpec) {
        specsToCheck = [authoritativeSpec];
      } else {
        // Union mode: drafts do NOT participate. Only active specs.
        specsToCheck = specs.filter(function(s) { return !isDraft(s.state); });
        if (specsToCheck.length === 0) {
          // Only drafts present, none authoritative — allow.
          console.log('in_scope');
          process.exit(0);
        }
      }

      // Check scope.out across applicable specs — any match blocks
      for (var si = 0; si < specsToCheck.length; si++) {
        var outPatterns = (specsToCheck[si].spec.scope && specsToCheck[si].spec.scope.out) || [];
        for (var pi = 0; pi < outPatterns.length; pi++) {
          var regex = new RegExp(outPatterns[pi].replace(/\\*/g, '.*').replace(/\\?/g, '.'));
          if (regex.test(filePath)) {
            console.log('out_of_scope:' + mode + ':' + specsToCheck[si].source + ':' + outPatterns[pi]);
            process.exit(0);
          }
        }
      }

      // Union all scope.in patterns — file must match at least one
      var allInScope = [];
      for (var si = 0; si < specsToCheck.length; si++) {
        var inPatterns = (specsToCheck[si].spec.scope && specsToCheck[si].spec.scope.in) || [];
        for (var pi = 0; pi < inPatterns.length; pi++) {
          allInScope.push(inPatterns[pi]);
        }
      }
      if (allInScope.length > 0) {
        var found = false;
        for (var pi = 0; pi < allInScope.length; pi++) {
          var regex = new RegExp(allInScope[pi].replace(/\\*/g, '.*').replace(/\\?/g, '.'));
          if (regex.test(filePath)) {
            found = true;
            break;
          }
        }
        if (!found) {
          console.log('not_in_scope:' + mode);
          process.exit(0);
        }
      }

      console.log('in_scope');
    } catch (error) {
      console.log('error:' + error.message);
    }
  " 2>&1)

  if [[ "$SCOPE_CHECK" == out_of_scope:* ]]; then
    DETAIL="${SCOPE_CHECK#out_of_scope:}"
    MODE="${DETAIL%%:*}"
    REST="${DETAIL#*:}"
    SOURCE="${REST%%:*}"
    PATTERN="${REST#*:}"
    if [[ "$MODE" == "union" ]]; then
      emit_scope_progression "This file is marked out-of-scope in '$SOURCE' by pattern '$PATTERN'. Mode: union (no authoritative spec bound). An unrelated spec may be blocking this edit. Diagnose: caws scope show."
    else
      emit_scope_progression "This file is marked out-of-scope in '$SOURCE' by pattern '$PATTERN'. Mode: authoritative (checking only your bound spec)."
    fi
    exit 0
  fi

  if [[ "$SCOPE_CHECK" == not_in_scope:* ]]; then
    MODE="${SCOPE_CHECK#not_in_scope:}"
    if [[ "$MODE" == "union" ]]; then
      emit_scope_progression "This file is not in the defined scope of any active spec. Mode: union (no authoritative spec bound). Diagnose: caws scope show."
    else
      emit_scope_progression "This file is not in the defined scope of your bound spec. Mode: authoritative. Update your spec's scope.in if this file should be in scope."
    fi
    exit 0
  fi

  if [[ "$SCOPE_CHECK" == "not_in_scope" ]]; then
    emit_scope_progression "This file is not in the defined scope of any active spec. Diagnose: caws scope show."
    exit 0
  fi
fi

exit 0
