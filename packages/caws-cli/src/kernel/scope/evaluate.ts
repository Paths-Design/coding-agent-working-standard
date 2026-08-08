// Pure scope evaluator.
//
// One question, one answer: given a path, a binding state, and a policy,
// what is the authority decision? No I/O. No filesystem. No throwing on
// untrusted input. Malformed paths land as `invalid_path` decisions.
//
// This evaluator is the single authority surface for "may this write happen?".
// CLI/hook layers decide how to render or enforce a Decision; the kernel
// does not concern itself with WriteIntent or read_only modes. A
// `no_authority` decision is never silently downgraded to `admit`.
//
// Evaluation order (after lexical path validation):
//
//   1. Binding authority
//        unbound      → no_authority.unbound
//        one_sided    → no_authority.binding_one_sided
//        bound        → continue
//
//   2. Infrastructure exemption (only after bound)
//        .caws or .caws/**, .claude or .claude/** → admit.infra_exempt
//
//   3. policy.non_governed_zones (glob, dot:true)
//        match → admit.non_governed_zone
//
//   4. spec.scope.out (exact-or-descendant; schema rejects globs)
//        match → reject.scope_out
//
//   5. Root-level paths
//        a. policy.root_passthrough exact match → admit.root_passthrough
//        b. spec.scope.in match (treats plain entries as prefixes) → admit.scope_in
//        c. otherwise                                              → reject.root_not_allowed
//
//   6. Non-root paths
//        a. spec.scope.in match → admit.scope_in
//        b. otherwise            → reject.scope_in_miss

import { diagnostic } from '../diagnostics/construct';
import type { Diagnostic } from '../diagnostics/types';
import { err, ok } from '../result/construct';
import type { Result } from '../result/types';
import type { Policy } from '../policy/types';
import { matchExactRoot, matchGlob, matchPrefix } from './match';
import { isRootLevel, normalizeRelativePosixPath } from './normalize';
import { SCOPE_RULES } from './rules';
import type { AdmitDecision, BindingState, Decision } from './types';

const INFRA_PREFIXES = ['.caws', '.claude'] as const;

/**
 * Evaluate a path against the bound spec and policy.
 *
 * Always returns a Decision; never throws for malformed inputs (those
 * become `invalid_path` decisions). The original `path` is preserved on
 * the Decision for diagnostics.
 */
export function evaluatePath(path: string, binding: BindingState, policy: Policy): Decision {
  // 0. Lexical path validation/normalization.
  const normalized = normalizeRelativePosixPath(path);
  if (!normalized.ok) {
    return {
      kind: 'invalid_path',
      rule: normalized.failure.rule,
      authority: 'kernel/scope',
      path: typeof path === 'string' ? path : String(path),
      message: normalized.failure.message,
      narrowRepair: 'Provide a relative POSIX path with no parent traversal, NUL, or backslash.',
      bindingState: binding.kind,
      data: { stage: 'normalize' },
    };
  }
  const normPath = normalized.normalized;

  // 1. Binding authority.
  if (binding.kind === 'unbound') {
    return {
      kind: 'no_authority',
      rule: SCOPE_RULES.NO_AUTHORITY_UNBOUND,
      authority: 'kernel/scope',
      path,
      normalizedPath: normPath,
      message: 'No spec is bound to this worktree; the kernel cannot decide scope authority.',
      narrowRepair: 'Bind a spec to this worktree by running `caws worktree bind <worktree-name> --spec <spec-id>` (writes the bidirectional binding atomically). If no worktree exists yet, create one with `caws worktree create <name> --spec <spec-id>` instead.',
      bindingState: 'unbound',
    };
  }
  if (binding.kind === 'one_sided') {
    return {
      kind: 'no_authority',
      rule: SCOPE_RULES.NO_AUTHORITY_BINDING_ONE_SIDED,
      authority: 'kernel/scope',
      path,
      normalizedPath: normPath,
      message:
        'Spec/worktree binding is one-sided (corrupt). The kernel refuses to evaluate scope.',
      narrowRepair:
        'Repair the one-sided binding by running `caws worktree bind <worktree-name> --spec <spec-id>` (atomically writes both sides of the binding), or run `caws doctor` for full details on which side is missing.',
      bindingState: 'one_sided',
      data: {
        specHasWorktree: binding.detail.specHasWorktree,
        registryHasSpecId: binding.detail.registryHasSpecId,
        ...(binding.detail.specWorktree !== undefined && { specWorktree: binding.detail.specWorktree }),
        ...(binding.detail.registrySpecId !== undefined && { registrySpecId: binding.detail.registrySpecId }),
        ...(binding.detail.worktreeName !== undefined && { worktreeName: binding.detail.worktreeName }),
      },
    };
  }

  // From here on, binding.kind === 'bound'.
  const spec = binding.spec;

  // 2. Infrastructure exemption — applies only after binding authority exists.
  const infraMatch = matchPrefix(normPath, INFRA_PREFIXES);
  if (infraMatch !== null) {
    return {
      kind: 'admit',
      rule: SCOPE_RULES.ADMIT_INFRA_EXEMPT,
      authority: 'kernel/scope',
      path,
      normalizedPath: normPath,
      message: `Path is under infrastructure prefix "${infraMatch}" and is exempt from scope.`,
      bindingState: 'bound',
      data: { matchedPrefix: infraMatch },
    };
  }

  // 3. Non-governed zones (policy authority).
  const nonGovernedZones = policy.non_governed_zones ?? [];
  if (nonGovernedZones.length > 0) {
    const zoneMatch = matchGlob(normPath, nonGovernedZones);
    if (zoneMatch !== null) {
      return {
        kind: 'admit',
        rule: SCOPE_RULES.ADMIT_NON_GOVERNED_ZONE,
        authority: 'kernel/scope',
        path,
        normalizedPath: normPath,
        message: `Path matches policy.non_governed_zones pattern "${zoneMatch}".`,
        bindingState: 'bound',
        data: { matchedPattern: zoneMatch },
      };
    }
  }

  // 4. scope.out — exact-or-descendant (schema forbids globs here).
  const scopeOut = spec.scope.out ?? [];
  if (scopeOut.length > 0) {
    const outMatch = matchPrefix(normPath, scopeOut);
    if (outMatch !== null) {
      return {
        kind: 'reject',
        rule: SCOPE_RULES.REJECT_SCOPE_OUT,
        authority: 'kernel/scope',
        path,
        normalizedPath: normPath,
        message: `Path is excluded by spec ${spec.id} via scope.out entry "${outMatch}".`,
        narrowRepair: `Move the change outside "${outMatch}" or amend the spec.`,
        bindingState: 'bound',
        data: { matchedPrefix: outMatch, specId: spec.id },
      };
    }
  }

  // 5/6. Admission via root_passthrough or scope.in.
  if (isRootLevel(normPath)) {
    const rootPassthrough = policy.root_passthrough ?? [];
    if (rootPassthrough.length > 0) {
      const rootMatch = matchExactRoot(normPath, rootPassthrough);
      if (rootMatch !== null) {
        return {
          kind: 'admit',
          rule: SCOPE_RULES.ADMIT_ROOT_PASSTHROUGH,
          authority: 'kernel/scope',
          path,
          normalizedPath: normPath,
          message: `Root-level file "${rootMatch}" is admitted by policy.root_passthrough.`,
          bindingState: 'bound',
          data: { matchedName: rootMatch },
        };
      }
    }

    const scopeInRoot = matchGlob(normPath, spec.scope.in);
    if (scopeInRoot !== null) {
      return {
        kind: 'admit',
        rule: SCOPE_RULES.ADMIT_SCOPE_IN,
        authority: 'kernel/scope',
        path,
        normalizedPath: normPath,
        message: `Path is admitted by spec ${spec.id} scope.in entry "${scopeInRoot}".`,
        bindingState: 'bound',
        data: { matchedPattern: scopeInRoot, specId: spec.id },
      };
    }

    // scope.support — admitted for edits like scope.in, but never a worktree
    // claim (WORKTREE-SUPPORT-SCOPE-001). Checked after scope.in (so a path in
    // both reports as scope.in) and after the upstream scope.out gate (so out
    // still shadows support). Lets a repo-root deliverable be edited without
    // making the bound worktree claim it.
    const scopeSupportRoot = matchGlob(normPath, spec.scope.support ?? []);
    if (scopeSupportRoot !== null) {
      return {
        kind: 'admit',
        rule: SCOPE_RULES.ADMIT_SCOPE_SUPPORT,
        authority: 'kernel/scope',
        path,
        normalizedPath: normPath,
        message: `Path is admitted by spec ${spec.id} scope.support entry "${scopeSupportRoot}" (editable, not worktree-claimed).`,
        bindingState: 'bound',
        data: { matchedPattern: scopeSupportRoot, specId: spec.id },
      };
    }

    return {
      kind: 'reject',
      rule: SCOPE_RULES.REJECT_ROOT_NOT_ALLOWED,
      authority: 'kernel/scope',
      path,
      normalizedPath: normPath,
      message: `Root-level file "${normPath}" is not in policy.root_passthrough and not listed in spec ${spec.id} scope.in or scope.support.`,
      narrowRepair: `Add "${normPath}" to policy.root_passthrough, list it in spec scope.in, or add it to scope.support (editable, not worktree-claimed).`,
      bindingState: 'bound',
      data: { specId: spec.id },
    };
  }

  // Non-root path: scope.in then scope.support are the admit gates.
  const scopeInMatch = matchGlob(normPath, spec.scope.in);
  if (scopeInMatch !== null) {
    return {
      kind: 'admit',
      rule: SCOPE_RULES.ADMIT_SCOPE_IN,
      authority: 'kernel/scope',
      path,
      normalizedPath: normPath,
      message: `Path is admitted by spec ${spec.id} scope.in entry "${scopeInMatch}".`,
      bindingState: 'bound',
      data: { matchedPattern: scopeInMatch, specId: spec.id },
    };
  }

  // scope.support — editable like scope.in, never a worktree claim
  // (WORKTREE-SUPPORT-SCOPE-001). After scope.in, after the scope.out gate.
  const scopeSupportMatch = matchGlob(normPath, spec.scope.support ?? []);
  if (scopeSupportMatch !== null) {
    return {
      kind: 'admit',
      rule: SCOPE_RULES.ADMIT_SCOPE_SUPPORT,
      authority: 'kernel/scope',
      path,
      normalizedPath: normPath,
      message: `Path is admitted by spec ${spec.id} scope.support entry "${scopeSupportMatch}" (editable, not worktree-claimed).`,
      bindingState: 'bound',
      data: { matchedPattern: scopeSupportMatch, specId: spec.id },
    };
  }

  return {
    kind: 'reject',
    rule: SCOPE_RULES.REJECT_SCOPE_IN_MISS,
    authority: 'kernel/scope',
    path,
    normalizedPath: normPath,
    message: `Path "${normPath}" does not match any entry in spec ${spec.id} scope.in or scope.support.`,
    narrowRepair: 'Add a covering entry to scope.in (worktree-claimed) or scope.support (editable, not claimed), or move the change to a covered path.',
    bindingState: 'bound',
    data: { specId: spec.id },
  };
}

/**
 * Adapter: map an admit Decision to Ok, all other Decision kinds to
 * Err(Diagnostic) with the full Decision attached as data so callers
 * retain the original evidence.
 *
 * Use this when you need Result-flavored composition (flatMap, all);
 * prefer evaluatePath when you need to render the decision.
 */
export function evaluatePathResult(
  path: string,
  binding: BindingState,
  policy: Policy,
): Result<AdmitDecision> {
  const decision = evaluatePath(path, binding, policy);
  if (decision.kind === 'admit') {
    return ok(decision);
  }
  return err(decisionToDiagnostic(decision));
}

function decisionToDiagnostic(decision: Decision): Diagnostic {
  return diagnostic({
    rule: decision.rule,
    authority: decision.authority,
    message: decision.message,
    subject: decision.normalizedPath ?? decision.path,
    ...(decision.narrowRepair !== undefined && { narrowRepair: decision.narrowRepair }),
    data: { decision },
  });
}
