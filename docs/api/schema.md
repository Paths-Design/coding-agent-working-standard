---
doc_id: caws-schema
authority: reference
status: active
title: CAWS Schema Specifications (v11.1.6)
owner: vNext rewrite team
updated: 2026-05-28
---

# CAWS Schema Specifications

## Overview

CAWS uses JSON Schema for validation and TypeScript interfaces for type safety. This document provides complete specifications for all CAWS schemas and data structures.

## Feature Specification Schema

> **Note:** vNext is multi-spec only. Specs live at `.caws/specs/<id>.yaml`. There is no legacy single-file `working-spec.yaml`. The kernel's canonical JSON Schema lives at `packages/caws-kernel/src/schemas/spec.v1.json` with `additionalProperties: false` — it rejects any field not listed in that schema (including `change_budget`, `acceptance_criteria`, `status`, and any v10 aliases).

The feature specification defines a single feature's requirements and constraints.

### JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://caws.paths.design/schemas/spec.v1.json",
  "title": "CAWS Spec",
  "description": "Strict spec schema for CAWS v11. Authority for spec shape, lifecycle, and forbidden surfaces. Rejects: change_budget, acceptance_criteria, mode:development, scope.include, scope.exclude, unknown top-level fields.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "id",
    "title",
    "risk_tier",
    "mode",
    "lifecycle_state",
    "blast_radius",
    "scope",
    "invariants",
    "acceptance",
    "non_functional",
    "contracts"
  ],
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\\d+[a-z]*$",
      "description": "Spec identifier. Uppercase prefix segments, numeric final segment, optional lowercase suffix.",
      "examples": ["FEAT-001", "CAWS-RELEASE-TAG-DRIVEN-001", "AUTH-007a"]
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200,
      "description": "Descriptive spec title"
    },
    "risk_tier": {
      "type": "integer",
      "enum": [1, 2, 3],
      "description": "Tier 1 most strict, Tier 3 least. String forms ('T1', '1') are NOT accepted."
    },
    "mode": {
      "type": "string",
      "enum": ["feature", "refactor", "fix", "doc", "chore"],
      "description": "Closed vocabulary. 'development' is rejected — choose a real mode."
    },
    "lifecycle_state": {
      "type": "string",
      "enum": ["draft", "active", "closed", "archived"],
      "description": "Primary lifecycle axis. Replaces v10 'status:' field (rejected by kernel)."
    },
    "resolution": {
      "type": "string",
      "enum": ["completed", "superseded", "abandoned"],
      "description": "Only set after closure (lifecycle_state in {closed, archived})."
    },
    "blockers": {
      "type": "array",
      "description": "Operational metadata for active specs. NOT a lifecycle state. Blocked specs still enforce scope.",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["reason"],
        "properties": {
          "reason": { "type": "string", "minLength": 1 },
          "waiting_on": { "type": "string" },
          "since": { "type": "string", "format": "date-time" }
        }
      }
    },
    "supersedes": {
      "type": "string",
      "pattern": "^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\\d+[a-z]*$",
      "description": "When resolution=superseded, the spec id this one supersedes."
    },
    "superseded_by": {
      "type": "string",
      "pattern": "^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\\d+[a-z]*$",
      "description": "When this spec is itself superseded by another."
    },
    "worktree": {
      "type": "string",
      "pattern": "^[a-zA-Z0-9_-]+$",
      "description": "Bidirectional binding: when set, worktrees.json[worktree].specId must equal this spec's id."
    },
    "operational_rollback_slo": {
      "type": "string",
      "description": "Time budget for operational rollback (e.g. '5m', '1h'). Required for Tier 1 via semantic check (not JSON Schema required).",
      "examples": ["5m", "1h", "24h"]
    },
    "blast_radius": {
      "type": "object",
      "additionalProperties": false,
      "required": ["modules"],
      "properties": {
        "modules": {
          "type": "array",
          "items": { "type": "string", "minLength": 1 },
          "minItems": 1,
          "description": "Non-empty list of modules affected by this change"
        },
        "data_migration": {
          "type": "boolean",
          "description": "Whether data migration is required (optional)"
        }
      }
    },
    "scope": {
      "type": "object",
      "additionalProperties": false,
      "description": "Authoritative scope. 'in' is required and non-empty. 'out' rejects glob patterns. 'include'/'exclude' aliases are NOT accepted.",
      "required": ["in"],
      "properties": {
        "in": {
          "type": "array",
          "items": { "type": "string", "minLength": 1 },
          "minItems": 1,
          "description": "Files/directories in scope (literal prefix matches)"
        },
        "out": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "not": { "pattern": "[*?]" },
            "description": "Directory paths only. Glob patterns (*, ?) are rejected."
          },
          "description": "Files/directories explicitly out of scope. No glob patterns."
        }
      }
    },
    "invariants": {
      "type": "array",
      "items": { "type": "string", "minLength": 1 },
      "minItems": 1,
      "description": "System invariants that must be maintained throughout this slice"
    },
    "acceptance": {
      "type": "array",
      "description": "Acceptance criteria in Given/When/Then format. Canonical key. 'acceptance_criteria' alias is rejected.",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "given", "when", "then"],
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^A\\d+$",
            "description": "Acceptance criteria ID, e.g. A1, A2"
          },
          "given": { "type": "string", "minLength": 1 },
          "when": { "type": "string", "minLength": 1 },
          "then": { "type": "string", "minLength": 1 },
          "test_command": { "type": "string" },
          "test_nodeids": { "type": "array", "items": { "type": "string" } },
          "evidence": { "type": "string" },
          "narrative": { "type": "string" }
        }
      }
    },
    "non_functional": {
      "type": "object",
      "additionalProperties": false,
      "description": "Exactly four permitted subkeys. Observability concerns belong under reliability.",
      "properties": {
        "performance": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Performance requirements as free-text strings"
        },
        "security": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Security requirements as free-text strings"
        },
        "accessibility": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Accessibility requirements as free-text strings"
        },
        "reliability": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Reliability and observability requirements as free-text strings"
        }
      }
    },
    "contracts": {
      "type": "array",
      "description": "Tier 1+2 require non-empty contracts (semantic check). Empty array is structurally valid for Tier 3.",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "type"],
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1,
            "description": "Contract name"
          },
          "type": {
            "type": "string",
            "enum": ["api", "schema", "contract-test", "behavior"],
            "description": "Contract type"
          },
          "path": {
            "type": "string",
            "description": "Optional path to contract specification"
          },
          "description": {
            "type": "string",
            "description": "Optional description"
          }
        }
      }
    },
    "observability": {
      "type": "array",
      "description": "Observability statements as free-text strings. Tier 1 required via semantic check.",
      "items": { "type": "string" }
    },
    "rollback": {
      "type": "array",
      "description": "Rollback steps as free-text strings. Tier 1 required non-empty via semantic check.",
      "items": { "type": "string" }
    },
    "experimental_mode": {
      "type": "object",
      "description": "Tier 3 only. Semantic check rejects on Tier 1 or 2.",
      "additionalProperties": false,
      "required": ["enabled", "rationale", "expires_at"],
      "properties": {
        "enabled": { "type": "boolean" },
        "rationale": { "type": "string", "minLength": 1 },
        "expires_at": { "type": "string", "format": "date-time" }
      }
    },
    "created_at": { "type": "string", "format": "date-time" },
    "updated_at": { "type": "string", "format": "date-time" },
    "owner": { "type": "string" },
    "closure_notes": { "type": "string" }
  }
}
```

> **Removed in v11:** `change_budget` (with `max_files`/`max_loc`) is rejected by the kernel. File and LOC budgets now derive from `.caws/policy.yaml` risk-tier thresholds; the spec never encodes them directly.

> **Rejected fields (kernel returns `spec.schema.violation`):** `change_budget`, `acceptance_criteria`, `scope.include`, `scope.exclude`, `status` (use `lifecycle_state`), `migrations`, `human_override`, `ai_assessment`, `git_config`, `threats`, `notes`, `non_goals`, `bounded_claim`, `dependencies`, `type` (top-level), `description` (top-level).

### TypeScript Interface

```typescript
interface CawsSpec {
  // Required fields (11)
  id: string;                        // Pattern: ^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\d+[a-z]*$
  title: string;
  risk_tier: 1 | 2 | 3;
  mode: 'feature' | 'refactor' | 'fix' | 'doc' | 'chore';
  lifecycle_state: 'draft' | 'active' | 'closed' | 'archived';
  blast_radius: BlastRadius;
  scope: SpecScope;
  invariants: string[];              // minItems: 1
  acceptance: AcceptanceCriteria[];  // minItems: 1
  non_functional: NonFunctional;
  contracts: ContractSpec[];

  // Optional fields
  resolution?: 'completed' | 'superseded' | 'abandoned';
  blockers?: Blocker[];
  supersedes?: string;               // spec id pattern
  superseded_by?: string;            // spec id pattern
  worktree?: string;                 // bound worktree name
  operational_rollback_slo?: string; // e.g. "5m", "1h" — required for Tier 1 via semantic check
  observability?: string[];          // required for Tier 1 via semantic check
  rollback?: string[];               // required non-empty for Tier 1 via semantic check
  experimental_mode?: ExperimentalMode; // Tier 3 only
  created_at?: string;               // ISO 8601
  updated_at?: string;               // ISO 8601
  owner?: string;
  closure_notes?: string;
}

interface BlastRadius {
  modules: string[];       // Non-empty list of affected modules
  data_migration?: boolean; // Optional; not required
}

interface SpecScope {
  in: string[];            // Required, non-empty; literal prefix matches
  out?: string[];          // Optional; directory paths only, no glob patterns
}

interface AcceptanceCriteria {
  id: string;              // Pattern: ^A\d+$
  given: string;
  when: string;
  then: string;
  test_command?: string;
  test_nodeids?: string[];
  evidence?: string;
  narrative?: string;
}

interface NonFunctional {
  // additionalProperties: false — exactly these four subkeys permitted
  performance?: string[];
  security?: string[];
  accessibility?: string[];
  reliability?: string[];  // Use for observability concerns too
}

interface ContractSpec {
  name: string;                                          // Required
  type: 'api' | 'schema' | 'contract-test' | 'behavior'; // Required
  path?: string;
  description?: string;
}

interface Blocker {
  reason: string;          // Required
  waiting_on?: string;
  since?: string;          // ISO 8601
}

interface ExperimentalMode {
  enabled: boolean;
  rationale: string;
  expires_at: string;      // ISO 8601
}
```

### Example: Tier-2 Feature Spec

```yaml
id: CAWS-AUTH-001
title: "Add OAuth2 token refresh endpoint"
risk_tier: 2
mode: feature
lifecycle_state: active
blast_radius:
  modules:
    - packages/caws-cli/src/commands/auth
    - packages/caws-cli/tests/auth
scope:
  in:
    - packages/caws-cli/src/commands/auth
    - packages/caws-cli/tests/auth
  out:
    - .caws/policy.yaml
    - CODEOWNERS
invariants:
  - "Existing auth tokens remain valid after this change"
  - "No new top-level commands added to the CLI surface"
acceptance:
  - id: A1
    given: "A valid refresh token exists"
    when: "the user runs caws auth refresh"
    then: "a new access token is issued and the old one is revoked"
  - id: A2
    given: "An expired refresh token is presented"
    when: "the user runs caws auth refresh"
    then: "the command exits non-zero with a structured error message"
non_functional:
  security:
    - "Refresh tokens must be single-use; reuse returns 401"
    - "Tokens stored at rest must be encrypted"
  reliability:
    - "Refresh endpoint must return within 500ms at p95"
  performance: []
  accessibility: []
contracts:
  - name: "auth-token-api"
    type: api
    path: docs/api/auth-token.yaml
    description: "Token refresh endpoint contract"
created_at: "2026-05-28T00:00:00Z"
updated_at: "2026-05-28T00:00:00Z"
owner: "darianrosebrook"
```

### Example: Tier-1 Spec (with required Tier-1 fields)

```yaml
id: CAWS-INFRA-001
title: "Migrate events.jsonl to append-only store"
risk_tier: 1
mode: refactor
lifecycle_state: active
operational_rollback_slo: "5m"
blast_radius:
  modules:
    - packages/caws-kernel/src/store
  data_migration: true
scope:
  in:
    - packages/caws-kernel/src/store
    - packages/caws-kernel/tests/store
invariants:
  - "events.jsonl remains hash-chained after migration"
  - "All existing event types validate against their v1 schemas"
acceptance:
  - id: A1
    given: "An existing events.jsonl file"
    when: "the migration runs"
    then: "all events are re-validated and the chain is intact"
non_functional:
  reliability:
    - "Migration must be atomic — partial write leaves the store in original state"
  performance:
    - "Migration completes in under 30s for a 10k-event log"
  security: []
  accessibility: []
contracts:
  - name: "events-jsonl-append-only"
    type: schema
    path: packages/caws-kernel/src/schemas/events
observability:
  - "Emit migration_started and migration_completed events"
  - "Log event count and chain-hash before and after"
rollback:
  - "git revert the migration commit"
  - "Restore events.jsonl from pre-migration backup at .caws/events.jsonl.bak"
created_at: "2026-05-28T00:00:00Z"
updated_at: "2026-05-28T00:00:00Z"
owner: "darianrosebrook"
```

## Audit Surface: .caws/events.jsonl

The `caws provenance` command was removed in v11 and there is no provenance schema in the kernel. The audit surface is the hash-chained `.caws/events.jsonl` file, which receives typed event records appended by lifecycle commands (`caws gates run`, `caws specs close`, `caws specs archive`, `caws worktree create`, etc.). Each event record carries a `prev_hash` field that chains to the previous entry. The event schemas live at `packages/caws-kernel/src/schemas/events/*.v1.json`.

Users needing an audit trail wire their own hooks against `caws gates run` output; they do not consume a provenance manifest.

## Tier Policy Configuration

### JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "CAWS Tier Policy",
  "type": "object",
  "patternProperties": {
    "^[1-3]$": {
      "type": "object",
      "properties": {
        "min_branch": {
          "type": "number",
          "minimum": 0,
          "maximum": 1
        },
        "min_mutation": {
          "type": "number",
          "minimum": 0,
          "maximum": 1
        },
        "requires_contracts": {
          "type": "boolean"
        },
        "requires_manual_review": {
          "type": "boolean"
        },
        "allowed_modes": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": ["feature", "refactor", "fix", "doc", "chore"]
          }
        }
      },
      "required": [
        "min_branch",
        "min_mutation",
        "requires_contracts",
        "allowed_modes"
      ]
    }
  }
}
```

> **Note:** `max_files` and `max_loc` are no longer part of the tier policy schema. Change budgets were removed from the spec schema in v11; budget enforcement derives entirely from `.caws/policy.yaml` risk-tier configuration.

### TypeScript Interface

```typescript
interface TierPolicy {
  [tier: string]: {
    min_branch: number;                // 0-1
    min_mutation: number;              // 0-1
    requires_contracts: boolean;       // Contract requirement
    requires_manual_review?: boolean;  // Manual review needed
    allowed_modes: Mode[];             // Allowed project modes
  };
}

type Mode = 'feature' | 'refactor' | 'fix' | 'doc' | 'chore';
```

## Tool Allowlist Schema

### JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "CAWS Tool Allowlist",
  "type": "array",
  "items": {
    "type": "string"
  },
  "minItems": 1,
  "uniqueItems": true
}
```

### TypeScript Interface

```typescript
type ToolAllowlist = string[];
```

## Waivers

In v11, waivers are per-file records at `.caws/waivers/<id>.yaml`. They are created, listed, and revoked via the `caws waiver` command group (singular — there is no `caws waivers` alias).

### v11 Waiver File Schema

Each `.caws/waivers/<id>.yaml` file has the following shape:

```yaml
id: WAIVER-001
gate: coverage
reason: "Bootstrapping phase — coverage gate not yet wired for this package"
approved_by: "darianrosebrook"
expires_at: "2026-08-01T00:00:00Z"
spec_id: CAWS-AUTH-001   # optional: scope waiver to a specific spec
created_at: "2026-05-28T00:00:00Z"
```

### Creating a Waiver

```bash
caws waiver create <id> \
  --gate <gate-name> \
  --reason "..." \
  --approved-by "<approver>" \
  --expires-at <iso8601>
```

Gate names are policy-defined (configured in `.caws/policy.yaml`). Waivers filter violations; they do not change the gate's `mode` (block/warn/skip). The reason field is free-text — no closed enum.

### TypeScript Interface

```typescript
interface WaiverRecord {
  id: string;             // Waiver identifier
  gate: string;           // Policy-defined gate name (free-text; not a closed enum)
  reason: string;         // Free-text rationale
  approved_by: string;    // Approver identifier
  expires_at: string;     // ISO 8601
  spec_id?: string;       // Optional: scope waiver to a specific spec
  created_at?: string;    // ISO 8601
}
```

## SBOM Schema (SPDX)

### JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "SPDX Software Bill of Materials",
  "type": "object",
  "properties": {
    "spdxId": {
      "type": "string",
      "const": "SPDXRef-DOCUMENT"
    },
    "spdxVersion": {
      "type": "string",
      "const": "SPDX-2.3"
    },
    "creationInfo": {
      "type": "object",
      "properties": {
        "created": {
          "type": "string",
          "format": "date-time"
        },
        "creators": {
          "type": "array",
          "items": { "type": "string" }
        }
      },
      "required": ["created", "creators"]
    },
    "name": { "type": "string" },
    "dataLicense": { "type": "string" },
    "SPDXID": { "type": "string" },
    "documentNamespace": { "type": "string" },
    "packages": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "SPDXID": { "type": "string" },
          "name": { "type": "string" },
          "version": { "type": "string" },
          "downloadLocation": { "type": "string" },
          "filesAnalyzed": { "type": "boolean" },
          "supplier": { "type": "string" },
          "originator": { "type": "string" },
          "copyrightText": { "type": "string" },
          "packageVerificationCode": {
            "type": "object",
            "properties": {
              "packageVerificationCodeValue": { "type": "string" }
            }
          }
        },
        "required": ["SPDXID", "name", "downloadLocation", "filesAnalyzed"]
      }
    },
    "relationships": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "spdxElementId": { "type": "string" },
          "relationshipType": { "type": "string" },
          "relatedSpdxElement": { "type": "string" }
        },
        "required": ["spdxElementId", "relationshipType", "relatedSpdxElement"]
      }
    }
  },
  "required": [
    "spdxId",
    "spdxVersion",
    "creationInfo",
    "name",
    "dataLicense",
    "SPDXID",
    "documentNamespace",
    "packages"
  ]
}
```

### TypeScript Interface

```typescript
interface SPDXDocument {
  spdxId: 'SPDXRef-DOCUMENT';
  spdxVersion: 'SPDX-2.3';
  creationInfo: CreationInfo;
  name: string;
  dataLicense: string;
  SPDXID: string;
  documentNamespace: string;
  packages: Package[];
  relationships?: Relationship[];
}

interface CreationInfo {
  created: string;  // ISO 8601
  creators: string[];
}

interface Package {
  SPDXID: string;
  name: string;
  version: string;
  downloadLocation: string;
  filesAnalyzed: boolean;
  supplier?: string;
  originator?: string;
  copyrightText?: string;
  packageVerificationCode?: {
    packageVerificationCodeValue: string;
  };
}

interface Relationship {
  spdxElementId: string;
  relationshipType: string;
  relatedSpdxElement: string;
}
```

## Validation

All schemas are validated using:

### JSON Schema Validation
- **Library**: Ajv (Another JSON Schema Validator)
- **Version**: Draft 2020-12
- **Features**: Full schema validation with detailed error messages

### TypeScript Type Checking
- **Compiler**: TypeScript 5.0+
- **Strict Mode**: Enabled for type safety
- **Interfaces**: Complete type definitions for all schemas

### Runtime Validation
```typescript
import Ajv from 'ajv';
import specSchema from './schemas/spec.v1.json';

const ajv = new Ajv();
const validate = ajv.compile(specSchema);

const isValid = validate(spec);
if (!isValid) {
  console.error('Validation errors:', validate.errors);
}
```

## Extensions

### Custom Schemas
Users can extend CAWS schemas with care:
- The spec schema uses `additionalProperties: false` — unknown top-level fields cause validation failure
- Policy and gate configuration in `.caws/policy.yaml` is the extension point for budget and threshold customization
- The events schema (`packages/caws-kernel/src/schemas/events/*.v1.json`) must be updated before new fields can appear in event payloads

### Schema Evolution
- The kernel schema is the single source of truth; this document tracks it
- Breaking changes (field removal, enum narrowing) require a spec and a changelog entry
- Deprecated fields emit `spec.schema.violation` immediately — there is no grace period

## References

- [`packages/caws-kernel/src/schemas/spec.v1.json`](../../packages/caws-kernel/src/schemas/spec.v1.json) — canonical spec schema (authority)
- [JSON Schema Specification](https://json-schema.org/)
- [SPDX Specification](https://spdx.github.io/spdx-spec/)
- [SLSA Specification](https://slsa.dev/spec/v0.1/)

For questions about schema validation or extension, see the [CAWS Documentation](../README.md) or create a GitHub issue.
