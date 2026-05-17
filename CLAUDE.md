# CLAUDE.md

Project-specific guidance for Claude Code agents working on the CAWS repository.

## This repo self-hosts (and is mid-cutover)

CAWS (Coding Agent Working Standard) is both the framework and a live user of it. The `.caws/` directory drives real quality gates on this codebase.

The repo is currently on the `caws-next` branch, completing the **v11.0.0 cutover** (vNext rewrite — pure kernel, I/O store, thin shell). Until cutover (slice 8d), `main` still runs the legacy v10.x surface and `caws-next` runs the v11 surface. **Doctrine source:** `docs/architecture/caws-vnext-command-surface.md`. Read §1 (posture A1) and §6 (invariants) before making decisions.

## v11 ships exactly eight command groups (A1 posture)

```
init  doctor  status  scope  claim  gates  evidence  waiver
```

Everything else (specs, worktree, validate, verify-acs, evaluate, iterate, diagnose, burnup, provenance, hooks, scaffold, agents, parallel, sidecar, mode, tutorial, plan, workflow, quality-monitor, tool, test-analysis, session, templates) is **removed in v11**. Spec/worktree lifecycle returns in v11.1. Projects needing it today pin to `caws-cli@^10.2.x`.

When working on `caws-next`, do not invoke removed commands as if they were current. They are gone from the v11 entry point and will fail with a `command not found` style error.

## Before you start

1. **Confirm which branch you're on.** `caws-next` (vNext, v11 surface) vs. `main` (legacy, v10 surface). Behavior differs.
2. **On `caws-next`:** run `caws status` and `caws doctor`. The `claim` panel surfaces worktree ownership; doctor surfaces drift.
3. **On `main` (legacy):** the v10 commands (specs, worktree, agents, parallel) are still active.
4. If working in parallel with another agent: create a git worktree externally (`git worktree add`); v11 does not ship the legacy `caws worktree create` orchestration. `caws claim` registers the worktree; `caws claim --takeover` acquires it from a foreign session.

## v11 spec workflow (replacement, not migration)

- Specs live at `.caws/specs/<id>.yaml`. There is no project-level working spec.
- v11 does **not** ship `caws specs create` / `caws validate`. Author the YAML directly; `caws doctor` and `caws gates run --spec <id>` are the validation surface in v11.
- Acceptance criteria use Given/When/Then format (see existing specs in `.caws/specs/` for the shape).

If you need legacy spec ergonomics today, pin `caws-cli@^10.2.x` and use `caws specs create / validate` there. Do not mix the two CLIs in one project.

## Governed paths (require special handling)

- `.caws/policy.yaml` — owns gate `mode` (block/warn/skip). Waivers filter violations; they do not change gate mode.
- `CODEOWNERS` — reviewer routing.
- `change_budget` keys in any spec YAML — use waivers, not edits.
- Pre-commit hooks — do not bypass with `--no-verify`.

Legitimate escape: `caws waiver create <id> --gate <gate> --reason "..." --approved-by "..." --expires-at <iso8601>` (singular `waiver`, not plural `waivers`).

## Worktree discipline

When git worktrees are active for parallel agent work:

- Work only in your assigned worktree.
- Use the main repo's venv (`source <main-repo>/.venv/bin/activate`), not a per-worktree one.
- Commits to the base branch during active worktrees should use the `merge(worktree):` format.
- `caws claim` shows worktree ownership; `caws claim --takeover` acquires it from a foreign session and writes a durable `prior_owners` audit.
- v11 does not ship orchestration commands for worktree create/destroy/merge — use `git worktree` directly. Lifecycle helpers return in v11.1.

See `.claude/rules/worktree-isolation.md` for the full list.

## v11 commands you'll use

- `caws init` — bootstrap canonical `.caws/` (idempotent; refuses legacy single-spec residue; no `--force`)
- `caws doctor` — drift detection over `.caws/` state. Exits 0 (clean) / 1 (findings or load errors) / 2 (composition failure)
- `caws status` — read-only dashboard. Always observability — never mutates `.caws/`
- `caws scope show <path>` — explain the scope decision for `<path>`
- `caws scope check <path>` — enforce the scope decision (exits 0 admit / 1 refuse)
- `caws claim [--takeover]` — surface or take ownership of the current worktree
- `caws gates run --spec <id>` — run policy-driven quality gates; appends one `gate_evaluated` event per declared gate
- `caws evidence record --type <test|gate|ac> --spec <id> --data <json>` — append a typed evidence event
- `caws waiver create | list | show | revoke` — manage waiver records (singular, no plural alias)

Run `caws <group> --help` for full options.

## Test suite

- CLI tests (vNext shell + store): `cd packages/caws-cli && npx jest`
- Kernel tests: `cd packages/caws-kernel && npm test`
- Per `/Users/darianrosebrook/.claude/CLAUDE.md` session protocol: interpret pass counts critically, cite specific assertion evidence, call out false-confidence risks.

## References

- `docs/architecture/caws-vnext-command-surface.md` — **doctrine source**: A1 posture, kept commands, removed commands, invariants
- `AGENTS.md` — full agent quickstart (in-repo)
- `docs/agents/full-guide.md` — comprehensive agent workflow (note: post-8c.1 cleanup may still contain v10 historical context — cross-reference the doctrine doc)
- `.claude/rules/` — git safety + worktree isolation rules (already loaded by Claude Code)
- `docs/internal/claude-code-cross-analysis.md` — how CAWS compares to Claude Code's runtime harness
