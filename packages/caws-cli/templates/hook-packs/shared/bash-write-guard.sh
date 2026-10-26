#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: shared
# hook_pack_version: 1
# caws_min_major: 11
# lineage_refs: 4,8,13,20,32
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
# CAWS Bash Write-Target Guard (shared, WORKTREE-ISOLATION-HARDENING-001 Fix 3).
# Self-filters on Bash, extracts write targets for a narrow set of mutation
# forms, routes each through lib/worktree-claim-oracle.cjs — same oracle as
# worktree-write-guard.sh so a Bash mutation and a Write/Edit get the same
# owner-vs-session answer.
#
# Recognized mutation forms:
#   redirection      > FILE   >> FILE
#   tee              tee FILE   tee -a FILE
#   in-place editors sed -i ... FILE   perl -pi ... FILE
#   truncate/touch   truncate ... FILE   touch FILE
#   remove/move/copy rm FILE   mv SRC DST   cp SRC DST   dd of=FILE
#   git path-restore git restore FILE   git checkout -- FILE
#                    git reset -- FILE   git clean
#   interpreter      Explicit readonly / finite-writes / unresolved effects
#                    from bounded Node/Python profiles. Proven write operands
#                    reach both repository and worktree ownership checks.
#                    File-entry scripts and unmodeled effects remain held.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/parse-input.sh
source "$SCRIPT_DIR/lib/parse-input.sh"
# shellcheck source=lib/caws-state.sh
# caws-state.sh provides the Bash-mutation-target machinery this guard needs to
# route a write through the worktree-claim oracle. A fatal `source <missing>`
# under `set -euo pipefail` is not caught by `|| exit 0`, and `|| exit 0` would
# SILENTLY ADMIT the mutation (fail-open). Fail CLOSED if it cannot load
# (CAWS-HOOK-SOURCE-GUARD-FAIL-SOFT-001).
if ! { [[ -f "$SCRIPT_DIR/lib/caws-state.sh" ]] && source "$SCRIPT_DIR/lib/caws-state.sh"; }; then
  echo "[bash-write-guard] CAWS hook infrastructure incomplete: lib/caws-state.sh is missing or did not load — cannot evaluate Bash-mutation ownership. Failing CLOSED. Restore the shared hook libs with: caws init adapters install" >&2
  printf '{"decision":"block","reason":"CAWS bash-write-guard: cannot load lib/caws-state.sh, so Bash-mutation worktree isolation cannot be evaluated. Failing closed. Restore the hook pack: caws init adapters install"}\n'
  exit 2
fi
# Ownership and containment below compare normalized paths. A path that cannot
# be normalized is refused here: compared unresolved, a foreign target can read
# as this session's own (CAWS-DEFECT-REALPATH-PYTHON-ABSENT-FAIL-OPEN-01).
_bwg_normalize_refuse() {
  echo "[bash-write-guard] cannot normalize the $1 path '$2', so Bash-mutation ownership cannot be evaluated. Failing CLOSED. Restore a working python3 on PATH." >&2
  printf '{"decision":"block","reason":"CAWS bash-write-guard: a path could not be normalized, so Bash-mutation ownership cannot be evaluated. Failing closed. Restore a working python3 on PATH."}\n'
  exit 2
}
_bwg_git_failed_refuse() {
  echo "[bash-write-guard] git could not determine the repository for $(printf '%q' "$1") although a .git entry exists at $(printf '%q' "$2"), so the canonical checkout and worktree ownership cannot be determined. Failing CLOSED. Repair the repository or worktree (git worktree repair, or prune and recreate it)." >&2
  printf '{"decision":"block","reason":"CAWS bash-write-guard: git could not determine the repository although a .git entry exists, so the canonical checkout and worktree ownership cannot be determined. Failing closed."}\n'
  exit 2
}
# Usage: _bwg_resolve_refuse <status> <start>: the canonical root could not be
# resolved. Status 3 means git did not answer although a .git entry exists.
_bwg_resolve_refuse() {
  local evidence=""
  if [[ "$1" == 3 ]]; then
    caws_git_evidence_dir_into evidence "${_BWG_START_PHYSICAL:-}" || evidence="$2"
    _bwg_git_failed_refuse "$2" "$evidence/.git"
  fi
  _bwg_normalize_refuse "project root" "$2"
}
_bwg_git_refuse() {
  echo "[bash-write-guard] git is not available on PATH, so the canonical checkout and worktree ownership cannot be determined. Failing CLOSED. Restore git on PATH." >&2
  printf '{"decision":"block","reason":"CAWS bash-write-guard: git is not available on PATH, so the canonical checkout and worktree ownership cannot be determined. Failing closed. Restore git on PATH."}\n'
  exit 2
}
# shellcheck source=lib/agent-surface.sh
# Provides CAWS_PROJECT_DIR and caws_source_lib — load-bearing. Guard the source
# (a fatal `source <missing>` is not caught by `|| true` under set -e) and fail
# CLOSED if absent.
if [[ -f "$SCRIPT_DIR/lib/agent-surface.sh" ]]; then
  source "$SCRIPT_DIR/lib/agent-surface.sh"
else
  echo "[bash-write-guard] CAWS hook infrastructure incomplete: lib/agent-surface.sh is missing. Failing CLOSED. Restore the shared hook libs with: caws init adapters install" >&2
  printf '{"decision":"block","reason":"CAWS bash-write-guard: cannot load lib/agent-surface.sh. Failing closed. Restore the hook pack: caws init adapters install"}\n'
  exit 2
fi
# shellcheck source=lib/emit.sh
# Use caws_source_lib so a vendor override is preferred over the shared default.
caws_source_lib emit.sh 2>/dev/null || true
if [[ -f "$SCRIPT_DIR/lib/ask-capability.sh" ]]; then
  source "$SCRIPT_DIR/lib/ask-capability.sh"
else
  echo "[CAWS guard] Missing lib/ask-capability.sh; cannot establish a human approval boundary." >&2
  exit 2
fi
[[ -f "$SCRIPT_DIR/lib/guard-message.sh" ]] && source "$SCRIPT_DIR/lib/guard-message.sh"
# shellcheck source=lib/session-id.sh
# CAWS-SESSION-RESOLVER-GUARD-DIVERGENCE-001 (A1/A2): resolve the operating
# session id through the SAME env-var precedence the TS resolver uses, not only
# HOOK_SESSION_ID (which does not propagate into agent-Bash). Best-effort source
# — a missing helper degrades to the legacy HOOK_SESSION_ID-only path, never a
# hard block.
[[ -f "$SCRIPT_DIR/lib/session-id.sh" ]] && source "$SCRIPT_DIR/lib/session-id.sh"
# shellcheck source=lib/write-allowlist.sh
# CAWS-GUARD-ALLOWLIST-SYNC-001: the shared unconditional-allow path set. A
# Bash mutation of an allowlisted path (docs/*, .caws/* minus payload, .tmp/*,
# .github/*, vendor dir, instruction files, agent-home dir) must get the SAME
# allow verdict as a Write/Edit of that path — this guard consults the SAME
# helper worktree-write-guard uses, so the two guards cannot diverge by tool.
# Best-effort source: a missing helper degrades to oracle-everything (the
# pre-fix behavior), never a hard block.
[[ -f "$SCRIPT_DIR/lib/write-allowlist.sh" ]] && source "$SCRIPT_DIR/lib/write-allowlist.sh"
parse_hook_input

# CAWS_ORACLE_SESSION_ID: the fully-resolved operating identity. Falls back to
# HOOK_SESSION_ID when the helper is absent (back-compat). This is what the
# oracle compares against the worktree's stamped owner — matching the resolver
# chain the stamper used, so owner-self recognition works across all harnesses.
if declare -F resolve_caws_session_id_with_payload >/dev/null 2>&1; then
  CAWS_ORACLE_SESSION_ID="$(resolve_caws_session_id_with_payload "${HOOK_SESSION_ID:-}")"
else
  CAWS_ORACLE_SESSION_ID="${HOOK_SESSION_ID:-}"
fi
export CAWS_ORACLE_SESSION_ID

caws_source_lib heredoc.sh 2>/dev/null || true

TOOL_NAME="$HOOK_TOOL_NAME"
COMMAND="$HOOK_COMMAND"

# Parsed exports are observations, not a replacement execution envelope. In a
# dispatcher child the original stdin is replayed even when parsing fast-paths;
# a standalone parser instead keeps the full local JSON or its transport file.
if [[ -n "${HOOK_PAYLOAD_FILE:-}" ]]; then
  if [[ ! -f "$HOOK_PAYLOAD_FILE" || ! -r "$HOOK_PAYLOAD_FILE" ]]; then
    echo '[bash-write-guard] UNRESOLVED: original payload transport file is unavailable.' >&2
    exit 2
  fi
elif [[ -z "${HOOK_INPUT_JSON:-}" ]]; then
  HOOK_INPUT_JSON="$(cat)" || exit 2
  export -n HOOK_INPUT_JSON 2>/dev/null || true
fi
original_payload() {
  if [[ -n "${HOOK_PAYLOAD_FILE:-}" ]]; then cat "$HOOK_PAYLOAD_FILE"
  else printf '%s' "${HOOK_INPUT_JSON:-}"; fi
}
ORIGINAL_TOOL="$(original_payload | node -e '
const fs = require("node:fs");
try {
  const value = JSON.parse(fs.readFileSync(0, "utf8"));
  if (!value || typeof value.tool_name !== "string" || !value.tool_name) process.exit(1);
  process.stdout.write(value.tool_name);
} catch { process.exit(1); }
' 2>/dev/null)" || {
  echo '[bash-write-guard] UNRESOLVED: original tool metadata is missing or malformed.' >&2
  exit 2
}
case "$ORIGINAL_TOOL" in
  Bash|exec_command|functions.exec_command|shell_command|functions.shell_command) ;;
  *) exit 0 ;;
esac

CAWS_CLAIM_ORACLE="$SCRIPT_DIR/lib/worktree-claim-oracle.cjs"

# Git is how this guard finds the canonical checkout and which session owns a
# linked worktree. Without it a worktree reads as an ungoverned directory, and
# a foreign mutation would be admitted at the governance check below.
command -v git >/dev/null 2>&1 || _bwg_git_refuse

# Resolve canonical root. Path identity is compared byte for byte, and a
# legitimate root may end in a line feed that command substitution would
# strip; the stripped root names no directory, so the governance check below
# would find no .caws and admit. Every path is therefore assigned through the
# out-parameter helpers in lib/caws-state.sh.
_BWG_START="${CAWS_PROJECT_DIR:-.}"
# No answer from git means "not a repository" only where no .git entry exists
# on the directory or any ancestor. Otherwise git failed (a broken worktree, a
# failing binary) and the directory must not be read as ungoverned.
caws_physical_dir_into _BWG_START_PHYSICAL "$_BWG_START" || _BWG_START_PHYSICAL=""
if ! caws_git_path_into _BWG_GIT_DIR "$_BWG_START" --git-dir &&
    caws_git_evidence_dir_into _BWG_GIT_EVIDENCE "$_BWG_START_PHYSICAL"; then
  _bwg_git_failed_refuse "$_BWG_START" "$_BWG_GIT_EVIDENCE/.git"
fi
caws_resolve_canonical_dir_into _BWG_PROJECT_RAW "$_BWG_START" || _bwg_resolve_refuse "$?" "$_BWG_START"
# Compare the same physical identity used by abspath for mutation targets.
# A logical alias such as /tmp or a symlinked project root is still this repo.
caws_guard_realpath_into PROJECT_DIR "$_BWG_PROJECT_RAW" || _bwg_normalize_refuse "project root" "$_BWG_PROJECT_RAW"

# The command analysis transport (caws.shell_mutation_view.v2) carries the
# operating directory as a coordinate that cannot hold a carriage return, line
# feed or tab. The operating directory is the payload's cwd when it names a
# directory, otherwise the project root (see _CWD_RESOLVED below), and the
# analyzer resolves it to its physical path, so an ordinary alias of such a
# directory reaches the same limit. It is refused here, before the governance
# check, rather than reaching the analyzer as an invalid contract.
_BWG_TRANSPORT_CWD="$PROJECT_DIR"
if [[ -n "${HOOK_CWD:-}" && -d "$HOOK_CWD" ]]; then
  caws_physical_dir_into _BWG_TRANSPORT_CWD "$HOOK_CWD" || _BWG_TRANSPORT_CWD="$HOOK_CWD"
fi
if [[ "$_BWG_TRANSPORT_CWD" == *[$'\r\n\t']* ]]; then
  echo "[bash-write-guard] the operating directory's physical path $(printf '%q' "$_BWG_TRANSPORT_CWD") contains a carriage return, line feed or tab, which the command mutation analysis transport cannot carry as a coordinate, so this command's write targets cannot be established. Failing CLOSED." >&2
  printf '{"decision":"block","reason":"CAWS bash-write-guard: the operating directory contains a carriage return, line feed or tab, which the command mutation analysis transport cannot carry, so write targets cannot be established. Failing closed."}\n'
  exit 2
fi

[[ -d "$PROJECT_DIR/.caws" ]] || exit 0
if [[ ! -f "$CAWS_CLAIM_ORACLE" ]] || ! command -v node >/dev/null 2>&1; then
  echo '[bash-write-guard] Ownership infrastructure unavailable in a governed project; failing closed. Restore the shared runtime with caws init adapters install.' >&2
  exit 2
fi

AGENT_CWD="${HOOK_CWD:-${CAWS_PROJECT_DIR:-.}}"

# The operating cwd is KNOWN only when the payload named a directory that
# exists. Otherwise AGENT_CWD above is a guess (the canonical root), and a
# relative mutation target resolved against a guess carries no ownership answer:
# `echo x > file.txt` may really mean another worktree's file. Relative targets
# are then handed to the oracle UNRESOLVED, flagged, so it answers
# ask_uncertain instead of classifying them as canonical paths.
#
# That fail-closed answer applies only to surfaces whose payload contract
# carries `cwd` (decision recorded in CAWS-DEFECT-CLAIM-ORACLE-CWD-RELATIVE-
# PATH-01): there a missing cwd is a degraded payload and asking is right. On a
# surface whose contract is unverified, an absent cwd is the normal case, and
# asking would refuse every relative write (a false refusal, ranked worse than
# the narrow fail-open), so those keep the prior behavior of resolving against
# the guess. The surface list lives in caws_payload_carries_cwd
# (lib/caws-state.sh), shared with worktree-write-guard so a relative Write and
# a relative Bash mutation get the same answer.
# CAWS_AGENT_SURFACE is set by lib/agent-surface.sh (sourced above), which
# defaults an unset value to claude-code.
_CWD_CONTRACT=0
caws_payload_carries_cwd && _CWD_CONTRACT=1
_CWD_RESOLVED=0
[[ -n "${HOOK_CWD:-}" && -d "$HOOK_CWD" ]] && _CWD_RESOLVED=1
# Codex session cwd anchors governance but does not identify the Bash command
# directory. The native/compatibility ingress overwrites inherited HOOK_* and
# computes this status from the validated host execution_workdir field.
_CODEX_EXECUTION_CWD_UNAVAILABLE=0
if [[ "${CAWS_AGENT_SURFACE:-}" == "codex" ]]; then
  _CWD_RESOLVED=0
  if [[ "${HOOK_EXECUTION_WORKDIR_STATUS:-}" == "resolved" && "${HOOK_CWD:-}" == /* && -d "$HOOK_CWD" ]]; then
    _CWD_RESOLVED=1
  else
    _CODEX_EXECUTION_CWD_UNAVAILABLE=1
  fi
fi

# CAWS-BASH-GUARD-BOUNDARY-DIVERGENCE-01: the cross-repository boundary.
#
# scope-guard hard-blocks a Write/Edit whose target is in a different repository
# and tells the reader that routing around it through Bash "hits the same
# boundary". It did not: every verdict below this point comes from the
# worktree-claim oracle, whose vocabulary (pass / block_foreign_worktree /
# block_claimed / ask_uncertain / ...) has no cross-repo member at all. A
# `sed -i` into a sibling repo was adjudicated for worktree claims in THIS repo,
# found none, and was permitted.
#
# The boundary enforced here is deliberately NARROWER than scope-guard's, and
# the difference is not an oversight. scope-guard refuses any absolute target
# outside the project; applying that to Bash would refuse ordinary scratch
# (`cat > /tmp/patch.py`), which is normal and safe. The harm scope-guard
# actually names is mutating "files (especially executables) outside its
# governing repo" — so the predicate here is "inside a DIFFERENT git
# repository", which /tmp is not.
# CAWS-GUARD-REMEDIATION-CROSS-REPO-CONSISTENCY-01 moved the predicate itself
# into lib/bash-mutation-targets.sh (caws_foreign_repo_root) because
# block-dangerous needs the SAME answer: its opaque-exec remediation used to
# offer "write the probe to a script file and run it by path" even when the
# payload's write target was in another repository — a route this guard
# refuses. One guard recommending what another refuses is how an agent gets
# walked out of the repo, so the two now read one implementation.
foreign_repo_root() {
  caws_foreign_repo_root "$1" "$PROJECT_DIR"
}

# --- target extraction (NARROW) --------------------------------------------
# Moved to lib/bash-mutation-targets.sh so casr-context.sh can consume the same
# recognizer without sourcing this guard (which parses input, resolves session
# state and then invokes the ownership oracle). The guard keeps its own
# fail-CLOSED posture on a missing lib; CASR keeps its fail-open posture. The
# AST-required mode supplies typed expansions to the existing utility-role rules.
# Governance: CASR-CONTEXT-DELIVERED-BY-TOOL-NAME-NOT-WRITE-TARGET-01.
if [[ -r "$SCRIPT_DIR/lib/bash-mutation-targets.sh" ]]; then
  # shellcheck source=lib/bash-mutation-targets.sh
  source "$SCRIPT_DIR/lib/bash-mutation-targets.sh"
fi
if ! declare -F caws_bash_mutation_candidates >/dev/null 2>&1; then
  echo "[bash-write-guard] CAWS hook infrastructure incomplete: lib/bash-mutation-targets.sh is missing or did not load — cannot extract Bash mutation targets. Failing CLOSED. Restore the shared hook libs with: caws init adapters install" >&2
  printf '{"decision":"block","reason":"CAWS bash-write-guard: cannot load lib/bash-mutation-targets.sh, so Bash-mutation targets cannot be extracted. Failing closed. Restore the hook pack: caws init adapters install"}\n'
  exit 2
fi
# A lib PRESENT but older than this guard is the more dangerous shape: the
# entry point above resolves, the guard runs, and the cross-repo arm silently
# adjudicates nothing — a fail-OPEN that no output reports. Each function this
# guard depends on is therefore checked by name, not inferred from one.
for _fn in caws_foreign_repo_root caws_bash_mutation_effects; do
  if ! declare -F "$_fn" >/dev/null 2>&1; then
    echo "[bash-write-guard] CAWS hook infrastructure incomplete: lib/bash-mutation-targets.sh loaded but does not provide $_fn — the cross-repository arm cannot run. Failing CLOSED. Update the shared hook libs with: caws init adapters install" >&2
    printf '{"decision":"block","reason":"CAWS bash-write-guard: lib/bash-mutation-targets.sh is present but stale (missing %s), so the cross-repository boundary cannot be adjudicated. Failing closed. Update the hook pack: caws init adapters install"}\n' "$_fn"
    exit 2
  fi
done

# The analyzer supplies syntax observations. Existing mutation policies decide.
CAWS_BASH_ANALYSIS_REQUIRED=1
if [[ ! -r "$SCRIPT_DIR/lib/bash-mutation-analysis.sh" ]] ||
    ! source "$SCRIPT_DIR/lib/bash-mutation-analysis.sh" ||
    ! declare -F caws_bash_prepare_analysis >/dev/null 2>&1 ||
    ! caws_bash_prepare_analysis "$COMMAND" "$AGENT_CWD" "$PROJECT_DIR"; then
  echo "[bash-write-guard] UNRESOLVED: ${CAWS_BASH_ANALYSIS_ERROR:-command mutation analysis bridge is unavailable}. Failing CLOSED; no legacy fallback." >&2
  exit 2
fi

CAWS_COPY_FINAL_SYMLINK=''
if [[ ! -r "$SCRIPT_DIR/lib/copy-roles.sh" ]] ||
    ! source "$SCRIPT_DIR/lib/copy-roles.sh" ||
    ! caws_copy_role_paths "$PROJECT_DIR"; then
  echo '[bash-write-guard] copy-role path infrastructure is unavailable; failing closed.' >&2
  exit 2
fi
if [[ "$CAWS_COPY_CANONICAL" == 1 ]]; then
  echo 'BLOCKED: Copying files from a worktree to the main repo is forbidden.' >&2
  exit 2
fi
case "${CAWS_COPY_FINAL_SYMLINK:-}" in
  0|1) ;;
  *) echo '[bash-write-guard] copy-role final-entry observation is unavailable; failing closed.' >&2; exit 2 ;;
esac
extract_targets() {
  # Preserve per-operand effects; equal path spellings can have different roles.
  # Interpreter/copy/broad paths keep their existing referent interpretation.
  local effects paths candidate
  effects="$(caws_bash_mutation_effects "$1")" || return 2
  [[ -z "$effects" ]] || printf '%s\n' "$effects"
  paths="$(caws_bash_analysis_interpreter_writes "$1")" || return 2
  while IFS= read -r candidate; do
    [[ -z "$candidate" ]] || printf 'referent\t%s\n' "$candidate"
  done <<< "$paths"
  for candidate in ${CAWS_COPY_WRITE_TARGET[@]+"${CAWS_COPY_WRITE_TARGET[@]}"}; do
    printf 'referent\t%s\n' "$candidate"
  done
  if declare -F caws_bash_broad_mutations >/dev/null 2>&1; then
    # Do not turn a cwd-relative broad mutation into a guessed absolute path.
    local broad_base="$AGENT_CWD"
    [[ "$_CODEX_EXECUTION_CWD_UNAVAILABLE" == "1" ]] && broad_base="."
    paths="$(caws_bash_broad_mutations "$1" "$broad_base" | cut -f2)" || return 2
    while IFS= read -r candidate; do
      [[ -z "$candidate" ]] || printf 'referent\t%s\n' "$candidate"
    done <<< "$paths"
  fi
  return 0
}

# abspath_into <var> <path>: caws_guard_realpath_into's status; every caller
# refuses on failure.
abspath_into() {
  case "$2" in
    /*) caws_guard_realpath_into "$1" "$2" ;;
    *)  caws_guard_realpath_into "$1" "$AGENT_CWD/$2" ;;
  esac
}

# A remove operation unlinks a literal final symlink, not its referent.
# Physical ancestors still determine entry ownership and repository membership.
mutation_target_into() {
  local _effect_role="$3" _effect_candidate="$4"
  local _effect_full _effect_parent _effect_leaf
  case "$_effect_candidate" in
    /*) _effect_full="$_effect_candidate" ;;
    *) _effect_full="$AGENT_CWD/$_effect_candidate" ;;
  esac
  _effect_leaf="${_effect_full##*/}"
  if [[ "$_effect_role" == unlink-entry* && -n "$_effect_leaf" &&
        "$_effect_leaf" != . && "$_effect_leaf" != .. && -L "$_effect_full" ]]; then
    _effect_parent="${_effect_full%/*}"
    [[ -n "$_effect_parent" ]] || _effect_parent=/
    caws_physical_dir_into _effect_parent "$_effect_parent" || return 1
    printf -v "$1" '%s/%s' "${_effect_parent%/}" "$_effect_leaf"
    printf -v "$2" '%s' "$_effect_parent"
  else
    abspath_into "$1" "$_effect_candidate" || return 1
    printf -v "$2" '%s' "${!1}"
  fi
}

# --- decide -----------------------------------------------------------------
WORST="pass"
WORST_DETAIL=""
WORST_KIND=""
_BWG_REMOVE_UNRESOLVED=0

escalate() {
  local rank_new rank_cur
  case "$1" in pass) rank_new=0 ;; ask) rank_new=1 ;; block) rank_new=2 ;; esac
  case "$WORST" in pass) rank_cur=0 ;; ask) rank_cur=1 ;; block) rank_cur=2 ;; esac
  if [[ "$rank_new" -gt "$rank_cur" ]]; then
    WORST="$1"; WORST_DETAIL="$2"; WORST_KIND="$3"
  fi
}

if [[ -n "$CAWS_COPY_UNRESOLVED" ]]; then
  escalate ask "$CAWS_COPY_UNRESOLVED" ask_copy_paths
fi

if ! _BWG_EFFECTS="$(extract_targets "$COMMAND")"; then
  _bwg_normalize_refuse 'mutation effect stream' "$COMMAND"
fi
while IFS= read -r effect; do
  [[ -z "$effect" ]] && continue
  if [[ "$effect" != *$'\t'* ]]; then
    _bwg_normalize_refuse 'mutation effect record' "$effect"
  fi
  effect_role="${effect%%$'\t'*}"
  cand="${effect#*$'\t'}"
  case "$effect_role" in
    referent|unlink-entry|unlink-entry-unresolved) ;;
    *) _bwg_normalize_refuse 'mutation effect role' "$effect_role" ;;
  esac
  if [[ -z "$cand" || "$cand" == *$'\t'* ]]; then
    _bwg_normalize_refuse 'mutation effect path' "$cand"
  fi
  if [[ "$effect_role" == unlink-entry* ]]; then
    case "$effect_role:$cand" in
      unlink-entry-unresolved:*|*:*/|*:*/.|*:*/..|*:'.'|*:'..')
        _BWG_REMOVE_UNRESOLVED=1 ;;
    esac
  fi
  # Candidates arrive byte-faithful. The recognizer's lexer consumes syntactic
  # quote delimiters as it scans and never introduces a sentinel, so a quoted
  # operand already reads as the path it names and `rm "harness/wire/some
  # file.py"` arrives as one operand containing its space. The sentinel
  # restoration and quote stripping that stood here undid damage the old
  # tokenizer did and were removed with it.
  # Unknown Codex command context cannot justify ANY guessed relative root,
  # including an allowlisted target or a supposed foreign worktree/repository.
  # Absolute targets still carry their own coordinate and reach every boundary.
  if [[ "$_CODEX_EXECUTION_CWD_UNAVAILABLE" == "1" ]]; then
    case "$cand" in
      /*) ;;
      *) escalate ask "$cand" "unavailable_native_context"; continue ;;
    esac
  fi
  if [[ "$_CWD_RESOLVED" != 1 && "$_CWD_CONTRACT" == 1 && "$cand" != /* ]]; then
    # Relative bytes carry no filesystem coordinate, including when the
    # registry has no active worktrees. Never resolve them against a guess.
    escalate ask "cwd-unresolved:$cand" "ask_uncertain"
    continue
  fi
  mutation_target_into abs _FOREIGN_PROBE "$effect_role" "$cand" ||
    _bwg_normalize_refuse "mutation target" "$cand"
  # CAWS-GUARD-ALLOWLIST-SYNC-001 + CAWS-GUARD-SCOPE-PRIORITY-001: record
  # whether this target is on the unconditional allowlist (docs/*, .caws/*
  # minus payload, .tmp/*, .github/*, vendor dir, instruction files,
  # agent-home dir). The oracle STILL runs — a scope.in CLAIM overrides the
  # allowlist, so a claimed docs/** path must block (block_claimed) just like
  # a claimed src/** path. But for an allowlisted path, only a CLAIM/ownership
  # block escalates; pass/degraded/ask/error do NOT (an unclaimed allowlisted
  # path is permitted, and a toolchain fault must not block it). Payload paths
  # (.caws/worktrees/*) are excluded by the helper and always escalate normally.
  # Cross-repo is adjudicated BEFORE the allowlist and the claim oracle: the
  # allowlist names paths relative to THIS project, so applying it to a sibling
  # repo's tree would admit its docs/, tests/ and .caws/ wholesale.
  _FOREIGN_REPO="$(foreign_repo_root "$_FOREIGN_PROBE"; printf x)"
  _FOREIGN_REPO="${_FOREIGN_REPO%x}"
  if [[ -n "$_FOREIGN_REPO" ]]; then
    escalate block "$_FOREIGN_REPO" "block_foreign_repo"
    continue
  fi
  _CAND_ALLOWLISTED=0
  if declare -F caws_is_write_allowlisted >/dev/null 2>&1; then
    if caws_is_write_allowlisted "$abs" "$PROJECT_DIR"; then
      _CAND_ALLOWLISTED=1
    fi
  fi
  _ORACLE_PATH="$abs"
  _CWD_UNRESOLVED=""
  if [[ "$_CWD_RESOLVED" != "1" && "$_CWD_CONTRACT" == "1" ]]; then
    case "$cand" in
      /*) ;;
      *) _ORACLE_PATH="$cand"; _CWD_UNRESOLVED=1 ;;
    esac
  fi
  _REMOVE_TREE=0
  if [[ "$effect_role" == unlink-entry* && -d "$abs" && ! -L "$abs" ]]; then
    _REMOVE_TREE=1
  fi
  out="$(CAWS_ORACLE_OPERATION=file CAWS_ORACLE_PROJECT_DIR="$PROJECT_DIR" \
    CAWS_ORACLE_REMOVE_TREE="$_REMOVE_TREE" \
    CAWS_ORACLE_CURRENT_BRANCH="" \
    CAWS_ORACLE_REL_PATH="$_ORACLE_PATH" \
    CAWS_ORACLE_CWD_UNRESOLVED="$_CWD_UNRESOLVED" \
    CAWS_ORACLE_SESSION_ID="$CAWS_ORACLE_SESSION_ID" \
    node "$CAWS_CLAIM_ORACLE" 2>&1 || true)"
  _first="${out%%$'\n'*}"
  case "${_first%%:*}" in
    pass|block_foreign_worktree|block_claimed|ask_uncertain|error_fail_closed|degraded_no_yaml)
      out="$_first" ;;
    *)
      _reason="$(printf '%s' "$_first" | cut -c1-200)"
      out="error_fail_closed:oracle-spawn (${_reason:-no output})" ;;
  esac
  outcome="${out%%:*}"
  detail="${out#*:}"
  case "$outcome" in
    pass) ;;
    # degraded_no_yaml is a TOOLCHAIN FAULT, not an ownership signal: the oracle
    # got PAST the yaml-free foreign-payload block and only the cross-worktree
    # canonical-claim check could not run (js-yaml unresolvable). Do NOT escalate
    # (it would turn every canonical mutation into an approval prompt when js-yaml
    # is absent). Record it for a single post-loop advisory; the mutation flows.
    degraded_no_yaml) _DEGRADED_NO_YAML=1 ;;
    block_foreign_worktree|block_claimed) escalate block "$detail" "$outcome" ;;
    ask_uncertain|error_fail_closed)
      if [[ "$detail" == remove-tree-* ||
            ( "$_REMOVE_TREE" == 1 && "$outcome" == error_fail_closed ) ]]; then
        _BWG_REMOVE_UNRESOLVED=1
        continue
      fi
      # Coordination allowlists tolerate canonical scope-tool faults, but
      # cannot establish cwd or registered payload ownership. Those specific
      # uncertainties survive even under docs/** and .caws/** custom roots.
      if [[ "$_CAND_ALLOWLISTED" == "1" && "$detail" != cwd-unresolved:* &&
            "$detail" != worktree-container-* && "$detail" != worktree-payload-* &&
            "$detail" != worktree-ownership-* ]]; then
        :
      else
        escalate ask "$detail" "$outcome"
      fi
      ;;
  esac
done <<< "$_BWG_EFFECTS"

# Git add/commit write Git metadata rather than a payload FILE. Validate both
# metadata roots at the repository boundary, then query the actual worktree's
# owner through a distinct, capability-namespaced oracle operation.
_GM_INDEX=0; _GM_SEEN_CONTEXTS=()
while [[ $_GM_INDEX -lt ${#CAWS_AST_GIT_WORKTREE[@]} ]]; do
  _GM_WORKTREE="${CAWS_AST_GIT_WORKTREE[$_GM_INDEX]}"
  _GM_DIRECTORY="${CAWS_AST_GIT_DIRECTORY[$_GM_INDEX]}"
  _GM_COMMON="${CAWS_AST_GIT_COMMON[$_GM_INDEX]}"
  _GM_FOREIGN=''
  for _GM_PATH in "$_GM_DIRECTORY" "$_GM_COMMON"; do
    # An absent coordinate stays an uncertainty for approval; a coordinate that
    # cannot be normalized is refused like every other ownership path.
    if [[ -z "$_GM_PATH" ]]; then
      escalate ask metadata-path-unresolved ask_git_metadata
      continue
    fi
    caws_guard_realpath_into _GM_PHYSICAL "$_GM_PATH" || _bwg_normalize_refuse "git metadata" "$_GM_PATH"
    if [[ "$_GM_PHYSICAL" != /* ]]; then
      escalate ask metadata-path-unresolved ask_git_metadata
      continue
    fi
    if [[ "$_GM_PHYSICAL" == *$'\n'* || "$_GM_PHYSICAL" == *$'\r'* || "$_GM_PHYSICAL" == *$'\t'* ]]; then
      escalate ask metadata-path-unrepresentable ask_git_metadata
      continue
    fi
    _GM_REPO="$(foreign_repo_root "$_GM_PHYSICAL"; printf x)"
    _GM_REPO="${_GM_REPO%x}"
    [[ -z "$_GM_REPO" ]] || _GM_FOREIGN="$_GM_REPO"
    case "$_GM_PHYSICAL" in
      "$PROJECT_DIR"|"${PROJECT_DIR%/}/"*) ;;
      *) escalate ask metadata-outside-project ask_git_metadata ;;
    esac
  done
  _GM_INDEX=$((_GM_INDEX+1))
  if [[ -n "$_GM_FOREIGN" ]]; then
    escalate block "$_GM_FOREIGN" block_foreign_repo
    continue
  fi
  _GM_SEEN=0
  _GM_KEY="${#_GM_DIRECTORY}:$_GM_DIRECTORY${#_GM_COMMON}:$_GM_COMMON${#_GM_WORKTREE}:$_GM_WORKTREE"
  for _GM_PRIOR in ${_GM_SEEN_CONTEXTS[@]+"${_GM_SEEN_CONTEXTS[@]}"}; do
    [[ "$_GM_PRIOR" != "$_GM_KEY" ]] || _GM_SEEN=1
  done
  [[ $_GM_SEEN == 0 ]] || continue
  _GM_SEEN_CONTEXTS+=( "$_GM_KEY" )
  _GM_STATUS=0
  _GM_OUT="$(CAWS_ORACLE_OPERATION=git-metadata CAWS_ORACLE_PROJECT_DIR="$PROJECT_DIR" \
    CAWS_ORACLE_CURRENT_BRANCH='' CAWS_ORACLE_REL_PATH='' \
    CAWS_ORACLE_GIT_WORKTREE="$_GM_WORKTREE" CAWS_ORACLE_GIT_DIRECTORY="$_GM_DIRECTORY" \
    CAWS_ORACLE_GIT_COMMON="$_GM_COMMON" CAWS_ORACLE_SESSION_ID="$CAWS_ORACLE_SESSION_ID" \
    node "$CAWS_CLAIM_ORACLE" 2>&1)" || _GM_STATUS=$?
  _GM_FIRST="${_GM_OUT%%$'\n'*}"
  if [[ "$_GM_FIRST" != git_metadata:* || "$_GM_FIRST" == *$'\r'* || "$_GM_FIRST" == *$'\t'* ]]; then
    escalate ask git-metadata-oracle-protocol ask_git_metadata
    continue
  fi
  _GM_VERDICT="${_GM_FIRST#git_metadata:}"
  _GM_OUTCOME="${_GM_VERDICT%%:*}"; _GM_DETAIL="${_GM_VERDICT#*:}"
  case "$_GM_OUTCOME" in
    block_foreign_worktree)
      case "$_GM_DETAIL" in
        ?*:?*) escalate block "$_GM_DETAIL" block_git_metadata ;;
        *) escalate ask git-metadata-oracle-protocol ask_git_metadata ;;
      esac ;;
    pass)
      if [[ $_GM_STATUS != 0 || "$_GM_OUT" != "$_GM_FIRST" ]]; then
        escalate ask git-metadata-oracle-protocol ask_git_metadata
      else
        case "$_GM_DETAIL" in
          git-canonical-metadata|owner-self:?*) ;;
          *) escalate ask git-metadata-oracle-protocol ask_git_metadata ;;
        esac
      fi ;;
    ask_uncertain|error_fail_closed) escalate ask "$_GM_DETAIL" ask_git_metadata ;;
    *) escalate ask git-metadata-oracle-protocol ask_git_metadata ;;
  esac
done

# --- DYNAMIC operands -------------------------------------------------------
# A dynamic operand (rm core/*.py) names a file-scoped mutation whose target
# POPULATION is only known at execution time. The recognizer deliberately does
# not expand it, so the guard cannot ask the ownership oracle about the actual
# files. It must still take a position, and the conservative one is derived
# rather than invented:
#
#   1. If the pattern's STATIC PREFIX lies inside a foreign worktree, the
#      existing ownership mechanism yields a positive verdict on evidence the
#      guard already trusts -> BLOCK.
#   2. ABSENCE OF A WORKTREE CLAIM IS NOT A CONFINEMENT PROOF. The former rule
#      "no active worktrees -> ALLOW" is withdrawn as unsound under the
#      broadened DYNAMIC type. This guard adjudicates block_foreign_repo BEFORE
#      the claim oracle and independently of worktree state, so an unresolved
#      `$TARGET` or `$(choose_path)` could resolve into a SIBLING REPOSITORY
#      while zero worktrees are active. An empty registry proves only that no
#      WORKTREE claim exists. Allow requires proof that every possible
#      resolution is confined; only a prefix the producer proved lexically can
#      supply it.
#   3. Otherwise -> ASK. Crucially, a `pass` on the static prefix is NOT a pass
#      here. `pass:unclaimed` on `core` means only that `core` itself carries no
#      claim; measured 2026-09-11, the oracle's canonical branch tests
#      globToRegExp(claim).test(candidate), so a file-specific claim on
#      core/a.py cannot match the candidate `core` and would be silently
#      dropped. Letting prefix-pass become a final pass is exactly the leak this
#      policy exists to prevent.
#
# This is a disposition over UNCERTAINTY, not a pattern-overlap oracle; building
# one is out of scope for this slice.
# The static prefix is NO LONGER computed here. The producer derives it from
# preserved lexical structure and ships it in the DYNAMIC record with an explicit
# basis. Recomputing it guard-side would restore two independent interpreters on
# opposite sides of the shared boundary -- the exact defect this lane removes --
# and the guard's copy could not see quoting the lexer already resolved.

_caws_active_worktrees_exist() {
  local reg="$PROJECT_DIR/.caws/worktrees.json"
  [[ -r "$reg" ]] || return 1
  grep -q '"path"' "$reg" 2>/dev/null
}

if declare -F caws_bash_dynamic_mutations >/dev/null 2>&1; then
  # HERE-STRING, not `< <(...)`: a process substitution runs the loop body in a
  # SUBSHELL, so `escalate`'s assignment to WORST would be discarded and every
  # dynamic verdict would compute correctly and then vanish.
  while IFS="$(printf '\t')" read -r _pat _reskind _prefix _basis _dynbase; do
    [[ -z "$_pat" ]] && continue
    if [[ "$_CODEX_EXECUTION_CWD_UNAVAILABLE" == "1" ]]; then
      case "$_pat" in
        /*) ;;
        *) escalate ask "$_pat" "unavailable_native_context"; continue ;;
      esac
    fi
    # CONSUME the producer's prefix; never re-derive it.
    if [[ "$_basis" != "lexically_proven" || -z "$_prefix" ]]; then
      # No provable confinement: the target could resolve anywhere, including
      # into a sibling repository that the claim oracle never examines.
      escalate ask "$_pat (${_reskind:-runtime}-resolved; no lexically proven prefix, so no region is proven admissible)" "ask_dynamic_unconfined"
      continue
    fi
    abspath_into _pabs "$_prefix" || _bwg_normalize_refuse "dynamic mutation prefix" "$_prefix"
    _dout="$(CAWS_ORACLE_PROJECT_DIR="$PROJECT_DIR" \
      CAWS_ORACLE_CURRENT_BRANCH="" \
      CAWS_ORACLE_REL_PATH="$_pabs" \
      CAWS_ORACLE_SESSION_ID="$CAWS_ORACLE_SESSION_ID" \
      node "$CAWS_CLAIM_ORACLE" 2>&1 || true)"
    _dfirst="${_dout%%$'\n'*}"
    case "${_dfirst%%:*}" in
      block_foreign_worktree|block_claimed)
        # Positive ownership verdict on the static prefix: evidence the guard
        # already acts on, independent of how the pattern expands.
        escalate block "$_pat (dynamic operand under ${_dfirst#*:})" "block_dynamic_foreign" ;;
      *)
        # A pass on the PREFIX is not a pass on the population: the oracle's
        # canonical branch tests globToRegExp(claim).test(candidate), so a
        # file-specific claim on core/a.py cannot match the candidate `core`.
        # Ask regardless of whether the registry currently holds any worktree --
        # emptiness is not a confinement proof.
        escalate ask "$_pat (${_reskind:-runtime}-resolved population under $_prefix; prefix verdict ${_dfirst%%:*} proves nothing about descendant claims)" "ask_dynamic_unresolved"
        ;;
    esac
  done <<< "$(caws_bash_dynamic_mutations "$COMMAND" "$AGENT_CWD")"
fi

# --- UNREPRESENTABLE targets -----------------------------------------------
# An operand the record carrier cannot transport (embedded newline/tab). Measured
# 2026-09-11: such a path splits into fragments, NEITHER of which matches a
# file-specific canonical claim, so the write is permitted -- an ownership
# BYPASS, not over-recognition. The guard never sees the bytes here (that is what
# "unrepresentable" means); it acts on the COUNT, which is enough to refuse.
if declare -F caws_bash_unrepresentable_count >/dev/null 2>&1; then
  _UNREPR_N="$(caws_bash_unrepresentable_count "$COMMAND" 2>/dev/null || echo 0)"
  if [[ "${_UNREPR_N:-0}" =~ ^[0-9]+$ && "${_UNREPR_N:-0}" -gt 0 ]]; then
    escalate ask "$_UNREPR_N operand(s) contain a newline or tab, which this recognizer's record carrier cannot transport faithfully; ownership cannot be adjudicated on a split target" "ask_unrepresentable_target"
  fi
fi

# --- UNSUPPORTED executable nesting ----------------------------------------
# Process substitution executes mutation-capable nested shell code this slice
# does not parse. Measured 2026-09-11: `cat <(echo x > CLAIMED)` returned ec=0
# where the plain form blocked. Silence here is indistinguishable from "no
# mutation", so presence alone must take a conservative posture.
if declare -F caws_bash_unsupported_nesting >/dev/null 2>&1; then
  while IFS= read -r _nest; do
    [[ -z "$_nest" ]] && continue
    escalate ask "unsupported shell context '$_nest'; mutation coordinates or nested execution could not be established" "ask_unsupported_nesting"
  done <<< "$(caws_bash_unsupported_nesting "$COMMAND" 2>/dev/null)"
fi

_BG_ID="CAWS bash-write-guard"
command -v guard_identity >/dev/null 2>&1 && _BG_ID="$(guard_identity bash-write-guard)"

# Keep an already observed ownership block; unresolved removal is a hard hold
# even when following an ambiguous final component happened to find an owner.
if [[ "$_BWG_REMOVE_UNRESOLVED" == 1 ]]; then
  escalate block 'unresolved remove options or final component' block_remove_unresolved
fi

# Preserve known ownership violations before refusing this unmodeled entry
# operation. An ask response cannot confine cp's failed-open unlink fallback.
if [[ "$CAWS_COPY_FINAL_SYMLINK" == 1 ]]; then
  escalate block final-destination-symlink block_copy_final_symlink
fi

case "$WORST" in
  block)
    if [[ "$WORST_KIND" == "block_remove_unresolved" ]]; then
      echo "[$_BG_ID] BLOCKED: unresolved remove options or final component; entry effects cannot be authorized." >&2
      exit 2
    fi
    if [[ "$WORST_KIND" == "block_copy_final_symlink" ]]; then
      echo "[$_BG_ID] BLOCKED: copy final destination symlink entry semantics are unmodeled; approval cannot authorize this operation." >&2
      exit 2
    fi
    if [[ "$WORST_KIND" == "block_foreign_repo" ]]; then
      echo "[$_BG_ID] BLOCKED: this Bash command mutates a file inside a DIFFERENT repository ($WORST_DETAIL), not this session's project ($PROJECT_DIR)." >&2
      echo "  A session may READ sibling repos freely but must not WRITE into one from here — the same boundary scope-guard applies to Write/Edit." >&2
      echo "  This is a CAWS governance decision. There is no in-band override." >&2
      echo "  To make the change: write an explicit HANDOFF for an agent rooted in that repo — WHAT to change, WHY, and the exact edit — and have that repo's own session apply it." >&2
      echo "  Do NOT edit ${CAWS_HOOKS_DIR:-.caws/hooks}/ or guard state to bypass this." >&2
      exit 2
    fi
    if [[ "$WORST_KIND" == "block_git_metadata" ]]; then
      _OWN_WT="${WORST_DETAIL%%:*}"
      echo "[$_BG_ID] BLOCKED: this Bash command writes Git metadata for worktree '$_OWN_WT', owned by a DIFFERENT session." >&2
      echo '  Run the operation through the session that owns that worktree.' >&2
    elif [[ "$WORST_KIND" == "block_foreign_worktree" ]]; then
      _OWN_WT="$(printf '%s' "$WORST_DETAIL" | cut -d: -f1)"
      echo "[$_BG_ID] BLOCKED: this Bash command mutates worktree '$_OWN_WT''s payload (.caws/worktrees/$_OWN_WT/...), owned by a DIFFERENT session." >&2
      echo "  A Bash mutation of another session's worktree files is the same isolation breach as a foreign Write/Edit — it is blocked at the same boundary." >&2
      echo "  This is a CAWS governance decision." >&2
      echo "  To work in worktree '$_OWN_WT', operate from a SESSION rooted there. 'caws claim' has NO worktree-name argument — it reads the current directory, so cd first: cd .caws/worktrees/$_OWN_WT && caws claim --takeover" >&2
    else
      IFS=',' read -ra _CLAIM_PAIRS <<< "$WORST_DETAIL"
      _LEAD_WT="${_CLAIM_PAIRS[0]%%:*}"
      _LEAD_PAT="${_CLAIM_PAIRS[0]#*:}"
      echo "[$_BG_ID] BLOCKED: this Bash command mutates '$_LEAD_WT:$_LEAD_PAT', claimed by an active worktree's scope.in." >&2
      _CLAIMANT_COUNT=${#_CLAIM_PAIRS[@]}
      if [[ "$_CLAIMANT_COUNT" -gt 1 ]]; then
        echo "  This path is claimed via scope.in by $_CLAIMANT_COUNT active worktrees:" >&2
        for _pair in "${_CLAIM_PAIRS[@]}"; do
          [[ -z "$_pair" ]] && continue
          _cw="${_pair%%:*}"
          _cp="${_pair#*:}"
          echo "    - worktree '$_cw' via scope.in '$_cp'" >&2
        done
        echo "  Route the edit through whichever single worktree should own it." >&2
      fi
      echo "  This is a CAWS governance decision." >&2
    fi
    echo "  Do NOT edit ${CAWS_HOOKS_DIR:-.caws/hooks}/ or guard state to bypass this." >&2
    exit 2 ;;
  ask)
    case "$WORST_KIND" in
      ask_copy_paths)
        _REASON="[$_BG_ID] Copy or move write paths could not be established ($WORST_DETAIL). This filesystem relation was not authorized; approve only if every affected path belongs to this session." ;;
      unavailable_native_context)
        _REASON="[$_BG_ID] unavailable-native-context: Codex did not provide a validated host command directory for relative target '$WORST_DETAIL'. Session cwd anchors the project but does not identify command execution cwd. No ownership conclusion was made. Supply native execution_workdir or use an absolute target." ;;
      ask_uncertain)
        if [[ "$WORST_DETAIL" == cwd-unresolved:* ]]; then
          _REASON="[$_BG_ID] ask_uncertain: the operating cwd could not be resolved for the relative path '${WORST_DETAIL#cwd-unresolved:}', so which file it names (this checkout or another worktree's payload) cannot be decided. Approve only if you know the target is yours to mutate, or rerun with an absolute path."
        else
          _REASON="[$_BG_ID] This Bash command targets a worktree-claimed or worktree-payload path and ownership could not be confirmed ($WORST_KIND:$WORST_DETAIL). Approve only if you own the target worktree; otherwise route the mutation through the owning worktree's session."
        fi ;;
      error_fail_closed)
        # A toolchain fault (oracle spawn failure, registry parse error, etc.) —
        # NOT an ownership conflict. Name it as such so the user is not misled
        # into thinking this path is worktree-claimed.
        _REASON="[$_BG_ID] Worktree-ownership could not be verified for this Bash mutation due to a TOOLCHAIN FAULT ($WORST_DETAIL), not a known ownership conflict. Approve if the target is safe to mutate from this session." ;;
      ask_unrepresentable_target)
        # NOT an ownership conflict and NOT a claimed path: the recognizer could
        # not TRANSPORT the operand, so no ownership question was ever put. Kept
        # distinct because collapsing it into the generic claim wording would
        # describe a conflict that was never adjudicated.
        _REASON="[$_BG_ID] ask_unrepresentable_target: $WORST_DETAIL. This is a CARRIER limit, not a known ownership conflict — the target was never adjudicated. Approve only if you know the target is yours to mutate." ;;
      ask_unsupported_nesting)
        _REASON="[$_BG_ID] ask_unsupported_nesting: $WORST_DETAIL. The nested command is outside this recognizer's parser envelope, so any write it performs was never adjudicated. Approve only if you know what the nested command writes." ;;
      ask_dynamic_unconfined|ask_dynamic_unresolved)
        _REASON="[$_BG_ID] $WORST_KIND: $WORST_DETAIL. The target is resolved at EXECUTION time, so ownership cannot be decided from the command text. Approve only if every path it can resolve to is yours to mutate." ;;
      ask_git_metadata)
        _REASON="[$_BG_ID] Git metadata ownership could not be established ($WORST_DETAIL). Approve only if the repository metadata and working tree belong to this session." ;;
      *)
        _REASON="[$_BG_ID] This Bash command targets a worktree-claimed or worktree-payload path and ownership could not be confirmed ($WORST_KIND:$WORST_DETAIL). Approve only if you own the target worktree; otherwise route the mutation through the owning worktree's session." ;;
    esac
    if caws_guard_cannot_ask; then
      echo "$_REASON" >&2
      echo "  (approval unavailable or automatically satisfied (mode=${HOOK_PERMISSION_MODE:-default}); blocked)" >&2
      exit 2
    fi
    emit_ask "$_REASON"
    exit 0 ;;
  *)
    # No claim/ownership escalation. If the cross-worktree canonical-claim check
    # degraded (js-yaml unresolvable), surface a single advisory so the skipped
    # check is visible — but the mutation is allowed (toolchain fault, not an
    # ownership conflict; the foreign-payload block already ran yaml-free).
    if [[ "${_DEGRADED_NO_YAML:-0}" == "1" ]]; then
      echo "[$_BG_ID] advisory: the cross-worktree scope.in claim check was SKIPPED for this mutation because js-yaml is unresolvable in the hook pack (toolchain fault, not an ownership conflict). The foreign-worktree-payload block still ran. Install js-yaml in the hook pack to restore the canonical-claim check." >&2
    fi
    exit 0 ;;
esac
