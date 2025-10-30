# CAWS Tools Improvement Plan

**Date:** October 30, 2025  
**Status:** Implementation Plan  
**Priority:** Critical Fixes Required

## Executive Summary

Combining diagnostic analysis and developer feedback, we've identified **5 critical issues** and **3 high-priority improvements** that need to be addressed to improve CAWS tool reliability and user experience.

## Priority 1: Critical Fixes (Breaking Functionality)

### Fix 1.1: MCP Server ES Module `__filename` Error

**Status:** ❌ Broken  
**Impact:** Blocks quality gates via MCP server  
**Effort:** Low (15 minutes)

**Issue:**
- `packages/caws-mcp-server/index.js:1147` uses `__filename` in ES module
- ES modules don't have `__filename` - need `import.meta.url`

**Fix:**
```javascript
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
```

**Files to Modify:**
- `packages/caws-mcp-server/index.js`

---

### Fix 1.2: Pre-Commit Hook Fallback Chain

**Status:** ❌ Blocking Commits  
**Impact:** Prevents all commits when quality gates script missing  
**Effort:** Medium (30 minutes)

**Issue:**
- Hooks expect `scripts/quality-gates/run-quality-gates.js` that doesn't exist
- No fallback to CLI or Python scripts
- Blocks commits unnecessarily

**Fix:**
Implement fallback chain:
1. Check for Node.js script
2. Fallback to `caws` CLI
3. Fallback to `make caws-gates` or Python scripts
4. Skip gracefully if none available (warn only)

**Files to Modify:**
- `packages/caws-cli/templates/.git/hooks/pre-commit`
- `packages/caws-cli/src/scaffold/index.js` (hook generation)

---

### Fix 1.3: MCP Validate Tool - Detect Existing CLI

**Status:** ⚠️ Inefficient  
**Impact:** Tries npx even when CLI installed globally  
**Effort:** Low (15 minutes)

**Issue:**
- `caws_validate()` MCP tool always uses `npx @paths.design/caws-cli`
- Should detect existing `caws` CLI installation first

**Fix:**
```javascript
// Detect existing CLI
const cawsPath = which('caws') || 'npx @paths.design/caws-cli';
```

**Files to Modify:**
- `packages/caws-mcp-server/index.js` (handleValidate function)

---

## Priority 2: High-Priority Improvements (UX Issues)

### Fix 2.1: CLI Quality Gates Path Resolution

**Status:** ⚠️ Works but Limited  
**Impact:** Fails when CLI installed globally  
**Effort:** Medium (45 minutes)

**Issue:**
- Assumes monorepo structure
- Doesn't check for project-local scripts
- Error message doesn't provide alternatives

**Fix:**
1. Check monorepo path first (current behavior)
2. Check for `@paths.design/quality-gates` in node_modules
3. Check for project-local scripts (`scripts/simple_gates.py`, `Makefile`)
4. Provide clear error with all options

**Files to Modify:**
- `packages/caws-cli/src/commands/quality-gates.js`

---

### Fix 2.2: Standardize Policy File Location

**Status:** ⚠️ Confusing  
**Impact:** Users see warnings about missing policy.yaml  
**Effort:** Low (20 minutes)

**Issue:**
- CLI expects `.caws/policy.yaml`
- Some initialization creates `.caws/policy/tier-policy.json`
- Two different formats/locations

**Fix:**
1. Standardize on `.caws/policy.yaml` (YAML format)
2. Update CLI to check both locations for backward compatibility
3. Update initialization to always create `.caws/policy.yaml`
4. Document migration path if needed

**Files to Modify:**
- `packages/caws-cli/src/policy/PolicyManager.js`
- `packages/caws-cli/src/commands/init.js`
- `packages/caws-cli/src/scaffold/index.js`

---

### Fix 2.3: Quality Gates Installation Clarity

**Status:** ⚠️ Unclear  
**Impact:** Users don't know how to install quality gates  
**Effort:** Medium (30 minutes)

**Issue:**
- Quality gates require separate package
- No clear installation instructions
- Error messages don't explain how to fix

**Fix:**
1. Add `caws scaffold --with-quality-gates` option
2. Improve error messages with installation instructions
3. Add fallback detection for Python scripts
4. Document in CLI help

**Files to Modify:**
- `packages/caws-cli/src/commands/scaffold.js`
- `packages/caws-cli/src/commands/quality-gates.js`
- `packages/caws-cli/README.md`

---

## Priority 3: Documentation & Polish

### Fix 3.1: Update Usage Guides

**Status:** ⚠️ Outdated  
**Impact:** Users confused about which tool to use  
**Effort:** Low (20 minutes)

**Fix:**
- Update docs with fallback chain information
- Clarify when to use CLI vs MCP vs Python scripts
- Add troubleshooting section

**Files to Modify:**
- `docs/agents/full-guide.md`
- `docs/guides/multi-agent-workflow.md`
- `packages/caws-cli/README.md`

---

## Implementation Order

### Phase 1: Critical Fixes (Day 1)
1. ✅ Fix MCP Server `__filename` error
2. ✅ Fix Pre-commit hook fallback chain
3. ✅ Fix MCP validate CLI detection

### Phase 2: High Priority (Day 2)
4. ✅ Improve CLI quality gates path resolution
5. ✅ Standardize policy file location
6. ✅ Add quality gates installation clarity

### Phase 3: Documentation (Day 3)
7. ✅ Update usage guides and troubleshooting

---

## Testing Strategy

### Unit Tests
- Test ES module path resolution
- Test fallback chain logic
- Test policy file detection

### Integration Tests
- Test MCP server quality gates execution
- Test pre-commit hook with various setups
- Test CLI quality gates from different contexts

### Manual Testing
- Test from monorepo root
- Test with globally installed CLI
- Test with Python-only setup
- Test pre-commit hook behavior

---

## Success Criteria

### Fix 1.1: MCP Server
- ✅ `caws_quality_gates_run()` works without errors
- ✅ Quality gates execute successfully via MCP

### Fix 1.2: Pre-Commit Hook
- ✅ Hook doesn't block commits when script missing
- ✅ Falls back gracefully through chain
- ✅ Provides clear warnings

### Fix 1.3: MCP Validate
- ✅ Detects existing CLI installation
- ✅ Uses `caws` command instead of npx when available

### Fix 2.1: CLI Quality Gates
- ✅ Works from monorepo root
- ✅ Works with globally installed CLI (fallback to Python)
- ✅ Provides clear error messages with alternatives

### Fix 2.2: Policy Files
- ✅ Consistent policy file location
- ✅ Backward compatibility maintained
- ✅ No warnings about missing files

### Fix 2.3: Quality Gates Installation
- ✅ Clear installation instructions
- ✅ Scaffold option available
- ✅ Helpful error messages

---

## Rollback Plan

If any fix causes issues:

1. **MCP Server Fix:** Revert to previous version, use CLI directly
2. **Pre-Commit Hook:** Users can use `--no-verify` temporarily
3. **Policy Files:** Support both formats during transition

---

## Notes

- All fixes maintain backward compatibility where possible
- Error messages should be helpful and actionable
- Fallback chains should be graceful (warn, don't block)
- Documentation updates should be comprehensive


