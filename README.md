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
```bash
# Initialize a new CAWS project
npm run init my-new-project

# Scaffold an existing project
npm run scaffold

# Run the CLI directly
npm run cli -- init my-project
```

## Monorepo Structure

This is a Turborepo-managed monorepo with the following packages:

```
packages/
├── caws-cli/           # CLI tool for scaffolding projects
├── caws-template/      # Project template with tools and configurations
└── caws-test-project/  # Example project using CAWS
```

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

#### CAWS CLI (`@caws/cli`)
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
- **Purpose**: Scaffolds new projects and adds CAWS components to existing projects
- **Features**:
  - Interactive project setup with validation
  - Schema-based configuration validation
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

The system enforces multiple quality gates:

1. **Naming Guard**: Prevents shadow file patterns (copy, enhanced, v2, etc.)
2. **Scope Guard**: Ensures changes stay within declared scope
3. **Budget Guard**: Enforces file/line-of-code limits
4. **Schema Validation**: Validates working specifications
5. **Security Scanning**: Detects secrets and validates tool allowlists
6. **Trust Scoring**: Automated quality assessment

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
- Accessibility and performance compliance
- Observability and rollback readiness
- Mode and scope discipline
- Supply chain attestations

**Target**: ≥82/100 for production readiness

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
GitHub Actions workflow includes:
- Scope and budget validation
- Static analysis and security scanning
- Unit and integration testing
- Performance and accessibility checks
- Provenance and attestation generation

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

Copyright (c) 2025 @darianrosebrook

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
git clone https://github.com/your-username/caws.git
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

## Changelog

### v1.0.0 (Current)
- ✅ **Initial Release**: Complete CAWS framework implementation
- ✅ **Turborepo Setup**: Monorepo structure with optimized build pipeline
- ✅ **Core Components**: CLI, template, and test project packages
- ✅ **Quality Gates**: Comprehensive validation and enforcement system
- ✅ **Provenance Tracking**: Full audit trail and attestation support
- ✅ **Security Framework**: Tool allowlisting and secret detection
- ✅ **Testing Infrastructure**: Jest, ESLint, Prettier, TypeScript setup
- ✅ **Documentation**: Comprehensive guides and examples

### Planned Features
- **v1.1.0**: Enhanced IDE integrations and plugins
- **v1.2.0**: Multi-language support (Python, Go, Rust)
- **v1.3.0**: Advanced analytics and reporting dashboard
- **v2.0.0**: Distributed agent coordination and collaboration

## Roadmap

### Phase 1: Foundation (✅ Complete)
- [x] Core CAWS framework implementation
- [x] Turborepo monorepo setup
- [x] Quality gates and validation system
- [x] Provenance and attestation infrastructure
- [x] Comprehensive testing framework
- [x] Documentation and examples

### Phase 2: Ecosystem (🚧 In Progress)
- [ ] IDE integrations (VS Code, IntelliJ, etc.)
- [ ] Multi-language support
- [ ] Plugin system for custom tools
- [ ] Enhanced CI/CD integrations
- [ ] Performance monitoring and analytics

### Phase 3: Scale & Collaboration (📋 Planned)
- [ ] Distributed agent coordination
- [ ] Advanced collaboration features
- [ ] Enterprise security and compliance
- [ ] Cloud-native deployment options
- [ ] Advanced analytics and insights

### Phase 4: Intelligence (🔮 Future)
- [ ] AI-powered code analysis
- [ ] Automated quality improvements
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

**Author**: @darianrosebrook
**Version**: 1.0.0
**License**: MIT
**Built with**: Turborepo + CAWS v1.0