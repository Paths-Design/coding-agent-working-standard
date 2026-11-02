#!/bin/bash
# Closed service image dispatcher. Original policy paths remain logical data.
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
  echo "[caws service image] Required runtime library failed: $1" >&2
  exit 2
}
source "$RUNTIME_DIR/runtime-paths.sh" || missing runtime-paths.sh
source "$RUNTIME_DIR/lib/agent-surface.sh" || missing agent-surface.sh
source __CAWS_IMAGE_RESOLVER__ || missing sealed-libraries.sh
caws_source_lib parse-input.sh || missing parse-input.sh
parse_hook_input || missing input
caws_source_lib session-id.sh || missing session-id.sh
caws_normalize_session_env "$(resolve_caws_session_id_with_payload "${HOOK_SESSION_ID:-}")" >/dev/null || missing session-id
caws_source_lib run-handlers.sh || missing run-handlers.sh
unset CAWS_PRIOR_BASH_ENV
export BASH_ENV="$RUNTIME_DIR/handler-env.sh"
[[ "$#" -gt 0 ]] || exit 0
[[ "$EVENT" == stop && "$CAWS_AGENT_SURFACE" == codex ]] || exit 2
run_handlers "$@"
