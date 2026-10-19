#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: shared
# hook_pack_version: 1
# caws_min_major: 11
# lineage_refs: 41
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
# Worktree Isolation Pin Guard (Entry 41, CAWS-DEFECT-WORKTREE-ISOLATION-PIN-
# RELEASE-01). A session whose project root lives inside .caws/worktrees/<name>
# is PINNED to that worktree: its commands must run there. Unlike the
# consumer-grown static pin that bricked sessions after they merged their own
# worktree, this pin has all three affordances:
#
#   RELEASE  — when the pinned directory no longer exists (merge/destroy
#              deleted it), the pin releases for the rest of the session with
#              a loud advisory. The bricked-session class (every later Bash
#              call refused, including pwd and `caws worktree create`, because
#              the remediation directory is gone) is impossible.
#   RE-POINT — `caws worktree create|ensure` is admitted even from an outside
#              working directory, so the next lane can be born.
#   EXIT     — `caws worktree merge|destroy` is admitted (quiet-merge.sh
#              reroots those commands to the repo root for CWD safety), which
#              is the sanctioned way the pin ends.
#
# The pin is DERIVED statelessly from CAWS_PROJECT_DIR on every call — no
# state file, no latch, no strike ramp — so it cannot outlive the directory
# it names. A pinned session's git operations must target its own worktree:
# `git -C <dir>` redirects and leading `cd <dir> && ... git ...` chains are
# refused when <dir> resolves to the canonical checkout or another worktree;
# git ops redirected to scratch dirs outside the repository stay permitted.
#
# OPT-IN: this guard installs with the shared pack but is NOT wired into the
# default dispatcher HANDLERS (it is a broad session-level cwd enforcement;
# the pack's default-wired guards are narrow). Enable by adding
# worktree-pin-guard.sh to the HANDLERS array in dispatch/pre_tool_use.sh.

set -euo pipefail

# Pin identity comes from the harness environment, never from command bytes.
SESSION_ROOT="${CAWS_PROJECT_DIR:-}"
case "$SESSION_ROOT" in
  *"/.caws/worktrees/"*) ;;
  *) exit 0 ;;
esac
CANONICAL="${SESSION_ROOT%%/.caws/worktrees/*}"
PIN_NAME="${SESSION_ROOT#*/.caws/worktrees/}"
PIN_NAME="${PIN_NAME%%/*}"
PIN_DIR="$CANONICAL/.caws/worktrees/$PIN_NAME"
[[ -n "$PIN_NAME" && -n "$CANONICAL" ]] || exit 0

emit_release() {
  echo "[worktree-pin-guard] worktree '$PIN_NAME' no longer exists: RELEASING this session's isolation pin." >&2
  echo "  Pinned to $PIN_DIR, which was merged or destroyed, so the isolation boundary is gone." >&2
  echo "  Continue from wherever the harness lands. To re-point, create a fresh lane:" >&2
  echo "    caws worktree create <name> --spec <id>   (then start the next slice's session inside it)" >&2
  exit 0
}

emit_block() {
  local why="$1"
  echo "[worktree-pin-guard] BLOCKED: $why" >&2
  echo "  This session is isolated in the worktree $PIN_DIR." >&2
  echo "  Re-run the command from $PIN_DIR." >&2
  echo "  Sanctioned exits: caws worktree merge|destroy <name> (end the isolation); caws worktree create|ensure (start a fresh lane)." >&2
  echo "  Do NOT edit ${CAWS_HOOKS_DIR:-.caws/hooks}/ or guard state to bypass this." >&2
  exit 2
}

[[ -d "$PIN_DIR" ]] || emit_release
# Parsed dispatcher fields are not a substitute for the original typed payload.
# Preserve stdin even when a dispatcher has already exported parsed markers.
if [[ -z "${HOOK_INPUT_JSON:-}" && -z "${HOOK_PAYLOAD_FILE:-}" ]]; then
  HOOK_INPUT_JSON="$(cat)"
  export -n HOOK_INPUT_JSON 2>/dev/null || true
fi
if [[ -n "${HOOK_PAYLOAD_FILE:-}" && ! -f "$HOOK_PAYLOAD_FILE" ]]; then
  emit_block "UNRESOLVED: the original payload transport file is unavailable."
fi

original_payload() {
  if [[ -n "${HOOK_PAYLOAD_FILE:-}" && -f "$HOOK_PAYLOAD_FILE" ]]; then
    cat "$HOOK_PAYLOAD_FILE"
  else
    printf '%s' "${HOOK_INPUT_JSON:-}"
  fi
}

# Scalar extraction stringifies malformed JSON values. Validate their type on
# the original payload before allowing a non-shell exemption.
[[ -d "$PIN_DIR" ]] || emit_release
ORIGINAL_TOOL="$(original_payload | node -e '
const fs = require("node:fs");
try {
  const payload = JSON.parse(fs.readFileSync(0, "utf8"));
  if (!payload || typeof payload.tool_name !== "string" || !payload.tool_name) process.exit(1);
  process.stdout.write(payload.tool_name);
} catch { process.exit(1); }
' 2>/dev/null)" || emit_block "UNRESOLVED: the original tool metadata is missing or malformed."

# Known non-Bash tools do not participate in this guard. Missing/malformed
# tool metadata under a live pin cannot establish that the call is exempt.
case "$ORIGINAL_TOOL" in
  Bash|exec_command|functions.exec_command|shell_command|functions.shell_command) ;;
  "") emit_block "UNRESOLVED: the hook tool is missing or malformed." ;;
  *) exit 0 ;;
esac
[[ -d "$PIN_DIR" ]] || emit_release

CAWS_BIN="${CAWS_BIN:-caws}"
command -v "$CAWS_BIN" >/dev/null 2>&1 || emit_block "UNRESOLVED: the command analyzer CLI is unavailable. Put caws on PATH or set CAWS_BIN."

# Neither the submitted command nor a reconstructed envelope enters shell code.
# --worktree is trusted argv; the CLI validates cwd from the original payload.
ANALYSIS_STATUS=0
ANALYSIS="$(original_payload | "$CAWS_BIN" hooks analyze --json --worktree "$PIN_DIR" 2>/dev/null)" || ANALYSIS_STATUS=$?

# Validate the entire result contract and its exit-code agreement before allow.
# A malformed/old CLI response is uncertainty, never an exemption.
if ! VALIDATED="$(printf '%s' "$ANALYSIS" | node -e '
const fs = require("node:fs");
try {
  const result = JSON.parse(fs.readFileSync(0, "utf8"));
  const codes = {allow:0, deny:1, unresolved:2};
  if (result.schema !== "caws.hooks_analyze.v1" || !Object.hasOwn(codes,result.decision) || Number(process.argv[1]) !== codes[result.decision]) throw Error();
  for (const [key, fields] of [["reasons",["code","message"]],["trace",["kind","detail"]]]) {
    if (!Array.isArray(result[key])) throw Error();
    for (const item of result[key]) {
      if (!item || fields.some(field => typeof item[field] !== "string") || !Number.isInteger(item.start) || !Number.isInteger(item.end) || item.start < 0 || item.end < item.start) throw Error();
    }
  }
  if (result.decision !== "allow" && result.reasons.length === 0) throw Error();
  process.stdout.write(result.decision);
  for (const item of result.reasons) process.stdout.write("\n  " + item.code + " [" + item.start + ":" + item.end + "]: " + JSON.stringify(item.message));
} catch { process.exit(1); }
' "$ANALYSIS_STATUS" 2>/dev/null)"; then
  emit_block "UNRESOLVED: the command analyzer did not return a valid decision."
fi

DECISION="${VALIDATED%%$'\n'*}"
DETAILS=""
[[ "$VALIDATED" == *$'\n'* ]] && DETAILS="${VALIDATED#*$'\n'}"
case "$DECISION" in
  allow) exit 0 ;;
  deny) emit_block "typed command analysis denied an operation outside the pinned worktree or an execution-bearing argument.
$DETAILS" ;;
  *) emit_block "UNRESOLVED: typed command analysis could not prove this command satisfies the worktree boundary.
$DETAILS" ;;
esac
