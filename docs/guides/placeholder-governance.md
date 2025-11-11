# Placeholder Governance System

**Explicit, bounded placeholder degradations with "no-surprises" contract enforcement.**

## Overview

The placeholder governance system ensures that when agents must degrade output due to token budgets, missing dependencies, or time constraints, those degradations are:

1. **Explicit** - Declared with full metadata
2. **Bounded** - Scoped to specific sections
3. **Justified** - Reason documented
4. **Safe** - Paired with fallbacks that preserve acceptance

## Operating Principle

**No Silent Placeholders.** Any elision must be:
- (a) Declared
- (b) Scoped
- (c) Justified
- (d) Paired with a concrete fallback that still satisfies the caller's acceptance

## When Placeholders Are Legitimate

Placeholders are acceptable when:

- **Token/latency ceilings**: Must hit a fixed token budget or timebox
- **Unavailable dependencies**: Missing library (e.g., `onnxruntime` for 3.14)
- **Redaction/PII**: Information must be obscured
- **Non-critical expansion**: Long narrative or examples that exceed target length

Placeholders are **not acceptable** for:
- Required acceptance criteria (schema validity, executable code regions)
- Safety disclaimers
- Citations promised in spec
- Critical business logic

## Placeholder Contract Schema

### JSON Envelope Format

```json
{
  "status": "ok | degraded",
  "result": {
    "type": "doc|code|json|plan",
    "value": "..."
  },
  "placeholders": [
    {
      "id": "PH-2025-11-11-001",
      "scope": "examples|citations|section|file_region",
      "location": "docs/guide.md#Rationale",
      "reason": "token_budget | dependency_missing | timebox | redaction",
      "budget": {
        "tokens_remaining": 92,
        "hard_cap": 1200
      },
      "impact": "non_blocking | partial | blocks_acceptance",
      "required_by": "acceptance_id|null",
      "fallback": "summarized bullet list without examples",
      "debt_note": "Generate 3 citations with quotes <=25w",
      "expiry": "2025-11-13T23:59:00Z"
    }
  ],
  "telemetry": {
    "tokens_used": 1108,
    "tokens_cap": 1200,
    "elapsed_ms": 1780,
    "confidence": 0.86
  }
}
```

### Markdown Degradations Section

For prose responses (not JSON), encode the same data tersely:

```markdown
## Degradations

- **[examples]** (token_budget): replaced with 3 summary bullets; see `PH-001` (non_blocking)
- **[citations]** (timebox): citation keys included, quotes deferred; see `PH-002` (partial)
```

## Acceptance Gates

### Gate P0 - Schema Validity

**Requirement**: Output must be syntactically valid (JSON, code compiles, doc builds) even if degraded.

**Validation**:
- All required fields present (`id`, `scope`, `reason`, `impact`, `fallback`)
- Valid enum values for `impact` and `reason`
- Proper structure

### Gate P1 - Placeholder Registry

**Requirement**: If any placeholders exist, `status=degraded` and `placeholders[].impact != blocks_acceptance`.

**Validation**:
- If placeholders exist → status must be "degraded"
- If status is "degraded" → placeholders array must exist
- No placeholders with `impact="blocks_acceptance"`

### Gate P2 - Debt Budget

**Requirement**: Max `N` open placeholders per artifact and total debt score ≤ threshold.

**Limits**:
- Documents: ≤2 placeholders
- Code files: ≤1 placeholder
- JSON/config: ≤1 placeholder
- Plans: ≤2 placeholders
- Tests: ≤1 placeholder

**Debt Score Calculation**:
- `non_blocking`: weight 1
- `partial`: weight 3
- `blocks_acceptance`: weight 10 (not allowed)

**Maximum debt score**: 10 per artifact

### Gate P3 - No Dangling Promises

**Requirement**: Reject if text includes "TODO", "TBD", "later", "see above" without matching placeholder entry.

**Patterns Detected**:
- `TODO`, `TBD`, `later`, `see above`
- `coming soon`, `will be implemented`, `to be added`

**Exception**: If promise text appears in a placeholder's `debt_note` or near a placeholder ID reference, it's allowed.

### Gate P4 - Safety/Attribution Non-Degradable

**Requirement**: If acceptance includes "citations present" or "license headers present," placeholders are disallowed in that scope.

**Non-degradable scopes**:
- `code_region` - Critical code sections
- `implementation` - Business logic implementation

## TypeScript Usage

### Basic Validation

```typescript
import {
  AgentEnvelope,
  validatePlaceholderGovernance,
  passesPlaceholderGovernance,
  assertNoBlockingPlaceholders,
} from '@paths.design/caws-types';

const envelope: AgentEnvelope = {
  status: 'degraded',
  result: {
    type: 'doc',
    value: '...',
  },
  placeholders: [
    {
      id: 'PH-2025-11-11-001',
      scope: 'examples',
      reason: 'token_budget',
      impact: 'non_blocking',
      fallback: '3 summary bullets',
    },
  ],
};

// Validate all gates
const results = validatePlaceholderGovernance(envelope);
const allPass = results.every((r) => r.passed);

// Quick check
if (passesPlaceholderGovernance(envelope)) {
  console.log('Placeholder governance passed');
}

// Assert no blocking placeholders
assertNoBlockingPlaceholders(envelope); // Throws if blocking found
```

### Debt Score Calculation

```typescript
import { calculateDebtScore, DEFAULT_PLACEHOLDER_CONFIG } from '@paths.design/caws-types';

const debtScore = calculateDebtScore(envelope.placeholders || []);
console.log(`Debt score: ${debtScore.total}/${DEFAULT_PLACEHOLDER_CONFIG.maxDebtScore}`);
```

## Quality Gates Integration

The placeholder governance gate runs automatically as part of CAWS quality gates:

```bash
# Run all gates (includes placeholder governance)
npm run quality-gates

# Run only placeholder gate
npm run quality-gates -- --gates=placeholders
```

### Gate Output

```
Checking placeholder governance...
   No placeholder governance violations found
```

Or if violations found:

```
Checking placeholder governance...
    Enforcement level: BLOCK
   1 placeholder governance findings (block mode)
   ❌ BLOCKING VIOLATIONS (1) - COMMIT BLOCKED:
   
PLACEHOLDERS: BLOCKING_PLACEHOLDERS
   Found 1 placeholder(s) that block acceptance criteria
   File: docs/guide.md
```

## Authoring Rules for Agents

### System Prompt Constraints

Embed these constraints into agent system prompts:

1. **Constraint**: If you can't deliver a required section within budget, *shrink fidelity* before eliding. Prefer compression (bullets, tables) over omission.

2. **Constraint**: If you *must* omit, emit a **single** concise placeholder object per omitted scope; do not scatter ambiguous TODOs.

3. **Constraint**: Provide an immediate **fallback** that preserves acceptance (e.g., "3 bullets summarizing the missing case study").

4. **Constraint**: Never placeholder critical sections: APIs, types, JSON keys, error handling, a11y notes, license/citation blocks.

5. **Output pattern**: Close with a **Degradations** section listing each placeholder in one line: `[scope] reason → fallback (impact)`.

### Minimal System Prompt Addition

> If constrained by token/time, first convert rich text to compressed bullets; if still over budget, replace only non-critical sections with explicit placeholders including scope, reason, and fallback. Do not leave silent omissions. Never placeholder acceptance-critical items.

## Examples

### Good (Documentation)

```markdown
### Error Handling

... concise rules ...

*Degradations:*
• **Examples** (token_budget): replaced with 3 summary bullets; see `PH-001` (non_blocking).
```

### Poor (Documentation)

```markdown
"We'll fill in examples later."  ← No scope, no reason, no fallback.
```

### Good (Code)

```typescript
export function parseConfig(src: string): Config {
  // Placeholder PH-002 (token_budget): strict schema validation replaced with basic shape check.
  // Fallback preserves runtime safety: unknown fields are rejected.
  const obj = JSON.parse(src);
  if (!obj || typeof obj !== "object" || typeof obj.env !== "string") {
    throw new Error("Invalid Config");
  }
  // TODO(debt PH-002): add zod schema with defaults & unions by 2025-11-13
  return obj as Config;
}
```

### Poor (Code)

```typescript
// TODO: validate this later
return JSON.parse(src);
```

## CAWS Integration

### Risk Tiering

- **Tier 1**: Placeholders forbidden unless waiver cites ID, owner, expiry, and acceptance impact
- **Tier 2/3**: Placeholders allowed within debt budget limits

### Debt Ledger

Aggregate `placeholders[].impact` into a numeric *debt score* surfaced in report cards; require a burn-down before promotion to release.

### Quality Gate Commands

```bash
# Check placeholder governance
caws quality-gates --gates=placeholders

# Validate with TypeScript
import { validatePlaceholderGovernance } from '@paths.design/caws-types';
```

## Telemetry & UX

### Section-Level Token Attribution

Log *where* budgets are blown (section-level token attribution):

```typescript
telemetry: {
  section_tokens: {
    "introduction": 150,
    "examples": 800,
    "conclusion": 50
  }
}
```

### Pre-Flight Estimator

Predict tokens for planned outline before generation; down-scale early.

### Auto-Offer Compression Choices

For interactive runs, offer choices:
- "Keep examples, drop citations?"
- "Keep citations, compress examples?"

## Configuration

Default configuration can be overridden:

```typescript
import { PlaceholderGovernanceConfig } from '@paths.design/caws-types';

const customConfig: PlaceholderGovernanceConfig = {
  maxPlaceholdersPerArtifact: {
    doc: 3,  // Allow more in docs
    code: 0, // Forbid in code
    // ...
  },
  maxDebtScore: 15,
  impactWeights: {
    non_blocking: 1,
    partial: 5,
    blocks_acceptance: 20,
  },
  allowTier1Placeholders: false,
  nonDegradableScopes: ['code_region', 'implementation', 'tests'],
  requiredPlaceholderFields: ['id', 'scope', 'reason', 'impact', 'fallback', 'expiry'],
};
```

## Bottom Line

Keep placeholders, but make them contractual: explicit, scoped, justified, and paired with a safe fallback. Enforce the contract in CI and prompts, and you'll preserve trust *and* velocity even under tight budgets.

