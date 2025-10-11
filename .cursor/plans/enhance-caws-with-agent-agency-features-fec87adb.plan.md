<!-- fec87adb-64e1-4ca5-9037-238272092376 1b3f3e96-ab41-4edd-922b-398b4f0d39b1 -->
# Enhance CAWS with Agent-Agency Features

## Overview

Agent-agency built a clean TypeScript implementation of CAWS validation that includes several improvements over the current JavaScript CAWS CLI. This plan identifies and ports beneficial features back to core CAWS.

---

## Key Innovations to Adopt

### 1. **Comprehensive Type Definitions** ✅ HIGH VALUE

**What they built:**

- `validation-types.ts` (482 lines): Complete TypeScript definitions for all CAWS structures
- Includes: `CAWSValidationResult`, `BudgetCompliance`, `QualityGateResult`, `WaiverApplication`, etc.
- Strong typing for all validation flows

**Why CAWS needs this:**

- Current CAWS CLI is JavaScript with inconsistent JSDoc types
- Agent validation results lack standardized structure
- Makes integration with TypeScript projects difficult

**Action:** Create `@paths.design/caws-types` package

- Export all validation types
- Provide TypeScript definitions for working specs, policies, waivers
- Enable type-safe CAWS integrations

---

### 2. **Enhanced Policy Management** ✅ CRITICAL

**What they built:**

```typescript
interface CAWSPolicy {
  version: string;
  risk_tiers: Record<number, {
    max_files: number;
    max_loc: number;
    coverage_threshold: number;     // ← NEW
    mutation_threshold: number;     // ← NEW
    contracts_required: boolean;    // ← NEW
    manual_review_required: boolean; // ← NEW
  }>;
  waiver_approval?: {              // ← NEW SECTION
    required_approvers: number;
    max_duration_days: number;
  };
}
```

**Why CAWS needs this:**

- Current policy.yaml only tracks budgets (max_files, max_loc)
- Quality thresholds are hardcoded in CLI commands
- No formal waiver approval policy

**Action:** Extend `.caws/policy.yaml` schema

- Add quality thresholds to tier definitions
- Add waiver approval requirements
- Migrate existing projects with safe defaults

---

### 3. **Structured Validation Results** ✅ HIGH VALUE

**What they built:**

```typescript
interface CAWSValidationResult {
  passed: boolean;
  verdict: "pass" | "fail" | "waiver-required";
  budgetCompliance: BudgetCompliance;
  qualityGates: QualityGateResult[];
  waivers: WaiverApplication[];
  remediation?: string[];          // ← Actionable fixes
  metadata?: ValidationMetadata;   // ← Rich context
  signature?: string;              // ← Future: cryptographic proof
}
```

**Why CAWS needs this:**

- Current validation returns inconsistent formats (text, JSON mixed)
- Hard to programmatically parse validation results
- No standard for remediation guidance

**Action:** Standardize validation output

- Add `--format=json` flag to all validation commands
- Implement `CAWSValidationResult` in CLI
- Provide human-readable and machine-readable formats

---

### 4. **Budget Utilization Tracking** ✅ MEDIUM VALUE

**What they built:**

```typescript
class BudgetValidator {
  calculateUtilization(compliance): { files: number; loc: number; overall: number }
  isApproachingLimit(compliance, threshold = 90): boolean
  generateBurnupReport(compliance, tier): string
}
```

**Why CAWS needs this:**

- Current budget checking is binary (pass/fail)
- No visibility into how close to limits
- Agents need proactive warnings

**Action:** Add budget utilization metrics

- Show percentage used (e.g., "45% of file budget used")
- Emit warnings at 80%, 90% thresholds
- Generate visual burn-up reports

---

### 5. **Waiver Validation & Expiry** ✅ CRITICAL

**What they built:**

```typescript
class WaiverManager {
  isWaiverValid(waiver): boolean {
    // Check status, expiration, approvals
    if (waiver.status !== 'active') return false;
    if (now > expiryDate) return false;
    if (waiver.approvers.length === 0) return false;
    return true;
  }
}
```

**Why CAWS needs this:**

- Current waiver system doesn't validate expiry
- No enforcement of approval requirements
- Expired waivers can still be applied

**Action:** Add waiver lifecycle management

- Automatic expiry checking
- Approval requirement validation
- Status tracking (active → expired → revoked)

---

### 6. **Structured Auto-Fix System** ✅ MEDIUM VALUE

**What they built:**

```typescript
interface AutoFix {
  field: string;
  value: unknown;
  description: string;  // Explain what was fixed
}

validator.validateWithSuggestions(spec, { autoFix: true });
```

**Why CAWS needs this:**

- Current `--auto-fix` is limited
- No visibility into what was auto-fixed
- Can't preview fixes before applying

**Action:** Enhance auto-fix system

- Return structured `AutoFix` objects
- Add `--dry-run` preview mode
- Show detailed descriptions of fixes

---

### 7. **Tier-Specific Validation** ✅ HIGH VALUE

**What they built:**

```typescript
private validateTierRequirements(spec: WorkingSpec) {
  // Tier 1 requires observability
  if (spec.risk_tier === 1) {
    if (!spec.observability) {
      errors.push({ field: 'observability', message: '...' });
    }
    if (!spec.rollback || spec.rollback.length === 0) {
      errors.push({ field: 'rollback', message: '...' });
    }
  }
}
```

**Why CAWS needs this:**

- Current validation doesn't enforce tier-specific requirements
- Tier 1 changes don't require rollback plans
- Security requirements not enforced for Tier 1

**Action:** Add tiered validation rules

- Tier 1: Require observability, rollback, security requirements
- Tier 2: Require contracts for external APIs
- Tier 3: Relaxed requirements
- Document requirements per tier in schema

---

### 8. **Experimental Mode Validation** ✅ LOW VALUE (Future)

**What they built:**

```typescript
interface ExperimentalMode {
  enabled: boolean;
  rationale: string;
  expires_at: string;
}
// Only allowed for Tier 3
// Must have future expiration date
```

**Why CAWS could benefit:**

- Formalize experimental feature workflow
- Time-box experiments with auto-expiry
- Reduce quality requirements for prototypes

**Action:** Add experimental mode (post-MVP)

- Allow reduced requirements for Tier 3 + experimental
- Enforce expiration dates
- Auto-promote or remove on expiry

---

### 9. **Comprehensive Test Patterns** ✅ MEDIUM VALUE

**What they built:**

- 369 lines of spec validator tests
- 492 lines of budget validator tests
- Helper functions for test fixtures
- Parameterized test cases

**Why CAWS needs this:**

- Current CAWS CLI tests are sparse
- No systematic validation coverage
- Hard to ensure regression-free changes

**Action:** Expand CAWS test suite

- Add comprehensive validator tests
- Create test fixture helpers
- Achieve 90%+ coverage on core validation

---

## Implementation Priorities

### P0: Critical (Week 1-2)

1. ✅ Create `@paths.design/caws-types` package with TypeScript definitions
2. ✅ Extend policy.yaml schema with quality thresholds and waiver approval
3. ✅ Standardize validation output with `CAWSValidationResult`
4. ✅ Add waiver expiry and approval validation

### P1: High Value (Week 3-4)

5. ✅ Add budget utilization tracking and warnings
6. ✅ Implement tier-specific validation rules
7. ✅ Enhance auto-fix with structured suggestions
8. ✅ Add comprehensive test coverage

### P2: Nice to Have (Future)

9. ❌ Experimental mode support (low urgency)
10. ❌ Cryptographic verdict signatures (future security)

---

## Benefits to Core CAWS

### For Agents

- **Type-safe integrations**: TypeScript agents get proper IntelliSense
- **Proactive warnings**: Know when approaching budget limits
- **Clear remediation**: Structured guidance on fixing validation errors

### For Humans

- **Better visibility**: See exactly how much budget is used
- **Governance enforcement**: Expired waivers auto-rejected
- **Consistent experience**: Same result format across all commands

### For Ecosystem

- **Interoperability**: Shared types enable tool ecosystem
- **Extensibility**: Clear interfaces for custom gates/validators
- **Reliability**: Comprehensive tests prevent regressions

---

## Migration Strategy

### Phase 1: Add Without Breaking

- Publish `@paths.design/caws-types` as new package
- Add extended policy schema fields (optional, backward compatible)
- Introduce `--format=json` flag (keep text as default)

### Phase 2: Enhance Existing

- Update internal validators to use new types
- Add budget utilization to status output
- Implement waiver validation checks

### Phase 3: Deprecate Old Patterns

- Mark old output formats as deprecated
- Migrate documentation to new patterns
- Update templates and examples

---

## Success Criteria

✅ **Type Safety**: All validation operations have TypeScript definitions

✅ **Governance**: Expired waivers cannot be applied

✅ **Visibility**: Budget usage shown as percentages with warnings

✅ **Standardization**: Validation results follow `CAWSValidationResult` schema

✅ **Testing**: 90%+ coverage on validation logic

---

## Files to Create/Modify

### New Files

- `packages/caws-types/` - New package for TypeScript definitions
  - `src/validation-types.ts`
  - `src/caws-types.ts`
  - `src/policy-types.ts`
  - `package.json`
  - `tsconfig.json`

### Modified Files

- `packages/caws-cli/src/commands/validate.js` - Add JSON output format
- `packages/caws-cli/src/budget-derivation.js` - Add utilization tracking
- `packages/caws-cli/src/validation/spec-validation.js` - Add tier validation
- `packages/caws-cli/templates/policy.yaml` - Extend schema
- `.caws/policy.schema.json` - Update JSON schema
- `docs/api/schema.md` - Document extended types

### New Tests

- `packages/caws-cli/tests/validation/spec-validator.test.js`
- `packages/caws-cli/tests/validation/budget-validator.test.js`
- `packages/caws-cli/tests/validation/waiver-manager.test.js`

---

## Open Questions

1. **Backward Compatibility**: Keep old policy.yaml format supported for 1-2 major versions?
2. **Type Package Versioning**: Should `@paths.design/caws-types` follow CAWS CLI versions or independent semver?
3. **Migration Tools**: Provide `caws migrate-policy` command for schema upgrades?
4. **Default Values**: What thresholds for new policy fields if not specified?

---

**Status**: Ready for review and prioritization

**Estimated Effort**: 3-4 weeks for P0+P1

**Dependencies**: None (can start immediately)

**Risk**: Low (all additions are backward compatible)

### To-dos

- [ ] Create @paths.design/caws-types package with TypeScript definitions from agent-agency implementation
- [ ] Extend policy.yaml schema with quality thresholds, manual_review_required, and waiver approval requirements
- [ ] Implement CAWSValidationResult structure with --format=json flag in all validation commands
- [ ] Add waiver expiry validation and approval requirement checking to WaiverManager
- [ ] Add budget utilization tracking with percentage calculations and threshold warnings
- [ ] Implement tier-specific validation rules (observability for T1, contracts for T1/T2, etc.)
- [ ] Enhance auto-fix system with structured suggestions and dry-run preview mode
- [ ] Port test patterns from agent-agency and achieve 90%+ coverage on validation logic