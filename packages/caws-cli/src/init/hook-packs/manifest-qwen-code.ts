// Qwen Code hook pack manifest.
//
// Qwen Code reads hook config from the repo-local .qwen/settings.json
// (claude-code/zcode precedent: the wiring is merged in place by
// hook-install.ts — mergeQwenSettings — and a settings.json.example reference
// is always written). No consent flag is needed because the write stays
// inside the repo.
//
// Qwen exports no env var that reliably names the repo root
// (QWEN_CODE_PROJECT_DIR points at the per-project state dir under
// ~/.qwen/projects/<slug>, not the working tree — probed live on 0.21.4,
// tmp/qwen-hook-probe-findings.md), so every settings.json entry invokes the
// repo-conditional shim (hooks/caws-qwen-hook.sh), which resolves the git
// root at invocation time (codex/kimi precedent) and no-ops outside CAWS
// repos.
//
// Qwen's hook payload is Claude-compatible (verified live on 0.21.4), but
// tool_name carries RUNTIME tool ids (write_file, edit, run_shell_command,
// ...) rather than the canonical harness names every shared guard
// self-filters on (Write|Edit|Bash|...). The pack therefore ships ONE vendor
// lib override — hooks/lib/parse-input.sh — which wraps the shared parser
// and normalizes qwen runtime ids to canonical names (codex precedent: the
// codex adapter overrides the same lib for apply_patch). No emit /
// run-handlers overrides are needed (unlike kimi): deny via
// permissionDecision is enforced natively (even under yolo), exit-2 stderr
// reasons reach the model natively, and ask degrades to deny in
// headless/background contexts automatically. The one
// documented-but-unenforced contract is updatedInput (0.21.x): the surface
// declares CAWS_SUPPORTS_UPDATED_INPUT=0 in agent-surface.sh so quiet-merge
// passes commands through unrewritten.
//
// Doctrine landing: .qwen/CAWS-HOOKS.md. Qwen auto-loads only the root
// QWEN.md (plus ~/.qwen/QWEN.md, .qwen/QWEN.local.md, and root AGENTS.md),
// so the wiring step also maintains a CAWS-managed @.qwen/CAWS-HOOKS.md
// import line in the root QWEN.md (created when absent).

import type { HookPackV1 } from './types';

export const QWEN_CODE_PACK_VERSION = 1;

export const QWEN_CODE_PACK: HookPackV1 = {
  id: 'qwen-code',
  targetSurface: 'qwen-code',
  packVersion: QWEN_CODE_PACK_VERSION,
  cawsMinMajor: 11,
  summary:
    'Qwen Code vendor adapter: repo-conditional hook shim and surface ' +
    'doctrine doc. Shared hook logic is in the `shared` pack under ' +
    '.caws/hooks/. Repo-local .qwen/settings.json wiring is merged ' +
    'separately by init.',
  // .qwen/settings.json is read at session start: a new qwen session is
  // required.
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
      '.qwen/logs/audit.log',
      '.qwen/logs/session-*.log',
      '.qwen/hooks/state/danger-latch-*.json',
      '.qwen/hooks/state/guard-strikes-*.json',
      '.qwen/hooks/state/guard-reprieve-*.json',
      '.caws/leases/',
      '.caws/sessions/<session-id>/',
      '.caws/sessions/.caller-session.json',
    ],
  },
  lineageRefs: [1, 4, 6, 8, 11, 12, 13, 16, 17, 19, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31],

  // Vendor-adapter files only. sourcePath is relative to the pack root
  // (packages/caws-cli/templates/hook-packs/qwen-code/).
  // All shared hook files are installed by the `shared` pack; they are
  // NOT duplicated here.
  installedFiles: [
    // -- The shim every .qwen/settings.json hook entry invokes --
    {
      destPath: '.qwen/hooks/caws-qwen-hook.sh',
      sourcePath: 'hooks/caws-qwen-hook.sh',
      executable: true,
      managed: true,
    },

    // -- Agent doctrine for qwen-code (imported from root QWEN.md) --
    {
      destPath: '.qwen/CAWS-HOOKS.md',
      sourcePath: 'CAWS-HOOKS.md',
      executable: false,
      managed: true,
    },

    // -- Qwen-specific lib override --
    // Installs to .qwen/hooks/lib/ which is where caws_source_lib looks for
    // vendor overrides at runtime. Wraps the shared parse-input.sh and
    // normalizes qwen runtime tool ids to the canonical harness names the
    // shared guards self-filter on.
    {
      destPath: '.qwen/hooks/lib/parse-input.sh',
      sourcePath: 'hooks/lib/parse-input.sh',
      executable: false,
      managed: true,
    },
  ],
};
