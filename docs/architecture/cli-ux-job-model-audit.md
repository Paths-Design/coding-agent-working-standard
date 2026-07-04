---
doc_id: cli-ux-job-model-audit
authority: architecture
status: active
title: CAWS CLI UX job-model audit
owner: vNext rewrite team
updated: 2026-07-04
---

# CAWS CLI UX job-model audit

This audit reviews the current CLI surface as an operator experience, not as a
code inventory. The question is whether each top-level command exposes enough
of a job model for agents working in deep projects such as Sterling: discover
state, preview impact, select a subset, apply safely, recover, and repair or
clean up residue without hand-editing governed state.

Evidence used:

- `packages/caws-cli/src/shell/command-metadata.ts` via built
  `COMMAND_SURFACE_METADATA`
- live help from `caws <command> --help` and leaf `--help`
- structured agent session JSON under CAWS `.caws/sessions`, CAWS `tmp/`,
  and Sterling `.caws/sessions`
- prior field failures around archive, worktree repair, stale liveness, and
  closed worktree/spec residue

## Job Model

| UX job | Good CAWS pattern today | Why it matters |
|---|---|---|
| Discover | `list`, `show`, `status`, `doctor`, `--data`, `--json` | Agents need a cheap read path before deciding to mutate. |
| Explain refusal | `scope show/check/contention`, doctor repair text | A refusal should name the owner, subject, and next safe command. |
| Preview mutation | dry-run default or `--dry-run` | Bulk/cleanup commands should show the exact set before writes. |
| Select subset | `--status`, `--include`, `--exclude`, repeated flags | Large repos need narrow selectors instead of one-at-a-time loops. |
| Apply deliberately | `--apply` after preview | Separates analysis from mutation and keeps transcript reviewable. |
| Recover | `recover`, `show --archived`, immutable events | Cleanup must preserve an audit/recovery path where possible. |
| Repair | `repair`, `repair-sparse`, `migrate-registry` | Agents need sanctioned alternatives to hand edits. |
| Clean/untrack/delete | `destroy`, `archive`, `retire-draft`, `prune` | Removal jobs need explicit state classes and guardrails. |

The strongest current pattern is `agents prune` and the updated
`specs archive --status closed`: filter/select, dry-run by default, explicit
`--apply`, and optional machine-readable output. This pattern should become the
default for every cleanup or bulk lifecycle surface.

## Command Surface Audit

| Top-level command | Branches / leaves | Help commands and surfaced context | Current UX fit | Missing or uneven job model |
|---|---|---|---|---|
| `init` | flat leaf | `caws init --help` surfaces read-only `--plan`/`--json`, hook-pack install options, adoption/overwrite choices, diagnostics `--data`. | Good bootstrap model: idempotent, explicit adoption/overwrite semantics, and a preview path that reports canonical state, `.gitignore`, hook-pack, and settings actions before mutation. | Good model to copy. Future init UX should keep plan/apply sharing the same classifiers. |
| `doctor` | flat leaf | `caws doctor --help` surfaces `--data`, `--repair-plan`, and repair-plan JSON. Runtime output includes findings and repair text; repair-plan mode groups findings into state classes with subject, source rule, safe next command, and allowed mutation or refusal reason. | Strong discovery/repair-orientation model with machine-readable handoff. | Good model to copy. Future expansion should keep mutation delegated to existing lifecycle commands. |
| `status` | flat leaf | `caws status --help` surfaces `--data`, focused panel filters (`--specs`, `--worktrees`, `--agents`, `--doctor`), and JSON output. Runtime dashboard remains read-only; focused filters render only requested panels from the same composed snapshot. | Good orientation model with large-project filters. | Future status UX could add saved profiles, but the main scan-cost gap is closed. |
| `scope` | `show`, `check`, `plan`, `contention` | `caws scope --help` lists the path-focused leaves. Leaf help distinguishes observation, enforcement, batch planning, and cross-worktree contention; `show`, `check`, `plan`, and `contention` expose JSON. `show/check/plan` JSON includes structured remediation for common refusals. | Strong path-level refusal/explanation model: `scope check --json` preserves enforcement exit codes; `scope plan` evaluates many paths in one read-only run and groups remediation commands. | Good model to copy. Remaining gap is optional apply handoff ergonomics outside `scope`: `scope` now delegates mutation to `specs amend-scope` by design. |
| `claim` | flat leaf | `caws claim --help` surfaces `--takeover`, read-only `--plan`, JSON output, `--release-paths --apply`, repeatable `--paths`, and diagnostics. | Good ownership surfacing and lease path-claim lifecycle: takeover remains explicit/audited, takeover impact can be previewed without mutation, and current-session lease path claims can be released through a dry-run/apply path. | Good model to copy. Future ownership UX should keep worktree authority (`worktrees.json`) separate from lease path metadata. |
| `gates` | `list`, `explain`, `run` | `caws gates --help`, `caws gates list --help`, `caws gates explain --help`, and `caws gates run --help` surface read-only policy discovery before mutation. `list` reports configured gates, modes, thresholds, risk-tier budgets, and effective waiver ids; `explain` expands one gate; `run` appends gate evidence. | Stronger governed-check model: agents can inspect policy modes and waiver matches before running evaluators or writing `gate_evaluated` events. | Good model to copy. Remaining gate gap is historical trend/readback across prior gate_evaluated evidence, which may belong under `evidence` or a future dashboard. |
| `evidence` | `record`, `list`, `show`, `schema` | Help surfaces typed `--type`, `--spec`, JSON payload, actor fields, read-only list filters, JSON output, event-ref lookup by seq/hash/prefix, and kernel-derived payload schema discovery. | Strong read/write symmetry: evidence can be appended, inspected, and prepared with a copy-pasteable schema/example path without direct `events.jsonl` parsing. | Good model to copy. Remaining gap is broader event-log discovery under `events`, not typed evidence inspection. |
| `events` | `list`, `show`, `migrate`, `rotate`, `verify-archive` | Group help lists read and maintenance leaves. `list` verifies the chain and reports counts/latest/rotation archive status; `show` resolves seq/hash/prefix/latest-rotation; `migrate` has `--apply`; `rotate` requires `--reason` and supports `--dry-run`/`--json`; `verify-archive` is read-only. | Stronger audit-log model: operators can discover current chain state and rotation history before rotate/verify operations. | Good model to copy. Remaining event-log gap is retention/prune policy, which should stay separate from rotate/archive verification. |
| `waiver` | `create`, `list`, `show`, `revoke`, `prune` | Help covers CRUD-like waiver lifecycle; create/revoke require audit metadata, create supports dry-run validation, and prune exposes expired-waiver cleanup as dry-run/apply with JSON. | Stronger exception lifecycle model: operators can preview candidate creation and clean expired active waivers without hand-editing waiver files. | Good model to copy. Remaining gap is richer waiver matching diagnostics from a gate violation back to candidate waiver scope. |
| `specs` | `create`, `list`, `show`, `recover`, `restore`, `retire-draft`, `prune-drafts`, `activate`, `amend-scope`, `close`, `archive`, `prune-archive`, `migrate`, `validate` | Group help now names every leaf. Leaf help exposes lifecycle state transitions, create preflight, restore dry-run/apply, draft cleanup dry-run/apply, batch archive selectors, migration apply/partial, and file-path validation. Archive batch mode now supports include/exclude, age/date selectors, and worktree-binding exclusion. | Strong lifecycle surface after the archive and draft-prune fixes: scoped creation, read-only create planning, governed scope amendment, recover/restore, guarded draft prune apply, batch archive with refined selectors, migration preview/apply. | Good model to copy. Remaining spec lifecycle gaps are smaller refusal-handoff improvements, such as turning draft-bind refusal into a direct `specs activate` handoff. |
| `worktree` | `create`, `list`, `bind`, `destroy`, `untrack`, `merge`, `migrate-registry`, `repair-sparse`, `repair`, `prune`, `cleanup-plan` | Group help lists lifecycle, untrack, migration, sparse repair, control-plane repair, doctor-evidence prune, and physical cleanup planning/apply. Leaf help distinguishes create vs bind, dry-run merge, destroy guardrails, untrack dry-run/apply, repair dry-run, prune dry-run/apply, cleanup-plan dry-run, and guarded cleanup-plan apply. | Strong lifecycle and cleanup model. `prune` covers safe control-plane residue classes, `untrack` preserves files after releasing a CAWS binding, and `cleanup-plan` classifies real git worktrees by clean/dirty, merged/unmerged, bound lifecycle, ownership, and registry presence. `cleanup-plan --apply` requires explicit selectors and destroys only `destroy-ready` items through `destroyWorktree`. | Good model to copy. Future expansion could consider `unbound-clean-candidate` apply, but only after field evidence proves it is safe. |
| `agents` | `register`, `heartbeat`, `stop`, `list`, `show`, `prune` | Help exposes hook-writer verbs, read-only list/show, JSON, stale TTLs, `--dead`, retention filters, dry-run default, `--apply`. | Best cleanup UX model in the CLI. It cleanly separates display-only stale state from deletion and supports machine output. | Good model to copy. Minor gap: no `explain <id>` that says why a lease is active/stale/stopped/dead, but list/show largely cover it. |
| `message` | `send`, `poll` | Help surfaces directed send, optional dead recipient escape hatch, poll wait/peek/JSON. | Adequate communication model and correctly says messages are not authority. | No inbox/list/history management or prune/retention surface. That may be intentional, but long-running projects will accumulate message-log state. |
| `prepush` | flat leaf | `caws prepush --help` surfaces remote/branch/base/spec/ack and diagnostics. | Good preflight model; `--ack` is an explicit exception path. | No "write an ack file" or "explain all unexpected commits grouped by spec/worktree" model for large ranges. |

## Parity Gaps by Job

| Job-to-be-done | Current command that mostly fits | Similar CAWS command with better UX | Gap | Candidate model |
|---|---|---|---|---|
| Bulk archive closed specs | `specs archive --status closed --include/--exclude --older-than-ms/--updated-before/--without-worktree --apply` | `agents prune --status ... --apply` | Now closed for refined closed-spec selection: dry-run/apply share the same governed selector path and apply archives only selected closed specs. | Future archive UX should focus on reporting/history, not broader deletion semantics. |
| Clean up stale/dead worktree control-plane residue | `worktree repair --dry-run` | `agents prune --dead/--status --older-than-ms --apply` | `repair` only mutates unambiguous half-states. It does not clean real worktree dirs, closed residue, or event-backed orphans. | Add `worktree prune` as a dry-run default with state classes: `ghost-registry`, `closed-spec-residue`, `merged-clean`, `dead-directory`, `event-orphan-refused`; require `--apply` and refuse ambiguous classes. |
| Destroy multiple worktrees safely | `worktree cleanup-plan --state destroy-ready --apply` | `specs archive --include/--exclude` | Now closed for the conservative class: apply requires explicit selectors and invokes `destroyWorktree` for each selected `destroy-ready` candidate. | Future expansion can consider `unbound-clean-candidate` only with the same selector/default-dry-run guardrails. |
| Untrack without deleting files | `worktree untrack <name> --reason ... --apply` | `worktree repair` clears dead bindings but only by doctor class | Now closed for single registered worktrees: dry-run default, required reason, clean/owned/existing-directory preconditions, and `worktree_untracked` audit evidence. | Future batch cleanup can compose this model, but should remain separate from physical deletion. |
| Restore an archived spec body | `specs recover <id> --out`, `specs restore <id> --as draft|active [--apply]` | `specs activate`, `specs amend-scope` | Now closed for explicit restore: dry-run by default, refuses overwrite, clears stale terminal/worktree fields, validates planned draft/active YAML, and appends `spec_restored` on apply. | Good model to copy for lifecycle resurrection: keep recovery read-only, make restore explicit, and strip stale authority before reactivation. |
| Convert a refusal into next command | `scope check --json`, `scope plan`, doctor repair text | `specs amend-scope` | Now closed for single-path and batch scope planning: JSON and human output include remediation commands for scope.in misses, root refusals, one-sided/unbound authority, and ambiguous claimants; batch output groups repeated commands. | Keep mutation delegated to existing lifecycle commands. |
| Inspect evidence history and payload shape | `evidence list/show/schema` | `waiver list/show`, `agents list/show` | Now closed for typed evidence events: list filters by spec/type, show resolves seq/hash/prefix after chain verification, and schema derives required payload fields from the kernel contracts. | Use this read/write/schema loop as a model for other append-heavy commands. |
| Rotate audit chain safely | `events list/show`, `events rotate --dry-run --reason ...`, `events verify-archive` | `events migrate --apply` | Now closed for first-order preview/read/verify parity: list/show summarize current chain and rotation archive status, rotate dry-run reports target archive path/line count/digest/stats/genesis, and verify-archive confirms archived bytes. | Future retention/prune semantics should be designed separately from rotation verification. |
| Clean expired waivers safely | `waiver prune --status expired [--apply]` | `agents prune --status ... --apply` | Now closed for expired active waivers: prune defaults to dry-run, supports JSON, and apply requires revocation audit metadata. | Future waiver UX should focus on explaining which waiver scope would match a gate violation, not broad deletion. |
| Retire stale draft specs in bulk | `specs prune-drafts --older-than-ms ... --apply`, `specs retire-draft <id>` | `specs archive --status closed --include/--exclude --apply` | Now closed for guarded apply: dry-run remains default, apply requires `--include` or explicit `--older-than-ms`, bound drafts stay refused unless `--include-bound`, refused plans do not mutate, and candidates retire through `retireDraftSpec` with one aggregate audit commit. | Future spec lifecycle UX should focus on refusal handoff and history/readback, not broader deletion semantics. |
| Plan tiered spec creation | `specs create --plan` | `waiver create --dry-run`, `events rotate --dry-run` | Now closed for creation preflight: plan validates the same candidate as create, reports missing semantic fields, supports JSON, and writes no spec/event state. | Future creation UX can add templates, but the read-only preflight is the durable base. |

## Session Evidence

I mined three transcript locations for actual `caws ...` command attempts:

- CAWS canonical `.caws/sessions`
- CAWS rendered/temporary session logs in `tmp/`
- Sterling `.caws/sessions`

The extractor read structured turn JSON (`refs.commands[]` or timeline tool
calls), selected commands matching `caws <top-level>`, and classified common
friction strings in command output. The linked worktree used for this audit did
not materialize canonical `.caws/sessions`, so the session mining was run from
the canonical checkout and Sterling checkout.

### Aggregate Counts

| Source | CAWS command attempts | Attempts with friction markers |
|---|---:|---:|
| CAWS `.caws/sessions` | 710 | 76 |
| CAWS `tmp/` rendered sessions | 1,319 | 132 |
| Sterling `.caws/sessions` | 8,752 | 447 |
| **Total** | **10,781** | **655** |

By top-level command:

| Top-level command | Attempts | Friction-marked attempts |
|---|---:|---:|
| `specs` | 4,541 | 279 |
| `worktree` | 3,606 | 171 |
| `scope` | 822 | 123 |
| `status` | 558 | 15 |
| `agents` | 400 | 29 |
| `gates` | 390 | 8 |
| `claim` | 107 | 6 |
| `doctor` | 96 | 5 |
| `message` | 87 | 4 |
| `init` | 79 | 8 |
| `evidence` | 68 | 6 |
| `prepush` | 15 | 1 |
| `events` | 8 | 0 |
| `waiver` | 4 | 0 |

### Friction Classes

| Friction marker | Count | UX implication |
|---|---:|---|
| `no_scope_authority` | 126 | Agents frequently ask scope questions from canonical/unbound contexts and then need a bridge to "what command gets me into an authoritative context?" |
| `unknown_or_missing_option` | 91 | Help/flag discoverability still creates retries, especially when command shapes are close but not parallel. |
| `tier_requires_metadata` | 87 | `specs create` for tier 1/2 has required semantic fields that are not fully expressible through current flags, so agents discover requirements by failure. |
| `danger_latch` | 66 | CAWS hook UX still matters for CLI workflows; blocked shell forms often interrupt otherwise correct CAWS procedures. |
| `worktree_not_found` | 62 | Agents repeatedly try `worktree destroy <name>` after merge/closure or for residue that is no longer a registered CAWS worktree. |
| `merge_failed` | 43 | Merge is a complex mutating job; failed merges need better plan/state output and post-failure recovery guidance. |
| `missing_bulk_archive` | 19 | This is the exact class fixed by batch `specs archive`; agents had to inspect help, count closed specs, and infer that no bulk path existed. |
| `contract_arg_invalid` | 14 | Contract tuple syntax is easy to invert; help should show examples and `specs create` should give a corrected form. |
| `draft_spec_create_refused` | 13 | Agents try to bind draft specs to worktrees; the next command is `specs activate`, but the flow is not yet a guided handoff. |
| `evidence_schema_rejected` | 10 | Fixed by `evidence schema --type <kind>` and per-kind `evidence record --help` examples. |
| `already_closed_close_refused` | 7 | Agents try to close specs that are already closed; common next jobs are archive, recover, or inspect closure state. |
| `parse_error` | 6 | Shell quoting and hook parsing failures still interrupt otherwise valid CAWS workflows. |
| `not_a_git_repo` | 1 | Rare compared with state-model misses. |

### Representative Patterns

| Pattern | Representative observed output | Missing model |
|---|---|---|
| Bulk archive absence | `caws specs archive --help` showed only `Usage: caws specs archive [options] <id>` while the session counted 1,326 closed specs and then asked whether there was a bulk path. | Fixed by batch archive; copy its selector/dry-run/apply model. |
| Worktree cleanup residue | `caws worktree destroy: failed... Worktree "..." not found in registry` after merge/closure verification. | A `worktree prune` or cleanup-plan state model for closed residue, dead dirs, and unregistered leftovers. |
| Scope from canonical checkout | `NO AUTHORITY scope.no_authority.unbound ... No spec is bound to this worktree`. | A guided bridge from "no authority" to `worktree create`, `worktree bind`, or `specs amend-scope`, depending on intent. |
| Draft spec binding | `Spec "..." is in lifecycle_state "draft"; only active specs can be bound to a new worktree.` | The refusal should include the safe next command: `caws specs activate <id>` or explain why activation is not safe. |
| Already-closed close | `Spec "..." is in lifecycle_state "closed"; only active specs can be closed.` | State-aware alternatives: `archive`, `show`, `recover`, or no-op success when closure already matches requested metadata. |
| Tier metadata failure | `Tier 1 specs require non-empty observability... rollback... contract.` | `specs create --help` needs complete tier-1/2 examples or a `--template tier1`/interactive plan output. |
| Contract tuple inversion | `invalid --contract "behavior:verifychain-detects-tamper": type "verifychain-detects-tamper" is not one of ...` | Error should print the accepted tuple shape and a corrected example. |
| Evidence schema rejection | `data: must have required property 'command'` for `evidence record --type test`. | Fixed by `evidence schema --type test` plus per-type examples in `evidence record --help`. |

## Implementation Ledger

| Slice | Status | Scope | Evidence |
|---|---|---|---|
| `UX-CLI-SPECS-CREATE-HELP-001` | Implemented in first repair slice | `specs create` help metadata and invalid `--contract` diagnostics | Adds an inline `--contract "core-api:behavior"` example to nested help metadata; invalid inverted tuples such as `behavior:verifychain-detects-tamper` now print the accepted tuple shape and a corrected `--contract "verifychain-detects-tamper:behavior"` suggestion. Covered by `packages/caws-cli/tests/shell/specs-create-ux.test.js`. |
| `UX-WORKTREE-CLEANUP-PLAN-001` | Implemented in second repair slice | `worktree prune` read-only cleanup planning | Adds `caws worktree prune` as a non-mutating plan command over doctor evidence, with `--state`, `--include`, `--exclude`, and `--json`. The plan exposes subject, state class, source rule, allowed mutation or refusal reason, and next safe command without touching `worktrees.json`, specs, events, or git worktree directories. Covered by `packages/caws-cli/tests/shell/worktree-cleanup-plan.test.js`. |
| `UX-WORKTREE-PRUNE-APPLY-001` | Implemented in third repair slice | `worktree prune --apply` for repairable classes | Adds explicit apply mode to `caws worktree prune`. Dry-run remains default; `--apply` mutates only `ghost-registry`, `dead-binding`, and `closed-spec-residue` through the same writer paths proven by `caws worktree repair`. Refused classes such as event orphans and stale-owner drift remain non-mutating and return nonzero when selected. Covered by `packages/caws-cli/tests/shell/worktree-cleanup-plan.test.js`. |
| `UX-WORKTREE-UNTRACK-001` | Implemented in fourth repair slice | `worktree untrack` control-plane release while preserving files | Adds `caws worktree untrack <name> --reason ... [--apply] [--json]`. Dry-run remains default; apply requires a reason, admitted ownership, an existing clean physical worktree directory, and clears only registry/spec bindings while preserving files. Successful apply appends `worktree_untracked`. Covered by `packages/caws-cli/tests/shell/worktree-untrack.test.js`. |
| `UX-EVIDENCE-READBACK-001` | Implemented in fifth repair slice | `evidence list/show` read-only evidence inspection | Adds `caws evidence list --spec <id> [--type <kind>] [--json]` and `caws evidence show <event-ref> [--json]`. Both commands load through the event store, verify the hash chain, leave `events.jsonl` byte-identical, and expose stable seq/hash handles. Covered by `packages/caws-cli/tests/shell/evidence-readback.test.js`. |
| `UX-EVENTS-ROTATE-DRY-RUN-001` | Implemented in sixth repair slice | `events rotate --dry-run` audit-storage preview | Adds `caws events rotate --dry-run --reason <text> [--allow-clean] [--json]`. The preview computes the target archive path, prior digest, line count, prior-chain status, actor-shape stats, and `chain_rotated` genesis event without renaming, archiving, appending, or rewriting `events.jsonl`. Covered by `packages/caws-cli/tests/shell/events-rotate-dry-run.test.js`. |
| `UX-EVIDENCE-SCHEMA-DISCOVERY-001` | Implemented in seventh repair slice | `evidence schema` read-only payload discovery | Adds `caws evidence schema --type <test|gate|ac> [--json]` and per-kind `evidence record --help` examples. The schema command validates invalid kinds before filesystem reads, derives required fields and properties from the kernel event payload schemas, emits copy-pasteable record commands, and never reads or writes `.caws/events.jsonl`. Covered by `packages/caws-cli/tests/shell/evidence-schema.test.js`. |
| `UX-EVENTS-LOG-DISCOVERY-001` | Implemented in eighth repair slice | `events list/show` read-only event-log discovery | Adds `caws events list [--limit <n>] [--json]` and `caws events show <event-ref|latest-rotation> [--json]`. Both commands load through the event store, verify the current hash chain, leave `events.jsonl` byte-identical, and report rotation archive presence plus digest/line-count match when applicable. Covered by `packages/caws-cli/tests/shell/events-log-discovery.test.js`. |
| `UX-GATES-POLICY-DISCOVERY-001` | Implemented in ninth repair slice | `gates list/explain` read-only policy discovery | Adds `caws gates list [--spec <id>] [--json]` and `caws gates explain <gate> [--spec <id>] [--json]`. Both commands compose the store snapshot, derive gate ids/modes/thresholds/risk-tier budgets from policy, use kernel waiver applicability for spec-scoped effective waiver ids, and never append `gate_evaluated` events. Covered by `packages/caws-cli/tests/shell/gates-policy-discovery.test.js`. |
| `UX-WAIVER-LIFECYCLE-PREFLIGHT-001` | Implemented in tenth repair slice | `waiver create --dry-run` and expired-waiver prune | Adds `caws waiver create --dry-run [--json]` and `caws waiver prune --status expired [--apply] [--json]`. Create dry-run validates the candidate and duplicate id without writing `.caws/waivers/`; prune dry-run prints the exact expired active target set; apply requires `--reason` and `--revoked-by` and revokes only selected expired active waivers through the existing store writer. Covered by `packages/caws-cli/tests/shell/waiver-lifecycle-preflight.test.js`. |
| `UX-SCOPE-REMEDIATION-GUIDANCE-001` | Implemented in eleventh repair slice | `scope check --json` and refusal remediation | Adds `caws scope check <path> --json` with the same decision contract as `scope show --json`, plus an optional `remediation` object. Human and JSON output now hand off to existing governed commands for scope.in misses/root refusals, scope.out exclusions, one-sided bindings, unbound worktrees, and ambiguous claimants without mutating from `scope`. Covered by `packages/caws-cli/tests/shell/scope-remediation-guidance.test.js`. |
| `UX-SPECS-CREATE-PLAN-001` | Implemented in twelfth repair slice | `specs create --plan` read-only creation preflight | Adds `caws specs create <id> ... --plan [--json]`. Plan mode reuses the create renderer and kernel parser, reports missing semantic fields such as `/contracts`, `/observability`, `/rollback`, and `/non_functional/security`, returns a copy-pasteable create command, and writes no spec files, events, or worktree registry entries. Covered by `packages/caws-cli/tests/shell/specs-create-plan.test.js`. |
| `UX-SCOPE-BATCH-PLAN-001` | Implemented in thirteenth repair slice | `scope plan` read-only batch path planning | Adds `caws scope plan --path <path>... [--paths-file <file>] [--json]`. The command evaluates each path through the same binding/kernel/remediation path as `scope show/check`, ignores blank/comment lines in path files, leaves CAWS state untouched, and groups repeated remediation commands such as multi-path `caws specs amend-scope <id> --add ...`. Covered by `packages/caws-cli/tests/shell/scope-batch-plan.test.js`. |
| `UX-SPECS-RESTORE-PLAN-001` | Implemented in fourteenth repair slice | `specs restore` governed archived/retired spec restoration | Adds `caws specs restore <id> --as <draft|active> [--apply] [--json]`. Restore defaults to a read-only plan, refuses to overwrite existing canonical specs, strips terminal lifecycle/worktree fields before validation, and appends typed `spec_restored` evidence on apply. Covered by `packages/caws-cli/tests/shell/specs-restore.test.js` and `packages/caws-kernel/tests/unit/spec-restored-event-contract.test.ts`. |
| `UX-SPECS-DRAFT-PRUNE-PLAN-001` | Implemented in fifteenth repair slice | `specs prune-drafts` read-only stale draft cleanup planning | Adds `caws specs prune-drafts [--older-than-ms <ms>] [--include <ids>] [--exclude <ids>] [--include-bound] [--json]`. The command classifies draft specs as candidates/skipped/refused using age, explicit selectors, and worktree binding state, and writes no spec files, events, or registry entries. Covered by `packages/caws-cli/tests/shell/specs-prune-drafts.test.js`. |
| `UX-WORKTREE-PHYSICAL-CLEANUP-PLAN-001` | Implemented in sixteenth repair slice | `worktree cleanup-plan` read-only physical worktree cleanup planning | Adds `caws worktree cleanup-plan [--state <classes>] [--include <subjects>] [--exclude <subjects>] [--json]`. The command classifies registered and unregistered physical git worktrees by clean/dirty, merged/unmerged, bound spec lifecycle, ownership, and registry presence, names the safe next command, and writes no registry, spec, event, or git worktree state. Covered by `packages/caws-cli/tests/shell/worktree-physical-cleanup-plan.test.js`. |
| `UX-WORKTREE-PHYSICAL-CLEANUP-APPLY-001` | Implemented in seventeenth repair slice | `worktree cleanup-plan --apply` guarded physical cleanup | Adds guarded apply to `caws worktree cleanup-plan`. Apply refuses unfiltered runs, mutates only selected `destroy-ready` registered worktrees, re-enters `destroyWorktree` for every deletion, and reports selected refused classes without mutation. Covered by `packages/caws-cli/tests/shell/worktree-physical-cleanup-plan.test.js`. |
| `UX-SPECS-ARCHIVE-SELECTORS-001` | Implemented in eighteenth repair slice | `specs archive --status closed` refined selectors | Adds `--older-than-ms`, `--updated-before`, and `--without-worktree` to batch archive. Dry-run and apply share the store selector, included non-matches report skip reasons, and apply archives only selected closed specs through the existing archive path. Covered by `packages/caws-cli/tests/store/specs-archive-batch-selector.test.js` and `packages/caws-cli/tests/shell/specs-archive-batch.test.js`. |
| `UX-SPECS-DRAFT-PRUNE-APPLY-001` | Implemented in nineteenth repair slice | `specs prune-drafts --apply` guarded stale draft retirement | Adds `--apply` and optional `--reason` to `caws specs prune-drafts`. Apply requires `--include` or explicit `--older-than-ms`, refuses selected plans with refused entries without mutation, retires only candidates through `retireDraftSpec`, and creates one aggregate audit commit for the batch. Covered by `packages/caws-cli/tests/shell/specs-prune-drafts.test.js`. |
| `UX-DOCTOR-REPAIR-PLAN-001` | Implemented in twentieth repair slice | `doctor --repair-plan` read-only finding handoff | Adds `caws doctor --repair-plan [--json]`. The plan is derived from the same composed snapshot and doctor findings as normal doctor output, writes no governed state, and emits one item per finding with state class, source rule, subject, safe next command, and allowed mutation or refusal reason. Covered by `packages/caws-cli/tests/shell/doctor-plan.test.js`. |
| `UX-STATUS-FOCUSED-FILTERS-001` | Implemented in twenty-first repair slice | `status` focused read-only panels | Adds `caws status --specs/--worktrees/--agents/--doctor [--json]`. Default `caws status` remains the full dashboard; focused filters render only requested panels from the same snapshot, and JSON includes the selected panel payloads with `read_only: true`. Covered by `packages/caws-cli/tests/shell/status-filters.test.js`. |
| `UX-INIT-PREVIEW-PLAN-001` | Implemented in twenty-second repair slice | `init --plan` read-only bootstrap preview | Adds `caws init --plan [--json]`. The plan reuses canonical-state, `.gitignore`, hook-pack, and settings classifiers without creating `.caws`, `.gitignore`, hook files, settings files, or events, and reports refusal reasons plus the next apply command. Covered by `packages/caws-cli/tests/shell/init-plan.test.js`. |
| `UX-CLAIM-RELEASE-PREVIEW-001` | Implemented in twenty-third repair slice | `claim --plan` and `claim --release-paths` | Adds `caws claim --plan [--json]` for read-only ownership/takeover impact preview and `caws claim --release-paths [--apply] [--json]` for dry-run/apply clearing of the current session lease `claimed_paths`. The release path writes only through the lease store and does not mutate worktree ownership, specs, events, or git state. Covered by `packages/caws-cli/tests/shell/claim-release-preview.test.js`. |

## Next Slice

The next implementation slice should address `message` log management.
`message send/poll` appends and consumes directed messages, but agents do not
yet have an inbox/list/history/prune surface for long-running projects. Add
read-only listing/history first, then a guarded retention/prune model if the
state classes are unambiguous.

## Findings

1. **The CLI has a good cleanup UX pattern, but it is not consistently applied.**
   `agents prune`, batch `specs archive`, and `specs prune-drafts --apply` have the right operator shape:
   filter, preview, explicit apply, and JSON. Cleanup-heavy surfaces under
   `worktree` and `specs` now share that model.

2. **Worktree cleanup now has the right diagnosis/apply split.**
   `worktree repair` handles safe control-plane half-states, `prune` plans and
   applies repairable doctor residue, `untrack` releases a binding while
   preserving files, and `cleanup-plan` classifies real git worktrees. Guarded
   `cleanup-plan --apply` now destroys only selected `destroy-ready` candidates
   through the existing destroy writer.

3. **Physical worktree cleanup no longer needs a second deletion engine.**
   `worktree cleanup-plan` reports cleanliness, merge state, binding lifecycle,
   ownership, registry presence, refusal reasons, and next commands. Its apply
   path reuses `destroyWorktree`, so ownership, clean checkout, and merged
   branch checks are authoritative at mutation time.

4. **Doctor now publishes a repair-plan taxonomy.**
   `doctor --repair-plan` gives agents a read-only handoff from finding to
   state class, subject, next command, allowed mutation, or refusal reason.
   Mutation stays delegated to existing lifecycle commands such as
   `worktree prune`, `waiver prune`, and `worktree create`.

5. **Status scan cost is closed for large projects.**
   `status --specs/--worktrees/--agents/--doctor` lets agents ask for just
   the relevant orientation panel, and `--json` exposes the same selection
   for scripted workflows.

6. **Init now has a preview-before-mutation path.**
   `init --plan` lets agents inspect canonical bootstrap, gitignore, hook-pack,
   and settings wiring decisions before any filesystem writes. This closes the
   install-plan gap and gives other setup commands a model for shared
   classifier plan/apply implementation.

7. **Claim now separates ownership preview from lease path release.**
   `claim --plan` previews takeover impact and prior-owner audit rows without
   writing `worktrees.json`; `claim --release-paths` defaults to a dry-run and
   `--apply` clears only the current session lease `claimed_paths`.

8. **Read/write/schema symmetry is still uneven outside evidence.**
   `evidence record/list/show/schema` now has an append/read/schema loop, but `message
   send/poll` can append and consume messages without a broader log-management
   surface. That may be acceptable for narrow workflows, but it is weak for
   audit-driven agent projects.

9. **Help context is now closer to reality, but nested help should keep naming
   adjacent alternatives.** The recent `specs archive` and `specs validate`
   fixes show that group and leaf help need to explain neighboring commands:
   archive vs recover, create vs amend-scope, repair vs destroy, prune vs
   repair. Agents use help as a decision tree, not only as an option list.

## Recommendations

1. Promote the prune/archive UX contract to a doctrine pattern:
   cleanup commands default to dry-run, accept explicit selectors, print the
   exact target set, require `--apply`, and expose JSON.

2. Design `caws worktree prune` around state classes, not a broad delete:
   `ghost-registry`, `dead-binding`, `closed-spec-residue`, `merged-clean`,
   `dirty-refused`, `foreign-owned-refused`, `event-orphan-refused`.

3. Keep `worktree cleanup-plan` read-only and separate from `worktree prune`.
   `prune` is doctor/control-plane cleanup; `cleanup-plan` is physical git
   worktree classification.

4. Add `message` inbox/history mode:
   keep messages non-authoritative, but give agents a read-only way to list
   inbox/history entries and inspect retained message state before any prune
   semantics are designed.

5. Add help regression tests for any group description that names subcommands
   and for cleanup leaves that claim dry-run/apply semantics. The CLI already
   has metadata-driven help; the gap is asserting the UX promises that agents
   rely on.

6. Add remaining lifecycle cleanup designs only after their state semantics are
   explicit: batch stale-draft retirement apply and batch physical worktree
   deletion need separate plan/apply guardrails.
