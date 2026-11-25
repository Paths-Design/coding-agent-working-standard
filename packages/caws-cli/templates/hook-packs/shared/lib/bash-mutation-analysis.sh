#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: shared
# hook_pack_version: 1
# caws_min_major: 11
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
# Syntax observations only. Mutation roles and ownership policy remain downstream.
CAWS_AST_VALUE=(); CAWS_AST_KIND=(); CAWS_AST_DYNAMIC=(); CAWS_AST_RESOLUTION=()
CAWS_AST_UNREPR=(); CAWS_AST_CWD=(); CAWS_AST_ISSUES=()
CAWS_AST_INTERPRETER_TARGET=(); CAWS_AST_INTERPRETER_OPERATION=()
CAWS_AST_INTERPRETER_START=(); CAWS_AST_INTERPRETER_END=(); CAWS_AST_INTERPRETER_CWD=()
CAWS_AST_INTERPRETER_PAYLOAD_START=(); CAWS_AST_INTERPRETER_PAYLOAD_END=()
CAWS_AST_PROGRAM_KIND=(); CAWS_AST_PROGRAM_LANGUAGE=(); CAWS_AST_PROGRAM_CWD=(); CAWS_AST_PROGRAM_SOURCE=()
CAWS_AST_GIT_SUBCOMMAND=(); CAWS_AST_GIT_DIRECTORY=(); CAWS_AST_GIT_COMMON=()
CAWS_AST_GIT_WORKTREE=(); CAWS_AST_GIT_START=(); CAWS_AST_GIT_END=()
CAWS_AST_COPY_OPERATION=(); CAWS_AST_COPY_KNOWLEDGE=(); CAWS_AST_COPY_DESTINATION=()
CAWS_AST_COPY_DIRECTORY_MODE=(); CAWS_AST_COPY_CWD=(); CAWS_AST_COPY_START=(); CAWS_AST_COPY_END=()
CAWS_AST_COPY_SOURCE_OFFSET=(); CAWS_AST_COPY_SOURCE_COUNT=(); CAWS_AST_COPY_SOURCES=()
CAWS_BASH_ANALYSIS_READY=0
# "<origin>\t<absolute path>" evidence from interpreter source; origin is inline
# for source in the command and entry for a file it names.
CAWS_INTERPRETER_EVIDENCE=()

# The machine dispatcher points BASH_ENV at its own handler-env.sh so handlers
# load the runtime libraries, and saves the caller's value in
# CAWS_PRIOR_BASH_ENV. The analyzer models the agent's shell environment and
# reports an inherited BASH_ENV as unmodeled, so it must be given the caller's
# value: the dispatcher's own would mark every command as unanalyzable. A
# BASH_ENV the dispatcher did not set is passed through untouched.
caws_run_with_agent_bash_env() {
  if [[ ${CAWS_MACHINE_RUNTIME:-} == 1 && -n ${CAWS_SHARED_LIB_DIR:-} &&
        ${BASH_ENV:-} == "${CAWS_SHARED_LIB_DIR%/lib}/handler-env.sh" ]] &&
      declare -p CAWS_PRIOR_BASH_ENV >/dev/null 2>&1; then
    if [[ -n $CAWS_PRIOR_BASH_ENV ]]; then
      BASH_ENV="$CAWS_PRIOR_BASH_ENV" "$@"
    else
      ( unset BASH_ENV; "$@" )
    fi
  else
    "$@"
  fi
}

caws_bash_prepare_analysis() {
  local command="$1" cwd="$2" project="$3" cli="${CAWS_BIN:-caws}" json
  local -a context_args=()
  if [[ ${_CWD_RESOLVED:-0} != 1 ]]; then
    cwd="$project"
    if [[ ${_CWD_CONTRACT:-0} == 1 ]]; then
      context_args+=( --cwd-unresolved )
    fi
  fi
  CAWS_BASH_ANALYSIS_READY=0
  CAWS_BASH_ANALYSIS_ERROR='command mutation analysis is unavailable'
  command -v jq >/dev/null 2>&1 || return 2
  command -v "$cli" >/dev/null 2>&1 || return 2
  declare -F original_payload >/dev/null 2>&1 || return 2
  # The original envelope owns execution context. Parsed scalar exports cannot
  # replace its command aliases, dialect, startup choices or working directory.
  if ! json="$(original_payload |
      caws_run_with_agent_bash_env "$cli" hooks mutation-view --json --cwd "$cwd" --project "$project" ${context_args[@]+"${context_args[@]}"})"; then
    local codes
    codes="$(jq -ser '
      if length==1 and .[0].schema=="caws.shell_mutation_view.v2" and (.[0].issues|type)=="array"
      then [.[0].issues[].code | select(type=="string" and length>0 and length<=64 and test("^[a-z0-9_-]+$"))][:8] | unique | join(", ")
      else empty end
    ' <<< "$json" 2>/dev/null)" || codes=''
    CAWS_BASH_ANALYSIS_ERROR="command mutation analyzer failed${codes:+ ($codes)}"; return 2
  fi
  CAWS_AST_VALUE=(); CAWS_AST_KIND=(); CAWS_AST_DYNAMIC=(); CAWS_AST_RESOLUTION=()
  CAWS_AST_UNREPR=(); CAWS_AST_CWD=(); CAWS_AST_ISSUES=()
  CAWS_AST_INTERPRETER_TARGET=(); CAWS_AST_INTERPRETER_OPERATION=()
  CAWS_AST_INTERPRETER_START=(); CAWS_AST_INTERPRETER_END=(); CAWS_AST_INTERPRETER_CWD=()
  CAWS_AST_INTERPRETER_PAYLOAD_START=(); CAWS_AST_INTERPRETER_PAYLOAD_END=()
  CAWS_AST_PROGRAM_KIND=(); CAWS_AST_PROGRAM_LANGUAGE=(); CAWS_AST_PROGRAM_CWD=(); CAWS_AST_PROGRAM_SOURCE=()
  CAWS_AST_GIT_SUBCOMMAND=(); CAWS_AST_GIT_DIRECTORY=(); CAWS_AST_GIT_COMMON=()
  CAWS_AST_GIT_WORKTREE=(); CAWS_AST_GIT_START=(); CAWS_AST_GIT_END=()
  CAWS_AST_COPY_OPERATION=(); CAWS_AST_COPY_KNOWLEDGE=(); CAWS_AST_COPY_DESTINATION=()
  CAWS_AST_COPY_DIRECTORY_MODE=(); CAWS_AST_COPY_CWD=(); CAWS_AST_COPY_START=(); CAWS_AST_COPY_END=()
  CAWS_AST_COPY_SOURCE_OFFSET=(); CAWS_AST_COPY_SOURCE_COUNT=(); CAWS_AST_COPY_SOURCES=()
  local tag value kind dynamic resolution unrepr coordinate start end operation payload_start payload_end
  local subcommand directory common worktree
  local knowledge directory_mode copy_count copy_index
  local complete=0 malformed=0 execution_seen=0 execution_command='' execution_cwd=''
  while IFS= read -r -d '' tag; do
    [[ $complete == 0 ]] || { malformed=1; break; }
    case "$tag" in
      execution)
        [[ $execution_seen == 0 ]] || { malformed=1; break; }
        IFS= read -r -d '' execution_command && IFS= read -r -d '' execution_cwd || { malformed=1; break; }
        execution_seen=1 ;;
      token)
        IFS= read -r -d '' value && IFS= read -r -d '' kind &&
        IFS= read -r -d '' dynamic && IFS= read -r -d '' resolution &&
        IFS= read -r -d '' unrepr && IFS= read -r -d '' coordinate &&
        IFS= read -r -d '' start && IFS= read -r -d '' end || { malformed=1; break; }
        CAWS_AST_VALUE+=( "$value" ); CAWS_AST_KIND+=( "$kind" )
        CAWS_AST_DYNAMIC+=( "$dynamic" ); CAWS_AST_RESOLUTION+=( "$resolution" )
        CAWS_AST_UNREPR+=( "$unrepr" ); CAWS_AST_CWD+=( "$coordinate" ) ;;
      issue)
        IFS= read -r -d '' value || { malformed=1; break; }
        CAWS_AST_ISSUES+=( "$value" ) ;;
      git_metadata)
        IFS= read -r -d '' subcommand && IFS= read -r -d '' directory &&
        IFS= read -r -d '' common && IFS= read -r -d '' worktree &&
        IFS= read -r -d '' start && IFS= read -r -d '' end || { malformed=1; break; }
        if [[ "$directory$common$worktree" == *$'\n'* || "$directory$common$worktree" == *$'\r'* || "$directory$common$worktree" == *$'\t'* ]]; then
          CAWS_AST_ISSUES+=( git_metadata_unrepresentable )
        else
          CAWS_AST_GIT_SUBCOMMAND+=( "$subcommand" ); CAWS_AST_GIT_DIRECTORY+=( "$directory" )
          CAWS_AST_GIT_COMMON+=( "$common" ); CAWS_AST_GIT_WORKTREE+=( "$worktree" )
          CAWS_AST_GIT_START+=( "$start" ); CAWS_AST_GIT_END+=( "$end" )
        fi ;;
      interpreter_write)
        IFS= read -r -d '' value && IFS= read -r -d '' operation &&
        IFS= read -r -d '' start && IFS= read -r -d '' end &&
        IFS= read -r -d '' coordinate && IFS= read -r -d '' payload_start &&
        IFS= read -r -d '' payload_end || { malformed=1; break; }
        CAWS_AST_INTERPRETER_TARGET+=( "$value" ); CAWS_AST_INTERPRETER_OPERATION+=( "$operation" )
        CAWS_AST_INTERPRETER_START+=( "$start" ); CAWS_AST_INTERPRETER_END+=( "$end" )
        CAWS_AST_INTERPRETER_CWD+=( "$coordinate" )
        CAWS_AST_INTERPRETER_PAYLOAD_START+=( "$payload_start" ); CAWS_AST_INTERPRETER_PAYLOAD_END+=( "$payload_end" )
        # The row coordinate, rather than the envelope cwd or HOME, owns the
        # resolution. Missing relative coordinates cannot yield a FILE grant.
        if [[ "$value" != /* && -z "$coordinate" ]]; then
          CAWS_AST_ISSUES+=( interpreter_target_cwd_unresolved )
        fi ;;
      interpreter_source)
        IFS= read -r -d '' kind && IFS= read -r -d '' value &&
        IFS= read -r -d '' coordinate && IFS= read -r -d '' operation || { malformed=1; break; }
        CAWS_AST_PROGRAM_KIND+=( "$kind" ); CAWS_AST_PROGRAM_LANGUAGE+=( "$value" )
        CAWS_AST_PROGRAM_CWD+=( "$coordinate" ); CAWS_AST_PROGRAM_SOURCE+=( "$operation" ) ;;
      copy)
        IFS= read -r -d '' operation && IFS= read -r -d '' knowledge &&
          IFS= read -r -d '' value && IFS= read -r -d '' directory_mode &&
          IFS= read -r -d '' coordinate && IFS= read -r -d '' start &&
          IFS= read -r -d '' end && IFS= read -r -d '' copy_count || { malformed=1; break; }
        [[ "$copy_count" =~ ^[0-9]+$ && "$copy_count" -le 4096 ]] || { malformed=1; break; }
        CAWS_AST_COPY_OPERATION+=( "$operation" ); CAWS_AST_COPY_KNOWLEDGE+=( "$knowledge" )
        CAWS_AST_COPY_DESTINATION+=( "$value" ); CAWS_AST_COPY_DIRECTORY_MODE+=( "$directory_mode" )
        CAWS_AST_COPY_CWD+=( "$coordinate" ); CAWS_AST_COPY_START+=( "$start" ); CAWS_AST_COPY_END+=( "$end" )
        CAWS_AST_COPY_SOURCE_OFFSET+=( "${#CAWS_AST_COPY_SOURCES[@]}" )
        CAWS_AST_COPY_SOURCE_COUNT+=( "$copy_count" )
        copy_index=0
        while [[ $copy_index -lt $copy_count ]]; do
          IFS= read -r -d '' value || { malformed=1; break; }
          CAWS_AST_COPY_SOURCES+=( "$value" ); copy_index=$((copy_index + 1))
        done
        [[ $malformed == 0 ]] || break ;;
      complete) complete=1 ;;
      *) malformed=1; break ;;
    esac
  done < <(jq -sj --slurpfile request <(original_payload) '
    def span: (.start|type)=="number" and (.end|type)=="number" and
      .start>=0 and .end>=.start and .start==(.start|floor) and .end==(.end|floor);
    def coordinate($unknown_cwd): (.cwd==null and $unknown_cwd) or ((.cwd|type)=="string" and (.cwd|startswith("/")) and (.cwd|test("[\\r\\n\\t]")|not));
    def absolute: type=="string" and startswith("/");
    # Source offsets use JavaScript UTF-16 indices, including astral codepoints.
    def source_length: [explode[] | if .>65535 then 2 else 1 end] | add // 0;
    def bounded($length): span and .end<=$length;
    def language: .language=="node" or .language=="python";
    def transport_path:
      type=="string" and length>0 and
      (contains("\u0000")|not) and (contains("\r")|not) and
      (contains("\n")|not) and (contains("\t")|not) and
      (startswith("__INTERP__")|not);
    def effects:
      . as $row | .effects as $effects |
      ($effects|type)=="object" and ($effects.writes|type)=="array" and
      if $effects.kind=="unresolved" then
        ($effects|keys)==["kind","profile","reason","writes"] and
        $effects.profile==null and ($effects.reason|type)=="string" and ($effects.reason|length)>0 and
        ($effects.writes|length)==0
      elif $effects.kind=="readonly" or $effects.kind=="finite-writes" then
        ($effects|keys)==["kind","profile","writes"] and
        ($row.language=="node" and $effects.profile=="caws.node-source-effects.v1") and
        ($row.payloads|length)==1 and
        if $effects.kind=="readonly" then ($effects.writes|length)==0
        else ($effects.writes|length)>0 and
          all($effects.writes[]; (.target|transport_path) and
            (keys==["end","operation","start","target"]) and
            (.operation=="write" or .operation=="append") and
            bounded($row.payloads[0].text|source_length) and .end>.start)
        end
      else false end;
    def copy_operation($document):
      (keys==["cwd","destination","directoryMode","end","knowledge","operation","sources","start"]) and
      (.operation=="cp" or .operation=="mv") and
      coordinate($document.execution.cwd==null) and bounded($document.execution.command|source_length) and .end>.start and
      (.sources|type)=="array" and (.sources|length)<=4096 and
      if .knowledge=="finite" then
        (.sources|length)>0 and all(.sources[]; type=="string" and length>0) and
        (.destination|type)=="string" and (.destination|length)>0 and
        (.directoryMode=="auto" or .directoryMode=="directory")
      elif .knowledge=="readonly" or .knowledge=="unresolved" then
        (.sources|length)==0 and .destination==null and .directoryMode==null
      else false end;
    def valid:
      . as $document |
      type=="object" and .schema=="caws.shell_mutation_view.v2" and
      (.execution|type)=="object" and (.execution.command|type)=="string" and
      (.execution.command|utf8bytelength)<=65536 and
      (.execution.cwd==null or (.execution.cwd|absolute)) and
      ($request|length)==1 and ($request[0].tool_input|type)=="object" and
      ([$request[0].tool_input|to_entries[]|select(.key=="command" or .key=="cmd")|.value] as $sources |
        ($sources|length)>0 and all($sources[]; type=="string" and .==$document.execution.command)) and
      (.tokens|type)=="array" and (.issues|type)=="array" and (.interpreters|type)=="array" and
      (.interpreterInvocations|type)=="array" and
      (.gitMetadata|type)=="array" and
      (.copyInvocations|type)=="array" and (.copyInvocations|length)<=4096 and
      (.copyOperations|type)=="array" and (.copyOperations|length)<=4096 and
      all(.copyInvocations[]; (keys==["end","operation","start"]) and
        (.operation=="cp" or .operation=="mv") and bounded($document.execution.command|source_length) and .end>.start) and
      all(.copyOperations[]; copy_operation($document)) and
      ([.copyInvocations[]|[.operation,.start,.end]]==[.copyOperations[]|[.operation,.start,.end]]) and
      all(.tokens[]; (.value|type)=="string" and
        (.kind as $k | ["word","op","redirect","input_redirect","unsupported_nesting"]|index($k))!=null and
        (.dynamic|type)=="boolean" and (.resolution=="" or .resolution=="runtime") and
        (.dynamic == (.resolution=="runtime")) and .prefix=="" and .prefixBasis=="none" and
        (.unrepresentable|type)=="boolean" and coordinate($document.execution.cwd==null) and bounded($document.execution.command|source_length) and
        (.unrepresentable or ((.value|contains("\n")|not) and (.value|contains("\t")|not)))) and
      all(.issues[]; (.code|type)=="string" and (.message|type)=="string" and bounded($document.execution.command|source_length)) and
      all(.interpreterInvocations[]; language and bounded($document.execution.command|source_length)) and
      (if (.issues|length)==0 then
        ([.interpreterInvocations[]|[.language,.start,.end]]==[.interpreters[]|[.language,.start,.end]])
        else true end) and
      # A directory the command changed into can be unknown on its own row.
      all(.interpreters[]; language and coordinate(true) and bounded($document.execution.command|source_length) and
        (.argv|type)=="array" and (.argv|length)>0 and all(.argv[]; .==null or type=="string") and
        (.argv[0]|type)=="string" and
        (if .language=="node" then (.argv[0]|split("/")|last|.=="node" or .=="nodejs")
          else (.argv[0]|split("/")|last|test("^python([0-9]+(\\.[0-9]+)*)?$")) end) and
        (.payloads|type)=="array" and (.payloads|length)<=32 and all(.payloads[];
          (.text|type)=="string" and (.origin=="argument" or .origin=="heredoc") and
          bounded($document.execution.command|source_length)) and
        (if .launch=="program" then .effects.kind=="unresolved" and all(.payloads[]; .origin=="heredoc")
          else (.launch==null or .launch=="inline") and (.payloads|length)<=1 and .rewritten!=true end) and
        (.rewritten==null or (.rewritten|type)=="boolean") and
        (.entry==null or ((.entry|type)=="string" and .launch=="program")) and effects) and
      all(.gitMetadata[]; (.subcommand|type)=="string" and (.subcommand|test("^[A-Za-z0-9][A-Za-z0-9._-]*$")) and
        (.directory|absolute) and (.common|absolute) and (.worktree|absolute) and bounded($document.execution.command|source_length)) and
      all(..|strings; contains("\u0000")|not);
    def frame: .[] | tostring + "\u0000";
    if length!=1 then error("one mutation-view document required") else .[0] end |
    if valid then
      (["execution",.execution.command,(.execution.cwd//"")]|frame),
      (.tokens[] | ["token",.value,.kind,(if .dynamic then 1 else 0 end),.resolution,
        (if .unrepresentable then 1 else 0 end),(.cwd//""),.start,.end] | frame),
      (.issues[] | ["issue",(.code+": "+.message)] | frame),
      # A backend that does not say how source was launched has not read it.
      (.interpreters[] | . as $row |
        if .launch=="program" then
          (.payloads[] | ["interpreter_source","submitted",$row.language,($row.cwd//""),.text]|frame),
          (select(.entry!=null) | if .rewritten==true then "rewritten" elif (.payloads|length)==0 then "entry"
            else empty end | ["interpreter_source",.,$row.language,($row.cwd//""),$row.entry]|frame)
        elif .effects.kind=="unresolved" and .launch=="inline" and (.payloads|length)==1 then
          (["interpreter_source","inline",.language,(.cwd//""),.payloads[0].text]|frame)
        elif .effects.kind=="unresolved" then
          (["issue",("mutation-interpreter-effects: "+.effects.reason)]|frame)
        else .effects.writes[] |
          ["interpreter_write",.target,.operation,.start,.end,($row.cwd//""),
            $row.payloads[0].start,$row.payloads[0].end]|frame
        end),
      (.gitMetadata[] | ["git_metadata",.subcommand,.directory,.common,.worktree,.start,.end]|frame),
      (.copyOperations[] | (["copy",.operation,.knowledge,(.destination//""),(.directoryMode//""),
        (.cwd//""),.start,.end,(.sources|length)]+.sources)|frame),
      (["complete"]|frame)
    else error("invalid caws.shell_mutation_view.v2 response") end
  ' <<< "$json")
  if [[ $complete != 1 || $malformed != 0 || $execution_seen != 1 ]]; then
    CAWS_BASH_ANALYSIS_ERROR='command mutation analyzer returned an invalid or incomplete contract'; return 2
  fi
  # All downstream roles, relative-path checks and cache identity use the same
  # decoded context as projection. A project placeholder never becomes proof.
  COMMAND="$execution_command"
  if [[ -n "$execution_cwd" ]]; then
    AGENT_CWD="$execution_cwd"; _CWD_RESOLVED=1
  else
    AGENT_CWD="$project"; _CWD_RESOLVED=0; _CWD_CONTRACT=1
  fi
  CAWS_BASH_ANALYSIS_COMMAND="$execution_command"; CAWS_BASH_ANALYSIS_READY=1
  return 0
}

caws_bash_load_analysis_tokens() {
  [[ ${CAWS_BASH_ANALYSIS_READY:-0} == 1 && "$1" == "${CAWS_BASH_ANALYSIS_COMMAND-}" ]] || return 2
  CAWS_TOK_VALUE=( ${CAWS_AST_VALUE[@]+"${CAWS_AST_VALUE[@]}"} )
  CAWS_TOK_KIND=( ${CAWS_AST_KIND[@]+"${CAWS_AST_KIND[@]}"} )
  CAWS_TOK_DYNAMIC=( ${CAWS_AST_DYNAMIC[@]+"${CAWS_AST_DYNAMIC[@]}"} )
  CAWS_TOK_RESKIND=( ${CAWS_AST_RESOLUTION[@]+"${CAWS_AST_RESOLUTION[@]}"} )
  CAWS_TOK_UNREPR=( ${CAWS_AST_UNREPR[@]+"${CAWS_AST_UNREPR[@]}"} )
  CAWS_TOK_CWD=( ${CAWS_AST_CWD[@]+"${CAWS_AST_CWD[@]}"} )
  CAWS_TOK_CTX=(); CAWS_TOK_PREFIX=(); CAWS_TOK_PREFIX_BASIS=()
  local i=0
  while [[ $i -lt ${#CAWS_TOK_VALUE[@]} ]]; do
    CAWS_TOK_CTX+=( root ); CAWS_TOK_PREFIX+=( '' ); CAWS_TOK_PREFIX_BASIS+=( none ); i=$((i+1))
  done
  return 0
}

# Proven interpreter operands join the same FILE stream as shell operands.
# Weak literal observations are intentionally absent from the mandatory path.
caws_bash_analysis_interpreter_writes() {
  [[ ${CAWS_BASH_ANALYSIS_READY:-0} == 1 && "$1" == "${CAWS_BASH_ANALYSIS_COMMAND-}" ]] || return 2
  local i=0 target coordinate
  while [[ $i -lt ${#CAWS_AST_INTERPRETER_TARGET[@]} ]]; do
    target="${CAWS_AST_INTERPRETER_TARGET[$i]}"; coordinate="${CAWS_AST_INTERPRETER_CWD[$i]}"
    case "$target" in
      /*) printf '%s\n' "$target" ;;
      *) [[ -z "$coordinate" ]] || printf '%s/%s\n' "$coordinate" "$target" ;;
    esac
    i=$((i+1))
  done
  return 0
}

# Names that give inline source a way to write or to start a program. Source in
# the command is fully visible, so these reach past the verbs that mark a file
# as a writer.
CAWS_NODE_WRITE_MENTIONS='(^|[^A-Za-z0-9_])(writeFile|appendFile|createWriteStream|copyFile|cp|truncate|ftruncate|rename|unlink|rm|rmdir|symlink|link|open|write|exec|execFile|spawn)(Sync)?[[:space:]]*(\(|[^A-Za-z0-9_[:space:]]|$)|child_process|\][[:space:]]*\('
CAWS_PY_WRITE_MENTIONS="\.(unlink|rename|rmdir|mkdir|touch|symlink_to|hardlink_to|symlink|link|truncate|extractall|system|popen|exec[lv]p?e?|spawn[lv]p?e?|rmtree|copytree|copy2|makedirs)\(|(^|[^A-Za-z0-9_.])(unlink|rmtree|copytree|copy2|makedirs|system|popen)\(|(^|[^A-Za-z0-9_])subprocess([^A-Za-z0-9_]|$)|\.open\([[:space:]]*['\"][rwabtx+]*[wax+]"
# Calls that write a file, and the same calls with a literal first operand.
CAWS_NODE_FILE_WRITES='(writeFile|appendFile|createWriteStream|copyFile|rename|unlink|truncate)(Sync)?[[:space:]]*\('
CAWS_NODE_NAMED_TARGET="(writeFile|appendFile|createWriteStream|copyFile|rename|unlink|truncate|open)(Sync)?\([[:space:]]*['\"\`]"
CAWS_PY_NAMED_TARGET="((^|[^A-Za-z0-9_])(open|Path)|os\.(replace|rename|remove|unlink)|shutil\.(copyfile|copy|move))\([[:space:]]*['\"]"

# Reads a complete Python program on stdin and prints what its write operands
# can be, following names, joins and simple calls back to literals:
#   T <path>  a write to this path, or to something under it
#   W <text>  text a write or a started program may use as a path
#   U         a write whose target no literal reaches
#   X         another program is started
#   C <path>  a directory the program changes into ("C" alone when unknown)
# It exits non-zero for source it cannot read, and never runs any of it.
CAWS_PY_WRITE_TARGETS='
import ast
import posixpath
import re
import shlex
import sys

raw = sys.stdin.buffer.read(524289)
if len(raw) > 524288:
    sys.exit(3)
tree = ast.parse(raw)
nodes = list(ast.walk(tree))
if len(nodes) > 32768:
    sys.exit(3)

SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef,
          ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)
FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef)
UNKNOWN = [(None, False, True)]
STAR = {
    "os": "remove unlink rename replace renames rmdir removedirs mkdir makedirs system popen link symlink truncate chdir",
    "shutil": "copy copy2 copyfile copytree move rmtree make_archive unpack_archive",
    "pathlib": "Path PurePath PosixPath",
    "subprocess": "run call check_call check_output Popen getoutput getstatusoutput",
    "os.path": "join abspath expanduser dirname",
}
FIRST = set("os.remove os.unlink os.rmdir os.removedirs os.mkdir os.makedirs os.truncate os.chmod "
            "os.chown os.utime os.mkfifo os.mknod shutil.rmtree shelve.open sqlite3.connect "
            "logging.FileHandler numpy.save numpy.savetxt numpy.savez".split())
SECOND = set("shutil.copy shutil.copy2 shutil.copyfile shutil.copytree os.link os.symlink "
             "urllib.request.urlretrieve".split())
BOTH = set("os.rename os.replace os.renames shutil.move".split())
OPENERS = set("open builtins.open io.open codecs.open gzip.open bz2.open lzma.open tarfile.open "
              "zipfile.ZipFile tarfile.TarFile".split())
METHODS = set("write_text write_bytes unlink rmdir mkdir touch symlink_to hardlink_to chmod".split())
SAVERS = set("to_csv to_json to_excel to_parquet to_pickle to_markdown to_html savefig tofile".split())
COMMANDS = set("os.system os.popen".split())
SAME = set("str os.fspath os.fsdecode os.path.abspath os.path.realpath os.path.normpath "
           "os.path.expanduser os.path.expandvars sorted list tuple set reversed iter next".split())
KEEP = set("resolve absolute expanduser strip rstrip lstrip as_posix decode encode get pop items "
           "keys values copy setdefault".split())
READERS = set("ls cat head tail wc grep rg stat file diff du pwd echo which basename dirname".split())
GIT_READERS = set("log show diff status rev-parse rev-list ls-files ls-tree grep cat-file blame "
                  "describe merge-base shortlog for-each-ref show-ref".split())

scope_of = {}
parent_of = {}
bindings = {}
globals_of = {}
aliases = {}
functions = {}
parameters = {}
calls = []
found = set()
changed = []
steps = 0


def tick():
    global steps
    steps += 1
    if steps > 200000:
        sys.exit(3)


def place(node, scope):
    scope_of[id(node)] = scope
    inner = scope
    if isinstance(node, SCOPES):
        inner = node
        parent_of[id(node)] = scope
    for field, value in ast.iter_fields(node):
        for child in value if isinstance(value, list) else [value]:
            if isinstance(child, ast.AST):
                outside = field in ("decorator_list", "args", "returns", "bases", "keywords")
                place(child, scope if outside and not isinstance(node, SCOPES[4:]) else inner)


sys.setrecursionlimit(4000)
place(tree, tree)


def chain(scope):
    while scope is not None:
        yield scope
        scope = parent_of.get(id(scope))


class Field:
    """One field of a value that is unpacked, or of each row of one iterated."""

    def __init__(self, value, index, count, rows):
        self.value, self.index, self.count, self.rows = value, index, count, rows


def bind(scope, name, value):
    owners = [scope]
    if name in globals_of.get(id(scope), ()):
        owners = list(chain(scope))[1:] or [tree]
    for owner in owners:
        bindings.setdefault((id(owner), name), []).append(value)


def bind_target(target, value, rows=False):
    if isinstance(target, ast.Name):
        bind(scope_of[id(target)], target.id, value)
    elif isinstance(target, ast.Attribute):
        bindings.setdefault(("attribute", target.attr), []).append(value)
    elif isinstance(target, (ast.Subscript, ast.Starred)):
        bind_target(target.value, value, rows)
    elif isinstance(target, (ast.Tuple, ast.List)):
        for index, item in enumerate(target.elts):
            bind_target(item, Field(value, index, len(target.elts), rows))


for node in nodes:
    if isinstance(node, (ast.Global, ast.Nonlocal)):
        globals_of.setdefault(id(scope_of[id(node)]), set()).update(node.names)
for node in nodes:
    tick()
    if isinstance(node, ast.Import):
        for item in node.names:
            aliases[item.asname or item.name.split(".")[0]] = item.name if item.asname else item.name.split(".")[0]
    elif isinstance(node, ast.ImportFrom):
        for item in node.names:
            if item.name == "*":
                for name in STAR.get(node.module or "", "").split():
                    aliases[name] = node.module + "." + name
            else:
                aliases[item.asname or item.name] = (node.module or "") + "." + item.name
    elif isinstance(node, ast.Assign):
        for target in node.targets:
            bind_target(target, node.value)
            if isinstance(scope_of[id(node)], ast.ClassDef) and isinstance(target, ast.Name):
                bindings.setdefault(("attribute", target.id), []).append(node.value)
    elif isinstance(node, (ast.AnnAssign, ast.NamedExpr)):
        if node.value is not None:
            bind_target(node.target, node.value)
    elif isinstance(node, ast.AugAssign):
        bind_target(node.target, ast.BinOp(left=node.target, op=node.op, right=node.value))
    elif isinstance(node, (ast.For, ast.AsyncFor, ast.comprehension)):
        bind_target(node.target, node.iter, True)
    elif isinstance(node, ast.withitem) and node.optional_vars is not None:
        bind_target(node.optional_vars, node.context_expr)
    elif isinstance(node, ast.Lambda):
        for item in [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]:
            bindings.setdefault((id(node), item.arg), [])
    elif isinstance(node, FUNCTIONS):
        functions.setdefault(node.name, []).append(node)
        ordered = [*node.args.posonlyargs, *node.args.args]
        for item in (node.args.vararg, node.args.kwarg):
            if item is not None:
                bindings.setdefault((id(node), item.arg), [])
        skip = 1 if ordered and ordered[0].arg in ("self", "cls") else 0
        for index, item in enumerate(ordered):
            parameters[(id(node), item.arg)] = (node.name, index - skip, item.arg)
        for item in node.args.kwonlyargs:
            parameters[(id(node), item.arg)] = (node.name, None, item.arg)
        defaults = list(zip(ordered[len(ordered) - len(node.args.defaults):], node.args.defaults))
        for item, value in defaults + list(zip(node.args.kwonlyargs, node.args.kw_defaults)):
            if value is not None:
                bindings.setdefault((id(node), item.arg), []).append(value)
    elif isinstance(node, ast.Call):
        calls.append(node)


def lookup(node):
    for scope in chain(scope_of.get(id(node), tree)):
        key = (id(scope), node.id)
        if key in bindings or key in parameters:
            return key
    return None


def qualified(node, depth=0):
    if isinstance(node, ast.Name):
        key = lookup(node)
        if key is None:
            return aliases.get(node.id, node.id)
        values = bindings.get(key, [])
        if depth < 4 and len(values) == 1 and isinstance(values[0], (ast.Name, ast.Attribute)):
            return qualified(values[0], depth + 1)
        return "." + node.id
    if isinstance(node, ast.Attribute):
        return qualified(node.value, depth) + "." + node.attr
    if isinstance(node, ast.Call) and qualified(node.func, depth) == "getattr" and len(node.args) > 1:
        if isinstance(node.args[1], ast.Constant):
            return qualified(node.args[0], depth) + "." + str(node.args[1].value)
    return "?"


def limited(values):
    unique = list(dict.fromkeys(values))
    return unique if len(unique) <= 2048 else unique[:2048] + [(None, False, True)]


def bounded(left, right):
    # Too many combinations: what precedes the join still locates the target.
    return right if len(left) * len(right) <= 2048 else [(None, False, True)]


def joined(left, right):
    out = []
    right = bounded(left, right)
    for text, exact, strong in left:
        for more, whole, sure in right:
            if more is not None and more[:1] in ("/", "~"):
                out.append((more, whole, strong and sure))
            elif text is None:
                out.append((None, False, strong))
            elif not exact or more is None:
                out.append((text.rstrip("/") + "/" if exact else text, False, strong))
            else:
                out.append((posixpath.join(text, more), whole, strong and sure))
    return limited(out)


def added(left, right):
    out = []
    right = bounded(left, right)
    for text, exact, strong in left:
        for more, whole, sure in right:
            if text is None or not exact:
                out.append((text, False, strong))
            else:
                out.append((text + (more or ""), whole and more is not None, strong and sure))
    return limited(out)


def prefixes(values):
    return limited([(text, False, strong) for text, exact, strong in values])


def parents(values):
    return limited([(None if text is None else posixpath.dirname(text.rstrip("/")) or ".", exact, strong)
                    for text, exact, strong in values])


def fold(values, rest, seen):
    for item in rest:
        values = joined(values, evaluate(item, seen))
    return values


def mentions(node):
    out = []
    for item in ast.walk(node):
        if isinstance(item, ast.Constant) and isinstance(item.value, str):
            if "/" in item.value or item.value.startswith("~"):
                out.append((item.value, False, False))
    return out


def home(text):
    return re.sub(r"^\$(?:HOME|\{HOME\})(?=/|$)", "~", text)


def literals(node, depth=0):
    """The literal collections a value can be."""
    if isinstance(node, (ast.List, ast.Tuple, ast.Set, ast.Dict)):
        return [node]
    if isinstance(node, ast.Name) and depth < 4:
        return [item for value in bindings.get(lookup(node), [])
                for item in literals(value, depth + 1)]
    return []


def field(node, seen):
    """What one unpacked field holds; the whole value when its shape is unknown."""
    value, index = node.value, node.index
    if isinstance(value, Field):
        return evaluate(value, seen)
    if isinstance(value, ast.Call):
        name = qualified(value.func)
        if name == "enumerate" and node.rows and value.args:
            return evaluate(value.args[0], seen) if index == 1 else []
        if name == "zip" and node.rows and index < len(value.args):
            return evaluate(value.args[index], seen)
        if isinstance(value.func, ast.Attribute) and value.func.attr == "items" and index < 2:
            tables = literals(value.func.value)
            if tables and all(isinstance(item, ast.Dict) for item in tables):
                cells = [cell for item in tables for cell in (item.values if index else item.keys)]
                return limited([entry for cell in cells for entry in evaluate(cell, seen)])
    out = []
    for item in literals(value):
        rows = getattr(item, "elts", []) if node.rows else [item]
        for row in rows:
            if not isinstance(row, (ast.Tuple, ast.List)) or len(row.elts) != node.count:
                return evaluate(value, seen)
            out += evaluate(row.elts[index], seen)
    return limited(out) if out else evaluate(value, seen)


def evaluate(node, seen=()):
    tick()
    if node is None or id(node) in seen or len(seen) > 40:
        return []
    seen = seen + (id(node),)
    if isinstance(node, Field):
        return field(node, seen)
    if isinstance(node, ast.Constant):
        if isinstance(node.value, bytes):
            return [(node.value.decode("utf-8", "replace"), True, True)]
        return [(home(node.value), True, True)] if isinstance(node.value, str) else []
    if isinstance(node, ast.JoinedStr):
        values = [("", True, True)]
        for part in node.values:
            values = added(values, evaluate(part, seen))
        return values
    if isinstance(node, ast.FormattedValue):
        return evaluate(node.value, seen) or UNKNOWN
    if isinstance(node, ast.BinOp):
        left, right = evaluate(node.left, seen), evaluate(node.right, seen)
        if isinstance(node.op, ast.Div):
            return joined(left, right or UNKNOWN)
        if isinstance(node.op, ast.Add):
            return added(left, right or UNKNOWN) if left else right
        return prefixes(left) if isinstance(node.op, ast.Mod) else UNKNOWN
    if isinstance(node, ast.Name):
        key = lookup(node)
        if key is None:
            return UNKNOWN
        values = [value for item in bindings.get(key, []) for value in evaluate(item, seen)]
        if key in parameters:
            name, index, keyword = parameters[key]
            supplied = [call for call in calls if isinstance(call.func, (ast.Name, ast.Attribute))
                        and (call.func.id if isinstance(call.func, ast.Name) else call.func.attr) == name]
            for call in supplied:
                given = [item.value for item in call.keywords if item.arg == keyword]
                if index is not None and 0 <= index < len(call.args):
                    given.append(call.args[index])
                spread = any(isinstance(item, ast.Starred) for item in call.args)
                for item in given:
                    values += evaluate(item, seen)
                if spread or any(item.arg is None for item in call.keywords):
                    values += UNKNOWN
            if not supplied and not values:
                return UNKNOWN
        return limited(values)
    if isinstance(node, ast.Attribute):
        name = qualified(node)
        if name in ("os.devnull", "os.path.devnull"):
            return [("/dev/null", True, True)]
        if name in ("os.curdir", "os.path.curdir"):
            return [(".", True, True)]
        if node.attr == "parent":
            return parents(evaluate(node.value, seen))
        if node.attr in ("name", "stem", "suffix", "path"):
            values = evaluate(node.value, seen)
            if node.attr == "path":
                return values
            return limited([(None if text is None else posixpath.basename(text), exact, strong)
                            for text, exact, strong in values])
        values = [value for item in bindings.get(("attribute", node.attr), [])
                  for value in evaluate(item, seen)]
        return limited(values) if values else UNKNOWN
    if isinstance(node, ast.Subscript):
        if qualified(node.value) == "os.environ":
            return environment(node.slice)
        if isinstance(node.value, ast.Attribute) and node.value.attr == "parents":
            return prefixes(parents(evaluate(node.value.value, seen)))
        if qualified(node.value) == "sys.argv":
            return UNKNOWN
        return evaluate(node.value, seen) or UNKNOWN
    if isinstance(node, ast.IfExp):
        return limited(evaluate(node.body, seen) + evaluate(node.orelse, seen))
    if isinstance(node, (ast.BoolOp, ast.List, ast.Tuple, ast.Set)):
        items = node.values if isinstance(node, ast.BoolOp) else node.elts
        return limited([value for item in items for value in evaluate(item, seen)])
    if isinstance(node, ast.Dict):
        return limited([value for item in [*node.keys, *node.values] for value in evaluate(item, seen)])
    if isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp)):
        return evaluate(node.elt, seen)
    if isinstance(node, ast.DictComp):
        return limited(evaluate(node.key, seen) + evaluate(node.value, seen))
    if isinstance(node, (ast.Starred, ast.Await, ast.NamedExpr)):
        return evaluate(node.value, seen)
    if isinstance(node, ast.Call):
        return called(node, seen)
    return UNKNOWN


def environment(node):
    node = getattr(node, "value", node) if type(node).__name__ == "Index" else node
    name = node.value if isinstance(node, ast.Constant) else None
    known = {"HOME": "~", "PWD": ".", "TMPDIR": "/tmp"}
    return [(known[name], True, True)] if name in known else UNKNOWN


def called(node, seen):
    name = qualified(node.func)
    first = node.args[0] if node.args else None
    if name in ("os.path.join", "posixpath.join"):
        return fold(evaluate(first, seen), node.args[1:], seen)
    if name.split(".")[-1] in ("Path", "PurePath", "PosixPath", "PurePosixPath"):
        return fold(evaluate(first, seen), node.args[1:], seen) if first is not None else [(".", True, True)]
    if name in SAME:
        return evaluate(first, seen)
    if name in ("enumerate", "zip", "itertools.chain"):
        return limited([value for item in node.args for value in evaluate(item, seen)])
    if name in ("filter", "map"):
        values = limited([value for item in node.args[1:] for value in evaluate(item, seen)])
        kept = name == "filter" or qualified(first) in SAME or qualified(first).split(".")[-1] == "Path"
        return values if kept else limited(UNKNOWN + [(text, False, False) for text, exact, strong in values if text])
    if name == "os.path.dirname":
        return parents(evaluate(first, seen))
    if name == "os.path.basename":
        return limited([(None if text is None else posixpath.basename(text), exact, strong)
                        for text, exact, strong in evaluate(first, seen)])
    if name in ("os.getcwd", "pathlib.Path.cwd", "Path.cwd"):
        return [(".", True, True)]
    if name in ("pathlib.Path.home", "Path.home"):
        return [("~", True, True)]
    if name in ("os.environ.get", "os.getenv"):
        values = environment(first)
        return values if values is not UNKNOWN else limited(
            UNKNOWN + [value for item in node.args[1:] for value in evaluate(item, seen)])
    if name.startswith("tempfile."):
        return [("/tmp/", False, True)]
    if name in ("glob.glob", "glob.iglob", "os.listdir", "os.scandir", "os.walk"):
        return prefixes(evaluate(first, seen))
    if isinstance(node.func, ast.Attribute):
        attribute, receiver = node.func.attr, node.func.value
        if attribute == "joinpath":
            return fold(evaluate(receiver, seen), node.args, seen)
        if attribute in ("glob", "rglob", "iterdir"):
            return prefixes(evaluate(receiver, seen))
        if attribute in KEEP:
            return evaluate(receiver, seen)
        if attribute in ("with_name", "with_suffix", "with_stem"):
            return prefixes(parents(evaluate(receiver, seen)))
        if attribute in ("split", "splitlines"):
            separator = first.value if isinstance(first, ast.Constant) else None
            out = []
            for text, exact, strong in evaluate(receiver, seen):
                if text is None or not exact:
                    out.append((text, False, strong))
                else:
                    pieces = text.splitlines() if attribute == "splitlines" else text.split(separator or None)
                    out += [(piece, True, strong) for piece in pieces]
            return limited(out)
        if attribute == "format":
            return limited([(None if text is None else text.split("{")[0] or None, False, strong)
                            for text, exact, strong in evaluate(receiver, seen)])
        if attribute == "replace" and len(node.args) == 2:
            return prefixes(evaluate(receiver, seen)) + mentions(node)
    local = functions.get(node.func.id if isinstance(node.func, ast.Name) else
                          node.func.attr if isinstance(node.func, ast.Attribute) else "", [])
    values = []
    for function in local:
        for item in ast.walk(function):
            if isinstance(item, (ast.Return, ast.Yield)) and item.value is not None:
                values += evaluate(item.value, seen)
    return limited(values) if values else limited(UNKNOWN + mentions(node))


def emit(values, sure=True):
    if not values:
        return
    for text, exact, strong in values:
        if text is None:
            if sure:
                found.add("U")
        elif text == "" or re.search(r"[\x00-\x1f]", text):
            continue
        elif strong:
            found.add("T " + text)
        else:
            found.add("W " + text)


def target(node):
    if node is None:
        found.add("U")
    elif not (isinstance(node, ast.Constant) and not isinstance(node.value, (str, bytes))):
        emit(evaluate(node) or UNKNOWN)


def argument(call, index, *names):
    for item in call.keywords:
        if item.arg in names:
            return item.value
    if any(isinstance(item, ast.Starred) for item in call.args[:index + 1]):
        return call.args[0]
    return call.args[index] if index < len(call.args) else None


def writes(mode):
    if mode is None:
        return False
    values = evaluate(mode)
    if not values or any(text is None or not exact for text, exact, strong in values):
        return True
    return any(set(text) & set("wax+") for text, exact, strong in values)


def reading(words):
    words = [word for word in words if word]
    if not words:
        return False
    name = posixpath.basename(words[0])
    if name == "git":
        rest = words[1:]
        while rest and rest[0] in ("-C", "--no-pager"):
            rest = rest[2 if rest[0] == "-C" else 1:]
        return bool(rest) and rest[0] in GIT_READERS and not any(
            word.startswith(("--out", "-o", "--ext")) for word in rest)
    return name in READERS


def started(call):
    command = call.args[0] if call.args else None
    words = None
    if isinstance(command, (ast.List, ast.Tuple)):
        items = command.elts
        if all(isinstance(item, ast.Constant) and isinstance(item.value, str) for item in items):
            words = [item.value for item in items]
    elif isinstance(command, ast.Constant) and isinstance(command.value, str):
        if not re.search(r"[<>|;&$`\n(]", command.value):
            try:
                words = shlex.split(command.value)
            except ValueError:
                words = None
    if words is not None and reading(words):
        return
    found.add("X")
    for item in ast.walk(call):
        if isinstance(item, ast.Constant) and isinstance(item.value, str):
            for piece in re.split(r"[\s\x27\x22<>|;&()=]+", item.value):
                if "/" in piece or piece.startswith("~"):
                    emit([(home(piece), True, False)])
        elif isinstance(item, ast.Name):
            emit([value for value in evaluate(item) if value[0] and "/" in value[0]], False)


def writer(name):
    return name in FIRST or name in SECOND or name in BOTH or name in OPENERS


for call in calls:
    tick()
    name = qualified(call.func)
    attribute = call.func.attr if isinstance(call.func, ast.Attribute) else None
    if name in OPENERS:
        if writes(argument(call, 1, "mode")) or any(item.arg is None for item in call.keywords):
            target(argument(call, 0, "file", "filename", "name"))
    elif name == "os.open":
        flags = argument(call, 1, "flags")
        if flags is None or re.search("WRONLY|RDWR|CREAT|APPEND|TRUNC", ast.dump(flags)) or isinstance(flags, ast.Name):
            target(argument(call, 0, "path"))
    elif name in FIRST:
        target(argument(call, 0, "path", "name", "database", "filename", "fname", "file"))
    elif name in SECOND:
        target(argument(call, 1, "dst", "filename"))
    elif name in BOTH:
        target(argument(call, 0, "src", "old"))
        target(argument(call, 1, "dst", "new"))
    elif name in ("shutil.make_archive", "shutil.unpack_archive"):
        target(argument(call, 0 if name.endswith("make_archive") else 1, "base_name", "extract_dir"))
    elif name in ("os.chdir", "contextlib.chdir"):
        changed.append(call)
    elif name in COMMANDS or re.match(r"subprocess\.|os\.(?:exec|spawn|posix_spawn)|asyncio\.create_subprocess", name):
        started(call)
    elif name in ("exec", "eval", "compile"):
        found.add("X")
        emit(mentions(call))
    elif name == "fileinput.input" and any(item.arg == "inplace" for item in call.keywords):
        target(argument(call, 0, "files"))
    elif attribute == "open":
        mode = argument(call, 0, "mode")
        literal = mode.value if isinstance(mode, ast.Constant) and isinstance(mode.value, str) else None
        if literal is not None and re.match("^[rwabtxU+]+$", literal):
            if writes(mode):
                target(call.func.value)
        elif len(call.args) > 1 or any(item.arg == "mode" for item in call.keywords):
            if writes(argument(call, 1, "mode")):
                target(call.args[0] if call.args else call.func.value)
    elif attribute in METHODS or (attribute in ("rename", "replace") and len(call.args) == 1):
        receiver = call.func.value
        if qualified(receiver).split(".")[-1] in ("Path", "PosixPath"):
            target(argument(call, 0, "self"))
        else:
            target(receiver)
            if attribute in ("rename", "replace"):
                target(call.args[0])
    elif attribute in SAVERS and call.args:
        emit(evaluate(call.args[0]), False)
    elif attribute in ("extractall", "extract"):
        emit(evaluate(argument(call, 0 if attribute == "extractall" else 1, "path")) or [(".", True, True)])
    # A writer handed to another call is applied to what else it is given.
    for item in call.args:
        if isinstance(item, (ast.Name, ast.Attribute)) and writer(qualified(item)):
            for other in call.args:
                if other is not item:
                    emit(evaluate(other) or UNKNOWN)

for call in changed:
    for text, exact, strong in evaluate(argument(call, 0, "path")) or UNKNOWN:
        found.add("C" if text is None or re.search(r"[\x00-\x1f]", text) else "C " + text)
lines = sorted(found)
if len(lines) > 2048:
    sys.exit(3)
sys.stdout.write("".join(line + "\n" for line in lines))
'

# _caws_interpreter_literals <language> <source> <verbs>
#   Print the path literals <source> may write to, for source with no readable
#   syntax tree. The operand of a read names something the source reads, so it
#   is dropped.
_caws_interpreter_literals() {
  local language="$1" source="$2" verbs="$3" quoted="(\"[^\"]*\"|'[^']*')" kind=''
  # Bytes that are not valid text must not stop a filter part way through.
  local -x LC_ALL=C
  case "$language" in
    python) kind=python-file ;;
    python-text) source="$(sed -E \
      -e "s/open\([[:space:]]*$quoted[[:space:]]*(,[[:space:]]*['\"]r[bt]*['\"])?[[:space:]]*\)/open()/g" \
      -e "s/Path\([[:space:]]*$quoted[[:space:]]*\)\.(read_text|read_bytes|exists|is_file|is_dir|iterdir|glob|rglob|stat)/\2/g" <<< "$source")" ;;
    node) source="$(sed -E \
      -e "s/(readFile|readdir|exists|lstat|stat|access|createReadStream)(Sync)?\([[:space:]]*$quoted/\1\2(/g" \
      -e "s/(require\(|import\(|from|import)[[:space:]]*$quoted/\1/g" <<< "$source")" ;;
  esac
  _caws_interp_payload_literals "$source" "$verbs" "$kind"
}

# _caws_node_text <source>
#   Node source without the calls that only print or start a reading program.
_caws_node_text() {
  local -x LC_ALL=C
  local reads='(ls|cat|head|tail|wc|grep|rg|stat|git( -C [^ ]+)?( --no-pager)? (log|show|diff|status|rev-parse|rev-list|ls-files|ls-tree|grep|cat-file|blame|merge-base))'
  reads="$reads( [^'\"\`<>|;&\$()]*)?"
  sed -E \
    -e 's/(process\.)?(stdout|stderr)\.write\(/print(/g' \
    -e "s/import[[:space:]]*\{[[:space:]]*(execSync|exec)[[:space:]]*\}[[:space:]]*from[[:space:]]*['\"](node:)?child_process['\"]//g" \
    -e 's/--(ou|ext|textc)/;--\1/g' \
    -e "s/(execSync|exec)\([[:space:]]*'$reads'/run(/g" \
    -e "s/(execSync|exec)\([[:space:]]*\"$reads\"/run(/g" \
    -e "s/(execSync|exec)\([[:space:]]*\`$reads\`/run(/g" \
    -e "s/(const|let|var)[[:space:]]*\{[[:space:]]*(execSync|exec)[[:space:]]*\}[[:space:]]*=[[:space:]]*require\(['\"](node:)?child_process['\"]\)//g" \
    -e "s/require\(['\"](node:)?child_process['\"]\)\.run\(/run(/g" <<< "$1"
}

# _caws_node_named_targets <source>
#   Print literals that are the operand of a file write, directly or through one
#   name or path join.
_caws_node_named_targets() {
  local -x LC_ALL=C
  local text name operand="[[:space:]]*(path\.)?(join\(|resolve\()?[[:space:]]*"
  local first='(writeFile|appendFile|createWriteStream|unlink|rm|rmdir|mkdir|truncate|rename|outputFile|writeJson)(Sync)?\('
  local second='(copyFile|cp|rename|symlink|link|copy|move)(Sync)?\([^(),]*(\([^()]*\))?[^(),]*,'
  text="$(tr '\n' ' ' <<< "$1")"
  {
    grep -oE "($first|$second)$operand['\"\`][^'\"\`]+['\"\`]" <<< "$text"
    grep -oE "($first|$second)$operand[A-Za-z_\$][A-Za-z0-9_\$]*[[:space:]]*[,)+]" <<< "$text" |
      sed -E 's/[[:space:]]*[,)+]$//; s/.*[^A-Za-z0-9_$]//' | sort -u | while IFS= read -r name; do
        grep -oE "(const|let|var)[[:space:]]+${name//\$/\\\$}[[:space:]]*=$operand['\"\`][^'\"\`]+['\"\`]" <<< "$text"
      done
  } | sed -E "s/.*['\"\`]([^'\"\`]+)['\"\`]\$/\1/; s/\\\$\{.*//" | grep '[/~]' | sort -u
  return 0
}

# _caws_record_evidence <origin> <coordinate> <literals> [guess-home]
#   Record each literal. A relative literal resolves against the invocation
#   directory and, when the source composes paths from the home directory in a
#   way that was not read, against HOME when that names something that exists.
_caws_record_evidence() {
  local origin="$1" coordinate="$2" literal
  while IFS= read -r literal; do
    [[ -n "$literal" ]] || continue
    case "$literal" in
      # Installed tools are programs a script runs, not repositories it edits.
      /opt/homebrew/*|/usr/*|/bin/*|/sbin/*) continue ;;
      /*) CAWS_INTERPRETER_EVIDENCE+=( "$origin"$'\t'"$literal" ) ;;
      '~'|'~'/*) CAWS_INTERPRETER_EVIDENCE+=( "$origin"$'\t'"${HOME:-/nonexistent-home}${literal#\~}" ) ;;
      *)
        [[ -z "$coordinate" ]] || CAWS_INTERPRETER_EVIDENCE+=( "$origin"$'\t'"$coordinate/$literal" )
        if [[ -n "${4:-}" && -n "${HOME:-}" && -e "$HOME/${literal%%/*}" ]]; then
          CAWS_INTERPRETER_EVIDENCE+=( "$origin"$'\t'"$HOME/$literal" )
        fi ;;
    esac
  done <<< "$3"
}

# _caws_names_home <source>
#   Whether source composes paths from the home directory.
_caws_names_home() { grep -qE 'homedir|expanduser|HOME|\.home\(' <<< "$1" && printf home; return 0; }

# _caws_python_targets <source>
#   Fill _PT_STRONG, _PT_WEAK, _PT_UNKNOWN, _PT_STARTED and _PT_FOUND from the
#   syntax tree. Returns 1 when the source has none this interpreter can read.
_caws_python_targets() {
  local lines line dirs='' unknown_dir=0 text
  _PT_STRONG=''; _PT_WEAK=''; _PT_UNKNOWN=0; _PT_STARTED=0; _PT_FOUND=0
  lines="$(printf '%s' "$1" | PYTHONDONTWRITEBYTECODE=1 python3 -I -c "$CAWS_PY_WRITE_TARGETS" 2>/dev/null)" || return 1
  while IFS= read -r line; do
    text="${line#? }"
    case "$line" in
      'T '*) _PT_FOUND=1; _PT_STRONG+="$text"$'\n' ;;
      'W '*) _PT_FOUND=1; _PT_WEAK+="$text"$'\n' ;;
      U) _PT_FOUND=1; _PT_UNKNOWN=1 ;;
      X) _PT_FOUND=1; _PT_STARTED=1 ;;
      'C '*) dirs+="$text"$'\n' ;;
      C) unknown_dir=1 ;;
    esac
  done <<< "$lines"
  # A relative write lands wherever the program may have changed into.
  if [[ $_PT_FOUND == 1 && ( -n "$dirs" || $unknown_dir == 1 ) ]]; then
    _PT_STRONG+="$dirs"
    [[ $unknown_dir == 0 ]] || ! grep -qvE '^(/|~|$)' <<< "$_PT_STRONG" || _PT_UNKNOWN=1
  fi
  return 0
}

# _caws_inline_evidence <language> <coordinate> <source>
#   Source in the command. A write there must name its target, and a relative
#   target needs a directory.
_caws_inline_evidence() {
  local language="$1" coordinate="$2" source="$3" literals='' writes="$CAWS_PY_WRITE_VERBS"
  local named="$CAWS_PY_NAMED_TARGET" found=0 relative=0 home
  home="$(_caws_names_home "$source")"
  if [[ "$language" == python ]] && _caws_python_targets "$source"; then
    [[ $_PT_FOUND == 1 ]] || return 0
    _caws_record_evidence inline "$coordinate" "$_PT_STRONG"
    _caws_record_evidence inline "$coordinate" "$_PT_WEAK"
    if [[ $_PT_UNKNOWN == 1 ]]; then
      CAWS_AST_ISSUES+=( 'mutation-interpreter-effects: inline source writes to a target it does not name literally' )
    fi
    if [[ -n "$coordinate" ]]; then
      CAWS_INTERPRETER_EVIDENCE+=( inline$'\t'"$coordinate/relative-target" )
    elif grep -qvE '^(/|~|$)' <<< "$_PT_STRONG"; then
      CAWS_AST_ISSUES+=( 'cwd-unresolved: inline source writes relative to a directory that could not be established' )
    fi
    return 0
  fi
  if [[ "$language" == python ]]; then
    if grep -qE "$CAWS_PY_WRITE_VERBS" <<< "$source"; then
      found=1; literals="$(_caws_interpreter_literals python "$source" "$CAWS_PY_WRITE_VERBS")"
    fi
    if grep -qE "$CAWS_PY_WRITE_MENTIONS" <<< "$source"; then
      found=1
      literals+=$'\n'"$(_caws_interpreter_literals python-text "$source" "$CAWS_PY_WRITE_MENTIONS")"
    fi
  else
    source="$(_caws_node_text "$source")"
    if grep -qE "$CAWS_NODE_WRITE_MENTIONS" <<< "$source"; then
      found=1; writes="$CAWS_NODE_FILE_WRITES"; named="$CAWS_NODE_NAMED_TARGET"
      literals="$(_caws_interpreter_literals node "$source" "$CAWS_NODE_WRITE_MENTIONS")"
    fi
  fi
  [[ $found == 1 ]] || return 0
  _caws_record_evidence inline "$coordinate" "$literals" "$home"
  if [[ -n "$coordinate" ]]; then
    # A relative write lands in the directory the program starts in.
    CAWS_INTERPRETER_EVIDENCE+=( inline$'\t'"$coordinate/relative-target" )
  fi
  grep -qE "$writes" <<< "$source" || return 0
  # A name without a slash is a relative target no path literal shows.
  if grep -qE "['\"][^'\"/[:space:]]+\.[A-Za-z0-9]+['\"]" <<< "$source"; then relative=1; fi
  if [[ "$literals" != *[!$'\n']* && $relative == 0 ]] && ! grep -qE "$named" <<< "$source"; then
    CAWS_AST_ISSUES+=( 'mutation-interpreter-effects: inline source writes to a target it does not name literally' )
  elif [[ -z "$coordinate" ]] && {
      [[ "$literals" != *[!$'\n']* || $relative == 1 ]] || grep -qvE '^(/|~/|$)' <<< "$literals"; }; then
    CAWS_AST_ISSUES+=( 'cwd-unresolved: inline source writes relative to a directory that could not be established' )
  fi
}

# _caws_file_evidence <origin> <language> <coordinate> <source> [committed]
#   Source of a program the command launches. A write it names is evidence. What
#   it merely mentions beside one is evidence only where an edit added it: a
#   committed mention is the project's own reviewed code.
_caws_file_evidence() {
  local origin="$1" language="$2" coordinate="$3" source="$4" strong='' weak='' before='' verbs home literal
  home="$(_caws_names_home "$source")"
  verbs="$CAWS_PY_WRITE_VERBS"; [[ "$language" == python ]] || verbs="$CAWS_NODE_WRITE_VERBS"
  if [[ "$language" == python ]] && _caws_python_targets "$source"; then
    strong="$_PT_STRONG"; weak="$_PT_WEAK"; home=''
    if [[ -n "${5:-}" && -n "$weak" ]] && _caws_python_targets "$5"; then before="$_PT_WEAK"; fi
  else
    [[ "$language" == python ]] || strong="$(_caws_node_named_targets "$source")"
    weak="$(_caws_interpreter_literals "$language" "$source" "$verbs")"
    [[ -z "${5:-}" ]] || before="$(_caws_interpreter_literals "$language" "$5" "$verbs")"
  fi
  _caws_record_evidence "$origin" "$coordinate" "$strong" "$home"
  while IFS= read -r literal; do
    [[ -n "$literal" && $'\n'"$before"$'\n' != *$'\n'"$literal"$'\n'* ]] || continue
    _caws_record_evidence "$origin" "$coordinate" "$literal" "$home"
  done <<< "$weak"
}

# caws_bash_interpreter_evidence <project>
#   Fill CAWS_INTERPRETER_EVIDENCE. A literal says a program may write there,
#   not that it will, so evidence reaches the foreign-repository and
#   foreign-payload checks and never becomes a FILE operand. A target computed
#   at run time, a module and a program in another language leave no evidence;
#   that is the limited-recognizer residual every launched program has.
#
#   Source in the command is fully visible, so a write there that names no
#   target at all is held.
caws_bash_interpreter_evidence() {
  local project="$1" i=0 kind language coordinate source verbs script body committed
  CAWS_INTERPRETER_EVIDENCE=()
  [[ ${CAWS_BASH_ANALYSIS_READY:-0} == 1 ]] || return 2
  declare -F _caws_interp_payload_literals >/dev/null 2>&1 &&
    declare -F caws_foreign_repo_root >/dev/null 2>&1 || return 2
  while [[ $i -lt ${#CAWS_AST_PROGRAM_KIND[@]} ]]; do
    kind="${CAWS_AST_PROGRAM_KIND[$i]}"; language="${CAWS_AST_PROGRAM_LANGUAGE[$i]}"
    coordinate="${CAWS_AST_PROGRAM_CWD[$i]}"; source="${CAWS_AST_PROGRAM_SOURCE[$i]}"
    i=$((i+1))
    case "$kind" in
      inline) _caws_inline_evidence "$language" "$coordinate" "$source"; continue ;;
      submitted) _caws_file_evidence inline "$language" "$coordinate" "$source"; continue ;;
    esac
    verbs="$CAWS_PY_WRITE_VERBS"
    [[ "$language" == python ]] || verbs="$CAWS_NODE_WRITE_VERBS"
    case "$source" in
      /*) script="$source" ;;
      *) script=''; [[ -z "$coordinate" ]] || script="$coordinate/$source" ;;
    esac
    # The command may create the file it goes on to run. Shell text around the
    # source is not a Python program, so it gets the co-occurrence scan.
    if [[ "$kind" == rewritten || ( -n "$script" && ! -e "$script" ) ]]; then
      _caws_record_evidence entry "$coordinate" \
        "$(_caws_interpreter_literals "${language/python/text}" "${COMMAND:-}" "$verbs")" \
        "$(_caws_names_home "${COMMAND:-}")"
    fi
    [[ -n "$script" && -f "$script" ]] || continue
    body="$(head -c 524289 "$script" 2>/dev/null || true)"
    [[ ${#body} -le 524288 ]] || continue
    committed=''
    if [[ -z "$(caws_foreign_repo_root "$script" "$project")" ]]; then
      committed="$(git -C "${script%/*}" show "HEAD:./${script##*/}" 2>/dev/null || true)"
    fi
    _caws_file_evidence entry "$language" "$coordinate" "$body" "$committed"
  done
  return 0
}

# Legacy callers may ask for weak hints; this required bridge grants none.
caws_bash_analysis_interpreter_literals() {
  [[ ${CAWS_BASH_ANALYSIS_READY:-0} == 1 && "$1" == "${CAWS_BASH_ANALYSIS_COMMAND-}" ]] || return 2
  return 0
}
