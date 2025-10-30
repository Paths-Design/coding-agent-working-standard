# CAWS Tools Diagnostic Report

**Date:** October 30, 2025  
**Status:** Issues Identified - Review Required

## Executive Summary

After reviewing the agent's CAWS tool execution, three main issues were identified:

1. **MCP Server Quality Gates Error**: `__filename` undefined in ES modules
2. **Pre-commit Hook Path Mismatch**: Looking for non-existent Node.js script
3. **CLI Quality Gates Path Resolution**: Works but expects monorepo structure

## Issue 1: MCP Server `__filename` Error

### Problem

The MCP server's `handleQualityGatesRun` function uses `__filename` which is not available in ES modules.

**Location:** `packages/caws-mcp-server/index.js:1147`

```javascript
const qualityGatesPath = path.join(
  path.dirname(path.dirname(__filename)), // ❌ __filename undefined in ES modules
  '..',
  '..',
  'packages',
  'quality-gates',
  'run-quality-gates.mjs'
);
```

### Root Cause

- MCP server uses ES modules (`import.meta.url` visible at line 3158)
- `__filename` is a CommonJS variable, not available in ES modules
- Should use `import.meta.url` with `fileURLToPath()` instead

### Expected Fix

```javascript
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const qualityGatesPath = path.join(
  path.dirname(path.dirname(__filename)),
  '..',
  '..',
  'packages',
  'quality-gates',
  'run-quality-gates.mjs'
);
```

### Impact

- `caws_quality_gates_run` MCP tool fails with "`__filename` is not defined"
- Quality gates cannot be run via MCP server
- Workaround: Use CLI directly or Python scripts

---

## Issue 2: Pre-commit Hook Path Mismatch (kokoro-onnx)

### Problem

The kokoro-onnx pre-commit hook references a Node.js quality gates script that doesn't exist.

**Location:** `kokoro-onnx/.git/hooks/pre-commit`

**Expected by hook:**

```bash
node scripts/quality-gates/run-quality-gates.js  # ❌ File doesn't exist
```

**Actual available scripts:**

- `scripts/simple_gates.py` ✅ (Python script)
- `make caws-gates` ✅ (calls Python script)

### Root Cause

- Pre-commit hook was likely copied from a template or different project
- Hook expects Node.js script, but kokoro-onnx uses Python scripts
- Hook doesn't check if file exists before running

### Current Hook Behavior

The hook at `kokoro-onnx/.git/hooks/pre-commit` actually doesn't try to run quality gates (lines 30-55 only check for package.json and run eslint/tests). However, the agent's output mentioned a hook trying to run `scripts/quality-gates/run-quality-gates.js`.

**Possible explanation:** There may be a different hook or the hook was modified during the session.

### Expected Fix

Update the hook to use Python scripts or check for file existence:

```bash
# Option 1: Use Python script
if [ -f "scripts/simple_gates.py" ]; then
  python3 scripts/simple_gates.py all --tier 2 --profile backend-api || exit 1
fi

# Option 2: Use Makefile target
if [ -f "Makefile" ]; then
  make caws-gates || exit 1
fi
```

### Impact

- Pre-commit hooks may fail if trying to run quality gates
- Commits blocked if hook enforces quality gates
- Workaround: `git commit --no-verify` (not recommended)

---

## Issue 3: CLI Quality Gates Path Resolution

### Problem

The CLI's `quality-gates` command uses `__filename` to resolve paths, which works but assumes a specific monorepo structure.

**Location:** `packages/caws-cli/src/commands/quality-gates.js:393`

```javascript
const cliSrcDir = path.dirname(__filename); // CommonJS - works ✅
const cliSrcRoot = path.dirname(cliSrcDir);
const cliPackageDir = path.dirname(cliSrcRoot);
const packagesDir = path.dirname(cliPackageDir);
const qualityGatesRunner = path.join(packagesDir, 'quality-gates', 'run-quality-gates.mjs');
```

### Current Behavior

- Works correctly when CLI is installed as part of monorepo
- Assumes structure: `packages/caws-cli/src/commands/quality-gates.js` → `packages/quality-gates/run-quality-gates.mjs`
- Fails when CLI is installed globally via npm (`@paths.design/caws-cli`)

### Error Message

```
❌ Quality gates runner not found at:
   /Users/drosebrook/.nvm/versions/node/v23.11.1/lib/node_modules/@paths.design/quality-gates/run-quality-gates.mjs
💡 Run from project root or ensure quality gates are installed
```

### Root Cause

When installed globally:

- `__filename` resolves to: `/Users/drosebrook/.nvm/.../node_modules/@paths.design/caws-cli/dist/commands/quality-gates.js`
- Path resolution assumes monorepo structure doesn't exist
- `quality-gates` package is separate and not installed globally

### Expected Behavior

The CLI should:

1. Check if running from monorepo (path resolution works)
2. If not, check if `quality-gates` package is available locally
3. Fall back to project-local scripts if available
4. Provide clear error message with all options

### Impact

- `caws quality-gates run` fails when CLI installed globally
- Works fine when run from monorepo root
- Workaround: Use Python scripts or run from monorepo

---

## Issue 4: Working Spec YAML Validation

### Problem

Working spec had YAML syntax error with `.pyc` pattern.

**Fixed:** Changed from `.pyc` to `"**/*.pyc"` (proper YAML string)

### Status

✅ **RESOLVED** - Fixed by agent during session

---

## Comparison: CLI vs MCP vs Python Scripts

| Tool                                   | Status     | Use Case           | Notes                             |
| -------------------------------------- | ---------- | ------------------ | --------------------------------- |
| **CLI (`caws quality-gates`)**         | ⚠️ Partial | From monorepo root | Works in monorepo, fails globally |
| **MCP (`caws_quality_gates_run`)**     | ❌ Broken  | Via MCP server     | `__filename` ES module issue      |
| **Python (`scripts/simple_gates.py`)** | ✅ Working | From project root  | Most reliable option              |
| **Makefile (`make caws-gates`)**       | ✅ Working | From project root  | Wrapper around Python script      |

### Recommended Usage

**For kokoro-onnx project:**

```bash
# Primary method
make caws-gates

# Alternative
python3 scripts/simple_gates.py all --tier 2 --profile backend-api
```

**For CAWS monorepo:**

```bash
# From monorepo root
caws quality-gates

# Or use Python fallback
python3 scripts/simple_gates.py all --tier 2 --profile backend-api
```

---

## Files Requiring Fixes

### Priority 1: Critical (Breaks Functionality)

1. **`packages/caws-mcp-server/index.js:1147`**
   - Replace `__filename` with ES module equivalent
   - Use `import.meta.url` and `fileURLToPath()`

### Priority 2: High (Improves Reliability)

2. **`packages/caws-cli/src/commands/quality-gates.js:393-397`**
   - Add fallback path resolution for global installs
   - Check for project-local quality gates scripts
   - Improve error messages

3. **`kokoro-onnx/.git/hooks/pre-commit`** (if modified)
   - Update to use Python scripts instead of Node.js
   - Add file existence checks before running

### Priority 3: Medium (Documentation)

4. **Documentation updates**
   - Update usage guides to clarify when to use which tool
   - Add troubleshooting section for path resolution issues
   - Document ES module vs CommonJS differences

---

## Testing Recommendations

### Test Cases

1. **MCP Server ES Module Fix**

   ```javascript
   // Test: Run quality gates via MCP server
   // Expected: Should work without __filename error
   ```

2. **CLI Global Install**

   ```bash
   # Test: Install CLI globally, run from external project
   # Expected: Should detect local scripts or provide clear error
   ```

3. **Pre-commit Hook**
   ```bash
   # Test: Commit changes in kokoro-onnx
   # Expected: Should use Python scripts or skip gracefully
   ```

---

## Root Cause Analysis

### Why These Issues Exist

1. **ES Module Migration**: MCP server uses ES modules but code still references CommonJS variables
2. **Monorepo Assumptions**: CLI assumes monorepo structure instead of checking for alternatives
3. **Template Mismatch**: Pre-commit hooks copied from templates don't match project structure
4. **Path Resolution**: Hard-coded path resolution instead of dynamic detection

### Patterns to Avoid

- ❌ Using `__filename` in ES modules
- ❌ Hard-coding monorepo paths
- ❌ Copying hooks without customization
- ❌ Assuming single installation method

### Patterns to Follow

- ✅ Use `import.meta.url` in ES modules
- ✅ Detect project structure dynamically
- ✅ Customize hooks per project
- ✅ Support multiple installation methods

---

## Next Steps

1. **Fix MCP Server** (Priority 1)
   - Replace `__filename` with ES module equivalent
   - Test with MCP client

2. **Improve CLI Path Resolution** (Priority 2)
   - Add fallback detection logic
   - Test with global installs

3. **Update Pre-commit Hook** (Priority 2)
   - Use Python scripts for kokoro-onnx
   - Add proper error handling

4. **Documentation** (Priority 3)
   - Update usage guides
   - Add troubleshooting section

---

## Summary

Most CAWS tools work correctly, but three path resolution issues prevent quality gates from running in certain contexts:

- ✅ **CLI validation**: Working
- ✅ **CLI evaluate**: Working
- ✅ **CLI status**: Working
- ✅ **CLI diagnose**: Working
- ✅ **Python scripts**: Working
- ⚠️ **CLI quality-gates**: Works in monorepo only
- ❌ **MCP quality-gates**: Broken (ES module issue)
- ⚠️ **Pre-commit hooks**: May reference wrong paths

The primary blocker is the MCP server ES module issue. Once fixed, quality gates should work via both CLI and MCP server.
