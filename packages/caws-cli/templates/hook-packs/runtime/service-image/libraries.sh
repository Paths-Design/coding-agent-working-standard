# Closed generated source table; no live project, user or runtime tier fallback.
caws_source_lib() {
  case "${1:-}" in
__CAWS_IMAGE_LIBRARY_CASES__
    *) printf '[caws service image] Undeclared library\n' >&2; return 2 ;;
  esac
}
