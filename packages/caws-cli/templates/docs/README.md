# CAWS Project Documentation

## Overview
This project is built with the **Coding Agent Working Standard (CAWS)** — a framework for quality-assured, multi-agent AI-assisted development. CAWS partitions authority across agents (scope, worktree binding, ownership) so concurrent work stays safe and attributable.

## Key Features
- **Quality Gates**: Policy-driven validation of scope, budget, and standards (`caws gates run`)
- **Scope Binding**: Each spec declares `scope.in`/`scope.out`; the scope guard enforces edit boundaries
- **Worktree Isolation**: `caws worktree create` binds a git worktree to a spec for safe parallel work
- **Hash-chained Audit**: Every lifecycle action appends a typed event to `.caws/events.jsonl`

## Getting Started

### 1. Project Setup
The project is already initialized with CAWS. Review and customize:
- `.caws/specs/<spec-id>.yaml` — Per-feature specifications (canonical; the only spec location)
- `.caws/policy.yaml` — Risk tier definitions and gate modes
- `.github/workflows/` — CI quality gates (wire your own hooks against `caws gates run`)

### 2. Development Workflow
1. **Plan**: Create or update a feature spec with `caws specs create <id>` and edit its scope/invariants/acceptance
2. **Implement**: Stay within the spec's declared scope and mode
3. **Verify**: Run `caws doctor` and `caws gates run --spec <id>` locally
4. **Record**: Append evidence with `caws evidence record`

### 3. Quality Assurance
- Run `npm test` for the test suite
- `caws doctor` — project-wide drift detection and schema validation
- `caws gates run --spec <id> --context commit` — policy-driven gates for one spec

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

.caws/                 # CAWS control plane
├── specs/            # Per-feature specs (canonical)
├── policy.yaml       # Gates + risk-tier budgets
└── events.jsonl      # Hash-chained audit log
```

### Key Patterns
- **Dependency Injection**: For testability and determinism
- **Interface Segregation**: Clean boundaries and contracts
- **Property Testing**: Edge cases and invariants

## Development Guidelines

### Agent Conduct Rules
1. **Spec Adherence**: Stay within declared scope and mode
2. **Determinism**: Inject time, UUID, and random dependencies
3. **Comprehensive Testing**: Unit + property + integration tests
4. **No fake implementations**: No placeholder stubs, no `TODO` in committed code
5. **Prove claims**: Provide test/gate evidence, not assertions

### Code Quality
- **Type Safety**: Full TypeScript coverage where applicable
- **Test Coverage**: Set thresholds in your CI; CAWS does not ship coverage gates in v11
- **Performance**: Track latency/accessibility budgets under the spec's `non_functional`
- **Security**: Input validation, rate limiting, secret scanning

## Deployment

### CI/CD Pipeline
Wire your CI to the CAWS surface:
- `caws doctor` for drift detection
- `caws gates run --spec <id> --context ci` for policy-driven gates
- Static analysis, security scanning, and tests as your project requires

### Environment Setup
1. Configure environment variables
2. Set up monitoring and alerting
3. Establish rollback procedures
4. Document operational runbooks

## Troubleshooting

### Common Issues
1. **Scope Violations**: Run `caws scope show <path>` — it reports whether your binding is authoritative or union mode and names the responsible spec
2. **Gate Failures**: Run `caws gates run --spec <id>` and inspect the output + exit code
3. **Binding Drift**: Repair with `caws worktree bind <name> --spec <id>`
4. **Flaky Tests**: Use property testing and proper mocking

### Support
- Check `AGENTS.md` for the agent quickstart
- Review CI logs for quality gate failures
- Use `caws doctor` and `caws status` for validation and diagnosis

## Contributing

### Development Process
1. Create or update a feature spec (`caws specs create <id>`)
2. Create comprehensive tests
3. Implement within the spec's scope
4. Run `caws doctor` + `caws gates run`
5. Document changes thoroughly

### Code Review
- Review against the active feature spec
- Check gate results and scope adherence
- Validate rollback where applicable
- Ensure documentation completeness

## Resources

- **[Agent Quickstart](../AGENTS.md)**: How agents work in this project
- **[Canonical Specs](../.caws/specs/)**: Project requirements
- **[Policy](../.caws/policy.yaml)**: Gates and risk-tier budgets

---

**Maintainer**: @darianrosebrook
**Framework**: CAWS v11
