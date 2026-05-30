# CAWS contracts: what they are and why tiers gate on them

When you run `caws specs create … --risk-tier 2` (or `--risk-tier 1`), CAWS rejects
the spec with:

```
Tier 2 specs require at least one contract.
  repair:  Add at least one contract or change risk_tier to 3 or mode to chore.
```

This guide explains what a **contract** is, why higher-risk tiers require one, and
how to satisfy (or escape) the requirement.

## What a contract is

A CAWS contract is a small, structured declaration in a spec's `contracts:` block
that names an **interface or guarantee the slice must honor**. It is the spec's
promise about *what stays true at a boundary* — the thing a reviewer (or a future
agent) can check the implementation against.

The shape (from the kernel `Contract` type):

```yaml
contracts:
  - name: <identifier>           # required — a short label, e.g. "commits-md-output"
    type: <contract-type>        # required — one of: api | schema | contract-test | behavior
    path: <file path>            # optional — where the contract artifact lives
    description: <text>          # optional — one line on what it guarantees
```

### The four contract types

| `type` | What it declares | Typical `path` |
|---|---|---|
| `api` | A function/CLI/HTTP surface the slice exposes or depends on | the OpenAPI/IDL file, or the module exporting it |
| `schema` | A data shape (record, JSON schema, DB table) the slice reads/writes | the schema file |
| `contract-test` | An executable test that pins the boundary behavior | the test file |
| `behavior` | A behavioral guarantee not captured as a single file | (often omitted; described in `description`) |

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

## Why tiers gate on contracts

CAWS risk tiers scale rigor to blast radius:

- **Tier 1 / Tier 2** — higher-risk changes (real features, cross-module surfaces).
  They require **at least one contract** because a higher-risk change must make an
  explicit, checkable interface promise — not just "I edited some files." Tier 1
  additionally requires non-empty `observability`, `rollback`, and
  `non_functional.security`.
- **Tier 3** — low-blast-radius slices (docs, tests, harnesses, small fixes). These
  permit `contracts: []`. `mode: chore` also exempts the contract requirement at any
  tier.

The gate is enforced by the kernel at spec-validation time
(`packages/caws-kernel/src/spec/validate-semantics.ts`), so it applies whether you
create via the CLI or hand-edit the YAML.

## How to satisfy or escape the requirement

There is no `--contract` flag on `caws specs create`; contracts are added by editing
the spec YAML. Because creation validates the planned YAML, you cannot create a
tier-1/2 spec with an empty `contracts:` block in one step. Two paths:

1. **Bootstrap at tier 3, then raise the tier.** `caws specs create FOO-001 --mode
   feature --risk-tier 3` succeeds with `contracts: []`. Open the spec, fill in
   `scope.in`, add your `contracts:` entries, then change `risk_tier:` to 2 (or 1).
   This is the path the create-rejection repair text points you to.

2. **Stay at tier 3 if the slice genuinely is low-risk.** A docs/test/small-fix
   slice does not need a contract; tier 3 is the right tier and `contracts: []` is
   correct. Don't inflate the tier to look rigorous — pick the tier that matches the
   blast radius.

## Where contracts are consumed

The `contracts:` block is part of the spec's durable record. It is read by:

- **Spec validation** (the kernel tier gate above) — presence/shape checks.
- **Reviewers and future agents** — the contract is the boundary to verify the
  implementation against, and the artifact a `verify-acs`-style check can point at
  via `path`.

Contracts are declarative: CAWS does not auto-execute a `contract-test` for you at
create time. The `type`/`path` make the promise explicit and locatable; running the
referenced test is part of proving the slice's acceptance criteria.
