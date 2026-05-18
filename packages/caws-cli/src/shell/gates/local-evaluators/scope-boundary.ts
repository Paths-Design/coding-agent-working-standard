// scope_boundary evaluator.
//
// Iterates the staged file list and asks the kernel scope evaluator
// (`evaluatePath`) for each path. Any `reject` decision becomes a
// `scope_boundary` violation; `invalid_path` decisions also become
// violations (the staged path is malformed and not policy-admissible).
//
// `admit` and `no_authority` decisions do NOT produce violations here.
// `no_authority` (unbound or one_sided) is a binding problem — the
// gates command itself should refuse to run in that state long before
// this evaluator is called, OR a doctor-style separate diagnostic
// should be raised. For v11.1 we treat `no_authority` as a non-blocking
// "cannot decide" outcome consistent with the kernel's contract; the
// caller's binding precondition is the authoritative gate.

import { evaluatePath, type BindingState } from '@paths.design/caws-kernel';
import type { Spec, Policy } from '@paths.design/caws-kernel';

import type { GatesViolation } from '../gate-result-contract';
import { listStagedChanges, type StagedFileChange } from './diff-helpers';

export interface ScopeBoundaryInput {
  readonly spec: Spec;
  readonly policy: Policy;
  readonly repoRoot: string;
  /** Worktree name; defaults to "scope-boundary" if not known. The kernel
   *  uses this only for diagnostic data, not for authority. */
  readonly worktreeName?: string;
  /** Override staged-diff source (tests). */
  readonly stagedChanges?: readonly StagedFileChange[];
}

export interface ScopeBoundaryResult {
  readonly violations: readonly GatesViolation[];
  readonly observed: {
    readonly files_evaluated: number;
    readonly rejected: number;
    readonly invalid: number;
  };
}

export function evaluateScopeBoundary(input: ScopeBoundaryInput): ScopeBoundaryResult {
  const changes = input.stagedChanges ?? listStagedChanges(input.repoRoot);
  // Local evaluator assumes the gates command would not have proceeded
  // unbound; we synthesize a `bound` BindingState from the spec under
  // evaluation. The caws-cli `caws gates run --spec <id>` contract is
  // that the caller has named the spec; we treat that as authority for
  // the purpose of scope evaluation here.
  const binding: BindingState = {
    kind: 'bound',
    spec: input.spec,
    worktreeName: input.worktreeName ?? 'gates-run',
  };

  const violations: GatesViolation[] = [];
  let rejected = 0;
  let invalid = 0;
  for (const c of changes) {
    const d = evaluatePath(c.path, binding, input.policy);
    if (d.kind === 'reject') {
      rejected++;
      violations.push({
        gate: 'scope_boundary',
        type: d.rule,
        message: d.message,
        file: c.path,
        severity: 'fail',
      });
    } else if (d.kind === 'invalid_path') {
      invalid++;
      violations.push({
        gate: 'scope_boundary',
        type: d.rule,
        message: d.message,
        file: c.path,
        severity: 'fail',
      });
    }
  }

  return {
    violations,
    observed: {
      files_evaluated: changes.length,
      rejected,
      invalid,
    },
  };
}
