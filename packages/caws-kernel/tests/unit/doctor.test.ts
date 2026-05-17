import {
  DOCTOR_RULES,
  DOCTOR_RULE_PREFIXES,
  inspectProjectState,
} from '../../src/doctor';
import type { DoctorInput, TemplateCheck } from '../../src/doctor';
import type { Spec } from '../../src/spec/types';
import type { Policy } from '../../src/policy/types';
import type { ChainedEvent } from '../../src/evidence';
import { prepareAppend } from '../../src/evidence';
import { isOk } from '../../src/result';
import type { WorktreeRegistry } from '../../src/worktree';

const NOW = new Date('2026-05-11T12:00:00.000Z');

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
      god_object: { enabled: true, mode: 'warn' },
      todo_detection: { enabled: true, mode: 'warn' },
    },
    ...overrides,
  };
}

function baseInput(overrides: Partial<DoctorInput> = {}): DoctorInput {
  return {
    specs: [],
    policy: makePolicy(),
    now: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Summary + clean
// ---------------------------------------------------------------------------

describe('inspectProjectState — clean state', () => {
  it('reports clean=true with no findings when state is healthy', () => {
    const report = inspectProjectState(baseInput());
    expect(report.clean).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.summary).toEqual({ errors: 0, warnings: 0, infos: 0 });
  });
});

describe('inspectProjectState — programmer input validation', () => {
  it('throws when specs is not an array', () => {
    expect(() =>
      inspectProjectState({ now: NOW, specs: null as unknown as readonly Spec[] })
    ).toThrow(TypeError);
  });

  it('throws when now is not a valid Date', () => {
    expect(() =>
      inspectProjectState({ specs: [], now: 'now' as unknown as Date })
    ).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// 1. spec lifecycle — unbound_active stale/missing-timestamp
// ---------------------------------------------------------------------------

describe('unbound_active — thresholded model', () => {
  it('warning when active+unbound and updated_at exceeds threshold', () => {
    const old = new Date(NOW.getTime() - 2 * 3600_000).toISOString(); // 2h ago
    const report = inspectProjectState(
      baseInput({ specs: [makeSpec({ updated_at: old })] })
    );
    const rules = report.findings.map((f) => f.rule);
    expect(rules).toContain(DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_STALE);
    const f = report.findings.find((x) => x.rule === DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_STALE);
    expect(f?.severity).toBe('warning');
  });

  it('no finding when active+unbound and updated_at is within threshold', () => {
    const recent = new Date(NOW.getTime() - 10_000).toISOString(); // 10s ago
    const report = inspectProjectState(
      baseInput({ specs: [makeSpec({ updated_at: recent })] })
    );
    const rules = report.findings.map((f) => f.rule);
    expect(rules).not.toContain(DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_STALE);
    expect(rules).not.toContain(DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_TIMESTAMP_MISSING);
  });

  it('info finding when active+unbound and updated_at is absent', () => {
    const report = inspectProjectState(baseInput({ specs: [makeSpec()] }));
    const f = report.findings.find(
      (x) => x.rule === DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_TIMESTAMP_MISSING
    );
    expect(f).toBeDefined();
    expect(f?.severity).toBe('info');
  });

  it('info when updated_at exists but is unparseable', () => {
    const report = inspectProjectState(
      baseInput({ specs: [makeSpec({ updated_at: 'tuesday' })] })
    );
    const f = report.findings.find(
      (x) => x.rule === DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_TIMESTAMP_MISSING
    );
    expect(f).toBeDefined();
    expect(f?.severity).toBe('info');
  });

  it('does NOT fire for non-active specs', () => {
    const old = new Date(NOW.getTime() - 2 * 3600_000).toISOString();
    const report = inspectProjectState(
      baseInput({
        specs: [
          makeSpec({ id: 'A', lifecycle_state: 'draft', updated_at: old }),
          makeSpec({ id: 'B', lifecycle_state: 'closed', updated_at: old }),
          makeSpec({ id: 'C', lifecycle_state: 'archived', updated_at: old }),
        ],
      })
    );
    const rules = report.findings.map((f) => f.rule);
    expect(rules).not.toContain(DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_STALE);
    expect(rules).not.toContain(DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_TIMESTAMP_MISSING);
  });

  it('does NOT fire when binding (either side) exists', () => {
    const old = new Date(NOW.getTime() - 2 * 3600_000).toISOString();
    const specWithBoth = makeSpec({ worktree: 'wt-a', updated_at: old });
    const reg: WorktreeRegistry = { 'wt-a': { specId: 'TEST-1' } };
    const report = inspectProjectState(
      baseInput({ specs: [specWithBoth], worktrees: reg })
    );
    expect(report.findings.map((f) => f.rule)).not.toContain(
      DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_STALE
    );
  });

  it('threshold is configurable via unboundActiveThresholdMs', () => {
    const old = new Date(NOW.getTime() - 10_000).toISOString(); // 10s ago
    const report = inspectProjectState(
      baseInput({
        specs: [makeSpec({ updated_at: old })],
        unboundActiveThresholdMs: 5_000,
      })
    );
    expect(report.findings.map((f) => f.rule)).toContain(
      DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_STALE
    );
  });
});

// ---------------------------------------------------------------------------
// 2. binding integrity
// ---------------------------------------------------------------------------

describe('binding integrity', () => {
  it('reports BINDING_ONE_SIDED when registry has specId but spec is silent', () => {
    const spec = makeSpec({ id: 'X-1' }); // no worktree pointer
    const registry: WorktreeRegistry = { 'wt-foo': { specId: 'X-1' } };
    const report = inspectProjectState(
      baseInput({ specs: [spec], worktrees: registry })
    );
    const f = report.findings.find((x) => x.rule === DOCTOR_RULES.BINDING_ONE_SIDED);
    expect(f).toBeDefined();
    expect(f?.severity).toBe('error');
    expect(f?.data?.['worktree_name']).toBe('wt-foo');
  });

  it('reports BINDING_ONE_SIDED when spec points but registry lacks specId', () => {
    const spec = makeSpec({ id: 'X-1', worktree: 'wt-foo' });
    const registry: WorktreeRegistry = { 'wt-foo': { branch: 'caws/wt-foo' } };
    const report = inspectProjectState(
      baseInput({ specs: [spec], worktrees: registry })
    );
    expect(report.findings.map((f) => f.rule)).toContain(
      DOCTOR_RULES.BINDING_ONE_SIDED
    );
  });

  it('reports BINDING_REGISTRY_MISSING_SPEC when registry references unknown spec', () => {
    const registry: WorktreeRegistry = { 'wt-foo': { specId: 'GHOST-99' } };
    const report = inspectProjectState(
      baseInput({ specs: [], worktrees: registry })
    );
    const f = report.findings.find(
      (x) => x.rule === DOCTOR_RULES.BINDING_REGISTRY_MISSING_SPEC
    );
    expect(f).toBeDefined();
    expect(f?.severity).toBe('error');
  });

  it('reports BINDING_SPEC_MISSING_REGISTRY when spec points at a missing entry', () => {
    const spec = makeSpec({ id: 'X-1', worktree: 'wt-gone' });
    const report = inspectProjectState(
      baseInput({ specs: [spec], worktrees: {} })
    );
    expect(report.findings.map((f) => f.rule)).toContain(
      DOCTOR_RULES.BINDING_SPEC_MISSING_REGISTRY
    );
  });

  it('does not flag bidirectional bindings', () => {
    const spec = makeSpec({ id: 'X-1', worktree: 'wt-foo' });
    const registry: WorktreeRegistry = { 'wt-foo': { specId: 'X-1' } };
    const report = inspectProjectState(
      baseInput({ specs: [spec], worktrees: registry })
    );
    const bindingRules = report.findings
      .map((f) => f.rule)
      .filter((r) => r.startsWith('doctor.binding.'));
    expect(bindingRules).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2c. spec_not_governable — bidirectional bind to a non-active spec
// ---------------------------------------------------------------------------

describe('binding — spec_not_governable', () => {
  it('fires when bidirectional binding exists with a closed spec', () => {
    const spec = makeSpec({ id: 'X-1', worktree: 'wt-foo', lifecycle_state: 'closed' });
    const registry: WorktreeRegistry = { 'wt-foo': { specId: 'X-1' } };
    const report = inspectProjectState(
      baseInput({ specs: [spec], worktrees: registry })
    );
    const f = report.findings.find(
      (x) => x.rule === DOCTOR_RULES.BINDING_SPEC_NOT_GOVERNABLE
    );
    expect(f).toBeDefined();
    expect(f?.severity).toBe('error');
    expect(f?.data?.['lifecycle_state']).toBe('closed');
    expect(f?.data?.['spec_id']).toBe('X-1');
  });

  it('fires for archived spec with bidirectional binding', () => {
    const spec = makeSpec({ id: 'X-1', worktree: 'wt-foo', lifecycle_state: 'archived' });
    const registry: WorktreeRegistry = { 'wt-foo': { specId: 'X-1' } };
    const report = inspectProjectState(
      baseInput({ specs: [spec], worktrees: registry })
    );
    expect(report.findings.map((f) => f.rule)).toContain(
      DOCTOR_RULES.BINDING_SPEC_NOT_GOVERNABLE
    );
  });

  it('fires for draft spec with bidirectional binding', () => {
    // Draft is not strictly "non-governable" everywhere in the kernel (the
    // worktree kernel allows binding drafts), but doctor flags the state
    // because a non-active spec held bidirectionally is the wrong steady
    // state for governance. The shell can choose to mute drafts later.
    const spec = makeSpec({ id: 'X-1', worktree: 'wt-foo', lifecycle_state: 'draft' });
    const registry: WorktreeRegistry = { 'wt-foo': { specId: 'X-1' } };
    const report = inspectProjectState(
      baseInput({ specs: [spec], worktrees: registry })
    );
    expect(report.findings.map((f) => f.rule)).toContain(
      DOCTOR_RULES.BINDING_SPEC_NOT_GOVERNABLE
    );
  });

  it('does NOT fire when binding is one-sided (a different rule covers it)', () => {
    const spec = makeSpec({ id: 'X-1', worktree: 'wt-foo', lifecycle_state: 'closed' });
    const registry: WorktreeRegistry = { 'wt-foo': {} }; // no specId
    const report = inspectProjectState(
      baseInput({ specs: [spec], worktrees: registry })
    );
    const rules = report.findings.map((f) => f.rule);
    expect(rules).not.toContain(DOCTOR_RULES.BINDING_SPEC_NOT_GOVERNABLE);
  });

  it('does NOT fire when spec is active', () => {
    const spec = makeSpec({ id: 'X-1', worktree: 'wt-foo', lifecycle_state: 'active' });
    const registry: WorktreeRegistry = { 'wt-foo': { specId: 'X-1' } };
    const report = inspectProjectState(
      baseInput({ specs: [spec], worktrees: registry })
    );
    const rules = report.findings.map((f) => f.rule);
    expect(rules).not.toContain(DOCTOR_RULES.BINDING_SPEC_NOT_GOVERNABLE);
  });
});

// ---------------------------------------------------------------------------
// 2d. spec_points_to_foreign_binding — cross-mismatch from spec's view
// ---------------------------------------------------------------------------

describe('binding — spec_points_to_foreign_binding', () => {
  it('fires when spec.worktree is held by a different spec in the registry', () => {
    const specA = makeSpec({ id: 'A-1', worktree: 'wt-foo' });
    const specOther = makeSpec({ id: 'OTHER-1' }); // exists; not bound
    const registry: WorktreeRegistry = { 'wt-foo': { specId: 'OTHER-1' } };
    const report = inspectProjectState(
      baseInput({ specs: [specA, specOther], worktrees: registry })
    );
    const f = report.findings.find(
      (x) => x.rule === DOCTOR_RULES.BINDING_SPEC_POINTS_TO_FOREIGN_BINDING
    );
    expect(f).toBeDefined();
    expect(f?.severity).toBe('error');
    expect(f?.subject).toBe('A-1');
    expect(f?.data?.['registry_spec_id']).toBe('OTHER-1');
    expect(f?.data?.['worktree_name']).toBe('wt-foo');
  });

  it('fires even when the foreign spec is NOT loaded', () => {
    // The other half (BINDING_REGISTRY_MISSING_SPEC) still fires from the
    // registry side; the spec side now gets its own rule. Together they
    // describe both perspectives of the corrupt link.
    const specA = makeSpec({ id: 'A-1', worktree: 'wt-foo' });
    const registry: WorktreeRegistry = { 'wt-foo': { specId: 'GHOST-99' } };
    const report = inspectProjectState(
      baseInput({ specs: [specA], worktrees: registry })
    );
    const rules = report.findings.map((f) => f.rule);
    expect(rules).toContain(DOCTOR_RULES.BINDING_SPEC_POINTS_TO_FOREIGN_BINDING);
    expect(rules).toContain(DOCTOR_RULES.BINDING_REGISTRY_MISSING_SPEC);
  });

  it('does NOT fire when binding is bidirectional', () => {
    const specA = makeSpec({ id: 'A-1', worktree: 'wt-foo' });
    const registry: WorktreeRegistry = { 'wt-foo': { specId: 'A-1' } };
    const report = inspectProjectState(
      baseInput({ specs: [specA], worktrees: registry })
    );
    expect(report.findings.map((f) => f.rule)).not.toContain(
      DOCTOR_RULES.BINDING_SPEC_POINTS_TO_FOREIGN_BINDING
    );
  });
});

// ---------------------------------------------------------------------------
// 2e. Duplicate-finding regression locks
// ---------------------------------------------------------------------------

describe('binding — duplicate-finding regression locks', () => {
  function findingsFor(report: ReturnType<typeof inspectProjectState>, rule: string) {
    return report.findings.filter((f) => f.rule === rule);
  }

  it('cross-mismatch with foreign spec absent: each rule fires exactly once', () => {
    const specA = makeSpec({ id: 'A-1', worktree: 'wt-foo' });
    const registry: WorktreeRegistry = { 'wt-foo': { specId: 'GHOST' } };
    const report = inspectProjectState(
      baseInput({ specs: [specA], worktrees: registry })
    );
    expect(
      findingsFor(report, DOCTOR_RULES.BINDING_SPEC_POINTS_TO_FOREIGN_BINDING)
    ).toHaveLength(1);
    expect(
      findingsFor(report, DOCTOR_RULES.BINDING_REGISTRY_MISSING_SPEC)
    ).toHaveLength(1);
  });

  it('cross-mismatch with foreign spec present: rules fire exactly once each', () => {
    const specA = makeSpec({ id: 'A-1', worktree: 'wt-foo' });
    const specOther = makeSpec({ id: 'OTHER-1' });
    const registry: WorktreeRegistry = { 'wt-foo': { specId: 'OTHER-1' } };
    const report = inspectProjectState(
      baseInput({ specs: [specA, specOther], worktrees: registry })
    );
    // The registry side reports ONE_SIDED against OTHER-1; the spec side
    // reports SPEC_POINTS_TO_FOREIGN_BINDING against A-1. Each exactly once.
    expect(findingsFor(report, DOCTOR_RULES.BINDING_ONE_SIDED)).toHaveLength(1);
    expect(
      findingsFor(report, DOCTOR_RULES.BINDING_SPEC_POINTS_TO_FOREIGN_BINDING)
    ).toHaveLength(1);
  });

  it('single one-sided binding (registry-only) fires BINDING_ONE_SIDED exactly once', () => {
    const spec = makeSpec({ id: 'X-1' });
    const registry: WorktreeRegistry = { 'wt-foo': { specId: 'X-1' } };
    const report = inspectProjectState(
      baseInput({ specs: [spec], worktrees: registry })
    );
    expect(findingsFor(report, DOCTOR_RULES.BINDING_ONE_SIDED)).toHaveLength(1);
  });

  it('spec_not_governable + bidirectional bind: SPEC_NOT_GOVERNABLE once, no ONE_SIDED', () => {
    const spec = makeSpec({ id: 'X-1', worktree: 'wt-foo', lifecycle_state: 'closed' });
    const registry: WorktreeRegistry = { 'wt-foo': { specId: 'X-1' } };
    const report = inspectProjectState(
      baseInput({ specs: [spec], worktrees: registry })
    );
    expect(findingsFor(report, DOCTOR_RULES.BINDING_SPEC_NOT_GOVERNABLE)).toHaveLength(1);
    expect(findingsFor(report, DOCTOR_RULES.BINDING_ONE_SIDED)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. agent freshness (display only)
// ---------------------------------------------------------------------------

describe('agent freshness — display only', () => {
  const stale = new Date(NOW.getTime() - 48 * 3600_000).toISOString(); // 48h
  const fresh = new Date(NOW.getTime() - 60_000).toISOString(); // 60s

  it('warns on stale agents', () => {
    const report = inspectProjectState(
      baseInput({
        agents: {
          'sess-stale': { session_id: 'sess-stale', last_active: stale },
          'sess-fresh': { session_id: 'sess-fresh', last_active: fresh },
        },
      })
    );
    const stales = report.findings.filter(
      (f) => f.rule === DOCTOR_RULES.AGENT_STALE_DISPLAY_ONLY
    );
    expect(stales).toHaveLength(1);
    expect(stales[0]!.severity).toBe('warning');
    expect(stales[0]!.subject).toBe('sess-stale');
  });

  it('message and repair never imply takeover authority', () => {
    const report = inspectProjectState(
      baseInput({
        agents: { 'sess-stale': { session_id: 'sess-stale', last_active: stale } },
      })
    );
    const f = report.findings.find(
      (x) => x.rule === DOCTOR_RULES.AGENT_STALE_DISPLAY_ONLY
    )!;
    expect(f.message.toLowerCase()).not.toMatch(/abandoned|orphan|reclaim|takeover/);
    expect(f.message.toLowerCase()).toMatch(/display only/);
    expect(f.narrowRepair?.toLowerCase()).toMatch(/no automatic action/);
  });

  it('TTL is configurable', () => {
    const recent = new Date(NOW.getTime() - 60_000).toISOString();
    const report = inspectProjectState(
      baseInput({
        agents: { 'sess-1': { session_id: 'sess-1', last_active: recent } },
        staleAgentTtlMs: 30_000, // 30s — recent is older
      })
    );
    expect(report.findings.map((f) => f.rule)).toContain(
      DOCTOR_RULES.AGENT_STALE_DISPLAY_ONLY
    );
  });
});

// ---------------------------------------------------------------------------
// 4. ownership hygiene — prior_owners growth
// ---------------------------------------------------------------------------

describe('prior_owners growth — hygiene only', () => {
  it('warns when prior_owners exceeds threshold', () => {
    const priors = Array.from({ length: 30 }, (_, i) => ({
      session_id: `sess-${i}`,
      takenOver_at: NOW.toISOString(),
    }));
    const registry: WorktreeRegistry = {
      'wt-foo': { specId: 'X-1', prior_owners: priors },
    };
    const spec = makeSpec({ id: 'X-1', worktree: 'wt-foo' });
    const report = inspectProjectState(
      baseInput({ specs: [spec], worktrees: registry })
    );
    const f = report.findings.find(
      (x) => x.rule === DOCTOR_RULES.OWNERSHIP_PRIOR_OWNER_GROWTH
    );
    expect(f).toBeDefined();
    expect(f?.severity).toBe('warning');
    expect(f?.data?.['prior_owner_count']).toBe(30);
  });

  it('does NOT mutate the input registry', () => {
    const priors = Array.from({ length: 50 }, (_, i) => ({
      session_id: `sess-${i}`,
      takenOver_at: NOW.toISOString(),
    }));
    const before = JSON.stringify(priors);
    const registry: WorktreeRegistry = {
      'wt-foo': { specId: 'X-1', prior_owners: priors },
    };
    const spec = makeSpec({ id: 'X-1', worktree: 'wt-foo' });
    inspectProjectState(baseInput({ specs: [spec], worktrees: registry }));
    expect(JSON.stringify(priors)).toBe(before);
    expect(JSON.stringify(registry['wt-foo']!.prior_owners)).toBe(before);
  });

  it('threshold is configurable', () => {
    const priors = Array.from({ length: 3 }, (_, i) => ({
      session_id: `sess-${i}`,
      takenOver_at: NOW.toISOString(),
    }));
    const registry: WorktreeRegistry = {
      'wt-foo': { specId: 'X-1', prior_owners: priors },
    };
    const spec = makeSpec({ id: 'X-1', worktree: 'wt-foo' });
    const report = inspectProjectState(
      baseInput({
        specs: [spec],
        worktrees: registry,
        priorOwnersGrowthThreshold: 2,
      })
    );
    expect(report.findings.map((f) => f.rule)).toContain(
      DOCTOR_RULES.OWNERSHIP_PRIOR_OWNER_GROWTH
    );
  });
});

// ---------------------------------------------------------------------------
// 5. event chain validity
// ---------------------------------------------------------------------------

describe('event chain', () => {
  it('reports EVENT_CHAIN_INVALID when verifyChain fails', () => {
    // Build one valid event, then tamper with it.
    const g = prepareAppend(null, {
      event: 'spec_created',
      ts: '2026-05-11T11:00:00.000Z',
      actor: { kind: 'agent', id: 'darian' },
      spec_id: 'X-1',
      data: { title: 'Test feature', risk_tier: 2, mode: 'feature', lifecycle_state: 'draft' },
    });
    if (!isOk(g)) throw new Error('genesis prepareAppend failed');
    const tampered: ChainedEvent[] = [
      { ...g.value, ts: '2099-01-01T00:00:00.000Z' as string },
    ];
    const report = inspectProjectState(baseInput({ events: tampered }));
    const f = report.findings.find((x) => x.rule === DOCTOR_RULES.EVENT_CHAIN_INVALID);
    expect(f).toBeDefined();
    expect(f?.severity).toBe('error');
    expect(typeof f?.data?.['first_rule']).toBe('string');
  });

  it('does not fire on a valid 2-event chain', () => {
    const g = prepareAppend(null, {
      event: 'spec_created',
      ts: '2026-05-11T11:00:00.000Z',
      actor: { kind: 'agent', id: 'darian' },
      spec_id: 'X-1',
      data: { title: 'Test feature', risk_tier: 2, mode: 'feature', lifecycle_state: 'draft' },
    });
    if (!isOk(g)) throw new Error('genesis failed');
    const next = prepareAppend(g.value, {
      event: 'spec_created',
      ts: '2026-05-11T11:01:00.000Z',
      actor: { kind: 'agent', id: 'darian' },
      spec_id: 'X-2',
      data: { title: 'Other', risk_tier: 2, mode: 'feature', lifecycle_state: 'draft' },
    });
    if (!isOk(next)) throw new Error('next failed');
    const report = inspectProjectState(baseInput({ events: [g.value, next.value] }));
    expect(report.findings.map((f) => f.rule)).not.toContain(
      DOCTOR_RULES.EVENT_CHAIN_INVALID
    );
  });

  it('does nothing when events is empty or omitted', () => {
    expect(inspectProjectState(baseInput({})).findings).toEqual([]);
    expect(inspectProjectState(baseInput({ events: [] })).findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. policy
// ---------------------------------------------------------------------------

describe('policy', () => {
  it('errors when policy is missing', () => {
    const report = inspectProjectState({ specs: [], now: NOW });
    const f = report.findings.find((x) => x.rule === DOCTOR_RULES.POLICY_MISSING);
    expect(f).toBeDefined();
    expect(f?.severity).toBe('error');
    expect(report.clean).toBe(false);
  });

  it('passes through policy warnings with preserved metadata', () => {
    const report = inspectProjectState(
      baseInput({
        policyWarnings: [
          {
            rule: 'policy.non_governed_zones.dangerously_broad',
            authority: 'kernel/policy',
            message: 'non_governed_zones contains "**"',
            severity: 'warning',
            data: { pattern: '**' },
          },
        ],
      })
    );
    const f = report.findings.find(
      (x) => x.rule === DOCTOR_RULES.POLICY_VALID_WITH_WARNINGS
    );
    expect(f).toBeDefined();
    expect(f?.severity).toBe('warning');
    expect(f?.data?.['source_rule']).toBe('policy.non_governed_zones.dangerously_broad');
    expect(f?.data?.['pattern']).toBe('**');
  });
});

// ---------------------------------------------------------------------------
// 7. templates — severity preserved
// ---------------------------------------------------------------------------

describe('templates — caller-supplied check results', () => {
  it('preserves severity of incoming error diagnostics', () => {
    const t: TemplateCheck = {
      template_id: 'spec/feature.yaml',
      path: 'templates/spec/feature.yaml',
      errors: [
        {
          rule: 'spec.acceptance.too_short',
          authority: 'kernel/spec',
          message: 'acceptance.then is empty.',
          severity: 'error',
        },
      ],
    };
    const report = inspectProjectState(baseInput({ templates: [t] }));
    const f = report.findings.find((x) => x.rule === DOCTOR_RULES.TEMPLATE_DRIFT);
    expect(f).toBeDefined();
    expect(f?.severity).toBe('error');
    expect(f?.data?.['source_rule']).toBe('spec.acceptance.too_short');
    expect(f?.subject).toBe('templates/spec/feature.yaml');
  });

  it('emits doctor.template.warning with warning severity', () => {
    const t: TemplateCheck = {
      template_id: 'spec/sample.yaml',
      errors: [],
      warnings: [
        {
          rule: 'spec.invariants.too_few',
          authority: 'kernel/spec',
          message: 'invariants has only 1 entry.',
          severity: 'warning',
        },
      ],
    };
    const report = inspectProjectState(baseInput({ templates: [t] }));
    const f = report.findings.find((x) => x.rule === DOCTOR_RULES.TEMPLATE_WARNING);
    expect(f).toBeDefined();
    expect(f?.severity).toBe('warning');
  });

  it('preserves incoming severity even when it disagrees with the doctor rule default', () => {
    // An "error" array entry that itself declares severity 'warning' should
    // produce a doctor.template.drift finding with warning severity.
    const t: TemplateCheck = {
      template_id: 'spec/loose.yaml',
      errors: [
        {
          rule: 'spec.observability.missing',
          authority: 'kernel/spec',
          message: 'observability is recommended for Tier 2.',
          severity: 'warning',
        },
      ],
    };
    const report = inspectProjectState(baseInput({ templates: [t] }));
    const f = report.findings.find((x) => x.rule === DOCTOR_RULES.TEMPLATE_DRIFT);
    expect(f).toBeDefined();
    expect(f?.severity).toBe('warning');
  });

  it('defaults missing severity to error when in errors[]', () => {
    const t: TemplateCheck = {
      template_id: 'spec/missing-severity.yaml',
      errors: [
        {
          rule: 'spec.title.too_short',
          authority: 'kernel/spec',
          message: 'title is shorter than 10 chars.',
          // severity intentionally omitted
        },
      ],
    };
    const report = inspectProjectState(baseInput({ templates: [t] }));
    const f = report.findings.find((x) => x.rule === DOCTOR_RULES.TEMPLATE_DRIFT);
    expect(f).toBeDefined();
    expect(f?.severity).toBe('error');
  });

  it('defaults missing severity to warning when in warnings[]', () => {
    const t: TemplateCheck = {
      template_id: 'spec/missing-warning-sev.yaml',
      errors: [],
      warnings: [
        {
          rule: 'spec.invariants.too_few',
          authority: 'kernel/spec',
          message: 'invariants has only 1 entry.',
          // severity intentionally omitted
        },
      ],
    };
    const report = inspectProjectState(baseInput({ templates: [t] }));
    const f = report.findings.find((x) => x.rule === DOCTOR_RULES.TEMPLATE_WARNING);
    expect(f).toBeDefined();
    expect(f?.severity).toBe('warning');
  });

  it('uses template_id as finding subject when path is absent', () => {
    const t: TemplateCheck = {
      template_id: 'spec/no-path.yaml',
      // no path
      errors: [
        {
          rule: 'spec.acceptance.too_short',
          authority: 'kernel/spec',
          message: 'acceptance.then is empty.',
          severity: 'error',
        },
      ],
    };
    const report = inspectProjectState(baseInput({ templates: [t] }));
    const f = report.findings.find((x) => x.rule === DOCTOR_RULES.TEMPLATE_DRIFT);
    expect(f?.subject).toBe('spec/no-path.yaml');
  });
});

// ---------------------------------------------------------------------------
// Public namespace contract
// ---------------------------------------------------------------------------

describe('doctor — public namespace contract', () => {
  it('every DOCTOR_RULES value falls under one of the published prefixes', () => {
    for (const value of Object.values(DOCTOR_RULES)) {
      expect(DOCTOR_RULE_PREFIXES.some((p) => value.startsWith(p))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Summary + clean computation
// ---------------------------------------------------------------------------

describe('summary + clean', () => {
  it('clean=false iff there is at least one error finding', () => {
    const report = inspectProjectState({ specs: [], now: NOW });
    expect(report.summary.errors).toBeGreaterThan(0);
    expect(report.clean).toBe(false);
  });

  it('warnings and infos alone do not unset clean', () => {
    // unbound active timestamp_missing is info-only.
    const report = inspectProjectState(baseInput({ specs: [makeSpec()] }));
    expect(report.summary.errors).toBe(0);
    expect(report.clean).toBe(true);
  });
});

