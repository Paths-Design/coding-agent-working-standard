// caws-kernel public surface
//
// Pure TypeScript governance primitives. No I/O.
// Slice 1 established: result, diagnostics, schemas, spec, policy.
// Slice 2 adds: scope (authority evaluator).
// Evidence/worktree modules fill in subsequent slices.

export * from './result';
export * from './diagnostics';
export * from './spec';
export * from './policy';
export * from './scope';
