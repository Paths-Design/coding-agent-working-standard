#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: qwen-code
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
#
# qwen-code parse-input override — tool-name normalization (codex precedent:
# the codex adapter overrides this same lib to normalize apply_patch ->
# Edit/Write).
#
# WHY THIS EXISTS. Every shared guard self-filters on the CANONICAL harness
# tool names in a `case "$HOOK_TOOL_NAME"` arm (Write|Edit for the file
# guards, Bash for the shell guards, ExitPlanMode for the plan-transcript
# pair). Qwen Code payloads carry the RUNTIME tool ids instead (verified live
# on 0.21.4 — tmp/qwen-hook-probe-findings.md):
#
#   write_file, edit, run_shell_command, read_file, glob, grep_search,
#   notebook_edit, exit_plan_mode
#
# Without normalization every guard's self-filter misses and the whole chain
# silently no-ops on qwen tool calls. This override wraps the shared parser
# (single copy of the parsing logic — no fork to drift) and rewrites
# HOOK_TOOL_NAME to the canonical name after parsing, keeping the raw qwen id
# in HOOK_ORIGINAL_TOOL_NAME for audit payloads.
#
# FAIL-OPEN: if the shared parser cannot be located, parse_hook_input degrades
# to a no-op — guards then self-filter to no-match, matching the shared
# fail-open posture for parse failures.
#
# IDEMPOTENT: safe to source multiple times.

if [[ -n "${_CAWS_QWEN_PARSE_INPUT_LOADED:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
_CAWS_QWEN_PARSE_INPUT_LOADED=1

# Locate the shared lib. Dispatchers export CAWS_SHARED_LIB_DIR before
# caws_source_lib loads this file; the fallback covers handlers that source
# libs directly with only CAWS_PROJECT_DIR set.
_caws_qwen_shared_lib="${CAWS_SHARED_LIB_DIR:-}"
if [[ -z "$_caws_qwen_shared_lib" && -n "${CAWS_PROJECT_DIR:-}" && "${CAWS_PROJECT_DIR}" != "." ]]; then
  _caws_qwen_shared_lib="${CAWS_PROJECT_DIR}/.caws/hooks/lib"
fi

if [[ -z "$_caws_qwen_shared_lib" || ! -f "$_caws_qwen_shared_lib/parse-input.sh" ]]; then
  parse_hook_input() { return 0; }
  unset _caws_qwen_shared_lib
  return 0 2>/dev/null || exit 0
fi

# The shared file's own double-source guard (_HOOK_PARSE_INPUT_LOADED) makes
# this idempotent if the shared lib was already loaded by another path.
# shellcheck disable=SC1090
source "$_caws_qwen_shared_lib/parse-input.sh"
unset _caws_qwen_shared_lib

# Rename the shared implementation out of the way (declare -f line 1 is
# always "<name> ()"; the remainder is the body), then define the wrapping
# parse_hook_input under the canonical name the dispatchers call.
eval "_caws_qwen_parse_hook_input_base() $(declare -f parse_hook_input | tail -n +2)"

# Qwen runtime tool id -> canonical harness tool name. Unknown ids pass
# through unchanged (guards self-filter to no-match — fail-open).
_caws_qwen_normalize_tool_name() {
  case "${HOOK_TOOL_NAME:-}" in
    write_file)      HOOK_TOOL_NAME="Write" ;;
    edit)            HOOK_TOOL_NAME="Edit" ;;
    run_shell_command) HOOK_TOOL_NAME="Bash" ;;
    read_file)       HOOK_TOOL_NAME="Read" ;;
    glob)            HOOK_TOOL_NAME="Glob" ;;
    grep_search)     HOOK_TOOL_NAME="Grep" ;;
    notebook_edit)   HOOK_TOOL_NAME="NotebookEdit" ;;
    exit_plan_mode)  HOOK_TOOL_NAME="ExitPlanMode" ;;
    *) return 0 ;;
  esac
  export HOOK_TOOL_NAME
}

parse_hook_input() {
  _caws_qwen_parse_hook_input_base "$@" || return $?
  # Preserve the raw qwen runtime id for audit before normalizing.
  HOOK_ORIGINAL_TOOL_NAME="${HOOK_TOOL_NAME:-}"
  export HOOK_ORIGINAL_TOOL_NAME
  _caws_qwen_normalize_tool_name
  return 0
}
