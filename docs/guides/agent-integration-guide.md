---
doc_id: agent-integration-guide
authority: reference
status: active
title: Agent integration guide (v11.0.0)
owner: vNext rewrite team
updated: 2026-05-15
---

# Agent integration guide (v11.0.0)

This guide explains how to integrate an AI agent runtime (Claude Code, Cursor, custom orchestrator, etc.) with CAWS v11.0.0 as a quality and audit substrate.

> **v11 posture (A1).** v11.0.0 ships eight command groups: `init`, `doctor`, `status`, `scope`, `claim`, `gates`, `evidence`, `waiver`. The legacy `caws evaluate`, `caws iterate`, `caws diagnose`, `caws agent evaluate` surfaces are removed. The integration patterns below use only the v11 surface.
>
> Doctrine source: [`docs/architecture/caws-vnext-command-surface.md`](../architecture/caws-vnext-command-surface.md). Full CLI reference: [`docs/api/cli.md`](../api/cli.md).

## What CAWS v11 gives an agent

| Capability | Surface |
|---|---|
| Drift detection on `.caws/` state | `caws doctor` (exit 0/1/2) |
| Read-only project dashboard | `caws status` |
| Scope decision (explain) | `caws scope show <path>` |
| Scope decision (enforce) | `caws scope check <path>` (exit 0/1) |
| Worktree ownership | `caws claim` (read), `caws claim --takeover` (write + audit) |
| Policy-driven quality gates | `caws gates run --spec <id>` (exit 0/1) |
| Hash-chained evidence | `caws evidence record --type <kind> --spec <id> --data '{...}'` |
| Bypass with audit | `caws waiver create / list / show / revoke` |

All commands are scriptable. Exit codes are uniform: 0 success/observation, 1 domain failure, 2 composition failure.

## Prerequisites

- v11 CLI installed: `npm install -g @paths.design/caws-cli@^11.0.0`
- Project initialized: `caws init` (idempotent; refuses legacy `.caws/working-spec.yaml` residue)
- At least one spec authored at `.caws/specs/<id>.yaml` (v11 ships no spec generator — author the YAML directly)

## Pre-implementation checks

Before an agent starts implementing a feature, the integration runtime should:

```bash
# 1. Verify the project is healthy
caws doctor                              # exit 0 = clean
if [ $? -ne 0 ]; then exit 1; fi

# 2. Verify the target spec exists and is well-formed
ls .caws/specs/<id>.yaml || exit 1

# 3. For each file the agent intends to edit, verify scope
for f in $TARGET_FILES; do
  caws scope check "$f" || exit 1
done

# 4. Surface worktree ownership (if running in a worktree)
caws claim                               # exit 0 = owned by this session
```

## The development loop

There is no `caws iterate` in v11. The agent's loop is structured by the *project's* test suite and the v11 gate evaluation, not by a CAWS-internal guidance command.

Recommended loop:

1. **Implement** — agent edits files within `scope.in`.
2. **Run project tests** — `npm test` / `pytest` / etc.
3. **Record evidence** — `caws evidence record --type test --spec <id> --data '{...}'` for each test result the runtime cares to audit.
4. **Run gates** — `caws gates run --spec <id>`. Exit 0 if all blocking gates pass.
5. **Address blockers** — either fix the underlying issue, or open a waiver (see below).
6. **Re-run** — back to (4) until green.
7. **Final check** — `caws doctor && caws status`.

## Recording evidence

Each evidence event is hash-chained and atomic. The runtime should record:

```bash
# A test result
caws evidence record --type test --spec <id> \
  --data '{"name":"unit/login","status":"pass","runtime_ms":42}'

# An acceptance-criterion closure
caws evidence record --type ac --spec <id> \
  --data '{"id":"A1","status":"satisfied","tested_by":["unit/login","integration/login"]}'

# An AI-assisted-change marker (tool, model, session id)
caws evidence record --type ac --spec <id> \
  --data '{"id":"A1","status":"satisfied","assistance":"ai","tool":"claude-code","model":"opus-4.7","session":"<session-id>"}'
```

The schema for `--data` is per-`--type` and is otherwise free-form (the project's policy decides which fields are required). The store appends through `prepareAppend` + `verifyChain`; do not write `events.jsonl` directly.

## Running gates

```bash
caws gates run --spec <id>
```

Behavior:

- `policy.yaml` declares each gate's mode (`block`, `warn`, `skip`).
- For each declared gate, one `gate_evaluated` event is appended to `.caws/events.jsonl`.
- Active waivers filter matching violations out of the disposition. Waivers do not change gate mode.

Exit codes: `0` (all blocking gates pass after waiver filtering), `1` (a blocking gate fails), `2` (composition failure — not in a repo, can't read `.caws/`, missing tooling).

The integration runtime should treat exit `2` differently from exit `1`: `2` is a setup problem; `1` is a real quality failure.

## Bypassing a gate (waivers)

When a gate violation is acceptable but cannot be fixed in the current change:

```bash
caws waiver create <id>-w \
  --gate <gate-name> \
  --reason "Why the violation is acceptable + mitigation plan" \
  --approved-by "approver@example.com" \
  --expires-at "2026-12-31T23:59:59Z"
```

Subsequent `caws gates run --spec <id>` filters matching violations. The waiver is auditable, time-bound, and revocable:

```bash
caws waiver list
caws waiver show <id>-w
caws waiver revoke <id>-w
```

Waivers are the legitimate escape. Hand-editing `change_budget` in the spec or editing `policy.yaml` directly will be rejected by CI and is a violation of the governed-paths discipline.

## Worktree ownership (multi-agent)

When multiple agents work in parallel, each agent's runtime should:

1. Place the agent in its assigned git worktree (`git worktree add ../proj-<name> -b <branch>`).
2. Have the agent run `caws claim` to surface ownership.
3. Refuse to mutate state if `caws claim` exits non-zero with a foreign-claim message.
4. Read `tmp/<sessionId>/` (the prior session's log) before deciding to take over.
5. Use `caws claim --takeover` only with explicit user authorization. Takeover writes a durable `prior_owners` audit on the worktree entry.

A stale heartbeat is not authorization. Paused sessions are not ended sessions.

## Composing v11 commands

### Pattern: pre-edit gate

Before letting the agent write to `<path>`:

```bash
caws scope check <path> || refuse_edit
```

### Pattern: post-edit evidence

After each successful edit/test cycle:

```bash
project_tests && \
  caws evidence record --type test --spec <id> --data '{...}'
```

### Pattern: pre-merge sign-off

Before declaring the feature done:

```bash
caws doctor && \
  caws gates run --spec <id> && \
  caws evidence record --type ac --spec <id> --data '{"id":"A_FINAL","status":"satisfied"}'
```

## What CAWS v11 does NOT provide

- **No agent guidance API** (`caws iterate`, `caws workflow guidance` are removed). The runtime decides the loop.
- **No quality scoring API** (`caws evaluate` is removed). Use `caws gates run` exit code + the per-gate event in `events.jsonl`.
- **No spec generator** (`caws specs create` is removed). Author YAML directly.
- **No worktree lifecycle** (`caws worktree create / merge`, `caws parallel setup` are removed). Use `git worktree`; v11.1 will reintroduce vNext lifecycle.
- **No git-hook installer** (`caws hooks install` is removed). Set up project hooks externally.
- **No provenance subsystem** (`caws provenance` is removed). The hash-chained `events.jsonl` is the audit surface.

If your runtime depends on any of those, pin `caws-cli@^10.2.x` until v11.1.

## CI integration

A v11-shaped CI step:

```yaml
- name: Setup CAWS
  run: npm install -g @paths.design/caws-cli@^11.0.0

- name: CAWS health check
  run: caws doctor

- name: Run gates
  run: caws gates run --spec ${{ matrix.spec_id }}
```

Exit codes drive CI status: `0` green, `1` red (real failure), `2` red (setup error — investigate before re-running).

## Troubleshooting

**`caws init` refuses to run.**
Legacy `.caws/working-spec.yaml` is present. Migrate to per-feature `.caws/specs/<id>.yaml` first.

**`caws scope check <path>` returned 1 unexpectedly.**
Run `caws scope show <path>` to see the decision. Likely the file is not in `scope.in`. If it should be, edit the spec; if it shouldn't, the agent is out of bounds.

**`caws gates run --spec <id>` returned 1 and the failing gate seems wrong.**
Read the diagnostic output. If the violation is genuinely acceptable, open a waiver. Do not edit `policy.yaml` or the spec's `change_budget` to bypass.

**`caws claim` refused with a foreign owner.**
Another session id owns the worktree. Read their `tmp/<sessionId>/` log. Take over only with explicit user authorization.

## See also

- [`docs/architecture/caws-vnext-command-surface.md`](../architecture/caws-vnext-command-surface.md) — doctrine source
- [`docs/api/cli.md`](../api/cli.md) — full v11 CLI reference
- [`docs/guides/multi-agent-workflow.md`](multi-agent-workflow.md) — multi-agent coordination
- [`docs/guides/worktree-isolation.md`](worktree-isolation.md) — worktree mechanics
- [`docs/agents/full-guide.md`](../agents/full-guide.md) — comprehensive agent workflow
- [`AGENTS.md`](../../AGENTS.md) — agent quickstart
