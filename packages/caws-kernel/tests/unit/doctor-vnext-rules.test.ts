// Slice 7c.2 — kernel doctor rules off the 7c.1 input surface.
//
// One test per rule (positive + negative or boundary), plus integration
// assertions that doctor stays diagnostic-only and does not duplicate
// policy validation.

import { DOCTOR_RULES, inspectProjectState } from '../../src/doctor';
import type { DoctorInput } from '../../src/doctor';
import { prepareAppend } from '../../src/evidence';
import { isOk } from '../../src/result';
import type { Diagnostic } from '../../src/diagnostics/types';
import type { Policy } from '../../src/policy/types';
import type { Waiver } from '../../src/waiver/types';

const NOW = new Date('2026-05-15T12:00:00.000Z');
const FUTURE_AT = '2027-01-01T00:00:00.000Z';
// 5 days from NOW (well inside a 7-day expires_soon horizon)
const SOON_AT = new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString();

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

function fullFsPresent(): NonNullable<DoctorInput['filesystem']> {
  return {
    cawsDirExists: true,
    specsDirExists: true,
    waiversDirExists: true,
    policyYamlExists: true,
    worktreesJsonExists: true,
    agentsJsonExists: true,
    eventsJsonlExists: false,
  };
}

function activeWaiver(overrides: Partial<Waiver> = {}): Waiver {
  return {
    id: 'WAIV-1',
    title: 'a waiver',
    status: 'active',
    gates: ['budget_limit'],
    reason: 'authorized',
    approved_by: 'lead@example.com',
    created_at: '2026-05-01T00:00:00.000Z',
    expires_at: FUTURE_AT,
    ...overrides,
  } as Waiver;
}

// =====================================================================
// init.legacy_working_spec_present / _schema_present
// =====================================================================
describe('7c.2 doctor.init.legacy_*_present', () => {
  it('workingSpecYaml=true → error', () => {
    const r = inspectProjectState(
      baseInput({
        initResidue: { workingSpecYaml: true, workingSpecSchemaJson: false },
      })
    );
    const f = r.findings.find(
      (x) => x.rule === DOCTOR_RULES.INIT_LEGACY_WORKING_SPEC_PRESENT
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
    expect(f!.subject).toBe('.caws/working-spec.yaml');
    // No spurious schema-present finding.
    expect(
      r.findings.some(
        (x) => x.rule === DOCTOR_RULES.INIT_LEGACY_WORKING_SPEC_SCHEMA_PRESENT
      )
    ).toBe(false);
  });

  it('workingSpecSchemaJson=true → error', () => {
    const r = inspectProjectState(
      baseInput({
        initResidue: { workingSpecYaml: false, workingSpecSchemaJson: true },
      })
    );
    const f = r.findings.find(
      (x) => x.rule === DOCTOR_RULES.INIT_LEGACY_WORKING_SPEC_SCHEMA_PRESENT
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
  });

  it('both false → no findings', () => {
    const r = inspectProjectState(
      baseInput({
        initResidue: { workingSpecYaml: false, workingSpecSchemaJson: false },
      })
    );
    const legacy = r.findings.filter((x) =>
      x.rule.startsWith('doctor.init.legacy_')
    );
    expect(legacy).toEqual([]);
  });
});

// =====================================================================
// init.*_missing — only fire when .caws/ exists
// =====================================================================
describe('7c.2 doctor.init.*_missing layout drift', () => {
  it('every canonical file/dir present → no missing rules fire', () => {
    const r = inspectProjectState(baseInput({ filesystem: fullFsPresent() }));
    const missing = r.findings.filter((x) =>
      /_(?:dir|registry)_missing$/.test(x.rule)
    );
    expect(missing).toEqual([]);
  });

  it('cawsDir absent → no missing-layout findings (uninitialized != drift)', () => {
    const r = inspectProjectState(
      baseInput({
        filesystem: {
          cawsDirExists: false,
          specsDirExists: false,
          waiversDirExists: false,
          policyYamlExists: false,
          worktreesJsonExists: false,
          agentsJsonExists: false,
          eventsJsonlExists: false,
        },
      })
    );
    const layoutMissing = r.findings.filter((x) =>
      /^doctor\.init\..*(?:_dir|_registry)_missing$/.test(x.rule)
    );
    expect(layoutMissing).toEqual([]);
  });

  it('cawsDir present but specs missing → specs_dir_missing warning', () => {
    const fs = { ...fullFsPresent(), specsDirExists: false };
    const r = inspectProjectState(baseInput({ filesystem: fs }));
    const f = r.findings.find(
      (x) => x.rule === DOCTOR_RULES.INIT_SPECS_DIR_MISSING
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warning');
  });

  it('cawsDir present but waivers missing → waivers_dir_missing warning', () => {
    const fs = { ...fullFsPresent(), waiversDirExists: false };
    const r = inspectProjectState(baseInput({ filesystem: fs }));
    expect(
      r.findings.find((x) => x.rule === DOCTOR_RULES.INIT_WAIVERS_DIR_MISSING)
    ).toBeDefined();
  });

  it('cawsDir present but worktrees.json missing → worktrees_registry_missing warning', () => {
    const fs = { ...fullFsPresent(), worktreesJsonExists: false };
    const r = inspectProjectState(baseInput({ filesystem: fs }));
    const f = r.findings.find(
      (x) => x.rule === DOCTOR_RULES.INIT_WORKTREES_REGISTRY_MISSING
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warning');
  });

  it('cawsDir present but agents.json missing → agents_registry_missing warning', () => {
    const fs = { ...fullFsPresent(), agentsJsonExists: false };
    const r = inspectProjectState(baseInput({ filesystem: fs }));
    expect(
      r.findings.find(
        (x) => x.rule === DOCTOR_RULES.INIT_AGENTS_REGISTRY_MISSING
      )
    ).toBeDefined();
  });

  it('events.jsonl absent → NO finding (first append creates it)', () => {
    const fs = { ...fullFsPresent(), eventsJsonlExists: false };
    const r = inspectProjectState(baseInput({ filesystem: fs }));
    expect(r.findings.some((x) => x.rule.includes('events_jsonl'))).toBe(false);
    // Confirm the rule simply doesn't exist in the registry.
    expect(
      Object.values(DOCTOR_RULES).some((r) => r.includes('events_jsonl'))
    ).toBe(false);
  });
});

// =====================================================================
// CAWS-DOCTOR-HOOKS-NO-CAWS-DRIFT-001:
// init.hooks_present_caws_absent — hooks installed, .caws/ absent.
// The INVERSE of *_missing (which presuppose .caws/ exists).
// =====================================================================
describe('doctor.init.hooks_present_caws_absent', () => {
  // An uninitialized repo: .caws/ does not exist, every sub-path absent.
  function cawsAbsentFs(
    overrides: Partial<NonNullable<DoctorInput['filesystem']>> = {}
  ): NonNullable<DoctorInput['filesystem']> {
    return {
      cawsDirExists: false,
      specsDirExists: false,
      waiversDirExists: false,
      policyYamlExists: false,
      worktreesJsonExists: false,
      agentsJsonExists: false,
      eventsJsonlExists: false,
      ...overrides,
    };
  }

  it('hookPackInstalled=true AND cawsDir absent → warning fires', () => {
    const r = inspectProjectState(
      baseInput({ filesystem: cawsAbsentFs({ hookPackInstalled: true }) })
    );
    const f = r.findings.find(
      (x) => x.rule === DOCTOR_RULES.INIT_HOOKS_PRESENT_CAWS_ABSENT
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warning');
    expect(f!.subject).toBe('.caws');
    // The repair must point at `caws init`, not at fabricating spec IDs.
    expect(f!.narrowRepair).toContain('caws init');
    expect(f!.data).toMatchObject({
      caws_dir_exists: false,
      hook_pack_installed: true,
    });
  });

  it('hookPackInstalled=true BUT cawsDir present → does NOT fire (initialized)', () => {
    const r = inspectProjectState(
      baseInput({
        filesystem: { ...fullFsPresent(), hookPackInstalled: true },
      })
    );
    expect(
      r.findings.some(
        (x) => x.rule === DOCTOR_RULES.INIT_HOOKS_PRESENT_CAWS_ABSENT
      )
    ).toBe(false);
  });

  it('cawsDir absent BUT hookPackInstalled=false → does NOT fire (plain new repo)', () => {
    const r = inspectProjectState(
      baseInput({ filesystem: cawsAbsentFs({ hookPackInstalled: false }) })
    );
    expect(
      r.findings.some(
        (x) => x.rule === DOCTOR_RULES.INIT_HOOKS_PRESENT_CAWS_ABSENT
      )
    ).toBe(false);
  });

  it('hookPackInstalled undefined → does NOT fire (unobserved, not absent)', () => {
    const r = inspectProjectState(
      baseInput({ filesystem: cawsAbsentFs() })
    );
    expect(
      r.findings.some(
        (x) => x.rule === DOCTOR_RULES.INIT_HOOKS_PRESENT_CAWS_ABSENT
      )
    ).toBe(false);
  });

  it('filesystem undefined entirely → does NOT fire', () => {
    const r = inspectProjectState(baseInput());
    expect(
      r.findings.some(
        (x) => x.rule === DOCTOR_RULES.INIT_HOOKS_PRESENT_CAWS_ABSENT
      )
    ).toBe(false);
  });
});

// =====================================================================
// registry.malformed_loaded
// =====================================================================
describe('7c.2 doctor.registry.malformed_loaded', () => {
  it('passes through registryDiagnostics with severity preserved', () => {
    const diag: Diagnostic = {
      rule: 'store.registry.not_object',
      authority: 'kernel/diagnostics',
      severity: 'error',
      message: 'worktrees.json is not a JSON object.',
      subject: '/abs/.caws/worktrees.json',
    };
    const r = inspectProjectState(baseInput({ registryDiagnostics: [diag] }));
    const f = r.findings.find(
      (x) => x.rule === DOCTOR_RULES.REGISTRY_MALFORMED_LOADED
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
    expect(f!.message).toMatch(/not a JSON object/);
    expect(f!.data?.source_rule).toBe('store.registry.not_object');
  });

  it('empty registryDiagnostics → no finding (missing != malformed)', () => {
    const r = inspectProjectState(baseInput({ registryDiagnostics: [] }));
    expect(
      r.findings.find((x) => x.rule === DOCTOR_RULES.REGISTRY_MALFORMED_LOADED)
    ).toBeUndefined();
  });
});

// =====================================================================
// policy.critical_gate_not_blocking
// =====================================================================
describe('7c.2 doctor.policy.critical_gate_not_blocking', () => {
  it('all critical gates block → no posture finding', () => {
    const r = inspectProjectState(baseInput());
    expect(
      r.findings.find(
        (x) => x.rule === DOCTOR_RULES.POLICY_CRITICAL_GATE_NOT_BLOCKING
      )
    ).toBeUndefined();
  });

  it('budget_limit in warn mode → warning', () => {
    const policy = makePolicy({
      gates: {
        ...makePolicy().gates,
        budget_limit: { enabled: true, mode: 'warn' },
      },
    });
    const r = inspectProjectState(baseInput({ policy }));
    const f = r.findings.find(
      (x) => x.rule === DOCTOR_RULES.POLICY_CRITICAL_GATE_NOT_BLOCKING
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warning');
    expect(f!.data?.gate_id).toBe('budget_limit');
    expect(f!.data?.mode).toBe('warn');
  });

  it('scope_boundary disabled → warning', () => {
    const policy = makePolicy({
      gates: {
        ...makePolicy().gates,
        scope_boundary: { enabled: false, mode: 'block' },
      },
    });
    const r = inspectProjectState(baseInput({ policy }));
    const f = r.findings.find(
      (x) =>
        x.rule === DOCTOR_RULES.POLICY_CRITICAL_GATE_NOT_BLOCKING &&
        (x.data?.gate_id as string) === 'scope_boundary'
    );
    expect(f).toBeDefined();
    expect(f!.data?.enabled).toBe(false);
  });

  it('non-critical gate (god_object) in warn mode → no posture finding', () => {
    // god_object is mode=warn in the default policy and should NOT trip
    // critical_gate_not_blocking.
    const r = inspectProjectState(baseInput());
    expect(
      r.findings.some(
        (x) =>
          x.rule === DOCTOR_RULES.POLICY_CRITICAL_GATE_NOT_BLOCKING &&
          (x.data?.gate_id as string) === 'god_object'
      )
    ).toBe(false);
  });
});

// =====================================================================
// policy.non_governed_zone_broad
// =====================================================================
describe('7c.2 doctor.policy.non_governed_zone_broad', () => {
  it('non_governed_zones=["**"], force=false → warning (inert)', () => {
    const policy = makePolicy({ non_governed_zones: ['**'] });
    const r = inspectProjectState(baseInput({ policy }));
    const f = r.findings.find(
      (x) => x.rule === DOCTOR_RULES.POLICY_NON_GOVERNED_ZONE_BROAD
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warning');
    expect(f!.data?.pattern).toBe('**');
    expect(f!.data?.force).toBe(false);
    expect(f!.message).toMatch(/inert pending non_governed_zones_force/);
  });

  it('non_governed_zones=["**"], force=true → error (armed)', () => {
    const policy = makePolicy({
      non_governed_zones: ['**'],
      non_governed_zones_force: true,
    });
    const r = inspectProjectState(baseInput({ policy }));
    const f = r.findings.find(
      (x) => x.rule === DOCTOR_RULES.POLICY_NON_GOVERNED_ZONE_BROAD
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
    expect(f!.data?.force).toBe(true);
  });

  it('narrow patterns ("research/**", "playground/**") → no finding', () => {
    const policy = makePolicy({
      non_governed_zones: ['research/**', 'playground/**'],
    });
    const r = inspectProjectState(baseInput({ policy }));
    expect(
      r.findings.find(
        (x) => x.rule === DOCTOR_RULES.POLICY_NON_GOVERNED_ZONE_BROAD
      )
    ).toBeUndefined();
  });

  it('every dangerous pattern in the explicit list fires the rule', () => {
    const dangerous = ['*', '**', '**/*', '.', './', '/', '/*'];
    for (const pattern of dangerous) {
      const policy = makePolicy({ non_governed_zones: [pattern] });
      const r = inspectProjectState(baseInput({ policy }));
      const f = r.findings.find(
        (x) => x.rule === DOCTOR_RULES.POLICY_NON_GOVERNED_ZONE_BROAD
      );
      expect(f).toBeDefined();
      expect(f!.data?.pattern).toBe(pattern);
    }
  });
});

// =====================================================================
// policy.root_passthrough_risky
// =====================================================================
describe('7c.2 doctor.policy.root_passthrough_risky', () => {
  it('root_passthrough=["package.json"] → warning', () => {
    const policy = makePolicy({ root_passthrough: ['package.json'] });
    const r = inspectProjectState(baseInput({ policy }));
    const f = r.findings.find(
      (x) => x.rule === DOCTOR_RULES.POLICY_ROOT_PASSTHROUGH_RISKY
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warning');
    expect(f!.data?.file).toBe('package.json');
  });

  it('non-risky root file → no finding', () => {
    const policy = makePolicy({ root_passthrough: ['custom-readme.md'] });
    const r = inspectProjectState(baseInput({ policy }));
    expect(
      r.findings.find(
        (x) => x.rule === DOCTOR_RULES.POLICY_ROOT_PASSTHROUGH_RISKY
      )
    ).toBeUndefined();
  });
});

// =====================================================================
// waiver.too_many_active_for_gate
// =====================================================================
describe('7c.2 doctor.waiver.too_many_active_for_gate', () => {
  it('cap=1, two effective waivers on the same gate → warning', () => {
    const policy = makePolicy({
      waivers: { max_active_waivers_per_gate: 1 },
    });
    const waivers = [
      activeWaiver({ id: 'WAIV-A-1' }),
      activeWaiver({ id: 'WAIV-B-1' }),
    ];
    const r = inspectProjectState(baseInput({ policy, waivers }));
    const f = r.findings.find(
      (x) => x.rule === DOCTOR_RULES.WAIVER_TOO_MANY_ACTIVE_FOR_GATE
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warning');
    expect(f!.data?.gate_id).toBe('budget_limit');
    expect(f!.data?.count).toBe(2);
    expect(f!.data?.cap).toBe(1);
  });

  it('cap=5, one waiver → no finding', () => {
    const policy = makePolicy({
      waivers: { max_active_waivers_per_gate: 5 },
    });
    const r = inspectProjectState(
      baseInput({ policy, waivers: [activeWaiver({ id: 'WAIV-1' })] })
    );
    expect(
      r.findings.find(
        (x) => x.rule === DOCTOR_RULES.WAIVER_TOO_MANY_ACTIVE_FOR_GATE
      )
    ).toBeUndefined();
  });

  it('cap=1, two waivers BUT one revoked → no finding (revoked not counted)', () => {
    const policy = makePolicy({
      waivers: { max_active_waivers_per_gate: 1 },
    });
    const waivers: Waiver[] = [
      activeWaiver({ id: 'WAIV-A-1' }),
      {
        id: 'WAIV-B-1',
        title: 'rescinded',
        status: 'revoked',
        gates: ['budget_limit'],
        reason: 'withdrawn',
        approved_by: 'lead@example.com',
        created_at: '2026-05-01T00:00:00.000Z',
        expires_at: FUTURE_AT,
        revocation: {
          revoked_at: '2026-05-10T00:00:00.000Z',
          reason: 'audit',
        },
      } as Waiver,
    ];
    const r = inspectProjectState(baseInput({ policy, waivers }));
    expect(
      r.findings.find(
        (x) => x.rule === DOCTOR_RULES.WAIVER_TOO_MANY_ACTIVE_FOR_GATE
      )
    ).toBeUndefined();
  });

  it('cap=1, two waivers BUT one expired → no finding (expired not counted)', () => {
    const policy = makePolicy({
      waivers: { max_active_waivers_per_gate: 1 },
    });
    const waivers: Waiver[] = [
      activeWaiver({ id: 'WAIV-A-1' }),
      activeWaiver({
        id: 'WAIV-B-1',
        expires_at: '2025-01-01T00:00:00.000Z', // expired vs NOW
      }),
    ];
    const r = inspectProjectState(baseInput({ policy, waivers }));
    expect(
      r.findings.find(
        (x) => x.rule === DOCTOR_RULES.WAIVER_TOO_MANY_ACTIVE_FOR_GATE
      )
    ).toBeUndefined();
  });

  it('no policy threshold → no finding (does not invent a default)', () => {
    const policy = makePolicy(); // no policy.waivers.max_*
    const waivers = [
      activeWaiver({ id: 'WAIV-A-1' }),
      activeWaiver({ id: 'WAIV-B-1' }),
      activeWaiver({ id: 'WAIV-C-1' }),
    ];
    const r = inspectProjectState(baseInput({ policy, waivers }));
    expect(
      r.findings.find(
        (x) => x.rule === DOCTOR_RULES.WAIVER_TOO_MANY_ACTIVE_FOR_GATE
      )
    ).toBeUndefined();
  });
});

// =====================================================================
// waiver.expires_soon
// =====================================================================
describe('7c.2 doctor.waiver.expires_soon', () => {
  it('no policy threshold → never fires (no invented default)', () => {
    const r = inspectProjectState(
      baseInput({ waivers: [activeWaiver({ id: 'WAIV-1', expires_at: SOON_AT })] })
    );
    expect(
      r.findings.find((x) => x.rule === DOCTOR_RULES.WAIVER_EXPIRES_SOON)
    ).toBeUndefined();
  });

  it('threshold=7 days, waiver expires in 5 days → info', () => {
    const policy = makePolicy({ waivers: { default_expiry_days: 7 } });
    const r = inspectProjectState(
      baseInput({
        policy,
        waivers: [activeWaiver({ id: 'WAIV-SOON-1', expires_at: SOON_AT })],
      })
    );
    const f = r.findings.find(
      (x) => x.rule === DOCTOR_RULES.WAIVER_EXPIRES_SOON
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe('info');
    expect(f!.data?.waiver_id).toBe('WAIV-SOON-1');
    expect(f!.data?.horizon_days).toBe(7);
  });

  it('threshold=7 days, waiver expires far in the future → no finding', () => {
    const policy = makePolicy({ waivers: { default_expiry_days: 7 } });
    const r = inspectProjectState(
      baseInput({
        policy,
        waivers: [activeWaiver({ id: 'WAIV-1', expires_at: FUTURE_AT })],
      })
    );
    expect(
      r.findings.find((x) => x.rule === DOCTOR_RULES.WAIVER_EXPIRES_SOON)
    ).toBeUndefined();
  });

  it('threshold present but waiver is REVOKED → no finding', () => {
    const policy = makePolicy({ waivers: { default_expiry_days: 7 } });
    const waivers: Waiver[] = [
      {
        id: 'WAIV-REV-1',
        title: 'rescinded',
        status: 'revoked',
        gates: ['budget_limit'],
        reason: 'withdrawn',
        approved_by: 'lead@example.com',
        created_at: '2026-05-01T00:00:00.000Z',
        expires_at: SOON_AT,
        revocation: { revoked_at: '2026-05-10T00:00:00.000Z' },
      } as Waiver,
    ];
    const r = inspectProjectState(baseInput({ policy, waivers }));
    expect(
      r.findings.find((x) => x.rule === DOCTOR_RULES.WAIVER_EXPIRES_SOON)
    ).toBeUndefined();
  });
});

// =====================================================================
// Cross-rule integration
// =====================================================================
describe('7c.2 cross-rule integration', () => {
  it('all rule prefixes fire together produce a coherent report', () => {
    // Build a scenario where every new rule fires once to confirm they
    // co-exist without clobbering each other.
    const policy = makePolicy({
      gates: {
        ...makePolicy().gates,
        budget_limit: { enabled: false, mode: 'warn' }, // critical not blocking
      },
      non_governed_zones: ['**'], // broad
      non_governed_zones_force: true, // armed → error
      root_passthrough: ['package.json'], // risky
      waivers: { max_active_waivers_per_gate: 1, default_expiry_days: 7 },
    });
    const waivers = [
      activeWaiver({ id: 'WAIV-A-1' }),
      activeWaiver({ id: 'WAIV-B-1' }), // → too_many_active_for_gate
      activeWaiver({ id: 'WAIV-SOON-1', expires_at: SOON_AT }), // → expires_soon (×3 since A and B also fall inside 7 days vs FUTURE_AT)
    ];
    const r = inspectProjectState(
      baseInput({
        policy,
        waivers,
        initResidue: { workingSpecYaml: true, workingSpecSchemaJson: true },
        filesystem: {
          ...fullFsPresent(),
          specsDirExists: false,
          waiversDirExists: false,
          worktreesJsonExists: false,
          agentsJsonExists: false,
        },
        registryDiagnostics: [
          {
            rule: 'store.registry.not_object',
            authority: 'kernel/diagnostics',
            severity: 'error',
            message: 'worktrees.json is not a JSON object.',
            subject: '/abs/.caws/worktrees.json',
          },
        ],
      })
    );
    const ruleIds = new Set(r.findings.map((f) => f.rule));
    // Every new rule should appear at least once.
    const expected = [
      DOCTOR_RULES.INIT_LEGACY_WORKING_SPEC_PRESENT,
      DOCTOR_RULES.INIT_LEGACY_WORKING_SPEC_SCHEMA_PRESENT,
      DOCTOR_RULES.INIT_SPECS_DIR_MISSING,
      DOCTOR_RULES.INIT_WAIVERS_DIR_MISSING,
      DOCTOR_RULES.INIT_WORKTREES_REGISTRY_MISSING,
      DOCTOR_RULES.INIT_AGENTS_REGISTRY_MISSING,
      DOCTOR_RULES.REGISTRY_MALFORMED_LOADED,
      DOCTOR_RULES.POLICY_CRITICAL_GATE_NOT_BLOCKING,
      DOCTOR_RULES.POLICY_NON_GOVERNED_ZONE_BROAD,
      DOCTOR_RULES.POLICY_ROOT_PASSTHROUGH_RISKY,
      DOCTOR_RULES.WAIVER_TOO_MANY_ACTIVE_FOR_GATE,
      DOCTOR_RULES.WAIVER_EXPIRES_SOON,
    ];
    for (const r of expected) expect(ruleIds.has(r)).toBe(true);
    // Summary numbers reflect the mixed severities. The report stays
    // coherent: errors > 0, warnings > 0, infos > 0, clean=false.
    expect(r.summary.errors).toBeGreaterThan(0);
    expect(r.summary.warnings).toBeGreaterThan(0);
    expect(r.summary.infos).toBeGreaterThan(0);
    expect(r.clean).toBe(false);
  });

  it('doctor source still has no fs/path/env/clock executable references', () => {
    // Re-asserting the slice 7a.5 purity boundary. 7c.2 added a fair
    // amount of code; make sure none of it accidentally reaches into I/O.
    const fs = require('fs') as typeof import('fs');
    const pathMod = require('path') as typeof import('path');
    function strip(src: string): string {
      const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
      return noBlock
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n');
    }
    const inspectSrc = strip(
      fs.readFileSync(pathMod.resolve(__dirname, '../../src/doctor/inspect.ts'), 'utf8')
    );
    expect(inspectSrc).not.toMatch(/from ['"]fs['"]/);
    expect(inspectSrc).not.toMatch(/from ['"]node:fs['"]/);
    expect(inspectSrc).not.toMatch(/from ['"]path['"]/);
    expect(inspectSrc).not.toMatch(/from ['"]node:path['"]/);
    expect(inspectSrc).not.toMatch(/process\.env/);
    expect(inspectSrc).not.toMatch(/process\.cwd/);
    expect(inspectSrc).not.toMatch(/Date\.now\s*\(/);
    expect(inspectSrc).not.toMatch(/new\s+Date\s*\(\s*\)/);
  });
});
