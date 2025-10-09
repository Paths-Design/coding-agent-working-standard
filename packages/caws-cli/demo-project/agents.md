# CAWS Demo Project - Agent Guide

**How AI agents work with this CAWS demo project**

## 🎯 Your Mission

This demo project showcases production-ready CAWS implementation. Your job is to:

1. **Understand the existing architecture** (authentication, data, memory, AI services)
2. **Add new features** following CAWS workflow
3. **Maintain quality standards** (92% coverage, 78% mutation score)
4. **Demonstrate best practices** in contract-first development

## 🚀 Getting Started

### First Steps

```bash
# Always validate first
npx caws validate

# Check current project status
npx caws status

# Get guidance for your task
npx caws iterate --current-state "Starting feature development"
```

### Understanding This Project

```yaml
# Check .caws/working-spec.yaml for:
risk_tier: 1 # Highest quality standards
contracts: # API contracts defined
  - type: openapi
    path: docs/api/auth.yaml
acceptance: # Your implementation targets
  - id: 'A1'
    given: 'User not authenticated'
    when: 'Valid credentials provided'
    then: 'User logged in successfully'
```

## 📋 Quality Requirements

### Tier 1 Standards (This Project)

- **Coverage**: ≥90% (currently 92%)
- **Mutation Score**: ≥70% (currently 78%)
- **Contracts**: Required and tested
- **Review**: Manual review required

### Never Violate These Rules

- ✅ **Validate before coding**: `caws validate`
- ✅ **Contracts before implementation**: Define APIs first
- ✅ **Tests first**: TDD approach required
- ✅ **Stay in scope**: Respect `scope.in` boundaries
- ✅ **Track progress**: Use `caws progress update`

## 🔄 Development Workflow

### Phase 1: Understand & Plan

```bash
# Read existing contracts
cat docs/api/auth.yaml

# Check current implementation
cat src/api/auth.ts

# Validate your understanding
npx caws validate
```

### Phase 2: Add New Feature

```yaml
# 1. Update working spec with new acceptance criteria
vim .caws/working-spec.yaml

# 2. Add API contracts
vim docs/api/new-feature.yaml

# 3. Validate contracts exist
npx caws validate
```

### Phase 3: Implement (TDD)

```bash
# 1. Write failing tests
vim tests/unit/new-feature.test.ts
npm test  # Should fail

# 2. Implement code
vim src/services/new-feature.ts
npm test  # Should pass

# 3. Check coverage
npm run test:coverage  # Must be ≥90%
```

### Phase 4: Quality Assurance

```bash
# Run all quality gates
npx caws diagnose

# Update progress
npx caws progress update --criterion-id A1 --status completed

# Final validation
npx caws status
```

## 🏗️ Architecture Overview

### Services in This Demo

| Service            | Purpose                       | Tier | Contracts            |
| ------------------ | ----------------------------- | ---- | -------------------- |
| **Authentication** | User login/logout             | T1   | OpenAPI + TypeScript |
| **Data Layer**     | PostgreSQL + Redis + Vector   | T2   | OpenAPI + SQL        |
| **Memory System**  | Multi-tenant knowledge graphs | T2   | OpenAPI + TypeScript |
| **AI Integration** | Local model inference         | T2   | OpenAPI + TypeScript |

### Key Files to Study

```
.caws/working-spec.yaml     # Project specification
docs/api/                   # OpenAPI contracts
src/types/                  # TypeScript interfaces
tests/contract/             # API contract tests
tests/unit/                 # Unit test examples
```

## 🧪 Testing Structure

### Test Types Required

- **Unit Tests**: Business logic (≥90% coverage)
- **Contract Tests**: API compliance (all endpoints)
- **Integration Tests**: Service interactions
- **E2E Tests**: Complete user journeys
- **Mutation Tests**: Test suite strength (≥70% score)

### Example Test Patterns

```typescript
// Contract test (Pact)
test('GET /users returns valid user array', async () => {
  const response = await fetch('/api/users');
  await validateAgainstSchema(response, 'docs/api/users.yaml');
});

// Unit test with coverage
test('UserService.authenticate validates credentials', () => {
  const service = new UserService(mockRepo);
  const result = service.authenticate('user', 'pass');
  expect(result.success).toBe(true);
});
```

## 📊 Success Metrics

### What Makes You Successful

- **Quality Compliance**: Meet all Tier 1 requirements
- **Contract Adherence**: APIs exactly match specifications
- **Test Effectiveness**: Comprehensive suites that catch mutations
- **Documentation**: Clear updates to contracts and README
- **Independence**: Work autonomously with `caws iterate` guidance

### Common Pitfalls to Avoid

- ❌ Starting implementation before validation
- ❌ Creating `enhanced-*` files instead of refactoring
- ❌ Writing code without tests
- ❌ Exceeding change budgets (25 files, 1000 LOC)
- ❌ Including secrets in prompts or code

## 🛠️ Essential Commands

```bash
# Validation & Planning
npx caws validate                    # Check spec compliance
npx caws status                      # Project health overview
npx caws iterate                     # Get development guidance

# Development
npx caws progress update             # Track acceptance criteria
npx caws evaluate                    # Assess current progress

# Quality Assurance
npx caws diagnose                    # Run health checks
npx caws test-analysis assess-budget # Predict test needs

# Provenance
npx caws provenance show             # View audit trail
```

## 🎯 Example Tasks

### Task 1: Add Password Reset Feature

1. Update `.caws/working-spec.yaml` with new acceptance criteria
2. Add OpenAPI contract for `/auth/reset-password`
3. Implement password reset logic with tests
4. Meet coverage and mutation requirements

### Task 2: Improve AI Model Selection

1. Add contract for model selection endpoint
2. Implement intelligent model routing
3. Add performance monitoring
4. Update existing contracts

### Task 3: Enhance Memory Search

1. Extend memory API with advanced filtering
2. Update TypeScript interfaces
3. Add comprehensive tests
4. Maintain existing performance

## 📞 Getting Help

1. **Read the contracts**: `docs/api/` - understand existing APIs
2. **Study the tests**: `tests/` - learn testing patterns
3. **Use guidance**: `npx caws iterate` - get step-by-step help
4. **Validate often**: `npx caws validate` - catch issues early
5. **Check examples**: Study existing implementations

## 📚 Resources

- **[Full CAWS Guide](../../docs/agents/full-guide.md)** - Comprehensive system guide
- **[Working Specs](../../docs/internal/SPEC_VALIDATION_SUMMARY.md)** - Current specifications
- **[Benchmarking](../../docs/internal/CAWS_AGENT_BENCHMARKING_FRAMEWORK.md)** - Performance testing
- **[Main README](../../README.md)** - Project overview

---

**Goal**: Demonstrate expert-level CAWS implementation by adding features that maintain or improve the 92%+ quality metrics.

**Remember**: This demo shows how AI agents and humans collaborate to build production-quality software with CAWS.
