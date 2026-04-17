# CLAUDE.md

Project-specific guidance for Claude Code agents working on the CAWS repository.

## This repo self-hosts

CAWS (Coding Agent Workflow System) is both the framework and a live user of it. The `.caws/` directory drives real quality gates on this codebase. Follow CAWS protocol, not free-form edits.

## Before you start

1. Check current state: `caws specs list` — see active specs
2. Check conflicts: `caws specs conflicts` — before editing scope-shared areas
3. If working in parallel with other agents, use a worktree (`caws worktree create <name>` or `caws parallel setup <plan.yaml>`)

## Spec workflow

- **Never edit `.caws/working-spec.yaml` directly.** That's the project baseline. Create a feature spec at `.caws/specs/<ID>.yaml` instead:
  ```bash
  caws specs create <id> --type feature --title "..."
  caws validate --spec-id <id>
  ```
- **Always pass `--spec-id`** on `caws validate|iterate|evaluate|verify-acs|status` — otherwise commands may target the wrong spec.
- Acceptance criteria use Given/When/Then format (see `.caws/specs/EVLOG-002.yaml` for reference shape).
- `contracts: []` is accepted but discouraged for `mode=feature`.

## Governed paths (require special handling)

Per `.caws/agent-operating-spec.yaml`:

- `.caws/policy.yaml` — CI requires 2 approvals + path discipline (no code changes in the same PR)
- `CODEOWNERS` — reviewer routing, do not edit casually
- `change_budget` keys in any spec YAML — blocked by CI; use waivers instead
- Pre-commit hooks — do not bypass with `--no-verify`

Legitimate escape: `caws waivers create --reason=<code> --gates=<list> --expires-at=<iso8601>`.

## Worktree discipline

When worktrees are active:

- Work only in your assigned worktree
- Use the main repo's venv (`source <main-repo>/.venv/bin/activate`), not a per-worktree one
- Commits to the base branch during active worktrees must use the `merge(worktree):` format (enforced by commit-msg hook)
- On completion: `caws worktree destroy <name>` → `git checkout main` → `git merge --no-ff caws/<name>`

See `.claude/rules/worktree-isolation.md` for the full list.

## Commands you'll use

- `caws validate --spec-id <id>` — schema validation
- `caws gates run --context cli|commit` — quality gates (cli context skips budget — it applies to diffs, not the whole repo)
- `caws verify-acs --spec-id <id>` — check ACs against tests
- `caws iterate --spec-id <id>` — iteration guidance
- `caws status [--visual] [--spec-id <id>]` — project health
- `caws specs conflicts` — scope overlap check

## Test suite

- Fast gate: `npm run test:fast`
- CLI tests: `cd packages/caws-cli && npx jest` (invoke directly — the top-level `test:fast` script occasionally gets swallowed by zsh completion noise)
- Per `/Users/darianrosebrook/.claude/CLAUDE.md` session protocol: interpret pass counts critically, cite specific assertion evidence, call out false-confidence risks.

## References

- `AGENTS.md` — full agent quickstart (in-repo)
- `docs/agents/full-guide.md` — comprehensive agent workflow
- `.claude/rules/` — git safety + worktree isolation rules (already loaded by Claude Code)
- `docs/internal/claude-code-cross-analysis.md` — how CAWS compares to Claude Code's runtime harness
