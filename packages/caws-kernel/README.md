# @paths.design/caws-kernel

Pure TypeScript governance primitives for CAWS vNext.

## Status

This package is **stable** (v1.1.3, published to npm as `@paths.design/caws-kernel`). It is the governance primitive layer consumed by `@paths.design/caws-cli@^11`. The public API follows semantic versioning; breaking changes are gated behind a major-version bump.

## Boundary

- **Pure**: every public function is a pure transformation. No file I/O, no git execution, no network.
- **Returns `Result<T>`**: validation failures return structured diagnostics; programmer errors throw.
- **Schemas are authoritative**: the JSON Schema files in `src/schemas/` define the contract; TypeScript types are generated/curated to match.

I/O adapters live separately in `packages/caws-cli` (the shell layer).

## Layout

```
src/
  result/         Ok<T> | Err<Diagnostic[]>
  diagnostics/    structured envelope: rule, authority, subject, message, narrowRepair
  schemas/        spec.v1.json, policy.v1.json, events/*.v1.json
  spec/           parse + validate spec YAML (Slice 1.6)
  policy/         parse + validate + budget derivation (Slice 1.7)
  scope/          authoritative-only path admission (Slice 2)
  evidence/       canonical JSON + hash chain + typed events (Slice 3)
  worktree/       pure binding/claim transitions (Slice 4)
```

## Build

```bash
npm run build       # tsc → dist/
npm run typecheck   # type-check without emit
npm test            # jest
```
