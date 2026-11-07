#!/bin/bash
# Preload the selected adapter in Bash handler children. Existing guard scripts
# can keep sourcing their local libraries: the shared idempotence flags preserve
# the selected parser, identity resolver and native emitters. Guard code and
# ownership oracles remain project-owned. Preserve an existing Bash startup file.
if [[ -n "${CAWS_PRIOR_BASH_ENV:-}" && "${CAWS_PRIOR_BASH_ENV}" != "${BASH_ENV:-}" ]]; then
  source "$CAWS_PRIOR_BASH_ENV" || exit 2
fi
source "${CAWS_SHARED_LIB_DIR}/agent-surface.sh" || exit 2
caws_source_lib parse-input.sh || exit 2
caws_source_lib session-id.sh || exit 2
caws_source_lib emit.sh || exit 2
