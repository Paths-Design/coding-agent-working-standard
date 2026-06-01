<!--
# CAWS-MANAGED-HOOK
# hook_pack: claude-code
# hook_pack_version: 11
# caws_min_major: 11
# lineage_refs: 1,4,6,8,11,12,13,16,17,19,20
# do_not_edit_directly: update via `caws init --agent-surface claude-code`
-->

# CAWS Claude Code Hook Pack

This directory contains the v11 Claude Code hook pack — pre-tool-call
governance infrastructure that interposes between the agent and its Edit,
Write, and Bash tools. The kernel/store/shell trinity owns canonical state;
these hooks **project** that state into refusals at the agent's boundary,
where the kernel cannot reach (the kernel runs downstream of the tool
call).

## The contract: every hook here exists because of an incident

This pack is not optional scaffolding. Every script under
`.claude/hooks/` traces to a specific entry in
`docs/failure-lineage.md`. Modifying or removing
a hook requires:

1. Naming the lineage entry the hook covers.
2. Identifying the replacement mechanism that preserves the protection.
3. Documenting the change in the same lineage doc.

Hooks may be **evolved** as the v11 state model evolves. They may not be
removed or weakened by an agent's local judgment. If you think a guard
is wrong, stop and ask the user.

## Lineage map

| File | Lineage entries | What it prevents |
|------|----------------|------------------|
| `block-dangerous.sh` + `classify_command.py` | 1, 17 | catastrophic git operations; tokenized-argv bypasses; danger latch |
| `worktree-guard.sh` | 4, 6, 11, 19, 20, 32 | amend/stash/reset/force-push during active worktrees; cross-boundary file copies; **canonical-checkout mutating git commands (checkout/switch/branch -f/reset non-hard) blocked when worktrees active** (CANONICAL-CHECKOUT-WORKTREE-GUARD-001); **agent-Bash `git sparse-checkout` (any subcommand) refused with canonical-spec-materialization wording pointing to `caws worktree repair-sparse <name>`** (WORKTREE-SPEC-CANONICAL-ACCESS-GUARD-001 A3); **the path-restore family (`git restore <path>` / `git checkout -- <path>` / `git clean`) blocked when worktrees active, worded by the actual op — a path restore is NOT a branch switch** (WORKTREE-ISOLATION-HARDENING-001 Fix 5) |
| `worktree-write-guard.sh` | 4, 8, 13, 20, 32 | base-branch writes when worktrees are active (enforcement returns in CLI-WORKTREE-001); baseline-clobber; **Read/Write/Edit refusal against `<linked-worktree>/.caws/specs/*` to prevent canonical spec authority from being materialized as a divergent private copy inside a worktree, before the broad `.caws/*` allowlist can exit 0** (WORKTREE-SPEC-CANONICAL-ACCESS-GUARD-001 A1/A2, contract `canonical-spec-authority-materialization-guard-v1`); **`.caws/worktrees/<name>/<rest>` payload writes routed through `lib/worktree-claim-oracle.js` BEFORE the broad `.caws/*` allowlist — a foreign session's write into another worktree's payload hard-blocks instead of being allowlisted** (WORKTREE-ISOLATION-HARDENING-001 Fix 1+2) |
| `bash-write-guard.sh` | 4, 8, 13, 20, 32 | **Bash mutation-target authority: self-filters to Bash, extracts targets for a narrow mutation-form set (redirection, `tee`, `sed -i`, `perl -pi`, `truncate`, `touch`, `rm`, `mv`, `cp`, `dd of=`, git path-restore), and routes each through the SAME `lib/worktree-claim-oracle.js` as Write/Edit — a Bash mutation of a foreign worktree's payload blocks at the same boundary as a foreign Write/Edit** (WORKTREE-ISOLATION-HARDENING-001 Fix 3) |
| `lib/worktree-claim-oracle.js` | 4, 8, 13, 20, 32 | **the single worktree-ownership oracle (standalone node helper, NOT an inline `node -e` heredoc) shelled out to by worktree-write-guard (Write/Edit) and bash-write-guard (Bash) so both surfaces return the same owner-vs-session answer; lazy `js-yaml` so the foreign-payload block works without a resolvable `js-yaml`; fails closed** (WORKTREE-ISOLATION-HARDENING-001 Fix 1+2+3) |
| `scope-guard.sh` | 8, 11, 12, 16 | edits outside the active spec's `scope.in`; cross-spec union interference; unbound → no authority |
| `session-caws-status.sh` | 4, 11 | inherited-dirty-state collision; foreign-claim soft-block; version-skew |
| `reset-strikes.sh` | 8, 16 | human-authorized strike reset (escape hatch, not auto-resettable) |
| `reset-danger-latch.sh` | 17 | human-authorized danger latch reset |
| `guard-strikes.sh` | 8, 16 | progressive enforcement (strike 1 warn → strike 3 block) |
| `audit.sh` | 9 | per-tool-call audit log |
| `session-log.sh` | 10 | per-turn narrative + structured transcripts |
| `caws_dispatch/*` | 8, 11, 17 | wires Claude Code's lifecycle to the registered handler list |
| `lib/*` | 8, 16 | shared input parsing and handler runner |
| `god-object-check.sh` | 28 | advisory: flags a written/edited file whose SLOC exceeds `CAWS_GOD_OBJECT_LOC` (default 2000). Edit-time analogue of the `god_object` gate. Always exit 0. |
| `shortcut-language-check.sh` | 29 | progressive: flags TODO/FIXME/XXX/placeholder/"not implemented" stub language in NON-test source; escalates warn→ask→block via guard-strikes. Edit-time analogue of the `todo_detection` gate. |
| `duplicate-export-check.sh` | 30 | advisory: on Write of a new JS/TS file, flags an exported symbol whose exact name already exists in the enclosing package src tree (generic-name allowlist). Always exit 0. |
| `loc-delta-check.sh` | 31 | advisory: on Edit, flags an added-line delta over `CAWS_LOC_DELTA_WARN_THRESHOLD` (default 300) via the new_string/old_string payload diff. Always exit 0. |

The four `*-check.sh` hooks above are the **edit-time advisory quality plane** (QG-HOOKS-EXTRACT-001). They reimplement the load-bearing quality-gates detection *intent* in self-contained bash; they do NOT import, shell out to, or runtime-couple with `packages/quality-gates`, and they do NOT change `caws gates run`. `caws gates run` remains the governed policy-gate runner; these hooks are installed utilities the repo tunes via env (option-C doctrine). See `docs/guides/hook-packs.md` for operator usage.

## v11 state-model awareness

The v11 pack reads CAWS state under both v10 and v11 shapes during the
transition window:

- **Specs**: `lifecycle_state` is read first; `status` is the v10 fallback.
  Terminal states (closed, archived, completed) are not enforced.
  `draft` does NOT participate in union-wide blocking unless it is the
  authoritative/bound spec.
- **Worktrees registry**: both v11 direct-key
  (`{"<name>": {...}}`) and v10 nested
  (`{"worktrees": {"<name>": {...}}}`) shapes are accepted.
- **Bound spec id**: both `entry.specId` (v10) and `entry.spec_id` (v11)
  are accepted.

## Version-skew warning

`session-caws-status.sh` emits a non-blocking WARNING when the global
`caws` binary's major version differs from the repo's `caws-cli` major
version. Hooks parse local state directly, but any CLI advice in
diagnostics may be invalid. Consider matching major versions:
`npm install -g @paths.design/caws-cli@^<repo-major>`.

## Activation

Claude Code reads `.claude/settings.json` at session start. Installing
the pack mid-session does NOT activate it until the session is restarted.
`caws init --agent-surface claude-code` wires `settings.json` for you
(see below), but the hooks still load only on the NEXT session start.
Do not continue substantive work after install without restarting first;
the hooks you just installed are not yet enforcing.

## settings.json wiring

`caws init --agent-surface claude-code` MERGES the four CAWS
`caws_dispatch` entrypoints into `.claude/settings.json`
non-destructively: it creates the file if absent, appends the entries to
an existing file while preserving your `permissions`, `env`, and any
existing hooks, is a no-op if already wired, and refuses to touch an
unparseable file. It also always writes a `.claude/settings.json.example`
for reference. The canonical wiring it installs is:

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Read|Write|Edit|Glob|Grep|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/caws_dispatch/pre_tool_use.sh",
            "timeout": 45
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit|Bash|ExitPlanMode",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/caws_dispatch/post_tool_use.sh",
            "timeout": 60
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/caws_dispatch/session_start.sh",
            "timeout": 30
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/caws_dispatch/stop.sh",
            "timeout": 30
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/session-log.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

## Managed file headers

Every managed file in this pack carries a header like:

```
# CAWS-MANAGED-HOOK
# hook_pack: claude-code
# hook_pack_version: <N>
# caws_min_major: 11
# lineage_refs: <comma-separated entries>
# do_not_edit_directly: update via `caws init --agent-surface claude-code`
```

The header is what `caws init` uses to distinguish managed files (safe to
update on re-install under a documented policy) from local user files
(refused without explicit `--adopt` or `--overwrite`).

Removing or editing the header turns the file into an unmanaged
snowflake. Re-running install will then refuse to touch it — by design.
