# CAWS Waiver Troubleshooting Guide

**For AI Agents and Developers**

## Quick Fix: Waiver Not Applying

If you're seeing budget violations despite creating a waiver, check these common issues:

### Issue 1: Invalid Waiver ID Format

**Symptom**: Waiver file exists but validation still fails

**Cause**: Waiver ID doesn't match required format

**Check**:

```bash
cat .caws/waivers/WV-*.yaml | grep "^id:"
```

**Required Format**: `WV-XXXX` where XXXX is exactly 4 digits (0000-9999)

**Examples**:

- ✅ `WV-0001`
- ✅ `WV-9999`
- ❌ `WV-ARB-003-COMPLETION` (no descriptive text allowed)
- ❌ `WV-1` (must be 4 digits, use `WV-0001`)
- ❌ `waiver-001` (must start with `WV-`)

**Fix**:

```bash
# Rename waiver file and update ID
mv .caws/waivers/WV-ARB-003-COMPLETION.yaml .caws/waivers/WV-0001.yaml

# Edit .caws/waivers/WV-0001.yaml
# Change: id: WV-ARB-003-COMPLETION
# To:     id: WV-0001
```

---

### Issue 2: Waiver Not Referenced in Working Spec

**Symptom**: Waiver file exists but budget validation ignores it

**Cause**: Waiver must be explicitly referenced in working spec

**Check**:

```bash
grep -A5 "waiver_ids:" .caws/working-spec.yaml
```

**Expected Output**:

```yaml
waiver_ids:
  - WV-0001
```

**Fix**:

```yaml
# Edit .caws/working-spec.yaml
# Add this field (or append to existing array):

id: PROJECT-001
risk_tier: 2
waiver_ids:
  - WV-0001 # ← Add this
```

---

### Issue 3: Waiver Doesn't Cover Budget Gate

**Symptom**: Waiver referenced but budget validation still fails

**Cause**: Waiver must explicitly cover the `budget_limit` gate

**Check**:

```bash
cat .caws/waivers/WV-0001.yaml | grep -A3 "^gates:"
```

**Expected Output**:

```yaml
gates:
  - budget_limit
```

**Fix**:

```yaml
# Edit .caws/waivers/WV-0001.yaml
# Ensure gates includes budget_limit:

gates:
  - budget_limit # ← Must include this for budget violations
```

---

### Issue 4: Policy File Not Loading

**Symptom**: "Policy file not found" despite creating `.caws/policy.yaml`

**Possible Causes**:

1. Wrong working directory
2. Stale cache
3. Path resolution issue

**Diagnostic Steps**:

```bash
# 1. Verify file exists
ls -la .caws/policy.yaml

# 2. Check current directory
pwd

# 3. Verify you're in project root (should see .caws/ folder)
ls -la .caws/

# 4. Run validation with diagnostics
caws validate --format json 2>&1 | grep -A5 "policy"
```

**If file exists but not found**:

Check the validation output for diagnostic information:

```
⚠️  Policy file exists but not loaded: /path/to/.caws/policy.yaml
   Current working directory: /different/path
   Project root: /detected/root
   Cache status: HIT (may be stale)
```

**Fixes**:

**Option A: Run from correct directory**

```bash
cd /path/to/project-root
caws validate
```

**Option B: Clear cache (if stale)**

```bash
# Clear CAWS cache (implementation-dependent)
rm -rf ~/.caws-cache 2>/dev/null || true

# Re-validate
caws validate
```

**Option C: Specify project root explicitly**

```bash
caws validate --project-root /path/to/project
```

---

### Issue 5: Manually Editing change_budget in Working Spec

**Symptom**: Changing `change_budget.max_files` or `max_loc` has no effect

**Cause**: Budget is **derived** from policy + waivers, not stored in working spec

**Incorrect Approach**:

```yaml
# .caws/working-spec.yaml
change_budget:
  max_files: 50 # ← Editing this does nothing
  max_loc: 7000 # ← Budget is derived, not read from here
```

**Correct Approach**:

Budget is calculated as:

```
effective_budget = policy.risk_tiers[X].budget + waiver.delta
```

**To increase budget**:

1. Create waiver with delta
2. Reference waiver in working spec
3. Let CAWS derive the budget

**Example**:

```yaml
# .caws/policy.yaml
risk_tiers:
  2:
    max_files: 25
    max_loc: 1000

# .caws/waivers/WV-0001.yaml
id: WV-0001
delta:
  max_files: 25
  max_loc: 4000

# .caws/working-spec.yaml
risk_tier: 2
waiver_ids:
  - WV-0001
# Result: effective budget = 50 files, 5000 LOC
```

---

## Complete Waiver Workflow

### Step 1: Create Valid Waiver File

```yaml
# .caws/waivers/WV-0001.yaml
id: WV-0001
title: 'Emergency Budget Extension for ARBITER-003'
reason: 'emergency_hotfix'
description: |
  Completing constitutional authority integration requires exceeding
  standard Tier 2 budget due to foundational system changes.
status: active
gates:
  - budget_limit
expires_at: '2025-10-31T23:59:59Z'
approvers:
  - 'tech-lead@example.com'
delta:
  max_files: 25
  max_loc: 4000
risk_assessment:
  impact_level: 'medium'
  mitigation_plan: |
    - Comprehensive test coverage (92% pass rate)
    - Incremental rollout with feature flags
    - Constitutional governance for future changes
```

### Step 2: Reference in Working Spec

```yaml
# .caws/working-spec.yaml
id: PROJECT-001
title: 'ARBITER-003 Integration'
risk_tier: 2
mode: feature
waiver_ids:
  - WV-0001
# Do NOT manually set change_budget - it's derived
```

### Step 3: Validate

```bash
caws validate

# Should show:
# ✅ Working spec validation passed
# Budget: 50 files, 5000 LOC (baseline + waiver)
```

### Step 4: Commit and Push

```bash
git add .caws/
git commit -m "chore: Add budget waiver for ARBITER-003 integration"
git push
```

---

## Error Messages Explained

### "Invalid waiver ID format"

**Full Message**:

```
❌ Invalid waiver ID format: WV-ARB-003-COMPLETION
   Waiver IDs must be exactly 4 digits: WV-0001 through WV-9999
   Fix waiver_ids in .caws/working-spec.yaml
```

**Fix**: Use 4-digit numeric suffix only (WV-0001, not WV-ARB-003)

---

### "Waiver file not found"

**Full Message**:

```
❌ Waiver file not found: WV-0001
   Expected location: /path/to/.caws/waivers/WV-0001.yaml
   Create waiver with: caws waiver create
```

**Fix**: Create waiver file at specified location or fix waiver_ids reference

---

### "Waiver does not cover 'budget_limit' gate"

**Full Message**:

```
⚠️  Waiver WV-0001 does not cover 'budget_limit' gate
   Current gates: [coverage_threshold]
   Add 'budget_limit' to gates array to apply to budget violations
```

**Fix**: Add `budget_limit` to waiver's `gates` array

---

### "Budget exceeded but no waivers referenced"

**Full Message**:

```
⚠️  Budget exceeded but no waivers referenced
   Add waiver_ids: ["WV-0001"] to working spec, then create waiver file
```

**Fix**: Add `waiver_ids` array to working spec

---

## Validation Checklist

Before committing, verify:

- [ ] Waiver file exists: `.caws/waivers/WV-XXXX.yaml`
- [ ] Waiver ID is 4 digits: `id: WV-0001`
- [ ] Waiver includes budget_limit gate: `gates: [budget_limit]`
- [ ] Working spec references waiver: `waiver_ids: [WV-0001]`
- [ ] Policy file exists: `.caws/policy.yaml`
- [ ] Validation passes: `caws validate`
- [ ] Budget shows effective limit: baseline + delta

---

## When to Use Waivers

**Valid Use Cases**:

- Emergency hotfixes requiring immediate deployment
- Foundational changes affecting multiple systems
- Legacy integration with constrained scope
- Performance-critical optimizations
- Time-boxed experimental features

**Invalid Use Cases**:

- Routine feature development (adjust policy instead)
- Avoiding quality standards
- Skipping required testing
- Bypassing security reviews

---

## Getting Help

### For Agents

If stuck after following this guide:

1. Check agent diagnosis: `docs/internal/AGENT_WAIVER_POLICY_DIAGNOSIS.md`
2. Review quick summary: `docs/internal/AGENT_STUCK_QUICK_SUMMARY.md`
3. Consult full guide: `docs/agents/full-guide.md`

### For Developers

```bash
# Show validation output with full diagnostics
caws validate --format json

# Check waiver status
caws waivers list

# Verify policy loading
cat .caws/policy.yaml

# Test budget derivation
node -e "
const { deriveBudget } = require('@paths.design/caws-cli/src/budget-derivation');
const spec = require('./.caws/working-spec.yaml');
deriveBudget(spec, process.cwd()).then(console.log);
"
```

---

## Related Documentation

- [Agent Integration Guide](agent-integration-guide.md)
- [Working with Quality Gates](../agents/full-guide.md#quality-gates)
- [Policy Configuration](../api/quality-gates.yaml)
- [Waiver Lifecycle Management](../api/quality-gates.yaml#/components/schemas/Waiver)
