#!/bin/bash
# CAWS machine adapter runtime. Project policy supplies ordered handler entries;
# executable adapter libraries come from one immutable machine snapshot.
set -uo pipefail
RUNTIME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export CAWS_SHARED_LIB_DIR="$RUNTIME_DIR/lib"
export CAWS_MACHINE_ADAPTER_LIB_DIR="$RUNTIME_DIR/surfaces/$1/lib"
export CAWS_MACHINE_RUNTIME=1
export CAWS_AGENT_SURFACE="$1"
EVENT="$2"
HOOKS_DIR="$3"
shift 3
export HOOKS_DIR

missing() {
  echo "[caws machine adapter] Required runtime library failed: $1" >&2
  exit 2
}
source "$RUNTIME_DIR/runtime-paths.sh" || missing runtime-paths.sh
source "$RUNTIME_DIR/lib/agent-surface.sh" || missing agent-surface.sh
caws_source_lib parse-input.sh || missing parse-input.sh
parse_hook_input || missing input
caws_source_lib session-id.sh || missing session-id.sh
caws_normalize_session_env "$(resolve_caws_session_id_with_payload "${HOOK_SESSION_ID:-}")" >/dev/null || missing session-id
caws_source_lib run-handlers.sh || missing run-handlers.sh
export CAWS_PRIOR_BASH_ENV="${BASH_ENV:-}"
export BASH_ENV="$RUNTIME_DIR/handler-env.sh"
[[ "$#" -gt 0 ]] || exit 0
if [[ "$EVENT" == pre_tool_use ]]; then
  run_handlers --short-circuit-on-block "$@"
else
  # Preserve the legacy PostToolUse dispatcher's runtime-only disable list.
  # Policy retains the declared list, so removing an environment override can
  # re-enable a handler without another adoption or a policy rewrite.
  if [[ "$EVENT" == post_tool_use ]]; then
    HANDLERS=()
    for handler in "$@"; do
      case ":${CAWS_DISABLED_HANDLERS:-}:" in
        *":${handler%% *}:"*) ;;
        *) HANDLERS+=("$handler") ;;
      esac
    done
    [[ "${#HANDLERS[@]}" -gt 0 ]] || exit 0
    run_handlers "${HANDLERS[@]}"
  else
    run_handlers "$@"
  fi
fi
