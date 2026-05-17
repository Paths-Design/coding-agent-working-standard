---
doc_id: caws-cli-api-reference
authority: reference
status: active
title: CAWS CLI API Reference (v11.0.0)
owner: vNext rewrite team
updated: 2026-05-15
---

# CAWS CLI API Reference (v11.0.0)

The CAWS CLI (`@paths.design/caws-cli`) is the governance surface for the Coding Agent Workflow System. v11.0.0 ships exactly eight command groups; everything else has been removed (see [§ Removed in v11](#removed-in-v11)).

**Doctrine source:** [`docs/architecture/caws-vnext-command-surface.md`](../architecture/caws-vnext-command-surface.md). When this reference and the doctrine doc disagree, the doctrine doc wins.

If you need legacy command behavior (`specs`, `worktree`, `validate`, `verify-acs`, `evaluate`, `iterate`, `diagnose`, `burnup`, `provenance`, `hooks`, `scaffold`, `parallel`, `agents`, `mode`, `tutorial`, `plan`, `workflow`, `quality-monitor`, `tool`, `test-analysis`, `session`, `templates`, `sidecar`), pin to `caws-cli@^10.2.x` until v11.1 reintroduces vNext spec and worktree lifecycle.

## Installation

```bash
npm install -g @paths.design/caws-cli@^11.0.0
caws --version
```

The package depends on `@paths.design/caws-kernel@^1.0.0` (pure governance primitives). Both are published independently.

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

Bootstrap canonical vNext `.caws/` project state.

```bash
caws init
```

Behavior:

- Idempotent. Re-running on an already-initialized project is a no-op.
- Refuses to run if legacy `.caws/working-spec.yaml` is present (migrate first; there is no `--force`).
- Creates the canonical layout:

  ```
  .caws/
    specs/                  # per-feature specs (.caws/specs/<id>.yaml)
    waivers/                # waiver records (.caws/waivers/<id>.yaml)
    policy.yaml             # gate block/warn/skip policy
    worktrees.json          # worktree registry
    agents.json             # agent session registry
    # events.jsonl is created on first append; never required at rest.
  ```

Exit codes: 0 (created or no-op), 1 (legacy residue refused), 2 (not a git repo / I/O failure).

---

## 2. `caws doctor`

Drift detection over `.caws/` state.

```bash
caws doctor
```

Inspects the snapshot composed by the store and surfaces findings (missing files, malformed YAML, residue, ownership conflicts, etc.). Pure kernel-side inspection; the store composes the snapshot, doctor evaluates it.

Exit codes: 0 (clean), 1 (findings or load errors), 2 (composition failure).

---

## 3. `caws status`

Read-only dashboard.

```bash
caws status
```

Surfaces project, current context, claim panel (when run inside a registered worktree), and active doctor findings. **Always observability — never mutates `.caws/`.** Running it any number of times produces zero `.caws/` byte changes (see invariant 7 in the doctrine doc).

Exit code: 0 (always).

---

## 4. `caws scope`

Evaluate file paths against the bound spec scope.

### `caws scope show <path>`

Explain the scope decision for `<path>`.

```bash
caws scope show src/foo.ts
```

Exit code: 0 (always — pure observation).

### `caws scope check <path>`

Enforce the scope decision for `<path>`.

```bash
caws scope check src/foo.ts
```

Exit codes: 0 (admit), 1 (refuse).

---

## 5. `caws claim`

Surface or take ownership of the current worktree.

```bash
caws claim                  # read-only inspection (default)
caws claim --takeover       # acquire ownership from a foreign session
```

Without `--takeover`: prints the current claim (`<sessionId>:<platform>`, last heartbeat age, any `tmp/<sessionId>/` session-log pointer) and exits non-zero when the worktree is owned by a different session. Modifies nothing.

With `--takeover`: rewrites the owner to the current session id and appends the prior owner (sessionId, platform, lastSeen-at-takeover, takenOver_at) to a `prior_owners` audit array on the worktree entry in `.caws/worktrees.json`. Durable across sessions — postmortems can see what happened.

**Use `--takeover` only with explicit user authorization.** A stale heartbeat is not authorization — paused sessions are not ended sessions. Read the session log under `tmp/<sessionId>/` first.

Exit codes: 0 (claim succeeds or already owned), 1 (foreign claim without `--takeover`), 2 (composition failure / not in a worktree).

---

## 6. `caws gates run`

Run policy-driven quality gates against current changes.

```bash
caws gates run --spec <id>
```

| Flag | Description |
|---|---|
| `--spec <id>` | Spec ID to evaluate against (required). |

Behavior:

- `policy.yaml` declares each gate's mode (`block`, `warn`, `skip`).
- For each declared gate, appends one `gate_evaluated` event to `.caws/events.jsonl` (hash-chained via the store's `appendEvent`).
- Waivers filter matching violations out of the disposition; they do not change gate mode.

Exit codes: 0 (all blocking gates pass), 1 (a blocking gate fails after waiver filtering), 2 (composition failure).

---

## 7. `caws evidence record`

Append a typed evidence event to `.caws/events.jsonl`.

```bash
caws evidence record \
  --type test --spec FEAT-1 \
  --data '{"name":"unit","status":"pass"}'
```

| Flag | Description |
|---|---|
| `--type <kind>` | Evidence kind: `test`, `gate`, or `ac`. |
| `--spec <id>` | Spec ID this evidence is bound to. |
| `--data <json>` | Inline JSON payload describing the evidence. Schema is per-`--type`. |

The event is appended through the store's `appendEvent` (hash-chained, atomic, locked). There is no other path that may write `events.jsonl`.

Exit codes: 0 (recorded), 1 (validation failure on `--data`), 2 (composition failure).

---

## 8. `caws waiver`

Manage waiver records that filter matching gate violations.

**Singular surface only — `caws waivers` (plural) is removed.**

### `caws waiver create <id>`

```bash
caws waiver create FEAT-1-w \
  --gate budget_limit \
  --reason "Refactor required emergency budget breach" \
  --approved-by "team-lead@example.com" \
  --expires-at "2026-12-01T00:00:00Z"
```

| Flag | Description |
|---|---|
| `--gate <gate>` | Gate name this waiver filters. |
| `--reason <text>` | Free-text rationale. |
| `--approved-by <text>` | Approver identity. |
| `--expires-at <iso8601>` | Hard expiry timestamp. |

Exit codes: 0 (created), 1 (duplicate id, validation failure), 2 (composition failure).

### `caws waiver list`

```bash
caws waiver list
```

Lists active waivers with id, gate, expiry, and approval metadata.

### `caws waiver show <id>`

```bash
caws waiver show FEAT-1-w
```

Shows full waiver record (yaml).

### `caws waiver revoke <id>`

```bash
caws waiver revoke FEAT-1-w
```

Marks the waiver revoked. Subsequent `caws gates run` no longer filters violations through it.

Exit codes: 0 (revoked), 1 (not found, already revoked), 2 (composition failure).

---

## State files

What v11 owns and writes:

| Path | Owner | Writers |
|---|---|---|
| `.caws/specs/<id>.yaml` | spec authoring (manual / external) | (none — author the YAML directly in v11.0.0) |
| `.caws/waivers/<id>.yaml` | `caws waiver create / revoke` | store (atomic write) |
| `.caws/policy.yaml` | manual edit (governed) | (none) |
| `.caws/worktrees.json` | `caws claim`, `caws claim --takeover` | store (atomic write) |
| `.caws/agents.json` | session-log hooks | external (not the CLI) |
| `.caws/events.jsonl` | `caws gates run`, `caws evidence record`, `caws claim --takeover` | store's `appendEvent` ONLY (hash-chained) |

What v11 explicitly does NOT touch:

- `.caws/working-spec.yaml` — legacy single-spec authority, refused by `caws init`.
- `.caws/provenance/*` — legacy provenance tree, no v11 writer.
- Generated git hooks under `.git/hooks/*` — `caws hooks install` is removed.

---

## Removed in v11

The following commands existed in v10.x and are **removed in v11.0.0**. They are no longer registered with the CLI entrypoint and `caws --help` does not list them. Invoking them will fail.

| Removed | Reason category | Replacement |
|---|---|---|
| `caws specs create / list / show / update / delete / close / archive / conflicts / migrate / types` | Lifecycle gap (LG) | Author YAML directly in `.caws/specs/<id>.yaml`; lifecycle returns in v11.1, or pin `caws-cli@^10.2.x` |
| `caws worktree create / list / destroy / merge / bind / claim / prune / repair` | Lifecycle gap (LG) | `caws claim` for ownership; use `git worktree` directly for create/destroy; lifecycle returns in v11.1 |
| `caws parallel setup / status / merge / teardown` | Lifecycle gap (LG) | Manual `git worktree` orchestration; v11.1 will reintroduce |
| `caws agents list / show` | Peripheral / non-core (PNC) | Read `.caws/agents.json` and `tmp/<sessionId>/` directly |
| `caws session start / checkpoint / end / list / show / briefing` | Peripheral / non-core (PNC) | External session-log hook |
| `caws validate / verify-acs / evaluate / iterate / diagnose / burnup` | Authority conflict (AC) — used legacy spec resolution and parallel events.jsonl writers | `caws doctor` + `caws gates run --spec <id>` |
| `caws scaffold` | Scaffold / hook risk (SH) | Out of scope for governed core |
| `caws hooks install / remove / status` | Authority conflict (AC) — generated hooks called removed commands | External git hook setup; `caws gates run` is the gate surface |
| `caws provenance init / update / show / verify / analyze-ai` | Provenance / evidence conflict (PE) — duplicated `events.jsonl` semantics | `caws evidence record` + hash-chained `events.jsonl` |
| `caws archive` | Lifecycle gap (LG) | `caws specs archive` (v11.1) — interim: edit YAML status manually |
| `caws waivers` (plural) | Authority conflict — duplicated singular surface | `caws waiver` (singular, this doc §8) |
| `caws sidecar drift / gaps / waiver-draft / provenance` | Peripheral / non-core (PNC) | Out of scope for governed core |
| `caws mode current / set / compare / recommend / details` | Peripheral / non-core (PNC) | Mode concept removed; spec `risk_tier` carries equivalent |
| `caws tutorial / plan / workflow / quality-monitor / tool / test-analysis / templates` | Peripheral / non-core (PNC) | Out of scope for governed core |
| `caws quality-gates` (alias) | Authority conflict — alias for the removed pre-v11 gates surface | `caws gates run --spec <id>` |
| `caws version` (subcommand) | Peripheral / non-core (PNC) | `caws --version` |

This list is exhaustive against `caws-cli@10.2.x`. Anything not listed and not in §1–§8 above does not exist in v11.

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

See [`docs/architecture/caws-vnext-command-surface.md`](../architecture/caws-vnext-command-surface.md) §6 for the fuller statement of each invariant and how v11 guarantees them.

---

## See also

- [`packages/caws-cli/README.md`](../../packages/caws-cli/README.md) — package-level v11 reference (npm-published)
- [`AGENTS.md`](../../AGENTS.md) — agent quickstart for working in v11 projects
- [`CLAUDE.md`](../../CLAUDE.md) — Claude Code project guidance
- [`docs/architecture/caws-vnext-command-surface.md`](../architecture/caws-vnext-command-surface.md) — doctrine source
