#!/bin/sh
# Native-created per-request Git view; no ambient config or source Git execution.
: "${CAWS_SERVICE_GIT_DIRECTORY:?missing admitted Git view}"
: "${CAWS_SERVICE_GIT_WORK_TREE:?missing admitted Git work tree}"
: "${CAWS_SERVICE_GIT_COMMON_DIRECTORY:?missing admitted common-directory data}"
: "${CAWS_SERVICE_GIT_ORIGINAL_DIRECTORY:?missing admitted original-directory data}"
if [ "$#" -eq 2 ] && [ "$1" = rev-parse ]; then
  case "$2" in
    --git-common-dir) printf '%s\n' "$CAWS_SERVICE_GIT_COMMON_DIRECTORY"; exit 0 ;;
    --git-dir) printf '%s\n' "$CAWS_SERVICE_GIT_ORIGINAL_DIRECTORY"; exit 0 ;;
  esac
fi
case "${1:-}" in
  rev-parse|status|log|diff) ;;
  *) printf '[caws service image] Unsupported Git verb\n' >&2; exit 75 ;;
esac
for arg do
  case "$arg" in
    -c*|-C*|--git-dir*|--work-tree*|--config-env*|--exec-path*|--namespace*|--super-prefix*)
      printf '[caws service image] Unsupported Git routing argument\n' >&2; exit 75 ;;
  esac
done
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null
export GIT_ATTR_NOSYSTEM=1 GIT_CONFIG_COUNT=0 GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0
exec __CAWS_IMAGE_TOOL_PATH__ --no-pager --git-dir="$CAWS_SERVICE_GIT_DIRECTORY" --work-tree="$CAWS_SERVICE_GIT_WORK_TREE" "$@"
