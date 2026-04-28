# AGENTS.md

This project uses [CAWS](https://github.com/paths-design/caws) (Coding Agent Working Standard) for quality-assured AI-assisted development.

## Build & Test

```bash
npm install              # Install dependencies
npm test                 # Run tests
npm run lint             # Lint code
npm run typecheck        # Type check (if TypeScript)
caws validate            # Validate the current CAWS spec
```

## Project Structure

```
.caws/
  working-spec.yaml      # Compatibility mirror for legacy paths
  specs/                 # Canonical feature specs
  policy.yaml            # Quality policy overrides (optional)
  waivers.yml            # Active waivers (optional)
```

## CAWS Workflow

1. **Read the canonical spec**: Use `.caws/specs/<spec-id>.yaml` when feature specs exist
2. **Validate**: Run `caws validate --spec-id <spec-id>` for feature work
3. **Plan**: Run `caws iterate` for implementation guidance
4. **Implement**: Write tests first, then implementation. Stay within scope boundaries.
5. **Verify**: Run `caws evaluate` to check quality compliance
6. **Commit**: Use conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`)

For a new feature in a multi-agent project:

```bash
caws specs create my-feature --type feature --title "My Feature"
caws validate --spec-id my-feature
```

## Scope and Worktree Binding

The scope guard enforces `scope.in` and `scope.out` from your spec. How it enforces depends on binding:

- **Authoritative mode** (worktree bound to a spec): Only your spec's scope is checked. Other agents' specs cannot block you.
- **Union mode** (no binding): ALL active specs are checked. Any `scope.out` from any spec can block you.

```bash
# See your effective scope and binding health
caws scope show

# Fix a broken binding
caws worktree bind <spec-id>
```

**Recovery** (when blocked unexpectedly):
1. Run `caws scope show` to check mode and binding health
2. If union mode: `caws worktree bind <spec-id>`
3. If authoritative but blocked: update your spec's `scope.in`
4. Do NOT edit another spec's `scope.out` to unblock yourself

## Multi-Agent Claims

Each session is registered in `.caws/agents.json` automatically. Worktree session ownership is recorded in `.caws/worktrees.json:owner` as a session id. `caws worktree bind`, `merge`, and `claim` will refuse to mutate a worktree owned by a different session id without `--takeover`.

```bash
# See registered agents (composite <sessionId>:<platform> format)
caws agents list

# Inspect a worktree's claim — read-only by default
caws worktree claim <name>

# Take over a foreign claim (writes prior_owners audit)
caws worktree claim <name> --takeover
```

When a refusal fires, the warning includes the claimer's session id, heartbeat age, and a pointer to any `tmp/<sessionId>/` session-log directory — read that log for context before deciding to take over. A stale heartbeat does NOT mean the prior session is dead; it may be paused.

## Spec Lifecycle: Archive

```bash
# Move a closed spec to the canonical archive
caws specs archive <spec-id>
```

The `.caws/specs/.archive/` directory is filesystem-authoritative — `caws specs list` reports any file under it as `archived` regardless of YAML status. `caws specs create` refuses ids that collide with archived files unless `--force` is supplied (which removes the archived copy and writes a fresh draft).

## Key Rules

1. **Stay in scope** -- only edit files listed in `scope.in`, never touch `scope.out`
2. **Respect change budgets** -- stay within `max_files` and `max_loc` limits
3. **No shadow files** -- edit in place, never create `*-enhanced.*`, `*-new.*`, `*-v2.*`, `*-final.*` copies
4. **Tests first** -- write failing tests before implementation
5. **Deterministic code** -- inject time, random, and UUID generators for testability
6. **No fake implementations** -- no placeholder stubs, no `TODO` in committed code, no in-memory arrays pretending to be persistence, no hardcoded mock responses
7. **Prove claims** -- never assert "production-ready", "complete", or "battle-tested" without passing all quality gates. Provide evidence (test results, coverage reports), not assertions.
8. **No marketing language in docs** -- avoid "revolutionary", "cutting-edge", "state-of-the-art", "enterprise-grade" in documentation and comments
9. **Ask first for risky changes** -- changes touching >10 files, >300 LOC, crossing package boundaries, or affecting security/infrastructure require discussion before implementation

## Quality Gates

Requirements are tiered based on the `risk_tier` in the active spec:

| Gate | T1 (Critical) | T2 (Standard) | T3 (Low Risk) |
|------|---------------|----------------|----------------|
| Test coverage | 90%+ | 80%+ | 70%+ |
| Mutation score | 70%+ | 50%+ | 30%+ |
| Contracts | Required | Required | Optional |
| Manual review | Required | Optional | Optional |

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
| **fix** | Unchanged | Discouraged | Red test -> green; root cause note |
| **doc** | N/A | Docs only | Updated README/usage snippets |
| **chore** | N/A | Build/tools only | Version updates, dependency changes |

## Waivers

If you need to bypass a quality gate, create a waiver with justification:

```bash
caws waivers create --reason emergency_hotfix --gates coverage_threshold
```

Valid reasons: `emergency_hotfix`, `legacy_integration`, `experimental_feature`, `performance_critical`, `infrastructure_limitation`

## Pre-Submit Checklist

- [ ] Canonical spec exists and validates (`caws validate --spec-id <spec-id>` when applicable)
- [ ] All tests pass (`npm test`)
- [ ] Coverage meets tier requirements
- [ ] Lints pass (`npm run lint`)
- [ ] Types check (`npm run typecheck`)
- [ ] No scope violations
- [ ] Change budget not exceeded (`caws burnup --spec-id <spec-id>` shows budget consumption)
- [ ] Acceptance criteria proven (`caws verify-acs --spec-id <spec-id>` checks evidence exists)
- [ ] Conventional commit message

### Optional: Self-Diagnosis with Sidecars

If a gate blocks you, use sidecar commands to understand why before retrying:

```bash
caws sidecar gaps          # What's missing? Which gates are failing and why?
caws sidecar drift         # Has implementation drifted from the spec intent?
caws sidecar waiver-draft  # Generate a pre-filled waiver if the gap is acceptable
caws sidecar provenance    # Summarize work history for merge readiness
```
