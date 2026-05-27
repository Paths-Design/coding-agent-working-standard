# Tier 1 follow-up queue — post-migrator restoration plan

Created 2026-05-26 during the `CAWS-MIGRATE-V10-SPECS-001` slice (commit 2 of 7 landed as `9effdfe`). This is a queue note, **not** a spec. Do not expand the active/draft spec surface while the migrator is in flight; specs go through `caws specs create` only after the migrator merges.

Source audit: this session's overhead-view audit (Sterling consumer report at `/Users/darianrosebrook/Desktop/Projects/sterling/docs/ephemeral/caws-v11-issues.md`, Sterling fixes JSON at `docs/reports/sterling-v11-fixes.json`, and Entry 21 of `docs/failure-lineage.md`).

## Sequencing rule (do not violate)

1. Finish `CAWS-MIGRATE-V10-SPECS-001` commits 3–7 first.
2. Land migrator merge to main.
3. Then file follow-up specs in the order below, one at a time, each closed before the next opens.

The strategic reason for the rule: every open spec is control-plane surface. The project is already carrying control-plane drift (H3 half-state on `SESSION-OWNERSHIP-METADATA-001`, H6 foreign-physical on `release-caws-11-1-7-train`, 5 stale post-merge branches, `WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-001` active without a worktree, README pointing first-contact users at v10.2.x). Closing one loop completely is worth more than opening four parallel ones.

## Tier 1 queue (file in this order after migrator lands)

### 1. CAWS-GATES-RUN-ABORT-ON-CORRUPT-CHAIN-001 — P0 silent CI failure

Sterling evidence (verbatim from `sterling-v11-fixes.json`):

```
caws gates run: failed to append gate_evaluated event for budget_limit
[ERROR ] store.events.invalid_event_shape: must be equal to one of the allowed values
... exit: 0
```

Exit 0 with zero gates evaluated is the worst possible CI outcome: green dashboard, zero coverage, no signal to the operator that anything went wrong. Affects every repo with any partially-corrupt event chain (not just Sterling).

Surfaces to investigate:
- `packages/caws-cli/src/shell/commands/gates.ts` — exit-code logic on per-gate append failure.
- `packages/caws-cli/src/store/events-store.ts` — `appendEvent` failure handling.
- The kernel-side `validateChainedEvent` v10 compat alias already shipped in kernel 1.1.3; this defect persists even with that alias because the failure mode is appending a NEW v11 event whose body fails some schema check, not reading a v10 entry.

Likely shape: 2-line change to either exit non-zero on per-gate append failure OR isolate per-gate failures from each other so subsequent gates still run. Independent of any other slice. Will trigger the v11.1.8 release train.

### 2. KERNEL-EVENT-V10-VERIFYCHAIN-COMPAT-001 — verify-chain compat

Residual called out in `docs/failure-lineage.md` Entry 20 amendment. `verifyChain` re-hashes via `computeEventHash → canonicalJson(event minus event_hash)` and compares to stored `event_hash`. A v10 entry will verify under v11 only if the v10 writer used a canonical-JSON serialization byte-identical to v11's. If not, verify fails with `evidence.chain.event_hash_mismatch` on every legacy entry.

**Not** a Sterling worktree-create blocker (the hot path doesn't re-hash prev), but the moment any operator runs `caws events verify-archive` over an archive containing legacy entries, every entry fails.

Two possible resolutions:
- Add a v10-canonical-JSON path inside `computeEventHash` for entries whose `event === 'validation_completed'`.
- Document that v10→v11 boundary archives must be rotated via `caws events rotate --reason "v10→v11 boundary"` before chain verification can pass; the existing `prior_chain_status: parseable_unverified` semantics cover this.

Resolution choice depends on whether v10 entries are evidentiarily load-bearing for any consumer compliance/audit. Investigate before filing.

### 3. CAWS-DOCTOR-SEVERITY-RECALIBRATION-001 — false-ERROR class

Five Sterling blockers were `[ERROR]` for findings that should be `[INFO]` or `[WARN]`. Concrete cases (from the audit):

- `spec_missing_registry` on closed/archived specs (Sterling Issue 17 — should be INFO)
- `store.specs.non_yaml_skipped` on `registry.json` + companion `*.preflight.md` (Sterling Issue 18 — INFO)
- The v10-envelope ghost `worktrees` key (Sterling Issue 5 — should suggest `caws worktree migrate-registry` instead of reporting a fake ghost)
- `doctor.binding.spec_not_governable` on draft-state worktree bindings (could be WARN with a clearer repair)
- One more from the subagent's count (verify against Sterling's final `caws doctor` output: `1 store.specs.non_yaml_skipped`, `1 doctor.worktree.foreign_physical` (already INFO — exemplar), `1 doctor.spec.unbound_active_stale`, `1 doctor.binding.one_sided`).

A severity-recalibration pass would silence ~1000 doctor errors of noise across post-migration repos.

### 4. CAWS-DOCS-V11-1-7-RECONCILIATION-001 — README + arch-doc drift

P1 user-facing defect: README lines 9 and 15 send first-contact users to install v10.2.x; line 45 gives the current command. A user reading top-to-bottom installs a version 9 months behind the registry that can't initialize a v11.1.7-shape repo at all.

Also fold in:
- `docs/architecture/caws-vnext-command-surface.md` line 300 still says `non_functional` admits only `reliability` and `performance`; schema admits 4 (CLAUDE.md trap #6 was fixed this session as `4ef73fe` but the arch doc still drifts).
- CLAUDE.md cites `@paths.design/caws-cli@11.1.4`; current is `11.1.6` (about to be `11.1.8` after item 1 lands).

Single docs slice. Cheap. Could bundle with item 1 if the slice author wants.

### 5. CAWS-SESSION-ID-DRIFT-ENV-PRECEDENCE-001 (P0 — Sterling-recurring)

**Symptom:** every `caws worktree merge` after a Claude Code session restart refuses with `OWNED (foreign) — caws-<prior-hex>`, even when the same human user is operating. Sterling has been forced into repeated `caws claim --takeover` cycles within a single agent session.

**Root cause (from diagnosis 2026-05-26):** `packages/caws-cli/src/shell/session/resolve-session.ts` minted-capsule path runs whenever `CLAUDE_SESSION_ID` is not set in `process.env`. Claude Code provides the stable session id as `HOOK_SESSION_ID` in the hook envelope JSON (consumed by `parse-input.sh`), but does NOT export it into child-process env. So every CLI invocation outside a hook context misses priority 1 of `resolveSession` and falls through to capsule-or-mint. A second compounding bug: `readCapsule` iterates `.caws/sessions/*.json` and returns the first whose `worktree_root` matches, but does NOT delete superseded capsules. After a restart, multiple capsules may match the same worktree, and which one wins is non-deterministic by filesystem order.

**Fix shape (two surgical options, either standalone):**
- **Option A (harness-side, one line per hook):** in `agent-register.sh` / `agent-heartbeat.sh` / any hook that may spawn a `caws` invocation, add `export CLAUDE_SESSION_ID="$HOOK_SESSION_ID"` before the CLI call. This makes priority 1 of `resolveSession` hit consistently for every hook-triggered CAWS command.
- **Option B (store-side, capsule cleanup):** in `resolve-session.ts` mint path, before writing the new capsule, scan `.caws/sessions/` and delete any pre-existing capsule whose `worktree_root` matches. Guarantees per-worktree-root capsule uniqueness; restart cleanly supersedes prior mint.

Recommendation: ship both. Option A fixes the hook-context path; Option B fixes the human-shell path. Together they eliminate drift across both invocation paths.

**Authority discipline:** this is a substrate change, not an enforcement relaxation. The `worktrees.json:owner.session_id` field remains authoritative; `--takeover` semantics remain unchanged. The fix changes which id is RESOLVED, not how ownership is COMPARED.

### 6. CAWS-SPECS-CLOSE-DEFAULT-RESOLUTION-001 (P1 — Sterling-recurring)

**Symptom:** `caws specs close <id> --reason "..."` errors with `error: required option '--resolution <r>' not specified` before any business logic runs. The recovery instruction emitted by `caws worktree merge` after a `partial_failure_unrecovered` (e.g., `caws specs close <id> --resolution completed --merge-commit ...`) includes `--resolution`, but agents that read only the error or attempt the close manually with `--reason` fail twice.

**Root cause (from diagnosis 2026-05-26):** `packages/caws-cli/src/shell/register.ts` line 613 registers `--resolution` as Commander `.requiredOption` with no default. The composed `caws worktree merge → closeSpec` path hardcodes `resolution: 'completed'` (`worktrees-writer.ts` ~line 1024) and is unaffected. The defect is purely shell-UX: manual close calls have no default.

**Fix shape (one line):**
```ts
// register.ts ~line 613
.option(
  '--resolution <r>',
  'Resolution: completed | superseded | abandoned (default: completed)',
  'completed'
)
```
And ensure `runSpecsCloseCommand`'s existing `VALID_RESOLUTIONS` enum check still runs against the default.

**Why "completed" is the safe default:** the vast majority of spec closes are completion-of-work. `superseded` and `abandoned` are explicit operator decisions that should be opted into. Defaulting to `completed` matches the merge-path behavior.

**Kernel-side:** no change. The `CLOSED_SPEC_MISSING_RESOLUTION` semantic gate (`packages/caws-kernel/src/spec/rules.ts`) is correct — kernel still enforces resolution must be present. The fix changes what value the shell SUPPLIES when the operator doesn't, not what the kernel ACCEPTS.

**Adjacent UX gap (out of scope for this fix, but worth flagging):** when `caws worktree merge` hits `partial_failure_unrecovered`, the merge commit is on disk but the spec is still `active`. The error data names the recovery command. The agent should be able to inspect the spec's actual state with `caws specs show <id>` to confirm the lifecycle_state remains active before re-running close. Documenting this in the merge error output (one extra line: "spec lifecycle_state remains 'active'; re-run with: caws specs close ...") would close the loop.

## Tier 2 (defer until Tier 1 closes)

5. `caws waiver migrate --from v10` — Sterling hand-wrote a custom Node script for this. No spec exists. Sibling to the in-flight specs migrator; should reuse `detectSpecVersion` pattern. Sterling Issue 6 + Issue 14 (waiver-vs-policy mismatch unmasked by migration).
6. `WORKTREE-FIRST-AGENT-EXECUTION-GUARD-001` (Task #71 already in task list) — canonical-mutation non-authoritative guard.
7. H3/H6 half-state doctor diagnostics — `WORKTREE-DOCTOR-HALF-STATE-001` is `closed` by spec lifecycle but no diagnostic exists for the cases observed in this session.

## Captured-but-not-filed defects (memory-only or draft, not in active spec surface)

Do NOT promote these to active until Tier 1 is clear:

- `SESSION-LOG-RENDERER-MISSING-001` (draft) — `session-log.sh` references python file not in `installedFiles`.
- `TEMPLATES-PUBLISH-REGRESSION-001` (draft) — hook-pack templates missing from published tarball.
- `WORKTREE-MERGE-V11-SHAPE-001` (memory only, in `project_caws_worktree_merge_v11_schema_regression.md`) — `--dry-run` crashes on production v11 shape.
- `CAWS-WORKTREE-CREATE-SPARSE-SPEC-BUG-001` (draft) — sparse-checkout excludes `.caws/specs/` (designed, not a bug — needs reclassification).
- Sterling Issue 15 (scope-guard strike accumulator is session-scoped, not per-file) — known UX rough edge; reset script is the recovery path.
- Sterling Issue 17 (session-id mismatch on `caws worktree merge`) — friction for single-user iterative sessions across context resets.

## Closure criteria for this queue note

This file can be deleted (not archived) once:
- Items 1–4 above are either filed-and-closed or moved to a different artifact (e.g., a v11.1.8 release report).
- `docs/failure-lineage.md` Entry 21's "behavioral-equivalence confidence" framing is no longer the bleeding-edge state of the project.

Until then, this is the durable queue. Do not lose it.
