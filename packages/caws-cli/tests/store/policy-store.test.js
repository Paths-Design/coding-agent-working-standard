/**
 * Tests for policy-store. Distinguishes:
 *   - missing file → { warnings: [], errors: [] }, no policy
 *   - parseable + valid → { policy, warnings, errors: [] }
 *   - parseable but invalid → { warnings: [], errors: [...] }
 *   - unparseable YAML → errors populated
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadPolicy } = require('../../dist/store');

function mkTempCawsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'caws-policy-store-'));
}

const VALID_POLICY = `
version: 1
risk_tiers:
  "1":
    max_files: 5
    max_loc: 200
  "2":
    max_files: 15
    max_loc: 600
  "3":
    max_files: 30
    max_loc: 1500
gates:
  budget_limit:
    enabled: true
    mode: block
  spec_completeness:
    enabled: true
    mode: block
  scope_boundary:
    enabled: true
    mode: block
  god_object:
    enabled: true
    mode: warn
  todo_detection:
    enabled: true
    mode: warn
`;

describe('loadPolicy', () => {
  let cawsDir;
  afterEach(() => {
    if (cawsDir) fs.rmSync(cawsDir, { recursive: true, force: true });
  });

  it('missing policy.yaml → no errors, no warnings, no policy', () => {
    cawsDir = mkTempCawsDir();
    const r = loadPolicy(cawsDir);
    expect(r.policy).toBeUndefined();
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('valid policy.yaml → policy returned, no errors', () => {
    cawsDir = mkTempCawsDir();
    fs.writeFileSync(path.join(cawsDir, 'policy.yaml'), VALID_POLICY);
    const r = loadPolicy(cawsDir);
    expect(r.policy).toBeDefined();
    expect(r.policy.version).toBe(1);
    expect(r.errors).toEqual([]);
  });

  it('malformed YAML → errors populated, no policy', () => {
    cawsDir = mkTempCawsDir();
    fs.writeFileSync(path.join(cawsDir, 'policy.yaml'), 'this: : invalid:');
    const r = loadPolicy(cawsDir);
    expect(r.policy).toBeUndefined();
    expect(r.errors.length).toBeGreaterThan(0);
  });
});
