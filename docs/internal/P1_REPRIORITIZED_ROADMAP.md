# P1 Reprioritized Roadmap - Based on Agent Feedback

**Date**: October 9, 2025  
**Source**: Real agent feedback from production use  
**Current Score**: 8.5/10 (Excellent foundation, critical fixes needed)

---

## 🎯 Reprioritization Analysis

After reviewing comprehensive agent feedback, I'm **changing the P1 priority order** to address **critical trust and reliability issues** first.

### Original P1 Plan (Before Feedback)

1. ~~Sprint 2: Enhanced Error Handling~~ (Now Sprint 3)
2. ~~Sprint 3: IDE Integration~~ (Now Sprint 4)
3. ~~Sprint 4: Performance Optimization~~ (Deprioritized)

### New P1 Plan (After Feedback)

1. **Sprint 2: Trust & Reliability Fixes** 🔴 CRITICAL
2. **Sprint 3: Enhanced Error Context** 🟡 HIGH
3. **Sprint 4: Progress Tracking & DX** 🟢 MEDIUM

---

## 🔴 P1 Sprint 2: Trust & Reliability Fixes (CRITICAL)

**Priority**: HIGHEST  
**Duration**: 2-3 days  
**Why First**: "False positives kill trust" - Agent feedback

### Critical Issues from Feedback

#### Issue #1: Monorepo/Workspace Detection (FALSE POSITIVES)

**Problem**:

```bash
❌ TypeScript configuration [HIGH]
   Issue: ts-jest missing
   Reality: ts-jest IS installed in workspace
```

**Impact**:

- ⚠️ **Trust erosion** - Agents doubt all diagnostics
- ⚠️ **Wasted time** - Manual verification needed
- ⚠️ **Confusion** - Mixed signals

**Root Cause**: Only checks root `package.json`, doesn't understand:

- Monorepo structures
- npm workspaces
- Nested configurations

**Fix Required**: Workspace-aware dependency checking

---

#### Issue #2: Inconsistent Working Directory Context

**Problem**:

```bash
# From root
caws gates all 1
❌ Coverage: 0% (not found)

# From workspace
caws gates all 1
❌ Coverage: 5.8% (found!)
```

**Impact**:

- ⚠️ **Broken CI/CD** - Gates fail incorrectly from root
- ⚠️ **Frustration** - Must remember correct directory
- ⚠️ **False negatives** - Real coverage not detected

**Root Cause**: No auto-detection of active workspace

**Fix Required**: Smart workspace detection

---

### Implementation Plan

#### Task 1: Workspace-Aware Dependency Checker (4-6 hours)

**File**: `packages/caws-cli/src/utils/workspace-detector.js`

```javascript
/**
 * Detect and validate dependencies across workspace structures
 */
class WorkspaceDetector {
  async checkDependency(dep, startPath) {
    // 1. Check root package.json
    const rootCheck = await this.checkRootPackageJson(dep, startPath);
    if (rootCheck.found) return rootCheck;

    // 2. Detect workspace configuration
    const workspaces = await this.getWorkspaces(startPath);
    if (workspaces.length > 0) {
      // 3. Check all workspace package.json files
      for (const ws of workspaces) {
        const wsCheck = await this.checkWorkspacePackageJson(ws, dep);
        if (wsCheck.found) {
          return {
            ...wsCheck,
            location: 'workspace',
            workspace: ws,
          };
        }
      }
    }

    // 4. Check hoisted node_modules
    const hoistedCheck = await this.checkHoistedModules(dep, startPath);
    if (hoistedCheck.found) return hoistedCheck;

    return { found: false, checked: [startPath, ...workspaces] };
  }

  async getWorkspaces(startPath) {
    // Support multiple formats:
    // - npm workspaces (package.json)
    // - yarn workspaces (package.json)
    // - pnpm workspace (pnpm-workspace.yaml)
    // - lerna (lerna.json)
  }
}
```

**Testing**:

- ✅ npm workspaces
- ✅ yarn workspaces
- ✅ pnpm workspaces
- ✅ lerna monorepos
- ✅ standalone projects

---

#### Task 2: Smart Working Directory Detection (3-4 hours)

**File**: `packages/caws-cli/src/utils/working-directory-finder.js`

```javascript
/**
 * Find the active/relevant workspace for command execution
 */
class WorkingDirectoryFinder {
  async findWorkingDirectory(startPath, context = {}) {
    // Priority 1: Explicit working directory from user
    if (context.workingDirectory) {
      return context.workingDirectory;
    }

    // Priority 2: Directory with test artifacts
    const artifactDirs = ['coverage', 'test-results', '.nyc_output'];
    for (const dir of artifactDirs) {
      const found = await this.findDirectoryWithArtifact(startPath, dir);
      if (found) return found;
    }

    // Priority 3: Workspace with package.json + test script
    const workspaces = await this.getWorkspaces(startPath);
    for (const ws of workspaces) {
      const pkg = await this.readPackageJson(ws);
      if (pkg.scripts?.test) {
        return ws;
      }
    }

    // Priority 4: Current directory if has tests/
    if (
      fs.existsSync(path.join(startPath, 'tests')) ||
      fs.existsSync(path.join(startPath, 'test'))
    ) {
      return startPath;
    }

    // Fallback: Root
    return startPath;
  }
}
```

**Integration Points**:

- `caws diagnose` - Use for dependency checks
- `caws gates` - Use for coverage/test lookups
- `caws evaluate` - Use for project analysis

---

#### Task 3: Update Diagnose Command (2-3 hours)

**File**: `packages/caws-cli/src/commands/diagnose.js`

**Changes**:

```javascript
// Before (false positives)
if (!hasTsJest) {
  issues.push({
    severity: 'high',
    category: 'typescript',
    message: 'TypeScript + Jest detected but missing ts-jest',
    fix: 'Install ts-jest: npm install --save-dev ts-jest',
  });
}

// After (workspace-aware)
const tsJestCheck = await workspaceDetector.checkDependency('ts-jest', workingDir);
if (isTypeScript && hasJest && !tsJestCheck.found) {
  issues.push({
    severity: 'high',
    category: 'typescript',
    message: 'TypeScript + Jest detected but missing ts-jest',
    fix: 'Install ts-jest: npm install --save-dev ts-jest',
    details: {
      checked_locations: tsJestCheck.checked,
      suggestion: 'Run from workspace directory or install in root',
    },
  });
} else if (tsJestCheck.found && tsJestCheck.location === 'workspace') {
  // No issue - found in workspace (don't report)
  console.log(`✅ ts-jest found in ${tsJestCheck.workspace}`);
}
```

---

#### Task 4: Update Gate Checker (2-3 hours)

**File**: `packages/caws-cli/templates/apps/tools/caws/gates.ts`

**Changes**:

```typescript
// Before (directory-sensitive)
const coverageFile = path.join(workingDirectory, 'coverage/coverage-summary.json');

// After (smart detection)
const workingDir = await workingDirFinder.findWorkingDirectory(workingDirectory, {
  lookFor: 'coverage',
});
const coverageFile = path.join(workingDir, 'coverage/coverage-summary.json');

if (!fs.existsSync(coverageFile)) {
  return {
    passed: false,
    error: 'Coverage report not found',
    details: {
      searched_directory: workingDir,
      expected_file: coverageFile,
      hint:
        workingDir !== workingDirectory
          ? `Auto-detected workspace: ${workingDir}`
          : 'Run tests to generate coverage report',
    },
  };
}
```

---

### Success Criteria

| Criteria                          | Target | Validation                         |
| --------------------------------- | ------ | ---------------------------------- |
| No false positives in monorepos   | 0      | Test with npm/yarn/pnpm workspaces |
| Working directory auto-detection  | 100%   | Gates pass from root and workspace |
| Dependency checks workspace-aware | 100%   | Find deps in any workspace         |
| Clear error messages              | 100%   | Show searched locations            |
| Agent trust score                 | > 9/10 | Re-test with agent                 |

---

## 🟡 P1 Sprint 3: Enhanced Error Context (HIGH)

**Priority**: HIGH  
**Duration**: 2 days  
**Why Second**: "Can't debug without context" - Agent feedback

### Issues from Feedback

#### Issue #3: Limited Error Context

**Problem**:

```bash
❌ Contract gate failed
   - Contract tests not run or results not found
```

**Missing**:

- Where did tool look?
- What format expected?
- How to generate results?

**Fix Required**: Rich error context

---

### Implementation Plan

#### Task 1: Enhanced Error Messages (3-4 hours)

**Pattern**:

```javascript
{
  passed: false,
  error: 'Contract tests not run or results not found',
  details: {
    searched_paths: [
      'coverage/contract-test-results.json',
      'test-results/contracts.json',
      '.caws/contract-results.json',
    ],
    expected_format: {
      description: 'JSON with test results',
      schema: {
        tests: [{ name: string, passed: boolean }],
        summary: { total: number, passed: number },
      },
    },
    example_setup: [
      'Install contract testing library: npm i -D @pact-foundation/pact',
      'Run tests: npm run test:contract',
      'Ensure output at: coverage/contract-test-results.json',
    ],
    documentation: 'https://caws.dev/docs/contract-testing',
  },
}
```

**Apply to**:

- All gate checkers
- Diagnostic tools
- Validation errors

---

#### Task 2: "Did You Mean?" Improvements (2-3 hours)

**Enhance existing error handler**:

```javascript
// Current (basic)
Unknown command: 'evalute'
Did you mean: evaluate?

// Enhanced (with context)
Unknown command: 'evalute'

💡 Did you mean one of these?
   evaluate    - Check quality score (most similar)
   iterate     - Get next steps
   validate    - Check working spec

📚 See all commands: caws --help
🔍 Search docs: https://caws.dev/search?q=evalute
```

---

#### Task 3: Troubleshooting Guides (3-4 hours)

**Create**: `packages/caws-cli/src/troubleshooting/index.js`

```javascript
const TROUBLESHOOTING_GUIDES = {
  'coverage-not-found': {
    title: 'Coverage Report Not Found',
    symptoms: [
      'Gate fails with "Coverage report not found"',
      'Coverage shows 0% even after running tests',
    ],
    diagnosis_steps: [
      'Check if tests actually generate coverage: npm test -- --coverage',
      'Verify coverage directory exists: ls -la coverage/',
      'Confirm coverage-summary.json exists',
    ],
    solutions: [
      {
        issue: 'Tests not configured for coverage',
        fix: 'Add --coverage flag to test script in package.json',
        example: '"test": "jest --coverage"',
      },
      {
        issue: 'Coverage in different location',
        fix: 'Update coverageDirectory in jest.config.js',
        example: 'coverageDirectory: "./coverage"',
      },
    ],
    see_also: ['https://caws.dev/docs/coverage-setup'],
  },
  // ... more guides
};
```

---

## 🟢 P1 Sprint 4: Progress Tracking & DX (MEDIUM)

**Priority**: MEDIUM  
**Duration**: 2-3 days  
**Why Third**: Important for long-running projects, but doesn't break trust

### Issue from Feedback

#### Issue #4: No Incremental Progress Tracking

**Problem**:

```bash
⬜ A1: Data securely stored...
⬜ A2: Task routed...
Progress: 0/5 (0%)
```

**Missing**:

- Can't mark "in progress"
- Can't track partial completion
- Demotivating (0% after hours of work)

---

### Implementation Plan

#### Task 1: Progress State Management (4-5 hours)

**Enhance working spec**:

```yaml
acceptance:
  - id: A1
    given: User logs in
    when: Invalid credentials
    then: Error message shown
    status: in_progress # NEW
    progress: # NEW
      tests_written: 5
      tests_passing: 3
      tests_failing: 2
      coverage: 45.2
      last_updated: '2025-10-09T14:30:00Z'
```

**Add command**: `caws progress update`

```bash
caws progress update A1 --status in_progress --tests-written 5 --tests-passing 3
```

---

#### Task 2: Visual Progress Display (2-3 hours)

```bash
📊 Acceptance Criteria Progress:

   ▶️ A1: Data securely stored (IN PROGRESS - 60%)
      Tests: 3/5 passing | Coverage: 45.2%
      Last updated: 2 hours ago

   ⬜ A2: Task routed to optimal agent (NOT STARTED)

   ⬜ A3: Results aggregated correctly (NOT STARTED)

   Overall: 1/3 started, 0/3 complete (20%)
```

---

#### Task 3: Waiver Management via MCP (3-4 hours)

**Already implemented in P1 Sprint 1!** ✅

Just need to:

- Update documentation
- Add to help text
- Surface in status command

---

## 📊 Comparison: Original vs Reprioritized

| Sprint   | Original Plan   | Reprioritized               | Reason                               |
| -------- | --------------- | --------------------------- | ------------------------------------ |
| **P1-2** | Error Handling  | **Trust & Reliability**     | Critical: False positives kill trust |
| **P1-3** | IDE Integration | **Enhanced Error Context**  | High: Enables self-service debugging |
| **P1-4** | Performance     | **Progress Tracking & DX**  | Medium: Important but not blocking   |
| **P1-5** | -               | **IDE Integration** (moved) | Lower priority than reliability      |

---

## 🎯 Recommended Next Action

**Start with P1 Sprint 2: Trust & Reliability Fixes**

### Why This Order?

1. **Trust First** - Agent feedback: "If diagnostics are wrong, I start doubting other outputs"
2. **Unblock CI/CD** - Workspace issues break automation
3. **Quick Win** - 2-3 days to fix critical issues
4. **Foundation** - Other improvements build on reliable base

### What We Get

- ✅ No false positives in monorepos
- ✅ Gates work from any directory
- ✅ Agent trust restored (8.5 → 9.5/10)
- ✅ Production-ready for real teams

---

## 💬 Decision Point

**Do you want to:**

1. ✅ **Start P1 Sprint 2** (Trust & Reliability) - RECOMMENDED
2. Continue with original plan (Error Handling first)
3. Mix: Do some trust fixes + some error handling
4. Different priority

The agent feedback is clear: **Fix false positives first** or risk losing trust. Everything else builds on a reliable foundation.

What's your preference?
