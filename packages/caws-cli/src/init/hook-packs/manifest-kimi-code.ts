// Kimi Code hook pack manifest.
//
// Kimi Code has no project-level hook config: [[hooks]] entries live only in
// the user-level $KIMI_CODE_HOME/config.toml. The pack therefore installs a
// repo-conditional shim (hooks/caws-kimi-hook.sh) that the user-level wiring
// invokes; the shim resolves the git root at invocation time (codex
// precedent) and no-ops outside CAWS repos. The config.toml merge itself is
// NOT a pack file — it is performed by hook-install.ts (mergeKimiUserConfig)
// under the explicit --wire-user-config flag, and the reference copy is
// emitted as .kimi-code/caws-hooks.toml.example.
//
// Kimi's hook payload is Claude-compatible in SHAPE (verified live on
// 0.31.1) but not in every field NAME: file tools carry tool_input.path (not
// file_path) and the call id is tool_call_id (not tool_use_id), so the pack
// carries a parse-input.sh override that normalizes both — without it every
// path-based guard silently admits every kimi file edit. Output-side
// divergences: emit.sh (ask->deny, block/ask reasons mirrored to stderr,
// which is Kimi's block-reason channel on exit 2) and run-handlers.sh ("deny"
// recognized as priority-3 so a mapped ask->deny escalation short-circuits
// with return 2, and any non-zero aggregate exit promoted to 2 because Kimi
// does not enforce exit 1).
//
// The override libs install to .kimi-code/hooks/lib/ which is exactly where
// caws_source_lib looks for vendor overrides:
//   ${CAWS_PROJECT_DIR}/${CAWS_VENDOR_DIR}/hooks/lib/<basename>
//   = .kimi-code/hooks/lib/<name>
//
// No bridge wrapper (contrast zcode): Kimi tolerates non-JSON stdout and the
// hookEventName envelope field, so the shared dispatchers are invoked
// directly.

import type { HookPackV1 } from './types';

export const KIMI_CODE_PACK_VERSION = 2;

export const KIMI_CODE_PACK: HookPackV1 = {
  id: 'kimi-code',
  targetSurface: 'kimi-code',
  packVersion: KIMI_CODE_PACK_VERSION,
  cawsMinMajor: 11,
  summary:
    'Kimi Code vendor adapter: repo-conditional hook shim, AGENTS.md, and ' +
    'kimi-specific emit/run-handlers lib overrides. Shared hook logic is in ' +
    'the `shared` pack under .caws/hooks/. User-level config.toml wiring is ' +
    'merged separately under --wire-user-config.',
  // config.toml is read at session start: a new kimi session is required.
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
    reads: [
      '.caws/specs/*.yaml',
      '.caws/worktrees.json',
      '.caws/agents.json',
      '.caws/leases/',
      '.caws/policy.yaml',
      'package.json',
    ],
    writes: [
      '.kimi-code/logs/audit.log',
      '.kimi-code/logs/session-*.log',
      '.kimi-code/hooks/state/danger-latch-*.json',
      '.kimi-code/hooks/state/guard-strikes-*.json',
      '.kimi-code/hooks/state/guard-reprieve-*.json',
      '.caws/leases/',
      '.caws/sessions/<session-id>/',
      '.caws/sessions/.caller-session.json',
    ],
  },
  lineageRefs: [1, 4, 6, 8, 11, 12, 13, 16, 17, 19, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31],

  // Vendor-adapter files only. sourcePath is relative to the pack root
  // (packages/caws-cli/templates/hook-packs/kimi-code/).
  // All shared hook files are installed by the `shared` pack; they are
  // NOT duplicated here.
  installedFiles: [
    // -- The shim every user-level [[hooks]] entry invokes --
    {
      destPath: '.kimi-code/hooks/caws-kimi-hook.sh',
      sourcePath: 'hooks/caws-kimi-hook.sh',
      executable: true,
      managed: true,
    },

    // -- Agent doctrine for kimi-code --
    {
      destPath: '.kimi-code/AGENTS.md',
      sourcePath: 'AGENTS.md',
      executable: false,
      managed: true,
    },

    // -- Kimi-specific lib overrides --
    // These install to .kimi-code/hooks/lib/ which is where caws_source_lib
    // looks for vendor overrides at runtime. Each file is sourced in
    // preference to the shared default when CAWS_VENDOR_DIR=.kimi-code.
    {
      destPath: '.kimi-code/hooks/lib/emit.sh',
      sourcePath: 'hooks/lib/emit.sh',
      executable: false,
      managed: true,
    },
    {
      destPath: '.kimi-code/hooks/lib/run-handlers.sh',
      sourcePath: 'hooks/lib/run-handlers.sh',
      executable: false,
      managed: true,
    },
    {
      destPath: '.kimi-code/hooks/lib/parse-input.sh',
      sourcePath: 'hooks/lib/parse-input.sh',
      executable: false,
      managed: true,
    },
  ],
};
