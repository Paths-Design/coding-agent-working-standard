/**
 * Slice 7c.1 — vNext input-surface facts on StoreSnapshot / DoctorInput.
 *
 * Doctor (kernel) does not stat the filesystem. The store does, and the
 * kernel consumes the booleans. These tests pin three contracts:
 *
 *   1. composeStoreSnapshot populates initResidue + filesystem +
 *      registryDiagnostics correctly across canonical, residue, and
 *      missing-file scenarios.
 *
 *   2. composeDoctorSnapshot projects all three onto DoctorInput
 *      so 7c.2 rules can fire off them.
 *
 *   3. Adding the input surface alone does NOT yet produce any new
 *      doctor.init.* / doctor.registry.* finding — those land in 7c.2.
 *      This test makes the "no rules yet" boundary explicit so 7c.2
 *      can flip the assertion without ambiguity.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  composeStoreSnapshot,
  composeDoctorSnapshot,
} = require('../../dist/store');
const { inspectProjectState } = require('@paths.design/caws-kernel');

const NOW = new Date('2026-05-15T12:00:00.000Z');

function mkTempCawsDir(prefix = 'caws-7c1-') {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const cawsDir = path.join(repoRoot, '.caws');
  return { repoRoot, cawsDir };
}

const VALID_POLICY = `version: 1
risk_tiers:
  '1': { max_files: 5, max_loc: 200 }
  '2': { max_files: 15, max_loc: 600 }
  '3': { max_files: 30, max_loc: 1500 }
gates:
  budget_limit:     { enabled: true, mode: block }
  spec_completeness:{ enabled: true, mode: block }
  scope_boundary:   { enabled: true, mode: block }
`;

// ============================================================
// initResidue
// ============================================================
describe('StoreSnapshot.initResidue', () => {
  it('reports both flags false on a clean canonical layout', () => {
    const { repoRoot, cawsDir } = mkTempCawsDir();
    try {
      fs.mkdirSync(cawsDir, { recursive: true });
      fs.writeFileSync(path.join(cawsDir, 'policy.yaml'), VALID_POLICY);

      const snap = composeStoreSnapshot({ repoRoot, cawsDir });
      expect(snap.initResidue.workingSpecYaml).toBe(false);
      expect(snap.initResidue.workingSpecSchemaJson).toBe(false);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('reports workingSpecYaml=true when the legacy file exists', () => {
    const { repoRoot, cawsDir } = mkTempCawsDir();
    try {
      fs.mkdirSync(cawsDir, { recursive: true });
      fs.writeFileSync(
        path.join(cawsDir, 'working-spec.yaml'),
        'id: LEGACY-1\n'
      );

      const snap = composeStoreSnapshot({ repoRoot, cawsDir });
      expect(snap.initResidue.workingSpecYaml).toBe(true);
      expect(snap.initResidue.workingSpecSchemaJson).toBe(false);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('reports workingSpecSchemaJson=true when the legacy schema exists', () => {
    const { repoRoot, cawsDir } = mkTempCawsDir();
    try {
      fs.mkdirSync(cawsDir, { recursive: true });
      fs.writeFileSync(
        path.join(cawsDir, 'working-spec.schema.json'),
        '{}'
      );

      const snap = composeStoreSnapshot({ repoRoot, cawsDir });
      expect(snap.initResidue.workingSpecSchemaJson).toBe(true);
      expect(snap.initResidue.workingSpecYaml).toBe(false);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('treats a directory at the legacy path as not-a-file (so dirs do not trigger residue)', () => {
    // Defensive: a directory named working-spec.yaml is legacy-shape
    // pollution, but it's a different problem than a real residual file
    // and shouldn't fire the file-present rule. fs.statSync().isFile()
    // will be false for a directory, so the snapshot reports false here.
    const { repoRoot, cawsDir } = mkTempCawsDir();
    try {
      fs.mkdirSync(path.join(cawsDir, 'working-spec.yaml'), { recursive: true });
      const snap = composeStoreSnapshot({ repoRoot, cawsDir });
      expect(snap.initResidue.workingSpecYaml).toBe(false);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

// ============================================================
// filesystem facts
// ============================================================
describe('StoreSnapshot.filesystem', () => {
  it('reports every canonical surface as missing on an uninitialized repo', () => {
    const { repoRoot, cawsDir } = mkTempCawsDir();
    try {
      // No .caws/ at all.
      const snap = composeStoreSnapshot({ repoRoot, cawsDir });
      expect(snap.filesystem).toEqual({
        cawsDirExists: false,
        specsDirExists: false,
        waiversDirExists: false,
        policyYamlExists: false,
        worktreesJsonExists: false,
        agentsJsonExists: false,
        eventsJsonlExists: false,
      });
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('reports every canonical surface as present after a full bootstrap (no events.jsonl required)', () => {
    const { repoRoot, cawsDir } = mkTempCawsDir();
    try {
      fs.mkdirSync(path.join(cawsDir, 'specs'), { recursive: true });
      fs.mkdirSync(path.join(cawsDir, 'waivers'), { recursive: true });
      fs.writeFileSync(path.join(cawsDir, 'policy.yaml'), VALID_POLICY);
      fs.writeFileSync(path.join(cawsDir, 'worktrees.json'), '{}\n');
      fs.writeFileSync(path.join(cawsDir, 'agents.json'), '{}\n');
      // events.jsonl deliberately omitted — first append creates it.

      const snap = composeStoreSnapshot({ repoRoot, cawsDir });
      expect(snap.filesystem).toEqual({
        cawsDirExists: true,
        specsDirExists: true,
        waiversDirExists: true,
        policyYamlExists: true,
        worktreesJsonExists: true,
        agentsJsonExists: true,
        eventsJsonlExists: false,
      });
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('reports eventsJsonlExists=true once the file lands on disk', () => {
    const { repoRoot, cawsDir } = mkTempCawsDir();
    try {
      fs.mkdirSync(cawsDir, { recursive: true });
      fs.writeFileSync(path.join(cawsDir, 'events.jsonl'), '');
      const snap = composeStoreSnapshot({ repoRoot, cawsDir });
      expect(snap.filesystem.eventsJsonlExists).toBe(true);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('reports a partially-initialized layout precisely', () => {
    // policy and specs/ present; waivers/ + registries missing.
    const { repoRoot, cawsDir } = mkTempCawsDir();
    try {
      fs.mkdirSync(path.join(cawsDir, 'specs'), { recursive: true });
      fs.writeFileSync(path.join(cawsDir, 'policy.yaml'), VALID_POLICY);

      const snap = composeStoreSnapshot({ repoRoot, cawsDir });
      expect(snap.filesystem.cawsDirExists).toBe(true);
      expect(snap.filesystem.specsDirExists).toBe(true);
      expect(snap.filesystem.policyYamlExists).toBe(true);
      expect(snap.filesystem.waiversDirExists).toBe(false);
      expect(snap.filesystem.worktreesJsonExists).toBe(false);
      expect(snap.filesystem.agentsJsonExists).toBe(false);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

// ============================================================
// registryDiagnostics
// ============================================================
describe('StoreSnapshot.registryDiagnostics', () => {
  it('is empty when both registries are absent (missing != malformed)', () => {
    const { repoRoot, cawsDir } = mkTempCawsDir();
    try {
      fs.mkdirSync(cawsDir, { recursive: true });
      const snap = composeStoreSnapshot({ repoRoot, cawsDir });
      expect(snap.registryDiagnostics).toEqual([]);
      // Sanity: snapshot still falls back to the empty registries.
      expect(snap.worktrees).toEqual({});
      expect(snap.agents).toEqual({});
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('surfaces a worktrees.json malformed-shape diagnostic', () => {
    const { repoRoot, cawsDir } = mkTempCawsDir();
    try {
      fs.mkdirSync(cawsDir, { recursive: true });
      // Array, not an object → REGISTRY_NOT_OBJECT.
      fs.writeFileSync(path.join(cawsDir, 'worktrees.json'), '[]');
      const snap = composeStoreSnapshot({ repoRoot, cawsDir });
      expect(snap.registryDiagnostics.length).toBeGreaterThan(0);
      expect(snap.registryDiagnostics[0].rule).toBe('store.registry.not_object');
      // Snapshot still falls back so downstream code keeps working.
      expect(snap.worktrees).toEqual({});
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('surfaces an agents.json malformed-shape diagnostic', () => {
    const { repoRoot, cawsDir } = mkTempCawsDir();
    try {
      fs.mkdirSync(cawsDir, { recursive: true });
      fs.writeFileSync(path.join(cawsDir, 'agents.json'), '"a string"');
      const snap = composeStoreSnapshot({ repoRoot, cawsDir });
      expect(snap.registryDiagnostics.length).toBeGreaterThan(0);
      expect(
        snap.registryDiagnostics.some(
          (d) => d.rule === 'store.registry.not_object'
        )
      ).toBe(true);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

// ============================================================
// composeDoctorSnapshot projection
// ============================================================
describe('composeDoctorSnapshot projects new fields onto DoctorInput', () => {
  it('forwards initResidue, filesystem, and registryDiagnostics into DoctorInput', () => {
    const { repoRoot, cawsDir } = mkTempCawsDir();
    try {
      fs.mkdirSync(cawsDir, { recursive: true });
      fs.writeFileSync(
        path.join(cawsDir, 'working-spec.yaml'),
        'id: LEGACY-1\n'
      );
      // Force a malformed registry to populate registryDiagnostics too.
      fs.writeFileSync(path.join(cawsDir, 'worktrees.json'), '[]');

      const { snapshot, doctorInput } = composeDoctorSnapshot({
        repoRoot,
        cawsDir,
        now: NOW,
      });

      // The snapshot's facts arrive on DoctorInput verbatim.
      expect(doctorInput.initResidue).toEqual(snapshot.initResidue);
      expect(doctorInput.filesystem).toEqual(snapshot.filesystem);
      expect(doctorInput.registryDiagnostics).toEqual(
        snapshot.registryDiagnostics
      );
      // And the legacy fact is the one we planted.
      expect(doctorInput.initResidue.workingSpecYaml).toBe(true);
      expect(doctorInput.registryDiagnostics.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

// ============================================================
// 7c.1 boundary — input present, no new doctor rules yet
// ============================================================
describe('7c.1 boundary: no doctor.init.* / doctor.registry.* findings yet', () => {
  it('extending DoctorInput alone does NOT cause any new finding to fire', () => {
    // This test pins the slice boundary. 7c.2 will add the rules and
    // flip these assertions; until then, a project with full residue
    // and a malformed registry must produce zero doctor.init.* /
    // doctor.registry.* findings via the kernel.
    const { repoRoot, cawsDir } = mkTempCawsDir();
    try {
      fs.mkdirSync(cawsDir, { recursive: true });
      fs.writeFileSync(
        path.join(cawsDir, 'working-spec.yaml'),
        'id: LEGACY-1\n'
      );
      fs.writeFileSync(
        path.join(cawsDir, 'working-spec.schema.json'),
        '{}'
      );
      fs.writeFileSync(path.join(cawsDir, 'policy.yaml'), VALID_POLICY);
      fs.writeFileSync(path.join(cawsDir, 'worktrees.json'), '[]');

      const { doctorInput } = composeDoctorSnapshot({
        repoRoot,
        cawsDir,
        now: NOW,
      });
      const report = inspectProjectState(doctorInput);

      const newRulePrefixes = ['doctor.init.', 'doctor.registry.'];
      const newFindings = report.findings.filter((f) =>
        newRulePrefixes.some((p) => f.rule.startsWith(p))
      );
      expect(newFindings).toEqual([]);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
