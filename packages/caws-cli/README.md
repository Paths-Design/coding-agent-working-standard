# CAWS CLI

**Command Line Interface for CAWS (Coding Agent Workflow System)**

The CAWS CLI is the primary interface for developers and agents to interact with CAWS quality assurance and workflow management capabilities. It provides comprehensive project scaffolding, validation, and management tools.

## Overview

The CAWS CLI serves as the central control point for:

- **Project Initialization**: Scaffold new projects with CAWS quality gates
- **Quality Validation**: Run comprehensive validation against working specifications
- **Agent Integration**: Programmatic APIs for AI agents to evaluate and guide development
- **Waiver Management**: Fast-lane escape hatches with full audit trails
- **Quality Gates**: v2 pipeline with configurable gate modules
- **Session Management**: Track and manage agent work sessions

## Installation

### Global Installation (Recommended)

```bash
npm install -g @paths.design/caws-cli
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

### Quality Gates

```bash
# Run quality gates v2 pipeline
caws gates run

# Run legacy quality gates
caws quality-gates
```

### Worktree Management

```bash
# Create an isolated worktree for parallel agent work
caws worktree create <name>

# List active worktrees
caws worktree list

# Merge a completed worktree back to base
caws worktree merge <name>

# Destroy a worktree
caws worktree destroy <name>

# Bind a spec to a worktree (fixes authoritative scope mode)
caws worktree bind <spec-id>

# Repair registry inconsistencies
caws worktree repair
```

### Scope Management

```bash
# Inspect effective scope boundaries, mode, and binding health
caws scope show
```

### Session Management

```bash
# Start a tracked session
caws session start

# Create a session checkpoint
caws session checkpoint

# End a session
caws session end

# List past sessions
caws session list
```

### Spec Management

```bash
# List all specs (project + feature)
caws specs list

# Create a feature spec
caws specs create FEAT-001 --type feature --title "description"

# Show a spec
caws specs show FEAT-001

# Check for scope conflicts between specs
caws specs conflicts
```

### Tool Management

```bash
# Run the CAWS tool interface
caws tool
```

## Architecture

The CLI is built with a modular architecture:

```
caws-cli/
├── src/
│   ├── index.js           # Main CLI entry point
│   ├── waivers-manager.js # Waiver system implementation
│   ├── quality-gates/     # v2 gate modules
│   └── tool-loader.js     # Dynamic tool loading system
├── templates/             # Project templates
└── dist/                  # Compiled output
```

### Key Components

- **Command Parser**: Commander.js-based CLI with subcommands
- **Tool System**: Dynamic loading of quality gate tools
- **Waiver Manager**: Fast-lane escape hatch management
- **Quality Gates v2**: Modular gate pipeline with configurable modules
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
        ┌─────────────────┐
        │ caws-mcp-server │
        │ (Agent Bridge)  │
        └─────────────────┘
```

- **caws-template**: Provides the tools and configurations that CLI manages
- **caws-mcp-server**: Exposes CLI functionality to AI agents via MCP protocol

### Quality Gates Integration

The v2 quality gates pipeline (`caws gates run`) executes modular gate checks:

1. **Spec Validation**: Validates working specifications against schema (mode, blast_radius, rollback SLO)
2. **Security Scanning**: Runs security checks and secret detection
3. **Scope Enforcement**: Verifies changes stay within spec-defined boundaries
4. **Test & Coverage**: Runs tests and validates coverage thresholds per risk tier
5. **Performance Checks**: Validates performance budgets and metrics

Gates can be configured per-spec with `mode` (block/warn/skip) and custom `thresholds` in policy.yaml.

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
title: 'Feature implementation'
risk_tier: 2
mode: feature
change_budget:
  max_files: 25
  max_loc: 1000
acceptance:
  - id: 'A1'
    given: 'Current state'
    when: 'Feature implemented'
    then: 'Expected behavior'
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
      version: '1.0.0',
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
npm install -g @paths.design/caws-cli
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

- **Main Project**: https://github.com/Paths-Design/coding-agent-working-standard
- **Documentation**: https://docs.paths.design
- **Issues**: https://github.com/Paths-Design/coding-agent-working-standard/issues
- **Discussions**: https://github.com/Paths-Design/coding-agent-working-standard/discussions
