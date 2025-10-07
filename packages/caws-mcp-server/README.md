# CAWS MCP Server

**Model Context Protocol Server for CAWS Agent Integration**

The CAWS MCP Server enables AI agents and AI coding assistants to interact with CAWS (Coding Agent Workflow System) quality assurance capabilities through the Model Context Protocol. This allows agents to evaluate code quality, get iterative development guidance, and access CAWS tools directly from their development environment.

## Overview

The MCP Server acts as a bridge between CAWS and AI agents by:

- **Exposing CAWS Tools**: Making CAWS CLI commands available as MCP tools
- **Resource Management**: Providing access to working specifications and waivers
- **Real-time Evaluation**: Enabling agents to assess code quality on-demand
- **Workflow Guidance**: Offering structured development guidance
- **Quality Monitoring**: Supporting continuous quality assessment

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────┐
│   AI Agent      │────│  CAWS MCP Server │────│    CAWS     │
│   (Cursor,      │    │   (Protocol       │    │  CLI/Tools  │
│    Windsurf,    │    │    Bridge)       │    │             │
│    Copilot)     │────│ • Tool Registry  │────│ • Quality   │
└─────────────────┘    │ • Context Mgmt   │    │ • Gates      │
                       │ • Protocol Bridge│    │ • Validation │
                       └──────────────────┘    └─────────────┘
```

## Installation

### NPM Installation

```bash
npm install -g @caws/mcp-server
```

### Local Development

```bash
# Clone the CAWS monorepo
git clone https://github.com/paths-design/caws.git
cd caws/packages/caws-mcp-server

# Install dependencies
npm install

# Start the server
npm start
```

## MCP Tools

The server exposes the following tools to agents:

### Quality Evaluation (`caws_evaluate`)

Evaluate work against CAWS quality standards.

```javascript
// Agent calls the tool
const result = await callTool('caws_evaluate', {
  specFile: '.caws/working-spec.yaml',
  workingDirectory: '/path/to/project'
});

// Returns evaluation results
{
  "success": true,
  "evaluation": {
    "overall_status": "quality_passed",
    "quality_score": 0.92,
    "criteria": [...],
    "next_actions": [...]
  }
}
```

### Iterative Guidance (`caws_iterate`)

Get context-aware development guidance.

```javascript
const guidance = await callTool('caws_iterate', {
  specFile: '.caws/working-spec.yaml',
  currentState: "Started implementing core functionality",
  workingDirectory: '/path/to/project'
});

// Returns structured guidance
{
  "success": true,
  "iteration": {
    "guidance": "Focus on implementing core functionality...",
    "next_steps": ["Add error handling", "Write unit tests"],
    "confidence": 0.85,
    "focus_areas": ["Error Handling", "Testing"]
  }
}
```

### Validation (`caws_validate`)

Run CAWS validation on working specifications.

```javascript
const validation = await callTool('caws_validate', {
  specFile: '.caws/working-spec.yaml',
  workingDirectory: '/path/to/project'
});

// Returns validation results
{
  "success": true,
  "content": [{
    "type": "text",
    "text": "Validation completed: Working spec is valid"
  }]
}
```

### Waiver Management (`caws_waiver_create`)

Create waivers for exceptional circumstances.

```javascript
const waiver = await callTool('caws_waiver_create', {
  title: "Emergency security fix",
  reason: "emergency_hotfix",
  description: "Critical vulnerability requires immediate deployment",
  gates: ["coverage_threshold"],
  expiresAt: "2025-11-01T00:00:00Z",
  approvedBy: "security-team",
  impactLevel: "high",
  mitigationPlan: "Manual testing completed"
});
```

### Workflow Guidance (`caws_workflow_guidance`)

Get step-by-step workflow guidance for development tasks.

```javascript
const workflow = await callTool('caws_workflow_guidance', {
  workflowType: "tdd", // tdd, refactor, feature
  currentStep: 2,
  context: { project_tier: 2 }
});

// Returns workflow guidance
{
  "workflow_type": "tdd",
  "current_step": 2,
  "guidance": "Write a failing test that captures the desired behavior...",
  "next_step": 3,
  "caws_recommendations": ["Run CAWS validation", "Check test coverage"]
}
```

### Quality Monitoring (`caws_quality_monitor`)

Monitor code quality impact in real-time.

```javascript
const monitoring = await callTool('caws_quality_monitor', {
  action: "file_saved", // file_saved, code_edited, test_run
  files: ["src/api.js"],
  context: {
    project_tier: 2,
    change_size: 150
  }
});

// Returns quality impact analysis
{
  "quality_impact": "code_change",
  "risk_level": "medium",
  "recommendations": [
    "Run CAWS validation: caws agent evaluate",
    "Check for linting issues"
  ]
}
```

## MCP Resources

The server provides access to CAWS resources:

### Working Specifications

Access project working specifications:

```
caws://working-spec/.caws/working-spec.yaml
caws://working-spec/packages/api/working-spec.yaml
```

### Waiver Information

Access waiver details and audit information:

```
caws://waivers/WV-0001
caws://waivers/WV-0002
```

## Integration Examples

### Cursor IDE Integration

```javascript
// Cursor hook for real-time quality monitoring
function handleFileSave(filePath) {
  const monitoring = await callMcpTool('caws_quality_monitor', {
    action: 'file_saved',
    files: [filePath]
  });

  if (monitoring.risk_level === 'high') {
    return {
      allow: true,
      warnings: monitoring.recommendations
    };
  }
}
```

### Windsurf Workflow Integration

```markdown
# /caws-guided-development

## CAWS-Guided Feature Development

1. **Initialize CAWS Spec**
   ```
   caws init feature-name --interactive
   ```
   *Create comprehensive working specification*

2. **Get Initial Guidance**
   ```
   # Agent calls MCP tool
   guidance = callTool('caws_iterate', {
     currentState: 'Planning phase complete',
     workflowType: 'feature'
   })
   ```
   *Receive structured development guidance*

3. **Implement Core Functionality**
   ```
   # Agent implements features
   # Real-time quality monitoring via MCP
   monitoring = callTool('caws_quality_monitor', {
     action: 'code_edited',
     files: ['src/feature.js']
   })
   ```

4. **Quality Validation**
   ```
   evaluation = callTool('caws_evaluate', {
     specFile: '.caws/working-spec.yaml'
   })
   if evaluation.quality_score < 0.75:
       # Address quality issues
       create_waiver_if_needed()
   ```

5. **Iterate Based on Feedback**
   ```
   next_guidance = callTool('caws_iterate', {
     currentState: 'Completed core implementation'
   })
   # Continue development cycle
   ```

## Configuration

### Environment Variables

```bash
# CAWS CLI path (if not in PATH)
export CAWS_CLI_PATH=/path/to/caws-cli

# Working directory for evaluations
export CAWS_WORKING_DIR=/current/project

# Default working spec file
export CAWS_SPEC_FILE=.caws/working-spec.yaml
```

### Server Configuration

```javascript
const server = new CawsMcpServer({
  cawsCliPath: '/custom/path/to/caws',
  defaultWorkingDir: '/projects',
  enableCaching: true,
  logLevel: 'info'
});
```

## Development

### Building

```bash
cd packages/caws-mcp-server
npm run build    # Build the server
npm run dev      # Development with watch
npm run lint     # Run ESLint
npm run test     # Run tests
```

### Adding New Tools

1. Define tool schema in `CAWS_TOOLS` array
2. Implement handler in `handleToolCall` method
3. Add comprehensive error handling
4. Update documentation and tests

### Tool Handler Pattern

```javascript
async handleNewTool(args) {
  try {
    // Validate input parameters
    this.validateParameters(args, toolSchema);

    // Execute CAWS CLI command or logic
    const result = await this.executeCawsCommand(args);

    // Format response according to MCP protocol
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: error.message }, null, 2)
      }],
      isError: true
    };
  }
}
```

## Testing

### Unit Tests

```bash
npm run test:unit        # Test individual components
npm run test:integration # Test MCP protocol integration
npm run test:e2e         # End-to-end tool testing
```

### MCP Protocol Testing

```bash
# Test with MCP inspector
npx @modelcontextprotocol/inspector

# Connect to CAWS MCP server
# Test tool calls and resource access
```

## Security Considerations

### Tool Validation

- All MCP tool calls are validated against schemas
- CAWS CLI commands are executed in controlled environment
- File system access is restricted to working directory
- Audit logging for all tool usage

### Resource Access Control

- Working specifications are read-only through MCP
- Waiver information access is logged
- No write operations allowed through MCP interface
- Context-aware permission checking

## Troubleshooting

### Connection Issues

```bash
# Check MCP server is running
ps aux | grep caws-mcp-server

# Test MCP protocol connection
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"method": "tools/list"}'
```

### Tool Execution Errors

```bash
# Check CAWS CLI installation
caws --version

# Verify working directory permissions
ls -la .caws/

# Check tool configurations
caws tools list
```

### Resource Access Issues

```bash
# Verify working spec exists
ls -la .caws/working-spec.yaml

# Check file permissions
stat .caws/working-spec.yaml

# Validate YAML syntax
caws validate .caws/working-spec.yaml
```

## Performance Optimization

### Caching Strategy

- Tool results cached for 5 minutes
- Working spec parsing cached during session
- File system operations batched where possible

### Connection Pooling

- Persistent CAWS CLI process for repeated calls
- Connection reuse for resource access
- Timeout handling for long-running operations

## Contributing

### Development Workflow

1. **Setup**: Clone and install dependencies
2. **Development**: Add new tools or resources
3. **Testing**: Write comprehensive tests
4. **Documentation**: Update tool schemas and examples
5. **Review**: Ensure MCP protocol compliance

### Code Standards

- Follow MCP protocol specifications
- Comprehensive error handling and logging
- TypeScript for type safety (future migration)
- Clear separation of concerns

## Relationship to CAWS Ecosystem

The MCP Server is a key integration point in the CAWS ecosystem:

- **CAWS CLI**: Executes the underlying quality assurance logic
- **CAWS Template**: Provides tools and configurations
- **CAWS VS Code Extension**: Uses MCP server for IDE integration
- **Agent Platforms**: Connect via MCP for CAWS capabilities

## License

MIT License - see main project LICENSE file.

## Links

- **Main Project**: https://github.com/paths-design/caws
- **MCP Specification**: https://modelcontextprotocol.io/specification
- **Documentation**: https://docs.caws.dev/mcp-server
- **Issues**: https://github.com/paths-design/caws/issues
