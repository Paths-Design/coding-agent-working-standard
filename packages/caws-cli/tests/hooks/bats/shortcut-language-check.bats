#!/usr/bin/env bats
# shortcut-language-check.sh — stub language vs domain vocabulary
# (CAWS-DEFECT-SHORTCUT-LANG-DOMAIN-VOCABULARY-FP-01, lineage 29).
#
# The defect this pins: "placeholder" is a first-class UI term (the HTML input
# attribute, the React Native prop, the ::placeholder pseudo-element), so the
# guard struck ordinary component code — `placeholder?: string`,
# `placeholder={placeholder}`, a `"placeholder"` union member — while missing
# the clearest stub phrasing of all ("This is just a placeholder"), which the
# reference-determiner layer suppressed because of the "a". The same collision
# hit `type Todo` and an `XXX-XXX-XXXX` input mask.
#
# Both directions are load-bearing. The silent cases alone would pass against a
# guard that never fires; the firing cases alone would pass against the old
# guard. Every firing case asserts the pattern class and the quoted line, so a
# case that fires for the wrong reason (a TODO case tripping the placeholder
# rule) fails. Every silent case also asserts no strike was recorded — an
# advisory suppressed from stdout but still counted toward the block would be
# the worse defect.
#
# Each test gets its own HOME, so the strike file it asserts on is its own and
# every firing case is a first strike; nothing reads or writes the operator's
# real ~/.caws.

load helpers

setup_file() {
  caws_install_pack_once
  # Baseline and mutation runs point the suite at a variant guard while keeping
  # the installed libs it sources: SHORTCUT_GUARD_UNDER_TEST replaces the body,
  # then SHORTCUT_GUARD_MUTATE_FROM/_TO applies one literal replacement. A FROM
  # that is absent fails setup, so a mutant that changes nothing cannot
  # "survive". The replacement splices prefix + TO + suffix rather than using
  # ${body/from/to}: bash 3.2 (macOS /bin/bash) keeps the quotes of a quoted
  # replacement inside a double-quoted expansion, which would corrupt the guard.
  local guard="$CAWS_TEST_HOOKS_DIR/shortcut-language-check.sh" body from
  if [[ -n "${SHORTCUT_GUARD_UNDER_TEST:-}" ]]; then
    cat "$SHORTCUT_GUARD_UNDER_TEST" >"$guard" || return 1
  fi
  if [[ -n "${SHORTCUT_GUARD_MUTATE_FROM:-}" ]]; then
    from="$SHORTCUT_GUARD_MUTATE_FROM"
    body="$(cat "$guard")"
    [[ "$body" == *"$from"* ]] || {
      echo "mutation FROM not found in $guard" >&2
      return 1
    }
    printf '%s%s%s\n' "${body%%"$from"*}" "${SHORTCUT_GUARD_MUTATE_TO:-}" "${body#*"$from"}" >"$guard"
  fi
}
teardown_file() {
  caws_teardown_pack
}

SESSION="caws-bats-shortcut"

# _invoke_shortcut HOME — run the installed guard on stdin with an isolated
# HOME; stderr goes to a file so `output` is the guard's decision JSON only.
_invoke_shortcut() {
  local home="$1"
  env HOME="$home" CAWS_HOME="$home/.caws" \
    CLAUDE_CODE_SESSION_ID="$SESSION" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    bash "$CAWS_TEST_HOOKS_DIR/shortcut-language-check.sh" 2>"$home/stderr.log"
}

# scan <Write|Edit> <file_path> <content> — sets bats' status/output and
# STRIKES (the strike file this case would have written).
scan() {
  local tool="$1" fp="$2" content="$3" home field=content envelope
  home="$(mktemp -d "$BATS_TEST_TMPDIR/home.XXXXXX")"
  [[ "$tool" == Edit ]] && field=new_string
  envelope=$(jq -nc --arg t "$tool" --arg fp "$fp" --arg f "$field" --arg c "$content" \
    --arg s "$SESSION" --arg cwd "$CAWS_TEST_REPO" \
    '{session_id:$s, cwd:$cwd, tool_name:$t, tool_input:{file_path:$fp, ($f):$c}}')
  run _invoke_shortcut "$home" <<<"$envelope"
  STRIKES="$home/.caws/state/sessions/$SESSION/strikes.json"
}

assert_silent() {
  assert_success
  assert_output ''
  [[ ! -e "$STRIKES" ]] || fail "expected no strike recorded, found $STRIKES: $(cat "$STRIKES")"
}

# assert_strike <pattern-class> <line-ref> <quoted-line-prefix>
assert_strike() {
  local class="$1" line_ref="$2" excerpt="$3" msg
  assert_success
  msg=$(printf '%s' "$output" | jq -r '.hookSpecificOutput.additionalContext // empty')
  [[ -n "$msg" ]] || fail "expected a strike-1 advisory, got: ${output:-<nothing>}"
  [[ "$msg" == *": $class — $line_ref: \"$excerpt"* ]] ||
    fail "expected '$class — $line_ref: \"$excerpt…', got: $msg"
  [[ "$msg" == *"(strike 1 of 3 — advisory.)" ]] || fail "expected the first-strike wording, got: $msg"
  [[ -f "$STRIKES" ]] || fail "advisory emitted but no strike recorded at $STRIKES"
  run jq -r '.shortcut_language' "$STRIKES"
  assert_output '1'
}

PH="placeholder used as stub language in a comment"
KW="incomplete-work marker (TODO/FIXME/XXX/HACK/TBD)"
NI="not-implemented / deferred-work language"
THROW="explicit not-implemented stub throw"

# --- placeholder as UI vocabulary: silent -----------------------------------

@test "shortcut-language: a React input's placeholder prop, union member, attribute and JSDoc noun are vocabulary" {
  scan Write /repo/src/components/Input/Input.tsx 'import { type InputHTMLAttributes } from "react";
export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "name" | "placeholder" | "value"> {
  /** Placeholder text shown when the input is empty. */
  placeholder?: string;
}
export function Input({
  placeholder,
  ...rest
}: InputProps) {
  return <input placeholder={placeholder} {...rest} />;
}'
  assert_silent
}

@test "shortcut-language: React Native placeholder and placeholderTextColor props are vocabulary" {
  scan Write /repo/src/components/Input/Input.native.tsx \
    '<TextInput placeholderTextColor={muted} placeholder={placeholder} />'
  assert_silent
}

@test "shortcut-language: CSS ::placeholder and :placeholder-shown selectors are vocabulary" {
  scan Write /repo/src/styles/input.css '.input::placeholder { color: var(--input-placeholder); }
.input:placeholder-shown { border-style: dashed; }'
  assert_silent
}

@test "shortcut-language: a bare Placeholder JSDoc prop description is vocabulary" {
  scan Write /repo/src/Field.tsx '/** Placeholder */
placeholder?: string;'
  assert_silent
}

@test "shortcut-language: comments describing the placeholder concept are vocabulary" {
  scan Write /repo/src/codegen/attrs.ts '// map placeholder to the native attribute
// The placeholder is shown until the user types.
// Renders a placeholder while the image loads
if (props.placeholder) attrs.push("placeholder");'
  assert_silent
}

@test "shortcut-language: 'the skeleton is a placeholder' describes a UI element, not this code" {
  scan Write /repo/src/Skeleton.tsx '// The skeleton is a placeholder shown while content loads.
export const Skeleton = () => <div aria-busy="true" />;'
  assert_silent
}

@test "shortcut-language: aria-placeholder beside a deferral cue is an attribute name, not stub language" {
  scan Write /repo/src/Combobox.tsx '// set aria-placeholder later, once the label is known
el.setAttribute("aria-placeholder", hint);'
  assert_silent
}

@test "shortcut-language: a joined ::placeholder before a stub head word is a selector name" {
  scan Write /repo/src/styles/field.css '/* ::placeholder until focus, then the label floats */
.field input::placeholder { opacity: 0; }'
  assert_silent
}

@test "shortcut-language: an HTML comment describing a placeholder slot is vocabulary" {
  scan Write /repo/src/Input.vue '<!-- placeholder slot for the hint text -->
<input :placeholder="placeholder" />'
  assert_silent
}

@test "shortcut-language: placeholder in a URL followed by an unrelated line comment is vocabulary" {
  scan Write /repo/src/assets.ts 'const URL = "https://example.com/placeholder"; // ok'
  assert_silent
}

@test "shortcut-language: an Edit binding the placeholder attribute is vocabulary" {
  scan Edit /repo/src/Search.tsx '<input placeholder={placeholder} aria-label={label} />'
  assert_silent
}

# --- other marker words used as vocabulary: silent --------------------------

@test "shortcut-language: todo / Todo identifiers in code are vocabulary" {
  scan Write /repo/examples/todo/app.ts 'type Todo = { title: string; done: boolean };
const todos: Todo[] = items.filter((todo) => !todo.done);'
  assert_silent
}

@test "shortcut-language: an XXX format mask as an input placeholder value is vocabulary" {
  scan Write /repo/src/PhoneInput.tsx '<input type="tel" placeholder="XXX-XXX-XXXX" />'
  assert_silent
}

# A glob's "/*" must not open a block comment, or every later line would be
# scanned as comment text and an identifier named todo would read as a marker.
@test "shortcut-language: a single-star glob in a string does not open a block comment" {
  scan Write /repo/scripts/scan.ts 'const pattern = "src/*.ts";
const todo = loadTasks(pattern);'
  assert_silent
}

@test "shortcut-language: a double-star glob in a string does not open a block comment" {
  scan Write /repo/scripts/scan.ts 'const pattern = "src/**/*.ts";
const todo = loadTasks(pattern);'
  assert_silent
}

@test "shortcut-language: a marker in reference position inside a comment stays suppressed" {
  scan Write /repo/src/lint.ts '// avoid leaving a TODO behind in generated code'
  assert_silent
}

@test "shortcut-language: test files remain exempt" {
  scan Write /repo/src/Input.test.tsx '// TODO: cover the disabled state'
  assert_silent
}

# --- a marker that is an identifier or data, not unfinished work: silent ----
#
# The marker word is assembled at runtime ($T) so this suite never carries the
# bare token it exercises.

T="TO""DO"

@test "shortcut-language: a spec id containing the marker in a comment is an identifier" {
  scan Write /repo/src/specs.ts "// see CAWS-DEFECT-SPECS-CREATE-${T}-SCAFFOLD-01 for the scaffold contract"
  assert_silent
}

@test "shortcut-language: id-shaped marker joins with a leading or trailing uppercase segment are identifiers" {
  scan Write /repo/src/specs.ts "// tracked as ${T}-123 and ${T}_SCAFFOLD and SCAFFOLD-${T}.
export const SCAFFOLD_${T}_LINE = buildLine();"
  assert_silent
}

@test "shortcut-language: a double-quoted constant whose value starts with the marker is data" {
  scan Write /repo/src/scaffold.ts "export const SCAFFOLD_LINE = \"${T}: describe the change\";"
  assert_silent
}

@test "shortcut-language: single-quoted and template-literal constants holding the marker are data" {
  scan Write /repo/src/scaffold.ts "const a = '${T}: fill in the title';
const b = \`${T}: fill in \${name}\`;"
  assert_silent
}

@test "shortcut-language: a scaffold string that embeds a hash comment holding the marker is data" {
  scan Write /repo/src/scaffold.ts "const YAML_SCAFFOLD = 'name: x # ${T}: describe the scope';
const URL_SCAFFOLD = \"a // ${T}: b\";"
  assert_silent
}

@test "shortcut-language: a string with an escaped quote before the marker stays one literal" {
  scan Write /repo/src/scaffold.ts "const s = \"say \\\\\"hi\\\\\" then ${T}\";"
  assert_silent
}

# --- placeholder as stub language in a comment: strikes ---------------------

@test "shortcut-language: a bare '// placeholder' comment strikes" {
  scan Write /repo/src/api.ts 'export function load() {
  // placeholder
  return null;
}'
  assert_strike "$PH" "line 2" "// placeholder"
}

@test "shortcut-language: 'This is just a placeholder' strikes despite the determiner 'a'" {
  scan Write /repo/src/api.ts '// This is just a placeholder'
  assert_strike "$PH" "line 1" "// This is just a placeholder"
}

@test "shortcut-language: \"it's a placeholder\" strikes" {
  scan Write /repo/src/api.ts "export const rows = []; // it's a placeholder"
  assert_strike "$PH" "line 1" "export const rows = []; // it's a placeholder"
}

@test "shortcut-language: 'placeholder implementation' strikes" {
  scan Write /repo/src/api.ts '// Placeholder implementation, replace with real logic'
  assert_strike "$PH" "line 1" "// Placeholder implementation"
}

@test "shortcut-language: a trailing '// placeholder for now' strikes" {
  scan Write /repo/src/api.ts 'return null; // placeholder for now'
  assert_strike "$PH" "line 1" "return null; // placeholder for now"
}

@test "shortcut-language: 'temporary placeholder' in a block comment strikes" {
  scan Write /repo/src/api.ts 'const x = 0; /* temporary placeholder */'
  assert_strike "$PH" "line 1" "const x = 0; /* temporary placeholder */"
}

@test "shortcut-language: a Python '# placeholder until …' comment strikes" {
  scan Write /repo/tools/sync.py 'x = 0  # placeholder until the API lands'
  assert_strike "$PH" "line 1" "x = 0  # placeholder until the API lands"
}

@test "shortcut-language: a multi-line block comment body without leading stars strikes" {
  scan Write /repo/src/api.ts 'export const handler = () => {
  /*
    placeholder for now
  */
};'
  assert_strike "$PH" "line 3" "placeholder for now"
}

@test "shortcut-language: a deferral cue elsewhere in the same comment strikes" {
  scan Write /repo/src/api.ts '// placeholder, fill in later'
  assert_strike "$PH" "line 1" "// placeholder, fill in later"
}

# The two placeholder rules are separate scans; the advisory must still quote
# the earliest stub line, not whichever rule reported first.
@test "shortcut-language: the advisory quotes the first placeholder stub line" {
  scan Write /repo/src/api.ts '// placeholder, fill in later
const a = 1;
// placeholder implementation'
  assert_strike "$PH" "line 1" "// placeholder, fill in later"
}

@test "shortcut-language: an Edit's stub comment strikes and names the line within the edit" {
  scan Edit /repo/src/api.ts 'const rows = []; // placeholder for now'
  assert_strike "$PH" "line 1 of the edit" "const rows = []; // placeholder for now"
}

# An Edit's new_string often starts inside a JSDoc block, so its "* " lines
# arrive with no opener in sight.
@test "shortcut-language: a JSDoc-fragment Edit with a stub line strikes" {
  scan Edit /repo/src/api.ts ' * Loads the rows.
 * placeholder for now
 */'
  assert_strike "$PH" "line 2 of the edit" "* placeholder for now"
}

# --- the other pattern classes still fire: strikes --------------------------

@test "shortcut-language: a TODO marker in a comment strikes and quotes its line" {
  scan Write /repo/src/api.ts 'const a = 1;
const b = 2;
// TODO: wire the real handler'
  assert_strike "$KW" "line 3" "// TODO: wire the real handler"
}

@test "shortcut-language: a lowercase todo marker in a comment strikes" {
  scan Write /repo/src/api.ts '// todo: handle the error path'
  assert_strike "$KW" "line 1" "// todo: handle the error path"
}

@test "shortcut-language: a marker after a word ending in a determiner's letters ('data TODO') strikes" {
  scan Write /repo/src/api.ts '// load the data TODO'
  assert_strike "$KW" "line 1" "// load the data TODO"
}

@test "shortcut-language: an uppercase marker used as a bare code value strikes" {
  scan Write /repo/src/api.ts "const label = ${T};"
  assert_strike "$KW" "line 1" "const label = ${T};"
}

@test "shortcut-language: a bare marker comment strikes even beside an id-shaped one" {
  scan Write /repo/src/api.ts "// see CAWS-DEFECT-SPECS-CREATE-${T}-SCAFFOLD-01
// ${T}: wire the real handler"
  assert_strike "$KW" "line 2" "// ${T}: wire the real handler"
}

@test "shortcut-language: a marker followed by lowercase prose after a hyphen is not an id and strikes" {
  scan Write /repo/src/api.ts "// ${T}-fix the handler"
  assert_strike "$KW" "line 1" "// ${T}-fix the handler"
}

@test "shortcut-language: a marker joined to a lowercase word by a hyphen is not an id and strikes" {
  scan Write /repo/src/api.ts "// fix-${T} later"
  assert_strike "$KW" "line 1" "// fix-${T} later"
}

@test "shortcut-language: a trailing marker comment after a complete string literal strikes" {
  scan Write /repo/src/api.ts "const a = 'ok'; // ${T}: replace the literal"
  assert_strike "$KW" "line 1" "const a = 'ok'; // ${T}: replace the literal"
}

@test "shortcut-language: a bare marker after a string literal on the same code line strikes" {
  scan Write /repo/src/api.ts "const a = \"ok\"; const b = ${T};"
  assert_strike "$KW" "line 1" "const a = \"ok\"; const b = ${T};"
}

@test "shortcut-language: a marker after an unterminated string quote still strikes" {
  scan Write /repo/src/api.ts "const a = \"unterminated ${T}"
  assert_strike "$KW" "line 1" "const a = \"unterminated ${T}"
}

@test "shortcut-language: a stray apostrophe before a line comment does not hide the marker" {
  scan Write /repo/src/deploy.sh "echo don't panic; # ${T}: handle failure"
  assert_strike "$KW" "line 1" "echo don't panic; # ${T}: handle failure"
}

@test "shortcut-language: a single-quoted not-implemented throw still strikes" {
  scan Write /repo/src/api.ts "export function save() {
  throw new Error('not implemented');
}"
  assert_strike "$THROW" "line 2" "throw new Error('not implemented');"
}

@test "shortcut-language: a not-implemented throw reports the throw class" {
  scan Write /repo/src/api.ts 'export function save() {
  throw new Error("not implemented");
}'
  assert_strike "$THROW" "line 2" 'throw new Error("not implemented");'
}

@test "shortcut-language: a 'coming soon' comment strikes" {
  scan Write /repo/src/api.ts '// coming soon'
  assert_strike "$NI" "line 1" "// coming soon"
}
