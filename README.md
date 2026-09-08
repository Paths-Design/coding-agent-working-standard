# CAWS — Coding Agent Working Standard

**A deterministic substrate for project state, scope, claims, gates, waivers, and audit evidence.**

CAWS is a kernel/store/shell architecture that gives coding agents and humans a shared, observable, auditable view of a project's quality state. The CLI is the governance surface; the kernel is pure governance primitives; the store owns all I/O; `.caws/` is the state directory.

This repository is the source for the `@paths.design/caws-cli` npm package (the kernel is absorbed into it — there is no separate `@paths.design/caws-kernel` publish). CAWS self-hosts: `.caws/` drives real quality gates on this codebase.

## Current architecture

CAWS combines repository-owned governance with a shared machine runtime. The
installed package version is reported by `caws --version`; the v11 governance
architecture remains the foundation of the current CLI. Specs and worktree/bridge
bindings own project authority. Runtime installation and agent leases do not grant it.

**Doctrine source:** [`docs/architecture/caws-vnext-command-surface.md`](docs/architecture/caws-vnext-command-surface.md). Read it before relying on any other doc in this repo — historical context in deeper docs may still describe v10 behavior.

**Migrating from v10.2?** Read [`docs/migration-v10-to-v11.md`](docs/migration-v10-to-v11.md) first. v11 is not a drop-in replacement for every v10.2 workflow — some commands are removed, some renamed, some deferred. The guide classifies every v10.2 command and includes a rollback one-liner.

## Command surface

Use `caws --help` for the current command tree. Common project operations:

| Command | Purpose |
|---|---|
| `caws init` | Initialize project governance. `init adapters` manages the shared runtime and native registration; `init migrate` converts reviewed legacy governance. Dedicated subcommand help describes each operation. |
| `caws doctor` | Drift detection over `.caws/` state. Exits 0 (clean) / 1 (findings or load errors) / 2 (composition failure). |
| `caws status` | Read-only dashboard: project, current context, agents, claim, doctor findings. Never mutates `.caws/`. |
| `caws scope show / check / contention` | Explain scope, enforce scope, or report cross-worktree path contention. |
| `caws claim [--takeover] [--paths <path>] [--spec <id>] [--release]` | Surface or take ownership of the current worktree. Writes `prior_owners` audit on takeover; `--paths` declares working-tree ownership metadata on the current lease; `--spec`/`--release` acquire/release a BRIDGE binding (session↔spec authority for non-worktree contexts). |
| `caws gates run --spec <id> [--context <cli\|commit\|ci>]` | Run policy-driven quality gates. Appends one `gate_evaluated` event per declared gate. |
| `caws evidence record --type <kind> --spec <id> --data <json>` | Append a typed evidence event (`test` / `gate` / `human_decision`; AC closure uses `specs evidence`) to `.caws/events.jsonl`. |
| `caws events migrate / rotate / verify-archive` | Maintenance for the hash-chained `.caws/events.jsonl` (v10→v11 migration, rotation, archive integrity). |
| `caws waiver create / list / show / revoke` | Manage waiver records that filter matching gate violations. Singular surface — no plural alias. `create` requires `--title`, `--gate`, `--reason`, `--approved-by`, `--expires-at`. |
| `caws reprieve grant / show / revoke / list` | Session-scoped guard reprieve: skip a PreToolUse guard for one session until expiry. |
| `caws specs create / list / show / recover / restore / retire-draft / prune-drafts / activate / deactivate / amend / amend-scope / evidence / close / reopen / archive / prune-archive / migrate / validate` | Manage CAWS spec lifecycle. Specs live at `.caws/specs/<id>.yaml`. `create` writes `lifecycle_state: draft` by default (`--activate` creates active directly); the normal path is `caws worktree create --spec <id>`, which activates on bind. Batch archive supports `--status closed`, `--include`, `--exclude`, and `--apply`. |
| `caws worktree create / list / ensure / bind / destroy / untrack / merge / review / migrate-registry / repair-sparse / repair / prune / cleanup-plan` | Manage CAWS worktrees bound to active specs (`ensure` is the idempotent create-or-admit form; `review` is a read-only pre-merge gate; `repair` prunes ghost registry entries + clears dead spec→worktree bindings; `repair-sparse` restores the `.caws/specs` sparse-checkout invariant; `untrack` releases the registry binding while keeping the directory; `prune`/`cleanup-plan` are dry-run-by-default cleanup planners). |
| `caws agents register / heartbeat / stop / list / show / prune` | Agent-liveness substrate (`.caws/leases/`). Operational cache only — never authority. |
| `caws message send / reply / poll / inbox / history / status / prune` | Directed inter-agent message channel over `.caws/messages.jsonl`. Not authority; verify claims before acting. |
| `caws session prune` | Dry-run-default retention for `.caws/sessions/` turn logs. The full lifecycle (`start`/`checkpoint`/`end`) remains deferred. |
| `caws working-tree check / ack` | Working-tree provenance advisory: `check` reports uncommitted overlap with another session's lease; `ack` acknowledges it. |
| `caws handoff export / import` | Portable handoff briefs for session-to-session continuity. |

Run `caws <group> --help` for live options, or see [`docs/command-reference.md`](docs/command-reference.md) for the exhaustive leaf and flag surface.

## Quick start

### Prerequisites

- Node.js >= 18
- Git

### Install

```bash
npm install -g @paths.design/caws-cli
caws --version
```

### Set up the machine once

```bash
caws init adapters install --plan
caws init adapters install
caws init adapters configure --agent-surface codex --plan
caws init adapters configure --agent-surface codex
```

Review native hook trust and verify execution in the target harness. For an
existing project, preview and apply `caws init adapters migrate --agent-surface
codex` once to retire its local registration. See the [setup and migration
guide](docs/guides/hook-packs.md#machine-adapter-installation) for custom hooks,
other harnesses, symlinked configuration and exact backups.

### Bootstrap a project

```bash
git init my-project && cd my-project
caws init --agent-surface codex
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

Project `.caws/` owns specs, policy and audit state. Shared executables, adapters
and session-global reprieves live under `~/.caws` (`CAWS_HOME` can select another
absolute machine home). Legacy singleton governance needs an explicit reviewed
`caws init migrate --from <plan>` preview and `migrate apply --from <plan>`;
see the [legacy migration guide](docs/migration-v10-to-v11.md).

After upgrading the CLI package, preview and run `caws init adapters install`
once to update stock hooks across adopted projects. `configure` changes native
registration, `migrate` retires project registration, and `rollback` restores the
previous shared runtime. These are separate operations, each with its own help.

### Author a spec

```bash
caws specs create FEAT-1 --title "Short title" --mode feature --risk-tier 3
```

This creates `.caws/specs/FEAT-1.yaml` in `lifecycle_state: draft`. Edit it to fill in `scope.in`/`scope.out`, `invariants`, `acceptance` (Given/When/Then), `non_functional`, and `contracts` — see existing specs in this repo's `.caws/specs/` for the shape, and [`docs/api/schema.md`](docs/api/schema.md) for the field reference.

`caws worktree create <name> --spec FEAT-1` activates the draft as it binds it, so `active` means the slice is being worked rather than merely written down. Pass `--activate` to `specs create` if you are working a slice without a worktree.

### Daily commands

```bash
caws doctor                              # health check
caws status                              # dashboard
caws scope show src/foo.ts               # what scope says about a file
caws gates run --spec FEAT-1             # run policy-driven gates
caws waiver create FOO-1 \
  --title "Reviewed budget exception" \
  --gate budget_limit \
  --reason "..." \
  --approved-by "team-lead" \
  --expires-at "2026-12-01T00:00:00Z"
caws evidence record \
  --type test --spec FEAT-1 \
  --data '{"command":"npm test","exit_code":0}'
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

1. **Kernel** (`packages/caws-cli/src/kernel/` — absorbed into the CLI package; no separate `@paths.design/caws-kernel` publish) — pure TypeScript. Spec parsing, policy validation, scope evaluation, doctor inspection, waiver effectiveness, hash-chained event verification. No `fs`, `path`, `process.env`, `Date.now()`, or `new Date()` in executable code; all time is injected.
2. **Store** — Node I/O. Atomic writes via `writeFileAtomic`, hash-chained `events.jsonl` via lock + `prepareAppend`, snapshot composition for the doctor, legacy `working-spec.yaml` residue detection.
3. **Shell** — Commander commands and renderers. Composes store snapshots, calls kernel functions, prints diagnostics.

### Architectural invariants

1. `events.jsonl` is written ONLY through the store's `appendEvent`.
2. `policy.yaml` owns gate `mode` (block/warn/skip). Waivers filter violations out of the disposition; they do not change gate mode.
3. Doctor is pure (kernel-side). The store composes the snapshot; doctor inspects it.
4. Missing != malformed. Diagnostics distinguish absence from corruption.
5. `events.jsonl` is never required at rest. The first `appendEvent` creates it.
6. `caws init` is idempotent and non-destructive. Plain initialization refuses legacy residue; explicit reviewed migration converts it. `--force` applies only to legacy pack `--overwrite`.
7. `caws status` is observability. Running it any number of times produces no `.caws/` byte changes.

### Exit codes

- `0` — success / observation
- `1` — domain failure (gate failed, doctor finding, scope refused)
- `2` — composition failure (not a git repo, can't read `.caws/`, missing required tooling)

## Repository layout

```
caws/
├── packages/
│   └── caws-cli/                 # CLI (governance surface) — the only
│       │                         # published package; the kernel is
│       │                         # absorbed into it (no separate
│       │                         # @paths.design/caws-kernel publish)
│       ├── src/
│       │   ├── shell/            # vNext command implementations (TS)
│       │   ├── store/            # vNext I/O layer (TS)
│       │   ├── kernel/           # Pure governance primitives (TS, no I/O)
│       │   └── ...               # legacy v10 sources (orphaned post-8a3, deleted in 8e)
│       └── README.md             # v11-honest package README
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
cd packages/caws-cli && npx jest      # CLI shell + store tests (includes the absorbed kernel under src/kernel)
```

This project uses CAWS for its own development — see [`AGENTS.md`](AGENTS.md) and the doctrine doc for contributor workflow.

## License

MIT — see [LICENSE](LICENSE).

## Support

- **Issues:** https://github.com/Paths-Design/coding-agent-working-standard/issues
- **Discussions:** https://github.com/Paths-Design/coding-agent-working-standard/discussions
- **Email:** hello@paths.design
