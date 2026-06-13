#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: shared
# hook_pack_version: 1
# caws_min_major: 11
# lineage_refs: 19,27
# do_not_edit_directly: update via `caws init`
#
# PreCompact dispatcher — shared core (surface-neutral).
#
# Some agent harnesses support a PreCompact event (e.g. Codex). The CAWS
# shared pack uses it as a lightweight lifecycle checkpoint: it refreshes
# the session lease and records a session-log entry, but does not block
# compaction.
#
# Claude Code routes PreCompact through a direct session-log.sh invocation
# in its settings.json (not through this dispatcher). When the vendor wiring
# moves to the shared dispatcher, both surfaces will use this file.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"

# Resolve surface-specific env (CAWS_VENDOR_DIR, CAWS_LOG_DIR, etc.)
# shellcheck source=../lib/agent-surface.sh
source "$HOOKS_DIR/lib/agent-surface.sh" 2>/dev/null || true

source "$HOOKS_DIR/lib/parse-input.sh" 2>/dev/null || exit 0
parse_hook_input || exit 0

source "$HOOKS_DIR/lib/run-handlers.sh" 2>/dev/null || exit 0

HANDLERS=(
  agent-heartbeat.sh
  "session-log.sh pre-compact"
)

run_handlers "${HANDLERS[@]}"
