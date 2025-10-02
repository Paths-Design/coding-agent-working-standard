# Test Plan: {{PROJECT_TITLE}}

## Overview
- **Project**: {{PROJECT_ID}}
- **Risk Tier**: {{PROJECT_TIER}}
- **Mode**: {{PROJECT_MODE}}
- **Target Coverage**: {{TARGET_COVERAGE}}% branch, {{TARGET_MUTATION}}% mutation

## Test Strategy
### Unit Tests
- **Framework**: Jest/Vitest
- **Coverage Target**: {{UNIT_COVERAGE}}%
- **Focus**: Pure functions, business logic isolation
- **Mock Policy**: Only external dependencies (clock, fs, network)

### Contract Tests
- **Framework**: Pact/MSW
- **Target**: API contracts, schema validation
- **Coverage**: Consumer and provider contracts

### Integration Tests
- **Framework**: Testcontainers
- **Scope**: Database, external services
- **Data**: Realistic fixtures via factories

### E2E Tests
- **Framework**: Playwright
- **Scope**: Critical user paths only
- **Selectors**: Semantic roles/labels

### Mutation Tests
- **Framework**: Stryker
- **Target Score**: {{TARGET_MUTATION}}%
- **Focus**: Assertion effectiveness

## Test Categories

### Acceptance Criteria Tests
{{ACCEPTANCE_TESTS}}

### Edge Case Tests
{{EDGE_CASE_TESTS}}

### Property-Based Tests
{{PROPERTY_TESTS}}

### Non-Functional Tests
- **Performance**: API latency budgets
- **Accessibility**: axe-core compliance
- **Security**: SAST scan clean

## Test Data Strategy
### Factories
{{TEST_FACTORIES}}

### Fixtures
{{TEST_FIXTURES}}

### Seed Data
{{SEED_DATA}}

## Execution Environment
- **Local**: npm test scripts
- **CI**: GitHub Actions with containers
- **Parallelization**: Test splitting by file

## Quality Gates
- [ ] Unit coverage ≥ {{UNIT_COVERAGE}}%
- [ ] Mutation score ≥ {{TARGET_MUTATION}}%
- [ ] Contract tests pass
- [ ] Integration tests pass
- [ ] E2E smoke tests pass
- [ ] Accessibility scan clean
- [ ] Performance budgets met

---

**Author**: @darianrosebrook
**Generated**: {{TIMESTAMP}}
