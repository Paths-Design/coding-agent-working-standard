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
CAWS_AST_GIT_SUBCOMMAND=(); CAWS_AST_GIT_DIRECTORY=(); CAWS_AST_GIT_COMMON=()
CAWS_AST_GIT_WORKTREE=(); CAWS_AST_GIT_START=(); CAWS_AST_GIT_END=()
CAWS_AST_COPY_OPERATION=(); CAWS_AST_COPY_KNOWLEDGE=(); CAWS_AST_COPY_DESTINATION=()
CAWS_AST_COPY_DIRECTORY_MODE=(); CAWS_AST_COPY_CWD=(); CAWS_AST_COPY_START=(); CAWS_AST_COPY_END=()
CAWS_AST_COPY_SOURCE_OFFSET=(); CAWS_AST_COPY_SOURCE_COUNT=(); CAWS_AST_COPY_SOURCES=()
CAWS_BASH_ANALYSIS_READY=0

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
      "$cli" hooks mutation-view --json --cwd "$cwd" --project "$project" ${context_args[@]+"${context_args[@]}"})"; then
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
      ([.copyInvocations[]|{operation,start,end}]==[.copyOperations[]|{operation,start,end}]) and
      all(.tokens[]; (.value|type)=="string" and
        (.kind as $k | ["word","op","redirect","input_redirect","unsupported_nesting"]|index($k))!=null and
        (.dynamic|type)=="boolean" and (.resolution=="" or .resolution=="runtime") and
        (.dynamic == (.resolution=="runtime")) and .prefix=="" and .prefixBasis=="none" and
        (.unrepresentable|type)=="boolean" and coordinate($document.execution.cwd==null) and bounded($document.execution.command|source_length) and
        (.unrepresentable or ((.value|contains("\n")|not) and (.value|contains("\t")|not)))) and
      all(.issues[]; (.code|type)=="string" and (.message|type)=="string" and bounded($document.execution.command|source_length)) and
      all(.interpreterInvocations[]; language and bounded($document.execution.command|source_length)) and
      (if (.issues|length)==0 then
        ([.interpreterInvocations[]|{language,start,end}]==[.interpreters[]|{language,start,end}])
        else true end) and
      all(.interpreters[]; language and coordinate($document.execution.cwd==null) and bounded($document.execution.command|source_length) and
        (.argv|type)=="array" and (.argv|length)>0 and all(.argv[]; .==null or type=="string") and
        (.argv[0]|type)=="string" and
        (if .language=="node" then (.argv[0]|split("/")|last|.=="node" or .=="nodejs")
          else (.argv[0]|split("/")|last|test("^python([0-9]+(\\.[0-9]+)*)?$")) end) and
        (.payloads|type)=="array" and (.payloads|length)<=1 and all(.payloads[];
          (.text|type)=="string" and (.origin=="argument" or .origin=="heredoc") and
          bounded($document.execution.command|source_length)) and effects) and
      all(.gitMetadata[]; (.subcommand=="add" or .subcommand=="commit") and
        (.directory|absolute) and (.common|absolute) and (.worktree|absolute) and bounded($document.execution.command|source_length)) and
      all(..|strings; contains("\u0000")|not);
    def frame: .[] | tostring + "\u0000";
    if length!=1 then error("one mutation-view document required") else .[0] end |
    if valid then
      (["execution",.execution.command,(.execution.cwd//"")]|frame),
      (.tokens[] | ["token",.value,.kind,(if .dynamic then 1 else 0 end),.resolution,
        (if .unrepresentable then 1 else 0 end),(.cwd//""),.start,.end] | frame),
      (.issues[] | ["issue",(.code+": "+.message)] | frame),
      (.interpreters[] | . as $row |
        if .effects.kind=="unresolved" then
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

# Legacy callers may ask for weak hints; this required bridge grants none.
caws_bash_analysis_interpreter_literals() {
  [[ ${CAWS_BASH_ANALYSIS_READY:-0} == 1 && "$1" == "${CAWS_BASH_ANALYSIS_COMMAND-}" ]] || return 2
  return 0
}
