---
doc_id: command-reference
authority: reference
status: active
title: CAWS CLI command reference
owner: vNext rewrite team
updated: 2026-06-03
audience: consumer
generated: true
source: packages/caws-cli/src/shell/command-metadata.ts
---

<!--
  GENERATED FILE — do not edit by hand.
  Source: packages/caws-cli/src/shell/command-metadata.ts (COMMAND_SURFACE_METADATA).
  Regenerate: node packages/caws-cli/scripts/generate-command-reference.mjs
  The sync test (tests/docs/command-reference-sync.test.js) fails CI if this
  file drifts from the metadata.
-->

# CAWS CLI Command Reference

Every `caws` command group and its subcommands, generated from the same typed metadata the CLI uses to build `--help`. Run `caws <group> --help` for the live form.

## Groups

- [`caws init`](#caws-init) — Bootstrap the canonical vNext .caws/ project state (idempotent; refuses to overwrite legacy single-spec layout). With --agent-surface, also installs the corresponding hook pack.
- [`caws doctor`](#caws-doctor) — Run drift detection against the current .caws/ state
- [`caws status`](#caws-status) — Read-only dashboard: project, current context, claim, and doctor findings
- [`caws scope`](#caws-scope) — Evaluate file paths against the bound spec scope
- [`caws claim`](#caws-claim) — Surface ownership of the current worktree; with --takeover, acquire ownership from a foreign session (writes prior_owners audit). With --paths, declare working-tree ownership metadata on the current session's lease (SESSION-OWNERSHIP-METADATA-001).
- [`caws gates`](#caws-gates) — Inspect and run quality gates against the current changes (policy-driven)
- [`caws evidence`](#caws-evidence) — Record, inspect, and describe typed evidence events in .caws/events.jsonl
- [`caws events`](#caws-events) — Read and maintain .caws/events.jsonl (list/show/rotate/migrate/verify-archive)
- [`caws waiver`](#caws-waiver) — Manage CAWS waivers (bounded exception records that suppress matching gate violations)
- [`caws specs`](#caws-specs) — Manage CAWS spec lifecycle (create/list/show/recover/restore/retire-draft/prune-drafts/activate/amend-scope/close/archive/prune-archive/migrate/validate)
- [`caws worktree`](#caws-worktree) — Manage CAWS worktrees (create/list/bind/destroy/untrack/merge/migrate-registry/repair-sparse/repair/prune/cleanup-plan). Worktrees are git worktrees bound to active specs.
- [`caws agents`](#caws-agents) — Agent liveness substrate: register/heartbeat/stop/list/show/prune. Operational cache only — NEVER authority. CAWS-native JSON; never Claude Code hook envelope.
- [`caws message`](#caws-message) — Inter-agent message channel (AGENT-MESSAGE-CHANNEL-001): send/poll directed messages between running sessions, addressed by session id, over .caws/messages.jsonl. Separate from the events audit chain; not authority — a message body is an unverified claim.
- [`caws prepush`](#caws-prepush) — Classify the outgoing commit range before publish and refuse commits not attributable to the current slice. Diagnose/decide only — does NOT run git push.

## `caws init`

Bootstrap the canonical vNext .caws/ project state (idempotent; refuses to overwrite legacy single-spec layout). With --agent-surface, also installs the corresponding hook pack.

**Options:**

- `--data` — Show structured data block on diagnostics
- `--plan` — Preview the canonical state, gitignore, hook-pack, and settings changes without writing anything.
- `--json` — Emit the read-only init plan as JSON with --plan.
- `--agent-surface <name>` — Install a hook pack for an agent harness (claude-code | codex | opencode | cursor | windsurf | none). When omitted, init attempts filesystem detection and skips hook install when ambiguous.
- `--overwrite` — For hook-pack install: replace drifted or unmanaged files at managed pack paths. CAUTION: local edits to those files will be lost.
- `--adopt` — For hook-pack install: leave drifted or unmanaged files in place without enforcing pack contents. CAUTION: pack drift is no longer tracked for those paths.

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

## `caws claim`

Surface ownership of the current worktree; with --takeover, acquire ownership from a foreign session (writes prior_owners audit). With --paths, declare working-tree ownership metadata on the current session's lease (SESSION-OWNERSHIP-METADATA-001).

**Options:**

- `--takeover` — Forcibly take ownership of a foreign-owned worktree. Required when the current owner is a different session.
- `--plan` — Preview claim ownership or takeover impact without mutating worktrees.json, leases, specs, events, or git state.
- `--json` — Emit the read-only claim plan or release-paths result as JSON.
- `--release-paths` — Clear the current session lease claimed_paths. Dry-run by default; pair with --apply to write the lease update.
- `--apply` — Apply --release-paths. Not used for normal claim or takeover, which keep their existing behavior.
- `--paths <path>` (repeatable) — Declare a path as claimed by the current session. Repeatable; order preserved; strings stored verbatim. Refused with no write if no lease exists for the current session.
- `--data` — Show structured data block on diagnostics

## `caws gates`

Inspect and run quality gates against the current changes (policy-driven)

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

### `caws gates run`

Run CAWS-local policy evaluators and apply policy.gates[gate].mode to decide block/warn/skip. Appends one gate_evaluated event per policy-declared gate. Exit codes: 0/1 on gate disposition; 2 on hard composition error (no policy / report-contract failure); 3 on evidence-integrity failure (a gate_evaluated event failed to append or validate).

**Options:**

- `--spec <id>` (**required**) — Spec id this gate run is about
- `--context <ctx>` (default: `cli`) — Compatibility no-op retained from the former external quality package path
- `--data` — Show structured data block on diagnostics

## `caws evidence`

Record, inspect, and describe typed evidence events in .caws/events.jsonl

### `caws evidence record`

Append a typed evidence event (test|gate|ac). Payload examples: test {"command":"npm test","exit_code":0}; gate {"gate_id":"budget_limit","mode":"block","result":"pass","violations":[]}; ac {"criterion_id":"A1","status":"pass","evidence_ref":"npm test"}. Use `caws evidence schema --type <kind>` for the full kernel schema.

**Options:**

- `--type <kind>` (**required**) — Evidence kind: test | gate | ac
- `--spec <id>` (**required**) — Spec id this evidence is about
- `--data <json>` (**required**) — Event payload as a JSON object string
- `--actor-kind <kind>` (default: `agent`) — Actor kind: agent | human | system | automation
- `--actor-id <id>` — Override actor id (defaults to session id)

### `caws evidence list`

Read typed evidence events for a spec from the hash-chained events log. Read-only; verifies the event chain before listing. Filters to test|gate|ac evidence and can narrow by --type.

**Options:**

- `--spec <id>` (**required**) — Spec id whose evidence should be listed
- `--type <kind>` — Optional evidence kind filter: test | gate | ac
- `--json` — Emit the evidence list as JSON.
- `--data` — Show structured data block on diagnostics

### `caws evidence show <event-ref>`

Show one event from the hash-chained events log by sequence number, exact event hash, or unique event-hash prefix. Read-only; verifies the event chain before resolving the reference.

**Argument:** `event-ref` (required) — Event sequence number, full event hash, or unique event-hash prefix.

**Options:**

- `--json` — Emit the matched event as JSON.
- `--data` — Show structured data block on diagnostics

### `caws evidence schema`

Print the kernel-derived payload schema and a copy-pasteable `caws evidence record` example for one evidence kind. Read-only; does not read or write .caws/events.jsonl.

**Options:**

- `--type <kind>` (**required**) — Evidence kind: test | gate | ac
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

- `--from <version>` (**required**) — Source schema version (only v10 supported in v11.2)
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

Manage CAWS waivers (bounded exception records that suppress matching gate violations)

### `caws waiver create <id>`

Create a new active waiver. Validates against the kernel before writing; --dry-run validates shape and duplicate id state without creating a file.

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

List waivers. By default excludes revoked and expired records.

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

Revoke a waiver. Writes a revocation record; refuses double-revoke.

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

## `caws specs`

Manage CAWS spec lifecycle (create/list/show/recover/restore/retire-draft/prune-drafts/activate/amend-scope/close/archive/prune-archive/migrate/validate)

**Options:**

- `--status <status>` — Compatibility handoff to caws specs list --status <status>: active | draft | closed | archived
- `--data` — Show structured data block on diagnostics

### `caws specs create [id]`

Create a new spec in lifecycle_state: active.

**Argument:** `id` (optional) — Spec id to create

**Options:**

- `--id <id>` — Alias for the positional spec id
- `--title <title>` — Short spec title (required)
- `--mode <mode>` — Spec mode (required): feature | refactor | fix | doc | chore
- `--risk-tier <n>` — Risk tier (required): 1 | 2 | 3
- `--tier <n>` — Alias for --risk-tier; writes the canonical risk_tier field: 1 | 2 | 3
- `--scope-in <path>` (repeatable) — Populate scope.in at creation time (repeatable); avoids the YAML hand-edit. Widen later with `caws specs amend-scope`.
- `--scope.in <path>` (repeatable) — Alias for --scope-in using the YAML field name; writes canonical scope.in and is repeatable.
- `--acceptance <text>` (repeatable) — Seed an acceptance criterion at creation time (repeatable). Free text becomes the then clause; "given: ...; when: ...; then: ..." sets all fields.
- `--contract <spec>` (repeatable) — Add a contract at creation (repeatable), as "name:type[:path]" where type is api|schema|contract-test|behavior. Example: --contract "core-api:behavior". Tier 1/2 specs REQUIRE at least one contract; tier 3 / --mode chore do not.
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

### `caws specs retire-draft <id>`

Retire a never-activated DRAFT spec via tombstone. Refuses active (use close), closed (use archive), and archived specs. Deletes the draft YAML and appends a recoverable spec_retired event (recover via caws specs show <id> --archived). The governed alternative to raw git rm.

**Argument:** `id` (required) — Draft spec id to retire

**Options:**

- `--reason <text>` — Optional human-readable retirement note
- `--data` — Show structured data block on diagnostics

### `caws specs prune-drafts`

Plan or apply stale draft cleanup. Dry-run by default: classifies draft specs as candidates, skipped, or refused using age, include/exclude selectors, and worktree binding state. --apply retires only candidate drafts through the governed retire-draft path.

**Options:**

- `--older-than-ms <ms>` — Stale threshold in milliseconds (default: 604800000 = 7 days)
- `--include <ids>` — Comma-separated spec ids to include even when not stale
- `--exclude <ids>` — Comma-separated spec ids to exclude from the plan
- `--include-bound` — Allow bound draft specs to appear as candidates; default refuses bound drafts
- `--apply` — Retire selected candidate drafts. Requires --include or explicit --older-than-ms.
- `--reason <text>` — Optional retirement reason recorded on spec_retired events during --apply
- `--json` — Emit the draft cleanup plan as JSON
- `--data` — Show structured data block on diagnostics

### `caws specs activate <id>`

Activate a pre-authored draft spec. Draft-only: patches lifecycle_state to active and appends spec_activated.

**Argument:** `id` (required) — Draft spec id to activate

**Options:**

- `--data` — Show structured data block on diagnostics

### `caws specs amend-scope <id>`

Amend a spec's scope.in/scope.out/scope.support on the canonical control plane (active/draft only). The sanctioned way to add a path you need to edit — no git cherry-pick, no danger latch. Writes only canonical .caws/specs/<id>; scope check from a linked worktree admits the added path immediately. Comment-preserving; validate-before-write; appends spec_scope_amended.

**Argument:** `id` (required) — Active or draft spec id to amend

**Options:**

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

- `--resolution <r>` (default: `completed`) — Resolution: completed | superseded | abandoned
- `--reason <text>` — Closure notes recorded on the spec YAML and the spec_closed event
- `--closure-notes <text>` — Alias for --reason; writes closure_notes on the closed spec
- `--notes <text>` — Alias for --reason; compatibility shorthand for closure_notes
- `--merge-commit <sha>` — Optional merge commit SHA (e.g., when closure follows a worktree merge)
- `--superseded-by <id>` — Spec id that supersedes this one (use with --resolution superseded)
- `--data` — Show structured data block on diagnostics

### `caws specs archive [id]`

Archive one closed spec, or batch-archive closed specs with --status closed. Batch mode defaults to dry-run; pass --apply to archive selected specs in one aggregate audit commit.

**Argument:** `id` (optional) — Closed spec id to archive

**Options:**

- `--reason <text>` — Archive reason (advisory; the spec_archived event does not carry it)
- `--status <s>` — Batch selector status. Currently only: closed
- `--include <ids>` — Comma-separated spec ids to include in batch mode
- `--exclude <ids>` — Comma-separated spec ids to exclude from batch mode
- `--older-than-ms <ms>` — Batch selector: archive only closed specs whose updated_at/created_at age is at least this many milliseconds
- `--updated-before <timestamp>` — Batch selector: archive only closed specs whose updated_at/created_at timestamp is before this cutoff
- `--without-worktree` — Batch selector: archive only closed specs that do not still carry a worktree binding
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

- `--from <version>` (**required**) — Source schema version (only v10 is supported in v11.2)
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

## `caws worktree`

Manage CAWS worktrees (create/list/bind/destroy/untrack/merge/migrate-registry/repair-sparse/repair/prune/cleanup-plan). Worktrees are git worktrees bound to active specs.

### `caws worktree create <name>`

Create a new git worktree under .caws/worktrees/<name> bound to an active spec. Also links recognized git-ignored dependency/cache artifacts (node_modules, .pnpm-store, Python venvs, Rust target, Swift .build) from the canonical checkout into the worktree as relative symlinks, reported under an "Artifacts:" block with unlink/install guidance. Linking is advisory (create never fails on it), skips paths that already exist in the worktree, and skips on lock/manifest divergence. A linked artifact shares the canonical directory: run the printed unlink command before installing if the worktree branch changes dependency manifests.

**Argument:** `name` (required) — Worktree name

**Options:**

- `--spec <id>` (**required**) — Active spec id to bind the worktree to
- `--base-branch <branch>` — Base branch to start from (default: current branch)
- `--branch <branch>` — New branch name (default: worktree name)
- `--data` — Show structured data block on diagnostics

### `caws worktree list`

List registered worktrees with branch, spec binding, and owner.

**Options:**

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

Merge a worktree branch into its base. Auto-closes the bound spec via caws specs close.

**Argument:** `name` (required) — Worktree name

**Options:**

- `--dry-run` — Validate prerequisites only; no git, no file writes, no events
- `--message <text>` — Custom merge commit message (default: merge(worktree): <name>)
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

- `--state <classes>` — Comma-separated state-class filter (for example: ghost-registry,closed-spec-residue,event-orphan-refused).
- `--status <classes>` — Alias for --state <classes>; accepts the same state-class values.
- `--include <subjects>` — Comma-separated subjects to include (worktree names, spec ids, or paths).
- `--exclude <subjects>` — Comma-separated subjects to exclude (worktree names, spec ids, or paths).
- `--apply` — Apply only safe cleanup classes (ghost-registry, dead-binding, closed-spec-residue). Refused classes still do not mutate.
- `--json` — Emit the plan or apply outcome as JSON.
- `--data` — Show structured data block on diagnostics

### `caws worktree cleanup-plan`

Print a physical worktree cleanup plan. Dry-run by default. With --apply, requires an explicit selector and destroys only destroy-ready registered worktrees through the existing destroyWorktree path.

**Options:**

- `--state <classes>` — Comma-separated state-class filter (for example: destroy-ready,dirty-refused,foreign-owned-refused,unregistered-physical-refused).
- `--status <classes>` — Alias for --state <classes>; accepts the same state-class values.
- `--include <subjects>` — Comma-separated worktree names, spec ids, or paths to include.
- `--exclude <subjects>` — Comma-separated worktree names, spec ids, or paths to exclude.
- `--apply` — Apply selected destroy-ready candidates only. Requires --state, --include, or --exclude. Refused classes still do not mutate.
- `--json` — Emit the plan or apply outcome as JSON.
- `--data` — Show structured data block on diagnostics

## `caws agents`

Agent liveness substrate: register/heartbeat/stop/list/show/prune. Operational cache only — NEVER authority. CAWS-native JSON; never Claude Code hook envelope.

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
- `--stale-ttl-ms <ms>` — TTL for stale classification (default: 1800000 = 30m)
- `--json` — Emit CAWS-native JSON to stdout
- `--data` — Show structured data block on diagnostics

### `caws agents show <id>`

Show one lease by session id. Read-only.

**Argument:** `id` (required) — Session id of the lease to show

**Options:**

- `--json` — Emit CAWS-native JSON to stdout
- `--data` — Show structured data block on diagnostics

### `caws agents prune`

Operator-invoked cleanup. Defaults to dry-run; pass --apply to actually delete. Never invoked by hooks. Two modes: --dead (PID-liveness: remove active/stopping leases on THIS host whose owning process is gone — collapses the verify→stop→prune dance into one step), or --status <stopped|stale> --older-than-ms <ms> (retention-based).

**Options:**

- `--dead` — Remove leases whose owning process is dead (active/stopping, this host, pid not alive). Mutually exclusive with --status. Foreign-host leases are never touched.
- `--status <s>` — stopped | stale (required unless --dead)
- `--older-than-ms <ms>` — Retention threshold in milliseconds (required with --status)
- `--stale-ttl-ms <ms>` — TTL for stale classification (used with --status stale; default 30m)
- `--apply` — Actually delete (default: dry-run)
- `--json` — Emit CAWS-native JSON to stdout
- `--data` — Show structured data block on diagnostics

## `caws message`

Inter-agent message channel (AGENT-MESSAGE-CHANNEL-001): send/poll directed messages between running sessions, addressed by session id, over .caws/messages.jsonl. Separate from the events audit chain; not authority — a message body is an unverified claim.

### `caws message send`

Send a message to another session. Attributes the sender via this session's identity; refuses a recipient that is not live in the agent registry.

**Options:**

- `--to <session_id>` — Recipient session id (required)
- `--text <message>` — Message body (required, non-empty)
- `--allow-dead` — Send even if the recipient is not live in the registry (escape hatch; default off)
- `--data` — Show structured data block on diagnostics

### `caws message poll`

Pull the next undelivered message addressed to you. Deliver-once. Defaults --me to this session id.

**Options:**

- `--me <session_id>` — Endpoint to poll for (default: this session id)
- `--wait <ms>` — Block up to <ms> for a message before returning (long-poll; capped at 60000)
- `--peek` — Show the next message without consuming it (no delivery record)
- `--json` — Emit JSON ({message, waiting}) instead of human text
- `--data` — Show structured data block on diagnostics

### `caws message inbox`

List undelivered messages addressed to you without consuming them. Read-only; poll remains the delivery-consuming command.

**Options:**

- `--me <session_id>` — Endpoint inbox to list (default: this session id)
- `--limit <n>` — Maximum messages to print from the waiting queue
- `--json` — Emit JSON ({ok, read_only, me, waiting, messages})
- `--data` — Show structured data block on diagnostics

### `caws message history`

Show retained channel history between this session and another endpoint. Read-only; message bodies are communication, not authority.

**Options:**

- `--me <session_id>` — This endpoint (default: this session id)
- `--with <session_id>` — Other endpoint in the channel (required)
- `--limit <n>` — Maximum recent messages to print, preserving log order
- `--json` — Emit JSON ({ok, read_only, channel, total, messages})
- `--data` — Show structured data block on diagnostics

### `caws message prune`

Plan or apply retention cleanup for delivered non-authoritative chat messages. Dry-run by default; undelivered inbox messages are preserved.

**Options:**

- `--status <status>` (**required**) — Message retention selector: delivered
- `--older-than-ms <ms>` — Select delivered messages older than this many milliseconds
- `--include <ids>` — Comma-separated message ids to include
- `--exclude <ids>` — Comma-separated message ids to exclude
- `--apply` — Rewrite .caws/messages.jsonl to remove selected delivered messages and their delivery markers
- `--json` — Emit JSON prune plan/result
- `--data` — Show structured data block on diagnostics

## `caws prepush`

Classify the outgoing commit range before publish and refuse commits not attributable to the current slice. Diagnose/decide only — does NOT run git push.

**Options:**

- `--remote <remote>` (default: `origin`) — Push remote
- `--branch <branch>` (default: `main`) — Push branch
- `--base <ref>` — Base ref override (default <remote>/<branch>)
- `--spec <id>` — Current session active spec id (for slice-match)
- `--ack <sha>` (repeatable, default: `[]`) — Acknowledge an unexpected commit by SHA (repeatable)
- `--data` — Show structured data block on diagnostics
