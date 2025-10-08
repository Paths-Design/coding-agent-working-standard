# CAWS Project Documentation

## Overview
This project is built with the **Coding Agent Workflow System (CAWS)** - an engineering-grade framework that ensures quality, reliability, and maintainability in AI-assisted development.

## Key Features
- 🔒 **Quality Gates**: Automated validation of scope, budget, and standards
- 🧪 **Comprehensive Testing**: Unit, contract, integration, and mutation testing
- 📊 **Observability**: Structured logging, metrics, and tracing
- 🔄 **Rollback Ready**: Feature flags and migration support
- 📦 **Provenance Tracking**: SBOM and SLSA attestation generation

## Getting Started

### 1. Project Setup
The project is already scaffolded with CAWS. Review and customize:
- `.caws/working-spec.yaml` - Project specification and requirements
- `.caws/policy/tier-policy.json` - Risk tier definitions
- `.github/workflows/caws.yml` - CI/CD quality gates

### 2. Development Workflow
1. **Plan**: Update working spec with requirements and scope
2. **Implement**: Follow agent conduct rules and mode constraints
3. **Verify**: Run tests and quality gates locally
4. **Document**: Update documentation and generate provenance

### 3. Quality Assurance
- Run `npm run test` for all tests
- Check trust score with CAWS tools
- Validate against working specification
- Ensure rollback capabilities

## Architecture

### Directory Structure
```
src/                    # Source code
├── core/              # Core business logic
├── api/               # API endpoints
├── models/            # Data models
└── utils/             # Utilities

tests/                 # Test suites
├── unit/             # Unit tests
├── contract/         # Contract tests
├── integration/      # Integration tests
└── e2e/              # End-to-end tests

apps/tools/caws/       # CAWS utilities
└── prompt-lint.js    # Prompt validation
└── attest.js         # SBOM/attestation generation
```

### Key Patterns
- **Dependency Injection**: For testability and determinism
- **Interface Segregation**: Clean boundaries and contracts
- **Observability**: Structured logging and metrics
- **Property Testing**: Edge cases and invariants

## Development Guidelines

### Agent Conduct Rules
1. **Spec Adherence**: Stay within declared scope and mode
2. **Determinism**: Inject time, UUID, and random dependencies
3. **Comprehensive Testing**: Unit + property + integration tests
4. **Observability**: Log, metric, and trace key operations
5. **Rollback Ready**: Feature flags and migration support

### Code Quality
- **Type Safety**: Full TypeScript coverage
- **Test Coverage**: 80%+ branch coverage, 50%+ mutation score
- **Performance**: API p95 < 250ms, accessibility compliance
- **Security**: Input validation, rate limiting, secret scanning

## Deployment

### CI/CD Pipeline
The project includes automated quality gates:
- Static analysis and security scanning
- Unit and integration testing
- Performance and accessibility validation
- Provenance and attestation generation

### Environment Setup
1. Configure environment variables
2. Set up monitoring and alerting
3. Establish rollback procedures
4. Document operational runbooks

## Monitoring & Observability

### Metrics
- Request latency and throughput
- Error rates and types
- Resource utilization
- Business metrics

### Logging
- Structured logs with correlation IDs
- Error tracking and alerting
- Performance monitoring
- Security event logging

### Tracing
- Distributed request tracing
- Performance profiling
- Dependency analysis
- Root cause identification

## Troubleshooting

### Common Issues
1. **Trust Score Low**: Check test coverage and quality gates
2. **Scope Violations**: Ensure changes align with working spec
3. **Budget Exceeded**: Review change size and complexity
4. **Flaky Tests**: Use property testing and proper mocking

### Support
- Check `agents.md` for comprehensive documentation
- Review CI/CD logs for quality gate failures
- Use CAWS tools for validation and debugging
- Follow agent conduct rules for collaboration

## Contributing

### Development Process
1. Update working specification
2. Create comprehensive tests
3. Implement with quality gates
4. Generate provenance artifacts
5. Document changes thoroughly

### Code Review
- Review against working specification
- Check trust score and quality gates
- Validate observability and rollback
- Ensure documentation completeness

## Resources

- **[CAWS Framework](agents.md)**: Complete system documentation
- **[Working Specification](.caws/working-spec.yaml)**: Project requirements
- **[Quality Gates](.github/workflows/caws.yml)**: CI/CD pipeline
- **[Tools](apps/tools/caws/)**: Development utilities

---

**Maintainer**: @darianrosebrook
**Framework**: CAWS v1.0
**Updated**: $(date)
