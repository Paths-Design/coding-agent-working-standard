# CAWS Migration Guide: v3.4 → v3.5

**Agent-Agency Enhancements Edition**

This guide helps you migrate existing CAWS projects to take advantage of new features from agent-agency integration.

---

## What's New in v3.5

### ✨ TypeScript Type Definitions

- New package: `@paths.design/caws-types`
- Full type safety for TypeScript projects

### ✨ Enhanced Policy Management

- Quality thresholds in policy.yaml
- Waiver approval requirements
- Tiered validation rules

### ✨ JSON Output Format

- `--format=json` flag for validation
- Machine-readable results

### ✨ Budget Utilization Tracking

- Real-time budget percentage tracking
- Proactive warnings at 80%, 90%, 95%

### ✨ Tier-Specific Validation

- Tier 1 requires observability, rollback, security
- Stricter governance for critical changes

---

## Migration Steps

### Step 1: Update CAWS CLI

```bash
npm install -g @paths.design/caws-cli@^3.5.0
# or
npm install --save-dev @paths.design/caws-cli@^3.5.0
```

### Step 2: Update Policy File (Optional but Recommended)

**Current `.caws/policy.yaml`:**

```yaml
version: 1
risk_tiers:
  '1':
    max_files: 10
    max_loc: 250
```

**Enhanced `.caws/policy.yaml`:**

```yaml
version: 1
risk_tiers:
  '1':
    max_files: 10
    max_loc: 250
    coverage_threshold: 90 # NEW
    mutation_threshold: 70 # NEW
    contracts_required: true # NEW
    manual_review_required: true # NEW
    description: 'Critical changes requiring manual review'
  '2':
    max_files: 100
    max_loc: 10000
    coverage_threshold: 80
    mutation_threshold: 50
    contracts_required: true
    manual_review_required: false
    description: 'Standard features with automated gates'
  '3':
    max_files: 500
    max_loc: 40000
    coverage_threshold: 70
    mutation_threshold: 30
    contracts_required: false
    manual_review_required: false
    description: 'Low-risk changes with minimal oversight'

# NEW: Waiver approval policy
waiver_approval:
  required_approvers: 1
  max_duration_days: 90
  auto_revoke_expired: true
```

**Migration command:**

```bash
# Backup current policy
cp .caws/policy.yaml .caws/policy.yaml.backup

# Update with new fields (safe - old format still works)
# Just add the new fields manually or use sed:
```

### Step 3: Update Working Specs (Tier 1 Only)

If you have **Tier 1** working specs, you now need to add:

**Required additions:**

```yaml
# .caws/working-spec.yaml (Tier 1 changes)
risk_tier: 1

# NEW: Required for Tier 1
observability:
  logs:
    - 'Log user authentication attempts'
    - 'Log payment transaction status'
  metrics:
    - 'auth_attempts_total'
    - 'payment_success_rate'
  traces:
    - 'user-auth-flow'
    - 'payment-processing'

# NEW: Required for Tier 1
rollback:
  - '1. Revert database migrations using migration-down.sql'
  - '2. Rollback deployment to previous version'
  - '3. Verify auth system operational'

# NEW: Required for Tier 1 (must have security requirements)
non_functional:
  security:
    - 'Input validation on all user inputs'
    - 'CSRF protection on state-changing operations'
    - 'Rate limiting on auth endpoints'
  # ... existing a11y, perf
```

**Validation:**

```bash
# Check if your Tier 1 specs are compliant
caws validate .caws/working-spec.yaml
```

### Step 4: Audit Existing Waivers

Enhanced waiver validation now checks:

- Expiry dates (must be in future)
- Approval requirements (from policy)
- Required fields

**Check waiver status:**

```bash
caws waivers list
```

**Expected output:**

```
✅ WV-0001: Emergency hotfix (active, expires 2025-12-01)
⚠️  WV-0002: Legacy integration (expired 2025-09-15)
✅ WV-0003: Feature flag rollout (active, expires 2025-11-30)
```

**Fix expired waivers:**

```bash
# Expired waivers are now auto-rejected
# Either:
# 1. Remove waiver_ids from working specs
# 2. Create new waivers with future expiry
```

### Step 5: Add TypeScript Types (TypeScript Projects Only)

```bash
npm install @paths.design/caws-types
```

**Update your code:**

```typescript
// Before
const spec = {
  id: 'FEAT-001',
  risk_tier: 2,
  // ... no type safety
};

// After
import type { WorkingSpec } from '@paths.design/caws-types';

const spec: WorkingSpec = {
  id: 'FEAT-001',
  risk_tier: 2,
  // ... fully typed with IntelliSense
};
```

### Step 6: Update CI/CD (Optional)

**Use JSON output for programmatic parsing:**

```yaml
# .github/workflows/validate.yml
- name: Validate CAWS spec
  run: |
    result=$(caws validate --format=json)
    passed=$(echo "$result" | jq '.passed')

    if [ "$passed" = "false" ]; then
      echo "::error::CAWS validation failed"
      echo "$result" | jq '.validation.errors'
      exit 1
    fi
```

### Step 7: Test Budget Monitoring

```bash
# Check current budget usage
caws status

# You'll now see utilization percentages:
# Budget Usage:
#   Files: 45% (45/100)
#   LOC: 52% (5200/10000)
#   Overall: 52%
```

---

## Breaking Changes

### ⚠️ None

All changes are **backward compatible**.

**What still works:**

- Old policy.yaml format (new fields are optional)
- Default text output (JSON is opt-in via `--format`)
- Tier 2/3 specs without observability/rollback

**What's enhanced:**

- Validation is stricter for Tier 1
- Waiver expiry is enforced
- Budget warnings are more detailed

---

## Testing Your Migration

### Test 1: Validate Existing Spec

```bash
caws validate
# Should pass if it passed before
```

### Test 2: Check Budget Status

```bash
caws status
# Should show budget percentages
```

### Test 3: JSON Output

```bash
caws validate --format=json | jq '.passed'
# Should output: true or false
```

### Test 4: Waiver Validation

```bash
caws waivers list
# Should show status of all waivers
```

---

## Rollback Plan

If you encounter issues:

### Option 1: Revert CLI Version

```bash
npm install -g @paths.design/caws-cli@3.4.0
```

### Option 2: Restore Policy Backup

```bash
cp .caws/policy.yaml.backup .caws/policy.yaml
```

### Option 3: Temporary Tier Downgrade

```yaml
# In working-spec.yaml
# Temporarily downgrade to Tier 2 if Tier 1 validation fails
risk_tier: 2 # was 1
```

---

## Getting Help

### Common Issues

#### Issue: "Observability required for Tier 1 changes"

**Solution:** Add `observability` section to your working spec:

```yaml
observability:
  logs: ['Log key events']
  metrics: ['Important metrics']
  traces: ['Critical traces']
```

#### Issue: "Waiver WV-0001 expired"

**Solution:** Either remove the waiver from `waiver_ids` or create a new waiver:

```bash
caws waiver create \
  --title "Emergency budget extension" \
  --reason emergency_hotfix \
  --gates budget_limit \
  --expires-at 2025-12-31T23:59:59Z
```

#### Issue: "Policy file missing quality thresholds"

**Solution:** It's optional! Old format still works. But if you want the new features, add them:

```yaml
risk_tiers:
  '1':
    # ... existing fields
    coverage_threshold: 90 # add these
    mutation_threshold: 70
```

---

## Benefits After Migration

### For Developers

- ✅ Better type safety (TypeScript)
- ✅ Clearer validation errors
- ✅ Proactive budget warnings

### For Teams

- ✅ Enforced Tier 1 rigor
- ✅ Policy-driven governance
- ✅ Automated waiver expiry

### For CI/CD

- ✅ Machine-readable results
- ✅ Easy pipeline integration
- ✅ Consistent error formats

---

## Timeline

**Recommended migration timeline:**

- **Week 1**: Update CLI, test existing specs
- **Week 2**: Update policy.yaml, audit waivers
- **Week 3**: Add TypeScript types (if applicable)
- **Week 4**: Update CI/CD, train team

---

## Support

- **Documentation**: `docs/agents/full-guide.md`
- **Examples**: `docs/agents/examples.md`
- **Issues**: GitHub Issues
- **Community**: Discord (#caws-support)

---

**Migration checklist:**

- [ ] Updated CAWS CLI to v3.5+
- [ ] Backed up .caws/policy.yaml
- [ ] Updated policy.yaml with new fields (optional)
- [ ] Validated all Tier 1 specs have observability/rollback/security
- [ ] Audited waivers for expiry
- [ ] Tested `caws validate --format=json`
- [ ] Updated CI/CD pipelines (optional)
- [ ] Installed @paths.design/caws-types (TypeScript projects)
- [ ] Trained team on new features

**Status**: Ready to migrate  
**Estimated time**: 2-4 hours for most projects  
**Risk**: Low (backward compatible)
