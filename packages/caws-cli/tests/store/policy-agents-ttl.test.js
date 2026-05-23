/**
 * SESSION-OWNERSHIP-METADATA-001 commit 2 — policy schema tests for
 * agents.last_modified_paths_ttl_seconds.
 *
 * Covers A10:
 *   - key is optional (absent → no error)
 *   - default 1800 (consumed by upstream callers, not by the writer)
 *   - bounds [60, 86400]
 *   - out-of-bounds values fail schema validation (not "clamp with WARN")
 *   - integer-typed (rejects strings, floats, booleans)
 *
 * Reminder: the writer does NOT consume this value. A10 covers schema
 * validation only. C1 storage-bounds interpretation.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadPolicy } = require('../../dist/store');

function mkTempCawsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'caws-policy-agents-ttl-'));
}

const POLICY_BASE = `
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
`;

function writePolicy(cawsDir, body) {
  fs.writeFileSync(path.join(cawsDir, 'policy.yaml'), body);
}

describe('A10 — policy.agents.last_modified_paths_ttl_seconds', () => {
  let cawsDir;
  afterEach(() => {
    if (cawsDir) fs.rmSync(cawsDir, { recursive: true, force: true });
  });

  it('omitted: policy validates with no error', () => {
    cawsDir = mkTempCawsDir();
    writePolicy(cawsDir, POLICY_BASE);
    const r = loadPolicy(cawsDir);
    expect(r.errors).toEqual([]);
    expect(r.policy).toBeDefined();
  });

  it('valid value 1800 (proposed default): policy validates', () => {
    cawsDir = mkTempCawsDir();
    writePolicy(
      cawsDir,
      POLICY_BASE + '\nagents:\n  last_modified_paths_ttl_seconds: 1800\n'
    );
    const r = loadPolicy(cawsDir);
    expect(r.errors).toEqual([]);
    expect(r.policy.agents.last_modified_paths_ttl_seconds).toBe(1800);
  });

  it('lower-bound 60 is valid', () => {
    cawsDir = mkTempCawsDir();
    writePolicy(
      cawsDir,
      POLICY_BASE + '\nagents:\n  last_modified_paths_ttl_seconds: 60\n'
    );
    const r = loadPolicy(cawsDir);
    expect(r.errors).toEqual([]);
    expect(r.policy.agents.last_modified_paths_ttl_seconds).toBe(60);
  });

  it('upper-bound 86400 is valid', () => {
    cawsDir = mkTempCawsDir();
    writePolicy(
      cawsDir,
      POLICY_BASE + '\nagents:\n  last_modified_paths_ttl_seconds: 86400\n'
    );
    const r = loadPolicy(cawsDir);
    expect(r.errors).toEqual([]);
    expect(r.policy.agents.last_modified_paths_ttl_seconds).toBe(86400);
  });

  it('below lower bound (59) fails schema validation', () => {
    cawsDir = mkTempCawsDir();
    writePolicy(
      cawsDir,
      POLICY_BASE + '\nagents:\n  last_modified_paths_ttl_seconds: 59\n'
    );
    const r = loadPolicy(cawsDir);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('above upper bound (86401) fails schema validation', () => {
    cawsDir = mkTempCawsDir();
    writePolicy(
      cawsDir,
      POLICY_BASE + '\nagents:\n  last_modified_paths_ttl_seconds: 86401\n'
    );
    const r = loadPolicy(cawsDir);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('string value fails schema validation (integer-typed)', () => {
    cawsDir = mkTempCawsDir();
    writePolicy(
      cawsDir,
      POLICY_BASE + '\nagents:\n  last_modified_paths_ttl_seconds: "1800"\n'
    );
    const r = loadPolicy(cawsDir);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('float value fails schema validation (integer-typed)', () => {
    cawsDir = mkTempCawsDir();
    writePolicy(
      cawsDir,
      POLICY_BASE + '\nagents:\n  last_modified_paths_ttl_seconds: 1800.5\n'
    );
    const r = loadPolicy(cawsDir);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('unknown key under agents: fails schema validation (additionalProperties false)', () => {
    cawsDir = mkTempCawsDir();
    writePolicy(
      cawsDir,
      POLICY_BASE +
        '\nagents:\n  last_modified_paths_ttl_seconds: 1800\n  unknown_key: 1\n'
    );
    const r = loadPolicy(cawsDir);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});
