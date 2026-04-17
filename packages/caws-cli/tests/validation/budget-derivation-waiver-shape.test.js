/**
 * @fileoverview CAWSFIX-13 — validateWaiverStructure accepts modern schema shape.
 * Covers A1-A5 from .caws/specs/CAWSFIX-13.yaml.
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');
const {
  validateWaiverStructure,
  WAIVER_REQUIRED_FIELDS,
  loadWaiver,
  deriveBudget,
} = require('../../src/budget-derivation');

const modernWaiver = () => ({
  id: 'WV-0001',
  applies_to: 'TEST-0001',
  gates: ['budget_limit'],
  delta: { max_files: 5, max_loc: 200 },
  reason_code: 'architectural_refactor',
  description:
    'A modern-shape waiver used to exercise validator parity with .caws/waiver.schema.json.',
  mitigation:
    'Complete migration to modern waiver shape and keep validator in lockstep with the schema.',
  expires_at: '2099-12-31T23:59:59Z',
  risk_owner: 'test-owner',
  approvers: [{ handle: 'tech-lead', approved_at: '2025-01-01T00:00:00Z' }],
  status: 'active',
});

describe('CAWSFIX-13 — validateWaiverStructure (modern shape)', () => {
  test('A1: modern waiver passes validation', () => {
    expect(() => validateWaiverStructure(modernWaiver())).not.toThrow();
  });

  test('A3: waiver missing delta is rejected with message naming delta', () => {
    const w = modernWaiver();
    delete w.delta;
    expect(() => validateWaiverStructure(w)).toThrow(/missing required field: delta/);
  });

  test('A4: legacy string approvers rejected with message naming handle shape', () => {
    const w = modernWaiver();
    w.approvers = ['@alice', 'bob@example.com'];
    expect(() => validateWaiverStructure(w)).toThrow(/handle/);
  });

  test('A4b: empty approvers array rejected', () => {
    const w = modernWaiver();
    w.approvers = [];
    expect(() => validateWaiverStructure(w)).toThrow(/approvers must be a non-empty array/);
  });

  test('A5: required-field list matches .caws/waiver.schema.json:required', () => {
    const schemaPath = path.resolve(__dirname, '../../../../.caws/waiver.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    expect([...WAIVER_REQUIRED_FIELDS].sort()).toEqual([...schema.required].sort());
  });
});

describe('CAWSFIX-13 — loadWaiver round-trips modern shape', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawsfix-13-'));
    fs.mkdirSync(path.join(tempDir, '.caws', 'waivers'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('A1 (end-to-end): loadWaiver returns the waiver, not null', () => {
    const w = modernWaiver();
    fs.writeFileSync(path.join(tempDir, '.caws', 'waivers', 'WV-0001.yaml'), yaml.dump(w));
    const loaded = loadWaiver('WV-0001', tempDir);
    expect(loaded).not.toBeNull();
    expect(loaded.id).toBe('WV-0001');
    expect(loaded.delta.max_files).toBe(5);
  });
});

describe('CAWSFIX-13 — A2 end-to-end budget delta applied', () => {
  let tempDir;
  // Bundled template policy schema requires all three tiers (CAWSFIX-08
  // territory — repo-root schema is more permissive but not yet loaded).
  const policy = {
    version: 1,
    risk_tiers: {
      1: { max_files: 10, max_loc: 500 },
      2: { max_files: 25, max_loc: 1000 },
      3: { max_files: 50, max_loc: 2000 },
    },
    edit_rules: {
      policy_and_code_same_pr: false,
      min_approvers_for_budget_raise: 1,
    },
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawsfix-13-a2-'));
    fs.mkdirSync(path.join(tempDir, '.caws', 'waivers'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.caws', 'policy.yaml'), yaml.dump(policy));
    fs.writeFileSync(
      path.join(tempDir, '.caws', 'waivers', 'WV-0001.yaml'),
      yaml.dump(modernWaiver())
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('A2: effective max_files = baseline + waiver delta (waiver NOT dropped)', async () => {
    const spec = {
      id: 'TEST-0001',
      title: 'Test',
      risk_tier: 2,
      mode: 'feature',
      waiver_ids: ['WV-0001'],
    };
    // useCache: false so a stale entry from another suite cannot win.
    const result = await deriveBudget(spec, tempDir, { useCache: false });
    // Baseline T2 = 25 max_files; waiver adds 5 → 30. Pre-fix: waiver dropped, stays at 25.
    expect(result.effective.max_files).toBe(30);
    expect(result.effective.max_loc).toBe(1200);
  });
});
