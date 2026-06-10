#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: codex
# hook_pack_version: 3
# caws_min_major: 11
# lineage_refs: 19,27
# do_not_edit_directly: update via `caws init --agent-surface codex`
#
# PreCompact dispatcher for Codex hooks.
#
# Codex supports a PreCompact event; the CAWS parity pack uses it as a
# lightweight lifecycle checkpoint. It refreshes the session lease and records
# a session-log entry, but does not block compaction.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"

source "$HOOKS_DIR/lib/parse-input.sh" 2>/dev/null || exit 0
parse_hook_input || exit 0

source "$HOOKS_DIR/lib/run-handlers.sh" 2>/dev/null || exit 0

HANDLERS=(
  agent-heartbeat.sh
  session-log.sh pre-compact
)

run_handlers "${HANDLERS[@]}"
