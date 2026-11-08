---
doc_id: command-reference
authority: reference
status: active
title: CAWS CLI command reference
owner: vNext rewrite team
updated: 2026-09-07
audience: consumer
generated: true
source: packages/caws-cli/src/shell/command-metadata.ts
---

<!--
  GENERATED FILE — do not edit by hand.
  Source: packages/caws-cli/src/shell/command-metadata.ts (COMMAND_SURFACE_METADATA).
  Regenerate: node packages/caws-cli/scripts/generate-command-reference.mjs
  Package documentation checks fail if this
  file drifts from the metadata.
-->

# CAWS CLI Command Reference

Every `caws` command group and its subcommands, generated from the same typed metadata the CLI uses to build `--help`. Run `caws <group> --help` for the live form.

## Groups

- [`caws init`](#caws-init) — Project initialization and global runtime setup. Use adapters for machine installation and native configuration, migrate for legacy governance conversion, and diff/port for legacy pack maintenance.
- [`caws doctor`](#caws-doctor) — Run drift detection against the current .caws/ state
- [`caws status`](#caws-status) — Read-only dashboard: project, current context, claim, and doctor findings
- [`caws tui`](#caws-tui) — Read-only full-screen terminal dashboard over the same panel data as status (project/binding, specs, worktrees, agents, doctor, gates); refreshes live, q/Ctrl-C exits
- [`caws scope`](#caws-scope) — Evaluate file paths against the bound spec scope
- [`caws hooks`](#caws-hooks) — Inspect and amend the effective hook chain and the repo-local hook policy
- [`caws claim`](#caws-claim) — Surface ownership of the current worktree; with --takeover, acquire ownership from a foreign session (writes prior_owners audit). With --paths, declare working-tree ownership metadata on the current session's lease (SESSION-OWNERSHIP-METADATA-001). With --spec <id> / --release, acquire/release a BRIDGE binding — session↔spec authority for non-worktree contexts (AUTH-BINDING-BRIDGE-001).
- [`caws gates`](#caws-gates) — Inspect and run quality gates against the current changes (list/explain/run; policy-driven)
- [`caws evidence`](#caws-evidence) — Record, list, show, and describe typed evidence events in .caws/events.jsonl (record/list/show/schema)
- [`caws events`](#caws-events) — Read and maintain .caws/events.jsonl (list/show/rotate/migrate/verify-archive)
- [`caws waiver`](#caws-waiver) — Manage CAWS waivers — GATE-RUN-ONLY, legacy pre-v11 surface. A waiver suppresses matching violations in `caws gates run` and NEVER lifts a hook guard; hook blocks are governed by reprieves (`caws reprieve grant`), which is the system hooks actually consult.
- [`caws reprieve`](#caws-reprieve) — Session-scoped guard reprieve: skip a PreToolUse guard for ONE session until a stated expiry. Use when a session legitimately needs to do what a guard blocks (e.g. editing a hook script) WITHOUT disabling it for every other session. Distinct from `caws waiver`: a reprieve skips a HOOK guard at dispatch time (operational cache, session-scoped, expiring); a waiver bypasses a GATE at policy-run time (governance state, kernel-adjudicated). Replaces the anti-pattern of commenting a guard out of the dispatcher HANDLERS array. A reprieve covers hook guards only and does not change `caws worktree merge` readiness: a lane-provenance merge refusal is remedied with `caws specs amend-scope <spec> --add-support <path>`.
- [`caws specs`](#caws-specs) — Manage CAWS spec lifecycle (create/list/show/recover/restore/commit/retire-draft/prune-drafts/activate/deactivate/amend/amend-scope/evidence/verify-acs/close/reopen/archive/prune-archive/migrate/validate/relocate)
- [`caws worktree`](#caws-worktree) — Manage CAWS worktrees (create/adopt/list/ensure/bind/destroy/untrack/merge/review/migrate-registry/repair-sparse/repair/prune/cleanup-plan). Worktrees are git worktrees bound to active specs. Compatibility: `caws worktree --prune ...` is normalized to `caws worktree prune ...` before parsing.
- [`caws agents`](#caws-agents) — Agent liveness substrate: register/heartbeat/stop/list/show/work-state/prune. Operational cache only — NEVER authority. CAWS-native JSON; never Claude Code hook envelope.
- [`caws handoff`](#caws-handoff) — Portable handoff briefs (HANDOFF-EXPORT-IMPORT-001): `export` builds the metadata-only brief for a session (self by default; `--session <id>` for a peer, consent-gated with the operator recorded as the exporting authority) and writes it under .caws/handoffs/ — never user tmp/, never package-shipped. `import` reads a brief, surfaces its context, and appends exactly one manual_pickup handoff event. Briefs carry ONLY structured metadata (identity, work_state, claimed_paths, prior handoff events); file contents and turn transcripts are never read or exported, and secret-bearing paths are redacted to name-only.
- [`caws message`](#caws-message) — Inter-agent message channel (AGENT-MESSAGE-CHANNEL-001): send/reply/poll/settle/inbox/history/status/prune directed messages between running sessions, addressed by session id (or a wt:/spec: alias), over .caws/messages.jsonl. Separate from the events audit chain; not authority — a message body is an unverified claim.
- [`caws session`](#caws-session) — Session-log retention and manual handoff records. `prune` (SESSION-LOG-RETENTION-SCOPE-001) is dry-run-default retention for stale per-session turn history under .caws/sessions/ (operational cache). `pickup` (MULTI-AGENT-HANDOFF-EVENT-001) records an explicit operator handoff — "I am continuing session X's work" — as a manual_pickup event in the hash-chained audit log. The session LIFECYCLE (start/checkpoint/end) remains deferred.
- [`caws working-tree`](#caws-working-tree) — Working-tree overlap advisory surface (WORKING-TREE-PROVENANCE-GUARD-001): `check` reports whether another active session's claimed/modified paths overlap the current dirty tree (read-only, non-mutating); `ack` records the operator's explicit per-session, per-path acknowledgement that cleans up that overlap. Never authority — neither command changes scope, claim, ownership, or lifecycle state.
- [`caws goal`](#caws-goal) — Hold this session's stop to a spec's acceptance criteria (CAWS-GOAL-AC-STOP-GATE-01). `set` binds the session to a spec; the Stop handler then re-derives that spec's acceptance with `caws specs verify-acs --json` and refuses the stop while any criterion is unproven, so the session keeps working instead of stopping on an unproven claim. `show` reports the current binding and the gate's consecutive-block count, read-only. `clear` releases the session from its goal, which does NOT mean the criteria were met. Never authority: the spec owns the bar, `caws specs evidence` remains the only writer of acceptance truth, and this surface can neither mark a criterion passed nor change scope or lifecycle state. Opt-in — with no goal set the stop chain is unchanged.

## `caws init`

Project initialization and global runtime setup. Use adapters for machine installation and native configuration, migrate for legacy governance conversion, and diff/port for legacy pack maintenance.

Without a subcommand: Initialize project-owned .caws governance and managed ignore rules. Configured harnesses inherit the shared runtime. Unconfigured harnesses retain legacy pack installation compatibility. Example: caws init --agent-surface codex --plan

**Options:**

- `--plan` — Preview canonical state, managed ignore rules and effective harness configuration without writing anything.
- `--dry-run` — Compatibility alias for --plan; previews init changes without writing anything.
- `--json` — Emit the read-only init plan as JSON with --plan or --dry-run.
- `--data` — Show structured data block on diagnostics
- `--agent-surface <name>` — Select the native harness; a configured system surface inherits machine hooks without project copies: claude-code | codex | opencode | zcode | kimi-code | qwen-code | dsh | cursor | windsurf | none
- `--overwrite [paths...]` — Preview replacing drifted managed files with the shipped template (all when bare, or name paths). Withholds the write and prints a diff; --force applies it and discards local edits. To keep local edits while taking upstream, use caws init port.
- `--force` — Apply the --overwrite replacements, discarding local edits at those paths. Invalid without --overwrite; never overrides governance migration.
- `--adopt` — Retain the local files and stop tracking pack drift for those paths. This ends drift reporting rather than reconciling it; caws init port lands reconciled content and resumes tracking.
- `--wire-user-config` — Legacy kimi-code only: append reviewed hook registration to user config.toml.

### `caws init adapters`

Machine runtime operations: install, configure, migrate, rollback and legacy adopt. With no operation, install is the compatibility default (applies unless --plan).

Without a subcommand: Install or update the shared runtime under CAWS_HOME (default ~/.caws). Applies by default; --plan previews. Does not upgrade the CLI package or register a native harness. Example: caws init adapters install --plan --json

**Options:**

- `--plan` — Read-only preview; do not apply changes.
- `--dry-run` — Compatibility alias for --plan; never writes.
- `--json` — Emit the result or preview as JSON.
- `--data` — Show structured data block on diagnostics

#### `caws init adapters install`

Install or update the shared runtime under CAWS_HOME (default ~/.caws). Applies by default; --plan previews. Does not upgrade the CLI package or register a native harness. Example: caws init adapters install --plan --json

**Options:**

- `--plan` — Read-only preview; do not apply changes.
- `--dry-run` — Compatibility alias for --plan; never writes.
- `--json` — Emit the result or preview as JSON.
- `--data` — Show structured data block on diagnostics
- `--native-image <file>` — Install an explicit local pinned native image and complete production prefix. Accepts reviewed native-image-input.v1 descriptors or receipt-selected native-image-input.v2 descriptors. Keeps existing harness registration; configure --entry native opts in separately.

#### `caws init adapters configure`

Register the installed runtime in harness user configuration. Applies by default; --plan previews. Requires --agent-surface. Restart and verify native trust and execution separately. Example: caws init adapters configure --agent-surface codex --plan

**Options:**

- `--agent-surface <name>` — Select the native harness; a configured system surface inherits machine hooks without project copies: claude-code | codex | opencode | zcode | kimi-code | qwen-code | dsh | cursor | windsurf | none
- `--plan` — Read-only preview; do not apply changes.
- `--dry-run` — Compatibility alias for --plan; never writes.
- `--json` — Emit the result or preview as JSON.
- `--data` — Show structured data block on diagnostics
- `--entry <native|legacy>` — Explicitly select the installed entry. Native requires a verified native image. Omission preserves an existing explicit selection and defaults to legacy for a fresh registration.
- `--native-config-target <path>` — Explicit resolved target of a user-managed native-config symlink inside the user home. Preserve the symlink and update only that target.

#### `caws init adapters migrate`

Retire legacy project native registrations once, after system configuration exists. Applies by default; --plan previews. Requires --agent-surface. Preserves unrelated hooks and exact backups; never migrates governance. Example: caws init adapters migrate --agent-surface codex --plan --json

**Options:**

- `--agent-surface <name>` — Select the native harness; a configured system surface inherits machine hooks without project copies: claude-code | codex | opencode | zcode | kimi-code | qwen-code | dsh | cursor | windsurf | none
- `--from <file>` — Read a reviewed surface-policy JSON file: disabled, extensions, handlers, libraries. Single project only; preserves classified custom behavior.
- `--plan` — Read-only preview; do not apply changes.
- `--dry-run` — Compatibility alias for --plan; never writes.
- `--json` — Emit the result or preview as JSON.
- `--data` — Show structured data block on diagnostics
- `--projects-root <path>` — Process direct Git project children independently. Incompatible with --from; projects needing review are reported without undoing successful migrations.

#### `caws init adapters rollback`

Restore the previous verified shared runtime through an atomic pointer swap. Applies by default; --plan previews. Does not roll back the CLI package, project policy, or native registration.

**Options:**

- `--plan` — Read-only preview; do not apply changes.
- `--dry-run` — Compatibility alias for --plan; never writes.
- `--json` — Emit the result or preview as JSON.
- `--data` — Show structured data block on diagnostics

#### `caws init adapters adopt`

Legacy adapter-only compatibility operation. Applies by default; --plan previews. Requires --agent-surface. Does not globalize stock hooks or renderers; prefer configure followed by migrate.

**Options:**

- `--agent-surface <name>` — Select the native harness; a configured system surface inherits machine hooks without project copies: claude-code | codex | opencode | zcode | kimi-code | qwen-code | dsh | cursor | windsurf | none
- `--from <file>` — Read a reviewed surface-policy JSON file: disabled, extensions, handlers, libraries. Single project only; preserves classified custom behavior.
- `--plan` — Read-only preview; do not apply changes.
- `--dry-run` — Compatibility alias for --plan; never writes.
- `--json` — Emit the result or preview as JSON.
- `--data` — Show structured data block on diagnostics

### `caws init migrate`

Preview reviewed legacy governance conversion without writes. Example: caws init migrate --from reviewed-governance.json. Use migrate apply to execute.

Without a subcommand: Preview reviewed legacy governance conversion without writes. Example: caws init migrate --from reviewed-governance.json. Use migrate apply to execute.

**Options:**

- `--from <file>` — Read a reviewed governance-conversion JSON plan: version, reason, requirementNotes, changes. Original source hashes are verified before application.
- `--plan` — Read-only preview; do not apply changes.
- `--dry-run` — Compatibility alias for --plan; never writes.
- `--json` — Emit the result or preview as JSON.
- `--data` — Show structured data block on diagnostics

#### `caws init migrate apply`

Apply a reviewed legacy-governance conversion plan after preview. Original hashes must still match. Archives originals before installing validated draft governance. Example: caws init migrate apply --from reviewed-governance.json

**Options:**

- `--from <file>` — Read a reviewed governance-conversion JSON plan: version, reason, requirementNotes, changes. Original source hashes are verified before application.
- `--json` — Emit the result or preview as JSON.
- `--data` — Show structured data block on diagnostics

### `caws init diff`

Read-only drift comparison for the installed project pack (the shared pack, plus the detected surface pack). Machine runtime snapshots update separately via adapters install.

**Options:**

- `--agent-surface <name>` — Select the native harness; a configured system surface inherits machine hooks without project copies: claude-code | codex | opencode | zcode | kimi-code | qwen-code | dsh | cursor | windsurf | none
- `--data` — Show structured data block on diagnostics
- `--three-way <path>` — Compare installed bytes with their pristine baseline and current template, separating local growth from upstream changes.

### `caws init port <path>`

Land reviewed content at one managed pack path through the installer: it validates, version-stamps, records a new pristine baseline and audit-commits, so drift tracking resumes. This is the non-destructive discharge for a drifted hook — unlike --overwrite --force it keeps what you reconciled. Requires --from; does not edit immutable machine runtime snapshots.

**Argument:** `path` (required) — Managed pack destination path (list them with caws init diff).

**Options:**

- `--agent-surface <name>` — Select the native harness; a configured system surface inherits machine hooks without project copies: claude-code | codex | opencode | zcode | kimi-code | qwen-code | dsh | cursor | windsurf | none
- `--data` — Show structured data block on diagnostics
- `--from <file>` — Reviewed replacement content in a staging file outside the protected hook tree.

## `caws doctor`

Run drift detection against the current .caws/ state

**Options:**

- `--data` — Show structured data block on findings/diagnostics
- `--repair-plan` — Emit a read-only repair plan derived from doctor findings
- `--json` — Emit the repair plan as JSON with --repair-plan

## `caws status`

Read-only dashboard: project, current context, claim, and doctor findings

**Options:**

- `--data` — Show structured data block on rendered diagnostics
- `--specs` — Render only the focused specs panel
- `--worktrees` — Render only the focused worktrees panel
- `--agents` — Render only the focused agents panel
- `--doctor` — Render only the focused doctor panel
- `--short` — Render a compact read-only status summary
- `--json` — Emit selected status panels as JSON

## `caws tui`

Read-only full-screen terminal dashboard over the same panel data as status (project/binding, specs, worktrees, agents, doctor, gates); refreshes live, q/Ctrl-C exits

**Options:**

- `--once` — Render one frame to stdout and exit 0 (deterministic text, safe to pipe/diff)
- `--interval <ms>` — Refresh interval for the live session in milliseconds (default 3000, clamped 250-60000)

## `caws scope`

Evaluate file paths against the bound spec scope

### `caws scope show <path>`

Explain the scope decision for <path>; always exits 0

**Argument:** `path` (required) — File path to evaluate

**Options:**

- `--data` — Show structured data block
- `--spec <id>` — Evaluate against a named spec as read-only context instead of current worktree authority
- `--json` — Emit the scope decision as a single-line stable JSON contract (for hooks/tooling)

### `caws scope check <path>`

Enforce the scope decision for <path>; exits 0 on admit, 1 otherwise. --json emits the same decision/remediation contract as scope show while preserving check exit codes.

**Argument:** `path` (required) — File path to enforce

**Options:**

- `--data` — Show structured data block
- `--spec <id>` — Evaluate against a named spec as read-only context instead of current worktree authority
- `--json` — Emit the scope decision and remediation guidance as a single-line JSON contract

### `caws scope plan`

Evaluate multiple paths in one read-only run and group remediation commands. Always exits 0 after a successful plan, even when planned decisions include refusals.

**Options:**

- `--path <path>` (repeatable, default: `[]`) — Path to evaluate; repeat for multiple paths
- `--paths-file <file>` — Read newline-delimited paths from a file. Blank lines and # comments are ignored.
- `--spec <id>` — Evaluate every path against a named spec as read-only context instead of current worktree authority
- `--json` — Emit per-path decisions, counts, and grouped remediation commands as JSON
- `--data` — Show structured data block on diagnostics

### `caws scope contention <path>`

Report which other active worktrees (same base branch) have a bound spec whose scope.in claims <path>; always exits 0

**Argument:** `path` (required) — File path to check for cross-worktree claims

**Options:**

- `--json` — Emit the contention result as a single-line stable JSON contract (for hooks/tooling)

## `caws hooks`

Inspect and amend the effective hook chain and the repo-local hook policy

### `caws hooks inspection-prefix`

Classify complete newline-separated literal inspection commands from stdin without execution or project authority. Fixed versioned response; exits 0 only for positive classification, 1 for unsupported syntax/roles, 2 for parse/runtime/budget failure. Trusted executable lookup and Git configuration are caller assumptions.

### `caws hooks mutation-view`

Project bounded shell tokens for the write guard without execution. Reads {command} JSON on stdin. Facts confer no write authority. Exits 0 for a valid projection (including unresolved issues), 2 for unavailable analysis.

**Options:**

- `--cwd <path>` — Actual absolute execution directory
- `--cwd-unresolved` — Retain unknown coordinates; cwd is only a syntax-traversal placeholder
- `--project <path>` — Absolute project root supplied by the guard
- `--shell <shell>` — Declared shell (supported: bash)
- `--json` — Emit tokens, interpreter provenance and unresolved issues

### `caws hooks analyze`

Analyze Bash command effects without executing the command. Reads a JSON request or native tool payload from stdin unless --command is supplied. Exits 0 for allow, 1 for deny and 2 for unresolved.

**Options:**

- `--command <command>` — Analyze these exact command bytes instead of stdin
- `--cwd <path>` — Override the request working directory
- `--worktree <path>` — Trusted worktree pin; overrides the payload worktree
- `--shell <shell>` — Override the declared shell (supported: bash)
- `--json` — Emit the stable decision, source-positioned reasons and trace

### `caws hooks list`

Show the effective handler chain per event, each row tagged with the tier that put it there (stock, repo-policy, machine-policy). Shells the launcher so what it prints is what executes. Always exits 0.

**Options:**

- `--event <event>` — Limit to one lifecycle event
- `--surface <surface>` — Resolve for a named agent surface (default: the current session surface)
- `--json` — Emit the resolved chain as a single-line JSON contract
- `--data` — Show structured data block on diagnostics

### `caws hooks validate`

Validate .caws/hooks/hook-policy.json against the schema and the repo policy floor. Exits 0 when valid OR absent (a repo that never opts in is not in error), 1 when the document is rejected.

**Options:**

- `--json` — Emit the validation result as JSON
- `--data` — Show structured data block on diagnostics

### `caws hooks compile`

Compile the per-event chain sidecars read by project-wired surfaces. Renders every chain before writing any, so a chain the dispatcher parser would refuse aborts the whole run. --check compares what is on disk against what would be compiled and WRITES NOTHING, exiting 1 when any event is stale.

**Options:**

- `--check` — Read-only staleness check: name every stale event and exit 1, or exit 0 when all agree. Writes nothing.
- `--event <event>` — Limit to one lifecycle event
- `--json` — Emit the per-event result as JSON
- `--data` — Show structured data block on diagnostics

### `caws hooks add <handler.sh>`

Splice a handler into one event chain from the repo policy. Additive: it removes nothing. Writes .caws/hooks/hook-policy.json; run `caws hooks compile` afterwards to reach project-wired surfaces.

**Argument:** `handler.sh` (required) — Handler entry to splice in

**Options:**

- `--event <event>` — Lifecycle event to splice into (required)
- `--before <handler.sh>` — Anchor to insert before; omit to append at the end of the chain
- `--path <rel>` — Repo-relative path the handler lives at, for a handler the pack does not ship
- `--reason <text>` — Why this repo extends the chain (required, >= 12 characters)
- `--surface <surface>` — Narrow the decision to one surface (default: `default`, which every surface layers over)
- `--json` — Emit the mutation result as JSON

### `caws hooks disable <handler.sh>`

Subtract a handler from one event chain. Enforcement-reducing and permanent across every clone, so --reason is mandatory and is recorded in the document. Handlers on the repo-policy floor are refused.

**Argument:** `handler.sh` (required) — Handler to subtract from the chain

**Options:**

- `--event <event>` — Lifecycle event to subtract from (required)
- `--reason <text>` — Why this guard does not run here (required, >= 12 characters)
- `--surface <surface>` — Narrow the decision to one surface
- `--json` — Emit the mutation result as JSON

### `caws hooks replace <handler.sh>`

Point a shipped handler at a repo-local file, recording the forked pack version and sha256 so doctor can report the drift. Enforcement-reducing: --reason and --approver are mandatory. Floor handlers are refused.

**Argument:** `handler.sh` (required) — Shipped handler to point at a repo-local file

**Options:**

- `--with <rel>` — Repo-relative path of the replacement (required)
- `--reason <text>` — Why the shipped handler does not fit (required, >= 12 characters)
- `--approver <id>` — Who accepted the fork (required)
- `--surface <surface>` — Narrow the decision to one surface
- `--json` — Emit the mutation result as JSON

### `caws hooks restore <handler.sh>`

Drop every repo-policy entry naming a handler, returning it to stock. Refuses when the document never named it rather than reporting success over an unchanged file.

**Argument:** `handler.sh` (required) — Handler to return to stock

**Options:**

- `--event <event>` — Scope the removal to one event; omit to sweep every event
- `--surface <surface>` — The surface to restore on
- `--json` — Emit the mutation result as JSON

### `caws hooks import`

Migrate this project's machine-state overrides into the committed repo policy, then clear the migrated machine keys. Surfaces with identical policy collapse to "default". Refuses, writing nothing, when machine state touches a floor handler the repo tier cannot express, or when the policy already declares the destination surface. Imported extensions record that machine state captured no justification rather than inventing one.

**Options:**

- `--from-machine` — Required. The only source this verb reads; naming it keeps the command honest if another is ever added.
- `--plan` — Inventory all machine groups and preview legacy import or an explicit --select candidate. Writes nothing.
- `--select <entry-id>` (repeatable) — With --plan, select a transferable surface:handler:name group (repeatable). Retained floor and dependency entries are never selected.
- `--apply-plan <path>` — Apply a reviewed JSON reconciliation plan after rechecking its input identities. Clears only selected machine keys.
- `--recover <path>` — Resume an interrupted selective import from its machine journal, refusing concurrent edits or a live owner.
- `--json` — Emit the import result as JSON

## `caws claim`

Surface ownership of the current worktree; with --takeover, acquire ownership from a foreign session (writes prior_owners audit). With --paths, declare working-tree ownership metadata on the current session's lease (SESSION-OWNERSHIP-METADATA-001). With --spec <id> / --release, acquire/release a BRIDGE binding — session↔spec authority for non-worktree contexts (AUTH-BINDING-BRIDGE-001).

**Options:**

- `--spec <id>` — AUTH-BINDING-BRIDGE-001: bridge the session to an ACTIVE spec (no worktree needed). Same scope.in admission surface as a worktree binding; refuses a spec held by a worktree (subordination) or another session (use --takeover). Pair with --release to name the binding to release.
- `--release` — AUTH-BINDING-BRIDGE-001: release bridge binding(s) owned by this session. With --spec <id>, releases exactly that binding; bare releases every owned binding.
- `--takeover` — Forcibly take ownership of a foreign-owned worktree. Required when the current owner is a different session.
- `--plan` — Preview claim ownership or takeover impact without mutating worktrees.json, leases, specs, events, or git state.
- `--json` — Emit the read-only claim plan or release-paths result as JSON.
- `--release-paths` — Clear the current session lease claimed_paths. Dry-run by default; pair with --apply to write the lease update.
- `--apply` — Apply --release-paths. Not used for normal claim or takeover, which keep their existing behavior.
- `--paths <path>` (repeatable) — Declare a path as claimed by the current session. Repeatable; order preserved; strings stored verbatim. Refused with no write if no lease exists for the current session.
- `--data` — Show structured data block on diagnostics

## `caws gates`

Inspect and run quality gates against the current changes (list/explain/run; policy-driven)

### `caws gates list`

List policy-declared gates, modes, thresholds, risk-tier budgets, and effective waiver ids. Read-only; does not run evaluators or append gate_evaluated events.

**Options:**

- `--spec <id>` — Optional spec id for spec-scoped waiver matching
- `--json` — Emit gate summaries, risk tiers, and waiver policy as JSON.
- `--data` — Show structured data block on diagnostics

### `caws gates explain <gate>`

Explain one policy gate: enabled state, mode, thresholds, waiver policy, and effective waiver ids. Read-only; validates the gate id against policy.gates.

**Argument:** `gate` (required) — Gate id to explain

**Options:**

- `--spec <id>` — Optional spec id for spec-scoped waiver matching
- `--json` — Emit the gate explanation as JSON.
- `--data` — Show structured data block on diagnostics

### `caws gates run [spec]`

Run CAWS-local policy evaluators and apply policy.gates[gate].mode to decide block/warn/skip (budget_limit is advisory: a risk-tier sizing goal that never blocks). Appends one gate_evaluated event per policy-declared gate. Exit codes: 0/1 on gate disposition; 2 on hard composition error (no policy / report-contract failure); 3 on evidence-integrity failure (a gate_evaluated event failed to append or validate).

**Argument:** `spec` (optional) — Spec id this gate run is about; alias for --spec <id>

**Options:**

- `--spec <id>` — Spec id this gate run is about; aliases positional <spec>
- `--base <ref>` — Evaluate committed changes from the merge base of this ref and HEAD, plus staged changes. Registered lanes use their recorded base. Without a base only a nonempty staged index is evaluated; unstaged and untracked work is excluded.
- `--context <ctx>` (default: `cli`) — Compatibility no-op retained from the former external quality package path
- `--data` — Show structured data block on diagnostics

## `caws evidence`

Record, list, show, and describe typed evidence events in .caws/events.jsonl (record/list/show/schema)

### `caws evidence record`

Append a typed evidence event (test|gate|human_decision). Payload examples: test {"command":"npm test","exit_code":0}; gate {"gate_id":"budget_limit","mode":"block","result":"pass","violations":[]}; human_decision {"decision":"approve-approach","decision_class":"approval"}. Use `caws evidence schema --type <kind>` for the full kernel schema. `--type ac` is REFUSED here: it would append an audit event without writing the spec evidence: block that the close gate reads — use `caws specs evidence <id> --ac <ac> --status <s>` instead (it dual-writes both).

**Options:**

- `--type <kind>` (**required**) — Evidence kind: test | gate | human_decision (ac is refused — use `caws specs evidence`)
- `--spec <id>` (**required**) — Spec id this evidence is about
- `--data <json>` (**required**) — Event payload as a JSON object string
- `--actor-kind <kind>` (default: `agent`) — Actor kind: agent | human | system | automation
- `--actor-id <id>` — Override actor id (defaults to session id)

### `caws evidence list`

Read typed evidence events for a spec from the hash-chained events log. Read-only; verifies the event chain before listing. Filters to test|gate|ac|human_decision evidence and can narrow by --type.

**Options:**

- `--spec <id>` (**required**) — Spec id whose evidence should be listed
- `--type <kind>` — Optional evidence kind filter: test | gate | ac | human_decision
- `--json` — Emit the evidence list as JSON.
- `--data` — Show structured data block on diagnostics

### `caws evidence show <event-ref>`

Show one event from the hash-chained events log by sequence number, exact event hash, or unique event-hash prefix. Read-only; verifies the event chain before resolving the reference.

**Argument:** `event-ref` (required) — Event sequence number, full event hash, or unique event-hash prefix.

**Options:**

- `--json` — Emit the matched event as JSON.
- `--data` — Show structured data block on diagnostics

### `caws evidence schema`

Print the kernel-derived payload schema and a copy-pasteable example command for one evidence kind. Read-only; does not read or write .caws/events.jsonl. For test|gate|human_decision the example is a `caws evidence record` call; for ac it is the `caws specs evidence` call that actually writes the closure authority.

**Options:**

- `--type <kind>` (**required**) — Evidence kind: test | gate | ac | human_decision
- `--json` — Emit schema, required fields, and example command as JSON.

## `caws events`

Read and maintain .caws/events.jsonl (list/show/rotate/migrate/verify-archive)

### `caws events list`

Summarize the current hash-chained events log. Read-only; verifies the chain, reports counts, latest event, recent events, and chain_rotated archive status.

**Options:**

- `--json` — Emit chain summary, rotations, and recent events as JSON.
- `--limit <n>` — Number of recent events to include (default: 20; use 0 for summary only)
- `--data` — Show structured data block on diagnostics

### `caws events show <event-ref>`

Show one event after verifying the current hash chain. The special ref latest-rotation shows the newest chain_rotated event with archive presence/digest/line-count status.

**Argument:** `event-ref` (required) — Event sequence number, full event hash, unique event-hash prefix, or latest-rotation.

**Options:**

- `--json` — Emit the matched event and rotation status as JSON.
- `--data` — Show structured data block on diagnostics

### `caws events migrate`

Migrate a v10-shape events.jsonl to a v11 chain via chain_rotated rotation. Dry-run by default; --apply executes.

**Options:**

- `--from <version>` (**required**) — Source schema version to migrate from: v10
- `--apply` — Execute the rotation (default is dry-run)
- `--reason <text>` — Operator reason recorded into the chain_rotated payload (required with --apply)
- `--actor-kind <kind>` (default: `agent`) — Actor kind: agent | human | system | automation
- `--actor-id <id>` — Override actor id (defaults to session id)
- `--allow-partial-upgrade` — Allow rotation when v10 specs are still present (off by default; see CAWS-MIGRATE-V10-SPECS-001)

### `caws events rotate`

Rotate events.jsonl: archive existing chain, start fresh chain with chain_rotated genesis event. Distinct from migrate — admits fully-unparseable logs. Supports --dry-run preview.

**Options:**

- `--reason <text>` (**required**) — Operator reason recorded into the chain_rotated payload
- `--dry-run` — Preview archive path, digest, stats, and genesis event without mutating events.jsonl.
- `--json` — Emit the dry-run plan as JSON.
- `--actor-kind <kind>` (default: `agent`) — Actor kind: agent | human | system | automation
- `--actor-id <id>` — Override actor id (defaults to session id)
- `--allow-clean` — Allow rotation of a clean v11 chain (friction flag)

### `caws events verify-archive`

Verify that the archive file named in the most recent chain_rotated event byte-matches its committed digest + line count.

## `caws waiver`

Manage CAWS waivers — GATE-RUN-ONLY, legacy pre-v11 surface. A waiver suppresses matching violations in `caws gates run` and NEVER lifts a hook guard; hook blocks are governed by reprieves (`caws reprieve grant`), which is the system hooks actually consult.

### `caws waiver create <id>`

Create a new active waiver. Gate-run-only: it suppresses matching violations in `caws gates run` and never lifts a hook guard (use `caws reprieve grant` for hook blocks). Validates against the kernel before writing; --dry-run validates shape and duplicate id state without creating a file.

**Argument:** `id` (required) — Waiver id to create

**Options:**

- `--title <title>` (**required**) — Short waiver title (≥5 chars)
- `--gate <gate>` (**required**, repeatable) — Gate id this waiver covers; repeat for multiple gates
- `--reason <reason>` (**required**) — Justification for the waiver
- `--approved-by <id>` (**required**) — Approver identity
- `--expires-at <iso>` (**required**) — Expiry as an ISO-8601 datetime with timezone
- `--spec <id>` — Optional spec id this waiver is scoped to (omit for project-wide)
- `--dry-run` — Validate the waiver and duplicate id state without writing .caws/waivers/
- `--json` — Emit create/dry-run result as JSON.
- `--data` — Show structured data block on diagnostics

### `caws waiver list`

List waivers (gate-run-only; hooks consult reprieves, not waivers). By default excludes revoked and expired records.

**Options:**

- `--include-revoked` — Include revoked waivers
- `--include-expired` — Include expired waivers
- `--data` — Show structured data block on diagnostics

### `caws waiver show <id>`

Show a waiver, including its derived effectiveness at now.

**Argument:** `id` (required) — Waiver id to show

**Options:**

- `--data` — Show structured data block on diagnostics

### `caws waiver revoke <id>`

Revoke a waiver (gate-run-only; hooks consult reprieves, not waivers). Writes a revocation record; refuses double-revoke.

**Argument:** `id` (required) — Waiver id to revoke

**Options:**

- `--revoked-by <id>` — Identity recorded in revocation.revoked_by
- `--reason <reason>` — Reason recorded in revocation.reason (recommended for audit)
- `--data` — Show structured data block on diagnostics

### `caws waiver prune`

Plan or apply cleanup for derived-expired active waivers. Dry-run by default; --apply revokes the selected waivers through the existing atomic revoke path.

**Options:**

- `--status <status>` (**required**) — Waiver effectiveness selector: expired
- `--apply` — Execute the prune plan by revoking selected waivers
- `--reason <reason>` — Required with --apply; recorded in each revocation.reason
- `--revoked-by <id>` — Required with --apply; recorded in each revocation.revoked_by
- `--json` — Emit the prune plan/result as JSON.
- `--data` — Show structured data block on diagnostics

## `caws reprieve`

Session-scoped guard reprieve: skip a PreToolUse guard for ONE session until a stated expiry. Use when a session legitimately needs to do what a guard blocks (e.g. editing a hook script) WITHOUT disabling it for every other session. Distinct from `caws waiver`: a reprieve skips a HOOK guard at dispatch time (operational cache, session-scoped, expiring); a waiver bypasses a GATE at policy-run time (governance state, kernel-adjudicated). Replaces the anti-pattern of commenting a guard out of the dispatcher HANDLERS array. A reprieve covers hook guards only and does not change `caws worktree merge` readiness: a lane-provenance merge refusal is remedied with `caws specs amend-scope <spec> --add-support <path>`.

### `caws reprieve grant`

Human-terminal operation: grant a reprieve under CAWS_HOME/state/sessions for the named handlers until expiry. Agents cannot grant their own reprieves. Use for a necessary action CAWS cannot adequately adjudicate. Before asking the human, the agent must provide a self-contained reason: action and target/spec, observed refusal and CAWS limitation, ordinary alternatives and why none can accomplish it, session/handlers, extent/use count, exclusions, expiry, verification, recovery and revocation. Use an ordinary route when available. Disclose prior refusals; a past or peer grant is not reusable permission. Approval must precede the action. One session, one repo by default; other repos ignore the grant unless --all-repos was given. Partial grants over handlers enforcing one boundary are refused. The entire named handler is skipped on matching calls until expiry: paths, operations and use counts in the reason are agent obligations, not machine-enforced restrictions. The CLI does not assess the justification. The skip is logged when it fires.

**Options:**

- `--handlers <list>` (**required**) — Comma-separated handler basenames to skip (e.g. protected-paths.sh)
- `--reason <text>` (**required**) — Self-contained justification: blocked action/target/spec, CAWS limitation, why ordinary alternatives cannot work, exact bounds, verification/recovery and revocation. Recorded for human review and future agents; not machine-enforced path authority.
- `--approved-by <id>` (**required**) — Approver identity
- `--for <duration>` — Expiry as a duration from now, e.g. 30m, 1h30m, 120s, 2d (units: s, m, h/hr, d). Mutually exclusive with --expires-at; exactly one is required.
- `--expires-at <iso>` — Expiry as an absolute ISO-8601 datetime, e.g. 2026-07-26T02:30:00Z (must include Z or a +/-HH:MM offset). Mutually exclusive with --for; prefer --for unless you need an exact instant.
- `--current` — Resolve the session from env (default)
- `--session <id>` — Explicit session id (overrides --current)
- `--surface <name>` — Harness provenance and legacy lookup context (default: detect); new grants use the machine session store
- `--all-repos` — Reach every repo on this machine instead of only the repo the grant is issued from. Default is repo-scoped: a guard in any other repo ignores the grant. Use only when the work legitimately spans repos, and state that in --reason.
- `--dry-run` — Validate and report without writing the state file
- `--json` — Emit the result as JSON.
- `--data` — Show structured data block on diagnostics

### `caws reprieve show`

Show the reprieve for the current (or named) session, if any, including its derived active/expired state.

**Options:**

- `--current` — Resolve the session from env (default)
- `--session <id>` — Explicit session id (overrides --current)
- `--surface <name>` — Harness provenance and legacy lookup context (default: detect); new grants use the machine session store
- `--json` — Emit the record as JSON.
- `--data` — Show structured data block on diagnostics

### `caws reprieve revoke`

Revoke (delete) the reprieve for the current (or named) session. The guard resumes normal enforcement immediately. --reason is mandatory and is recorded in the audit log.

**Options:**

- `--reason <text>` (**required**) — Why the reprieve is being cleared; recorded
- `--current` — Resolve the session from env (default)
- `--session <id>` — Explicit session id (overrides --current)
- `--surface <name>` — Harness provenance and legacy lookup context (default: detect); new grants use the machine session store
- `--json` — Emit the result as JSON.
- `--data` — Show structured data block on diagnostics

### `caws reprieve list`

List active guard reprieves across sessions, with each one's handlers, expiry, and derived active/expired state.

**Options:**

- `--surface <name>` — Harness provenance and legacy lookup context (default: detect); new grants use the machine session store
- `--json` — Emit the list as JSON.
- `--data` — Show structured data block on diagnostics

## `caws specs`

Manage CAWS spec lifecycle (create/list/show/recover/restore/commit/retire-draft/prune-drafts/activate/deactivate/amend/amend-scope/evidence/verify-acs/close/reopen/archive/prune-archive/migrate/validate/relocate)

**Options:**

- `--status <status>` — Compatibility handoff to caws specs list --status <status>: active | draft | closed | archived
- `--data` — Show structured data block on diagnostics

### `caws specs create [id]`

Create a new spec in lifecycle_state: draft. Binding a worktree (caws worktree create <name> --spec <id>) activates it, so active means the slice is being worked. Use --activate to create it active instead.

**Argument:** `id` (optional) — Spec id to create

**Options:**

- `--allow-foreign-branch` — CANONICAL-DRIFT-GUARDS-001: deliberately author this lifecycle commit on a foreign (parked) branch. Without it, the command refuses when the canonical HEAD is off-base while worktrees are active.
- `--id <id>` — Alias for the positional spec id
- `--title <title>` — Short spec title (required)
- `--mode <mode>` — Spec mode (required): feature | refactor | fix | doc | chore
- `--scope-in <path>` (repeatable) — Populate scope.in at creation time (repeatable); avoids the YAML hand-edit. Widen later with `caws specs amend-scope`.
- `--scope.in <path>` (repeatable) — Alias for --scope-in using the YAML field name; writes canonical scope.in and is repeatable.
- `--acceptance <text>` (repeatable) — Seed an acceptance criterion at creation time (repeatable). Free text becomes the then clause; "given: ...; when: ...; then: ..." sets all fields.
- `--contract <spec>` (repeatable) — Add a contract at creation (repeatable), as "name:type[:path]" where type is api|schema|contract-test|behavior. Example: --contract "core-api:behavior".
- `--module <text>` (repeatable) — Populate blast_radius.modules at creation (repeatable). The field is schema-required non-empty; without this flag the command writes a scaffolded default. Replace it later with caws specs amend --add-module, which replaces the scaffolded default when it is the only entry.
- `--invariant <text>` (repeatable) — Populate invariants at creation (repeatable). The field is schema-required non-empty; without this flag the command writes a scaffolded default. Replace it later with caws specs amend --add-invariant, which replaces the scaffolded default when it is the only entry.
- `--observability <text>` (repeatable) — Add an observability item at creation (repeatable): a log, metric, trace, or alert.
- `--rollback <text>` (repeatable) — Add a rollback step at creation (repeatable).
- `--activate` — Create the spec in lifecycle_state: active instead of draft. Only for a slice you are working without a worktree — the normal path is caws worktree create --spec <id>, which activates on bind.
- `--security <text>` (repeatable) — Add a non_functional.security requirement at creation (repeatable).
- `--plan` — Read-only preflight: validate and print the candidate spec without writing .caws/specs or events
- `--json` — With --plan, emit the candidate, diagnostics, missing fields, and create command as JSON
- `--data` — Show structured data block on diagnostics

### `caws specs list`

List specs. By default excludes archived specs.

**Options:**

- `--status <status>` — Filter by lifecycle status: active | draft | closed | archived
- `--lifecycle <state>` — Alias for --status; filter by lifecycle state: active | draft | closed | archived
- `--state <state>` — Alias for --status; filter by lifecycle state: active | draft | closed | archived
- `--active` — Alias for --status active
- `--draft` — Alias for --status draft
- `--closed` — Alias for --status closed
- `--archived` — Include archived specs in the listing
- `--session-id <id>` — Session work-surface view: list only specs this session relates to (created it, holds its bridge claim, or owns a worktree bound to it), each with its binding state and suggested action. Includes archived specs unless --status narrows the view.
- `--data` — Show structured data block on diagnostics

### `caws specs show <id>`

Show a spec by id. Defaults to active specs only; pass --archived to recover an archived spec body from the event log + git history.

**Argument:** `id` (required) — Spec id to show

**Options:**

- `--data` — Show structured data block on diagnostics
- `--archived` — Recover an archived spec body. Move-shaped archives are read from .caws/specs/.archive/ when present; tombstone-shaped archives fall back to git show <blob_sha>.

### `caws specs recover <id>`

Recover an archived spec body. Reads .caws/events.jsonl for the spec_archived event, prefers an on-disk .caws/specs/.archive/<id>.yaml body for move-shaped archives, and falls back to git history/blob recovery. Prints to stdout (or --out <path>) and does not mutate .caws/specs/.

**Argument:** `id` (required) — Archived spec id to recover

**Options:**

- `--data` — Show structured data block on diagnostics
- `--out <path>` — Write the recovered body to this path instead of stdout

### `caws specs restore <id>`

Restore a recoverable archived/retired spec body back to .caws/specs/<id>.yaml as draft or active. Dry-run by default; --apply writes the validated body and appends spec_restored. Restore refuses to overwrite an existing canonical spec and clears stale terminal lifecycle/worktree fields.

**Argument:** `id` (required) — Archived or retired spec id to restore

**Options:**

- `--as <state>` — Target lifecycle state for the restored spec: draft | active
- `--apply` — Apply the restore (default: read-only dry-run plan)
- `--json` — Emit restore plan/apply result as JSON
- `--data` — Show structured data block on diagnostics

### `caws specs commit <id>`

Governed recovery for a spec mutation whose audit commit did not land (sandbox-protected .git, index.lock contention, or a pre-existing dirty tree). Stages and commits ONLY .caws/specs/<id>.yaml through the same path-scoped autoCommit discipline as lifecycle writers — never -A, never --no-verify, pre-commit hooks respected. A clean spec is a reported no-op; exit 1 surfaces the refusal reason. (CAWS-SPECS-COMMIT-PENDING-RECOVERY-001)

**Argument:** `id` (required) — Spec id whose pending audit state to commit

**Options:**

- `--data` — Show structured data block on diagnostics

### `caws specs retire-draft <id>`

Retire a never-activated DRAFT spec via tombstone. Refuses active (use close), closed (use archive), and archived specs. Deletes the draft YAML and appends a recoverable spec_retired event (recover via caws specs show <id> --archived). The governed alternative to raw git rm.

**Argument:** `id` (required) — Draft spec id to retire

**Options:**

- `--reason <text>` — Optional human-readable retirement note
- `--data` — Show structured data block on diagnostics

### `caws specs prune-drafts`

Plan or apply stale draft cleanup. Dry-run by default: classifies draft specs as candidates, skipped, or refused using age, include/exclude selectors, and worktree binding state. --apply retires only candidate drafts through the governed retire-draft path.

**Options:**

- `--older-than <duration>` — Stale threshold as a duration, e.g. 10m, 2h, 7d (default: 7d; units: s, m, h/hr, d; combine as 1h30m). Mutually exclusive with --older-than-ms.
- `--older-than-ms <ms>` — Stale threshold in milliseconds (default: 604800000 = 7 days). Prefer --older-than.
- `--include <ids>` — Comma-separated spec ids to include even when not stale
- `--exclude <ids>` — Comma-separated spec ids to exclude from the plan
- `--include-bound` — Allow bound draft specs to appear as candidates; default refuses bound drafts
- `--apply` — Retire selected candidate drafts. Requires --include or an explicit --older-than / --older-than-ms.
- `--reason <text>` — Optional retirement reason recorded on spec_retired events during --apply
- `--json` — Emit the draft cleanup plan as JSON
- `--data` — Show structured data block on diagnostics

### `caws specs activate <id>`

Activate a pre-authored draft spec. Draft-only: patches lifecycle_state to active and appends spec_activated.

**Argument:** `id` (required) — Draft spec id to activate

**Options:**

- `--allow-foreign-branch` — CANONICAL-DRIFT-GUARDS-001: deliberately author this lifecycle commit on a foreign (parked) branch. Without it, the command refuses when the canonical HEAD is off-base while worktrees are active.
- `--data` — Show structured data block on diagnostics

### `caws specs amend-scope <id>`

Amend a spec's scope.in/scope.out/scope.support on the canonical control plane (active/draft only). The sanctioned way to add a path you need to edit — no git cherry-pick, no danger latch. Writes only canonical .caws/specs/<id>; scope check from a linked worktree admits the added path immediately. Comment-preserving; validate-before-write; appends spec_scope_amended.

**Argument:** `id` (required) — Active or draft spec id to amend

**Options:**

- `--allow-foreign-branch` — CANONICAL-DRIFT-GUARDS-001: deliberately author this lifecycle commit on a foreign (parked) branch. Without it, the command refuses when the canonical HEAD is off-base while worktrees are active.
- `--add <path>` (repeatable) — Add a scope.in path — editable AND worktree-claimed (repeatable)
- `--remove <path>` (repeatable) — Remove a matching scope.in path — file or directory, matched by logical value regardless of quoting (repeatable)
- `--add-out <path>` (repeatable) — Add a scope.out path. NOTE: the no-glob rule is an ADD-time schema constraint (file or directory paths only); removal has no such restriction (repeatable)
- `--remove-out <path>` (repeatable) — Remove a matching scope.out path — file or directory, matched by logical value regardless of quoting (repeatable)
- `--add-support <path>` (repeatable) — Add a scope.support path — editable like scope.in but NOT worktree-claimed (use for repo-root deliverables; repeatable)
- `--remove-support <path>` (repeatable) — Remove a matching scope.support path — matched by logical value regardless of quoting (repeatable)
- `--reason <text>` — Optional operator rationale recorded on the spec_scope_amended event
- `--data` — Show structured data block on diagnostics

### `caws specs close <id>`

Close an active spec. Non-destructive raw-byte YAML patch; appends spec_closed event.

**Argument:** `id` (required) — Active spec id to close

**Options:**

- `--allow-foreign-branch` — CANONICAL-DRIFT-GUARDS-001: deliberately author this lifecycle commit on a foreign (parked) branch. Without it, the command refuses when the canonical HEAD is off-base while worktrees are active.
- `--resolution <r>` (default: `completed`) — Resolution: completed | superseded | abandoned
- `--reason <text>` — Closure notes recorded on the spec YAML and the spec_closed event
- `--closure-notes <text>` — Alias for --reason; writes closure_notes on the closed spec
- `--notes <text>` — Alias for --reason; compatibility shorthand for closure_notes
- `--note <text>` — Alias for --reason; singular compatibility shorthand for closure_notes
- `--merge-commit <sha>` — Optional merge commit SHA (e.g., when closure follows a worktree merge)
- `--superseded-by <id>` — Spec id that supersedes this one (use with --resolution superseded)
- `--data` — Show structured data block on diagnostics

### `caws specs evidence <id>`

Record per-criterion verified status (AC evidence) on the spec's evidence: block — the CLOSURE AUTHORITY read by the close gate. Dual-writes: patches the spec block AND appends an ac_recorded event in one transaction. This is the ONLY command that writes the block (`caws evidence record --type ac` is refused and redirects here). The close gate WARNS when a declared AC lacks pass/waived evidence and names the criteria on close and merge; it does not currently refuse the close (warn-mode). Active/draft only (a closed/archived spec's evidence is frozen).

**Argument:** `id` (required) — Active or draft spec id to record evidence for

**Options:**

- `--ac <id>` (**required**) — Acceptance criterion id (e.g. A1); must match a declared acceptance[].id
- `--status <s>` — Verified status (required). pass/waived satisfy the close gate; fail/unchecked are recorded for audit but do not satisfy closure: pass | fail | unchecked | waived
- `--evidence-ref <ref>` — Reference to the evidence (test command, artifact path, or waiver id). Required unless --status waived (where --waiver-reason supplies it)
- `--waiver-reason <text>` — Mandatory when --status waived — an undocumented waiver is indistinguishable from an oversight
- `--test-nodeid <id>` — Optional: specific test node id (jest/vitest/pytest) when status was determined by test execution
- `--command <cmd>` — Optional: the command run to determine status
- `--exit-code <n>` — Optional: exit code of the command run
- `--artifact-path <path>` — Optional: artifact path evidencing the criterion
- `--commit-sha <sha>` — Optional: commit sha (7-40 hex chars) evidencing the criterion
- `--verify` — Re-derive the cited evidence before recording: run the cited test through the detected runner (specs verify-acs --run documents which runners execute and how each is resolved), check the cited artifact and commit. From inside a linked worktree the check runs against that worktree (named in the output with its HEAD) and refuses when the worktree has uncommitted changes. Refuses to record status pass when the citation is refuted and writes nothing; a citation that cannot be re-derived is recorded and named as self-reported. When the cited test executes and passes, the entry records test_verified_at (the HEAD it ran at), which specs close — it never runs tests — reports as the recorded execution; any later re-record drops it. Requires at least one of --test-nodeid / --artifact-path / --commit-sha (a --command is recorded but never executed, so it cannot be verified)
- `--data` — Show structured data block on diagnostics

### `caws specs verify-acs <id>`

Re-derive the spec's recorded acceptance evidence against reality instead of trusting its status field. Per criterion: the cited commit_sha must exist and be reachable from a ref, the cited artifact_path must be present at that revision, and the cited test_nodeid must exist (or, with --run, execute and pass). Three verdicts, never collapsed: verified (the check ran and passed), refuted (it ran and failed, or the citation names nothing), not_rederived (nothing mechanical was declared, or the check could not run). A criterion with only narrative evidence is not_rederived, and every verdict derived from an agent-supplied field is tagged [agent-cited] — re-derivation proves a citation is real, not that it is relevant; the tag never means the check did not run. Read-only: writes nothing. A recorded command is never executed. Exit 1 when any criterion is refuted; with --strict, also when any is not_rederived.

**Argument:** `id` (required) — Spec id whose recorded acceptance evidence to re-derive

**Options:**

- `--run` — Execute cited tests instead of only checking they exist. jest is resolved from the repository's own node_modules/.bin, walking up to the repo root — never npx. pytest is not repo-resolved: it runs as python3 -m pytest against whatever python3 is first on PATH, so a different ambient interpreter can change the verdict. Default: existence check only, which reports not_rederived, never pass
- `--strict` — Exit 1 when any criterion is not_rederived (default: exit 1 only on refuted)
- `--runner <name>` — Override test-runner detection. Only pytest, jest, node, bats execute under --run; naming vitest, cargo, go reports unavailable and verifies nothing: pytest | jest | node | bats | vitest | cargo | go
- `--json` — Emit the verify-acs.v1 report as JSON
- `--data` — Show structured data block on diagnostics

### `caws specs reopen <id>`

Reopen a closed spec (closed -> active), the inverse of close. Removes resolution/closure_notes/superseded_by so the active spec is valid; leaves the spec unbound (re-bind with caws worktree create/bind). Appends spec_reopened event.

**Argument:** `id` (required) — Closed spec id to reopen

**Options:**

- `--reason <text>` — Optional reason recorded on the spec_reopened event (e.g. work determined incomplete)
- `--data` — Show structured data block on diagnostics

### `caws specs amend <id>`

Amend a spec's blast_radius.modules, invariants, or acceptance criteria. The first two are schema-required non-empty, so create writes a scaffolded default when no flag supplies one; this is how an already-created spec replaces that default without a hand edit that bypasses the audit trail. Acceptance flags (--set-ac/--add-ac/--remove-ac) amend a criterion's Given/When/Then text — exactly one AC op per invocation — and reset that criterion's recorded evidence in the same transaction, because a rewritten claim must never keep the proof of the old text. Appends spec_body_amended. Draft and active specs allow add, remove, and rewrite. A CLOSED spec allows only filling a field still holding its scaffolded default (for acceptance: all three fields, and only while the criterion carries no evidence) — a concluded record may have a blank filled, never a claim rewritten. Archived specs are refused (restore first). For scope, use caws specs amend-scope.

**Argument:** `id` (required) — Spec id to amend

**Options:**

- `--add-module <text>` (repeatable) — Add a blast_radius.modules entry (repeatable). Replaces the scaffolded default when that is the only entry.
- `--remove-module <text>` (repeatable) — Remove a blast_radius.modules entry (repeatable); matches the logical value regardless of quoting.
- `--add-invariant <text>` (repeatable) — Add an invariants entry (repeatable). Replaces the scaffolded default when that is the only entry.
- `--remove-invariant <text>` (repeatable) — Remove an invariants entry (repeatable); matches the logical value regardless of quoting.
- `--set-ac <id>` — Rewrite an existing acceptance criterion's text (e.g. A2). Pair with --given/--when/--then; fields not supplied keep their wording. Resets the criterion's evidence to unchecked.
- `--add-ac <id>` — Declare a NEW acceptance criterion. Requires --given, --when, and --then. Refuses an id that already exists (use --set-ac to rewrite).
- `--remove-ac <id>` — Remove an acceptance criterion and its evidence entry. Refused when it is the only criterion (schema minItems 1).
- `--given <text>` — Criterion's Given text (with --set-ac or --add-ac).
- `--when <text>` — Criterion's When text (with --set-ac or --add-ac).
- `--then <text>` — Criterion's Then text (with --set-ac or --add-ac).
- `--reason <text>` — Optional rationale recorded verbatim on the spec_body_amended event.
- `--data` — Show structured data block on diagnostics

### `caws specs deactivate <id>`

Demote an active spec back to draft (active -> draft), the inverse of activate. Use it when a spec was activated by mistake or its slice has not started — unlike close, it writes no resolution, so it makes no claim that the work concluded. Removes any resolution/closure_notes/superseded_by residue. Refused for a spec bound to a worktree. Appends spec_deactivated event.

**Argument:** `id` (required) — Active spec id to demote to draft

**Options:**

- `--reason <text>` — Optional reason recorded on the spec_deactivated event (e.g. activated against the wrong id)
- `--data` — Show structured data block on diagnostics

### `caws specs archive [id]`

Archive one closed spec, or batch-archive closed specs with --status closed. Batch mode defaults to dry-run; pass --apply to archive selected specs in one aggregate audit commit.

**Argument:** `id` (optional) — Closed spec id to archive

**Options:**

- `--reason <text>` — Archive reason (advisory; the spec_archived event does not carry it)
- `--status <s>` — Batch selector status. Currently only: closed
- `--include <ids>` — Comma-separated spec ids to include in batch mode
- `--exclude <ids>` — Comma-separated spec ids to exclude from batch mode
- `--older-than <duration>` — Batch selector: archive only closed specs whose updated_at/created_at age is at least this duration, e.g. 10m, 2h, 7d (units: s, m, h/hr, d; combine as 1h30m). Mutually exclusive with --older-than-ms.
- `--older-than-ms <ms>` — Batch selector: archive only closed specs whose updated_at/created_at age is at least this many milliseconds. Prefer --older-than.
- `--updated-before <timestamp>` — Batch selector: archive only closed specs whose updated_at/created_at timestamp is before this cutoff
- `--without-worktree` — Batch selector: archive only closed specs that do not still carry a worktree binding
- `--replace` — Archive over an id that already has a body in .caws/specs/.archive/. The existing body is first copied to <id>.superseded-<timestamp>.yaml — nothing is discarded. Without this, a stale archived body shadows the live spec permanently, because recover prefers the on-disk archived body.
- `--apply` — Apply batch archive (default: dry-run)
- `--json` — Emit CAWS-native JSON to stdout
- `--data` — Show structured data block on diagnostics

### `caws specs prune-archive`

Compatibility no-op. Archived spec bodies under .caws/specs/.archive/ are canonical again and are not pruned by CAWS. To archive closed specs, use caws specs archive --status closed; to bring an archived spec back, use caws specs restore or caws specs recover.

**Options:**

- `--apply` — Accepted for compatibility; no files are pruned. Use caws specs archive --status closed --apply to archive closed specs.
- `--data` — Show structured data block on diagnostics

### `caws specs migrate`

v10→v11 spec YAML migrator (CAWS-MIGRATE-V10-SPECS-001). Default is dry-run; --apply opts into mutation. --apply without --partial refuses if any spec hits a "refused" verdict. --apply --partial writes migratable specs, skips refused, emits a durable JSON report under .caws/migrations/v10-specs/.

**Options:**

- `--from <version>` (**required**) — Source schema version to migrate from: v10
- `--apply` — Write migrated YAMLs to disk (default: dry-run)
- `--partial` — Allow apply to proceed even when some specs are refused (only meaningful with --apply)
- `--lifecycle-mapping <path>` — Path to a JSON file mapping spec ids to v11 lifecycle values, shaped like {"SPEC-1":{"lifecycle_state":"closed","resolution":"implemented"}}. Used for v10 lifecycles outside the v11 enum (superseded/proven/frozen). Operator-owned; the transformer never auto-defaults.
- `--json` — Emit machine-readable JSON output instead of human text
- `--data` — Show structured data block on diagnostics

### `caws specs validate <file>`

Validate a spec YAML FILE on disk using the CLI's own bundled parser and the kernel parse->shape->semantics pipeline. Path-shaped (takes a file path, not a spec id); does NOT resolve .caws/, read canonical state, or mutate anything. Exits 0 when valid, non-zero with a rendered diagnostic when invalid or unreadable. Lets hooks/CI validate spec YAML without carrying their own parser dependency — works for any consumer project regardless of language.

**Argument:** `file` (required) — Path to the spec YAML file to validate

**Options:**

- `--data` — Show structured data block on diagnostics

### `caws specs relocate <id>`

CANONICAL-DRIFT-GUARDS-001 (Entry 37 recovery): move a spec YAML from a mis-parked canonical branch onto the base branch WITHOUT touching any working tree — object-db plumbing (read the parked copy, graft onto base via a private temp index, commit-tree, compare-and-swap the base ref; bounded retry on contention). Dry-run by default; --apply performs. The audit is the commit on base itself. Base branch resolves from the worktree registry (unique baseBranch required).

**Argument:** `id` (required) — Spec id whose YAML should move to base

**Options:**

- `--to-base` — Accepted for explicitness; to-base is the only v1 target.
- `--apply` — Perform the relocation (default is a read-only dry-run plan).
- `--data` — Show structured data block on diagnostics

## `caws worktree`

Manage CAWS worktrees (create/adopt/list/ensure/bind/destroy/untrack/merge/review/migrate-registry/repair-sparse/repair/prune/cleanup-plan). Worktrees are git worktrees bound to active specs. Compatibility: `caws worktree --prune ...` is normalized to `caws worktree prune ...` before parsing.

### `caws worktree create <name>`

Create a new git worktree under .caws/worktrees/<name> bound to an active spec. Also links recognized git-ignored dependency/cache artifacts (node_modules, .pnpm-store, Python venvs, Rust target, Swift .build) from the canonical checkout into the worktree as relative symlinks, reported under an "Artifacts:" block with unlink/install guidance. Linking is advisory (create never fails on it), skips paths that already exist in the worktree, and skips on lock/manifest divergence. A linked artifact shares the canonical directory: run the printed unlink command before installing if the worktree branch changes dependency manifests.

**Argument:** `name` (required) — Worktree name

**Options:**

- `--spec <id>` (**required**) — Active spec id to bind the worktree to
- `--base-branch <branch>` — Base branch to start from (default: current branch)
- `--branch <branch>` — New branch name (default: worktree name)
- `--data` — Show structured data block on diagnostics

### `caws worktree adopt <name>`

Register an existing Git linked worktree of this repository and bind a draft or active spec. Requires the exact root and a non-main, non-base branch; --branch creates a new branch for a detached app checkout. Preserves staged, unstaged and untracked source work; refuses local authority changes, conflicting registry bindings and foreign spec owners. Applies the CAWS authority sparse exclusion. Failure retains the checkout, commits and any explicitly requested new branch.

**Argument:** `name` (required) — New CAWS registry name

**Options:**

- `--path <path>` (**required**) — Existing linked worktree root
- `--spec <id>` (**required**) — Draft or active spec to bind
- `--base-branch <branch>` (**required**) — Existing local integration base branch
- `--branch <branch>` — New branch for a detached checkout; retained on later registration failure
- `--data` — Show structured data block on diagnostics

### `caws worktree list`

List registered worktrees with branch, lane divergence from base (ahead/behind), spec binding, and owner.

**Options:**

- `--json` — Emit the same facts as machine-readable JSON, with full owner session ids and null divergence counts where a ref does not resolve
- `--data` — Show structured data block on diagnostics

### `caws worktree ensure <name>`

Create-or-admit affordance (WORKTREE-ENSURE-AFFORDANCE-001): absent worktree is created via the full create path (worktree_created + worktree_bound, draft activates on bind); an existing worktree bound to the SAME spec with an admitting owner and an untouched fork-point branch ADMITS idempotently (exit 0, no new events) and prints the cd entry command. Refuses: foreign-owned (soft-block; takeover stays on caws claim), different-spec binding (list/unbind handoffs), closed/archived spec (reopen/recover handoffs), moved branch (in-flight lane). ensure accepts no takeover flag by design.

**Argument:** `name` (required) — Worktree name

**Options:**

- `--spec <id>` (**required**) — Spec id to bind (draft or active)
- `--data` — Show structured data block on diagnostics

### `caws worktree bind <name>`

Repair bidirectional binding between a worktree and a spec (one-sided → bound). Refuses a foreign-owned worktree unless --steal --reason is given.

**Argument:** `name` (required) — Worktree name

**Options:**

- `--spec <id>` (**required**) — Spec id to bind the worktree to
- `--steal` — Forcibly take ownership of a worktree owned by a different session. Requires --reason. Appends a worktree_ownership_seized audit event.
- `--reason <text>` — Justification for --steal (required when stealing; recorded in the audit log).
- `--data` — Show structured data block on diagnostics

### `caws worktree destroy <name>`

Destroy a worktree. Guarded: refuses foreign ownership, dirty checkout, and unmerged branch unless --abandon-unmerged or its --force compatibility alias is supplied.

**Argument:** `name` (required) — Worktree name

**Options:**

- `--abandon-unmerged` — Destroy even when the branch is not merged into base. Still respects ownership and clean working tree.
- `--force` — Compatibility alias for --abandon-unmerged only; still respects ownership, clean checkout, and registry guardrails.
- `--data` — Show structured data block on diagnostics

### `caws worktree untrack <name>`

Release a CAWS worktree registry binding while preserving the physical git worktree directory for inspection. Dry-run by default. Requires --reason; --apply removes only the control-plane binding and refuses foreign-owned, dirty, or missing-directory cases.

**Argument:** `name` (required) — Registered worktree name to release from CAWS tracking.

**Options:**

- `--reason <reason>` (**required**) — Operator reason recorded on the worktree_untracked audit event.
- `--apply` — Apply the untrack plan. Without --apply, the command only prints the plan.
- `--json` — Emit the dry-run plan or apply outcome as JSON.
- `--data` — Show structured data block on diagnostics

### `caws worktree merge <name>`

Merge a worktree branch into its base. Auto-closes the bound spec via caws specs close. Refuses on lane provenance when the branch carries a commit touching a path outside the spec scope; the remedy is `caws specs amend-scope <spec> --add-support <path>`, and the refusal names that command for each offending path.

**Argument:** `name` (required) — Worktree name

**Options:**

- `--dry-run` — Check prerequisites and Git merge readiness; no ref, index, working-tree or event updates (may write unreachable Git objects)
- `--apply` — Run the dry-run gate, then merge if ready (collapses --dry-run + real merge into one call). Refuses with findings if not ready; never forces.
- `--message <text>` — Custom merge commit message (default: merge(worktree): <name>)
- `--closure-notes <text>` — Closure notes written to the bound spec on auto-close (replaces the machine stub). Mirrors caws specs close.
- `--reason <text>` — Alias for --closure-notes
- `--notes <text>` — Alias for --closure-notes
- `--note <text>` — Alias for --closure-notes
- `--no-close` — Land the merge but leave the bound spec ACTIVE (no spec_closed event), so caws specs evidence is still accepted. Close explicitly afterwards. Mutually exclusive with --closure-notes.
- `--data` — Show structured data block on diagnostics

### `caws worktree migrate-registry`

Convert v10.2 legacy-envelope .caws/worktrees.json into the v11 flat-map shape. Destroyed records are omitted iff no spec claims them and their path is absent; refuses otherwise. Idempotent on already-flat files.

**Options:**

- `--dry-run` — Classify and report what would happen; do not write.
- `--data` — Show structured data block on diagnostics

### `caws worktree repair-sparse <name>`

Restore the .caws/specs sparse-checkout invariant on a linked worktree. Idempotent and non-destructive: refuses if .caws/specs/ has dirty or untracked content rather than stashing, cleaning, resetting, or deleting it. Use this after a `git sparse-checkout disable` has materialized canonical spec files into the worktree.

**Argument:** `name` (required) — Worktree name

**Options:**

- `--data` — Show structured data block on diagnostics

### `caws worktree repair`

Repair the unambiguous worktree/spec half-states the doctor surfaces: prune a ghost registry entry (H1) and clear a dead spec->worktree binding (H4 ghost, H3 dormant). Consumes the doctor diagnostics + §1.4 decision matrix as authority; never re-derives policy. Refuses ambiguous/forbidden classes (H2, H3-active, H5, H6, event-orphan) with a doctrine pointer and zero mutation. NEVER creates or deletes a git worktree directory.

**Options:**

- `--dry-run` — Report each H-class, subject, planned mutation, and event; write nothing.
- `--data` — Show structured data block on diagnostics

### `caws worktree prune`

Print a worktree cleanup plan from doctor evidence. Dry-run by default. With --apply, mutates only apply-capable classes (ghost-registry, dead-binding, closed-spec-residue) through the same writer paths as caws worktree repair; refused classes remain refused.

**Options:**

- `--state <classes>` — Comma-separated state-class filter. Accepted classes: ghost-registry, verified-dead-creation, dead-binding, closed-spec-residue, missing-spec-refused, active-binding-refused, binding-contradiction-refused, foreign-physical-refused, event-orphan-refused, one-sided-binding-refused, non-governable-binding-refused, owner-lease-missing-refused, git-observation-unavailable
- `--status <classes>` — Alias for --state <classes>; accepts the same state-class values.
- `--include <subjects>` — Comma-separated subjects to include (worktree names, spec ids, or paths).
- `--exclude <subjects>` — Comma-separated subjects to exclude (worktree names, spec ids, or paths).
- `--apply` — Apply only safe cleanup classes (ghost-registry, dead-binding, closed-spec-residue). Refused classes still do not mutate.
- `--json` — Emit the plan or apply outcome as JSON.
- `--data` — Show structured data block on diagnostics

### `caws worktree cleanup-plan`

Print a physical worktree cleanup plan. Dry-run by default. With --apply, requires an explicit selector and destroys only destroy-ready registered worktrees through the existing destroyWorktree path.

**Options:**

- `--state <classes>` — Comma-separated state-class filter. Accepted classes: destroy-ready, unbound-clean-candidate, dirty-refused, unmerged-refused, active-bound-refused, foreign-owned-refused, missing-directory-refused, not-git-worktree-refused, unknown-spec-refused, unregistered-physical-refused, git-observation-unavailable
- `--status <classes>` — Alias for --state <classes>; accepts the same state-class values.
- `--include <subjects>` — Comma-separated worktree names, spec ids, or paths to include.
- `--exclude <subjects>` — Comma-separated worktree names, spec ids, or paths to exclude.
- `--apply` — Apply selected destroy-ready candidates only. Requires --state, --include, or --exclude. Refused classes still do not mutate.
- `--json` — Emit the plan or apply outcome as JSON.
- `--data` — Show structured data block on diagnostics

### `caws worktree review <name>`

Read-only human-review gate (WORKTREE-REVIEW-SURFACE-001): renders exactly what `caws worktree merge <name>` would land — the exact commit list in base..branch (never counts-only), a per-commit scope-provenance table flagging out-of-scope paths with the refusal merge raises, the lane diffstat, the bound spec’s acceptance criteria with their recorded evidence status (the close-gate authority), and the owner’s lease work_state (visibility only). Never mutates .caws/, never appends events, never touches git refs or any working tree. A missing worktree exits 1; a rendered report exits 0; an empty lane renders honestly without fabricated rows.

**Argument:** `name` (required) — Registered worktree name to review

**Options:**

- `--json` — Emit the same review report as machine-readable JSON.
- `--data` — Show structured data block on diagnostics

## `caws agents`

Agent liveness substrate: register/heartbeat/stop/list/show/work-state/prune. Operational cache only — NEVER authority. CAWS-native JSON; never Claude Code hook envelope.

### `caws agents register`

Register this session in .caws/leases/. Hook-invoked at SessionStart.

**Options:**

- `--session-id <id>` — Explicit session id (required for hook-invoked usage; overrides resolveSession)
- `--platform <p>` — Platform tag (e.g., claude-code, cursor, manual)
- `--reason <r>` — session_start | pre_tool_use | manual_register | claim | status
- `--json` — Emit CAWS-native JSON to stdout (never hookSpecificOutput)
- `--include-active-summary` — Include active_agent_count + active_agents in JSON output
- `--data` — Show structured data block on diagnostics

### `caws agents heartbeat`

Refresh this session's lease. Hook-invoked at PreToolUse. Throttle-aware.

**Options:**

- `--session-id <id>` — Explicit session id (required for hook-invoked usage)
- `--platform <p>` — Platform tag
- `--reason <r>` — pre_tool_use | claim | status | manual_register
- `--session-kind <main|fork|subagent>` — Harness session kind for the lease (display + coordination aid, never authority). The hook passes CAWS_SESSION_KIND through when set (CAWS-AGENTS-FORK-IDENTITY-001).
- `--forked-from <session_id>` — Parent session id — only meaningful with --session-kind fork; refused otherwise (CAWS-AGENTS-FORK-IDENTITY-001).
- `--throttle <ms>` — Skip write if last_active within this many ms (default: 0 — no throttle)
- `--json` — Emit CAWS-native JSON to stdout
- `--include-active-summary` — Include active_agent_count + active_agents in JSON output
- `--data` — Show structured data block on diagnostics

### `caws agents stop`

Mark this session's lease stopped. Hook-invoked at Stop. Warn no-op if no prior lease.

**Options:**

- `--session-id <id>` — Explicit session id
- `--platform <p>` — Platform tag
- `--json` — Emit CAWS-native JSON to stdout
- `--data` — Show structured data block on diagnostics

### `caws agents list`

List active / stale / stopped agents. Read-only.

**Options:**

- `--include-stale` — Include stale (active-but-TTL-expired) records
- `--include-stopped` — Include stopped records
- `--active` — Active-only (overrides --include-* flags); TTL-classified active, not raw status field
- `--stale-ttl <duration>` — TTL for stale classification as a duration, e.g. 30m, 2h (default: 30m; units: s, m, h/hr, d; combine as 1h30m). Mutually exclusive with --stale-ttl-ms.
- `--stale-ttl-ms <ms>` — TTL for stale classification in milliseconds (default: 1800000 = 30m). Prefer --stale-ttl.
- `--json` — Emit CAWS-native JSON to stdout
- `--data` — Show structured data block on diagnostics

### `caws agents show <id>`

Show one lease by session id, with its derived TTL liveness classification. Read-only.

**Argument:** `id` (required) — Session id of the lease to show

**Options:**

- `--stale-ttl <duration>` — TTL for the derived liveness classification as a duration, e.g. 30m, 2h (default: 30m; units: s, m, h/hr, d; combine as 1h30m); the persisted status is unaffected. Mutually exclusive with --stale-ttl-ms.
- `--stale-ttl-ms <ms>` — TTL for the derived liveness classification in milliseconds (default: 1800000 = 30m); the persisted status is unaffected. Prefer --stale-ttl.
- `--json` — Emit CAWS-native JSON to stdout
- `--data` — Show structured data block on diagnostics

### `caws agents work-state`

Visibility-only work-state annotation on this session's lease (LEASE-WORK-STATE-001). Bare form shows the current state. Answers "who is blocked on a human / ready for review / done?" in agents list, status, and message sender context. NEVER authority.

**Options:**

- `--set <state>` — Set the state: working | blocked_awaiting_human | review_ready | done
- `--clear` — Remove the work-state annotation entirely
- `--note <text>` — Optional bounded note (max 200 chars) accompanying --set
- `--session-id <id>` — Explicit session id (overrides resolveSession)
- `--json` — Emit CAWS-native JSON to stdout
- `--data` — Show structured data block on diagnostics

### `caws agents prune`

Operator-invoked cleanup. Defaults to dry-run; pass --apply to actually delete. Never invoked by hooks. Three modes: --dead (PID-liveness: remove active/stopping leases on THIS host whose owning process is gone), --status <stopped|stale|legacy> --older-than <duration> (or --older-than-ms <ms>; retention-based; legacy is status-agnostic and reaches v10/early-v11 records with no status field), or --status legacy for age-based cleanup of orphan records.

**Options:**

- `--dead` — Remove leases whose owning process is dead (active/stopping, this host, pid not alive). Mutually exclusive with --status. Foreign-host leases are never touched.
- `--status <s>` — stopped | stale | legacy (required unless --dead). legacy is status-agnostic — selects by last_active age alone, reaching records with no status field.
- `--older-than <duration>` — Retention threshold as a duration, e.g. 12h, 7d (units: s, m, h/hr, d; combine as 1h30m). --status requires this or --older-than-ms.
- `--older-than-ms <ms>` — Retention threshold in milliseconds. Prefer --older-than.
- `--stale-ttl <duration>` — TTL for stale classification as a duration (used with --status stale; default 30m). Mutually exclusive with --stale-ttl-ms.
- `--stale-ttl-ms <ms>` — TTL for stale classification in milliseconds (used with --status stale; default 30m). Prefer --stale-ttl.
- `--apply` — Actually delete (default: dry-run)
- `--json` — Emit CAWS-native JSON to stdout
- `--data` — Show structured data block on diagnostics

## `caws handoff`

Portable handoff briefs (HANDOFF-EXPORT-IMPORT-001): `export` builds the metadata-only brief for a session (self by default; `--session <id>` for a peer, consent-gated with the operator recorded as the exporting authority) and writes it under .caws/handoffs/ — never user tmp/, never package-shipped. `import` reads a brief, surfaces its context, and appends exactly one manual_pickup handoff event. Briefs carry ONLY structured metadata (identity, work_state, claimed_paths, prior handoff events); file contents and turn transcripts are never read or exported, and secret-bearing paths are redacted to name-only.

### `caws handoff export`

Build and write the metadata-only handoff brief for a session. The brief carries session identity, lease work_state, claimed_paths (secret-bearing paths redacted to name-only per the scan-secrets pattern class), the worktree/spec binding, and prior handoff events from the audit chain — never file contents or turn transcripts. Written to .caws/handoffs/<id>.json (content-hashed snapshot). Self-export by default; `--session <id>` exports a PEER's brief and records the operator as the exporting authority.

**Options:**

- `--session <id>` — Export a PEER session's brief (consent-gated: the operator is recorded as the exporting authority)
- `--data` — Show structured data block on diagnostics

### `caws handoff import <file>`

Read and shape-validate a handoff brief, surface its context (source session, work_state, claimed_paths, prior handoffs), and append exactly ONE manual_pickup event binding the brief's source session to the importing session. Import never mutates claims, leases, scope, or lifecycle state — provenance, never authority. A malformed brief is refused with nothing appended.

**Argument:** `file` (required) — Brief file path (absolute or .caws/handoffs/<name> shorthand)

**Options:**

- `--data` — Show structured data block on diagnostics

## `caws message`

Inter-agent message channel (AGENT-MESSAGE-CHANNEL-001): send/reply/poll/settle/inbox/history/status/prune directed messages between running sessions, addressed by session id (or a wt:/spec: alias), over .caws/messages.jsonl. Separate from the events audit chain; not authority — a message body is an unverified claim.

### `caws message send`

Send a message to another session. Attributes the sender via this session's identity; refuses a recipient with no lease or a stale heartbeat (a stopped lease with a fresh heartbeat is idle between turns, not dead). A refused send prints a not-sent verdict to stdout — judge sends by their printed output.

**Options:**

- `--to <endpoint>` — Recipient endpoint (required): a session id, or an alias wt:<worktree-name> / spec:<spec-id> resolving to the freshest bound session
- `--text <message>` — Message body (required, non-empty)
- `--reply-to <message_id>` — Thread linkage: the message id this send replies to. Must exist and be addressed to you (CAWS-MESSAGE-LEDGER-COMPLETENESS-001).
- `--urgency <critical|normal>` — Delivery-ordering signal (default normal): a critical message polls before normal traffic regardless of age — ordering, NOT authority (CAWS-MESSAGE-DELIVERY-ECONOMICS-001).
- `--allow-dead` — Send even if the recipient is not live in the registry (escape hatch; default off)
- `--data` — Show structured data block on diagnostics

### `caws message reply [message_id]`

Reply to a message on its own channel — the recipient is the original message's kernel-attributed sender, so no session id is transcribed. Same liveness semantics as send; refuses an unknown id and refuses replying to your own message.

**Argument:** `message_id` (optional) — Id of the message being replied to (primary positional form; --id is the alias)

**Options:**

- `--id <message_id>` — Id of the message being replied to (alias for the positional)
- `--text <message>` — Reply body (required, non-empty)
- `--allow-dead` — Send even if the recipient is not live in the registry (escape hatch; default off)
- `--data` — Show structured data block on diagnostics

### `caws message poll`

Pull the next undelivered message addressed to you. Deliver-once. The result carries registry-derived sender context (worktree/spec/branch) when the sender has a lease. Defaults --me to this session id.

**Options:**

- `--me <session_id>` — Endpoint to poll for (default: this session id)
- `--wait <ms>` — Block up to <ms> for a message before returning (long-poll; capped at 60000)
- `--peek` — Show the next message without consuming it (no delivery record)
- `--receipt <auto|poll>` — Receipt mode recorded on the delivery record: 'auto' for the heartbeat hook's auto-delivery path, 'poll' (default) for an explicit poll (CAWS-MESSAGE-LEDGER-COMPLETENESS-001).
- `--drain <n>` — Consume up to n messages in one poll (1..10, default 1), critical-first then oldest-first — backlog coalescing for the auto-delivery hook (CAWS-MESSAGE-DELIVERY-ECONOMICS-001).
- `--offer` — Reserve automatic-delivery candidates for later settlement instead of consuming on poll
- `--offer-ttl-ms <ms>` — Offer lifetime in milliseconds (bounded to 1..300000; default 30000)
- `--json` — Emit JSON ({message, messages, sender?, waiting, poll_ms}) instead of human text
- `--data` — Show structured data block on diagnostics

### `caws message settle <offer_id>`

Settle one exact live automatic-delivery offer. Delivered means successful adapter handoff, not recipient visibility; released offers may retry.

**Argument:** `offer_id` (required) — Exact offer occurrence id returned by message poll --offer

**Options:**

- `--me <session_id>` — Recipient bound into the offer (default: this session id)
- `--outcome <delivered|released>` — Settlement outcome (default: delivered)
- `--json` — Emit JSON ({ok, settlement})
- `--data` — Show structured data block on diagnostics

### `caws message inbox`

List undelivered messages addressed to you without consuming them. Read-only; poll remains the delivery-consuming command.

**Options:**

- `--me <session_id>` — Endpoint inbox to list (default: this session id; ignored with --all)
- `--limit <n>` — Maximum messages to print from the waiting queue
- `--all` — List every undelivered message in the repo (all recipients), oldest-first, annotated with recipient and age. Read-only (CAWS-MESSAGE-LEDGER-COMPLETENESS-001).
- `--json` — Emit JSON ({ok, read_only, me, waiting, messages})
- `--data` — Show structured data block on diagnostics

### `caws message history`

Show retained channel history between this session and another endpoint, each message annotated with its delivery state ([queued] vs [delivered]). Read-only; message bodies are communication, not authority.

**Options:**

- `--me <session_id>` — This endpoint (default: this session id)
- `--with <session_id>` — Other endpoint in the channel (required)
- `--limit <n>` — Maximum recent messages to print, preserving log order
- `--json` — Emit JSON ({ok, read_only, channel, total, messages})
- `--data` — Show structured data block on diagnostics

### `caws message status [message_id]`

Observe one message's delivery state (queued vs delivered, with timestamps) — lets a sender distinguish "queued" from "seen" without polling the recipient. Read-only.

**Argument:** `message_id` (optional) — Id of the message to observe (primary positional form; --id is the alias)

**Options:**

- `--id <message_id>` — Id of the message to observe (alias for the positional)
- `--mine` — Dead-letter view: list YOUR sent messages that are still undelivered instead of observing one id (CAWS-MESSAGE-BEHAVIOR-001).
- `--queued` — With --mine: restrict to still-undelivered sends (required pairing for the dead-letter view).
- `--older-than <duration>` — With --mine --queued: only list sends queued at least this long, e.g. 30m, 2h (default 1h; units: s, m, h/hr, d; combine as 1h30m). Mutually exclusive with --older-than-ms.
- `--older-than-ms <ms>` — With --mine --queued: the same window in milliseconds (default 3600000 = 1h). Prefer --older-than.
- `--json` — Emit JSON ({ok, read_only, message, delivered, delivered_at?})
- `--data` — Show structured data block on diagnostics

### `caws message prune`

Plan or apply retention cleanup for non-authoritative chat messages. Dry-run by default. --status delivered prunes delivered messages; --status undelivered-to-dead-session prunes UNDELIVERED messages whose recipient is verifiably not live (no lease, or a heartbeat older than the TTL) and which are older than a retention floor (default 7d) — every recipient that could still consume (live, or idle with a fresh heartbeat) is preserved.

**Options:**

- `--status <status>` (**required**) — Message retention selector. A bare "undelivered" is refused on purpose: undelivered messages are prunable only with dead-recipient proof.: delivered | undelivered-to-dead-session
- `--older-than <duration>` — Age threshold as a duration, e.g. 1h, 7d (units: s, m, h/hr, d; combine as 1h30m). For delivered: select messages older than this. For undelivered-to-dead-session: override the retention floor (default 7d; 0s = immediate). Mutually exclusive with --older-than-ms.
- `--older-than-ms <ms>` — Age threshold in milliseconds (same semantics as --older-than; default floor 604800000 = 7 days; 0 = immediate). Prefer --older-than.
- `--include <ids>` — Comma-separated message ids to include
- `--exclude <ids>` — Comma-separated message ids to exclude
- `--apply` — Rewrite .caws/messages.jsonl to remove selected messages (archived first to .caws/messages.jsonl.archive with a selector marker)
- `--json` — Emit JSON prune plan/result
- `--data` — Show structured data block on diagnostics

## `caws session`

Session-log retention and manual handoff records. `prune` (SESSION-LOG-RETENTION-SCOPE-001) is dry-run-default retention for stale per-session turn history under .caws/sessions/ (operational cache). `pickup` (MULTI-AGENT-HANDOFF-EVENT-001) records an explicit operator handoff — "I am continuing session X's work" — as a manual_pickup event in the hash-chained audit log. The session LIFECYCLE (start/checkpoint/end) remains deferred.

### `caws session prune`

Dry-run-default retention for .caws/sessions/: classify each session log dir by last turn activity and report what is older than the retention window. Only per-session turn history (turn-<NNN>.json) is retention-eligible; the identity capsule (.session-envelope.json), .meta.json, and top-level dotfiles are preserved (per-path exclusion). The current session and any session with a live lease are protected and never pruned. --apply performs the prune; without it nothing is deleted. Operational cache only — never appends an event, never touches governed state.

**Options:**

- `--older-than <duration>` — Retention window as a duration, e.g. 7d, 12h (default: 30d; units: s, m, h/hr, d; combine as 1h30m). Mutually exclusive with --older-than-ms.
- `--older-than-ms <ms>` — Retention window in milliseconds (default: 30 days). Prefer --older-than.
- `--apply` — Perform the prune instead of dry-running it
- `--json` — Emit the plan or apply outcome as JSON.
- `--data` — Show structured data block on diagnostics

### `caws session pickup`

Record an explicit manual handoff (MULTI-AGENT-HANDOFF-EVENT-001): the operator declares "I am continuing session X's work". Appends one manual_pickup event to the hash-chained audit log naming source_session, receiving_session, and the paths picked up. Use when no automated trigger (stash restore, overlap ack, claim takeover) fired but the handoff still deserves a durable record. Provenance, never authority: no lease, claim, scope, or lifecycle mutation.

**Options:**

- `--from <session-id>` (**required**) — The session whose work is being picked up
- `--paths <path>` (repeatable) — Path(s) being picked up (comma-separated or repeatable)
- `--reason <text>` — Operator reason recorded on the handoff event
- `--data` — Show structured data block on diagnostics

## `caws working-tree`

Working-tree overlap advisory surface (WORKING-TREE-PROVENANCE-GUARD-001): `check` reports whether another active session's claimed/modified paths overlap the current dirty tree (read-only, non-mutating); `ack` records the operator's explicit per-session, per-path acknowledgement that cleans up that overlap. Never authority — neither command changes scope, claim, ownership, or lifecycle state.

### `caws working-tree check`

Report working-tree overlap with OTHER active sessions, read-only. Consumes the same predicate the PreToolUse guard uses. Exit 0 if no overlap, exit 1 if another session's claimed_paths / last_modified_paths overlap the dirty tree (scriptable precondition). Never mutates the tree or any .caws/ state.

**Options:**

- `--json` — Emit the overlap report as machine-readable JSON.
- `--data` — Show structured data block on diagnostics

### `caws working-tree ack`

Record the operator's explicit acknowledgement that they are cleaning up work claimed by another session. Writes a durable prior_overlap_acks audit entry on the TARGET session's lease (operational cache — never authority). Only records the acknowledgement; the cleanup is the operator's own action.

**Options:**

- `--session <id>` (**required**) — The other session whose overlap is being cleaned up
- `--paths <path>` (repeatable) — Overlapping path(s) being acknowledged (comma-separated or repeatable)
- `--target <command>` — The cleanup command this ack covers (e.g. "git stash")
- `--data` — Show structured data block on diagnostics

## `caws goal`

Hold this session's stop to a spec's acceptance criteria (CAWS-GOAL-AC-STOP-GATE-01). `set` binds the session to a spec; the Stop handler then re-derives that spec's acceptance with `caws specs verify-acs --json` and refuses the stop while any criterion is unproven, so the session keeps working instead of stopping on an unproven claim. `show` reports the current binding and the gate's consecutive-block count, read-only. `clear` releases the session from its goal, which does NOT mean the criteria were met. Never authority: the spec owns the bar, `caws specs evidence` remains the only writer of acceptance truth, and this surface can neither mark a criterion passed nor change scope or lifecycle state. Opt-in — with no goal set the stop chain is unchanged.

### `caws goal set <spec-id>`

Bind this session to a spec's acceptance criteria. Refuses a spec that does not load or declares no criteria, because either would surface at stop time as an unactionable refusal. Only verdict=verified counts as met; not_rederived is narrative-only evidence and does not pass.

**Argument:** `spec-id` (required) — The spec whose acceptance criteria become this session’s stop condition

**Options:**

- `--data` — Show structured data block on diagnostics

### `caws goal show`

Report this session's goal binding and the gate's consecutive-block count, read-only. Reports the counter; never edits it. Always exits 0.

**Options:**

- `--data` — Show structured data block on diagnostics

### `caws goal clear`

Release this session from its goal. Allowed without human approval — the gate’s block budget already guarantees a goal can never trap a session, so the escape is not what makes it safe. Clearing does NOT mean the criteria were met: it prints a record naming the spec it dropped so the release is legible rather than silent. Recorded evidence is unchanged.

**Options:**

- `--data` — Show structured data block on diagnostics
