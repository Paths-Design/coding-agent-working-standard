# Agent Workflow Extensions with CAWS

This document explores how CAWS can integrate with modern agent coding IDEs to create powerful, real-time feedback loops and guided development workflows.

## Overview of Agent IDE Integration Patterns

### 1. Cursor IDE Hooks - Real-time Validation

Cursor provides hooks that run before or after defined stages of the agent loop. These hooks can:
- **Observe** agent behavior and context
- **Block** or modify agent actions
- **Extend** agent capabilities with external tools
- Communicate via JSON over stdio

**Key Capabilities:**
- Real-time quality gate enforcement
- Agent behavior modification
- External tool integration
- Context-aware interventions

### 2. Cascade Workflows - Guided Task Sequences

Cascade enables markdown-based workflow definitions that guide agents through repetitive processes:
- **Step-by-step guidance** for complex tasks
- **Workflow chaining** (`/workflow-1` can call `/workflow-2`)
- **Team collaboration** via shared workflow definitions
- **Repeatable processes** for deployments, code reviews, etc.

**Key Capabilities:**
- Structured development processes
- Multi-step task orchestration
- Team workflow standardization
- Agent-guided task completion

### 3. Preview SDK - Copilot Extension Integration

GitHub's Preview SDK simplifies building Copilot extensions that integrate tools and APIs directly into agent conversations:
- **Request verification** and response formatting
- **API interaction handling**
- **Tool integration** in chat interfaces
- **Agent capability extension**

**Key Capabilities:**
- Seamless tool integration in chat
- API-first development approach
- Agent-augmented workflows
- Contextual tool invocation

## CAWS Integration Strategies

### Strategy 1: VS Code Extension + MCP Server

**Architecture:**
```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────┐
│   VS Code IDE   │────│  MCP Server      │────│    CAWS     │
│                 │    │  (Local Agent)   │    │  CLI/Tools  │
│ • Agent Chat    │    │ • Tool Registry  │    │ • Quality   │
│ • File Editing  │    │ • Context Mgmt   │    │ • Gates      │
│ • Terminal      │────│ • Protocol Bridge│────│ • Validation │
└─────────────────┘    └──────────────────┘    └─────────────┘
```

**MCP Server Capabilities:**
- **Tool Exposure**: CAWS commands as MCP tools
- **Context Awareness**: Project state and working specs
- **Real-time Feedback**: Quality gate results in chat
- **Workflow Integration**: Step-by-step guided development

### Strategy 2: Cursor Hooks Integration

**Hook Points:**
```javascript
// Pre-agent action hook
{
  "hook": "pre_agent_action",
  "context": {
    "action": "code_edit",
    "file": "src/api.js",
    "project_tier": 2,
    "working_spec": ".caws/working-spec.yaml"
  },
  "response": {
    "allow": true,
    "warnings": ["Consider adding error handling"],
    "suggestions": ["Run CAWS validation after edit"]
  }
}
```

**Hook Integration:**
- **Quality Gate Hooks**: Block risky changes
- **Validation Hooks**: Real-time spec compliance
- **Guidance Hooks**: Contextual development advice
- **Workflow Hooks**: Step progression validation

### Strategy 3: Cascade Workflow Integration

**CAWS-Guided Workflows:**
```markdown
# /caws-feature-development

## Feature Development with CAWS Quality Gates

1. **Initialize CAWS Spec**
   - Run: `caws init feature-name --mode=feature --tier=2`
   - Verify: Working spec completeness

2. **Plan Implementation**
   - Get CAWS guidance: `caws agent iterate --current-state "Planning phase"`
   - Define acceptance criteria
   - Break down into manageable tasks

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

## Call Other Workflows
- /caws-testing-workflow for comprehensive testing
- /caws-deployment-checklist for deployment preparation
```

## Implementation Roadmap

### Phase 1: MCP Server Foundation

**MCP Server Implementation:**
```javascript
// mcp-caws-server.js
const { Server } = require('@modelcontextprotocol/sdk/server');

class CawsMcpServer extends Server {
  constructor() {
    super({
      name: 'caws-mcp-server',
      version: '1.0.0'
    });

    this.setupToolHandlers();
  }

  setupToolHandlers() {
    // Quality evaluation tool
    this.setRequestHandler('tools/call', async (request) => {
      if (request.params.name === 'caws_evaluate') {
        const result = await this.runCawsEvaluation(request.params.arguments);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }]
        };
      }
    });

    // Iterative guidance tool
    this.setRequestHandler('tools/call', async (request) => {
      if (request.params.name === 'caws_iterate') {
        const guidance = await this.runCawsGuidance(request.params.arguments);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(guidance, null, 2)
          }]
        };
      }
    });
  }

  async runCawsEvaluation(args) {
    const { execSync } = require('child_process');
    try {
      const result = execSync(`caws agent evaluate ${args.specFile}`, {
        encoding: 'utf8',
        cwd: args.workingDirectory || process.cwd()
      });
      return JSON.parse(result);
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async runCawsGuidance(args) {
    const { execSync } = require('child_process');
    try {
      const cmd = `caws agent iterate --current-state "${args.currentState}" ${args.specFile}`;
      const result = execSync(cmd, {
        encoding: 'utf8',
        cwd: args.workingDirectory || process.cwd()
      });
      return JSON.parse(result);
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}
```

### Phase 2: VS Code Extension Integration

**Extension Architecture:**
```typescript
// extension.ts
import * as vscode from 'vscode';
import { CawsMcpClient } from './mcp-client';

export function activate(context: vscode.ExtensionContext) {
  const mcpClient = new CawsMcpClient();

  // Register CAWS commands
  context.subscriptions.push(
    vscode.commands.registerCommand('caws.evaluate', async () => {
      const result = await mcpClient.callTool('caws_evaluate', {
        specFile: '.caws/working-spec.yaml'
      });

      // Display results in output channel or webview
      showCawsResults(result);
    })
  );

  // Register code action provider for CAWS suggestions
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider('*', new CawsCodeActionProvider())
  );

  // Register status bar item
  const statusBarItem = vscode.window.createStatusBarItem();
  statusBarItem.command = 'caws.evaluate';
  statusBarItem.text = 'CAWS: $(check)';
  context.subscriptions.push(statusBarItem);

  // Set up file watchers for real-time validation
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  watcher.onDidChange(() => {
    // Trigger real-time validation
    mcpClient.callTool('caws_validate_realtime', { changedFiles: [] });
  });
}
```

### Phase 3: Cursor Hooks Integration

**Cursor Hook Implementation:**
```javascript
#!/usr/bin/env node

// cursor-hook-caws.js
const { readFileSync } = require('fs');
const { execSync } = require('child_process');

process.stdin.on('data', (data) => {
  const hookData = JSON.parse(data.toString());

  if (hookData.hook === 'pre_agent_action') {
    handlePreAgentAction(hookData);
  } else if (hookData.hook === 'post_agent_action') {
    handlePostAgentAction(hookData);
  }
});

function handlePreAgentAction(hookData) {
  const { action, file, project_tier } = hookData.context;

  // Check if action affects quality gates
  if (action === 'code_edit' && project_tier <= 2) {
    try {
      // Run quick validation
      const result = execSync('caws agent evaluate --feedback-only .caws/working-spec.yaml', {
        encoding: 'utf8'
      });

      const evaluation = JSON.parse(result);

      if (!evaluation.success) {
        // Block the action and provide guidance
        const response = {
          allow: false,
          block_reason: 'CAWS validation failed',
          suggestions: evaluation.evaluation.next_actions,
          caws_status: evaluation.evaluation.overall_status
        };

        process.stdout.write(JSON.stringify(response) + '\n');
        return;
      }
    } catch (error) {
      // Allow but warn on hook failure
      const response = {
        allow: true,
        warnings: ['CAWS validation hook failed - proceeding with caution']
      };
      process.stdout.write(JSON.stringify(response) + '\n');
      return;
    }
  }

  // Allow the action
  process.stdout.write(JSON.stringify({ allow: true }) + '\n');
}

function handlePostAgentAction(hookData) {
  const { action, file } = hookData.context;

  if (action === 'code_edit') {
    // Suggest CAWS validation after edit
    const response = {
      suggestions: [
        'Consider running: caws agent evaluate',
        'Check quality gates: caws validate'
      ],
      caws_recommendation: 'Validate changes against CAWS quality standards'
    };

    process.stdout.write(JSON.stringify(response) + '\n');
  }
}
```

### Phase 4: Cascade Workflow Integration

**CAWS Workflow Templates:**
```markdown
# /caws-tdd-workflow

## Test-Driven Development with CAWS

**Purpose**: Guide agents through TDD process with CAWS quality validation

**Steps**:

1. **Define Requirements**
   ```
   caws agent evaluate --feedback-only .caws/working-spec.yaml
   ```
   *Ensure acceptance criteria are well-defined*

2. **Write Failing Test**
   ```
   # Agent writes test that captures desired behavior
   # Test should fail initially
   ```

3. **Implement Minimal Code**
   ```
   # Agent implements just enough code to make test pass
   ```

4. **Run CAWS Validation**
   ```
   caws agent evaluate .caws/working-spec.yaml
   ```
   *Check if implementation meets quality standards*

5. **Refactor if Needed**
   - Address any failing quality gates
   - Improve code while maintaining test suite
   - Re-run validation

6. **Repeat**
   - Add next test case
   - Continue TDD cycle

**Quality Gates**:
- Unit test coverage maintained
- No new linting errors
- Acceptance criteria validation

---

# /caws-refactor-workflow

## Safe Refactoring with CAWS

**Purpose**: Ensure refactoring maintains quality standards

**Steps**:

1. **Baseline Quality Check**
   ```
   caws agent evaluate .caws/working-spec.yaml
   ```
   *Establish current quality baseline*

2. **Apply Refactoring**
   ```
   # Agent performs refactoring changes
   ```

3. **Immediate Validation**
   ```
   caws validate --quick
   ```
   *Quick check for obvious issues*

4. **Comprehensive Testing**
   ```
   caws agent evaluate .caws/working-spec.yaml
   ```
   *Full quality gate validation*

5. **Provenance Documentation**
   ```
   caws provenance update --refactor-summary "Refactored X for better Y"
   ```

**Risk Mitigation**:
- Contract tests ensure API compatibility
- Integration tests verify system behavior
- Performance benchmarks maintained

---

# /caws-emergency-fix

## Emergency Fix Workflow

**Purpose**: Handle critical fixes while maintaining safety

**Steps**:

1. **Assess Urgency**
   - Determine if waiver needed
   - Evaluate risk level

2. **Create Waiver if Required**
   ```
   caws waivers create \
     --title "Emergency security fix" \
     --reason emergency_hotfix \
     --gates coverage_threshold \
     --expires-at "2025-11-01T00:00:00Z" \
     --approved-by "security-team" \
     --impact-level critical \
     --mitigation-plan "Security testing completed manually"
   ```

3. **Apply Fix**
   ```
   # Implement critical fix
   ```

4. **Validate with Waiver**
   ```
   caws agent evaluate .caws/working-spec.yaml
   ```
   *Should pass with waiver applied*

5. **Schedule Follow-up**
   - Plan comprehensive testing
   - Schedule waiver review
   - Document lessons learned

**Emergency Checklist**:
- [ ] Waiver approved by appropriate stakeholders
- [ ] Manual testing completed
- [ ] Rollback plan documented
- [ ] Follow-up work scheduled
```

## Real-time Agent Feedback Loops

### 1. Continuous Quality Monitoring

**MCP Tool Integration:**
```javascript
// Real-time quality monitoring during development
const qualityMonitor = {
  name: 'caws_quality_monitor',
  description: 'Monitor code quality in real-time during development',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['file_saved', 'code_edited', 'test_run'] },
      files: { type: 'array', items: { type: 'string' } },
      context: { type: 'object' }
    }
  },
  handler: async (args) => {
    const { action, files, context } = args;

    // Run appropriate CAWS checks based on action
    if (action === 'file_saved') {
      const result = await runCawsCheck('quick_validate', files);
      return {
        feedback: result.feedback,
        suggestions: result.suggestions,
        quality_score: result.score
      };
    }

    if (action === 'code_edited') {
      const guidance = await runCawsGuidance(context.current_state);
      return {
        next_steps: guidance.next_steps,
        confidence: guidance.confidence,
        focus_areas: guidance.focus_areas
      };
    }
  }
};
```

### 2. Intelligent Code Action Suggestions

**VS Code Integration:**
```typescript
class CawsCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(document: vscode.TextDocument, range: vscode.Range) {
    const actions: vscode.CodeAction[] = [];

    // Suggest CAWS validation after code changes
    const validateAction = new vscode.CodeAction(
      'Validate with CAWS',
      vscode.CodeActionKind.QuickFix
    );
    validateAction.command = {
      command: 'caws.validate',
      title: 'Run CAWS validation',
      arguments: [document.uri]
    };
    actions.push(validateAction);

    // Suggest waiver creation for failing gates
    const waiverAction = new vscode.CodeAction(
      'Create CAWS Waiver',
      vscode.CodeActionKind.QuickFix
    );
    waiverAction.command = {
      command: 'caws.createWaiver',
      title: 'Create waiver for failing gates'
    };
    actions.push(waiverAction);

    return actions;
  }
}
```

### 3. Agent Behavior Modification

**Cursor Hook Integration:**
```javascript
// Hook that modifies agent behavior based on CAWS guidance
function modifyAgentBehavior(hookData) {
  const { context } = hookData;

  // Get CAWS guidance for current state
  const guidance = getCawsGuidance(context.current_implementation_state);

  // Modify agent prompts or behavior
  const modifications = {
    system_prompt_additions: guidance.focus_areas.map(area =>
      `Pay special attention to: ${area}`
    ),
    response_modifiers: guidance.risk_mitigations.map(risk =>
      `Important: ${risk}`
    ),
    next_action_suggestions: guidance.next_steps
  };

  return modifications;
}
```

## Benefits of Extended Agent Workflows

### 1. **Proactive Quality Assurance**
- Real-time validation prevents quality issues
- Early feedback reduces rework
- Automated quality gate enforcement

### 2. **Guided Development Process**
- Step-by-step workflow guidance
- Context-aware suggestions
- Structured approach to complex tasks

### 3. **Enhanced Agent Capabilities**
- Access to comprehensive quality tools
- Risk-aware decision making
- Provenance tracking for agent actions

### 4. **Team Collaboration**
- Shared workflow definitions
- Consistent quality standards
- Collaborative problem-solving

### 5. **Intelligent Automation**
- Smart test selection
- Parallel execution optimization
- Predictive failure detection

## Implementation Priority

### High Priority (Immediate)
- **MCP Server** for basic CAWS tool exposure
- **VS Code Extension** foundation
- **Basic Cursor Hooks** for validation blocking

### Medium Priority (Next Phase)
- **Cascade Workflow Templates** for common tasks
- **Real-time feedback loops** in IDE
- **Smart test selection** integration

### Future Enhancements
- **Advanced AI guidance** using CAWS data
- **Multi-agent coordination** via workflows
- **Enterprise integrations** (LDAP, SSO)
- **Custom workflow builders** for teams

This integration creates a powerful ecosystem where agents can leverage CAWS quality assurance capabilities in real-time, creating more reliable, guided, and collaborative development experiences.
