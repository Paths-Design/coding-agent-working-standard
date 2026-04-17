/**
 * @fileoverview CAWSFIX-07 — Budget derivation no-ops cleanly when spec has no
 * change_budget (D4). Also covers the sync variant (`deriveBudgetSync`) used
 * by `validateWorkingSpecWithSuggestions`, which was the site of the real
 * crash: it called the async `deriveBudget` without awaiting and then read
 * `.effective.max_files` on a Promise.
 *
 * @author CAWSFIX-07 implementation
 */

const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');
const {
  deriveBudget,
  deriveBudgetSync,
} = require('../../src/budget-derivation');

describe('CAWSFIX-07 — Budget derivation without change_budget (D4)', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `caws-cawsfix07-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await fs.mkdir(path.join(tempDir, '.caws'), { recursive: true });
  });

  afterEach(async () => {
    try {
      if (process.cwd().startsWith(tempDir)) process.chdir(__dirname);
    } catch (_) { /* ignore */ }
    await fs.remove(tempDir);
  });

  const writePolicy = async (policy) => {
    await fs.writeFile(
      path.join(tempDir, '.caws', 'policy.yaml'),
      yaml.dump(policy),
      'utf8'
    );
  };

  const standardPolicy = {
    version: 1,
    risk_tiers: {
      1: { max_files: 25, max_loc: 1000 },
      2: { max_files: 50, max_loc: 2000 },
      3: { max_files: 100, max_loc: 5000 },
    },
  };

  // ---------------------------------------------------------------------------
  // A1 — spec with no `change_budget` does not crash
  // ---------------------------------------------------------------------------
  describe('A1: spec without change_budget does not crash (sync path)', () => {
    test('deriveBudgetSync on spec without change_budget returns policy baseline (no throw)', async () => {
      await writePolicy(standardPolicy);
      const spec = {
        id: 'TEST-001',
        title: 'No budget',
        risk_tier: 2,
        mode: 'development',
        // intentionally NO change_budget key
      };

      let result;
      expect(() => {
        result = deriveBudgetSync(spec, tempDir);
      }).not.toThrow();

      expect(result).toBeDefined();
      expect(result.baseline).toEqual({ max_files: 50, max_loc: 2000 });
      expect(result.effective).toEqual({ max_files: 50, max_loc: 2000 });
    });

    test('deriveBudgetSync returns a .effective.max_files that is a number (was the crash surface)', async () => {
      await writePolicy(standardPolicy);
      const spec = { id: 'TEST-002', title: 'X', risk_tier: 3, mode: 'development' };

      const result = deriveBudgetSync(spec, tempDir);

      // The historical crash was checkBudgetCompliance reading
      // derivedBudget.effective.max_files on a Promise — so this assertion
      // documents that effective.max_files is materialized.
      expect(typeof result.effective.max_files).toBe('number');
      expect(result.effective.max_files).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // A2 — policy baseline is returned for the declared risk_tier
  // ---------------------------------------------------------------------------
  describe('A2: policy baseline returned for each declared tier', () => {
    test.each([
      [1, 25, 1000],
      [2, 50, 2000],
      [3, 100, 5000],
    ])('risk_tier=%i → max_files=%i, max_loc=%i', async (tier, files, loc) => {
      await writePolicy(standardPolicy);
      const spec = { id: `TEST-T${tier}`, title: 'tier test', risk_tier: tier, mode: 'development' };

      const result = deriveBudgetSync(spec, tempDir);

      expect(result.baseline).toEqual({ max_files: files, max_loc: loc });
      expect(result.effective).toEqual({ max_files: files, max_loc: loc });
    });

    test('string risk_tier like "T2" normalizes to tier 2', async () => {
      await writePolicy(standardPolicy);
      const spec = { id: 'TEST-003', title: 'X', risk_tier: 'T2', mode: 'development' };

      const result = deriveBudgetSync(spec, tempDir);

      expect(result.baseline.max_files).toBe(50);
    });
  });

  // ---------------------------------------------------------------------------
  // A3 — missing tier in policy throws with a clear, named error
  // ---------------------------------------------------------------------------
  describe('A3: missing tier in policy throws clear error', () => {
    test('spec.risk_tier=5 against policy with only 1,2,3 throws with "Risk tier 5 not defined"', async () => {
      await writePolicy(standardPolicy);
      const spec = { id: 'TEST-004', title: 'X', risk_tier: 5, mode: 'development' };

      expect(() => {
        deriveBudgetSync(spec, tempDir);
      }).toThrow(/Risk tier 5 not defined/);
    });

    test('missing-tier error is NOT a TypeError (no "undefined" undefined-read)', async () => {
      await writePolicy(standardPolicy);
      const spec = { id: 'TEST-005', title: 'X', risk_tier: 99, mode: 'development' };

      let err;
      try {
        deriveBudgetSync(spec, tempDir);
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      expect(err).not.toBeInstanceOf(TypeError);
      expect(String(err.message)).not.toMatch(/Cannot read properties of undefined/);
    });
  });

  // ---------------------------------------------------------------------------
  // A4 — waiver deltas apply on top of the policy baseline
  // ---------------------------------------------------------------------------
  describe('A4: waiver deltas apply on top of policy baseline', () => {
    // NOTE: this fixture matches the shape `validateWaiverStructure` in
    // budget-derivation.js currently enforces (requires `title`, `reason`,
    // `approvers: string[]`). That shape DIVERGES from
    // .caws/waiver.schema.json (which requires `reason_code`, `mitigation`,
    // `approvers: [{handle, approved_at}]`). The two definitions being out of
    // sync is a real follow-up bug to file — outside CAWSFIX-07's scope.
    const writeWaiver = async (id, delta, status = 'active') => {
      const waiver = {
        id,
        title: `Test waiver ${id}`,
        reason: 'test',
        status,
        gates: ['budget_limit'],
        delta,
        expires_at: '2099-12-31T23:59:59Z',
        approvers: ['test@example.com'],
      };
      await fs.mkdir(path.join(tempDir, '.caws', 'waivers'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, '.caws', 'waivers', `${id}.yaml`),
        yaml.dump(waiver),
        'utf8'
      );
    };

    test('waiver_ids with delta.max_files=10 adds to baseline (no change_budget present)', async () => {
      await writePolicy(standardPolicy);
      await writeWaiver('WV-0001', { max_files: 10, max_loc: 500 });

      const spec = {
        id: 'TEST-006',
        title: 'with waiver, no budget',
        risk_tier: 2,
        mode: 'development',
        waiver_ids: ['WV-0001'],
      };

      const result = deriveBudgetSync(spec, tempDir);

      expect(result.baseline).toEqual({ max_files: 50, max_loc: 2000 });
      expect(result.effective).toEqual({ max_files: 60, max_loc: 2500 });
    });

    test('cumulative waivers add deltas together on top of policy baseline', async () => {
      await writePolicy(standardPolicy);
      await writeWaiver('WV-0001', { max_files: 10, max_loc: 500 });
      await writeWaiver('WV-0002', { max_files: 5, max_loc: 100 });

      const spec = {
        id: 'TEST-006',
        title: 'X',
        risk_tier: 2,
        mode: 'development',
        waiver_ids: ['WV-0001', 'WV-0002'],
      };

      const result = deriveBudgetSync(spec, tempDir);

      expect(result.effective.max_files).toBe(65);
      expect(result.effective.max_loc).toBe(2600);
    });

    test('expired waiver is ignored by sync path', async () => {
      await writePolicy(standardPolicy);
      const expiredWaiver = {
        id: 'WV-9999',
        title: 'Expired test waiver',
        reason: 'test',
        status: 'active',
        gates: ['budget_limit'],
        delta: { max_files: 1000, max_loc: 1000000 },
        expires_at: '2020-01-01T00:00:00Z', // way in the past
        approvers: ['test@example.com'],
      };
      await fs.mkdir(path.join(tempDir, '.caws', 'waivers'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, '.caws', 'waivers', 'WV-9999.yaml'),
        yaml.dump(expiredWaiver),
        'utf8'
      );

      const spec = {
        id: 'TEST-006',
        title: 'X',
        risk_tier: 2,
        mode: 'development',
        waiver_ids: ['WV-9999'],
      };

      const result = deriveBudgetSync(spec, tempDir);

      // Expired waiver must NOT inflate the budget
      expect(result.effective).toEqual({ max_files: 50, max_loc: 2000 });
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-check — async `deriveBudget` path still behaves identically on the
  // no-change_budget case (regression check for a shared contract)
  // ---------------------------------------------------------------------------
  describe('async parity: deriveBudget behaves identically on no-change_budget specs', () => {
    test('async deriveBudget returns same shape as deriveBudgetSync for spec without change_budget', async () => {
      await writePolicy(standardPolicy);
      const spec = { id: 'TEST-007', title: 'parity', risk_tier: 2, mode: 'development' };

      const syncResult = deriveBudgetSync(spec, tempDir);
      const asyncResult = await deriveBudget(spec, tempDir);

      expect(syncResult.baseline).toEqual(asyncResult.baseline);
      expect(syncResult.effective).toEqual(asyncResult.effective);
    });
  });
});
