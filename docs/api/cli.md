---
doc_id: caws-cli-api-reference
authority: reference
status: active
title: CAWS CLI API Reference (v11.6.0)
owner: vNext rewrite team
updated: 2026-07-03
---

# CAWS CLI API Reference (v11.6.0)

The CAWS CLI (`@paths.design/caws-cli`) is the governance surface for the Coding Agent Working Standard. The v11 line ships fourteen top-level commands/groups: `init`, `doctor`, `status`, `scope`, `claim`, `gates`, `evidence`, `events`, `waiver`, `specs`, `worktree`, `agents`, `message`, `prepush`, plus the auto-generated `help`.

**Doctrine source:** [`docs/architecture/caws-vnext-command-surface.md`](../architecture/caws-vnext-command-surface.md). When this reference and the doctrine doc disagree, the doctrine doc wins.

**Generated exhaustive reference:** [`docs/command-reference.md`](../command-reference.md) is generated from `COMMAND_SURFACE_METADATA`, the same metadata used for CLI `--help`. This hand-authored API reference documents every leaf command and the behavioral context; generated flag details live there.

Commands that existed in v10.x and do not ship in the v11 line are listed in [§ Removed in v11](#removed-in-v11). `caws parallel` and `caws session` are deferred to v11.3+ and are not replaceable by pinning to v10.2.x.

## Installation

```bash
npm install -g @paths.design/caws-cli@^11.6.0
caws --version
```

The package depends on `@paths.design/caws-kernel@^1.4.0` (pure governance primitives). Both are published independently.

## Global flags

| Flag | Description |
|---|---|
| `--version`, `-V` | Show version number |
| `--help`, `-h` | Show help for any command |

Per-command JSON / quiet flags are documented under each command. There is no global `--json` / `--quiet` in v11; output mode is per-command.

## Exit codes (uniform)

| Code | Meaning |
|---|---|
| `0` | Success / observation |
| `1` | Domain failure (gate failed, doctor finding, scope refused, waiver duplicate) |
| `2` | Composition failure (not a git repo, can't read `.caws/`, missing required tooling) |

---

## 1. `caws init`

Bootstrap canonical vNext `.caws/` project state. With `--agent-surface`, also installs the corresponding hook pack.

```bash
caws init
caws init --plan
caws init --plan --json
caws init --agent-surface claude-code
caws init --agent-surface codex
```

| Flag | Description |
|---|---|
| `--plan` | Preview canonical `.caws/`, `.gitignore`, hook-pack, and settings changes without writing anything. |
| `--json` | Emit the read-only init plan as JSON with `--plan`. |
| `--agent-surface <name>` | Install a hook pack for an agent harness: `claude-code`, `codex`, `cursor`, `windsurf`, or `none`. When omitted, init attempts filesystem detection and skips hook install when ambiguous. |
| `--overwrite` | For hook-pack install: replace drifted or unmanaged files at managed pack paths. CAUTION: local edits to those files will be lost. |
| `--adopt` | For hook-pack install: leave drifted or unmanaged files in place without enforcing pack contents. CAUTION: pack drift is no longer tracked for those paths. |
| `--data` | Show structured data block on diagnostics. |

Behavior:

- Idempotent. Re-running on an already-initialized project is a no-op.
- `--plan` is read-only. It reports canonical paths that would be created or already exist, the `.gitignore` managed-block outcome, selected hook-pack file actions, Claude settings wiring plans, Codex trust notes, refusal reasons, and the next apply command.
- Refuses to run if legacy `.caws/working-spec.yaml` is present (migrate first; there is no `--force`).
- Creates the canonical layout:

  ```
  .caws/
    specs/                  # per-feature specs (.caws/specs/<id>.yaml)
    waivers/                # waiver records (.caws/waivers/<id>.yaml)
    policy.yaml             # gate block/warn/skip policy
    worktrees.json          # worktree registry
    leases/                 # agent lease files written by caws agents register/heartbeat/stop
    # events.jsonl is created on first append; never required at rest.
  ```

Exit codes: 0 (created or no-op), 1 (legacy residue refused), 2 (not a git repo / I/O failure).

---

## 2. `caws doctor`

Drift detection over `.caws/` state.

```bash
caws doctor
caws doctor --data
caws doctor --repair-plan
caws doctor --repair-plan --json
```

| Flag | Description |
|---|---|
| `--data` | Show structured data block on findings/diagnostics. |
| `--repair-plan` | Emit a read-only repair plan derived from doctor findings. |
| `--json` | Emit the repair plan as JSON with `--repair-plan`. |

Inspects the snapshot composed by the store and surfaces findings (missing files, malformed YAML, residue, ownership conflicts, etc.). Pure kernel-side inspection; the store composes the snapshot, doctor evaluates it.

`--repair-plan` keeps doctor read-only but reshapes findings into agent-actionable plan items. Each item includes the source rule, subject, severity, state class, safe next command, and either an allowed mutation class or a refusal reason. The plan is derived from the same composed snapshot and findings as `caws doctor`; it does not write specs, events, worktree registry state, leases, waivers, policy, or git worktree directories.

Exit codes: 0 (clean), 1 (findings or load errors), 2 (composition failure).

---

## 3. `caws scope`

Evaluate file paths against the bound spec scope.

### `caws scope show <path>`

Explain the scope decision for `<path>`. Always exits 0 (pure observation).

```bash
caws scope show src/foo.ts
caws scope show src/foo.ts --json
caws scope show src/foo.ts --spec FEAT-1
```

`--json` emits the stable decision contract used by hooks and automation. For
repairable refusals, the payload includes a `remediation` object with safe
handoff commands such as `caws specs amend-scope`, `caws worktree bind`, or
claimant inspection commands.

`--spec <id>` evaluates the path against a named spec as read-only context. It
answers "does this path fit this spec?" and reports JSON `mode:
spec_context`; it does not prove the current checkout owns write authority.

### `caws scope check <path>`

Enforce the scope decision for `<path>`.

```bash
caws scope check src/foo.ts
caws scope check src/foo.ts --json
caws scope check src/foo.ts --spec FEAT-1 --json
```

`--json` emits the same decision/remediation contract as `scope show --json`
while preserving enforcement exit codes.

With `--spec <id>`, exit codes enforce the path against the named spec's scope
only. For write authority, run without `--spec` from the owning worktree.

Exit codes: 0 (admit), 1 (refuse).

### `caws scope plan`

Evaluate multiple paths in one read-only run and group shared remediation
commands.

```bash
caws scope plan --path src/foo.ts --path docs/foo.md
caws scope plan --spec FEAT-1 --path src/foo.ts --path docs/foo.md
caws scope plan --paths-file changed-paths.txt --json
```

| Flag | Description |
|---|---|
| `--path <path>` | Path to evaluate; repeat for multiple paths. |
| `--paths-file <file>` | Read newline-delimited paths from a file. Blank lines and `#` comments are ignored. |
| `--spec <id>` | Evaluate every path against a named spec as read-only context. |
| `--json` | Emit per-path decisions, counts, and grouped remediation commands as JSON. |
| `--data` | Show structured data block on diagnostics. |

`scope plan` is observational: it uses the same decision/remediation contract
as single-path `scope show/check`, but it does not enforce or mutate. Grouped
commands are handoffs to existing governed mutation surfaces such as
`caws specs amend-scope`.

### `caws scope contention <path>`

Report which other active worktrees on the same base branch have a bound spec whose `scope.in` claims `<path>`. Always exits 0 and is intended for hook/tooling contention checks.

```bash
caws scope contention src/foo.ts
caws scope contention src/foo.ts --json
```

---

## 4. `caws status`

Read-only dashboard.

```bash
caws status
caws status --data
caws status --specs
caws status --worktrees --agents
caws status --doctor --json
```

| Flag | Description |
|---|---|
| `--data` | Show structured data block on rendered diagnostics. |
| `--specs` | Render only the focused specs panel. |
| `--worktrees` | Render only the focused worktrees panel. |
| `--agents` | Render only the focused agents panel. |
| `--doctor` | Render only the focused doctor panel. |
| `--json` | Emit selected status panels as JSON. |

Surfaces project, current context, claim panel (when run inside a registered worktree), agent lease summary, and active doctor findings. **Always observability — never mutates `.caws/`.** Running it any number of times produces zero `.caws/` byte changes (see invariant 7 in the doctrine doc).

Focused filters keep the same read-only snapshot but render only the requested panels. Combine filters to inspect several panels at once. `--json` emits the selected panel payloads with `read_only: true`; without any focused filter, JSON includes the status data panels (`specs`, `worktrees`, `agents`, `doctor`).

Exit code: 0 (always).

---

## 5. `caws claim`

Surface or take ownership of the current worktree; with `--paths`, declare working-tree ownership metadata on the current session's lease.

```bash
caws claim                  # read-only inspection (default)
caws claim --plan           # read-only ownership/takeover preview
caws claim --takeover --plan --json
caws claim --takeover       # acquire ownership from a foreign session
caws claim --paths src/foo  # declare path ownership on current session lease
caws claim --release-paths  # preview clearing current session lease path claims
caws claim --release-paths --apply
```

| Flag | Description |
|---|---|
| `--takeover` | Forcibly take ownership of a foreign-owned worktree. Required when the current owner is a different session. |
| `--plan` | Preview claim ownership or takeover impact without mutating `worktrees.json`, leases, specs, events, or git state. |
| `--json` | Emit the read-only claim plan or release-paths result as JSON. |
| `--release-paths` | Clear the current session lease `claimed_paths`. Dry-run by default; pair with `--apply` to write the lease update. |
| `--apply` | Apply `--release-paths`. Not used for normal claim or takeover, which keep their existing behavior. |
| `--paths <path>` | Declare a path as claimed by the current session. Repeatable; order preserved; strings stored verbatim. Refused with no write if no lease exists for the current session. (SESSION-OWNERSHIP-METADATA-001) |
| `--data` | Show structured data block on diagnostics. |

Without `--takeover`: prints the current claim (`<sessionId>:<platform>`, last heartbeat age, any `tmp/<sessionId>/` session-log pointer) and exits non-zero when the worktree is owned by a different session. Modifies nothing.

With `--takeover --plan`: reports the current owner, resulting owner, and prior-owner audit row that would be appended. No registry, lease, spec, event, or git state is written.

With `--takeover`: rewrites the owner to the current session id and appends the prior owner (sessionId, platform, last_seen, takenOver_at) to a `prior_owners` audit array on the worktree entry in `.caws/worktrees.json`. Durable across sessions — postmortems can see what happened.

With `--release-paths`: previews clearing the current session's lease `claimed_paths` without changing ownership. With `--release-paths --apply`, writes only the current session lease path metadata (`claimed_paths: []`) through the lease store; it does not take over a foreign owner, mutate specs, append events, or touch git state.

**Use `--takeover` only with explicit user authorization.** A stale heartbeat is not authorization — paused sessions are not ended sessions. Read the session log under `tmp/<sessionId>/` first.

Exit codes: 0 (claim succeeds or already owned), 1 (foreign claim without `--takeover`), 2 (composition failure / not in a worktree).

---

## 6. `caws gates`

Inspect and run policy-driven quality gates against current changes.

### `caws gates list`

```bash
caws gates list
caws gates list --spec FEAT-1 --json
```

| Flag | Description |
|---|---|
| `--spec <id>` | Optional spec id for spec-scoped waiver matching. |
| `--json` | Emit gate summaries, risk tiers, and waiver policy as JSON. |
| `--data` | Show structured data block on diagnostics. |

Read-only policy discovery. The command reports configured gates, enabled state, mode, thresholds, effective waiver ids, risk-tier budgets, and waiver policy without running evaluators or appending `gate_evaluated` events.

### `caws gates explain <gate>`

```bash
caws gates explain budget_limit
caws gates explain budget_limit --spec FEAT-1 --json
```

| Flag | Description |
|---|---|
| `--spec <id>` | Optional spec id for spec-scoped waiver matching. |
| `--json` | Emit the gate explanation as JSON. |
| `--data` | Show structured data block on diagnostics. |

Read-only explanation for one configured policy gate. Unknown gate ids exit nonzero and print the accepted gate set.

### `caws gates run`

Run policy-driven quality gates and append evidence.

```bash
caws gates run --spec <id>
caws gates run --spec <id> --context commit
caws gates run --spec <id> --data
```

| Flag | Description |
|---|---|
| `--spec <id>` | Spec id this gate run is about. |
| `--context <ctx>` | Subprocess context: `cli`, `commit`, or `ci` (default: `cli`). |
| `--data` | Show structured data block on diagnostics. |

Behavior:

- `policy.yaml` declares each gate's mode (`block`, `warn`, `skip`).
- For each declared gate, appends one `gate_evaluated` event to `.caws/events.jsonl` (hash-chained via the store's `appendEvent`).
- Waivers filter matching violations out of the disposition; they do not change gate mode.

Exit codes: 0 (all blocking gates pass), 1 (a blocking gate fails after waiver filtering), 2 (composition failure).

---

## 7. `caws evidence`

Record, inspect, and describe typed evidence events in `.caws/events.jsonl`.

### `caws evidence record`

Append a typed evidence event.

```bash
caws evidence record \
  --type test --spec FEAT-1 \
  --data '{"command":"npm test","exit_code":0}'
caws evidence record \
  --type gate --spec FEAT-1 \
  --data '{"gate_id":"budget_limit","mode":"block","result":"pass","violations":[]}'
caws evidence record \
  --type ac --spec FEAT-1 \
  --data '{"criterion_id":"A1","status":"pass","evidence_ref":"npm test"}'
```

| Flag | Description |
|---|---|
| `--type <kind>` | Evidence kind: `test`, `gate`, or `ac`. |
| `--spec <id>` | Spec id this evidence is bound to. |
| `--data <json>` | Inline JSON payload describing the evidence. Schema is per-`--type`; inspect it with `caws evidence schema --type <kind>`. |
| `--actor-kind <kind>` | Actor kind: `agent`, `human`, `system`, or `automation` (default: `agent`). |
| `--actor-id <id>` | Override actor id (defaults to session id). |

The event is appended through the store's `appendEvent` (hash-chained, atomic, locked). There is no other path that may write `events.jsonl`.

Exit codes: 0 (recorded), 1 (validation failure on `--data`), 2 (composition failure).

### `caws evidence schema`

```bash
caws evidence schema --type test
caws evidence schema --type gate --json
caws evidence schema --type ac
```

| Flag | Description |
|---|---|
| `--type <kind>` | Evidence kind: `test`, `gate`, or `ac`. |
| `--json` | Emit the kernel-derived payload schema, required fields, and example command as JSON. |

Read-only schema discovery for `caws evidence record`. The command derives the payload contract from the same kernel schemas that validate `test_recorded`, `gate_evaluated`, and `ac_recorded` events. It does not read, append, rewrite, rotate, or lock `.caws/events.jsonl`.

### `caws evidence list`

```bash
caws evidence list --spec FEAT-1
caws evidence list --spec FEAT-1 --type test --json
```

| Flag | Description |
|---|---|
| `--spec <id>` | Spec id whose typed evidence should be listed. |
| `--type <kind>` | Optional evidence kind filter: `test`, `gate`, or `ac`. |
| `--json` | Emit the evidence list as JSON. |
| `--data` | Show structured data block on diagnostics. |

Read-only evidence history over the hash-chained event log. The command verifies the loaded chain, filters to typed evidence events (`test_recorded`, `gate_evaluated`, `ac_recorded`), and reports stable `seq`/`hash` handles for follow-up inspection.

### `caws evidence show <event-ref>`

```bash
caws evidence show 42
caws evidence show sha256:0123456789abcdef...
caws evidence show sha256:0123456789ab --json
```

| Flag | Description |
|---|---|
| `--json` | Emit the matched event as JSON. |
| `--data` | Show structured data block on diagnostics. |

Read-only event lookup by sequence number, exact event hash, or unique event-hash prefix. Ambiguous prefixes and missing references exit nonzero without mutating `events.jsonl`.

---

## 8. `caws events`

Read and maintain `.caws/events.jsonl`.

### `caws events list`

```bash
caws events list
caws events list --limit 0
caws events list --json
```

| Flag | Description |
|---|---|
| `--json` | Emit the chain summary, rotation summaries, and recent events as JSON. |
| `--limit <n>` | Number of recent events to include (default: 20; use `0` for summary only). |
| `--data` | Show structured data block on diagnostics. |

Read-only event-log discovery. The command verifies the current hash chain, reports the event count, counts by event type, the latest event handle, recent events, and `chain_rotated` archive status. Rotation summaries include archive path, prior digest, prior line count, prior chain status, archive presence, and digest/line-count match when the archive is present.

### `caws events show <event-ref>`

```bash
caws events show 42
caws events show sha256:0123456789ab --json
caws events show latest-rotation --json
```

| Flag | Description |
|---|---|
| `--json` | Emit the matched event and rotation status as JSON. |
| `--data` | Show structured data block on diagnostics. |

Read-only lookup by sequence number, exact event hash, unique event-hash prefix, or the special `latest-rotation` ref. The command verifies the current chain before resolving the reference. Missing and ambiguous references exit nonzero without mutating `events.jsonl`.

### `caws events migrate`

Migrate a v10-shape `events.jsonl` to a v11 chain via `chain_rotated` rotation. Dry-run by default.

```bash
caws events migrate
caws events migrate --from v10 --apply --reason "v10 migration"
```

### `caws events rotate`

Rotate `events.jsonl`: archive existing chain, start fresh chain with `chain_rotated` genesis event. Distinct from `migrate` — admits fully-unparseable logs.

```bash
caws events rotate --dry-run --reason "operator maintenance" --allow-clean
caws events rotate --dry-run --reason "operator maintenance" --allow-clean --json
caws events rotate --reason "operator maintenance"
caws events rotate --reason "operator maintenance" --allow-clean
```

| Flag | Description |
|---|---|
| `--reason <text>` | Operator reason recorded into the `chain_rotated` payload. Required. |
| `--dry-run` | Preview archive path, digest, actor-shape stats, and genesis event without mutating `events.jsonl`. |
| `--json` | Emit the dry-run plan as JSON. |
| `--actor-kind <kind>` | Actor kind: `agent`, `human`, `system`, or `automation` (default: `agent`). |
| `--actor-id <id>` | Override actor id (defaults to session id). |
| `--allow-clean` | Allow rotation of a clean v11 chain. Without this flag, clean-chain rotation refuses as an explicit friction guard. |

Dry-run is read-only for audit storage: it does not rename, archive, append, or rewrite `events.jsonl`. The JSON plan includes the target archive path, prior file digest, prior line count, prior chain status, actor-shape stats, and the `chain_rotated` genesis event that an apply run with the same timestamp and inputs would write.

### `caws events verify-archive`

Verify that the archive file named in the most recent `chain_rotated` event byte-matches its committed digest and line count.

```bash
caws events verify-archive
```

Exit codes: 0 (verified / dry-run), 1 (digest mismatch or missing archive), 2 (composition failure).

---

## 9. `caws waiver`

Manage waiver records that filter matching gate violations.

**Singular surface only — `caws waivers` (plural) is removed.**

### `caws waiver create <id>`

```bash
caws waiver create FEAT-001-WAIVER-001 \
  --title "Emergency budget breach" \
  --gate budget_limit \
  --reason "Refactor required emergency budget breach" \
  --approved-by "team-lead@example.com" \
  --expires-at "2026-12-01T00:00:00Z"
caws waiver create FEAT-001-WAIVER-002 \
  --title "Preview waiver" \
  --gate budget_limit \
  --reason "Preview the waiver record before writing it" \
  --approved-by "team-lead@example.com" \
  --expires-at "2026-12-01T00:00:00Z" \
  --dry-run --json
```

| Flag | Description |
|---|---|
| `--title <title>` | Short waiver title (≥5 chars). **Required.** |
| `--gate <gate>` | Gate id this waiver covers. Repeatable for multiple gates. |
| `--reason <text>` | Justification for the waiver. |
| `--approved-by <id>` | Approver identity. |
| `--expires-at <iso8601>` | Expiry as an ISO-8601 datetime with timezone. |
| `--spec <id>` | Optional spec id this waiver is scoped to. Omit for project-wide scope. |
| `--dry-run` | Validate the candidate and duplicate id without writing `.caws/waivers/<id>.yaml`. |
| `--json` | Emit the dry-run candidate as JSON. |
| `--data` | Show structured data block on diagnostics. |

Dry-run mode is read-only: it validates the same kernel waiver candidate as
normal create, checks for a duplicate id in loaded waiver records, and does not
write waiver files or append events.

Exit codes: 0 (created or valid dry-run), 1 (duplicate id, validation failure), 2 (composition failure).

### `caws waiver list`

```bash
caws waiver list
```

Lists active waivers with id, gate, expiry, and approval metadata. By default excludes revoked and expired records.

### `caws waiver show <id>`

```bash
caws waiver show FEAT-001-WAIVER-001
```

Shows full waiver record (yaml), including its derived effectiveness at now.

### `caws waiver revoke <id>`

```bash
caws waiver revoke FEAT-001-WAIVER-001
```

Marks the waiver revoked. Subsequent `caws gates run` no longer filters violations through it. Refuses double-revoke.

Exit codes: 0 (revoked), 1 (not found, already revoked), 2 (composition failure).

### `caws waiver prune`

```bash
caws waiver prune --status expired
caws waiver prune --status expired --json
caws waiver prune --status expired \
  --apply \
  --reason "Expired waiver cleanup" \
  --revoked-by "agent@example.com"
```

| Flag | Description |
|---|---|
| `--status <status>` | Required selector. Currently only `expired`. |
| `--apply` | Revoke the selected expired active waivers. Without `--apply`, prune is a dry-run plan. |
| `--reason <text>` | Required with `--apply`; stored in each revocation record. |
| `--revoked-by <id>` | Required with `--apply`; stored in each revocation record. |
| `--json` | Emit the prune plan/result as JSON. |
| `--data` | Show structured data block on diagnostics. |

Dry-run mode prints the exact target set and does not mutate waiver files.
Apply mode mutates only expired active waivers by writing normal revocation
metadata through the waiver store path.

Exit codes: 0 (plan or apply completed), 1 (invalid selector or missing apply metadata), 2 (composition failure).

---

## 10. `caws specs`

Manage CAWS spec lifecycle.

### `caws specs create <id>`

```bash
caws specs create FEAT-1 \
  --title "Add widget support" \
  --mode feature \
  --risk-tier 1
caws specs create FEAT-1 \
  --title "Add widget support" \
  --mode feature \
  --risk-tier 1 \
  --plan
caws specs create FEAT-2 \
  --title "Low-risk docs slice" \
  --mode doc \
  --tier 3 \
  --scope-in docs/widget.md \
  --plan --json
```

| Flag | Description |
|---|---|
| `--title <title>` | Short spec title. |
| `--mode <mode>` | Spec mode: `feature`, `refactor`, `fix`, `doc`, or `chore`. |
| `--risk-tier <n>` | Risk tier: `1`, `2`, or `3`. |
| `--tier <n>` | Alias for `--risk-tier`; writes the canonical `risk_tier` field. |
| `--scope-in <path>` | Seed `scope.in`; repeatable. |
| `--contract <entry>` | Seed a contract entry; repeatable. |
| `--plan` | Read-only preflight. Render and validate the candidate without writing `.caws/specs/<id>.yaml` or appending events. |
| `--json` | With `--plan`, emit the candidate, diagnostics, missing fields, and create command as JSON. |
| `--data` | Show structured data block on diagnostics. |

Creates a new spec in `lifecycle_state: active`. `--plan` validates the same
candidate path that normal create would write, but exits without mutation; this
is useful for tier 1/2 specs where required semantic fields such as contracts,
observability, rollback, or security need to be planned before the YAML exists.
When tier-required semantic fields are missing, plan output includes
copy-pasteable YAML examples for those fields; JSON output exposes the same
examples in `field_examples`.
Note: `--type` is a removed v10 alias; use `--mode` instead.

Not returned in v11.1: `specs update`, `specs delete`, `specs conflicts`, `specs types`. Edit the YAML directly for field updates; schema validation runs on `caws doctor` and `caws gates run`.

### `caws specs list`

```bash
caws specs list
caws specs list --archived
```

Lists specs. By default excludes archived specs.

### `caws specs show <id>`

```bash
caws specs show FEAT-1
caws specs show FEAT-1 --archived
```

Show a spec by id. Pass `--archived` to recover an archived spec body from the event log and git history.

### `caws specs recover <id>`

```bash
caws specs recover FEAT-1
caws specs recover FEAT-1 --out path/to/output.yaml
```

Recover an archived spec body. Reads `.caws/events.jsonl` for the `spec_archived` event, prefers an on-disk `.caws/specs/.archive/<id>.yaml` body for move-shaped archives, and falls back to git history/blob recovery. Prints to stdout (or `--out <path>`). Does NOT mutate `.caws/specs/`.

### `caws specs restore <id>`

```bash
caws specs restore FEAT-1 --as draft
caws specs restore FEAT-1 --as active --apply
caws specs restore FEAT-1 --as draft --json
```

Restore a recoverable archived or retired spec body back to `.caws/specs/<id>.yaml` as `draft` or `active`. Defaults to a read-only dry-run plan. `--apply` writes the validated body and appends `spec_restored`.

Restore refuses to overwrite an existing canonical spec. During restore it clears stale top-level lifecycle authority that should not be resurrected into draft/active state: `resolution`, `closure_notes`, `superseded_by`, and `worktree`.

### `caws specs retire-draft <id>`

```bash
caws specs retire-draft FEAT-1
```

Governed retirement of a never-activated draft spec. Refuses active specs (use `close`), closed specs (use `archive`), and archived specs. Deletes the draft YAML through the recoverable lifecycle path and appends `spec_retired`.

### `caws specs prune-drafts`

```bash
caws specs prune-drafts
caws specs prune-drafts --older-than-ms 604800000 --json
caws specs prune-drafts --include FEAT-1,FEAT-2 --exclude FEAT-2
caws specs prune-drafts --include FEAT-1 --include-bound
caws specs prune-drafts --older-than-ms 604800000 --apply --reason "stale draft cleanup"
```

Stale draft cleanup planning and guarded apply. Dry-run is the default: the command classifies draft specs as `candidate`, `skipped`, or `refused` using age, explicit include/exclude selectors, and worktree binding state without writing events or spec files.

Default stale threshold is seven days (`604800000` ms) using `updated_at` when present, otherwise `created_at`. Bound drafts are refused by default; `--include-bound` allows bound drafts to appear as candidates. `--apply` requires `--include` or an explicit `--older-than-ms`, refuses mutation when the selected plan has refused entries, and retires candidates through the same governed `spec_retired` tombstone path as `caws specs retire-draft <id>`.

### `caws specs activate <id>`

```bash
caws specs activate FEAT-1
```

Governed activation of a pre-authored draft spec. Draft-only: patches `lifecycle_state: active`, refreshes `updated_at`, and appends `spec_activated`.

### `caws specs amend-scope <id>`

```bash
caws specs amend-scope FEAT-1 --add src/foo.ts --add docs/foo.md
caws specs amend-scope FEAT-1 --remove tmp/old.md --reason "scope narrowed"
```

Governed scope amendments for an active spec. Use one invocation with all `--add`/`--remove` values for a logical amendment.

### `caws specs close <id>`

```bash
caws specs close FEAT-1
caws specs close FEAT-1 --resolution completed
caws specs close FEAT-1 --closure-notes "Completed in worktree merge"
```

Close an active spec. Non-destructive raw-byte YAML patch; appends `spec_closed` event.

`--reason <text>` and `--closure-notes <text>` both write the spec's `closure_notes` field and the corresponding close-event note. Use one or the other, not both.

If the spec is already closed, the command refuses without changing closure metadata and prints state-aware next steps: inspect with `caws specs show <id>`, archive with `caws specs archive <id>`, or recover the body after archive with `caws specs recover <id> --out <path>`.

### `caws specs archive [id]`

```bash
caws specs archive FEAT-1
caws specs archive --status closed
caws specs archive --status closed --include FEAT-1,FEAT-2 --exclude FEAT-2
caws specs archive --status closed --older-than-ms 604800000 --updated-before 2026-07-01T00:00:00.000Z
caws specs archive --status closed --without-worktree
caws specs archive --status closed --json
caws specs archive --status closed --apply
```

Archive one closed spec, or batch-archive closed specs. Single-spec mode moves the YAML file to `.caws/specs/.archive/` and appends `spec_archived`.

Batch mode requires `--status closed`, defaults to dry-run, and prints the matching set plus a copy-pasteable `--apply` command. `--include <ids>` and `--exclude <ids>` accept comma-separated spec ids. Age/date selectors use `updated_at` when present and `created_at` as fallback: `--older-than-ms <ms>` requires the timestamp age to meet the threshold, and `--updated-before <timestamp>` requires the timestamp to be before the cutoff. `--without-worktree` excludes closed specs that still carry a `worktree:` binding. `--apply` archives selected closed specs through the governed archive path and creates one aggregate audit commit for the batch.

### `caws specs prune-archive`

```bash
caws specs prune-archive
caws specs prune-archive --apply
```

Compatibility no-op. Archived spec bodies under `.caws/specs/.archive/` are canonical again and are not pruned by CAWS. `--apply` is accepted for compatibility and does not remove files.

### `caws specs migrate`

```bash
caws specs migrate
caws specs migrate --apply
caws specs migrate --apply --partial
```

v10→v11 spec YAML migrator (CAWS-MIGRATE-V10-SPECS-001). Default is dry-run; `--apply` opts into mutation. `--apply` without `--partial` refuses if any spec hits a "refused" verdict. `--apply --partial` writes migratable specs, skips refused, emits a durable JSON report under `.caws/migrations/v10-specs/`.

### `caws specs validate <file>`

```bash
caws specs validate .caws/specs/FEAT-1.yaml
caws specs validate path/to/spec.yaml --data
```

Validate one spec YAML file on disk using the CLI's bundled parser and the kernel parse→shape→semantics pipeline. Path-shaped: takes a file path, not a spec id. It does not resolve canonical `.caws/` state and does not mutate anything.

---

## 11. `caws worktree`

Manage CAWS worktrees. Worktrees are git worktrees bound to active specs.

### `caws worktree create <name>`

```bash
caws worktree create my-feature --spec FEAT-1
caws worktree create my-feature --spec FEAT-1 --base-branch main --branch feat/my-feature
```

| Flag | Description |
|---|---|
| `--spec <id>` | Active spec id to bind the worktree to. |
| `--base-branch <branch>` | Base branch to start from (default: current branch). |
| `--branch <branch>` | New branch name (default: worktree name). |
| `--data` | Show structured data block on diagnostics. |

Creates a new git worktree under `.caws/worktrees/<name>` bound to an active spec. Writes the bidirectional worktree↔spec binding, registers ownership, and emits `worktree_created` + `worktree_bound` events.

If `--spec` names a draft spec, the command refuses without creating the worktree and prints the safe handoff `caws specs activate <id>`. Activation must pass its own spec preflight before create/bind is retried.

### `caws worktree list`

```bash
caws worktree list
```

Lists registered worktrees with branch, spec binding, and owner.

### `caws worktree bind <name>`

```bash
caws worktree bind my-feature --spec FEAT-1
```

Repair bidirectional binding between a worktree and a spec (one-sided → bound).

Only active specs can be bound. If the target spec is still draft, the refusal includes `caws specs activate <id>` and leaves the registry, spec file, events, and worktree directory unchanged.

### `caws worktree destroy <name>`

```bash
caws worktree destroy my-feature
caws worktree destroy my-feature --abandon-unmerged
```

| Flag | Description |
|---|---|
| `--abandon-unmerged` | Destroy even when the branch is not merged into base. Still respects ownership and clean working tree. |
| `--data` | Show structured data block on diagnostics. |

Non-forceful: refuses foreign ownership, dirty checkout, unmerged branch (use `--abandon-unmerged` to override branch check only).

### `caws worktree untrack <name>`

```bash
caws worktree untrack my-feature --reason "preserve files for review"
caws worktree untrack my-feature --reason "preserve files for review" --apply
caws worktree untrack my-feature --reason "preserve files for review" --json
```

| Flag | Description |
|---|---|
| `--reason <reason>` | Required operator reason recorded on the `worktree_untracked` audit event. |
| `--apply` | Apply the untrack plan. Without `--apply`, the command only prints the plan. |
| `--json` | Emit the dry-run plan or apply outcome as JSON. |
| `--data` | Show structured data block on diagnostics. |

Releases a CAWS registry/spec binding while preserving the physical git worktree directory for inspection. Dry-run is the default. Apply refuses foreign-owned worktrees, dirty checkouts, and missing physical directories; it removes only the control-plane binding, clears the matching spec `worktree:` field when present, and appends `worktree_untracked`.

### `caws worktree merge <name>`

```bash
caws worktree merge my-feature
caws worktree merge my-feature --dry-run
caws worktree merge my-feature --message "merge(worktree): integrate widget support"
```

| Flag | Description |
|---|---|
| `--dry-run` | Validate prerequisites only; no git, no file writes, no events. |
| `--message <text>` | Custom merge commit message (default: `merge(worktree): <name>`). |
| `--data` | Show structured data block on diagnostics. |

Merge a worktree branch into its base. Auto-closes the bound spec via `caws specs close`.

### `caws worktree migrate-registry`

```bash
caws worktree migrate-registry
caws worktree migrate-registry --dry-run
```

Convert v10.2 legacy-envelope `.caws/worktrees.json` into the v11 flat-map shape. Idempotent on already-flat files.

### `caws worktree repair-sparse <name>`

```bash
caws worktree repair-sparse my-feature
```

Restore the `.caws/specs` sparse-checkout invariant on a linked worktree. Idempotent and non-destructive: refuses if `.caws/specs/` has dirty or untracked content rather than stashing, cleaning, resetting, or deleting it.

### `caws worktree repair`

```bash
caws worktree repair
caws worktree repair --dry-run
```

Repair unambiguous worktree/spec half-states surfaced by `caws doctor`: prune ghost registry entries and clear dead spec→worktree bindings. Refuses ambiguous or forbidden classes with zero mutation. Never creates or deletes a git worktree directory.

### `caws worktree prune`

```bash
caws worktree prune
caws worktree prune --state ghost-registry,closed-spec-residue
caws worktree prune --include wt-old,SPEC-001 --exclude wt-foreign --json
caws worktree prune --state ghost-registry,dead-binding --apply
```

| Flag | Description |
|---|---|
| `--state <classes>` | Comma-separated state-class filter, such as `ghost-registry`, `closed-spec-residue`, or `event-orphan-refused`. |
| `--include <subjects>` | Comma-separated worktree names, spec ids, or paths to include. |
| `--exclude <subjects>` | Comma-separated worktree names, spec ids, or paths to exclude. |
| `--apply` | Apply only safe cleanup classes: `ghost-registry`, `dead-binding`, and `closed-spec-residue`. Refused classes still do not mutate. |
| `--json` | Emit the plan or apply outcome as JSON. |
| `--data` | Show structured data block on diagnostics. |

Cleanup plan over doctor evidence. Dry-run is the default: it classifies worktree residue and refusal classes, names the next safe command, and does not mutate `worktrees.json`, specs, events, or git worktree directories. `--apply` executes only the same mechanically safe writer paths already proven by `caws worktree repair`; event orphans, foreign physical worktrees, stale-owner lease drift, and other refused classes stay refused.

### `caws worktree cleanup-plan`

```bash
caws worktree cleanup-plan
caws worktree cleanup-plan --state destroy-ready,dirty-refused
caws worktree cleanup-plan --include wt-old,SPEC-001 --exclude wt-foreign --json
caws worktree cleanup-plan --state destroy-ready --apply
```

| Flag | Description |
|---|---|
| `--state <classes>` | Comma-separated state-class filter, such as `destroy-ready`, `dirty-refused`, `foreign-owned-refused`, or `unregistered-physical-refused`. |
| `--include <subjects>` | Comma-separated worktree names, spec ids, or paths to include. |
| `--exclude <subjects>` | Comma-separated worktree names, spec ids, or paths to exclude. |
| `--apply` | Apply selected `destroy-ready` candidates only. Requires at least one explicit selector: `--state`, `--include`, or `--exclude`. Refused classes still do not mutate. |
| `--json` | Emit the plan or apply outcome as JSON. |
| `--data` | Show structured data block on diagnostics. |

Physical cleanup plan over real git worktree directories. Dry-run is the default: it classifies registered worktrees and unregistered physical git worktrees under `.caws/worktrees/` by clean/dirty state, merged/unmerged branch state, bound spec lifecycle, registry ownership, and CAWS registry presence without deleting a directory, mutating `.caws/worktrees.json`, patching spec YAML, appending events, or invoking `git worktree remove`.

Apply mode is intentionally narrow. `--apply` refuses unless at least one selector is present, applies only selected `destroy-ready` registered worktrees, and calls the existing `destroyWorktree` path for each deletion so ownership, clean checkout, and merged-branch checks are re-evaluated at mutation time. Selected non-apply classes such as `dirty-refused`, `unmerged-refused`, `foreign-owned-refused`, and `unregistered-physical-refused` remain refused.

State classes include `destroy-ready`, `unbound-clean-candidate`, `dirty-refused`, `unmerged-refused`, `active-bound-refused`, `foreign-owned-refused`, `missing-directory-refused`, `not-git-worktree-refused`, `unknown-spec-refused`, `unregistered-physical-refused`, and `git-observation-unavailable`.

Note: `caws worktree reconcile` is deferred to v11.2+.

---

## 12. `caws agents`

Agent liveness substrate. **Operational cache only — NEVER authority.** State lives in `.caws/leases/`. CAWS-native JSON; never Claude Code hook envelope.

### `caws agents register`

```bash
caws agents register --session-id <id> --platform claude-code --reason session_start
```

Register this session in `.caws/leases/`. Hook-invoked at `SessionStart`.

| Flag | Description |
|---|---|
| `--session-id <id>` | Explicit session id (required for hook-invoked usage; overrides `resolveSession`). |
| `--platform <p>` | Platform tag (e.g., `claude-code`, `cursor`, `manual`). |
| `--reason <r>` | `session_start`, `pre_tool_use`, `manual_register`, `claim`, or `status`. |
| `--json` | Emit CAWS-native JSON to stdout. |
| `--include-active-summary` | Include `active_agent_count` + `active_agents` in JSON output. |
| `--data` | Show structured data block on diagnostics. |

### `caws agents heartbeat`

```bash
caws agents heartbeat
```

Refresh this session's lease. Hook-invoked at `PreToolUse`. Throttle-aware.

### `caws agents stop`

```bash
caws agents stop
```

Mark this session's lease stopped. Hook-invoked at `Stop`. Warn no-op if no prior lease.

### `caws agents list`

```bash
caws agents list
caws agents list --include-stale --include-stopped
caws agents list --active
caws agents list --json
```

| Flag | Description |
|---|---|
| `--include-stale` | Include stale (active-but-TTL-expired) records. |
| `--include-stopped` | Include stopped records. |
| `--active` | Active-only (overrides `--include-*` flags); TTL-classified active, not raw status field. |
| `--stale-ttl-ms <ms>` | TTL for stale classification (default: 1800000 = 30m). |
| `--json` | Emit CAWS-native JSON to stdout. |
| `--data` | Show structured data block on diagnostics. |

### `caws agents show <id>`

```bash
caws agents show <session-id>
caws agents show <session-id> --json
```

Show one lease by session id. Read-only.

### `caws agents prune`

```bash
caws agents prune --status stopped --older-than-ms 604800000
caws agents prune --status stale --older-than-ms 604800000 --apply
caws agents prune --dead --json
caws agents prune --dead --apply
```

| Flag | Description |
|---|---|
| `--status <s>` | Filter by status: `stopped` or `stale`. |
| `--older-than-ms <ms>` | Retention threshold in milliseconds. |
| `--dead` | Remove active/stopping leases on this host whose owning process is dead. Mutually exclusive with `--status`. |
| `--stale-ttl-ms <ms>` | TTL for stale classification (default: 30m). |
| `--apply` | Actually delete (default: dry-run). |
| `--json` | Emit CAWS-native JSON to stdout. |
| `--data` | Show structured data block on diagnostics. |

Operator-invoked cleanup. Never invoked by hooks.

---

## 13. `caws message`

Directed inter-agent messages over `.caws/messages.jsonl`. Messages are not authority; a message body is an unverified claim until checked against repo/runtime state.

### `caws message send`

```bash
caws message send --to <session-id> --text "Please inspect DOC-1"
caws message send --to <session-id> --text "Please inspect DOC-1" --allow-dead
```

Send a message to another session. By default refuses recipients that are not live in the agent registry.

### `caws message poll`

```bash
caws message poll
caws message poll --me <session-id> --wait 60000
caws message poll --peek --json
```

Pull the next undelivered message addressed to the current session, or to `--me`. Default behavior is deliver-once; `--peek` observes without consuming.

### `caws message inbox`

```bash
caws message inbox
caws message inbox --me <session-id> --limit 20
caws message inbox --json
```

Read-only inbox listing for undelivered messages. Unlike `poll`, this command never appends delivery records and never consumes messages. JSON output includes `read_only: true`, `waiting`, and the returned `messages`.

### `caws message history`

```bash
caws message history --with <session-id>
caws message history --me <session-id> --with <other-session-id> --limit 50
caws message history --with <session-id> --json
```

Read-only channel history between two endpoints. History includes both directions in message-log order; `--limit` returns the most recent messages while preserving log order. Message bodies remain communication, not authority or evidence.

### `caws message prune`

```bash
caws message prune --status delivered
caws message prune --status delivered --older-than-ms 604800000 --apply
caws message prune --status delivered --include <message-id>,<message-id> --exclude <message-id> --json
```

Dry-run-first retention cleanup for non-authoritative chat logs. Only delivered message records are candidates; undelivered inbox messages are preserved and reported as skipped. `--apply` rewrites `.caws/messages.jsonl` only when paired with an explicit retention selector such as `--older-than-ms` or `--include`, and removes selected delivered messages plus their delivery markers.

---

## 14. `caws prepush`

Governed pre-push range check (MULTI-AGENT-PUSH-RANGE-GUARD-001). Classifies the outgoing commit range and refuses commits not attributable to the current slice. Diagnose/decide only — does not run `git push`.

```bash
caws prepush
caws prepush --base origin/main --spec FEAT-1
caws prepush --ack <sha>
```

| Flag | Description |
|---|---|
| `--remote <remote>` | Push remote (default: `origin`). |
| `--branch <branch>` | Push branch (default: `main`). |
| `--base <ref>` | Base ref override (default `<remote>/<branch>`). |
| `--spec <id>` | Current session active spec id for slice matching. |
| `--ack <sha>` | Acknowledge an unexpected commit by SHA. Repeatable. |
| `--data` | Show structured data block on diagnostics. |

---

## State files

What v11 owns and writes:

| Path | Owner | Writers |
|---|---|---|
| `.caws/specs/<id>.yaml` | `caws specs create / restore / retire-draft / activate / amend-scope / close / archive / validate` | store (atomic write + raw-byte YAML patch) |
| `.caws/specs/.archive/<id>.yaml` | `caws specs archive` | store (move from `.caws/specs/`) |
| `.caws/waivers/<id>.yaml` | `caws waiver create / revoke / prune --apply` | store (atomic write) |
| `.caws/policy.yaml` | manual edit (governed) | (none — the CLI reads but does not write this file) |
| `.caws/worktrees.json` | `caws worktree create/bind/destroy/untrack/merge/repair/prune/migrate-registry`, `caws claim / claim --takeover` | store (atomic write) |
| `.caws/leases/` | `caws agents register / heartbeat / stop / prune` | store (per-session lease files) |
| `.caws/messages.jsonl` | `caws message send / poll` | store (directed message log; not authority) |
| `.caws/events.jsonl` | `caws gates run`, `caws evidence record`, `caws claim --takeover`, `caws specs close/archive/restore/retire-draft`, `caws worktree create/merge/destroy/untrack/prune` | store's `appendEvent` ONLY (hash-chained) |

What v11 explicitly does NOT touch:

- `.caws/working-spec.yaml` — legacy single-spec authority, refused by `caws init`.
- `.caws/provenance/*` — legacy provenance tree, no v11 writer.
- Generated git hooks under `.git/hooks/*` — `caws hooks install` is removed; use `caws init --agent-surface <name>` to install hook packs.

---

## Removed in v11

The following commands existed in v10.x and are **removed in v11**. They are no longer registered with the CLI entrypoint and `caws --help` does not list them. Invoking them will fail.

| Removed | Reason category | Replacement |
|---|---|---|
| `caws validate / verify` | Replaced v10 validation bundle — used legacy spec resolution and parallel `events.jsonl` writers | `caws doctor` + `caws gates run --spec <id>` |
| `caws diagnose` | Renamed v10 diagnostic surface | `caws doctor` |
| `caws verify-acs` | Removed AC-evidence report | Encode AC-evidence assertions in your test suite directly. |
| `caws evaluate` | Removed quality-evaluation report | `caws gates run --spec <id>` covers policy gates; quality-evaluation reports are not reproduced. |
| `caws iterate` | Removed advisory iteration guidance | Use spec acceptance criteria as guidance. |
| `caws burnup` | Removed budget report | Derive budget burn-up from `caws status` + spec `change_budget` manually. |
| `caws scaffold` | Scaffold / hook risk (SH) | Out of scope for governed core |
| `caws hooks install / remove / status` | Authority conflict (AC) — generated hooks called removed commands | `caws init --agent-surface <name>` installs the hook pack |
| `caws provenance init / update / show / verify / analyze-ai` | Provenance / evidence conflict (PE) — duplicated `events.jsonl` semantics | `caws evidence record` + hash-chained `events.jsonl` |
| `caws archive` (standalone) | Lifecycle gap (LG) — standalone command removed | `caws specs archive <id>` |
| `caws waivers` (plural) | Authority conflict — duplicated singular surface | `caws waiver` (singular, this doc §9) |
| `caws sidecar drift / gaps / waiver-draft / provenance` | Peripheral / non-core (PNC) | Out of scope for governed core |
| `caws mode current / set / compare / recommend / details` | Peripheral / non-core (PNC) | Mode concept removed; spec `risk_tier` carries equivalent |
| `caws tutorial / plan / workflow / quality-monitor / tool / test-analysis / templates` | Peripheral / non-core (PNC) | Out of scope for governed core |
| `caws quality-gates` (alias) | Authority conflict — alias for the removed pre-v11 gates surface | `caws gates run --spec <id>` |
| `caws version` (subcommand) | Peripheral / non-core (PNC) | `caws --version` |
| `caws parallel setup / status / merge / teardown` | Deferred to v11.3+ | Loop `caws worktree create` per spec for multi-agent setup |
| `caws session start / checkpoint / end / list / show / briefing` | Deferred to v11.3+ | External session-log hook; `caws agents` for liveness visibility |
| `caws specs update / delete / conflicts / types` | Not restored in v11.1 | Edit spec YAML directly; `caws doctor` validates on next run |
| `caws worktree claim` (standalone subcommand) | Promoted to top-level | `caws claim` (top-level command, this doc §5) |
| `caws worktree prune` | Restored as cleanup planning with guarded apply | Use `caws worktree prune` to classify cleanup candidates; `--apply` mutates only repairable H-classes and refuses ambiguous classes |
| `caws worktree reconcile` | Deferred to v11.2+ | Use `caws worktree prune`, `caws worktree list`, `caws worktree repair`, and manual cleanup |

This list is exhaustive against `caws-cli@10.2.x`. Anything not listed and not in §1–§14 above does not exist in v11.

---

## Architectural invariants

These are the contracts v11 enforces. Don't try to work around them in client code; you'll fight the runtime.

1. `events.jsonl` is written ONLY through the store's `appendEvent`.
2. `policy.yaml` owns gate `mode` (block/warn/skip). Waivers filter violations out of the disposition; they do not change gate mode.
3. Doctor is pure (kernel-side). The store composes the snapshot; doctor inspects it.
4. Missing != malformed. Diagnostics distinguish absence from corruption.
5. `events.jsonl` is never required at rest. The first `appendEvent` creates it.
6. `caws init` is idempotent and non-destructive. It refuses legacy residue. There is no `--force`.
7. `caws status` is observability. Running it any number of times produces no `.caws/` byte changes.
8. Agent liveness state (`.caws/leases/`) is an operational cache — NEVER authority. Ownership authority lives in `.caws/worktrees.json`; spec authority lives in `.caws/specs/<id>.yaml`.

See [`docs/architecture/caws-vnext-command-surface.md`](../architecture/caws-vnext-command-surface.md) §6 for the fuller statement of each invariant and how v11 guarantees them.

---

## See also

- [`packages/caws-cli/README.md`](../../packages/caws-cli/README.md) — package-level v11 reference (npm-published)
- [`AGENTS.md`](../../AGENTS.md) — agent quickstart for working in v11 projects
- [`CLAUDE.md`](../../CLAUDE.md) — Claude Code project guidance
- [`docs/architecture/caws-vnext-command-surface.md`](../architecture/caws-vnext-command-surface.md) — doctrine source
- [`docs/migration-v10-to-v11.md`](../migration-v10-to-v11.md) — migration guide for teams moving from v10.2
