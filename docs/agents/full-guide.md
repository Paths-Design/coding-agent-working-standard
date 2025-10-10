# CAWS - Agent Workflow Guide

**Coding Agent Workflow System** - Engineering-grade operating system for AI-assisted development

**Version**: 3.1.0  
**Last Updated**: October 8, 2025

---

## Purpose & Philosophy

CAWS is an engineering-grade operating system for coding agents that:

1. **Forces planning before code** - No implementation without a validated working spec
2. **Treats tests as first-class artifacts** - Tests drive implementation, not the other way around
3. **Creates explainable provenance** - Every change is tracked and attributable
4. **Enforces quality via automated gates** - CI/CD validates coverage, mutation scores, and contracts

This guide teaches agents how to collaborate effectively with humans using CAWS tooling and conventions.

---

## Quick Start for Agents

### Your First CAWS Project

When you encounter a CAWS project, follow this sequence:

1. **Check for working spec**: Look for `.caws/working-spec.yaml`
2. **Understand the scope**: Read the `scope.in` and `scope.out` to know boundaries
3. **Check risk tier**: Tier 1 (critical), Tier 2 (standard), Tier 3 (low risk)
4. **Review acceptance criteria**: These are your implementation targets
5. **Validate before starting**: Run `caws validate` to ensure spec is valid

### The Golden Rule

**Never write implementation code until:**

- Working spec exists and validates
- Test plan is defined
- Acceptance criteria are clear
- Scope boundaries are understood

---

## Core Concepts

### Risk Tiers - Your Quality Contract

Risk tiers drive rigor and determine quality gates:

| Tier      | Use Case                    | Coverage | Mutation | Contracts | Review   |
| --------- | --------------------------- | -------- | -------- | --------- | -------- |
| **🔴 T1** | Auth, billing, migrations   | 90%+     | 70%+     | Required  | Manual   |
| **🟡 T2** | Features, APIs, data writes | 80%+     | 50%+     | Required  | Optional |
| **🟢 T3** | UI, internal tools          | 70%+     | 30%+     | Optional  | Optional |

**As an agent, you must:**

- Infer and declare the tier in your plan
- Meet or exceed tier requirements
- Request human review for Tier 1 changes
- Never downgrade a tier without human approval

### Key Invariants (Never Violate These)

1. **Atomic Change Budget**: Stay within `max_files` and `max_loc` limits
2. **In-Place Refactors**: No shadow files (`enhanced-*`, `new-*`, `v2-*`, etc.)
3. **Deterministic Code**: Use injected time/uuid/random for testability
4. **Secure Prompts**: Never include secrets, `.env` files, or keys in context
5. **Provenance**: All changes are tracked and attributable

### The Working Spec - Your Blueprint

Every task needs a working spec at `.caws/working-spec.yaml`:

```yaml
id: FEAT-001
title: 'Add user authentication flow'
risk_tier: 1
mode: feature
change_budget:
  max_files: 25
  max_loc: 1000
blast_radius:
  modules: ['auth', 'api']
  data_migration: false
operational_rollback_slo: '5m'
scope:
  in: ['src/auth/', 'tests/auth/', 'package.json']
  out: ['src/billing/', 'node_modules/']
invariants:
  - 'System maintains data consistency during rollback'
  - 'Authentication state is never stored in localStorage'
  - 'All auth tokens expire within 24h'
acceptance:
  - id: 'A1'
    given: 'User is logged out'
    when: 'User submits valid credentials'
    then: 'User is logged in and redirected to dashboard'
  - id: 'A2'
    given: 'User has invalid session token'
    when: 'User attempts to access protected route'
    then: 'User is redirected to login with error message'
non_functional:
  a11y: ['keyboard-navigation', 'screen-reader-labels']
  perf: { api_p95_ms: 250, lcp_ms: 2500 }
  security: ['input-validation', 'csrf-protection', 'rate-limiting']
contracts:
  - type: 'openapi'
    path: 'docs/api/auth.yaml'
```

---

## Your Development Workflow

### Phase 1: Plan (Before Any Code)

**Goal**: Create a validated working spec and test plan.

```bash
# 1. Create or validate working spec
caws validate --suggestions

# 2. If issues exist, use auto-fix for safe corrections
caws validate --auto-fix

# 3. Review acceptance criteria - these are your targets
cat .caws/working-spec.yaml | grep -A 20 "acceptance:"
```

**What to include in your plan:**

1. **Design sketch**: Sequence diagram or API table
2. **Test matrix**: Unit/contract/integration/e2e with edge cases
3. **Data plan**: Fixtures, factories, seed strategy
4. **Observability**: Logs/metrics/traces for production verification

**Output**: `feature.plan.md` committed to repo

### Phase 2: Implement (Test-Driven)

**Goal**: Write tests first, then implementation.

**Order of operations:**

1. **Contracts first** (if applicable)

   ```bash
   # Generate types from OpenAPI/GraphQL
   npm run generate:types

   # Add contract tests before implementation
   # Location: tests/contract/
   ```

2. **Unit tests next**

   ```bash
   # Write failing tests for each acceptance criterion
   # Location: tests/unit/

   # Run tests to confirm they fail
   npm test
   ```

3. **Implementation**

   ```bash
   # Implement to make tests pass
   # Stay within scope.in boundaries
   # Keep files under max_loc budget
   ```

4. **Integration/E2E tests**

   ```bash
   # Add integration tests for persistence/transactions
   # Location: tests/integration/

   # Add E2E smoke tests for critical paths
   # Location: tests/e2e/
   ```

**Implementation rules:**

- ✅ **DO**: Edit existing modules, use injected dependencies, write deterministic code
- ❌ **DON'T**: Create shadow files, hardcode timestamps/UUIDs, exceed change budget

### Phase 3: Verify (Must Pass Before PR)

**Goal**: Ensure all quality gates pass locally.

```bash
# Run full verification suite
npm run verify

# Or run individual checks
npm run lint              # Code style
npm run typecheck         # Type safety
npm test                  # All tests
npm run test:coverage     # Coverage thresholds
npm run test:mutation     # Mutation testing
npm run test:contract     # Contract validation
npm run test:e2e          # End-to-end smoke tests
```

**Quality gates by tier:**

**Tier 1:**

- Branch coverage ≥ 90%
- Mutation score ≥ 70%
- All contract tests pass
- Manual code review completed
- No SAST/secret scan violations

**Tier 2:**

- Branch coverage ≥ 80%
- Mutation score ≥ 50%
- Contract tests pass (if external APIs)
- E2E smoke tests pass

**Tier 3:**

- Branch coverage ≥ 70%
- Mutation score ≥ 30%
- Integration happy-path tests pass

### Phase 4: Document & Deliver

**Goal**: Create comprehensive PR with all artifacts.

**PR checklist:**

```markdown
## Working Spec

- [ ] `.caws/working-spec.yaml` attached and validates
- [ ] Risk tier appropriate for change impact
- [ ] Acceptance criteria met

## Tests

- [ ] Test plan documented
- [ ] Coverage meets tier requirements
- [ ] Mutation score meets tier requirements
- [ ] Contract tests pass (if applicable)
- [ ] E2E smoke tests pass (if applicable)

## Documentation

- [ ] README updated (if public API changed)
- [ ] Migration notes (if database changes)
- [ ] Rollback plan documented
- [ ] Changelog updated (semver impact noted)

## Quality Gates

- [ ] All lints pass
- [ ] Type checks pass
- [ ] No secret scan violations
- [ ] No SAST violations
- [ ] Performance budgets met

## Provenance

- [ ] Commits follow conventional commits format
- [ ] PR title references ticket ID
- [ ] Provenance updated: `caws provenance update`
```

---

## CLI Commands Reference

### Project Initialization

```bash
# Interactive wizard (recommended for new projects)
caws init --interactive

# Initialize in existing directory
caws init .

# Use project template
caws init my-project --template=extension
```

### Validation

```bash
# Check working spec validity
caws validate

# Get helpful suggestions for fixing issues
caws validate --suggestions

# Auto-fix safe validation issues
caws validate --auto-fix

# Quiet mode for CI
caws validate --quiet
```

### Scaffolding

```bash
# Add CAWS components to existing project
caws scaffold

# Only essential components
caws scaffold --minimal

# Include specific features
caws scaffold --with-codemods
caws scaffold --with-oidc
```

### Provenance Tracking

```bash
# Initialize provenance tracking
caws provenance init

# Install git hooks for automatic tracking
caws hooks install --backup

# Update provenance manually
caws provenance update --commit <hash>

# View beautiful dashboard
caws provenance show --format=dashboard

# Analyze AI effectiveness
caws provenance analyze-ai
```

---

## Mode Matrix - Know Your Context

Different modes have different rules:

| Mode         | Contracts       | New Files              | Required Artifacts                        |
| ------------ | --------------- | ---------------------- | ----------------------------------------- |
| **feature**  | Required first  | Allowed in scope.in    | Migration plan, feature flag, perf budget |
| **refactor** | Must not change | Discouraged (use mods) | Codemod script + semantic diff report     |
| **fix**      | Unchanged       | Discouraged            | Red test → green; root cause note         |
| **doc**      | N/A             | Allowed (docs only)    | Updated README/usage snippets             |
| **chore**    | N/A             | Limited (build/tools)  | Version updates, dependency changes       |

### Feature Mode (Most Common)

**When to use**: Adding new functionality

**Requirements**:

1. Define contracts first (OpenAPI/GraphQL/etc.)
2. Write consumer/provider tests before implementation
3. Include migration plan if database changes
4. Add feature flag for gradual rollout
5. Set performance budgets

**Example workflow**:

```bash
# 1. Define contract
vim docs/api/new-feature.yaml

# 2. Generate types
npm run generate:types

# 3. Write contract tests
vim tests/contract/new-feature.test.ts

# 4. Implement
vim src/features/new-feature.ts

# 5. Verify
npm run verify
```

### Refactor Mode (High Risk)

**When to use**: Restructuring without behavior change

**Requirements**:

1. Contracts must not change
2. Provide codemod script for automatic transformation
3. Include semantic diff report
4. Prove no behavior change with tests
5. Update all imports automatically

**Example workflow**:

```bash
# 1. Write codemod
vim codemod/rename-user-service.ts

# 2. Dry run
npx jscodeshift -d -t codemod/rename-user-service.ts src/

# 3. Apply
npx jscodeshift -t codemod/rename-user-service.ts src/

# 4. Verify tests still pass
npm test

# 5. Generate semantic diff
npm run semver-check
```

### Fix Mode (Urgent)

**When to use**: Fixing bugs

**Requirements**:

1. Write failing test that reproduces bug
2. Implement minimal fix
3. Document root cause in PR
4. Avoid new files - prefer in-place edits

**Example workflow**:

```bash
# 1. Write failing test
vim tests/unit/user-service.test.ts
npm test # Should fail

# 2. Fix
vim src/services/user-service.ts
npm test # Should pass

# 3. Document
vim .caws/working-spec.yaml # Add root cause note
```

---

## Common Patterns & Best Practices

### Pattern: Deterministic Testing

**Problem**: Tests that use `Date.now()`, `Math.random()`, or `crypto.randomUUID()` are non-deterministic.

**Solution**: Inject time/random/UUID generators.

```typescript
// ❌ Bad - Non-deterministic
class OrderService {
  createOrder(items) {
    return {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      items,
    };
  }
}

// ✅ Good - Deterministic
class OrderService {
  constructor(
    private clock: Clock,
    private idGenerator: IdGenerator
  ) {}

  createOrder(items) {
    return {
      id: this.idGenerator.generate(),
      timestamp: this.clock.now(),
      items,
    };
  }
}

// Test with injected dependencies
test('createOrder generates valid order', () => {
  const clock = new FixedClock('2025-01-01T00:00:00Z');
  const idGen = new SequentialIdGenerator();
  const service = new OrderService(clock, idGen);

  const order = service.createOrder([item1, item2]);

  expect(order.id).toBe('00000001');
  expect(order.timestamp).toBe('2025-01-01T00:00:00Z');
});
```

### Pattern: Guard Clauses for Safety

**Problem**: Deep nesting makes code hard to read and error-prone.

**Solution**: Use guard clauses and early returns.

```typescript
// ❌ Bad - Deep nesting
function processOrder(order) {
  if (order) {
    if (order.items && order.items.length > 0) {
      if (order.user) {
        if (order.user.active) {
          // Process order
          return calculateTotal(order.items);
        } else {
          throw new Error('User not active');
        }
      } else {
        throw new Error('No user');
      }
    } else {
      throw new Error('No items');
    }
  } else {
    throw new Error('No order');
  }
}

// ✅ Good - Guard clauses
function processOrder(order) {
  if (!order) {
    throw new Error('No order');
  }

  if (!order.items || order.items.length === 0) {
    throw new Error('No items');
  }

  if (!order.user) {
    throw new Error('No user');
  }

  if (!order.user.active) {
    throw new Error('User not active');
  }

  // Now safe to process
  return calculateTotal(order.items);
}
```

### Pattern: Contract-First Development

**Problem**: API changes break consumers unexpectedly.

**Solution**: Define contracts first, generate types, test before implementing.

```bash
# 1. Define OpenAPI contract
cat > docs/api/users.yaml << EOF
openapi: 3.0.0
paths:
  /users:
    get:
      responses:
        200:
          content:
            application/json:
              schema:
                type: array
                items:
                  \$ref: '#/components/schemas/User'
components:
  schemas:
    User:
      type: object
      required: [id, email, name]
      properties:
        id: { type: string }
        email: { type: string }
        name: { type: string }
EOF

# 2. Generate TypeScript types
npx openapi-typescript docs/api/users.yaml -o src/types/api.ts

# 3. Write contract test
cat > tests/contract/users.test.ts << EOF
import { validateAgainstSchema } from '@pact-foundation/pact';

test('GET /users returns valid user array', async () => {
  const response = await fetch('/api/users');
  const data = await response.json();

  await validateAgainstSchema(data, 'docs/api/users.yaml', '/users');
});
EOF

# 4. Implement
# src/api/users.ts now has type safety and contract validation
```

---

## Troubleshooting Common Issues

### Validation Errors

#### Error: `risk_tier is required`

**Cause**: Working spec missing risk tier.

**Fix**:

```yaml
# Add to .caws/working-spec.yaml
risk_tier: 2 # Choose 1, 2, or 3 based on impact
```

#### Error: `Invalid ID format`

**Cause**: ID doesn't match `PREFIX-NUMBER` pattern.

**Fix**:

```yaml
# ❌ Bad
id: feature-001
id: FEAT001
id: feat_001

# ✅ Good
id: FEAT-001
id: FIX-042
id: REFACTOR-003
```

#### Error: `scope.in is required`

**Cause**: Missing scope definition.

**Fix**:

```yaml
scope:
  in: ['src/features/auth/', 'tests/auth/']
  out: ['node_modules/', 'dist/']
```

### Scope Violations

#### Error: `File outside scope: src/unrelated.ts`

**Cause**: PR touches files not listed in `scope.in`.

**Fix Option 1 - Update scope**:

```yaml
scope:
  in:
    - 'src/features/auth/'
    - 'src/unrelated.ts' # Add file to scope
```

**Fix Option 2 - Split PR**:
Split changes into separate PRs with different scopes.

### Budget Exceeded

#### Error: `35 files changed, exceeds budget of 25`

**Cause**: Change is too large.

**Fix Option 1 - Split PR**:
Break into smaller, focused PRs.

**Fix Option 2 - Increase budget**:

```yaml
change_budget:
  max_files: 40 # Only if justified
  max_loc: 1200
```

**Note**: Prefer splitting over increasing budget.

### Test Coverage Failures

#### Error: `Branch coverage 75% below tier 2 requirement of 80%`

**Cause**: Insufficient test coverage.

**Fix**:

1. Run coverage report: `npm run test:coverage`
2. Identify untested branches in HTML report
3. Add tests for uncovered paths
4. Re-run: `npm run test:coverage`

#### Error: `Mutation score 45% below tier 2 requirement of 50%`

**Cause**: Tests aren't strong enough (mutants survive).

**Fix**:

1. Run mutation report: `npm run test:mutation`
2. Review surviving mutants
3. Add assertions that would catch those mutations
4. Re-run: `npm run test:mutation`

---

## Provenance & AI Tracking

CAWS automatically tracks all AI-assisted changes for transparency and quality analysis.

### Automatic Tracking via Git Hooks

When you commit, hooks automatically:

1. Detect if change was AI-assisted (Cursor Composer, Chat, Tab)
2. Extract quality metrics (coverage, mutation score)
3. Link commits to working spec
4. Update provenance journal

### Viewing Provenance

```bash
# Beautiful dashboard with insights
caws provenance show --format=dashboard

# JSON output for tooling
caws provenance show --format=json

# Analyze AI effectiveness
caws provenance analyze-ai
```

### Dashboard Insights

The provenance dashboard shows:

- Total commits and AI-assisted percentage
- Quality score trends over time
- AI contribution breakdown (Composer vs Tab completions)
- Acceptance rate for AI-assisted changes
- Recent activity timeline
- Smart recommendations for improvement

---

## Integration with Cursor IDE

CAWS provides deep Cursor IDE integration via hooks and rules.

### Cursor Rules (`.cursor/rules/`)

CAWS includes modular MDC rule files:

1. **01-working-style.mdc** - Working style and risk limits
2. **02-quality-gates.mdc** - Tests, linting, commit discipline
3. **03-naming-and-refactor.mdc** - Naming conventions, anti-duplication
4. **04-logging-language-style.mdc** - Logging clarity, emoji policy
5. **05-safe-defaults-guards.mdc** - Defensive coding patterns
6. **06-typescript-conventions.mdc** - TS/JS specific rules
7. **07-process-ops.mdc** - Server and process management
8. **08-solid-and-architecture.mdc** - SOLID principles
9. **09-docstrings.mdc** - Cross-language documentation
10. **10-authorship-and-attribution.mdc** - File attribution

**These rules guide your behavior in Cursor automatically.**

### Cursor Hooks (`.cursor/hooks/`)

Real-time quality enforcement:

- **validate-command** - Blocks dangerous commands (`rm -rf /`, force push)
- **validate-file-read** - Prevents reading secrets (`.env`, keys)
- **validate-file-write** - Enforces naming conventions
- **post-edit** - Auto-formats code after changes

### Disabling Temporarily

```bash
# If you need to bypass commit hooks temporarily
git commit --no-verify  # Allowed for commits

# Note: --no-verify is BLOCKED for git push
# Push operations must pass all quality gates
```

---

## Project Templates

CAWS includes templates for common project types.

### VS Code Extension

```bash
caws init my-extension --template=extension
```

**Optimized for:**

- Risk tier: 2 (high user impact)
- Webview security (CSP enforcement)
- Activation performance (<1s)
- Budget: 25 files, 1000 lines

### React Library

```bash
caws init my-lib --template=library
```

**Optimized for:**

- Risk tier: 2 (API stability)
- Bundle size limits
- Tree-shakeable exports
- Budget: 20 files, 800 lines

### API Service

```bash
caws init my-api --template=api
```

**Optimized for:**

- Risk tier: 1 (data integrity)
- Backward compatibility
- Performance budgets
- Budget: 40 files, 1500 lines

### CLI Tool

```bash
caws init my-cli --template=cli
```

**Optimized for:**

- Risk tier: 3 (low risk)
- Error handling
- Help text and UX
- Budget: 15 files, 600 lines

---

## Advanced Topics

### Codemods for Refactoring

When refactoring, use codemods instead of manual edits:

```bash
# Install jscodeshift
npm install -g jscodeshift

# Create codemod
vim codemod/rename-function.ts

# Dry run to preview changes
jscodeshift -d -t codemod/rename-function.ts src/

# Apply transformation
jscodeshift -t codemod/rename-function.ts src/

# Verify tests pass
npm test
```

**Example codemod:**

```typescript
// codemod/rename-function.ts
export default function transformer(file, api) {
  const j = api.jscodeshift;
  const root = j(file.source);

  // Find all calls to oldFunction
  root
    .find(j.CallExpression, {
      callee: { name: 'oldFunction' },
    })
    .forEach((path) => {
      // Rename to newFunction
      path.value.callee.name = 'newFunction';
    });

  return root.toSource();
}
```

### Feature Flags

For gradual rollouts, use feature flags:

```typescript
// Define flags
const flags = {
  newAuthFlow: process.env.FEATURE_NEW_AUTH === 'true',
};

// Use in code
if (flags.newAuthFlow) {
  return handleAuthV2(credentials);
} else {
  return handleAuthV1(credentials);
}
```

### Performance Budgets

Set budgets in working spec:

```yaml
non_functional:
  perf:
    api_p95_ms: 250 # API latency budget
    lcp_ms: 2500 # Largest Contentful Paint
    tti_ms: 3500 # Time to Interactive
    bundle_kb: 50 # JavaScript bundle size
```

**Enforce in CI:**

```bash
# Lighthouse CI
npm run lighthouse:ci

# Bundle size check
npm run build
du -k dist/main.js | awk '{if ($1 > 50) exit 1}'
```

---

## FAQ for Agents

### Q: Can I skip writing tests if the change is small?

**A: No.** Tests are required regardless of change size. Even a one-line fix needs:

1. A failing test that reproduces the bug
2. The fix
3. The passing test

### Q: Can I create `enhanced-foo.ts` alongside `foo.ts` for refactoring?

**A: No.** Shadow files are forbidden. Instead:

1. Edit `foo.ts` in place
2. Or create a codemod to transform `foo.ts`
3. Or refactor with a different canonical name

### Q: What if the working spec doesn't exist?

**A: Create one.** Before any implementation:

1. Create `.caws/working-spec.yaml`
2. Fill in all required fields
3. Run `caws validate --suggestions`
4. Request human approval
5. Then implement

### Q: Can I exceed the change budget if the task requires it?

**A: Split the task.** If you need more than `max_files` or `max_loc`:

1. Break into multiple smaller PRs
2. Each with its own working spec
3. Each staying within budget

Only increase budget with human approval and strong justification.

### Q: What if lints fail but I think they're wrong?

**A: Fix the lints.** You can use `git commit --no-verify` to commit temporarily, but you cannot push without fixing. If the lint rule is incorrect:

1. Fix the code to satisfy the lint
2. Or request human discussion of the lint rule
3. Human can update lint config if appropriate
4. Note: `git push --no-verify` is BLOCKED

### Q: Can I commit without updating provenance?

**A: Hooks do it automatically.** If hooks are installed, provenance updates on every commit. If hooks aren't installed:

1. Install them: `caws hooks install`
2. Or manually update: `caws provenance update`

---

## Additional Resources

### Documentation

- **Complete Guide**: `docs/agents/full-guide.md` - Comprehensive CAWS reference
- **Tutorial**: `docs/agents/tutorial.md` - Step-by-step learning path
- **Examples**: `docs/agents/examples.md` - Real-world project examples

### Project-Specific

- **Getting Started**: `.caws/GETTING_STARTED.md` - Generated per project
- **Templates**: `.caws/templates/` - Feature plans, test plans, PR templates
- **Examples**: `.caws/examples/` - Working spec examples

### Cursor Rules

- **Rules Directory**: `.cursor/rules/` - Modular MDC rule files
- **Rules README**: `.cursor/rules/README.md` - Rule system documentation

---

## Summary Checklist

Before starting any work:

- [ ] Working spec exists and validates
- [ ] Risk tier is appropriate
- [ ] Acceptance criteria are clear
- [ ] Scope boundaries are defined
- [ ] Test plan is documented

During implementation:

- [ ] Write tests first (TDD)
- [ ] Stay within scope.in boundaries
- [ ] Keep under change budget
- [ ] Use guard clauses and safe defaults
- [ ] Inject dependencies for testability
- [ ] No shadow files (no enhanced-_, new-_, v2-\*)

Before submitting PR:

- [ ] All tests pass: `npm test`
- [ ] Coverage meets tier requirements
- [ ] Mutation score meets tier requirements
- [ ] Lints pass: `npm run lint`
- [ ] Types check: `npm run typecheck`
- [ ] Contracts validate (if applicable)
- [ ] Performance budgets met
- [ ] No secret scan violations
- [ ] Provenance updated

**Questions?** Check the full guide or ask your human collaborator.

---

_This guide is your companion for CAWS-driven development. Bookmark it, reference it often, and use it to deliver high-quality, well-tested, explainable code._
