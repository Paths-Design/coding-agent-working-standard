# @paths.design/caws-types

TypeScript type definitions for CAWS (Coding Agent Workflow System).

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
  cawsVersion: '3.4.0',
  timestamp: new Date().toISOString(),
  budgetCompliance: {
    /* ... */
  },
  qualityGates: [],
  waivers: [],
};
```

## Exported Types

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

This package follows the CAWS CLI versioning:

- Major version matches CAWS CLI major version
- Minor/patch versions may diverge for type-only changes

## License

MIT
