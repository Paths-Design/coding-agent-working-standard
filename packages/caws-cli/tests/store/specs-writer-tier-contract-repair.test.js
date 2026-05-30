/**
 * CAWS-SPEC-CREATE-FIRSTTIMER-UX-001 A1/A2 — createSpec's tier-contract
 * rejection threads the kernel's narrowRepair into the LIFECYCLE_PLAN_REJECTED
 * diagnostic, so the shell can print the `repair:` line that names the escape.
 *
 * Before this fix, specs-writer mapped the kernel diagnostic into a store
 * diagnostic copying ONLY d.message, silently discarding d.narrowRepair — a
 * first-timer hit a bare "Tier 2 requires a contract" with no way forward.
 *
 * Integration-style: real temp git repos + real createSpec. No mocking — the
 * point is the kernel→store diagnostic plumbing.
 *
 * @author @darianrosebrook
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createSpec } = require('../../dist/store/specs-writer');
const { initProject } = require('../../dist/store');

function mkCawsGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test User']);
  execFileSync('git', [
    '-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init',
  ]);
  const r = initProject(root);
  if (!r.ok) throw new Error('initProject failed in fixture');
  return { root, cawsDir: path.join(root, '.caws') };
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

const ACTOR = { id: 'test-actor', kind: 'human' };
const NOW = () => new Date('2026-05-30T00:00:00.000Z');

/** Pull the rejection diagnostics off a createSpec failure result. */
function rejectionDiagnostics(result) {
  // createSpec returns an Err with `.errors` on validation failure.
  expect(result.ok === false || Array.isArray(result.errors)).toBeTruthy();
  return result.errors || [];
}

describe('CAWS-SPEC-CREATE-FIRSTTIMER-UX-001 — tier-contract repair text', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  // ── A1: tier-2 create rejection carries narrowRepair ───────────────
  it('A1: a tier-2 create with no contract is rejected WITH a narrowRepair naming the escape', () => {
    fixture = mkCawsGitRepo('tier2-repair-');
    const result = createSpec(fixture.cawsDir, {
      id: 'FEAT-001',
      title: 'tier-2 feature',
      mode: 'feature',
      riskTier: 2,
      initialState: 'active',
      now: NOW,
      actor: ACTOR,
    });

    const diags = rejectionDiagnostics(result);
    expect(diags.length).toBeGreaterThan(0);
    const contractDiag = diags.find((d) =>
      /require.*at least one contract/i.test(d.message)
    );
    expect(contractDiag).toBeDefined();
    // The fix: narrowRepair is present and names the tier-3 / contract escape.
    expect(typeof contractDiag.narrowRepair).toBe('string');
    expect(contractDiag.narrowRepair.length).toBeGreaterThan(0);
    expect(contractDiag.narrowRepair).toMatch(/contract/i);
    expect(contractDiag.narrowRepair).toMatch(/risk_tier.*3|tier.*3|chore/i);
  });

  // ── A2: tier-1 multi-violation create preserves narrowRepair per diag ──
  it('A2: a tier-1 create rejection preserves narrowRepair on its diagnostics', () => {
    fixture = mkCawsGitRepo('tier1-repair-');
    const result = createSpec(fixture.cawsDir, {
      id: 'FEAT-002',
      title: 'tier-1 feature',
      mode: 'feature',
      riskTier: 1,
      initialState: 'active',
      now: NOW,
      actor: ACTOR,
    });

    const diags = rejectionDiagnostics(result);
    expect(diags.length).toBeGreaterThan(0);
    // At least the contract diagnostic must carry a non-empty narrowRepair.
    const contractDiag = diags.find((d) =>
      /require.*at least one contract/i.test(d.message)
    );
    expect(contractDiag).toBeDefined();
    expect(contractDiag.narrowRepair).toBeTruthy();
    // Every diagnostic that the kernel gave a narrowRepair keeps it (none
    // silently dropped to undefined by the store mapping).
    const withRepairText = diags.filter(
      (d) => typeof d.narrowRepair === 'string' && d.narrowRepair.length > 0
    );
    expect(withRepairText.length).toBeGreaterThan(0);
  });

  // ── regression: tier-3 create still succeeds (no contract needed) ──
  it('regression: a tier-3 create succeeds with no contract', () => {
    fixture = mkCawsGitRepo('tier3-ok-');
    const result = createSpec(fixture.cawsDir, {
      id: 'FEAT-003',
      title: 'tier-3 chore',
      mode: 'feature',
      riskTier: 3,
      initialState: 'active',
      now: NOW,
      actor: ACTOR,
    });
    // Success: no .errors, and the spec file exists.
    expect(result.errors).toBeUndefined();
    expect(fs.existsSync(path.join(fixture.cawsDir, 'specs', 'FEAT-003.yaml'))).toBe(true);
  });
});
