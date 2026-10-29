#!/bin/bash
# Preload the selected adapter in Bash handler children. Existing guard scripts
# can keep sourcing their local libraries: the shared idempotence flags preserve
# the selected parser, identity resolver and native emitters. Guard code and
# ownership oracles remain project-owned. This preload is adapter machinery,
# not an inherited startup fact for the command analyzer. Preserve presence as
# well as value: even an explicitly empty original BASH_ENV remains observable.
readonly _CAWS_HANDLER_PRIOR_BASH_ENV_SET="${CAWS_PRIOR_BASH_ENV_SET:-}"
readonly _CAWS_HANDLER_PRIOR_BASH_ENV="${CAWS_PRIOR_BASH_ENV-}"
if [[ "$_CAWS_HANDLER_PRIOR_BASH_ENV_SET" == x ]]; then
  export BASH_ENV="$_CAWS_HANDLER_PRIOR_BASH_ENV"
else
  unset BASH_ENV
fi
if [[ -n "${BASH_ENV:-}" && "$BASH_ENV" != "${BASH_SOURCE[0]}" ]]; then
  source "$BASH_ENV" || exit 2
fi
source "${CAWS_SHARED_LIB_DIR}/agent-surface.sh" || exit 2
caws_source_lib parse-input.sh || exit 2
caws_source_lib session-id.sh || exit 2
caws_source_lib emit.sh || exit 2
# Startup code may unset or rebind BASH_ENV. Analysis retains the unknown startup
# fact captured at dispatch entry; this is not a simulation of a user shell's
# environment after startup. Each separate handler still receives this preload
# from the dispatcher. Startup changes before dispatch entry are not recovered.
if [[ "$_CAWS_HANDLER_PRIOR_BASH_ENV_SET" == x ]]; then
  export BASH_ENV="$_CAWS_HANDLER_PRIOR_BASH_ENV"
else
  unset BASH_ENV
fi
