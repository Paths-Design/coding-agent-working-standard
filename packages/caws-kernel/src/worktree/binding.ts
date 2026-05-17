// Binding derivation and bind/rebind transitions.
//
// Pure: every function takes a snapshot of the inputs and returns either a
// Result<RegistryPatch> or a derived state value. No I/O. No event emission.
// All time is injected by the caller.

import { diagnostic } from '../diagnostics/construct';
import type { Diagnostic } from '../diagnostics/types';
import { err, ok } from '../result/construct';
import type { Result } from '../result/types';
import type { Spec } from '../spec/types';
import { sameSession, validateSessionIdentity, validateWorktreeName } from './identity';
import { WORKTREE_RULES } from './rules';
import type { BindingState, RegistryPatch, SessionIdentity, WorktreeRegistry } from './types';

// ----------------------------------------------------------------------------
// deriveBindingState
// ----------------------------------------------------------------------------

/**
 * Derive the binding state for a given (spec, registry, worktreeName) tuple.
 *
 * Implements the canonical bidirectional rule:
 *   bound       <=> registry[name].specId === spec.id AND spec.worktree === name
 *   one_sided   <=> exactly one direction is set
 *   unbound     <=> neither direction set (or registry has no entry)
 *
 * `one_sided` is reported as-is. The kernel does NOT silently repair it.
 * That is doctor's job (Slice 5a/7).
 */
export function deriveBindingState(
  spec: Spec,
  registry: WorktreeRegistry,
  worktreeName: string
): BindingState {
  const record = registry[worktreeName];
  const registrySpecId = record?.specId;
  const registryHasSpecId = typeof registrySpecId === 'string' && registrySpecId.length > 0;

  const specWorktree = spec.worktree;
  const specHasWorktree = typeof specWorktree === 'string' && specWorktree.length > 0;

  const bothPoint = registryHasSpecId && specHasWorktree;
  const bidirectional =
    bothPoint && registrySpecId === spec.id && specWorktree === worktreeName;

  if (bidirectional) {
    return { kind: 'bound', spec, worktreeName };
  }

  if (bothPoint || registryHasSpecId || specHasWorktree) {
    return {
      kind: 'one_sided',
      detail: {
        specHasWorktree,
        registryHasSpecId,
        ...(specHasWorktree && specWorktree !== undefined ? { specWorktree } : {}),
        ...(registryHasSpecId && registrySpecId !== undefined ? { registrySpecId } : {}),
        worktreeName,
      },
    };
  }

  return { kind: 'unbound' };
}

// ----------------------------------------------------------------------------
// bindWorktree
// ----------------------------------------------------------------------------

/**
 * Options for `bindWorktree`.
 */
export interface BindWorktreeOptions {
  /**
   * Authority bit: when true, an existing binding to a different spec id is
   * permitted to be replaced. The shell layer is expected to surface its own
   * UX (confirmation prompt, etc.) before passing rebind=true. Without it,
   * a different-spec binding causes the kernel to refuse with
   * `worktree.binding.rebind_requires_explicit_flag`.
   */
  readonly rebind?: boolean;
}

/**
 * Compute the registry patch required to bind a worktree to a spec.
 *
 * Cases (in order):
 *
 *   1. Caller-input validation fails (bad name, bad session) → Err.
 *   2. Spec is not in a governable state (only `draft` and `active` may bind).
 *      → Err(BINDING_SPEC_NOT_GOVERNABLE).
 *   3. Existing record binds the same spec id → Ok with idempotent patch
 *      (no-op semantically; shell may skip writing).
 *   4. Existing record binds a different spec id, opts.rebind not true
 *      → Err(BINDING_REBIND_REQUIRES_EXPLICIT_FLAG).
 *   5. Existing record binds a different spec id, opts.rebind === true
 *      → Ok({ kind: 'rebind_worktree', ... }) with WARNING
 *        BINDING_REBIND_PERFORMED.
 *   6. No existing record (or no specId) → Ok({ kind: 'bind_worktree', ... })
 *      with idempotent=false.
 *
 * The kernel does NOT prompt; the shell owns UX.
 */
export function bindWorktree(
  spec: Spec,
  registry: WorktreeRegistry,
  worktreeName: string,
  session: SessionIdentity,
  opts: BindWorktreeOptions,
  now: Date
): Result<RegistryPatch> {
  // 1. Identity validation.
  const nameRes = validateWorktreeName(worktreeName);
  if (nameRes.ok === false) return nameRes;
  const name = nameRes.value;

  const sessionRes = validateSessionIdentity(session);
  if (sessionRes.ok === false) return sessionRes;
  const validSession = sessionRes.value;

  // 2. Governable state check.
  if (spec.lifecycle_state !== 'draft' && spec.lifecycle_state !== 'active') {
    return err(
      diagnostic({
        rule: WORKTREE_RULES.BINDING_SPEC_NOT_GOVERNABLE,
        authority: 'kernel/worktree',
        message: `Spec ${spec.id} is in lifecycle_state="${spec.lifecycle_state}" and cannot accept a worktree binding.`,
        subject: spec.id,
        narrowRepair: 'Reopen the spec or create a new draft before binding.',
      })
    );
  }

  const when = now.toISOString();
  const existing = registry[name];

  // 3. Same-spec idempotent bind.
  if (existing?.specId === spec.id) {
    return ok({
      kind: 'bind_worktree',
      worktree_name: name,
      spec_id: spec.id,
      owner: validSession,
      when,
      idempotent: true,
    });
  }

  // 4 + 5. Different-spec: rebind required or refused.
  if (typeof existing?.specId === 'string' && existing.specId.length > 0) {
    if (!opts.rebind) {
      return err(
        diagnostic({
          rule: WORKTREE_RULES.BINDING_REBIND_REQUIRES_EXPLICIT_FLAG,
          authority: 'kernel/worktree',
          message: `Worktree "${name}" is already bound to spec ${existing.specId}; rebinding to ${spec.id} requires an explicit rebind flag.`,
          subject: name,
          narrowRepair: 'Pass { rebind: true } if you intend to replace the existing binding.',
          data: { from_spec_id: existing.specId, to_spec_id: spec.id },
        })
      );
    }

    const warning: Diagnostic = diagnostic({
      rule: WORKTREE_RULES.BINDING_REBIND_PERFORMED,
      authority: 'kernel/worktree',
      message: `Worktree "${name}" rebound from ${existing.specId} to ${spec.id}.`,
      subject: name,
      severity: 'warning',
      data: { from_spec_id: existing.specId, to_spec_id: spec.id },
    });

    return ok(
      {
        kind: 'rebind_worktree',
        worktree_name: name,
        from_spec_id: existing.specId,
        to_spec_id: spec.id,
        owner: validSession,
        when,
      },
      [warning]
    );
  }

  // 6. Fresh bind.
  return ok({
    kind: 'bind_worktree',
    worktree_name: name,
    spec_id: spec.id,
    owner: validSession,
    when,
    idempotent: false,
  });
}

// Re-export for convenience.
export { sameSession };
