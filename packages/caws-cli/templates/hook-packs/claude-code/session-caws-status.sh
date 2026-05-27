#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: claude-code
# hook_pack_version: 6
# caws_min_major: 11
# lineage_refs: 4,11
# do_not_edit_directly: update via `caws init --agent-surface claude-code`
#
# CAWS Session Status Hook for Claude Code (v11-shape).
# Fires on session-start. Surfaces:
#   - active-worktree warning (dual-shape registry compatible)
#   - global vs repo CAWS version skew warning
#   - caws status briefing (v11-shape)
# Never blocks; emits to stdout for the agent's session start.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/parse-input.sh
source "$SCRIPT_DIR/lib/parse-input.sh"
# Hook does not read stdin fields -- dispatches on a positional arg.
# Sourcing parse-input.sh still wires up PATH (nvm/homebrew) for CAWS CLI.

EVENT_TYPE="${1:-}"
if [ "$EVENT_TYPE" != "session-start" ]; then
  exit 0
fi

if ! command -v caws &>/dev/null; then
  echo "CAWS CLI not found. Install with: npm install -g @paths.design/caws-cli"
  exit 0
fi

if [ ! -d "${CLAUDE_PROJECT_DIR:-.}/.caws" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

CAWS_ROOT="."
if command -v git >/dev/null 2>&1; then
  _GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null || echo ".git")
  if [ "$_GIT_COMMON" != ".git" ]; then
    _CANDIDATE=$(cd "$_GIT_COMMON/.." 2>/dev/null && pwd || echo "")
    if [ -n "$_CANDIDATE" ] && [ -d "$_CANDIDATE/.caws" ]; then
      CAWS_ROOT="$_CANDIDATE"
    fi
  fi
fi

# --- Active-worktree warning (dual-shape registry compatible) ---
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

if [ -f "$CAWS_ROOT/.caws/worktrees.json" ] && command -v node >/dev/null 2>&1; then
  WT_INFO=$(node -e "
    try {
      var reg = JSON.parse(require('fs').readFileSync('$CAWS_ROOT/.caws/worktrees.json', 'utf8'));
      function entriesOf(r) {
        if (!r || typeof r !== 'object') return [];
        if (r.worktrees && typeof r.worktrees === 'object') return Object.values(r.worktrees);
        // v11 direct-key: filter to objects with a 'status' field.
        var out = [];
        for (var k in r) {
          if (Object.prototype.hasOwnProperty.call(r, k)) {
            var v = r[k];
            if (v && typeof v === 'object' && typeof v.status === 'string') {
              // For v11 direct-key, the worktree name is the outer key,
              // not entry.name. Synthesize name from key when absent.
              if (!v.name) v = Object.assign({}, v, { name: k });
              out.push(v);
            }
          }
        }
        return out;
      }
      var entries = entriesOf(reg);
      var active = entries.filter(function(w) { return w.status === 'active'; });
      if (active.length > 0) {
        var names = active.map(function(w) { return (w.name || '<unknown>') + ' (' + (w.branch || '?') + ')'; });
        var bases = active.map(function(w) { return w.baseBranch || ''; }).filter(function(v,i,a) { return v && a.indexOf(v) === i; });
        console.log(active.length + ':' + names.join(', ') + ':' + bases.join(','));
      } else {
        console.log('0::');
      }
    } catch(e) { console.log('0::'); }
  " 2>/dev/null || echo "0::")

  WT_COUNT=$(echo "$WT_INFO" | cut -d: -f1)
  WT_NAMES=$(echo "$WT_INFO" | cut -d: -f2)
  WT_BASES=$(echo "$WT_INFO" | cut -d: -f3)

  if [ "$WT_COUNT" -gt 0 ] 2>/dev/null; then
    BASE_BRANCH=$(echo "$WT_BASES" | cut -d',' -f1)

    echo ""
    echo "================================================================"
    echo "  ACTIVE WORKTREES DETECTED: $WT_COUNT worktree(s)"
    echo "  $WT_NAMES"
    echo "================================================================"

    if [ -n "$BASE_BRANCH" ] && [ "$CURRENT_BRANCH" = "$BASE_BRANCH" ]; then
      echo ""
      echo "  Worktrees are preferred for isolated feature work, but direct"
      echo "  checkpoint edits on $CURRENT_BRANCH are allowed."
      echo ""
      echo "  If a worktree was created for your task:"
      echo "    cd $CAWS_ROOT/.caws/worktrees/<name>/"
      echo ""
      echo "  Worktree lifecycle commands (create/destroy/merge) return in"
      echo "  CAWS v11.1+; if you are on v11.0 they are not yet available."
      echo ""
      echo "  CANONICAL-CHECKOUT-WORKTREE-GUARD-001 active:"
      echo "    Mutating git commands from this checkout (checkout, switch,"
      echo "    branch -f, reset non-hard) are now BLOCKED while worktrees"
      echo "    are active. Read-only commands remain allowed. To act on a"
      echo "    worktree's branch, enter the worktree first."
      echo ""
    else
      echo ""
      echo "  You are on branch '$CURRENT_BRANCH' (worktree). Good."
      echo "  Other active worktrees: $WT_NAMES"
    fi
    echo "================================================================"
    echo ""
  fi
fi

# --- Version-skew warning (advisory, never blocks) ---
#
# Hooks parse local CAWS state directly. The global `caws` binary may be a
# different major version than the repo's caws-cli — for example, an
# operator has the v10 binary globally installed while editing a v11 repo,
# or vice versa during transitions. Diagnostics from a mismatched binary
# can recommend commands that do not exist in the target version.
if command -v caws >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  GLOBAL_VER="$(caws --version 2>/dev/null | head -1 | tr -d '[:space:]' || echo '')"
  GLOBAL_MAJOR="${GLOBAL_VER%%.*}"
  REPO_PKG_JSON=""
  for cand in \
    "$CAWS_ROOT/packages/caws-cli/package.json" \
    "$CAWS_ROOT/node_modules/@paths.design/caws-cli/package.json"; do
    if [ -f "$cand" ]; then REPO_PKG_JSON="$cand"; break; fi
  done
  if [ -n "$REPO_PKG_JSON" ] && [ -n "$GLOBAL_MAJOR" ]; then
    REPO_VER="$(node -e "
      try { console.log((require('$REPO_PKG_JSON').version || '').trim()); }
      catch(e) { console.log(''); }
    " 2>/dev/null || echo '')"
    REPO_MAJOR="${REPO_VER%%.*}"
    if [ -n "$REPO_MAJOR" ] && [ "$REPO_MAJOR" != "$GLOBAL_MAJOR" ]; then
      echo ""
      echo "WARNING: global caws major version ($GLOBAL_MAJOR) differs from repo caws-cli major version ($REPO_MAJOR)."
      echo "Hooks parse local state directly, but any CLI advice in diagnostics may be invalid."
      echo "Consider: npm install -g @paths.design/caws-cli@^$REPO_MAJOR"
      echo ""
    fi
  fi
fi

# --- CAWS status briefing (v11-shape) ---
# v11 replaces `caws session briefing` with `caws status`. Fall back if unavailable.
if caws status >/dev/null 2>&1; then
  caws status 2>/dev/null || true
else
  echo "--- CAWS Session Briefing (fallback) ---"
  HEAD_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
  BRANCH=$(git branch --show-current 2>/dev/null || echo "detached")
  DIRTY_COUNT=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  echo "Git: ${BRANCH} @ ${HEAD_SHA} (${DIRTY_COUNT} dirty files)"
  if [ "$DIRTY_COUNT" -gt 0 ]; then
    echo "WARNING: Working tree has uncommitted changes from a prior session."
    echo "Classify and commit or stash them before starting new work."
  fi
  echo "--- End CAWS Briefing ---"
fi

exit 0
