# CAWS MCP Server API Reference

**Version**: 1.0.0  
**Protocol**: Model Context Protocol (MCP)  
**Transport**: stdio  
**Author**: @darianrosebrook

---

## Overview

The CAWS MCP Server exposes 13 tools for AI agents to interact with the Coding Agent Workflow System. All tools follow the MCP protocol specification and return structured JSON responses.

### Base Configuration

```json
{
  "name": "caws-mcp-server",
  "version": "1.0.0",
  "description": "CAWS quality assurance tools for AI agents",
  "transport": "stdio"
}
```

---

## Tools Index

### Project Management
- [`caws_init`](#caws_init) - Initialize new projects
- [`caws_scaffold`](#caws_scaffold) - Add CAWS to existing projects
- [`caws_status`](#caws_status) - Project health overview
- [`caws_diagnose`](#caws_diagnose) - Health checks & auto-fix

### Quality Assurance
- [`caws_evaluate`](#caws_evaluate) - Quality evaluation
- [`caws_iterate`](#caws_iterate) - Iterative guidance
- [`caws_validate`](#caws_validate) - Spec validation

### Development Tools
- [`caws_hooks`](#caws_hooks) - Git hooks management
- [`caws_provenance`](#caws_provenance) - Provenance tracking
- [`caws_waiver_create`](#caws_waiver_create) - Waiver creation

### Workflow Support
- [`caws_workflow_guidance`](#caws_workflow_guidance) - Workflow help
- [`caws_quality_monitor`](#caws_quality_monitor) - Real-time monitoring
- [`caws_test_analysis`](#caws_test_analysis) - Test statistics

---

## Tool Specifications

### caws_init

Initialize a new project with CAWS setup.

**Name**: `caws_init`

**Description**: Create a new CAWS project with optional templates and setup wizard.

**Input Schema**:
```json
{
  "type": "object",
  "properties": {
    "projectName": {
      "type": "string",
      "description": "Name of the project to create (use \".\" for current directory)",
      "default": "."
    },
    "template": {
      "type": "string",
      "description": "Project template to use",
      "enum": ["extension", "library", "api", "cli"]
    },
    "interactive": {
      "type": "boolean",
      "description": "Run interactive setup wizard (not recommended for AI agents)",
      "default": false
    },
    "workingDirectory": {
      "type": "string",
      "description": "Working directory for initialization"
    }
  }
}
```

**Returns**:
```json
{
  "content": [{
    "type": "text",
    "text": "{\"success\": true, \"message\": \"Project initialized successfully\", \"output\": \"...\", \"projectName\": \"my-project\"}"
  }]
}
```

**Error Response**:
```json
{
  "content": [{
    "type": "text",
    "text": "{\"success\": false, \"error\": \"Error message\", \"command\": \"caws init\"}"
  }],
  "isError": true
}
```

**Usage Example**:
```javascript
const result = await callTool('caws_init', {
  projectName: 'my-extension',
  template: 'extension',
  interactive: false
});
```

**Exit Codes**:
- `0`: Success
- `1`: Generic error
- Timeout: 30 seconds

---

### caws_scaffold

Add CAWS components to an existing project.

**Name**: `caws_scaffold`

**Description**: Scaffold CAWS components into existing codebase.

**Input Schema**:
```json
{
  "type": "object",
  "properties": {
    "minimal": {
      "type": "boolean",
      "description": "Only install essential components",
      "default": false
    },
    "withCodemods": {
      "type": "boolean",
      "description": "Include codemod scripts",
      "default": false
    },
    "withOIDC": {
      "type": "boolean",
      "description": "Include OIDC trusted publisher setup",
      "default": false
    },
    "force": {
      "type": "boolean",
      "description": "Overwrite existing files",
      "default": false
    },
    "workingDirectory": {
      "type": "string",
      "description": "Working directory for scaffolding"
    }
  }
}
```

**Returns**:
```json
{
  "content": [{
    "type": "text",
    "text": "{\"success\": true, \"message\": \"CAWS components scaffolded successfully\", \"output\": \"...\"}"
  }]
}
```

**Usage Example**:
```javascript
const result = await callTool('caws_scaffold', {
  minimal: false,
  withCodemods: true,
  force: false
});
```

**Exit Codes**:
- `0`: Success
- `1`: Scaffold failed
- Timeout: 30 seconds

---

### caws_evaluate

Evaluate work against CAWS quality standards.

**Name**: `caws_evaluate`

**Description**: Comprehensive quality evaluation against working specification.

**Input Schema**:
```json
{
  "type": "object",
  "properties": {
    "specFile": {
      "type": "string",
      "description": "Path to working spec file",
      "default": ".caws/working-spec.yaml"
    },
    "workingDirectory": {
      "type": "string",
      "description": "Working directory for evaluation"
    }
  }
}
```

**Returns**:
```json
{
  "content": [{
    "type": "text",
    "text": "{
      \"success\": true,
      \"evaluation\": {
        \"overall_status\": \"quality_passed\",
        \"quality_score\": 0.92,
        \"criteria\": [...],
        \"next_actions\": [...]
      }
    }"
  }]
}
```

**Evaluation Status Values**:
- `quality_passed`: All criteria met
- `quality_failed`: One or more criteria failed
- `spec_invalid`: Working spec has errors

**Usage Example**:
```javascript
const result = await callTool('caws_evaluate', {
  specFile: '.caws/working-spec.yaml'
});

const evaluation = JSON.parse(result.content[0].text);
if (evaluation.evaluation.quality_score > 0.8) {
  console.log('High quality achieved!');
}
```

**Exit Codes**:
- `0`: Evaluation completed
- `1`: Evaluation failed
- Timeout: 30 seconds

---

### caws_iterate

Get iterative development guidance based on current progress.

**Name**: `caws_iterate`

**Description**: Context-aware guidance for next development steps.

**Input Schema**:
```json
{
  "type": "object",
  "properties": {
    "specFile": {
      "type": "string",
      "description": "Path to working spec file",
      "default": ".caws/working-spec.yaml"
    },
    "currentState": {
      "type": "string",
      "description": "Description of current implementation state"
    },
    "workingDirectory": {
      "type": "string",
      "description": "Working directory for guidance"
    }
  }
}
```

**Returns**:
```json
{
  "content": [{
    "type": "text",
    "text": "{
      \"success\": true,
      \"iteration\": {
        \"guidance\": \"Focus on implementing error handling...\",
        \"next_steps\": [\"Add try-catch blocks\", \"Write error tests\"],
        \"confidence\": 0.85,
        \"focus_areas\": [\"Error Handling\", \"Testing\"]
      }
    }"
  }]
}
```

**Usage Example**:
```javascript
const result = await callTool('caws_iterate', {
  currentState: 'Completed core API implementation, need to add validation'
});

const guidance = JSON.parse(result.content[0].text);
console.log(`Next: ${guidance.iteration.next_steps.join(', ')}`);
```

**Exit Codes**:
- `0`: Guidance generated
- `1`: Failed to generate guidance
- Timeout: 30 seconds

---

### caws_validate

Run CAWS validation on working specification.

**Name**: `caws_validate`

**Description**: Validate working spec format and completeness.

**Input Schema**:
```json
{
  "type": "object",
  "properties": {
    "specFile": {
      "type": "string",
      "description": "Path to working spec file",
      "default": ".caws/working-spec.yaml"
    },
    "workingDirectory": {
      "type": "string",
      "description": "Working directory for validation"
    }
  }
}
```

**Returns**:
```json
{
  "content": [{
    "type": "text",
    "text": "Validation completed:\\n✅ Working spec is valid"
  }]
}
```

**Usage Example**:
```javascript
const result = await callTool('caws_validate', {
  specFile: '.caws/working-spec.yaml'
});
```

**Exit Codes**:
- `0`: Validation passed
- `1`: Validation failed
- Timeout: 30 seconds

---

### caws_hooks

Manage CAWS git hooks for provenance tracking and quality gates.

**Name**: `caws_hooks`

**Description**: Install, remove, or check status of git hooks.

**Input Schema**:
```json
{
  "type": "object",
  "properties": {
    "subcommand": {
      "type": "string",
      "enum": ["install", "remove", "status"],
      "description": "Hooks command to execute",
      "default": "status"
    },
    "force": {
      "type": "boolean",
      "description": "Force overwrite existing hooks (for install)",
      "default": false
    },
    "backup": {
      "type": "boolean",
      "description": "Backup existing hooks before installing",
      "default": false
    },
    "workingDirectory": {
      "type": "string",
      "description": "Working directory for hooks operations"
    }
  },
  "required": ["subcommand"]
}
```

**Returns**:
```json
{
  "content": [{
    "type": "text",
    "text": "{\"success\": true, \"subcommand\": \"install\", \"output\": \"Successfully installed 4 git hooks\"}"
  }]
}
```

**Subcommands**:
- `install`: Install CAWS git hooks
- `remove`: Remove CAWS git hooks
- `status`: Check hooks installation status

**Usage Example**:
```javascript
// Install hooks with backup
const install = await callTool('caws_hooks', {
  subcommand: 'install',
  backup: true
});

// Check status
const status = await callTool('caws_hooks', {
  subcommand: 'status'
});
```

**Exit Codes**:
- `0`: Operation successful
- `1`: Operation failed
- Timeout: 30 seconds

---

### caws_provenance

Manage CAWS provenance tracking and audit trails.

**Name**: `caws_provenance`

**Description**: Initialize, update, show, verify, or analyze provenance data.

**Input Schema**:
```json
{
  "type": "object",
  "properties": {
    "subcommand": {
      "type": "string",
      "enum": ["init", "update", "show", "verify", "analyze-ai"],
      "description": "Provenance command to execute"
    },
    "commit": {
      "type": "string",
      "description": "Git commit hash for updates"
    },
    "message": {
      "type": "string",
      "description": "Commit message"
    },
    "author": {
      "type": "string",
      "description": "Author information"
    },
    "quiet": {
      "type": "boolean",
      "description": "Suppress output",
      "default": false
    },
    "workingDirectory": {
      "type": "string",
      "description": "Working directory for provenance operations"
    }
  },
  "required": ["subcommand"]
}
```

**Returns**:
```json
{
  "content": [{
    "type": "text",
    "text": "{\"success\": true, \"subcommand\": \"show\", \"output\": \"Provenance history...\"}"
  }]
}
```

**Subcommands**:
- `init`: Initialize provenance tracking
- `update`: Add commit to provenance chain
- `show`: Display provenance history
- `verify`: Validate chain integrity
- `analyze-ai`: Analyze AI contribution patterns

**Usage Example**:
```javascript
// Initialize provenance
await callTool('caws_provenance', { subcommand: 'init' });

// Update with commit
await callTool('caws_provenance', {
  subcommand: 'update',
  commit: 'abc123',
  message: 'feat: add feature',
  author: 'user@example.com'
});

// Analyze AI contributions
const analysis = await callTool('caws_provenance', {
  subcommand: 'analyze-ai'
});
```

**Exit Codes**:
- `0`: Operation successful
- `1`: Operation failed
- Timeout: 30 seconds

---

### caws_status

Get project health overview and status summary.

**Name**: `caws_status`

**Description**: Display comprehensive project health metrics.

**Input Schema**:
```json
{
  "type": "object",
  "properties": {
    "specFile": {
      "type": "string",
      "description": "Path to working spec file",
      "default": ".caws/working-spec.yaml"
    },
    "workingDirectory": {
      "type": "string",
      "description": "Working directory for status check"
    }
  }
}
```

**Returns**:
```json
{
  "content": [{
    "type": "text",
    "text": "{\"success\": true, \"output\": \"Project Health: GOOD\\n...\"}"
  }]
}
```

**Usage Example**:
```javascript
const result = await callTool('caws_status');
console.log(JSON.parse(result.content[0].text).output);
```

**Exit Codes**:
- `0`: Status retrieved
- `1`: Failed to get status
- Timeout: 30 seconds

---

### caws_diagnose

Run health checks and optionally apply automatic fixes.

**Name**: `caws_diagnose`

**Description**: Diagnose project health and optionally fix issues.

**Input Schema**:
```json
{
  "type": "object",
  "properties": {
    "fix": {
      "type": "boolean",
      "description": "Automatically apply fixes for detected issues",
      "default": false
    },
    "workingDirectory": {
      "type": "string",
      "description": "Working directory for diagnostics"
    }
  }
}
```

**Returns**:
```json
{
  "content": [{
    "type": "text",
    "text": "{\"success\": true, \"output\": \"Diagnostics completed...\", \"fixesApplied\": true}"
  }]
}
```

**Usage Example**:
```javascript
// Check only
const check = await callTool('caws_diagnose', { fix: false });

// Check and fix
const fix = await callTool('caws_diagnose', { fix: true });
```

**Exit Codes**:
- `0`: Diagnostics completed
- `1`: Diagnostics failed
- Timeout: 60 seconds (longer for fixes)

---

### caws_waiver_create

Create a waiver for exceptional circumstances.

**Name**: `caws_waiver_create`

**Description**: Create quality gate waiver with justification and expiration.

**Input Schema**:
```json
{
  "type": "object",
  "properties": {
    "title": { "type": "string", "description": "Waiver title" },
    "reason": {
      "type": "string",
      "enum": [
        "emergency_hotfix",
        "legacy_integration",
        "experimental_feature",
        "third_party_constraint",
        "performance_critical",
        "security_patch",
        "infrastructure_limitation",
        "other"
      ],
      "description": "Reason for waiver"
    },
    "description": { "type": "string", "description": "Detailed description" },
    "gates": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Quality gates to waive"
    },
    "expiresAt": { "type": "string", "description": "Expiration date (ISO 8601)" },
    "approvedBy": { "type": "string", "description": "Approver name" },
    "impactLevel": {
      "type": "string",
      "enum": ["low", "medium", "high", "critical"],
      "description": "Risk impact level"
    },
    "mitigationPlan": { "type": "string", "description": "Risk mitigation plan" },
    "workingDirectory": { "type": "string", "description": "Working directory" }
  },
  "required": [
    "title",
    "reason",
    "description",
    "gates",
    "expiresAt",
    "approvedBy",
    "impactLevel",
    "mitigationPlan"
  ]
}
```

**Returns**:
```json
{
  "content": [{
    "type": "text",
    "text": "Waiver created successfully:\\n..."
  }]
}
```

**Usage Example**:
```javascript
const waiver = await callTool('caws_waiver_create', {
  title: "Emergency security patch",
  reason: "security_patch",
  description: "Critical vulnerability requires immediate deployment",
  gates: ["coverage_threshold", "mutation_score"],
  expiresAt: "2025-11-01T00:00:00Z",
  approvedBy: "security-team",
  impactLevel: "high",
  mitigationPlan: "Manual testing completed, automated tests to follow"
});
```

**Exit Codes**:
- `0`: Waiver created
- `1`: Waiver creation failed
- Timeout: 30 seconds

---

### caws_workflow_guidance

Get workflow-specific guidance for development tasks.

**Name**: `caws_workflow_guidance`

**Description**: Structured guidance for TDD, refactor, or feature workflows.

**Input Schema**:
```json
{
  "type": "object",
  "properties": {
    "workflowType": {
      "type": "string",
      "enum": ["tdd", "refactor", "feature"],
      "description": "Type of workflow"
    },
    "currentStep": {
      "type": "number",
      "description": "Current step in workflow (1-based)"
    },
    "context": {
      "type": "object",
      "description": "Additional context for guidance"
    }
  },
  "required": ["workflowType", "currentStep"]
}
```

**Returns**:
```json
{
  "content": [{
    "type": "text",
    "text": "{
      \"workflow_type\": \"tdd\",
      \"current_step\": 2,
      \"total_steps\": 6,
      \"step_description\": \"Write failing test\",
      \"guidance\": \"Write a test that captures the desired behavior...\",
      \"next_step\": 3,
      \"next_step_description\": \"Implement minimal code\",
      \"all_steps\": [...],
      \"caws_recommendations\": [\"Run tests\", \"Check coverage\"]
    }"
  }]
}
```

**Workflow Types**:
- `tdd`: Test-Driven Development (6 steps)
- `refactor`: Refactoring workflow (5 steps)
- `feature`: Feature development (6 steps)

**Usage Example**:
```javascript
const guidance = await callTool('caws_workflow_guidance', {
  workflowType: 'tdd',
  currentStep: 2,
  context: { complexity: 'high' }
});

const workflow = JSON.parse(guidance.content[0].text);
console.log(`Current: ${workflow.step_description}`);
console.log(`Next: ${workflow.next_step_description}`);
```

**Exit Codes**:
- `0`: Guidance generated
- `1`: Invalid workflow type
- Timeout: Instant (no external call)

---

### caws_quality_monitor

Monitor code quality impact in real-time.

**Name**: `caws_quality_monitor`

**Description**: Analyze quality impact of file changes and actions.

**Input Schema**:
```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": ["file_saved", "code_edited", "test_run"],
      "description": "Type of action performed"
    },
    "files": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Files affected by action"
    },
    "context": {
      "type": "object",
      "description": "Additional context about the action"
    }
  },
  "required": ["action"]
}
```

**Returns**:
```json
{
  "content": [{
    "type": "text",
    "text": "{
      \"action\": \"file_saved\",
      \"files_affected\": 1,
      \"quality_impact\": \"code_change\",
      \"recommendations\": [
        \"Run CAWS validation: caws agent evaluate\",
        \"Check for linting issues\"
      ],
      \"risk_level\": \"medium\"
    }"
  }]
}
```

**Action Types**:
- `file_saved`: File saved to disk
- `code_edited`: Code modification in editor
- `test_run`: Test execution completed

**Risk Levels**:
- `low`: Minimal impact
- `medium`: Standard review recommended
- `high`: Comprehensive validation required

**Usage Example**:
```javascript
const monitor = await callTool('caws_quality_monitor', {
  action: 'code_edited',
  files: ['src/api.ts', 'src/utils.ts'],
  context: {
    project_tier: 2,
    change_size: 150
  }
});

const result = JSON.parse(monitor.content[0].text);
if (result.risk_level === 'high') {
  // Trigger validation
}
```

**Exit Codes**:
- `0`: Analysis complete
- Timeout: Instant (no external call)

---

### caws_test_analysis

Run statistical analysis for budget prediction and test optimization.

**Name**: `caws_test_analysis`

**Description**: Analyze test patterns and predict budget requirements.

**Input Schema**:
```json
{
  "type": "object",
  "properties": {
    "subcommand": {
      "type": "string",
      "enum": ["assess-budget", "analyze-patterns", "find-similar"],
      "description": "Analysis type to perform"
    },
    "specFile": {
      "type": "string",
      "description": "Path to working spec file",
      "default": ".caws/working-spec.yaml"
    },
    "workingDirectory": {
      "type": "string",
      "description": "Working directory for analysis"
    }
  },
  "required": ["subcommand"]
}
```

**Returns**:
```json
{
  "content": [{
    "type": "text",
    "text": "Analysis completed:\\n..."
  }]
}
```

**Subcommands**:
- `assess-budget`: Predict required budget
- `analyze-patterns`: Analyze test patterns
- `find-similar`: Find similar projects

**Usage Example**:
```javascript
const budget = await callTool('caws_test_analysis', {
  subcommand: 'assess-budget'
});
```

**Exit Codes**:
- `0`: Analysis complete
- `1`: Analysis failed
- Timeout: 30 seconds

---

## Error Handling

All tools follow consistent error handling:

### Error Response Format
```json
{
  "content": [{
    "type": "text",
    "text": "{
      \"success\": false,
      \"error\": \"Error description\",
      \"command\": \"caws command that failed\"
    }"
  }],
  "isError": true
}
```

### Common Error Codes
- `ENOENT`: File or directory not found
- `EACCES`: Permission denied
- `ETIMEDOUT`: Operation timed out
- `EINVAL`: Invalid parameters

### Error Handling Best Practices
```javascript
try {
  const result = await callTool('caws_init', { projectName: 'test' });
  const parsed = JSON.parse(result.content[0].text);
  
  if (!parsed.success) {
    console.error(`Error: ${parsed.error}`);
    return;
  }
  
  // Handle success
} catch (error) {
  console.error(`Tool call failed: ${error.message}`);
}
```

---

## Resources

The CAWS MCP Server also provides resource access:

### Working Specifications
- URI Pattern: `caws://working-spec/{path}`
- MIME Type: `application/yaml`
- Access: Read-only

### Waivers
- URI Pattern: `caws://waivers/{id}`
- MIME Type: `application/json`
- Access: Read-only

---

## Rate Limiting & Performance

### Timeouts
- Default: 30 seconds
- Diagnose with fix: 60 seconds
- Workflow guidance: Instant (no subprocess)
- Quality monitor: Instant (no subprocess)

### Concurrent Calls
- Supported: Yes
- Max concurrent: Unlimited (subprocess-based)
- Note: May impact system performance

### Performance Tips
1. Use `workingDirectory` to avoid unnecessary path resolution
2. Cache evaluation results for repeated checks
3. Use quality monitor for lightweight checks
4. Batch similar operations when possible

---

## Version History

### 1.0.0 (October 2025)
- Initial release with 13 tools
- Full CLI parity for core operations
- Provenance tracking support
- Workflow guidance system

---

## Support & Resources

- **Documentation**: `/docs/agents/full-guide.md`
- **Examples**: `/examples/agent-caws-integration.js`
- **Issues**: https://github.com/paths-design/caws/issues
- **Protocol Spec**: https://modelcontextprotocol.io/specification

---

## License

MIT License - see main project LICENSE file.


