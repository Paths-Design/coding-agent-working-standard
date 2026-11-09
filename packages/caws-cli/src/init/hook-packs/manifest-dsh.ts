// DeepSeek Harness (DSH) hook pack manifest.
//
// DSH's interposition is a harness-loaded plugin (the harness's canonical
// interception points: tools/pre-execute, tools/post-execute, agent/created,
// agent/turn-stopping). Per-surface facts live in
// surfaces/registry.json; `dsh` carries hookMechanism: 'harness-plugin'. The
// CAWS reference adapter is the `@caws/dsh-bundle` bundle (repo
// `caws-dsh-bundle`), which composes three plugins — caws-hooks (policy
// dispatch), caws-session-log (turn-log fold), and caws-agents-lifecycle
// (CLI-mediated leases) — and is loaded from the DSH profile's bundle list.
// A profile composes each bundle's OWN patch (declared as dsh.bundle.patch in
// that bundle's package.json) before its own cordis.patch.yml, so the CAWS
// plugin ids arrive from the bundle's patch; the profile's own patch is an
// additional layer and is empty on a stock profile. It is NOT a repo-local
// auto-discovered file like opencode's `.opencode/plugins/*.ts`, and it is NOT
// wired by a settings key.
//
// So this vendor pack installs only the surface doctrine (`.dsh/AGENTS.md`).
// The interposition plugin is loaded from the profile; the shared bash
// dispatchers it invokes are installed unchanged by the `shared` pack under
// `.caws/hooks/`. The plugin resolves the repo root at runtime from the session
// cwd (walking up to the nearest `.caws/`), sets CAWS_AGENT_SURFACE=dsh and
// CAWS_PROJECT_DIR=<root>, and translates DSH tool names to the Claude Code
// canonical names the guards self-filter on (bash→Bash, write→Write,
// edit→Edit, …).
//
// Blocking semantics: DSH supports allow/ask/deny on tools/pre-execute via the
// typed PreToolDecision and the approval seam. The bridge resolves a CAWS "ask"
// through that seam; a rejection or unavailable approval channel degrades to a
// denial, never a silent allow.
//
// Activation: DSH loads plugins at profile start (or live-recomposes under
// HMR). Installing the pack mid-session does NOT activate the plugin until the
// profile loads the bundle — hence activation: 'restart_required'. Whether a
// given machine is wired is a property of the live profile (its bundle list
// plus each bundle's patch), never of a settings key. `caws init
// --agent-surface dsh --plan` and `caws doctor` observe that composition and
// report WIRED / NOT WIRED / UNOBSERVED instead of assuming it.

import type { HookPackV1 } from './types';
import { SURFACE_HOOK_MECHANISMS } from './surfaces.generated';

export const DSH_PACK_VERSION = 4;

export const DSH_PACK: HookPackV1 = {
  id: 'dsh',
  targetSurface: 'dsh',
  packVersion: DSH_PACK_VERSION,
  cawsMinMajor: 11,
  summary:
    'DeepSeek Harness vendor adapter: surface doctrine only; the CAWS ' +
    `interposition plugin is harness-loaded (hookMechanism: ${SURFACE_HOOK_MECHANISMS.dsh}) ` +
    'from the DSH profile bundle list and invokes the shared CAWS dispatchers. ' +
    'Shared hook logic is in the `shared` pack under .caws/hooks/.',
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
