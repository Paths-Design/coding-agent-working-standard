# Junie Guidelines - CAWS Project

This project uses CAWS (Coding Agent Working Standard) for quality-assured development.

## Working Spec

Before making changes, read `.caws/working-spec.yaml`. It defines:

- **Risk tier**: Quality requirements (T1: 90%+ coverage, T2: 80%+, T3: 70%+)
- **Scope**: `scope.in` lists files you may edit, `scope.out` is off-limits
- **Change budget**: Maximum files and lines of code per change
- **Acceptance criteria**: What "done" means for this task

## CAWS Commands

```bash
caws validate                    # Validate the working spec
caws agent iterate               # Get implementation guidance
caws agent evaluate              # Evaluate quality compliance
caws waivers create --reason ... # Create waiver for justified exceptions
```

## Key Rules

1. **Stay in scope** -- only edit files listed in `scope.in`
2. **Respect change budgets** -- stay within `max_files` and `max_loc`
3. **No shadow files** -- edit in place, never create `*-enhanced.*`, `*-new.*`, `*-v2.*`, `*-final.*` copies
4. **Tests first** -- write failing tests before implementation
5. **Deterministic code** -- inject time, random, and UUID generators for testability
6. **No fake implementations** -- no placeholder stubs, no `TODO` in committed code, no in-memory arrays pretending to be persistence, no hardcoded mock responses
7. **Prove claims** -- never assert "production-ready", "complete", or "battle-tested" without passing all quality gates. Provide evidence, not assertions.
8. **No marketing language in docs** -- avoid "revolutionary", "cutting-edge", "state-of-the-art", "enterprise-grade"
9. **Ask first for risky changes** -- changes touching >10 files, >300 LOC, crossing package boundaries, or affecting security/infrastructure require discussion first
10. **Conventional commits** -- use `feat:`, `fix:`, `refactor:`, `docs:`, `chore:` prefixes

## Quality Gates

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
- Max cognitive complexity: 15
- Max nesting depth: 4
- Max function length: 50 lines
- Max file length: 1000 lines
- Max parameters: 5
- No emojis in production code or logs
- Check if a server/process is already running before starting another

### Naming

Forbidden file name modifiers: enhanced, unified, better, new, next, final, copy, revamp, improved. Prefer in-place edits with a merge-then-delete strategy for refactors.

## Build & Test

```bash
npm install          # Install dependencies
npm test             # Run tests
npm run lint         # Lint code
npm run typecheck    # Type check (if TypeScript)
caws validate        # Validate CAWS spec
```
