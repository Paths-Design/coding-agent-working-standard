// WORKTREE-DOCTOR-HALF-STATE-001
//
// Kernel-level unit tests for the six half-state classes H1–H6.
//
// Test discipline:
//   - Each H-class fixture is constructed DIRECTLY in memory. No dependency
//     on the lifecycle-rollback fault-injection seam — the harness proves
//     these states are real; these tests prove classification on explicit
//     fixtures (per spec invariant).
//   - Doctor purity: all input is plain data; the kernel never touches fs,
//     process, git, or Date.now.
//   - Discharge regressions for H2 (BINDING_ONE_SIDED) and H3
//     (BINDING_SPEC_MISSING_REGISTRY) pin existing-rule coverage so a
//     future refactor cannot silently regress without failing this slice.
//   - H5 substring-refusal regression locks the doctor-UX rule that
//     binding_contradiction_3way must never suggest a mutating command.

import {
  DOCTOR_RULES,
  DOCTOR_RULE_PREFIXES,
  inspectProjectState,
} from '../../src/doctor';
import type {
  DoctorInput,
  GitWorktreeEntry,
} from '../../src/doctor';
import type { Spec } from '../../src/spec/types';
import type { WorktreeRegistry } from '../../src/worktree';

const NOW = new Date('2026-05-22T12:00:00.000Z');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

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

function makeRegistry(
  entries: Record<
    string,
    {
      specId?: string;
      path?: string;
      prior_owners?: readonly unknown[];
    }
  >
): WorktreeRegistry {
  return entries as unknown as WorktreeRegistry;
}

function makeInput(overrides: Partial<DoctorInput> = {}): DoctorInput {
  return {
    specs: [],
    now: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Rule registry hygiene
// ---------------------------------------------------------------------------

describe('WORKTREE-DOCTOR-HALF-STATE-001 — rule registry', () => {
  test('all four new rule ids are registered with doctor.worktree.* prefix', () => {
    expect(DOCTOR_RULES.WORKTREE_GHOST_REGISTRY_ENTRY).toBe(
      'doctor.worktree.ghost_registry_entry'
    );
    expect(DOCTOR_RULES.WORKTREE_BINDING_CONTRADICTION_3WAY).toBe(
      'doctor.worktree.binding_contradiction_3way'
    );
    expect(DOCTOR_RULES.WORKTREE_FOREIGN_PHYSICAL).toBe(
      'doctor.worktree.foreign_physical'
    );
    expect(DOCTOR_RULES.WORKTREE_GIT_OBSERVATION_UNAVAILABLE).toBe(
      'doctor.worktree.git_observation_unavailable'
    );
  });

  test("'doctor.worktree.' is listed in DOCTOR_RULE_PREFIXES", () => {
    expect(DOCTOR_RULE_PREFIXES).toContain('doctor.worktree.');
  });
});

// ---------------------------------------------------------------------------
// H1 — ghost registry entry
// ---------------------------------------------------------------------------

describe('WORKTREE-DOCTOR-HALF-STATE-001 H1 — ghost registry entry', () => {
  test('fires WORKTREE_GHOST_REGISTRY_ENTRY when registry entry exists but worktree dir absent and not in git list', () => {
    const spec = makeSpec({ id: 'GHOST-1' });
    const registry = makeRegistry({
      'wt-ghost': { specId: 'GHOST-1' },
    });
    const input = makeInput({
      specs: [spec],
      worktrees: registry,
      filesystem: {
        cawsDirExists: true,
        specsDirExists: true,
        waiversDirExists: true,
        policyYamlExists: true,
        worktreesJsonExists: true,
        agentsJsonExists: true,
        eventsJsonlExists: true,
        worktreeDirByName: { 'wt-ghost': false },
      },
      gitWorktrees: [],
    });

    const report = inspectProjectState(input);

    const ghost = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.WORKTREE_GHOST_REGISTRY_ENTRY
    );
    expect(ghost).toBeDefined();
    expect(ghost!.severity).toBe('error');
    expect(ghost!.subject).toBe('wt-ghost');
    expect(ghost!.data).toMatchObject({
      worktree_name: 'wt-ghost',
      spec_id: 'GHOST-1',
      canonical_dir_present: false,
      git_worktree_listed: false,
    });
  });

  test('does NOT fire H1 when canonical worktree dir is present', () => {
    const spec = makeSpec({ id: 'OK-1' });
    const registry = makeRegistry({
      'wt-ok': { specId: 'OK-1' },
    });
    const input = makeInput({
      specs: [spec],
      worktrees: registry,
      filesystem: {
        cawsDirExists: true,
        specsDirExists: true,
        waiversDirExists: true,
        policyYamlExists: true,
        worktreesJsonExists: true,
        agentsJsonExists: true,
        eventsJsonlExists: true,
        worktreeDirByName: { 'wt-ok': true },
      },
      gitWorktrees: [],
    });

    const report = inspectProjectState(input);

    const ghost = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.WORKTREE_GHOST_REGISTRY_ENTRY
    );
    expect(ghost).toBeUndefined();
  });

  test('does NOT fire H1 when git list reports the recorded path even if canonical dir absent', () => {
    // Edge case: worktree was created at a non-canonical path. The
    // canonical-dir check is false, but the recorded path is in
    // `git worktree list` output. Don't false-alarm.
    const spec = makeSpec({ id: 'NONCANON-1' });
    const registry = makeRegistry({
      'wt-noncanon': { specId: 'NONCANON-1', path: '/tmp/noncanon-wt' },
    });
    const input = makeInput({
      specs: [spec],
      worktrees: registry,
      filesystem: {
        cawsDirExists: true,
        specsDirExists: true,
        waiversDirExists: true,
        policyYamlExists: true,
        worktreesJsonExists: true,
        agentsJsonExists: true,
        eventsJsonlExists: true,
        worktreeDirByName: { 'wt-noncanon': false },
      },
      gitWorktrees: [{ path: '/tmp/noncanon-wt', branch: 'refs/heads/x' }],
    });

    const report = inspectProjectState(input);

    const ghost = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.WORKTREE_GHOST_REGISTRY_ENTRY
    );
    expect(ghost).toBeUndefined();
  });

  test('silently SKIPS H1 when filesystem.worktreeDirByName is unavailable', () => {
    const spec = makeSpec({ id: 'NOFS-1' });
    const registry = makeRegistry({
      'wt-nofs': { specId: 'NOFS-1' },
    });
    const input = makeInput({
      specs: [spec],
      worktrees: registry,
      // filesystem omitted entirely
      gitWorktrees: [],
    });

    const report = inspectProjectState(input);

    expect(
      report.findings.find(
        (f) => f.rule === DOCTOR_RULES.WORKTREE_GHOST_REGISTRY_ENTRY
      )
    ).toBeUndefined();
  });

  // AGENT-LIVENESS-DOCTOR-001 (D10): the H1 ghost rule was LOOSENED. It no
  // longer REQUIRES git observation — the canonical-dir filesystem fact
  // (worktreeDirByName) is sufficient to flag a registry entry whose dir is
  // gone. The prior "silently skip when git is unavailable" behavior WAS the
  // D10 defect: doctor reported clean on a drifted repo because git happened to
  // be unobservable. git porcelain is now a refinement (it can prevent a false
  // ghost for a worktree at a non-canonical path), not a precondition. When git
  // observation is absent the finding still fires, with git_worktree_listed:null.
  test('H1 FIRES on worktreeDirByName alone when gitWorktrees is unavailable (D10 loosening)', () => {
    const spec = makeSpec({ id: 'NOGIT-1' });
    const registry = makeRegistry({
      'wt-nogit': { specId: 'NOGIT-1' },
    });
    const input = makeInput({
      specs: [spec],
      worktrees: registry,
      filesystem: {
        cawsDirExists: true,
        specsDirExists: true,
        waiversDirExists: true,
        policyYamlExists: true,
        worktreesJsonExists: true,
        agentsJsonExists: true,
        eventsJsonlExists: true,
        worktreeDirByName: { 'wt-nogit': false },
      },
      // gitWorktrees omitted
      gitObservationFailure: 'git not installed',
    });

    const report = inspectProjectState(input);

    const ghost = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.WORKTREE_GHOST_REGISTRY_ENTRY
    );
    expect(ghost).toBeDefined();
    expect(ghost!.subject).toBe('wt-nogit');
    // git refinement could not run → the listed flag is null, not false.
    expect(ghost!.data?.git_worktree_listed).toBeNull();
  });

  // FOLLOWUP-001 A3: defensive filter regression. The prior slice (commit
  // a84ac60) added a defensive filter that skips non-object records when
  // iterating worktrees during H1 emission. The motivating case is the
  // v10.2 legacy envelope shape leaking through a future loader regression:
  //   { version: 1, worktrees: { ... } }
  // Both "version" (a number) and "worktrees" (an object) appear as top-
  // level keys. Without the filter, the kernel would iterate "version: 1"
  // and crash on registry[name] access or emit a malformed finding.
  //
  // This test pins the defensive filter by constructing the legacy
  // envelope shape directly as a DoctorInput.worktrees and asserting:
  //   - "version" (number record) produces NO H1 finding (filtered out)
  //   - "worktrees" (object record) DOES produce an H1 finding (the
  //     kernel cannot distinguish "a real worktree named worktrees" from
  //     "a legacy envelope key" at the rule layer — operators see the
  //     spurious finding as evidence of the underlying loader bug)
  //
  // Removing the defensive filter (e.g. by reverting commit a84ac60)
  // would either crash this test or break the "version" expectation.
  test('FOLLOWUP-001 A3: H1 defensive filter skips non-object records (v10.2 legacy envelope shape)', () => {
    const input = makeInput({
      specs: [],
      // The shape that leaks: { version: 1, worktrees: { ... } }.
      // We construct it directly as the kernel's WorktreeRegistry would
      // see it post-leak. WorktreeRegistry is typed as
      // Record<string, WorktreeRecord>; the cast lets us inject the
      // pathological shape that exercises the defensive filter.
      worktrees: {
        version: 1,
        worktrees: { 'real-wt': { specId: 'X' } },
      } as unknown as WorktreeRegistry,
      filesystem: {
        cawsDirExists: true,
        specsDirExists: true,
        waiversDirExists: true,
        policyYamlExists: true,
        worktreesJsonExists: true,
        agentsJsonExists: true,
        eventsJsonlExists: true,
        worktreeDirByName: {
          version: false,
          worktrees: false,
          'real-wt': false,
        },
      },
      gitWorktrees: [],
    });

    // Must not throw.
    const report = inspectProjectState(input);

    // "version" (number record) MUST NOT produce an H1 finding —
    // defensive filter regression assertion.
    const versionFinding = report.findings.find(
      (f) =>
        f.rule === DOCTOR_RULES.WORKTREE_GHOST_REGISTRY_ENTRY &&
        f.subject === 'version'
    );
    expect(versionFinding).toBeUndefined();

    // "worktrees" (object record) DOES produce an H1 finding — the
    // kernel cannot distinguish a real worktree named "worktrees" from
    // a legacy envelope key, by design. This is the documented behavior:
    // operators are expected to interpret the spurious finding as
    // evidence of the underlying loader leak and migrate the file.
    const worktreesFinding = report.findings.find(
      (f) =>
        f.rule === DOCTOR_RULES.WORKTREE_GHOST_REGISTRY_ENTRY &&
        f.subject === 'worktrees'
    );
    expect(worktreesFinding).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// H2 — one-sided registry → spec (DISCHARGED by BINDING_ONE_SIDED)
//
// Regression test: H2's observable state (registry has specId pointing to
// spec X; spec X exists but lacks `worktree:`) is detected by the existing
// BINDING_ONE_SIDED rule, NOT by BINDING_SPEC_MISSING_REGISTRY (the
// original draft hypothesized the wrong rule). Pin this so future refactors
// of BINDING_ONE_SIDED cannot silently regress H2.
// ---------------------------------------------------------------------------

describe('WORKTREE-DOCTOR-HALF-STATE-001 H2 — discharged by BINDING_ONE_SIDED', () => {
  test('H2 fixture fires BINDING_ONE_SIDED (not BINDING_SPEC_MISSING_REGISTRY)', () => {
    // H2: registry[name].specId = X; spec X exists; spec X has no worktree:
    const spec = makeSpec({ id: 'H2-1', worktree: undefined });
    const registry = makeRegistry({
      'wt-h2': { specId: 'H2-1' },
    });
    const input = makeInput({
      specs: [spec],
      worktrees: registry,
    });

    const report = inspectProjectState(input);

    const oneSided = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.BINDING_ONE_SIDED
    );
    expect(oneSided).toBeDefined();
    expect(oneSided!.severity).toBe('error');
    expect(oneSided!.subject).toBe('wt-h2');

    // FOLLOWUP-001 A5: pin the data-payload shape so downstream
    // authority logic (WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-001) can
    // rely on these fields without re-inspecting the kernel rule.
    expect(oneSided!.data).toMatchObject({
      worktree_name: 'wt-h2',
      spec_id: 'H2-1',
      specHasWorktree: false,
      registryHasSpecId: true,
    });

    // Negative: BINDING_SPEC_MISSING_REGISTRY MUST NOT fire here.
    const wrongRule = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.BINDING_SPEC_MISSING_REGISTRY
    );
    expect(wrongRule).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// H3 — one-sided spec → registry (DISCHARGED by BINDING_SPEC_MISSING_REGISTRY)
//
// Regression test: H3's observable state (spec has `worktree: name`,
// registry lacks `name`) is detected by BINDING_SPEC_MISSING_REGISTRY.
// Exercises BOTH lifecycle_state: active AND lifecycle_state: draft to
// close the existing test-coverage gap (the production rule has no
// lifecycle guard, but no test confirmed this for non-active specs).
// ---------------------------------------------------------------------------

describe('WORKTREE-DOCTOR-HALF-STATE-001 H3 — discharged by BINDING_SPEC_MISSING_REGISTRY (active + draft)', () => {
  test('H3 fires for an active spec with worktree: but no registry entry', () => {
    const spec = makeSpec({
      id: 'H3-1',
      lifecycle_state: 'active',
      worktree: 'wt-h3-active',
    });
    const input = makeInput({
      specs: [spec],
      worktrees: makeRegistry({}),
    });

    const report = inspectProjectState(input);

    const finding = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.BINDING_SPEC_MISSING_REGISTRY
    );
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('error');
    expect(finding!.subject).toBe('H3-1');
    // FOLLOWUP-001 A5: pin the data-payload shape (active spec). The
    // canonical_dir_observed: false comes from FOLLOWUP-001 H4 enrichment
    // (no filesystem block → no spec-claim map → unobserved).
    expect(finding!.data).toMatchObject({
      spec_id: 'H3-1',
      worktree_name: 'wt-h3-active',
      canonical_dir_observed: false,
    });
    expect('canonical_dir_present' in (finding!.data ?? {})).toBe(false);
  });

  test('H3 fires for a DRAFT spec with worktree: but no registry entry (no lifecycle guard)', () => {
    const spec = makeSpec({
      id: 'H3-2',
      lifecycle_state: 'draft',
      worktree: 'wt-h3-draft',
    });
    const input = makeInput({
      specs: [spec],
      worktrees: makeRegistry({}),
    });

    const report = inspectProjectState(input);

    const finding = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.BINDING_SPEC_MISSING_REGISTRY
    );
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('error');
    expect(finding!.data).toMatchObject({
      spec_id: 'H3-2',
      worktree_name: 'wt-h3-draft',
    });
  });
});

// ---------------------------------------------------------------------------
// H4 — destroyWorktree post-fault enrichment (FOLLOWUP-001 honest version)
//
// H4's registry/spec axis is identical to H3 (spec has worktree:, no
// registry entry). The third fact (whether the canonical worktree dir is
// present) is delivered as data enrichment on BINDING_SPEC_MISSING_REGISTRY.
//
// The original slice used the registry-keyed worktreeDirByName map for
// this enrichment, which collapsed two distinct facts:
//   (a) we observed the canonical path is absent
//   (b) we never observed the canonical path
// Both produced git_worktree_present: false, because the H4 case is
// precisely "spec claims X, registry has no X" — so X is by construction
// NOT a key in the registry-keyed map.
//
// FOLLOWUP-001 fix: use a SPEC-CLAIM-keyed map
// (filesystem.specClaimedWorktreeDirByName) and surface the two facts
// distinctly:
//   - canonical_dir_observed: true when X is a key in the map, false
//     when we have no observation (or the map is absent entirely)
//   - canonical_dir_present: set only when observed, omitted otherwise
//
// The enrichment is an observable filesystem fact, NOT provenance proof
// that destroyWorktree caused the state. Downstream authority logic
// (WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-001) decides interpretation.
// ---------------------------------------------------------------------------

describe('WORKTREE-DOCTOR-HALF-STATE-FOLLOWUP-001 H4 — enrichment uses spec-claim-keyed map', () => {
  test('observed-present: canonical_dir_observed: true, canonical_dir_present: true', () => {
    const spec = makeSpec({
      id: 'H4-OBSPRES-1',
      worktree: 'wt-h4-obspres',
    });
    const input = makeInput({
      specs: [spec],
      worktrees: makeRegistry({}),
      filesystem: {
        cawsDirExists: true,
        specsDirExists: true,
        waiversDirExists: true,
        policyYamlExists: true,
        worktreesJsonExists: true,
        agentsJsonExists: true,
        eventsJsonlExists: true,
        worktreeDirByName: {},
        specClaimedWorktreeDirByName: { 'wt-h4-obspres': true },
      },
    });

    const report = inspectProjectState(input);

    const finding = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.BINDING_SPEC_MISSING_REGISTRY
    );
    expect(finding).toBeDefined();
    expect(finding!.data).toMatchObject({
      spec_id: 'H4-OBSPRES-1',
      worktree_name: 'wt-h4-obspres',
      canonical_dir_observed: true,
      canonical_dir_present: true,
    });
    // Honesty: the obsolete git_worktree_present field must not leak back.
    expect('git_worktree_present' in (finding!.data ?? {})).toBe(false);
  });

  test('observed-absent: canonical_dir_observed: true, canonical_dir_present: false', () => {
    const spec = makeSpec({
      id: 'H4-OBSABS-1',
      worktree: 'wt-h4-obsabs',
    });
    const input = makeInput({
      specs: [spec],
      worktrees: makeRegistry({}),
      filesystem: {
        cawsDirExists: true,
        specsDirExists: true,
        waiversDirExists: true,
        policyYamlExists: true,
        worktreesJsonExists: true,
        agentsJsonExists: true,
        eventsJsonlExists: true,
        worktreeDirByName: {},
        specClaimedWorktreeDirByName: { 'wt-h4-obsabs': false },
      },
    });

    const report = inspectProjectState(input);

    const finding = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.BINDING_SPEC_MISSING_REGISTRY
    );
    expect(finding).toBeDefined();
    expect(finding!.data).toMatchObject({
      spec_id: 'H4-OBSABS-1',
      worktree_name: 'wt-h4-obsabs',
      canonical_dir_observed: true,
      canonical_dir_present: false,
    });
    expect('git_worktree_present' in (finding!.data ?? {})).toBe(false);
  });

  test('unobserved (map omits the name): canonical_dir_observed: false, canonical_dir_present OMITTED', () => {
    const spec = makeSpec({
      id: 'H4-UNOBS-1',
      worktree: 'wt-h4-unobs',
    });
    const input = makeInput({
      specs: [spec],
      worktrees: makeRegistry({}),
      filesystem: {
        cawsDirExists: true,
        specsDirExists: true,
        waiversDirExists: true,
        policyYamlExists: true,
        worktreesJsonExists: true,
        agentsJsonExists: true,
        eventsJsonlExists: true,
        worktreeDirByName: {},
        specClaimedWorktreeDirByName: {}, // intentionally empty
      },
    });

    const report = inspectProjectState(input);

    const finding = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.BINDING_SPEC_MISSING_REGISTRY
    );
    expect(finding).toBeDefined();
    expect(finding!.data).toMatchObject({
      spec_id: 'H4-UNOBS-1',
      worktree_name: 'wt-h4-unobs',
      canonical_dir_observed: false,
    });
    // The critical correctness assertion: when unobserved, the kernel
    // does NOT synthesize a canonical_dir_present value.
    expect('canonical_dir_present' in (finding!.data ?? {})).toBe(false);
    expect('git_worktree_present' in (finding!.data ?? {})).toBe(false);
  });

  test('unobserved (specClaimedWorktreeDirByName entirely undefined): canonical_dir_observed: false, canonical_dir_present OMITTED', () => {
    // Backward-compat: an older test fixture that does not construct the
    // new map at all. Kernel must still produce the honest payload.
    const spec = makeSpec({
      id: 'H4-NOMAP-1',
      worktree: 'wt-h4-nomap',
    });
    const input = makeInput({
      specs: [spec],
      worktrees: makeRegistry({}),
      // filesystem omitted entirely → specClaimedWorktreeDirByName undefined
    });

    const report = inspectProjectState(input);

    const finding = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.BINDING_SPEC_MISSING_REGISTRY
    );
    expect(finding).toBeDefined();
    expect(finding!.data).toMatchObject({
      spec_id: 'H4-NOMAP-1',
      worktree_name: 'wt-h4-nomap',
      canonical_dir_observed: false,
    });
    expect('canonical_dir_present' in (finding!.data ?? {})).toBe(false);
    expect('git_worktree_present' in (finding!.data ?? {})).toBe(false);
  });

  test('registry-keyed worktreeDirByName is NOT consulted for H4 enrichment (semantic separation)', () => {
    // Build a fixture where the OLD code path would have produced
    // git_worktree_present: true (worktreeDirByName[name] === true). The
    // new code path ignores that map entirely — only
    // specClaimedWorktreeDirByName drives H4 enrichment. Since the
    // spec-claim map is empty here, the data must report unobserved.
    const spec = makeSpec({
      id: 'H4-SEMSEP-1',
      worktree: 'wt-h4-semsep',
    });
    const input = makeInput({
      specs: [spec],
      worktrees: makeRegistry({}),
      filesystem: {
        cawsDirExists: true,
        specsDirExists: true,
        waiversDirExists: true,
        policyYamlExists: true,
        worktreesJsonExists: true,
        agentsJsonExists: true,
        eventsJsonlExists: true,
        // Misleading entry — old code would have used this to say
        // git_worktree_present: true. Kernel must ignore it for H4.
        worktreeDirByName: { 'wt-h4-semsep': true },
        specClaimedWorktreeDirByName: {},
      },
    });

    const report = inspectProjectState(input);

    const finding = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.BINDING_SPEC_MISSING_REGISTRY
    );
    expect(finding).toBeDefined();
    expect(finding!.data).toMatchObject({ canonical_dir_observed: false });
    expect('canonical_dir_present' in (finding!.data ?? {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// H5 — 3-way registry/spec contradiction
//
// Registry binds wt -> specB; specA claims worktree: wt; specB has no
// worktree: field. The new rule fires IN ADDITION TO any per-perspective
// findings from existing rules; it is the only finding that names all
// three contradictory facts in one place.
//
// Locked invariant: the repair text MUST NOT contain a shell command
// (substring-refusal regression).
// ---------------------------------------------------------------------------

describe('WORKTREE-DOCTOR-HALF-STATE-001 H5 — binding_contradiction_3way + UX rule', () => {
  test('fires WORKTREE_BINDING_CONTRADICTION_3WAY on the bindWorktreeRepair post-fault shape', () => {
    const specA = makeSpec({
      id: 'H5-SPECA-1',
      worktree: 'wt-h5',
    });
    const specB = makeSpec({
      id: 'H5-SPECB-1',
      worktree: undefined,
    });
    const registry = makeRegistry({
      'wt-h5': { specId: 'H5-SPECB-1' },
    });
    const input = makeInput({
      specs: [specA, specB],
      worktrees: registry,
    });

    const report = inspectProjectState(input);

    const finding = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.WORKTREE_BINDING_CONTRADICTION_3WAY
    );
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('error');
    expect(finding!.subject).toBe('wt-h5');
    expect(finding!.data).toMatchObject({
      worktree_name: 'wt-h5',
      registry_spec_id: 'H5-SPECB-1',
      spec_a_id: 'H5-SPECA-1',
      spec_a_worktree: 'wt-h5',
      spec_b_id: 'H5-SPECB-1',
      spec_b_worktree: null,
    });
  });

  test('H5 repair text is a non-actionable doctrine pointer (substring-refusal regression)', () => {
    // NOTE on test design (FOLLOWUP-001 A7):
    //
    // Substring-refusal is a TRIPWIRE, not a structural invariant — a
    // future regression could introduce an actionable phrase that uses
    // different substrings (e.g. "execute X" instead of "$ X") and slip
    // through. The forbidden-list is necessary but not sufficient.
    //
    // The structural assertion below (FOLLOWUP-001 A7) adds a positive
    // shape constraint: the repair text must contain EXACTLY one
    // CAWS-spec-id-shaped token (matching /[A-Z][A-Z0-9-]+-\d+[a-z]*/),
    // and that token must be WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-001.
    // This catches "helpfully" rewriting the pointer to a different
    // (wrong) authority or sneaking in additional identifiers.
    const specA = makeSpec({
      id: 'H5-A-2',
      worktree: 'wt-h5b',
    });
    const specB = makeSpec({
      id: 'H5-B-2',
      worktree: undefined,
    });
    const input = makeInput({
      specs: [specA, specB],
      worktrees: makeRegistry({
        'wt-h5b': { specId: 'H5-B-2' },
      }),
    });

    const report = inspectProjectState(input);

    const finding = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.WORKTREE_BINDING_CONTRADICTION_3WAY
    );
    expect(finding).toBeDefined();
    const repair = finding!.narrowRepair ?? '';

    // Must mention the authority control-plane spec as a doctrine pointer.
    expect(repair).toContain('WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-001');

    // Must NOT contain any actionable command substring. Pinning these
    // explicitly prevents future regressions that might "helpfully"
    // suggest a fix and accidentally encode the wrong authority.
    const forbidden = [
      'caws worktree',
      'caws specs',
      'git ',
      'rm ',
      'mv ',
      'sh ',
      'bash ',
      '$',
      '`',
    ];
    for (const needle of forbidden) {
      expect(repair).not.toContain(needle);
    }

    // FOLLOWUP-001 A7: structural assertion. Extract every CAWS-spec-id-
    // shaped token from the repair text. Exactly one must appear, and it
    // must be the doctrine pointer.
    const specIdPattern = /[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+-\d+[a-z]*/g;
    const tokens = repair.match(specIdPattern) ?? [];
    expect(tokens).toEqual(['WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-001']);
  });

  test('does NOT fire H5 when specB also claims the same worktree (no contradiction)', () => {
    const specA = makeSpec({ id: 'OK-A-1', worktree: 'wt-shared' });
    const specB = makeSpec({ id: 'OK-B-1', worktree: 'wt-shared' });
    const input = makeInput({
      specs: [specA, specB],
      worktrees: makeRegistry({
        'wt-shared': { specId: 'OK-B-1' },
      }),
    });

    const report = inspectProjectState(input);

    expect(
      report.findings.find(
        (f) => f.rule === DOCTOR_RULES.WORKTREE_BINDING_CONTRADICTION_3WAY
      )
    ).toBeUndefined();
  });

  test('does NOT fire H5 when there is no specA claiming the worktree (plain one-sided)', () => {
    const specB = makeSpec({ id: 'PLAIN-B-1', worktree: undefined });
    const input = makeInput({
      specs: [specB],
      worktrees: makeRegistry({
        'wt-onesided': { specId: 'PLAIN-B-1' },
      }),
    });

    const report = inspectProjectState(input);

    expect(
      report.findings.find(
        (f) => f.rule === DOCTOR_RULES.WORKTREE_BINDING_CONTRADICTION_3WAY
      )
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// H6 — foreign physical worktree
// ---------------------------------------------------------------------------

describe('WORKTREE-DOCTOR-HALF-STATE-001 H6 — foreign physical', () => {
  test('fires WORKTREE_FOREIGN_PHYSICAL (INFO) when git list has a path not in registry', () => {
    const input = makeInput({
      specs: [],
      worktrees: makeRegistry({}),
      gitWorktrees: [
        { path: '/tmp/foreign-wt', branch: 'refs/heads/feature' },
      ],
    });

    const report = inspectProjectState(input);

    const finding = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.WORKTREE_FOREIGN_PHYSICAL
    );
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('info');
    expect(finding!.subject).toBe('/tmp/foreign-wt');
    expect(finding!.data).toMatchObject({
      path: '/tmp/foreign-wt',
      branch: 'refs/heads/feature',
    });
  });

  test('does NOT fire H6 when the git-listed path matches a registry entry path', () => {
    const input = makeInput({
      specs: [],
      worktrees: makeRegistry({
        'wt-known': { specId: 'X-1', path: '/tmp/known-wt' },
      }),
      gitWorktrees: [{ path: '/tmp/known-wt' }],
    });

    const report = inspectProjectState(input);

    expect(
      report.findings.find(
        (f) => f.rule === DOCTOR_RULES.WORKTREE_FOREIGN_PHYSICAL
      )
    ).toBeUndefined();
  });

  test('silently SKIPS H6 when gitWorktrees is unavailable', () => {
    const input = makeInput({
      specs: [],
      worktrees: makeRegistry({}),
      // gitWorktrees omitted
    });

    const report = inspectProjectState(input);

    expect(
      report.findings.find(
        (f) => f.rule === DOCTOR_RULES.WORKTREE_FOREIGN_PHYSICAL
      )
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Git observation unavailable — non-fatal graceful behavior
// ---------------------------------------------------------------------------

describe('WORKTREE-DOCTOR-HALF-STATE-001 — git observation unavailable', () => {
  test('emits WORKTREE_GIT_OBSERVATION_UNAVAILABLE (INFO) when gitObservationFailure is set', () => {
    const input = makeInput({
      specs: [],
      worktrees: makeRegistry({}),
      gitObservationFailure: 'git worktree list exited 128: not a git repository',
    });

    const report = inspectProjectState(input);

    const finding = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.WORKTREE_GIT_OBSERVATION_UNAVAILABLE
    );
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('info');
    expect(finding!.data).toMatchObject({
      reason: 'git worktree list exited 128: not a git repository',
    });
  });

  test('the rest of the report still runs when git observation failed (non-fatal)', () => {
    // Inject an H3 fixture AND a git observation failure. Verify H3
    // still fires; verify H1/H6 do NOT fire (gracefully skipped).
    const spec = makeSpec({
      id: 'NONFATAL-1',
      worktree: 'wt-orphan',
    });
    const input = makeInput({
      specs: [spec],
      worktrees: makeRegistry({}),
      gitObservationFailure: 'git not installed',
    });

    const report = inspectProjectState(input);

    // H3 still fires.
    expect(
      report.findings.find(
        (f) => f.rule === DOCTOR_RULES.BINDING_SPEC_MISSING_REGISTRY
      )
    ).toBeDefined();

    // H1 and H6 do not fire (no input to detect them).
    expect(
      report.findings.find(
        (f) => f.rule === DOCTOR_RULES.WORKTREE_GHOST_REGISTRY_ENTRY
      )
    ).toBeUndefined();
    expect(
      report.findings.find(
        (f) => f.rule === DOCTOR_RULES.WORKTREE_FOREIGN_PHYSICAL
      )
    ).toBeUndefined();

    // Git-unavailable INFO is present.
    expect(
      report.findings.find(
        (f) => f.rule === DOCTOR_RULES.WORKTREE_GIT_OBSERVATION_UNAVAILABLE
      )
    ).toBeDefined();
  });

  test('does NOT emit git_observation_unavailable when gitObservationFailure is absent', () => {
    const input = makeInput({
      specs: [],
      worktrees: makeRegistry({}),
      gitWorktrees: [],
    });

    const report = inspectProjectState(input);

    expect(
      report.findings.find(
        (f) => f.rule === DOCTOR_RULES.WORKTREE_GIT_OBSERVATION_UNAVAILABLE
      )
    ).toBeUndefined();
  });
});
