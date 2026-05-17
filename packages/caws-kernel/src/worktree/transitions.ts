// Spec lifecycle transitions vs active worktree bindings.
//
// The kernel answers one question here:
//
//   "Given (spec, registry, transition), is the transition legal?"
//
// `merge_finalize` is the only transition that may close a spec while a
// worktree is bound. All other transitions (`close`, `archive`, `delete`)
// require no active bound worktree. The Err side carries the active
// binding's identity so the shell can name it in the diagnostic.

import { diagnostic } from '../diagnostics/construct';
import { err, ok } from '../result/construct';
import type { Result } from '../result/types';
import type { Spec } from '../spec/types';
import { WORKTREE_RULES } from './rules';
import type { SpecTransition, TransitionDecision, WorktreeRegistry } from './types';

const KNOWN_TRANSITIONS: ReadonlySet<SpecTransition> = new Set<SpecTransition>([
  'close',
  'archive',
  'delete',
  'merge_finalize',
]);

/**
 * Decide whether `spec` may undergo `transition` given `registry`.
 *
 * Rules:
 *   - `merge_finalize`: always allowed (it IS the merge close path).
 *     Reports the binding it's finalizing in `data.binding` for the shell.
 *   - `close | archive | delete`: blocked iff some entry in `registry` has
 *     `specId === spec.id`. The block is hard; the shell must merge or
 *     unbind first. Returns Err with the offending worktree_name.
 *
 * The function does NOT consult `spec.lifecycle_state`. That is `spec/`
 * authority. This kernel is concerned solely with the active-binding
 * blocker.
 */
export function canTransitionSpecWithWorktree(
  spec: Spec,
  registry: WorktreeRegistry,
  transition: SpecTransition
): Result<TransitionDecision> {
  if (!KNOWN_TRANSITIONS.has(transition)) {
    return err(
      diagnostic({
        rule: WORKTREE_RULES.TRANSITION_INVALID,
        authority: 'kernel/worktree',
        message: `Unknown spec transition "${String(transition)}".`,
        narrowRepair: 'Use one of: close, archive, delete, merge_finalize.',
      })
    );
  }

  // Find any active binding to this spec.
  const bindings: { worktree_name: string }[] = [];
  for (const [name, record] of Object.entries(registry)) {
    if (record?.specId === spec.id) {
      bindings.push({ worktree_name: name });
    }
  }

  if (transition === 'merge_finalize') {
    // Merge finalize is the legal close vector.
    const first = bindings[0];
    return ok({
      transition,
      allowed: true,
      ...(first ? { binding: { worktree_name: first.worktree_name, spec_id: spec.id } } : {}),
    });
  }

  if (bindings.length > 0) {
    const offending = bindings[0]!.worktree_name;
    return err(
      diagnostic({
        rule: WORKTREE_RULES.TRANSITION_BLOCKED_BY_ACTIVE_BINDING,
        authority: 'kernel/worktree',
        message: `Spec ${spec.id} cannot ${transition} while worktree "${offending}" is bound.`,
        subject: spec.id,
        narrowRepair: `Detach worktree "${offending}" from spec ${spec.id} first. (v11.0.0 does not ship worktree lifecycle commands; remove the binding from .caws/worktrees.json directly, or pin to caws-cli@^10.2.x for \`caws worktree merge ${offending}\` / \`caws worktree destroy ${offending}\`.)`,
        data: {
          transition,
          spec_id: spec.id,
          bound_worktrees: bindings.map((b) => b.worktree_name),
        },
      })
    );
  }

  return ok({ transition, allowed: true });
}
