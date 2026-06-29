// opencode hook pack manifest.
//
// opencode (https://opencode.ai) is the fourth agent harness CAWS supports.
// Unlike claude-code and codex — which fire hooks by invoking an external
// bash command named in a config file (.claude/settings.json,
// .codex/hooks.json) — opencode's lifecycle interposition is an in-process
// TypeScript plugin surface (https://opencode.ai/docs/plugins). There is no
// "run this bash command on PreToolUse" config field. opencode exposes:
//
//   - `tool.execute.before` — fires before a tool runs; the plugin can
//     mutate args, and BLOCKS the call by `throw new Error(reason)`.
//   - `tool.execute.after` — fires after a tool runs.
//   - `event` — the generic bus-callback; session.created / session.idle /
//     session.compacted are observed here for session lifecycle.
//
// So the opencode vendor adapter is a TS plugin shim (not a config file).
// The shim translates opencode's in-process callbacks into the SAME shared
// bash dispatchers every other surface uses (.caws/hooks/dispatch/<event>.sh),
// reusing 100% of the guard/check logic with no duplication. The shared core
// is installed unchanged by the `shared` pack; this adapter installs only:
//   - .opencode/plugins/caws.ts   (the shim; auto-discovered by opencode)
//   - .opencode/AGENTS.md         (surface doctrine)
//
// Path resolution: unlike the codex hooks.json (which uses install-time
// __CAWS_CODEX_*__ token substitution to bake absolute paths into the
// wiring), the opencode plugin resolves the repo root at RUNTIME from the
// plugin ctx (worktree / project.path / directory). No token step, no
// installer special-case — the plugin file is copied verbatim.
//
// Blocking semantics: opencode's only PreToolUse block primitive is
// `throw new Error(msg)` inside tool.execute.before (the message becomes the
// tool-failure reason the agent sees). The shim parses the dispatcher's
// stdout decision + exit code and throws on block. opencode has no native
// PreToolUse "ask"; per the codex precedent (codex/hooks/lib/emit.sh degrades
// ask -> deny), ask-level escalations degrade to block so governance never
// silently allows an operation because an unsupported ask field was ignored.
//
// Advisory-warn surfacing (known limitation): tool.execute.before is binary
// (throw = block, return = allow); there is no native "allow but show the
// agent a warning." Advisory decisions (warn/allow with a reason) are sent
// to opencode's structured log via client.app.log({level:"warn"}) rather than
// the model's context. This is weaker than the claude-code/codex stderr
// surface; a future iteration may inject advisories into the message stream.
//
// Activation: opencode loads plugins once at startup from
// .opencode/plugins/ (and ~/.config/opencode/plugins/). Installing
// mid-session does NOT activate the plugin until opencode is restarted —
// hence activation: 'restart_required', matching codex.

import type { HookPackV1 } from './types';

// Version 5: production. Removes the v4 diagnostic trace and lands the two
// fixes that made the opencode surface fully functional end-to-end (verified
// live): (1) extractJsonObjects — the dispatcher's stdout is multi-line
// (jq pretty-prints additionalContext), so the old line-by-line parse missed
// every additionalContext and contextLen was always 0; (2) context injection
// via experimental.chat.system.transform (v2/v3 session.prompt no-ops from a
// tool hook). tool.execute.before stashes additionalContext; system.transform
// appends it to the system prompt on the next model call. Live-verified:
// message → heartbeat poll → additionalContext → stash → system.transform
// INJECTED → model perceives it. Builds on v3 (updatedInput/quiet-merge) and
// v2 (session-id in the dispatcher payload).
export const OPENCODE_PACK_VERSION = 5;

export const OPENCODE_PACK: HookPackV1 = {
  id: 'opencode',
  targetSurface: 'opencode',
  packVersion: OPENCODE_PACK_VERSION,
  cawsMinMajor: 11,
  summary:
    'opencode vendor adapter: TS plugin shim wiring tool.execute.before/after ' +
    'and session events to the shared CAWS dispatchers. Shared hook logic is ' +
    'in the `shared` pack under .caws/hooks/.',
  activation: 'restart_required',
  lifecycleEvents: ['pre_bash', 'pre_write', 'pre_edit', 'session_start', 'stop', 'pre_compact'],
  stateModel: {
    // Reads/writes mirror codex (same shared core runs under the hood) but
    // with opencode-native log/state paths. Runtime reads/writes for the
    // shared hook scripts are declared in manifest-shared.ts.
    reads: [
      '.caws/specs/*.yaml',
      '.caws/worktrees.json',
      '.caws/agents.json',
      '.caws/leases/',
      '.caws/policy.yaml',
      'package.json',
    ],
    writes: [
      '.opencode/logs/audit.log',
      '.opencode/logs/session-*.log',
      '.opencode/hooks/state/danger-latch-*.json',
      '.opencode/hooks/state/guard-strikes-*.json',
      '.caws/leases/',
      '.caws/sessions/<session-id>/',
      '.caws/sessions/.caller-session.json',
    ],
  },
  lineageRefs: [1, 4, 6, 8, 11, 12, 13, 16, 17, 19, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31],

  // Vendor-adapter files only. sourcePath is relative to the pack root
  // (packages/caws-cli/templates/hook-packs/opencode/). All shared hook
  // files are installed by the `shared` pack; they are NOT duplicated here.
  installedFiles: [
    // -- The TS plugin shim. opencode auto-discovers *.ts from
    //    .opencode/plugins/ at startup (no opencode.json `plugin:` entry
    //    required). Resolves .caws/ paths at runtime from the plugin ctx;
    //    copied verbatim (no install-time token substitution). --
    {
      destPath: '.opencode/plugins/caws.ts',
      sourcePath: 'plugin.ts',
      executable: false,
      managed: true,
    },

    // -- Surface doctrine for hook editors --
    {
      destPath: '.opencode/AGENTS.md',
      sourcePath: 'AGENTS.md',
      executable: false,
      managed: true,
    },
  ],
};
