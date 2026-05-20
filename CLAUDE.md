# CLAUDE.md

Project-specific guidance for Claude Code agents working on the CAWS repository.

## This repo self-hosts

CAWS (Coding Agent Working Standard) is both the framework and a live user of it. The `.caws/` directory drives real quality gates on this codebase.

The v11 cutover is complete. `main` runs the v11 surface (currently published as `@paths.design/caws-cli@11.1.2`). v11.2 is in planning — see `docs/architecture/caws-vnext-command-surface.md` §1 ("v11.2 plan") for the multi-agent authority and observability work. **Doctrine source:** `docs/architecture/caws-vnext-command-surface.md`. Read §1 (cutover posture and v11.2 plan) and §6 (architectural invariants — invariants 1–7 are v11 core; 8–13 are v11.2 additions) before making decisions.

## v11.1 ships eleven command groups

```
init  doctor  status  scope  claim  gates  evidence  waiver  specs  worktree
```

(The eight v11.0 governed-core groups, plus `specs` and `worktree` restored in v11.1.)

Removed in v11.0 and not planned to return: `scaffold`, `validate`, `verify-acs`, `evaluate`, `iterate`, `diagnose`, `burnup`, `archive`, `provenance`, `sidecar`, `mode`, `tutorial`, `plan`, `workflow`, `quality-monitor`, `tool`, `test-analysis`, `templates`, legacy `hooks install`. The hash-chained `.caws/events.jsonl` is the audit surface; users wire their own hooks against `caws gates run`.

Currently absent and **planned for v11.2**: `caws agents list/show`, `caws claim --spec <id>` (bridge claims for non-worktree contexts), `caws worktree prune/repair/reconcile`. Until v11.2 ships, `caws status` + direct reads of `.caws/worktrees.json` and `.caws/agents.json` cover the agent-inspection use case.

**Deferred to v11.3+**: `caws session` and `caws parallel`. The `caws worktree create` loop replaces `parallel` for multi-agent setup.

## Before you start

1. Run `caws status` and `caws doctor`. The `claim` panel surfaces worktree ownership; doctor surfaces drift.
2. For multi-agent work: create your worktree with `caws worktree create <name> --spec <id>`. The command writes the bidirectional worktree↔spec binding, registers ownership, and emits the `worktree_created` + `worktree_bound` events. There is no `caws parallel setup` — loop `caws worktree create` per spec.
3. `caws claim` surfaces or takes worktree ownership. `caws claim --takeover` acquires from a foreign session and writes a `prior_owners` audit entry. In v11.2, `--takeover` will additionally emit a `claim_taken_over.v1` event (currently missing — known audit gap).

## v11 spec workflow

- Specs live at `.caws/specs/<id>.yaml`. There is no project-level working spec.
- v11.1 ships `caws specs create/list/show/close/archive`. Author specs via the CLI; `caws doctor` and `caws gates run --spec <id>` validate.
- Acceptance criteria use Given/When/Then format (see existing specs in `.caws/specs/` for the shape).

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
