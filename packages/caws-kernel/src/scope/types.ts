// Scope authority types.
//
// The scope kernel answers one question:
//   "Given this path, binding state, policy, and (when bound) spec —
//    what is the authority decision?"
//
// The kernel does no I/O and never throws on user input. Malformed paths
// land as `invalid_path` decisions, not exceptions.

// BindingState's canonical home is `worktree/types.ts` (worktree owns
// binding; scope is a consumer). Re-exported here so consumer paths
// (`@paths.design/caws-kernel/scope`) remain stable.
export type { BindingState } from '../worktree/types';
import type { BindingState } from '../worktree/types';

/**
 * The four mutually exclusive outcomes of evaluation.
 *
 *  - `admit`: the path is admissible under the current authority.
 *  - `reject`: the path is well-formed but the bound spec/policy refuse it.
 *  - `no_authority`: there is no bound spec to evaluate against. Distinct
 *    from `reject` because the answer is "we cannot decide" rather than
 *    "we decided no". Read-only commands may render this; hooks must
 *    treat it as a hard refusal for governed writes.
 *  - `invalid_path`: the caller handed the kernel a path the kernel cannot
 *    safely reason about (absolute, parent traversal, NUL, etc.). This is
 *    a caller-side error surfaced as data, not a thrown exception.
 */
export type DecisionKind = 'admit' | 'reject' | 'no_authority' | 'invalid_path';

/**
 * Common shape carried by every Decision.
 *
 * Always carries:
 *  - `rule`: a stable identifier from `SCOPE_RULES`. Public contract.
 *  - `authority`: always `'kernel/scope'` for this evaluator.
 *  - `path`: the original path the caller passed in (unmodified).
 *  - `bindingState`: the kind tag of the binding the decision was made under.
 *
 * Optionally carries:
 *  - `normalizedPath`: present when the path was successfully normalized.
 *  - `narrowRepair`: present when the kernel knows a precise repair.
 *  - `data`: extra structured detail (e.g. matched pattern, asymmetry shape).
 */
interface DecisionBase {
  readonly rule: string;
  readonly authority: 'kernel/scope';
  readonly path: string;
  readonly normalizedPath?: string;
  readonly message: string;
  readonly narrowRepair?: string;
  readonly bindingState: BindingState['kind'];
  readonly data?: Readonly<Record<string, unknown>>;
}

/** Decision discriminated by `kind`. Use `Extract<Decision, {kind:'admit'}>` to narrow. */
export type Decision =
  | (DecisionBase & { readonly kind: 'admit' })
  | (DecisionBase & { readonly kind: 'reject' })
  | (DecisionBase & { readonly kind: 'no_authority' })
  | (DecisionBase & { readonly kind: 'invalid_path' });

/** Convenience alias for the admit-only narrowing. */
export type AdmitDecision = Extract<Decision, { kind: 'admit' }>;
