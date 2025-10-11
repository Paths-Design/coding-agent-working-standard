# CAWS - Coding Agent Workflow System

**Engineering-grade operating system for AI-assisted development**

CAWS is a comprehensive framework that transforms how AI agents and human developers collaborate on software projects. It enforces quality, reliability, and maintainability through automated validation, provenance tracking, and contract-first development.

## 🎯 What CAWS Is For

CAWS is designed for organizations and teams that want:

- **Predictable AI Agent Behavior**: Standardized workflows that agents follow reliably
- **Quality Assurance**: Automated gates prevent bugs and ensure maintainability
- **Explainable Development**: Full provenance tracking shows what happened and why
- **Contract-First APIs**: API contracts defined before implementation
- **Risk-Based Rigor**: Different quality requirements based on project risk

## 🚀 Quick Start

### Prerequisites

- Node.js >= 18.0.0
- npm >= 10.0.0
- Git (for provenance tracking)

### Installation

```bash
# Install globally for CLI usage
npm install -g @paths.design/caws-cli

# Verify installation
caws --version
```

### Your First CAWS Project

```bash
# Initialize a new project with CAWS
caws init my-project

# Navigate to project
cd my-project

# Create your working specification
vim .caws/working-spec.yaml

# Validate the specification
caws validate

# Start development following CAWS workflow
```

## 📋 How CAWS Works

### The CAWS Development Workflow

1. **📝 Plan**: Create a validated working specification (`.caws/working-spec.yaml`)
2. **🔗 Contract**: Define API contracts (OpenAPI, TypeScript interfaces)
3. **🧪 Test**: Write tests first (TDD approach)
4. **💻 Implement**: Code against contracts and tests
5. **✅ Verify**: Run quality gates and validation
6. **📊 Document**: Track provenance and update docs

### Risk-Based Quality Tiers

| Tier      | Use Case                    | Coverage | Mutation | Contracts | Review   |
| --------- | --------------------------- | -------- | -------- | --------- | -------- |
| 🔴 **T1** | Auth, billing, migrations   | 90%+     | 70%+     | Required  | Manual   |
| 🟡 **T2** | Features, APIs, data writes | 80%+     | 50%+     | Required  | Optional |
| 🟢 **T3** | UI, internal tools          | 70%+     | 30%+     | Optional  | Optional |

### Key Components

- **Working Specifications**: YAML files defining project scope, requirements, and contracts
- **Quality Gates**: Automated validation of tests, coverage, linting, and security
- **Provenance Tracking**: Complete audit trail of all changes and AI assistance
- **Contract Validation**: API contracts tested before and during implementation
- **MCP Server**: Model Context Protocol server for AI agent integration

## 🛠️ CLI Commands

### Project Management

```bash
caws init [project-name]          # Initialize new CAWS project
caws scaffold                     # Add CAWS to existing project
caws validate                     # Validate working specification
caws status                       # Show project health and status
```

### Development Workflow

```bash
caws iterate                      # Get iterative development guidance
caws evaluate                     # Evaluate current implementation
caws progress update              # Update acceptance criteria progress
```

### Quality & Testing

```bash
caws diagnose                     # Run health checks and diagnostics
caws test-analysis assess-budget  # Predict test budget needs
```

### Provenance & Compliance

```bash
caws provenance init              # Initialize provenance tracking
caws provenance show              # Display provenance dashboard
caws provenance analyze-ai        # Analyze AI effectiveness
caws hooks install                # Install automatic git hooks
```

### Quality Gates

```bash
caws waivers create               # Create quality gate waivers
caws waivers list                 # List active waivers
caws workflow guidance            # Get workflow-specific guidance
```

## 📚 Documentation & Examples

### 📖 Comprehensive Guides

- **[Agent Workflow Guide](docs/agents/full-guide.md)** - Complete guide for AI agents
- **[Agent Integration Guide](docs/guides/agent-integration-guide.md)** - Technical integration details
- **[Agent Workflow Extensions](docs/guides/agent-workflow-extensions.md)** - Advanced agent features

### 🧪 Examples & Templates

- **[Demo Project](packages/caws-cli/demo-project/)** - Complete working example
- **[Template Project](packages/caws-cli/templates/)** - Project scaffolding templates

### 🔍 Quality Assurance

- **[Benchmarking Framework](docs/internal/CAWS_AGENT_BENCHMARKING_FRAMEWORK.md)** - Agent effectiveness testing
- **[Specification Audit](docs/internal/SPEC_ALIGNMENT_AUDIT.md)** - Current implementation status
- **[Validation Summary](docs/internal/SPEC_VALIDATION_SUMMARY.md)** - Compliance verification

## 🏗️ Architecture Overview

### Core Components

#### 1. **Working Specifications** (`.caws/working-spec.yaml`)

YAML files defining:

- Project scope and boundaries
- Acceptance criteria
- API contracts references
- Risk tier and quality requirements
- Performance budgets and SLAs

#### 2. **Quality Gates**

Automated validation including:

- **Test Coverage**: Branch and statement coverage requirements
- **Mutation Testing**: Test suite strength validation
- **Contract Testing**: API contract compliance
- **Static Analysis**: Linting, type checking, security scanning

#### 3. **Provenance Tracking**

Complete audit trail with:

- AI vs human contribution tracking
- Commit-to-spec linkage
- Quality metrics over time
- Automated git hooks

#### 4. **MCP Server** (`packages/caws-mcp-server/`)

Model Context Protocol server providing:

- Standardized tool interface for AI agents
- Real-time validation and guidance
- Workflow state management

#### 5. **Contract-First Development**

API contracts defined before implementation:

- OpenAPI specifications
- TypeScript interface definitions
- JSON Schema validation
- Automated contract testing

### Data Flow

```
Working Spec → Contract Generation → Test Writing → Implementation → Quality Gates → Provenance Tracking
     ↓              ↓                      ↓             ↓              ↓              ↓
   Validate      Generate Types          TDD         Code Against     Automated       Audit Trail
   Schema        From Contracts         Approach     Contracts       Validation       & Analytics
```

## 🤖 For AI Agents

### Your Development Contract

When working on a CAWS project, you must:

1. **Always validate first**: Run `caws validate` before starting work
2. **Follow the risk tier**: Meet coverage, mutation, and contract requirements
3. **Create contracts first**: Define APIs before implementation
4. **Write tests first**: TDD approach with comprehensive edge cases
5. **Track provenance**: All changes are attributable and auditable
6. **Stay in scope**: Respect `scope.in` and `scope.out` boundaries

### Agent Success Metrics

- **Independence**: Can work autonomously without constant human intervention
- **Quality Compliance**: Meets all tier requirements on first attempt
- **Contract Adherence**: APIs match specifications exactly
- **Test Coverage**: Comprehensive test suites that catch mutations
- **Documentation**: Clear, accurate documentation updates

See the **[Agent Workflow Guide](docs/agents/full-guide.md)** for detailed instructions.

## 📦 Packages

### Core Packages

| Package                   | Description                                 | Status                  |
| ------------------------- | ------------------------------------------- | ----------------------- |
| **caws-cli**              | Command-line interface for CAWS operations  | ✅ Stable (v3.4.0)      |
| **caws-mcp-server**       | Model Context Protocol server for AI agents | ✅ Stable (v1.0.0)      |
| **caws-vscode-extension** | VS Code extension with CAWS integration     | 🧪 Pre-release (v0.9.0) |

### Development Packages

| Package                | Description                          | Status    |
| ---------------------- | ------------------------------------ | --------- |
| **caws-test-project**  | Reference implementation and testing | ✅ Stable |
| **caws-cli/templates** | Project templates and scaffolding    | ✅ Stable |

## 🔧 Development

### Building

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

### Monorepo Structure

```
caws/
├── packages/
│   ├── caws-cli/                 # Main CLI tool
│   │   ├── src/                  # CLI source code
│   │   ├── templates/            # Project templates
│   │   └── demo-project/         # Working example
│   ├── caws-mcp-server/          # MCP server
│   │   ├── src/                  # Server source
│   │   └── index.js              # Entry point
│   └── caws-vscode-extension/     # VS Code extension
├── docs/                         # Documentation
│   ├── agents/                   # Agent guides
│   ├── guides/                   # Integration guides
│   └── internal/                 # Internal docs
└── scripts/                      # Build and utility scripts
```

## 🤝 Contributing

We welcome contributions! See our [Contributing Guide](CONTRIBUTING.md) for details.

### Development Workflow

1. **Fork** the repository
2. **Create** a feature branch
3. **Implement** your changes following CAWS principles
4. **Test** thoroughly (we use CAWS ourselves!)
5. **Submit** a pull request

### Code Quality

This project uses CAWS for its own development. All contributions must:

- Pass CAWS validation (`caws validate`)
- Meet Tier 1 quality standards (90% coverage, 70% mutation)
- Include comprehensive contract definitions
- Follow the established patterns and conventions

## 📄 License

**MIT License** - see [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **Model Context Protocol** for the standardized agent interface
- **OpenAPI Initiative** for API contract standards
- **Jest** and **Stryker** communities for testing frameworks
- **VS Code** team for the extension platform

---

## 📞 Support & Community

- **📖 Documentation**: [Full Agent Guide](docs/agents/full-guide.md)
- **🐛 Issues**: [GitHub Issues](https://github.com/Paths-Design/coding-agent-working-standard/issues)
- **💬 Discussions**: [GitHub Discussions](https://github.com/Paths-Design/coding-agent-working-standard/discussions)
- **📧 Email**: hello@paths.design

---

**CAWS v3.1.0** - Making AI-human collaboration reliable, explainable, and high-quality.
