# CAWS - Agent Quick Reference

**Essential guide for AI agents working with CAWS projects**

## 🚀 Getting Started

### First Steps in Any CAWS Project

```bash
# 1. Always validate first
caws validate

# 2. Check current status
caws status

# 3. Get iterative guidance
caws iterate --current-state "Starting implementation"
```

### Your Contract with CAWS

**You MUST:**

- ✅ **Validate before starting** any work
- ✅ **Create contracts before implementation**
- ✅ **Write tests first** (TDD approach)
- ✅ **Meet quality tier requirements**
- ✅ **Stay within scope boundaries**
- ✅ **Track all changes** for provenance

**You MUST NOT:**

- ❌ Write implementation without validated specs
- ❌ Create shadow files (`enhanced-*`, `new-*`)
- ❌ Exceed change budgets
- ❌ Skip quality gates
- ❌ Include secrets in context

## 📋 Risk Tiers (Your Quality Contract)

| Tier      | Coverage | Mutation | Contracts | Use Case                    |
| --------- | -------- | -------- | --------- | --------------------------- |
| 🔴 **T1** | 90%+     | 70%+     | Required  | Auth, billing, migrations   |
| 🟡 **T2** | 80%+     | 50%+     | Required  | Features, APIs, data writes |
| 🟢 **T3** | 70%+     | 30%+     | Optional  | UI, internal tools          |

## 🔄 Development Workflow

### Phase 1: Plan & Validate

```bash
# Validate working spec
caws validate

# Check current progress
caws progress update --criterion-id A1 --status in_progress
```

### Phase 2: Contract First

```yaml
# In .caws/working-spec.yaml, define contracts:
contracts:
  - type: openapi
    path: docs/api/feature.yaml
    version: 1.0.0
  - type: typescript
    path: src/types/feature.ts
    version: 1.0.0
```

### Phase 3: Test-Driven Development

```bash
# Write failing tests first
# Implement to make tests pass
# Meet coverage requirements
```

### Phase 4: Quality Gates

```bash
# Run all validations
caws diagnose

# Check final status
caws status
```

## 🛠️ Essential Commands

### Validation & Status

```bash
caws validate                    # Validate working spec
caws status                      # Project health overview
caws diagnose                    # Run diagnostics
```

### Development Workflow

```bash
caws iterate                     # Get next steps guidance
caws evaluate                    # Evaluate current progress
caws progress update             # Update acceptance criteria
```

### Quality Assurance

```bash
caws test-analysis assess-budget # Predict test needs
caws workflow guidance          # Get workflow help
```

### Provenance & Compliance

```bash
caws provenance show             # View audit trail
caws hooks status                # Check git hooks
```

### Cursor Hooks

CAWS includes pre-configured Cursor IDE hooks for Real-Time Quality enforcement and enhanced agent workflows:

```bash
# Hooks are automatically created during initialization
# Located in .cursor/hooks/

# Available hooks:
# - audit.sh - Audit trail for file operations
# - block-dangerous.sh - Block dangerous commands
# - scan-secrets.sh - Detect secrets and PII
# - naming-check.sh - Enforce naming conventions
# - validate-spec.sh - Check working-spec.yaml
# - format.sh - Auto-format code
# - scope-guard.sh - Enforce scope boundaries
```

See `docs/guides/hooks-and-agent-workflows.md` for detailed configuration.

## ⚠️ Critical Rules

### Scope Boundaries

```yaml
# Respect these in .caws/working-spec.yaml
scope:
  in: ['src/feature/', 'tests/feature/'] # ✅ Allowed
  out: ['node_modules/', 'src/other/'] # ❌ Forbidden
```

### Change Budgets

```yaml
# Never exceed these limits
change_budget:
  max_files: 25 # Files changed
  max_loc: 1000 # Lines of code
```

### Quality Requirements

- **T1**: 90% coverage, 70% mutation, contracts required
- **T2**: 80% coverage, 50% mutation, contracts required
- **T3**: 70% coverage, 30% mutation, contracts optional

## 📚 Key Resources

- **[Full Guide](docs/agents/full-guide.md)** - Complete documentation
- **[Working Specs](docs/internal/SPEC_VALIDATION_SUMMARY.md)** - Current specifications
- **[Benchmarking](docs/internal/CAWS_AGENT_BENCHMARKING_FRAMEWORK.md)** - Performance testing
- **[Demo Project](packages/caws-cli/demo-project/)** - Working example

## 🎯 Success Metrics

**Agent excellence is measured by:**

- **Independence**: Working autonomously without constant human guidance
- **Quality Compliance**: Meeting tier requirements on first attempt
- **Contract Adherence**: APIs exactly matching specifications
- **Test Effectiveness**: Comprehensive suites that catch mutations
- **Scope Discipline**: Staying within defined boundaries

## 🔍 Common Pitfalls

### ❌ What NOT to Do

- Starting implementation before validation
- Creating `enhanced-*` or `new-*` files
- Writing code without tests first
- Exceeding change budgets
- Ignoring provenance tracking

### ✅ What to Do

- Always run `caws validate` first
- Define contracts before implementation
- Write comprehensive test suites
- Update progress with `caws progress update`
- Request human review for Tier 1 changes

## 📞 Getting Help

1. **Read the full guide**: `docs/agents/full-guide.md`
2. **Check examples**: `packages/caws-cli/demo-project/`
3. **Use built-in help**: `caws workflow guidance`
4. **Validate often**: `caws validate` catches issues early

---

**Remember**: CAWS exists to make AI-human collaboration reliable and high-quality. Follow the rules, validate often, and deliver excellent results.
