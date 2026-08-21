// DeepSeek Harness (DSH) hook pack manifest.
//
// DSH's lifecycle interposition is an in-process Cordis plugin surface (the
// harness's canonical interception points: tools/pre-execute,
// tools/post-execute, agent/session-start, agent/turn-stopping). The CAWS
// adapter is the `@deepseek-ai/dsh-hooks-caws` plugin, which ships in the DSH
// package tree and is loaded from the DSH profile — NOT a repo-local
// auto-discovered file like opencode's `.opencode/plugins/*.ts`.
//
// So this vendor pack installs only the surface doctrine (`.dsh/AGENTS.md`).
// The interposition shim is a harness plugin; the shared bash dispatchers it
// invokes are installed unchanged by the `shared` pack under `.caws/hooks/`.
// The plugin resolves the repo root at runtime from the session cwd (walking
// up to the nearest `.caws/`), sets CAWS_AGENT_SURFACE=dsh and
// CAWS_PROJECT_DIR=<root>, and translates DSH tool names to the Claude Code
// canonical names the guards self-filter on (bash→Bash, write→Write,
// edit→Edit, …).
//
// Blocking semantics: DSH supports allow/ask/deny on tools/pre-execute via the
// typed PreToolDecision and the approval seam, so the surface uses the "ask"
// permission vocab (like claude-code) — a CAWS "ask" escalates to a real
// confirmation prompt, not a silent allow.
//
// Activation: DSH loads plugins at profile start. Installing the pack
// mid-session does NOT activate the plugin until the profile is restarted —
// hence activation: 'restart_required'.

import type { HookPackV1 } from './types';

export const DSH_PACK_VERSION = 1;

export const DSH_PACK: HookPackV1 = {
  id: 'dsh',
  targetSurface: 'dsh',
  packVersion: DSH_PACK_VERSION,
  cawsMinMajor: 11,
  summary:
    'DeepSeek Harness vendor adapter: surface doctrine only; the interposition ' +
    'plugin (@deepseek-ai/dsh-hooks-caws) ships in the harness profile and ' +
    'invokes the shared CAWS dispatchers. Shared hook logic is in the `shared` ' +
    'pack under .caws/hooks/.',
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
      '.dsh/logs/audit.log',
      '.dsh/logs/session-*.log',
      '.dsh/hooks/state/danger-latch-*.json',
      '.dsh/hooks/state/guard-strikes-*.json',
      '.caws/leases/',
      '.caws/sessions/<session-id>/',
      '.caws/sessions/.caller-session.json',
    ],
  },
  lineageRefs: [1, 4, 6, 8, 11, 12, 13, 16, 17, 19, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31],

  // Vendor-adapter files only. sourcePath is relative to the pack root
  // (packages/caws-cli/templates/hook-packs/dsh/). All shared hook files are
  // installed by the `shared` pack; they are NOT duplicated here.
  installedFiles: [
    {
      destPath: '.dsh/AGENTS.md',
      sourcePath: 'AGENTS.md',
      executable: false,
      managed: true,
    },
  ],
};
