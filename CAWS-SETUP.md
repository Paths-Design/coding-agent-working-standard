# CAWS Setup Guide

Complete guide to operationalizing the **Coding Agent Workflow System (CAWS)** for scalable, quality-assured development.

## Overview

CAWS provides an engineering-grade operating system for coding agents with:
- 🔒 **Quality Gates**: Automated validation and trust scoring
- 🧪 **Comprehensive Testing**: Multi-layered test strategies
- 📊 **Observability**: Structured monitoring and provenance
- 🔄 **Rollback Ready**: Feature flags and migration support
- 📦 **Supply Chain**: SBOM and attestation generation

## Quick Start

### Option 1: Automated Setup (Recommended)
```bash
# Run the setup script
./setup-caws.sh
```

### Option 2: Manual Setup
```bash
# Install CAWS CLI
cd caws-cli
npm install -g .

# Test installation
caws --version

# Create your first project
caws init my-awesome-project
```

## Project Structure

After setup, you'll have:

```
Projects/
├── caws-cli/              # CLI tool for scaffolding
├── caws-template/         # Project template
├── setup-caws.sh         # Setup script
├── CAWS-SETUP.md         # This guide
└── my-awesome-project/   # Your new project (after caws init)
```

## Creating New Projects

### Interactive Setup (Recommended)
```bash
caws init my-new-project
```

This will prompt you for:
1. **Project ID** (e.g., FEAT-1234)
2. **Title** (descriptive name)
3. **Risk Tier** (1-3: critical, standard, low risk)
4. **Mode** (feature, refactor, fix, doc, chore)
5. **Scope** (in/out of scope items)
6. **Requirements** (functional and non-functional)
7. **Contracts** (API specifications)
8. **Observability** (logging, metrics, tracing)

### Non-Interactive Setup
```bash
caws init my-project --non-interactive
```

Uses sensible defaults - customize `.caws/working-spec.yaml` afterward.

### Skip Git Initialization
```bash
caws init my-project --no-git
```

## Scaffolding Existing Projects

Add CAWS to an existing project:

```bash
cd my-existing-project
caws scaffold
```

This adds:
- `.caws/` configuration directory
- `apps/tools/caws/` utility tools
- `codemod/` AST transformation scripts
- `.github/workflows/caws.yml` CI/CD pipeline
- Documentation and templates

## Project Customization

### Working Specification
Edit `.caws/working-spec.yaml` to customize:

```yaml
id: YOUR-PROJECT-001
title: "Your Project Description"
risk_tier: 2                    # 1=critical, 2=standard, 3=low risk
mode: feature                   # feature, refactor, fix, doc, chore
change_budget:
  max_files: 25                 # File change limit
  max_loc: 1000                 # Line of code limit
blast_radius:
  modules: ["core", "api"]      # Affected modules
  data_migration: false         # Requires DB migration
scope:
  in: ["user auth", "api endpoints"]
  out: ["legacy auth", "deprecated APIs"]
# ... more configuration
```

### Risk Tiers

| Tier | Description | Coverage | Mutation | Manual Review |
|------|-------------|----------|----------|---------------|
| 1    | Critical path, auth, billing | 90% | 70% | Required |
| 2    | Features, APIs | 80% | 50% | Optional |
| 3    | UI, tooling | 70% | 30% | Not required |

## Quality Gates

CAWS enforces multiple automated quality gates:

### 1. Pre-commit Hooks
- **Naming Guard**: Blocks duplicate file patterns (`enhanced-*.ts`)
- **Scope Guard**: Ensures changes stay within declared scope
- **Budget Guard**: Enforces file/LOC change limits

### 2. CI/CD Pipeline
- Static analysis (TypeScript, ESLint)
- Security scanning (SAST, secrets)
- Unit testing with coverage
- Integration testing
- Performance budgets
- Accessibility validation

### 3. Trust Score Calculation
Composite score (0-100) based on:
- Test coverage and mutation adequacy
- Contract compliance
- Accessibility and performance
- Observability implementation
- Mode and scope discipline
- Supply chain attestations

Target: **≥82/100** for production readiness

## Development Tools

### CAWS CLI
```bash
# Initialize new project
caws init <project-name>

# Scaffold existing project
caws scaffold

# Version info
caws --version
```

### Utility Tools
- **`prompt-lint.js`**: Validates prompts for secrets and tool allowlists
- **`attest.js`**: Generates CycloneDX SBOM and SLSA attestations
- **`codemod/rename.ts`**: AST transformations for refactoring

### Testing Framework
```bash
# Run all tests
npm run test

# Unit tests with coverage
npm run test:unit

# Contract tests
npm run test:contract

# Integration tests
npm run test:integration

# Mutation testing
npm run test:mutation

# Accessibility tests
npm run test:axe
```

## Agent Conduct Rules

All development must follow these hard constraints:

1. **Spec Adherence**: Stay within declared scope and mode
2. **Determinism**: Inject time, UUID, and random dependencies
3. **Comprehensive Testing**: Unit + property + integration tests
4. **Observability**: Log, metric, and trace key operations
5. **Rollback Ready**: Feature flags and migration support
6. **Documentation**: Update specs and generate provenance

## CI/CD Integration

### GitHub Actions
The template includes a complete workflow with:
- Multi-job parallel execution
- Caching for performance
- Artifact collection and provenance
- Trust score calculation and reporting

### Environment Setup
1. Configure required secrets
2. Set up monitoring and alerting
3. Establish incident response procedures
4. Document operational runbooks

## Monitoring & Observability

### Structured Logging
```javascript
// Good: Structured logging
logger.info('User authenticated', {
  userId: user.id,
  method: 'local',
  duration: 150
});

// Bad: Unstructured logging
console.log('User logged in');
```

### Metrics
- Request latency and throughput
- Error rates by type
- Resource utilization
- Business KPIs

### Tracing
- Distributed request correlation
- Performance profiling
- Dependency analysis

## Security & Compliance

### Supply Chain Security
- **SBOM Generation**: CycloneDX format
- **Attestation**: SLSA in-toto statements
- **Dependency Scanning**: Automated vulnerability detection
- **Secret Detection**: Pre-commit and CI scanning

### Access Control
- **Tool Allowlisting**: Restrict agent capabilities
- **Prompt Sanitization**: Remove secrets and sensitive data
- **Audit Trails**: Complete provenance tracking

## Troubleshooting

### Common Issues

#### Low Trust Score
```bash
# Check test coverage
npm run test:unit -- --coverage

# Run mutation tests
npm run test:mutation

# Validate working spec
node apps/tools/caws/validate.js .caws/working-spec.json
```

#### Scope Violations
```bash
# Check which files are out of scope
git diff --name-only origin/main | grep -v -f .caws/scope-in.txt
```

#### Budget Exceeded
```bash
# Count changed files and lines
git diff --stat origin/main

# Check against budget
jq '.change_budget' .caws/working-spec.json
```

### Performance Issues
```bash
# Run performance tests
npm run perf:budgets

# Check API response times
curl -w "@curl-format.txt" -s -o /dev/null $API_ENDPOINT
```

### Debugging Tools
```bash
# Enable debug logging
DEBUG=* npm test

# Check generated artifacts
ls -la .agent/

# Validate SBOM
cat .agent/sbom.json | jq .
```

## Best Practices

### Project Planning
1. **Start Small**: Begin with focused, well-scoped projects
2. **Risk Assessment**: Choose appropriate tier for complexity
3. **Scope Definition**: Clearly define what's in/out of scope
4. **Budget Setting**: Realistic file/LOC change limits

### Development Workflow
1. **Spec First**: Update working specification before coding
2. **Test Driven**: Write tests before implementation
3. **Incremental**: Small changes with frequent validation
4. **Review Ready**: Ensure rollback and documentation

### Code Quality
1. **Type Safety**: Full TypeScript coverage
2. **Test Coverage**: 80%+ branch, 50%+ mutation
3. **Performance**: API p95 < 250ms
4. **Accessibility**: WCAG AA compliance

## Migration Guide

### From Existing Projects
1. **Assess Current State**: Evaluate existing code quality
2. **Define Scope**: What needs to be brought under CAWS
3. **Scaffold Incrementally**: Add CAWS components gradually
4. **Set Baselines**: Establish current quality metrics
5. **Improve Iteratively**: Use trust score to guide improvements

### Version Control Strategy
1. **Branch Protection**: Require quality gates on main
2. **Pull Request Templates**: Use CAWS PR template
3. **Review Checklists**: Include trust score and gates
4. **Release Gates**: Block deployment without attestation

## Support & Resources

### Documentation
- **[CAWS Framework](caws-template/agents.md)**: Complete system guide
- **[CLI Documentation](caws-cli/README.md)**: Tool usage guide
- **[Project Template](caws-template/README.md)**: Template documentation

### Tools
- **CAWS CLI**: `caws --help`
- **Prompt Linter**: `node apps/tools/caws/prompt-lint.js`
- **Attestation Generator**: `node apps/tools/caws/attest.js`

### Community
- **Contributing**: See contribution guidelines
- **Issues**: Report bugs and request features
- **Discussions**: Share experiences and best practices

## Advanced Configuration

### Custom Tool Allowlist
Edit `apps/tools/caws/tools-allow.json`:
```json
[
  "grep",
  "read_file",
  "search_replace",
  "list_dir",
  "custom-tool-*"
]
```

### Tier Policy Customization
Modify `.caws/policy/tier-policy.json`:
```json
{
  "1": {
    "min_branch": 0.95,
    "min_mutation": 0.80,
    "requires_contracts": true,
    "requires_manual_review": true
  }
}
```

### Schema Extensions
Add custom validation rules in `.caws/schemas/`:
```json
{
  "customProperty": {
    "type": "string",
    "pattern": "^[A-Z][a-z]+$"
  }
}
```

## Maintenance

### Regular Tasks
1. **Update Dependencies**: Keep tools and libraries current
2. **Review Trust Scores**: Monitor project health trends
3. **Update Templates**: Refresh with latest best practices
4. **Tool Maintenance**: Update allowlists and configurations

### Health Monitoring
- Track trust score trends across projects
- Monitor quality gate pass/fail rates
- Review SBOM for dependency health
- Audit attestation completeness

## Conclusion

CAWS provides a complete operating system for coding agents, ensuring:
- **Quality**: Automated validation and trust scoring
- **Reliability**: Comprehensive testing and rollback support
- **Observability**: Complete provenance and monitoring
- **Security**: Supply chain security and secret protection
- **Scalability**: Template-based project creation

Start with `./setup-caws.sh` and create your first project with `caws init`. The system will guide you through best practices and ensure consistent, high-quality development.

---

**Author**: @darianrosebrook
**Framework**: CAWS v1.0
**Last Updated**: $(date)
**License**: MIT
