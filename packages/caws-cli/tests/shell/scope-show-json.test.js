'use strict';

/**
 * Contract tests for `caws scope show --json` (CAWS-SCOPE-SHOW-JSON-CONTRACT-001).
 *
 * The JSON object emitted by `caws scope show --json` is the stable hook-facing
 * interface that scope-guard.sh parses with jq instead of re-parsing spec YAML.
 * These tests pin the contract at the pure-function layer (buildScopeDecisionJson
 * / renderDecisionJson), driven by synthetic kernel Decision + shell
 * ResolvedBinding inputs — no real repo, deterministic.
 *
 * They assert SEMANTICS (exact field values), not just shape: the field-mapping
 * from (Decision, ResolvedBinding) to the contract is the thing a renderer
 * regression would break, so each field is checked against a known input.
 *
 * SUT loaded from dist/.
 */

const {
  buildScopeDecisionJson,
  renderDecisionJson,
  renderDecision,
} = require('../../dist/shell/render/decision');

// --- synthetic kernel Decision builders (mirror the kernel Decision shape) ---

function admitDecision(overrides = {}) {
  return {
    kind: 'admit',
    rule: 'scope.admit.scope_in',
    authority: 'kernel/scope',
    path: 'packages/foo/bar.ts',
    bindingState: 'bound',
    message: 'admitted',
    data: { matchedPattern: 'packages/foo/bar.ts', specId: 'FOO-001' },
    ...overrides,
  };
}

function rejectDecision(overrides = {}) {
  return {
    kind: 'reject',
    rule: 'scope.reject.scope_out',
    authority: 'kernel/scope',
    path: 'packages/other/x.ts',
    bindingState: 'bound',
    message: 'rejected',
    narrowRepair: 'add to scope.in',
    data: { matchedPrefix: 'packages/other', specId: 'FOO-001' },
    ...overrides,
  };
}

// --- synthetic shell ResolvedBinding builders ---

function boundContext(overrides = {}) {
  return {
    binding: {
      kind: 'bound',
      spec: { id: 'FOO-001' },
      worktreeName: 'foo-wt',
    },
    worktreeName: 'foo-wt',
    source: 'registry_path_match',
    ...overrides,
  };
}

function unboundContext(overrides = {}) {
  return {
    binding: { kind: 'unbound' },
    source: 'none',
    ...overrides,
  };
}

describe('buildScopeDecisionJson: admit under a bound worktree (authoritative)', () => {
  const json = buildScopeDecisionJson(admitDecision(), boundContext());

  test('decision is the kernel admit kind', () => {
    expect(json.decision).toBe('admit');
  });
  test('rule is the stable kernel rule id', () => {
    expect(json.rule).toBe('scope.admit.scope_in');
  });
  test('mode is authoritative when bindingState is bound', () => {
    expect(json.mode).toBe('authoritative');
  });
  test('boundSpecId comes from decision.data.specId', () => {
    expect(json.boundSpecId).toBe('FOO-001');
  });
  test('worktreeName comes from the resolved binding', () => {
    expect(json.worktreeName).toBe('foo-wt');
  });
  test('source is carried through', () => {
    expect(json.source).toBe('registry_path_match');
  });
  test('matchedPattern is normalized from data.matchedPattern', () => {
    expect(json.matchedPattern).toBe('packages/foo/bar.ts');
  });
  test('no repair field on a clean admit (decision had no narrowRepair)', () => {
    expect(json.repair).toBeUndefined();
  });
});

describe('buildScopeDecisionJson: reject under a bound worktree', () => {
  const json = buildScopeDecisionJson(rejectDecision(), boundContext());

  test('decision is reject', () => {
    expect(json.decision).toBe('reject');
  });
  test('mode stays authoritative (a bound reject is still authoritative)', () => {
    expect(json.mode).toBe('authoritative');
  });
  test('matchedPattern is normalized from data.matchedPrefix', () => {
    expect(json.matchedPattern).toBe('packages/other');
  });
  test('repair is carried from decision.narrowRepair', () => {
    expect(json.repair).toBe('add to scope.in');
  });
});

describe('buildScopeDecisionJson: union mode when not bound', () => {
  test('unbound binding => mode union, no boundSpecId/worktreeName', () => {
    const decision = {
      kind: 'no_authority',
      rule: 'scope.no_authority.unbound',
      authority: 'kernel/scope',
      path: 'README.md',
      bindingState: 'unbound',
      message: 'no authority',
    };
    const json = buildScopeDecisionJson(decision, unboundContext());
    expect(json.mode).toBe('union');
    expect(json.bindingState).toBe('unbound');
    expect(json.boundSpecId).toBeUndefined();
    expect(json.worktreeName).toBeUndefined();
  });

  test('one_sided binding is union mode (not authoritative)', () => {
    const decision = {
      kind: 'no_authority',
      rule: 'scope.no_authority.binding_one_sided',
      authority: 'kernel/scope',
      path: 'x.ts',
      bindingState: 'one_sided',
      message: 'one sided',
    };
    const json = buildScopeDecisionJson(decision, {
      binding: { kind: 'one_sided', detail: {} },
      source: 'none',
    });
    expect(json.mode).toBe('union');
  });
});

describe('buildScopeDecisionJson: boundSpecId fallback to BindingState.spec.id', () => {
  test('when decision.data has no specId, use the bound binding spec id', () => {
    const decision = admitDecision({ data: { matchedPattern: 'p' } }); // no specId in data
    const json = buildScopeDecisionJson(decision, boundContext());
    expect(json.boundSpecId).toBe('FOO-001'); // from binding.spec.id
  });
});

describe('buildScopeDecisionJson: ambiguous claimants', () => {
  test('ambiguous binding surfaces claimant spec ids', () => {
    const decision = {
      kind: 'no_authority',
      rule: 'scope.no_authority.unbound',
      authority: 'kernel/scope',
      path: 'shared.ts',
      bindingState: 'unbound',
      message: 'ambiguous',
    };
    const ctx = {
      binding: { kind: 'unbound' },
      source: 'none',
      ambiguous: {
        targetPath: 'shared.ts',
        claimants: [
          { specId: 'A-1', worktreeName: 'a', matchedScopeInEntry: 'shared.ts' },
          { specId: 'B-1', worktreeName: 'b', matchedScopeInEntry: 'shared.ts' },
        ],
      },
    };
    const json = buildScopeDecisionJson(decision, ctx);
    expect(json.ambiguousClaimants).toEqual(['A-1', 'B-1']);
  });
});

describe('renderDecisionJson: emits one parseable JSON line', () => {
  test('output is single-line valid JSON matching buildScopeDecisionJson', () => {
    const decision = admitDecision();
    const ctx = boundContext();
    const line = renderDecisionJson(decision, ctx);
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual(buildScopeDecisionJson(decision, ctx));
  });
});

describe('renderDecision: human render is unaffected by the new JSON path', () => {
  test('default human render still leads with the ADMIT label + rule', () => {
    const out = renderDecision(admitDecision(), { boundContext: boundContext() });
    expect(out.startsWith('ADMIT')).toBe(true);
    expect(out).toContain('scope.admit.scope_in');
    // and it is NOT json
    expect(() => JSON.parse(out)).toThrow();
  });
});
