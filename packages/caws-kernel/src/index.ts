// caws-kernel public surface
//
// Pure TypeScript governance primitives. No I/O.
// Slice 1 established: result, diagnostics, schemas, spec, policy.
// Slice 2 added: scope (authority evaluator).
// Slice 3 added: evidence (canonicalJson, hash chain, event validation).
// Slice 4 adds: worktree (binding, ownership, freshness, transitions).

export * from './result';
export * from './diagnostics';
export * from './spec';
export * from './policy';
export * from './worktree';
export * from './scope';
export * from './evidence';
