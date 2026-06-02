---
doc_id: documentation-standards
authority: canonical
status: active
title: CAWS Documentation Standards
owner: vNext rewrite team
updated: 2026-06-02
audience: maintainer
---

# CAWS Documentation Standards

This document defines the front-matter schema every governed doc under `docs/`
carries, and the validator that enforces it. It is the canonical schema source
for `packages/caws-cli/scripts/validate-docs.mjs`.

## Why front-matter

Front-matter makes a doc's identity, authority, lifecycle, and **audience**
machine-readable. The audience field in particular lets the npm-package
ship-list be *derived* from the docs themselves (`audience: consumer`) rather
than hand-maintained — so a doc declares once whether consumers should receive
it, and tooling does the rest. This mirrors the proven convention in the
sibling Sterling project.

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

| Field | Meaning |
|---|---|
| `doc_id` | Stable kebab-case identifier, unique within `docs/`. |
| `authority` | The doc's normative weight (enum below). |
| `status` | Lifecycle state (enum below). |
| `title` | Human-readable title. |
| `owner` | Who maintains it. |
| `updated` | ISO date (`YYYY-MM-DD`) of last substantive update. |

### `authority` enum

`canonical`, `policy`, `architecture`, `adr`, `spec`, `roadmap`, `reference`,
`guide`, `working`, `ephemeral`.

### `status` enum

`active`, `superseded`, `draft`, `archived`. A `superseded` doc **must** also
carry a `superseded_by:` field naming its replacement's `doc_id`.

### `audience` enum

`consumer` — written for someone who installs and uses `@paths.design/caws-cli`.
These docs are candidates for the npm-package ship-list.

`maintainer` — written for someone working *on* CAWS (architecture, failure
lineage, release procedure, internal reports). Not shipped to consumers.

## Enforcement: the strict set and the toggle

The validator (`packages/caws-cli/scripts/validate-docs.mjs`) does **not** yet
enforce the schema across all of `docs/`. It enforces a declared **strict set**
— the consumer-facing docs plus this standards doc — and treats every other doc
as a non-failing warning. The strict set is a plain data array in the
validator (`STRICT_SET`), so widening enforcement repo-wide is a one-line edit,
or a `--all` run:

```bash
# Enforce the strict set (default; what CI runs today):
node packages/caws-cli/scripts/validate-docs.mjs

# Preview repo-wide enforcement (the future toggle):
node packages/caws-cli/scripts/validate-docs.mjs --all

# Machine-readable report:
node packages/caws-cli/scripts/validate-docs.mjs --json
```

Exit codes: `0` = no strict-set violations; `1` = one or more strict-set
violations; `2` = usage/IO error. The validator **fails closed** — a strict-set
doc whose front-matter block is unparseable YAML is a violation, not a skip.

This staged design lets the consumer-doc surface be enforced immediately while
the ~30 maintainer docs are migrated incrementally. When every doc carries
valid front-matter, flip the strict set to all of `docs/` (or wire `--all` into
CI) and delete the narrow list.

## Adding a new doc

1. Add the front-matter block with all required fields and an `audience`.
2. If it is consumer-facing, set `audience: consumer` and (in a later slice)
   it will be picked up by the package ship-list automatically.
3. Run `node packages/caws-cli/scripts/validate-docs.mjs` before committing.
