#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: shared
# hook_pack_version: 1
# caws_min_major: 11
# lineage_refs: (new — CAWS-GUARD-REPRIEVE-SESSION-SCOPED-001)
# edit_stance: YOURS TO EDIT. This is a starting hook, not a locked one — shape it
#   to your repo: tune thresholds, add checks, remove what does not fit. Your edits
#   are preserved: caws init treats a changed hook as intended growth and will not
#   clobber it — it shows a diff and asks (--adopt keeps yours; --overwrite --force
#   takes the upstream template). The CAWS-MANAGED-HOOK marker above is only how caws
#   init finds hooks it can offer updates for; it is NOT a keep-out sign. CAWS owns the
#   failure-class invariant (the why/what a guard protects); you own the how. The one
#   edit to avoid: gutting a guard to dodge a block instead of fixing the cause. Grow
#   everything else freely.
# Session-scoped guard reprieve consult (CAWS-GUARD-REPRIEVE-SESSION-SCOPED-001).
#
# A reprieve is a governed, per-session, expiring, machine-checkable way to SKIP a
# PreToolUse guard for exactly one agent session. It replaces the anti-pattern of
# commenting a guard out of the dispatcher's HANDLERS array (which disables it for
# EVERY agent, forever, with no reason/approver/expiry).
#
# Machine records live at ${CAWS_HOME:-$HOME/.caws}/state/sessions/<id>/
# guard-reprieve-<id>.json. Global presence shadows legacy project records,
# including malformed, expired and revoked records. Reads never create state.
# A missing global record may be read from the canonical project's vendor
# hooks/state directory for one-time migration compatibility. Grant writes only
# the machine store; revoke writes a global tombstone so fallback cannot revive
# an older grant. Neither state location confers project ownership.
# IDEMPOTENT: safe to source multiple times.

if [[ -n "${_CAWS_REPRIEVE_SH_LOADED:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
_CAWS_REPRIEVE_SH_LOADED=1

# Resolve the machine session directory without creating it.
caws_reprieve_state_dir() {
  local _sid="${1:-${CAWS_SESSION_ID:-${HOOK_SESSION_ID:-}}}"
  [[ -n "$_sid" && "$_sid" != "unknown" ]] || return 1
  local _safe_sid
  _safe_sid=$(printf '%s' "$_sid" | tr -c 'A-Za-z0-9._-' '_')
  printf '%s/state/sessions/%s\n' "${CAWS_HOME:-${HOME:-}/.caws}" "$_safe_sid"
}

_caws_legacy_reprieve_state_dir() {
  # CAWS-LATCH-CANONICAL-STATE-DIR-001: delegate to the shared canonical-root
  # walk in lib/caws-state.sh (caws_canonical_state_dir) instead of inlining an
  # equivalent walk here. The helper reproduces this function's exact semantics
  # (git-common-dir -> canonical root, relative-common resolved absolute via
  # pwd -P, no .caws/ requirement, fail-open to the start dir). Falls back to
  # the inline walk if the helper is unavailable (caws-state.sh not yet sourced
  # in this shell) so reprieve never depends on source order.
  local state_dir
  if declare -F caws_canonical_state_dir >/dev/null 2>&1; then
    state_dir="$(caws_canonical_state_dir "${CAWS_PROJECT_DIR:-.}" "${CAWS_VENDOR_DIR:-.claude}")"
  else
    # Inline fallback identical to the pre-refactor walk (and to the helper).
    local project_dir="${CAWS_PROJECT_DIR:-.}"
    local common
    common="$(cd "$project_dir" 2>/dev/null && git rev-parse --git-common-dir 2>/dev/null)" || common=""
    if [[ -n "$common" ]]; then
      case "$common" in
        /*) : ;;
        *)  common="$project_dir/$common" ;;
      esac
      local canon_root
      canon_root="$(cd "$common/.." 2>/dev/null && pwd -P)" || canon_root=""
      if [[ -n "$canon_root" ]]; then
        project_dir="$canon_root"
      fi
    fi
    state_dir="$project_dir/${CAWS_VENDOR_DIR:-.claude}/hooks/state"
  fi
  printf '%s\n' "$state_dir"
}

# Filename for a session's reprieve record. Uses the shared sanitize_session
# (lib/caws-state.sh) with an inline fallback identical to block-dangerous's
# _danger_safe_session, so writer/reader share one transform.
caws_reprieve_file() {
  local session_id="${1:-}"
  local safe_session
  if command -v sanitize_session >/dev/null 2>&1; then
    safe_session="$(sanitize_session "$session_id")"
  else
    safe_session="$(printf '%s' "$session_id" | tr -c 'A-Za-z0-9._-' '_')"
  fi
  local global_file="$(caws_reprieve_state_dir "$session_id")/guard-reprieve-${safe_session}.json"
  # Presence is decisive: expired, revoked or malformed global records must
  # never resurrect a still-active legacy copy through fallback.
  if [[ -e "$global_file" || -L "$global_file" ]]; then
    printf '%s\n' "$global_file"
  else
    local legacy_file="$(_caws_legacy_reprieve_state_dir)/guard-reprieve-${safe_session}.json"
    if [[ -e "$legacy_file" || -L "$legacy_file" ]]; then
      printf '%s\n' "$legacy_file"
    else
      printf '%s\n' "$global_file"
    fi
  fi
}

# caws_is_handler_reprieved <handler-basename> [<session-id>]
#
# Returns 0 (true) if the named handler should be SKIPPED for the given session
# because of an active (non-expired) reprieve that names it in its `handlers`
# array. Returns 1 (false) otherwise — including: no reprieve file, expired,
# malformed, the handler not in the array, or the session id is "unknown".
#
# The session id defaults to the resolved operating identity
# (resolve_caws_session_id_with_payload), so the dispatcher can call this with
# just the handler basename and get the boundary-crossing identity for free.
#
# Sets the globals CAWS_REPRIEVE_SESSION_ID / CAWS_REPRIEVE_EXPIRES_AT /
# CAWS_REPRIEVE_REASON on a positive match so the caller can log WHY the skip
# happened (the spec's observability invariant — a silent skip is forbidden).
caws_is_handler_reprieved() {
  local handler="$1"
  local session_id="${2:-}"
  # Reset caller-facing globals on every call so a stale match can't bleed.
  CAWS_REPRIEVE_SESSION_ID=""
  CAWS_REPRIEVE_EXPIRES_AT=""
  CAWS_REPRIEVE_REASON=""

  # Resolve the session id if the caller didn't pass one explicitly. Best-effort:
  # if session-id.sh isn't sourced, fall back to HOOK_SESSION_ID, then "unknown".
  if [[ -z "$session_id" || "$session_id" == "unknown" ]]; then
    if declare -F resolve_caws_session_id_with_payload >/dev/null 2>&1; then
      session_id="$(resolve_caws_session_id_with_payload "${HOOK_SESSION_ID:-}")"
    else
      session_id="${HOOK_SESSION_ID:-unknown}"
    fi
  fi
  # Never admit a reprieve for an unresolved ("unknown") session — that would
  # alias every broken-context invocation into one shared skip.
  if [[ -z "$session_id" || "$session_id" == "unknown" ]]; then
    return 1
  fi

  local reprieve_file
  reprieve_file="$(caws_reprieve_file "$session_id")"
  if [[ ! -f "$reprieve_file" ]]; then
    return 1
  fi

  # Read + expiry-check + handler-match in ONE python call (the hook pack's
  # established JSON tool — mirrors parse-input.sh / block-dangerous.sh usage).
  # Emits "ADMIT <expires_at> <reason>" on a positive match, nothing otherwise.
  # A malformed or unreadable file is treated as no-reprieve (fail-open, like
  # the latch reader — never block a tool call because the reprieve cache broke).
  local verdict
  verdict="$(python3 -c '
import json, sys, os
try:
    from pathlib import Path
    record_path = Path(sys.argv[1])
    if any(p.is_symlink() for p in [record_path, *list(record_path.parents)[:4]]):
        sys.exit(1)
    with open(sys.argv[1]) as f:
        rec = json.load(f)
except Exception:
    sys.exit(1)
if not isinstance(rec, dict) or rec.get("session_id") != sys.argv[3] or "revoked_at" in rec:
    sys.exit(1)
if any(not isinstance(rec.get(k), str) or not rec[k] for k in ("created_at", "approved_by", "reason")):
    sys.exit(1)
expires_at = rec.get("expires_at")
if not isinstance(expires_at, str) or not expires_at:
    sys.exit(1)
# Derived expiry. CAWS-GUARD-REPRIEVE-NAIVE-EXPIRY-001: a user may pass a
# timezone-less --expires-at (e.g. "2026-07-19T04:00:00"); the writer is
# supposed to reject those, but the reader must be robust to legacy/inert
# files already on disk. Assume UTC for a naive datetime (the only sane
# default for a tool whose now=UTC) so the compare does not TypeError on
# naive-vs-aware -- which would silently disable the reprieve with no error
# surfaced (the worst failure class: reports success while doing nothing).
# A past expiry means absent. Never mutate the file on read.
import datetime
try:
    exp = datetime.datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
except Exception:
    sys.exit(1)
if exp.tzinfo is None:
    exp = exp.replace(tzinfo=datetime.timezone.utc)
now = datetime.datetime.now(datetime.timezone.utc)
if exp <= now:
    sys.exit(1)
handlers = rec.get("handlers")
if not isinstance(handlers, list) or any(not isinstance(h, str) for h in handlers):
    sys.exit(1)
target = sys.argv[2]
if target not in handlers:
    sys.exit(1)
# Positive match. Emit expires_at + reason for the caller to log.
reason = rec.get("reason", "")
print("ADMIT\t" + expires_at + "\t" + str(reason))
' "$reprieve_file" "$handler" "$session_id" 2>/dev/null)" || return 1

  if [[ "$verdict" == ADMIT* ]]; then
    # Parse the tab-delimited ADMIT line into the caller-facing globals.
    local _exp _reason
    _exp="$(printf '%s' "$verdict" | cut -f2)"
    _reason="$(printf '%s' "$verdict" | cut -f3-)"
    CAWS_REPRIEVE_SESSION_ID="$session_id"
    CAWS_REPRIEVE_EXPIRES_AT="$_exp"
    CAWS_REPRIEVE_REASON="$_reason"
    return 0
  fi
  return 1
}
