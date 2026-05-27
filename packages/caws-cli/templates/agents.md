# AGENTS.md

This project uses [CAWS](https://github.com/paths-design/caws) (Coding Agent Working Standard) for quality-assured AI-assisted development. CAWS v11.1+ ships a small set of governed commands; this guide assumes that surface.

## Build & Test

```bash
npm install              # Install dependencies
npm test                 # Run tests
npm run lint             # Lint code
npm run typecheck        # Type check (if TypeScript)
caws doctor              # Project-wide CAWS drift detection
```

## Project Structure

```
.caws/
  specs/                 # Per-feature specs (canonical; the only spec location)
  specs/.archive/        # Archived specs (filesystem-authoritative)
  policy.yaml            # Gates + risk_tier change budgets
  waivers/               # Per-id waiver files
  agents.json            # Session registry (gitignored runtime cache)
  leases/                # Per-session liveness leases (gitignored)
  worktrees.json         # Worktree registry (gitignored runtime state)
  events.jsonl           # Hash-chained audit log (gitignored)
  state/                 # Runtime working state (gitignored, auto-managed)
```

## CAWS Workflow

1. **Read the spec**: Use `.caws/specs/<id>.yaml` for the active feature
2. **Plan with `caws doctor`**: Get drift snapshot before changes
3. **Implement**: Write tests first, then implementation. Stay within scope.
4. **Verify with `caws gates run --spec <id> --context commit`**: Per-spec gate evaluation
5. **Commit**: Use conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`)

For a new feature:

```bash
caws specs create FEAT-001 --title "My Feature" --mode feature --risk-tier 3
# Then edit .caws/specs/FEAT-001.yaml to populate scope/invariants/acceptance/...
git add .caws/specs/FEAT-001.yaml && git commit -m "chore(caws): create FEAT-001 spec"
caws worktree create wt-feat-001 --spec FEAT-001
cd .caws/worktrees/wt-feat-001
```

## v11 Spec Shape

Specs at `.caws/specs/<id>.yaml` carry:

- `id` (pattern `^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\d+[a-z]*$`)
- `title` (≤200 chars)
- `risk_tier` (integer 1|2|3 — string forms like `"T3"` are rejected)
- `mode` (`feature|refactor|fix|doc|chore` — v10 `development` is rejected)
- `lifecycle_state` (`draft|active|closed|archived` — replaces v10 `status:`)
- `blast_radius.modules` (non-empty string array)
- `scope.in` (non-empty); `scope.out` (directory paths only — no glob patterns)
- `invariants` (non-empty array of strings)
- `acceptance` (array of `{id: ^A\d+$, given, when, then}` — v10 `acceptance_criteria:` is rejected)
- `non_functional` (object; only `reliability` and `performance` admitted)
- `contracts` (`{name, type: api|schema|contract-test|behavior, path?, description?}`; tier-1/2 require non-empty)

**v10 fields removed from the schema**: `type:`, `description:`, `notes:`, `non_goals:`, `bounded_claim:`, `dependencies:`, `status_rationale:`, `change_budget:`, `created:`.

## Scope and Worktree Binding

The scope guard enforces `scope.in` / `scope.out` from your spec. How it enforces depends on binding:

- **Authoritative mode** (worktree bound to a spec): Only your spec's scope is checked. Other agents' specs cannot block you.
- **Union mode** (no binding): ALL active specs are checked. Any `scope.out` from any spec can block you.

```bash
# Explain the scope decision for one path (always exits 0)
caws scope show <path>

# Enforce the scope decision (exits 0 admit, 1 reject)
caws scope check <path>

# Repair a one-sided binding
caws worktree bind <name> --spec <id>
```

**Recovery** (when blocked unexpectedly):

1. Run `caws scope show <path>` (positional `<path>` is required in v11)
2. If union mode: `caws worktree bind <name> --spec <id>`
3. If authoritative but blocked: update your spec's `scope.in`, or request a waiver via `caws waiver create`
4. Do NOT edit another spec's `scope.out` to unblock yourself

## Multi-Agent Claims

Each session is registered in `.caws/agents.json` automatically (via the agent-register hook and on every CAWS lifecycle CLI invocation). Per-session liveness leases land in `.caws/leases/` (gitignored, operational cache only). Worktree session ownership is recorded in `.caws/worktrees.json:owner` as a session id. `caws worktree bind`, `merge`, and `claim` will refuse to mutate a worktree owned by a different session id without `--takeover`.

```bash
# Surface the current worktree's ownership (read-only)
caws claim

# Take over a foreign claim (writes prior_owners audit)
caws claim --takeover
```

Note: `caws agents list/show` is planned for v11.2; until then inspect `.caws/agents.json` and `.caws/worktrees.json` directly, or use `caws status`.

When a refusal fires, the warning includes the claimer's session id, heartbeat age, and a pointer to any `tmp/<sessionId>/` session-log directory — read that log for context before deciding to take over. A stale heartbeat does NOT mean the prior session is dead; it may be paused.

## Spec Lifecycle

```bash
# Close an active spec
caws specs close <id>

# Move a closed spec to the canonical archive
caws specs archive <id>
```

The `.caws/specs/.archive/` directory is filesystem-authoritative — `caws specs list` reports any file under it as `lifecycle_state: archived` regardless of YAML literal. `caws specs create` refuses ids that already exist in `.archive/`.

> **Budget note**: `change_budget:` is not accepted as a top-level spec field in v11.
> Budgets derive from `.caws/policy.yaml` `risk_tiers`. Adjust thresholds via `policy.yaml`,
> not via spec edits.

## Key Rules

1. **Stay in scope** — only edit files admitted by `scope.in`, never touch `scope.out`
2. **Respect change budgets** — stay within `max_files` and `max_loc` limits derived from `risk_tier`
3. **No shadow files** — edit in place, never create `*-enhanced.*`, `*-new.*`, `*-v2.*`, `*-final.*` copies
4. **Tests first** — write failing tests before implementation
5. **Deterministic code** — inject time, random, and UUID generators for testability
6. **No fake implementations** — no placeholder stubs, no `TODO` in committed code, no in-memory arrays pretending to be persistence, no hardcoded mock responses
7. **Prove claims** — never assert "production-ready", "complete", or "battle-tested" without passing gates. Provide evidence (test results, coverage reports), not assertions.
8. **No marketing language in docs** — avoid "revolutionary", "cutting-edge", "state-of-the-art", "enterprise-grade" in documentation and comments
9. **Ask first for risky changes** — changes touching >10 files, >300 LOC, crossing package boundaries, or affecting security/infrastructure require discussion before implementation

## Quality Gates (v11)

Gates are declared in `.caws/policy.yaml` with a `mode` (`block | warn | skip`). v11's five admissible gate names:

| Gate | Typical mode | Purpose |
|------|--------------|---------|
| `budget_limit` | block | Enforce change_budget limits derived from `risk_tier` |
| `spec_completeness` | block | Refuse load on schema-invalid specs |
| `scope_boundary` | block | Refuse edits outside the bound spec's `scope.in` |
| `god_object` | warn | Flag large/responsibility-overloaded modules |
| `todo_detection` | warn | Flag TODOs/placeholders/dangling promises in committed code |

Risk tier governs change-budget thresholds but does NOT directly set per-gate enforcement levels — the gate `mode` is global. v10's "T1 90% coverage / T2 80% / T3 70%" table is gone; coverage and mutation gates were not ported into v11's gate vocabulary. Run those outside CAWS in CI if you need them.

Run `caws gates run --spec <id> --context commit` to evaluate all declared gates. Each evaluation appends a `gate_evaluated` event to `.caws/events.jsonl`.

## Code Style

- Prefer `const` over `let`
- Use guard clauses and early returns over deep nesting
- Single responsibility: one reason to change per module
- Depend on abstractions, not concretions
- Extension points over editing internals (open/closed principle)
- Max cyclomatic complexity per function: 10
- Max nesting depth: 4
- Max function length: 50 lines
- Max file length: 1000 lines
- Max parameters: 5
- No emojis in production code or logs
- Check if a server/process is already running before starting another

### Naming

Forbidden file name modifiers: `enhanced`, `unified`, `better`, `new`, `next`, `final`, `copy`, `revamp`, `improved`. Use in-place edits with merge-then-delete strategy for refactors.

## Modes

| Mode | Contracts | New Files | Key Artifacts |
|------|-----------|-----------|---------------|
| **feature** | Required first | Allowed in scope.in | Migration plan, feature flag, perf budget |
| **refactor** | Must not change | Discouraged | Codemod script + semantic diff |
| **fix** | Unchanged | Discouraged | Red test → green; root cause note |
| **doc** | N/A | Docs only | Updated README/usage snippets |
| **chore** | N/A | Build/tools only | Version updates, dependency changes |

## Waivers

v11 waivers live at `.caws/waivers/<WV-NNNN>.yaml`, one file per waiver. (The v10 aggregate `active-waivers.yaml` format is rejected.) Create via:

```bash
caws waiver create WV-1234 \
  --title "Short justification (>=5 chars)" \
  --gate <gate-name> \
  --reason "..." \
  --approved-by "@you" \
  --expires-at 2026-06-30T00:00:00Z
```

Repeat `--gate` for multiple gates. Gate names must appear in `.caws/policy.yaml` `gates`. The CLI validates against the kernel before writing.

## Pre-Submit Checklist

- [ ] Canonical spec exists and validates (`caws doctor` reports 0 spec.schema.* errors)
- [ ] All tests pass (`npm test`)
- [ ] Coverage meets your CI thresholds (run outside CAWS — coverage is not a v11 gate)
- [ ] Lints pass (`npm run lint`)
- [ ] Types check (`npm run typecheck`)
- [ ] No scope violations (`caws gates run --spec <id> --context commit` passes scope_boundary)
- [ ] Change budget not exceeded (`caws gates run` passes budget_limit; check `policy.yaml risk_tiers` for the threshold)
- [ ] Acceptance criteria proven (each `acceptance[i]` carries `test_nodeids:` or `evidence:`; record proofs via `caws evidence record --type ac --spec <id>`)
- [ ] Conventional commit message

## Removed commands (do not use)

The following v10 commands were removed in v11.0 and are not coming back:

`scaffold`, `validate`, `verify-acs`, `evaluate`, `iterate`, `diagnose`, `burnup`, `archive` (the standalone command — `caws specs archive` is the replacement), `provenance`, `sidecar`, `mode`, `tutorial`, `plan`, `workflow`, `quality-monitor`, `tool`, `test-analysis`, `templates`, legacy `hooks install`.

If you see any of these in older project doctrine or hooks, the surface no longer exists — fold the intent into `doctor`, `gates run`, `status`, `specs`, or `evidence record`. The hash-chained `.caws/events.jsonl` is the audit surface.
