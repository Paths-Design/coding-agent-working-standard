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

// v2 (WORKTREE-REPAIR-INSTALLED-SMOKE-001): agent-stop.sh corrected from the
// nonexistent `caws agents deregister` to `caws agents stop` (the Stop hook was
// silently no-op'ing — `|| true` swallowed the unknown-command error — leaving
// zombie active leases on every install). A shared-template content change
// requires this bump so `caws init` re-propagates the fix to consumers.
// v3 (CAWS-CLASSIFY-LITERAL-OPAQUE-EXEC-READONLY-001): block-dangerous.sh now
// refuses an opaque-exec ask (python3 -c / node -e with $VAR/$()/backtick) with
// a prescriptive remediation INSTEAD of arming the sticky session danger latch.
// A shared-template content change requires this bump so `caws init`
// re-propagates the fix to consumers (installed hooks are copied, not linked).
// v4 (CAWS-SCOPE-SHOW-JSON-CONTRACT-001): scope-guard.sh deletes its inline
// node -e + js-yaml spec re-parser and consumes `caws scope show --json` (the
// stable kernel-backed diagnostic contract) instead. The kernel is the single
// scope evaluator; the hook is a thin caller. Bump re-propagates the de-duped
// hook to consumers (whose agents cannot edit the CLI themselves).
// v5 (CAWS-SCOPE-CONTENTION-CMD-001): worktree-write-guard.sh deletes its LAST
// inline js-yaml block (the cross-worktree SPEC_CONTENTION_CHECK) and consumes
// `caws scope contention --json` (kernel evaluateContention). After this no
// shared hook re-parses spec YAML. Bump re-propagates the de-duped hook.
// v6 (CAWS-HOOK-PACK-MANAGED-HEADER-GROWTH-DOCTRINE-001): the managed-hook
// header no longer carries the "do_not_edit_directly: update via caws init"
// directive (which contradicted the growth doctrine and trained agents to hunt
// for an upstream fix instead of editing their own hook). Every header now
// carries an `edit_stance:` line stating the repo OWNS and may grow the hook,
// that edits are preserved (caws init refuses to overwrite a changed managed
// hook), and that only editing-to-bypass is out of bounds. The machine-read
// marker keys are untouched. Bump re-propagates the reframed header.
//
// v7 (CAWS-CLASSIFY-PIPE-TO-LOCAL-SCRIPT-CARVEOUT-001): classify_command.py
// carves the pipe-to-LOCAL-SCRIPT form (`printf json | bash hook.sh`) back to
// allow — piping a payload into a NAMED, inspectable script file is not curl|sh
// of a remote interpreter and must not arm the catastrophic latch. Bare
// `| bash`/`| sh`, flagged/redirected forms, and the curl/wget rule still deny.
// This was the #1 deny-class danger-latch reset in the repo's own telemetry.
//
// v8 (CAWS-GOD-OBJECT-CHECK-HYSTERESIS-001): god-object-check.sh is now
// hysteresis-aware. It no longer re-warns on every edit to an already-over-
// threshold file (noise that trains the agent to ignore the advisory); for an
// Edit it warns only when the edit CROSSES the threshold or adds a large delta
// (>= CAWS_GOD_OBJECT_DELTA, default 100), derived statelessly from the Edit
// payload. A Write of a whole over-threshold file still warns; always exit 0.
//
// v9 (CAWS-HOOKPACK-ORACLE-JSYAML-DEGRADE-001): worktree-claim-oracle.cjs now
// emits `degraded_no_yaml` (not `error_fail_closed`) when the cross-worktree
// canonical-claim check cannot run because js-yaml is unresolvable. bash-write-
// guard.sh and worktree-write-guard.sh map it to allow-with-advisory, not ask —
// a missing dependency is a toolchain fault, not an ownership signal, and the
// old fail-closed turned every canonical mutation into an approval prompt when
// js-yaml was absent. The yaml-free foreign-worktree-payload block is unchanged
// and still hard-blocks. The error_fail_closed ask message is also reworded to
// name a toolchain fault rather than a (false) ownership conflict.
//
// v10 (CAWS-HOOK-SOURCE-GUARD-FAIL-SOFT-001): the load-bearing guards
// (block-dangerous, scope-guard, worktree-guard, worktree-write-guard,
// bash-write-guard, scan-secrets, quiet-merge) now source agent-surface.sh /
// caws-state.sh through a survivable `[[ -f ]] && source` form instead of
// `source <missing> 2>/dev/null || true`. Under `set -euo pipefail` the old
// form was a fatal builtin error that `|| true` did NOT catch, so a missing
// shared lib silently killed every guard that sourced it — including the danger
// latch (the Sterling consumer incident). On a missing load-bearing lib the
// enforcement guards now fail LOUD: block-dangerous + the two write guards emit
// a self-identifying block decision and exit 2 (the write guards' prior
// `|| exit 0` fail-OPEN on caws-state.sh is removed); advisories (scan-secrets,
// quiet-merge) fail soft-but-loud (diagnostic + exit 0).
//
// v11 (AGENT-HEARTBEAT-MESSAGE-HINT-001): the agent-heartbeat multi-agent notice
// now also tells peers they can message each other directly via `caws message
// send/poll` (with delivery-timing / non-live-refusal / unverified-claim caveats).
// Additive notice text only; no behavioral change to the heartbeat write or the
// change-detection suppression.
//
// v12 (AGENT-MESSAGE-AUTODELIVERY-001): the agent-heartbeat hook now AUTO-DELIVERS
// inter-agent mail — on every PreToolUse it polls the session's mailbox (NOT gated
// by the heartbeat write-throttle) and injects the next waiting message into
// context (consume + inject, one per tool call, fail-closed-non-blocking). Fixes
// the pull-model gap where a recipient only saw mail when manually polling. Also
// lowers the heartbeat write-throttle 30s -> 15s for snappier peer-presence.
//
// v13 (AGENT-HEARTBEAT-NOTICE-TRAPS-01): peer-notice text corrected — replies
// auto-surface at the next tool call (poll [--wait] is check-now, not how you
// receive replies), and two real footguns warned: judge a send by its printed
// output not a chained `echo $?` (which reports the echo, not the send; also no
// 2>/dev/null), and liveness is repo-local (a peer running elsewhere is refused
// here). Notice text only — no behavioral change.
// v14 (OPENCODE-HOOK-PACK-001): agent-surface.sh now recognizes the opencode
// surface — CAWS_VENDOR_DIR=.opencode, CAWS_PERMISSION_VOCAB=deny (opencode
// has no PreToolUse ask; its block primitive is throw inside
// tool.execute.before). Without this, an opencode plugin dispatch set
// CAWS_AGENT_SURFACE=opencode but every guard fell through to the claude-code
// default and spammed "unknown CAWS_AGENT_SURFACE=opencode" warnings while
// misrouting logs to .claude/logs/. No other behavioral change.
// v15 (UX-HOOK-INPUT-PARSE-DIAGNOSTIC-001): runtime-paths.sh keeps malformed
// hook stdin fail-open, but now emits a controlled CAWS hook-parse diagnostic to
// stderr instead of silently replacing the payload with {}. The diagnostic never
// echoes raw malformed input and avoids Python tracebacks.
// v16 (CAWS-ZCODE-AGENT-SURFACE-001): agent-surface.sh gains a `zcode` case arm
// (CAWS_VENDOR_DIR=.zcode, CAWS_PERMISSION_VOCAB=ask — ZCode supports allow/ask/
// deny for PreToolUse like Claude Code). emit_ask gains an optional [event]
// parameter so a future PostToolUse caller can pass the correct hookEventName;
// the harness validates hookEventName against the actual event and rejects a
// mismatch. No current caller passes a second arg, so existing PreToolUse ask
// behavior is unchanged; the change is defensive hardening that lets the same
// emitter serve PostToolUse without each surface rolling its own.
// v17 (CAWS-WORKTREE-WRITE-GUARD-VENDOR-GENERALIZE-001): agent-surface.sh
// exports CAWS_INSTRUCTION_FILES (CLAUDE.md for claude-code; AGENTS.md for
// codex/opencode/zcode; both for the unknown-surface fallback).
// worktree-write-guard.sh's hardcoded CLAUDE.md allowlist arm is replaced with
// a CAWS_INSTRUCTION_FILES-driven [[ == ]] conditional so every surface's root
// instruction file bypasses the base-branch write guard. session-log.sh's
// is_plan_file_path() no longer hardcodes .claude/plans/ — it derives the
// harness plan dir from CAWS_VENDOR_DIR (same [[ == ]] pattern the rest of the
// file uses for vendor paths).
// CAWS-RESOLVER-PLATFORM-FROM-ENVELOPE-001: parse-input.sh's
// _write_durable_session_envelope now emits a `platform` field (sourced from
// CAWS_PLATFORM_FLAG) so the resolver can read the true surface identity
// instead of hardcoding 'claude-code'. Defaults to 'claude-code' when the
// flag is unset, preserving back-compat for wirings that haven't sourced
// agent-surface.sh.
// v26 (HOOK-PROJECT-DIR-ROOT-NOT-CWD-01): agent-surface.sh now NORMALIZES the
// vendor *_PROJECT_DIR (CLAUDE_PROJECT_DIR / CODEX_PROJECT_DIR) to its git
// repo root before adopting it, via `git rev-parse --show-toplevel`. Some
// harnesses inject the session CWD there rather than the repo root — zcode
// sets CLAUDE_PROJECT_DIR to the session cwd, which is often a package-bearing
// subdirectory, so the old verbatim adoption made CAWS_PROJECT_DIR a subdir and
// fragmented every derived path (CAWS_LOG_DIR, the heartbeat lease cache, the
// audit log) into a stray <subdir>/.caws or <subdir>/.zcode, wedging merges
// and corrupting peer-agent context. This is the same invariant the codex
// dispatcher already binds (hook-install.ts codexCommand:
// CAWS_PROJECT_DIR=$REPO_ROOT). It is a no-op for harnesses whose vendor dir
// is already the root (Claude Code, Codex — show-toplevel is idempotent);
// fail-open keeps the raw candidate when git is absent or the dir is not in a
// repo (never downgrades a real vendor signal to "."); the bare "." fallback
// is reached only when no vendor *_PROJECT_DIR is set at all.
// v27 (CAWS-RESET-LATCH-MULTIVENDOR-001): reset-danger-latch.sh now searches
// across ALL present vendor state dirs, not just its own (defaulted) one. The
// latch is written by block-dangerous.sh under the WRITER's vendor dir (the
// active harness bridge sets CAWS_AGENT_SURFACE, e.g. zcode -> .zcode/), but
// the reset is run by a human from a plain shell where CAWS_AGENT_SURFACE is
// unset, so agent-surface.sh defaults to claude-code -> .claude/. In a
// multi-surface repo the latch lived under .zcode/ while the reset searched
// only .claude/ — reporting "nothing to clear" while the latch stayed armed,
// wedging the agent with no working recovery. --all now sweeps every vendor
// dir; --session/--current search the keyed filename (and the one-latch
// fallback) across the union. The session-id resolution is unchanged.
// v28 (CAWS-LATCH-CANONICAL-STATE-DIR-001): extract a shared canonical
// hook-state-dir helper (lib/caws-state.sh caws_canonical_state_dir) and align
// the danger-latch clearer + reprieve onto it. lib/reprieve.sh no longer
// inlines its own git-common-dir walk (pure dedup, behavior-preserving).
// reset-danger-latch.sh anchors its multi-vendor search at the CANONICAL repo
// root (via the helper) instead of the install root — closing the gap where a
// latch written at <git-root>/.zcode/... was missed when the reset ran from a
// linked worktree (install root != git root). The guard-strike subsystem is
// deliberately NOT migrated (its out-of-tree placement is an intentional
// git-add safety invariant). No behavioral change to reprieve; the latch
// clearer is strictly more correct than v27's install-root anchoring.
// v29 (CAWS-SESSION-SHELL-RESOLVER-CAPSULE-001): resolve_caws_session_id
// (lib/session-id.sh) now consults the durable capsule at
// .caws/sessions/caws-<id>.json when the env-identity chain misses — the shell
// mirror of the TS resolver's tier-3 readCapsule, and the same file caws
// worktree create records as the owner. Without it, a Bash subshell carrying no
// identity env var resolved to "unknown", so the write-guards treated the
// owner's own edits as foreign and blocked/reverted them. This completes the
// shell resolver to match the canonical identity model (one model across shell
// + TS), not a parallel fallback. Fail-opens to "unknown" only when no capsule
// exists.
//
// Version 30: CAWS-HOOK-PACK-KIMI-CODE-001. lib/agent-surface.sh gains the
// kimi-code case arm (vendor dir .kimi-code, deny vocab, AGENTS.md instruction
// file) and SURFACES doc; quiet-merge.sh passes commands through unrewritten
// on surfaces without an updatedInput contract (kimi). No guard logic changes.
//
// Version 31: CAWS-HOOK-PACK-QWEN-CODE-001. lib/agent-surface.sh gains the
// qwen-code case arm (vendor dir .qwen, ask vocab — deny/ask both enforced
// natively per the 0.21.4 probe, QWEN.md instruction file,
// CAWS_SUPPORTS_UPDATED_INPUT=0 — documented but not enforced in Qwen 0.21.x)
// and SURFACES doc. lib/session-id.sh adds QWEN_CODE_SESSION_ID to the
// canonical env-var precedence (tier 4, after CODEX_THREAD_ID), mirroring the
// resolve-session.ts qwen tier. No guard logic changes.
export const SHARED_PACK_VERSION = 31;

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
      // CAWS-SESSION-RESOLVER-GUARD-DIVERGENCE-001 (A6): shared session-id
      // precedence helper sourced by the write guards, block-dangerous.sh, and
      // reset-danger-latch.sh so every shell surface resolves "the current
      // session" through ONE env-var chain that mirrors the TS resolver.
      destPath: '.caws/hooks/lib/session-id.sh',
      sourcePath: 'lib/session-id.sh',
      executable: false,
      managed: true,
    },
    {
      // CAWS-GUARD-REPRIEVE-SESSION-SCOPED-001: session-scoped guard reprieve
      // consult lib. Sourced best-effort by run-handlers.sh; the dispatcher
      // skips invocation of reprieved handlers for the resolved session.
      destPath: '.caws/hooks/lib/reprieve.sh',
      sourcePath: 'lib/reprieve.sh',
      executable: false,
      managed: true,
    },
    {
      destPath: '.caws/hooks/lib/worktree-claim-oracle.cjs',
      sourcePath: 'lib/worktree-claim-oracle.cjs',
      executable: false,
      managed: true,
    },
    {
      // CAWS-GUARD-ALLOWLIST-SYNC-001 extracted this helper but shipped it
      // without a manifest entry (the layout test has been red since
      // b4c1d4b2 and consumers never received the file, degrading both
      // write guards to their pre-sync allow behavior). Declared here so
      // init installs it alongside the guards that source it
      // (worktree-write-guard.sh, bash-write-guard.sh).
      destPath: '.caws/hooks/lib/write-allowlist.sh',
      sourcePath: 'lib/write-allowlist.sh',
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
