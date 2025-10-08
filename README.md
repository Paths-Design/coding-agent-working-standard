# CAWS - Coding Agent Workflow System

An engineering-grade operating system for coding agents that enforces quality, reliability, and maintainability through automated validation, provenance tracking, and comprehensive tooling.

## Quick Start

### Prerequisites

- Node.js >= 18.0.0
- npm >= 10.0.0

### Setup

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Run tests
npm run test

# Lint all packages
npm run lint
```

### CLI Usage

#### Option 1: Global Installation (Recommended)

```bash

# Install globally for CLI usage
npm install -g @paths.design/caws-cli

# Initialize a new CAWS project
caws init my-new-project

# Scaffold an existing project
caws scaffold

# Validate working specification (runs quality gates automatically)
caws validate

# Agent-oriented commands for programmatic evaluation
caws agent evaluate .caws/working-spec.yaml    # Evaluate work quality (JSON output)
caws agent iterate .caws/working-spec.yaml      # Get iterative development guidance

# Waivers system for exceptional circumstances
caws waivers create --title "Emergency fix" --gates coverage_threshold  # Create waiver
caws waivers list                          # List active waivers
caws waivers revoke WV-0001                # Revoke waiver
caws waivers stats                         # Waiver statistics

# Experimental features with dry-run support
caws experimental --dry-run validate .caws/working-spec.yaml  # Dry run validation
caws experimental quality-gates .caws/working-spec.yaml       # Experimental quality gates

# CI/CD optimization and generation
caws cicd analyze                           # Analyze project for optimizations
caws cicd generate github                   # Generate optimized GitHub Actions
caws cicd test-selection --from-commit HEAD~1  # Smart test selection

# Statistical test analysis and learning
caws test-analysis assess-budget             # Predict budget needs from historical data
caws test-analysis analyze-patterns          # Analyze waiver patterns and trends
caws test-analysis find-similar              # Find similar historical projects

# Provenance tracking and audit trails
caws provenance update --commit <hash>       # Update provenance after commit
caws provenance show                         # Display provenance chain with AI tracking
caws provenance verify                        # Verify provenance integrity
caws provenance analyze-ai                    # Analyze AI effectiveness patterns

# Manage CAWS tools
caws tools list                    # List available tools
caws tools run validate           # Execute specific tool
```

#### Option 2: Local Development (Monorepo)

```bash
# Build and run CLI directly (development)
node packages/caws-cli/dist/index.js --help

# Initialize a new CAWS project
node packages/caws-cli/dist/index.js init my-new-project

# Scaffold CAWS components
node packages/caws-cli/dist/index.js scaffold

# Validate working specification (runs quality gates automatically)
node packages/caws-cli/dist/index.js validate

# Statistical test analysis and learning
node packages/caws-cli/dist/index.js test-analysis assess-budget     # Predict budget needs
node packages/caws-cli/dist/index.js test-analysis analyze-patterns  # Analyze waiver patterns
node packages/caws-cli/dist/index.js test-analysis find-similar      # Find similar projects

# Provenance tracking and audit trails
node packages/caws-cli/dist/index.js provenance update --commit <hash>  # Update provenance
node packages/caws-cli/dist/index.js provenance show                   # Show provenance chain
node packages/caws-cli/dist/index.js provenance verify                 # Verify integrity
node packages/caws-cli/dist/index.js provenance analyze-ai             # Analyze AI patterns

# Manage CAWS tools
node packages/caws-cli/dist/index.js tools list        # List available tools
node packages/caws-cli/dist/index.js tools run validate # Execute specific tool
```

#### Option 3: npm Scripts (Project Context)

```bash
# From the project root (when working in this monorepo)
node apps/tools/caws/start.js        # Start a new change
npm run caws:validate                # Validate working spec (with tools)
npm run caws:verify                  # Run full quality gates
node apps/tools/caws/attest.js > .agent/attestation.json  # Generate attestations

# Dynamic tool management
npm run caws tools list              # List all available tools
npm run caws tools run validate      # Execute specific tool
```

**Note**: For scripts that need arguments, use direct node execution rather than npm run.

## Monorepo Structure

This is a Turborepo-managed monorepo with the following packages:

```
packages/
├── caws-cli/           # CLI tool for scaffolding projects
├── caws-template/      # Project template with tools and configurations
├── caws-test-project/  # Example project using CAWS
├── caws-mcp-server/    # Model Context Protocol server for agent integration
└── caws-vscode-extension/ # VS Code extension with real-time CAWS integration
```

## Agent Integration

CAWS provides specialized commands for agents to use as quality bars during iterative development:

### Agent Commands

```bash
# Evaluate work against CAWS quality standards (JSON output for parsing)
caws agent evaluate .caws/working-spec.yaml

# Get iterative development guidance based on current progress
caws agent iterate --current-state '{"description": "Started implementation"}' .caws/working-spec.yaml

# Validate spec readiness without running quality gates
caws agent evaluate --feedback-only .caws/working-spec.yaml
```

### Agent Workflow Integration

Agents can integrate CAWS into their development loops:

```javascript
// Example agent integration
async function developWithCaws(specPath) {
  let currentState = 'Initial implementation';

  while (true) {
    // Evaluate current progress
    const result = await runCommand(`caws agent evaluate ${specPath}`);

    if (result.success && result.evaluation.overall_status === 'quality_passed') {
      console.log('✅ Implementation complete!');
      break;
    }

    // Get guidance for next iteration
    const guidance = await runCommand(
      `caws agent iterate --current-state '{"description": "${currentState}"}' ${specPath}`
    );

    // Execute recommended next steps
    await implementSteps(guidance.iteration.next_steps);

    currentState = `Completed: ${guidance.iteration.next_steps.join(', ')}`;
  }
}
```

### Quality Standards

CAWS enforces risk-tiered quality standards:

- **Tier 1** (High Risk): 90% coverage, 70% mutation, contracts required
- **Tier 2** (Medium Risk): 80% coverage, 50% mutation, contracts required
- **Tier 3** (Low Risk): 70% coverage, 30% mutation, contracts optional

Agents receive structured feedback on failing criteria with actionable improvement suggestions.

See [`docs/agent-integration-guide.md`](docs/agent-integration-guide.md) for comprehensive agent integration documentation.

## Waivers System

CAWS provides a waivers system for exceptional circumstances where quality gates need to be temporarily bypassed. Waivers are fully auditable and flagged for review.

### Waiver Creation

```bash
caws waivers create \
  --title "Emergency security fix" \
  --reason emergency_hotfix \
  --description "Critical vulnerability fix requiring immediate deployment" \
  --gates coverage_threshold,contract_compliance \
  --expires-at "2025-11-01T00:00:00Z" \
  --approved-by "security-team" \
  --impact-level critical \
  --mitigation-plan "Manual security testing completed, automated tests temporarily waived"
```

### Waiver Management

```bash
# List active waivers
caws waivers list

# Revoke a waiver
caws waivers revoke WV-0001 --reason "Issue resolved"

# Extend waiver expiration
caws waivers extend WV-0001 --new-expiry "2025-12-01T00:00:00Z" --approved-by "security-team"

# Waiver statistics
caws waivers stats
```

### Waiver Features

- **Risk Assessment**: Required impact level and mitigation plan
- **Expiration**: Automatic cleanup of expired waivers
- **Audit Trail**: Complete logging of waiver lifecycle
- **Review Flagging**: High-risk waivers create review files for code owners
- **Context Awareness**: Environment-specific waiver application

## Experimental Mode

CAWS experimental mode provides access to cutting-edge features with built-in safety measures.

### Dry Run Support

```bash
# Dry run validation without side effects
caws experimental --dry-run validate .caws/working-spec.yaml --enhanced-analysis

# Dry run quality gates
caws experimental --dry-run quality-gates .caws/working-spec.yaml --parallel-execution
```

### Experimental Features

- **Enhanced Analysis**: Advanced spec validation with AI assistance
- **Predictive Scoring**: ML-based quality predictions
- **Parallel Execution**: Experimental parallel quality gate processing
- **Smart Selection**: AI-powered test selection algorithms

## CI/CD Optimization

CAWS provides intelligent CI/CD pipeline optimization based on project risk tier and characteristics.

### Pipeline Analysis

```bash
# Analyze project for optimization opportunities
caws cicd analyze

# Example output:
# 📊 Project Tier: 2
# ⏱️  Estimated Savings: 64% faster builds
# 💰 Monthly Time Savings: 8 hours
```

### Configuration Generation

```bash
# Generate optimized GitHub Actions workflow
caws cicd generate github --output .github/workflows/caws-gates.yml

# Generate GitLab CI configuration
caws cicd generate gitlab --output .gitlab-ci.yml

# Generate Jenkins pipeline
caws cicd generate jenkins --output Jenkinsfile
```

### Smart Test Selection

```bash
# Analyze changed files for targeted testing
caws cicd test-selection --changed-files "src/api.js,tests/unit/auth.test.js"

# Analyze git changes since commit
caws cicd test-selection --from-commit HEAD~1
```

### Optimization Features

- **Tier-Based Execution**: Different rigor levels for T1/T2/T3 projects
- **Parallel Processing**: Independent quality gates run simultaneously
- **Smart Caching**: Framework-aware dependency and build caching
- **Conditional Logic**: Skip unnecessary checks based on project characteristics
- **Time Estimation**: Predict build times and optimization savings

## Agent Integration & Hooks

CAWS provides comprehensive integration with AI coding agents across multiple platforms:

### Integration Options

- **Cursor IDE**: Real-time quality gates via native hooks
- **VS Code**: Extension with live monitoring and dashboards
- **Windsurf/Cascade**: Structured workflows for guided development
- **MCP Protocol**: Standardized tool access for any MCP-compatible agent
- **GitHub Copilot**: Preview SDK extensions for seamless tool integration

### Getting Started

```bash
# Initialize project with agent integrations
caws init my-project --interactive --enable-all-integrations

# Use agent commands for quality-aware development
caws agent evaluate .caws/working-spec.yaml     # Quality assessment
caws agent iterate --current-state "Planning"   # Development guidance
caws waivers create --title "Hotfix"            # Exception handling
```

### Platform-Specific Setup

| Platform       | Setup Command         | Features                          |
| -------------- | --------------------- | --------------------------------- |
| **Cursor**     | `caws scaffold`       | Real-time hooks, instant feedback |
| **VS Code**    | Extension install     | Live dashboard, code actions      |
| **Windsurf**   | `caws init --cascade` | Guided workflows, team sharing    |
| **MCP Server** | `npm run mcp:start`   | Tool protocol, cross-platform     |

See [`docs/guides/hooks-and-agent-workflows.md`](docs/guides/hooks-and-agent-workflows.md) for comprehensive integration guide.

## Development

### Available Scripts

```bash
# Build all packages
npm run build

# Development mode with watch
npm run dev

# Lint all packages
npm run lint

# Fix linting issues
npm run lint:fix

# Format code
npm run format

# Run all tests
npm run test

# Run tests in watch mode
npm run test:watch

# Validate CAWS configurations
npm run validate

# Clean build artifacts
npm run clean
```

### Package-Specific Scripts

#### CAWS CLI (`@paths.design/caws-cli`)

```bash
cd packages/caws-cli
npm run build        # Build TypeScript
npm run dev          # Development with watch
npm run test         # Run tests
npm run lint         # Lint code
npm run format       # Format code
npm run start        # Run CLI
```

#### CAWS Template (`@caws/template`)

```bash
cd packages/caws-template
npm run build        # Build tools
npm run validate     # Validate working spec
npm run test         # Run tests
npm run lint         # Lint tools
npm run format       # Format code
```

### Adding New Packages

1. Create a new directory in `packages/`
2. Add package.json with name prefixed with `@caws/`
3. Add the package to turbo.json dependencies if needed
4. Add any shared configurations (TypeScript, ESLint, etc.)

## Architecture

### Core Components

#### CAWS CLI

- **Purpose**: Scaffolds new projects and provides dynamic tool execution and validation
- **Features**:
  - Interactive project setup with validation
  - Dynamic tool discovery and loading
  - Automated quality gate execution
  - Schema-based configuration validation
  - Tool security validation and allowlisting
  - Git repository initialization
  - Provenance tracking and attestation
  - Error handling and recovery

#### CAWS Template

- **Purpose**: Provides the complete CAWS project structure and tools
- **Features**:
  - Working specification schemas
  - Quality gate enforcement tools
  - Provenance and attestation utilities
  - Security scanning and compliance
  - CI/CD pipeline configurations

### Quality Gates

The system enforces multiple quality gates through dynamic tool execution:

1. **Naming Guard**: Prevents shadow file patterns (copy, enhanced, v2, etc.)
2. **Scope Guard**: Ensures changes stay within declared scope
3. **Budget Guard**: Enforces file/line-of-code limits
4. **Schema Validation**: Validates working specifications
5. **Security Scanning**: Detects secrets and validates tool allowlists
6. **Tool Validation**: Dynamic loading and security validation of tools
7. **Quality Gate Tools**: Automated execution of validation, security, and testing tools
8. **Trust Scoring**: Automated quality assessment with configurable thresholds

### Dynamic Tool System

CAWS provides a plugin-based architecture for extensible quality gates and development tools:

#### Tool Discovery & Loading

- **Automatic Discovery**: CLI automatically finds tools in `apps/tools/caws/` directory
- **Dynamic Loading**: Tools are loaded securely with validation and error handling
- **Security Validation**: All tools validated against allowlists and security scans
- **Caching**: Loaded tools cached for performance with invalidation support

#### Tool Categories

- **Validation Tools**: Schema validation, configuration checking
- **Security Tools**: Secret scanning, vulnerability assessment
- **Quality Gate Tools**: Automated testing, coverage analysis
- **Code Generation Tools**: Scaffolding, documentation generation
- **Analysis Tools**: Performance monitoring, dependency checking

#### Tool Interface

All CAWS tools implement a standardized interface:

```javascript
class MyTool extends BaseTool {
  getMetadata() {
    return {
      id: 'my-tool',
      name: 'My Custom Tool',
      version: '1.0.0',
      capabilities: ['validation'],
      author: 'Your Name',
    };
  }

  async executeImpl(parameters, context) {
    // Tool implementation
    return { success: true, output: result };
  }
}
```

### Risk Tiering

Projects are classified into risk tiers with appropriate rigor levels:

- **Tier 1** (Critical): auth/billing/migrations - Maximum rigor
- **Tier 2** (Standard): features/APIs - Standard rigor
- **Tier 3** (Low Risk): UI/tooling - Basic rigor

## Security & Compliance

### Provenance Tracking

- Complete audit trail of all operations
- SBOM (Software Bill of Materials) generation
- SLSA (Supply chain Levels for Software Artifacts) attestations
- Cryptographic signatures for integrity

### Tool Allowlisting

- Restricted set of approved tools for agents
- Security scanning of prompts and outputs
- Secret detection and prevention

### Supply Chain Security

- Dependency vulnerability scanning
- Automated security analysis (SAST)
- Containerized builds with provenance

## Testing Strategy

### Test Categories

- **Unit Tests**: Individual functions and components
- **Integration Tests**: Component interactions
- **E2E Tests**: Complete user workflows
- **Contract Tests**: API specifications
- **Mutation Tests**: Test effectiveness validation
- **Accessibility Tests**: WCAG compliance

### Coverage Requirements

- **Tier 1**: ≥90% branch coverage, ≥70% mutation score
- **Tier 2**: ≥80% branch coverage, ≥50% mutation score
- **Tier 3**: ≥70% branch coverage, ≥30% mutation score

## Trust Score

CAWS calculates a trust score (0-100) based on:

- Test coverage and mutation adequacy
- Contract compliance and versioning
- Tool validation and security compliance
- Dynamic quality gate execution results
- Accessibility and performance compliance
- Observability and rollback readiness
- Mode and scope discipline
- Supply chain attestations

**Target**: ≥82/100 for production readiness

### Tool Validation Scoring

- **Security Validation**: 20 points - Tools must pass security scans
- **Interface Compliance**: 10 points - Tools must implement required methods
- **Execution Success**: 15 points - Tools must execute without errors
- **Metadata Completeness**: 5 points - Tools must provide complete metadata

## Contributing

### Development Workflow

1. Create a feature branch
2. Make changes with comprehensive tests
3. Ensure all quality gates pass
4. Update documentation
5. Create pull request with working spec

### Code Standards

- Use TypeScript for new code
- Follow ESLint and Prettier configurations
- Write comprehensive tests with property-based testing
- Update provenance manifests for changes
- Document all public APIs

### Pull Request Requirements

- Working specification with scope and acceptance criteria
- All tests passing with required coverage
- Quality gates satisfied
- Security scan clean
- Provenance manifest included

## Requirements

### System Requirements

- **Node.js**: >= 18.0.0
- **npm**: >= 10.0.0
- **Git**: For version control and provenance tracking
- **CI/CD**: GitHub Actions (or adapt for other platforms)

### Development Tools

- **Turbo**: Build system and task orchestration
- **TypeScript**: Type safety and compilation
- **Jest**: Testing framework
- **ESLint**: Code quality and consistency
- **Prettier**: Code formatting

## Examples

### New Feature Project

```bash
# Initialize a new feature project
npm run init user-auth-service

# The CLI will guide you through:
# - Project metadata and scope
# - Risk tier and mode classification
# - Change budget constraints
# - API contracts and specifications
# - Non-functional requirements
# - Observability and rollback strategies
```

### Refactoring Existing Codebase

```bash
# Initialize a refactoring project
npm run init legacy-refactor --mode=refactor

# Add CAWS components to existing project
npm run scaffold
```

### Documentation Project

```bash
# Initialize documentation project
npm run init api-docs --mode=doc
```

## Configuration

### Working Specification Schema

Projects include a comprehensive `.caws/working-spec.yaml` with:

- Project metadata and scope
- Risk tier and mode classification
- Change budget constraints
- Acceptance criteria and invariants
- Non-functional requirements
- Observability configuration
- Migration and rollback strategies

### CI/CD Pipeline

GitHub Actions workflows include:

- **Automated Testing**: Comprehensive test suite execution
- **Quality Gates**: Scope and budget validation with semantic versioning
- **Static Analysis**: Security scanning and code quality checks
- **Performance Testing**: Accessibility and performance validation
- **Automated Publishing**: Semantic versioning with OIDC authentication
- **Provenance Generation**: SBOM and attestation creation

## Automated Publishing

### Semantic Versioning

This project uses [Conventional Commits](https://conventionalcommits.org/) for automated versioning:

- `feat:` → Minor release (1.0.0 → 1.1.0)
- `fix:` → Patch release (1.0.0 → 1.0.1)
- `BREAKING CHANGE:` → Major release (1.0.0 → 2.0.0)

### Release Process

1. **Commit Analysis**: Commits analyzed for type and scope
2. **Version Calculation**: Next version determined by commit types
3. **Changelog Generation**: Release notes created from commit messages
4. **Package Publishing**: NPM package published with OIDC authentication
5. **Git Tagging**: Release tagged and pushed to repository

### Commit Conventions

See [COMMIT_CONVENTIONS.md](COMMIT_CONVENTIONS.md) for detailed guidelines.

### OIDC Setup

For automated publishing with OIDC (OpenID Connect), see [OIDC_SETUP.md](OIDC_SETUP.md).

## Documentation

- **Framework Guide**: Complete system documentation
- **Working Spec Schema**: JSON schema for validation
- **Tier Policy**: Risk tier definitions and thresholds
- **CI/CD Pipeline**: Quality gates workflow
- **Tool Documentation**: Usage guides for all utilities

## Support

### Getting Help

- **📖 Documentation**: Comprehensive guides and examples in this README and package docs
- **🛠️ Tools**: Complete utility suite with built-in help
- **🎯 Examples**: Implementation patterns and sample projects
- **🤝 Community**: Agent conduct rules and best practices
- **🐛 Issues**: Report bugs or request features on GitHub

### Support Channels

- **GitHub Issues**: Bug reports, feature requests, and technical questions
- **Documentation**: Inline help with `caws --help` and tool-specific guides
- **Examples**: Review sample projects and documentation files
- **Community Guidelines**: Follow agent conduct rules for collaboration

### Troubleshooting

If you encounter issues:

1. **Check Prerequisites**: Ensure Node.js >= 18.0.0 and npm >= 10.0.0
2. **Clean Install**: `npm run clean && npm install`
3. **Validate Setup**: `npm run validate` to check configurations
4. **Check Logs**: Review build and test output for error details
5. **Example Projects**: Reference working examples for setup patterns

## License

MIT License

Copyright (c) 2025 Paths Design

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Collaboration

### Contributing Guidelines

We welcome contributions from the community! Here's how to get involved:

#### Development Setup

```bash
# Fork the repository
git clone https://github.com/your-organization/caws.git
cd caws

# Install dependencies
npm install

# Set up development environment
npm run dev
```

#### Contribution Process

1. **Create Issue**: Open a GitHub issue for bugs, features, or questions
2. **Fork Repository**: Create your own fork of the project
3. **Create Branch**: Use descriptive branch names (e.g., `feat/cli-improvements`)
4. **Make Changes**: Follow coding standards and add tests
5. **Test Thoroughly**: Ensure all tests pass and quality gates are satisfied
6. **Update Documentation**: Add or update relevant documentation
7. **Create Pull Request**: Submit PR with detailed description

#### Code Standards

- **TypeScript First**: Use TypeScript for new code and APIs
- **Testing**: Write comprehensive tests with property-based testing where applicable
- **Documentation**: Update JSDoc comments and README sections
- **Quality Gates**: Ensure all automated checks pass
- **Provenance**: Update provenance manifests for significant changes

### Agent Conduct Rules

When collaborating with CAWS agents, follow these guidelines:

1. **Scope Adherence**: Stay within declared scope boundaries
2. **Determinism**: Ensure reproducible results with injected dependencies
3. **Testing**: Write comprehensive tests for all changes
4. **Documentation**: Update documentation for new features
5. **Provenance**: Maintain complete audit trails
6. **Security**: Respect tool allowlists and security constraints

### Community Standards

- **Respectful Communication**: Maintain professional and constructive discussions
- **Inclusive Environment**: Welcome diverse perspectives and experiences
- **Knowledge Sharing**: Share learnings and help others succeed
- **Quality Focus**: Prioritize reliability, security, and maintainability
- **Continuous Improvement**: Embrace feedback and iterative enhancement

## API Reference

### CAWS CLI

#### `caws init <project-name>` (alias: `i`)

Initialize a new project with CAWS scaffolding.

**Options:**

- `-i, --interactive`: Run interactive setup (default: true)
- `-g, --git`: Initialize git repository (default: true)
- `-n, --non-interactive`: Skip interactive prompts
- `--no-git`: Don't initialize git repository

#### `caws scaffold` (alias: `s`)

Add CAWS components to an existing project.

**Options:**

- `-f, --force`: Overwrite existing files

#### `caws version` (alias: `v`)

Show version and system information.

#### `caws tools` - Tool Management

Manage CAWS tools and plugins.

**Commands:**

- `caws tools list` (alias: `ls`): List all available tools
  - `-v, --verbose`: Show detailed tool information
- `caws tools run <tool-id>`: Execute a specific tool
  - `-p, --params <json>`: JSON parameters for tool execution
  - `-t, --timeout <ms>`: Execution timeout in milliseconds (default: 30000)

### CAWS Tools

#### Validation Tool

```bash
node packages/caws-template/apps/tools/caws/validate.js <spec-file>
```

Validates working specifications against JSON schema.

#### Quality Gates

```bash
node packages/caws-template/apps/tools/caws/gates.js <gate-type> <tier> <value>
```

Enforces quality thresholds based on risk tier.

#### Provenance Generator

```bash
node packages/caws-template/apps/tools/caws/provenance.js generate [options]
node packages/caws-template/apps/tools/caws/provenance.js sbom [project-path]
node packages/caws-template/apps/tools/caws/provenance.js slsa [provenance-path]
```

Generates provenance manifests and attestations.

#### Prompt Linter

```bash
node packages/caws-template/apps/tools/caws/prompt-lint.js <prompt-files> [options]
```

Validates prompts for security and compliance.

#### Attestation Generator

```bash
node packages/caws-template/apps/tools/caws/attest.js <type> [options]
```

Generates SBOM and SLSA attestations.

### Developing CAWS Tools

#### Tool Development Quick Start

```bash
# Create a new tool
cat > apps/tools/caws/my-tool.js << 'EOF'
const { BaseTool } = require('../../../src/tool-interface');

class MyTool extends BaseTool {
  getMetadata() {
    return {
      id: 'my-tool',
      name: 'My Custom Tool',
      version: '1.0.0',
      description: 'A custom CAWS tool',
      capabilities: ['validation'],
      author: 'Your Name'
    };
  }

  async executeImpl(parameters, context) {
    // Your tool logic here
    return {
      success: true,
      output: { message: 'Tool executed successfully' }
    };
  }
}

module.exports = MyTool;
EOF

# Test the tool
node packages/caws-cli/dist/index.js tools run my-tool
```

#### Tool Categories and Capabilities

- `validation`: Tools that validate code/configuration
- `security`: Security scanning and vulnerability assessment
- `quality-gates`: Automated quality checks and testing
- `code-generation`: Code scaffolding and documentation
- `analysis`: Performance monitoring and dependency analysis

#### Tool Security Requirements

- Tools must be validated against the `tools-allow.json` allowlist
- No direct filesystem access outside working directory
- No execution of arbitrary commands
- No network access except for approved endpoints
- Source code scanned for security vulnerabilities

## Changelog

### v1.1.0 (Current)

- ✅ **Dynamic Tool System**: Plugin-based architecture for extensible tools
- ✅ **Tool Discovery & Loading**: Automatic discovery and secure loading of tools
- ✅ **Quality Gate Integration**: Tools automatically executed during validation
- ✅ **Tool Management CLI**: `caws tools` commands for tool management
- ✅ **Security Validation**: Comprehensive tool validation and allowlisting
- ✅ **Tool Interface**: Standardized interface for tool development
- ✅ **Enhanced CLI**: Tool-aware validation with automated quality gates
- ✅ **Waivers System**: Fast-lane escape hatches with full audit trails
- ✅ **Experimental Mode**: Dry-run capabilities for cutting-edge features
- ✅ **Agent Integration**: Programmatic evaluation and iterative guidance
- ✅ **CI/CD Optimization**: Tier-based conditional execution and pipeline generation
- ✅ **MCP Server**: Model Context Protocol server for AI agent integration
- ✅ **VS Code Extension**: Real-time IDE integration with quality monitoring
- ✅ **Workflow Extensions**: Extended agent feedback loops and guided development
- ✅ **Unified Hooks Strategy**: Consolidated hooks and agent workflow documentation

### v1.0.0 (Previous)

- ✅ **Initial Release**: Complete CAWS framework implementation
- ✅ **Turborepo Setup**: Monorepo structure with optimized build pipeline
- ✅ **Core Components**: CLI, template, and test project packages
- ✅ **Quality Gates**: Comprehensive validation and enforcement system
- ✅ **Provenance Tracking**: Full audit trail and attestation support
- ✅ **Security Framework**: Tool allowlisting and secret detection
- ✅ **Testing Infrastructure**: Jest, ESLint, Prettier, TypeScript setup
- ✅ **Documentation**: Comprehensive guides and examples

### Planned Features

- **v1.2.0**: Enhanced IDE integrations and plugins
- **v1.3.0**: Multi-language support (Python, Go, Rust)
- **v1.4.0**: Advanced analytics and reporting dashboard
- **v2.0.0**: Distributed agent coordination and collaboration

## Roadmap

### Foundation (✅ Complete - v1.0.0)

- [x] Core CAWS framework implementation
- [x] Turborepo monorepo setup
- [x] Quality gates and validation system
- [x] Provenance and attestation infrastructure
- [x] Comprehensive testing framework
- [x] Documentation and examples

### Dynamic Tool System (✅ Complete - v1.1.0)

- [x] Plugin-based tool architecture with dynamic loading
- [x] Tool discovery and secure validation system
- [x] Quality gate integration with automated execution
- [x] Tool management CLI commands (`caws tools`)
- [x] Security validation and allowlist enforcement
- [x] Standardized tool interface and base classes
- [x] Enhanced CLI with tool-aware validation

### Strategic Enhancements (✅ Complete - v1.1.0)

- [x] Fast-lane escape hatches (waivers system with audit trails)
- [x] Experimental mode with dry-run capabilities
- [x] AI self-assessment and confidence tracking (agent integration)
- [x] CI/CD optimization with tier-based conditional execution
- [x] Enhanced trust score calculation with risk assessment
- [ ] Test meaningfulness analysis beyond coverage metrics
- [ ] Human override mechanisms
- [ ] Multi-language support (JS/TS, Python, Java, Go, Rust)
- [ ] Legacy integration and assessment tools
- [ ] Real-time dashboard and observability

### IDE Integration & Developer Tools (🚧 In Progress - v1.2.0)

- [ ] VS Code extension with inline CAWS validation
- [ ] IntelliJ IDEA plugin
- [ ] Real-time spec validation in editor
- [ ] Interactive trust score visualization
- [ ] AI confidence indicators in IDE

### Enterprise & Collaboration (📋 Planned - v1.3.0)

- [ ] Advanced analytics and reporting dashboard
- [ ] Enterprise security and compliance features
- [ ] LDAP/SSO integration
- [ ] Role-based access control
- [ ] Cloud-native deployment options
- [ ] Audit logging and compliance reporting

### Agent Intelligence & Autonomy (🔮 Future - v2.0.0)

- [ ] Distributed agent coordination
- [ ] Multi-agent workflow orchestration
- [ ] AI-powered code analysis and improvements
- [ ] Predictive risk assessment
- [ ] Self-healing capabilities
- [ ] Autonomous agent workflows

## FAQ

### What is CAWS?

CAWS (Coding Agent Workflow System) is an engineering-grade operating system for coding agents that enforces quality, reliability, and maintainability through automated validation, provenance tracking, and comprehensive tooling.

### Why use CAWS?

CAWS provides:

- **Quality Assurance**: Automated validation and testing
- **Transparency**: Complete provenance and audit trails
- **Security**: Tool allowlisting and secret detection
- **Reliability**: Risk-tiered development with appropriate rigor
- **Collaboration**: Standardized workflows and documentation

### How does CAWS compare to other tools?

Unlike simple linting or testing tools, CAWS provides:

- **Comprehensive Framework**: End-to-end workflow management
- **Risk-Based Approach**: Tiered quality requirements
- **Provenance Tracking**: Complete audit trails
- **Security First**: Built-in security validation
- **Agent Ready**: Designed for AI coding agents

### Can I use CAWS with existing projects?

Yes! Use `npm run scaffold` to add CAWS components to existing projects. The system is designed to integrate with existing codebases while enforcing quality standards.

### What programming languages does CAWS support?

Currently optimized for Node.js/TypeScript projects, but the framework is designed to be extensible to other languages. Multi-language support is planned for future versions.

### How do I contribute to CAWS?

Follow the Contributing Guidelines above:

1. Open an issue for discussion
2. Fork the repository
3. Create a feature branch
4. Make changes with tests
5. Submit a pull request

### Is CAWS open source?

Yes! CAWS is released under the MIT License and welcomes community contributions.

### Where can I get help?

- **Documentation**: This comprehensive README
- **Issues**: GitHub issues for bugs and questions
- **Examples**: Sample projects and documentation
- **Community**: Follow agent conduct rules for collaboration

---

**Organization**: Paths Design
**Version**: 1.1.0
**License**: MIT
**Built with**: Turborepo + CAWS v1.1.0
