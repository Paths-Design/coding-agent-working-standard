// caws-kernel public surface
//
// Pure TypeScript governance primitives. No I/O.
// Slice 1 established: result, diagnostics, schemas, spec, policy.
// Slice 2 added: scope (authority evaluator).
// Slice 3 adds: evidence (canonicalJson, hash chain, event validation).
// Worktree module fills in a subsequent slice.

export * from './result';
export * from './diagnostics';
export * from './spec';
export * from './policy';
export * from './scope';
export * from './evidence';
