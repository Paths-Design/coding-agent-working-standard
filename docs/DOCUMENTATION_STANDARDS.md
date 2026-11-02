---
doc_id: documentation-standards
authority: canonical
status: active
title: CAWS Documentation Standards
owner: vNext rewrite team
updated: 2026-11-02
audience: maintainer
---

# CAWS Documentation Standards

This document defines the front-matter schema governed docs under `docs/` are
expected to carry, and the validator that enforces it. It is the human-readable
counterpart of `packages/caws-cli/scripts/validate-docs.mjs`; where the two
disagree, the validator is the executable authority.

## Why front-matter

Front-matter makes a doc's identity, authority, lifecycle, and **audience**
machine-readable. The audience field in particular lets the npm-package
ship-list be _derived_ from the docs themselves (`audience: consumer`) rather
than hand-maintained — so a doc declares once whether consumers should receive
it, and tooling does the rest. This mirrors the proven convention in the sibling
Sterling project.

## The schema

Every governed doc begins with a YAML front-matter block fenced by `---`:

```yaml
---
doc_id: short-kebab-id
authority: reference
status: active
title: Human-readable title
owner: vNext rewrite team
updated: 2026-06-02
audience: consumer
---
```

### Required fields

| Field       | Meaning                                                              |
| ----------- | -------------------------------------------------------------------- |
| `doc_id`    | Stable kebab-case identifier, unique within `docs/`.                 |
| `authority` | The doc's normative weight (enum below).                             |
| `status`    | Lifecycle state (enum below).                                        |
| `title`     | Human-readable title.                                                |
| `owner`     | Who maintains it.                                                    |
| `updated`   | ISO date (`YYYY-MM-DD`) of last substantive update.                  |
| `audience`  | `consumer` or `maintainer` (required on strict-set docs; see below). |

### `authority` enum

`canonical`, `policy`, `architecture`, `adr`, `spec`, `roadmap`, `reference`,
`guide`, `working`, `ephemeral`.

### `status` enum

`active`, `superseded`, `draft`, `archived`. A `superseded` doc **must** also
carry a `superseded_by:` field naming its replacement's `doc_id`.

### `audience` enum

`consumer` — written for someone who installs and uses `@paths.design/caws-cli`.
These docs are candidates for the npm-package ship-list.

`maintainer` — written for someone working _on_ CAWS (architecture, failure
lineage, release procedure, internal reports). Not shipped to consumers.

`audience` is required on every strict-set doc and, where present on any other
doc, must be one of these two values. The npm-package ship-list is derived from
`audience: consumer`, so a doc without an audience never ships.

## Enforcement: the strict set and the toggle

The validator (`packages/caws-cli/scripts/validate-docs.mjs`) enforces a
declared **strict set** of five docs — this standards doc plus four consumer
guides (`caws-developer-guide.md`, `multi-agent-workflow.md`,
`waiver-troubleshooting.md`, `worktree-isolation.md`) — and reports every other
doc as a non-failing warning. It is the first step of `npm run docs:check`,
which the release-qualification CI workflow invokes; it is not a separate CI
step. The strict set is a plain data array in the validator (`STRICT_SET`), so
widening enforcement repo-wide is a one-line edit, or a `--all` run:

```bash
# Enforce the strict set (default; first step of docs:check, which CI runs):
node packages/caws-cli/scripts/validate-docs.mjs

# Preview repo-wide enforcement (the future toggle):
node packages/caws-cli/scripts/validate-docs.mjs --all

# Machine-readable report:
node packages/caws-cli/scripts/validate-docs.mjs --json
```

Exit codes: `0` = no strict-set violations; `1` = one or more strict-set
violations; `2` = usage/IO error. The validator **fails closed** — a strict-set
doc whose front-matter block is unparseable YAML is a violation, not a skip.

Migration is staged. As of 2026-11-02, 20 of 58 tracked docs under `docs/`
satisfy the schema and `--all` reports 38 violations: 25 with no front-matter
and 13 missing only `audience`. The validator names each offender in its warning
output. When every doc carries valid front-matter, promote `--all` into
`docs:check` and delete `STRICT_SET`.

## Adding a new doc

1. Add the front-matter block with all required fields and an `audience`.
2. If it is consumer-facing, set `audience: consumer` and (in a later slice) it
   will be picked up by the package ship-list automatically.
3. Run `node packages/caws-cli/scripts/validate-docs.mjs` (or
   `npm run docs:check --workspace @paths.design/caws-cli`) before committing.
