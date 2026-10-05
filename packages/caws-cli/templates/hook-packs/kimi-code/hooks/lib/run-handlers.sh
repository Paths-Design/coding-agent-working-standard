#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: kimi-code
# hook_pack_version: 1
# caws_min_major: 11
# lineage_refs: 8,16
# edit_stance: YOURS TO EDIT. This is a starting hook, not a locked one — shape it
#   to your repo: tune thresholds, add checks, remove what does not fit. Your edits
#   are preserved: caws init treats a changed hook as intended growth and will not
#   clobber it — it shows a diff and asks (--adopt keeps yours; --overwrite --force
#   takes the upstream template). The CAWS-MANAGED-HOOK marker above is only how caws
#   init finds hooks it can offer updates for; it is NOT a keep-out sign. CAWS owns the
#   failure-class invariant (the why/what a guard protects); you own the how. The one
#   edit to avoid: gutting a guard to dodge a block instead of fixing the cause. Grow
#   everything else freely.
# Surface compatibility entry: dispatch is implemented once in shared.
# The shared runner preserves deny priority, Codex diagnostic aliases, and
# Kimi exit-code promotion. A direct compatibility caller may have no bootstrap
# flags; selecting this vendor entry supplies the fallback surface explicitly.
export CAWS_AGENT_SURFACE="${CAWS_AGENT_SURFACE:-kimi-code}"
_caws_surface_runner_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_caws_shared_runner="${CAWS_SHARED_LIB_DIR:-${_caws_surface_runner_dir}/../../../.caws/hooks/lib}/run-handlers.sh"
if [[ ! -f "$_caws_shared_runner" ]]; then
  printf '[caws surface runner] required shared runner missing: %s\n' "$_caws_shared_runner" >&2
  return 2 2>/dev/null || exit 2
fi
source "$_caws_shared_runner"
