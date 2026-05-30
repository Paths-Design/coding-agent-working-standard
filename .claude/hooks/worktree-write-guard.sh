#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: claude-code
# hook_pack_version: 11
# caws_min_major: 11
# lineage_refs: 4,8,13
# do_not_edit_directly: update via `caws init --agent-surface claude-code`
#
# CAWS Worktree Write Guard for Claude Code.
#
# Two responsibilities:
#
#   1. Canonical-spec-materialization refusal
#      (WORKTREE-SPEC-CANONICAL-ACCESS-GUARD-001 A1/A2).
#      From inside a linked worktree (git rev-parse --git-common-dir !=
#      git rev-parse --git-dir, after realpath normalization), refuse
#      Read/Write/Edit tool calls whose file_path resolves under
#      <linked-worktree>/.caws/specs/*. Such files would be private
#      materialized copies of canonical spec authority, divergent from
#      the canonical .caws/specs bytes, silently consulted by anything
#      that walks cwd upward. The refusal MUST fire BEFORE the broad
#      .caws/* allowlist below, otherwise the allowlist would exit 0
#      first and the slice would appear implemented while the target
#      path still bypassed the guard. The canonical checkout itself
#      (git_common_dir == git_dir) IS spec authority and is allowed
#      through this predicate; this refusal targets the linked-worktree
#      materialization class only.
#
#   2. Base-branch write enforcement (intentionally fail-open for
#      v11.1, restored in CLI-WORKTREE-001). The hook serves as the
#      managed-install seat for the worktree-write enforcement surface
#      and asserts the always-allowed allowlist so .caws/, .claude/,
#      docs/, scripts/, tmp/, and tests/ writes are never inadvertently
#      blocked by a future enforcement pass that forgets the allowlist.
#
# Worktree-active enforcement (when restored) must read the worktrees
# registry under both shapes:
#   v11 direct-key: { "<name>": { ... } }
#   v10 nested:     { "worktrees": { "<name>": { ... } } }
# and accept both specId (v10) and spec_id (v11) on entries.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/parse-input.sh
source "$SCRIPT_DIR/lib/parse-input.sh"
parse_hook_input
# shellcheck source=lib/caws-state.sh
# Provides $CAWS_NODE_ENTRIES_OF / $CAWS_NODE_ENTRY_SPEC_ID (registry
# reads) and _realpath (path normalization) used throughout this guard.
# The lib is a managed sibling shipped with this hook; if it is somehow
# absent we cannot normalize paths safely, so fail OPEN (exit 0) rather
# than enforce on un-normalized paths (HOOK-LIB-CONSOLIDATION-001 T2a).
source "$SCRIPT_DIR/lib/caws-state.sh" 2>/dev/null || exit 0
command -v _realpath >/dev/null 2>&1 || exit 0

TOOL_NAME="$HOOK_TOOL_NAME"
FILE_PATH="$HOOK_FILE_PATH"

case "$TOOL_NAME" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

# WORKTREE_ROOT: where the agent is operating from. This is the cwd
# whose .caws/specs/* path is the refusal target. Kept distinct from
# CANONICAL_ROOT below — these MUST NOT be conflated for the spec-path
# predicate.
WORKTREE_ROOT="${CLAUDE_PROJECT_DIR:-.}"
WORKTREE_ROOT="$(cd "$WORKTREE_ROOT" 2>/dev/null && pwd -P || printf '%s\n' "$WORKTREE_ROOT")"

# _realpath is provided by lib/caws-state.sh (sourced above) —
# HOOK-LIB-CONSOLIDATION-001 T2a. The local copy was removed.

# Linked-worktree detection via git as primary signal. CAWS registry
# (.caws/worktrees.json) is consulted ONLY for diagnostic enrichment;
# a registry desync MUST NOT suppress the refusal (I3).
IS_LINKED_WORKTREE=0
CANONICAL_ROOT=""
if command -v git >/dev/null 2>&1; then
  GIT_COMMON_DIR_RAW="$(cd "$WORKTREE_ROOT" 2>/dev/null && git rev-parse --git-common-dir 2>/dev/null || printf '')"
  GIT_DIR_RAW="$(cd "$WORKTREE_ROOT" 2>/dev/null && git rev-parse --git-dir 2>/dev/null || printf '')"
  if [[ -n "$GIT_COMMON_DIR_RAW" ]] && [[ -n "$GIT_DIR_RAW" ]]; then
    # Resolve relative paths against WORKTREE_ROOT before realpath.
    case "$GIT_COMMON_DIR_RAW" in
      /*) GIT_COMMON_DIR_ABS="$GIT_COMMON_DIR_RAW" ;;
      *)  GIT_COMMON_DIR_ABS="$WORKTREE_ROOT/$GIT_COMMON_DIR_RAW" ;;
    esac
    case "$GIT_DIR_RAW" in
      /*) GIT_DIR_ABS="$GIT_DIR_RAW" ;;
      *)  GIT_DIR_ABS="$WORKTREE_ROOT/$GIT_DIR_RAW" ;;
    esac
    GIT_COMMON_DIR="$(_realpath "$GIT_COMMON_DIR_ABS")"
    GIT_DIR="$(_realpath "$GIT_DIR_ABS")"
    if [[ -n "$GIT_COMMON_DIR" ]] && [[ "$GIT_COMMON_DIR" != "$GIT_DIR" ]]; then
      IS_LINKED_WORKTREE=1
      # CANONICAL_ROOT = parent of GIT_COMMON_DIR. Used for allowlist
      # rewriting only; NOT used for the spec-path refusal predicate.
      CANONICAL_CANDIDATE="$(_realpath "$GIT_COMMON_DIR/..")"
      if [[ -n "$CANONICAL_CANDIDATE" ]] && [[ -d "$CANONICAL_CANDIDATE/.caws" ]]; then
        CANONICAL_ROOT="$CANONICAL_CANDIDATE"
      fi
    fi
  fi
fi

# Canonical-spec-materialization refusal (I1: BEFORE the allowlist).
#
# Predicate: tool_name in {Read,Write,Edit} (already gated above)
#            AND is_linked_worktree (via git signal)
#            AND FILE_PATH resolves under <WORKTREE_ROOT>/.caws/specs/.
#
# WORKTREE_ROOT is the cwd-as-resolved-via-CLAUDE_PROJECT_DIR. NOT
# CANONICAL_ROOT, NOT a PROJECT_DIR that has been rewritten upward. The
# refused path lives under the LINKED worktree's tree.
if [[ "$IS_LINKED_WORKTREE" == "1" ]] && [[ -n "$FILE_PATH" ]]; then
  # WORKTREE_ROOT is already realpath-normalized (pwd -P above), so
  # SPEC_ROOT inherits that normalization. We MUST also normalize
  # FILE_PATH_ABS through _realpath so the comparison is symlink-
  # immune. On macOS, /tmp -> /private/tmp; without normalization, an
  # agent-supplied /tmp/.../.caws/specs/X.yaml would NOT prefix-match
  # SPEC_ROOT=/private/tmp/.../.caws/specs because the literal strings
  # diverge. python3 os.path.realpath resolves the existing prefix
  # even when the leaf does not exist (Write tool case).
  SPEC_ROOT="$WORKTREE_ROOT/.caws/specs"
  case "$FILE_PATH" in
    /*) FILE_PATH_ABS="$FILE_PATH" ;;
    *)  FILE_PATH_ABS="$WORKTREE_ROOT/$FILE_PATH" ;;
  esac
  FILE_PATH_ABS="$(_realpath "$FILE_PATH_ABS")"
  case "$FILE_PATH_ABS" in
    "$SPEC_ROOT"/*|"$SPEC_ROOT")
      echo "[worktree-write-guard.sh] BLOCKED: $FILE_PATH" >&2
      echo "[worktree-write-guard.sh] Refusing $TOOL_NAME against a linked-worktree .caws/specs/ path." >&2
      echo "[worktree-write-guard.sh]" >&2
      echo "[worktree-write-guard.sh] Linked worktrees must not use worktree-local .caws/specs/ files as authority." >&2
      echo "[worktree-write-guard.sh] That path would be a private materialized copy, not canonical spec authority." >&2
      echo "[worktree-write-guard.sh] CAWS resolves spec reads through the canonical control plane regardless of cwd." >&2
      echo "[worktree-write-guard.sh]" >&2
      echo "[worktree-write-guard.sh] To read a spec from any cwd (including this worktree), use:" >&2
      echo "[worktree-write-guard.sh]   caws specs show <id>" >&2
      echo "[worktree-write-guard.sh]" >&2
      echo "[worktree-write-guard.sh] To check scope from any cwd, use:" >&2
      echo "[worktree-write-guard.sh]   caws scope show <path>" >&2
      echo "[worktree-write-guard.sh]   caws scope check <path>" >&2
      echo "[worktree-write-guard.sh]" >&2
      echo "[worktree-write-guard.sh] If sparse-checkout was disabled in this worktree and you need to restore" >&2
      echo "[worktree-write-guard.sh] the canonical-only invariant, run from the canonical checkout:" >&2
      echo "[worktree-write-guard.sh]   caws worktree repair-sparse <name>" >&2
      exit 2
      ;;
  esac
fi

# Legacy allowlist preserved from v11.1 fail-open base-branch enforcement.
# For the allowlist, use PROJECT_DIR rewritten toward the canonical checkout
# (the historical behavior) so that .caws/ etc. paths under canonical also
# match when the agent is operating from inside a linked worktree.
PROJECT_DIR="$WORKTREE_ROOT"
if [[ -n "$CANONICAL_ROOT" ]]; then
  PROJECT_DIR="$CANONICAL_ROOT"
fi

# Always-allowed paths bypass enforcement.
# User-global Claude state lives outside the repo; .caws/, .claude/, docs/,
# scripts/, tmp/, .archive/, and .githooks/ are coordination/governance
# surfaces, not application code.
#
# PROJECT_DIR is realpath-normalized (pwd -P / _realpath above). An
# agent-supplied FILE_PATH may NOT be (e.g. /tmp/... vs /private/tmp/...
# on macOS), so a raw "$PROJECT_DIR"/docs/* arm would miss. Normalize the
# file path through _realpath for the absolute-prefix comparison; keep the
# bare relative arms (docs/*, .caws/*) for cwd-relative paths.
if [[ -n "$FILE_PATH" ]]; then
  case "$FILE_PATH" in
    /*) FILE_PATH_FOR_ALLOWLIST="$(_realpath "$FILE_PATH")" ;;
    *)  FILE_PATH_FOR_ALLOWLIST="$FILE_PATH" ;;
  esac
  case "$FILE_PATH_FOR_ALLOWLIST" in
    "${HOME:-}"/.claude/*) exit 0 ;;
    "$PROJECT_DIR"/.caws/*|.caws/*) exit 0 ;;
    "$PROJECT_DIR"/.claude/*|.claude/*) exit 0 ;;
    # Root CLAUDE.md is the project-level agent-instruction surface; it lives
    # at the repo root (not under .claude/) so it needs its own arm.
    "$PROJECT_DIR"/CLAUDE.md|CLAUDE.md) exit 0 ;;
    "$PROJECT_DIR"/.gitignore|.gitignore) exit 0 ;;
    "$PROJECT_DIR"/.tmp/*|.tmp/*) exit 0 ;;
    "$PROJECT_DIR"/tmp/*|tmp/*) exit 0 ;;
    "$PROJECT_DIR"/.archive/*|.archive/*) exit 0 ;;
    "$PROJECT_DIR"/.githooks/*|.githooks/*) exit 0 ;;
    "$PROJECT_DIR"/.github/*|.github/*) exit 0 ;;
    "$PROJECT_DIR"/docs/*|docs/*) exit 0 ;;
  esac
fi

# --- Base-branch write enforcement -----------------------------------------
# Harvested from Sterling (HOOK-PACK-DIVERGENCE-RECONCILE-001). Previously
# this hook was fail-open (exit 0) pending CLI-WORKTREE-001; that spec is
# archived and the active successor is WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-001.
# Enforcement is now restored: writes on the base branch are refused while
# worktrees are active (or whenever no worktree context is present), with a
# scope-contention diagnosis. Uses the dual-shape registry helpers from
# lib/caws-state.sh ($CAWS_NODE_ENTRIES_OF / $CAWS_NODE_ENTRY_SPEC_ID).

# Need the registry + node to enforce; absent either, fail open.
if [[ ! -f "$PROJECT_DIR/.caws/worktrees.json" ]]; then
  exit 0
fi
if ! command -v node >/dev/null 2>&1; then
  exit 0
fi

# Use the hook input's cwd (where the agent is actually working), not
# CLAUDE_PROJECT_DIR (which always points to the main repo root, even when the
# agent has cd'd into a worktree at .caws/worktrees/<name>/).
AGENT_DIR="${HOOK_CWD:-${CLAUDE_PROJECT_DIR:-.}}"
# Normalize AGENT_DIR through realpath so the WORKTREE_BASE prefix check
# below is symlink-immune (PROJECT_DIR is already normalized; an
# un-normalized AGENT_DIR like /tmp/... would never prefix-match a
# /private/tmp/... WORKTREE_BASE on macOS).
AGENT_DIR="$(_realpath "$AGENT_DIR")"
CURRENT_BRANCH=$(caws_current_branch "$AGENT_DIR")  # HOOK-LIB-CONSOLIDATION-001 T2b
WORKTREE_BASE="$PROJECT_DIR/.caws/worktrees"

# If the agent is already operating inside a CAWS worktree, allow edits.
# A worktree may be "fresh" before its first commit, so branch-based matching
# alone is not sufficient here.
if [[ -n "$AGENT_DIR" ]] && [[ "$AGENT_DIR" == "$WORKTREE_BASE"/* ]]; then
  exit 0
fi

# Also allow edits when the current branch itself is a registered non-destroyed
# worktree branch, even if the cwd did not preserve the worktree path.
IS_REGISTERED_WORKTREE=$(node -e "
  $CAWS_NODE_ENTRIES_OF
  try {
    var reg = JSON.parse(require('fs').readFileSync('$PROJECT_DIR/.caws/worktrees.json', 'utf8'));
    var current = '$CURRENT_BRANCH';
    var found = entriesOf(reg).some(function(w) {
      return w.branch === current && w.status !== 'destroyed' && w.status !== 'missing';
    });
    console.log(found ? '1' : '0');
  } catch(e) { console.log('0'); }
" 2>/dev/null || echo "0")

if [[ "$IS_REGISTERED_WORKTREE" == "1" ]]; then
  exit 0
fi

WT_INFO=$(node -e "
  $CAWS_NODE_ENTRIES_OF
  try {
    var reg = JSON.parse(require('fs').readFileSync('$PROJECT_DIR/.caws/worktrees.json', 'utf8'));
    var active = entriesOf(reg).filter(function(w) {
      return w.status !== 'destroyed' && w.status !== 'missing' && w.baseBranch === '$CURRENT_BRANCH';
    });
    console.log(active.length + ':' + active.map(function(w) { return w.name; }).join(', '));
  } catch(e) { console.log('0:'); }
" 2>/dev/null || echo "0:")

WT_COUNT=$(echo "$WT_INFO" | cut -d: -f1)
WT_NAMES=$(echo "$WT_INFO" | cut -d: -f2)

if [[ "$WT_COUNT" -lt 1 ]] 2>/dev/null && command -v git >/dev/null 2>&1; then
  GIT_WT_INFO=$(git -C "$PROJECT_DIR" worktree list --porcelain 2>/dev/null | awk -v current="$PROJECT_DIR" '
    BEGIN {
      count = 0;
      names = "";
      path = "";
    }
    /^worktree / {
      path = substr($0, 10);
      next;
    }
    /^branch / {
      if (path != "" && path != current) {
        count++;
        name = path;
        sub(/^.*\//, "", name);
        names = names (names ? ", " : "") name;
      }
      path = "";
      next;
    }
    END {
      if (path != "" && path != current) {
        count++;
        name = path;
        sub(/^.*\//, "", name);
        names = names (names ? ", " : "") name;
      }
      printf "%d:%s\n", count, names;
    }
  ')

  WT_COUNT=$(echo "$GIT_WT_INFO" | cut -d: -f1)
  WT_NAMES=$(echo "$GIT_WT_INFO" | cut -d: -f2-)
fi

if [[ -n "$FILE_PATH" ]] && [[ "$WT_COUNT" -gt 0 ]] 2>/dev/null; then
  # Derive REL_PATH from the realpath-normalized file path so it strips the
  # normalized PROJECT_DIR prefix correctly (see allowlist note above).
  REL_PATH="${FILE_PATH_FOR_ALLOWLIST:-$FILE_PATH}"
  if [[ "$REL_PATH" == "$PROJECT_DIR"/* ]]; then
    REL_PATH="${REL_PATH#$PROJECT_DIR/}"
  fi

  SPEC_CONTENTION_CHECK=$(PROJECT_DIR="$PROJECT_DIR" CURRENT_BRANCH="$CURRENT_BRANCH" REL_PATH="$REL_PATH" node -e "
    var fs = require('fs');
    var path = require('path');
    var yaml;

    try {
      yaml = require('js-yaml');
    } catch (_) {
      console.log('unknown:no-js-yaml');
      process.exit(0);
    }

    $CAWS_NODE_ENTRIES_OF
    $CAWS_NODE_ENTRY_SPEC_ID
    $CAWS_NODE_GLOB_TO_SCOPE_REGEXP

    try {
      var projectDir = process.env.PROJECT_DIR;
      var currentBranch = process.env.CURRENT_BRANCH;
      var relPath = process.env.REL_PATH;
      var registryPath = path.join(projectDir, '.caws', 'worktrees.json');
      var registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      // entriesOf handles both v10 envelope and v11 flat-map shapes —
      // see lib/caws-state.sh.
      var worktrees = entriesOf(registry).filter(function(w) {
        return w.status !== 'destroyed' && w.status !== 'missing' && w.baseBranch === currentBranch;
      });

      if (worktrees.length === 0) {
        console.log('unknown:no-registry-worktrees');
        process.exit(0);
      }

      for (var wi = 0; wi < worktrees.length; wi++) {
        var wt = worktrees[wi];
        // entrySpecId handles both v11 spec_id and v10 specId carryover.
        var wtSpecId = entrySpecId(wt);
        if (!wtSpecId) {
          console.log('unknown:missing-specId:' + (wt.name || 'unnamed'));
          process.exit(0);
        }

        var specPath = path.join(projectDir, '.caws', 'specs', wtSpecId + '.yaml');
        if (!fs.existsSync(specPath)) {
          specPath = path.join(projectDir, '.caws', 'specs', wtSpecId + '.yml');
        }
        if (!fs.existsSync(specPath)) {
          console.log('unknown:missing-spec:' + wtSpecId);
          process.exit(0);
        }

        var spec = yaml.load(fs.readFileSync(specPath, 'utf8')) || {};
        var scope = spec.scope || {};
        var patterns = []
          .concat(Array.isArray(scope.in) ? scope.in : [])
          .concat(Array.isArray(scope.out) ? scope.out : []);

        if (patterns.length === 0) {
          console.log('unknown:missing-scope:' + wtSpecId);
          process.exit(0);
        }

        for (var pi = 0; pi < patterns.length; pi++) {
          if (globToRegExp(patterns[pi]).test(relPath)) {
            console.log('claimed:' + (wt.name || wtSpecId) + ':' + patterns[pi]);
            process.exit(0);
          }
        }
      }

      console.log('clear');
    } catch (error) {
      console.log('unknown:' + error.message);
    }
  " 2>/dev/null || echo "unknown:node-error")

  # We deliberately do NOT early-return on "clear". Sibling agents routinely
  # edit outside their declared scope (rename refactors, test updates,
  # cross-cutting fixes), and those unclaimed edits are exactly what triggers
  # cross-agent collisions on shared files. We still COMPUTE the contention
  # decision so the block message can tell the user whether the file is
  # claimed, unclaimed, or the check couldn't run.
  :
fi

# Block writes on the base branch even when no matching worktrees are active.
# Working directly on main is forbidden; the agent must first enter or create a
# worktree before making edits.
if [[ "$WT_COUNT" -eq 0 ]] 2>/dev/null; then
  echo "[worktree-write-guard.sh] BLOCKED: Cannot write/edit files on '$CURRENT_BRANCH' without a worktree." >&2
  echo "" >&2
  echo "Worktrees are preferred for isolated feature work. If you are doing" >&2
  echo "repo-coordination work (docs, .caws/, .claude/ config), the always-" >&2
  echo "allowed allowlist above already let that through; this block is for" >&2
  echo "application/source edits on the base branch." >&2
  echo "  To use an existing worktree: cd $PROJECT_DIR/.caws/worktrees/<name>/" >&2
  echo "  To create a new worktree:    caws worktree create <name>" >&2
  echo "" >&2
  echo "Do NOT edit .claude/hooks/, .claude/logs/guard-strikes-*.json, or other guard state to bypass this." >&2
  echo "If you believe the base branch needs a direct edit, ask the user first." >&2
  exit 2
fi

# Allow edits during an active merge (conflict resolution). The worktree-
# isolation rules explicitly permit merge commits on the base branch; conflict
# resolution requires Write/Edit on the conflicted files.
MERGE_HEAD_PATH=$(cd "$AGENT_DIR" && git rev-parse --git-dir 2>/dev/null || echo ".git")
if [[ -f "$MERGE_HEAD_PATH/MERGE_HEAD" ]]; then
  exit 0
fi

# Block: we're on the base branch with active worktrees.
echo "[worktree-write-guard.sh] BLOCKED: Cannot write/edit files on '$CURRENT_BRANCH' while $WT_COUNT worktree(s) are active: $WT_NAMES" >&2
echo "" >&2

# Surface the scope-contention decision so the user knows WHY we blocked:
# either a specific active worktree claimed this file, or the contention check
# itself could not reach a decision (missing specId, missing spec, missing scope).
if [[ -n "${SPEC_CONTENTION_CHECK:-}" ]]; then
  case "$SPEC_CONTENTION_CHECK" in
    claimed:*)
      echo "File is claimed by an active worktree's scope:" >&2
      echo "  $SPEC_CONTENTION_CHECK" >&2
      echo "  (format: claimed:<worktree-name>:<matching-pattern>)" >&2
      echo "Switch into that worktree to make this edit." >&2
      echo "" >&2
      ;;
    clear)
      echo "No active worktree's scope claims this file." >&2
      echo "  Main remains blocked anyway — sibling agents routinely edit" >&2
      echo "  outside their declared scope (rename refactors, test updates," >&2
      echo "  cross-cutting fixes), and those unclaimed edits are exactly" >&2
      echo "  what triggers cross-agent collisions on shared files." >&2
      echo "  Create a new worktree + spec for this work, or extend an" >&2
      echo "  existing spec's scope.in to cover this file." >&2
      echo "" >&2
      ;;
    unknown:*)
      echo "Scope contention could not be evaluated: $SPEC_CONTENTION_CHECK" >&2
      echo "  Likely a spec is missing specId, spec file, or scope." >&2
      echo "  Run 'caws scope show <path>' to diagnose; 'caws worktree bind <name> --spec <id>' to fix." >&2
      echo "" >&2
      ;;
  esac
fi

echo "You MUST work in a worktree, not on the base branch." >&2
echo "  To use an existing worktree: cd $PROJECT_DIR/.caws/worktrees/<name>/" >&2
echo "  To create a new worktree:    caws worktree create <name>" >&2
echo "" >&2
echo "Do NOT make changes on main and create a worktree retroactively." >&2
echo "The worktree must exist BEFORE you start making changes." >&2
echo "Do NOT edit .claude/hooks/, .claude/logs/guard-strikes-*.json, or other guard state to bypass this." >&2
echo "If you believe the base branch needs a direct edit, ask the user first." >&2
echo "" >&2
echo "If you are merging a worktree branch, use: caws worktree merge <name>" >&2
echo "Or start the merge first (git merge --no-ff <branch>), then resolve conflicts." >&2
exit 2
