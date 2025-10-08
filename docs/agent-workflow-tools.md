# CAWS Agent Workflow Tools Guide

This guide shows agents how to use CAWS tools to navigate quality gates and achieve their objectives without violating guardrails.

## 🚫 When You Get Blocked: Actionable Solutions

### **Block: "Cannot edit .caws/policy.yaml"**

**Why blocked**: Policy files require human dual-control to prevent silent bypass.

**Approved workflow**:

```bash
# 1. Check current budget status
caws burnup

# 2. Create a waiver for budget exception
caws waivers create \
  --title="Budget exception for [describe work]" \
  --reason=architectural_refactor \
  --description="Detailed explanation of why budget increase needed" \
  --gates=budget_limit \
  --expires-at="2025-12-31T23:59:59Z" \
  --approved-by="developer-name" \
  --impact-level=medium \
  --mitigation-plan="How you'll address the underlying issue"

# 3. Reference waiver in working spec
# Edit .caws/working-spec.yaml and add:
waiver_ids: ["WV-XXXX"]  # Replace with actual waiver ID

# 4. Validate your changes
caws validate .caws/working-spec.yaml
```

---

### **Block: "Cannot add change_budget to working-spec.yaml"**

**Why blocked**: Budgets must be derived from policy, not directly editable.

**Approved workflow**:

```bash
# 1. Check current budget vs usage
caws burnup

# 2. Create waiver if over budget
caws waivers create \
  --title="Scope expansion for [feature]" \
  --reason=architectural_refactor \
  --gates=budget_limit \
  --delta-max-files=10 \
  --delta-max-loc=1000 \
  --expires-at="2025-12-31T23:59:59Z"

# 3. Add waiver reference to spec
# In .caws/working-spec.yaml:
waiver_ids: ["WV-XXXX"]

# 4. Validate and proceed
caws validate .caws/working-spec.yaml
```

---

### **Block: "File access outside CAWS scope"**

**Why blocked**: Work must stay within defined scope boundaries.

**Approved workflow**:

```bash
# 1. Check current scope definition
caws validate .caws/working-spec.yaml

# 2. Option A: Update scope in working spec
# Edit .caws/working-spec.yaml scope.in array to include needed files

# Option B: Create scope waiver
caws waivers create \
  --title="Scope expansion for [file/directory]" \
  --reason=architectural_refactor \
  --gates=scope_boundary \
  --description="Need access to [specific files] for [reason]"

# 3. Validate scope changes
caws validate .caws/working-spec.yaml
```

---

### **Block: "Policy + code changes in same PR"**

**Why blocked**: Governance changes must be isolated and approved separately.

**Approved workflow**:

```bash
# 1. Create separate PR for policy changes
# Move waiver/policy changes to dedicated PR

# 2. For budget issues, create waiver in separate PR
caws waivers create \
  --title="Budget exception" \
  --reason=architectural_refactor \
  --gates=budget_limit

# 3. Reference waiver in main work PR
# In working-spec.yaml of main PR:
waiver_ids: ["WV-XXXX"]
```

---

## 🛠️ Essential CAWS Tools for Agents

### **caws validate** - Check compliance

```bash
# Validate working spec
caws validate .caws/working-spec.yaml

# Check if file is in scope
caws validate .caws/working-spec.yaml --scope-check "path/to/file"
```

### **caws burnup** - Budget visibility

```bash
# See current budget vs usage
caws burnup

# Output shows:
# - Baseline budget (from policy)
# - Effective budget (with waivers)
# - Current usage percentage
# - Warnings when approaching limits
```

### **caws waivers create** - Request exceptions

```bash
# Full waiver creation
caws waivers create \
  --title="Clear description" \
  --reason=architectural_refactor \
  --description="Why needed + mitigation" \
  --gates=budget_limit \
  --expires-at="2025-12-31T23:59:59Z" \
  --approved-by="agent-handle"
```

### **caws agent evaluate** - Quality assessment

```bash
# Get structured evaluation
caws agent evaluate

# Returns JSON with:
# - Overall quality score
# - Specific gate results
# - Actionable improvement suggestions
```

### **caws agent iterate** - Iterative guidance

```bash
# Get next steps for current work
caws agent iterate

# Returns JSON with:
# - Current status assessment
# - Recommended next actions
# - Quality gate status
```

---

## 🔄 Complete Agent Workflow

### **Daily Development Loop**:

1. **Start work**: `caws agent evaluate` to check current status
2. **Plan changes**: Reference waiver_ids if budget exceptions needed
3. **Implement**: Stay within scope and budget limits
4. **Validate**: `caws validate` frequently to catch issues early
5. **Check budget**: `caws burnup` when approaching complexity limits
6. **Get guidance**: `caws agent iterate` for next steps
7. **Handle blocks**: Use appropriate waiver creation workflow

### **When Budget Issues Arise**:

1. **Assess**: `caws burnup` to understand current vs limit
2. **Waiver**: `caws waivers create` with proper justification
3. **Reference**: Add waiver_ids to working spec
4. **Validate**: `caws validate` to confirm waiver acceptance
5. **Proceed**: Continue work within new effective budget

### **When Scope Issues Arise**:

1. **Check scope**: `caws validate --scope-check "file"`
2. **Update spec**: Add needed files to scope.in OR
3. **Create waiver**: For exceptional scope expansions
4. **Validate**: Confirm scope compliance

---

## ⚡ Quick Reference Commands

| Situation             | Command                                      | Purpose                        |
| --------------------- | -------------------------------------------- | ------------------------------ |
| Check budget status   | `caws burnup`                                | See usage vs limits            |
| Validate work         | `caws validate`                              | Check compliance               |
| Need budget exception | `caws waivers create --gates=budget_limit`   | Request budget waiver          |
| Need scope exception  | `caws waivers create --gates=scope_boundary` | Request scope waiver           |
| Get evaluation        | `caws agent evaluate`                        | Structured quality assessment  |
| Get next steps        | `caws agent iterate`                         | Iterative development guidance |
| Check scope           | `caws validate --scope-check "file"`         | Verify file access             |

---

## 🎯 Agent Operating Principles

1. **Prevention over cure**: Use `caws validate` and `caws burnup` proactively
2. **Waivers are normal**: Budget/scope exceptions happen - just follow the process
3. **Dual control**: Policy changes require human approval - respect this
4. **Transparency**: All exceptions are auditable and time-bound
5. **Iterative**: Use `caws agent iterate` to maintain quality throughout work

**Remember**: CAWS tools exist to help you succeed within quality constraints, not to prevent success. The guardrails guide you to the proper path for achieving your objectives safely and sustainably.

---

## 📊 Advanced Test Analysis (Future Enhancement)

### **Vision: Learning Quality System**

**CAWS Test Analysis learns from quality gate failures and waivers to continuously improve budget allocation, test selection, and risk assessment.**

### **What We're Looking For**

#### **Key Outcomes**

- **70-80% accuracy** in predicting budget overruns before they happen
- **50% reduction** in unnecessary test execution through smart selection
- **Proactive risk alerts** when similar projects historically needed waivers
- **Continuous improvement** as the system learns from each quality gate violation

#### **Example User Experience**

```bash
# Before starting work, get intelligent guidance
$ caws test-analysis assess-budget --spec .caws/working-spec.yaml
📊 Budget Assessment for FEAT-0123 (Tier 2)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Historical Analysis: 45 similar projects analyzed
🎯 Recommended Budget: 120 files, 12,000 LOC (+20% buffer)
💡 Rationale: Similar API features needed 18% extra for comprehensive testing
⚠️ Risk Factors: Complex state management (80% of overruns)
✅ Confidence: High (78% prediction accuracy)

# During development, optimize test runs
$ caws test-analysis select-tests --changes diff.patch --time-budget 5m
🎯 Smart Test Selection (5min budget)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Priority Tests (85% issue detection rate):
  ✅ api/user-management.test.js (2.1s, catches 40% of auth bugs)
  ✅ state/validation.test.js (1.8s, catches 35% of data bugs)
  ✅ integration/user-flow.test.js (0.9s, catches 25% of flow bugs)

Skipped: 12 low-value tests (saves 3.2min, 2% false negative risk)
```

### **Core Components**

#### **1. Waiver Pattern Learning Engine**

```javascript
// What it does: Analyzes waiver history to find systematic patterns
class WaiverPatternLearner {
  analyzePatterns(waivers, specs) {
    return {
      budget_overruns: {
        by_feature_type: { api: +25%, ui: +10%, data: +40% },
        by_tech_stack: { react: +15%, node: +20% },
        by_team_size: { small: +5%, large: +35% }
      },
      common_reasons: [
        { reason: 'test_coverage', frequency: 0.35, avg_overrun: 1200 },
        { reason: 'integration_complexity', frequency: 0.28, avg_overrun: 800 }
      ]
    };
  }
}
```

#### **2. Project Similarity Matcher**

```javascript
// What it does: Finds historical projects similar to current work
class ProjectSimilarityMatcher {
  findSimilarProjects(currentSpec, historicalSpecs) {
    return historicalSpecs
      .map((project) => ({
        project: project.id,
        similarity_score: calculateSimilarity(currentSpec, project),
        budget_accuracy: project.actual_budget / project.allocated_budget,
        waiver_count: project.waivers.length,
      }))
      .filter((p) => p.similarity_score > 0.7)
      .sort((a, b) => b.similarity_score - a.similarity_score);
  }
}
```

#### **3. Test Effectiveness Scorer**

```javascript
// What it does: Learns which tests catch which types of issues
class TestEffectivenessScorer {
  scoreTests(testResults, waivers) {
    return testResults.map((test) => ({
      test: test.name,
      effectiveness_score: calculateEffectiveness(test, waivers),
      issue_types_caught: ['auth', 'data', 'performance'],
      avg_runtime: test.duration,
      false_positive_rate: test.falsePositives / test.totalRuns,
    }));
  }
}
```

### **Why This Fits CAWS Big Picture**

#### **1. Closes the Learning Loop**

- **Current CAWS**: Quality gates prevent bad practices
- **With Analysis**: System learns WHY gates were triggered and prevents similar issues proactively
- **Result**: Quality gates become smarter over time

#### **2. Addresses Budget Inaccuracy Pain Point**

- **Problem**: Static risk tiers often wrong (±50% accuracy)
- **Solution**: Statistical analysis of similar projects (±75% accuracy)
- **Impact**: Fewer waiver requests, better planning

#### **3. Optimizes CI/CD Performance**

- **Problem**: All tests run on every change (slow, expensive)
- **Solution**: Run only high-value tests based on change type
- **Impact**: 50% faster feedback loops, lower cloud costs

#### **4. Scales with Team Growth**

- **Small teams**: Basic correlations provide value
- **Large teams**: Rich historical data enables precise predictions
- **Enterprise**: Automated budget allocation and risk assessment

### **Implementation Roadmap**

#### **Phase 1: Correlation Analysis (v0.1 - ✅ IMPLEMENTED)**

- ✅ Waiver pattern analysis (`caws test-analysis analyze-patterns`)
- ✅ Basic project similarity matching (`caws test-analysis find-similar`)
- ✅ Statistical budget predictions (`caws test-analysis assess-budget`)
- **Target**: 70% prediction accuracy
- **Status**: Working with waiver data, ready for historical project data

#### **Phase 2: Test Effectiveness (v0.2)**

- Test result correlation with issues found
- Smart test selection algorithms
- Runtime optimization
- **Target**: 50% test time reduction

#### **Phase 3: ML Enhancement (v1.0 - Optional)**

- Neural networks for complex pattern recognition
- Natural language processing for spec analysis
- Predictive risk modeling
- **Target**: 85%+ prediction accuracy

### **Success Metrics**

#### **Quantitative**

- **Prediction Accuracy**: >75% for budget overrun prediction
- **Test Optimization**: >50% reduction in CI time for equivalent coverage
- **Waiver Reduction**: >30% fewer waivers through better initial budgets

#### **Qualitative**

- **Developer Experience**: "CAWS predicted our exact budget needs"
- **Team Velocity**: "CI runs 3x faster with same confidence"
- **Quality Gates**: "Gates now prevent issues before they happen"

### **Technical Architecture**

#### **Data Sources**

- Waiver history (`.caws/waivers/`)
- Working specs (`.caws/working-spec.yaml`)
- Test results (CI artifacts)
- Git history (change patterns)

#### **Storage Strategy**

- Local JSON files for team data
- Optional cloud sync for enterprise features
- Compression for historical archives

#### **Privacy & Security**

- All analysis local-first
- No code/content sent externally
- Team controls data sharing

This feature transforms CAWS from a **static quality gate system** into a **learning quality intelligence platform** that gets smarter with every project.
