#!/bin/bash
# Native-owned adapter for the reviewed Codex Stop image. Legacy ownerless
# pending lists are diagnosed by the helper and never assigned to this caller.
set -uo pipefail
caws_source_lib parse-input.sh || exit 2
parse_hook_input || exit 2
[[ -n "${HOOK_TRANSCRIPT_PATH:-}" && -f "$HOOK_TRANSCRIPT_PATH" ]] || exit 0
[[ -n "${HOOK_SESSION_ID:-}" && "$HOOK_SESSION_ID" != unknown ]] || exit 2
jq -nc --arg project __CAWS_IMAGE_PLAN_PROJECT__ \
  --arg session "$HOOK_SESSION_ID" --arg transcript "$HOOK_TRANSCRIPT_PATH" \
  '{canonicalProject:$project,surface:"codex",sessionId:$session,transcriptPath:$transcript,action:{kind:"finalize"}}' |
  __CAWS_IMAGE_PLAN_NATIVE__ plan-snapshots --home __CAWS_IMAGE_PLAN_HOME__ \
    --checkout "${CAWS_SERVICE_GIT_WORK_TREE:?}" --legacy-user-home "${HOME:-}" >/dev/null
