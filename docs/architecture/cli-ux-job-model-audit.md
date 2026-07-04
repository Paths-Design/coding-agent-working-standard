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
| `init` | flat leaf | `caws init --help` surfaces hook-pack install options, adoption/overwrite choices, diagnostics `--data`. | Good bootstrap model: idempotent, explicit adoption/overwrite semantics. | No dry-run/advice mode for "what would init install or overwrite?" A preview would match package managers' install-plan UX. |
| `doctor` | flat leaf | `caws doctor --help` surfaces `--data`; runtime output includes findings and repair text. | Strong discovery/repair-orientation model. | Findings are not yet directly actionable as a generated plan. Agents still translate doctor classes into separate commands manually. |
| `status` | flat leaf | `caws status --help` surfaces `--data`; runtime dashboard is read-only. | Good orientation model. | No focused filters (`--worktrees`, `--agents`, `--specs`) for large projects; agents may parse a broad dashboard. |
| `scope` | `show`, `check`, `contention` | `caws scope --help` lists the three path-focused leaves. Leaf help distinguishes observation, enforcement, and cross-worktree contention; `show`/`contention` expose JSON. | Strong path-level refusal/explanation model. | No batch path check and no direct "amend this spec to admit these paths" handoff. The repair model lives in `specs amend-scope`, but the scope refusal does not produce a ready command. |
| `claim` | flat leaf | `caws claim --help` surfaces `--takeover`, repeatable `--paths`, and diagnostics. | Good ownership surfacing. Takeover is explicit and audited. | No release/clear path for path claims. No preview of a takeover's impact beyond the refusal text. |
| `gates` | `list`, `explain`, `run` | `caws gates --help`, `caws gates list --help`, `caws gates explain --help`, and `caws gates run --help` surface read-only policy discovery before mutation. `list` reports configured gates, modes, thresholds, risk-tier budgets, and effective waiver ids; `explain` expands one gate; `run` appends gate evidence. | Stronger governed-check model: agents can inspect policy modes and waiver matches before running evaluators or writing `gate_evaluated` events. | Good model to copy. Remaining gate gap is historical trend/readback across prior gate_evaluated evidence, which may belong under `evidence` or a future dashboard. |
| `evidence` | `record`, `list`, `show`, `schema` | Help surfaces typed `--type`, `--spec`, JSON payload, actor fields, read-only list filters, JSON output, event-ref lookup by seq/hash/prefix, and kernel-derived payload schema discovery. | Strong read/write symmetry: evidence can be appended, inspected, and prepared with a copy-pasteable schema/example path without direct `events.jsonl` parsing. | Good model to copy. Remaining gap is broader event-log discovery under `events`, not typed evidence inspection. |
| `events` | `list`, `show`, `migrate`, `rotate`, `verify-archive` | Group help lists read and maintenance leaves. `list` verifies the chain and reports counts/latest/rotation archive status; `show` resolves seq/hash/prefix/latest-rotation; `migrate` has `--apply`; `rotate` requires `--reason` and supports `--dry-run`/`--json`; `verify-archive` is read-only. | Stronger audit-log model: operators can discover current chain state and rotation history before rotate/verify operations. | Good model to copy. Remaining event-log gap is retention/prune policy, which should stay separate from rotate/archive verification. |
| `waiver` | `create`, `list`, `show`, `revoke` | Help covers CRUD-like waiver lifecycle; create/revoke require audit metadata. | Good exception lifecycle model. | No dry-run validation for `create`, and no `prune expired` cleanup model. |
| `specs` | `create`, `list`, `show`, `recover`, `retire-draft`, `activate`, `amend-scope`, `close`, `archive`, `prune-archive`, `migrate`, `validate` | Group help now names every leaf. Leaf help exposes lifecycle state transitions, batch archive selectors, migration apply/partial, and file-path validation. | Strongest lifecycle surface after the archive fix: scoped creation, governed scope amendment, recover, batch archive, migration preview/apply. | Missing a general lifecycle cleanup model across states: e.g. "archive all closed older than X", "retire all stale drafts", "restore archived body to a chosen path/state". `recover` is read/output only; there is no governed `restore`. |
| `worktree` | `create`, `list`, `bind`, `destroy`, `untrack`, `merge`, `migrate-registry`, `repair-sparse`, `repair`, `prune` | Group help lists lifecycle, untrack, migration, sparse repair, control-plane repair, and cleanup planning. Leaf help distinguishes create vs bind, dry-run merge, destroy guardrails, untrack dry-run/apply, repair dry-run, and prune dry-run/apply. | Improved single-worktree lifecycle and targeted cleanup model. `prune` now covers safe repairable residue classes, while `untrack` covers preserving files after releasing a CAWS binding. | Still missing batch destroy/cleanup over real worktrees by merged/clean/closed state. `repair` and `prune` intentionally do not remove real git worktree directories, so batch physical deletion needs a separate plan/apply model. |
| `agents` | `register`, `heartbeat`, `stop`, `list`, `show`, `prune` | Help exposes hook-writer verbs, read-only list/show, JSON, stale TTLs, `--dead`, retention filters, dry-run default, `--apply`. | Best cleanup UX model in the CLI. It cleanly separates display-only stale state from deletion and supports machine output. | Good model to copy. Minor gap: no `explain <id>` that says why a lease is active/stale/stopped/dead, but list/show largely cover it. |
| `message` | `send`, `poll` | Help surfaces directed send, optional dead recipient escape hatch, poll wait/peek/JSON. | Adequate communication model and correctly says messages are not authority. | No inbox/list/history management or prune/retention surface. That may be intentional, but long-running projects will accumulate message-log state. |
| `prepush` | flat leaf | `caws prepush --help` surfaces remote/branch/base/spec/ack and diagnostics. | Good preflight model; `--ack` is an explicit exception path. | No "write an ack file" or "explain all unexpected commits grouped by spec/worktree" model for large ranges. |

## Parity Gaps by Job

| Job-to-be-done | Current command that mostly fits | Similar CAWS command with better UX | Gap | Candidate model |
|---|---|---|---|---|
| Bulk archive closed specs | `specs archive --status closed --include/--exclude --apply` | `agents prune --status ... --apply` | Now mostly closed. Remaining gap is age/state filters beyond `closed`. | Add selectors such as `--older-than`, `--updated-before`, or `--without-worktree` only after the lifecycle semantics are explicit. |
| Clean up stale/dead worktree control-plane residue | `worktree repair --dry-run` | `agents prune --dead/--status --older-than-ms --apply` | `repair` only mutates unambiguous half-states. It does not clean real worktree dirs, closed residue, or event-backed orphans. | Add `worktree prune` as a dry-run default with state classes: `ghost-registry`, `closed-spec-residue`, `merged-clean`, `dead-directory`, `event-orphan-refused`; require `--apply` and refuse ambiguous classes. |
| Destroy multiple worktrees safely | `worktree destroy <name>` | `specs archive --include/--exclude` | One-at-a-time only; no selector by spec status, merged state, owner, or cleanliness. | Add a batch plan surface, not necessarily batch deletion first: `worktree cleanup plan --status closed --merged --json`, then a deliberately scoped apply command. |
| Untrack without deleting files | `worktree untrack <name> --reason ... --apply` | `worktree repair` clears dead bindings but only by doctor class | Now closed for single registered worktrees: dry-run default, required reason, clean/owned/existing-directory preconditions, and `worktree_untracked` audit evidence. | Future batch cleanup can compose this model, but should remain separate from physical deletion. |
| Restore an archived spec body | `specs recover <id> --out` | `specs activate`, `specs amend-scope` | Recovery is output-only. There is no governed restore to `.caws/specs/<id>.yaml` as draft/active. | Add `specs restore <id> --as draft --out canonical --apply` only if lifecycle semantics are accepted; otherwise keep `recover` read-only and document the manual path. |
| Convert a refusal into next command | `scope check`, `doctor` repair text | `specs amend-scope` | The user has to copy/paste and infer the exact next command. | Add structured remediation JSON fields and copy-paste commands for common safe repairs. |
| Inspect evidence history and payload shape | `evidence list/show/schema` | `waiver list/show`, `agents list/show` | Now closed for typed evidence events: list filters by spec/type, show resolves seq/hash/prefix after chain verification, and schema derives required payload fields from the kernel contracts. | Use this read/write/schema loop as a model for other append-heavy commands. |
| Rotate audit chain safely | `events list/show`, `events rotate --dry-run --reason ...`, `events verify-archive` | `events migrate --apply` | Now closed for first-order preview/read/verify parity: list/show summarize current chain and rotation archive status, rotate dry-run reports target archive path/line count/digest/stats/genesis, and verify-archive confirms archived bytes. | Future retention/prune semantics should be designed separately from rotation verification. |
| Retire stale draft specs in bulk | `specs retire-draft <id>` | `specs archive --status closed --include/--exclude --apply` | Draft cleanup is one-at-a-time and lacks selectors. | Add batch selectors only after "stale draft" is defined: age, no worktree binding, no scope changes, or explicit include list. |

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

## Next Slice

The next implementation slice should address waiver lifecycle cleanup and
preflight validation: `caws waiver create --dry-run` and/or
`caws waiver prune --status expired [--apply] [--json]`. Waiver create/revoke
already require audit metadata, but operators cannot preview validation or
clean expired waiver records with the same dry-run/apply model used by agents
and specs cleanup. Keep the first slice read-only by default and make expired
selection explicit before any revoke/prune mutation.

## Findings

1. **The CLI has a good cleanup UX pattern, but it is not consistently applied.**
   `agents prune` and batch `specs archive` have the right operator shape:
   filter, preview, explicit apply, and JSON. Cleanup-heavy surfaces under
   `worktree` and draft spec lifecycle do not yet share that model.

2. **Worktree cleanup is the largest practical gap for Sterling-scale repos.**
   The current split is technically correct but ergonomically incomplete:
   `worktree repair` handles safe control-plane half-states, `destroy` removes
   one registered worktree, and `merge` handles one bound branch. There is no
   sanctioned command for the recurring middle cases: closed spec residue,
   merged-clean worktrees, ignored dead directories, or "untrack but preserve
   files for review."

3. **`specs create` needs a fuller creation model, not only more validation.**
   Session evidence repeatedly shows agents discovering tier-1/2 requirements
   and contract tuple syntax by failure. `--scope-in` and `--contract` helped,
   but the command still needs either complete examples in help or a plan/template
   mode for tiered specs.

4. **Repair commands should publish the state taxonomy they use.**
   `doctor` has rich H-class repair text, but users discover it only through
   prose. A machine-readable plan with state class, subject, allowed mutation,
   refusal reason, and next command would let agents avoid guessing.

5. **Read/write/schema symmetry is still uneven outside evidence.**
   `evidence record/list/show/schema` now has an append/read/schema loop, but `message
   send/poll` can append and consume messages without a broader log-management
   surface. That may be acceptable for narrow workflows, but it is weak for
   audit-driven agent projects.

6. **Help context is now closer to reality, but nested help should keep naming
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

3. Add a read-only `worktree cleanup plan` or make `worktree prune` dry-run by
   default before adding any apply behavior. Sterling needs a trustworthy plan
   more than it needs another destructive verb.

4. Add waiver cleanup/preflight parity: dry-run validation for create and a
   selector/apply model for expired waiver cleanup.

5. Add help regression tests for any group description that names subcommands
   and for cleanup leaves that claim dry-run/apply semantics. The CLI already
   has metadata-driven help; the gap is asserting the UX promises that agents
   rely on.

6. Add examples to `specs create --help` for tier-1/2 specs and contract tuple
   syntax, or add a `specs create --plan` mode that validates and prints the
   missing required semantic fields before writing.
