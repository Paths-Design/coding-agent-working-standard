# Named CAWS immutable-image adapter for the directly sourced Sterling client.
# The builder replaces both markers with quoted, pinned absolute literals.
# Returning nonzero here would invoke Sterling's inline renderer. Failures must
# leave the whole selected handler; this library never starts or reaps a daemon.
slrd_try_render() {
  if [[ "$#" -ne 14 ]]; then
    printf '%s\n' 'CAWS session render service unavailable' >&2
    exit 75
  fi
  local caws_session_render_status=0
  __CAWS_SERVICE_CLIENT_NODE__ __CAWS_SERVICE_CLIENT_ENTRY__ "$@" || caws_session_render_status=$?
  # Drop this selected shell's duplicates as well as the Node child's copies.
  exec 3>&- 4<&- 5>&-
  if [[ "$caws_session_render_status" -eq 0 ]]; then
    return 0
  fi
  exit 75
}
slrd_spawn() {
  printf '%s\n' 'CAWS session render service unavailable' >&2
  exit 75
}
