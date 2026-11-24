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
        (.payloads|type)=="array" and (.payloads|length)<=1 and all(.payloads[];
          (.text|type)=="string" and (.origin=="argument" or .origin=="heredoc") and
          bounded($document.execution.command|source_length)) and
        (.launch==null or .launch=="inline" or (.launch=="program" and .effects.kind=="unresolved" and (.payloads|length)==0)) and
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
          (select(.entry!=null) | ["interpreter_source","entry",.language,(.cwd//""),.entry]|frame)
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

# _caws_interpreter_literals <language> <source> <verbs>
#   Print the path literals <source> may write to. The operand of a read names
#   something the source reads, so it is dropped; a complete Python program gets
#   that distinction from its syntax tree.
_caws_interpreter_literals() {
  local language="$1" source="$2" verbs="$3" kind='' quoted="(\"[^\"]*\"|'[^']*')"
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

# _caws_record_evidence <origin> <coordinate> <literals> [reviewed-literals]
#   Record each literal a reviewed version of the source does not already hold.
#   A relative literal resolves against the invocation directory and, because
#   programs compose paths from the home directory, against HOME when that names
#   something that exists.
_caws_record_evidence() {
  local origin="$1" coordinate="$2" literal
  while IFS= read -r literal; do
    [[ -n "$literal" ]] || continue
    [[ -z "${4:-}" || $'\n'"$4"$'\n' != *$'\n'"$literal"$'\n'* ]] || continue
    case "$literal" in
      # Installed tools are programs a script runs, not repositories it edits.
      /opt/homebrew/*|/usr/*|/bin/*|/sbin/*) continue ;;
      /*) CAWS_INTERPRETER_EVIDENCE+=( "$origin"$'\t'"$literal" ) ;;
      '~'/*) CAWS_INTERPRETER_EVIDENCE+=( "$origin"$'\t'"${HOME:-/nonexistent-home}/${literal#\~/}" ) ;;
      *)
        [[ -z "$coordinate" ]] || CAWS_INTERPRETER_EVIDENCE+=( "$origin"$'\t'"$coordinate/$literal" )
        if [[ -n "${HOME:-}" && -e "$HOME/${literal%%/*}" ]]; then
          CAWS_INTERPRETER_EVIDENCE+=( "$origin"$'\t'"$HOME/$literal" )
        fi ;;
    esac
  done <<< "$3"
}

# _caws_inline_evidence <language> <coordinate> <source>
#   Source in the command. A write there must name its target, and a relative
#   target needs a directory.
_caws_inline_evidence() {
  local language="$1" coordinate="$2" source="$3" literals='' writes="$CAWS_PY_WRITE_VERBS"
  local named="$CAWS_PY_NAMED_TARGET" found=0
  if [[ "$language" == python ]]; then
    if grep -qE "$CAWS_PY_WRITE_VERBS" <<< "$source"; then
      found=1; literals="$(_caws_interpreter_literals python "$source" "$CAWS_PY_WRITE_VERBS")"
    fi
    if grep -qE "$CAWS_PY_WRITE_MENTIONS" <<< "$source"; then
      found=1
      literals+=$'\n'"$(_caws_interpreter_literals python-text "$source" "$CAWS_PY_WRITE_MENTIONS")"
    fi
  elif grep -qE "$CAWS_NODE_WRITE_MENTIONS" <<< "$source"; then
    found=1; writes="$CAWS_NODE_FILE_WRITES"; named="$CAWS_NODE_NAMED_TARGET"
    literals="$(_caws_interpreter_literals node "$source" "$CAWS_NODE_WRITE_MENTIONS")"
  fi
  [[ $found == 1 ]] || return 0
  _caws_record_evidence inline "$coordinate" "$literals"
  if [[ -n "$coordinate" ]]; then
    # A relative write lands in the directory the program starts in.
    CAWS_INTERPRETER_EVIDENCE+=( inline$'\t'"$coordinate/relative-target" )
  fi
  grep -qE "$writes" <<< "$source" || return 0
  if [[ "$literals" != *[!$'\n']* ]] &&
      ! grep -qE "['\"][^'\"/[:space:]]+\.[A-Za-z0-9]+['\"]" <<< "$source" &&
      ! grep -qE "$named" <<< "$source"; then
    CAWS_AST_ISSUES+=( 'mutation-interpreter-effects: inline source writes to a target it does not name literally' )
  elif [[ -z "$coordinate" ]] && { [[ "$literals" != *[!$'\n']* ]] || grep -qvE '^(/|~/|$)' <<< "$literals"; }; then
    CAWS_AST_ISSUES+=( 'cwd-unresolved: inline source writes relative to a directory that could not be established' )
  fi
}

# caws_bash_interpreter_evidence <project>
#   Fill CAWS_INTERPRETER_EVIDENCE. A literal says a program may write there,
#   not that it will, so evidence reaches the foreign-repository and
#   foreign-payload checks and never becomes a FILE operand. A target computed
#   at run time, a module and a program in another language leave no evidence;
#   that is the limited-recognizer residual every launched program has.
#
#   Source in the command is fully visible, so a write there that names no
#   target at all is held. What the project has committed is its own reviewed
#   code, like a build target, so only the literals an edit adds are evidence.
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
    if [[ "$kind" == inline ]]; then
      _caws_inline_evidence "$language" "$coordinate" "$source"
      continue
    fi
    verbs="$CAWS_PY_WRITE_VERBS"
    [[ "$language" == python ]] || verbs="$CAWS_NODE_WRITE_VERBS"
    case "$source" in
      /*) script="$source" ;;
      *) [[ -n "$coordinate" ]] || continue; script="$coordinate/$source" ;;
    esac
    if [[ ! -f "$script" ]]; then
      # The command may create the file it goes on to run. Shell text around the
      # source is not a Python program, so it gets the co-occurrence scan.
      [[ -e "$script" ]] ||
        _caws_record_evidence entry "$coordinate" \
          "$(_caws_interpreter_literals "${language/python/text}" "${COMMAND:-}" "$verbs")"
      continue
    fi
    body="$(head -c 524289 "$script" 2>/dev/null || true)"
    [[ ${#body} -le 524288 ]] || continue
    committed=''
    if [[ -z "$(caws_foreign_repo_root "$script" "$project")" ]]; then
      committed="$(git -C "${script%/*}" show "HEAD:./${script##*/}" 2>/dev/null || true)"
      [[ "$committed" != "$body" ]] || continue
    fi
    _caws_record_evidence entry "$coordinate" \
      "$(_caws_interpreter_literals "$language" "$body" "$verbs")" \
      "$(_caws_interpreter_literals "$language" "$committed" "$verbs")"
  done
  return 0
}

# Legacy callers may ask for weak hints; this required bridge grants none.
caws_bash_analysis_interpreter_literals() {
  [[ ${CAWS_BASH_ANALYSIS_READY:-0} == 1 && "$1" == "${CAWS_BASH_ANALYSIS_COMMAND-}" ]] || return 2
  return 0
}
