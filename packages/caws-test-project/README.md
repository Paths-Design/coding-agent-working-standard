# CAWS Test Project

**Example CAWS Project for Testing and Validation**

The CAWS Test Project serves as a reference implementation and testing ground for CAWS (Coding Agent Workflow System) features. It demonstrates proper CAWS project structure, includes comprehensive test suites, and validates CAWS quality gates and tooling.

## Overview

The test project provides:

- **Reference Structure**: Complete CAWS project layout
- **Quality Gate Validation**: Tests all CAWS quality gates
- **Tool Integration**: Demonstrates CAWS tool ecosystem
- **Testing Examples**: Comprehensive test suite examples
- **CI/CD Validation**: GitHub Actions and other CI/CD integration
- **Provenance Tracking**: Complete audit trail examples

## Project Structure

```
caws-test-project/
├── .caws/                    # CAWS configuration directory
│   ├── working-spec.yaml     # Project working specification
│   ├── waivers/              # Waiver management (if needed)
│   └── cache/                # CI/CD optimization cache
├── apps/tools/caws/          # CAWS quality gate tools
├── tests/                    # Comprehensive test suites
│   ├── unit/                 # Unit tests
│   ├── integration/          # Integration tests
│   ├── contract/             # Contract tests
│   ├── e2e/                  # End-to-end tests
│   ├── mutation/             # Mutation tests
│   └── axe/                  # Accessibility tests
├── docs/                     # Project documentation
├── codemod/                  # Code transformation tools
├── agents.md                 # Agent conduct guidelines
└── package.json              # Project configuration
```

## Working Specification

The project includes a comprehensive working specification:

```yaml
id: TEST-001
title: "CAWS Test Project"
risk_tier: 2
mode: feature
change_budget:
  max_files: 50
  max_loc: 2000
scope:
  in: ["src/", "tests/", "docs/"]
  out: ["node_modules/", "dist/"]
acceptance:
  - id: "A1"
    given: "CAWS project structure"
    when: "All quality gates execute"
    then: "Zero critical issues found"
invariants:
  - "Project maintains CAWS compliance"
  - "All tests pass with required coverage"
  - "Security scans pass without high-severity issues"
```

## Quality Gates

The test project validates all CAWS quality gates:

### Code Quality Gates
- **Linting**: ESLint configuration and rules
- **Type Checking**: TypeScript strict mode validation
- **Formatting**: Prettier code formatting standards
- **Security**: Dependency vulnerability scanning

### Testing Gates
- **Unit Tests**: Jest-based unit test coverage (>80%)
- **Integration Tests**: Component interaction validation
- **Contract Tests**: API contract compliance
- **E2E Tests**: Full workflow validation
- **Mutation Tests**: Test effectiveness validation (>50%)

### Analysis Gates
- **Accessibility**: WCAG 2.1 AA compliance (axe-core)
- **Performance**: Bundle size and runtime performance budgets
- **Security Scanning**: SAST and dependency analysis
- **Code Complexity**: Maintainability index validation

## Tool Integration

### Quality Gate Tools

The project includes examples of all CAWS tool types:

#### Validation Tools
- **Spec Validator**: Validates working specifications
- **Schema Validator**: JSON schema compliance checking
- **Dependency Validator**: Package.json and lockfile validation

#### Security Tools
- **Secret Scanner**: Prevents credential leaks
- **Vulnerability Scanner**: Dependency security analysis
- **SAST Scanner**: Static application security testing

#### Quality Gate Tools
- **Coverage Gate**: Test coverage threshold enforcement
- **Mutation Gate**: Mutation testing score validation
- **Performance Gate**: Performance budget checking

#### Analysis Tools
- **Complexity Analyzer**: Code complexity metrics
- **Accessibility Scanner**: WCAG compliance validation
- **Bundle Analyzer**: Bundle size optimization

### Tool Development Examples

Each tool demonstrates CAWS tool development patterns:

```javascript
// Tool metadata definition
const metadata = {
  id: 'coverage-gate',
  name: 'Coverage Quality Gate',
  version: '1.0.0',
  capabilities: ['quality-gates', 'validation'],
  author: '@caws-team'
};

// Tool execution logic
async function execute(parameters, context) {
  const coverage = await getCoverageReport();
  const threshold = getTierThreshold(context.spec.risk_tier);

  return {
    success: coverage >= threshold,
    output: {
      coverage_percentage: coverage,
      threshold_required: threshold,
      status: coverage >= threshold ? 'passed' : 'failed'
    }
  };
}
```

## Testing Strategy

### Test Categories

#### Unit Tests (`tests/unit/`)
- Individual function and component testing
- Mocked dependencies and isolated logic
- Fast execution (< 100ms per test)

#### Integration Tests (`tests/integration/`)
- Component interaction validation
- Real dependencies with test databases
- API endpoint testing

#### Contract Tests (`tests/contract/`)
- API contract compliance validation
- Consumer-driven contract testing
- Pact-based contract verification

#### E2E Tests (`tests/e2e/`)
- Full user workflow validation
- Browser automation with Playwright
- Critical path coverage

#### Mutation Tests (`tests/mutation/`)
- Test effectiveness validation using Stryker
- Mutation score > 50% for T2 projects
- Automated mutant generation and killing

#### Accessibility Tests (`tests/axe/`)
- WCAG 2.1 AA compliance validation
- Automated accessibility scanning
- Manual accessibility review checklists

### Coverage Requirements

Based on CAWS risk tiers:

| Test Type | T1 (Critical) | T2 (Standard) | T3 (Low Risk) |
|-----------|---------------|----------------|---------------|
| Unit | ≥90% | ≥80% | ≥70% |
| Integration | Required | Required | Optional |
| Contract | Required | Required | Optional |
| E2E | Required | Optional | Optional |
| Mutation | ≥70% | ≥50% | ≥30% |

## CI/CD Integration

### GitHub Actions Example

```yaml
name: CAWS Quality Gates

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  quality-gates:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup CAWS
        run: npm install -g @caws/cli

      - name: CAWS Analysis
        run: caws cicd analyze

      - name: Run Quality Gates
        run: caws validate

      - name: Agent Evaluation
        run: caws agent evaluate .caws/working-spec.yaml
```

### CI/CD Optimization

The test project demonstrates CAWS CI/CD optimization:

```bash
# Analyze project for optimizations
caws cicd analyze

# Generate optimized GitHub Actions
caws cicd generate github --output .github/workflows/caws-gates.yml

# Smart test selection
caws cicd test-selection --from-commit HEAD~1
```

## Agent Integration

### Agent Testing Scenarios

The test project includes scenarios for testing agent integrations:

#### Scenario 1: Quality-Guided Development
```javascript
// Agent follows CAWS quality guidance
const guidance = await caws.getIterativeGuidance('Planning phase');
implementSteps(guidance.next_steps);
const evaluation = await caws.evaluateQuality();
assert(evaluation.quality_score >= 0.75);
```

#### Scenario 2: Waiver Management
```javascript
// Agent handles exceptional circumstances
const evaluation = await caws.evaluateQuality();
if (!evaluation.success && needsWaiver) {
  const waiver = await caws.createWaiver({
    reason: 'emergency_hotfix',
    gates: ['coverage_threshold'],
    justification: 'Critical security fix'
  });
}
```

#### Scenario 3: Workflow Orchestration
```javascript
// Agent follows structured workflows
const workflow = await caws.getWorkflowGuidance('tdd', 2);
console.log(workflow.guidance);
console.log('Next steps:', workflow.next_steps);
```

## Development Usage

### Running Tests

```bash
# All tests
npm test

# Specific test categories
npm run test:unit
npm run test:integration
npm run test:contract
npm run test:e2e:smoke
npm run test:mutation
npm run test:axe

# With coverage
npm run test:coverage
```

### CAWS Validation

```bash
# Validate working spec
npm run caws:validate

# Full quality gates
caws validate

# Agent evaluation
caws agent evaluate .caws/working-spec.yaml
```

### Tool Development

```bash
# Test tool development
node apps/tools/caws/my-tool.js

# Validate tool
caws tools run my-tool

# List all tools
caws tools list
```

## Documentation

### Tool Documentation

Each tool includes comprehensive documentation:

- **Purpose**: What the tool validates or analyzes
- **Configuration**: Setup and configuration options
- **Output Format**: Structured results and error handling
- **Integration**: How to integrate with CI/CD pipelines
- **Troubleshooting**: Common issues and solutions

### Test Documentation

Test suites include detailed documentation:

- **Test Strategy**: Approach and coverage goals
- **Test Data**: Sample data and edge cases
- **Mocking Strategy**: Dependency isolation approaches
- **Performance**: Expected execution times and resource usage

## Contributing

### Test Case Development

1. **Identify Gap**: Find missing test coverage or scenarios
2. **Write Specification**: Document test requirements
3. **Implement Tests**: Add test cases with proper assertions
4. **Validate Coverage**: Ensure coverage requirements met
5. **Update Documentation**: Document new test patterns

### Tool Development

1. **Define Purpose**: Clear tool objective and scope
2. **Implement Interface**: Follow CAWS tool interface
3. **Add Validation**: Comprehensive input and output validation
4. **Write Tests**: Tool functionality testing
5. **Document Usage**: Clear usage examples and configuration

### Quality Gate Updates

1. **Assess Impact**: Evaluate changes on existing projects
2. **Update Thresholds**: Adjust based on project maturity
3. **Test Integration**: Validate with CI/CD pipelines
4. **Update Documentation**: Reflect new requirements

## Relationship to CAWS Ecosystem

The test project serves as the validation and reference implementation:

- **CAWS CLI**: Tests CLI commands and integrations
- **CAWS Template**: Validates tool ecosystem and configurations
- **CAWS MCP Server**: Tests agent integration protocols
- **CAWS VS Code Extension**: Validates IDE integration
- **Agent Platforms**: Provides test scenarios for agent workflows

## Troubleshooting

### Test Failures

**Coverage below threshold**
```bash
# Check coverage report
npm run test:coverage

# Identify uncovered lines
# Add missing test cases
```

**Mutation score low**
```bash
# Run mutation testing
npm run test:mutation

# Review surviving mutants
# Improve test assertions
```

**Integration test failures**
```bash
# Check service dependencies
# Verify test data setup
# Review error logs
```

### Tool Issues

**Tool not loading**
```bash
# Check tool file permissions
chmod +x apps/tools/caws/tool-name.js

# Validate tool metadata
caws tools run tool-name --validate
```

**Tool execution errors**
```bash
# Check tool logs
tail -f .caws/logs/tool-name.log

# Verify tool dependencies
npm ls tool-dependency
```

### CI/CD Issues

**Pipeline optimization not working**
```bash
# Check CAWS CLI version
caws --version

# Validate working spec
caws validate .caws/working-spec.yaml

# Test optimization analysis
caws cicd analyze
```

## Performance Benchmarks

### Test Execution Times

- **Unit Tests**: < 30 seconds
- **Integration Tests**: < 2 minutes
- **Contract Tests**: < 1 minute
- **E2E Tests**: < 5 minutes
- **Mutation Tests**: < 10 minutes
- **Accessibility Tests**: < 2 minutes

### Quality Gate Performance

- **Linting**: < 10 seconds
- **Type Checking**: < 20 seconds
- **Security Scanning**: < 30 seconds
- **Coverage Analysis**: < 15 seconds
- **Full Quality Gates**: < 2 minutes

## License

MIT License - see main project LICENSE file.

## Links

- **Main Project**: https://github.com/paths-design/caws
- **Documentation**: https://docs.caws.dev/test-project
- **Issues**: https://github.com/paths-design/caws/issues
- **CI/CD Status**: https://github.com/paths-design/caws/actions