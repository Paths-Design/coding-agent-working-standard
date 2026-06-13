#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: shared
# hook_pack_version: 1
# caws_min_major: 11
# lineage_refs: 8,11,12,16
# do_not_edit_directly: update via `caws init`
#
# CAWS Scope Guard Hook (v11-shape).
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
# shellcheck source=lib/guard-message.sh
# Provides guard_identity / guard_amend_scope_hint / guard_not_harness_note —
# the shared legibility helpers (HOOK-GUARD-LEGIBILITY-001) so a scope refusal
# names itself ("CAWS scope-guard") and prints a literal copy-pasteable
# amend-scope remediation, instead of reading as a generic harness prompt.
# Guard with a file-existence test: under `set -euo pipefail`, `source <missing>`
# is a fatal builtin error a trailing `|| true` does NOT catch.
[[ -f "$SCRIPT_DIR/lib/guard-message.sh" ]] && source "$SCRIPT_DIR/lib/guard-message.sh"
# shellcheck source=lib/caws-state.sh
# Provides $CAWS_NODE_GLOB_TO_SCOPE_REGEXP — the single canonical scope-glob
# matcher shared with worktree-write-guard so the two guards can never
# disagree on a (path, pattern) scope decision (HOOK-LIB-CONSOLIDATION-001 T1a).
source "$SCRIPT_DIR/lib/caws-state.sh" 2>/dev/null || true
# shellcheck source=lib/agent-surface.sh
# Provides CAWS_PROJECT_DIR, CAWS_VENDOR_DIR for path resolution.
source "$SCRIPT_DIR/lib/agent-surface.sh" 2>/dev/null || true
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
  # Optional 2nd arg: the bound spec id (authoritative mode). When known, the
  # message prints the literal copy-pasteable widening command for THAT spec;
  # otherwise it falls back to a placeholdered form.
  local spec_id="${2:-}"

  local _id _hint _note
  if command -v guard_identity >/dev/null 2>&1; then
    _id="$(guard_identity scope-guard)"
    _hint="$(guard_amend_scope_hint "$spec_id" "$REL_PATH")"
    _note="$(guard_not_harness_note)"
  else
    _id="CAWS scope-guard"
    _hint="caws specs amend-scope ${spec_id:-<spec-id>} --add $REL_PATH"
    _note="This is a CAWS governance decision, not a harness prompt."
  fi

  local widen="If this path SHOULD be in scope, widen the bound spec: $_hint"
  local fix_options="Fix options: (1) edit a file already in scope, (2) $widen, (3) ask the user."
  local hard_block_guidance="If prior strikes from earlier edits are cornering this session and the scope is now correct, ask the user to run: bash ${CAWS_VENDOR_DIR}/hooks/reset-strikes.sh --current (or --session <uuid>) to clear stale strike state. Verify the worktree binding: the spec must declare 'worktree: <name>' and .caws/worktrees.json must map that same worktree name to the correct 'specId' (v10) or 'spec_id' (v11). On CAWS v11.0 the worktree lifecycle CLI is not yet restored; on v11.1+ use 'caws worktree bind'. Do not edit ${CAWS_VENDOR_DIR}/hooks/, ${CAWS_VENDOR_DIR}/logs/guard-strikes-*.json, or other guard state to bypass this check."

  guard_enforce_progressive_strikes \
    "$SESSION_ID" \
    "scope_guard" \
    "$WORK_DIR" \
    "$_id strike 1 of 3 for '$REL_PATH'. $_note This edit proceeds, but a second out-of-scope edit will require user approval. $detail $widen" \
    "$_id strike 2 of 3 for '$REL_PATH'. $_note Blocked — asking the user for approval. $detail $fix_options" \
    "$_id strike 3 of 3 for '$REL_PATH'. $_note Hard-blocked until scope is corrected. $detail $fix_options $hard_block_guidance"
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
  "$HOME/${CAWS_VENDOR_DIR}/"
  ".caws/"
  "${CAWS_VENDOR_DIR}/"
  "docs/"
  "tests/"
  "scripts/"
  "tmp/"
  ".archive/"
)

# Policy-declared non-governed zones (CAWSFIX-26 / ledger D9).
POLICY_FILE="${CAWS_PROJECT_DIR:-.}/.caws/policy.yaml"
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

WORK_DIR="${HOOK_CWD:-${CAWS_PROJECT_DIR:-.}}"
PROJECT_DIR="${CAWS_PROJECT_DIR:-.}"

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

# CAWS-LITE-MODE-RETIREMENT-001: lite mode (scope.json without specs/)
# was removed in pack v8. v11 projects only have .caws/specs/; lite-mode
# .caws/scope.json is a v10 artifact. Consumers with a legacy
# .caws/scope.json get a doctor finding (not a hook branch).
if [[ -d "$WORK_DIR/.caws/specs" ]]; then
  SPECS_BASE="$WORK_DIR"
else
  SPECS_BASE="$PROJECT_DIR"
fi

# No specs directory means no v11 governance to enforce.
if [[ ! -d "$SPECS_BASE/.caws/specs" ]]; then
  exit 0
fi

FOREIGN_REPO=0
if [[ "$FILE_PATH" == "$WORK_DIR"/* ]]; then
  REL_PATH="${FILE_PATH#$WORK_DIR/}"
elif [[ "$FILE_PATH" == "$PROJECT_DIR"/* ]]; then
  REL_PATH="${FILE_PATH#$PROJECT_DIR/}"
elif [[ "$FILE_PATH" == /* ]]; then
  # SCOPE-GUARD-FOREIGN-REPO-CONTAINMENT-001: an ABSOLUTE path under neither
  # this session's WORK_DIR nor PROJECT_DIR belongs to a DIFFERENT repository.
  REL_PATH="$FILE_PATH"
  FOREIGN_REPO=1
else
  REL_PATH="$FILE_PATH"
fi

# SCOPE-GUARD-FOREIGN-REPO-CONTAINMENT-001: hard-block a Write/Edit to a file in
# a DIFFERENT repository, immediately — before the kernel scope-check and the
# 3-strike ramp. Honor absolute allow-prefixes here, before the foreign block,
# so harness-state writes pass.
if [[ "$FOREIGN_REPO" == "1" ]]; then
  for _prefix in "${ALLOW_PREFIXES[@]}"; do
    [[ "$_prefix" == /* ]] || continue
    if [[ "$FILE_PATH" == "${_prefix}"* ]]; then
      exit 0
    fi
  done
  _id="CAWS scope-guard"
  command -v guard_identity >/dev/null 2>&1 && _id="$(guard_identity scope-guard)"
  _note="This is a CAWS governance decision, not a harness prompt."
  command -v guard_not_harness_note >/dev/null 2>&1 && _note="$(guard_not_harness_note)"
  emit_block "$_id: BLOCKED — '$FILE_PATH' is in a DIFFERENT repository than this session's project ($PROJECT_DIR). $_note This guard governs edits within the current repo; a session may READ sibling repos freely but must NOT WRITE into another repo from here, so it cannot silently mutate files (especially executables) outside its governing repo. There is no in-band override. To make this change: write an explicit HANDOFF for an agent rooted in that repo — state WHAT to change, WHY, and HOW (the exact edit), then have that repo's own session (or the user) apply it. Do NOT route around this via Bash (sed -i / cp / output redirect / node -e / python write) — those hit the same boundary and are a guard bypass."
  exit 2
fi

if [[ "$REL_PATH" != */* ]]; then
  exit 0
fi
for prefix in "${ALLOW_PREFIXES[@]}"; do
  if [[ "$FILE_PATH" == "${prefix}"* ]] || [[ "$REL_PATH" == "${prefix}"* ]]; then
    exit 0
  fi
done

# Full mode: per-feature specs under .caws/specs/ (v11-shape aware)
SPECS_DIR="$SPECS_BASE/.caws/specs"

# CAWS-SCOPE-STRIKE-SOURCE-UNIFY-001: delegate to `caws scope check`
# (the kernel-backed authority) before falling back to the inline node
# block below.
if command -v caws >/dev/null 2>&1; then
  if caws scope check "$REL_PATH" >/dev/null 2>&1; then
    # Kernel-authoritative ADMIT. Skip strike counter entirely.
    exit 0
  fi
fi

if command -v node >/dev/null 2>&1; then
  SCOPE_CHECK=$(node -e "
    var yaml = require('js-yaml');
    var fs = require('fs');
    var path = require('path');

    $CAWS_NODE_GLOB_TO_SCOPE_REGEXP

    try {
      var filePath = '$REL_PATH';
      var projectDir = '$PROJECT_DIR';
      var worktreeName = '$WORKTREE_NAME';

      // v11-shape lifecycle resolution.
      function lifecycleOf(s) {
        return (s && (s.lifecycle_state || s.status)) || 'active';
      }
      var TERMINAL = { closed: 1, archived: 1, completed: 1 };
      function isDraft(state) { return state === 'draft'; }

      var specs = [];
      var malformedSpecs = [];

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
          } catch (parseErr) {
            malformedSpecs.push(files[fi]);
            process.stderr.write('scope-guard: malformed spec at ' +
              files[fi] + ': ' + (parseErr && parseErr.message) + '\n');
          }
        }
      }

      if (specs.length === 0) {
        console.log('in_scope');
        process.exit(0);
      }

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

      if (worktreeName && malformedSpecs.length > 0) {
        try {
          var mRegistryPath = path.join(projectDir, '.caws', 'worktrees.json');
          if (fs.existsSync(mRegistryPath)) {
            var mRegistry = JSON.parse(fs.readFileSync(mRegistryPath, 'utf8'));
            var mEntry = worktreeEntry(mRegistry, worktreeName);
            var mBoundId = boundSpecIdOf(mEntry);
            if (mBoundId) {
              for (var mi = 0; mi < malformedSpecs.length; mi++) {
                var mFileBase = malformedSpecs[mi].replace(/\.ya?ml$/i, '');
                if (mFileBase === mBoundId) {
                  console.log('malformed_bound_spec:' + malformedSpecs[mi]);
                  process.exit(0);
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
        specsToCheck = specs.filter(function(s) { return !isDraft(s.state); });
        if (specsToCheck.length === 0) {
          console.log('in_scope');
          process.exit(0);
        }
      }

      for (var si = 0; si < specsToCheck.length; si++) {
        var outPatterns = (specsToCheck[si].spec.scope && specsToCheck[si].spec.scope.out) || [];
        for (var pi = 0; pi < outPatterns.length; pi++) {
          var regex = globToRegExp(outPatterns[pi]);
          if (regex.test(filePath)) {
            console.log('out_of_scope:' + mode + ':' + specsToCheck[si].source + ':' + outPatterns[pi]);
            process.exit(0);
          }
        }
      }

      var allInScope = [];
      for (var si = 0; si < specsToCheck.length; si++) {
        var inPatterns = (specsToCheck[si].spec.scope && specsToCheck[si].spec.scope.in) || [];
        for (var pi = 0; pi < inPatterns.length; pi++) {
          allInScope.push(inPatterns[pi]);
        }
        var supportPatterns = (specsToCheck[si].spec.scope && specsToCheck[si].spec.scope.support) || [];
        for (var sp = 0; sp < supportPatterns.length; sp++) {
          allInScope.push(supportPatterns[sp]);
        }
      }
      if (allInScope.length > 0) {
        var found = false;
        for (var pi = 0; pi < allInScope.length; pi++) {
          var regex = globToRegExp(allInScope[pi]);
          if (regex.test(filePath)) {
            found = true;
            break;
          }
        }
        if (!found) {
          var boundIdForHint = (authoritativeSpec && authoritativeSpec.spec && authoritativeSpec.spec.id) || '';
          console.log('not_in_scope:' + mode + ':' + boundIdForHint);
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

  if [[ "$SCOPE_CHECK" == malformed_bound_spec:* ]]; then
    MALFORMED_FILE="${SCOPE_CHECK#malformed_bound_spec:}"
    emit_scope_progression "Your worktree's bound spec '.caws/specs/$MALFORMED_FILE' failed to parse (invalid YAML). Scope cannot be enforced authoritatively, so the edit is refused rather than falling back to weaker union-mode checks. Fix the YAML in '$MALFORMED_FILE', then retry."
    exit 0
  fi

  if [[ "$SCOPE_CHECK" == not_in_scope:* ]]; then
    REST="${SCOPE_CHECK#not_in_scope:}"
    MODE="${REST%%:*}"
    BOUND_SPEC_ID=""
    if [[ "$REST" == *:* ]]; then
      BOUND_SPEC_ID="${REST#*:}"
    fi
    if [[ "$MODE" == "union" ]]; then
      emit_scope_progression "This file is not in the defined scope of any active spec. Mode: union (no authoritative spec bound). Diagnose: caws scope show."
    else
      emit_scope_progression "This file is not in the defined scope of your bound spec '${BOUND_SPEC_ID:-<unknown>}'. Mode: authoritative." "$BOUND_SPEC_ID"
    fi
    exit 0
  fi

  if [[ "$SCOPE_CHECK" == "not_in_scope" ]]; then
    emit_scope_progression "This file is not in the defined scope of any active spec. Diagnose: caws scope show."
    exit 0
  fi
fi

exit 0
