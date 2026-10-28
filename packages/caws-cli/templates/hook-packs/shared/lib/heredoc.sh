#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: shared
# hook_pack_version: 1
# caws_min_major: 11
# lineage_refs: 35,38
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
# heredoc.sh — neutralize heredoc BODIES before a guard reads command text.
#
# CAWS-GUARD-HEREDOC-BODY-READ-AS-COMMAND-01.
#
# Ported into the canonical pack from sterling's .caws/hooks/lib/heredoc.sh
# (GUARD-HEREDOC-BODY-READ-AS-COMMAND-001). The file-sink behavior is preserved;
# a separate literal Node projection handles JavaScript operators that resemble
# shell redirects. Callers must retain the original command for interpreter
# write checks. This projection is only an outer-shell syntax view.
#
# Entry 35 records the extractor's narrowness ("a here-doc heredoc that writes a
# claimed path is not recognized"); this file closes the OTHER face of that
# narrowness — the extractor recognizing a body that is not a command at all.
#
# The PreToolUse guards adjudicate the literal text of a Bash command. A
# heredoc body is not command text — it is a payload the command carries — but
# it arrives inside the same string, so every verb matcher reads it as if it
# were a command. Observed live: writing a memory file whose CONTENT documented
# that force-pushing is forbidden was itself refused as a force push, and a
# test corpus containing `caws worktree create x --scope y` was refused as a
# sparse-checkout attempt. In both the command mutated a file and ran no git.
#
# WHY A SAFELIST, NOT A DENYLIST. The naive fix — blank every heredoc body —
# opens a real bypass, because a heredoc fed to an interpreter IS code:
#
#     bash <<'EOF'
#     git push --force
#     EOF
#
# Blanking that hides a genuine force push from every guard. So this blanks a
# body only when the introducing line's command is one this file KNOWS writes
# the payload to a file or to stdout (`cat`, `tee`). Anything else — a shell, an
# unrecognized command, a form this parser cannot read — keeps its body fully
# visible. A complete, direct, quoted Node heredoc is the narrow exception for
# outer-shell syntax only: its body IS executable JavaScript, so raw interpreter
# checks must still see it. Node is never a file sink or a read-only safelist.
#
# Widen CAWS_HEREDOC_FILE_SINKS only for a command that provably cannot execute
# its payload.

# Commands whose heredoc payload is written out, never executed.
CAWS_HEREDOC_FILE_SINKS="${CAWS_HEREDOC_FILE_SINKS:-cat tee}"

# Only the admitted shared generation may supply prefix classification. The
# dispatcher/handler executor overwrites these selection coordinates; they are
# compared to this file, never used to choose an ambient CLI. Project/user/
# surface overrides and transformed service images cannot borrow sibling tools.
# Snapshot byte verification and normal host lookup are loader/host contracts;
# this adds no executable attestation or stronger TOCTOU claim.
_caws_bound_inspection_prefix() (
  local source="${BASH_SOURCE[0]}" shared selected generation digest parent reply
  [[ "$source" == /* && "${source##*/}" == heredoc.sh && ! -L "$source" ]] || return 1
  shared="$(CDPATH='' cd -P -- "${source%/*}" 2>/dev/null && pwd -P)" || return 1
  [[ "$shared" == */lib && "$source" -ef "$shared/heredoc.sh" ]] || return 1
  generation="${shared%/lib}"; digest="${generation##*/}"; parent="${generation%/*}"
  [[ "$parent" == */lib/runtimes && "$digest" =~ ^[a-f0-9]{64}$ &&
     "$digest" == "${CAWS_ADAPTER_RUNTIME_DIGEST:-}" ]] || return 1
  [[ "${CAWS_SHARED_LIB_DIR:-}" == /* ]] || return 1
  selected="$(CDPATH='' cd -P -- "$CAWS_SHARED_LIB_DIR" 2>/dev/null && pwd -P)" || return 1
  [[ "$selected" == "$shared" ]] || return 1
  local node="$generation/native/node"
  local entry="$generation/native-prefix/node_modules/@paths.design/caws-cli/dist/shell/analysis/inspection-prefix-entry.js"
  [[ -x "$node" && -f "$entry" && ! -L "$node" && ! -L "$entry" ]] || return 1
  # Keep this list aligned with nodeStartupBinding: no startup preload, module
  # search injection, cache/coverage/warning writes or OpenSSL configuration.
  unset NODE_OPTIONS NODE_PATH NODE_V8_COVERAGE NODE_COMPILE_CACHE
  unset NODE_REDIRECT_WARNINGS NODE_REPL_EXTERNAL_MODULE NODE_REPL_HISTORY
  unset NODE_ICU_DATA OPENSSL_CONF OPENSSL_ENGINES
  set -o pipefail
  reply="$(
    if printf '%s' "$1" | "$node" "$entry" 2>/dev/null | (
      # Preserve record bytes, reject NUL, and cap capture even for an old or
      # malformed entry. The selected entry supervises parser wall/heap limits.
      local value='' character='' count=0
      while IFS= read -r -d '' -n 1 character; do
        [[ -n "$character" ]] || exit 1
        count=$((count + 1)); [[ "$count" -le 80 ]] || exit 1
        value+="$character"
      done
      printf '%sx' "$value"
    ); then printf 0; else printf 1; fi
  )"
  [[ "$reply" == $'caws.inspection-prefix.v1:allow\nx0' ]]
)

# Echo $1 with every safelisted heredoc BODY replaced by blank lines.
# Line count and the delimiter lines are preserved so a caller reporting a
# position still points at the right place.
caws_blank_heredoc_bodies() {
  local input="$1"
  local line rest delim="" stripped
  local in_body=0 allow_indent=0 sink

  # No heredoc at all: return the input untouched rather than round-tripping it
  # through the loop, which would normalize trailing newlines.
  if [[ "$input" != *"<<"* ]]; then
    printf '%s' "$input"
    return 0
  fi

  # Buffer/look ahead before projecting Node: an unfinished or ambiguous
  # heredoc must not erase any payload. This deliberately recognizes only one
  # standalone bare `node <<'DELIM'` / `node <<"DELIM"` header, with no options,
  # wrapper, redirects, continuation, or second heredoc. Buffer the whole prefix
  # and ask one bound structural classifier only after the terminator is known.
  # Its argument-role policy is shared with analysis, not a second shell regex.
  #
  # Like the callers' literal command view, this assumes normal command lookup
  # supplied by the host. It does not authenticate ambient aliases/functions or
  # executable identity, nor prove the Node payload read-only. Callers retain
  # the original raw command for interpreter-write checks.
  local node_rest="${input#*<<}"
  local node_single="^[[:blank:]]*node[[:blank:]]+<<[[:blank:]]*'([^']+)'[[:blank:]]*$"
  local node_double='^[[:blank:]]*node[[:blank:]]+<<[[:blank:]]*"([^"\\]+)"[[:blank:]]*$'
  local node_prefix='' node_body=0 node_offset=0 node_start=0 node_delim="" node_blanks=""
  local node_nonblank=$'[^ \t\n]'
  if [[ "$node_rest" != *"<<"* ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$node_body" == 1 ]]; then
        if [[ "$line" == "$node_delim" ]]; then
          # Only Bash's blank command separators qualify for the independent
          # Node-first path. CR/VT/FF are not empty shell statements.
          if [[ "$node_prefix" =~ $node_nonblank ]] && ! _caws_bound_inspection_prefix "$node_prefix"; then
            printf '%s' "$input"
            return 0
          fi
          # Slice the original string, including its exact trailing newlines.
          # Only body lines become blank; header and terminator are untouched.
          printf '%s%s%s' "${input:0:node_start}" "$node_blanks" "${input:node_offset}"
          return 0
        fi
        node_blanks+=$'\n'
      else
        if [[ "$line" =~ $node_single || "$line" =~ $node_double ]]; then
          node_delim="${BASH_REMATCH[1]}"
          if [[ ! "$node_delim" =~ [[:cntrl:]] ]]; then
            node_body=1
            node_start=$((node_offset + ${#line} + 1))
            node_prefix="${input:0:node_offset}"
          fi
        fi
      fi
      node_offset=$((node_offset + ${#line} + 1))
    done <<< "$input"
    if [[ "$node_body" == 1 ]]; then printf '%s' "$input"; return 0; fi
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$in_body" == "1" ]]; then
      stripped="$line"
      # `<<-DELIM` permits the terminator to be indented with tabs.
      if [[ "$allow_indent" == "1" ]]; then
        stripped="${stripped#"${stripped%%[![:space:]]*}"}"
      fi
      if [[ "$stripped" == "$delim" ]]; then
        in_body=0
        delim=""
        allow_indent=0
        printf '%s\n' "$line"
      else
        printf '\n'
      fi
      continue
    fi

    printf '%s\n' "$line"

    [[ "$line" != *"<<"* ]] && continue

    # Only a safelisted sink may have its payload treated as data.
    sink=0
    for _cmd in $CAWS_HEREDOC_FILE_SINKS; do
      # Command position: start of line, or immediately after a pipe/semicolon/
      # and-or. Deliberately NOT a bare substring match — `bash -c "cat x"` must
      # not read as a `cat` invocation.
      if [[ "$line" =~ (^|[\|\;\&])[[:space:]]*${_cmd}([[:space:]]|$) ]]; then
        sink=1
        break
      fi
    done
    [[ "$sink" == "0" ]] && continue

    rest="${line#*<<}"
    # `<<<` is a here-STRING: one line, no body, nothing to blank.
    [[ "$rest" == "<"* ]] && continue

    allow_indent=0
    if [[ "$rest" == "-"* ]]; then
      allow_indent=1
      rest="${rest#-}"
    fi
    rest="${rest#"${rest%%[![:space:]]*}"}"
    # The delimiter ends at whitespace or at a following redirect.
    delim="${rest%%[[:space:]]*}"
    delim="${delim%%>*}"
    delim="${delim%\"}"; delim="${delim#\"}"
    delim="${delim%\'}"; delim="${delim#\'}"

    # An unparseable delimiter means we do not know where the body ends, so we
    # must not guess: leave the rest of the command visible.
    [[ -z "$delim" ]] && continue

    in_body=1
  done <<< "$input"
}
