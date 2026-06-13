// Shared hook pack manifest.
//
// Installs the surface-neutral shared hook core under `.caws/hooks/`.
// This pack contains the dispatchers, guard scripts, and shared libs that
// are identical across all vendor surfaces (claude-code, codex, ...).
//
// Design decision: AgentSurface / targetSurface
// HookPackV1.targetSurface is typed as Exclude<AgentSurface,'none'> — it
// is meant to name the harness this pack targets. The shared pack is NOT
// surface-targeted; it is installed unconditionally alongside ANY vendor
// pack. Rather than widening AgentSurface to include 'shared' (which
// would pollute resolveHookPack and the `--agent-surface` CLI surface),
// we declare the shared pack with targetSurface: 'claude-code' as a
// nominal stand-in value (field is not consulted for this pack) and note
// that the field carries no semantic meaning for the shared core.
// The install caller (init.ts) installs SHARED_PACK directly, bypassing
// resolveHookPack, so the targetSurface value is never read at runtime.
//
// CAWS-HOOK-PACK-SHARED-CORE-001: this pack is the single source of truth
// for all shared hook logic. A change to a shared file requires exactly
// one version bump here, not parallel bumps in two vendor trees.

import type { HookPackV1 } from './types';

export const SHARED_PACK_VERSION = 1;

export const SHARED_PACK: HookPackV1 = {
  // 'shared' is the canonical pack identity for the shared hook core.
  id: 'shared',
  // targetSurface is nominally required by HookPackV1 but carries no
  // semantic meaning for the shared core (which is surface-agnostic).
  // 'claude-code' is used as a stand-in value. The install caller
  // invokes installHookPack(SHARED_PACK) directly and never reads this.
  targetSurface: 'claude-code',
  packVersion: SHARED_PACK_VERSION,
  cawsMinMajor: 11,
  summary:
    'Shared CAWS hook core: dispatchers, guards, and libs installed under ' +
    '.caws/hooks/ for all agent surfaces.',
  activation: 'restart_required',
  lifecycleEvents: [
    'pre_bash',
    'pre_write',
    'pre_edit',
    'session_start',
    'pre_compact',
    'stop',
  ],
  stateModel: {
    // The shared core reads canonical CAWS state.
    reads: [
      '.caws/specs/*.yaml',
      '.caws/worktrees.json',
      '.caws/agents.json',
      '.caws/leases/',
      '.caws/policy.yaml',
      'package.json',
    ],
    // Writes to runtime paths (log dir is surface-derived at runtime via
    // CAWS_LOG_DIR from lib/agent-surface.sh). The shared core writes to:
    //   - CAWS_LOG_DIR  (resolves to .claude/logs or .codex/logs)
    //   - .caws/leases/ (agent liveness substrate)
    //   - .caws/sessions/ (session log + caller-session pointer)
    writes: [
      '<CAWS_LOG_DIR>/audit.log',
      '<CAWS_LOG_DIR>/session-*.log',
      '<CAWS_VENDOR_DIR>/hooks/state/danger-latch-*.json',
      '<CAWS_VENDOR_DIR>/hooks/state/guard-strikes-*.json',
      '.caws/leases/',
      '.caws/sessions/<session-id>/',
      '.caws/sessions/.caller-session.json',
    ],
  },
  lineageRefs: [1, 4, 6, 8, 11, 12, 13, 16, 17, 19, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31],

  // Installed files. All install to .caws/hooks/<relpath>.
  // sourcePath is relative to the shared/ pack root
  // (packages/caws-cli/templates/hook-packs/shared/).
  // Executable flags match the flags from the original claude-code manifest
  // for the same logical file.
  installedFiles: [
    // -- Dispatchers (event entrypoints) --
    {
      destPath: '.caws/hooks/dispatch/pre_tool_use.sh',
      sourcePath: 'dispatch/pre_tool_use.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.caws/hooks/dispatch/post_tool_use.sh',
      sourcePath: 'dispatch/post_tool_use.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.caws/hooks/dispatch/session_start.sh',
      sourcePath: 'dispatch/session_start.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.caws/hooks/dispatch/stop.sh',
      sourcePath: 'dispatch/stop.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.caws/hooks/dispatch/pre_compact.sh',
      sourcePath: 'dispatch/pre_compact.sh',
      executable: true,
      managed: true,
    },

    // -- Shared libraries --
    {
      destPath: '.caws/hooks/lib/agent-surface.sh',
      sourcePath: 'lib/agent-surface.sh',
      executable: false,
      managed: true,
    },
    {
      destPath: '.caws/hooks/lib/parse-input.sh',
      sourcePath: 'lib/parse-input.sh',
      executable: false,
      managed: true,
    },
    {
      destPath: '.caws/hooks/lib/run-handlers.sh',
      sourcePath: 'lib/run-handlers.sh',
      executable: false,
      managed: true,
    },
    {
      destPath: '.caws/hooks/lib/caws-state.sh',
      sourcePath: 'lib/caws-state.sh',
      executable: false,
      managed: true,
    },
    {
      destPath: '.caws/hooks/lib/emit.sh',
      sourcePath: 'lib/emit.sh',
      executable: false,
      managed: true,
    },
    {
      destPath: '.caws/hooks/lib/guard-message.sh',
      sourcePath: 'lib/guard-message.sh',
      executable: false,
      managed: true,
    },
    {
      destPath: '.caws/hooks/lib/worktree-claim-oracle.cjs',
      sourcePath: 'lib/worktree-claim-oracle.cjs',
      executable: false,
      managed: true,
    },

    // -- Shared runtime-paths loader --
    {
      destPath: '.caws/hooks/runtime-paths.sh',
      sourcePath: 'runtime-paths.sh',
      executable: false,
      managed: true,
    },

    // -- Scope and worktree guards --
    {
      destPath: '.caws/hooks/scope-guard.sh',
      sourcePath: 'scope-guard.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.caws/hooks/worktree-guard.sh',
      sourcePath: 'worktree-guard.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.caws/hooks/worktree-write-guard.sh',
      sourcePath: 'worktree-write-guard.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.caws/hooks/bash-write-guard.sh',
      sourcePath: 'bash-write-guard.sh',
      executable: true,
      managed: true,
    },

    // -- Dangerous command guards --
    {
      destPath: '.caws/hooks/block-dangerous.sh',
      sourcePath: 'block-dangerous.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.caws/hooks/classify_command.py',
      sourcePath: 'classify_command.py',
      executable: true,
      managed: true,
    },

    // -- Human-authorized escape hatches --
    {
      destPath: '.caws/hooks/reset-strikes.sh',
      sourcePath: 'reset-strikes.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.caws/hooks/reset-danger-latch.sh',
      sourcePath: 'reset-danger-latch.sh',
      executable: true,
      managed: true,
    },

    // -- Strike counter shared library --
    {
      destPath: '.caws/hooks/guard-strikes.sh',
      sourcePath: 'guard-strikes.sh',
      executable: true,
      managed: true,
    },

    // -- Session lifecycle and logging --
    {
      destPath: '.caws/hooks/session-caws-status.sh',
      sourcePath: 'session-caws-status.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.caws/hooks/agent-register.sh',
      sourcePath: 'agent-register.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.caws/hooks/agent-heartbeat.sh',
      sourcePath: 'agent-heartbeat.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.caws/hooks/agent-stop.sh',
      sourcePath: 'agent-stop.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.caws/hooks/session-log.sh',
      sourcePath: 'session-log.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.caws/hooks/session_log_renderer.py',
      sourcePath: 'session_log_renderer.py',
      executable: false,
      managed: true,
    },
    {
      destPath: '.caws/hooks/audit.sh',
      sourcePath: 'audit.sh',
      executable: true,
      managed: true,
    },

    // -- Promoted guards (v7+) --
    {
      destPath: '.caws/hooks/cwd-guard.sh',
      sourcePath: 'cwd-guard.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.caws/hooks/protected-paths.sh',
      sourcePath: 'protected-paths.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.caws/hooks/scan-secrets.sh',
      sourcePath: 'scan-secrets.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.caws/hooks/naming-check.sh',
      sourcePath: 'naming-check.sh',
      executable: true,
      managed: true,
    },

    // -- Quality advisory plane (v11+) --
    {
      destPath: '.caws/hooks/god-object-check.sh',
      sourcePath: 'god-object-check.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.caws/hooks/shortcut-language-check.sh',
      sourcePath: 'shortcut-language-check.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.caws/hooks/duplicate-export-check.sh',
      sourcePath: 'duplicate-export-check.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.caws/hooks/loc-delta-check.sh',
      sourcePath: 'loc-delta-check.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.caws/hooks/quality-check.sh',
      sourcePath: 'quality-check.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.caws/hooks/validate-spec.sh',
      sourcePath: 'validate-spec.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.caws/hooks/stop-worktree-check.sh',
      sourcePath: 'stop-worktree-check.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.caws/hooks/quiet-merge.sh',
      sourcePath: 'quiet-merge.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.caws/hooks/plan-transcript-snapshot.sh',
      sourcePath: 'plan-transcript-snapshot.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.caws/hooks/plan-transcript-finalize.sh',
      sourcePath: 'plan-transcript-finalize.sh',
      executable: true,
      managed: true,
    },
  ],
};
