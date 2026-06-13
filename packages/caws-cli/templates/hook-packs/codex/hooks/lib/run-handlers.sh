#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: codex
# hook_pack_version: 7
# caws_min_major: 11
# lineage_refs: 8,16
# do_not_edit_directly: update via `caws init --agent-surface codex`
# Codex handler-dispatch loop (codex override).
#
# This file overrides the shared lib/run-handlers.sh for the codex surface. It
# is sourced by caws_source_lib (defined in shared/lib/agent-surface.sh) in
# preference to the shared default when:
#   $CAWS_PROJECT_DIR/$CAWS_VENDOR_DIR/hooks/lib/run-handlers.sh
# exists (i.e. .codex/hooks/lib/run-handlers.sh is present in the consumer repo).
#
# Codex-specific differences from the shared baseline:
#   1. _rh_stdout_priority recognizes "deny" as priority-3 (same as "block"),
#      since Codex uses "deny" where Claude Code uses "ask". Both cause
#      immediate short-circuit and return 2.
#   2. Dry-run env var name: accepts CODEX_HOOK_DRY_RUN in addition to
#      CAWS_HOOK_DRY_RUN (back-compat for existing codex consumer configs).
#   3. Timing env var name: accepts CODEX_HOOK_TIMING in addition to
#      CAWS_HOOK_TIMING (back-compat).
#
# The shared version accepts CAWS_HOOK_DRY_RUN / CAWS_HOOK_TIMING and also
# CLAUDE_HOOK_* legacy aliases. This override adds CODEX_HOOK_* as a third
# alias tier for codex consumers.
#
# Everything else (loop logic, stderr prefix, timing, handler resolution via
# HOOKS_DIR) is identical to the shared version.

if [[ -n "${_HOOK_RUN_HANDLERS_LOADED:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
_HOOK_RUN_HANDLERS_LOADED=1

# ---------------------------------------------------------------------------
# _rh_is_truthy <value>
# Returns 0 (true) when value is non-empty and not "0".
# ---------------------------------------------------------------------------
_rh_is_truthy() {
  local val="${1:-}"
  [[ -n "$val" && "$val" != "0" ]]
}

# ---------------------------------------------------------------------------
# _rh_ms_now
# Prints current Unix time in milliseconds (integer).
# Uses date +%s%N if available, falls back to python3.
# ---------------------------------------------------------------------------
_rh_ms_now() {
  local ns
  ns=$(date +%s%N 2>/dev/null)
  # macOS date does not support %N; it prints literally "%N"
  if [[ "$ns" == *%N* ]]; then
    python3 -c 'import time; print(int(time.time() * 1000))'
  else
    printf '%d\n' "$(( ns / 1000000 ))"
  fi
}

# Codex-specific: "deny" is treated as priority-3 (immediate block/short-circuit)
# since Codex uses "deny" in place of "ask" for permission decisions.
_rh_stdout_priority() {
  local payload="$1"
  local decision
  decision=$(printf '%s' "$payload" | jq -r '.decision // .hookSpecificOutput.permissionDecision // ""' 2>/dev/null || true)
  case "$decision" in
    deny) printf '3\n' ;;
    block) printf '3\n' ;;
    ask) printf '2\n' ;;
    *) printf '1\n' ;;
  esac
}

# ---------------------------------------------------------------------------
# run_handlers [--short-circuit-on-block] <handler-entry>...
# ---------------------------------------------------------------------------
run_handlers() {
  local short_circuit=0
  if [[ "${1:-}" == "--short-circuit-on-block" ]]; then
    short_circuit=1
    shift
  fi

  # Ensure the input is parsed and HOOK_INPUT_JSON is available.
  # parse-input.sh is idempotent (guarded by _HOOK_PARSE_INPUT_LOADED).
  if [[ -z "${HOOK_INPUT_JSON:-}" ]]; then
    # HOOKS_DIR must be set by the caller (dispatcher boilerplate).
    # Use caws_source_lib if available (function defined in agent-surface.sh),
    # otherwise fall back to direct path.
    if command -v caws_source_lib >/dev/null 2>&1; then
      caws_source_lib parse-input.sh 2>/dev/null || return 0
    else
      # shellcheck source=parse-input.sh
      source "${HOOKS_DIR}/lib/parse-input.sh" 2>/dev/null || return 0
    fi
    parse_hook_input || return 0
  fi

  # Accept surface-neutral (CAWS_HOOK_*), legacy Claude (CLAUDE_HOOK_*),
  # and Codex-specific (CODEX_HOOK_*) env var names for dry-run / timing.
  local dry_run=0
  _rh_is_truthy "${CAWS_HOOK_DRY_RUN:-${CLAUDE_HOOK_DRY_RUN:-${CODEX_HOOK_DRY_RUN:-}}}" && dry_run=1

  local timing=0
  _rh_is_truthy "${CAWS_HOOK_TIMING:-${CLAUDE_HOOK_TIMING:-${CODEX_HOOK_TIMING:-}}}" && timing=1

  local max_exit=0
  local last_stdout=""
  local last_stdout_priority=0

  # Snapshot the outer $@ into an array so `set --` inside the loop can safely
  # clobber positional params without breaking iteration. Using "$@" directly
  # with `for entry in "$@"` captures at loop start on modern bash, but this
  # is safer across shells and makes the intent explicit.
  local entries
  entries=("$@")

  local entry
  for entry in "${entries[@]}"; do
    # Split on whitespace: first token = script, rest = positional args.
    # shellcheck disable=SC2086
    set -- $entry
    local handler="$1"
    shift
    # "$@" now holds the handler's positional args (may be empty). Use it
    # directly rather than stashing into a local array -- bash 3.2 (macOS
    # default) has quirky ${arr[@]+"${arr[@]}"} expansion behavior for
    # empty arrays under set -u in certain command-substitution contexts.
    # "$@" has no such quirks: empty positional params under set -u is a
    # normal, non-error case.

    local handler_path="${HOOKS_DIR}/${handler}"
    if [[ ! -x "$handler_path" ]]; then
      continue
    fi

    local t_start=0
    if (( timing )); then
      t_start=$(_rh_ms_now)
    fi

    local stderr_file
    stderr_file=$(mktemp)
    local stdout_buf
    stdout_buf=$(printf '%s' "$HOOK_INPUT_JSON" \
                  | "$handler_path" "$@" 2>"$stderr_file")
    local exit_code=$?

    local t_elapsed=0
    if (( timing )); then
      local t_end
      t_end=$(_rh_ms_now)
      t_elapsed=$(( t_end - t_start ))
    fi

    # Re-emit handler stderr prefixed with handler name.
    if [[ -s "$stderr_file" ]]; then
      while IFS= read -r line; do
        printf '[%s] %s\n' "$handler" "$line" >&2
      done < "$stderr_file"
    fi
    rm -f "$stderr_file"

    # Timing annotation (after handler stderr so they don't interleave).
    if (( timing )); then
      printf '[timing] %s: %dms\n' "$handler" "$t_elapsed" >&2
    fi

    # Dry-run annotation for non-zero exits.
    if (( dry_run )) && (( exit_code != 0 )); then
      printf '[DRY-RUN] %s would have exited %d\n' "$handler" "$exit_code" >&2
      exit_code=0
    fi

    # Accumulate stdout. Structured block/deny/ask decisions outrank lower-priority
    # hook context so a later handler cannot accidentally erase a safety
    # boundary emitted by an earlier handler.
    if [[ -n "$stdout_buf" ]]; then
      local stdout_priority
      stdout_priority=$(_rh_stdout_priority "$stdout_buf")
      if [[ "$stdout_priority" -eq 3 ]]; then
        printf '%s\n' "$stdout_buf"
        return 2
      fi
      if [[ "$stdout_priority" -ge "$last_stdout_priority" ]]; then
        last_stdout="$stdout_buf"
        last_stdout_priority="$stdout_priority"
      fi
    fi

    # Short-circuit on blocking exit (exit 2), unless dry-run zeroed it.
    if (( short_circuit )) && [[ "$exit_code" -eq 2 ]]; then
      [[ -n "$last_stdout" ]] && printf '%s\n' "$last_stdout"
      return 2
    fi

    if [[ "$exit_code" -gt "$max_exit" ]]; then
      max_exit="$exit_code"
    fi
  done

  [[ -n "$last_stdout" ]] && printf '%s\n' "$last_stdout"

  if (( dry_run )); then
    return 0
  fi
  return "$max_exit"
}
