# Agent Workflow Extensions & Hooks Strategy

> **Complete guide to CAWS agent integration across IDEs, workflows, and development platforms**

## Overview

CAWS provides comprehensive agent integration through multiple extension points, enabling AI coding assistants to leverage CAWS quality assurance capabilities across different platforms and workflows.

## Integration Patterns

### 1. **Cursor IDE Hooks** - Real-time Quality Gates

Cursor hooks provide instant feedback during AI-assisted coding sessions.

#### Hook Types & Timing

| Hook Type | Timing | Purpose | Example Use |
|-----------|--------|---------|-------------|
| **beforeShellExecution** | Pre-command | Block dangerous operations | Prevent `rm -rf /` |
| **beforeReadFile** | Pre-read | Scan for secrets | Block reading `.env` files |
| **afterFileEdit** | Post-save | Auto-format & validate | Run ESLint, check naming |
| **beforeSubmitPrompt** | Pre-prompt | Scope validation | Check file attachments |
| **beforeMCPExecution** | Pre-MCP call | Tool validation | Verify MCP tool safety |

#### Installation

```bash
# Automatic setup with CAWS init
caws init my-project --interactive
# Prompts for Cursor hooks enablement

# Manual setup
caws scaffold  # Adds .cursor/ directory
```

#### Example Hook: Quality Validation

```bash
#!/bin/bash
# .cursor/hooks/validate-spec.sh

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.file_path // ""')

if [[ "$FILE_PATH" == "working-spec.yaml" ]]; then
  # Validate CAWS spec
  if command -v caws &> /dev/null; then
    if ! caws validate "$FILE_PATH" --quiet 2>/dev/null; then
      echo '{
        "userMessage": "⚠️ CAWS spec validation failed. Run: caws validate --suggestions",
        "agentMessage": "The working-spec.yaml has validation errors"
      }'
    fi
  fi
fi
```

### 2. **Cascade Workflows** - Guided Task Sequences

Cascade enables structured development workflows invoked via `/[workflow-name]`.

#### Workflow Structure

```markdown
# /caws-feature-development

## Feature Development with CAWS Quality Gates

**Purpose**: Guide agents through feature development with quality validation

1. **Initialize CAWS Spec**
   - Run: `caws init feature-name --mode=feature --tier=2`
   - Verify: Working spec completeness

2. **Plan Implementation**
   - Get CAWS guidance: `caws agent iterate --current-state "Planning phase"`
   - Define acceptance criteria

3. **Implement Core Functionality**
   - Write code with TDD approach
   - Run frequent validation: `caws agent evaluate`
   - Address failing quality gates immediately

4. **Quality Assurance**
   - Execute full quality gates: `caws validate`
   - Address any waivers needed
   - Ensure all acceptance criteria met

5. **Final Validation**
   - Run comprehensive testing
   - Generate provenance reports
   - Ready for integration
```

#### Workflow Categories

- **`/caws-tdd-workflow`** - Test-driven development cycle
- **`/caws-refactor-workflow`** - Safe refactoring with validation
- **`/caws-feature-workflow`** - Feature development lifecycle
- **`/caws-emergency-fix`** - Emergency fixes with waivers

### 3. **MCP Server Integration** - Tool Exposure for Agents

Model Context Protocol server exposes CAWS tools to AI agents.

#### Available Tools

```javascript
// MCP Tool Registry
const CAWS_TOOLS = [
  {
    name: 'caws_evaluate',
    description: 'Evaluate work against CAWS quality standards',
    inputSchema: {
      type: 'object',
      properties: {
        specFile: { type: 'string', default: '.caws/working-spec.yaml' },
        workingDirectory: { type: 'string' }
      }
    }
  },
  {
    name: 'caws_iterate',
    description: 'Get iterative development guidance',
    inputSchema: {
      type: 'object',
      properties: {
        currentState: { type: 'string', description: 'Current implementation state' }
      }
    }
  },
  {
    name: 'caws_waiver_create',
    description: 'Create a waiver for exceptional circumstances',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        reason: { type: 'string', enum: ['emergency_hotfix', 'legacy_integration', ...] },
        gates: { type: 'array', items: { type: 'string' } },
        expiresAt: { type: 'string' },
        approvedBy: { type: 'string' },
        impactLevel: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        mitigationPlan: { type: 'string' }
      },
      required: ['title', 'reason', 'gates', 'expiresAt', 'approvedBy', 'impactLevel', 'mitigationPlan']
    }
  }
];
```

#### Usage in Agents

```javascript
// Agent using MCP CAWS tools
async function developWithCaws() {
  // Evaluate current progress
  const evaluation = await mcpClient.callTool('caws_evaluate', {
    specFile: '.caws/working-spec.yaml'
  });

  if (evaluation.success && evaluation.quality_score >= 0.75) {
    return "Implementation complete";
  }

  // Get guidance for next steps
  const guidance = await mcpClient.callTool('caws_iterate', {
    currentState: "Implementation in progress"
  });

  // Execute recommended steps
  await implementSteps(guidance.next_steps);

  return "Continuing development";
}
```

### 4. **VS Code Extension** - IDE Integration

Real-time CAWS integration within the development environment.

#### Features

- **Status Bar**: Live quality score display
- **Code Actions**: Context-aware CAWS suggestions
- **Webview Dashboard**: Interactive quality monitoring
- **File Watchers**: Real-time validation feedback
- **Command Palette**: Full CAWS command access

#### Extension Capabilities

```typescript
// VS Code extension registration
export function activate(context: vscode.ExtensionContext) {
  // Quality monitoring
  const qualityMonitor = new CawsQualityMonitor(mcpClient);

  // Status bar with live scores
  const statusBar = new CawsStatusBar();

  // Code action providers
  vscode.languages.registerCodeActionsProvider('*', new CawsCodeActionProvider());

  // File change monitoring
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  watcher.onDidChange(uri => qualityMonitor.onFileChanged(uri));
}
```

### 5. **Preview SDK Integration** - Copilot Extensions

GitHub Copilot extensions using Preview SDK for seamless tool integration.

#### Extension Pattern

```javascript
// Copilot extension using Preview SDK
const cawsTools = {
  evaluate: {
    name: 'CAWS Quality Evaluation',
    handler: async (args) => {
      const result = await runCawsEvaluation(args.specFile);
      return {
        type: 'text',
        text: `Quality Score: ${(result.score * 100).toFixed(1)}%`
      };
    }
  }
};

// Register with Preview SDK
const server = new CopilotExtensionServer();
server.setRequestHandler('tools/call', async (request) => {
  const tool = cawsTools[request.params.name];
  if (tool) {
    return await tool.handler(request.params.arguments);
  }
});
```

### 6. **Git Hooks** - Traditional Development Gates

Standard git hooks for commit and push validation.

#### Hook Timing Matrix

| Hook Type | Timing | Speed Target | Purpose |
|-----------|--------|--------------|---------|
| **pre-commit** | Before commit | < 15s | Quick checks (lint, format, naming) |
| **pre-push** | Before push | < 60s | Validation (CAWS spec, unit tests, contracts) |
| **commit-msg** | After commit | < 5s | Message validation |
| **pre-merge** | Before merge | < 30s | Integration checks |

#### Installation

```bash
# Automatic with CAWS
caws init my-project  # Installs git hooks

# Manual installation
npm run hooks:install
```

## Multi-Platform Agent Integration

### Platform Comparison

| Platform | Integration Method | Real-time | Structured Workflows | Tool Access |
|----------|-------------------|-----------|---------------------|-------------|
| **Cursor** | Native hooks | ✅ Instant | ❌ | ✅ Direct |
| **VS Code** | Extension + MCP | ✅ Real-time | ✅ Workflows | ✅ MCP tools |
| **Windsurf** | Cascade workflows | ⚠️ Workflow-based | ✅ Structured | ✅ MCP tools |
| **GitHub Copilot** | Preview SDK | ⚠️ Chat-based | ❌ | ✅ SDK tools |
| **Generic IDEs** | MCP server | ❌ | ❌ | ✅ MCP tools |
| **CLI Tools** | Direct API | ❌ | ✅ Scripts | ✅ Full API |

### Choosing Integration Strategy

#### For **Real-time Feedback**
- **Primary**: Cursor hooks (instant, < 500ms)
- **Secondary**: VS Code extension (real-time, < 2s)
- **Fallback**: MCP server polling

#### For **Structured Workflows**
- **Primary**: Cascade workflows (markdown-based, team shareable)
- **Secondary**: VS Code extension workflows
- **Fallback**: CLI scripts

#### For **Tool Integration**
- **Primary**: MCP server (standardized protocol)
- **Secondary**: Preview SDK (Copilot-specific)
- **Fallback**: Direct API calls

## Implementation Examples

### Example 1: TDD Workflow with Cursor Hooks

```bash
# Cursor hook for TDD cycle
#!/bin/bash
# .cursor/hooks/tdd-cycle.sh

INPUT=$(cat)
ACTION=$(echo "$INPUT" | jq -r '.hook_event_name')

case $ACTION in
  "afterFileEdit")
    # After editing a test file
    FILE=$(echo "$INPUT" | jq -r '.file_path')
    if [[ "$FILE" == *test* ]]; then
      # Run tests and provide feedback
      if npm test -- --testPathPattern="$FILE" --watchAll=false; then
        echo '{"userMessage": "✅ Tests passed - proceed with implementation"}'
      else
        echo '{"userMessage": "❌ Tests failed - fix implementation"}'
      fi
    fi
    ;;
  "beforeShellExecution")
    # Block certain commands during TDD
    CMD=$(echo "$INPUT" | jq -r '.command')
    if [[ "$CMD" == *"git commit"* ]]; then
      # Check if tests pass before committing
      if ! npm test; then
        echo '{
          "permission": "deny",
          "userMessage": "❌ Cannot commit - tests are failing",
          "agentMessage": "Please fix failing tests before committing"
        }'
        exit 0
      fi
    fi
    ;;
esac
```

### Example 2: Quality Monitoring with MCP

```javascript
// Agent continuously monitoring quality
class QualityAwareAgent {
  constructor(mcpClient) {
    this.mcpClient = mcpClient;
    this.monitoringInterval = setInterval(() => this.checkQuality(), 30000);
  }

  async checkQuality() {
    try {
      const result = await this.mcpClient.callTool('caws_evaluate', {
        specFile: '.caws/working-spec.yaml'
      });

      const evaluation = JSON.parse(result.content[0].text);

      if (evaluation.quality_score < 0.7) {
        // Quality is degrading - get guidance
        const guidance = await this.mcpClient.callTool('caws_iterate', {
          currentState: "Quality issues detected"
        });

        // Suggest improvements
        this.notifyUser(guidance.iteration.next_steps);
      }
    } catch (error) {
      console.warn('Quality monitoring failed:', error);
    }
  }
}
```

### Example 3: Cascade Workflow Integration

```markdown
# /caws-agent-development

## Agent-Guided Development Workflow

**Purpose**: Enable agents to self-direct development with CAWS quality bars

**Steps**:

1. **Assess Current State**
   ```
   caws agent evaluate .caws/working-spec.yaml
   ```
   *Get baseline quality assessment*

2. **Plan Next Phase**
   ```
   caws agent iterate --current-state "Planning next implementation phase"
   ```
   *Receive AI-guided development suggestions*

3. **Implement Changes**
   - Follow CAWS guidance for implementation approach
   - Use appropriate risk tier and quality standards
   - Implement iteratively with frequent validation

4. **Quality Validation**
   ```
   caws agent evaluate .caws/working-spec.yaml
   ```
   *Validate implementation meets quality standards*

5. **Address Issues**
   - Fix failing quality gates
   - Create waivers for exceptional circumstances if needed
   - Update working spec if requirements changed

6. **Completion Check**
   - Verify acceptance criteria met
   - Generate provenance documentation
   - Ready for integration or next phase

**Agent Decision Points**:
- Quality score < 0.75 → Continue iteration
- Quality score ≥ 0.75 → Consider complete
- Critical quality gates failing → Request human review
- Working spec changes needed → Escalate to human

**Call Other Workflows**:
- `/caws-testing-workflow` for comprehensive testing
- `/caws-waiver-request` for exceptional circumstances
- `/caws-documentation-update` for docs maintenance
```

## Best Practices

### Platform Selection

1. **Use Cursor** for real-time feedback during AI-assisted coding
2. **Use Cascade** for team-shared development workflows
3. **Use MCP** for standardized tool access across platforms
4. **Use VS Code Extension** for comprehensive IDE integration
5. **Use Preview SDK** for Copilot-specific integrations

### Integration Strategy

1. **Layer Approaches**: Combine multiple integration methods for comprehensive coverage
2. **Fail Gracefully**: Ensure one integration failure doesn't break others
3. **Performance First**: Keep real-time hooks under 500ms
4. **User Choice**: Allow developers to opt into different integration levels

### Agent Development Guidelines

1. **Quality-First**: Always check CAWS evaluation before considering tasks complete
2. **Iterative Approach**: Use CAWS guidance for systematic development
3. **Risk Awareness**: Respect tier-based quality requirements
4. **Documentation**: Maintain provenance through development process

## Troubleshooting

### Common Issues

#### Cursor Hooks Not Executing
```bash
# Check hook permissions
ls -la .cursor/hooks/*.sh

# Test manually
echo '{"file_path":"test.js"}' | .cursor/hooks/format.sh

# Restart Cursor after configuration changes
```

#### MCP Server Connection Issues
```bash
# Check MCP server status
ps aux | grep caws-mcp-server

# Restart MCP server
pkill -f caws-mcp-server
npm run mcp:start
```

#### Cascade Workflow Not Found
```bash
# Check workflow discovery
find . -name "*.md" -path "*/workflows/*" | head -10

# Validate workflow format
cat .windsurf/workflows/caws-feature-development.md
```

#### VS Code Extension Not Loading
```bash
# Check extension status
code --list-extensions | grep caws

# Reload VS Code window
# Cmd/Ctrl + Shift + P → "Developer: Reload Window"
```

## Resources

- [Cursor Hooks Documentation](https://docs.cursor.com/advanced/hooks)
- [Cascade Workflows Guide](https://docs.windsurf.com/windsurf/cascade/workflows)
- [MCP Protocol Specification](https://modelcontextprotocol.io/specification)
- [Preview SDK Documentation](https://github.com/copilot-extensions/preview-sdk.js)
- [VS Code Extension API](https://code.visualstudio.com/api)

## Migration Guide

### From Individual Hooks to Unified Strategy

**Before**: Separate git hooks, Cursor hooks, manual workflows
```bash
# Git hooks only
npm run hooks:install

# Cursor hooks separate
cp -r packages/caws-cli/templates/.cursor .
```

**After**: Integrated agent workflow system
```bash
# Single command enables all integrations
caws init my-project --interactive --enable-all-integrations

# Agents get comprehensive tool access
caws agent evaluate    # Quality assessment
caws agent iterate     # Development guidance
caws waivers create    # Exception handling
```

### Platform-Specific Migration

- **Cursor Users**: Enable hooks during `caws init`
- **VS Code Users**: Install CAWS extension from marketplace
- **Windsurf Users**: Import CAWS Cascade workflows
- **Copilot Users**: Use CAWS Preview SDK extensions

---

**This unified approach enables agents to work seamlessly with CAWS quality assurance across all major AI coding platforms, providing consistent, high-quality development experiences regardless of the tools used.**
