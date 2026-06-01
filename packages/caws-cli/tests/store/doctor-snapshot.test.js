/**
 * Tests for composeDoctorSnapshot: end-to-end loading from a temp .caws/
 * directory, feeding into the kernel's inspectProjectState, asserting
 * deterministic output.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  appendEvent,
  composeDoctorSnapshot,
  composeStoreSnapshot,
} = require('../../dist/store');
const { inspectProjectState, DOCTOR_RULES } = require('@paths.design/caws-kernel');

const NOW = new Date('2026-05-12T12:00:00.000Z');

function mkTempCawsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'caws-snapshot-'));
}

const VALID_SPEC = (id, lifecycle = 'active') => `
id: ${id}
title: A reasonably long title for the feature being shipped
risk_tier: 3
mode: feature
lifecycle_state: ${lifecycle}
updated_at: '2026-05-12T11:59:30.000Z'
blast_radius:
  modules: [src/test]
scope:
  in: ["src/**"]
invariants: ["Some invariant statement."]
acceptance:
  - id: A1
    given: a precondition
    when: an action
    then: an outcome
non_functional: {}
contracts: []
`;

const VALID_POLICY = `
version: 1
risk_tiers:
  "1": { max_files: 5, max_loc: 200 }
  "2": { max_files: 15, max_loc: 600 }
  "3": { max_files: 30, max_loc: 1500 }
gates:
  budget_limit: { enabled: true, mode: block }
  spec_completeness: { enabled: true, mode: block }
  scope_boundary: { enabled: true, mode: block }
  god_object: { enabled: true, mode: warn }
  todo_detection: { enabled: true, mode: warn }
`;

describe('composeStoreSnapshot — full state assembly', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it('aggregates specs, policy, registries, events into a snapshot', () => {
    cawsDir = mkTempCawsDir();
    fs.mkdirSync(path.join(cawsDir, 'specs'), { recursive: true });
    fs.writeFileSync(path.join(cawsDir, 'specs', 'FOO-1.yaml'), VALID_SPEC('FOO-1'));
    fs.writeFileSync(path.join(cawsDir, 'policy.yaml'), VALID_POLICY);
    fs.writeFileSync(
      path.join(cawsDir, 'worktrees.json'),
      JSON.stringify({
        'wt-foo': { specId: 'FOO-1' },
      })
    );
    fs.writeFileSync(
      path.join(cawsDir, 'agents.json'),
      JSON.stringify({
        'sess-1': { session_id: 'sess-1', last_active: NOW.toISOString() },
      })
    );
    appendEvent(cawsDir, {
      event: 'spec_created',
      ts: NOW.toISOString(),
      actor: { kind: 'agent', id: 'darian' },
      spec_id: 'FOO-1',
      data: {
        title: 'Test feature',
        risk_tier: 3,
        mode: 'feature',
        lifecycle_state: 'draft',
      },
    });

    const snap = composeStoreSnapshot({ repoRoot: cawsDir, cawsDir });
    expect(snap.specs.map((s) => s.id)).toEqual(['FOO-1']);
    expect(snap.policy).toBeDefined();
    expect(snap.worktrees['wt-foo']).toBeDefined();
    expect(snap.agents['sess-1']).toBeDefined();
    expect(snap.events).toHaveLength(1);
    expect(snap.eventWarnings).toEqual([]);
  });

  it('missing .caws/ contents → empty snapshot with no errors', () => {
    cawsDir = mkTempCawsDir();
    const snap = composeStoreSnapshot({ repoRoot: cawsDir, cawsDir });
    expect(snap.specs).toEqual([]);
    expect(snap.policy).toBeUndefined();
    expect(snap.policyErrors).toEqual([]);
    expect(snap.worktrees).toEqual({});
    expect(snap.agents).toEqual({});
    expect(snap.events).toEqual([]);
  });
});

describe('composeDoctorSnapshot → inspectProjectState (end-to-end)', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it('hands a valid snapshot to the kernel and produces a clean DoctorReport', () => {
    cawsDir = mkTempCawsDir();
    fs.mkdirSync(path.join(cawsDir, 'specs'), { recursive: true });
    // Slice 7c.2 layout-missing rules require waivers/ and agents.json
    // to be present to declare the project canonically initialized.
    // Without these, doctor would emit waivers_dir_missing and
    // agents_registry_missing warnings (correctly — doctor is doing its
    // job; this test wasn't covering the full canonical layout).
    fs.mkdirSync(path.join(cawsDir, 'waivers'), { recursive: true });
    fs.writeFileSync(
      path.join(cawsDir, 'specs', 'FOO-1.yaml'),
      VALID_SPEC('FOO-1') + 'worktree: wt-foo\n'
    );
    fs.writeFileSync(path.join(cawsDir, 'policy.yaml'), VALID_POLICY);
    fs.writeFileSync(
      path.join(cawsDir, 'worktrees.json'),
      JSON.stringify({ 'wt-foo': { specId: 'FOO-1' } })
    );
    // AGENT-LIVENESS-DOCTOR-001 (D10): the H1 ghost rule no longer silently
    // skips when git observation is unavailable — the canonical-dir fact alone
    // now flags a registry entry whose dir is gone (that silent skip was the
    // D10 defect). This fixture intends a CLEAN valid project, so the backing
    // worktree dir must actually exist; otherwise wt-foo is a legitimate ghost.
    fs.mkdirSync(path.join(cawsDir, 'worktrees', 'wt-foo'), { recursive: true });
    fs.writeFileSync(path.join(cawsDir, 'agents.json'), '{}');

    const { snapshot, doctorInput } = composeDoctorSnapshot({
      repoRoot: cawsDir,
      cawsDir,
      now: NOW,
    });
    expect(snapshot.specs).toHaveLength(1);
    expect(doctorInput.specs).toHaveLength(1);
    expect(doctorInput.now).toBe(NOW);

    const report = inspectProjectState(doctorInput);
    expect(report.clean).toBe(true);
    // WORKTREE-DOCTOR-HALF-STATE-001: this fixture uses `cawsDir` as
    // repoRoot, which is a non-git tempdir. observeGitWorktrees fails
    // (legitimately — there is no git repo to inspect), and doctor
    // emits a single INFO finding to make the gap visible. clean is
    // still true because INFO does not unset clean; H1/H6 silently
    // skip; no other rules fire on this otherwise-valid fixture.
    expect(report.findings.map((f) => f.rule)).toEqual([
      DOCTOR_RULES.WORKTREE_GIT_OBSERVATION_UNAVAILABLE,
    ]);
    expect(report.findings[0].severity).toBe('info');
  });

  it('surfaces POLICY_MISSING when there is no policy.yaml', () => {
    cawsDir = mkTempCawsDir();
    const { doctorInput } = composeDoctorSnapshot({
      repoRoot: cawsDir,
      cawsDir,
      now: NOW,
    });
    const report = inspectProjectState(doctorInput);
    expect(report.findings.map((f) => f.rule)).toContain(DOCTOR_RULES.POLICY_MISSING);
  });

  it('propagates load diagnostics through StoreSnapshot, not DoctorInput', () => {
    cawsDir = mkTempCawsDir();
    fs.mkdirSync(path.join(cawsDir, 'specs'), { recursive: true });
    fs.writeFileSync(
      path.join(cawsDir, 'specs', 'BROKEN.yaml'),
      'this: : invalid: yaml: :'
    );
    fs.writeFileSync(path.join(cawsDir, 'policy.yaml'), VALID_POLICY);

    const { snapshot, doctorInput } = composeDoctorSnapshot({
      repoRoot: cawsDir,
      cawsDir,
      now: NOW,
    });
    // The invalid spec did NOT make it into DoctorInput.specs.
    expect(doctorInput.specs).toEqual([]);
    // But the diagnostic is on the StoreSnapshot for the shell to render.
    expect(snapshot.specDiagnostics.length).toBeGreaterThan(0);
  });

  it('passes injected `now` and optional templates through to DoctorInput', () => {
    cawsDir = mkTempCawsDir();
    fs.writeFileSync(path.join(cawsDir, 'policy.yaml'), VALID_POLICY);
    const templates = [
      {
        template_id: 'spec/feature.yaml',
        errors: [],
        warnings: [],
      },
    ];
    const { doctorInput } = composeDoctorSnapshot({
      repoRoot: cawsDir,
      cawsDir,
      now: NOW,
      templates,
      staleAgentTtlMs: 3600_000,
      unboundActiveThresholdMs: 5_000,
      priorOwnersGrowthThreshold: 10,
    });
    expect(doctorInput.now).toBe(NOW);
    expect(doctorInput.templates).toBe(templates);
    expect(doctorInput.staleAgentTtlMs).toBe(3600_000);
    expect(doctorInput.unboundActiveThresholdMs).toBe(5_000);
    expect(doctorInput.priorOwnersGrowthThreshold).toBe(10);
  });
});

// =====================================================================
// CAWS-DOCTOR-HOOKS-NO-CAWS-DRIFT-001:
// observeHookPackInstalled + end-to-end INIT_HOOKS_PRESENT_CAWS_ABSENT.
// Distinct repoRoot != cawsDir layout: a repo with .claude/hooks/ present
// and .caws/ absent. Exercises the real filesystem observation, not just
// the hand-fed kernel rule.
// =====================================================================
describe('hookPackInstalled observation (CAWS-DOCTOR-HOOKS-NO-CAWS-DRIFT-001)', () => {
  let repoRoot;
  afterEach(() => {
    if (repoRoot) fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  function mkRepoRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'caws-hookpack-'));
  }

  function installHook(root, name) {
    const hooksDir = path.join(root, '.claude', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, name), '#!/bin/bash\nexit 0\n');
  }

  it('marker hook present + no .caws/ → hookPackInstalled=true and finding fires', () => {
    repoRoot = mkRepoRoot();
    installHook(repoRoot, 'scope-guard.sh'); // a CAWS marker hook
    const cawsDir = path.join(repoRoot, '.caws'); // intentionally NOT created

    const snap = composeStoreSnapshot({ repoRoot, cawsDir });
    expect(snap.filesystem.hookPackInstalled).toBe(true);
    expect(snap.filesystem.cawsDirExists).toBe(false);

    const { doctorInput } = composeDoctorSnapshot({ repoRoot, cawsDir, now: NOW });
    const report = inspectProjectState(doctorInput);
    const f = report.findings.find(
      (x) => x.rule === DOCTOR_RULES.INIT_HOOKS_PRESENT_CAWS_ABSENT
    );
    expect(f).toBeDefined();
    expect(f.severity).toBe('warning');
    expect(f.narrowRepair).toContain('caws init');
  });

  it('the OTHER marker hook (worktree-write-guard.sh) alone also counts', () => {
    repoRoot = mkRepoRoot();
    installHook(repoRoot, 'worktree-write-guard.sh');
    const cawsDir = path.join(repoRoot, '.caws');
    const snap = composeStoreSnapshot({ repoRoot, cawsDir });
    expect(snap.filesystem.hookPackInstalled).toBe(true);
  });

  it('a bare .claude/hooks/ with only a NON-CAWS hook → hookPackInstalled=false', () => {
    repoRoot = mkRepoRoot();
    installHook(repoRoot, 'some-unrelated-hook.sh');
    const cawsDir = path.join(repoRoot, '.caws');
    const snap = composeStoreSnapshot({ repoRoot, cawsDir });
    expect(snap.filesystem.hookPackInstalled).toBe(false);
    // And therefore the finding does NOT fire.
    const { doctorInput } = composeDoctorSnapshot({ repoRoot, cawsDir, now: NOW });
    const report = inspectProjectState(doctorInput);
    expect(
      report.findings.some(
        (x) => x.rule === DOCTOR_RULES.INIT_HOOKS_PRESENT_CAWS_ABSENT
      )
    ).toBe(false);
  });

  it('marker hook present AND .caws/ present → finding does NOT fire (initialized)', () => {
    repoRoot = mkRepoRoot();
    installHook(repoRoot, 'scope-guard.sh');
    const cawsDir = path.join(repoRoot, '.caws');
    fs.mkdirSync(cawsDir, { recursive: true });
    fs.writeFileSync(path.join(cawsDir, 'policy.yaml'), VALID_POLICY);

    const snap = composeStoreSnapshot({ repoRoot, cawsDir });
    expect(snap.filesystem.hookPackInstalled).toBe(true);
    expect(snap.filesystem.cawsDirExists).toBe(true);

    const { doctorInput } = composeDoctorSnapshot({ repoRoot, cawsDir, now: NOW });
    const report = inspectProjectState(doctorInput);
    expect(
      report.findings.some(
        (x) => x.rule === DOCTOR_RULES.INIT_HOOKS_PRESENT_CAWS_ABSENT
      )
    ).toBe(false);
  });
});
