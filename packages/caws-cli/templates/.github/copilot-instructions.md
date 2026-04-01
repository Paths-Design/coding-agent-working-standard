# CAWS Integration Instructions for GitHub Copilot

This project uses CAWS (Coding Agent Working Standard) for quality-assured AI-assisted development.

## CAWS Project Detection

Check if current project uses CAWS:
- Look for `.caws/working-spec.yaml` file
- Check for `caws` commands in package.json scripts
- Verify CAWS CLI availability: `caws --version`

## Working Specifications

Working specs define project requirements and constraints:

```yaml
id: PROJ-001
title: "Feature implementation"
risk_tier: 2  # 1=Critical, 2=Standard, 3=Low risk
mode: feature  # feature|refactor|fix|chore
change_budget:
  max_files: 25
  max_loc: 1000
scope:
  in: ["src/", "tests/"]
  out: ["node_modules/", "dist/"]
```

Always validate working specs: `caws validate`

## Quality Workflow

1. **Before implementation**: `caws iterate --current-state "describe what you're about to do"`
2. **During implementation**: `caws evaluate --quiet`
3. **Before commit**: `caws validate && caws evaluate`

## Quality Gates by Risk Tier

| Gate | T1 (Critical) | T2 (Standard) | T3 (Low Risk) |
|------|---------------|----------------|----------------|
| Test coverage | 90%+ | 80%+ | 70%+ |
| Mutation score | 70%+ | 50%+ | 30%+ |
| Contracts | Required | Required | Optional |
| Manual review | Required | Optional | Optional |

## Key Rules

1. Stay within `scope.in` boundaries -- do not edit files in `scope.out`
2. Respect `change_budget.max_files` and `change_budget.max_loc` limits
3. No shadow files -- edit in place, never create `*-enhanced.*`, `*-new.*`, `*-v2.*` copies
4. Write tests before implementation when possible
5. Use conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`

## Waivers

If you need to bypass a quality gate, create a waiver:

```bash
caws waivers create --reason emergency_hotfix --gates coverage_threshold
```

Valid reasons: `emergency_hotfix`, `legacy_integration`, `experimental_feature`, `performance_critical`, `infrastructure_limitation`

## Common Patterns

### Feature Development
1. Validate working spec: `caws validate`
2. Get implementation guidance: `caws iterate`
3. Implement with quality checks: `caws evaluate --quiet`
4. Run full validation: `caws validate && npm test`

### Bug Fixes
1. Assess risk tier and impact
2. Write failing test that reproduces the bug
3. Implement minimal fix
4. Run quality validation: `caws validate`

## Troubleshooting

- **Working spec invalid**: Run `caws validate --suggestions`
- **Scope violations**: Update `.caws/working-spec.yaml` scope or create waiver
- **Quality gate failures**: Address root cause rather than creating waivers
