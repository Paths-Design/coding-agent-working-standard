<!--
# CAWS-MANAGED-HOOK
# hook_pack: kimi-code
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

# CAWS Kimi Code Hook Pack

This directory is the **kimi-code vendor adapter** for the CAWS hook pack. It
contains only the Kimi-specific wiring, surface documentation, and override lib
files. All shared hook logic lives in the CAWS shared core, installed at
`.caws/hooks/` in the consumer repo.

## The one thing that is different about Kimi

**Kimi Code has no project-level hook config.** `[[hooks]]` entries live only
in the user-level `$KIMI_CODE_HOME/config.toml` (default
`~/.kimi-code/config.toml`) and fire for every project you open. The CAWS
wiring is therefore **repo-conditional**: each user-level entry invokes
`.kimi-code/hooks/caws-kimi-hook.sh`, which resolves the git root at invocation
time and exits 0 silently when the repo has no `.caws/hooks/` shared core.
Outside CAWS repos the wiring is inert.

`caws init --agent-surface kimi-code` installs this pack and writes
`.kimi-code/caws-hooks.toml.example` (the five `[[hooks]]` blocks). The merge
into your user-level `config.toml` happens only when you pass
`--wire-user-config` — it is append-only, idempotent, honors `KIMI_CODE_HOME`,
and never rewrites your existing entries. Without the flag, init prints the
blocks for you to paste yourself.

## Layout (CAWS-HOOK-PACK-SHARED-CORE-001)

```
.caws/hooks/            # shared core — event dispatchers + all guard/check hooks
  dispatch/             # pre_tool_use.sh, post_tool_use.sh, session_start.sh, stop.sh, pre_compact.sh
  lib/                  # parse-input.sh, run-handlers.sh, emit.sh, agent-surface.sh, ...
  <shared hooks>.sh     # scope-guard, block-dangerous, worktree-guard, etc.

.kimi-code/             # kimi-code adapter (this directory when installed)
  AGENTS.md             # this file
  caws-hooks.toml.example  # reference copy of the user-level wiring
  hooks/
    caws-kimi-hook.sh   # the shim every user-level [[hooks]] entry calls
    lib/                # kimi-code override libs (sourced in preference to shared lib)
      emit.sh           # ask->deny; block/ask reasons mirrored to stderr
      run-handlers.sh   # "deny" recognized as priority-3 (immediate block)
```

The override files are resolved at runtime by `caws_source_lib` (defined in
`shared/lib/agent-surface.sh`): it checks
`$CAWS_PROJECT_DIR/$CAWS_VENDOR_DIR/hooks/lib/<name>` before falling back to
the shared default. `CAWS_VENDOR_DIR` is `.kimi-code` for this surface.

## Kimi contract (verified live against kimi 0.31.1)

| Behavior | Contract |
|----------|----------|
| Payload (stdin JSON) | `{hook_event_name, session_id, cwd, tool_name, tool_input, tool_call_id}` — Claude-compatible; the shared `parse-input.sh` is used unchanged |
| Block | exit `2` + the reason on **stderr**; or stdout `{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":...}}` |
| `ask` | NOT blocking (observed: the tool executed) — the emit override maps ask-level escalations to `deny` so governance never silently allows |
| `hookEventName` in the envelope | tolerated (kept in the emitted envelopes) |
| `updatedInput` | no documented contract — quiet-merge passes commands through unrewritten |
| Session identity | reaches hooks only via the payload `session_id`; agent-Bash subshells resolve via the CAWS session capsule (cwd-independent) |

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
and the human-facing inventory any installed surface's README (e.g.
`.claude/hooks/README.md` when the claude-code pack is also installed). The
short version: `block-dangerous.sh` (catastrophic commands + danger latch),
`worktree-guard.sh` / `worktree-write-guard.sh` / `bash-write-guard.sh`
(worktree isolation), `scope-guard.sh` (spec scope enforcement),
`protected-paths.sh`, `scan-secrets.sh`, plus the advisory quality plane
(`god-object-check.sh`, `shortcut-language-check.sh`,
`duplicate-export-check.sh`, `loc-delta-check.sh`).

When a guard blocks, the reason reaches you on stderr (Kimi's block channel).
When a guard is skipped under a reprieve, the skip is logged to stderr as
`[reprieve] <handler> skipped for session <id> (expires <ts>)`.

## Activation

Kimi reads `config.toml` at session start: installing the pack mid-session
does NOT activate it. After `caws init --agent-surface kimi-code
--wire-user-config` (or after pasting the example blocks into your
`config.toml`), **start a new kimi session** before relying on enforcement.
Sessions launched from a subdirectory of the repo still scope governance to
the git root (the shim resolves it at invocation time).
