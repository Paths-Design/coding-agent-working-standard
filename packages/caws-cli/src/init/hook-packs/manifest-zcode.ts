// ZCode hook pack manifest.
//
// ZCode (the ZCode CLI) is the fifth agent harness CAWS supports. Like
// claude-code and codex, ZCode fires hooks by invoking an external command
// named in a config file (.zcode/config.json). Unlike those surfaces, ZCode's
// hook runner parses the command's stdout against a STRICT JSON schema: extra
// keys are rejected, and non-JSON stdout is treated as a hook failure
// (hook.run.failed). The CAWS shared dispatchers emit valid JSON for the
// decision-bearing events (PreToolUse/PostToolUse/Stop via emit.sh), but the
// SessionStart dispatcher's session-caws-status.sh handler emits plain-text
// banners (worktree roster, risk briefing, doctor state) via echo — valid
// under Claude Code's free-form-text contract, rejected by ZCode.
//
// So the ZCode vendor adapter is a bridge wrapper (caws-bridge.sh), not a bare
// dispatcher reference. The bridge sits between .zcode/config.json and the
// shared dispatchers: it runs the dispatcher with CAWS_AGENT_SURFACE=zcode
// injected, captures stdout + exit code, and either passes valid JSON through
// or re-wraps non-JSON output as a valid additionalContext envelope so ZCode's
// parser accepts it. The dispatcher's exit code is always relayed (block
// decisions preserved). This reuses 100% of the shared guard/check logic with
// no duplication; the shared core is installed unchanged by the `shared` pack
// under .caws/hooks/.
//
// Permission vocabulary: ZCode supports allow/ask/deny for PreToolUse (the same
// vocabulary as Claude Code), so CAWS_PERMISSION_VOCAB=ask — unlike codex and
// opencode, which degrade ask to deny because their only block primitive is a
// hard failure. No vendor override of emit.sh is installed for zcode.
//
// Path resolution: like Claude Code, ZCode exposes a ZCODE_PROJECT_DIR env var
// at hook invocation time pointing at the project root. The config.json
// command templates embed "${ZCODE_PROJECT_DIR}" so copied worktrees and
// subdirectory-launched sessions resolve the project root at invocation time,
// not install time — matching the codex runtime-root doctrine
// (CAWS-CODEX-HOOK-RUNTIME-ROOT-001) without needing install-time token
// substitution.
//
// .zcode/config.json is NOT a managed pack file: it carries user-authored
// hooks/permissions/env that the pack must not clobber. It is merged
// non-destructively at install time by hook-install.ts:mergeZcodeConfig (the
// ZCode parallel of mergeClaudeSettings), targeting ZCode's schema:
//   { "hooks": { "enabled": true, "events": { "<Event>": [ {matcher,hooks} ] } } }
// A .zcode/config.json.example is emitted as a reference artifact for users
// who decline the in-place merge.
//
// Activation: ZCode reads hook registration from .zcode/config.json at session
// start. Installing mid-session does NOT activate the hooks until ZCode is
// restarted — hence activation: 'restart_required', matching codex/opencode.

import type { HookPackV1 } from './types';

// Version 1 (CAWS-ZCODE-AGENT-SURFACE-001): initial ZCode vendor adapter.
// Installs the bridge wrapper only; shared hook logic comes from the `shared`
// pack. The bridge is the bugfixed version validated live in the Sterling
// consumer (commit cf0118d97): strict-JSON re-wrapping, multi-object stdout
// coalescing (decision-bearing objects win over advisory), exit-code pass-through.
export const ZCODE_PACK_VERSION = 2;

export const ZCODE_PACK: HookPackV1 = {
  id: 'zcode',
  targetSurface: 'zcode',
  packVersion: ZCODE_PACK_VERSION,
  cawsMinMajor: 11,
  summary:
    'ZCode vendor adapter: bridge wrapper that re-wraps shared-dispatcher ' +
    "output for ZCode's strict-JSON hook contract. Shared hook logic is in " +
    'the `shared` pack under .caws/hooks/.',
  activation: 'restart_required',
  // No PreCompact wiring: the zcode bridge/dispatcher set does not register a
  // PreCompact event. Add 'pre_compact' here only if/when a ZCode PreCompact
  // dispatcher path is wired into .zcode/config.json.
  lifecycleEvents: ['pre_bash', 'pre_write', 'pre_edit', 'session_start', 'stop'],
  stateModel: {
    // Reads/writes mirror codex/claude-code (same shared core runs under the
    // hood) but with zcode-native log/state paths. Runtime reads/writes for the
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
      '.zcode/logs/audit.log',
      '.zcode/logs/session-*.log',
      '.caws/leases/',
      '.caws/sessions/<session-id>/',
      '.caws/sessions/.caller-session.json',
    ],
  },
  // zcode is a fresh surface; no prior failure-lineage entries name it. As the
  // surface accumulates its own incident history, append those entries here.
  lineageRefs: [],

  // Vendor-adapter files only. sourcePath is relative to the pack root
  // (packages/caws-cli/templates/hook-packs/zcode/). All shared hook files are
  // installed by the `shared` pack; they are NOT duplicated here.
  installedFiles: [
    // -- The bridge wrapper. Sits between ZCode's hook runner and the shared
    //    dispatcher at .caws/hooks/dispatch/<event>.sh, re-wrapping non-JSON
    //    output (e.g. SessionStart banners) as valid additionalContext
    //    envelopes. Copied verbatim (no install-time token substitution) — the
    //    ZCODE_PROJECT_DIR env var is resolved by ZCode at invocation time. --
    {
      destPath: '.zcode/hooks/caws-bridge.sh',
      sourcePath: 'hooks/caws-bridge.sh',
      executable: true,
      managed: true,
    },
  ],
};
