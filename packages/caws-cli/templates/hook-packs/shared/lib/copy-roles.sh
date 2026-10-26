#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: shared
# hook_pack_version: 1
# caws_min_major: 11
# Derive regular-file write paths from validated copy-role observations.
# Filesystem observations are a snapshot, not final-launch confinement.
CAWS_COPY_WRITE_TARGET=()
CAWS_COPY_CANONICAL=0
CAWS_COPY_UNRESOLVED=''
CAWS_COPY_FINAL_SYMLINK=0

_caws_copy_hold() {
  [[ -n "$CAWS_COPY_UNRESOLVED" ]] || CAWS_COPY_UNRESOLVED="$1"
  return 0
}

_caws_copy_nominal_into() {
  local _caws_cn_var="$1" _caws_cn_operand="$2" _caws_cn_cwd="$3"
  _caws_outparam_ok "$_caws_cn_var" _caws_cn_ || return 2
  [[ -n "$_caws_cn_operand" ]] || return 1
  if [[ "$_caws_cn_operand" == /* ]]; then
    printf -v "$_caws_cn_var" '%s' "$_caws_cn_operand"
  else
    [[ "$_caws_cn_cwd" == /* ]] || return 1
    printf -v "$_caws_cn_var" '%s/%s' "$_caws_cn_cwd" "$_caws_cn_operand"
  fi
}

_caws_copy_emit() {
  if [[ "$1" == *[$'\r\n\t']* ]]; then
    _caws_copy_hold 'copy write target cannot use FILE transport'
  else
    CAWS_COPY_WRITE_TARGET+=( "$1" )
  fi
}

_caws_copy_single_link() {
  # realpath resolves symlinks, not aliases of the same inode. Do not let an
  # external pathname authorize a write through a hardlink into owned payload.
  python3 -c 'import os, stat, sys; s = os.stat(sys.argv[1]); sys.exit(0 if stat.S_ISREG(s.st_mode) and s.st_nlink == 1 else 2)' "$1" 2>/dev/null
}

caws_copy_role_paths() {
  local _caws_cr_project="$1" _caws_cr_name _caws_cr_rows _caws_cr_total
  local _caws_cr_row=0 _caws_cr_index _caws_cr_offset _caws_cr_count _caws_cr_checked=0
  local _caws_cr_operation _caws_cr_knowledge _caws_cr_mode _caws_cr_cwd _caws_cr_directory
  local _caws_cr_operand _caws_cr_source_nominal _caws_cr_source_physical _caws_cr_child
  local _caws_cr_destination _caws_cr_effective _caws_cr_physical _caws_cr_parent
  CAWS_COPY_WRITE_TARGET=(); CAWS_COPY_CANONICAL=0; CAWS_COPY_UNRESOLVED=''; CAWS_COPY_FINAL_SYMLINK=0
  [[ ${CAWS_BASH_ANALYSIS_READY:-0} == 1 && "$_caws_cr_project" == /* ]] || return 2
  declare -F caws_guard_realpath_into >/dev/null &&
    declare -F caws_physical_dir_into >/dev/null || return 2
  for _caws_cr_name in OPERATION KNOWLEDGE DESTINATION DIRECTORY_MODE CWD SOURCE_OFFSET SOURCE_COUNT SOURCES; do
    declare -p "CAWS_AST_COPY_$_caws_cr_name" >/dev/null 2>&1 || return 2
  done
  caws_physical_dir_into _caws_cr_project "$_caws_cr_project" || return 2
  set -- ${CAWS_AST_COPY_OPERATION[@]+"${CAWS_AST_COPY_OPERATION[@]}"}
  _caws_cr_rows=$#
  set -- ${CAWS_AST_COPY_SOURCES[@]+"${CAWS_AST_COPY_SOURCES[@]}"}
  _caws_cr_total=$#
  while [[ $_caws_cr_row -lt $_caws_cr_rows ]]; do
    _caws_cr_operation="${CAWS_AST_COPY_OPERATION[$_caws_cr_row]-}"
    _caws_cr_knowledge="${CAWS_AST_COPY_KNOWLEDGE[$_caws_cr_row]-}"
    _caws_cr_mode="${CAWS_AST_COPY_DIRECTORY_MODE[$_caws_cr_row]-}"
    _caws_cr_cwd="${CAWS_AST_COPY_CWD[$_caws_cr_row]-}"
    _caws_cr_offset="${CAWS_AST_COPY_SOURCE_OFFSET[$_caws_cr_row]-}"
    _caws_cr_count="${CAWS_AST_COPY_SOURCE_COUNT[$_caws_cr_row]-}"
    [[ "$_caws_cr_operation" == cp || "$_caws_cr_operation" == mv ]] || return 2
    if [[ "$_caws_cr_knowledge" == readonly ]]; then
      _caws_cr_row=$((_caws_cr_row + 1)); continue
    elif [[ "$_caws_cr_knowledge" == unresolved ]]; then
      _caws_copy_hold 'copy operand roles are unresolved'
      _caws_cr_row=$((_caws_cr_row + 1)); continue
    fi
    [[ "$_caws_cr_knowledge" == finite && ( "$_caws_cr_mode" == auto || "$_caws_cr_mode" == directory ) ]] || return 2
    [[ "$_caws_cr_offset" =~ ^[0-9]+$ && ${#_caws_cr_offset} -le 5 &&
       "$_caws_cr_count" =~ ^[0-9]+$ && ${#_caws_cr_count} -le 5 ]] || return 2
    _caws_cr_offset=$((10#$_caws_cr_offset)); _caws_cr_count=$((10#$_caws_cr_count))
    [[ $_caws_cr_count -gt 0 && $_caws_cr_count -le 4096 &&
       $((_caws_cr_offset + _caws_cr_count)) -le $_caws_cr_total ]] || return 2
    # Refuse an over-budget row before spending filesystem probes on its prefix.
    # Previously observed rows remain available to the mandatory write oracle.
    if [[ $((_caws_cr_checked + _caws_cr_count)) -gt 128 ]]; then
      _caws_copy_hold 'copy path observation budget exceeded'
      _caws_cr_row=$((_caws_cr_row + 1)); continue
    fi
    _caws_cr_operand="${CAWS_AST_COPY_DESTINATION[$_caws_cr_row]-}"
    if ! _caws_copy_nominal_into _caws_cr_destination "$_caws_cr_operand" "$_caws_cr_cwd"; then
      _caws_copy_hold 'copy destination has no proven coordinate'
      _caws_cr_row=$((_caws_cr_row + 1)); continue
    fi
    if [[ "$_caws_cr_operation" == mv && -L "$_caws_cr_destination" ]]; then
      _caws_copy_hold 'move destination symlink semantics are unmodeled'
      _caws_cr_row=$((_caws_cr_row + 1)); continue
    fi
    _caws_cr_directory=0
    [[ -d "$_caws_cr_destination" ]] && _caws_cr_directory=1
    if [[ "$_caws_cr_mode" == directory && $_caws_cr_directory == 0 ]] ||
        [[ $_caws_cr_count -gt 1 && $_caws_cr_directory == 0 ]] ||
        [[ "$_caws_cr_destination" == */ && $_caws_cr_directory == 0 ]]; then
      _caws_copy_hold 'copy destination is not a proven directory'
      _caws_cr_row=$((_caws_cr_row + 1)); continue
    fi
    _caws_cr_index=0
    while [[ $_caws_cr_index -lt $_caws_cr_count ]]; do
      _caws_cr_checked=$((_caws_cr_checked + 1))
      _caws_cr_operand="${CAWS_AST_COPY_SOURCES[$((_caws_cr_offset + _caws_cr_index))]-}"
      _caws_cr_index=$((_caws_cr_index + 1))
      if ! _caws_copy_nominal_into _caws_cr_source_nominal "$_caws_cr_operand" "$_caws_cr_cwd"; then
        _caws_copy_hold 'copy source has no proven coordinate'; continue
      fi
      _caws_cr_child="${_caws_cr_operand##*/}"
      _caws_cr_effective="$_caws_cr_destination"
      if [[ $_caws_cr_directory == 1 ]]; then
        _caws_cr_effective="${_caws_cr_destination%/}/$_caws_cr_child"
      fi
      if [[ "$_caws_cr_operation" == cp && -L "$_caws_cr_effective" ]]; then
        # Force-copy fallback may unlink this entry rather than write its
        # referent. Keep known referent violations, but never authorize the
        # unmodeled entry replacement, even through an approval response.
        CAWS_COPY_FINAL_SYMLINK=1
        _caws_copy_hold 'copy final destination symlink entry semantics are unmodeled'
      fi
      if [[ -L "$_caws_cr_source_nominal" || ! -f "$_caws_cr_source_nominal" ]]; then
        _caws_copy_hold 'copy source is not a modeled regular file'; continue
      fi
      caws_guard_realpath_into _caws_cr_source_physical "$_caws_cr_source_nominal" || return 2
      if [[ -d "$_caws_cr_effective" ]] ||
          [[ -e "$_caws_cr_effective" && ! -f "$_caws_cr_effective" ]] ||
          [[ "$_caws_cr_operation" == mv && -L "$_caws_cr_effective" ]]; then
        _caws_copy_hold 'copy destination entry semantics are unmodeled'; continue
      fi
      caws_guard_realpath_into _caws_cr_physical "$_caws_cr_effective" || return 2
      case "$_caws_cr_source_physical" in
        "$_caws_cr_project"/.caws/worktrees/*)
          case "$_caws_cr_physical" in
            "$_caws_cr_project"/.caws/worktrees/*) ;;
            "$_caws_cr_project"|"$_caws_cr_project"/*) CAWS_COPY_CANONICAL=1 ;;
          esac ;;
      esac
      # These resolved paths are ownership observations, not admission. Keep
      # known foreign writes/deletions visible even when link identity or the
      # destination parent cannot authorize the rest of this invocation.
      _caws_copy_emit "$_caws_cr_physical"
      [[ "$_caws_cr_operation" != mv ]] || _caws_copy_emit "$_caws_cr_source_physical"
      if [[ "$_caws_cr_operation" == mv ]] && ! _caws_copy_single_link "$_caws_cr_source_physical"; then
        _caws_copy_hold 'move source hard-link identity is unmodeled or unavailable'; continue
      fi
      if [[ -e "$_caws_cr_physical" ]] && ! _caws_copy_single_link "$_caws_cr_physical"; then
        _caws_copy_hold 'copy destination hard-link identity is unmodeled or unavailable'; continue
      fi
      _caws_cr_parent="${_caws_cr_physical%/*}"
      [[ -n "$_caws_cr_parent" ]] || _caws_cr_parent=/
      if ! caws_physical_dir_into _caws_cr_parent "$_caws_cr_parent"; then
        _caws_copy_hold 'copy destination parent does not exist'; continue
      fi
    done
    _caws_cr_row=$((_caws_cr_row + 1))
  done
  return 0
}
