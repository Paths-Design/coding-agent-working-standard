# P1 Priorities - Next Steps Plan

**Date**: October 9, 2025
**Status**: P0 Complete - Planning P1
**Version**: CAWS Extension v1.0.0

---

## P1 Priority Areas

Based on the successful P0 completion, here are the next priorities organized by impact and effort:

### 1. Missing MCP Tools Implementation HIGH PRIORITY

**Status**: 3 MCP tools have no CLI commands yet

| MCP Tool                 | CLI Command              | Status          | Impact                     |
| ------------------------ | ------------------------ | --------------- | -------------------------- |
| `caws_workflow_guidance` | Not implemented       | **P1-CRITICAL** | Core agent workflow        |
| `caws_quality_monitor`   | Not implemented       | **P1-HIGH**     | Real-time quality tracking |
| `caws_test_analysis`     | Exists but not tested | **P1-MEDIUM**   | Budget optimization        |

**Rationale**: These tools are exposed via MCP but have incomplete or missing CLI implementations. This breaks the 1:1 parity principle.

---

### 2. Enhanced Error Handling MEDIUM PRIORITY

**Current State**: Basic error handling exists
**Improvements Needed**:

- Context-aware error messages
- Recovery suggestions
- "Did you mean?" for typos (partially implemented)
- Detailed troubleshooting guides

**Example Enhancement**:

```typescript
// Before
Error: Working spec not found

// After
Error: Working spec not found at .caws/working-spec.yaml

💡 Suggestions:
   1. Initialize CAWS: caws init
   2. Create spec manually: mkdir .caws && touch .caws/working-spec.yaml
   3. Check current directory: pwd

📚 Documentation: https://caws.dev/docs/working-spec
```

---

### 3. Performance Optimization LOW PRIORITY

**Current State**: Fast with bundled CLI (~2s response time)
**Potential Improvements**:

1. **CLI Invocation Caching**
   - Cache recent CLI results
   - Invalidate on file changes
   - Reduce redundant calls

2. **Parallel Tool Execution**
   - Run independent checks in parallel
   - Aggregate results
   - Faster validation cycles

3. **Incremental Validation**
   - Only validate changed sections
   - Skip unchanged parts
   - Smart diffing

**ROI**: Low - current performance is acceptable

---

### 4. Additional CLI Commands FEATURE EXPANSION

**Commands to Implement**:

1. **`caws burnup`** - Budget burn-up reports
   - Already exists in code but not registered
   - Shows scope progress
   - Budget consumption tracking

2. **`caws templates list`** - Template discovery
   - Already implemented
   - List available templates
   - Show template details

3. **`caws workflow`** - Workflow guidance
   - TDD, refactor, feature modes
   - Step-by-step guidance
   - Context-aware suggestions

---

### 5. IDE Integration Enhancements USER EXPERIENCE

**Current State**: Basic MCP integration
**Enhancements**:

1. **VS Code Tasks**
   - Quick access from Command Palette
   - Keyboard shortcuts
   - Task templates

2. **Problem Matchers**
   - Parse CAWS output
   - Show issues in Problems panel
   - Quick-fix suggestions

3. **Status Bar Integration**
   - Show current risk tier
   - Display quality score
   - Quick status check

4. **Inline Diagnostics**
   - Show acceptance criteria in editor
   - Highlight scope violations
   - Real-time quality feedback

---

### 6. Documentation & Examples ADOPTION

**Current State**: Comprehensive guides exist
**Missing**:

1. **Video Tutorials**
   - Getting started (5 min)
   - Advanced workflows (10 min)
   - Troubleshooting (5 min)

2. **More Examples**
   - Real-world project walkthroughs
   - Common patterns
   - Anti-patterns to avoid

3. **Best Practices Guide**
   - Risk tier selection
   - Acceptance criteria writing
   - Test planning strategies

---

## Recommended P1 Roadmap

### Sprint 1: Missing Tools (CRITICAL)

**Duration**: 1-2 days
**Goal**: Achieve 100% CLI/MCP parity

**Tasks**:

1. Implement `caws workflow` command
2. Implement `caws quality-monitor` command
3. Test `caws test-analysis` via MCP
4. Update MCP handlers if needed
5. Verify all tools functional

**Acceptance Criteria**:

- All MCP tools have working CLI commands
- 100% CLI/MCP parity maintained
- All tools tested end-to-end
- Documentation updated

---

### Sprint 2: Error Handling & UX (HIGH)

**Duration**: 2-3 days
**Goal**: Better developer experience

**Tasks**:

1. Enhanced error messages with context
2. Recovery suggestions for common errors
3. Improved "Did you mean?" functionality
4. Add troubleshooting guides
5. Better progress indicators

**Acceptance Criteria**:

- All errors have actionable suggestions
- "Did you mean?" covers all commands
- Progress shown for long operations
- Help text comprehensive

---

### Sprint 3: IDE Integration (MEDIUM)
**Duration**: 3-4 days
**Goal**: Native IDE experience

**Tasks**:

1. VS Code task definitions
2. Problem matchers for CAWS output
3. Status bar integration
4. Command Palette shortcuts
5. Quick-fix providers

**Acceptance Criteria**:

- CAWS commands in Command Palette
- Issues show in Problems panel
- Status bar shows project health
- Keyboard shortcuts configured

---

### Sprint 4: Performance & Polish (LOW)

**Duration**: 2-3 days
**Goal**: Optimize and refine

**Tasks**:

1. CLI result caching
2. Parallel validation
3. Incremental checking
4. Bundle size optimization
5. Memory profiling

**Acceptance Criteria**:

- Response time < 1s for cached operations
- Validation 2x faster
- Memory usage optimized
- No performance regressions

---

## P1-CRITICAL: Missing Tools Deep Dive

Let me analyze what needs to be implemented:

### 1. `caws_workflow_guidance` Tool

**MCP Signature**:

```typescript
{
  workflowType: 'tdd' | 'refactor' | 'feature',
  currentStep: number,
  context?: object
}
```

**CLI Command Needed**:

```bash
caws workflow <type> --step <number> [--context <json>]

# Examples:
caws workflow tdd --step 1
caws workflow refactor --step 3
caws workflow feature --step 2 --context '{"phase":"implementation"}'
```

**Implementation**:

- Create `src/commands/workflow.js`
- Mode-specific guidance (TDD, refactor, feature)
- Step-by-step instructions
- Context-aware suggestions

---

### 2. `caws_quality_monitor` Tool

**MCP Signature**:

```typescript
{
  action: 'file_saved' | 'code_edited' | 'test_run',
  files?: string[],
  context?: object
}
```

**CLI Command Needed**:

```bash
caws quality-monitor <action> [--files <files>] [--context <json>]

# Examples:
caws quality-monitor file_saved --files src/auth.ts
caws quality-monitor test_run
caws quality-monitor code_edited --files "src/*.ts"
```

**Implementation**:

- Create `src/commands/quality-monitor.js`
- Track quality impact of changes
- Real-time feedback
- Alert on quality degradation

---

### 3. `caws_test_analysis` Tool (EXISTS - NEEDS TESTING)

**Current State**: CLI command exists at `test-analysis`
**MCP Handler**: Implemented
**Status**: Not tested in P0

**Need**:

- Verify MCP integration works
- Test all subcommands
- Document usage

---

## Success Metrics

### P1 Sprint 1 (Missing Tools)

- 13/13 MCP tools have CLI implementations (currently 10/13)
- 100% CLI/MCP parity achieved
- All tools tested via MCP
- Response time < 2s for all tools

### P1 Sprint 2 (Error Handling)

- 90%+ errors have actionable suggestions
- User satisfaction score > 4/5
- Reduced support questions by 50%

### P1 Sprint 3 (IDE Integration)

- 5+ VS Code tasks defined
- Problem matcher working for all diagnostics
- Status bar updates in real-time

### P1 Sprint 4 (Performance)

- Cached operations < 1s
- Parallel validation 2x faster
- Memory usage < 100MB

---

## Risks & Mitigation

### Risk 1: Scope Creep

**Mitigation**: Strict sprint boundaries, prioritize ruthlessly

### Risk 2: Breaking Changes

**Mitigation**: Comprehensive test suite, semantic versioning

### Risk 3: Performance Regression

**Mitigation**: Benchmark suite, automated performance testing

---

## Decision Point: Where to Start?

### Option A: Sprint 1 (Missing Tools) - RECOMMENDED

**Pros**:

- Achieves 100% parity (critical)
- Unblocks MCP functionality
- High user impact
- Clear acceptance criteria

**Cons**:

- Requires CLI implementation
- Needs comprehensive testing

### Option B: Sprint 2 (Error Handling)

**Pros**:

- Improves user experience immediately
- Lower complexity
- Builds on existing code

**Cons**:

- Doesn't address parity gap
- Less critical than missing tools

### Option C: Sprint 3 (IDE Integration)

**Pros**:

- Great user experience
- Differentiator

**Cons**:

- Higher complexity
- Can wait until parity is achieved

---

## Recommendation

**Start with P1 Sprint 1: Missing Tools**

**Rationale**:

1. We claimed "100% parity" but only have 10/13 tools working
2. Missing tools are already exposed via MCP (broken promises)
3. Relatively quick implementation (1-2 days)
4. Unblocks users who need these tools
5. Maintains our quality standards

**Next Steps**:

1. Implement `caws workflow` command
2. Implement `caws quality-monitor` command
3. Test `caws test-analysis` integration
4. Update all documentation
5. Test end-to-end via MCP

---

## Questions to Answer

1. **Should we implement all 3 tools or prioritize?**
   - Recommendation: Implement all 3 for true parity

2. **What's the expected timeline?**
   - `caws workflow`: ~4 hours
   - `caws quality-monitor`: ~4 hours
   - Testing: ~2 hours
   - Total: 1 day

3. **Any breaking changes?**
   - No - purely additive features

4. **Documentation updates needed?**
   - Yes - update MCP tool list
   - Yes - add CLI command docs
   - Yes - update test results

---

## Ready to Start?

Let me know if you'd like to:

1. **Start P1 Sprint 1** - Implement missing tools
2. **Refine the plan** - Adjust priorities
3. **Deep dive on specific tool** - More details before starting
4. **Alternative approach** - Different P1 focus

I'm ready to implement when you are!
