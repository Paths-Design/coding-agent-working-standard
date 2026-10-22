#!/bin/bash
# Only the image resolver may select libraries in this profile.
[[ -z "${CAWS_PRIOR_BASH_ENV:-}" ]] || exit 2
source "${CAWS_SHARED_LIB_DIR}/agent-surface.sh" || exit 2
source __CAWS_IMAGE_RESOLVER__ || exit 2
caws_source_lib parse-input.sh || exit 2
caws_source_lib session-id.sh || exit 2
caws_source_lib emit.sh || exit 2
