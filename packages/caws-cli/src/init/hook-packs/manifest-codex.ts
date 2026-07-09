// Codex hook pack manifest.
//
// Codex loads project-local hooks from `.codex/hooks.json` after the project
// layer is trusted and the hook definitions are reviewed through `/hooks`.
// Multiple matching command hooks for a single event are launched
// concurrently, so this pack installs exactly one CAWS dispatcher per Codex
// event and keeps CAWS guard ordering inside those dispatchers.
//
// Version 7: CAWS-HOOK-PACK-SHARED-CORE-001. All shared hook logic
// (guards, dispatchers, libs) has been moved to the `shared` pack
// (manifest-shared.ts) which installs under .caws/hooks/. This vendor
// adapter now installs only the codex-specific surface files:
//   - hooks.json (the codex wiring; command paths updated to .caws/hooks/dispatch/)
//   - AGENTS.md (agent doctrine)
//   - hooks/lib/emit.sh, parse-input.sh, run-handlers.sh (genuine codex overrides)
//
// The codex override libs install to .codex/hooks/lib/ which is exactly
// where caws_source_lib looks for vendor overrides:
//   ${CAWS_PROJECT_DIR}/${CAWS_VENDOR_DIR}/hooks/lib/<basename>
//   = .codex/hooks/lib/<name>
//
// No session_log_renderer.py override: shared/session-log.sh resolves its
// renderer as `$SCRIPT_DIR/session_log_renderer.py` (= .caws/hooks/, the
// shared core), so a .codex/hooks/session_log_renderer.py copy is never
// invoked. The codex renderer never carried codex-specific event handling —
// it differed from the shared renderer only in the managed header and the
// agent name in comments — so it is pure cosmetic duplication of the exact
// kind this refactor eliminates. Codex uses the shared renderer.
//
// The shared pre_compact dispatcher at .caws/hooks/dispatch/pre_compact.sh
// is surface-neutral and handles codex PreCompact events directly; no
// per-vendor caws_dispatch/pre_compact.sh is needed.
//
// Decision on codex README: the codex adapter does NOT install a README.md.
// A README under .codex/hooks/ would need to be maintained separately from
// the claude-code README and would describe the same shared hook logic. The
// AGENTS.md is the authoritative surface doc for codex; that is sufficient.

import type { HookPackV1 } from './types';

// Version 9: CAWS-HOOK-PACK-MANAGED-HEADER-GROWTH-DOCTRINE-001. The codex
// surface files (AGENTS.md + the codex hook libs) drop the
// "do_not_edit_directly: update via caws init" header directive for the
// `edit_stance:` growth framing (repo owns/grows the hook; edits preserved;
// only editing-to-bypass is out of bounds). Bump re-propagates on next
// caws init --agent-surface codex.
//
// Version 10: CAWS-CODEX-HOOKS-JSON-SCHEMA-001. Remove the top-level
// CAWS metadata field from hooks.json because Codex only accepts `hooks` at the
// top level. Installer recognition now uses the runtime-root dispatcher shape
// for this one JSON file instead of unsupported embedded metadata.
export const CODEX_PACK_VERSION = 11;

export const CODEX_PACK: HookPackV1 = {
  id: 'codex',
  targetSurface: 'codex',
  packVersion: CODEX_PACK_VERSION,
  cawsMinMajor: 11,
  summary:
    'Codex vendor adapter: hooks.json wiring, AGENTS.md, and codex-specific ' +
    'lib overrides. Shared hook logic is in the `shared` pack under .caws/hooks/.',
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
      '.codex/logs/audit.log',
      '.codex/logs/session-*.log',
      '.codex/hooks/state/danger-latch-*.json',
      '.codex/hooks/state/guard-strikes-*.json',
      '.caws/leases/',
      '.caws/sessions/<session-id>/',
      '.caws/sessions/.caller-session.json',
    ],
  },
  lineageRefs: [1, 4, 6, 8, 11, 12, 13, 16, 17, 19, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31],

  // Vendor-adapter files only. sourcePath is relative to the pack root
  // (packages/caws-cli/templates/hook-packs/codex/).
  // All shared hook files are installed by the `shared` pack; they are
  // NOT duplicated here.
  installedFiles: [
    // -- Codex wiring (hooks.json carries substitution tokens that are
    //    replaced at install time with absolute .caws/hooks/dispatch/<event>.sh
    //    paths and CAWS_AGENT_SURFACE=codex injected) --
    {
      destPath: '.codex/hooks.json',
      sourcePath: 'hooks.json',
      executable: false,
      managed: true,
    },

    // -- Agent doctrine for codex --
    {
      destPath: '.codex/AGENTS.md',
      sourcePath: 'AGENTS.md',
      executable: false,
      managed: true,
    },

    // -- Codex-specific lib overrides --
    // These install to .codex/hooks/lib/ which is where caws_source_lib
    // looks for vendor overrides at runtime. Each file is sourced in
    // preference to the shared default when CAWS_VENDOR_DIR=.codex.
    {
      destPath: '.codex/hooks/lib/emit.sh',
      sourcePath: 'hooks/lib/emit.sh',
      executable: false,
      managed: true,
    },
    {
      destPath: '.codex/hooks/lib/parse-input.sh',
      sourcePath: 'hooks/lib/parse-input.sh',
      executable: false,
      managed: true,
    },
    {
      destPath: '.codex/hooks/lib/run-handlers.sh',
      sourcePath: 'hooks/lib/run-handlers.sh',
      executable: false,
      managed: true,
    },
  ],
};
