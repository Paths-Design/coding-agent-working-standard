#!/usr/bin/env bats
# bash-write-guard.sh + lib/heredoc.sh —
# GUARD-HEREDOC-BODY-READ-AS-COMMAND-001.
#
# A heredoc BODY is payload the command carries, not command text. The guard
# tokenizes the command string to find mutation targets, so before this slice a
# body containing a redirect/tee/rm verb was read as a command and routed to the
# worktree-claim oracle — refusing a command whose only real mutation was the
# file it redirected into.
#
# File-sink neutralization is a SAFELIST, not blanket blanking. Literal Node
# projection is only an outer-shell view: the original executable JavaScript
# must remain available to interpreter-write checks.
#
# Foreign-payload controls assert a real refusal independently of unmatched
# scope. Helper and lexical-API assertions pin the portable projection defect;
# the current typed handler already handles JavaScript and is a positive/hostile
# control, not an installed43 reproduction. Hostile commands are never executed.

load helpers

setup_file() {
  caws_install_pack_once
  # Match the physical managed layout. There is no environment-selected trust
  # hook: the selected library discovers the sibling Node/compiled entry itself.
  export CAWS_TEST_PREFIX_GENERATION="$CAWS_TEST_HOME/lib/runtimes/0000000000000000000000000000000000000000000000000000000000000000"
  export CAWS_TEST_PREFIX_LIB="$CAWS_TEST_PREFIX_GENERATION/lib/heredoc.sh"
  mkdir -p "$CAWS_TEST_PREFIX_GENERATION/lib" "$CAWS_TEST_PREFIX_GENERATION/native" \
    "$CAWS_TEST_PREFIX_GENERATION/native-prefix/node_modules/@paths.design/caws-cli/dist/shell"
  cp "$CAWS_TEST_HOOKS_DIR/lib/heredoc.sh" "$CAWS_TEST_PREFIX_LIB"
  cp "$(command -v node)" "$CAWS_TEST_PREFIX_GENERATION/native/node"
  cp -R "$CLI_PKG_ROOT/dist/shell/analysis" "$CAWS_TEST_PREFIX_GENERATION/native-prefix/node_modules/@paths.design/caws-cli/dist/shell/"
  cp "$CLI_PKG_ROOT/dist/shell/duration.js" "$CAWS_TEST_PREFIX_GENERATION/native-prefix/node_modules/@paths.design/caws-cli/dist/shell/"
  local parser_root
  parser_root="$(node -p 'require("path").dirname(require("path").dirname(require.resolve("unbash")))')"
  cp -R "$parser_root" "$CAWS_TEST_PREFIX_GENERATION/native-prefix/node_modules/unbash"
}
teardown_file() {
  caws_teardown_pack
}

# A foreign-owned payload provides an explicit ownership refusal control.
_seed_foreign_worktree() {
  local wt="wt-seed" spec="SEED-001" owner="${1:-other-session}"
  mkdir -p "$CAWS_TEST_REPO/.caws/worktrees/$wt" "$CAWS_TEST_REPO/.caws/specs"
  cat > "$CAWS_TEST_REPO/.caws/worktrees.json" <<JSON
{"$wt":{"name":"$wt","spec_id":"$spec","path":"$CAWS_TEST_REPO/.caws/worktrees/$wt","owner":{"session_id":"$owner"},"baseBranch":"main"}}
JSON
}

_foreign_payload() {
  printf '%s' "$CAWS_TEST_REPO/.caws/worktrees/wt-seed/file.txt"
}

_run_bwg() {
  local command="$1" sid="${2:-my-session}" envelope
  envelope="$(jq -nc --arg c "$command" --arg s "$sid" \
    '{tool_name:"Bash", tool_input:{command:$c}, session_id:$s}')"
  run_guard bash-write-guard.sh "$envelope"
}

_run_blank() {
  local input="$1"
  run env CAWS_SHARED_LIB_DIR="$CAWS_TEST_PREFIX_GENERATION/lib" \
    CAWS_ADAPTER_RUNTIME_DIGEST=0000000000000000000000000000000000000000000000000000000000000000 \
    bash -c 'source "$1"; caws_blank_heredoc_bodies "$2"' _ "$CAWS_TEST_PREFIX_LIB" "$input"
}

# The marker keeps trailing newlines observable through bats' output capture.
_run_blank_exact() {
  run env CAWS_SHARED_LIB_DIR="$CAWS_TEST_PREFIX_GENERATION/lib" \
    CAWS_ADAPTER_RUNTIME_DIGEST=0000000000000000000000000000000000000000000000000000000000000000 \
    bash -eu -o pipefail -c 'source "$1"; caws_blank_heredoc_bodies "$2"; printf __END__' _ "$CAWS_TEST_PREFIX_LIB" "$1"
}

# Exercise the published lexical API directly, not a replacement for the
# current bash-write-guard's mandatory typed analysis or an installed43 image.
_run_shell_view() {
  run env CAWS_SHARED_LIB_DIR="$CAWS_TEST_PREFIX_GENERATION/lib" \
    CAWS_ADAPTER_RUNTIME_DIGEST=0000000000000000000000000000000000000000000000000000000000000000 \
    bash -eu -o pipefail -c 'source "$1"; source "$2/lib/bash-mutation-targets.sh"; "$3" "$4"' _ "$CAWS_TEST_PREFIX_LIB" "$CAWS_TEST_HOOKS_DIR" "$1" "$2"
}

# The six separate inspection lines from consumer04. These strings are input
# to projection/guard APIs only; neither this prefix nor a hostile suffix runs.
_read_prefix() {
  printf 'pwd -P\ngit rev-parse --show-toplevel\ngit rev-parse HEAD\ngit branch --show-current\ngit status --short\ncat AGENTS.md'
}

# The actual06 postcommit readback prefix. Payloads below are inert API inputs;
# the full unchanged installed/native call remains a separate qualification.
_postcommit_prefix() {
  printf 'git rev-parse HEAD\ngit show --stat --oneline HEAD\ngit status --short'
}

_caws_read_prefix() {
  printf '/opt/reviewed/bin/caws specs show EXAMPLE-001\ncaws status --short'
}

# ── guard-level (end to end through the real oracle) ────────────────────────

@test "A1b control: a redirect to a foreign worktree payload DOES block (the block path is live)" {
  _seed_foreign_worktree
  _run_bwg "echo x > $(_foreign_payload)"
  assert_failure
  assert_output --partial 'BLOCKED'
  assert_output --partial 'wt-seed'
}

@test "A1: the same redirect inside a cat heredoc BODY is not read as a target" {
  _seed_foreign_worktree
  _run_bwg "$(printf 'cat > notes.md <<%s\nDocumenting the old flow: echo x > %s\n%s\n' "'EOF'" "$(_foreign_payload)" EOF)"
  assert_success
  refute_output --partial 'BLOCKED'
}

@test "A1c: the same redirect inside a tee heredoc BODY is not read as a target" {
  _seed_foreign_worktree
  _run_bwg "$(printf 'tee notes.md <<%s\nExample: rm %s\n%s\n' "'EOF'" "$(_foreign_payload)" EOF)"
  assert_success
  refute_output --partial 'BLOCKED'
}

@test "A3: a sibling mutation OUTSIDE the heredoc is still adjudicated (no hiding behind a body)" {
  _seed_foreign_worktree
  _run_bwg "$(printf 'echo x > %s && cat > notes.md <<%s\nharmless\n%s\n' "$(_foreign_payload)" "'EOF'" EOF)"
  assert_failure
  assert_output --partial 'BLOCKED'
}

# ── helper-level (the transformation itself) ────────────────────────────────

@test "A2: an interpreter-fed heredoc keeps its body fully visible (the safelist is not a bypass)" {
  _run_blank "$(printf 'bash <<%s\ngit push --force origin main\n%s\n' "'EOF'" EOF)"
  assert_success
  assert_output --partial 'git push --force origin main'
}

@test "A2b: an unrecognized command's heredoc body stays visible (fail-closed direction)" {
  _run_blank "$(printf 'mystery-tool <<%s\nrm -rf /important\n%s\n' "'EOF'" EOF)"
  assert_success
  assert_output --partial 'rm -rf /important'
}

@test "A4: input with no heredoc is returned byte-identically" {
  _run_blank 'echo hi > f.txt'
  assert_success
  assert_output 'echo hi > f.txt'
}

@test "A4b: an unterminated heredoc is blanked to end-of-input without error" {
  _run_blank "$(printf 'cat > f <<%s\nsecret payload\n' "'EOF'")"
  assert_success
  refute_output --partial 'secret payload'
}

@test "A5: a body line that merely starts with the delimiter does not close the heredoc" {
  _run_blank "$(printf 'cat > f <<%s\nEOFX\nstill body text\n%s\n' "'EOF'" EOF)"
  assert_success
  refute_output --partial 'still body text'
}

@test "literal Node: installed helper body matches the selected source" {
  run sed '/^# hook_pack_version:/d' "$CLI_PKG_ROOT/templates/hook-packs/shared/lib/heredoc.sh"
  assert_success
  local expected="$output"
  run sed '/^# hook_pack_version:/d' "$CAWS_TEST_PREFIX_LIB"
  assert_success
  assert_output "$expected"
}

@test "literal Node: quoted arrow and greater-than payload projects out with exact surrounding bytes" {
  local quote input expected
  for quote in "'" '"'; do
    input="$(printf '\n \t\n  node <<%sJS%s\nconst rows = ["1"].map(x => JSON.parse(x));\nconsole.log(rows.length > 0);\nJS\necho after > after.txt\n' "$quote" "$quote")"$'\n\n'
    expected="$(printf '\n \t\n  node <<%sJS%s\n\n\nJS\necho after > after.txt\n' "$quote" "$quote")"$'\n\n'
    _run_blank_exact "$input"
    assert_success
    assert_output "${expected}__END__"
  done
}

@test "literal Node: observed map arrow produces no outer-shell mutation candidate" {
  local input
  input=$'node <<\'JS\'\nconst rows = ["1"].map(x => JSON.parse(x));\nconsole.log(rows.length > 0);\nJS'
  _run_shell_view caws_bash_mutation_candidates "$input"
  assert_success
  assert_output ''
}

@test "literal Node: current typed guard admits the read-only command" {
  _run_bwg $'node <<\'JS\'\nconst rows = ["1"].map(x => JSON.parse(x));\nconsole.log(rows.length > 0);\nJS'
  assert_success
  refute_output --partial 'BLOCKED'
  refute_output --partial 'UNRESOLVED'
}

@test "literal Node: exact terminator and absent final newline are preserved" {
  _run_blank_exact $'node <<"JS"\nJSX\nconsole.log("ok");\nJS'
  assert_success
  assert_output $'node <<"JS"\n\n\nJS__END__'
}

@test "literal Node: unsupported headers retain the entire payload" {
  local header input
  for header in 'node <<JS' 'node <<$END' 'node - <<"JS"' 'node --input-type=module <<"JS"' \
    'env node <<"JS"' 'command node <<"JS"' '/usr/bin/node <<"JS"' 'node <<-"JS"' \
    'node <<"JS" > result' 'node <<"JS"; echo after' 'node <<"JS" # comment' \
    'bash <<"JS"' 'python3 <<"JS"' 'mystery-tool <<"JS"'; do
    input="$header"$'\nconst rows = ["1"].map(x => JSON.parse(x));\nJS'
    _run_blank "$input"
    assert_success
    assert_output "$input"
  done
}

@test "literal Node: unterminated or multiply introduced payloads are not erased" {
  local input
  for input in $'node <<\'JS\'\nconst f = x => x > 0;' \
    $'node <<\'JS\' <<\'OTHER\'\nconst f = x => x;\nJS\nOTHER\n' \
    $'node <<\'JS\'\nconst f = x => x;\nJS\nnode <<\'OTHER\'\nconst g = x => x;\nOTHER\n'; do
    _run_blank "$input"
    assert_success
    assert_output "$(printf '%s' "$input")"
  done
}

@test "literal Node: quoted or compound shell contexts cannot masquerade as a direct header" {
  local input
  for input in $'bash -c \'\nnode <<"JS"\ngit push --force\nJS\n\'' \
    $'value=$(\nnode <<"JS"\nconsole.log("ok");\nJS\n)' \
    $'if true; then\nnode <<"JS"\nconsole.log("ok");\nJS\nfi' \
    $'echo continued \\\nnode <<"JS"\nconsole.log("ok");\nJS'; do
    _run_blank "$input"
    assert_success
    assert_output "$input"
  done
}

@test "literal Node lookup: a visible alias really can execute the body as harmless shell" {
  local input=$'shopt -s expand_aliases\nalias node=sh\nnode <<\'SH\'\nprintf CAWS_ALIAS_BODY_EXECUTED\nSH'
  # This is the sole executed payload: a harmless stdout marker, never a
  # hostile Git command, external write, or interpreter mutation probe.
  run bash --noprofile --norc -c "$input"
  assert_success
  assert_output CAWS_ALIAS_BODY_EXECUTED
}

@test "literal Node lookup: alias override keeps shell operations visible in projection" {
  local input=$'shopt -s expand_aliases\nalias node=sh\nnode <<\'SH\'\ngit sparse-checkout disable\nSH'
  _run_blank "$input"
  assert_success
  assert_output "$input"
  _run_shell_view caws_bash_command_lines "$input"
  assert_success
  assert_output 'git sparse-checkout disable'
}

@test "literal Node lookup: overridden shell body reaches worktree refusal before simulated effects" {
  _seed_foreign_worktree
  local input=$'shopt -s expand_aliases\nalias node=sh\nnode <<\'SH\'\ngit sparse-checkout disable\nSH'
  local marker="$BATS_TEST_TMPDIR/operation-sentinel"
  printf sentinel > "$marker"
  run_guard worktree-guard.sh "$(hook_envelope Bash '' "$input")"
  local guard_status="$status"
  # Never execute this command. The sentinel models the effect only if the
  # guard allows it, so an exit-zero block-shaped response cannot pass.
  if [[ "$guard_status" == 0 ]]; then printf changed > "$marker"; fi
  printf 'override guard exit=%s sentinel=%s\n' "$guard_status" "$(cat "$marker")"
  assert_equal "$guard_status" 2
  assert_output --partial 'BLOCKED: agent-issued git sparse-checkout'
  assert_equal "$(cat "$marker")" sentinel
}

@test "literal Node lookup: other visible state changes cannot establish direct Node identity" {
  local prefix input
  for prefix in 'builtin alias node=sh' 'hash -p /bin/sh node' \
    'builtin hash -p /bin/sh node' 'enable -f /tmp/override.so node' \
    'builtin enable -n node' 'source ./lookup.sh' '. ./lookup.sh' \
    'eval alias node=sh' 'PATH=/other/bin' 'BASH_ENV=/other/env' \
    'set -o posix' 'echo plain-prefix'; do
    input="$prefix"$'\nnode <<\'SH\'\ngit sparse-checkout disable\nSH'
    _run_blank "$input"
    assert_success
    assert_output "$input"
    _run_shell_view caws_bash_command_lines "$input"
    assert_success
    assert_output 'git sparse-checkout disable'
  done
}

@test "literal Node: unquoted shell substitution remains visible and cannot write the sentinel" {
  _seed_foreign_worktree
  local target input
  target="$(_foreign_payload)"
  printf sentinel > "$target"
  input="$(printf 'node <<JS\n$(touch %s)\nJS\n' "$target")"
  _run_blank "$input"
  assert_success
  assert_output "$input"
  _run_bwg "$input"
  assert_equal "$status" 2
  assert_output --partial 'BLOCKED'
  assert_equal "$(cat "$target")" sentinel
}

@test "literal Node: raw interpreter write literals survive outer-shell projection" {
  local input target="$CAWS_TEST_REPO/foreign/file.txt"
  input="$(printf 'node <<%s\nrequire("fs").writeFileSync("%s", "changed");\nJS\n' "'JS'" "$target")"
  _run_blank "$input"
  assert_success
  refute_output --partial 'writeFileSync'
  _run_shell_view caws_bash_interpreter_write_literals "$input"
  assert_success
  assert_output --partial "$target"
}

@test "literal Node: valid JavaScript foreign write is refused before any simulated effect" {
  local foreign="$BATS_TEST_TMPDIR/foreign" target input
  mkdir -p "$foreign"
  git -C "$foreign" init -q -b main
  target="$foreign/sentinel.txt"
  printf sentinel > "$target"
  input="$(printf 'node <<%s\nrequire("fs").writeFileSync("%s", "changed");\nJS\n' "'JS'" "$target")"
  _run_bwg "$input"
  local guard_status="$status" guard_output="$output"
  if [[ "$guard_status" == 0 ]]; then printf changed > "$target"; fi
  assert_equal "$guard_status" 2
  assert_equal "$(cat "$target")" sentinel
  [[ "$guard_output" == *BLOCKED* ]]
  [[ "$guard_output" == *"$foreign"* ]]
}

@test "literal Node: real shell redirects before and after retain targets and refusal" {
  _seed_foreign_worktree
  local target input position
  target="$(_foreign_payload)"
  printf sentinel > "$target"
  for position in before after; do
    input=$'node <<\'JS\'\nconst f = x => x > 0;\nJS'
    if [[ "$position" == before ]]; then input="echo changed > $target"$'\n'"$input";
    else input+=$'\n'"echo changed > $target"; fi
    _run_shell_view caws_bash_mutation_candidates "$input"
    assert_success
    assert_line "$target"
    if [[ "$position" == before ]]; then
      # Earlier statements make Node lookup uncertain. The conservative view
      # retains the whole payload as well as the real outer mutation target.
      _run_blank "$input"
      assert_success
      assert_output "$input"
    else
      assert_output "$target"
    fi
    _run_bwg "$input"
    assert_equal "$status" 2
    assert_output --partial 'BLOCKED'
    assert_output --partial 'wt-seed'
    assert_equal "$(cat "$target")" sentinel
  done
}

@test "literal Node: worktree operation view ignores body prose and preserves outside Git policy" {
  _seed_foreign_worktree
  local input position
  input=$'node <<\'JS\'\nconsole.log("git sparse-checkout disable");\nJS'
  _run_shell_view caws_bash_command_lines "$input"
  assert_success
  assert_output ''
  for position in before after; do
    input=$'node <<\'JS\'\nconsole.log("git sparse-checkout disable");\nJS'
    if [[ "$position" == before ]]; then input=$'git sparse-checkout disable\n'"$input";
    else input+=$'\ngit sparse-checkout disable'; fi
    _run_shell_view caws_bash_command_lines "$input"
    assert_success
    assert_output 'git sparse-checkout disable'
    run_guard worktree-guard.sh "$(hook_envelope Bash '' "$input")"
    assert_equal "$status" 2
    assert_output --partial 'BLOCKED: agent-issued git sparse-checkout'
  done
}

@test "read prefix: consumer04 six lines preserve exact bytes around only the projected Node body" {
  local prefix input expected quote trailing
  prefix="$(_read_prefix)"
  for quote in "'" '"'; do
    for trailing in '' $'\n' $'\n\n'; do
      input="$prefix"$'\n'"node <<${quote}NODE${quote}"$'\nconst rows = ["1"].map(l=>JSON.parse(l));\nNODE\ncaws status --json'"$trailing"
      expected="$prefix"$'\n'"node <<${quote}NODE${quote}"$'\n\nNODE\ncaws status --json'"$trailing"
      _run_blank_exact "$input"
      assert_success
      assert_output "${expected}__END__"
    done
  done
}

@test "read prefix: consumer04 arrow has no fake target while inspection and suffix command views survive" {
  local input
  input="$(_read_prefix)"$'\nnode <<\'NODE\'\nconst rows = ["1"].map(l=>JSON.parse(l));\nNODE\ncaws status --json'
  _run_shell_view caws_bash_mutation_candidates "$input"
  assert_success
  assert_output ''
  _run_shell_view caws_bash_command_lines "$input"
  assert_success
  assert_output $'git rev-parse --show-toplevel\ngit rev-parse HEAD\ngit branch --show-current\ngit status --short\ncaws status --json'
  _run_bwg "$input"
  assert_success
  refute_output --partial 'BLOCKED'
  refute_output --partial 'UNRESOLVED'
}

@test "read prefix: each finite inspection member accepts horizontal whitespace and literal dot path" {
  local prefix input expected
  for prefix in $' \tpwd\t-P  ' 'git rev-parse --show-toplevel' $'git\trev-parse\tHEAD\t' \
    ' git branch --show-current ' 'git status --short' 'cat AGENTS.md' $'\tcat\t./AGENTS.md  ' \
    'cat package.json' 'cat ./docs/file.md' 'cat ../AGENTS.md' 'cat /tmp/read_only.txt' 'cat ./-literal-file'; do
    input=$'\n'"$prefix"$'\n\tnode <<"JS"\nconst f = x => x > 0;\nJS\n'
    expected=$'\n'"$prefix"$'\n\tnode <<"JS"\n\nJS\n'
    _run_blank_exact "$input"
    assert_success
    assert_output "${expected}__END__"
  done
}

@test "read prefix: unsupported line after valid inspections keeps shell operations visible" {
  local unsafe input
  for unsafe in 'alias node=sh' $'shopt -s expand_aliases\nalias node=sh' \
    'node() { sh; }' 'function node { sh; }' 'eval alias node=sh' 'source ./lookup.sh' '. ./lookup.sh' \
    'hash -p /bin/sh node' 'builtin hash -p /bin/sh node' 'enable -f /tmp/override.so node' \
    'builtin enable -n node' 'PATH=/other/bin' 'export PATH=/other/bin' 'VAR=x' \
    'env node' 'command pwd -P' 'pwd -P; hash -p /bin/sh node' 'pwd -P && cat AGENTS.md' \
    'pwd -P | cat' 'cat AGENTS.md > /tmp/output' $'pwd -P \\\ncat AGENTS.md' \
    'cat $(printf AGENTS.md)' 'cat "$file"' 'cat `printf AGENTS.md`' \
    'git -c alias.status=other status --short' 'pwd -P # comment' \
    'cat --help' 'cat AGENTS.md*' 'cat AGENTS?.md' \
    'cat [AGENTS].md' 'cat ~/AGENTS.md' 'cat <AGENTS.md' 'echo plain-prefix' 'if true; then'; do
    input="$(_read_prefix)"$'\n'"$unsafe"$'\nnode <<\'SH\'\ngit sparse-checkout disable\nSH'
    _run_blank "$input"
    assert_success
    assert_output "$input"
    _run_shell_view caws_bash_command_lines "$input"
    assert_success
    assert_line 'git sparse-checkout disable'
  done
}

@test "read prefix: visible alias after inspections still refuses shell policy before simulated effects" {
  _seed_foreign_worktree
  local input marker="$BATS_TEST_TMPDIR/prefix-sentinel"
  input="$(_read_prefix)"$'\nshopt -s expand_aliases\nalias node=sh\nnode <<\'SH\'\ngit sparse-checkout disable\nSH'
  printf sentinel > "$marker"
  run_guard worktree-guard.sh "$(hook_envelope Bash '' "$input")"
  local guard_status="$status"
  if [[ "$guard_status" == 0 ]]; then printf changed > "$marker"; fi
  printf 'prefixed alias guard exit=%s sentinel=%s\n' "$guard_status" "$(cat "$marker")"
  assert_equal "$guard_status" 2
  assert_output --partial 'BLOCKED: agent-issued git sparse-checkout'
  assert_equal "$(cat "$marker")" sentinel
}

@test "read prefix: incomplete unquoted or multiple heredocs remain conservative" {
  local body input
  for body in $'node <<JS\n$(touch /foreign/file)\nJS' \
    $'node <<\'JS\'\nconst f = x => x;' \
    $'node <<\'JS\' <<\'OTHER\'\ngit sparse-checkout disable\nJS\nOTHER' \
    $'node <<\'JS\'\nconst f = x => x;\nJS\nnode <<\'OTHER\'\nconst g = x => x;\nOTHER'; do
    input="$(_read_prefix)"$'\n'"$body"
    _run_blank "$input"
    assert_success
    assert_output "$input"
  done
}

@test "read prefix: raw foreign Node write remains visible and refuses before simulated effects" {
  local foreign="$BATS_TEST_TMPDIR/prefixed-foreign" physical_foreign target input
  mkdir -p "$foreign"
  git -C "$foreign" init -q -b main
  physical_foreign="$(cd "$foreign" && pwd -P)"
  target="$foreign/sentinel.txt"
  printf sentinel > "$target"
  input="$(_read_prefix)"$'\n'"$(printf 'node <<%s\nrequire("fs").writeFileSync("%s", "changed");\nJS\n' "'JS'" "$target")"
  _run_blank "$input"
  assert_success
  refute_output --partial 'writeFileSync'
  _run_shell_view caws_bash_interpreter_write_literals "$input"
  assert_success
  assert_line "$target"
  _run_bwg "$input"
  local guard_status="$status"
  if [[ "$guard_status" == 0 ]]; then printf changed > "$target"; fi
  printf 'prefixed Node write guard exit=%s target=%s sentinel=%s\n' "$guard_status" "$target" "$(cat "$target")"
  assert_equal "$guard_status" 2
  assert_output --partial "BLOCKED: this Bash command mutates a file inside a DIFFERENT repository ($physical_foreign)"
  assert_equal "$(cat "$target")" sentinel
}

@test "read prefix: real outer writes before or after remain targets and refuse" {
  _seed_foreign_worktree
  local input body target position
  target="$(_foreign_payload)"
  printf sentinel > "$target"
  body=$'node <<\'JS\'\nconst f = x => x > 0;\nJS'
  for position in before after; do
    if [[ "$position" == before ]]; then
      input="$(_read_prefix)"$'\n'"echo changed > $target"$'\n'"$body"
      _run_blank "$input"
      assert_success
      assert_output "$input"
    else
      input="$(_read_prefix)"$'\n'"$body"$'\n'"echo changed > $target"
    fi
    _run_shell_view caws_bash_mutation_candidates "$input"
    assert_success
    assert_line "$target"
    if [[ "$position" == after ]]; then assert_output "$target"; fi
    _run_bwg "$input"
    local guard_status="$status"
    if [[ "$guard_status" == 0 ]]; then printf changed > "$target"; fi
    assert_equal "$guard_status" 2
    assert_output --partial "BLOCKED: this Bash command mutates worktree 'wt-seed''s payload"
    assert_equal "$(cat "$target")" sentinel
  done
}

@test "structural prefix: unchanged05 Git diff and policy cat project the literal Node body only" {
  local prefix input expected
  prefix=$'git diff -- .gitignore\ncat .caws/policy.yaml'
  input="$prefix"$'\nnode <<\'NODE\'\nconst fs=require("fs"),p=require("path"),c=require("crypto");for(const f of [{path:"file"}].filter(f=>f.path!==".gitignore")){console.log(p.basename(f.path),c.createHash("sha256"));}\nNODE\n'
  expected="$prefix"$'\nnode <<\'NODE\'\n\nNODE\n'
  _run_blank_exact "$input"
  assert_success
  assert_output "${expected}__END__"
  _run_shell_view caws_bash_mutation_candidates "$input"
  assert_success
  assert_output ''
}

@test "actual06 prefix: Git show oneline projects only the representative Node body" {
  local prefix input expected ending
  prefix="$(_postcommit_prefix)"
  for ending in '' $'\n' $'\n\n'; do
    input="$prefix"$'\nnode <<\'NODE\'\nconst fs=require("fs"),c=require("crypto");const rows=[{path:"file"}].filter(f=>f.path!==".gitignore").map(f=>f.path);\nNODE'"$ending"
    expected="$prefix"$'\nnode <<\'NODE\'\n\nNODE'"$ending"
    _run_blank_exact "$input"
    assert_success
    assert_output "${expected}__END__"
    _run_shell_view caws_bash_mutation_candidates "$input"
    assert_success
    assert_output ''
  done
}

@test "actual06 prefix: output execution and invalid oneline options retain the Node body" {
  local option input
  for option in '--oneline --output=target' '--oneline --ext-diff' '--oneline --textconv' '--oneline=unexpected'; do
    input=$'git rev-parse HEAD\n'"git show --stat $option HEAD"$'\ngit status --short\nnode <<\'NODE\'\nconst f=x=>x;\nNODE'
    _run_blank_exact "$input"
    assert_success
    assert_output "${input}__END__"
  done
}

@test "actual06 prefix: raw Node foreign write refuses before simulated effects" {
  local foreign="$BATS_TEST_TMPDIR/postcommit-foreign" physical_foreign target input
  mkdir -p "$foreign"
  git -C "$foreign" init -q -b main
  physical_foreign="$(cd "$foreign" && pwd -P)"
  target="$foreign/sentinel.txt"
  printf sentinel > "$target"
  input="$(_postcommit_prefix)"$'\n'"$(printf 'node <<%s\nrequire("fs").writeFileSync("%s", "changed");\nJS\n' "'JS'" "$target")"
  _run_blank "$input"
  assert_success
  refute_output --partial 'writeFileSync'
  _run_shell_view caws_bash_interpreter_write_literals "$input"
  assert_success
  assert_line "$target"
  _run_bwg "$input"
  local guard_status="$status"
  if [[ "$guard_status" == 0 ]]; then printf changed > "$target"; fi
  printf 'actual06 Node guard exit=%s target=%s sentinel=%s\n' "$guard_status" "$target" "$(cat "$target")"
  assert_equal "$guard_status" 2
  assert_output --partial "BLOCKED: this Bash command mutates a file inside a DIFFERENT repository ($physical_foreign)"
  assert_equal "$(cat "$target")" sentinel
}

@test "actual06 prefix: real outer writes before and after the body retain refusal" {
  _seed_foreign_worktree
  local target input body position
  target="$(_foreign_payload)"
  printf sentinel > "$target"
  body=$'node <<\'JS\'\nconst f=x=>x;\nJS'
  for position in before after; do
    if [[ "$position" == before ]]; then
      input="$(_postcommit_prefix)"$'\n'"echo changed > $target"$'\n'"$body"
    else
      input="$(_postcommit_prefix)"$'\n'"$body"$'\n'"echo changed > $target"
    fi
    _run_shell_view caws_bash_mutation_candidates "$input"
    assert_success
    assert_line "$target"
    _run_bwg "$input"
    local guard_status="$status"
    if [[ "$guard_status" == 0 ]]; then printf changed > "$target"; fi
    printf 'actual06 outer %s guard exit=%s sentinel=%s\n' "$position" "$guard_status" "$(cat "$target")"
    assert_equal "$guard_status" 2
    assert_output --partial "BLOCKED: this Bash command mutates worktree 'wt-seed''s payload"
    assert_equal "$(cat "$target")" sentinel
  done
}

@test "actual06 prefix: lookup override keeps shell policy refusal before simulated effects" {
  _seed_foreign_worktree
  local marker="$BATS_TEST_TMPDIR/postcommit-lookup-sentinel" input
  input="$(_postcommit_prefix)"$'\nshopt -s expand_aliases\nalias node=sh\nnode <<\'SH\'\ngit sparse-checkout disable\nSH'
  _run_blank "$input"
  assert_success
  assert_output "$input"
  printf sentinel > "$marker"
  run_guard worktree-guard.sh "$(hook_envelope Bash '' "$input")"
  local guard_status="$status"
  if [[ "$guard_status" == 0 ]]; then printf changed > "$marker"; fi
  printf 'actual06 alias guard exit=%s sentinel=%s\n' "$guard_status" "$(cat "$marker")"
  assert_equal "$guard_status" 2
  assert_output --partial 'BLOCKED: agent-issued git sparse-checkout'
  assert_equal "$(cat "$marker")" sentinel
}

@test "CAWS reader prefix: only the body is projected and false JS shell targets disappear" {
  local prefix input expected ending
  prefix="$(_caws_read_prefix)"
  for ending in '' $'\n' $'\n\n'; do
    input="$prefix"$'\nnode <<\'NODE\'\nconst rows=x.map(x=>JSON.parse(x));\nNODE'"$ending"
    expected="$prefix"$'\nnode <<\'NODE\'\n\nNODE'"$ending"
    _run_blank_exact "$input"
    assert_success
    assert_output "${expected}__END__"
    _run_shell_view caws_bash_mutation_candidates "$input"
    assert_success
    assert_output ''
  done
}

@test "CAWS effects and unknown options retain raw Node input" {
  local command input
  for command in 'caws specs recover EXAMPLE-001 --out target' \
    'caws specs verify-acs EXAMPLE-001 --run' 'caws status --unknown' \
    'caws specs show' 'caws specs show EXAMPLE-001 extra' 'env caws status'; do
    input="$command"$'\nnode <<\'N\'\nconst rows=x.map(x=>JSON.parse(x));\nN\n'
    _run_blank_exact "$input"
    assert_success
    assert_output "${input}__END__"
  done
}

@test "CAWS reader prefix: raw Node foreign write refuses before simulated effects" {
  local foreign="$BATS_TEST_TMPDIR/caws-foreign" physical_foreign target input
  mkdir -p "$foreign"
  git -C "$foreign" init -q -b main
  physical_foreign="$(cd "$foreign" && pwd -P)"
  target="$foreign/sentinel.txt"
  printf sentinel > "$target"
  input="$(_caws_read_prefix)"$'\n'"$(printf 'node <<%s\nrequire("fs").writeFileSync("%s", "changed");\nJS\n' "'JS'" "$target")"
  _run_blank "$input"
  assert_success
  refute_output --partial 'writeFileSync'
  _run_shell_view caws_bash_interpreter_write_literals "$input"
  assert_success
  assert_line "$target"
  _run_bwg "$input"
  local guard_status="$status"
  if [[ "$guard_status" == 0 ]]; then printf changed > "$target"; fi
  printf 'CAWS Node guard exit=%s target=%s sentinel=%s\n' "$guard_status" "$target" "$(cat "$target")"
  assert_equal "$guard_status" 2
  assert_output --partial "BLOCKED: this Bash command mutates a file inside a DIFFERENT repository ($physical_foreign)"
  assert_equal "$(cat "$target")" sentinel
}

@test "CAWS reader prefix: outer writes before and after retain specific refusal" {
  _seed_foreign_worktree
  local target input body position
  target="$(_foreign_payload)"
  printf sentinel > "$target"
  body=$'node <<\'JS\'\nconst rows=x.map(x=>JSON.parse(x));\nJS'
  for position in before after; do
    if [[ "$position" == before ]]; then
      input="$(_caws_read_prefix)"$'\n'"echo changed > $target"$'\n'"$body"
    else
      input="$(_caws_read_prefix)"$'\n'"$body"$'\n'"echo changed > $target"
    fi
    _run_shell_view caws_bash_mutation_candidates "$input"
    assert_success
    assert_line "$target"
    _run_bwg "$input"
    local guard_status="$status"
    if [[ "$guard_status" == 0 ]]; then printf changed > "$target"; fi
    printf 'CAWS outer %s guard exit=%s sentinel=%s\n' "$position" "$guard_status" "$(cat "$target")"
    assert_equal "$guard_status" 2
    assert_output --partial "BLOCKED: this Bash command mutates worktree 'wt-seed''s payload"
    assert_equal "$(cat "$target")" sentinel
  done
}

@test "CAWS reader prefix: lookup override refuses before simulated effects" {
  _seed_foreign_worktree
  local marker="$BATS_TEST_TMPDIR/caws-lookup-sentinel" input
  input="$(_caws_read_prefix)"$'\nshopt -s expand_aliases\nalias node=sh\nnode <<\'SH\'\ngit sparse-checkout disable\nSH'
  _run_blank "$input"
  assert_success
  assert_output "$input"
  printf sentinel > "$marker"
  run_guard worktree-guard.sh "$(hook_envelope Bash '' "$input")"
  local guard_status="$status"
  if [[ "$guard_status" == 0 ]]; then printf changed > "$marker"; fi
  printf 'CAWS lookup guard exit=%s sentinel=%s\n' "$guard_status" "$(cat "$marker")"
  assert_equal "$guard_status" 2
  assert_output --partial 'BLOCKED: agent-issued git sparse-checkout'
  assert_equal "$(cat "$marker")" sentinel
}
