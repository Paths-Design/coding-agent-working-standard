# CAWS CLI

A command-line tool for scaffolding and initializing projects with the **Coding Agent Workflow System (CAWS)**.

## Installation

```bash
# Install globally from the caws-cli directory
cd caws-cli
npm install -g .

# Or run directly
node src/index.js
```

## Usage

### Initialize New Project
```bash
# Interactive setup (recommended)
caws init my-new-project

# Non-interactive with defaults
caws init my-new-project --non-interactive

# Skip git initialization
caws init my-new-project --no-git
```

### Scaffold Existing Project
```bash
# Add CAWS components to existing project
caws scaffold

# Force overwrite existing files
caws scaffold --force
```

### Version Information
```bash
caws --version
caws version
```

## Commands

### `caws init <project-name>` (alias: `i`)
Initialize a new project with CAWS scaffolding.

**Options:**
- `-i, --interactive`: Run interactive setup (default: true)
- `-g, --git`: Initialize git repository (default: true)
- `-n, --non-interactive`: Skip interactive prompts

### `caws scaffold` (alias: `s`)
Add CAWS components to an existing project.

**Options:**
- `-f, --force`: Overwrite existing files

### `caws version` (alias: `v`)
Show version and system information.

## Interactive Setup

When running `caws init` interactively, you'll be prompted for:

1. **Project ID**: Ticket system identifier (e.g., FEAT-1234)
2. **Project Title**: Descriptive name
3. **Risk Tier**: 1 (critical), 2 (standard), 3 (low risk)
4. **Mode**: feature, refactor, fix, doc, or chore
5. **Change Budget**: File and line-of-code limits
6. **Scope**: What's in/out of scope for the project
7. **Requirements**: Functional and non-functional requirements
8. **Contracts**: API specifications and paths
9. **Observability**: Logging, metrics, and tracing setup
10. **Migration Plan**: Database and deployment strategy

## Project Structure

The CLI creates a complete CAWS project structure:

```
project-name/
├── .caws/                          # CAWS configuration
│   ├── policy/tier-policy.json     # Risk tier definitions
│   ├── schemas/                    # JSON schemas
│   ├── templates/                  # PR templates
│   └── working-spec.yaml          # Project specification
├── .agent/                         # Provenance artifacts
├── apps/tools/caws/                # CAWS utilities
├── codemod/                        # AST transformation scripts
├── docs/                           # Documentation
├── tests/                          # Test directories
├── .github/workflows/caws.yml      # CI/CD pipeline
├── agents.md                       # CAWS framework guide
└── README.md                       # Project documentation
```

## Features

- 🚀 **Quick Start**: Complete project scaffolding in minutes
- 🔧 **Interactive Setup**: Guided configuration process with validation
- 📋 **Template Generation**: Working specifications and PR templates
- 🛠️ **Tool Integration**: Pre-configured development tools with quality gates
- 📦 **Provenance Ready**: SBOM and attestation setup with trust scoring
- 🔒 **Quality Gates**: Pre-configured CI/CD pipelines with automated validation
- ✅ **Schema Validation**: JSON Schema validation of working specifications
- 🧪 **Developer Tools**: Linting, testing, and formatting setup
- 🔍 **Security Scanning**: Prompt linting and secret detection
- 📊 **Trust Scoring**: Automated quality assessment and scoring

## Configuration

### Working Specification
The CLI generates a comprehensive `.caws/working-spec.yaml` that includes:
- Project metadata and scope
- Risk tier and mode classification
- Change budget constraints
- Acceptance criteria and invariants
- Non-functional requirements
- Observability configuration
- Migration and rollback strategies

### CI/CD Pipeline
Includes GitHub Actions workflow with:
- Scope and budget validation
- Static analysis and security scanning
- Unit and integration testing
- Performance and accessibility checks
- Provenance and attestation generation

## Examples

### New Feature Project
```bash
caws init user-auth-service
# Follows interactive prompts for authentication service setup
```

### Refactoring Existing Codebase
```bash
caws init legacy-refactor --non-interactive
# Creates refactor mode specification with appropriate constraints
```

### Documentation Project
```bash
caws init api-docs
# Sets up doc mode with appropriate scope and budget
```

## Requirements

- **Node.js**: >= 16.0.0
- **npm**: For package management
- **Git**: For version control (optional)

## Development

### Running Locally
```bash
cd caws-cli
npm install
npm start init my-test-project
```

### Testing
```bash
npm test          # Run tests with linting
npm run test:watch # Run tests in watch mode
```

### Linting & Formatting
```bash
npm run lint      # Run ESLint
npm run lint:fix  # Fix ESLint issues
npm run format    # Format with Prettier
```

### Development Tools
The CLI includes comprehensive development tooling:
- **ESLint**: Code quality and consistency
- **Prettier**: Code formatting
- **Jest**: Unit testing framework
- **Schema Validation**: JSON Schema validation of working specs
- **Quality Gates**: Automated trust scoring and validation

## Architecture

The CLI is built with:
- **Commander.js**: Command-line interface framework
- **Inquirer.js**: Interactive prompt library
- **fs-extra**: Enhanced file system operations
- **js-yaml**: YAML parsing and generation

## Contributing

1. Fork the repository
2. Create feature branch
3. Add tests for new functionality
4. Ensure CLI still works with existing templates
5. Submit pull request

## License

MIT - see LICENSE file for details.

## Support

- 📖 **Documentation**: See inline help with `caws --help`
- 🐛 **Issues**: Report bugs or request features
- 🤝 **Contributing**: See contributing guidelines

---

**Author**: @darianrosebrook
**Version**: 1.0.0
**CAWS**: v1.0
