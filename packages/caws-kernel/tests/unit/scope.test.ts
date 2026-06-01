import {
  evaluatePath,
  evaluatePathResult,
  SCOPE_RULES,
  SCOPE_RULE_PREFIXES,
} from '../../src/scope';
import type { BindingState, Decision } from '../../src/scope';
import type { Policy } from '../../src/policy/types';
import type { Spec } from '../../src/spec/types';

// ---------- Helpers ----------

function makeSpec(overrides: Partial<Spec> = {}): Spec {
  return {
    id: 'TEST-1',
    title: 'Test spec',
    risk_tier: 3,
    mode: 'feature',
    lifecycle_state: 'active',
    blast_radius: { modules: ['src/test'] },
    scope: { in: ['src/**'] },
    invariants: ['none'],
    acceptance: [{ id: 'A1', given: 'g', when: 'w', then: 't' }],
    non_functional: {},
    contracts: [],
    ...overrides,
  };
}

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    version: 1,
    risk_tiers: {
      '1': { max_files: 5, max_loc: 200 },
      '2': { max_files: 15, max_loc: 600 },
      '3': { max_files: 30, max_loc: 1500 },
    },
    gates: {
      budget_limit: { enabled: true, mode: 'block' },
      spec_completeness: { enabled: true, mode: 'block' },
      scope_boundary: { enabled: true, mode: 'block' },
    },
    ...overrides,
  };
}

function bound(spec: Spec, worktreeName = 'wt-1'): BindingState {
  return { kind: 'bound', spec, worktreeName };
}

const UNBOUND: BindingState = { kind: 'unbound' };

type OneSidedDetail = Extract<BindingState, { kind: 'one_sided' }>['detail'];

function oneSided(detail: OneSidedDetail): BindingState {
  return { kind: 'one_sided', detail };
}

const NUL = String.fromCharCode(0);

// ---------- Lexical normalization / invalid_path ----------

describe('evaluatePath – invalid path', () => {
  const spec = makeSpec();
  const policy = makePolicy();

  it('rejects empty string with invalid_path.empty', () => {
    const d = evaluatePath('', bound(spec), policy);
    expect(d.kind).toBe('invalid_path');
    expect(d.rule).toBe(SCOPE_RULES.INVALID_PATH_EMPTY);
    expect(d.authority).toBe('kernel/scope');
  });

  it('rejects non-string with invalid_path.not_string', () => {
    const d = evaluatePath(42 as unknown as string, bound(spec), policy);
    expect(d.kind).toBe('invalid_path');
    expect(d.rule).toBe(SCOPE_RULES.INVALID_PATH_NOT_STRING);
    expect(d.path).toBe('42');
  });

  it('rejects absolute path with invalid_path.absolute', () => {
    const d = evaluatePath('/etc/passwd', bound(spec), policy);
    expect(d.kind).toBe('invalid_path');
    expect(d.rule).toBe(SCOPE_RULES.INVALID_PATH_ABSOLUTE);
  });

  it('rejects parent traversal with invalid_path.parent_traversal', () => {
    const d = evaluatePath('src/../etc/passwd', bound(spec), policy);
    expect(d.kind).toBe('invalid_path');
    expect(d.rule).toBe(SCOPE_RULES.INVALID_PATH_PARENT_TRAVERSAL);
  });

  it('rejects backslash with invalid_path.backslash', () => {
    const d = evaluatePath('src\\foo.ts', bound(spec), policy);
    expect(d.kind).toBe('invalid_path');
    expect(d.rule).toBe(SCOPE_RULES.INVALID_PATH_BACKSLASH);
  });

  it('rejects NUL byte with invalid_path.nul', () => {
    const pathWithNul = 'src/foo' + NUL + '.ts';
    const d = evaluatePath(pathWithNul, bound(spec), policy);
    expect(d.kind).toBe('invalid_path');
    expect(d.rule).toBe(SCOPE_RULES.INVALID_PATH_NUL);
  });

  it('rejects "./" alone (empty after strip)', () => {
    const d = evaluatePath('./', bound(spec), policy);
    expect(d.kind).toBe('invalid_path');
    expect(d.rule).toBe(SCOPE_RULES.INVALID_PATH_EMPTY);
  });

  it('strips leading "./" and proceeds', () => {
    const d = evaluatePath('./src/foo.ts', bound(spec), policy);
    expect(d.kind).toBe('admit');
    expect(d.normalizedPath).toBe('src/foo.ts');
  });

  it('collapses duplicate slashes', () => {
    const d = evaluatePath('src//nested///foo.ts', bound(spec), policy);
    expect(d.kind).toBe('admit');
    expect(d.normalizedPath).toBe('src/nested/foo.ts');
  });

  it('does NOT call any decision before normalization fails', () => {
    // Even unbound: invalid_path must precede no_authority so the diagnostic
    // names the caller-side error.
    const d = evaluatePath('/etc/passwd', UNBOUND, makePolicy());
    expect(d.kind).toBe('invalid_path');
  });
});

// ---------- Binding authority ----------

describe('evaluatePath – binding authority', () => {
  const policy = makePolicy();

  it('returns no_authority.unbound when binding is unbound', () => {
    const d = evaluatePath('src/foo.ts', UNBOUND, policy);
    expect(d.kind).toBe('no_authority');
    expect(d.rule).toBe(SCOPE_RULES.NO_AUTHORITY_UNBOUND);
    expect(d.bindingState).toBe('unbound');
    expect(d.narrowRepair).toMatch(/caws worktree bind/);
  });

  it('returns no_authority.binding_one_sided when binding is one_sided (registry-only)', () => {
    const binding = oneSided({
      specHasWorktree: false,
      registryHasSpecId: true,
      registrySpecId: 'TEST-1',
      worktreeName: 'wt-1',
    });
    const d = evaluatePath('src/foo.ts', binding, policy);
    expect(d.kind).toBe('no_authority');
    expect(d.rule).toBe(SCOPE_RULES.NO_AUTHORITY_BINDING_ONE_SIDED);
    expect(d.bindingState).toBe('one_sided');
    expect(d.data?.['specHasWorktree']).toBe(false);
    expect(d.data?.['registryHasSpecId']).toBe(true);
  });

  it('returns no_authority.binding_one_sided when binding is one_sided (spec-only)', () => {
    const binding = oneSided({
      specHasWorktree: true,
      registryHasSpecId: false,
      specWorktree: 'wt-1',
    });
    const d = evaluatePath('src/foo.ts', binding, policy);
    expect(d.kind).toBe('no_authority');
    expect(d.rule).toBe(SCOPE_RULES.NO_AUTHORITY_BINDING_ONE_SIDED);
    expect(d.data?.['specHasWorktree']).toBe(true);
    expect(d.data?.['registryHasSpecId']).toBe(false);
  });

  it('does NOT silently admit infra paths when unbound', () => {
    const d = evaluatePath('.caws/specs/foo.yaml', UNBOUND, policy);
    expect(d.kind).toBe('no_authority');
    expect(d.rule).toBe(SCOPE_RULES.NO_AUTHORITY_UNBOUND);
  });
});

// ---------- Admit rules ----------

describe('evaluatePath – admit rules', () => {
  const policy = makePolicy();
  const spec = makeSpec();

  it('admits via infra_exempt for .caws/', () => {
    const d = evaluatePath('.caws/specs/foo.yaml', bound(spec), policy);
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_INFRA_EXEMPT);
    expect(d.data?.['matchedPrefix']).toBe('.caws');
  });

  it('admits via infra_exempt for .claude/', () => {
    const d = evaluatePath('.claude/hooks/foo.sh', bound(spec), policy);
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_INFRA_EXEMPT);
    expect(d.data?.['matchedPrefix']).toBe('.claude');
  });

  it('admits .caws as exact path (no descendant required)', () => {
    const d = evaluatePath('.caws', bound(spec), policy);
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_INFRA_EXEMPT);
  });

  it('does NOT admit .caws-old/ (boundary safety)', () => {
    const d = evaluatePath('.caws-old/foo.yaml', bound(spec), policy);
    expect(d.kind).toBe('reject');
    expect(d.rule).toBe(SCOPE_RULES.REJECT_SCOPE_IN_MISS);
  });

  it('admits via non_governed_zone (glob pattern)', () => {
    const p = makePolicy({ non_governed_zones: ['docs/**'] });
    const d = evaluatePath('docs/foo.md', bound(spec), p);
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_NON_GOVERNED_ZONE);
    expect(d.data?.['matchedPattern']).toBe('docs/**');
  });

  it('admits via non_governed_zone (plain prefix entry)', () => {
    const p = makePolicy({ non_governed_zones: ['vendor'] });
    const d = evaluatePath('vendor/lib/x.js', bound(spec), p);
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_NON_GOVERNED_ZONE);
  });

  it('admits via root_passthrough (exact match)', () => {
    const p = makePolicy({ root_passthrough: ['package.json', 'README.md'] });
    const d = evaluatePath('package.json', bound(spec), p);
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_ROOT_PASSTHROUGH);
    expect(d.data?.['matchedName']).toBe('package.json');
  });

  it('does NOT admit nested file via root_passthrough', () => {
    const p = makePolicy({ root_passthrough: ['package.json'] });
    const d = evaluatePath('vendor/package.json', bound(spec), p);
    expect(d.kind).toBe('reject');
    expect(d.rule).toBe(SCOPE_RULES.REJECT_SCOPE_IN_MISS);
  });

  it('does NOT admit similar root file via root_passthrough (exact only)', () => {
    const p = makePolicy({ root_passthrough: ['package.json'] });
    const d = evaluatePath('package.json.bak', bound(spec), p);
    expect(d.kind).toBe('reject');
    expect(d.rule).toBe(SCOPE_RULES.REJECT_ROOT_NOT_ALLOWED);
  });

  it('admits via scope_in (glob)', () => {
    const d = evaluatePath('src/foo.ts', bound(makeSpec({ scope: { in: ['src/**'] } })), policy);
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_SCOPE_IN);
    expect(d.data?.['matchedPattern']).toBe('src/**');
  });

  it('admits via scope_in (plain prefix)', () => {
    const d = evaluatePath('src/nested/foo.ts', bound(makeSpec({ scope: { in: ['src'] } })), policy);
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_SCOPE_IN);
  });

  it('admits dotfile under scope.in glob with dot:true semantics', () => {
    const d = evaluatePath(
      'src/.hidden.ts',
      bound(makeSpec({ scope: { in: ['src/*'] } })),
      policy,
    );
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_SCOPE_IN);
  });

  it('admits root file when explicitly listed in scope.in', () => {
    const d = evaluatePath(
      'package.json',
      bound(makeSpec({ scope: { in: ['package.json', 'src/**'] } })),
      makePolicy({ root_passthrough: [] }),
    );
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_SCOPE_IN);
  });
});

// ---------- scope.support (WORKTREE-SUPPORT-SCOPE-001) ----------

describe('evaluatePath – scope.support', () => {
  const policy = makePolicy({ root_passthrough: [] });

  it('admits a non-root path in scope.support (not scope.in) via ADMIT_SCOPE_SUPPORT', () => {
    const d = evaluatePath(
      'docs/notes.md',
      bound(makeSpec({ scope: { in: ['src/**'], support: ['docs/**'] } })),
      policy,
    );
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_SCOPE_SUPPORT);
    expect(d.data?.['matchedPattern']).toBe('docs/**');
  });

  it('admits a ROOT-level deliverable listed only in scope.support', () => {
    // The compose-trap case: a repo-root file the slice must write but should
    // NOT make worktree-claimed. scope.support admits it; scope.in does not.
    const d = evaluatePath(
      'FRICTION-LOG.md',
      bound(makeSpec({ scope: { in: ['src/**'], support: ['FRICTION-LOG.md'] } })),
      policy,
    );
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_SCOPE_SUPPORT);
  });

  it('prefers scope.in over scope.support when a path is in both (reports scope_in)', () => {
    const d = evaluatePath(
      'src/foo.ts',
      bound(makeSpec({ scope: { in: ['src/**'], support: ['src/**'] } })),
      policy,
    );
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_SCOPE_IN);
  });

  it('scope.out still shadows a scope.support path (out is the upstream gate)', () => {
    const d = evaluatePath(
      'docs/secret/notes.md',
      bound(
        makeSpec({
          scope: { in: ['src/**'], support: ['docs/**'], out: ['docs/secret'] },
        }),
      ),
      policy,
    );
    expect(d.kind).toBe('reject');
    expect(d.rule).toBe(SCOPE_RULES.REJECT_SCOPE_OUT);
  });

  it('a path in neither scope.in nor scope.support is rejected (scope_in_miss)', () => {
    const d = evaluatePath(
      'lib/other.ts',
      bound(makeSpec({ scope: { in: ['src/**'], support: ['docs/**'] } })),
      policy,
    );
    expect(d.kind).toBe('reject');
    expect(d.rule).toBe(SCOPE_RULES.REJECT_SCOPE_IN_MISS);
  });

  it('absent scope.support is unchanged behavior (root miss still REJECT_ROOT_NOT_ALLOWED)', () => {
    const d = evaluatePath(
      'UNLISTED.md',
      bound(makeSpec({ scope: { in: ['src/**'] } })),
      policy,
    );
    expect(d.kind).toBe('reject');
    expect(d.rule).toBe(SCOPE_RULES.REJECT_ROOT_NOT_ALLOWED);
  });
});

// ---------- Reject rules ----------

describe('evaluatePath – reject rules', () => {
  const policy = makePolicy();

  it('rejects via scope.out (exact-or-descendant)', () => {
    const spec = makeSpec({ scope: { in: ['src/**'], out: ['src/generated'] } });
    const d = evaluatePath('src/generated/foo.ts', bound(spec), policy);
    expect(d.kind).toBe('reject');
    expect(d.rule).toBe(SCOPE_RULES.REJECT_SCOPE_OUT);
    expect(d.data?.['matchedPrefix']).toBe('src/generated');
  });

  it('rejects scope.out exact match (the directory itself)', () => {
    const spec = makeSpec({ scope: { in: ['src/**'], out: ['src/generated'] } });
    const d = evaluatePath('src/generated', bound(spec), policy);
    expect(d.kind).toBe('reject');
    expect(d.rule).toBe(SCOPE_RULES.REJECT_SCOPE_OUT);
  });

  it('does NOT reject scope.out lookalike (boundary safety)', () => {
    // 'src/generatedness/foo.ts' should NOT be rejected by 'src/generated'.
    const spec = makeSpec({ scope: { in: ['src/**'], out: ['src/generated'] } });
    const d = evaluatePath('src/generatedness/foo.ts', bound(spec), policy);
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_SCOPE_IN);
  });

  it('rejects via scope_in_miss for non-root path outside scope.in', () => {
    const spec = makeSpec({ scope: { in: ['src/**'] } });
    const d = evaluatePath('docs/foo.md', bound(spec), policy);
    expect(d.kind).toBe('reject');
    expect(d.rule).toBe(SCOPE_RULES.REJECT_SCOPE_IN_MISS);
  });

  it('rejects via root_not_allowed when root file is not in passthrough or scope.in', () => {
    const spec = makeSpec({ scope: { in: ['src/**'] } });
    const d = evaluatePath('CHANGELOG.md', bound(spec), makePolicy({ root_passthrough: [] }));
    expect(d.kind).toBe('reject');
    expect(d.rule).toBe(SCOPE_RULES.REJECT_ROOT_NOT_ALLOWED);
    expect(d.narrowRepair).toMatch(/root_passthrough/);
  });

  it('does NOT admit srcx/foo via "src/**" pattern (boundary)', () => {
    const spec = makeSpec({ scope: { in: ['src/**'] } });
    const d = evaluatePath('srcx/foo.ts', bound(spec), policy);
    expect(d.kind).toBe('reject');
    expect(d.rule).toBe(SCOPE_RULES.REJECT_SCOPE_IN_MISS);
  });
});

// ---------- Evaluation order ----------

describe('evaluatePath – evaluation order', () => {
  it('infra exemption wins over scope.out', () => {
    const spec = makeSpec({ scope: { in: ['src/**'], out: ['.caws'] } });
    const d = evaluatePath('.caws/specs/foo.yaml', bound(spec), makePolicy());
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_INFRA_EXEMPT);
  });

  it('infra exemption wins over non_governed_zones', () => {
    // Both would admit, but the infra rule must fire first so doctor and
    // diagnostics report the kernel-owned exemption rather than a policy match.
    const spec = makeSpec({ scope: { in: ['src/**'] } });
    const policy = makePolicy({ non_governed_zones: ['.caws/**'] });
    const d = evaluatePath('.caws/specs/foo.yaml', bound(spec), policy);
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_INFRA_EXEMPT);
  });

  it('non_governed_zones wins over scope.out', () => {
    const spec = makeSpec({ scope: { in: ['src/**'], out: ['vendor'] } });
    const policy = makePolicy({ non_governed_zones: ['vendor/**'] });
    const d = evaluatePath('vendor/lib/x.js', bound(spec), policy);
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_NON_GOVERNED_ZONE);
  });

  it('scope.out wins over scope.in', () => {
    const spec = makeSpec({ scope: { in: ['src/**'], out: ['src/generated'] } });
    const d = evaluatePath('src/generated/foo.ts', bound(spec), makePolicy());
    expect(d.kind).toBe('reject');
    expect(d.rule).toBe(SCOPE_RULES.REJECT_SCOPE_OUT);
  });

  it('root_passthrough takes precedence over scope.in for root files', () => {
    const spec = makeSpec({ scope: { in: ['package.json', 'src/**'] } });
    const policy = makePolicy({ root_passthrough: ['package.json'] });
    const d = evaluatePath('package.json', bound(spec), policy);
    expect(d.kind).toBe('admit');
    expect(d.rule).toBe(SCOPE_RULES.ADMIT_ROOT_PASSTHROUGH);
  });
});

// ---------- evaluatePathResult adapter ----------

describe('evaluatePathResult – Result adapter', () => {
  const policy = makePolicy();

  it('maps admit to Ok with the AdmitDecision payload', () => {
    const r = evaluatePathResult('src/foo.ts', bound(makeSpec()), policy);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('admit');
      expect(r.value.rule).toBe(SCOPE_RULES.ADMIT_SCOPE_IN);
    }
  });

  it('maps reject to Err with full Decision in data', () => {
    const r = evaluatePathResult('docs/foo.md', bound(makeSpec()), policy);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const d = r.errors[0];
      expect(d?.rule).toBe(SCOPE_RULES.REJECT_SCOPE_IN_MISS);
      expect(d?.authority).toBe('kernel/scope');
      const inner = d?.data?.['decision'] as Decision | undefined;
      expect(inner?.kind).toBe('reject');
    }
  });

  it('maps no_authority to Err', () => {
    const r = evaluatePathResult('src/foo.ts', UNBOUND, policy);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]?.rule).toBe(SCOPE_RULES.NO_AUTHORITY_UNBOUND);
    }
  });

  it('maps invalid_path to Err', () => {
    const r = evaluatePathResult('/etc/passwd', UNBOUND, policy);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]?.rule).toBe(SCOPE_RULES.INVALID_PATH_ABSOLUTE);
    }
  });
});

// ---------- Namespace contract ----------

describe('SCOPE_RULES namespace contract', () => {
  it('every rule string starts with one of the four namespace prefixes', () => {
    const allRules = Object.values(SCOPE_RULES);
    for (const rule of allRules) {
      const matched = SCOPE_RULE_PREFIXES.some((p) => rule.startsWith(p));
      expect(matched).toBe(true);
    }
  });

  it('admit rules begin with scope.admit.', () => {
    const admitRules = [
      SCOPE_RULES.ADMIT_INFRA_EXEMPT,
      SCOPE_RULES.ADMIT_NON_GOVERNED_ZONE,
      SCOPE_RULES.ADMIT_ROOT_PASSTHROUGH,
      SCOPE_RULES.ADMIT_SCOPE_IN,
      SCOPE_RULES.ADMIT_SCOPE_SUPPORT,
    ];
    for (const r of admitRules) expect(r.startsWith('scope.admit.')).toBe(true);
  });

  it('reject rules begin with scope.reject.', () => {
    const rejectRules = [
      SCOPE_RULES.REJECT_SCOPE_OUT,
      SCOPE_RULES.REJECT_SCOPE_IN_MISS,
      SCOPE_RULES.REJECT_ROOT_NOT_ALLOWED,
    ];
    for (const r of rejectRules) expect(r.startsWith('scope.reject.')).toBe(true);
  });

  it('no_authority rules begin with scope.no_authority.', () => {
    expect(SCOPE_RULES.NO_AUTHORITY_UNBOUND.startsWith('scope.no_authority.')).toBe(true);
    expect(SCOPE_RULES.NO_AUTHORITY_BINDING_ONE_SIDED.startsWith('scope.no_authority.')).toBe(true);
  });

  it('invalid_path rules begin with scope.invalid_path.', () => {
    const invalidRules = [
      SCOPE_RULES.INVALID_PATH_EMPTY,
      SCOPE_RULES.INVALID_PATH_ABSOLUTE,
      SCOPE_RULES.INVALID_PATH_PARENT_TRAVERSAL,
      SCOPE_RULES.INVALID_PATH_BACKSLASH,
      SCOPE_RULES.INVALID_PATH_NUL,
      SCOPE_RULES.INVALID_PATH_NOT_STRING,
    ];
    for (const r of invalidRules) expect(r.startsWith('scope.invalid_path.')).toBe(true);
  });
});

// ---------- Authority + bindingState invariants ----------

describe('Decision invariants', () => {
  const policy = makePolicy();
  const spec = makeSpec();

  function decisions(): Decision[] {
    return [
      evaluatePath('src/foo.ts', bound(spec), policy),
      evaluatePath('docs/foo.md', bound(spec), policy),
      evaluatePath('src/foo.ts', UNBOUND, policy),
      evaluatePath('/etc/passwd', UNBOUND, policy),
      evaluatePath(
        'src/foo.ts',
        oneSided({ specHasWorktree: true, registryHasSpecId: false }),
        policy,
      ),
    ];
  }

  it('every Decision has authority "kernel/scope"', () => {
    for (const d of decisions()) expect(d.authority).toBe('kernel/scope');
  });

  it('every Decision preserves the original path', () => {
    const inputs = ['src/foo.ts', 'docs/foo.md', 'src/foo.ts', '/etc/passwd', 'src/foo.ts'];
    decisions().forEach((d, i) => expect(d.path).toBe(inputs[i]));
  });

  it('every Decision carries a bindingState matching the input binding', () => {
    const expected: Array<BindingState['kind']> = ['bound', 'bound', 'unbound', 'unbound', 'one_sided'];
    decisions().forEach((d, i) => expect(d.bindingState).toBe(expected[i]));
  });
});
