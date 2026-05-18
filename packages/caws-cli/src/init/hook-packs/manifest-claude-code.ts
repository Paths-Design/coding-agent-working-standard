// Claude Code hook pack manifest.
//
// Installs the v11-shape Claude Code hook plane into a repo. Activation
// requires a session restart in Claude Code: hook registration is read at
// session start, so installing mid-session does not affect the current
// session's tool calls.
//
// Lineage entries this pack covers — see
// packages/caws-cli/docs-status/failure-lineage.md:
//   Entry 1  — git init catastrophic deletion (block-dangerous + classify_command)
//   Entry 4  — worktree cross-contamination, inherited-dirty-state (worktree-guard)
//   Entry 6  — stash-and-destroy (worktree-guard)
//   Entry 8  — scope violations, union-mode interference (scope-guard)
//   Entry 11 — ownership claim, CAWSFIX-31/32 (worktree-guard, session-caws-status)
//   Entry 12 — unbound = no authority (scope-guard fail-closed)
//   Entry 13 — working-spec.yaml baseline clobber (worktree-write-guard)
//   Entry 16 — adjudicator overstep / role partitioning (the pack itself)
//   Entry 17 — git --bare init bypass + danger latch (classify_command + block-dangerous + reset-danger-latch)

import type { HookPackV1 } from './types';

// Pack version bumps when managed file contents change in a way that
// existing installs should pick up via the managed_old_version → auto-
// update path. Version 2 ships the strike-level diagnostic triage,
// activation-banner wording fix, settings.json "why we don't write it"
// note, and tightened ask/block semantics in block-dangerous.
export const CLAUDE_CODE_PACK_VERSION = 2;

export const CLAUDE_CODE_PACK: HookPackV1 = {
  id: 'claude-code',
  targetSurface: 'claude-code',
  packVersion: CLAUDE_CODE_PACK_VERSION,
  cawsMinMajor: 11,
  summary:
    'v11-shape Claude Code hook pack: scope, worktree, dangerous-command, ' +
    'and session lifecycle guards.',
  activation: 'restart_required',
  lifecycleEvents: ['pre_bash', 'pre_write', 'pre_edit', 'session_start', 'stop'],
  stateModel: {
    reads: [
      '.caws/specs/*.yaml',
      '.caws/worktrees.json',
      '.caws/agents.json',
      '.caws/policy.yaml',
      'package.json',
    ],
    writes: [
      '.claude/logs/audit.log',
      '.claude/logs/session-*.log',
      '.claude/hooks/state/danger-latch-*.json',
      '.claude/hooks/state/guard-strikes-*.json',
      'tmp/<session-id>/',
    ],
  },
  lineageRefs: [1, 4, 6, 8, 11, 12, 13, 16, 17],

  // Installed files. Order is deterministic (used by tests and by the
  // install reporter). destPath is relative to repo root.
  // sourcePath is relative to the pack root
  // (packages/caws-cli/templates/hook-packs/claude-code/).
  installedFiles: [
    // -- Scope and worktree guards (v11-shape) --
    {
      destPath: '.claude/hooks/scope-guard.sh',
      sourcePath: 'scope-guard.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.claude/hooks/worktree-guard.sh',
      sourcePath: 'worktree-guard.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.claude/hooks/worktree-write-guard.sh',
      sourcePath: 'worktree-write-guard.sh',
      executable: true,
      managed: true,
    },

    // -- Entry 17 dangerous-command hardening (preserved verbatim) --
    {
      destPath: '.claude/hooks/block-dangerous.sh',
      sourcePath: 'block-dangerous.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.claude/hooks/classify_command.py',
      sourcePath: 'classify_command.py',
      executable: true,
      managed: true,
    },

    // -- Human-authorized escape hatches (preserved) --
    {
      destPath: '.claude/hooks/reset-strikes.sh',
      sourcePath: 'reset-strikes.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.claude/hooks/reset-danger-latch.sh',
      sourcePath: 'reset-danger-latch.sh',
      executable: true,
      managed: true,
    },

    // -- Strike counter shared library (sourced by scope-guard) --
    {
      destPath: '.claude/hooks/guard-strikes.sh',
      sourcePath: 'guard-strikes.sh',
      executable: true,
      managed: true,
    },

    // -- Session lifecycle and logging --
    {
      destPath: '.claude/hooks/session-caws-status.sh',
      sourcePath: 'session-caws-status.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.claude/hooks/session-log.sh',
      sourcePath: 'session-log.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.claude/hooks/audit.sh',
      sourcePath: 'audit.sh',
      executable: true,
      managed: true,
    },

    // -- Shared libraries sourced by every hook script --
    {
      destPath: '.claude/hooks/runtime-paths.sh',
      sourcePath: 'runtime-paths.sh',
      executable: false,
      managed: true,
    },
    {
      destPath: '.claude/hooks/lib/parse-input.sh',
      sourcePath: 'lib/parse-input.sh',
      executable: false,
      managed: true,
    },
    {
      destPath: '.claude/hooks/lib/run-handlers.sh',
      sourcePath: 'lib/run-handlers.sh',
      executable: false,
      managed: true,
    },

    // -- Dispatch entrypoints invoked from .claude/settings.json --
    {
      destPath: '.claude/hooks/dispatch/pre_tool_use.sh',
      sourcePath: 'dispatch/pre_tool_use.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.claude/hooks/dispatch/post_tool_use.sh',
      sourcePath: 'dispatch/post_tool_use.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.claude/hooks/dispatch/session_start.sh',
      sourcePath: 'dispatch/session_start.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.claude/hooks/dispatch/stop.sh',
      sourcePath: 'dispatch/stop.sh',
      executable: true,
      managed: true,
    },

    // NOTE: .claude/settings.json is NOT a managed pack file. It often
    // carries user-authored `permissions` and `env` blocks that the pack
    // should not touch. Install emits explicit instructions for the
    // user to wire the four dispatch entrypoints into their existing
    // settings.json (or to create one from the canonical snippet in
    // CLAUDE.md if absent). This avoids JSON-merge complexity and
    // preserves user-owned settings.

    // -- Doctrine landing for hook editors --
    {
      destPath: '.claude/hooks/CLAUDE.md',
      sourcePath: 'CLAUDE.md',
      executable: false,
      managed: true,
    },
  ],
};
