# CAWS Integration Instructions for GitHub Copilot

These instructions help Copilot understand and work with CAWS (Coding Agent Workflow System) quality assurance processes.

## Overview

CAWS provides structured quality assurance for AI-assisted development. When working on CAWS-enabled projects, follow these guidelines to maintain quality standards and leverage CAWS tools effectively.

## CAWS Project Detection

**Check if current project uses CAWS:**
- Look for `.caws/working-spec.yaml` file
- Check for `caws` commands in package.json scripts
- Verify CAWS CLI availability: `caws --version`

## Working with CAWS Working Specifications

**Working specs define project requirements and constraints:**

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

**Always validate working specs:**
```bash
caws validate .caws/working-spec.yaml
```

## Quality Assurance Workflow

### 1. Pre-Implementation
```
# Get CAWS guidance before starting
caws agent iterate --current-state "About to implement X"

# CAWS will provide:
# - Implementation suggestions
# - Quality requirements
# - Risk considerations
```

### 2. During Implementation
```
# Regular quality checks
caws agent evaluate --quiet

# Address any issues immediately
# Create waivers only when justified
caws waivers create --reason emergency_hotfix --gates coverage_threshold
```

### 3. Pre-Commit Validation
```
# Comprehensive validation before commits
caws validate
caws agent evaluate

# Fix any quality gate failures
```

## CAWS Quality Gates

### Code Quality Gates
- **Linting**: ESLint, Prettier formatting
- **Type Checking**: TypeScript strict mode
- **Security**: Dependency scanning, secret detection
- **Performance**: Bundle size, runtime budgets

### Testing Gates
- **Unit Tests**: Individual component testing
- **Integration Tests**: Component interaction
- **Contract Tests**: API contract validation
- **E2E Tests**: Full workflow testing
- **Mutation Tests**: Test effectiveness validation

### Analysis Gates
- **Accessibility**: WCAG 2.1 AA compliance
- **Complexity**: Maintainability metrics
- **Coverage**: Test coverage thresholds

## Waiver Management

**Create waivers only for justified exceptions:**

```bash
# Example: Emergency security fix
caws waivers create \
  --title "Critical security vulnerability fix" \
  --reason emergency_hotfix \
  --gates coverage_threshold,contract_tests \
  --expires-at "2025-11-01T00:00:00Z" \
  --approved-by "security-team" \
  --impact-level critical \
  --mitigation-plan "Manual testing completed, security review passed"
```

**Waiver reasons:**
- `emergency_hotfix` - Critical production issues
- `legacy_integration` - Third-party compatibility
- `experimental_feature` - Sandbox/prototype code
- `performance_critical` - Hot path optimizations
- `infrastructure_limitation` - Platform constraints

## Scope Management

**Respect CAWS-defined scope boundaries:**

- **In scope**: Files listed in `scope.in` - full quality requirements apply
- **Out of scope**: Files in `scope.out` - no CAWS restrictions
- **Scope warnings**: Files outside primary scope but allowed

**Check scope compliance:**
```bash
caws validate --scope-check path/to/file.js
```

## Risk Tier Considerations

### Tier 1 (Critical) - Highest Quality Standards
- 90%+ test coverage
- All security scans pass
- Performance budgets strictly enforced
- Manual review required
- Zero waivers allowed for core gates

### Tier 2 (Standard) - Balanced Quality
- 80%+ test coverage
- Security scans pass
- Performance budgets monitored
- Peer review recommended
- Limited waivers allowed

### Tier 3 (Low Risk) - Flexible Development
- 70%+ test coverage
- Basic security checks
- Relaxed performance budgets
- Self-review acceptable
- Waivers freely allowed

## Common Patterns

### Feature Development
1. Update working spec with feature requirements
2. Get CAWS implementation guidance
3. Implement with regular quality checks
4. Create comprehensive tests
5. Validate all quality gates pass
6. Generate provenance report

### Bug Fixes
1. Assess risk tier and impact
2. Create minimal reproduction
3. Implement fix with tests
4. Run quality validation
5. Create waiver if emergency fix
6. Update working spec if scope changes

### Refactoring
1. Establish baseline quality metrics
2. Create refactoring plan
3. Implement changes incrementally
4. Maintain test suite passing
5. Run comprehensive validation
6. Update documentation

## Error Handling

### Quality Gate Failures
```
❌ CAWS validation failed
✅ Solution: Run caws validate --suggestions
✅ Fix identified issues
✅ Re-run validation
```

### Scope Violations
```
❌ File outside CAWS scope
✅ Solution: Update .caws/working-spec.yaml scope
✅ Or create waiver if justified
```

### Waiver Required
```
⚠️ High-risk change detected
✅ Solution: caws waivers create with justification
✅ Include mitigation plan
✅ Get appropriate approval
```

## Best Practices

### Code Quality
- Follow established patterns and conventions
- Write comprehensive tests with new code
- Maintain existing test coverage
- Address linting issues immediately

### Documentation
- Update working specs when requirements change
- Document waiver justifications thoroughly
- Keep provenance records current
- Update API documentation for public interfaces

### Collaboration
- Communicate waiver needs early
- Share quality gate results with team
- Review high-risk changes together
- Maintain collective code ownership

### Performance
- Monitor performance budgets during development
- Optimize hot paths identified by CAWS
- Address performance regressions immediately
- Include performance tests for critical paths

## Emergency Procedures

### Production Hotfix
1. Assess severity and business impact
2. Create emergency waiver immediately
3. Implement minimal fix with safety measures
4. Add comprehensive tests post-fix
5. Schedule follow-up quality improvements

### Security Vulnerability
1. Create critical waiver with security approval
2. Implement minimal security fix
3. Add security tests and monitoring
4. Conduct security review
5. Plan comprehensive fix for next release

## Integration with Other Tools

### Git Workflow
- Pre-commit hooks run fast CAWS checks
- Pre-push hooks run comprehensive validation
- Post-commit hooks update provenance
- Branch protection requires CAWS validation

### CI/CD Pipeline
- Automated CAWS quality gates
- Tier-based conditional execution
- Waiver validation and auditing
- Provenance report generation

### IDE Integration
- Real-time quality feedback
- Scope boundary enforcement
- Automatic waiver suggestions
- Quality dashboard visualization

## Troubleshooting

### CAWS CLI Issues
```bash
# Check installation
caws --version

# Update to latest version
npm install -g @caws/cli@latest

# Check working spec syntax
caws validate --suggestions
```

### Quality Gate Failures
```bash
# Get detailed feedback
caws agent evaluate

# Check specific gate
caws validate --gate linting

# View waiver options
caws waivers list --expiring-soon
```

### Performance Issues
```bash
# Skip heavy checks for urgent fixes
caws validate --skip performance,mutation

# Run fast checks only
caws agent evaluate --quick
```

## Support

### Getting Help
- Run `caws --help` for command reference
- Check `caws validate --suggestions` for specific issues
- Review working spec documentation
- Consult team CAWS guidelines

### Common Issues
- **Working spec invalid**: Fix YAML syntax and required fields
- **Scope violations**: Update scope or create waiver
- **Quality gate failures**: Address root cause, don't just waive
- **Performance regressions**: Optimize or adjust budgets

Remember: CAWS is designed to maintain quality while enabling development velocity. Use waivers judiciously and always prioritize code quality and security.
