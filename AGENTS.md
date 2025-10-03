# CAWS - Quick Reference Guide

**Coding Agent Workflow System** - Engineering-grade operating system for AI-assisted development

---

## 🎯 Quick Start

### Initialize CAWS
```bash
# Interactive wizard (recommended)
caws init --interactive

# Direct template
caws init my-project --template=extension

# Current directory
caws init .
```

### Validate & Verify
```bash
# Check your working spec
caws validate --suggestions

# Auto-fix safe issues
caws validate --auto-fix

# Scaffold additional tools
caws scaffold --minimal
```

### Cursor Hooks (Real-Time Quality)

CAWS integrates with Cursor IDE for real-time quality gates:

```bash
# Enabled automatically during `caws init --interactive`
# Or add to existing project:
caws scaffold
```

**What Cursor hooks provide**:
- Real-time validation as you code
- Blocks dangerous commands (`rm -rf /`, force push to main)
- Prevents reading secrets (`.env`, private keys)
- Auto-formats code after edits
- Enforces naming conventions
- Logs all AI interactions for provenance

**Temporarily disable**: Cursor Settings → Hooks → Disable

**Note**: Cursor hooks complement (don't replace) git hooks and CI/CD

---

## 🏗️ Core Framework

### Risk Tiers (Choose Based on Impact)

| Tier | Use Case | Coverage | Mutation | Contracts | Review |
|------|----------|----------|----------|-----------|---------|
| **🔴 T1** | Auth, billing, migrations | 90%+ | 70%+ | Required | Manual |
| **🟡 T2** | Features, APIs, data writes | 80%+ | 50%+ | Required | Optional |
| **🟢 T3** | UI, internal tools | 70%+ | 30%+ | Optional | Optional |

### Required Files

#### `.caws/working-spec.yaml`
```yaml
id: PROJ-001
title: "Feature description"
risk_tier: 2                    # 1, 2, or 3
mode: feature                   # feature|refactor|fix|doc|chore
change_budget:
  max_files: 25
  max_loc: 1000
blast_radius:
  modules: ["core", "api"]
  data_migration: false
operational_rollback_slo: "5m"
scope:
  in: ["src/", "package.json"]
  out: ["node_modules/"]
invariants:
  - "System maintains data consistency"
acceptance:
  - id: "A1"
    given: "Current state"
    when: "Action occurs"
    then: "Expected result"
non_functional:
  a11y: ["keyboard", "screen-reader"]
  perf: { api_p95_ms: 250 }
  security: ["validation", "auth"]
contracts:
  - type: "openapi"
    path: "docs/api.yaml"
```

#### `.caws/policy/tier-policy.json`
```json
{
  "packages": {
    "src/": { "tier": 2, "coverage": 80, "mutation": 50 },
    "tests/": { "tier": 2, "coverage": 90, "mutation": 70 }
  },
  "budgets": {
    "performance": { "api_p95_ms": 250 },
    "accessibility": ["WCAG_2.1_AA"],
    "security": ["sast_scan", "secret_scan"]
  }
}
```

### Key Invariants

1. **Atomic Changes**: Stay within change budget and scope
2. **In-Place Refactors**: Use codemods, no shadow files
3. **Deterministic Code**: Testable with controlled randomness
4. **Secure Prompts**: No secrets in AI context
5. **Provenance**: Track AI-assisted changes

---

## 🔧 CLI Commands

### Initialization
```bash
caws init <name>           # Create new project
caws init .               # Initialize in current directory
caws init --interactive   # Guided setup wizard
caws init --template=extension  # Use project template
```

### Development
```bash
caws validate              # Check working spec
caws validate --suggestions # Show helpful error messages
caws validate --auto-fix   # Fix safe validation issues
caws scaffold              # Add CAWS tools
caws scaffold --minimal    # Only essential components
caws scaffold --with-oidc  # Include publishing setup
```

### Quality Gates
```bash
# In CI: validate spec
caws validate --quiet

# Manual: run all gates
npm run verify

# Individual gates
npm run test:coverage
npm run test:mutation
npm run test:contract
```

---

## 📋 Development Workflow

### 1. Plan First
- Create `.caws/working-spec.yaml`
- Define acceptance criteria (GIVEN/WHEN/THEN)
- Set risk tier and change budget
- Identify scope and invariants

### 2. Implement with Tests
- Write tests first (TDD)
- Stay within change budget
- Follow acceptance criteria
- Maintain system invariants

### 3. Verify Quality
- Run validation: `caws validate`
- Execute tests: `npm test`
- Check coverage and mutation scores
- Manual review for Tier 1 changes

### 4. Document & Deploy
- Update working spec if scope changes
- Generate provenance manifest
- Deploy with rollback plan ready

---

## 🎨 Project Templates

### VS Code Extension
```bash
caws init my-extension --template=extension
```
- Risk tier: 2 (high user impact)
- Focus: Webview security, activation performance
- Budget: 25 files, 1000 lines
- Invariants: CSP enforcement, <1s activation

### React Library
```bash
caws init my-lib --template=library
```
- Risk tier: 2 (API stability)
- Focus: Bundle size, TypeScript exports
- Budget: 20 files, 800 lines
- Invariants: Tree-shakeable, no runtime deps

### API Service
```bash
caws init my-api --template=api
```
- Risk tier: 1 (data integrity)
- Focus: Backward compatibility, performance
- Budget: 40 files, 1500 lines
- Invariants: API contracts, data consistency

### CLI Tool
```bash
caws init my-cli --template=cli
```
- Risk tier: 3 (low risk)
- Focus: Error handling, help text
- Budget: 15 files, 600 lines
- Invariants: Exit codes, clear messages

---

## 🔍 Quality Gates

### Coverage Requirements
- **Branch Coverage**: T1 ≥90%, T2 ≥80%, T3 ≥70%
- **Mutation Score**: T1 ≥70%, T2 ≥50%, T3 ≥30%
- **Contract Tests**: Required for T1/T2 with external APIs
- **E2E Tests**: Required for T1, optional for T2/T3

### Validation Rules
- ID format: `PREFIX-NUMBER` (e.g., `FEAT-123`)
- Scope: Must specify `in` and `out` directories
- Invariants: At least 2-4 system guarantees
- Acceptance: At least one GHERKIN-style criterion
- Contracts: Required for T1/T2 if external APIs

### Performance Budgets
- API p95 latency: Default 250ms (configurable)
- Bundle size: Library default 50KB
- Accessibility: WCAG 2.1 AA compliance
- Security: SAST scan + secret detection

---

## 🚨 Common Issues & Fixes

### Validation Errors
```bash
# Missing required field
❌ Validation failed: invariants is required
💡 Add 1-3 statements about what must always remain true

# Wrong risk tier
❌ Validation failed: risk_tier must be 1, 2, or 3
💡 Tier 1: Critical, Tier 2: Standard, Tier 3: Low risk
🔧 Can auto-fix: run with --auto-fix

# Invalid ID format
❌ Validation failed: id format invalid
💡 Use format like: PROJ-001, FEAT-002, FIX-003
```

### Scope Creep
```bash
# PR touches files outside scope
❌ Gate failed: scope violation in src/unrelated.ts

# Solution: Update working spec or split PR
scope:
  in: ["src/feature/", "tests/"]
  out: ["src/unrelated/"]
```

### Budget Exceeded
```bash
# Too many files changed
❌ Gate failed: 35 files > budget 25

# Solution: Split into multiple PRs or increase budget
change_budget:
  max_files: 40  # Adjusted for complexity
```

---

## 📚 Additional Resources

### Full Documentation
- **Complete Guide**: `docs/agents/FULL_GUIDE.md` (821 lines)
- **Tutorial**: `docs/agents/TUTORIAL.md` (step-by-step)
- **Examples**: `docs/agents/EXAMPLES.md` (real projects)

### Getting Started
- **Your Guide**: `.caws/GETTING_STARTED.md` (generated per project)
- **Templates**: `.caws/templates/` (feature plans, test plans, PR templates)
- **Examples**: `.caws/examples/` (working specs for different project types)

### Tools & Scripts
- **Validation**: `apps/tools/caws/validate.js`
- **Gates**: `apps/tools/caws/gates.js`
- **Provenance**: `apps/tools/caws/provenance.js`
- **Templates**: `.caws/templates/`

---

## 🎯 Next Steps

1. **Initialize**: `caws init --interactive`
2. **Customize**: Edit `.caws/working-spec.yaml`
3. **Validate**: `caws validate --suggestions`
4. **Develop**: Follow the plan-implement-verify loop
5. **Deploy**: Use CI/CD with quality gates

**Questions?** Check the full guide or open an issue.

---

*This is the quick reference. For complete documentation, see `docs/agents/FULL_GUIDE.md`*

**Version**: 3.1.0  
**Last Updated**: October 2, 2025
