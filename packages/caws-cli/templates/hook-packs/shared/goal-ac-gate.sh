#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: shared
# hook_pack_version: 1
# caws_min_major: 11
# lineage_refs: 10,19,27
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
# CAWS-GOAL-AC-STOP-GATE-01 — hold a session to its bound spec's acceptance criteria.
#
# Opt-in. With no goal binding for this session the handler is a no-op and the
# stop chain behaves exactly as it did before this feature existed.
#
# When `caws goal set <spec-id>` has written a binding, this handler re-derives
# that spec's acceptance evidence with `caws specs verify-acs --json` and emits a
# {"decision":"block"} control decision while any criterion is unmet, so the
# session keeps working instead of stopping on an unproven claim.
#
# Why this and not the native /goal evaluator: that evaluator READS a rendering
# of a check in the transcript. This handler EXECUTES the check and reads its
# real exit status. The two can agree; only this one can be the authority.
#
# "Met" means verdict == verified. A not_rederived criterion is NOT a pass —
# narrative-only evidence is exactly what this gate exists to refuse.
#
# The gate never writes evidence: `caws specs evidence` remains the single
# writer of acceptance truth. It only ever reads verify-acs and writes its own
# block counter back into the binding file.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib/parse-input.sh
source "$SCRIPT_DIR/lib/parse-input.sh" 2>/dev/null || exit 0
# shellcheck source=lib/agent-surface.sh
source "$SCRIPT_DIR/lib/agent-surface.sh" 2>/dev/null || true
parse_hook_input || exit 0

# A1/A5 bound: after this many consecutive blocks with an unchanged unmet set,
# the gate degrades to a warning. A goal must never trap a session.
GOAL_MAX_CONSECUTIVE_BLOCKS="${CAWS_GOAL_MAX_CONSECUTIVE_BLOCKS:-3}"

ESCAPE_HINT='Clear it with: caws goal clear'

# No session identity -> no binding can be resolved -> inert. (A3)
if [[ -z "${HOOK_SESSION_ID:-}" || "$HOOK_SESSION_ID" == "unknown" ]]; then
  exit 0
fi

PROJECT_DIR="${CAWS_PROJECT_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
BINDING_FILE="$PROJECT_DIR/.caws/sessions/$HOOK_SESSION_ID/goal.json"

# The opt-in switch. No binding -> byte-identical to the pre-feature chain. (A3)
[[ -f "$BINDING_FILE" ]] || exit 0

if ! command -v python3 >/dev/null 2>&1; then
  # Fail LOUD, not closed: a missing interpreter is an operator problem, and
  # trapping every stop in the repo behind it would be worse than the gap.
  printf 'CAWS goal-ac-gate: python3 not found, so the acceptance gate cannot evaluate. Goal NOT enforced this stop. %s\n' "$ESCAPE_HINT" >&2
  exit 0
fi

emit_block() {
  # $1 = reason text (already free of raw newlines)
  python3 -c 'import json,sys; print(json.dumps({"decision":"block","reason":sys.argv[1]}))' "$1"
}

SPEC_ID="$(python3 -c '
import json,sys
try:
    with open(sys.argv[1]) as f: b=json.load(f)
except Exception: sys.exit(0)
v=b.get("spec_id")
if isinstance(v,str): print(v.strip())
' "$BINDING_FILE" 2>/dev/null)"

if [[ -z "$SPEC_ID" ]]; then
  emit_block "CAWS goal-ac-gate: the goal binding at .caws/sessions/$HOOK_SESSION_ID/goal.json is unreadable or names no spec_id, so the acceptance bar for this session cannot be determined. Re-set it with: caws goal set <spec-id>. $ESCAPE_HINT"
  exit 0
fi

CAWS_BIN="${CAWS_BIN:-caws}"
if ! command -v "$CAWS_BIN" >/dev/null 2>&1; then
  printf 'CAWS goal-ac-gate: %s not on PATH, so the acceptance gate cannot evaluate. Goal NOT enforced this stop. %s\n' "$CAWS_BIN" "$ESCAPE_HINT" >&2
  exit 0
fi

REPORT="$("$CAWS_BIN" specs verify-acs "$SPEC_ID" --json 2>/dev/null)"
VERIFY_STATUS=$?

# A4: verify-acs could not produce a report at all (missing spec, malformed
# YAML, crash). Block and name the failure — never pass the stop silently on an
# unreadable gate.
if [[ -z "$REPORT" ]]; then
  emit_block "CAWS goal-ac-gate: 'caws specs verify-acs $SPEC_ID --json' produced no report (exit $VERIFY_STATUS), so the acceptance bar for $SPEC_ID cannot be re-derived. This is a gate failure, not a pass. Investigate, then retry or $ESCAPE_HINT"
  exit 0
fi

# Single python pass: classify criteria and emit "<digest>\t<unmet summary>".
SUMMARY="$(printf '%s' "$REPORT" | python3 -c '
import json,sys
try:
    r=json.load(sys.stdin)
except Exception:
    print("PARSE_ERROR\t"); sys.exit(0)
crit=r.get("criteria")
if not isinstance(crit,list) or not crit:
    print("NO_CRITERIA\t"); sys.exit(0)
unmet=[]
for c in crit:
    if not isinstance(c,dict): continue
    cid=str(c.get("id","?"))
    verdict=str(c.get("verdict","unknown"))
    # verified is the ONLY pass. not_rederived is narrative-only: not proof.
    if verdict!="verified":
        reason=str(c.get("reason") or "")
        unmet.append(cid+"="+verdict+("("+reason+")" if reason else ""))
if not unmet:
    print("MET\t"); sys.exit(0)
print("UNMET\t"+", ".join(unmet))
' 2>/dev/null)"

STATE="${SUMMARY%%$'\t'*}"
UNMET_LIST="${SUMMARY#*$'\t'}"

if [[ "$STATE" == "PARSE_ERROR" || "$STATE" == "NO_CRITERIA" ]]; then
  emit_block "CAWS goal-ac-gate: the verify-acs report for $SPEC_ID was unreadable or declared no criteria ($STATE), so the acceptance bar cannot be evaluated. This is a gate failure, not a pass. $ESCAPE_HINT"
  exit 0
fi

# A2: every criterion verified -> the goal is met. Reset the counter, stay silent.
if [[ "$STATE" == "MET" ]]; then
  python3 -c '
import json,sys
p=sys.argv[1]
try:
    with open(p) as f: b=json.load(f)
except Exception: sys.exit(0)
b["consecutive_blocks"]=0
b["last_unmet_digest"]=""
try:
    with open(p,"w") as f: json.dump(b,f,indent=2)
except Exception: pass
' "$BINDING_FILE" 2>/dev/null
  exit 0
fi

# A1/A5: unmet. Bump the counter, but only while the unmet set is unchanged —
# recording new evidence resets the budget so real progress is never punished.
COUNT="$(python3 -c '
import json,sys,hashlib
p,digest_src=sys.argv[1],sys.argv[2]
digest=hashlib.sha256(digest_src.encode()).hexdigest()[:16]
try:
    with open(p) as f: b=json.load(f)
except Exception:
    b={}
prev=b.get("last_unmet_digest")
n=b.get("consecutive_blocks",0)
n=(n+1) if prev==digest else 1
b["consecutive_blocks"]=n
b["last_unmet_digest"]=digest
try:
    with open(p,"w") as f: json.dump(b,f,indent=2)
except Exception: pass
print(n)
' "$BINDING_FILE" "$UNMET_LIST" 2>/dev/null)"
[[ -z "$COUNT" ]] && COUNT=1

if (( COUNT > GOAL_MAX_CONSECUTIVE_BLOCKS )); then
  # A5: budget exhausted with no new evidence. Degrade to a loud warning and
  # let the session stop. A goal can never trap a session indefinitely.
  printf 'CAWS goal-ac-gate: goal for %s still UNMET after %d consecutive stops with no new evidence — releasing the stop rather than trapping the session.\n  Unmet: %s\n  %s\n' \
    "$SPEC_ID" "$GOAL_MAX_CONSECUTIVE_BLOCKS" "$UNMET_LIST" "$ESCAPE_HINT" >&2
  exit 0
fi

emit_block "CAWS goal-ac-gate: goal for $SPEC_ID is not met — $UNMET_LIST. Only verdict=verified counts as met; not_rederived is narrative-only evidence, not proof. Record real proof with 'caws specs evidence' (cite a commit_sha/test_nodeid, then re-derive with 'caws specs verify-acs $SPEC_ID'). Block $COUNT of $GOAL_MAX_CONSECUTIVE_BLOCKS before this gate releases the stop. $ESCAPE_HINT"
exit 0
