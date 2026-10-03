# CAWS contracts

New spec creation has no risk tier. Contracts are optional declarations of the
interfaces or guarantees relevant to a change; they do not select a rigor level.

## What a contract is

A CAWS contract is a small, structured declaration in a spec's `contracts:`
block that names an **interface or guarantee the slice must honor**. It is the
spec's promise about _what stays true at a boundary_ — the thing a reviewer (or
a future agent) can check the implementation against.

The shape (from the kernel `Contract` type):

```yaml
contracts:
  - name: <identifier> # required — a short label, e.g. "commits-md-output"
    type: <contract-type> # required — one of: api | schema | contract-test | behavior
    path: <file path> # optional — where the contract artifact lives
    description: <text> # optional — one line on what it guarantees
```

### The four contract types

| `type`          | What it declares                                                    | Typical `path`                                   |
| --------------- | ------------------------------------------------------------------- | ------------------------------------------------ |
| `api`           | A function/CLI/HTTP surface the slice exposes or depends on         | the OpenAPI/IDL file, or the module exporting it |
| `schema`        | A data shape (record, JSON schema, DB table) the slice reads/writes | the schema file                                  |
| `contract-test` | An executable test that pins the boundary behavior                  | the test file                                    |
| `behavior`      | A behavioral guarantee not captured as a single file                | (often omitted; described in `description`)      |

Example — a CLI slice declaring its output contract as a test:

```yaml
contracts:
  - name: markdown-table-output
    type: contract-test
    path: test/commits-cli.test.js
    description: >-
      Output is a GitHub-flavored markdown table; header row present, hash
      truncated to 8 chars, one row per commit.
```

## Declaring a contract

Use the repeatable `--contract "name:type[:path]"` flag:

```bash
caws specs create FOO-001 --title "Preserve the API boundary" --mode feature \
  --contract "core-api:behavior"
```

Omitting this flag writes `contracts: []`. Observability, rollback and security
requirements are independently optional creation flags. Supply meaningful
requirements for the work rather than selecting a tier to satisfy a validator.

Existing specs with `risk_tier` retain their historical validation constraints;
creation does not rewrite those records. New specs and `spec_created` events
omit the field. Neither a hidden tier nor a tier-specific budget is assigned.

## What a contract proves

The schema checks the declaration's shape. CAWS does not execute a
`contract-test` merely because its name and path are present. Review the actual
boundary and execute relevant tests when verifying acceptance. A declaration
alone is not evidence that its guarantee holds.
