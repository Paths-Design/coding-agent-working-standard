---
doc_id: caws-cli-api-reference
authority: reference
status: active
title: CAWS CLI API Reference (v11.5.0)
owner: vNext rewrite team
updated: 2026-05-28
---

# CAWS CLI API Reference (v11.5.0)

The CAWS CLI (`@paths.design/caws-cli`) is the governance surface for the Coding Agent Working Standard. The v11 line ships thirteen command groups: `init`, `doctor`, `scope`, `status`, `claim`, `gates`, `evidence`, `events`, `waiver`, `specs`, `worktree`, `agents`, and the auto-generated `help`.

**Doctrine source:** [`docs/architecture/caws-vnext-command-surface.md`](../architecture/caws-vnext-command-surface.md). When this reference and the doctrine doc disagree, the doctrine doc wins.

Commands that existed in v10.x and do not ship in the v11 line are listed in [§ Removed in v11](#removed-in-v11). `caws parallel` and `caws session` are deferred to v11.3+ and are not replaceable by pinning to v10.2.x.

## Installation

```bash
npm install -g @paths.design/caws-cli@^11.5.0
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

Bootstrap canonical vNext `.caws/` project state. With `--agent-surface`, also installs the corresponding hook pack.

```bash
caws init
caws init --agent-surface claude-code
caws init --agent-surface codex
```

| Flag | Description |
|---|---|
| `--agent-surface <name>` | Install a hook pack for an agent harness: `claude-code`, `codex`, `cursor`, `windsurf`, or `none`. When omitted, init attempts filesystem detection and skips hook install when ambiguous. |
| `--overwrite` | For hook-pack install: replace drifted or unmanaged files at managed pack paths. CAUTION: local edits to those files will be lost. |
| `--adopt` | For hook-pack install: leave drifted or unmanaged files in place without enforcing pack contents. CAUTION: pack drift is no longer tracked for those paths. |
| `--data` | Show structured data block on diagnostics. |

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
```

| Flag | Description |
|---|---|
| `--data` | Show structured data block on findings/diagnostics. |

Inspects the snapshot composed by the store and surfaces findings (missing files, malformed YAML, residue, ownership conflicts, etc.). Pure kernel-side inspection; the store composes the snapshot, doctor evaluates it.

Exit codes: 0 (clean), 1 (findings or load errors), 2 (composition failure).

---

## 3. `caws scope`

Evaluate file paths against the bound spec scope.

### `caws scope show <path>`

Explain the scope decision for `<path>`. Always exits 0 (pure observation).

```bash
caws scope show src/foo.ts
```

### `caws scope check <path>`

Enforce the scope decision for `<path>`.

```bash
caws scope check src/foo.ts
```

Exit codes: 0 (admit), 1 (refuse).

---

## 4. `caws status`

Read-only dashboard.

```bash
caws status
caws status --data
```

| Flag | Description |
|---|---|
| `--data` | Show structured data block on rendered diagnostics. |

Surfaces project, current context, claim panel (when run inside a registered worktree), and active doctor findings. **Always observability — never mutates `.caws/`.** Running it any number of times produces zero `.caws/` byte changes (see invariant 7 in the doctrine doc).

Exit code: 0 (always).

---

## 5. `caws claim`

Surface or take ownership of the current worktree; with `--paths`, declare working-tree ownership metadata on the current session's lease.

```bash
caws claim                  # read-only inspection (default)
caws claim --takeover       # acquire ownership from a foreign session
caws claim --paths src/foo  # declare path ownership on current session lease
```

| Flag | Description |
|---|---|
| `--takeover` | Forcibly take ownership of a foreign-owned worktree. Required when the current owner is a different session. |
| `--paths <path>` | Declare a path as claimed by the current session. Repeatable; order preserved; strings stored verbatim. Refused with no write if no lease exists for the current session. (SESSION-OWNERSHIP-METADATA-001) |
| `--data` | Show structured data block on diagnostics. |

Without `--takeover`: prints the current claim (`<sessionId>:<platform>`, last heartbeat age, any `tmp/<sessionId>/` session-log pointer) and exits non-zero when the worktree is owned by a different session. Modifies nothing.

With `--takeover`: rewrites the owner to the current session id and appends the prior owner (sessionId, platform, lastSeen-at-takeover, takenOver_at) to a `prior_owners` audit array on the worktree entry in `.caws/worktrees.json`. Durable across sessions — postmortems can see what happened.

**Use `--takeover` only with explicit user authorization.** A stale heartbeat is not authorization — paused sessions are not ended sessions. Read the session log under `tmp/<sessionId>/` first.

Exit codes: 0 (claim succeeds or already owned), 1 (foreign claim without `--takeover`), 2 (composition failure / not in a worktree).

---

## 6. `caws gates run`

Run policy-driven quality gates against current changes.

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
| `--spec <id>` | Spec id this evidence is bound to. |
| `--data <json>` | Inline JSON payload describing the evidence. Schema is per-`--type`. |
| `--actor-kind <kind>` | Actor kind: `agent`, `human`, `system`, or `automation` (default: `agent`). |
| `--actor-id <id>` | Override actor id (defaults to session id). |

The event is appended through the store's `appendEvent` (hash-chained, atomic, locked). There is no other path that may write `events.jsonl`.

Exit codes: 0 (recorded), 1 (validation failure on `--data`), 2 (composition failure).

---

## 8. `caws events`

Maintenance commands for `.caws/events.jsonl`.

### `caws events migrate`

Migrate a v10-shape `events.jsonl` to a v11 chain via `chain_rotated` rotation. Dry-run by default.

```bash
caws events migrate
caws events migrate --apply
```

### `caws events rotate`

Rotate `events.jsonl`: archive existing chain, start fresh chain with `chain_rotated` genesis event. Distinct from `migrate` — admits fully-unparseable logs.

```bash
caws events rotate
caws events rotate --apply
```

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
caws waiver create FEAT-1-w \
  --title "Emergency budget breach" \
  --gate budget_limit \
  --reason "Refactor required emergency budget breach" \
  --approved-by "team-lead@example.com" \
  --expires-at "2026-12-01T00:00:00Z"
```

| Flag | Description |
|---|---|
| `--title <title>` | Short waiver title (≥5 chars). **Required.** |
| `--gate <gate>` | Gate id this waiver covers. Repeatable for multiple gates. |
| `--reason <text>` | Justification for the waiver. |
| `--approved-by <id>` | Approver identity. |
| `--expires-at <iso8601>` | Expiry as an ISO-8601 datetime with timezone. |
| `--spec <id>` | Optional spec id this waiver is scoped to. Omit for project-wide scope. |
| `--data` | Show structured data block on diagnostics. |

Exit codes: 0 (created), 1 (duplicate id, validation failure), 2 (composition failure).

### `caws waiver list`

```bash
caws waiver list
```

Lists active waivers with id, gate, expiry, and approval metadata. By default excludes revoked and expired records.

### `caws waiver show <id>`

```bash
caws waiver show FEAT-1-w
```

Shows full waiver record (yaml), including its derived effectiveness at now.

### `caws waiver revoke <id>`

```bash
caws waiver revoke FEAT-1-w
```

Marks the waiver revoked. Subsequent `caws gates run` no longer filters violations through it. Refuses double-revoke.

Exit codes: 0 (revoked), 1 (not found, already revoked), 2 (composition failure).

---

## 10. `caws specs`

Manage CAWS spec lifecycle.

### `caws specs create <id>`

```bash
caws specs create FEAT-1 \
  --title "Add widget support" \
  --mode feature \
  --risk-tier 1
```

| Flag | Description |
|---|---|
| `--title <title>` | Short spec title. |
| `--mode <mode>` | Spec mode: `feature`, `refactor`, `fix`, `doc`, or `chore`. |
| `--risk-tier <n>` | Risk tier: `1`, `2`, or `3`. |
| `--data` | Show structured data block on diagnostics. |

Creates a new spec in `lifecycle_state: active`. Note: `--type` is a removed v10 alias; use `--mode` instead.

Not returned in v11.1: `specs update`, `specs delete`, `specs conflicts`, `specs types`. Edit the YAML directly for field updates; schema validation runs on `caws doctor` and `caws gates run`.

### `caws specs list`

```bash
caws specs list
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

### `caws specs close <id>`

```bash
caws specs close FEAT-1
```

Close an active spec. Non-destructive raw-byte YAML patch; appends `spec_closed` event.

### `caws specs archive <id>`

```bash
caws specs archive FEAT-1
```

Archive a closed spec. Moves the YAML file to `.caws/specs/.archive/`; appends `spec_archived` event.

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
caws worktree migrate-registry --apply
```

Convert v10.2 legacy-envelope `.caws/worktrees.json` into the v11 flat-map shape. Idempotent on already-flat files.

### `caws worktree repair-sparse <name>`

```bash
caws worktree repair-sparse my-feature
```

Restore the `.caws/specs` sparse-checkout invariant on a linked worktree. Idempotent and non-destructive: refuses if `.caws/specs/` has dirty or untracked content rather than stashing, cleaning, resetting, or deleting it.

Note: `caws worktree prune` and `caws worktree reconcile` are deferred to v11.2.

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
caws agents prune --status stopped
caws agents prune --status stale --apply
```

| Flag | Description |
|---|---|
| `--status <s>` | Filter by status: `stopped` or `stale`. |
| `--older-than-ms <ms>` | Retention threshold in milliseconds. |
| `--stale-ttl-ms <ms>` | TTL for stale classification (default: 30m). |
| `--apply` | Actually delete (default: dry-run). |
| `--json` | Emit CAWS-native JSON to stdout. |
| `--data` | Show structured data block on diagnostics. |

Operator-invoked cleanup. Never invoked by hooks.

---

## State files

What v11 owns and writes:

| Path | Owner | Writers |
|---|---|---|
| `.caws/specs/<id>.yaml` | `caws specs create / close / archive` | store (atomic write + raw-byte YAML patch) |
| `.caws/specs/.archive/<id>.yaml` | `caws specs archive` | store (move from `.caws/specs/`) |
| `.caws/waivers/<id>.yaml` | `caws waiver create / revoke` | store (atomic write) |
| `.caws/policy.yaml` | manual edit (governed) | (none — the CLI reads but does not write this file) |
| `.caws/worktrees.json` | `caws worktree create/bind/destroy/merge`, `caws claim / claim --takeover` | store (atomic write) |
| `.caws/leases/` | `caws agents register / heartbeat / stop / prune` | store (per-session lease files) |
| `.caws/events.jsonl` | `caws gates run`, `caws evidence record`, `caws claim --takeover`, `caws specs close/archive`, `caws worktree create/merge/destroy` | store's `appendEvent` ONLY (hash-chained) |

What v11 explicitly does NOT touch:

- `.caws/working-spec.yaml` — legacy single-spec authority, refused by `caws init`.
- `.caws/provenance/*` — legacy provenance tree, no v11 writer.
- Generated git hooks under `.git/hooks/*` — `caws hooks install` is removed; use `caws init --agent-surface <name>` to install hook packs.

---

## Removed in v11

The following commands existed in v10.x and are **removed in v11**. They are no longer registered with the CLI entrypoint and `caws --help` does not list them. Invoking them will fail.

| Removed | Reason category | Replacement |
|---|---|---|
| `caws validate / verify-acs / evaluate / iterate / diagnose / burnup` | Authority conflict (AC) — used legacy spec resolution and parallel `events.jsonl` writers | `caws doctor` + `caws gates run --spec <id>` |
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
| `caws worktree prune / reconcile` | Deferred to v11.2 | `caws worktree list` + manual cleanup |

This list is exhaustive against `caws-cli@10.2.x`. Anything not listed and not in §1–§12 above does not exist in v11.

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
