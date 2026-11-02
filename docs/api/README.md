---
doc_id: api-readme
authority: reference
status: active
title: docs/api — current reference and archived service designs
owner: CAWS maintainers
updated: 2026-11-02
audience: maintainer
---

# docs/api

Two things live in this directory, and they are not the same kind of document.

## Current CAWS reference

- [`cli.md`](cli.md) — CLI task and option semantics. The installed CLI's
  `--help` remains the exhaustive option catalogue; this page deliberately does
  not duplicate it.
- [`schema.md`](schema.md) — the current kernel schemas (spec, event log, policy
  risk tiers, tool allowlist, waivers) with their TypeScript shapes.

## Archived service designs — never implemented

These six OpenAPI 3.0.3 files describe JSON-over-HTTP microservices that CAWS
has never shipped:

| File                                                 | Describes                                     | Live CAWS equivalent                                                              |
| ---------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------- |
| [`agent-agency.yaml`](agent-agency.yaml)             | "Agent Agency" platform aggregator, MCP proxy | none — CAWS is a CLI; no HTTP server exists                                       |
| [`agent-orchestrator.yaml`](agent-orchestrator.yaml) | agent registration + task routing service     | `caws agents` (lease cache; operational cache, never authority)                   |
| [`ai-model.yaml`](ai-model.yaml)                     | local model load/inference service            | none — execution belongs to the agent harness CAWS governs                        |
| [`data-layer.yaml`](data-layer.yaml)                 | PostgreSQL/Redis/vector SQL service           | file-backed JSON/JSONL stores under `src/store/` and `.caws/`                     |
| [`memory-system.yaml`](memory-system.yaml)           | multi-tenant graph/vector memory              | none — `.caws/sessions/` turn logs are an operational cache, not a memory service |
| [`quality-gates.yaml`](quality-gates.yaml)           | coverage/mutation/contract gate service       | `caws gates` with the 5 policy gates in `.caws/policy.yaml`                       |

They arrived in one bulk import (`35be4afab`, 2025-10-08) alongside the
since-deleted `packages/caws-mcp-server` and two now-deleted sibling specs
(`mcp-protocol.yaml`, `mcp-tools.yaml`). Nothing in the repository references
them, and their titles/contact domains belong to other products. `ai-model.yaml`
and `memory-system.yaml` are also structurally invalid OpenAPI, which is further
evidence they were never loaded by a validator or generator.

**Do not cite these files as the CAWS API.** They are retained only as design
history. Each carries an `ARCHIVED DESIGN RECORD` banner at the top of the file.
A future slice may move them to `docs/archive/`; until then this README is the
warning that `docs/README.md`'s tree points at.
