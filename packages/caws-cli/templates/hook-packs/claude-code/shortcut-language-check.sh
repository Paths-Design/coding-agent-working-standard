#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: claude-code
# hook_pack_version: 11
# caws_min_major: 11
# lineage_refs: 29
# do_not_edit_directly: update via `caws init --agent-surface claude-code`
#
# CAWS Shortcut-Language Progressive Check (QG-HOOKS-EXTRACT-001)
#
# PostToolUse hook firing on Write/Edit. Flags "shortcut" / incomplete-work
# language in committed-bound source — the edit-time analogue of the
# quality-gates `todo_detection` gate
# (packages/quality-gates/todo-analyzer.mjs + check-placeholders.mjs). It
# re-implements the practical intent in self-contained bash: catch the agent
# leaving a TODO/FIXME/placeholder/"not implemented" stub in a NON-test source
# file.
#
# Unlike the other three advisory hooks, this one escalates via the existing
# progressive-strike mechanism (guard-strikes.sh):
#   strike 1 -> warn (allow)
#   strike 2 -> ask  (permission prompt)
#   strike 3 -> block
# Rationale: TODO/placeholder language in committed code is the CLAUDE.md
# "No fake implementations" rule; repeated offenses in a session warrant
# escalation, matching how scope-guard treats repeated scope violations.
#
# Test files (*.test.* / *.spec.*) are NOT strike-eligible: TODO/placeholder
# language in tests is routine (describing pending cases, fixture stubs).
#
# Patterns (case-insensitive) — only the high-signal subset of the
# todo-analyzer engine, kept to single-file grep for hook-time speed:
#   \bTODO\b \bFIXME\b \bXXX\b \bHACK\b \bTBD\b
#   "not implemented" "implement later" "coming soon" "placeholder"
#   stub-return shapes: return null;? // TODO ; throw new Error("not implemented")
#
# env: none (strike count fixed at 3 via guard-strikes.sh).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/parse-input.sh
source "$SCRIPT_DIR/lib/parse-input.sh" 2>/dev/null || exit 0
parse_hook_input || exit 0
# shellcheck source=guard-strikes.sh
source "$SCRIPT_DIR/guard-strikes.sh" 2>/dev/null || exit 0

FILE_PATH="$HOOK_FILE_PATH"
TOOL_NAME="$HOOK_TOOL_NAME"

case "$TOOL_NAME" in
  Write | Edit) ;;
  *) exit 0 ;;
esac

[[ -z "$FILE_PATH" ]] && exit 0

# Skip generated / vendored / build output.
case "$FILE_PATH" in
  */node_modules/* | */dist/* | */build/* | */coverage/* | */.next/* | */out/* | */vendor/*)
    exit 0
    ;;
esac

# Skip non-source artifacts: markdown/docs and lockfiles routinely contain
# the word "placeholder"/"TODO" as prose. The hook targets code.
case "$(basename "$FILE_PATH")" in
  *.md | *.markdown | *.txt | *.lock | *-lock.json | package-lock.json | *.min.js | *.bundle.js | *.map)
    exit 0
    ;;
esac

# Test files are exempt from strikes (TODO/placeholder is routine in specs).
case "$FILE_PATH" in
  *.test.* | *.spec.* | */tests/* | */__tests__/* | */test/* | */fixtures/*)
    exit 0
    ;;
esac

# The content to scan: prefer the tool payload (works on untracked files and
# is exactly what the agent just wrote). Write -> .content; Edit -> .new_string.
CONTENT=""
if [[ -n "${HOOK_TOOL_INPUT_JSON:-}" ]] && command -v jq >/dev/null 2>&1; then
  CONTENT=$(printf '%s' "$HOOK_TOOL_INPUT_JSON" | jq -r '.content // .new_string // empty' 2>/dev/null || printf '')
fi
# Fallback: read the file from disk if the payload had no content field.
if [[ -z "$CONTENT" ]] && [[ -f "$FILE_PATH" ]]; then
  CONTENT=$(cat "$FILE_PATH" 2>/dev/null || printf '')
fi
[[ -z "$CONTENT" ]] && exit 0

# Match the high-signal patterns. grep -nE on the content via a here-string;
# -i case-insensitive. Word-boundary keywords first, then phrases, then
# stub-return shapes.
MATCH=""
PATTERN_DESC=""

# 1. Keyword markers (word-boundary).
if hit=$(printf '%s' "$CONTENT" | grep -nE '\b(TODO|FIXME|XXX|HACK|TBD)\b' 2>/dev/null | head -1); then
  if [[ -n "$hit" ]]; then
    MATCH="$hit"
    PATTERN_DESC="incomplete-work marker (TODO/FIXME/XXX/HACK/TBD)"
  fi
fi

# 2. Placeholder / not-implemented phrases.
if [[ -z "$MATCH" ]]; then
  if hit=$(printf '%s' "$CONTENT" | grep -niE 'not implemented|implement later|coming soon|placeholder' 2>/dev/null | head -1); then
    if [[ -n "$hit" ]]; then
      MATCH="$hit"
      PATTERN_DESC="placeholder / not-implemented language"
    fi
  fi
fi

# 3. Stub-return shapes (throw new Error("not implemented") is caught above;
#    catch the bare "return null; // TODO" combo and an explicit stub throw).
if [[ -z "$MATCH" ]]; then
  if hit=$(printf '%s' "$CONTENT" | grep -niE 'throw new Error\(["'"'"']not implemented' 2>/dev/null | head -1); then
    if [[ -n "$hit" ]]; then
      MATCH="$hit"
      PATTERN_DESC="explicit not-implemented stub throw"
    fi
  fi
fi

[[ -z "$MATCH" ]] && exit 0

# Trim the matched line for the message (strip leading whitespace, cap length).
LINE_TEXT=$(printf '%s' "$MATCH" | sed 's/^[0-9]*://; s/^[[:space:]]*//' | cut -c1-120)

BASE="Shortcut-language advisory in ${FILE_PATH}: ${PATTERN_DESC} — \"${LINE_TEXT}\". CAWS doctrine (\"No fake implementations\") asks for complete code in committed source, not TODO/placeholder stubs."
MSG1="${BASE} (strike 1 of 3 — advisory.)"
MSG2="${BASE} (strike 2 of 3 — please resolve before continuing.)"
MSG3="${BASE} (strike 3 — blocked. Replace the placeholder/stub with a real implementation, or move the work to a tracked spec.)"

guard_enforce_progressive_strikes \
  "${HOOK_SESSION_ID:-unknown}" \
  "shortcut_language" \
  "${HOOK_CWD:-}" \
  "$MSG1" "$MSG2" "$MSG3"

# guard_enforce_progressive_strikes emits the decision JSON. For strikes 1/2
# it is an allow/ask (exit 0). For strike 3 it emits a block decision; exit 0
# is correct for PostToolUse (the tool already ran) — the block decision in
# the JSON is what Claude Code honors.
exit 0
