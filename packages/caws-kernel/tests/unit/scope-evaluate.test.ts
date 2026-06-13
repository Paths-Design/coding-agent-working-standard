/**
 * Unit tests for evaluatePath — the single scope authority surface (A1).
 *
 * CAWS-TEST-KERNEL-PURE-001. This is the security-critical kernel module: the
 * scope guard's correctness rests on it. Tests pin the ACTUAL admit/refuse
 * decision, the rule id, and — crucially — the EVALUATION ORDER, so a mutation
 * that flips a decision or reorders the pipeline is killed.
 *
 * Failure-lineage anchors:
 *   E8  (scope boundary violation)      -> scope.out shadows scope.in; misses reject.
 *   E12 (unbound = silent authority escape) -> unbound yields no_authority,
 *        NEVER admit. This is the load-bearing safety property.
 */

import { evaluatePath, evaluatePathResult } from '../../src/scope/evaluate';
import { SCOPE_RULES } from '../../src/scope/rules';
import { isOk, isErr } from '../../src/result/construct';
import { makePolicy, makeBound, UNBOUND, makeOneSided } from '../helpers/scope-fixtures';

const policy = makePolicy();

describe('evaluatePath: binding authority (E12 — unbound is no_authority, never admit)', () => {
  test('unbound -> no_authority.unbound, NOT admit', () => {
    const d = evaluatePath('src/anything.ts', UNBOUND, policy);
    expect(d.kind).toBe('no_authority');
    expect(d.rule).toBe(SCOPE_RULES.NO_AUTHORITY_UNBOUND);
    // The safety invariant: unbound is never silently admitted.
    expect(d.kind).not.toBe('admit');
  });

  test('one_sided binding -> no_authority.binding_one_sided (corrupt, refuse)', () => {
    const d = evaluatePath('src/x.ts', makeOneSided(), policy);
    expect(d.kind).toBe('no_authority');
    expect(d.rule).toBe(SCOPE_RULES.NO_AUTHORITY_BINDING_ONE_SIDED);
  });

  test('binding authority is checked BEFORE infra exemption (unbound .caws path still no_authority)', () => {
    // If order were inverted, a .caws path under unbound would wrongly admit.
    const d = evaluatePath('.caws/specs/x.yaml', UNBOUND, policy);
    expect(d.kind).toBe('no_authority');
  });
});

describe('evaluatePath: invalid path handling (no throw, surfaced as data)', () => {
  test('parent traversal -> invalid_path, not an exception', () => {
    const d = evaluatePath('../escape.ts', makeBound({ in: ['src'] }), policy);
    expect(d.kind).toBe('invalid_path');
    expect(d.rule).toBe(SCOPE_RULES.INVALID_PATH_PARENT_TRAVERSAL);
  });

  test('absolute path -> invalid_path', () => {
    const d = evaluatePath('/etc/passwd', makeBound({ in: ['src'] }), policy);
    expect(d.kind).toBe('invalid_path');
    expect(d.rule).toBe(SCOPE_RULES.INVALID_PATH_ABSOLUTE);
  });

  test('path validation runs BEFORE binding check (bad path under unbound is invalid_path)', () => {
    const d = evaluatePath('../x', UNBOUND, policy);
    expect(d.kind).toBe('invalid_path');
  });
});

describe('evaluatePath: scope.in admission', () => {
  test('a path under scope.in is admitted with scope_in rule', () => {
    const d = evaluatePath('src/store/x.ts', makeBound({ in: ['src/store'] }, 'S-1'), policy);
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_SCOPE_IN);
    expect(d.data?.specId).toBe('S-1');
  });

  test('a path NOT under scope.in is rejected with scope_in_miss', () => {
    const d = evaluatePath('lib/other.ts', makeBound({ in: ['src/store'] }), policy);
    expect(d.kind).toBe('reject');
    expect(d.rule).toBe(SCOPE_RULES.REJECT_SCOPE_IN_MISS);
  });
});

describe('evaluatePath: scope.out shadows scope.in (E8 — exclusion wins)', () => {
  test('a path in BOTH scope.in and scope.out is REJECTED (out wins)', () => {
    const d = evaluatePath(
      'src/store/secret.ts',
      makeBound({ in: ['src/store'], out: ['src/store/secret.ts'] }),
      policy
    );
    expect(d.kind).toBe('reject');
    expect(d.rule).toBe(SCOPE_RULES.REJECT_SCOPE_OUT);
  });

  test('scope.out is exact-or-descendant (a dir entry excludes its children)', () => {
    const d = evaluatePath(
      'src/store/sub/deep.ts',
      makeBound({ in: ['src'], out: ['src/store'] }),
      policy
    );
    expect(d.kind).toBe('reject');
    expect(d.rule).toBe(SCOPE_RULES.REJECT_SCOPE_OUT);
  });
});

describe('evaluatePath: infra exemption (after binding)', () => {
  test('.caws path under a bound spec is admitted infra_exempt (even if not in scope.in)', () => {
    const d = evaluatePath('.caws/specs/x.yaml', makeBound({ in: ['src'] }), policy);
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_INFRA_EXEMPT);
  });

  test('.claude path is infra-exempt too', () => {
    const d = evaluatePath('.claude/settings.json', makeBound({ in: ['src'] }), policy);
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_INFRA_EXEMPT);
  });

  test('infra exemption is checked BEFORE scope.out (a .caws path in scope.out still admits)', () => {
    // Order proof: infra (step 2) precedes scope.out (step 4).
    const d = evaluatePath('.caws/x.yaml', makeBound({ in: ['src'], out: ['.caws'] }), policy);
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_INFRA_EXEMPT);
  });
});

describe('evaluatePath: non_governed_zones (policy authority)', () => {
  test('a path matching a non_governed_zones glob is admitted', () => {
    const p = makePolicy({ non_governed_zones: ['docs/**'] });
    const d = evaluatePath('docs/guide.md', makeBound({ in: ['src'] }), p);
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_NON_GOVERNED_ZONE);
  });
});

describe('evaluatePath: root-level paths', () => {
  test('root file NOT in scope.in/passthrough -> reject.root_not_allowed', () => {
    const d = evaluatePath('README.md', makeBound({ in: ['src'] }), policy);
    expect(d.kind).toBe('reject');
    expect(d.rule).toBe(SCOPE_RULES.REJECT_ROOT_NOT_ALLOWED);
  });

  test('root file in policy.root_passthrough -> admit.root_passthrough', () => {
    const p = makePolicy({ root_passthrough: ['README.md'] });
    const d = evaluatePath('README.md', makeBound({ in: ['src'] }), p);
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_ROOT_PASSTHROUGH);
  });

  test('root_passthrough is checked BEFORE scope.in at root level', () => {
    const p = makePolicy({ root_passthrough: ['x.md'] });
    const d = evaluatePath('x.md', makeBound({ in: ['x.md'] }), p);
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_ROOT_PASSTHROUGH);
  });
});

describe('evaluatePath: scope.support (editable, NOT worktree-claimed)', () => {
  test('a path in scope.support is admitted with scope_support rule', () => {
    const d = evaluatePath(
      'src/shared/util.ts',
      makeBound({ in: ['src/store'], support: ['src/shared'] }),
      policy
    );
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_SCOPE_SUPPORT);
  });

  test('a path in BOTH scope.in and scope.support reports as scope_in (in checked first)', () => {
    const d = evaluatePath(
      'src/store/x.ts',
      makeBound({ in: ['src/store'], support: ['src/store'] }),
      policy
    );
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_SCOPE_IN);
  });

  test('scope.out still shadows scope.support (out wins over support too)', () => {
    const d = evaluatePath(
      'src/shared/x.ts',
      makeBound({ in: ['src'], out: ['src/shared'], support: ['src/shared'] }),
      policy
    );
    expect(d.kind).toBe('reject');
    expect(d.rule).toBe(SCOPE_RULES.REJECT_SCOPE_OUT);
  });
});

describe('evaluatePathResult: Result adapter', () => {
  test('admit decision -> Ok(decision)', () => {
    const r = evaluatePathResult('src/x.ts', makeBound({ in: ['src'] }), policy);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.kind).toBe('admit');
  });

  test('reject decision -> Err carrying the decision in data', () => {
    const r = evaluatePathResult('lib/x.ts', makeBound({ in: ['src'] }), policy);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors[0]!.rule).toBe(SCOPE_RULES.REJECT_SCOPE_IN_MISS);
      expect(r.errors[0]!.data?.decision).toBeDefined();
    }
  });

  test('unbound -> Err (no_authority is never an Ok)', () => {
    const r = evaluatePathResult('src/x.ts', UNBOUND, policy);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.errors[0]!.rule).toBe(SCOPE_RULES.NO_AUTHORITY_UNBOUND);
  });
});
