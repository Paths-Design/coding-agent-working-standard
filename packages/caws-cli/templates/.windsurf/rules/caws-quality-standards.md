# CAWS Quality Standards

This project uses CAWS (Coding Agent Working Standard) for quality-assured development.

## Working Spec

Always check `.caws/working-spec.yaml` before making changes. It defines:

- **Risk tier**: T1 (critical, 90%+ coverage), T2 (standard, 80%+), T3 (low risk, 70%+)
- **Scope boundaries**: `scope.in` (allowed files), `scope.out` (off-limits)
- **Change budget**: `max_files` and `max_loc` limits per change
- **Acceptance criteria**: Definition of done

## Key Rules

1. Stay within scope boundaries defined in the working spec
2. Respect change budgets -- split large changes into smaller PRs
3. No shadow files: never create `*-enhanced.*`, `*-new.*`, `*-v2.*`, `*-final.*` copies
4. Write tests before implementation when possible
5. Deterministic code -- inject time, random, and UUID generators for testability
6. No fake implementations -- no placeholder stubs, no `TODO` in committed code, no in-memory arrays pretending to be persistence, no hardcoded mock responses
7. Prove claims -- never assert "production-ready", "complete", or "battle-tested" without passing all quality gates. Provide evidence, not assertions.
8. No marketing language in docs -- avoid "revolutionary", "cutting-edge", "state-of-the-art", "enterprise-grade"
9. Ask first for risky changes -- changes touching >10 files, >300 LOC, crossing package boundaries, or affecting security/infrastructure require discussion first
10. Use conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`
11. Run `caws validate` before committing

## Quality Commands

```bash
caws validate                    # Validate working spec
caws agent iterate               # Get implementation guidance
caws agent evaluate              # Evaluate quality compliance
caws waivers create --reason ... # Create waiver for justified exceptions
```

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

## Naming

Forbidden file name modifiers: enhanced, unified, better, new, next, final, copy, revamp, improved. Use in-place edits with merge-then-delete strategy for refactors.
