#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: shared
# hook_pack_version: 1
# caws_min_major: 11
# lineage_refs: 4,8
# edit_stance: YOURS TO EDIT. This is a starting hook, not a locked one — shape it
#   to your repo: tune thresholds, add checks, remove what does not fit. Your edits
#   are preserved: caws init treats a changed hook as intended growth and will not
#   clobber it — it shows a diff and asks (--adopt keeps yours; --overwrite --force
#   takes the upstream template). The CAWS-MANAGED-HOOK marker above is only how caws
#   init finds hooks it can offer updates for; it is NOT a keep-out sign. CAWS owns the
#   failure-class invariant (the why/what a guard protects); you own the how. The one
#   edit to avoid: gutting a guard to dodge a block instead of fixing the cause. Grow
#   everything else freely.
# CAWS Worktree Cleanup Reminder
# Warns at session end if active worktrees remain. OPT-IN: not wired into
# the default stop HANDLERS array. Promoted from Sterling per
# HOOK-PACK-DIVERGENCE-RECONCILE-001.
# @author @darianrosebrook

set -euo pipefail

stop_activity_unavailable() {
  printf '[stop-worktree-check] activity unavailable: %s; reminder skipped\n' "$1" >&2
  exit 0
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/parse-input.sh
if [[ ! -f "$SCRIPT_DIR/lib/parse-input.sh" ]] || ! source "$SCRIPT_DIR/lib/parse-input.sh"; then
  stop_activity_unavailable hook-input
fi
# shellcheck source=lib/caws-state.sh
if [[ ! -f "$SCRIPT_DIR/lib/caws-state.sh" ]] || ! source "$SCRIPT_DIR/lib/caws-state.sh"; then
  stop_activity_unavailable canonical-root
fi
# Hook does not read stdin fields; only checks worktree registry state.
# Sourcing parse-input.sh still wires up PATH for node (used below).

declare -F caws_resolve_canonical_dir_into >/dev/null &&
  declare -F caws_physical_dir_into >/dev/null || stop_activity_unavailable canonical-root
PROJECT_DIR=""
if ! caws_resolve_canonical_dir_into PROJECT_DIR "${CAWS_PROJECT_DIR:-.}" ||
    ! caws_physical_dir_into PROJECT_DIR "$PROJECT_DIR"; then
  stop_activity_unavailable canonical-root
fi

# Check for active worktrees
if [[ -e "$PROJECT_DIR/.caws/worktrees.json" || -L "$PROJECT_DIR/.caws/worktrees.json" ]]; then
  command -v node >/dev/null 2>&1 || stop_activity_unavailable worktrees-registry
  ACTIVE_INFO="$(node -e "
    $CAWS_NODE_ENTRIES_OF
    try {
      var reg = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
      if (!reg || typeof reg !== 'object' || Array.isArray(reg)) process.exit(2);
      // Status-less entries (CLI-created — caws-cli 11.1.7+ persists no
      // status field) count as active alongside the explicit
      // 'active'/'fresh' states (HOOK-LIB-CONSOLIDATION-001 T1b).
      var active = entriesOf(reg).filter(function(w) {
        var s = w.status;
        return s === 'active' || s === 'fresh' || s === undefined || s === null || s === '';
      });
      if (active.length > 0) {
        console.log(active.length + ':' + active.map(function(w) { return w.name; }).join(', '));
      } else {
        console.log('0:');
      }
    } catch(e) { process.exit(2); }
  " "$PROJECT_DIR/.caws/worktrees.json" 2>/dev/null && printf x0 || printf 'x%s' "$?")"
  [[ "${ACTIVE_INFO##*x}" == 0 ]] || stop_activity_unavailable worktrees-registry
  ACTIVE_INFO="${ACTIVE_INFO%x*}"
  # Remove the reader's one record delimiter, retaining any data bytes.
  [[ "$ACTIVE_INFO" == *$'\n' ]] || stop_activity_unavailable worktrees-registry
  ACTIVE_INFO="${ACTIVE_INFO%$'\n'}"

  COUNT="${ACTIVE_INFO%%:*}"
  NAMES="${ACTIVE_INFO#*:}"
  [[ "$COUNT" =~ ^[0-9]+$ ]] || stop_activity_unavailable worktrees-registry

  if [[ "$COUNT" -eq 0 ]] 2>/dev/null; then
    echo "REMINDER: No active worktrees. Worktrees are preferred for isolated feature work; on the base branch the write guard's always-allowed allowlist still permits coordination/docs/config edits. To start isolated work: caws worktree create <name> --spec <id>. If a worktree's work is complete, run: caws worktree destroy <name> (then git branch -d <branch> to remove the branch)." >&2
    exit 0
  fi

  if [[ "$COUNT" -gt 0 ]] 2>/dev/null; then
    echo "REMINDER: $COUNT active worktree(s) remain: $NAMES. Other agents cannot commit to the base branch until all worktrees are destroyed. If your work is complete, run: caws worktree destroy <name> (then git branch -d <branch> to remove the branch)" >&2
    exit 0
  fi

fi

exit 0
