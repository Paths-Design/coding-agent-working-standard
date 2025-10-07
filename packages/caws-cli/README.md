# CAWS CLI

**Command Line Interface for CAWS (Coding Agent Workflow System)**

The CAWS CLI is the primary interface for developers and agents to interact with CAWS quality assurance and workflow management capabilities. It provides comprehensive project scaffolding, validation, and management tools.

## Overview

The CAWS CLI serves as the central control point for:

- **Project Initialization**: Scaffold new projects with CAWS quality gates
- **Quality Validation**: Run comprehensive validation against working specifications
- **Agent Integration**: Programmatic APIs for AI agents to evaluate and guide development
- **Waiver Management**: Fast-lane escape hatches with full audit trails
- **CI/CD Optimization**: Pipeline generation and optimization tools
- **Experimental Features**: Dry-run capabilities for cutting-edge functionality

## Installation

### Global Installation (Recommended)

```bash
npm install -g @caws/cli
```

### Local Development

```bash
# Clone the CAWS monorepo
git clone https://github.com/paths-design/caws.git
cd caws

# Install dependencies
npm install

# Build all packages
npm run build

# Use locally
node packages/caws-cli/dist/index.js --help
```

## Core Commands

### Project Management

```bash
# Initialize a new CAWS project
caws init my-project

# Add CAWS to existing project
caws scaffold

# Validate working specification
caws validate

# Get help
caws --help
```

### Agent Integration

```bash
# Evaluate work quality (JSON output for agents)
caws agent evaluate .caws/working-spec.yaml

# Get iterative development guidance
caws agent iterate --current-state "Started implementation" .caws/working-spec.yaml
```

### Waiver Management

```bash
# Create a waiver for exceptional circumstances
caws waivers create \
  --title "Emergency security fix" \
  --reason emergency_hotfix \
  --gates coverage_threshold \
  --expires-at "2025-11-01T00:00:00Z" \
  --approved-by "security-team"

# List active waivers
caws waivers list

# Revoke a waiver
caws waivers revoke WV-0001
```

### CI/CD Optimization

```bash
# Analyze project for CI/CD optimizations
caws cicd analyze

# Generate optimized GitHub Actions workflow
caws cicd generate github --output .github/workflows/caws-gates.yml

# Smart test selection based on changes
caws cicd test-selection --from-commit HEAD~1
```

### Experimental Features

```bash
# Dry-run validation without side effects
caws experimental --dry-run validate .caws/working-spec.yaml

# Experimental quality gates
caws experimental quality-gates .caws/working-spec.yaml --parallel-execution
```

### Tool Management

```bash
# List available CAWS tools
caws tools list

# Execute specific tool
caws tools run validate

# Manage tool configurations
caws tools --help
```

## Architecture

The CLI is built with a modular architecture:

```
caws-cli/
├── src/
│   ├── index.js           # Main CLI entry point
│   ├── waivers-manager.js # Waiver system implementation
│   ├── cicd-optimizer.js  # CI/CD optimization logic
│   └── tool-loader.js     # Dynamic tool loading system
├── templates/             # Project templates
└── dist/                  # Compiled output
```

### Key Components

- **Command Parser**: Commander.js-based CLI with subcommands
- **Tool System**: Dynamic loading of quality gate tools
- **Waiver Manager**: Fast-lane escape hatch management
- **CI/CD Optimizer**: Pipeline analysis and generation
- **Agent Interface**: JSON APIs for programmatic agent integration

## Integration with CAWS Ecosystem

### Relationship to Other Packages

```
┌─────────────────┐    ┌──────────────────┐
│   caws-cli      │────│  caws-template   │
│   (Commands)    │    │  (Tools & Config)│
└─────────────────┘    └──────────────────┘
        │                       │
        └───────────────────────┘
                │
        ┌─────────────────┐    ┌──────────────────┐
        │ caws-mcp-server │────│ caws-vscode-ext  │
        │ (Agent Bridge)  │    │   (IDE Integration)
        └─────────────────┘    └──────────────────┘
```

- **caws-template**: Provides the tools and configurations that CLI manages
- **caws-mcp-server**: Exposes CLI functionality to AI agents via MCP protocol
- **caws-vscode-extension**: Provides IDE integration using CLI capabilities

### Quality Gates Integration

The CLI automatically executes quality gates defined in the template:

1. **Spec Validation**: Validates working specifications against schema
2. **Security Scanning**: Runs security checks and secret detection
3. **Code Quality**: Executes linting, type checking, and formatting
4. **Test Execution**: Runs unit, integration, and contract tests
5. **Performance Checks**: Validates performance budgets and metrics

### Agent Workflow Integration

The CLI provides structured APIs for agents:

```javascript
// Agent can evaluate work quality
const result = await runCommand('caws agent evaluate spec.yaml');
// Returns: { success: true, evaluation: { quality_score: 0.85, ... } }

// Agent can get guidance for next steps
const guidance = await runCommand('caws agent iterate --current-state "..." spec.yaml');
// Returns: { guidance: "...", next_steps: [...], confidence: 0.8 }
```

## Configuration

### Working Specifications

Projects use `.caws/working-spec.yaml` files:

```yaml
id: PROJ-001
title: "Feature implementation"
risk_tier: 2
mode: feature
change_budget:
  max_files: 25
  max_loc: 1000
acceptance:
  - id: "A1"
    given: "Current state"
    when: "Feature implemented"
    then: "Expected behavior"
```

### Tool Configuration

Tools are configured in `apps/tools/caws/` directory with metadata:

```javascript
// Tool metadata
{
  id: 'validate',
  name: 'Working Spec Validator',
  capabilities: ['validation', 'quality-gates'],
  version: '1.0.0'
}
```

## Development

### Building

```bash
cd packages/caws-cli
npm run build    # Compile TypeScript
npm run dev      # Development with watch
npm run lint     # Run ESLint
npm run test     # Run tests
```

### Adding New Commands

1. Add command implementation in `src/index.js`
2. Update help text and option parsing
3. Add integration tests
4. Update documentation

### Tool Development

Tools follow a standardized interface:

```javascript
class MyTool extends BaseTool {
  getMetadata() {
    return {
      id: 'my-tool',
      name: 'My Custom Tool',
      capabilities: ['validation'],
      version: '1.0.0'
    };
  }

  async executeImpl(parameters, context) {
    // Tool logic here
    return { success: true, output: result };
  }
}
```

## Testing

### Test Categories

- **Unit Tests**: Individual command and component testing
- **Integration Tests**: End-to-end command workflows
- **Contract Tests**: API compatibility testing
- **Quality Gate Tests**: Tool execution and validation

### Running Tests

```bash
npm run test              # All tests
npm run test:unit         # Unit tests only
npm run test:integration  # Integration tests
npm run test:contract     # Contract tests
```

## Security

### Tool Validation

- All tools are validated against allowlists
- Security scanning prevents malicious tool execution
- Sandboxed execution environment
- Audit trails for all tool usage

### Waiver Security

- Waivers require explicit approval and justification
- Time-limited validity prevents permanent bypasses
- Audit logs track all waiver usage
- High-risk waivers trigger review processes

## Troubleshooting

### Common Issues

**Command not found**
```bash
# Ensure global installation
npm install -g @caws/cli
caws --version

# Or use local installation
node packages/caws-cli/dist/index.js --help
```

**Tool loading errors**
```bash
# Check tool directory structure
ls -la apps/tools/caws/

# Validate tool metadata
caws tools list

# Check tool permissions
chmod +x apps/tools/caws/*.js
```

**Validation failures**
```bash
# Check working spec syntax
caws validate --suggestions .caws/working-spec.yaml

# Auto-fix common issues
caws validate --auto-fix .caws/working-spec.yaml
```

## Contributing

### Code Standards

- Use async/await for asynchronous operations
- Provide comprehensive error handling
- Include detailed help text for all commands
- Write tests for new functionality
- Update documentation for API changes

### Pull Request Process

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Update documentation
6. Submit pull request with working spec

## License

MIT License - see main project LICENSE file.

## Links

- **Main Project**: https://github.com/paths-design/caws
- **Documentation**: https://docs.caws.dev
- **Issues**: https://github.com/paths-design/caws/issues
- **Discussions**: https://github.com/paths-design/caws/discussions