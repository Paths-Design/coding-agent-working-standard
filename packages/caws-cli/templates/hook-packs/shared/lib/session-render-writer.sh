# CAWS-MANAGED-HOOK
# hook_pack: shared
# hook_pack_version: 1
# caws_min_major: 11
# edit_stance: YOURS TO EDIT. CAWS uses this discovery marker to preserve local
#   growth and offer reviewed updates; it does not authorize bypassing guards.
# Cooperative renderer launch boundary. Source adoption must cover every writer,
# including daemon and one-shot entry points; installing this file alone does
# not stop an already running or unmodified foreign renderer.
#
# The native owner derives the stable canonical-project/output/session key and
# holds it across child exit, drained output and uncertain cleanup. Generation
# identifies the requested bytes but must never partition writer exclusion.
caws_session_render_writer() {
  if [[ "$#" -ne 15 ]]; then
    printf '%s\n' 'CAWS render writer unavailable: expected project, interpreter, renderer and twelve fields' >&2
    return 75
  fi
  local project="$1" interpreter="$2" renderer="$3"
  shift 3
  local native="${CAWS_RENDER_WRITER_NATIVE:-}" generation="${CAWS_RENDER_WRITER_GENERATION:-}"
  local timeout="${CAWS_RENDER_WRITER_TIMEOUT_MS:-30000}"
  if [[ "$native" != /* || ! -x "$native" || "${CAWS_HOME:-}" != /* \
     || "$project" != /* || "$interpreter" != /* || "$renderer" != /* \
     || ! "$generation" =~ ^[a-f0-9]{64}$ || ! "$timeout" =~ ^[0-9]+$ ]]; then
    printf '%s\n' 'CAWS render writer unavailable: explicit native custody configuration required' >&2
    return 75
  fi
  # Arguments are individual argv entries. No eval, shell command string,
  # daemon lease, PID-liveness check or response error grants a fallback.
  "$native" render-writer --home "$CAWS_HOME" --canonical-project "$project" \
    --output-directory "$1" --session-id "$3" --source-generation "$generation" \
    --timeout-ms "$timeout" -- "$interpreter" -I -S -B "$renderer" "$@"
}

# Successor for Sterling's directly sourced daemon client. All rendering goes
# through the native-owned one-shot boundary; failure leaves the selected hook
# instead of returning nonzero into the legacy unfenced inline fallback.
slrd_try_render() {
  if [[ "$#" -ne 14 || -z "${CAWS_ROOT:-}" || -z "${CAWS_RENDER_WRITER_PYTHON:-}" ]]; then
    printf '%s\n' 'CAWS render writer unavailable: adopted client configuration required' >&2
    exit 75
  fi
  local hooks="$1"
  shift 2
  local status=0
  caws_session_render_writer "$CAWS_ROOT" "$CAWS_RENDER_WRITER_PYTHON" \
    "$hooks/session_log_renderer.py" "$@" || status=$?
  [[ "$status" -eq 0 ]] || exit 75
  return 0
}

slrd_spawn() {
  printf '%s\n' 'CAWS render writer unavailable: unmanaged daemon startup refused' >&2
  exit 75
}
