# CAWS Schema Specifications

## Overview

CAWS uses JSON Schema for validation and TypeScript interfaces for type safety. This document provides complete specifications for all CAWS schemas and data structures.

## Working Specification Schema

The working specification defines the complete project requirements and constraints.

### JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "CAWS Working Spec",
  "type": "object",
  "required": [
    "id",
    "title",
    "risk_tier",
    "mode",
    "change_budget",
    "blast_radius",
    "operational_rollback_slo",
    "scope",
    "invariants",
    "acceptance",
    "non_functional",
    "contracts"
  ],
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^[A-Z]+-\\d+$",
      "description": "Project identifier (e.g., FEAT-1234)",
      "examples": ["FEAT-1234", "AUTH-456", "API-789"]
    },
    "title": {
      "type": "string",
      "minLength": 8,
      "description": "Descriptive project title",
      "examples": ["User Authentication Service", "API Gateway Refactor"]
    },
    "risk_tier": {
      "type": "integer",
      "enum": [1, 2, 3],
      "description": "Risk tier: 1 (critical), 2 (standard), 3 (low risk)"
    },
    "mode": {
      "type": "string",
      "enum": ["refactor", "feature", "fix", "doc", "chore"],
      "description": "Project mode"
    },
    "change_budget": {
      "type": "object",
      "properties": {
        "max_files": {
          "type": "integer",
          "minimum": 1,
          "description": "Maximum number of files to change"
        },
        "max_loc": {
          "type": "integer",
          "minimum": 1,
          "description": "Maximum lines of code to change"
        }
      },
      "required": ["max_files", "max_loc"],
      "additionalProperties": false
    },
    "blast_radius": {
      "type": "object",
      "properties": {
        "modules": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Modules affected by the change"
        },
        "data_migration": {
          "type": "boolean",
          "description": "Whether data migration is required"
        }
      },
      "required": ["modules", "data_migration"],
      "additionalProperties": false
    },
    "operational_rollback_slo": {
      "type": "string",
      "pattern": "^[0-9]+m$|^[0-9]+h$|^[0-9]+d$",
      "description": "Operational rollback SLO (e.g., 5m, 1h, 24h)",
      "examples": ["5m", "1h", "24h"]
    },
    "threats": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Potential threats and risks"
    },
    "scope": {
      "type": "object",
      "required": ["in"],
      "properties": {
        "in": {
          "type": "array",
          "items": { "type": "string" },
          "minItems": 1,
          "description": "Files/features in scope"
        },
        "out": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Files/features out of scope"
        }
      }
    },
    "invariants": {
      "type": "array",
      "items": { "type": "string" },
      "minItems": 1,
      "description": "System invariants that must be maintained"
    },
    "acceptance": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["id", "given", "when", "then"],
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^A\\d+$",
            "description": "Acceptance criteria ID"
          },
          "given": {
            "type": "string",
            "description": "Given clause"
          },
          "when": {
            "type": "string",
            "description": "When clause"
          },
          "then": {
            "type": "string",
            "description": "Then clause"
          }
        }
      },
      "description": "Acceptance criteria in Given-When-Then format"
    },
    "non_functional": {
      "type": "object",
      "properties": {
        "a11y": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Accessibility requirements"
        },
        "perf": {
          "type": "object",
          "properties": {
            "api_p95_ms": {
              "type": "integer",
              "minimum": 1,
              "description": "API p95 latency in milliseconds"
            },
            "lcp_ms": {
              "type": "integer",
              "minimum": 1,
              "description": "Largest Contentful Paint in milliseconds"
            }
          },
          "additionalProperties": false
        },
        "security": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Security requirements"
        }
      },
      "additionalProperties": false
    },
    "contracts": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["type", "path"],
        "properties": {
          "type": {
            "type": "string",
            "enum": ["openapi", "graphql", "proto", "pact"],
            "description": "Contract type"
          },
          "path": {
            "type": "string",
            "description": "Path to contract specification"
          }
        }
      }
    },
    "observability": {
      "type": "object",
      "properties": {
        "logs": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Log events to emit"
        },
        "metrics": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Metrics to collect"
        },
        "traces": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Traces to capture"
        }
      }
    },
    "migrations": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Migration steps"
    },
    "rollback": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Rollback steps"
    }
  },
  "additionalProperties": false
}
```

### TypeScript Interface

```typescript
interface WorkingSpec {
  id: string;                    // e.g., "FEAT-1234"
  title: string;                 // Descriptive name
  risk_tier: 1 | 2 | 3;         // Risk classification
  mode: 'refactor' | 'feature' | 'fix' | 'doc' | 'chore';

  change_budget: {
    max_files: number;          // Minimum 1
    max_loc: number;            // Minimum 1
  };

  blast_radius: {
    modules: string[];          // Affected modules
    data_migration: boolean;    // Requires data migration
  };

  operational_rollback_slo: string; // e.g., "5m", "1h", "24h"

  threats?: string[];            // Optional threats
  scope: {
    in: string[];               // In scope (required)
    out?: string[];             // Out of scope (optional)
  };
  invariants: string[];          // Must be maintained
  acceptance: AcceptanceCriteria[];

  non_functional: {
    a11y: string[];             // Accessibility requirements
    perf: {
      api_p95_ms: number;       // API performance budget
      lcp_ms?: number;          // Frontend performance budget
    };
    security: string[];         // Security requirements
  };

  contracts: ContractSpec[];
  observability?: ObservabilityConfig;
  migrations?: string[];         // Migration steps
  rollback?: string[];           // Rollback steps
}

interface AcceptanceCriteria {
  id: string;                    // e.g., "A1", "A2"
  given: string;                 // Given clause
  when: string;                  // When clause
  then: string;                  // Then clause
}

interface ContractSpec {
  type: 'openapi' | 'graphql' | 'proto' | 'pact';
  path: string;                  // Path to specification
}

interface ObservabilityConfig {
  logs: string[];                // Log events
  metrics: string[];             // Metrics to collect
  traces: string[];              // Traces to capture
}
```

## Provenance Schema

### JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "CAWS Provenance Manifest",
  "type": "object",
  "required": [
    "agent",
    "model",
    "model_hash",
    "tool_allowlist",
    "commit",
    "artifacts",
    "results",
    "approvals",
    "sbom",
    "attestation"
  ],
  "properties": {
    "agent": {
      "type": "string",
      "description": "Agent identifier"
    },
    "model": {
      "type": "string",
      "description": "Model identifier"
    },
    "model_hash": {
      "type": "string",
      "description": "Model hash for reproducibility"
    },
    "tool_allowlist": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Allowed tools for the agent"
    },
    "prompts": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Prompts used by the agent"
    },
    "commit": {
      "type": "string",
      "description": "Git commit hash"
    },
    "artifacts": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Generated artifacts"
    },
    "results": {
      "type": "object",
      "properties": {
        "coverage_branch": {
          "type": "number",
          "minimum": 0,
          "maximum": 1,
          "description": "Branch coverage percentage"
        },
        "mutation_score": {
          "type": "number",
          "minimum": 0,
          "maximum": 1,
          "description": "Mutation test score"
        },
        "tests_passed": {
          "type": "integer",
          "minimum": 0,
          "description": "Number of tests passed"
        },
        "contracts": {
          "type": "object",
          "properties": {
            "consumer": { "type": "boolean" },
            "provider": { "type": "boolean" }
          }
        },
        "a11y": {
          "type": "string",
          "enum": ["pass", "fail", "partial"]
        },
        "perf": { "type": "object" }
      },
      "additionalProperties": true
    },
    "approvals": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Human approvals"
    },
    "sbom": {
      "type": "string",
      "description": "SBOM attestation"
    },
    "attestation": {
      "type": "string",
      "description": "SLSA attestation"
    },
    "timestamp": {
      "type": "string",
      "format": "date-time"
    },
    "version": {
      "type": "string"
    },
    "hash": {
      "type": "string"
    }
  }
}
```

### TypeScript Interface

```typescript
interface ProvenanceManifest {
  agent: string;                 // Agent identifier
  model: string;                 // Model identifier
  model_hash: string;            // Model hash
  tool_allowlist: string[];      // Allowed tools
  prompts?: string[];            // Prompts used
  commit: string | null;         // Git commit hash
  artifacts: string[];           // Generated artifacts
  results: ProvenanceResults;    // Test and quality results
  approvals: string[];           // Human approvals
  sbom: string;                  // SBOM data
  attestation: string;           // SLSA attestation
  timestamp?: string;            // ISO timestamp
  version?: string;              // Manifest version
  hash: string;                  // Manifest hash
}

interface ProvenanceResults {
  coverage_branch?: number;      // 0-1
  mutation_score?: number;       // 0-1
  tests_passed?: number;         // Count
  contracts?: {
    consumer: boolean;           // Consumer contract tests
    provider: boolean;           // Provider contract tests
  };
  a11y?: 'pass' | 'fail' | 'partial'; // Accessibility results
  perf?: PerformanceResults;     // Performance metrics
  [key: string]: any;            // Additional results
}

interface PerformanceResults {
  api_p95_ms?: number;           // API p95 latency
  lcp_ms?: number;               // Largest Contentful Paint
  [key: string]: number | undefined;
}
```

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
        "max_files": {
          "type": "integer",
          "minimum": 1
        },
        "max_loc": {
          "type": "integer",
          "minimum": 1
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
        "max_files",
        "max_loc",
        "allowed_modes"
      ]
    }
  }
}
```

### TypeScript Interface

```typescript
interface TierPolicy {
  [tier: string]: {
    min_branch: number;           // 0-1
    min_mutation: number;         // 0-1
    requires_contracts: boolean;  // Contract requirement
    requires_manual_review: boolean; // Manual review needed
    max_files: number;            // File limit
    max_loc: number;              // LOC limit
    allowed_modes: Mode[];        // Allowed project modes
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
import { workingSpecSchema } from './schemas/working-spec.schema.json';

const ajv = new Ajv();
const validate = ajv.compile(workingSpecSchema);

const isValid = validate(workingSpec);
if (!isValid) {
  console.error('Validation errors:', validate.errors);
}
```

## Extensions

### Custom Schemas
Users can extend CAWS schemas:
- Add custom fields to working specifications
- Create project-specific validation rules
- Define domain-specific contract types
- Implement custom quality metrics

### Schema Evolution
- Backward compatibility maintained across versions
- Deprecation notices for removed fields
- Migration guides for breaking changes
- Community-driven schema improvements

## References

- [JSON Schema Specification](https://json-schema.org/)
- [SPDX Specification](https://spdx.github.io/spdx-spec/)
- [SLSA Specification](https://slsa.dev/spec/v0.1/)
- [in-toto Specification](https://in-toto.io/)

For questions about schema validation or extension, see the [CAWS Documentation](docs/README.md) or create a GitHub issue.
