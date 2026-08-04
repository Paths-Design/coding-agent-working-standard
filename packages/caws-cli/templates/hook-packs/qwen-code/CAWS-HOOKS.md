<!--
# CAWS-MANAGED-HOOK
# hook_pack: qwen-code
# hook_pack_version: 1
# caws_min_major: 11
# lineage_refs: 1,4,6,8,11,12,13,16,17,19,20
# edit_stance: YOURS TO EDIT. This is a starting hook, not a locked one — shape it
#   to your repo: tune thresholds, add checks, remove what does not fit. Your edits
#   are preserved: caws init treats a changed hook as intended growth and will not
#   clobber it — it shows a diff and asks (--adopt keeps yours; --overwrite --force
#   takes the upstream template). The CAWS-MANAGED-HOOK marker above is only how caws
#   init finds hooks it can offer updates for; it is NOT a keep-out sign. CAWS owns the
#   failure-class invariant (the why/what a guard protects); you own the how. The one
#   edit to avoid: gutting a guard to dodge a block instead of fixing the cause. Grow
#   everything else freely.
-->

# CAWS Qwen Code Hook Pack

This directory is the **qwen-code vendor adapter** for the CAWS hook pack. It
contains only the Qwen-specific wiring and surface documentation. All shared
hook logic lives in the CAWS shared core, installed at `.caws/hooks/` in the
consumer repo.

## How the wiring works

Qwen Code reads hooks from the repo-local `.qwen/settings.json` (merged under
any user-level `~/.qwen/settings.json`). `caws init --agent-surface qwen-code`
merges five managed hook entries — PreToolUse, PostToolUse, SessionStart,
Stop, PreCompact — into `.qwen/settings.json` non-destructively (your other
settings are preserved; a second run is a byte-identical no-op) and writes
`.qwen/settings.json.example` as a reference artifact.

Qwen exports no env var that reliably names the repo root
(`QWEN_CODE_PROJECT_DIR` points at the per-project state dir under
`~/.qwen/projects/<slug>`, not the working tree — probed live on 0.21.4), so
every entry invokes `.qwen/hooks/caws-qwen-hook.sh`, which resolves the git
root at invocation time and exits 0 silently when the repo has no
`.caws/hooks/` shared core. If this wiring is copied into a non-CAWS repo it
is inert.

This file is loaded through a CAWS-managed `@.qwen/CAWS-HOOKS.md` import line
in the root `QWEN.md` (Qwen Code auto-loads root `QWEN.md`; nothing else under
`.qwen/` is auto-loaded).

## Layout (CAWS-HOOK-PACK-SHARED-CORE-001)

```
.caws/hooks/            # shared core — event dispatchers + all guard/check hooks
  dispatch/             # pre_tool_use.sh, post_tool_use.sh, session_start.sh, stop.sh, pre_compact.sh
  lib/                  # parse-input.sh, run-handlers.sh, emit.sh, agent-surface.sh, ...
  <shared hooks>.sh     # scope-guard, block-dangerous, worktree-guard, etc.

.qwen/                  # qwen-code adapter (this directory when installed)
  CAWS-HOOKS.md         # this file
  settings.json         # repo-local hook wiring (merged by caws init)
  settings.json.example # reference copy of the canonical wiring
  hooks/
    caws-qwen-hook.sh   # the shim every settings.json entry calls
    lib/
      parse-input.sh    # override: normalizes qwen runtime tool ids
                        # (write_file, edit, run_shell_command, ...) to the
                        # canonical names (Write, Edit, Bash, ...) the shared
                        # guards self-filter on
```

The override file is resolved at runtime by `caws_source_lib` (defined in
`shared/lib/agent-surface.sh`): it checks
`$CAWS_PROJECT_DIR/$CAWS_VENDOR_DIR/hooks/lib/<name>` before falling back to
the shared default. `CAWS_VENDOR_DIR` is `.qwen` for this surface.

## Qwen contract (verified live against Qwen Code 0.21.4)

| Behavior | Contract |
|----------|----------|
| Payload (stdin JSON) | `{hook_event_name, session_id, cwd, tool_name, tool_input, tool_use_id, permission_mode}` — Claude-compatible shape; the vendor `parse-input.sh` override wraps the shared parser and normalizes `tool_name` from qwen runtime ids (`write_file`, `edit`, `run_shell_command`, ...) to the canonical names (`Write`, `Edit`, `Bash`, ...) the guards self-filter on |
| Block | stdout `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":...}}` (exit 0) — enforced even in yolo mode; or exit `2` with the reason on stderr |
| `ask` | Native: interactive sessions show a confirmation prompt; headless/background contexts degrade ask → deny automatically |
| exit 1 | Non-blocking error — the tool call proceeds; CAWS block paths never rely on it |
| `updatedInput` | documented but NOT enforced in 0.21.x — `CAWS_SUPPORTS_UPDATED_INPUT=0`; quiet-merge passes commands through unrewritten |
| Matchers | regex on runtime tool ids (`run_shell_command`, `write_file`, `edit`, `read_file`, `glob`, `grep_search`, ...) |
| Session identity | `session_id` in the payload; `QWEN_CODE_SESSION_ID` env var outside hooks |

## These are CAWS-managed files — and you may grow them

The hooks ship as **managed** files. "Managed" means `caws init` recognizes
them (via the `CAWS-MANAGED-HOOK` header) and can offer a baseline update — it
does **not** mean "frozen" or "hands off." This repo owns the HOW: **editing
these hooks to grow your governance is expected and welcome.**

There is exactly **one** edit that is out of bounds: editing a hook to
**bypass, delete, or locally weaken a guard** in order to dodge a block. If a
hook blocks work you believe is legitimate, fix the cause, create a waiver
(`caws waiver create`), or take a session-scoped reprieve (`caws reprieve
grant --current`) — do not defang the guard.

**Your edits are preserved — `caws init` will not clobber them.** An edited
managed hook is classified as *drift* and `caws init` refuses to overwrite it:
do nothing / `--adopt` keeps yours; `--overwrite` previews a diff;
`--overwrite --force` takes the upstream template.

## What each hook does

The guard inventory is identical on every surface — see the handler tables in
the shared core's dispatchers (`.caws/hooks/dispatch/*.sh`, HANDLERS arrays)
and the human-facing inventory in any installed surface's README (e.g.
`.claude/hooks/README.md` when the claude-code pack is also installed). The
short version: `block-dangerous.sh` (catastrophic commands + danger latch),
`worktree-guard.sh` / `worktree-write-guard.sh` / `bash-write-guard.sh`
(worktree isolation), `scope-guard.sh` (spec scope enforcement),
`protected-paths.sh`, `scan-secrets.sh`, plus the advisory quality plane
(`god-object-check.sh`, `shortcut-language-check.sh`,
`duplicate-export-check.sh`, `loc-delta-check.sh`).

When a guard blocks, the reason reaches the model through the
`permissionDecisionReason` (deny) or stderr on exit 2. When a guard is skipped
under a reprieve, the skip is logged to stderr as `[reprieve] <handler>
skipped for session <id> (expires <ts>)`.

## Activation

Qwen Code reads `.qwen/settings.json` at session start: installing the pack
mid-session does NOT activate it. After `caws init --agent-surface qwen-code`,
**start a new qwen session** before relying on enforcement. Sessions launched
from a subdirectory of the repo still scope governance to the git root (the
shim resolves it at invocation time).
