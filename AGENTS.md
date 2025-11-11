# CAWS - Agent Quick Reference

**Essential guide for AI agents working with CAWS projects**

## 🚨 CRITICAL: Multi-Agent Workflow

**If multiple agents are working on this project, each MUST use feature-specific specs to avoid conflicts!**

### The Problem

❌ Multiple agents editing `.caws/working-spec.yaml` = conflicts, overwritten work, chaos

### The Solution

✅ Each agent works on `.caws/specs/<feature-id>.yaml` = parallel work, no conflicts, success

**📚 See [Multi-Agent Workflow Guide](docs/guides/multi-agent-workflow.md) for complete details**

## 🚀 Getting Started

### First Steps in Any CAWS Project

```bash
# 1. Create YOUR feature-specific spec (if multiple agents)
caws specs create <your-feature-id> --type feature --title "Your Feature"

# 2. Validate YOUR spec (always use --spec-id with multiple specs)
caws validate --spec-id <your-feature-id>

# 3. Check current status for YOUR feature
caws status --visual --spec-id <your-feature-id>

# 4. Get iterative guidance for YOUR feature
caws iterate --spec-id <your-feature-id> --current-state "Starting implementation"
```

### Single-Agent Projects

If you're the only agent:

```bash
# Option 1: Create a feature spec (recommended)
caws specs create my-feature

# Option 2: Use legacy single spec (not recommended for new projects)
caws init .
```

### ✨ New Features for Better Agent Experience

```bash
# Enhanced visual status with progress bars
caws status --visual

# Multi-spec system for better organization
caws specs list                    # List all specs
caws specs create my-feature       # Create new spec
caws specs show my-feature         # View spec details

# Archive completed changes with lifecycle management
caws archive FEAT-001

# Use natural slash commands (via MCP server)
/caws:start --projectName my-project
/caws:validate
/caws:archive --changeId FEAT-001
/caws:specs list
```

### Your Contract with CAWS

**You MUST:**

- ✅ **Use feature-specific specs** (if multiple agents working on project)
- ✅ **Always include `--spec-id`** when multiple specs exist
- ✅ **Stay within your feature's scope** boundaries
- ✅ **Validate before starting** any work
- ✅ **Create contracts before implementation**
- ✅ **Write tests first** (TDD approach)
- ✅ **Meet quality tier requirements**
- ✅ **Track all changes** for provenance

**You MUST NOT:**

- ❌ **Edit other agents' feature specs** or scope directories
- ❌ **Work on `.caws/working-spec.yaml` if multiple agents exist**
- ❌ Write implementation without validated specs
- ❌ Create shadow files (`enhanced-*`, `new-*`)
- ❌ Exceed change budgets
- ❌ Skip quality gates
- ❌ Include secrets in context

## 📋 Complexity Tiers (CAWS Modes)

CAWS supports three complexity tiers that adapt the system to your project needs:

| Tier              | Coverage | Mutation | Commands | Features                  | Use Case                          |
| ----------------- | -------- | -------- | -------- | ------------------------- | --------------------------------- |
| 🟢 **Simple**     | 70%+     | 30%+     | 4        | Basic validation, specs   | Small projects, quick prototyping |
| 🟡 **Standard**   | 80%+     | 50%+     | 11       | Quality gates, provenance | Balanced teams, standard projects |
| 🔴 **Enterprise** | 90%+     | 70%+     | 14       | Full audit, compliance    | Large teams, regulated projects   |

### Mode Management

```bash
# Check current mode
caws mode current

# Switch modes
caws mode set simple
caws mode set standard
caws mode set enterprise

# Interactive mode selection
caws mode set --interactive

# Compare tiers
caws mode compare

# Get recommendations
caws mode recommend --size small --team-size 1
```

### Mode-Aware Features

- **Visual status** adapts to show only relevant features
- **Quality requirements** scale with complexity tier
- **Command availability** changes based on mode
- **Progress calculation** adjusts for enabled features

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

### Multi-Spec Workflow Commands (Use These!)

```bash
# Specs Management - FEATURE-SPECIFIC (Primary Pattern)
caws specs create <feature-id>               # Create YOUR feature spec
caws specs list                              # List all specs
caws specs show <feature-id>                 # View spec details

# Validation & Quality - WITH --spec-id
caws validate --spec-id <feature-id>         # Validate YOUR spec
caws status --visual --spec-id <feature-id>  # Check YOUR feature status
caws iterate --spec-id <feature-id>          # Get YOUR guidance
caws evaluate --spec-id <feature-id>         # Evaluate YOUR work
caws diagnose --spec-id <feature-id>         # Check YOUR health

# Progress Tracking - FEATURE-SPECIFIC
caws progress update --spec-id <feature-id> --criterion-id A1 --status completed

# Archive YOUR feature when complete
caws archive FEAT-001 --spec-id <feature-id>
```

### Single-Spec Commands (Legacy - Only if Alone)

```bash
# Project Management (single agent only)
caws init .                      # Initialize new CAWS project
caws scaffold                    # Add CAWS to existing project
caws status --visual             # Enhanced status
caws validate                    # Validate (uses legacy working-spec.yaml)

# Mode Management (Complexity Tiers)
caws mode current               # Check current mode
caws mode set simple            # Set simple mode
caws mode compare               # Compare all tiers
caws mode recommend             # Get tier recommendation

# Development Guidance
caws iterate --current-state "Implementation in progress"  # Get next steps
caws workflow guidance --workflowType tdd --currentStep 1  # Workflow help
caws tutorial agent  # Interactive agent tutorial
caws plan generate  # Generate implementation plan
```

### MCP Server Slash Commands (Natural Language)

```bash
# Project setup (via MCP server)
caws_slash_commands({
  command: "/caws:start",
  projectName: "my-project",
  template: "api"
})

# Validation (via MCP server)
caws_slash_commands({
  command: "/caws:validate",
  specFile: ".caws/working-spec.yaml"
})

# Status checking (via MCP server)
caws_slash_commands({
  command: "/caws:status"
})

# Multi-spec management (via MCP server)
caws_slash_commands({
  command: "/caws:specs list"
})

caws_slash_commands({
  command: "/caws:specs create",
  id: "user-auth",
  type: "feature",
  title: "User Authentication System"
})

caws_slash_commands({
  command: "/caws:specs show",
  id: "user-auth"
})

# Archive changes (via MCP server)
caws_slash_commands({
  command: "/caws:archive",
  changeId: "FEAT-001",
  force: true
})
```

### Quality Assurance

```bash
# Test analysis and budget prediction
caws test-analysis assess-budget  # Predict testing needs
caws test-analysis analyze-patterns  # Analyze test patterns
caws test-analysis find-similar   # Find similar test cases

# Quality monitoring (real-time)
caws quality-monitor file_saved --files src/feature.ts,tests/feature.test.ts
caws quality-monitor test_run --context '{"testCount": 15, "passed": 14}'
```

### Provenance & Compliance

```bash
# Audit trails
caws provenance init             # Initialize tracking
caws provenance update --commit abc123 --message "Feature complete"
caws provenance show             # View audit trail
caws provenance verify           # Verify chain integrity

# Git hooks management
caws hooks install              # Install CAWS git hooks
caws hooks status               # Check hook status
caws hooks remove               # Remove hooks

# Quality gate waivers
caws waivers create --title "Emergency hotfix" --reason emergency_hotfix --gates test-coverage
caws waivers list               # List all waivers
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

### OIDC Setup (Publishing Projects Only)

**OIDC (OpenID Connect) setup is only needed for projects that publish packages to registries.**

CAWS automatically detects if your project publishes packages by checking for:
- `package.json` with `publishConfig` or publish scripts (npm)
- `pyproject.toml` with build system and project metadata (PyPI)
- `pom.xml` (Maven)
- `.csproj` files (NuGet)
- GitHub Actions workflows with publishing steps

**When OIDC is automatically included:**
- Project has publishing configuration detected
- You explicitly request it with `--with-oidc` flag

**When OIDC is skipped:**
- Research/training projects (no publishing config)
- Internal tools (not published)
- Applications (not published as packages)

**If OIDC is skipped but you need it later:**
```bash
# Add OIDC setup guide manually
caws scaffold --with-oidc
```

**Agent Guidance:**
- ✅ If project publishes packages → OIDC setup is included automatically
- ✅ If project is research/training/internal → OIDC is skipped (correct behavior)
- ✅ If user asks about OIDC → Check project type and explain when it's needed
- ❌ Don't add OIDC to non-publishing projects unless explicitly requested

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

- **[Multi-Agent Workflow Guide](docs/guides/multi-agent-workflow.md)** - **READ THIS FIRST** if multiple agents
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

## 🔄 Complete Workflow Examples

### Example 1: New Feature Development (Multi-Agent TDD Approach)

```bash
# 1. Create YOUR feature-specific spec
caws specs create user-auth --type feature --title "User Authentication System"

# 2. Edit YOUR spec with contracts
# File: .caws/specs/user-auth.yaml
# - Define acceptance criteria
# - Set scope boundaries (what files you'll touch)
# - Define contracts and interfaces

# 3. Validate YOUR spec
caws validate --spec-id user-auth

# 4. Get guidance for YOUR feature
caws iterate --spec-id user-auth --current-state "Planning authentication"

# 5. Write tests first (TDD)
# Create tests for acceptance criteria A1-A3

# 6. Implement feature incrementally
# Update progress as each criterion is met
caws progress update --spec-id user-auth --criterion-id A1 --status completed --tests-written 5 --tests-passing 5

# 7. Run quality gates on YOUR feature
caws diagnose --spec-id user-auth
caws status --visual --spec-id user-auth

# 8. Archive YOUR feature when complete
caws archive FEAT-001 --spec-id user-auth
```

### Example 2: Bug Fix with Waiver (Emergency Scenario)

```bash
# 1. Acknowledge the issue
caws status --visual  # See current state

# 2. Create emergency waiver for quick fix
caws waivers create \
  --title "Critical login bug hotfix" \
  --reason emergency_hotfix \
  --description "Users cannot login - blocking all access" \
  --gates test-coverage,mutation-testing \
  --expires-at "2024-12-31" \
  --approved-by "Emergency Response Team" \
  --impact-level critical \
  --mitigation-plan "Deploy fix immediately, add tests within 24h"

# 3. Quick fix implementation (waiver allows reduced quality gates)
# Fix the critical issue

# 4. Archive the fix
caws archive FIX-001 --force  # Force due to incomplete tests

# 5. Follow up with proper test coverage (remove waiver later)
```

### Example 3: Refactoring with Quality Monitoring

```bash
# 1. Plan refactoring in working spec
caws validate

# 2. Enable quality monitoring
caws quality-monitor code_edited \
  --files src/legacy-module.ts \
  --context '{"refactoring": true, "targetComplexity": "low"}'

# 3. Iterative refactoring with monitoring
# Make small changes, monitor quality impact

# 4. Update progress as you go
caws progress update --criterion-id REF1 --status in_progress

# 5. Validate refactoring meets goals
caws evaluate
caws status --visual

# 6. Archive when complete
caws archive REFACT-001
```

## 🔍 Common Pitfalls & Solutions

### ❌ Common Mistakes

**Problem**: Starting implementation before validation
**Solution**: Always run `caws validate` first - it catches issues early

**Problem**: Creating `enhanced-*` or `new-*` files
**Solution**: Edit existing canonical files, don't create duplicates

**Problem**: Writing code without tests first (not TDD)
**Solution**: Write failing tests before implementation

**Problem**: Exceeding change budgets
**Solution**: Break large changes into smaller, auditable commits

**Problem**: Ignoring provenance tracking
**Solution**: Initialize with `caws provenance init` and update regularly

**Problem**: Forcing archives without meeting criteria
**Solution**: Use `--force` only for emergencies, document why

### ✅ Best Practices

- **Validate Often**: Run `caws validate` after any spec changes
- **Use Visual Status**: `caws status --visual` shows progress clearly
- **Leverage Slash Commands**: Natural language via MCP server is more intuitive
- **Monitor Quality**: Use `caws quality-monitor` for real-time feedback
- **Archive Properly**: Use `caws archive` to maintain clean change history
- **Request Help**: Use `caws workflow guidance` when stuck

## 📞 Getting Help

### Quick Help Commands

```bash
# Get command-specific help
caws --help                    # All available commands
caws status --help             # Status command options
caws archive --help            # Archive command options

# Workflow guidance for specific scenarios
caws workflow guidance --workflowType tdd --currentStep 1
caws workflow guidance --workflowType feature --currentStep 2

# Tool-specific help via MCP server
caws_help({ tool: "caws_validate" })           # Detailed tool help
caws_help({ category: "validation" })          # Tools by category
```

### Documentation Resources

1. **[Full Agent Guide](docs/agents/full-guide.md)** - Complete documentation
2. **[Demo Project](packages/caws-cli/demo-project/)** - Working examples
3. **[Spec System Comparison](docs/internal/SPEC_SYSTEMS_COMPARISON.md)** - Architecture insights
4. **[Working Specs](docs/internal/SPEC_VALIDATION_SUMMARY.md)** - Current specifications

### When to Ask for Human Help

- **Tier 1 Changes**: Always request review for critical features
- **Architecture Decisions**: When design choices affect multiple components
- **Emergency Waivers**: Before creating waivers for reduced quality gates
- **Complex Refactoring**: When changes span many files or systems
- **Performance Issues**: When optimizations might impact user experience

### Troubleshooting Commands

```bash
# Diagnose issues
caws diagnose                  # Run health checks
caws diagnose --fix            # Auto-fix detected issues

# Check system status
caws status --visual           # Visual project overview
caws status --json             # Machine-readable status

# Validate everything
caws validate                  # Check working spec
caws evaluate                  # Check quality compliance

# Get guidance
caws iterate --current-state "Stuck on implementation"
caws workflow guidance --workflowType refactor --currentStep 1
```

---

## 🎯 Agent Success Framework

**Your mission**: Deliver reliable, high-quality code that meets CAWS standards while maintaining efficient collaboration with human developers.

**Key Success Indicators**:

- ✅ **Zero validation errors** before implementation
- ✅ **Complete test coverage** meeting tier requirements
- ✅ **Clean archival** of completed changes
- ✅ **Proactive communication** about challenges and decisions
- ✅ **Scope discipline** - staying within defined boundaries

**Remember**: CAWS exists to make AI-human collaboration reliable and high-quality. Follow the rules, validate often, and deliver excellent results. When in doubt, validate first and ask for guidance!
