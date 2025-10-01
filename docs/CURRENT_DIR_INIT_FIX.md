# Current Directory Init & Conflict Handling Fixes

**Author:** @darianrosebrook  
**Date:** October 1, 2025  
**Version:** 2.0.2 (pending)  
**Issues Fixed:** #1, #2 from E2E testing

---

## Summary

Fixed two critical issues with current directory initialization (`caws init .`) and file conflict detection that were discovered during end-to-end testing.

---

## Issue #1: Current Directory Init Created Subdirectory

### Problem
When running `caws init .` to initialize CAWS in the current directory, the CLI was creating a subdirectory named `-` instead of initializing in place.

```bash
cd existing-app
caws init . --non-interactive
# Created: existing-app/-/.caws (WRONG)
# Expected: existing-app/.caws (RIGHT)
```

### Root Cause
1. The project name `.` was being sanitized to `-` before the check for current directory initialization
2. The sanitized name `-` was then treated as a new directory to create
3. The logic to skip directory creation for `.` never executed

### Fix Applied
**File:** `packages/caws-cli/src/index.js`

**Changes:**
1. Added special-case check to skip sanitization for `.`
2. Introduced `initInCurrentDir` flag to track current directory initialization
3. Modified directory creation logic to skip `fs.ensureDir` and `process.chdir` when `initInCurrentDir === true`
4. Updated user message to show "📁 Initializing in current directory"

**Code:**
```javascript
// Special case: '.' means current directory, don't sanitize
if (projectName !== '.') {
  // Sanitize project name
  const sanitizedName = projectName.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
  if (sanitizedName !== projectName) {
    console.warn(chalk.yellow(`⚠️  Project name sanitized to: ${sanitizedName}`));
    projectName = sanitizedName;
  }
}

// Determine if initializing in current directory
const initInCurrentDir = projectName === '.';
const targetDir = initInCurrentDir ? process.cwd() : path.resolve(process.cwd(), projectName);

// Create project directory and change to it (unless already in current directory)
if (!initInCurrentDir) {
  await fs.ensureDir(projectName);
  process.chdir(projectName);
  console.log(chalk.green(`📁 Created project directory: ${projectName}`));
} else {
  console.log(chalk.green(`📁 Initializing in current directory`));
}
```

### Behavior After Fix
```bash
cd existing-app
caws init . --non-interactive

# Output:
# 📁 Initializing in current directory
# ℹ️  Created basic CAWS structure
# ✅ Added agents.md guide
# ...

# Files created:
# existing-app/.caws/
# existing-app/.agent/
# existing-app/agents.md
# (existing files preserved)
```

---

## Issue #2: File Conflict Detection Broken

### Problem
When initializing in current directory with existing `agents.md`, the conflict detection wasn't working correctly.

```bash
cd test-dir
echo "custom" > agents.md
caws init . --non-interactive

# Expected: Original preserved, CAWS guide saved as caws.md
# Actual: Original preserved, but CAWS guide also saved as agents.md (in subdirectory)
```

### Root Cause
1. The conflict check was resolving the target directory before sanitization
2. After sanitization changed `.` to `-`, the conflict check was looking in the wrong directory
3. The conflict detection code ran before determining the actual target directory

### Fix Applied
**File:** `packages/caws-cli/src/index.js`

**Changes:**
1. Moved `targetDir` calculation to happen AFTER sanitization is skipped for `.`
2. Ensured conflict checks use the correct `targetDir` whether initializing in current directory or creating new one
3. Conflict detection now runs with accurate path information

**Code:**
```javascript
// Determine if initializing in current directory
const initInCurrentDir = projectName === '.';
const targetDir = initInCurrentDir ? process.cwd() : path.resolve(process.cwd(), projectName);

// Check for existing agents.md/caws.md in target directory
const existingAgentsMd = fs.existsSync(path.join(targetDir, 'agents.md'));
const existingCawsMd = fs.existsSync(path.join(targetDir, 'caws.md'));
```

### Behavior After Fix

**Scenario 1: Existing agents.md**
```bash
cd test-dir
echo "Custom agents" > agents.md
caws init . --non-interactive

# Output:
# ℹ️  agents.md exists, using caws.md for CAWS guide
# ✅ Added caws.md guide

# Files:
# agents.md (23 bytes) - original preserved
# caws.md (33KB) - CAWS guide
```

**Scenario 2: Both files exist**
```bash
cd test-dir
echo "Custom agents" > agents.md
echo "Custom CAWS" > caws.md
caws init . --non-interactive

# Output:
# ℹ️  agents.md exists, using caws.md for CAWS guide
# ⚠️  Both agents.md and caws.md exist, skipping guide copy

# Files:
# agents.md (custom) - preserved
# caws.md (custom) - preserved
```

**Scenario 3: Interactive mode with conflict**
```bash
cd test-dir
echo "Custom agents" > agents.md
caws init . --interactive

# Prompts:
# ⚠️  agents.md already exists. Overwrite with CAWS guide? (y/N)
#   - If yes: agents.md replaced with CAWS guide
#   - If no: CAWS guide saved as caws.md
```

---

## Test Coverage

Added comprehensive test cases to ensure fixes work correctly:

**New Tests:** `packages/caws-cli/tests/index.test.js`

1. **Test: Initialize in current directory with "."**
   - Creates directory with existing file
   - Runs `caws init . --non-interactive`
   - Verifies `.caws`, `.agent`, `agents.md` created in current dir
   - Verifies NO `-` subdirectory created
   - Verifies existing files preserved

2. **Test: Handle agents.md conflict with caws.md fallback**
   - Creates directory with custom `agents.md`
   - Runs `caws init . --non-interactive`
   - Verifies original `agents.md` preserved
   - Verifies CAWS guide saved as `caws.md`
   - Verifies `caws.md` contains CAWS content (>1000 chars)

3. **Test: Skip guide copy when both files exist**
   - Creates directory with both `agents.md` and `caws.md`
   - Runs `caws init . --non-interactive`
   - Verifies warning message shown
   - Verifies both files preserved unchanged

**Test Results:**
```
Test Suites: 11 passed, 11 total
Tests:       1 skipped, 87 passed, 88 total
```

All tests passing, including 3 new tests for current directory scenarios.

---

## Impact

### Before Fix
- ❌ `caws init .` created unexpected `-` subdirectory
- ❌ Existing `agents.md` not detected in current directory init
- ❌ CAWS guide could overwrite user's custom `agents.md`
- ❌ Confusing for both humans and AI agents

### After Fix
- ✅ `caws init .` correctly initializes in current directory
- ✅ Conflict detection works for all scenarios
- ✅ User files always preserved
- ✅ Clear messages explain what's happening
- ✅ Consistent behavior in interactive and non-interactive modes

---

## Breaking Changes

**None.** These are bug fixes that restore expected behavior. The changes are backward compatible:
- Projects initialized with explicit names (e.g., `caws init my-project`) work exactly as before
- Only `caws init .` behavior changed, and it now works as users would expect

---

## Developer Experience Improvements

### For Humans
- Can now reliably use `caws init .` to add CAWS to existing projects
- Clear feedback about file conflicts
- Choice to preserve or overwrite in interactive mode
- Existing work never silently overwritten

### For AI Agents
- Non-interactive mode handles conflicts intelligently
- Predictable fallback behavior (`caws.md` when `agents.md` exists)
- Clear output messages for logging and parsing
- Fast, deterministic operations

---

## Examples

### Example 1: New Project in Current Directory
```bash
mkdir my-app && cd my-app
npm init -y
echo "console.log('hello')" > index.js

caws init . --non-interactive

# Output:
# 📁 Initializing in current directory
# ℹ️  Created basic CAWS structure
# ✅ Added agents.md guide
# 🎉 Project initialized successfully!

# Structure:
# my-app/
#   .caws/working-spec.yaml
#   .agent/provenance.json
#   agents.md (33KB CAWS guide)
#   package.json (preserved)
#   index.js (preserved)
```

### Example 2: Existing Project with Custom Guide
```bash
cd my-docs-project
# Has custom agents.md for documentation agents

caws init . --non-interactive

# Output:
# 📁 Initializing in current directory
# ℹ️  Created basic CAWS structure
# ℹ️  agents.md exists, using caws.md for CAWS guide
# ✅ Added caws.md guide
# 🎉 Project initialized successfully!

# Structure:
# my-docs-project/
#   .caws/working-spec.yaml
#   .agent/provenance.json
#   agents.md (your custom guide, preserved)
#   caws.md (33KB CAWS guide)
```

### Example 3: AI Agent Workflow
```bash
# Agent receives: "Initialize CAWS in current directory"

caws init . --non-interactive
# Fast (<0.5s), no prompts, predictable output

# Agent parses output:
# ✅ "Added agents.md guide" → CAWS guide available
# OR
# ℹ️ "using caws.md for CAWS guide" → Read caws.md instead

# Agent can now:
# - Read working-spec.yaml for project context
# - Follow CAWS guidelines from agents.md or caws.md
# - Generate provenance for changes
```

---

## Related Files

### Modified
- `packages/caws-cli/src/index.js` - Core initialization logic
- `packages/caws-cli/tests/index.test.js` - Added 3 new test cases

### Tested
- Manual testing: 5 scenarios
- Automated tests: 87 tests passing
- E2E validation: Both human and AI agent workflows

---

## Deployment

**Version:** 2.0.2 (pending release)  
**Release Type:** Patch (bug fixes only)  
**NPM Package:** `@paths.design/caws-cli`

**Installation:**
```bash
npm install -g @paths.design/caws-cli@latest
```

**Verification:**
```bash
caws --version  # Should show 2.0.2
mkdir test && cd test
caws init . --non-interactive
ls -la  # Should see .caws, .agent, agents.md (no '-' directory)
```

---

## Next Steps

1. ✅ Fix implemented
2. ✅ Tests added and passing
3. ✅ Manual testing completed
4. ⏳ Commit changes
5. ⏳ Update version to 2.0.2
6. ⏳ Push to trigger release
7. ⏳ Verify npm publish
8. ⏳ Update documentation

---

## References

- E2E Test Plan: `/tmp/caws-e2e-test-plan.md`
- Test Results: Manual testing session Oct 1, 2025
- Issue Discovery: During comprehensive DX evaluation
- User Request: "Let's fix the existing project and conflict handling issues we found"

