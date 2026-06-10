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
//
// Version 7: CAWS-HOOK-PACK-PROMOTE-001. Promotes all 7 PORT-classified
// hooks from the Sterling hook audit
// (docs/reports/sterling_hook_port_audit_001.md):
//   - cwd-guard.sh (PreToolUse, lineage 22): blocks tool calls when
//     the working directory has been deleted. Mitigates a documented
//     Claude Code session-crash class.
//   - protected-paths.sh (PreToolUse, lineage 23): blocks Write/Edit
//     on .claude/hooks/* and .claude/logs/guard-strikes-*.json.
//     Closes the doctrine-vs-enforcement gap that lets agents edit
//     their own hook state.
//   - scan-secrets.sh (PreToolUse, lineage 24): advisory on .env
//     files, SSH keys, cloud configs. Never blocks.
//   - naming-check.sh (PostToolUse, lineage 25): "no shadow files"
//     enforcement. Banned modifier suffixes, version suffixes, date
//     stamps. Genericized: dropped Sterling-era references to the
//     v10 `caws naming check` CLI and `.caws/canonical-map.yaml`.
//   - quiet-merge.sh (PreToolUse LAST, lineage 26): rewrites
//     `caws worktree merge|destroy` bash commands to cd to repo
//     root + suppress output, avoiding subagent CWD-destroyed
//     crashes and context-window overflow on verbose merge output.
//     Companion to cwd-guard.sh.
//   - plan-transcript-snapshot.sh (PostToolUse on ExitPlanMode,
//     lineage 27): snapshots the conversation transcript co-located
//     with the plan file when ExitPlanMode fires.
//   - plan-transcript-finalize.sh (Stop, lineage 27): drains the
//     pending-snapshots list and overwrites each with the final
//     turn-end transcript. Companion to plan-transcript-snapshot.sh.
// Dispatcher updates: pre_tool_use.sh adds cwd-guard, protected-paths,
// scan-secrets, quiet-merge (last); post_tool_use.sh adds
// naming-check, plan-transcript-snapshot; stop.sh adds
// plan-transcript-finalize. No stateModel changes (the plan-transcript
// pair writes to $HOME/.claude/.pending-plan-snapshots, outside the
// repo).
//
// Version 8: CAWS-LITE-MODE-RETIREMENT-001. Removes the v10 "Lite mode"
// branch from scope-guard.sh. The branch previously read
// `.caws/scope.json` and enforced lite-mode rules when no `.caws/specs/`
// directory was present — a v10 fallback that silently disagreed with
// `caws doctor`'s v11 view of the same project. v8 hooks ignore
// `.caws/scope.json` entirely; consumers with a legacy file get a
// doctor finding (informational) pointing at the migration guide.
// No stateModel changes; no new managed files. The retirement is the
// LIVE component of CAWS-LITE-MODE-RETIREMENT-001 — the spec also
// authorizes deleting v10 source archaeology (src/config/lite-scope.js,
// src/config/modes.js, src/scaffold/, the lite branches in
// src/commands/init.js + src/commands/specs.js) but those files are
// already excluded from the v11 npm package by build-cli.js's
// allowlist, so deleting them is hygiene, not a behavior change.
// Companion docs section in docs/migration-v10-to-v11.md.
//
// Version 9: CAWS-SCOPE-STRIKE-SOURCE-UNIFY-001. Makes scope-guard.sh
// delegate to `caws scope check <path>` (the kernel-backed authority)
// before falling through to its inline node block. This unifies the
// scope-decision source: the hook's ADMIT/REFUSE matches what
// `caws scope show <path>` would report, eliminating the divergence
// class that Sterling turn-043 (2026-05-26) hit, where
// `caws scope show` returned ADMIT but the hook kept incrementing
// strikes against a previously-rejected path.
//
// Side effect (intentional): strike-state staleness is auto-resolved.
// When the kernel says ADMIT, the hook exits 0 immediately without
// invoking the strike counter, regardless of prior strikes accumulated
// against the path. The user no longer needs to run
// `reset-strikes.sh --current` after a scope.in amendment that newly
// admits a hot file.
//
// The inline node block (which was the only scope-decision path in
// pack v8) remains as the fallback when `caws` is not on PATH, and as
// the source of structured diagnostic detail (out_of_scope vs
// not_in_scope, the offending pattern, union vs authoritative mode)
// since `caws scope check` only exposes admit/refuse via exit code.
// A future iteration can collapse the fallback once
// `caws scope check --explain` exposes the structured detail.
//
// No new managed files; no stateModel changes.
//
// Version 10: CAWS-WORKTREE-OWNERSHIP-HARNESS-ID-001. parse-input.sh now
// also writes/refreshes a per-repo caller-session pointer at
// `<repo_root>/tmp/.caller-session.json` (alongside the existing durable
// envelope). In agent-Bash HOOK_SESSION_ID is absent, so when multiple
// fresh sibling envelopes match the repo the resolver cannot tell which
// is the caller's and refuses (then a rotating capsule gets frozen as
// worktrees.json owner -> own-worktree foreign-claim lockout after
// rotation/compact). The pointer names the session that most recently
// fired a hook in this repo; the resolver consumes it ONLY to
// disambiguate that >=2-fresh-envelope case to the caller's own
// envelope. Evidence, not authority: absent/stale/malformed/non-matching
// pointer still refuses. NEVER newest-wins. No new managed files (the
// pointer is written by the already-shipped parse-input.sh); stateModel
// gains the pointer write path.
//
// Version 11: QG-HOOKS-EXTRACT-001. Adds four advisory PostToolUse hooks
// that form the edit-time quality plane, the boundary analogue of the
// load-bearing quality-gates signals (packages/quality-gates/*.mjs):
//   - god-object-check.sh (lineage 28): SLOC-threshold advisory; warns
//     when a written/edited file exceeds CAWS_GOD_OBJECT_LOC (default
//     2000). Always exit 0. Edit-time analogue of the `god_object` gate.
//   - shortcut-language-check.sh (lineage 29): flags TODO/FIXME/XXX/
//     placeholder/"not implemented" language in NON-test committed-bound
//     source. The only one of the four that can block — escalates via the
//     existing guard_enforce_progressive_strikes (strike 1 warn, 2 ask,
//     3 block). Edit-time analogue of the `todo_detection` gate.
//   - duplicate-export-check.sh (lineage 30): on Write of a new JS/TS
//     file, flags an exported symbol whose name already exists elsewhere
//     in the enclosing package src tree (exact match, generic-name
//     allowlist). Advisory; bounded ripgrep/grep, never node_modules.
//   - loc-delta-check.sh (lineage 31): on Edit, warns when the
//     new_string vs old_string newline delta exceeds
//     CAWS_LOC_DELTA_WARN_THRESHOLD (default 300). Always advisory.
//
// These hooks reimplement detection INTENT in self-contained bash; they
// do NOT import, require, or shell out to any packages/quality-gates
// module, and they do NOT alter `caws gates run` (the governed policy-gate
// runner). This is option-C doctrine: the edit-time advisory plane is an
// installed hook-pack utility the repo tunes via env; the gates command
// remains a separate governed surface. Dispatcher update: caws_dispatch/
// post_tool_use.sh registers the four new handlers in its HANDLERS array
// (advisory-self-filtering; ordering preserved). No stateModel changes
// (the hooks read only the file being checked + the existing guard-strikes
// state path under .claude/, already declared).
export const CLAUDE_CODE_PACK_VERSION = 13;

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
      // CAWS-SESSION-LOG-RELOCATE-001: per-session state moved out of the
      // user-owned repo-root tmp/ into .caws/sessions/ (gitignored,
      // provenance-adjacent). Turn logs + .session-envelope.json live under
      // .caws/sessions/<session-id>/; the per-repo caller-session pointer
      // lives at .caws/sessions/.caller-session.json.
      '.caws/sessions/<session-id>/',
      '.caws/sessions/.caller-session.json',
    ],
  },
  lineageRefs: [1, 4, 6, 8, 11, 12, 13, 16, 17, 19, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31],

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
    {
      // WORKTREE-ISOLATION-HARDENING-001 (Fix 3): Bash mutation target guard.
      // worktree-write-guard only sees Write/Edit; Bash mutations (echo >>,
      // sed -i, rm, mv, git restore, ...) into worktree-owned payload were an
      // unguarded side door. This hook self-filters to Bash, extracts targets
      // for a narrow mutation-form set, and routes each through the shared
      // lib/worktree-claim-oracle.cjs — same owner-vs-session answer as a
      // Write/Edit of the same path. Wired into caws_dispatch/pre_tool_use.sh
      // after worktree-write-guard.
      destPath: '.claude/hooks/bash-write-guard.sh',
      sourcePath: 'bash-write-guard.sh',
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
    {
      // Shared v10/v11 dual-shape registry/state readers. Sourced by
      // worktree-guard, worktree-write-guard, scope-guard,
      // session-caws-status, and stop-worktree-check so the registry-shape
      // contract is a single point of change (promoted from Sterling per
      // HOOK-PACK-DIVERGENCE-RECONCILE-001; originally
      // CAWS-1117-V11-HOOK-DRIFT-MERGE-01 + CAWS-1117-ENTRY-BY-NAME-V11-SHAPE-01).
      destPath: '.claude/hooks/lib/caws-state.sh',
      sourcePath: 'lib/caws-state.sh',
      executable: false,
      managed: true,
    },
    {
      // Canonical Claude Code hook-output envelope emitters (emit_block /
      // emit_ask / emit_additional_context). Sourced by block-dangerous,
      // guard-strikes, validate-spec, and the code-quality hooks so the
      // three envelope shapes live in one place instead of being
      // copy-pasted under 5+ names across 12 hooks
      // (HOOK-LIB-CONSOLIDATION-001 T3a).
      destPath: '.claude/hooks/lib/emit.sh',
      sourcePath: 'lib/emit.sh',
      executable: false,
      managed: true,
    },
    {
      // Shared guard-message legibility helpers (guard_identity /
      // guard_amend_scope_hint / guard_not_harness_note). Sourced by
      // scope-guard, worktree-write-guard, and block-dangerous so every guard
      // refusal self-identifies ("CAWS scope-guard" / "CAWS
      // worktree-write-guard" / "CAWS command-safety") and prints a literal
      // copy-pasteable remediation, instead of reading as a generic harness
      // prompt that a first-timer dismisses (HOOK-GUARD-LEGIBILITY-001).
      destPath: '.claude/hooks/lib/guard-message.sh',
      sourcePath: 'lib/guard-message.sh',
      executable: false,
      managed: true,
    },
    {
      // The shared worktree-ownership oracle (WORKTREE-ISOLATION-HARDENING-001).
      // A standalone node helper (NOT an inline node -e heredoc — that form
      // corrupted hooks twice via JS-comment backtick/double-quote inside a
      // bash double-quoted string) shelled out to by BOTH worktree-write-guard
      // (Write/Edit) and bash-write-guard (Bash mutation target), so a write and
      // a Bash mutation of the same .caws/worktrees/<name>/<rest> payload path
      // get the SAME owner-vs-session answer. js-yaml is required lazily so the
      // foreign-worktree-payload block works even where js-yaml is unresolvable
      // in an installed .claude/hooks/lib/. Plain JS (no TS build artifact
      // dependency); the CLI-side admitsOwner/resolveSessionCandidates stays in
      // agreement via golden fixtures, not code sharing.
      // .cjs (not .js): the oracle is CommonJS (require()); a .js extension is
      // treated as ESM in a consumer repo whose package.json declares
      // "type":"module", crashing the spawn. .cjs forces CommonJS regardless of
      // the host package type (FIX-HOOKPACK-CONSUMER-INSTALL-001 D-cjs).
      destPath: '.claude/hooks/lib/worktree-claim-oracle.cjs',
      sourcePath: 'lib/worktree-claim-oracle.cjs',
      executable: false,
      managed: true,
    },

    // -- Dispatch entrypoints invoked from .claude/settings.json --
    // The caws_dispatch/ directory name is the namespace: a settings.json
    // hook entry whose command path contains "/.claude/hooks/caws_dispatch/"
    // is unambiguously CAWS-owned, which is how the idempotent settings.json
    // merge identifies its own entries without colliding with a user's
    // same-named hooks.
    {
      destPath: '.claude/hooks/caws_dispatch/pre_tool_use.sh',
      sourcePath: 'caws_dispatch/pre_tool_use.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.claude/hooks/caws_dispatch/post_tool_use.sh',
      sourcePath: 'caws_dispatch/post_tool_use.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.claude/hooks/caws_dispatch/session_start.sh',
      sourcePath: 'caws_dispatch/session_start.sh',
      executable: true,
      managed: true,
    },
    {
      destPath: '.claude/hooks/caws_dispatch/stop.sh',
      sourcePath: 'caws_dispatch/stop.sh',
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

    // -- CAWS-HOOK-PACK-PROMOTE-001 (v7): hooks promoted from Sterling --
    // See docs/reports/sterling_hook_port_audit_001.md and
    // docs/failure-lineage.md entries 22-25 for the governance gaps
    // each closes.
    {
      // PreToolUse: blocks tool calls when the working directory has
      // been deleted (worktree-destroyed-while-inside class).
      destPath: '.claude/hooks/cwd-guard.sh',
      sourcePath: 'cwd-guard.sh',
      executable: true,
      managed: true,
    },
    {
      // PreToolUse: blocks agent-side Write/Edit on hook scripts and
      // strike-state files. Structural enforcement of the doctrine
      // that hooks may not be edited by an agent's local judgment.
      destPath: '.claude/hooks/protected-paths.sh',
      sourcePath: 'protected-paths.sh',
      executable: true,
      managed: true,
    },
    {
      // PreToolUse: advisory-only warning on secret-bearing file paths.
      destPath: '.claude/hooks/scan-secrets.sh',
      sourcePath: 'scan-secrets.sh',
      executable: true,
      managed: true,
    },
    {
      // PostToolUse: "no shadow files" doctrine enforcement.
      // Advisory-only. Genericized: no v10 CLI references.
      destPath: '.claude/hooks/naming-check.sh',
      sourcePath: 'naming-check.sh',
      executable: true,
      managed: true,
    },

    // -- QG-HOOKS-EXTRACT-001 (v11): edit-time advisory quality plane --
    // Four PostToolUse hooks that reimplement the load-bearing
    // quality-gates detection INTENT (god_object, todo_detection,
    // functional-duplication name collision, LOC-delta) in self-contained
    // bash. They do NOT import or invoke any packages/quality-gates module
    // and do NOT change `caws gates run` (option-C doctrine). Three are
    // always-advisory (exit 0); shortcut-language-check escalates via
    // guard-strikes on the third session strike. See failure-lineage
    // entries 28-31.
    {
      // PostToolUse Write/Edit: SLOC-threshold god-object advisory.
      destPath: '.claude/hooks/god-object-check.sh',
      sourcePath: 'god-object-check.sh',
      executable: true,
      managed: true,
    },
    {
      // PostToolUse Write/Edit: shortcut/placeholder-language progressive
      // check (the only blocking one — strike 3 via guard-strikes).
      destPath: '.claude/hooks/shortcut-language-check.sh',
      sourcePath: 'shortcut-language-check.sh',
      executable: true,
      managed: true,
    },
    {
      // PostToolUse Write: duplicate-export advisory (exact symbol-name
      // collision in the enclosing package src tree).
      destPath: '.claude/hooks/duplicate-export-check.sh',
      sourcePath: 'duplicate-export-check.sh',
      executable: true,
      managed: true,
    },
    {
      // PostToolUse Edit: LOC-delta advisory (new_string vs old_string
      // newline delta over CAWS_LOC_DELTA_WARN_THRESHOLD).
      destPath: '.claude/hooks/loc-delta-check.sh',
      sourcePath: 'loc-delta-check.sh',
      executable: true,
      managed: true,
    },
    {
      // OPT-IN PostToolUse advisory: runs `caws gates run --spec <id>`
      // after source edits. Commented out in the default post_tool_use
      // HANDLERS array; ship the v11-correct source so consumers can
      // enable it. Promoted from Sterling per
      // HOOK-PACK-DIVERGENCE-RECONCILE-001.
      destPath: '.claude/hooks/quality-check.sh',
      sourcePath: 'quality-check.sh',
      executable: true,
      managed: true,
    },
    {
      // OPT-IN PostToolUse advisory: validates .caws/specs/*.yaml on
      // edit (YAML syntax + terminal-status AC coverage). Commented out
      // by default. Promoted from Sterling (v11-correct: does not call
      // the removed `caws validate`).
      destPath: '.claude/hooks/validate-spec.sh',
      sourcePath: 'validate-spec.sh',
      executable: true,
      managed: true,
    },
    {
      // OPT-IN Stop handler: reminds about active worktrees at session
      // end. Commented out in the default stop HANDLERS array. Promoted
      // from Sterling (dual-shape entriesOf + 'fresh' detection). Sources
      // lib/caws-state.sh.
      destPath: '.claude/hooks/stop-worktree-check.sh',
      sourcePath: 'stop-worktree-check.sh',
      executable: true,
      managed: true,
    },
    {
      // PreToolUse (LAST): rewrites caws worktree merge|destroy
      // bash commands for CWD safety + output suppression.
      // MUST be last in caws_dispatch/pre_tool_use.sh because it emits
      // updatedInput which replaces any prior interceptor's
      // updatedInput. Companion to cwd-guard.sh (lineage entry 22)
      // for the worktree-destroyed-while-inside class. Lineage 26.
      destPath: '.claude/hooks/quiet-merge.sh',
      sourcePath: 'quiet-merge.sh',
      executable: true,
      managed: true,
    },
    {
      // PostToolUse (ExitPlanMode-filtered): snapshots the session
      // transcript co-located with the plan file at the moment
      // ExitPlanMode fires. Paired with plan-transcript-finalize.sh
      // (Stop). Lineage 27.
      destPath: '.claude/hooks/plan-transcript-snapshot.sh',
      sourcePath: 'plan-transcript-snapshot.sh',
      executable: true,
      managed: true,
    },
    {
      // Stop: drains $HOME/.claude/.pending-plan-snapshots and
      // overwrites each pending snapshot with the turn-end
      // transcript. Companion to plan-transcript-snapshot.sh.
      // Already referenced in caws_dispatch/stop.sh; this entry makes
      // the pack manifest install it. Lineage 27.
      destPath: '.claude/hooks/plan-transcript-finalize.sh',
      sourcePath: 'plan-transcript-finalize.sh',
      executable: true,
      managed: true,
    },

    // -- Doctrine landing for hook editors --
    {
      destPath: '.claude/hooks/CLAUDE.md',
      sourcePath: 'CLAUDE.md',
      executable: false,
      managed: true,
    },
    // -- Human-facing inventory (CAWS-HOOKPACK-SHIP-README-001). Companion to
    // CLAUDE.md: CLAUDE.md is the agent-doctrine surface; README.md is the
    // at-a-glance hook map. Shipping it authoritatively prevents consumers
    // from reverse-engineering a drift-prone inventory by hand. --
    {
      destPath: '.claude/hooks/README.md',
      sourcePath: 'README.md',
      executable: false,
      managed: true,
    },
  ],
};
