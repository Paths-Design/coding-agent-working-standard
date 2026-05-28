# Session ownership metadata — design note

Status: implemented (post-doctrinal-amendment)
Date: 2026-05-22 (original), amended 2026-05-28
Spec: `.caws/specs/SESSION-OWNERSHIP-METADATA-001.yaml`
Related: `MULTI-AGENT-PUSH-RANGE-GUARD-001`, `WORKING-TREE-PROVENANCE-GUARD-001`, `MULTI-AGENT-HANDOFF-EVENT-001`

> **Doctrinal amendment 2026-05-28 — substrate pivot (READ FIRST).**
>
> This document was authored 2026-05-22 against the `AgentRecord` /
> `.caws/agents.json` substrate. The very next day,
> `MULTI-AGENT-ACTIVITY-REGISTRY-001` closed and FROZE `.caws/agents.json`:
> no new fields, no new readers, no new writers. The product requirement
> (mechanically readable session ownership metadata) is unchanged, but
> the **substrate is now the per-session `AgentLease` records** at
> `.caws/leases/<safe-session-id>.json`, written via the kernel's
> `updateAgentLeasePaths` and the store's `applyLeasePatch`.
>
> **What this means for any reader of the body below:**
>
> - Wherever this document says "extend `AgentRecord`", read "extend
>   `AgentLease`" (declared at
>   `packages/caws-kernel/src/worktree/leases.ts`).
> - Wherever it says "agents.json", read
>   "`.caws/leases/<safe-session-id>.json`".
> - Wherever it says "`isAgentRecord` predicate", treat that as
>   **WITHDRAWN**. The wrong-substrate Commit 1 (`51d0476`) briefly
>   introduced `isAgentRecord` on the `AgentRecord` path; it was
>   reverted in `ffcd4ba` and is NOT retained. The lease substrate
>   does not need a structural-disambiguation predicate — each lease
>   file's content IS the `AgentLease` record, with no mixed-key
>   enumeration problem. If a future legacy-`agents.json` reader needs
>   such a predicate, it belongs in the unfiled
>   `AGENTS-JSON-STRUCTURE-NORMALIZATION-001` slice, NOT here.
> - Wherever it says "`apply-patch.ts` writes claim/last_modified
>   paths", read "the new `apply-lease-patch.ts` writer path applies
>   `update_lease_paths` patches via `applyLeasePatch`; the legacy
>   `applyRegistryPatch` is NOT extended."
> - The `agents.last_modified_paths_ttl_seconds` policy key (A10) IS
>   still part of the implemented slice — it lives at the same
>   schema location with the same bounds. Only the store substrate
>   that consumes it (well, that DOESN'T consume it, per the C1
>   storage-bounds correction in §Q2) moved from `agents.json` to
>   leases.
>
> The Q1–Q6 deliberations, the `bound_spec_id` recon correction, the
> activation gate, the non-goals, and the storage-bounds vs TTL
> distinction (Q2 corrected) all remain valid as design rationale.
> Only the substrate name changed. The narrative is preserved below
> rather than rewritten so the audit trail of how the slice arrived
> at its final shape (including the wrong-substrate detour) stays
> intact for future readers.
>
> Final spec invariants and acceptance live at
> `.caws/specs/SESSION-OWNERSHIP-METADATA-001.yaml`; that file's
> doctrinal-amendment block is the authoritative substrate decision.
> This doc remains historical.

## Purpose

Resolve the six open design questions on `SESSION-OWNERSHIP-METADATA-001` (Q1–Q6 in the spec's triage block) before activation, plus document a structural drift in `.caws/agents.json` discovered during recon that the spec did not anticipate.

The spec is the contract. This note is the design rationale for the choices the spec then implements.

## Discovered state (recon)

Before resolving Q1–Q6, two facts from the on-disk shape and code path materially affect the design.

The spec, as drafted, asserts an invariant about `agents.json` that does not match the file on disk. This note **downgrades that invariant to a discovered-drift correction**: the spec text must be amended at activation time, the original wording is preserved here only to make the drift explicit, and downstream consumers must be aware that the live shape differs from what the draft claimed. The downgrade is not optional — proceeding with the draft's wording would build the substrate on a known false premise.

### Drift: `agents.json` top-level structure

**Original spec invariant (incorrect, to be amended at activation):** "agents.json itself does NOT declare a top-level version field today (per the inspected on-disk shape); this slice does NOT introduce one."

**Discovered-drift correction:** the actual on-disk shape (verified at `/Users/darianrosebrook/Desktop/Projects/caws/.caws/agents.json`) is:

```json
{
  "version": 1,
  "agents": {},
  "caws-d9bab4d388f3": {
    "session_id": "caws-d9bab4d388f3",
    "last_active": "2026-05-20T06:08:32.139Z",
    "platform": "darwin",
    "bound_worktree": "eh-v11-surface-wt",
    "bound_spec_id": "ERROR-HANDLER-V11-SURFACE-001"
  }
}
```

Three observations:

1. A `version: 1` field exists at the top level.
2. An empty `agents: {}` key exists at the top level (apparently unused; possibly legacy).
3. Per-session records sit alongside `version` and `agents` at the **same level** — not nested under `agents`.

The reader (`packages/caws-cli/src/store/agents-store.ts:20-40`) returns the raw object without filtering, so consumers iterating the registry as a `Record<sessionId, AgentRecord>` would see `"version"` and `"agents"` as session keys unless they explicitly filter. This is a pre-existing structural quirk, not a defect this slice introduces.

The activation spec must be amended to replace the inaccurate invariant. Choices:

- **(A)** Drop the invariant; do not claim either way. New fields land per-session as additive optional properties.
- **(B)** Keep the existing top-level `version: 1`. Adding new optional per-session fields does NOT require bumping. A future breaking change to per-session shape would bump.
- **(C)** Move records under `agents: {}` to match the apparent original intent. This is a **separate slice**, not part of this one — out of scope.

**Decision (locked in this note for activation):** choice (B). The top-level `version: 1` is preserved; new fields are per-session additive; no version bump. Choice (C) is recorded as a follow-up candidate (`AGENTS-JSON-STRUCTURE-NORMALIZATION-001`, unfiled) but does not block this slice.

### Drift-mitigation predicate (load-bearing)

The reader (`packages/caws-cli/src/store/agents-store.ts:20-40`) returns `value as AgentRegistry` — the raw object with `version`, `agents`, and per-session records all at the top level. Every downstream consumer (the working-tree provenance guard, the push-range classifier, the handoff event emitter) that enumerates "active agents" will inherit this confusion unless the substrate provides a narrow predicate. The visible symptom today is doctor's stale-agent display-only warnings firing on `version` and `agents`, which are not agents at all.

**Requirement (this slice):** introduce a small reader-side helper that distinguishes agent records from non-agent top-level keys. The contract is structural, not normalizing:

> Metadata consumers MUST treat a top-level value as an agent record **if and only if** it is an object whose `session_id` is a string AND whose `last_active` is a string. Any other top-level value (including `version: 1` and `agents: {}` in the current on-disk shape) is ignored, not warned on, not treated as a stale agent.

This is the minimum to prevent the new substrate (`claimed_paths`, `last_modified_paths`) from being read in contexts that would silently apply it to non-agent values. ~~The helper should live alongside the existing reader (likely a new exported predicate `isAgentRecord(value: unknown): value is AgentRecord` in `agents-store.ts` or `worktree/types.ts`). All new consumer surfaces in this slice and the three downstream slices MUST route through it.~~ **SUPERSEDED 2026-05-28:** on the lease substrate, each `.caws/leases/<safe-session-id>.json` file's content IS an `AgentLease` record — there is no mixed-key enumeration problem and the `isAgentRecord` predicate is not needed. The substrate-level enumeration helper lives in `packages/caws-cli/src/store/leases-store.ts` (`loadLeases`) and returns a typed `Record<sessionId, AgentLease>` directly. The wrong-substrate predicate from `51d0476` was reverted in `ffcd4ba`.

This is **not** structural normalization. The on-disk shape is unchanged; `version` and `agents: {}` remain. The doctor's stale-agent warnings on those keys remain (this slice does NOT amend doctor's diagnostics — that's covered by A6). What changes is that the substrate-level enumeration helper, and any helper added by this slice that returns "active agent records," is guarded by the predicate. Full structural cleanup remains `AGENTS-JSON-STRUCTURE-NORMALIZATION-001`.

### Drift: `bound_spec_id` is a spread extra — **WITHDRAWN / CORRECTED**

**Original (incorrect) finding, preserved for honesty:**

> The current writer (`apply-patch.ts:applyRefreshAgent`, lines 184-205) writes `bound_spec_id` into the record via `...(patch.bound_spec_id !== undefined ? { bound_spec_id: patch.bound_spec_id } : {})`. The field is **not** declared in the `AgentRecord` interface at `packages/caws-kernel/src/worktree/types.ts:113-118`.
>
> Decision: extend the `AgentRecord` interface with both new fields, and separately retrofit `bound_spec_id` into the interface in the same commit.

**Correction (pre-implementation, 2026-05-23):**

Direct source inspection during the recon-stop before commit 1 showed that `bound_spec_id` is **already declared** in `AgentRecord` at `packages/caws-kernel/src/worktree/types.ts:118` as `readonly bound_spec_id?: string`. It is referenced consistently throughout the codebase:

- `packages/caws-kernel/src/worktree/types.ts:118` — interface declaration
- `packages/caws-kernel/src/worktree/types.ts:211` — second use in a related interface
- `packages/caws-kernel/src/worktree/freshness.ts:21,45` — option type + spread on write
- `packages/caws-cli/src/shell/commands/claim.ts:193` — read on claim
- `packages/caws-cli/src/store/apply-patch.ts:202` — write in refreshAgent

There is no retrofit to do. The original finding was reconstructed from a quick agent summary rather than direct file read; the summary was wrong. **A9 has been withdrawn in place** in the spec (its id is preserved with a "withdrawn / corrected" body so the audit trail of the mistake remains visible).

This correction is itself an instance of the failure mode the four-part bar exists to prevent: an agent reconstructed provenance from a summary instead of reading the file. It was caught by the maintainer-instructed recon stop before commit 1. That is the value of the recon stop. The substrate work is unaffected: A1 and A10 remain valid. ~~Commit 1 only widens `AgentRecord` with `claimed_paths` and `last_modified_paths` and adds the `isAgentRecord` predicate.~~ **SUPERSEDED 2026-05-28:** the as-shipped Commit 1 (`3a560e9`) widens `AgentLease` with `claimed_paths` and `last_modified_paths` and ships `validateLeasePathMetadata` (structural validation + truncation helper) — NOT an `isAgentRecord` predicate. A8 was REINTERPRETED in the spec's doctrinal-amendment block: on the lease substrate, no top-level mixed-key disambiguation is needed (each lease file IS its `AgentLease`).

## Q1 — Implicit vs explicit claim semantics

Spec status: locked at draft — **explicit** declaration via a new surface (`caws claim --paths <glob>...`).

This note: confirmed. The soft-middle question ("implicit `last_modified_paths` but explicit `claimed_paths`?") is answered **yes**:

- `last_modified_paths` is **implicit FROM THE SESSION'S PERSPECTIVE** but explicit at the call site: an upstream caller (a future collector hook, a test harness, or a downstream consumer surface) assembles the path set the writer should record. The session does not formally declare these paths the way it would a claim; the field is observed-by-the-caller, recorded-by-the-writer. This is the "no information vs no claims" gap the consumer slices need to read.
- `claimed_paths` is **explicit**: only populated when the session (via `caws claim --paths <pattern>...` in commit 3 or equivalent) declares a claim. Empty/absent means "this session has not declared a claim," which is operationally different from "this session has no edits in scope."

The two fields are independent. A session can have `last_modified_paths: ["packages/foo/a.ts"]` and `claimed_paths: undefined` simultaneously — meaning "I've touched a.ts recently but I haven't formally claimed any path." The consumer slices interpret the combination, not either alone.

## Q2 — TTL default for `last_modified_paths` — CORRECTED to C1 storage-bounds interpretation

**Original (incorrect) decision, preserved for honesty:**

> The writer computes the window relative to `now()` at write time. Pruning policy: when the writer fires, paths older than `now() - ttl` are dropped from the set. Pruning happens on write, not on read.

**Correction (pre-commit-2, 2026-05-23):**

The original Q2 decision was structurally infeasible for the substrate shape locked in commit 1. `last_modified_paths` is `readonly string[]` — there are no per-path timestamps to consult, so the writer cannot identify which paths are "older than `now() - ttl`." Implementing the original wording would have required either (a) changing the substrate to `Array<{path, touched_at}>` (option C2 in the structural-question stop-and-report), which contradicts the "store verbatim" lock for paths and turns the slice into a timestamp-aware edit ledger; or (b) maintaining a side-channel timestamp map (C3), which is more complex and not designed for in this slice.

The correct interpretation is **C1 with storage-bounds refinement**: the writer stores caller-pruned data subject to structural validation and a deterministic max-size cap, but does NOT enforce per-path TTL.

| Concern | Owner |
|---|---|
| Per-path TTL membership ("was this path touched within N seconds?") | Caller (future collector hook, explicit-claim CLI, provenance surface, test harness) |
| FIFO cap / max 1000 entries | Writer (storage-bound invariant) |
| Path string validation (non-empty, no null bytes) | Writer |
| Per-path timestamp storage | **NOT represented in agents.json** — would be a different substrate |
| Policy key `agents.last_modified_paths_ttl_seconds` | Schema-validated config exposed to collectors/consumers; the substrate does NOT consume it |

This preserves the substrate-vs-policy distinction the four-part bar exists to maintain. The writer's job is durable storage of caller-supplied data, not semantic freshness enforcement. The policy key still ships (A10) but its consumers are upstream of the writer, not the writer itself.

Specifically:

- **Policy key**: `policy.yaml` adds optional integer `agents.last_modified_paths_ttl_seconds`, bounds `[60, 86400]`, default `1800` (30 min). Validated by `policy.v1.json` schema.
- **Default resolution**: absent key resolves to `1800`. Out-of-bounds values **fail schema validation** (block load with a clear diagnostic), not "clamp with WARN." The "clamp with WARN" pattern in the original Q2 was inconsistent with how the rest of the policy schema treats invalid values.
- **No writer consumption**: `applyRefreshAgent` does NOT read the TTL value. The TTL is exposed to whichever upstream code assembles the `last_modified_paths` array; that code is responsible for filtering by age before invoking the patch.
- **Writer-side enforcement is limited to storage bounds**: structural validation (string array, non-empty, no null bytes — fail closed on violation) and FIFO truncation at 1000 entries (caller-order preserved; if caller passes >1000, drop oldest until count = 1000).

## Q3 — Claim takeover mechanism

Spec status: locked at draft — **out of scope here**. Takeover lives in `WORKING-TREE-PROVENANCE-GUARD-001`.

This note: confirmed. The activator must NOT add any takeover surface to this slice. Doing so re-couples authority-state writes to the substrate-only data-model slice and creates the same boundary violation the four-part bar was decomposed to avoid.

What this slice MUST do for the takeover slice's benefit:

1. Ensure `claimed_paths` is observable from any session (cross-session reads work, per A4 of the spec).
2. ~~Ensure the `agents.json` writer does NOT silently clobber another session's `claimed_paths` field.~~ **SUPERSEDED 2026-05-28:** the lease-substrate writer is naturally per-session safe — each session writes to its own `.caws/leases/<safe-session-id>.json` file, so there is no shared mixed-key object the writer could clobber. The `applyLeasePatch` store function (from `apply-lease-patch.ts`) updates only the targeted session's lease file; other sessions' files are not touched at all. The cross-session non-clobber test from the original wording is therefore structurally guaranteed by the substrate shape rather than by writer discipline. The `agents.json` writer (`applyRegistryPatch`'s `refresh_agent` branch) is unchanged by this slice and remains frozen under `MULTI-AGENT-ACTIVITY-REGISTRY-001`.

## Q4 — Path normalization

Spec status: locked at draft — **verbatim storage**. Normalization is the consumer's responsibility.

This note: confirmed, with a related-but-separate concern flagged.

The hook-side cwd-relative path normalization defect (`project_scope_guard_path_normalization_followup` memory; unfiled as `SCOPE-GUARD-PATH-NORMALIZATION-001`) is at the **hook** layer, not the store layer. It does not affect this slice's storage decision but DOES affect what downstream consumers (the working-tree provenance guard especially) will need to handle when they read these fields. Specifically: a consumer comparing `last_modified_paths` against a path from the current working directory may need to normalize both sides to repo-root-relative form, or the comparison silently misses.

**Recommendation for consumer slices** (not enforced here): canonicalize on read to repo-root-relative form before any cross-record comparison. This recommendation belongs in the consumer slices' specs, not this one.

## Q5 — Glob expansion timing

Spec status: locked at draft — expansion at **consumer query time**, not at write time. Glob syntax MAY be validated at write time as a structural check.

This note: confirmed. Two refinements:

- **Validation at write time**: minimal — reject `claimed_paths` entries that are empty strings or contain null bytes. Do NOT enforce that paths exist on disk (a claim can declare a future path; sessions may claim paths they intend to create).
- **Consumer query-time expansion**: the consumer slices will need a small library helper (likely `matchPathAgainstClaims(path, claimedPaths)` in the kernel or store layer). Defining and shipping that helper is **out of scope for this slice** — it belongs in whichever consumer slice first needs it. The store-layer responsibility ends at "the strings are durably written."

## Q6 — Path-set bounded size

Spec proposed: `last_modified_paths` capped at 1000 entries, FIFO eviction. `claimed_paths` uncapped.

This note refines:

- **`last_modified_paths`**: 1000-entry cap, FIFO, enforced by the writer. If the caller passes >1000 entries, the writer preserves caller order and drops the lowest-index entries until the count is exactly 1000. No "TTL prune first" sequencing — per the corrected Q2, the writer does NOT TTL-prune. The cap is a pure storage-bound: it requires only ordered input and a max length, no per-path metadata. This is what makes FIFO cap and TTL **different kinds of rule** — FIFO is structurally enforceable; TTL is not, for this substrate shape.
- **`claimed_paths`**: 256-entry cap enforced **at the CLI layer in commit 3**, NOT at the writer in commit 2. Rationale: commit 2's writer accepts caller-provided `claimed_paths` verbatim subject to structural validation (string array, non-empty, no null bytes); commit 3's `caws claim --paths` CLI surface is the natural place to enforce the 256 user-facing cap with a friendly error directing the user to coarser globs. If a future caller invokes the writer directly with >256 claimed_paths, the writer accepts them — it is not the writer's job to enforce CLI ergonomics. Operator override via policy is **not** added in v1; a follow-up slice can lift the cap if telemetry shows it is wrong.

## Schema strategy (related to top-level drift)

The spec offers two paths: extend `AgentRecord` in place vs fork a v2 schema. Since no JSON schema for `agents.json` exists today (only TypeScript types), the choice reduces to "do we introduce a JSON schema at all?"

**Decision (locked):** **no JSON schema in this slice.** The new fields are additive optional properties on the `AgentRecord` TypeScript interface. Existing v1-shape records continue to parse trivially (optional fields are `undefined`).

Rationale:

- Introducing the first JSON schema for `agents.json` is a structural change orthogonal to this slice's purpose (which is data-model widening, not validation tightening).
- The existing TypeScript type + the `loadAgents` runtime shape check (`typeof value === 'object' && !Array.isArray(value)`) is the de-facto contract today. Maintaining it is the minimal-change path.
- A JSON schema for `agents.json` is a reasonable follow-up (`AGENTS-JSON-SCHEMA-001`, unfiled). It belongs in the same slice that addresses the top-level structure drift (choice C from §Discovered state).

## Implementation plan (after activation)

The maintainer-stated constraint is that **commit 1 widens substrate only; no shell surface yet.** `caws claim --paths` lands in a later commit within the same activated slice, after the type/store substrate is pinned. The plan reflects that:

**Commit 1 — types + reader predicate (no behavior change to writers):**

- `packages/caws-kernel/src/worktree/types.ts`: extend `AgentRecord` with:
  - `readonly claimed_paths?: readonly string[]`
  - `readonly last_modified_paths?: readonly string[]`
  - (NO `bound_spec_id` change — already declared at types.ts:118; A9 withdrawn.)
- ~~`packages/caws-cli/src/store/agents-store.ts` (or `worktree/types.ts`): export `isAgentRecord(value: unknown): value is AgentRecord` per the drift-mitigation predicate. This is the only behavior addition in commit 1.~~ **SUPERSEDED 2026-05-28:** as shipped, Commit 1 (`3a560e9`) widens `AgentLease` in `packages/caws-kernel/src/worktree/leases.ts` and exports `validateLeasePathMetadata` + `LAST_MODIFIED_PATHS_MAX_ENTRIES` from the kernel worktree barrel — no `isAgentRecord` predicate is added or needed. `packages/caws-cli/src/store/agents-store.ts` is untouched by the slice (frozen under `MULTI-AGENT-ACTIVITY-REGISTRY-001`).
- Tests: A1 (v1 records load with new fields undefined), A8 (non-agent top-level keys ignored by predicate). A passive no-regression assertion for `bound_spec_id` (load a record carrying the field and confirm it is exposed through the typed interface) is **permitted but not required** — it is hardening, not new functionality.
- No writer change in this commit. No policy schema change. No CLI surface.

**Commit 2 — writer + policy key (still no shell-side claim surface):**

This is a **storage-contract commit**, not a policy-engine commit. The writer durably stores caller-provided data subject to structural validation and storage bounds; it does NOT enforce TTL semantics, because the substrate has no per-path timestamps to read.

- `packages/caws-kernel/src/worktree/types.ts`: extend `RegistryPatch.refresh_agent` with optional `claimed_paths?: readonly string[]` and `last_modified_paths?: readonly string[]`. This is the kernel-side contract that propagates through to the writer.
- `packages/caws-kernel/src/worktree/freshness.ts`: extend `RefreshAgentClaimOptions` and `refreshAgentClaim` to forward the new fields into the patch envelope. **Requires scope amendment** to admit this file — the commit-2 amendment should land that on the base branch before the kernel edit. Do not bypass the kernel patch envelope.
- `packages/caws-cli/src/store/apply-patch.ts`: extend `applyRefreshAgent` to write `claimed_paths` and `last_modified_paths` to the targeted session's record when present, preserving all existing fields (existing v1 fields, sibling sessions' records, top-level `version`/`agents` non-record keys). Enforce writer-side invariants:
  - Structural validation: each entry is a non-empty string with no null bytes. Invalid input fails the entire write closed with a clear diagnostic — no partial write.
  - `last_modified_paths` max-size truncation: 1000 entries, FIFO, caller-order preserved. If caller passes >1000, drop lowest-index entries until count = 1000.
  - `claimed_paths`: stored verbatim subject to structural validation. NO 256-cap at this layer (that lands in commit 3 at the CLI).
  - **No TTL pruning**. The writer does NOT compute or apply TTL membership. Per the corrected Q2.
  - Cross-session non-clobber: writing session A's record MUST leave session B's record byte-identical.
- `packages/caws-kernel/src/schemas/policy.v1.json`: additive optional integer key `agents.last_modified_paths_ttl_seconds`, bounds `[60, 86400]`, default `1800` (30 minutes). Schema validation only; out-of-bounds values fail validation with a clear diagnostic, no clamp-with-warn. The writer does NOT consume this value.
- Tests: A2 (writer accepts claim payload), A3 (revised — writer stores caller-pruned set verbatim subject to validation + FIFO cap; NO TTL behavior), A5 (stale-record claim preservation: a session whose `last_active` is older than the policy TTL still exposes `claimed_paths` and `last_modified_paths` if those were last written; the writer does not retroactively drop them), A6 (no new doctor diagnostics fire), A10 (policy key schema validates with default 1800 and bounds; out-of-bounds rejected), cross-session non-clobber, structural-validation rejection cases (empty string, null byte, non-string entries).

**Commit 3 — explicit-claim CLI surface (`caws claim --paths`):**

- New shell command `caws claim --paths <pattern>...` in `packages/caws-cli/src/shell/` writes the claim into the current session's record via the writer added in commit 2. Enforces the 256-entry cap per Q6.
- Tests: end-to-end claim write, claim cap rejection, claim path validation (non-empty, no null bytes).
- This is the only shell-side addition in the activated slice. Other surfaces (`caws status`, `caws doctor`) remain untouched per A6.

**Commit 4 — closure:**

- `caws specs close SESSION-OWNERSHIP-METADATA-001 --reason "<closure prose>"` via single bash invocation (not nested `bash -c`; see [[project_caws_known_defects]] for the audit-drift incident).
- Closure notes record: schema strategy (no JSON schema; predicate helper instead), policy key (`agents.last_modified_paths_ttl_seconds` default 1800 sec, bounds 60–86400, validated but NOT writer-consumed under the C1 interpretation), cap values (writer enforces 1000 FIFO on `last_modified_paths`; commit 3 CLI enforces 256 on `claimed_paths`), A9 explicitly noted as **withdrawn** (no retrofit; the recon that motivated it was wrong), A8 predicate landed, the C1-storage-bounds correction to Q2/A3/A10 documented (substrate-vs-policy distinction preserved), and pointers to the three consumer slices.

## Activation gate

Activation requires:

1. Operator review of this design note (resolutions to Q1–Q6 + the two drift-vs-spec amendments).
2. Spec amendment with the following four changes:
   - **(a)** add ADR doc + substrate surfaces to `scope.in`:
     ```yaml
     scope:
       in:
         - .caws/specs/SESSION-OWNERSHIP-METADATA-001.yaml
         - docs/architecture/session-ownership-metadata.md
         - packages/caws-kernel/src/worktree/types.ts
         - packages/caws-cli/src/store/apply-patch.ts
         - packages/caws-cli/src/store/agents-store.ts
         - packages/caws-kernel/src/schemas/policy.v1.json
         - packages/caws-cli/tests/store/
         - packages/caws-kernel/tests/
     ```
     **Shell surfaces are deliberately excluded** from the activation amendment. They land later, as part of commit 3 (the explicit-claim CLI surface), via a follow-up scope amendment within the activated slice.
   - **(b)** correct the false invariant about `agents.json` top-level structure (delete the "agents.json itself does NOT declare a top-level version field today" wording; replace with the on-disk shape + the drift-mitigation predicate requirement).
   - **(c)** ~~add `bound_spec_id` retrofit to acceptance and scope~~ **WITHDRAWN.** This bullet originally added A9 as a retrofit acceptance. Pre-implementation source inspection showed `bound_spec_id` is already declared in `AgentRecord` at `packages/caws-kernel/src/worktree/types.ts:118`; there is no retrofit work to do. A9 has been preserved in place with a "withdrawn / corrected" body so the audit trail is honest. The activation amendment commit `f02121c` shipped this bullet as written; the correction commit (this slice's predecessor to commit 1) brings the spec text into alignment with reality.
   - **(d)** add policy key acceptance for `agents.last_modified_paths_ttl_seconds` (integer, bounds 60–86400 seconds, default 1800).
3. **New acceptance criterion A8** (load-bearing, gates the predicate from §Drift-mitigation predicate):
   ```text
   A8 — Non-agent top-level keys are not interpreted as agent records.
   Given agents.json contains top-level `version` and `agents` keys alongside session records,
   when ownership metadata readers enumerate active agent records,
   then only object values with a string `session_id` and string `last_active` are treated as agent records;
   `version` and `agents` are ignored, not warned on as stale sessions.
   ```
   This prevents the new substrate from being read in contexts that would silently apply it to non-agent values.
4. The amendment commit is `chore(caws): amend SESSION-OWNERSHIP-METADATA-001 scope for activation` (`f02121c`). It bundled the ADR doc + four spec corrections + A8. **No implementation code was in this commit.**
5. Activation itself is a separate commit (`chore(caws): activate SESSION-OWNERSHIP-METADATA-001` at `7d27f42`).
6. **Correction commit** (`chore(caws): correct SESSION-OWNERSHIP-METADATA-001 bound_spec_id recon`) — spec/ADR only, no code. Withdraws A9 in place and corrects ADR drift-finding #2 because pre-implementation source inspection showed the original recon was wrong. This commit is the predecessor to commit 1 of implementation.

The four implementation commits then follow per the plan above. Commit 3's scope-amendment for the shell surface is a separate, smaller amendment commit within the activated slice.

## Non-goals (explicit guards)

- No takeover surface. No claim-revocation logic. No blocking behavior. No refusals.
- No new event schemas. No emission of `agent_claimed_paths` or similar events.
- No batch migration of existing `agents.json`. Write-on-update is sufficient.
- No top-level structure changes to `agents.json`. The drift in §Discovered state stays drift; this slice does not normalize.
- No JSON schema for `agents.json`. TypeScript-types-only.
- No kernel authority changes. The new fields are advisory.
- No edits to other multi-agent specs (`WORKING-TREE-PROVENANCE-GUARD-001`, `MULTI-AGENT-PUSH-RANGE-GUARD-001`, `MULTI-AGENT-HANDOFF-EVENT-001`). Those slices consume the new data; their specs encode their own semantics.
