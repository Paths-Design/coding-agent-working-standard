#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: shared
# hook_pack_version: 139
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
# The stopping session's id decides which lanes this reminder may speak for.
# The dispatcher normally exports it; a standalone run parses the payload.
# A failed parse leaves the id unavailable, which names no lane below.
parse_hook_input >/dev/null 2>&1 || true
SESSION_ID="${HOOK_SESSION_ID:-}"
[[ "$SESSION_ID" == "unknown" ]] && SESSION_ID=""

declare -F caws_resolve_canonical_dir_into >/dev/null &&
  declare -F caws_physical_dir_into >/dev/null || stop_activity_unavailable canonical-root
PROJECT_DIR=""
if ! caws_resolve_canonical_dir_into PROJECT_DIR "${CAWS_PROJECT_DIR:-.}" ||
    ! caws_physical_dir_into PROJECT_DIR "$PROJECT_DIR"; then
  stop_activity_unavailable canonical-root
fi

# Check for active worktrees. The reminder names only lanes the stopping
# session owns. Another session's lane is reported as a count and never with
# a merge or destroy step: telling one agent to destroy a peer's lane is how
# work gets lost. Ownership is the claim oracle's rule (lib/
# worktree-claim-oracle.cjs): registry owner session id equal to this
# session's id, compared exactly.
if [[ -e "$PROJECT_DIR/.caws/worktrees.json" || -L "$PROJECT_DIR/.caws/worktrees.json" ]]; then
  command -v node >/dev/null 2>&1 || stop_activity_unavailable worktrees-registry
  REMINDER="$(node -e "
    $CAWS_NODE_ENTRIES_OF
    try {
      var reg = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
      if (!reg || typeof reg !== 'object' || Array.isArray(reg)) process.exit(2);
      var session = process.argv[2] || '';
      // Status-less entries (CLI-created — caws-cli 11.1.7+ persists no
      // status field) count as active alongside the explicit
      // 'active'/'fresh' states (HOOK-LIB-CONSOLIDATION-001 T1b).
      var active = entriesOf(reg).filter(function(w) {
        var s = w && w.status;
        return s === 'active' || s === 'fresh' || s === undefined || s === null || s === '';
      });
      function ownerOf(w) {
        var o = w && w.owner;
        if (o && typeof o === 'object' && typeof o.session_id === 'string') return o.session_id;
        if (typeof o === 'string') return o;
        return '';
      }
      var msg = '';
      if (active.length === 0) {
        msg = 'REMINDER: No active worktrees. Worktrees are preferred for isolated feature work; ' +
          'on the base branch the write guard\\'s always-allowed allowlist still permits ' +
          'coordination/docs/config edits. To start isolated work: caws worktree create <name> --spec <id>.';
      } else if (!session) {
        msg = 'REMINDER: ' + active.length + ' active worktree(s) are registered, but this session\\'s ' +
          'identity is unavailable, so ownership could not be attributed. Check owners with ' +
          'caws worktree list before merging or removing any lane; a lane another session owns is not yours.';
      } else {
        var mine = active.filter(function(w) { return ownerOf(w) === session; });
        var others = active.length - mine.length;
        if (mine.length > 0) {
          msg = 'REMINDER: this session owns ' + mine.length + ' active worktree(s): ' +
            mine.map(function(w) { return w.name; }).join(', ') + '. When a lane\\'s work is ' +
            'committed and verified, land it from the canonical checkout with: caws worktree merge <name>.';
          if (others > 0) {
            msg += ' ' + others + ' other active worktree(s) belong to other sessions and are not yours to merge or destroy.';
          }
        } else {
          msg = 'REMINDER: this session owns no active worktrees. ' + others +
            ' active worktree(s) belong to other sessions and are not yours to merge or destroy.';
        }
      }
      console.log(msg);
    } catch(e) { process.exit(2); }
  " "$PROJECT_DIR/.caws/worktrees.json" "$SESSION_ID" 2>/dev/null && printf x0 || printf 'x%s' "$?")"
  [[ "${REMINDER##*x}" == 0 ]] || stop_activity_unavailable worktrees-registry
  REMINDER="${REMINDER%x*}"
  # Remove the reader's one record delimiter, retaining any data bytes.
  [[ "$REMINDER" == *$'\n' ]] || stop_activity_unavailable worktrees-registry
  REMINDER="${REMINDER%$'\n'}"
  [[ -n "$REMINDER" ]] && printf '%s\n' "$REMINDER" >&2
  exit 0
fi

exit 0
