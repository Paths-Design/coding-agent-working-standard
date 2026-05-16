# CAWS — Agent Quick Reference (v11.0.0)

**Agent quickstart for working in CAWS-managed projects on the v11.0.0 substrate.**

## Read this first

This repo is on the `caws-next` branch, mid-cutover to v11.0.0 (vNext kernel/store/shell rewrite, A1 posture). The doctrine source is [`docs/architecture/caws-vnext-command-surface.md`](docs/architecture/caws-vnext-command-surface.md). When this doc and the doctrine doc disagree, the doctrine doc wins.

**v11.0.0 ships exactly eight command groups.** Everything else listed in older docs (`specs`, `worktree`, `validate`, `verify-acs`, `evaluate`, `iterate`, `diagnose`, `burnup`, `provenance`, `hooks`, `scaffold`, `parallel`, `agents`, `mode`, `tutorial`, `plan`, `workflow`, `quality-monitor`, `tool`, `test-analysis`, `session`, `templates`, `sidecar`) is **removed in v11**. Do not invoke them — they will fail.

If your project genuinely needs the legacy lifecycle commands today, pin to `caws-cli@^10.2.x`. v11.1 will reintroduce vNext spec and worktree lifecycle. The two CLIs cannot run side-by-side on the same project — they write to overlapping state.

## v11 command surface

| Command | Purpose |
|---|---|
| `caws init` | Bootstrap canonical `.caws/` state. Idempotent. Refuses legacy single-spec residue. No `--force`. |
| `caws doctor` | Drift detection over `.caws/` state. Exits 0 (clean) / 1 (findings or load errors) / 2 (composition failure). |
| `caws status` | Read-only dashboard: project, current context, claim, doctor findings. Never mutates `.caws/`. |
| `caws scope show <path>` | Explain the scope decision for `<path>`. Always exits 0. |
| `caws scope check <path>` | Enforce the scope decision (exits 0 admit / 1 refuse). |
| `caws claim [--takeover]` | Surface or take ownership of the current worktree. Writes `prior_owners` audit on takeover. |
| `caws gates run --spec <id>` | Run policy-driven quality gates. Appends one `gate_evaluated` event per declared gate. |
| `caws evidence record --type <kind> --spec <id> --data <json>` | Append a typed evidence event (`test` / `gate` / `ac`). |
| `caws waiver create / list / show / revoke` | Manage waiver records. Singular surface — no plural alias. |

Run `caws <group> --help` for full options and flag details.

## Specs in v11

- Specs live at `.caws/specs/<id>.yaml`. There is no project-level `working-spec.yaml`.
- v11 does **not** ship a spec generator (`caws specs create` is removed). Author the YAML directly — see existing specs in `.caws/specs/` for the shape.
- v11 does **not** ship `caws validate`. Validation happens via `caws doctor` (drift / structure) and `caws gates run --spec <id>` (policy / quality).
- Acceptance criteria use Given/When/Then format.
- A spec's `scope.in` / `scope.out` defines what files an agent may touch. `caws scope check <path>` enforces it.

## Your contract with v11 CAWS

**You MUST:**

- Author a spec in `.caws/specs/<id>.yaml` for every unit of work.
- Stay within the spec's `scope.in` boundaries — verify with `caws scope check <path>`.
- Run `caws doctor` and `caws gates run --spec <id>` before declaring work complete.
- Use `caws waiver create` (singular) to legitimately bypass a gate, with an expiry, an approver, and a reason.
- Surface ownership with `caws claim` before mutating shared state in a worktree.
- Treat `caws status` as observability — never write to `.caws/` directly except through CLI commands.

**You MUST NOT:**

- Invoke removed commands (see list above) — they are gone.
- Edit `.caws/working-spec.yaml`, `.caws/events.jsonl`, `.caws/policy.yaml`, or other governed state by hand. Use the CLI.
- Hand-edit `change_budget` keys in spec YAML to make a gate pass — create a waiver instead.
- Take over a worktree owned by another session (`caws claim --takeover`) without explicit user authorization.
- Create shadow files (`*-enhanced.*`, `*-final.*`, `*-v2.*`, `*-copy.*`) — edit canonical files in place.

## Quick start (project setup)

```bash
git init my-project && cd my-project
caws init                                  # idempotent; refuses legacy residue
```

`caws init` creates:

```
.caws/
  specs/                  # per-feature specs (.caws/specs/<id>.yaml)
  waivers/                # waiver records (.caws/waivers/<id>.yaml)
  policy.yaml             # gate block/warn/skip policy
  worktrees.json          # worktree registry
  agents.json             # agent session registry
  # events.jsonl is created on first append; never required at rest.
```

If `.caws/working-spec.yaml` exists, `caws init` refuses. Migrate that file into per-feature `.caws/specs/<id>.yaml` first — or do the migration on `caws-cli@10.2.x` and then upgrade.

## Daily agent workflow

```bash
# 1. Author a spec for your work
$EDITOR .caws/specs/FEAT-1.yaml

# 2. Verify scope/structure
caws doctor
caws scope show src/foo.ts                 # explain the scope decision
caws scope check src/foo.ts                # enforce; exits 1 if refused

# 3. Implement, run tests, then evaluate gates
caws gates run --spec FEAT-1               # policy decides block/warn/skip

# 4. Record typed evidence (test results, AC closures)
caws evidence record --type test --spec FEAT-1 \
  --data '{"name":"unit","status":"pass"}'
caws evidence record --type ac --spec FEAT-1 \
  --data '{"id":"A1","status":"satisfied"}'

# 5. Re-check
caws doctor
caws status
```

## Worktree-based parallel agent work

When multiple agents work on the same project, each agent **must** work in its own git worktree. v11 does not ship the legacy `caws parallel setup` orchestration — create worktrees with `git worktree` directly, then use `caws claim` to surface and record ownership.

```bash
# Set up an isolated worktree (host-side, before agent starts)
git worktree add ../my-proj-agent-auth -b agent-auth
cd ../my-proj-agent-auth

# Inside the worktree, surface the claim
caws claim                                 # prints owner; exits 0 if you own it
```

### Foreign-claim soft-block

`caws claim` (and `bind` / `merge` in lifecycle-shipping versions) refuse to mutate a worktree owned by a different session id without `--takeover`. The refusal looks like:

```
Worktree 'wt-foreign' is claimed by 8be65780-...:claude-code
   Last heartbeat: 2026-04-27T17:04:00Z (23 min ago)
   Session log:    tmp/8be65780-72e0-4fc7-a989-4ebac148c18d
                   15 turns, last turn 2026-04-27T17:26:49Z
   To proceed:     caws claim --takeover
```

**Read the session log first.** A stale heartbeat does not mean the prior session is dead — it may be paused. Take over only with explicit user authorization. `--takeover` writes a durable `prior_owners` audit (sessionId, platform, lastSeen-at-takeover, takenOver_at) so postmortems can see what happened.

## Architectural invariants (v11)

These are enforced by code, not docs. Don't try to work around them.

1. `events.jsonl` is written ONLY through the store's `appendEvent`. Never hand-edit.
2. `policy.yaml` owns gate `mode` (block / warn / skip). Waivers filter violations out of the disposition; they do not change gate mode.
3. Doctor is pure (kernel-side). The store composes the snapshot; doctor inspects it.
4. Missing != malformed. Diagnostics distinguish absence from corruption.
5. `events.jsonl` is never required at rest. The first `appendEvent` creates it.
6. `caws init` is idempotent and non-destructive. It refuses legacy residue. There is no `--force`.
7. `caws status` is observability. Running it any number of times produces no `.caws/` byte changes.

## Risk tiers (your quality contract)

| Tier | Coverage | Mutation | Contracts | Use Case |
|---|---|---|---|---|
| **T1** | 90%+ | 70%+ | Required | Auth, billing, migrations |
| **T2** | 80%+ | 50%+ | Required | Features, APIs, data writes |
| **T3** | 70%+ | 30%+ | Optional | UI, internal tools |

Set the tier in your spec's `risk_tier` field. `caws gates run --spec <id>` enforces the corresponding requirements as configured by the project's `policy.yaml`.

## Waivers

Waivers legitimately bypass a gate violation. They do not change gate mode — they filter violations out of the disposition.

```bash
caws waiver create FEAT-1-w \
  --gate budget_limit \
  --reason "Refactor required emergency budget breach; cleanup tracked in FEAT-2" \
  --approved-by "team-lead@example.com" \
  --expires-at "2026-12-01T00:00:00Z"

caws waiver list
caws waiver show FEAT-1-w
caws waiver revoke FEAT-1-w
```

## Exit codes (uniform across v11)

- `0` — success / observation
- `1` — domain failure (gate failed, doctor finding, scope refused, waiver duplicate)
- `2` — composition failure (not a git repo, can't read `.caws/`, missing required tooling)

## When to ask a human

- **Tier 1 changes** — always request review.
- **Architecture decisions** — when the design affects multiple components or governed paths.
- **Waivers on T1 gates** — emergency only; document mitigation plan.
- **`caws claim --takeover`** — never without explicit authorization.

## Resources

- [`docs/architecture/caws-vnext-command-surface.md`](docs/architecture/caws-vnext-command-surface.md) — **doctrine source**: posture, kept commands, removed commands, invariants
- [`docs/agents/full-guide.md`](docs/agents/full-guide.md) — comprehensive workflow guide (post-8c.1; cross-reference doctrine doc for any conflicts)
- [`docs/guides/multi-agent-workflow.md`](docs/guides/multi-agent-workflow.md) — multi-agent patterns
- [`docs/guides/worktree-isolation.md`](docs/guides/worktree-isolation.md) — worktree discipline
- [`docs/guides/waiver-troubleshooting.md`](docs/guides/waiver-troubleshooting.md) — waiver patterns
- [`packages/caws-cli/README.md`](packages/caws-cli/README.md) — v11 CLI package reference
- [`CLAUDE.md`](CLAUDE.md) — Claude Code project guidance for this repo

## Common pitfalls

**Problem**: Tried to run `caws specs create` / `caws validate` / `caws iterate` / `caws diagnose`.
**Cause**: Reading a stale doc that pre-dates v11 cutover.
**Fix**: Use the v11 surface above. Spec lifecycle returns in v11.1.

**Problem**: `caws init` refuses to run.
**Cause**: Legacy `.caws/working-spec.yaml` residue from v10.x.
**Fix**: Migrate that file's contents into `.caws/specs/<id>.yaml`, then re-run.

**Problem**: `caws claim` refused with a foreign-owner message.
**Cause**: Another agent session owns the worktree.
**Fix**: Read their session log under `tmp/<sessionId>/`; only `--takeover` with user authorization.

**Problem**: A gate keeps blocking and you want to bypass it.
**Cause**: Hand-editing `change_budget` will be rejected by CI; the right escape is a waiver.
**Fix**: `caws waiver create` with reason, approver, and expiry.

---

**Mission**: Deliver reliable, scoped, auditable changes through the v11 governance surface. When the docs and the doctrine doc disagree, trust the doctrine doc.
