#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: shared
# hook_pack_version: 1
# caws_min_major: 11
# lineage_refs: 29
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
# CAWS Shortcut-Language Progressive Check (QG-HOOKS-EXTRACT-001)
#
# PostToolUse hook firing on Write/Edit. Flags "shortcut" / incomplete-work
# language in committed-bound source — the edit-time analogue of the
# quality-gates `todo_detection` gate.
# Shortcut/placeholder quality signal: re-implements the practical intent in
# self-contained bash: catch the agent
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
# Patterns — only the high-signal subset of the todo-analyzer engine, kept to
# one awk pass plus grep for hook-time speed. Shortcut language is prose, and
# several marker words are also ordinary vocabulary in UI code ("placeholder"
# is an HTML attribute, an RN prop and a CSS pseudo-element; "todo" names
# things; "XXX-XXX-XXXX" is an input mask). So each pattern is scoped to where
# it is unambiguous:
#   an Error thrown with a not-implemented message   anywhere
#   TODO FIXME XXX HACK TBD (any case)               comment text only
#   TODO FIXME HACK TBD (uppercase)                  anywhere — a "TODO" string value
#   "not implemented" "implement later" "coming soon"   anywhere
#   placeholder beside a stub cue                    comment text only (see below)
# (CAWS-DEFECT-SHORTCUT-LANG-DOMAIN-VOCABULARY-FP-01; the earlier token-only
# narrowing was CAWS-SHORTCUT-LANG-PLACEHOLDER-TOKEN-FALSE-POSITIVE-002.)
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
# An Edit payload is a fragment, so its line numbers count from the fragment's
# first line, not the file's.
CONTENT=""
CONTENT_IS_FRAGMENT=0
if [[ -n "${HOOK_TOOL_INPUT_JSON:-}" ]] && command -v jq >/dev/null 2>&1; then
  CONTENT=$(printf '%s' "$HOOK_TOOL_INPUT_JSON" | jq -r '.content // .new_string // empty' 2>/dev/null || printf '')
  if [[ -n "$CONTENT" && "$TOOL_NAME" == Edit ]]; then
    CONTENT_IS_FRAGMENT=1
  fi
fi
# Fallback: read the file from disk if the payload had no content field.
if [[ -z "$CONTENT" ]] && [[ -f "$FILE_PATH" ]]; then
  CONTENT=$(cat "$FILE_PATH" 2>/dev/null || printf '')
fi
[[ -z "$CONTENT" ]] && exit 0

# Every candidate is a record "<line-no>\t<kind>\t<text>". CODE_RECORDS are the
# whole content lines (kind "code"). COMMENT_RECORDS carry only the text inside
# comments: kind "doc" for /** … */ blocks and leading-star fragments, "note"
# for every other comment.
TAB=$'\t'
CODE_RECORDS=$(printf '%s\n' "$CONTENT" | awk '{ print NR "\tcode\t" $0 }')

# A lexer-lite, not a parser. It tracks /* */ and <!-- --> across lines and
# takes the leftmost // /* <!-- # opener on each line. An opener must follow
# whitespace or one of { } ( ) ; , so "https://" and the "/*" inside a
# "src/*.ts" glob open nothing; "#" must be followed by whitespace or end of
# line (shell, Python, YAML — not CSS colours or #private fields). A line
# starting "-- " is a SQL/Lua comment, and a line starting "* " outside any
# block is a JSDoc fragment, which is what an Edit's new_string often is.
# An opener that sits inside a quoted literal that closes on the same line
# ("a // b", '# note: x') opens nothing: it is data, not a comment. A quote
# with no closing partner on the line is an ordinary character, so a stray
# apostrophe never hides a real comment that follows it.
_COMMENT_AWK='
function emit(k, text) { if (text ~ /[^ \t]/) print NR "\t" k "\t" text }
function mask(s,   n, i, j, k, c, d) {
  delete instr
  n = length(s); i = 1
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "\"" || c == "\047" || c == "`") {
      j = i + 1
      while (j <= n) {
        d = substr(s, j, 1)
        if (d == "\\") { j += 2; continue }
        if (d == c) break
        j++
      }
      if (j <= n) { for (k = i; k <= j; k++) instr[k] = 1; i = j + 1; continue }
    }
    i++
  }
}
{
  rest = " " $0
  base = 0
  if (inblock) delete instr; else mask(rest)
  if (!inblock) {
    if (rest ~ /^[ \t]*--[ \t]/) { emit("note", substr(rest, index(rest, "--") + 2)); next }
    if (rest ~ /^[ \t]*\*([ \t]|$)/) { emit("doc", substr(rest, index(rest, "*") + 1)); next }
  }
  while (rest != "") {
    if (inblock) {
      at = index(rest, closer)
      if (at == 0) { emit(kind, rest); next }
      emit(kind, substr(rest, 1, at - 1))
      base += at + length(closer) - 1
      rest = substr(rest, at + length(closer))
      inblock = 0
      continue
    }
    skip = 0
    while (1) {
      if (!match(substr(rest, skip + 1), /[ \t{}();,](\/\/|\/\*|<!--|#([ \t]|$))/)) next
      rs = skip + RSTART
      rl = RLENGTH
      if (!instr[base + rs + 1]) break
      skip = rs
    }
    opener = substr(rest, rs + 1, rl - 1)
    base += rs + rl - 1
    rest = substr(rest, rs + rl)
    if (opener == "//" || opener ~ /^#/) { emit("note", rest); next }
    closer = "*/"
    kind = "note"
    if (opener == "<!--") closer = "-->"
    else if (substr(rest, 1, 1) == "*" && substr(rest, 1, 2) != "*/") kind = "doc"
    inblock = 1
    delete instr
  }
}'
COMMENT_RECORDS=$(printf '%s\n' "$CONTENT" | awk "$_COMMENT_AWK" 2>/dev/null || true)

# Determiner / preposition words that, immediately before a keyword, mark it as
# a REFERENCED NOUN (a description of the concept) rather than an ACTIVE marker.
# Word-anchored, so a word that merely ends in one ("data TODO") stays active.
_REFERENCE_DETERMINERS='the|a|an|this|that|these|those|its|our|their|your|my|no|any|some|each|avoid|instead of|without|of|todo|fixme|xxx|hack|tbd'

# first_active RECORDS GREP_CASE_FLAG ERE — the first record holding ERE in
# ACTIVE (non-reference) position, or nothing. GREP_CASE_FLAG is -i, or -s to
# stay case-sensitive.
first_active() {
  printf '%s\n' "$1" \
    | grep "$2" -E "$3" 2>/dev/null \
    | grep -viE "\\b($_REFERENCE_DETERMINERS)[[:space:]]+($3)" 2>/dev/null \
    | head -1 || true
}

# Placeholder: comment text only, and only beside a stub cue. The word alone
# names the UI concept far more often than it marks a stub:
#   the comment is nothing but the word        // placeholder
#   a stub qualifier before it                 just a / temporary / this is a placeholder
#   a stub head word after it                  placeholder implementation / for now / until
#   a deferral cue elsewhere in the comment    // placeholder, fill in later
# The qualifier "is" counts only after a self-referential subject (this, it,
# that, which): "this is a placeholder" describes the code it sits in, while
# "the skeleton is a placeholder" describes a UI element. A bare "placeholder"
# in a /** doc comment */ is a prop description, not a stub. Joined forms
# (placeholder-shown, ::placeholder, aria-placeholder, placeholder_text,
# placeholderTextColor) never count. The reference-determiner layer is not
# applied here: "This is just a placeholder" is the clearest stub phrasing
# there is, and its "a" would suppress it.
_PH_WORD='(^|[^A-Za-z0-9_:-])placeholder([^A-Za-z0-9_-]|$)'
_PH_ALONE="^[0-9]+${TAB}note${TAB}[^A-Za-z0-9]*placeholder[^A-Za-z0-9]*\$"
_PH_QUALIFIED="\\b((this|it|that|which)('s|’s|[[:space:]]+is)|just|temporary|temp|tmp|stub|dummy|fake)[[:space:]]+((just|only|merely)[[:space:]]+)?(an?[[:space:]]+)?placeholder([^A-Za-z0-9_-]|\$)"
_PH_HEADED='(^|[^A-Za-z0-9_:-])placeholder[[:space:]]+(implementation|impl|logic|code|function|method|handler|body|stub|until|for now|pending)\b'
_PH_DEFERRAL='\b(for now|later|fill (it |this )?in|replace (this|it|me)|real implementation)\b'

placeholder_hit() {
  {
    printf '%s\n' "$COMMENT_RECORDS" | grep -iE "$_PH_ALONE|$_PH_QUALIFIED|$_PH_HEADED"
    printf '%s\n' "$COMMENT_RECORDS" | grep -iE "$_PH_WORD" | grep -iE "$_PH_DEFERRAL"
  } 2>/dev/null | sort -t "$TAB" -k1,1n | head -1 || true
}

# First match wins, most specific class first.
MATCH=""
PATTERN_DESC=""
take() {
  if [[ -z "$MATCH" && -n "$2" ]]; then
    MATCH="$2"
    PATTERN_DESC="$1"
  fi
}

take "explicit not-implemented stub throw" \
  "$(printf '%s\n' "$CODE_RECORDS" | grep -iE 'throw new Error\(["'"'"'`]not implemented' 2>/dev/null | head -1 || true)"
# The marker words are assembled from halves so this file never carries the
# bare tokens it hunts for. Two kinds of occurrence are data, not unfinished
# work, and are removed before the marker scan:
#   - an id-shaped token: a marker joined by - or _ to an uppercase
#     alphanumeric (a spec id such as CAWS-DEFECT-<marker>-SCAFFOLD-01, a
#     ticket ref such as <marker>-123). A marker followed by lowercase prose
#     ("<marker>-fix this"), or joined to lowercase text, still counts.
#   - a quoted string literal in code: the marker is the value the code owns
#     (scaffold text a CLI writes), not a stub it leaves behind. A string never
#     closing on its line is left alone, so a stray quote hides nothing.
_MK_COMMENT='TO''DO|FIX''ME|XX''X|HA''CK|TB''D'
_MK_CODE='TO''DO|FIX''ME|HA''CK|TB''D'
_STRIP_STRINGS_AWK='
{
  s = $0; n = length(s); out = ""; i = 1
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "\"" || c == "\047" || c == "`") {
      j = i + 1
      while (j <= n) {
        d = substr(s, j, 1)
        if (d == "\\") { j += 2; continue }
        if (d == c) break
        j++
      }
      if (j <= n) { out = out c c; i = j + 1; continue }
    }
    out = out c
    i++
  }
  print out
}'
strip_id_shaped() {
  sed -E -e "s/[A-Z0-9][-_]($1)/ID/g" -e "s/($1)[-_][A-Z0-9]/ID/g"
}
COMMENT_SCAN=$(printf '%s\n' "$COMMENT_RECORDS" | strip_id_shaped "$_MK_COMMENT")
CODE_SCAN=$(printf '%s\n' "$CONTENT" | awk "$_STRIP_STRINGS_AWK" | awk '{ print NR "\tcode\t" $0 }' | strip_id_shaped "$_MK_CODE")

take "incomplete-work marker (TO""DO/FIX""ME/XX""X/HA""CK/TB""D)" \
  "$(first_active "$COMMENT_SCAN" -i "\\b($_MK_COMMENT)\\b")"
# Outside comments only the uppercase convention counts, and the triple-X marker
# not at all: a type name or an input mask shares the word, but the uppercase form
# in code is a stub.
take "incomplete-work marker (TO""DO/FIX""ME/XX""X/HA""CK/TB""D)" \
  "$(first_active "$CODE_SCAN" -s "\\b($_MK_CODE)\\b")"
take "not-implemented / deferred-work language" \
  "$(first_active "$CODE_RECORDS" -i 'not implemented|implement later|coming soon')"
take "placeholder used as stub language in a comment" "$(placeholder_hit)"

[[ -z "$MATCH" ]] && exit 0

# Quote the whole source line (not just the comment fragment) so the message
# shows where the stub sits; strip leading whitespace, cap length.
LINE_NO="${MATCH%%"$TAB"*}"
[[ "$LINE_NO" =~ ^[0-9]+$ ]] || exit 0
LINE_TEXT=$(printf '%s\n' "$CONTENT" | sed -n "${LINE_NO}p" | sed 's/^[[:space:]]*//' | cut -c1-120)
LINE_REF="line ${LINE_NO}"
[[ "$CONTENT_IS_FRAGMENT" -eq 1 ]] && LINE_REF="line ${LINE_NO} of the edit"

BASE="Shortcut-language advisory in ${FILE_PATH}: ${PATTERN_DESC} — ${LINE_REF}: \"${LINE_TEXT}\". CAWS doctrine (\"No fake implementations\") asks for complete code in committed source, not TODO/placeholder stubs."
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
# the JSON is what the harness honors.
exit 0
