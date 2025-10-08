# CAWS CLI API Reference

## Overview

The CAWS CLI (`@paths.design/caws-cli`) is the primary interface for interacting with the Coding Agent Workflow System. It provides commands for project initialization, scaffolding, and management.

## Installation

```bash
# Install globally (recommended)
npm install -g @caws/cli

# Or run directly from the monorepo
cd packages/caws-cli
npm run build
npm run start -- init my-project
```

## Commands

### `caws init <project-name>` (alias: `i`)

Initialize a new project with CAWS scaffolding.

#### Description

Creates a complete CAWS project structure with working specifications, quality gates, and development tooling.

#### Arguments

- `<project-name>`: Name of the new project (required)

#### Options

- `-i, --interactive`: Run interactive setup (default: true)
- `-g, --git`: Initialize git repository (default: true)
- `-n, --non-interactive`: Skip interactive prompts
- `--no-git`: Don't initialize git repository

#### Examples

```bash
# Interactive setup (recommended)
caws init user-auth-service

# Non-interactive with defaults
caws init api-gateway --non-interactive

# Skip git initialization
caws init legacy-refactor --no-git

# Custom project name with spaces
caws init "My Awesome Project" --no-git
```

#### Interactive Prompts

When run interactively, you'll be guided through:

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

### `caws scaffold` (alias: `s`)

Add CAWS components to an existing project.

#### Description

Adds missing CAWS components to an existing project without affecting existing code.

#### Options

- `-f, --force`: Overwrite existing files

#### Examples

```bash
# Add CAWS components to current project
caws scaffold

# Force overwrite existing files
caws scaffold --force
```

#### What Gets Added

- `.caws/` directory with working spec and schemas
- `apps/tools/caws/` with validation and quality gate tools
- `codemod/` directory for AST transformations
- `.github/workflows/caws.yml` CI/CD pipeline
- Configuration files and documentation

### `caws version` (alias: `v`)

Show version and system information.

#### Description

Displays version information and system status.

#### Examples

```bash
caws --version
caws version
```

#### Output

```
CAWS CLI v1.0.0
Coding Agent Workflow System - Scaffolding Tool
Author: @darianrosebrook
License: MIT
Node.js: v20.0.0
Platform: darwin (macOS)
```

## Configuration

### Working Specification Schema

Projects include a comprehensive `.caws/working-spec.yaml`:

#### Required Fields

- `id`: Project identifier (e.g., FEAT-1234)
- `title`: Descriptive project name
- `risk_tier`: 1 (critical), 2 (standard), 3 (low risk)
- `mode`: feature, refactor, fix, doc, chore
- `change_budget`: File and line-of-code limits
- `scope`: What's in/out of scope
- `invariants`: System invariants that must be maintained
- `acceptance`: Acceptance criteria in Given-When-Then format
- `non_functional`: Performance, security, accessibility requirements
- `contracts`: API specifications

#### Optional Fields

- `threats`: Potential risks and threats
- `blast_radius`: Affected modules and data migration requirements
- `operational_rollback_slo`: Rollback service level objective
- `observability`: Logging, metrics, and tracing configuration
- `migrations`: Migration steps
- `rollback`: Rollback plan

### Example Working Specification

```yaml
id: FEAT-1234
title: 'User Authentication Service'
risk_tier: 2
mode: feature
change_budget:
  max_files: 25
  max_loc: 1000
blast_radius:
  modules: ['auth', 'api', 'database']
  data_migration: true
operational_rollback_slo: '5m'
scope:
  in: ['user authentication', 'api endpoints']
  out: ['legacy authentication', 'deprecated endpoints']
invariants:
  - 'System remains available during deployment'
  - 'Data consistency maintained'
acceptance:
  - id: 'A1'
    given: 'User provides valid credentials'
    when: 'Accessing protected endpoint'
    then: 'Access is granted'
  - id: 'A2'
    given: 'User provides invalid credentials'
    when: 'Attempting authentication'
    then: 'Access is denied'
non_functional:
  a11y: ['keyboard navigation', 'screen reader support']
  perf: { api_p95_ms: 250 }
  security: ['input validation', 'rate limiting']
contracts:
  - type: 'openapi'
    path: 'apps/contracts/api.yaml'
observability:
  logs: ['auth.success', 'auth.failure']
  metrics: ['auth_attempts_total', 'auth_success_total']
  traces: ['auth_flow']
migrations:
  - 'Create user_auth table'
  - 'Migrate existing users'
  - 'Validate data integrity'
rollback:
  - 'Feature flag kill-switch'
  - 'Database rollback script'
```

## Error Handling

### Common Errors

#### Project Directory Exists

```bash
❌ Directory my-project already exists
💡 Choose a different name or remove the existing directory
```

**Solution**: Choose a different project name or remove the existing directory.

#### Invalid Project ID Format

```bash
❌ Project ID should be in format: PREFIX-NUMBER (e.g., FEAT-1234)
```

**Solution**: Use format like `FEAT-1234`, `AUTH-456`, etc.

#### Template Directory Not Found

```bash
❌ Template directory not found
💡 Make sure you're running the CLI from the correct directory
```

**Solution**: Ensure you're in the correct directory or reinstall the CLI.

#### Git Not Available

```bash
⚠️  Git not found. Skipping git initialization.
💡 Install git to enable automatic repository setup.
```

**Solution**: Install Git or initialize the repository manually later.

### Troubleshooting

#### Clean Reinstallation

```bash
# Remove existing installation
npm uninstall -g @caws/cli

# Clean npm cache
npm cache clean --force

# Reinstall
npm install -g @caws/cli
```

#### Manual Project Setup

If the CLI fails, you can set up a CAWS project manually:

1. Copy the template structure
2. Update `.caws/working-spec.yaml` with your requirements
3. Run `caws validate` to check the specification
4. Set up your CI/CD pipeline
5. Configure your development tools

## Exit Codes

- `0`: Success
- `1`: Error (invalid arguments, validation failure, etc.)
- `2`: Project directory already exists
- `3`: Template not found
- `4`: Git initialization failed

## Environment Variables

### CAWS Configuration

- `CAWS_DEBUG`: Enable debug logging (default: false)
- `CAWS_NO_COLOR`: Disable colored output (default: false)
- `CAWS_CONFIG_PATH`: Custom configuration file path
- `CAWS_TEMPLATE_PATH`: Custom template directory path

### Git Configuration

- `GIT_AUTHOR_NAME`: Git author name for commits (overrides working-spec.yaml)
- `GIT_AUTHOR_EMAIL`: Git author email for commits (overrides working-spec.yaml)
- `GIT_COMMITTER_NAME`: Git committer name
- `GIT_COMMITTER_EMAIL`: Git committer email

### Working Spec Git Configuration

Projects can specify git author information in `.caws/working-spec.yaml`:

```yaml
git_config:
  author_name: 'CAWS Agent'
  author_email: 'agent@your-project.com'
```

This is automatically configured during `caws init` or can be set manually.

## Integration

### CI/CD Integration

The CLI generates GitHub Actions workflows that can be adapted for other CI/CD platforms:

```yaml
# Example GitLab CI integration
caws-init-job:
  stage: setup
  script:
    - npx @caws/cli init $CI_PROJECT_NAME --non-interactive
  only:
    - main
```

### IDE Integration

The CLI works with all major IDEs and editors:

- VS Code: Add to workspace scripts
- IntelliJ: Configure as external tool
- Vim/Neovim: Add to shell configuration

## Performance

### Benchmarks

- **Project Creation**: ~30 seconds for complete setup
- **Validation**: ~5 seconds for working spec validation
- **Scaffolding**: ~10 seconds for existing project integration

### Optimization Tips

- Use `--non-interactive` for automated environments
- Cache node_modules for faster builds
- Use turbo for parallel package processing
- Enable build caching in CI/CD

## Security

### Secure Usage

- Never run untrusted CAWS specifications
- Validate all inputs in production environments
- Use `--non-interactive` mode for automated pipelines
- Review generated files before committing

### Audit Trail

All CLI operations create provenance manifests for complete auditability.

## Support

### Getting Help

```bash
# Show help for all commands
caws --help

# Show help for specific command
caws init --help
caws scaffold --help
```

### Reporting Issues

- **Bugs**: Use GitHub issues with reproduction steps
- **Features**: Discuss in GitHub discussions first
- **Documentation**: Report documentation issues via GitHub issues

### Community

- **Discussions**: GitHub discussions for questions and ideas
- **Contributing**: See CONTRIBUTING.md for contribution guidelines
- **Security**: See SECURITY.md for vulnerability reporting
