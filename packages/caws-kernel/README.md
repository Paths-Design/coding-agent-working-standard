# @paths.design/caws-kernel

Pure TypeScript governance primitives for CAWS vNext.

## Status

This package is **pre-1.0 and unstable**. It is the foundation of the CAWS rewrite per `docs/rewrite/`. The public API will change without warning until v1.0.

## Boundary

- **Pure**: every public function is a pure transformation. No file I/O, no git execution, no network.
- **Returns `Result<T>`**: validation failures return structured diagnostics; programmer errors throw.
- **Schemas are authoritative**: the JSON Schema files in `src/schemas/` define the contract; TypeScript types are generated/curated to match.

I/O adapters live separately (`packages/caws-cli` shell layer; future `caws-kernel/store` Node-only submodule).

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
