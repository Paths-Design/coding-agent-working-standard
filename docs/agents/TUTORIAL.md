# CAWS Tutorial - Step-by-Step Guide

**Hands-on tutorial for implementing CAWS in your project**

---

## 🎯 Tutorial Overview

This tutorial walks you through implementing CAWS for a simple feature. We'll build a "user preferences" feature with proper planning, testing, and quality gates.

**Time**: ~45 minutes  
**Level**: Beginner to Intermediate  
**Prerequisites**: Node.js project with basic testing setup

---

## 📋 Tutorial Scenario

**Feature**: Add user preferences storage to a web application

**Requirements**:
- Store user preferences in localStorage
- Support dark/light theme preference
- Validate preference values
- Handle storage errors gracefully
- Include proper TypeScript types

**Risk Level**: Tier 2 (standard feature with data persistence)

---

## Step 1: Initialize CAWS

### Create Working Spec

```bash
# Initialize with interactive wizard
caws init --interactive
```

**Wizard Responses**:
- Project type: `application`
- Title: `Add User Preferences Storage`
- Risk tier: `2` (Standard feature)
- Mode: `feature`
- Max files: `8` (reasonable for this feature)
- Max lines: `200` (focused implementation)
- Modules: `ui, storage, types`
- Data migration: `No`
- Rollback SLO: `5m`

**Result**: `.caws/working-spec.yaml` is created with:

```yaml
id: PREF-001
title: "Add User Preferences Storage"
risk_tier: 2
mode: feature
change_budget:
  max_files: 8
  max_loc: 200
# ... rest auto-generated
```

### Customize Working Spec

Edit `.caws/working-spec.yaml` to add project-specific details:

```yaml
scope:
  in: ["src/preferences/", "src/types/", "tests/"]
  out: ["src/unrelated/", "node_modules/"]

invariants:
  - "Preferences are validated before storage"
  - "Invalid preferences fall back to defaults"
  - "Storage errors don't crash the application"
  - "TypeScript types prevent runtime errors"

acceptance:
  - id: "A1"
    given: "User changes theme preference"
    when: "Preference is saved"
    then: "Theme persists across browser sessions"
  - id: "A2"
    given: "Invalid preference value is provided"
    when: "Save is attempted"
    then: "Value is rejected and default is used"
  - id: "A3"
    given: "localStorage is unavailable"
    when: "Preference save is attempted"
    then: "Operation fails gracefully without errors"

non_functional:
  a11y: ["keyboard navigation", "screen reader support"]
  perf: { api_p95_ms: 50 }
  security: ["input validation", "XSS prevention"]
```

### Validate Spec

```bash
caws validate --suggestions
```

**Expected**: ✅ Valid spec

---

## Step 2: Plan the Implementation

### Copy Feature Template

```bash
cp .caws/templates/feature.plan.md docs/plans/PREF-001.md
```

### Fill in Feature Plan

Edit `docs/plans/PREF-001.md`:

```markdown
# PREF-001: Add User Preferences Storage

## Problem Statement
Users need to persist their preferences (theme, language, etc.) across browser sessions.

## Proposed Solution
Implement a preferences system using localStorage with TypeScript types and validation.

## Technical Approach
- Create TypeScript interfaces for preferences
- Implement storage layer with error handling
- Add validation and defaults
- Integrate with existing UI components

## Files to Create/Modify
1. `src/types/preferences.ts` - TypeScript interfaces
2. `src/preferences/storage.ts` - Storage implementation
3. `src/preferences/validation.ts` - Input validation
4. `src/preferences/hooks.ts` - React hooks (if applicable)
5. `tests/preferences/storage.test.ts` - Unit tests
6. `tests/preferences/validation.test.ts` - Validation tests

## Testing Strategy
- Unit tests for storage operations
- Validation tests for edge cases
- Integration tests for error handling
- Manual testing for UI integration

## Risk Assessment
- **Data Loss**: localStorage can be cleared → Mitigation: Graceful degradation
- **Type Safety**: Runtime validation needed → Mitigation: TypeScript + runtime checks
- **Browser Support**: localStorage availability → Mitigation: Feature detection

## Rollback Plan
1. Remove preference-related imports
2. Delete preference files
3. Revert any UI changes
4. Clear localStorage keys (optional)
```

---

## Step 3: Write Tests First (TDD)

### Create Test Files

**`tests/preferences/storage.test.ts`**:
```typescript
import { describe, it, expect, beforeEach } from '@jest/globals';
import { PreferencesStorage } from '../../src/preferences/storage';

describe('PreferencesStorage', () => {
  let storage: PreferencesStorage;

  beforeEach(() => {
    storage = new PreferencesStorage();
    localStorage.clear();
  });

  it('should store and retrieve preferences', () => {
    const prefs = { theme: 'dark', language: 'en' };
    storage.save(prefs);

    const retrieved = storage.load();
    expect(retrieved).toEqual(prefs);
  });

  it('should handle localStorage unavailable', () => {
    // Mock localStorage unavailable
    const originalGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error('Storage unavailable'); };

    expect(() => storage.load()).not.toThrow();
    expect(storage.load()).toEqual({});

    Storage.prototype.getItem = originalGetItem;
  });

  it('should validate preferences before saving', () => {
    const invalidPrefs = { theme: 'invalid' };
    expect(() => storage.save(invalidPrefs)).toThrow('Invalid theme');
  });
});
```

**`tests/preferences/validation.test.ts`**:
```typescript
import { describe, it, expect } from '@jest/globals';
import { validatePreferences, DEFAULT_PREFERENCES } from '../../src/preferences/validation';

describe('validatePreferences', () => {
  it('should accept valid preferences', () => {
    const validPrefs = { theme: 'dark', language: 'en' };
    expect(validatePreferences(validPrefs)).toBe(true);
  });

  it('should reject invalid theme', () => {
    const invalidPrefs = { theme: 'invalid' };
    expect(() => validatePreferences(invalidPrefs)).toThrow();
  });

  it('should provide defaults for missing values', () => {
    const partialPrefs = { theme: 'light' };
    const result = validatePreferences(partialPrefs);
    expect(result).toEqual({
      theme: 'light',
      language: DEFAULT_PREFERENCES.language
    });
  });
});
```

### Run Tests (Should Fail)

```bash
npm test
```

**Expected**: Tests fail because implementation doesn't exist yet

---

## Step 4: Implement the Feature

### Create TypeScript Interfaces

**`src/types/preferences.ts`**:
```typescript
export interface UserPreferences {
  theme: 'light' | 'dark' | 'auto';
  language: string;
  notifications: boolean;
  autoSave: boolean;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  theme: 'light',
  language: 'en',
  notifications: true,
  autoSave: true,
};
```

### Implement Validation

**`src/preferences/validation.ts`**:
```typescript
import { UserPreferences, DEFAULT_PREFERENCES } from '../types/preferences';

export function validatePreferences(prefs: Partial<UserPreferences>): UserPreferences {
  const validated: UserPreferences = { ...DEFAULT_PREFERENCES };

  if (prefs.theme) {
    if (!['light', 'dark', 'auto'].includes(prefs.theme)) {
      throw new Error(`Invalid theme: ${prefs.theme}`);
    }
    validated.theme = prefs.theme;
  }

  if (prefs.language) {
    if (typeof prefs.language !== 'string' || prefs.language.length < 2) {
      throw new Error('Invalid language code');
    }
    validated.language = prefs.language;
  }

  if (typeof prefs.notifications === 'boolean') {
    validated.notifications = prefs.notifications;
  }

  if (typeof prefs.autoSave === 'boolean') {
    validated.autoSave = prefs.autoSave;
  }

  return validated;
}
```

### Implement Storage Layer

**`src/preferences/storage.ts`**:
```typescript
import { UserPreferences, DEFAULT_PREFERENCES } from '../types/preferences';
import { validatePreferences } from './validation';

const STORAGE_KEY = 'user-preferences';

export class PreferencesStorage {
  save(preferences: Partial<UserPreferences>): void {
    try {
      const validated = validatePreferences(preferences);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(validated));
    } catch (error) {
      // Validation error or storage error
      throw new Error(`Failed to save preferences: ${error.message}`);
    }
  }

  load(): UserPreferences {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return DEFAULT_PREFERENCES;

      const parsed = JSON.parse(stored);
      return validatePreferences(parsed);
    } catch (error) {
      // Storage unavailable or corrupted data
      console.warn('Failed to load preferences, using defaults:', error.message);
      return DEFAULT_PREFERENCES;
    }
  }

  clear(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      // Storage unavailable, ignore
    }
  }
}
```

### Run Tests (Should Pass)

```bash
npm test
```

**Expected**: All tests pass ✅

---

## Step 5: Verify Quality Gates

### Check Change Budget

```bash
# Count files changed
find src/ tests/ -name "*.ts" -newer .caws/working-spec.yaml | wc -l

# Count lines changed
find src/ tests/ -name "*.ts" -newer .caws/working-spec.yaml -exec wc -l {} + | tail -1
```

**Expected**: Within budget (8 files, 200 lines)

### Run Validation

```bash
caws validate --quiet
```

**Expected**: ✅ No validation errors

### Check Coverage

```bash
npm run test:coverage
```

**Expected**: ≥80% branch coverage for Tier 2

### Manual Verification

1. **Acceptance Criteria**:
   - ✅ Theme preference persists across sessions
   - ✅ Invalid values are rejected with defaults
   - ✅ Storage errors handled gracefully

2. **Invariants**:
   - ✅ Preferences are validated before storage
   - ✅ Invalid preferences fall back to defaults
   - ✅ Storage errors don't crash the application
   - ✅ TypeScript types prevent runtime errors

---

## Step 6: Update Documentation

### Update Working Spec

If scope changed during implementation, update `.caws/working-spec.yaml`:

```yaml
# Add any new files to scope.in
scope:
  in: ["src/preferences/", "src/types/", "tests/", "src/hooks/"]
```

### Generate Final Report

```bash
# Generate completion report
node apps/tools/caws/completion-report.js PREF-001
```

---

## Step 7: Create PR

### Use PR Template

```bash
cp .caws/templates/pr.md docs/prs/PREF-001.md
```

### Fill in PR Template

```markdown
## Title: feat: Add user preferences storage

## Description
Implements persistent user preferences with localStorage, including theme and language settings.

## Working Spec
- **ID**: PREF-001
- **Risk Tier**: 2
- **Change Budget**: 8 files, 200 lines
- **Actual Changes**: 6 files, 145 lines

## Files Changed
- `src/types/preferences.ts` (25 lines)
- `src/preferences/storage.ts` (45 lines)
- `src/preferences/validation.ts` (35 lines)
- `tests/preferences/storage.test.ts` (60 lines)
- `tests/preferences/validation.test.ts` (40 lines)
- `.caws/working-spec.yaml` (minor updates)

## Testing
- Unit tests: 100% coverage
- Validation tests: All edge cases covered
- Manual testing: All acceptance criteria verified

## Quality Gates
- ✅ Validation: Working spec valid
- ✅ Coverage: 85% branch coverage
- ✅ Tests: All passing
- ✅ Manual Review: Ready for review

## Rollback Plan
1. Remove preference imports from components
2. Delete preference files
3. Clear localStorage keys
4. Revert UI integration changes

## Acceptance Criteria
- [x] Theme preference persists across sessions
- [x] Invalid preferences fall back to defaults
- [x] Storage errors handled gracefully
- [x] TypeScript types prevent runtime errors
```

---

## 🎉 Tutorial Complete!

You've successfully implemented a CAWS-managed feature with:

- ✅ Proper planning with working spec
- ✅ Test-driven development
- ✅ Quality gates and validation
- ✅ Comprehensive documentation
- ✅ Rollback planning

### What You Learned

1. **Planning First**: Working spec prevents scope creep
2. **Tests as Safety**: TDD catches issues early
3. **Validation Matters**: Automated checks maintain quality
4. **Documentation Pays**: Clear PRs speed up reviews
5. **Rollback Ready**: Always plan for failures

### Next Steps

1. **Apply to Real Work**: Use this pattern for your next feature
2. **Customize Templates**: Adapt templates to your team's needs
3. **Set Up CI**: Configure quality gates in your pipeline
4. **Team Training**: Share this approach with your team

### Resources

- **Working Spec**: `.caws/working-spec.yaml`
- **Tests**: `tests/preferences/`
- **Documentation**: `docs/plans/PREF-001.md`
- **Templates**: `.caws/templates/`

---

## 🧪 Bonus: Advanced Testing

For more robust testing, add property-based tests:

```typescript
import { fc } from 'fast-check';

describe('PreferencesStorage - Property Tests', () => {
  it('should round-trip any valid preferences', () => {
    fc.assert(
      fc.property(
        fc.record({
          theme: fc.constantFrom('light', 'dark', 'auto'),
          language: fc.string({ minLength: 2, maxLength: 5 }),
          notifications: fc.boolean(),
          autoSave: fc.boolean(),
        }),
        (prefs) => {
          const storage = new PreferencesStorage();
          storage.save(prefs);
          const loaded = storage.load();
          expect(loaded).toEqual({ ...DEFAULT_PREFERENCES, ...prefs });
        }
      )
    );
  });
});
```

This ensures your storage works correctly with any valid input combination.

---

**Happy coding with CAWS! 🎯**

**Tutorial Version**: 1.0  
**CAWS Version**: 3.1.0  
**Last Updated**: October 2, 2025
