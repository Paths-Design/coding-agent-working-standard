#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: claude-code
# hook_pack_version: 5
# caws_min_major: 11
# lineage_refs: 4,6,11,19
# do_not_edit_directly: update via `caws init --agent-surface claude-code`
#
# CAWS Worktree Safety Guard for Claude Code (v11-shape).
# Blocks dangerous git operations and cross-boundary file copies when
# parallel worktrees are active.
#
# Registry-shape compatibility:
#   v11 direct-key: { "<name>": { "status": "active", ... } }
#   v10 nested:     { "worktrees": { "<name>": { ... } } }

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/parse-input.sh
source "$SCRIPT_DIR/lib/parse-input.sh"
parse_hook_input

TOOL_NAME="$HOOK_TOOL_NAME"
COMMAND="$HOOK_COMMAND"

if [[ "$TOOL_NAME" != "Bash" ]] || [[ -z "$COMMAND" ]]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

if command -v git >/dev/null 2>&1; then
  GIT_COMMON_DIR=$(cd "$PROJECT_DIR" && git rev-parse --git-common-dir 2>/dev/null || echo "")
  if [[ -n "$GIT_COMMON_DIR" ]] && [[ "$GIT_COMMON_DIR" != ".git" ]]; then
    CANDIDATE=$(cd "$PROJECT_DIR" && cd "$GIT_COMMON_DIR/.." 2>/dev/null && pwd || echo "")
    if [[ -n "$CANDIDATE" ]] && [[ -d "$CANDIDATE/.caws" ]]; then
      PROJECT_DIR="$CANDIDATE"
    fi
  fi
fi

# Block sparse checkout (runs before "only check git commands" early-exit)
if echo "$COMMAND" | grep -qE 'caws\s+(worktree\s+create|parallel\s+setup).*--scope'; then
  echo "BLOCKED: --scope (sparse checkout) is not allowed." >&2
  echo "Sparse checkout breaks cross-module imports in most projects." >&2
  echo "Use full worktrees without --scope. Scope enforcement comes from" >&2
  echo "CAWS feature specs and lane discipline, not from hiding files." >&2
  exit 2
fi

if echo "$COMMAND" | grep -qE '(^|;|&&|\|)\s*git\s+sparse-checkout'; then
  # WORKTREE-SPEC-CANONICAL-ACCESS-GUARD-001 A3: blanket refusal stays.
  # Agent-issued git sparse-checkout commands are refused regardless of
  # subcommand (disable / set / init / reapply / list / add). Recovery
  # of the canonical-spec-materialization invariant in a linked CAWS
  # worktree is a CAWS worktree-repair concern routed through the CLI,
  # not an agent-Bash git operation.
  echo "BLOCKED: agent-issued git sparse-checkout is refused in CAWS projects." >&2
  echo "" >&2
  echo "Sparse-checkout in a CAWS linked worktree carries the mechanical guard" >&2
  echo "against the v10.2 split-brain authority class: .caws/specs/ is excluded" >&2
  echo "from the worktree by design, so canonical spec authority cannot be" >&2
  echo "materialized inside the worktree as a divergent private copy. Disabling" >&2
  echo "sparse-checkout (or any sparse-checkout reconfiguration via agent Bash)" >&2
  echo "would re-open that class. Linked worktrees must not use worktree-local" >&2
  echo ".caws/specs/ files as authority; CAWS resolves spec reads through the" >&2
  echo "canonical control plane regardless of cwd." >&2
  echo "" >&2
  echo "To read a spec from any cwd (including this worktree), use:" >&2
  echo "  caws specs show <id>" >&2
  echo "" >&2
  echo "To check scope from any cwd, use:" >&2
  echo "  caws scope show <path>" >&2
  echo "  caws scope check <path>" >&2
  echo "" >&2
  echo "To restore the sparse-checkout invariant on a linked worktree (e.g.," >&2
  echo "after a human-authorized sparse-checkout reconfiguration left the tree" >&2
  echo "with materialized .caws/specs/ files), run from the canonical checkout:" >&2
  echo "  caws worktree repair-sparse <name>" >&2
  echo "" >&2
  echo "The repair command is non-destructive: it refuses dirty .caws/specs/" >&2
  echo "rather than stashing, cleaning, or deleting work." >&2
  exit 2
fi

# ─── CANONICAL-CHECKOUT-WORKTREE-GUARD-001 (Entry 19) ────────────────
# Block mutating git commands from the canonical checkout while at
# least one active CAWS worktree exists. Hook-layer enforcement only:
# authority remains in worktrees.json + specs. The guard's refusal
# predicate is conjunctive: canonical + worktrees-active + mutating
# command. Any one false MUST allow.
#
# Leases (.caws/leases/*.json) are NOT consulted by this decision —
# stale-lease-is-evidence-never-authority. The block decision uses
# worktrees.json's active entries only.
canonical_guard_emit_block() {
  local action="$1"
  local first_active="$2"
  echo "BLOCKED: $action from the canonical checkout while CAWS worktrees are active." >&2
  echo "Active worktree(s) detected (e.g. '$first_active' in .caws/worktrees.json)." >&2
  echo "Switch into your worktree before mutating: cd .caws/worktrees/$first_active" >&2
  echo "Or destroy any worktree that is genuinely abandoned: caws worktree destroy <name>" >&2
}

# Determine whether the session's cwd is the canonical checkout.
# git_dir == git_common_dir indicates canonical; a linked worktree has
# git_dir under git_common_dir/worktrees/<name>/.
CANONICAL_GUARD_CHECK_CWD="${HOOK_CWD:-$PROJECT_DIR}"
if command -v git >/dev/null 2>&1 && [[ -d "$CANONICAL_GUARD_CHECK_CWD" ]]; then
  GIT_DIR_RESOLVED=$(cd "$CANONICAL_GUARD_CHECK_CWD" && git rev-parse --git-dir 2>/dev/null | head -1 || echo "")
  GIT_COMMON_RESOLVED=$(cd "$CANONICAL_GUARD_CHECK_CWD" && git rev-parse --git-common-dir 2>/dev/null | head -1 || echo "")
  if [[ -n "$GIT_DIR_RESOLVED" ]] && [[ -n "$GIT_COMMON_RESOLVED" ]]; then
    # Normalize to absolute paths so equality is structural, not textual.
    GIT_DIR_ABS=$(cd "$CANONICAL_GUARD_CHECK_CWD" && cd "$GIT_DIR_RESOLVED" 2>/dev/null && pwd || echo "$GIT_DIR_RESOLVED")
    GIT_COMMON_ABS=$(cd "$CANONICAL_GUARD_CHECK_CWD" && cd "$GIT_COMMON_RESOLVED" 2>/dev/null && pwd || echo "$GIT_COMMON_RESOLVED")
    if [[ "$GIT_DIR_ABS" == "$GIT_COMMON_ABS" ]]; then
      # We are in the canonical checkout. Now check for active worktrees.
      WORKTREES_JSON="$PROJECT_DIR/.caws/worktrees.json"
      if [[ -f "$WORKTREES_JSON" ]] && command -v node >/dev/null 2>&1; then
        FIRST_ACTIVE_WT=$(node -e "
          try {
            var reg = JSON.parse(require('fs').readFileSync('$WORKTREES_JSON', 'utf8'));
            function entriesOf(r) {
              if (!r || typeof r !== 'object') return [];
              if (r.worktrees && typeof r.worktrees === 'object') {
                return Object.entries(r.worktrees);
              }
              var out = [];
              for (var k in r) {
                if (Object.prototype.hasOwnProperty.call(r, k)) {
                  var v = r[k];
                  if (v && typeof v === 'object') out.push([k, v]);
                }
              }
              return out;
            }
            var entries = entriesOf(reg);
            // 'active' is the documented status; entries without an
            // explicit status (legacy/in-flight registry shapes) are
            // also treated as active because the CLI's createWorktree
            // does not always emit a status field.
            var active = entries.filter(function(e) {
              var s = e[1] && e[1].status;
              return s === 'active' || s === undefined || s === null || s === '';
            });
            if (active.length > 0) console.log(active[0][0]);
            else console.log('');
          } catch(e) { console.log(''); }
        " 2>/dev/null || echo "")
        if [[ -n "$FIRST_ACTIVE_WT" ]]; then
          # Predicate (a) canonical + (b) at least one active worktree
          # is satisfied. Now check (c) mutation command keywords.
          # Read-only commands (status, log, diff, show, fetch w/o --prune,
          # rev-parse, ls-files, branch -v, stash list) are NOT in this
          # set; they fall through to the existing guard rules.
          if echo "$COMMAND" | grep -qE '(^|[[:space:];&|])git\s+checkout\s+[^[:space:]-]'; then
            canonical_guard_emit_block "git checkout (branch switch)" "$FIRST_ACTIVE_WT"
            exit 2
          fi
          if echo "$COMMAND" | grep -qE '(^|[[:space:];&|])git\s+switch\s+[^[:space:]-]'; then
            canonical_guard_emit_block "git switch (branch switch)" "$FIRST_ACTIVE_WT"
            exit 2
          fi
          if echo "$COMMAND" | grep -qE '(^|[[:space:];&|])git\s+branch\s+(-f|--force)'; then
            canonical_guard_emit_block "git branch -f (force branch update)" "$FIRST_ACTIVE_WT"
            exit 2
          fi
          # git reset variants other than --hard (already covered later in
          # this file) — --keep, --merge, --soft, --mixed, or with no
          # mode flag — mutate the canonical's working tree/HEAD.
          if echo "$COMMAND" | grep -qE '(^|[[:space:];&|])git\s+reset\b' \
             && ! echo "$COMMAND" | grep -qE 'git\s+reset\s+--hard'; then
            canonical_guard_emit_block "git reset (HEAD mutation)" "$FIRST_ACTIVE_WT"
            exit 2
          fi
        fi
      fi
    fi
  fi
fi
# ─── /CANONICAL-CHECKOUT-WORKTREE-GUARD-001 ──────────────────────────

# Block cross-boundary file copies (worktree → main).
WORKTREE_BASE="$PROJECT_DIR/.caws/worktrees"
if [[ -d "$WORKTREE_BASE" ]]; then
  if echo "$COMMAND" | grep -qE '\b(cp|mv)\b'; then
    AGENT_IN_WORKTREE=false
    if [[ -n "$HOOK_CWD" ]] && [[ "$HOOK_CWD" == "$WORKTREE_BASE"/* ]]; then
      AGENT_IN_WORKTREE=true
    fi

    if [[ "$AGENT_IN_WORKTREE" != "true" ]]; then
      if echo "$COMMAND" | grep -qF ".caws/worktrees/" || echo "$COMMAND" | grep -qF "$WORKTREE_BASE"; then
        HAS_WT_PATH=false
        HAS_MAIN_PATH=false
        if echo "$COMMAND" | grep -qE '\.caws/worktrees/|'"$(echo "$WORKTREE_BASE" | sed 's/[\/&]/\\&/g')"''; then
          HAS_WT_PATH=true
        fi
        if echo "$COMMAND" | grep -qE "(^|\s)$PROJECT_DIR/[^.]|core/|src/|tests/|packages/" && [[ "$HAS_WT_PATH" == "true" ]]; then
          HAS_MAIN_PATH=true
        fi
        if [[ "$HAS_WT_PATH" == "true" ]] && [[ "$HAS_MAIN_PATH" == "true" ]]; then
          echo "BLOCKED: Copying files from a worktree to the main repo is forbidden." >&2
          echo "This bypasses worktree isolation. Work entirely within your worktree." >&2
          echo "If tests need the main repo's venv, activate it with:" >&2
          echo "  source $PROJECT_DIR/.venv/bin/activate" >&2
          exit 2
        fi
      fi
    fi
  fi
fi

# Only check git commands from here on
if ! echo "$COMMAND" | grep -qE '(^|\s|&&|\|)git\s'; then
  exit 0
fi

# Determine if worktrees are active (dual-shape aware).
#
# Helper logic embedded in the Node inline reads worktrees.json under both
# shapes. v11 direct-key: registry keys are worktree names themselves,
# each value is an entry object with at least { status }. v10 nested:
# registry.worktrees is the entry map.
WORKTREES_ACTIVE=false
PARALLEL_BASE=""

if [[ -f "$PROJECT_DIR/.caws/parallel.json" ]] && command -v node >/dev/null 2>&1; then
  PARALLEL_INFO=$(node -e "
    try {
      var reg = JSON.parse(require('fs').readFileSync('$PROJECT_DIR/.caws/parallel.json', 'utf8'));
      var agents = (reg.agents || []).length;
      console.log(agents + ':' + (reg.baseBranch || ''));
    } catch(e) { console.log('0:'); }
  " 2>/dev/null || echo "0:")

  AGENT_COUNT=$(echo "$PARALLEL_INFO" | cut -d: -f1)
  PARALLEL_BASE=$(echo "$PARALLEL_INFO" | cut -d: -f2)

  if [[ "$AGENT_COUNT" -gt 0 ]] 2>/dev/null; then
    WORKTREES_ACTIVE=true
  fi
fi

if [[ "$WORKTREES_ACTIVE" != "true" ]] && [[ -f "$PROJECT_DIR/.caws/worktrees.json" ]] && command -v node >/dev/null 2>&1; then
  ACTIVE_COUNT=$(node -e "
    try {
      var reg = JSON.parse(require('fs').readFileSync('$PROJECT_DIR/.caws/worktrees.json', 'utf8'));
      // Dual-shape: v10 nested vs v11 direct-key.
      function entriesOf(r) {
        if (!r || typeof r !== 'object') return [];
        if (r.worktrees && typeof r.worktrees === 'object') return Object.values(r.worktrees);
        // v11 direct-key: filter to objects with a 'status' field to avoid
        // mistaking top-level metadata (e.g., 'version') for an entry.
        var out = [];
        for (var k in r) {
          if (Object.prototype.hasOwnProperty.call(r, k)) {
            var v = r[k];
            if (v && typeof v === 'object' && typeof v.status === 'string') out.push(v);
          }
        }
        return out;
      }
      var entries = entriesOf(reg);
      var active = entries.filter(function(w) { return w.status === 'active'; });
      console.log(active.length);
    } catch(e) { console.log('0'); }
  " 2>/dev/null || echo "0")

  if [[ "$ACTIVE_COUNT" -gt 0 ]] 2>/dev/null; then
    WORKTREES_ACTIVE=true
  fi
fi

if [[ "$WORKTREES_ACTIVE" != "true" ]]; then
  exit 0
fi

# --- Block dangerous git operations when worktrees are active ---

if echo "$COMMAND" | grep -qE 'git\s+commit\s+.*--amend'; then
  echo "BLOCKED: git commit --amend is not allowed while worktrees are active." >&2
  echo "Amending commits risks rewriting another agent's work." >&2
  echo "Create a new commit instead." >&2
  exit 2
fi

if echo "$COMMAND" | grep -qE 'git\s+stash' && ! echo "$COMMAND" | grep -qE 'git\s+stash\s+list'; then
  echo "BLOCKED: git stash is not allowed while worktrees are active." >&2
  echo "Stash is shared across all worktrees and can capture or destroy another agent's work." >&2
  echo "Commit your changes to your branch instead." >&2
  exit 2
fi

if echo "$COMMAND" | grep -qE 'git\s+reset\s+--hard'; then
  echo "BLOCKED: git reset --hard is not allowed while worktrees are active." >&2
  echo "This could discard work that other agents depend on." >&2
  exit 2
fi

if echo "$COMMAND" | grep -qE 'git\s+push\s+.*(--force|-f\s)'; then
  echo "BLOCKED: Force push is not allowed while worktrees are active." >&2
  echo "This could rewrite history that other agents have based work on." >&2
  exit 2
fi

# --- Base branch protections ---
AGENT_DIR="${HOOK_CWD:-${CLAUDE_PROJECT_DIR:-.}}"
CURRENT_BRANCH=$(cd "$AGENT_DIR" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

BASE_BRANCH="$PARALLEL_BASE"
if [[ -z "$BASE_BRANCH" ]] && [[ -f "$PROJECT_DIR/.caws/worktrees.json" ]] && command -v node >/dev/null 2>&1; then
  BASE_BRANCH=$(node -e "
    try {
      var reg = JSON.parse(require('fs').readFileSync('$PROJECT_DIR/.caws/worktrees.json', 'utf8'));
      function entriesOf(r) {
        if (!r || typeof r !== 'object') return [];
        if (r.worktrees && typeof r.worktrees === 'object') return Object.values(r.worktrees);
        var out = [];
        for (var k in r) {
          if (Object.prototype.hasOwnProperty.call(r, k)) {
            var v = r[k];
            if (v && typeof v === 'object' && typeof v.status === 'string') out.push(v);
          }
        }
        return out;
      }
      var entries = entriesOf(reg);
      var active = entries.filter(function(w) { return w.status === 'active'; });
      if (active.length > 0) console.log(active[0].baseBranch || '');
      else console.log('');
    } catch(e) { console.log(''); }
  " 2>/dev/null || echo "")
fi

if [[ -n "$BASE_BRANCH" ]] && [[ "$CURRENT_BRANCH" == "$BASE_BRANCH" ]]; then
  if echo "$COMMAND" | grep -qE 'git\s+push'; then
    echo "BLOCKED: Pushing from the base branch ($BASE_BRANCH) while worktrees are active." >&2
    echo "You should be working in a worktree, not on the base branch." >&2
    echo "Use: cd .caws/worktrees/<name>/" >&2
    exit 2
  fi

  if echo "$COMMAND" | grep -qE 'git\s+merge\b'; then
    echo '{
      "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "additionalContext": "Merging into base branch ('"$BASE_BRANCH"') while worktrees are active. The commit-msg hook will enforce the merge(worktree): message format. Make sure the worktree for this branch has been destroyed first."
      }
    }'
    exit 0
  fi

  if echo "$COMMAND" | grep -qE 'git\s+commit\b' && ! echo "$COMMAND" | grep -qE '--amend'; then
    echo '{
      "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "additionalContext": "NOTE: committing to the base branch ('"$BASE_BRANCH"') while worktrees are active. Worktrees are preferred for isolated feature work, but logical checkpoint commits from the current checkout are allowed by Claude hooks. Avoid --amend and force-push while worktrees are active."
      }
    }'
    exit 0
  fi
fi

exit 0
