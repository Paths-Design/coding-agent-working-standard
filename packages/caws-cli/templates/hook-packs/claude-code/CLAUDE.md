<!--
# CAWS-MANAGED-HOOK
# hook_pack: claude-code
# hook_pack_version: 1
# caws_min_major: 11
# lineage_refs: 1,4,6,8,11,12,13,16,17
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
`packages/caws-cli/docs-status/failure-lineage.md`. Modifying or removing
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
| `worktree-guard.sh` | 4, 6, 11 | amend/stash/reset/force-push during active worktrees; cross-boundary file copies |
| `worktree-write-guard.sh` | 4, 8, 13 | base-branch writes when worktrees are active (enforcement returns in CLI-WORKTREE-001); baseline-clobber |
| `scope-guard.sh` | 8, 11, 12, 16 | edits outside the active spec's `scope.in`; cross-spec union interference; unbound → no authority |
| `session-caws-status.sh` | 4, 11 | inherited-dirty-state collision; foreign-claim soft-block; version-skew |
| `reset-strikes.sh` | 8, 16 | human-authorized strike reset (escape hatch, not auto-resettable) |
| `reset-danger-latch.sh` | 17 | human-authorized danger latch reset |
| `guard-strikes.sh` | 8, 16 | progressive enforcement (strike 1 warn → strike 3 block) |
| `audit.sh` | 9 | per-tool-call audit log |
| `session-log.sh` | 10 | per-turn narrative + structured transcripts |
| `dispatch/*` | 8, 11, 17 | wires Claude Code's lifecycle to the registered handler list |
| `lib/*` | 8, 16 | shared input parsing and handler runner |

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
`caws init --agent-surface claude-code` prints an activation instruction
saying so. Do not continue substantive work after install without
restarting first; the hooks you just installed are not yet enforcing.

## settings.json wiring

The pack does NOT manage `.claude/settings.json` — that file commonly
carries user-authored `permissions` and `env` blocks that the pack
should not overwrite. If you do not have a `.claude/settings.json`, add
the following minimum configuration so the dispatch entrypoints fire on
the Claude Code lifecycle:

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Read|Write|Edit|Glob|Grep|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/dispatch/pre_tool_use.sh",
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
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/dispatch/post_tool_use.sh",
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
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/dispatch/session_start.sh",
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
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/dispatch/stop.sh",
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
