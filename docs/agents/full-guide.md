---
doc_id: agents-full-guide
authority: reference
status: active
title: CAWS Agent Workflow Guide (v11.1.6)
owner: vNext rewrite team
updated: 2026-05-28
---

# CAWS — Agent Workflow Guide (v11.1.6)

**Coding Agent Working Standard** — engineering-grade operating system for AI-assisted development.

**Version**: 11.1.6
**Last Updated**: 2026-05-28

> **v11.1 posture (A1).** This guide describes the v11.1.6 surface — twelve command groups: `init`, `doctor`, `status`, `scope`, `claim`, `gates`, `evidence`, `events`, `waiver`, `specs`, `worktree`, `agents` (plus the auto-generated `help`). Removed v10 commands (`validate`, `iterate`, `evaluate`, `diagnose`, `provenance`, `scaffold`, `parallel`, `mode`, `verify-acs`, `burnup`, `sidecar`, `test-analysis`, `templates`, legacy `hooks install`) are not registered with the CLI. Do NOT pin `caws-cli@^10.2.x`; v11.1 ships the full spec/worktree/agents surface.
>
> Doctrine source: [`docs/architecture/caws-vnext-command-surface.md`](../architecture/caws-vnext-command-surface.md). Full CLI reference: [`docs/api/cli.md`](../api/cli.md). When this guide and the doctrine doc disagree, the doctrine doc wins.

---

## Purpose & Philosophy

CAWS is an engineering-grade governance substrate for coding agents that:

1. **Forces planning before code** — no implementation without a per-feature spec under `.caws/specs/<id>.yaml`
2. **Treats tests as first-class artifacts** — tests drive implementation, evidence is recorded as ACs close
3. **Creates explainable, hash-chained audit trails** — every gate evaluation and evidence event lands in `.caws/events.jsonl` (append-only, hash-chained via the store)
4. **Enforces quality via policy-driven gates** — `policy.yaml` declares each gate's mode (block/warn/skip); `caws gates run --spec <id>` executes them

This guide teaches agents how to collaborate effectively with humans using v11 CAWS tooling and conventions.

---

## Quick Start for Agents

### Your First CAWS Project

When you encounter a CAWS project, follow this sequence:

1. **Find your spec**: Look for `.caws/specs/<id>.yaml` for your feature.
2. **Understand the scope**: Read `scope.in` and `scope.out` for the boundaries.
3. **Check risk tier**: T1 (critical), T2 (standard), T3 (low risk).
4. **Review acceptance criteria**: These are your implementation targets (Given/When/Then).
5. **Verify project health**: Run `caws doctor` and `caws status`. `caws scope check <path>` for each file you intend to touch.

### The Golden Rule

**Never write implementation code until:**

- A per-feature spec exists at `.caws/specs/<id>.yaml`
- Test plan is defined
- Acceptance criteria are clear
- Scope boundaries are understood (`caws scope show <path>` to confirm)

---

## Core Concepts

### Risk Tiers - Your Quality Contract

Risk tiers drive rigor and determine quality gates:

| Tier      | Use Case                    | Coverage | Mutation | Contracts | Review   |
| --------- | --------------------------- | -------- | -------- | --------- | -------- |
| **T1** | Auth, billing, migrations   | 90%+     | 70%+     | Required  | Manual   |
| **T2** | Features, APIs, data writes | 80%+     | 50%+     | Required  | Optional |
| **T3** | UI, internal tools          | 70%+     | 30%+     | Optional  | Optional |

**As an agent, you must:**

- Infer and declare the tier in your plan
- Meet or exceed tier requirements
- Request human review for Tier 1 changes
- Never downgrade a tier without human approval

### Key Invariants (Never Violate These)

1. **Scope Discipline**: Only edit files admitted by `scope.in`; check with `caws scope show <path>` before writing
2. **In-Place Refactors**: No shadow files (`enhanced-*`, `new-*`, `v2-*`, etc.)
3. **Deterministic Code**: Use injected time/uuid/random for testability
4. **Secure Prompts**: Never include secrets, `.env` files, or keys in context
5. **Provenance**: All changes are tracked via the hash-chained `events.jsonl` audit trail

### The Feature Spec - Your Blueprint

Every task needs a working spec at `.caws/specs/<spec-id>.yaml`. Create one with the CLI, then fill in the project-specific fields:

```bash
caws specs create FEAT-001 --title "Add user authentication flow" --mode feature --risk-tier 1
```

Then edit the generated file to add scope, invariants, acceptance, and non-functional requirements:

```yaml
id: FEAT-001
title: 'Add user authentication flow'
risk_tier: 1
mode: feature
lifecycle_state: active
operational_rollback_slo: '5m'
blast_radius:
  modules: ['auth', 'api']
  data_migration: false
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
  accessibility: ['keyboard-navigation', 'screen-reader-labels']
  performance: ['api p95 < 250ms', 'LCP < 2500ms']
  security: ['input-validation', 'csrf-protection', 'rate-limiting']
contracts:
  - name: 'auth-api'
    type: 'api'
    path: 'docs/api/auth.yaml'
```

---

## Your Development Workflow

### Phase 1: Plan (Before Any Code)

**Goal**: Author a per-feature spec and a test plan.

```bash
# 1. Create the spec via CLI — this is the canonical path
caws specs create <id> --title "Feature title" --mode feature --risk-tier 2

# 2. Edit the generated file to add scope, invariants, acceptance criteria
$EDITOR .caws/specs/<id>.yaml

# 3. Verify drift / structure
caws doctor

# 4. Review acceptance criteria — these are your targets
caws specs show <id>
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

- **DO**: Edit existing modules, use injected dependencies, write deterministic code
- **DON'T**: Create shadow files, hardcode timestamps/UUIDs, exceed change budget

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
## Feature Spec

- [ ] `.caws/specs/<spec-id>.yaml` attached and validates
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
- [ ] Evidence recorded: `caws evidence record --type ac --spec <id> --data '{...}'`
```

---

## CLI Commands Reference (v11)

> Full reference: [`docs/api/cli.md`](../api/cli.md). What follows is a quickstart per phase.

### Project initialization

```bash
caws init                # idempotent; refuses legacy .caws/working-spec.yaml residue
                          # creates .caws/specs/, .caws/waivers/, policy.yaml, worktrees.json, agents.json
                          # there is no --force in v11
```

### Validation and drift detection

```bash
caws doctor              # drift detection over .caws/ state
                          # exit 0 (clean) / 1 (findings or load errors) / 2 (composition failure)

caws status              # read-only dashboard; never mutates .caws/

caws scope show <path>   # explain the scope decision
caws scope check <path>  # enforce; exit 0 admit / 1 refuse
```

(v11 does not ship `caws validate` or `caws scaffold`. Use `caws specs create` to author specs, then `caws doctor` + `caws gates run --spec <id>` for validation.)

### Quality gates

```bash
caws gates run --spec <id>
# Policy declares each gate's mode (block/warn/skip).
# Appends one gate_evaluated event per declared gate to .caws/events.jsonl.
# Waivers filter matching violations out of the disposition.
```

### Evidence recording

```bash
# Record a test result
caws evidence record --type test --spec <id> \
  --data '{"name":"login_happy_path","status":"pass"}'

# Record an acceptance-criterion closure
caws evidence record --type ac --spec <id> \
  --data '{"id":"A1","status":"satisfied"}'

# Record a gate decision (rare — gates run records this automatically)
caws evidence record --type gate --spec <id> --data '{...}'
```

All append hash-chained events through the store's `appendEvent`. There is no other writer.

### Spec lifecycle

```bash
caws specs create <id> --title "..." --mode <feature|refactor|fix|doc|chore> --risk-tier <1|2|3>
                          # creates .caws/specs/<id>.yaml in lifecycle_state: active
caws specs list           # list specs (excludes archived by default)
caws specs show <id>      # read a spec (resolves through canonical control plane)
caws specs recover <id>   # recover an archived or retired spec body
caws specs retire-draft <id>
                          # governed retirement for never-activated draft specs
caws specs activate <id>  # governed activation for a pre-authored draft spec
caws specs amend-scope <id> --add <path>
                          # governed scope amendment; batch logical adds/removes in one call
caws specs close <id>     # close an active spec
caws specs archive <id>   # archive one closed spec
caws specs archive --status closed --include A,B --exclude B --apply
                          # batch archive selected closed specs with one aggregate audit commit
caws specs prune-archive  # compatibility no-op; archive bodies are canonical
caws specs migrate        # dry-run v10->v11 YAML migration
caws specs validate       # validate spec YAML records
```

### Worktree lifecycle

```bash
caws worktree create <name> --spec <id>
                          # create a git worktree bound to an active spec
                          # emits worktree_created + worktree_bound events
caws worktree list        # list registered worktrees with branch, spec, owner
caws worktree bind <name> # repair a one-sided worktree↔spec binding
caws worktree destroy <name>
                          # destroy a worktree (refuses foreign ownership)
caws worktree merge <name>
                          # merge the branch back to base; auto-closes the bound spec
caws worktree migrate-registry
                          # convert legacy registry envelope to v11 flat map
caws worktree repair-sparse <name>
                          # restore .caws/specs sparse-checkout invariant
caws worktree repair      # repair unambiguous doctor-surfaced half-states
```

### Worktree ownership

```bash
caws claim               # surface ownership of the current worktree
caws claim --takeover    # acquire from a foreign session (writes prior_owners audit)
                          # use only with explicit user authorization
caws scope contention <path>
                          # report other active worktrees that claim the same path
```

### Agent liveness

```bash
caws agents list          # list active/stale/stopped agents (read-only; operational cache)
caws agents show <id>     # show one lease by session id
caws agents prune --dead  # dry-run cleanup for dead local process leases
caws agents prune --status stopped --older-than-ms 604800000 --apply
                          # retention cleanup; operator-invoked, never hook-invoked
```

### Message and pre-push checks

```bash
caws message send --to <session-id> --text "Please inspect FEAT-1"
caws message poll --wait 60000
                          # directed messages; not authority, verify claims before acting
caws prepush --base origin/main --spec <id>
                          # classify outgoing commits; diagnose/decide only, does not push
```

(v11 does not ship `caws hooks install` or `caws provenance` commands. The hash-chained `events.jsonl` is the audit trail; record evidence with `caws evidence record`.)

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
vim .caws/specs/<spec-id>.yaml # Add root cause note
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

**Cause**: feature spec missing risk tier.

**Fix**:

```yaml
# Add to .caws/specs/<spec-id>.yaml
risk_tier: 2 # Choose 1, 2, or 3 based on impact
```

#### Error: `Invalid ID format`

**Cause**: ID doesn't match `PREFIX-NUMBER` or `PREFIX-SEGMENT-NUMBER` pattern.

**Fix**:

```yaml
# ❌ Bad
id: feature-001
id: FEAT001
id: feat_001

# ✅ Good (single-segment)
id: FEAT-001
id: FIX-042
id: REFACTOR-003

# ✅ Good (multi-segment — accepted since CAWSFIX-10)
id: P03-IMPL-01
id: ALG-001A-HARDEN-01
id: CAWSFIX-14
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

### Change too large

**Cause**: The change touches files or code well outside the stated blast_radius/scope, suggesting the slice should be broken up.

**Fix - Split PR**: Break into smaller, focused PRs, each with its own spec and clearly bounded scope.

Note: `change_budget` (max_files/max_loc) is not a valid v11 spec field. Scope enforcement is done by the scope guard via `scope.in` / `scope.out`. Use `caws waiver create` for bounded exceptions to policy gates.

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

## Audit trail (v11): events.jsonl

CAWS audit lives in `.caws/events.jsonl` — an append-only, hash-chained log written exclusively through the store's `appendEvent`. v11 does not ship the legacy `caws provenance` subtree; the hash-chained event log is the single audit surface.

### Writers

| Event type | Writer |
|---|---|
| `spec_created` | `caws specs create <id>` |
| `spec_closed` | `caws specs close <id>` |
| `spec_archived` | `caws specs archive <id>` |
| `worktree_created` | `caws worktree create <name> --spec <id>` |
| `worktree_bound` | `caws worktree create` / `caws worktree bind <name>` |
| `gate_evaluated` | `caws gates run --spec <id>` (one per declared gate) |
| `evidence_recorded` | `caws evidence record --type <kind> --spec <id> --data '{...}'` |
| `worktree_takeover` | `caws claim --takeover` (records `prior_owners` audit) |

There is no other path that writes `events.jsonl`. Hand-editing is forbidden — it breaks the chain.

### Reading the log

`events.jsonl` is plain JSON-Lines. Read with `jq` or any JSON-Lines tool:

```bash
jq -c '.' .caws/events.jsonl | tail -20
```

The log is never required at rest — invariant 5. `caws doctor` does not flag a missing `events.jsonl`; the first `appendEvent` creates it.

### Recording AI-assisted-change evidence

When a change is AI-assisted, record an evidence event so the audit trail captures it:

```bash
caws evidence record --type ac --spec <id> \
  --data '{"id":"A1","status":"satisfied","assistance":"ai","tool":"claude-code"}'
```

The evidence-event schema accepts arbitrary `--data` payloads; the project's policy decides which fields are required.

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

## Project archetypes (spec patterns)

v11's `caws init` is no-arg and ships no project-template scaffolds. `caws templates` is removed and is not planned to return. Use `caws specs create` to bootstrap a spec, then fill in project-specific fields. Below are recommended `risk_tier` and `non_functional` defaults for common archetypes.

### VS Code extension

```yaml
risk_tier: 2          # high user impact
non_functional:
  performance:
    - 'extension activation < 1000ms on typical machine'
  security:
    - csp-enforcement       # webview security
```

### React library

```yaml
risk_tier: 2          # API stability
non_functional:
  performance:
    - 'tree-shakeable bundle < 50KB'
```

### API service

```yaml
risk_tier: 1          # data integrity
non_functional:
  performance:
    - 'api p95 < 250ms'
  security:
    - input-validation
    - rate-limiting
```

### CLI tool

```yaml
risk_tier: 3          # low risk
```

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

Set budgets in working spec using `non_functional.performance` (string array):

```yaml
non_functional:
  performance:
    - 'api p95 < 250ms'
    - 'LCP < 2500ms'
    - 'TTI < 3500ms'
    - 'JS bundle < 50KB'
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

1. `caws specs create <id> --title "..." --mode <mode> --risk-tier <n>` — this is the canonical creation path
2. Edit `.caws/specs/<id>.yaml` to add scope, invariants, acceptance criteria, and non-functional requirements
3. Run `caws doctor` to verify drift / structure
4. Request human approval
5. Then implement

### Q: Can I exceed the change budget if the task requires it?

**A: Split the task.** If the change is too large for a single focused slice:

1. Break into multiple smaller PRs
2. Each with its own working spec
3. Each with a clearly bounded scope

`change_budget` (max_files/max_loc) is not a recognized spec field in v11. Scope and blast_radius govern the change boundary; use waivers (`caws waiver create`) for policy-driven gate exceptions.

### Q: What if lints fail but I think they're wrong?

**A: Fix the lints.** You can use `git commit --no-verify` to commit temporarily, but you cannot push without fixing. If the lint rule is incorrect:

1. Fix the code to satisfy the lint
2. Or request human discussion of the lint rule
3. Human can update lint config if appropriate
4. Note: `git push --no-verify` is BLOCKED

### Q: How do I record an AI-assisted change in the audit trail?

**A: Use `caws evidence record`.** v11 has no `caws provenance` or `caws hooks install` — the hash-chained `.caws/events.jsonl` is the audit surface. Record evidence per AC closure or test result:

```bash
caws evidence record --type ac --spec <id> \
  --data '{"id":"A1","status":"satisfied","assistance":"ai","tool":"claude-code"}'
```

The store appends a hash-chained event. There is no separate provenance file to maintain.

---

## Additional Resources

### Documentation

- **Complete Guide**: `docs/agents/full-guide.md` - Comprehensive CAWS reference
- **Tutorial**: `docs/agents/tutorial.md` - Step-by-step learning path
- **Examples**: `docs/agents/examples.md` - Real-world project examples

### Project-Specific

- **Getting Started**: `.caws/GETTING_STARTED.md` - Generated per project
- **Templates**: `.caws/templates/` - Feature plans, test plans, PR templates
- **Examples**: `.caws/examples/` - feature spec examples

### Cursor Rules

- **Rules Directory**: `.cursor/rules/` - Modular MDC rule files
- **Rules README**: `.cursor/rules/README.md` - Rule system documentation

---

## Summary Checklist

Before starting any work:

- [ ] feature spec exists and validates
- [ ] Risk tier is appropriate
- [ ] Acceptance criteria are clear
- [ ] Scope boundaries are defined
- [ ] Test plan is documented

During implementation:

- [ ] Write tests first (TDD)
- [ ] Stay within scope.in boundaries (`caws scope show <path>` before every write)
- [ ] Keep changes focused within the spec's blast_radius
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
- [ ] Evidence recorded for each AC closure (`caws evidence record --type ac --spec <id>`)

**Questions?** Check the full guide or ask your human collaborator.

---

_This guide is your companion for CAWS-driven development. Bookmark it, reference it often, and use it to deliver high-quality, well-tested, explainable code._
