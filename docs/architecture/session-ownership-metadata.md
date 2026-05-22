# Session ownership metadata — design note

Status: draft (pre-activation review for `SESSION-OWNERSHIP-METADATA-001`)
Date: 2026-05-22
Spec: `.caws/specs/SESSION-OWNERSHIP-METADATA-001.yaml`
Related: `MULTI-AGENT-PUSH-RANGE-GUARD-001`, `WORKING-TREE-PROVENANCE-GUARD-001`, `MULTI-AGENT-HANDOFF-EVENT-001`

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

This is the minimum to prevent the new substrate (`claimed_paths`, `last_modified_paths`) from being read in contexts that would silently apply it to non-agent values. The helper should live alongside the existing reader (likely a new exported predicate `isAgentRecord(value: unknown): value is AgentRecord` in `agents-store.ts` or `worktree/types.ts`). All new consumer surfaces in this slice and the three downstream slices MUST route through it.

This is **not** structural normalization. The on-disk shape is unchanged; `version` and `agents: {}` remain. The doctor's stale-agent warnings on those keys remain (this slice does NOT amend doctor's diagnostics — that's covered by A6). What changes is that the substrate-level enumeration helper, and any helper added by this slice that returns "active agent records," is guarded by the predicate. Full structural cleanup remains `AGENTS-JSON-STRUCTURE-NORMALIZATION-001`.

### Drift: `bound_spec_id` is a spread extra

The current writer (`apply-patch.ts:applyRefreshAgent`, lines 184-205) writes `bound_spec_id` into the record via `...(patch.bound_spec_id !== undefined ? { bound_spec_id: patch.bound_spec_id } : {})`. The field is **not** declared in the `AgentRecord` interface at `packages/caws-kernel/src/worktree/types.ts:113-118`. Existing consumers consult it via `as Record<string, unknown>` casts or by direct property access at call sites.

This is precedent for "extra fields without interface change," but it has a real cost: TypeScript cannot help consumers find or validate the field. The new fields (`claimed_paths`, `last_modified_paths`) are central to three downstream slices, so the cost of leaving them undeclared is higher.

**Decision (locked):** extend the `AgentRecord` interface with both new fields as `readonly ... | undefined`, and **separately** retrofit `bound_spec_id` into the interface in the same commit (the field already exists on disk; adding it to the type is documentation, not behavior change). The retrofit is included in this slice's scope.in because it is a structural alignment with the very same writer that this slice modifies.

## Q1 — Implicit vs explicit claim semantics

Spec status: locked at draft — **explicit** declaration via a new surface (`caws claim --paths <glob>...`).

This note: confirmed. The soft-middle question ("implicit `last_modified_paths` but explicit `claimed_paths`?") is answered **yes**:

- `last_modified_paths` is **implicit**: the writer populates it from edits the session has actually performed within the TTL window. The session does not declare anything; the field is observed, not declared. This is the "no information vs no claims" gap the consumer slices need to read.
- `claimed_paths` is **explicit**: only populated when the session runs `caws claim --paths <pattern>...`. Empty/absent means "this session has not declared a claim," which is operationally different from "this session has no edits in scope."

The two fields are independent. A session can have `last_modified_paths: ["packages/foo/a.ts"]` and `claimed_paths: undefined` simultaneously — meaning "I've touched a.ts recently but I haven't formally claimed any path." The consumer slices interpret the combination, not either alone.

## Q2 — TTL default for `last_modified_paths`

Spec proposed: 30 minutes from `last_active`, capped at 24h, operator-configurable via `policy.yaml`.

This note refines:

- **Default**: 30 minutes.
- **Configurability**: via `policy.yaml` under a new key `agents.last_modified_paths_ttl_seconds` (seconds, not minutes, to match the rest of the policy schema which uses seconds for time-bounded fields).
- **Hard cap**: 24h (86400 seconds). Values above the cap are clamped at load time with a `WARN` diagnostic; the file is not rewritten.
- **Lower bound**: 60 seconds. Values below this are clamped at load with `WARN`.
- **Source of truth for the TTL window**: the writer computes the window relative to **`now()` at write time**, not relative to `last_active`. This avoids the ambiguity where an idle session's TTL window "stretches" because its heartbeat is stale.
- **Pruning policy**: when the writer fires, paths older than `now() - ttl` are dropped from the set. Pruning happens on write, not on read. If a session never writes, the field is **not** retroactively pruned by readers.

The `policy.yaml` key is additive-optional. Sessions that load against a policy without the key use the 30-minute default.

## Q3 — Claim takeover mechanism

Spec status: locked at draft — **out of scope here**. Takeover lives in `WORKING-TREE-PROVENANCE-GUARD-001`.

This note: confirmed. The activator must NOT add any takeover surface to this slice. Doing so re-couples authority-state writes to the substrate-only data-model slice and creates the same boundary violation the four-part bar was decomposed to avoid.

What this slice MUST do for the takeover slice's benefit:

1. Ensure `claimed_paths` is observable from any session (cross-session reads work, per A4 of the spec).
2. Ensure the `agents.json` writer does NOT silently clobber another session's `claimed_paths` field. The current writer's `...prev` spread already does the right thing **per session**, since each session has its own record keyed by `session_id`. But the writer must not modify another session's record. Adding a defensive test (A2.2 candidate) that asserts "writing session A's record leaves session B's `claimed_paths` byte-identical" is recommended.

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

- **`last_modified_paths`**: 1000-entry cap with FIFO eviction at write time. If a write would produce more than 1000 entries, drop the oldest (lowest-time) entries until the count is ≤ 1000. The TTL prune happens first, then the cap is applied. In practice the TTL will usually dominate.
- **`claimed_paths`**: soft cap of 256 entries enforced at write time. A `caws claim --paths` call that would produce more than 256 entries is rejected at the CLI layer with an error directing the user to use coarser globs. The reason: 256 is comfortably above realistic explicit-claim use (a human declaring "these paths are mine") and well below the size at which `agents.json` reads become noticeably slow. Operator override via policy is **not** added in v1; if production telemetry shows the cap is wrong, a follow-up slice can lift it.

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
  - `readonly bound_spec_id?: string` (retrofit; field already on disk)
- `packages/caws-cli/src/store/agents-store.ts` (or `worktree/types.ts`): export `isAgentRecord(value: unknown): value is AgentRecord` per the drift-mitigation predicate. This is the only behavior addition in commit 1.
- Tests: A1 (v1 records load with new fields undefined), A8 (non-agent top-level keys ignored by predicate), `bound_spec_id` retrofit (existing on-disk records expose the field through the typed interface).
- No writer change in this commit. No policy schema change. No CLI surface.

**Commit 2 — writer + policy key (still no shell-side claim surface):**

- `packages/caws-cli/src/store/apply-patch.ts`: extend `applyRefreshAgent` (and the `RegistryPatch` discriminated union) to accept and write `claimed_paths` and `last_modified_paths`. TTL prune happens here per Q2.
- `packages/caws-kernel/src/schemas/policy.v1.json`: additive optional key `agents.last_modified_paths_ttl_seconds`, integer, bounds `[60, 86400]`, default `1800` (30 minutes).
- Tests: A2 (writer accepts claim payload), A3 (TTL window prune), A5 (stale-record claim preservation), A6 (no new doctor diagnostics fire), cross-session non-interference (Q3 defensive test asserting that writing session A's record leaves session B's `claimed_paths` byte-identical).

**Commit 3 — explicit-claim CLI surface (`caws claim --paths`):**

- New shell command `caws claim --paths <pattern>...` in `packages/caws-cli/src/shell/` writes the claim into the current session's record via the writer added in commit 2. Enforces the 256-entry cap per Q6.
- Tests: end-to-end claim write, claim cap rejection, claim path validation (non-empty, no null bytes).
- This is the only shell-side addition in the activated slice. Other surfaces (`caws status`, `caws doctor`) remain untouched per A6.

**Commit 4 — closure:**

- `caws specs close SESSION-OWNERSHIP-METADATA-001 --reason "<closure prose>"` via single bash invocation (not nested `bash -c`; see [[project_caws_known_defects]] for the audit-drift incident).
- Closure notes record: schema strategy (no JSON schema; predicate helper instead), TTL default (1800 sec via policy), cap values (1000 last_modified / 256 claimed), `bound_spec_id` retrofit landed, A8 predicate landed, and pointers to the three consumer slices.

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
   - **(c)** add `bound_spec_id` retrofit to acceptance and scope. The new acceptance criterion records that the field, already present on disk, is formalized into `AgentRecord` and exposed through the typed interface.
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
4. The amendment commit is `chore(caws): amend SESSION-OWNERSHIP-METADATA-001 scope for activation`. It bundles the ADR doc + the four spec corrections + A8. **No implementation code is in this commit.**
5. Activation itself is a separate commit (`chore(caws): activate SESSION-OWNERSHIP-METADATA-001`).

The four implementation commits then follow per the plan above. Commit 3's scope-amendment for the shell surface is a separate, smaller amendment commit within the activated slice.

## Non-goals (explicit guards)

- No takeover surface. No claim-revocation logic. No blocking behavior. No refusals.
- No new event schemas. No emission of `agent_claimed_paths` or similar events.
- No batch migration of existing `agents.json`. Write-on-update is sufficient.
- No top-level structure changes to `agents.json`. The drift in §Discovered state stays drift; this slice does not normalize.
- No JSON schema for `agents.json`. TypeScript-types-only.
- No kernel authority changes. The new fields are advisory.
- No edits to other multi-agent specs (`WORKING-TREE-PROVENANCE-GUARD-001`, `MULTI-AGENT-PUSH-RANGE-GUARD-001`, `MULTI-AGENT-HANDOFF-EVENT-001`). Those slices consume the new data; their specs encode their own semantics.
