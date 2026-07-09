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
// that implement the edit-time quality plane:
//   - god-object-check.sh (lineage 28): SLOC-threshold advisory; warns
//     when a written/edited file exceeds CAWS_GOD_OBJECT_LOC (default
//     2000). Always exit 0. Edit-time analogue of the `god_object` gate.
//   - shortcut-language-check.sh (lineage 29): flags shortcut-language
//     markers in NON-test committed-bound source. The only one of the four
//     that can block — escalates via guard_enforce_progressive_strikes
//     (strike 1 warn, 2 ask, 3 block). Edit-time analogue of the
//     shortcut-detection gate.
//   - duplicate-export-check.sh (lineage 30): on Write of a new JS/TS
//     file, flags an exported symbol whose name already exists elsewhere
//     in the enclosing package src tree (exact match, generic-name
//     allowlist). Advisory; bounded ripgrep/grep, never node_modules.
//   - loc-delta-check.sh (lineage 31): on Edit, warns when the
//     new_string vs old_string newline delta exceeds
//     CAWS_LOC_DELTA_WARN_THRESHOLD (default 300). Always advisory.
//
// These hooks implement the edit-time quality checks in self-contained bash.
// They do NOT import, require, or shell out to an external quality package, and
// they do NOT alter `caws gates run` (the governed policy/evidence runner).
// The edit-time quality plane is an installed hook-pack utility the repo tunes
// via env; the gates command remains a separate governed surface. Dispatcher update: caws_dispatch/
// post_tool_use.sh registers the four new handlers in its HANDLERS array
// (advisory-self-filtering; ordering preserved). No stateModel changes
// (the hooks read only the file being checked + the existing guard-strikes
// state path under .claude/, already declared).
// Version 18: CAWS-HOOK-PACK-SHARED-CORE-001. All shared hook logic
// (guards, dispatchers, libs) has been moved to the `shared` pack
// (manifest-shared.ts) which installs under .caws/hooks/. This vendor
// adapter now installs ONLY the claude-code-specific surface files:
// CLAUDE.md (agent doctrine) and README.md (hook inventory). The
// settings.json wiring is updated to route through the shared dispatcher
// at .caws/hooks/dispatch/<event>.sh with CAWS_AGENT_SURFACE=claude-code
// injected.
// Version 20: CAWS-HOOK-PACK-MANAGED-HEADER-GROWTH-DOCTRINE-001. The
// claude-code surface docs (CLAUDE.md, README.md) drop the
// "do_not_edit_directly: update via caws init" header directive in favor of the
// `edit_stance:` growth framing (repo owns/grows the hook; edits preserved;
// only editing-to-bypass is out of bounds). Bump re-propagates the reframed
// header to consumers on next caws init.
export const CLAUDE_CODE_PACK_VERSION = 21;

export const CLAUDE_CODE_PACK: HookPackV1 = {
  id: 'claude-code',
  targetSurface: 'claude-code',
  packVersion: CLAUDE_CODE_PACK_VERSION,
  cawsMinMajor: 11,
  summary:
    'Claude Code vendor adapter: surface doc and README. ' +
    'Shared hook logic is in the `shared` pack under .caws/hooks/.',
  activation: 'restart_required',
  lifecycleEvents: ['pre_bash', 'pre_write', 'pre_edit', 'session_start', 'stop'],
  stateModel: {
    // Reads/writes are now the union of what the shared core (installed
    // alongside) and the settings.json wiring touch. Kept here as
    // documentation of the full surface. Runtime reads/writes for the
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
      '.claude/logs/audit.log',
      '.claude/logs/session-*.log',
      '.claude/hooks/state/danger-latch-*.json',
      '.claude/hooks/state/guard-strikes-*.json',
      '.caws/leases/',
      '.caws/sessions/<session-id>/',
      '.caws/sessions/.caller-session.json',
    ],
  },
  lineageRefs: [1, 4, 6, 8, 11, 12, 13, 16, 17, 19, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31],

  // Vendor-adapter files only. sourcePath is relative to the pack root
  // (packages/caws-cli/templates/hook-packs/claude-code/).
  // All shared hook files are installed by the `shared` pack; they are
  // NOT duplicated here.
  //
  // NOTE: .claude/settings.json is NOT a managed pack file. It carries
  // user-authored permissions/env blocks that the pack must not clobber.
  // Install merges the four CAWS caws_dispatch entries into settings.json
  // non-destructively and always writes a settings.json.example reference.
  installedFiles: [
    // -- Doctrine landing for hook editors --
    {
      destPath: '.claude/hooks/CLAUDE.md',
      sourcePath: 'CLAUDE.md',
      executable: false,
      managed: true,
    },
    // -- Human-facing hook inventory --
    {
      destPath: '.claude/hooks/README.md',
      sourcePath: 'README.md',
      executable: false,
      managed: true,
    },
  ],
};
