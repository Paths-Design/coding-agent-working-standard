# CAWS MCP Tools Test Plan

**Date**: October 9, 2025  
**Version**: After esbuild bundling + CLI path fixes  
**Extension**: `caws-vscode-extension-1.0.0.vsix`

## Pre-Test Setup

- ✅ Extension installed: `caws-vscode-extension-1.0.0.vsix`
- ✅ CLI bundled with esbuild (2.0 MB)
- ✅ All MCP handlers updated to use `../cli/index.js`
- ✅ All command names fixed (`evaluate`, `iterate` not `agent evaluate`)
- ⏳ **REQUIRES CURSOR RESTART** to load new extension

---

## Test Categories

### 1. Core Workflow Tools

| Tool            | Command Called  | Expected Result                         | Status  | Notes                            |
| --------------- | --------------- | --------------------------------------- | ------- | -------------------------------- |
| `caws_init`     | `caws init`     | Project initialized with CAWS structure | ✅ PASS | Created .caws/ + working spec    |
| `caws_scaffold` | `caws scaffold` | Components scaffolded, no ESM errors    | ✅ PASS | **NO ESM ERRORS!** esbuild wins! |
| `caws_validate` | `caws validate` | Validates working spec                  | ✅ PASS | Validated tier 2 spec            |

### 2. Quality & Guidance Tools (NEW)

| Tool                 | Command Called        | Expected Result      | Status  | Notes                        |
| -------------------- | --------------------- | -------------------- | ------- | ---------------------------- |
| `caws_evaluate`      | `caws evaluate`       | Quality score 0-100% | ✅ PASS | Got 80% (Grade B) - Perfect! |
| `caws_iterate`       | `caws iterate`        | Iterative guidance   | ✅ PASS | TDD guidance provided        |
| `caws_waiver_create` | `caws waivers create` | Waiver created       | ✅ PASS | Created WV-6916 successfully |

### 3. Project Health Tools

| Tool            | Command Called  | Expected Result       | Status  | Notes                    |
| --------------- | --------------- | --------------------- | ------- | ------------------------ |
| `caws_status`   | `caws status`   | Health overview       | ✅ PASS | Dashboard displayed      |
| `caws_diagnose` | `caws diagnose` | Health checks + fixes | ✅ PASS | Found 3 issues, auto-fix |

### 4. Provenance & Git Tools

| Tool              | Command Called         | Expected Result      | Status  | Notes                       |
| ----------------- | ---------------------- | -------------------- | ------- | --------------------------- |
| `caws_provenance` | `caws provenance show` | Provenance dashboard | ✅ PASS | Shows "no data" as expected |
| `caws_hooks`      | `caws hooks status`    | Git hooks status     | ✅ PASS | Shows 0/4 hooks active      |

### 5. Test Analysis Tools

| Tool                 | Command Called                     | Expected Result    | Status     | Notes                |
| -------------------- | ---------------------------------- | ------------------ | ---------- | -------------------- |
| `caws_test_analysis` | `caws test-analysis assess-budget` | Budget predictions | ⏳ Pending | Statistical analysis |

---

## Critical Test Scenarios

### Scenario A: Fresh Project Setup

```bash
1. Create test directory
2. Run: caws_init (with projectName=".", template="library")
3. Verify: .caws/ directory created
4. Run: caws_scaffold
5. Verify: No ESM errors (was failing before)
6. Run: caws_validate
7. Verify: Validation passes
```

### Scenario B: Quality Assessment

```bash
1. Navigate to project with working spec
2. Run: caws_evaluate
3. Verify: Receives quality score (0-100%)
4. Run: caws_iterate (with currentState="Tests written")
5. Verify: Receives guidance for next steps
6. Run: caws_status
7. Verify: Health overview displayed
```

### Scenario C: Waiver Management

```bash
1. Run: caws_waiver_create with all required fields
2. Verify: Waiver created with WV-XXXX ID
3. Verify: Stored in .caws/waivers/
```

### Scenario D: Performance Check

```bash
1. Run: caws_status
2. Measure: Response time (should be < 2s with bundled CLI)
3. Compare: Old vs new bundle performance
```

---

## Expected Improvements

### Before Fixes

- ❌ ESM errors in `caws_scaffold`
- ❌ `caws_evaluate` - Command not found
- ❌ `caws_iterate` - Command not found
- ❌ `caws_waiver_create` - Command not found
- ⚠️ Slow response times (unbundled CLI)

### After Fixes

- ✅ No ESM errors (esbuild bundles all dependencies)
- ✅ `caws_evaluate` - Calls `caws evaluate` successfully
- ✅ `caws_iterate` - Calls `caws iterate` successfully
- ✅ `caws_waiver_create` - Calls `caws waivers create` successfully
- ✅ Fast response times (2.0 MB bundled CLI)

---

## Test Execution Steps

1. **Restart Cursor** (critical - loads new extension)
2. Open test project or create new one
3. Execute each tool via MCP (not terminal)
4. Document results in this file
5. Update status: ⏳ Pending → ✅ Pass / ❌ Fail

---

## Known Issues to Watch For

1. **Path issues**: Ensure CLI is called from `../cli/index.js` not `../cli/dist/index.js`
2. **Command names**: Ensure commands are correct (`evaluate` not `agent evaluate`)
3. **ESM conflicts**: Should be resolved by esbuild bundling
4. **Timeouts**: Should be faster with bundled CLI
5. **JSON parsing**: New handlers return raw output (no parsing)

---

## Success Criteria

- ✅ All 13 MCP tools functional
- ✅ No ESM errors
- ✅ Response times < 2s
- ✅ New commands (`evaluate`, `iterate`, `waivers`) work
- ✅ 1:1 parity with CLI commands

---

## Next Steps After Testing

1. Document any failures
2. Create follow-up tasks for fixes
3. Update P0 completion document
4. Plan P1 priorities if all P0 tests pass
