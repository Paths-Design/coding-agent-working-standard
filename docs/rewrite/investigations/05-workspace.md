# Investigation 05: Workspace Boundaries

**Status:** delivered 2026-05-07
**Slice:** 1.0 (gates Slice 1.1 kernel scaffolding)
**Branch:** caws-next

---

## Current state

### Workspace topology

Root `package.json` declares:
```json
"workspaces": ["packages/*"]
```

`apps/**` is referenced in `turbo.json` `inputs` for `build`, `lint`, `lint:fix`, `format`, `test`, `test:unit`, and `validate` tasks — but the directory **does not exist on disk**. This is stale configuration carried from a deleted experiment. Turbo silently ignores missing input globs, so this is not currently a build failure, but it is dead weight in `turbo.json`.

### Existing packages (3)

| Package | Version | Type | Status |
|---|---|---|---|
| `packages/caws-cli` | 10.2.0 | CommonJS, `dist/index.js` bin | LEGACY — to be gutted in later slices |
| `packages/caws-types` | 2.0.0 | TypeScript, `dist/index.d.ts` types | LEGACY — to be replaced by re-exports of kernel types |
| `packages/quality-gates` | 2.0.0 | ESM `.mjs`, own bin `caws-quality-gates` | UNTOUCHED in vNext rewrite |

### Cross-package imports (audit result)

Searched `packages/caws-cli/src`, `packages/caws-types/src`, `packages/quality-gates/*.mjs` for cross-package imports. Findings:

- **`caws-cli` → `caws-types`**: 0 imports. `caws-cli` does NOT consume the published types from its sibling. The hand-written types in `caws-types` are effectively unused by the CLI today.
- **`caws-cli` → `quality-gates`**: 0 import statements. Five string references to `@paths.design/quality-gates` exist in `packages/caws-cli/src/utils/project-analysis.js`, but they are install-suggestion error messages, not real imports. The CLI invokes `quality-gates` via subprocess only.
- **`caws-types` → anything**: Only intra-package re-exports (`./placeholder-types`, `./validation-types`, etc.). No external sibling deps.
- **`quality-gates` → anything**: 0 imports of sibling packages.

This is the cleanest possible starting point. There is no in-process coupling to untangle. Each package is already an isolated unit.

### `caws-cli` package.json `dependencies`

Notable absence: NO `"@paths.design/caws-types"` or `"@paths.design/quality-gates"` entries. This confirms the audit — these are not workspace-linked dependencies. `caws-cli` builds and runs without any sibling.

---

## Implications for vNext

### Build order

Slice 1+ introduces `packages/caws-kernel/`. The intended dependency direction is:

```
caws-kernel        →  no internal package deps
caws-types         →  re-exports generated/public kernel types (workspace dep on caws-kernel)
caws-cli           →  consumes caws-kernel; optionally caws-types (for published TS surface)
quality-gates      →  unchanged; subprocess-isolated; no in-process kernel dep for now
```

Turbo will pick this up automatically via `dependsOn: ["^build"]` once the workspace deps are declared in each `package.json`. No `turbo.json` changes required for the dependency graph itself.

### `turbo.json` cleanup (deferred)

The stale `apps/**` references in `turbo.json` `inputs` should be removed before Slice 1.9 build verification, but they are not blocking — Turbo tolerates missing globs. Add to a follow-up task; do not handle in Slice 1.1 to keep the scaffolding commit focused.

### Files that must NOT be touched in Slice 1

- `packages/caws-cli/**` — gutting happens in later slices; Slice 1 is kernel-only
- `packages/caws-types/**` — replacement happens after kernel surface stabilizes
- `packages/quality-gates/**` — out of scope entirely
- `docs/rewrite/corpus/**` — corpus is committed; treat as read-only reference
- `.caws/**` — already greenfield on `caws-next`; leave alone until Slice 7 init
- `.git/hooks/**` — legacy hooks remain active until Slice 5b replaces them; do not modify
- `.claude/**` — harness changes are stashed under `harness-disable-for-caws-next`; Slice 1 must not stage anything in this directory

### Files that may be touched in Slice 1

- `packages/caws-kernel/**` — new package, all changes scoped here
- Root `package.json` — only to add `caws-kernel` entry if needed (probably not — `packages/*` glob covers it)
- `turbo.json` — optional: remove stale `apps/**` references (defer to Slice 1.9 cleanup)
- `docs/rewrite/investigations/05-workspace.md` — this file

---

## Acceptance for Slice 1.0

This investigation is functionally complete when:

1. ✅ `packages/*` workspace glob is the source of truth; no per-package entries needed.
2. ✅ `apps/` is confirmed absent on disk; `turbo.json` references are stale but non-blocking.
3. ✅ Cross-package import audit shows zero in-process coupling between existing packages.
4. ✅ Intended dependency direction documented: `caws-kernel` ← `caws-types` ← `caws-cli`; `quality-gates` orthogonal.
5. ✅ "Do not touch" boundary is explicit for Slice 1.

Slice 1.1 (scaffold `packages/caws-kernel`) may now proceed.

---

## Follow-ups (post-Slice-1)

- Remove stale `apps/**` from `turbo.json` inputs (cosmetic; Slice 1.9 or later).
- When `caws-cli` is gutted in Slice 5c, declare workspace dep on `caws-kernel` in its `package.json`.
- When `caws-types` is rewritten as kernel re-exports, declare workspace dep on `caws-kernel`.
