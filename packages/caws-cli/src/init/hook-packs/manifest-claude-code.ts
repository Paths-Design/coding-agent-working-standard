// Claude Code hook pack manifest.
//
// Installs the v11-shape Claude Code hook plane into a repo. Activation
// requires a session restart in Claude Code: hook registration is read at
// session start, so installing mid-session does not affect the current
// session's tool calls.
//
// Lineage entries this pack covers — see
// docs/failure-lineage.md:
//   Entry 1  — git init catastrophic deletion (block-dangerous + classify_command)
//   Entry 4  — worktree cross-contamination, inherited-dirty-state (worktree-guard)
//   Entry 6  — stash-and-destroy (worktree-guard)
//   Entry 8  — scope violations, union-mode interference (scope-guard)
//   Entry 11 — ownership claim, CAWSFIX-31/32 (worktree-guard, session-caws-status)
//   Entry 12 — unbound = no authority (scope-guard fail-closed)
//   Entry 13 — working-spec.yaml baseline clobber (worktree-write-guard)
//   Entry 16 — adjudicator overstep / role partitioning (the pack itself)
//   Entry 17 — git --bare init bypass + danger latch (classify_command + block-dangerous + reset-danger-latch)
//   Entry 19 — canonical-checkout hijack: parallel agent silently switched the
//              canonical checkout off the coordination branch, breaking authority
//              resolution for the worktree-bound session. MULTI-AGENT-ACTIVITY-
//              REGISTRY-001 ships the lease substrate (agent-register/heartbeat/
//              stop) so the next time two sessions touch this repo, both see
//              each other at SessionStart and on every tool call when N > 1.

import type { HookPackV1 } from './types';

// Pack version bumps when managed file contents change in a way that
// existing installs should pick up via the managed_old_version → auto-
// update path.
//
// Version 2: strike-level diagnostic triage, activation-banner wording
// fix, settings.json "why we don't write it" note, tightened ask/block
// semantics in block-dangerous.
//
// Version 3: MULTI-AGENT-ACTIVITY-REGISTRY-001. Adds three new managed
// files (agent-register.sh, agent-heartbeat.sh, agent-stop.sh) wired
// into the SessionStart, PreToolUse, and Stop dispatchers. The CLI is
// hook-protocol-agnostic; agent-heartbeat.sh is the sole emitter of
// Claude Code's hookSpecificOutput.additionalContext envelope. Adds
// .caws/leases/ to the stateModel read/write surface.
//
// Version 4: CANONICAL-CHECKOUT-WORKTREE-GUARD-001. Adds a hook-IO
// behavioral contract (canonical-checkout-pre-tool-use-guard-v1)
// inside worktree-guard.sh that blocks mutating git commands
// (checkout, switch, branch -f, reset non-hard) from the canonical
// checkout when at least one active CAWS worktree exists. The guard
// uses git_dir == git_common_dir as the canonical-detection predicate
// and the existing entriesOf helper for v10/v11 dual-shape registry
// reads. Leases are NOT consulted; visibility-only, never authority.
// Closes the enforcement gap that failure-lineage Entry 19 documented
// as visibility-without-enforcement. No new managed files; no stateModel
// changes (leases/worktrees.json already declared).
//
// Version 6: CAWS-HOOK-PACK-RENDERER-MISSING-001. Ships
// session_log_renderer.py alongside session-log.sh. Prior versions
// shipped session-log.sh with `RENDERER="$SCRIPT_DIR/session_log_renderer.py"`
// (line 35 of session-log.sh) but did NOT bundle the renderer
// itself, so every `caws init --agent-surface claude-code` produced
// a session-log.sh that crashed when invoked. Adds the renderer as
// a managed file (executable: false; invoked via `python3 <path>`).
// Removed Sterling-specific MEANINGFUL_COMMAND_KW entries (cargo
// test, cargo build, ruff, mypy) from the renderer's baseline;
// future work (CAWS-HOOK-PACK-RENDERER-CONFIG-001, not yet
// authored) may admit a sidecar config for consumer toolchain
// extensions. No stateModel changes (tmp/<session-id>/ already
// declared; the renderer writes into the same surface session-log.sh
// already declared as a write).
export const CLAUDE_CODE_PACK_VERSION = 6;

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
      '.caws/leases/',
      '.caws/policy.yaml',
      'package.json',
    ],
    writes: [
      '.claude/logs/audit.log',
      '.claude/logs/session-*.log',
      '.claude/hooks/state/danger-latch-*.json',
      '.claude/hooks/state/guard-strikes-*.json',
      '.caws/leases/',
      'tmp/<session-id>/',
    ],
  },
  lineageRefs: [1, 4, 6, 8, 11, 12, 13, 16, 17, 19],

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

    // -- MULTI-AGENT-ACTIVITY-REGISTRY-001 (lineage entry 19) --
    // Lease-substrate hooks. agent-register fires at SessionStart;
    // agent-heartbeat fires FIRST at PreToolUse (throttled, surfaces
    // parallel-agent presence via Claude Code additionalContext when
    // N>1); agent-stop fires at Stop to mark the lease stopped.
    // All three are best-effort and never block their dispatchers.
    {
      destPath: '.claude/hooks/agent-register.sh',
      sourcePath: 'agent-register.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.claude/hooks/agent-heartbeat.sh',
      sourcePath: 'agent-heartbeat.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.claude/hooks/agent-stop.sh',
      sourcePath: 'agent-stop.sh',
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
      // CAWS-HOOK-PACK-RENDERER-MISSING-001: session-log.sh shells out
      // to this Python script via `python3 "$RENDERER"`. Before v6 the
      // renderer was NOT bundled and every `caws init` shipped a broken
      // session-log.sh that crashed on invocation. Not marked executable
      // because it is invoked via python3 <path>, not as a standalone
      // binary.
      destPath: '.claude/hooks/session_log_renderer.py',
      sourcePath: 'session_log_renderer.py',
      executable: false,
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
