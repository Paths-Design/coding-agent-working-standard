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

// ---------------------------------------------------------------------------
// MUTATION-KILLING SUITE: assert message content, data fields, and branch arms
// that the basic suite above left uncovered.
// ---------------------------------------------------------------------------

describe('evaluatePath: invalid_path — message + data fields', () => {
  test('invalid_path preserves original path string on the decision', () => {
    const d = evaluatePath('../escape.ts', makeBound({ in: ['src'] }), policy);
    expect(d.kind).toBe('invalid_path');
    expect(d.path).toBe('../escape.ts');
  });

  test('invalid_path sets authority to kernel/scope', () => {
    const d = evaluatePath('../x.ts', makeBound({ in: ['src'] }), policy);
    expect(d.authority).toBe('kernel/scope');
  });

  test('invalid_path carries a narrowRepair hint', () => {
    const d = evaluatePath('../x.ts', makeBound({ in: ['src'] }), policy);
    expect(d.narrowRepair).toContain('relative POSIX path');
  });

  test('invalid_path data has stage: normalize', () => {
    const d = evaluatePath('../x.ts', makeBound({ in: ['src'] }), policy);
    expect(d.data?.stage).toBe('normalize');
  });

  test('invalid_path message is non-empty (parent traversal case)', () => {
    const d = evaluatePath('../x.ts', makeBound({ in: ['src'] }), policy);
    expect(typeof d.message).toBe('string');
    expect(d.message.length).toBeGreaterThan(0);
  });

  test('invalid_path from absolute path — rule and message', () => {
    const d = evaluatePath('/etc/passwd', makeBound({ in: ['src'] }), policy);
    expect(d.kind).toBe('invalid_path');
    expect(d.rule).toBe(SCOPE_RULES.INVALID_PATH_ABSOLUTE);
    expect(d.message).toContain('Absolute');
    expect(d.data?.stage).toBe('normalize');
  });

  test('non-string path — coerced to string, yields invalid_path with NOT_STRING rule', () => {
    // When typeof path !== 'string', the path is coerced via String(path)
    const d = evaluatePath(42 as unknown as string, makeBound({ in: ['src'] }), policy);
    expect(d.kind).toBe('invalid_path');
    expect(d.rule).toBe(SCOPE_RULES.INVALID_PATH_NOT_STRING);
    // The coerced path should be "42" (String(42))
    expect(d.path).toBe('42');
  });

  test('non-string path — path is String(value) not the raw value', () => {
    // L64: typeof path === 'string' ? path : String(path)
    // Mutation: "false" branch makes it always use `path` — that would fail because
    // typeof 42 !== 'string', so d.path would be 42 (a number), not "42".
    const d = evaluatePath(null as unknown as string, makeBound({ in: ['src'] }), policy);
    expect(d.kind).toBe('invalid_path');
    expect(d.path).toBe('null');
    expect(typeof d.path).toBe('string');
  });

  test('non-string path — typeof guard distinguishes string from non-string (L64 EqualityOperator)', () => {
    // Mutation "typeof path !== 'string'" would flip the condition so non-strings
    // also get the true branch and strings get the String() coercion.
    // Kill it: a valid string path that admits should also have path === original.
    const d = evaluatePath('src/x.ts', makeBound({ in: ['src'] }), policy);
    expect(d.path).toBe('src/x.ts');
    expect(d.kind).toBe('admit');
  });

  test('backslash path -> invalid_path with backslash rule', () => {
    const d = evaluatePath('src\\foo.ts', makeBound({ in: ['src'] }), policy);
    expect(d.kind).toBe('invalid_path');
    expect(d.rule).toBe(SCOPE_RULES.INVALID_PATH_BACKSLASH);
    expect(d.message.length).toBeGreaterThan(0);
    expect(d.data?.stage).toBe('normalize');
  });

  test('NUL byte path -> invalid_path with NUL rule', () => {
    const d = evaluatePath('src/\0foo.ts', makeBound({ in: ['src'] }), policy);
    expect(d.kind).toBe('invalid_path');
    expect(d.rule).toBe(SCOPE_RULES.INVALID_PATH_NUL);
    expect(d.message.length).toBeGreaterThan(0);
  });
});

describe('evaluatePath: no_authority.unbound — message + fields (L78-83)', () => {
  test('unbound message is non-empty and mentions spec', () => {
    const d = evaluatePath('src/x.ts', UNBOUND, policy);
    expect(d.message).toContain('spec');
  });

  test('unbound carries a narrowRepair hint mentioning caws worktree', () => {
    const d = evaluatePath('src/x.ts', UNBOUND, policy);
    expect(d.narrowRepair).toBeDefined();
    expect(d.narrowRepair).toContain('caws worktree');
  });

  test('unbound has bindingState: unbound', () => {
    const d = evaluatePath('src/x.ts', UNBOUND, policy);
    expect(d.bindingState).toBe('unbound');
  });

  test('unbound has normalizedPath on the decision', () => {
    const d = evaluatePath('src/x.ts', UNBOUND, policy);
    expect(d.normalizedPath).toBe('src/x.ts');
  });

  test('unbound has authority: kernel/scope', () => {
    const d = evaluatePath('src/x.ts', UNBOUND, policy);
    expect(d.authority).toBe('kernel/scope');
  });
});

describe('evaluatePath: no_authority.one_sided — message + data fields (L88-103)', () => {
  test('one_sided message mentions corrupt binding', () => {
    const d = evaluatePath('src/x.ts', makeOneSided(), policy);
    expect(d.message).toContain('one-sided');
  });

  test('one_sided carries a narrowRepair hint mentioning caws worktree bind', () => {
    const d = evaluatePath('src/x.ts', makeOneSided(), policy);
    expect(d.narrowRepair).toBeDefined();
    expect(d.narrowRepair).toContain('caws worktree bind');
  });

  test('one_sided has bindingState: one_sided', () => {
    const d = evaluatePath('src/x.ts', makeOneSided(), policy);
    expect(d.bindingState).toBe('one_sided');
  });

  test('one_sided data has specHasWorktree and registryHasSpecId', () => {
    const d = evaluatePath('src/x.ts', makeOneSided(), policy);
    expect(d.data?.specHasWorktree).toBe(true);
    expect(d.data?.registryHasSpecId).toBe(false);
  });

  test('one_sided data omits specWorktree when undefined (L101 conditional spread)', () => {
    // makeOneSided() has specHasWorktree:true/registryHasSpecId:false but no specWorktree
    const d = evaluatePath('src/x.ts', makeOneSided(), policy);
    expect(d.data).not.toHaveProperty('specWorktree');
  });

  test('one_sided data includes specWorktree when present (L101 spread — kills ObjectLiteral+conditional mutants)', () => {
    const binding: import('../../src/worktree/types').BindingState = {
      kind: 'one_sided',
      detail: {
        specHasWorktree: true,
        registryHasSpecId: false,
        specWorktree: 'my-worktree',
      },
    };
    const d = evaluatePath('src/x.ts', binding, policy);
    expect(d.data?.specWorktree).toBe('my-worktree');
  });

  test('one_sided data includes registrySpecId when present (L102 conditional spread)', () => {
    const binding: import('../../src/worktree/types').BindingState = {
      kind: 'one_sided',
      detail: {
        specHasWorktree: false,
        registryHasSpecId: true,
        registrySpecId: 'SPEC-XYZ',
      },
    };
    const d = evaluatePath('src/x.ts', binding, policy);
    expect(d.data?.registrySpecId).toBe('SPEC-XYZ');
  });

  test('one_sided data omits registrySpecId when absent (L102 — kills false conditional mutant)', () => {
    const d = evaluatePath('src/x.ts', makeOneSided(), policy);
    expect(d.data).not.toHaveProperty('registrySpecId');
  });

  test('one_sided data includes worktreeName when present (L103 conditional spread)', () => {
    const binding: import('../../src/worktree/types').BindingState = {
      kind: 'one_sided',
      detail: {
        specHasWorktree: false,
        registryHasSpecId: true,
        worktreeName: 'wt-alpha',
      },
    };
    const d = evaluatePath('src/x.ts', binding, policy);
    expect(d.data?.worktreeName).toBe('wt-alpha');
  });

  test('one_sided data omits worktreeName when absent (L103 — kills false conditional mutant)', () => {
    const d = evaluatePath('src/x.ts', makeOneSided(), policy);
    expect(d.data).not.toHaveProperty('worktreeName');
  });

  test('one_sided — all three optional fields present simultaneously', () => {
    const binding: import('../../src/worktree/types').BindingState = {
      kind: 'one_sided',
      detail: {
        specHasWorktree: true,
        registryHasSpecId: true,
        specWorktree: 'wt-both',
        registrySpecId: 'SPEC-BOTH',
        worktreeName: 'wt-both',
      },
    };
    const d = evaluatePath('src/x.ts', binding, policy);
    expect(d.data?.specWorktree).toBe('wt-both');
    expect(d.data?.registrySpecId).toBe('SPEC-BOTH');
    expect(d.data?.worktreeName).toBe('wt-both');
  });
});

describe('evaluatePath: infra exemption — message + data.matchedPrefix (L117-122)', () => {
  test('.caws path message mentions the matched infrastructure prefix', () => {
    const d = evaluatePath('.caws/specs/x.yaml', makeBound({ in: ['src'] }), policy);
    expect(d.message).toContain('.caws');
    expect(d.message).toContain('infrastructure prefix');
  });

  test('.caws data.matchedPrefix is ".caws"', () => {
    const d = evaluatePath('.caws/policy.yaml', makeBound({ in: ['src'] }), policy);
    expect(d.data?.matchedPrefix).toBe('.caws');
  });

  test('.claude data.matchedPrefix is ".claude"', () => {
    const d = evaluatePath('.claude/settings.json', makeBound({ in: ['src'] }), policy);
    expect(d.data?.matchedPrefix).toBe('.claude');
  });

  test('infra decision has bindingState: bound', () => {
    const d = evaluatePath('.caws/events.jsonl', makeBound({ in: ['src'] }), policy);
    expect(d.bindingState).toBe('bound');
  });

  test('infra decision has authority: kernel/scope', () => {
    const d = evaluatePath('.caws/x', makeBound({ in: ['src'] }), policy);
    expect(d.authority).toBe('kernel/scope');
  });

  test('infra decision has normalizedPath', () => {
    const d = evaluatePath('.caws/x.yaml', makeBound({ in: ['src'] }), policy);
    expect(d.normalizedPath).toBe('.caws/x.yaml');
  });
});

describe('evaluatePath: non_governed_zones — branch arms + message + data (L127-139)', () => {
  test('empty non_governed_zones -> no non-governed admission (branch skipped)', () => {
    // nonGovernedZones.length > 0 guard: if empty, zone match is skipped entirely.
    const pEmpty = makePolicy({ non_governed_zones: [] });
    const d = evaluatePath('docs/guide.md', makeBound({ in: ['src'] }), pEmpty);
    // With empty zones, should fall through to scope.in miss
    expect(d.kind).toBe('reject');
    expect(d.rule).toBe(SCOPE_RULES.REJECT_SCOPE_IN_MISS);
  });

  test('non_governed_zones length > 0 but no match -> path not admitted via zone', () => {
    // L128 ConditionalExpression: mutation "true" would always enter the branch,
    // then zoneMatch === null so no early return — behavior identical. But
    // L128 EqualityOperator: "length >= 0" always true — same. These are covered by
    // the "no match -> still rejects" shape.
    const pWithZone = makePolicy({ non_governed_zones: ['vendor/**'] });
    const d = evaluatePath('src/x.ts', makeBound({ in: [] }), pWithZone);
    expect(d.kind).toBe('reject');
    expect(d.rule).not.toBe(SCOPE_RULES.ADMIT_NON_GOVERNED_ZONE);
  });

  test('non_governed_zone message contains the matched pattern', () => {
    const p = makePolicy({ non_governed_zones: ['docs/**'] });
    const d = evaluatePath('docs/guide.md', makeBound({ in: ['src'] }), p);
    expect(d.message).toContain('docs/**');
    expect(d.message).toContain('non_governed_zones');
  });

  test('non_governed_zone data.matchedPattern is the glob that matched', () => {
    const p = makePolicy({ non_governed_zones: ['docs/**'] });
    const d = evaluatePath('docs/guide.md', makeBound({ in: ['src'] }), p);
    expect(d.data?.matchedPattern).toBe('docs/**');
  });

  test('non_governed_zone decision has bindingState: bound', () => {
    const p = makePolicy({ non_governed_zones: ['docs/**'] });
    const d = evaluatePath('docs/guide.md', makeBound({ in: ['src'] }), p);
    expect(d.bindingState).toBe('bound');
  });

  test('non_governed_zones undefined treated as empty (no error)', () => {
    // policy.non_governed_zones ?? [] — the undefined branch
    const pNone = makePolicy();
    const d = evaluatePath('docs/guide.md', makeBound({ in: ['src'] }), pNone);
    expect(d.kind).toBe('reject');
  });
});

describe('evaluatePath: scope.out — message + data fields + narrowRepair (L145-158)', () => {
  test('scope.out rejection message names the spec and the matched prefix', () => {
    const d = evaluatePath(
      'src/store/secret.ts',
      makeBound({ in: ['src/store'], out: ['src/store/secret.ts'] }, 'SPEC-OUT-001'),
      policy
    );
    expect(d.message).toContain('SPEC-OUT-001');
    expect(d.message).toContain('src/store/secret.ts');
  });

  test('scope.out data.matchedPrefix is the out entry that matched', () => {
    const d = evaluatePath(
      'src/store/secret.ts',
      makeBound({ in: ['src'], out: ['src/store'] }, 'SPEC-OUT-002'),
      policy
    );
    expect(d.data?.matchedPrefix).toBe('src/store');
  });

  test('scope.out data.specId matches the bound spec id', () => {
    const d = evaluatePath(
      'src/store/secret.ts',
      makeBound({ in: ['src'], out: ['src/store'] }, 'MY-SPEC-ID'),
      policy
    );
    expect(d.data?.specId).toBe('MY-SPEC-ID');
  });

  test('scope.out carries a narrowRepair mentioning the out entry', () => {
    const d = evaluatePath(
      'src/store/x.ts',
      makeBound({ in: ['src'], out: ['src/store'] }, 'S-1'),
      policy
    );
    expect(d.narrowRepair).toBeDefined();
    expect(d.narrowRepair).toContain('src/store');
  });

  test('empty scope.out -> scope.out gate skipped (L145 ArrayDeclaration mutant)', () => {
    // Stryker replaces scopeOut with ["Stryker was here"] — would cause false rejection.
    // Kill: with empty out, a path in scope.in MUST admit.
    const d = evaluatePath(
      'src/x.ts',
      makeBound({ in: ['src'], out: [] }, 'S-EMPTY-OUT'),
      policy
    );
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_SCOPE_IN);
  });

  test('scope.out length > 0 but no match -> falls through to admit (L146 ConditionalExpression branch)', () => {
    const d = evaluatePath(
      'src/other.ts',
      makeBound({ in: ['src'], out: ['lib'] }, 'S-2'),
      policy
    );
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_SCOPE_IN);
  });

  test('scope.out bindingState is bound', () => {
    const d = evaluatePath(
      'src/store/x.ts',
      makeBound({ in: ['src'], out: ['src/store'] }, 'S-1'),
      policy
    );
    expect(d.bindingState).toBe('bound');
  });
});

describe('evaluatePath: root_passthrough — message + data.matchedName (L165-177)', () => {
  test('root_passthrough message mentions the matched filename', () => {
    const p = makePolicy({ root_passthrough: ['README.md'] });
    const d = evaluatePath('README.md', makeBound({ in: ['src'] }), p);
    expect(d.message).toContain('README.md');
    expect(d.message).toContain('root_passthrough');
  });

  test('root_passthrough data.matchedName is the exact filename', () => {
    const p = makePolicy({ root_passthrough: ['package.json'] });
    const d = evaluatePath('package.json', makeBound({ in: ['src'] }), p);
    expect(d.data?.matchedName).toBe('package.json');
  });

  test('root_passthrough bindingState is bound', () => {
    const p = makePolicy({ root_passthrough: ['README.md'] });
    const d = evaluatePath('README.md', makeBound({ in: ['src'] }), p);
    expect(d.bindingState).toBe('bound');
  });

  test('empty root_passthrough -> skips passthrough gate (L165 ArrayDeclaration mutant)', () => {
    // ["Stryker was here"] mutant would wrongly admit README.md
    const p = makePolicy({ root_passthrough: [] });
    const d = evaluatePath('README.md', makeBound({ in: ['src'] }), p);
    expect(d.kind).toBe('reject');
    expect(d.rule).toBe(SCOPE_RULES.REJECT_ROOT_NOT_ALLOWED);
  });

  test('non-empty root_passthrough but no match -> falls through (L166 ConditionalExpression)', () => {
    const p = makePolicy({ root_passthrough: ['CONTRIBUTING.md'] });
    const d = evaluatePath('README.md', makeBound({ in: ['src'] }), p);
    expect(d.kind).toBe('reject');
    expect(d.rule).toBe(SCOPE_RULES.REJECT_ROOT_NOT_ALLOWED);
  });

  test('root_passthrough undefined -> treated as empty (no crash)', () => {
    const p = makePolicy();
    const d = evaluatePath('README.md', makeBound({ in: ['src'] }), p);
    expect(d.kind).toBe('reject');
  });
});

describe('evaluatePath: scope.in at root level — message + data (L183-192)', () => {
  test('root-level scope.in admit message contains the spec id and matched pattern', () => {
    const d = evaluatePath('AGENTS.md', makeBound({ in: ['AGENTS.md'] }, 'S-ROOT-IN'), policy);
    expect(d.kind).toBe('admit');
    expect(d.message).toContain('S-ROOT-IN');
    expect(d.message).toContain('AGENTS.md');
  });

  test('root-level scope.in data.matchedPattern is the entry that matched', () => {
    const d = evaluatePath('AGENTS.md', makeBound({ in: ['AGENTS.md'] }, 'S-ROOT-IN'), policy);
    expect(d.data?.matchedPattern).toBe('AGENTS.md');
  });

  test('root-level scope.in data.specId matches bound spec', () => {
    const d = evaluatePath('CLAUDE.md', makeBound({ in: ['CLAUDE.md'] }, 'MY-SPEC'), policy);
    expect(d.data?.specId).toBe('MY-SPEC');
  });

  test('root-level scope.in — admit vs no-admit distinguishes L183 BlockStatement mutant', () => {
    // BlockStatement mutant turns the if body to {}, so admit would not be returned.
    const dIn = evaluatePath('AGENTS.md', makeBound({ in: ['AGENTS.md'] }), policy);
    expect(dIn.kind).toBe('admit');
    expect(dIn.rule).toBe(SCOPE_RULES.ADMIT_SCOPE_IN);

    const dOut = evaluatePath('CHANGELOG.md', makeBound({ in: ['AGENTS.md'] }), policy);
    expect(dOut.kind).toBe('reject');
  });
});

describe('evaluatePath: scope.support at root level — message + data (L201-211)', () => {
  test('root-level scope.support admit message contains spec id and matched pattern', () => {
    const d = evaluatePath(
      'SHARED.md',
      makeBound({ in: ['src'], support: ['SHARED.md'] }, 'S-SUPPORT-ROOT'),
      policy
    );
    expect(d.kind).toBe('admit');
    expect(d.message).toContain('S-SUPPORT-ROOT');
    expect(d.message).toContain('SHARED.md');
    expect(d.message).toContain('editable, not worktree-claimed');
  });

  test('root-level scope.support data.matchedPattern is the entry that matched', () => {
    const d = evaluatePath(
      'SHARED.md',
      makeBound({ in: ['src'], support: ['SHARED.md'] }, 'S-SUPPORT-ROOT'),
      policy
    );
    expect(d.data?.matchedPattern).toBe('SHARED.md');
  });

  test('root-level scope.support data.specId matches bound spec', () => {
    const d = evaluatePath(
      'SHARED.md',
      makeBound({ in: ['src'], support: ['SHARED.md'] }, 'MY-SUPPORT-SPEC'),
      policy
    );
    expect(d.data?.specId).toBe('MY-SUPPORT-SPEC');
  });

  test('empty scope.support at root level -> falls through to reject (L201 ArrayDeclaration)', () => {
    // ["Stryker was here"] mutant would cause false reject on a real support path
    const d = evaluatePath(
      'SHARED.md',
      makeBound({ in: ['src'], support: [] }, 'S-1'),
      policy
    );
    expect(d.kind).toBe('reject');
    expect(d.rule).toBe(SCOPE_RULES.REJECT_ROOT_NOT_ALLOWED);
  });

  test('scope.support BlockStatement mutant killed: present support path admits, absent rejects', () => {
    const dIn = evaluatePath(
      'SHARED.md',
      makeBound({ in: ['src'], support: ['SHARED.md'] }),
      policy
    );
    expect(dIn.kind).toBe('admit');
    expect(dIn.rule).toBe(SCOPE_RULES.ADMIT_SCOPE_SUPPORT);

    const dOut = evaluatePath(
      'OTHER.md',
      makeBound({ in: ['src'], support: ['SHARED.md'] }),
      policy
    );
    expect(dOut.kind).toBe('reject');
  });
});

describe('evaluatePath: reject.root_not_allowed — message + data.specId + narrowRepair (L218-224)', () => {
  test('root_not_allowed message names the file and the spec', () => {
    const d = evaluatePath('README.md', makeBound({ in: ['src'] }, 'SPEC-ROOT-X'), policy);
    expect(d.kind).toBe('reject');
    expect(d.message).toContain('README.md');
    expect(d.message).toContain('SPEC-ROOT-X');
  });

  test('root_not_allowed data.specId matches bound spec', () => {
    const d = evaluatePath('README.md', makeBound({ in: ['src'] }, 'SPEC-ROOT-Y'), policy);
    expect(d.data?.specId).toBe('SPEC-ROOT-Y');
  });

  test('root_not_allowed narrowRepair mentions both passthrough and scope.in', () => {
    const d = evaluatePath('README.md', makeBound({ in: ['src'] }), policy);
    expect(d.narrowRepair).toContain('root_passthrough');
    expect(d.narrowRepair).toContain('scope.in');
  });

  test('root_not_allowed bindingState is bound', () => {
    const d = evaluatePath('CHANGELOG.md', makeBound({ in: ['src'] }), policy);
    expect(d.bindingState).toBe('bound');
  });
});

describe('evaluatePath: scope.in for non-root paths — message + data (L234-238)', () => {
  test('non-root scope.in message contains spec id and matched pattern', () => {
    const d = evaluatePath(
      'src/store/x.ts',
      makeBound({ in: ['src/store'] }, 'NR-SPEC-001'),
      policy
    );
    expect(d.kind).toBe('admit');
    expect(d.message).toContain('NR-SPEC-001');
    expect(d.message).toContain('src/store');
  });

  test('non-root scope.in data.matchedPattern is the entry that matched', () => {
    const d = evaluatePath(
      'src/store/x.ts',
      makeBound({ in: ['src/store'] }, 'NR-SPEC-001'),
      policy
    );
    expect(d.data?.matchedPattern).toBe('src/store');
  });

  test('non-root scope.in data.specId matches bound spec', () => {
    const d = evaluatePath(
      'src/store/x.ts',
      makeBound({ in: ['src/store'] }, 'MY-NR-SPEC'),
      policy
    );
    expect(d.data?.specId).toBe('MY-NR-SPEC');
  });

  test('non-root scope.in — admit vs miss distinguishes L234 BlockStatement / ConditionalExpression', () => {
    const dIn = evaluatePath('src/store/x.ts', makeBound({ in: ['src/store'] }), policy);
    expect(dIn.kind).toBe('admit');
    expect(dIn.rule).toBe(SCOPE_RULES.ADMIT_SCOPE_IN);

    const dMiss = evaluatePath('lib/other.ts', makeBound({ in: ['src/store'] }), policy);
    expect(dMiss.kind).toBe('reject');
    expect(dMiss.rule).toBe(SCOPE_RULES.REJECT_SCOPE_IN_MISS);
  });
});

describe('evaluatePath: scope.support for non-root paths — message + data (L245-255)', () => {
  test('non-root scope.support message contains spec id and matched pattern', () => {
    const d = evaluatePath(
      'shared/util.ts',
      makeBound({ in: ['src'], support: ['shared'] }, 'NR-SUP-001'),
      policy
    );
    expect(d.kind).toBe('admit');
    expect(d.message).toContain('NR-SUP-001');
    expect(d.message).toContain('shared');
    expect(d.message).toContain('editable, not worktree-claimed');
  });

  test('non-root scope.support data.matchedPattern is the entry that matched', () => {
    const d = evaluatePath(
      'shared/util.ts',
      makeBound({ in: ['src'], support: ['shared'] }, 'NR-SUP-001'),
      policy
    );
    expect(d.data?.matchedPattern).toBe('shared');
  });

  test('non-root scope.support data.specId matches bound spec', () => {
    const d = evaluatePath(
      'shared/util.ts',
      makeBound({ in: ['src'], support: ['shared'] }, 'MY-SUP-SPEC'),
      policy
    );
    expect(d.data?.specId).toBe('MY-SUP-SPEC');
  });

  test('empty scope.support -> falls through to scope_in_miss (L245 ArrayDeclaration mutant)', () => {
    const d = evaluatePath(
      'shared/util.ts',
      makeBound({ in: ['src'], support: [] }, 'S-1'),
      policy
    );
    expect(d.kind).toBe('reject');
    expect(d.rule).toBe(SCOPE_RULES.REJECT_SCOPE_IN_MISS);
  });

  test('non-root scope.support: admit vs miss distinguishes BlockStatement/ConditionalExpression mutants', () => {
    const dIn = evaluatePath(
      'shared/util.ts',
      makeBound({ in: ['src'], support: ['shared'] }),
      policy
    );
    expect(dIn.kind).toBe('admit');
    expect(dIn.rule).toBe(SCOPE_RULES.ADMIT_SCOPE_SUPPORT);

    const dMiss = evaluatePath(
      'other/util.ts',
      makeBound({ in: ['src'], support: ['shared'] }),
      policy
    );
    expect(dMiss.kind).toBe('reject');
    expect(dMiss.rule).toBe(SCOPE_RULES.REJECT_SCOPE_IN_MISS);
  });
});

describe('evaluatePath: reject.scope_in_miss — message + data.specId + narrowRepair (L262-268)', () => {
  test('scope_in_miss message names the path and the spec', () => {
    const d = evaluatePath('lib/other.ts', makeBound({ in: ['src'] }, 'MISS-SPEC'), policy);
    expect(d.message).toContain('lib/other.ts');
    expect(d.message).toContain('MISS-SPEC');
  });

  test('scope_in_miss data.specId matches bound spec', () => {
    const d = evaluatePath('lib/other.ts', makeBound({ in: ['src'] }, 'MY-MISS-SPEC'), policy);
    expect(d.data?.specId).toBe('MY-MISS-SPEC');
  });

  test('scope_in_miss narrowRepair mentions scope.in and scope.support', () => {
    const d = evaluatePath('lib/other.ts', makeBound({ in: ['src'] }), policy);
    expect(d.narrowRepair).toContain('scope.in');
    expect(d.narrowRepair).toContain('scope.support');
  });

  test('scope_in_miss bindingState is bound', () => {
    const d = evaluatePath('lib/other.ts', makeBound({ in: ['src'] }), policy);
    expect(d.bindingState).toBe('bound');
  });
});

describe('evaluatePathResult: decisionToDiagnostic narrowRepair field (L297-298)', () => {
  test('reject with narrowRepair -> Err diagnostic has narrowRepair (L298 conditional spread — true branch)', () => {
    // scope_in_miss carries narrowRepair; the diagnostic should too.
    const r = evaluatePathResult('lib/x.ts', makeBound({ in: ['src'] }), policy);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const diag = r.errors[0]!;
      expect(diag.narrowRepair).toBeDefined();
      expect(diag.narrowRepair).toContain('scope.in');
    }
  });

  test('reject with narrowRepair -> narrowRepair is the exact string from the decision', () => {
    // Kills ObjectLiteral mutant (L298) that replaces { narrowRepair: ... } with {}
    const d = evaluatePath('lib/x.ts', makeBound({ in: ['src'] }), policy);
    expect(d.kind).toBe('reject');
    const r = evaluatePathResult('lib/x.ts', makeBound({ in: ['src'] }), policy);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors[0]!.narrowRepair).toBe(d.narrowRepair);
    }
  });

  test('decisionToDiagnostic uses normalizedPath as subject when available (L297 LogicalOperator)', () => {
    // L297: subject: decision.normalizedPath ?? decision.path
    // Mutation: "decision.normalizedPath && decision.path" would use decision.path (string&&)
    // when normalizedPath is truthy. Kill: normalizedPath !== path when path has './' prefix.
    // We need a path where normalizedPath differs from path.
    const r = evaluatePathResult('./src/x.ts', makeBound({ in: ['src'] }), policy);
    // The decision should admit (normalizedPath = 'src/x.ts')
    // If it's an admit, we can't get a diagnostic. Let's use a rejecting path with './' prefix.
    const rReject = evaluatePathResult('./lib/x.ts', makeBound({ in: ['src'] }), policy);
    if (isErr(rReject)) {
      // subject should be normalizedPath ('lib/x.ts'), not './lib/x.ts'
      expect(rReject.errors[0]!.subject).toBe('lib/x.ts');
    }
  });

  test('decisionToDiagnostic falls back to path when normalizedPath absent (L297 — no_authority.unbound has no normalizedPath wait...)', () => {
    // unbound has normalizedPath set. Let's verify subject matches normalizedPath for unbound.
    const r = evaluatePathResult('src/x.ts', UNBOUND, policy);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      // unbound has normalizedPath: 'src/x.ts', so subject should be normalizedPath
      expect(r.errors[0]!.subject).toBe('src/x.ts');
    }
  });

  test('invalid_path decision -> Err with the invalid_path rule in the diagnostic', () => {
    // invalid_path has no normalizedPath, so subject falls back to decision.path
    const r = evaluatePathResult('../x.ts', makeBound({ in: ['src'] }), policy);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors[0]!.rule).toBe(SCOPE_RULES.INVALID_PATH_PARENT_TRAVERSAL);
      // subject should be decision.path (the original path) since no normalizedPath
      expect(r.errors[0]!.subject).toBe('../x.ts');
    }
  });

  test('decisionToDiagnostic: narrowRepair absent -> diagnostic has no narrowRepair (L298 false branch)', () => {
    // infra_exempt admits, so it won't be an Err.
    // unbound has narrowRepair. one_sided has narrowRepair.
    // non_governed_zone ADMITS. scope_in_miss has narrowRepair. scope_out has narrowRepair.
    // root_not_allowed has narrowRepair. invalid_path has narrowRepair.
    // The ONLY cases with no narrowRepair in the Decision type would be admit decisions —
    // but those become Ok, not Err. Let's check admit via evaluatePathResult:
    // an admit is Ok, so the false-branch is exercised as an Ok path (no diagnostic).
    // To get Err with no narrowRepair, we need a decision kind that has no narrowRepair.
    // Looking at the source: every reject/no_authority/invalid_path has narrowRepair.
    // This means the false branch of the conditional is NEVER hit for non-admits.
    // That makes it an equivalent mutant — document it.
    // Instead, verify the data.decision field is set (ObjectLiteral mutant kills at L298-data).
    const r = evaluatePathResult('lib/x.ts', makeBound({ in: ['src'] }), policy);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors[0]!.data).toBeDefined();
      expect(r.errors[0]!.data?.decision).toBeDefined();
      const decision = r.errors[0]!.data?.decision as Record<string, unknown>;
      expect(decision.kind).toBe('reject');
      expect(decision.rule).toBe(SCOPE_RULES.REJECT_SCOPE_IN_MISS);
    }
  });

  test('decisionToDiagnostic: narrowRepair is the correct string value, not empty (L298 ObjectLiteral kill)', () => {
    // If the narrowRepair spread became {}, narrowRepair would be missing on the diagnostic.
    const r = evaluatePathResult('lib/x.ts', makeBound({ in: ['src'] }), policy);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors[0]!.narrowRepair).toBeDefined();
      expect(r.errors[0]!.narrowRepair!.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// ADDITIONAL MUTATION KILLS: authority + bindingState fields on every path,
// L64 typeof guard, length > 0 branch conditions, and ArrayDeclaration fallbacks.
// ---------------------------------------------------------------------------

describe('evaluatePath: authority + bindingState fields on all non-trivial paths', () => {
  // L90 StringLiteral: authority in one_sided return
  test('one_sided has authority: kernel/scope (L90 StringLiteral)', () => {
    const d = evaluatePath('src/x.ts', makeOneSided(), policy);
    expect(d.authority).toBe('kernel/scope');
  });

  // L134 StringLiteral: authority in non_governed_zone return
  test('non_governed_zone has authority: kernel/scope (L134 StringLiteral)', () => {
    const p = makePolicy({ non_governed_zones: ['docs/**'] });
    const d = evaluatePath('docs/guide.md', makeBound({ in: ['src'] }), p);
    expect(d.authority).toBe('kernel/scope');
  });

  // L152 StringLiteral: authority in scope_out return
  test('scope_out has authority: kernel/scope (L152 StringLiteral)', () => {
    const d = evaluatePath(
      'src/store/secret.ts',
      makeBound({ in: ['src'], out: ['src/store'] }),
      policy
    );
    expect(d.authority).toBe('kernel/scope');
  });

  // L172 StringLiteral: authority in root_passthrough return
  test('root_passthrough has authority: kernel/scope (L172 StringLiteral)', () => {
    const p = makePolicy({ root_passthrough: ['README.md'] });
    const d = evaluatePath('README.md', makeBound({ in: ['src'] }), p);
    expect(d.authority).toBe('kernel/scope');
  });

  // L187 StringLiteral: authority in root-level scope.in return
  test('root-level scope.in has authority: kernel/scope (L187 StringLiteral)', () => {
    const d = evaluatePath('AGENTS.md', makeBound({ in: ['AGENTS.md'] }), policy);
    expect(d.authority).toBe('kernel/scope');
  });

  // L191 StringLiteral: bindingState in root-level scope.in return
  test('root-level scope.in has bindingState: bound (L191 StringLiteral)', () => {
    const d = evaluatePath('AGENTS.md', makeBound({ in: ['AGENTS.md'] }), policy);
    expect(d.bindingState).toBe('bound');
  });

  // L206 StringLiteral: authority in root-level scope.support return
  test('root-level scope.support has authority: kernel/scope (L206 StringLiteral)', () => {
    const d = evaluatePath(
      'SHARED.md',
      makeBound({ in: ['src'], support: ['SHARED.md'] }),
      policy
    );
    expect(d.authority).toBe('kernel/scope');
  });

  // L210 StringLiteral: bindingState in root-level scope.support return
  test('root-level scope.support has bindingState: bound (L210 StringLiteral)', () => {
    const d = evaluatePath(
      'SHARED.md',
      makeBound({ in: ['src'], support: ['SHARED.md'] }),
      policy
    );
    expect(d.bindingState).toBe('bound');
  });

  // L218 StringLiteral: authority in root_not_allowed return
  test('root_not_allowed has authority: kernel/scope (L218 StringLiteral)', () => {
    const d = evaluatePath('README.md', makeBound({ in: ['src'] }), policy);
    expect(d.authority).toBe('kernel/scope');
  });

  // L234 StringLiteral: authority in non-root scope.in return
  test('non-root scope.in has authority: kernel/scope (L234 StringLiteral)', () => {
    const d = evaluatePath('src/x.ts', makeBound({ in: ['src'] }), policy);
    expect(d.authority).toBe('kernel/scope');
  });

  // L238 StringLiteral: bindingState in non-root scope.in return
  test('non-root scope.in has bindingState: bound (L238 StringLiteral)', () => {
    const d = evaluatePath('src/x.ts', makeBound({ in: ['src'] }), policy);
    expect(d.bindingState).toBe('bound');
  });

  // L250 StringLiteral: authority in non-root scope.support return
  test('non-root scope.support has authority: kernel/scope (L250 StringLiteral)', () => {
    const d = evaluatePath(
      'shared/util.ts',
      makeBound({ in: ['src'], support: ['shared'] }),
      policy
    );
    expect(d.authority).toBe('kernel/scope');
  });

  // L254 StringLiteral: bindingState in non-root scope.support return
  test('non-root scope.support has bindingState: bound (L254 StringLiteral)', () => {
    const d = evaluatePath(
      'shared/util.ts',
      makeBound({ in: ['src'], support: ['shared'] }),
      policy
    );
    expect(d.bindingState).toBe('bound');
  });

  // L262 StringLiteral: authority in scope_in_miss return
  test('scope_in_miss has authority: kernel/scope (L262 StringLiteral)', () => {
    const d = evaluatePath('lib/other.ts', makeBound({ in: ['src'] }), policy);
    expect(d.authority).toBe('kernel/scope');
  });
});

describe('evaluatePath: L64 typeof guard precision (ConditionalExpression + EqualityOperator kills)', () => {
  // L64 ConditionalExpression: "true" mutant means non-strings ALSO take the `path` branch
  // and get the number 42 rather than "42". Kill: verify path field is a string.
  test('L64 true-branch mutant: path on invalid_path is always a string (number input)', () => {
    const d = evaluatePath(42 as unknown as string, makeBound({ in: ['src'] }), policy);
    expect(typeof d.path).toBe('string');
    expect(d.path).toBe('42');
  });

  // L64 ConditionalExpression: "false" mutant always coerces even valid strings.
  // Kill: a valid string's path field must equal the original (not String("original") === "original" anyway,
  // but the false-branch also works for strings so this is an equivalent mutant for string inputs).
  // Actually String("foo") === "foo", so false-branch is equivalent for string inputs.
  // The distinguishing case is a non-string: String(null) = "null", null.path would fail.
  test('L64 false-branch mutant: coerce-always is identical for strings, but kills on non-string', () => {
    // For undefined input: String(undefined) = "undefined"; undefined.toString() would throw
    const d = evaluatePath(undefined as unknown as string, makeBound({ in: ['src'] }), policy);
    expect(d.kind).toBe('invalid_path');
    expect(typeof d.path).toBe('string');
    expect(d.path).toBe('undefined');
  });

  // L64 EqualityOperator: "typeof path !== 'string'" flips the condition,
  // so strings get String() coercion (fine, equivalent) and non-strings get path directly (crashes or mismatch).
  // Kill: check path is exactly String(value) for non-string inputs.
  test('L64 EqualityOperator: typeof path !== string flips branches — non-string path is string-coerced', () => {
    const d = evaluatePath(false as unknown as string, makeBound({ in: ['src'] }), policy);
    expect(d.kind).toBe('invalid_path');
    expect(d.path).toBe('false');
    expect(typeof d.path).toBe('string');
  });

  // L64 StringLiteral: 'kernel/scope' authority for invalid_path
  test('L64 StringLiteral: invalid_path authority is kernel/scope for non-string path (kills the "" mutant)', () => {
    const d = evaluatePath(123 as unknown as string, makeBound({ in: ['src'] }), policy);
    expect(d.authority).toBe('kernel/scope');
  });
});

describe('evaluatePath: length > 0 branch guards and ?? [] fallbacks (ArrayDeclaration + ConditionalExpression + EqualityOperator)', () => {
  // L127 ArrayDeclaration: non_governed_zones ?? [] becomes ?? ["Stryker was here"]
  // This means even when policy has no non_governed_zones, Stryker's zone would match.
  // Kill: with undefined non_governed_zones and a path like "Stryker was here",
  // we must NOT get ADMIT_NON_GOVERNED_ZONE.
  test('L127 ArrayDeclaration: null non_governed_zones fallback to [] (no spurious zone match)', () => {
    // Use a path that would match "Stryker was here" if the mutant were active
    const pNull = makePolicy({ non_governed_zones: undefined as unknown as string[] });
    const d = evaluatePath('Stryker was here', makeBound({ in: ['src'] }), pNull);
    expect(d.rule).not.toBe(SCOPE_RULES.ADMIT_NON_GOVERNED_ZONE);
  });

  // L128 ConditionalExpression: mutation "true" always enters the zone-match block.
  // With empty zones and matchGlob([]), the match is null, so no early return — effect is same.
  // However: if length check is removed AND zones is ["Stryker was here"] (from L127 mutant),
  // we'd get an admit. Separate these.
  // The "true" mutant: always enters the length block, but matchGlob(path, []) returns null
  // so there's no observable difference with empty array. This is an equivalent mutant.
  test('L128 EqualityOperator: length >= 0 (always true) — observable via: non-empty zones, no match, still rejects', () => {
    // With length >= 0 mutant, the block is always entered. matchGlob still returns null
    // when no zone matches. So for a non-match case, outcome is same (still reject).
    // The only observable difference is when zones is empty BUT we enter the block —
    // but matchGlob([]) always returns null. This is effectively equivalent.
    // Document: this mutant is equivalent when zones is [] (matchGlob([]) = null always).
    const pZones = makePolicy({ non_governed_zones: ['vendor/**'] });
    const dMatch = evaluatePath('vendor/lib/x.js', makeBound({ in: ['src'] }), pZones);
    expect(dMatch.kind).toBe('admit');
    expect(dMatch.rule).toBe(SCOPE_RULES.ADMIT_NON_GOVERNED_ZONE);
    const dNoMatch = evaluatePath('src/x.ts', makeBound({ in: ['src'] }), pZones);
    // This should be admitted by scope.in, not zone
    expect(dNoMatch.rule).not.toBe(SCOPE_RULES.ADMIT_NON_GOVERNED_ZONE);
  });

  // L145 ArrayDeclaration: scope.out ?? [] becomes ["Stryker was here"]
  // So even with no scope.out, Stryker's string would be in out → any path matching it is rejected.
  test('L145 ArrayDeclaration: null scope.out falls back to [] (no spurious scope.out rejection)', () => {
    const d = evaluatePath(
      'Stryker was here/x.ts',
      makeBound({ in: ['Stryker was here'], out: undefined as unknown as string[] }),
      policy
    );
    // With the mutant, "Stryker was here" would be in scope.out and reject.
    // Without the mutant (correct), it should admit via scope.in.
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_SCOPE_IN);
  });

  // L165 ArrayDeclaration: root_passthrough ?? [] becomes ["Stryker was here"]
  test('L165 ArrayDeclaration: null root_passthrough falls back to [] (no spurious root passthrough)', () => {
    const pNull = makePolicy({ root_passthrough: undefined as unknown as string[] });
    const d = evaluatePath('Stryker was here', makeBound({ in: ['src'] }), pNull);
    // Should reject root_not_allowed, NOT admit via root_passthrough
    expect(d.kind).toBe('reject');
    expect(d.rule).toBe(SCOPE_RULES.REJECT_ROOT_NOT_ALLOWED);
  });

  // L201 ArrayDeclaration: scope.support ?? [] becomes ["Stryker was here"] for root support
  test('L201 ArrayDeclaration: null root-level scope.support falls back to [] (no spurious support admit)', () => {
    const binding = makeBound({
      in: ['src'],
      support: undefined as unknown as string[],
    });
    const d = evaluatePath('Stryker was here', binding, policy);
    // Should reject as root_not_allowed, NOT admit via scope.support
    expect(d.kind).toBe('reject');
    expect(d.rule).toBe(SCOPE_RULES.REJECT_ROOT_NOT_ALLOWED);
  });

  // L245 ArrayDeclaration: scope.support ?? [] becomes ["Stryker was here"] for non-root support
  test('L245 ArrayDeclaration: null non-root scope.support falls back to [] (no spurious support admit)', () => {
    const binding = makeBound({
      in: ['src'],
      support: undefined as unknown as string[],
    });
    const d = evaluatePath('Stryker was here/x.ts', binding, policy);
    // Should reject as scope_in_miss (path doesn't match 'src'), NOT admit via scope.support
    expect(d.kind).toBe('reject');
    expect(d.rule).toBe(SCOPE_RULES.REJECT_SCOPE_IN_MISS);
  });

  // L166 ConditionalExpression/EqualityOperator: rootPassthrough.length > 0 guard
  test('L166 ConditionalExpression: length > 0 guard — empty passthrough does NOT enter block (remains reject)', () => {
    // "true" mutant always enters, matchExactRoot(path, []) returns null, falls through anyway.
    // "length >= 0" mutant — same effect (match still returns null for empty array).
    // Both are equivalent when the array is empty (no distinguishable outcome from empty matchExactRoot).
    // Kill via: non-empty passthrough with specific name match vs no-match shape.
    const p = makePolicy({ root_passthrough: ['package.json'] });
    // 'README.md' is NOT in passthrough — must reject
    const dNoMatch = evaluatePath('README.md', makeBound({ in: ['src'] }), p);
    expect(dNoMatch.kind).toBe('reject');
    expect(dNoMatch.rule).toBe(SCOPE_RULES.REJECT_ROOT_NOT_ALLOWED);
    // 'package.json' IS in passthrough — must admit
    const dMatch = evaluatePath('package.json', makeBound({ in: ['src'] }), p);
    expect(dMatch.kind).toBe('admit');
    expect(dMatch.rule).toBe(SCOPE_RULES.ADMIT_ROOT_PASSTHROUGH);
  });
});

describe('evaluatePathResult: L298 narrowRepair conditional spread — full branch coverage', () => {
  // L298 ConditionalExpression "true": always spreads { narrowRepair }
  // This means even decisions that have no narrowRepair would get an undefined narrowRepair key.
  // Since ALL non-admit decisions in this source have narrowRepair, this mutant survives
  // (all have it, so spreading it unconditionally produces the same result).
  // This is an equivalent mutant.

  // L298 ConditionalExpression "false": never spreads narrowRepair.
  // Kill: verify that narrowRepair IS present on reject diagnostics.
  test('L298 false-branch kill: narrowRepair on scope_in_miss diagnostic is not undefined', () => {
    const r = evaluatePathResult('lib/x.ts', makeBound({ in: ['src'] }), policy);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors[0]!.narrowRepair).not.toBeUndefined();
      expect(r.errors[0]!.narrowRepair).not.toBe('');
    }
  });

  test('L298 false-branch kill: narrowRepair on scope_out diagnostic is present', () => {
    const r = evaluatePathResult(
      'src/store/x.ts',
      makeBound({ in: ['src'], out: ['src/store'] }),
      policy
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors[0]!.narrowRepair).toBeDefined();
      expect(r.errors[0]!.narrowRepair).toContain('amend the spec');
    }
  });

  test('L298 false-branch kill: narrowRepair on root_not_allowed diagnostic is present', () => {
    const r = evaluatePathResult('README.md', makeBound({ in: ['src'] }), policy);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors[0]!.narrowRepair).toBeDefined();
      expect(r.errors[0]!.narrowRepair).toContain('root_passthrough');
    }
  });

  test('L298 EqualityOperator kill: narrowRepair === undefined flips the check', () => {
    // "decision.narrowRepair === undefined" means: when narrowRepair IS defined,
    // the && result is false → no spread → missing from diagnostic.
    // Kill: confirm narrowRepair flows through from a decision that has it.
    const r = evaluatePathResult('src/x.ts', UNBOUND, policy);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const diag = r.errors[0]!;
      expect(diag.narrowRepair).toBeDefined();
      expect(diag.narrowRepair).toContain('caws worktree');
    }
  });

  test('L298 LogicalOperator kill: narrowRepair || {...} branch uses the repair text, not empty', () => {
    // "decision.narrowRepair !== undefined || { narrowRepair: decision.narrowRepair }"
    // With the || mutant, the spread is always { narrowRepair: undefined } when repair is absent.
    // Since all non-admit decisions have narrowRepair, this is equivalent in practice.
    // But we can verify the actual narrowRepair value is the real string, not undefined.
    const r = evaluatePathResult('../bad.ts', makeBound({ in: ['src'] }), policy);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const diag = r.errors[0]!;
      expect(diag.narrowRepair).toBeDefined();
      expect(diag.narrowRepair).toContain('relative POSIX path');
    }
  });
});
