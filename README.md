# CAWS — Coding Agent Working Standard

**A deterministic substrate for project state, scope, claims, gates, waivers, and audit evidence.**

CAWS is a kernel/store/shell architecture that gives coding agents and humans a shared, observable, auditable view of a project's quality state. The CLI is the governance surface; the kernel is pure governance primitives; the store owns all I/O; `.caws/` is the state directory.

This repository is the source for the `@paths.design/caws-cli` and `@paths.design/caws-kernel` npm packages. CAWS self-hosts: `.caws/` drives real quality gates on this codebase.

## Status: v11.1.x is the canonical line

The v11 cutover is complete. `main` runs the v11.1 surface published to npm as `@paths.design/caws-cli`. v11.1 restored the spec and worktree lifecycle on top of the v11.0 governed core and shipped the agent-liveness visibility substrate (`caws agents`, `.caws/leases/`). v11.2 is in planning (multi-agent *authority* — bridge claims, lease-backed enforcement — see the doctrine doc §1).

**Doctrine source:** [`docs/architecture/caws-vnext-command-surface.md`](docs/architecture/caws-vnext-command-surface.md). Read it before relying on any other doc in this repo — historical context in deeper docs may still describe v10 behavior.

**Migrating from v10.2?** Read [`docs/migration-v10-to-v11.md`](docs/migration-v10-to-v11.md) first. v11.1 is not a drop-in replacement for every v10.2 workflow — some commands are removed, some renamed, some deferred. The guide classifies every v10.2 command and includes a rollback one-liner.

## What v11.1 ships

Thirteen command groups (plus the auto-generated `help`).

| Command | Purpose |
|---|---|
| `caws init` | Bootstrap canonical `.caws/` state. Idempotent. Refuses legacy single-spec residue. No `--force`. `--agent-surface <claude-code\|cursor\|windsurf\|none>` installs a hook pack. |
| `caws doctor` | Drift detection over `.caws/` state. Exits 0 (clean) / 1 (findings or load errors) / 2 (composition failure). |
| `caws status` | Read-only dashboard: project, current context, agents, claim, doctor findings. Never mutates `.caws/`. |
| `caws scope show <path>` | Explain the scope decision for `<path>`. Always exits 0. |
| `caws scope check <path>` | Enforce the scope decision for `<path>`. Exits 0 admit / 1 refuse. |
| `caws claim [--takeover] [--paths <path>]` | Surface or take ownership of the current worktree. Writes `prior_owners` audit on takeover; `--paths` declares working-tree ownership metadata on the current lease. |
| `caws gates run --spec <id> [--context <cli\|commit\|ci>]` | Run policy-driven quality gates. Appends one `gate_evaluated` event per declared gate. |
| `caws evidence record --type <kind> --spec <id> --data <json>` | Append a typed evidence event (`test` / `gate` / `ac`) to `.caws/events.jsonl`. |
| `caws events migrate / rotate / verify-archive` | Maintenance for the hash-chained `.caws/events.jsonl` (v10→v11 migration, rotation, archive integrity). |
| `caws waiver create / list / show / revoke` | Manage waiver records that filter matching gate violations. Singular surface — no plural alias. |
| `caws specs create / list / show / recover / close / archive / retire-draft / prune-archive / migrate` | Manage CAWS spec lifecycle. Specs live at `.caws/specs/<id>.yaml`. Lifecycle exits by state: active → `close`, closed → `archive`, never-activated draft → `retire-draft` (governed tombstone, not raw `git rm`). |
| `caws worktree create / list / bind / destroy / merge / repair-sparse / migrate-registry` | Manage CAWS worktrees bound to active specs. |
| `caws agents register / heartbeat / stop / list / show / prune` | Agent-liveness substrate (`.caws/leases/`). Operational cache only — never authority. |
| `caws prepush [--base <ref>] [--ack <sha>]` | Governed pre-push range check (MULTI-AGENT-PUSH-RANGE-GUARD-001). Classifies the outgoing commit range and refuses commits not attributable to the current slice. Diagnose/decide only — does NOT run `git push`. |

Run `caws <group> --help` for full options.

## Quick start

### Prerequisites

- Node.js >= 18
- Git

### Install

```bash
npm install -g @paths.design/caws-cli@^11.1.0
caws --version
```

### Bootstrap a project

```bash
git init my-project && cd my-project
caws init
```

`caws init` creates the canonical vNext layout:

```
.caws/
  specs/                  # per-feature specs (.caws/specs/<id>.yaml)
  waivers/                # waiver records (.caws/waivers/<id>.yaml)
  policy.yaml             # gate block/warn/skip policy
  worktrees.json          # worktree registry
  agents.json             # agent session registry
  # events.jsonl is created on first append; never required at rest.
```

It refuses to run if legacy `.caws/working-spec.yaml` is present. Migrate that file into per-feature `.caws/specs/<id>.yaml` first (or do the migration on `caws-cli@10.2.x` before upgrading).

### Author a spec

```bash
caws specs create FEAT-1 --title "Short title" --mode feature --risk-tier 3
```

This creates `.caws/specs/FEAT-1.yaml` in `lifecycle_state: active`. Edit it to fill in `scope.in`/`scope.out`, `invariants`, `acceptance` (Given/When/Then), `non_functional`, and `contracts` — see existing specs in this repo's `.caws/specs/` for the shape, and [`docs/api/schema.md`](docs/api/schema.md) for the field reference.

### Daily commands

```bash
caws doctor                              # health check
caws status                              # dashboard
caws scope show src/foo.ts               # what scope says about a file
caws gates run --spec FEAT-1             # run policy-driven gates
caws waiver create FOO-1 \
  --gate budget_limit \
  --reason "..." \
  --approved-by "team-lead" \
  --expires-at "2026-12-01T00:00:00Z"
caws evidence record \
  --type test --spec FEAT-1 \
  --data '{"name":"unit","status":"pass"}'
```

## Multi-agent work

CAWS is built for concurrent agents. Its answer to "who can write what?" is to
**partition authority, not to add channels between agents.** Each agent gets its
own spec and its own bound worktree; the scope guard enforces edit boundaries
from `scope.in`/`scope.out`; ownership lives in `.caws/worktrees.json`.

```bash
# One spec + one worktree per agent (loop this per agent; there is no
# `caws parallel setup` — that surface is deferred to v11.3+)
caws specs create FEAT-AUTH --title "Auth" --mode feature --risk-tier 2
caws worktree create wt-auth --spec FEAT-AUTH   # writes the binding atomically
cd .caws/worktrees/wt-auth

# See who else is live before mutating shared state
caws status            # Agents panel + claim ownership
caws agents list       # active / stale / stopped sessions

# Finish: merge (auto-closes the bound spec) and destroy
caws worktree merge wt-auth
caws worktree destroy wt-auth
```

`caws agents` leases (`.caws/leases/`) are **visibility only** — a stale lease is
evidence, never authority. The only authority transition is an explicit
`caws claim --takeover`, which writes a durable `prior_owners` audit. This is the
lesson the failure lineage keeps teaching: collision is solved by non-overlapping
authority, not by inter-agent messaging. See [`docs/guides/multi-agent-workflow.md`](docs/guides/multi-agent-workflow.md).

## Architecture (v11)

Three layers:

1. **Kernel** (`@paths.design/caws-kernel`) — pure TypeScript. Spec parsing, policy validation, scope evaluation, doctor inspection, waiver effectiveness, hash-chained event verification. No `fs`, `path`, `process.env`, `Date.now()`, or `new Date()` in executable code; all time is injected.
2. **Store** — Node I/O. Atomic writes via `writeFileAtomic`, hash-chained `events.jsonl` via lock + `prepareAppend`, snapshot composition for the doctor, legacy `working-spec.yaml` residue detection.
3. **Shell** — Commander commands and renderers. Composes store snapshots, calls kernel functions, prints diagnostics.

### Architectural invariants

1. `events.jsonl` is written ONLY through the store's `appendEvent`.
2. `policy.yaml` owns gate `mode` (block/warn/skip). Waivers filter violations out of the disposition; they do not change gate mode.
3. Doctor is pure (kernel-side). The store composes the snapshot; doctor inspects it.
4. Missing != malformed. Diagnostics distinguish absence from corruption.
5. `events.jsonl` is never required at rest. The first `appendEvent` creates it.
6. `caws init` is idempotent and non-destructive. It refuses legacy residue. There is no `--force`.
7. `caws status` is observability. Running it any number of times produces no `.caws/` byte changes.

### Exit codes

- `0` — success / observation
- `1` — domain failure (gate failed, doctor finding, scope refused)
- `2` — composition failure (not a git repo, can't read `.caws/`, missing required tooling)

## Repository layout

```
caws/
├── packages/
│   ├── caws-cli/                 # CLI (governance surface)
│   │   ├── src/
│   │   │   ├── shell/            # vNext command implementations (TS)
│   │   │   ├── store/            # vNext I/O layer (TS)
│   │   │   └── ...               # legacy v10 sources (orphaned post-8a3, deleted in 8e)
│   │   └── README.md             # v11-honest package README
│   └── caws-kernel/              # Pure governance primitives (TS, no I/O)
├── docs/
│   ├── architecture/
│   │   └── caws-vnext-command-surface.md   # ← doctrine source
│   ├── agents/                   # agent guides
│   └── guides/                   # integration / workflow guides
├── .caws/                        # this repo's own CAWS state (self-hosting)
├── AGENTS.md                     # agent quickstart
└── CLAUDE.md                     # Claude Code project instructions
```

## Documentation

Authoritative for v11:

- **[`docs/architecture/caws-vnext-command-surface.md`](docs/architecture/caws-vnext-command-surface.md)** — doctrine source. Posture, kept commands, removed commands, invariants.
- **[`packages/caws-cli/README.md`](packages/caws-cli/README.md)** — v11 CLI reference.
- **[`AGENTS.md`](AGENTS.md)** — agent quickstart for working on this repo.
- **[`CLAUDE.md`](CLAUDE.md)** — Claude Code project guidance.

Cleanup status (Slice 8c.1):

- Files swept and rewritten v11-honest: this README, `AGENTS.md`, `CLAUDE.md`, `packages/caws-cli/README.md`, the doctrine doc.
- Files swept for active v10 instructions removed: `docs/agents/`, `docs/guides/`, `docs/api/cli.md`, `docs/agent-workflow-tools.md`.
- Files explicitly historical (allowed to retain v10 references): `docs/MIGRATION_GUIDE_V3.5.md`, `docs/ROLLBACK.md`, `docs/DEPLOYMENT.md`, `docs/failure-lineage.md`, anything under `docs/internal/`.

If you find a doc that still teaches removed commands as current workflow, file an issue or PR — it's a 8c.1 escapee.

## Development

```bash
npm install
npm run build
cd packages/caws-cli && npx jest      # CLI shell + store tests
cd packages/caws-kernel && npm test   # kernel tests
```

This project uses CAWS for its own development — see [`AGENTS.md`](AGENTS.md) and the doctrine doc for contributor workflow.

## License

MIT — see [LICENSE](LICENSE).

## Support

- **Issues:** https://github.com/Paths-Design/coding-agent-working-standard/issues
- **Discussions:** https://github.com/Paths-Design/coding-agent-working-standard/discussions
- **Email:** hello@paths.design
