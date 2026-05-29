# @paths.design/caws-types

TypeScript type definitions for CAWS (Coding Agent Working Standard).

## Installation

```bash
npm install @paths.design/caws-types
```

## Usage

```typescript
import {
  WorkingSpec,
  CAWSValidationResult,
  CAWSPolicy,
  BudgetCompliance,
} from '@paths.design/caws-types';

// Type-safe working spec
const spec: WorkingSpec = {
  id: 'FEAT-001',
  title: 'Add user authentication',
  risk_tier: 2,
  mode: 'feature',
  // ... rest of spec
};

// Type-safe validation result
const result: CAWSValidationResult = {
  passed: true,
  verdict: 'pass',
  cawsVersion: '<caws-cli-version>',  // e.g. '11.1.6'
  timestamp: new Date().toISOString(),
  budgetCompliance: {
    /* ... */
  },
  qualityGates: [],
  waivers: [],
};
```

## Exported Types

> **Authoritative list**: Run `npm run build` and inspect `dist/index.d.ts` for the complete, current export surface. The sections below document the primary stable exports; the package also exports placeholder governance types (`PlaceholderImpact`, `PlaceholderReason`, `PlaceholderScope`, etc.) from `placeholder-types` and `placeholder-helpers`.

### Working Spec Types

- `WorkingSpec` - Complete CAWS working specification
- `AcceptanceCriterion` - Given-When-Then acceptance criteria
- `ContractDefinition` - API contract definitions
- `CAWSConfig` - CAWS configuration from package.json

### Validation Types

- `CAWSValidationResult` - Complete validation result
- `BudgetCompliance` - Budget check results
- `QualityGateResult` - Individual gate results
- `WaiverApplication` - Applied waiver details
- `SpecValidationResult` - Spec structure validation
- `ValidationError` - Validation error details
- `ValidationWarning` - Validation warnings
- `AutoFix` - Auto-fix suggestions

### Policy Types

- `CAWSPolicy` - Complete policy configuration
- `RiskTierConfiguration` - Tier-specific settings
- `PolicyEditRules` - Policy governance rules
- `WaiverApprovalPolicy` - Waiver approval requirements
- `TierRequirements` - Computed tier requirements

### Budget Types

- `BudgetLimits` - Max files and LOC limits
- `ChangeStats` - Current change statistics
- `BudgetViolation` - Budget violation details
- `DerivedBudget` - Budget after waivers applied
- `BudgetUtilization` - Budget usage percentages

### Waiver Types

- `WaiverDocument` - Complete waiver document
- `WaiverApplication` - Applied waiver reference

## Type Safety Benefits

- **Compile-time checking**: Catch errors before runtime
- **IntelliSense support**: Auto-completion in IDEs
- **Documentation**: Types serve as inline documentation
- **Refactoring safety**: TypeScript ensures type consistency

## Version Compatibility

This package is versioned independently from the CAWS CLI. The current package version is **2.0.0**; the current CLI version is **11.1.6**. Major versions do not track each other. Check the [CHANGELOG](./CHANGELOG.md) or the package release notes for compatibility information when upgrading either package.

## License

MIT
