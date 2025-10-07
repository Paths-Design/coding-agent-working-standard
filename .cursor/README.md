# CAWS Cursor IDE Integration

This directory contains Cursor IDE hooks that provide real-time CAWS quality assurance integration during development.

## Overview

Cursor hooks enable seamless integration between CAWS and the Cursor IDE, providing:

- **Real-time quality validation** as you code
- **Automatic spec validation** when editing working specs
- **Scope enforcement** preventing out-of-scope file access
- **Tool validation** for safe MCP execution
- **Quality monitoring** after file edits

## Hook Configuration

The `hooks.json` file defines when each hook runs:

```json
{
  "beforeShellExecution": ["block-dangerous.sh", "audit.sh"],
  "beforeMCPExecution": ["audit.sh", "caws-tool-validation.sh"],
  "beforeReadFile": ["scan-secrets.sh", "caws-scope-guard.sh"],
  "afterFileEdit": ["format.sh", "naming-check.sh", "validate-spec.sh", "caws-quality-check.sh", "audit.sh"],
  "beforeSubmitPrompt": ["caws-scope-guard.sh", "audit.sh"],
  "stop": ["audit.sh"]
}
```

## Available Hooks

### CAWS-Specific Hooks

#### `caws-quality-check.sh`
- **Trigger**: `afterFileEdit`
- **Purpose**: Runs CAWS quality evaluation after code changes
- **Blocks**: No (provides warnings and suggestions)
- **Fallback**: Graceful degradation if CAWS CLI unavailable

#### `caws-scope-guard.sh`
- **Trigger**: `beforeReadFile`, `beforeSubmitPrompt`
- **Purpose**: Prevents access to files outside CAWS-defined scope
- **Blocks**: Yes (for out-of-scope file access)
- **Requires**: `.caws/working-spec.yaml`

#### `caws-tool-validation.sh`
- **Trigger**: `beforeMCPExecution`
- **Purpose**: Validates CAWS MCP tool calls for security
- **Blocks**: Yes (for dangerous operations or invalid waivers)
- **Validates**: Waiver creation, tool permissions, command safety

### General Security Hooks

#### `block-dangerous.sh`
- **Trigger**: `beforeShellExecution`
- **Purpose**: Prevents execution of dangerous shell commands
- **Blocks**: `rm -rf /`, `sudo`, destructive operations

#### `scan-secrets.sh`
- **Trigger**: `beforeReadFile`
- **Purpose**: Scans for potential secrets before file access
- **Blocks**: Files containing password/token patterns

### Code Quality Hooks

#### `format.sh`
- **Trigger**: `afterFileEdit`
- **Purpose**: Auto-formats code using Prettier/ESLint
- **Blocks**: No (formats in background)

#### `naming-check.sh`
- **Trigger**: `afterFileEdit`
- **Purpose**: Enforces CAWS naming conventions
- **Blocks**: No (provides warnings)

#### `validate-spec.sh`
- **Trigger**: `afterFileEdit`
- **Purpose**: Validates CAWS working specs in real-time
- **Blocks**: No (shows validation errors)

### Audit Hooks

#### `audit.sh`
- **Trigger**: Multiple events
- **Purpose**: Logs all hook executions for debugging
- **Blocks**: No (passive logging)

## Installation

### Automatic Setup

```bash
# CAWS init automatically sets up Cursor hooks
caws init my-project --interactive

# Or manually scaffold hooks
caws scaffold
```

### Manual Setup

1. Copy `.cursor/` directory to your project root
2. Ensure hook scripts are executable: `chmod +x .cursor/hooks/*.sh`
3. Restart Cursor IDE
4. Verify hooks are active in Cursor settings

## Configuration

### Environment Variables

```bash
# Enable debug logging
export CURSOR_HOOKS_DEBUG=1

# CAWS CLI path override
export CAWS_CLI_PATH=/custom/path/to/caws

# Disable specific hooks
export CURSOR_DISABLE_HOOKS=audit.sh,format.sh
```

### Hook Customization

Modify `hooks.json` to customize hook behavior:

```json
{
  "afterFileEdit": [
    {
      "command": "./.cursor/hooks/caws-quality-check.sh",
      "timeout": 5000,
      "background": true
    }
  ]
}
```

## Troubleshooting

### Hooks Not Running

```bash
# Check hook permissions
ls -la .cursor/hooks/

# Verify Cursor hooks are enabled
# Cursor Settings → Hooks → Enable hooks

# Check Cursor logs
# Help → Toggle Developer Tools → Console
```

### CAWS CLI Not Found

```bash
# Install CAWS CLI
npm install -g @caws/cli

# Or use bundled version (VS Code extension)
code --install-extension caws.caws-vscode-extension

# Verify PATH
which caws
```

### False Positives

```bash
# Temporarily disable hooks
export CURSOR_DISABLE_HOOKS=caws-scope-guard.sh

# Or modify hook logic
vim .cursor/hooks/caws-scope-guard.sh
```

### Performance Issues

```bash
# Run hooks in background
# Edit hooks.json to add "background": true

# Increase timeouts
# Edit hooks.json to add "timeout": 10000

# Disable slow hooks
export CURSOR_DISABLE_HOOKS=format.sh,naming-check.sh
```

## Development

### Creating New Hooks

1. **Create script** in `.cursor/hooks/`
2. **Make executable**: `chmod +x .cursor/hooks/your-hook.sh`
3. **Add to configuration** in `hooks.json`
4. **Test manually**: `echo '{}' | ./cursor/hooks/your-hook.sh`

### Hook Script Template

```bash
#!/bin/bash
# CAWS Hook: Description
# @author @darianrosebrook

set -e

# Read Cursor input
INPUT=$(cat)
DATA=$(echo "$INPUT" | jq -r '.data // ""')

# Your hook logic here
if [[ -n "$DATA" ]]; then
  # Process data
  echo '{"userMessage": "Hook executed", "agentMessage": "Details"}'
fi

exit 0
```

### Testing Hooks

```bash
# Test with sample input
echo '{"action": "edit_file", "file_path": "test.js"}' | ./cursor/hooks/caws-quality-check.sh

# Test error conditions
echo '{}' | ./cursor/hooks/caws-scope-guard.sh

# Debug with verbose output
export CURSOR_HOOKS_DEBUG=1
```

## Integration with CAWS Ecosystem

### Relationship to Other Tools

```
Cursor Hooks ←→ CAWS CLI ←→ VS Code Extension
     ↓              ↓              ↓
  Real-time      Command-line    Rich IDE
  Validation     Interface       Integration
```

### Complementary Tools

- **Git Hooks**: `.git/hooks/` for commit/push validation
- **VS Code Extension**: Rich UI for CAWS operations
- **MCP Server**: Agent tool integration
- **CAWS CLI**: Core functionality

### Data Flow

```
File Edit → Cursor Hook → CAWS CLI → Quality Check → User Feedback
                             ↓
                      Audit Log → Provenance Tracking
```

## Security Considerations

### Safe Execution

- Hooks run in isolated processes
- No access to sensitive Cursor data
- Input validation on all hook data
- Timeout protection against hanging hooks

### Privacy Protection

- File contents not sent to external services
- Local CAWS CLI execution only
- No telemetry or data collection
- User-controlled hook execution

## Performance Optimization

### Hook Design Principles

1. **Fast Execution**: < 2 seconds for real-time feedback
2. **Background Processing**: Non-blocking operations
3. **Selective Running**: Only run relevant hooks
4. **Caching**: Avoid redundant operations

### Optimization Strategies

- **Debounced execution** for file edit hooks
- **Incremental validation** for large codebases
- **Parallel processing** for independent checks
- **Result caching** for repeated operations

## Contributing

### Hook Development Guidelines

- **Clear naming**: `caws-*` prefix for CAWS-specific hooks
- **Comprehensive logging**: Debug-friendly output
- **Error handling**: Graceful failure modes
- **Documentation**: Inline comments and README updates
- **Testing**: Manual and automated test coverage

### Pull Request Process

1. **Test locally** in Cursor IDE
2. **Update documentation** in this README
3. **Add configuration examples** if needed
4. **Consider performance impact** on large codebases
5. **Test with different project types** (CAWS/non-CAWS)

## License

MIT License - see main project LICENSE file.
