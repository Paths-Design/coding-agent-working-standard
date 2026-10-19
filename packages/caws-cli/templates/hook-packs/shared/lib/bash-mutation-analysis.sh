#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: shared
# hook_pack_version: 1
# caws_min_major: 11
# Syntax observations only. Mutation roles and ownership policy remain downstream.
CAWS_AST_VALUE=(); CAWS_AST_KIND=(); CAWS_AST_DYNAMIC=(); CAWS_AST_RESOLUTION=()
CAWS_AST_UNREPR=(); CAWS_AST_CWD=(); CAWS_AST_ISSUES=(); CAWS_AST_LITERALS=()
CAWS_BASH_ANALYSIS_READY=0

_caws_ast_payload() {
  local payload="$1" verbs="$2" coordinate="$3" found=0 frag
  grep -qE "$verbs" <<< "$payload" || return 0
  while IFS= read -r frag; do
    [[ -n "$frag" ]] || continue
    found=1
    # These remain weak cross-repository observations, never FILE operands.
    case "$frag" in
      /*) CAWS_AST_LITERALS+=( "$frag" ) ;;
      '~'*)
        if [[ -n "$coordinate" ]]; then CAWS_AST_LITERALS+=( "$coordinate/$frag" )
        else CAWS_AST_ISSUES+=( interpreter_target_cwd_unresolved ); fi
        CAWS_AST_LITERALS+=( "${HOME:-/nonexistent-home}/${frag#\~}" ) ;;
      *)
        if [[ -n "$coordinate" ]]; then CAWS_AST_LITERALS+=( "$coordinate/$frag" )
        else CAWS_AST_ISSUES+=( interpreter_target_cwd_unresolved ); fi
        CAWS_AST_LITERALS+=( "${HOME:-/nonexistent-home}/$frag" ) ;;
    esac
  done < <(_caws_interp_payload_literals "$payload" "$verbs")
  if [[ $found == 0 ]]; then
    CAWS_AST_ISSUES+=( interpreter_write_target_unresolved )
  fi
  return 0
}

_caws_ast_entry_script() {
  local language="$1" coordinate="$2" verbs="$3"; shift 3
  # Pairs preserve unknown argv distinctly from an empty known string.
  local -a argv=() unknown=()
  while [[ $# -gt 0 ]]; do unknown+=( "$1" ); argv+=( "$2" ); shift 2; done
  local j=1 value script='' body
  while [[ $j -lt ${#argv[@]} ]]; do
    if [[ "${unknown[$j]}" == 1 ]]; then CAWS_AST_ISSUES+=( interpreter_entry_unresolved ); return 0; fi
    value="${argv[$j]}"
    case "$value" in
      -c|-e|-m|-p|--eval|--print|-e?*|-c?*|--eval=*|--print=*|-) return 0 ;;
      --) j=$((j+1)); break ;;
      -u|-B|-E|-s|-S|-I|-O|-OO|-q|-v|--no-warnings) j=$((j+1)); continue ;;
      --input-type) j=$((j+2)); continue ;;
      --input-type=*) j=$((j+1)); continue ;;
      -*) CAWS_AST_ISSUES+=( interpreter_option_unresolved ); return 0 ;;
    esac
    break
  done
  [[ $j -lt ${#argv[@]} ]] || return 0
  if [[ "${unknown[$j]}" == 1 ]]; then CAWS_AST_ISSUES+=( interpreter_entry_unresolved ); return 0; fi
  value="${argv[$j]}"
  case "$value" in
    /*) script="$value" ;;
    *)
      if [[ -z "$coordinate" ]]; then CAWS_AST_ISSUES+=( interpreter_entry_cwd_unresolved ); return 0; fi
      script="$coordinate/$value" ;;
  esac
  if [[ ! -f "$script" ]]; then CAWS_AST_ISSUES+=( interpreter_entry_unreadable ); return 0; fi
  # A sentinel preserves trailing newlines while the exit code preserves read failure.
  if ! body="$(head -c 524289 "$script" || exit $?; printf '.')"; then
    CAWS_AST_ISSUES+=( interpreter_entry_unreadable ); return 0
  fi
  body="${body%.}"
  local LC_ALL=C
  if [[ ${#body} -gt 524288 ]]; then CAWS_AST_ISSUES+=( interpreter_entry_budget ); return 0; fi
  _caws_ast_payload "$body" "$verbs" "$coordinate"
}

caws_bash_prepare_analysis() {
  local command="$1" cwd="$2" project="$3" cli="${CAWS_BIN:-caws}" json
  local unknown_cwd=false
  local -a context_args=()
  if [[ ${_CWD_RESOLVED:-0} != 1 ]]; then
    cwd="$project"
    if [[ ${_CWD_CONTRACT:-0} == 1 ]]; then
      unknown_cwd=true
      context_args+=( --cwd-unresolved )
    fi
  fi
  CAWS_BASH_ANALYSIS_READY=0
  CAWS_BASH_ANALYSIS_ERROR='command mutation analysis is unavailable'
  command -v jq >/dev/null 2>&1 || return 2
  command -v "$cli" >/dev/null 2>&1 || return 2
  if ! json="$(jq -nc --arg command "$command" '{command:$command}' |
      "$cli" hooks mutation-view --json --cwd "$cwd" --project "$project" ${context_args[@]+"${context_args[@]}"})"; then
    CAWS_BASH_ANALYSIS_ERROR='command mutation analyzer failed'; return 2
  fi
  CAWS_AST_VALUE=(); CAWS_AST_KIND=(); CAWS_AST_DYNAMIC=(); CAWS_AST_RESOLUTION=()
  CAWS_AST_UNREPR=(); CAWS_AST_CWD=(); CAWS_AST_ISSUES=(); CAWS_AST_LITERALS=()
  local tag value kind dynamic resolution unrepr coordinate start end language argc count isnull verbs payload
  local complete=0 malformed=0
  local -a arguments=()
  while IFS= read -r -d '' tag; do
    [[ $complete == 0 ]] || { malformed=1; break; }
    case "$tag" in
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
      interpreter)
        IFS= read -r -d '' language && IFS= read -r -d '' coordinate &&
        IFS= read -r -d '' argc || { malformed=1; break; }
        arguments=(); count=0
        while [[ $count -lt $argc ]]; do
          IFS= read -r -d '' isnull && IFS= read -r -d '' value || { malformed=1; break; }
          arguments+=( "$isnull" "$value" ); count=$((count+1))
        done
        [[ $malformed == 0 ]] || break
        case "$language" in node) verbs="$CAWS_NODE_WRITE_VERBS" ;; python) verbs="$CAWS_PY_WRITE_VERBS" ;; esac
        IFS= read -r -d '' argc || { malformed=1; break; }
        count=0
        while [[ $count -lt $argc ]]; do
          IFS= read -r -d '' payload || { malformed=1; break; }
          _caws_ast_payload "$payload" "$verbs" "$coordinate"
          count=$((count+1))
        done
        [[ $malformed == 0 ]] || break
        _caws_ast_entry_script "$language" "$coordinate" "$verbs" ${arguments[@]+"${arguments[@]}"} ;;
      complete) complete=1 ;;
      *) malformed=1; break ;;
    esac
  done < <(jq -sj --argjson unknown_cwd "$unknown_cwd" '
    def span: (.start|type)=="number" and (.end|type)=="number" and
      .start>=0 and .end>=.start and .start==(.start|floor) and .end==(.end|floor);
    def coordinate: (.cwd==null and $unknown_cwd) or ((.cwd|type)=="string" and (.cwd|startswith("/")));
    def valid:
      type=="object" and .schema=="caws.shell_mutation_view.v1" and
      (.tokens|type)=="array" and (.issues|type)=="array" and (.interpreters|type)=="array" and
      all(.tokens[]; (.value|type)=="string" and
        (.kind as $k | ["word","op","redirect","input_redirect","unsupported_nesting"]|index($k))!=null and
        (.dynamic|type)=="boolean" and (.resolution=="" or .resolution=="runtime") and
        (.dynamic == (.resolution=="runtime")) and .prefix=="" and .prefixBasis=="none" and
        (.unrepresentable|type)=="boolean" and coordinate and span and
        (.unrepresentable or ((.value|contains("\n")|not) and (.value|contains("\t")|not)))) and
      all(.issues[]; (.code|type)=="string" and (.message|type)=="string" and span) and
      all(.interpreters[]; (.language=="node" or .language=="python") and coordinate and span and
        (.argv|type)=="array" and (.argv|length)>0 and all(.argv[]; .==null or type=="string") and
        (.payloads|type)=="array" and all(.payloads[];
          (.text|type)=="string" and (.origin=="argument" or .origin=="heredoc") and span)) and
      all(..|strings; contains("\u0000")|not);
    def frame: .[] | tostring + "\u0000";
    if length!=1 then error("one mutation-view document required") else .[0] end |
    if valid then
      (.tokens[] | ["token",.value,.kind,(if .dynamic then 1 else 0 end),.resolution,
        (if .unrepresentable then 1 else 0 end),(.cwd//""),.start,.end] | frame),
      (.issues[] | ["issue",(.code+": "+.message)] | frame),
      (.interpreters[] |
        (["interpreter",.language,(.cwd//""),(.argv|length)]|frame),
        (.argv[] | [(if .==null then 1 else 0 end),(.//"")] | frame),
        ([(.payloads|length)]|frame), (.payloads[] | [.text]|frame)),
      (["complete"]|frame)
    else error("invalid caws.shell_mutation_view.v1 response") end
  ' <<< "$json")
  if [[ $complete != 1 || $malformed != 0 ]]; then
    CAWS_BASH_ANALYSIS_ERROR='command mutation analyzer returned an invalid or incomplete contract'; return 2
  fi
  CAWS_BASH_ANALYSIS_COMMAND="$command"; CAWS_BASH_ANALYSIS_READY=1
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

caws_bash_analysis_interpreter_literals() {
  [[ ${CAWS_BASH_ANALYSIS_READY:-0} == 1 && "$1" == "${CAWS_BASH_ANALYSIS_COMMAND-}" ]] || return 2
  printf '%s\n' ${CAWS_AST_LITERALS[@]+"${CAWS_AST_LITERALS[@]}"}
}
