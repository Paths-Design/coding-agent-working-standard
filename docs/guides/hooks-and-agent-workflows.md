---
doc_id: hooks-and-agent-workflows
authority: reference
status: active
title: Agent runtime hooks and workflow integration (v11.1.6)
owner: vNext rewrite team
updated: 2026-05-15
---

# Agent runtime hooks and workflow integration (v11.1.6)

> Guide to integrating AI coding assistants (Cursor, Windsurf/Cascade, Copilot, MCP clients) with CAWS v11.1.6 quality and audit surfaces.

## Overview

CAWS does not ship its own runtime hooks. The integration patterns below describe how *agent runtimes* should call out to v11 CAWS commands during their own hook lifecycles.

> **v11.1.6 posture (A1).** CAWS v11.1.6 ships twelve command groups: `init`, `doctor`, `scope`, `status`, `claim`, `gates`, `evidence`, `events`, `waiver`, `specs`, `worktree`, `agents`. The hook examples that follow use the subset relevant to agent integration. References to removed v10 commands (`evaluate`, `iterate`, `validate`, `provenance`, `hooks install`, `scaffold`, `quality-gates`, `waivers` plural) have been replaced with v11 equivalents. Doctrine source: [`docs/architecture/caws-vnext-command-surface.md`](../architecture/caws-vnext-command-surface.md).

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

v11 does not ship `caws init --interactive` or `caws scaffold`. Set up Cursor hooks externally:

```bash
# 1. Initialize CAWS (no-arg in v11)
caws init

# 2. Add your runtime's hook directory by hand or via your editor's setup
mkdir -p .cursor/hooks
$EDITOR .cursor/hooks/validate-spec.sh
```

#### Example hook: scope and drift validation

```bash
#!/bin/bash
# .cursor/hooks/validate-scope.sh
# Triggered before agent edits a file. Refuses out-of-scope edits.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.file_path // ""')

if [[ -z "$FILE_PATH" ]]; then exit 0; fi

if command -v caws &> /dev/null; then
  if ! caws scope check "$FILE_PATH" 2>/dev/null; then
    echo '{
      "permission": "deny",
      "userMessage": "⚠️ File is outside the bound spec scope. Update .caws/specs/<id>.yaml scope.in or pick a different file.",
      "agentMessage": "caws scope check refused edit on " '"$FILE_PATH"'
    }'
    exit 0
  fi
fi
```

A second example, drift surfacing on save:

```bash
#!/bin/bash
# .cursor/hooks/post-save-doctor.sh
# Surfaces drift findings after the agent saves a file.

if command -v caws &> /dev/null; then
  OUT=$(caws doctor 2>&1)
  CODE=$?
  if [ $CODE -eq 1 ]; then
    echo '{"userMessage": "⚠️ caws doctor reports drift findings — see output below.\n'"$OUT"'"}'
  fi
fi
```

### 2. **Cascade Workflows** - Guided Task Sequences

Cascade enables structured development workflows invoked via `/[workflow-name]`.

#### Workflow Structure

```markdown
# /caws-feature-development

## Feature development with CAWS v11 quality gates

**Purpose**: Guide agents through feature development with v11 quality validation.

1. **Author the spec**
   - Create `.caws/specs/<id>.yaml` directly (v11 ships no spec generator)
   - Verify: `caws doctor` exits 0

2. **Confirm scope before editing**
   - For each target file: `caws scope check <path>` (exit 0 admit / 1 refuse)

3. **Implement core functionality (TDD)**
   - Write tests first, then implementation
   - Run project test suite as usual
   - Record evidence: `caws evidence record --type test --spec <id> --data '{...}'`

4. **Quality gates**
   - Run: `caws gates run --spec <id>` (exit 0 = pass)
   - For acceptable violations, open a waiver: `caws waiver create <id>-w --gate <g> --reason "..." --approved-by "..." --expires-at <iso>`

5. **Final validation**
   - `caws doctor` (drift)
   - `caws status` (dashboard)
   - Record AC closures: `caws evidence record --type ac --spec <id> --data '{"id":"A1","status":"satisfied"}'`
   - Ready for review/merge
```

#### Workflow Categories

- **`/caws-tdd-workflow`** - Test-driven development cycle
- **`/caws-refactor-workflow`** - Safe refactoring with validation
- **`/caws-feature-workflow`** - Feature development lifecycle
- **`/caws-emergency-fix`** - Emergency fixes with waivers

### 3. **Preview SDK Integration** - Copilot Extensions

GitHub Copilot extensions using Preview SDK for seamless tool integration.

#### Extension Pattern

```javascript
// Copilot extension using Preview SDK
const cawsTools = {
  gates: {
    name: 'CAWS gates run',
    handler: async (args) => {
      const { exitCode, stdout } = await runCaws(['gates', 'run', '--spec', args.specId]);
      return {
        type: 'text',
        text: exitCode === 0
          ? '✅ All blocking gates pass.'
          : `❌ Gate failure (exit ${exitCode}):\n${stdout}`,
      };
    }
  },
  doctor: {
    name: 'CAWS doctor',
    handler: async () => {
      const { exitCode, stdout } = await runCaws(['doctor']);
      return { type: 'text', text: `caws doctor exit ${exitCode}\n${stdout}` };
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

### 4. **Git Hooks** - Traditional Development Gates

Standard git hooks for commit and push validation.

#### Hook Timing Matrix

| Hook Type | Timing | Speed Target | Purpose |
|-----------|--------|--------------|---------|
| **pre-commit** | Before commit | < 15s | Quick checks (lint, format, naming) |
| **pre-push** | Before push | < 60s | Validation (CAWS spec, unit tests, contracts) |
| **commit-msg** | After commit | < 5s | Message validation |
| **pre-merge** | Before merge | < 30s | Integration checks |

#### Installation

v11 does not ship git-hook installation (`caws hooks install` is removed). Set up hooks externally — `husky`, `pre-commit`, or hand-rolled shell scripts under `.git/hooks/`. Hook bodies should call out to v11 commands:

```bash
# .git/hooks/pre-commit
#!/bin/bash
set -e
caws doctor
caws gates run --spec "$(git config caws.activeSpec || echo current)"
```

## Multi-Platform Agent Integration

### Platform Comparison

| Platform | Integration Method | Real-time | Structured Workflows | Tool Access |
|----------|-------------------|-----------|---------------------|-------------|
| **Cursor** | Native hooks | Yes (Instant) | No | Yes (Direct) |
| **Windsurf** | Cascade workflows | Partial (Workflow-based) | Yes (Structured) | Yes (CLI) |
| **GitHub Copilot** | Preview SDK | Partial (Chat-based) | No | Yes (SDK tools) |
| **CLI Tools** | Direct API | No | Yes (Scripts) | Yes (Full API) |

### Choosing Integration Strategy

#### For **Real-time Feedback**
- **Primary**: Cursor hooks (instant, < 500ms)
- **Fallback**: CLI polling

#### For **Structured Workflows**
- **Primary**: Cascade workflows (markdown-based, team shareable)
- **Fallback**: CLI scripts

#### For **Tool Integration**
- **Primary**: CLI (direct invocation)
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

### Example 2: drift monitoring with periodic doctor checks

```javascript
// Agent continuously monitoring drift via v11 doctor
class DriftAwareAgent {
  constructor(runCaws) {
    this.runCaws = runCaws;
    this.monitoringInterval = setInterval(() => this.checkDrift(), 30000);
  }

  async checkDrift() {
    try {
      const { exitCode, stdout } = await this.runCaws(['doctor']);
      if (exitCode === 1) {
        // Drift findings present
        this.notifyUser(`caws doctor reports drift:\n${stdout}`);
      } else if (exitCode === 2) {
        // Composition failure — setup problem, not a quality issue
        console.warn(`caws doctor composition failure:\n${stdout}`);
      }
    } catch (error) {
      console.warn('Drift monitoring failed:', error);
    }
  }
}
```

### Example 3: Cascade Workflow Integration

```markdown
# /caws-agent-development

## Agent-guided development workflow (v11)

**Purpose**: Self-directed development against the v11 quality surface.

**Steps**:

1. **Assess current state**
   ```
   caws doctor
   caws status
   ```
   *Drift detection and dashboard. Exit 0 = clean.*

2. **Confirm scope**
   ```
   caws scope check <target-file>
   ```
   *Refuse out-of-scope edits. Update .caws/specs/<id>.yaml scope.in if a file should be in.*

3. **Implement changes**
   - Author tests first, then implementation.
   - Use appropriate risk tier and quality standards from your spec.
   - Run project test suite locally as usual.

4. **Quality gates**
   ```
   caws gates run --spec <id>
   ```
   *Exit 0 = pass. Hash-chained gate_evaluated event recorded per declared gate.*

5. **Address issues**
   - Fix failing gates, OR
   - Open a waiver: `caws waiver create <id>-w --gate <g> --reason "..." --approved-by "..." --expires-at <iso>`
   - Update spec if scope/requirements changed.

6. **Completion check**
   - `caws gates run --spec <id>` returns 0.
   - Record AC closures: `caws evidence record --type ac --spec <id> --data '{"id":"A1","status":"satisfied"}'`.
   - Final `caws doctor && caws status`. Ready for review.

**Agent decision points**:
- `caws gates run` exits 1 → fix or waive; do not proceed without addressing.
- `caws gates run` exits 2 → composition failure; investigate environment, do not retry blindly.
- T1-tier blocking gate failure → request human review before waiver.
- Spec scope changes needed → escalate to human.

**Call other workflows**:
- `/caws-tdd-workflow` for the test-first cycle
- `/caws-waiver-request` for guided waiver authoring
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

**After (v11)**: explicit per-tool integration calling the v11 surface
```bash
# Initialize CAWS state
caws init

# Set up your runtime's hooks externally — they call into v11 commands:
caws doctor            # drift detection
caws gates run --spec <id>   # quality gates
caws evidence record --type ac --spec <id> --data '{...}'   # audit
caws waiver create <id>-w --gate <g> --reason "..." --approved-by "..." --expires-at <iso>   # legitimate bypass
```

### Platform-Specific Migration

- **Cursor Users**: Install the Cursor hook pack: `caws init --agent-surface cursor` (there is no interactive hook-enable prompt)
- **VS Code Users**: Install CAWS extension from marketplace
- **Windsurf Users**: Import CAWS Cascade workflows
- **Copilot Users**: Use CAWS Preview SDK extensions

---

**This unified approach enables agents to work seamlessly with CAWS quality assurance across all major AI coding platforms, providing consistent, high-quality development experiences regardless of the tools used.**
