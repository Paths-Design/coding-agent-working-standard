# @paths.design/caws-cli

**CAWS CLI v11 — the governed core plus lifecycle for the Coding Agent
Working Standard.**

CAWS (Coding Agent Working Standard) gives coding agents a deterministic
substrate for project state, scope, claims, gates, waivers, and audit
evidence. v11 is a ground-up rewrite around a pure kernel, an I/O
store, and a thin shell. It replaces v10.x.

## What v11 ships

### Governed core (v11.0)

| Command | What it does |
|---|---|
| `caws init` | Bootstrap the canonical `.caws/` project state. Idempotent. Refuses to overwrite legacy single-spec layout. |
| `caws doctor` | Drift detection over `.caws/` state. Exits 0 (clean) / 1 (findings or load errors) / 2 (composition failure). |
| `caws status` | Read-only dashboard: project, current context, claim, doctor findings. Always exits 0; never mutates governance state. |
| `caws scope show <path>` | Explain the scope decision for `<path>`. Always exits 0. |
| `caws scope check <path>` | Enforce the scope decision for `<path>`. Exits 0 on admit, 1 on refuse. |
| `caws claim [--takeover]` | Surface or take ownership of the current worktree. Writes a `prior_owners` audit on takeover. |
| `caws gates run --spec <id>` | Run quality gates against current changes. Policy decides block/warn/skip. Appends one `gate_evaluated` event per policy-declared gate. |
| `caws evidence record --type <kind> --spec <id> --data <json>` | Append a typed evidence event (`test`/`gate`/`ac`) to `.caws/events.jsonl`. |
| `caws waiver create/list/show/revoke` | Manage waiver records that filter matching gate violations. Singular surface — no plural alias. |

### Lifecycle (v11)

| Command | What it does |
|---|---|
| `caws worktree create/list/bind/destroy/merge` | Worktree lifecycle on the vNext substrate. Canonical path for parallel agent work. |
| `caws specs` | vNext spec lifecycle. |

Run `caws <group> --help` for full options.

## Posture

v11 is structured as kernel + store + shell. The kernel has no `fs`,
`path`, or clock access; the store owns all I/O and the hash-chained
event log; the shell composes them into commands.

Commands that existed in v10.2.x and were **removed in v11.0** (no
replacement is planned in any current milestone): `scaffold`, `validate`,
`verify-acs`, `evaluate`, `iterate`, `diagnose`, `burnup`, `archive`,
`provenance` (superseded by `events.jsonl`), `sidecar`, `mode`,
`tutorial`, `plan`, `templates`, `workflow`, `quality-monitor`, `tool`,
`test-analysis`, legacy `hooks` install (hook packs now install through
`caws init --agent-surface <name>`).

The v11 line includes the `caws agents list/show` liveness substrate. Still
planned for v11.2: bridge-claim authority such as `caws claim --spec
<id>`, plus broader worktree reconciliation surfaces.

Explicitly deferred to v11.3+: `caws session` and `caws parallel`. The
`caws worktree create` loop pattern replaces `parallel` for multi-agent
setup today.

See `docs/architecture/caws-vnext-command-surface.md` in the repo for
the complete doctrine, command surface, and architectural invariants.

## Installation

```bash
npm install -g @paths.design/caws-cli@^11.5.0
```

The package depends on `@paths.design/caws-kernel@^1.0.0` (the pure
governance primitives). Both are published independently; the kernel
is published first and the CLI second.

Requires Node.js >= 18.

## Quickstart

In a fresh repo:

```bash
git init
caws init
```

To install an agent hook pack during init:

```bash
caws init --agent-surface claude-code
caws init --agent-surface codex
caws init --agent-surface opencode
```

Codex installs project-local `.codex/hooks.json` plus `.codex/hooks/*`.
After install, restart/reopen Codex and review or trust changed project
hooks with `/hooks`.

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

It refuses to run if legacy `.caws/working-spec.yaml` is present.
Migrate that file into per-feature `.caws/specs/<id>.yaml` first (or
do the migration on `caws-cli@10.2.x` and then upgrade).

Then:

```bash
caws doctor                  # health check (exit 0/1/2)
caws status                  # dashboard
caws scope show src/foo.ts   # what scope says about src/foo.ts
caws gates run --spec FEAT-1 # run policy-driven gates
caws waiver create FOO-1 \
  --title "Temporary waiver for X" \
  --gate budget_limit \
  --reason "..." \
  --approved-by "team-lead" \
  --expires-at "2026-12-01T00:00:00Z"
caws evidence record \
  --type test --spec FEAT-1 \
  --data '{"name":"unit","status":"pass"}'
```

## Architecture (v11)

Three layers:

1. **Kernel** (`@paths.design/caws-kernel`) — pure TypeScript. Spec
   parsing, policy validation, scope evaluation, doctor inspection,
   waiver effectiveness, hash-chained event verification. No `fs`,
   `path`, `process.env`, `Date.now()`, or `new Date()` in executable
   code; all time is injected.
2. **Store** — Node I/O. Atomic writes via `writeFileAtomic`,
   hash-chained `events.jsonl` via lock + `prepareAppend`,
   snapshot composition for the doctor, `working-spec.yaml` residue
   detection.
3. **Shell** — Commander commands and renderers. Composes store
   snapshots, calls kernel functions, prints diagnostics.

### Architectural invariants

1. `events.jsonl` is written ONLY through the store's `appendEvent`.
2. `policy.yaml` owns gate `mode` (block/warn/skip). Waivers filter
   violations out of the disposition; they do not change gate mode.
3. Doctor is pure (kernel-side). The store composes the snapshot;
   doctor inspects it.
4. Missing != malformed. Diagnostics distinguish absence from
   corruption.
5. `events.jsonl` is never required at rest. The first `appendEvent`
   creates it.
6. `caws init` is idempotent and non-destructive. It refuses legacy
   residue. There is no `--force`.
7. `caws status` is observability. Running it any number of times
   produces no `.caws/` byte changes.

## Exit codes

- `0` — success / observation.
- `1` — domain failure (gate failed, doctor finding, validation
  rejected, scope refused).
- `2` — composition failure (not a git repo, can't read `.caws/`,
  missing required tooling).

## Contributing

The CAWS repo self-hosts: `.caws/` drives real quality gates on this
codebase. See the project repository for contributing guidelines and
the agent workflow guide.

## License

MIT
