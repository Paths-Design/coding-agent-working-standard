# P1 Sprint 1: Achieve True 100% CLI/MCP Parity

**Priority**: 🔴 CRITICAL  
**Duration**: 1-2 days  
**Goal**: Move MCP server logic to CLI commands for 1:1 parity

---

## Problem Statement

Currently, 3 MCP tools have **hardcoded logic in the MCP server** instead of calling CLI commands:

1. `caws_workflow_guidance` - Uses `generateWorkflowGuidance()` method
2. `caws_quality_monitor` - Uses `analyzeQualityImpact()` method
3. `caws_test_analysis` - Calls old CLI path `packages/caws-cli/dist/index.js`

**This violates the 1:1 parity principle**: MCP should be a thin wrapper around CLI commands, not implement logic directly.

---

## Current State Analysis

### 1. `caws_workflow_guidance` ❌ NO CLI COMMAND

**Current Implementation**: Hardcoded in MCP server

```javascript
// packages/caws-mcp-server/index.js:586
generateWorkflowGuidance(workflowType, currentStep, _context) {
  const workflowTemplates = {
    tdd: { steps: [...], guidance: {...} },
    refactor: { steps: [...], guidance: {...} },
    feature: { steps: [...], guidance: {...} }
  }
  // ... 100+ lines of hardcoded logic
}
```

**What's Needed**:

```bash
caws workflow <type> --step <number> [--context <json>]
```

**LOC to Move**: ~150 lines from MCP server → new CLI command

---

### 2. `caws_quality_monitor` ❌ NO CLI COMMAND

**Current Implementation**: Hardcoded in MCP server

```javascript
// packages/caws-mcp-server/index.js:697
async analyzeQualityImpact(action, files, context) {
  // ... 80+ lines of switch statement logic
  // Analyzes file_saved, code_edited, test_run actions
}
```

**What's Needed**:

```bash
caws quality-monitor <action> [--files <files>] [--context <json>]
```

**LOC to Move**: ~80 lines from MCP server → new CLI command

---

### 3. `caws_test_analysis` ⚠️ WRONG CLI PATH

**Current Implementation**: Calls wrong path

```javascript
// packages/caws-mcp-server/index.js:508
const result = await execCommand(
  `node packages/caws-cli/dist/index.js test-analysis ${subcommand}`,
  // Should be: ../cli/index.js
```

**CLI Command**: ✅ Already exists as `caws test-analysis`

**What's Needed**: Fix MCP handler path

---

## Implementation Plan

### Task 1: Create `caws workflow` Command

**File**: `packages/caws-cli/src/commands/workflow.js`

**Requirements**:

1. Support 3 workflow types: `tdd`, `refactor`, `feature`
2. Accept `--step <number>` flag
3. Optional `--current-state <json>` flag
4. Output workflow guidance in structured format

**Code to Port**:

- Move `generateWorkflowGuidance()` from MCP server
- Move workflow templates object
- Add CLI argument parsing
- Format output nicely

**Estimated**: 3-4 hours

---

### Task 2: Create `caws quality-monitor` Command

**File**: `packages/caws-cli/src/commands/quality-monitor.js`

**Requirements**:

1. Support 3 action types: `file_saved`, `code_edited`, `test_run`
2. Accept `--files <files>` flag (comma-separated)
3. Optional `--context <json>` flag
4. Output quality analysis and recommendations

**Code to Port**:

- Move `analyzeQualityImpact()` from MCP server
- Add CLI argument parsing
- Format output with colors
- Provide actionable recommendations

**Estimated**: 3-4 hours

---

### Task 3: Fix `caws test-analysis` MCP Handler

**File**: `packages/caws-mcp-server/index.js`

**Changes**:

```javascript
// Before:
const result = await execCommand(
  `node packages/caws-cli/dist/index.js test-analysis ${subcommand}`,

// After:
const command = `node ${path.join(__dirname, '../cli/index.js')} test-analysis ${subcommand}`;
const result = execSync(command, {...});
```

**Estimated**: 30 minutes

---

### Task 4: Update MCP Handlers to Call CLI

**File**: `packages/caws-mcp-server/index.js`

**Changes Needed**:

#### 4a. Update `handleWorkflowGuidance`:

```javascript
async handleWorkflowGuidance(args) {
  const { workflowType, currentStep, context } = args;
  const workingDirectory = args.workingDirectory || process.cwd();

  try {
    const contextArg = context ? `--current-state ${JSON.stringify(context)}` : '';
    const command = `node ${path.join(__dirname, '../cli/index.js')} workflow ${workflowType} --step ${currentStep} ${contextArg}`;

    const result = execSync(command, {
      encoding: 'utf8',
      cwd: workingDirectory,
      maxBuffer: 1024 * 1024,
    });

    return {
      content: [{ type: 'text', text: result }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Workflow guidance failed: ${error.message}` }],
      isError: true,
    };
  }
}
```

#### 4b. Update `handleQualityMonitor`:

```javascript
async handleQualityMonitor(args) {
  const { action, files, context } = args;
  const workingDirectory = args.workingDirectory || process.cwd();

  try {
    const filesArg = files?.length ? `--files ${files.join(',')}` : '';
    const contextArg = context ? `--context ${JSON.stringify(context)}` : '';
    const command = `node ${path.join(__dirname, '../cli/index.js')} quality-monitor ${action} ${filesArg} ${contextArg}`;

    const result = execSync(command, {
      encoding: 'utf8',
      cwd: workingDirectory,
      maxBuffer: 1024 * 1024,
    });

    return {
      content: [{ type: 'text', text: result }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Quality monitoring failed: ${error.message}` }],
      isError: true,
    };
  }
}
```

**Estimated**: 1 hour

---

### Task 5: Remove Hardcoded Methods from MCP Server

**File**: `packages/caws-mcp-server/index.js`

**Methods to Remove**:

- `generateWorkflowGuidance()` (~150 lines)
- `analyzeQualityImpact()` (~80 lines)

**Benefit**:

- Cleaner MCP server code
- Single source of truth (CLI)
- Easier to maintain

**Estimated**: 15 minutes

---

### Task 6: Register New Commands in CLI

**File**: `packages/caws-cli/src/index.js`

**Add**:

```javascript
const { workflowCommand } = require('./commands/workflow');
const { qualityMonitorCommand } = require('./commands/quality-monitor');

// Register workflow command
program
  .command('workflow')
  .description('Get workflow-specific guidance for development tasks')
  .addCommand(
    program
      .createCommand('tdd')
      .description('Test-driven development workflow')
      .option('--step <number>', 'Current step in workflow', '1')
      .option('--current-state <json>', 'Current implementation state', '{}')
      .action((options) => workflowCommand('tdd', options))
  )
  .addCommand(
    program
      .createCommand('refactor')
      .description('Refactoring workflow')
      .option('--step <number>', 'Current step in workflow', '1')
      .option('--current-state <json>', 'Current implementation state', '{}')
      .action((options) => workflowCommand('refactor', options))
  )
  .addCommand(
    program
      .createCommand('feature')
      .description('Feature development workflow')
      .option('--step <number>', 'Current step in workflow', '1')
      .option('--current-state <json>', 'Current implementation state', '{}')
      .action((options) => workflowCommand('feature', options))
  );

// Register quality-monitor command
program
  .command('quality-monitor <action>')
  .description('Monitor code quality impact in real-time')
  .option('--files <files>', 'Files affected (comma-separated)')
  .option('--context <json>', 'Additional context', '{}')
  .action(qualityMonitorCommand);
```

**Estimated**: 30 minutes

---

### Task 7: Rebuild and Test

**Steps**:

1. Rebuild CLI with esbuild
2. Rebuild extension bundle
3. Package new .vsix
4. Install extension
5. Test all 3 tools via MCP

**Commands**:

```bash
# Rebuild CLI
cd packages/caws-cli
node esbuild.config.js

# Rebuild extension
cd ../caws-vscode-extension
npm run bundle-deps
vsce package --skip-license --allow-unused-files-pattern --no-dependencies

# Install
code --install-extension caws-vscode-extension-1.0.0.vsix --force

# Test (after Cursor restart)
# Via MCP:
caws_workflow_guidance
caws_quality_monitor
caws_test_analysis
```

**Estimated**: 1 hour

---

### Task 8: Update Documentation

**Files to Update**:

1. `docs/internal/MCP_CLI_PARITY_ANALYSIS.md` - Mark as complete
2. `docs/internal/P0_TEST_RESULTS_COMPLETE.md` - Update to 13/13
3. `docs/agents/full-guide.md` - Add new commands
4. `packages/caws-cli/README.md` - Document new commands

**Estimated**: 1 hour

---

## Total Effort Estimate

| Task                             | Estimated Time              |
| -------------------------------- | --------------------------- |
| 1. Create `caws workflow`        | 3-4 hours                   |
| 2. Create `caws quality-monitor` | 3-4 hours                   |
| 3. Fix `test-analysis` path      | 0.5 hours                   |
| 4. Update MCP handlers           | 1 hour                      |
| 5. Remove hardcoded methods      | 0.25 hours                  |
| 6. Register CLI commands         | 0.5 hours                   |
| 7. Rebuild and test              | 1 hour                      |
| 8. Update documentation          | 1 hour                      |
| **TOTAL**                        | **10-12 hours (~1.5 days)** |

---

## Success Criteria

- ✅ `caws workflow tdd --step 1` works from terminal
- ✅ `caws workflow refactor --step 2` works from terminal
- ✅ `caws workflow feature --step 3` works from terminal
- ✅ `caws quality-monitor file_saved --files src/auth.ts` works
- ✅ `caws quality-monitor code_edited` works
- ✅ `caws quality-monitor test_run` works
- ✅ `caws test-analysis assess-budget` works (path fixed)
- ✅ All 3 tools work via MCP (no hardcoded logic)
- ✅ MCP server < 1200 LOC (removed ~230 lines)
- ✅ 13/13 MCP tools have CLI commands
- ✅ 100% true CLI/MCP parity achieved

---

## Implementation Order

### Phase 1: CLI Commands (6-8 hours)

1. Create `workflow.js` command
2. Create `quality-monitor.js` command
3. Register both in `index.js`
4. Test locally via terminal

### Phase 2: MCP Integration (2-3 hours)

1. Update `handleWorkflowGuidance` to call CLI
2. Update `handleQualityMonitor` to call CLI
3. Fix `handleTestAnalysis` path
4. Remove hardcoded methods

### Phase 3: Build & Test (2-3 hours)

1. Rebuild CLI bundle
2. Rebuild extension
3. Test all tools via MCP
4. Verify 100% parity

---

## Architecture Benefits

### Before (Current State)

```
MCP Tool → MCP Server Method → Hardcoded Logic
                ↓
         No CLI Command!
```

**Problems**:

- Logic duplicated if we add CLI later
- Can't use these features from terminal
- Harder to test
- Breaks parity principle

### After (P1 Complete)

```
MCP Tool → MCP Handler → CLI Command → Logic
Terminal → CLI Command → Logic
```

**Benefits**:

- Single source of truth
- CLI-first design
- Testable independently
- True 1:1 parity

---

## Risk Assessment

### Low Risk

- Creating new CLI commands (additive)
- Porting existing logic (no new behavior)
- Updating MCP handlers (established pattern)

### Medium Risk

- Breaking existing MCP tool functionality
- **Mitigation**: Test before/after carefully

### High Risk

- None identified

---

## Ready to Start?

This spec provides everything needed to achieve true 100% CLI/MCP parity.

**Next Steps**:

1. Review this spec
2. Approve approach
3. Start with Task 1: Create `caws workflow` command
4. Work through tasks sequentially

Let me know when you're ready to begin implementation!
