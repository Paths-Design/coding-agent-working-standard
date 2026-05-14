/**
 * Tests for waivers-store.
 *
 *   - missing waivers dir → []
 *   - valid waivers load
 *   - malformed waiver file → load diagnostic, valid waivers still load
 *   - duplicate ids → diagnostic, first wins
 *   - filename mismatch → info diagnostic
 *   - writeWaiver refuses duplicate
 *   - markRevoked transitions status and writes back atomically
 *   - markRevoked refuses non-existent or already-revoked
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  loadWaivers,
  markRevoked,
  STORE_RULES,
  writeWaiver,
} = require('../../dist/store');

function mkTempCawsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'caws-waivers-store-'));
}

const VALID_WAIVER = (id = 'WAIV-001') => ({
  id,
  title: 'Test waiver for legacy todo entries',
  status: 'active',
  gates: ['todo_detection'],
  reason: 'Migration in progress; todo cleanup tracked separately',
  approved_by: 'darian',
  created_at: '2026-05-14T12:00:00.000Z',
  expires_at: '2026-06-14T12:00:00.000Z',
});

const VALID_WAIVER_YAML = (id = 'WAIV-001') => `id: ${id}
title: 'Test waiver for legacy todo entries'
status: active
gates:
  - todo_detection
reason: 'Migration in progress; todo cleanup tracked separately'
approved_by: 'darian'
created_at: '2026-05-14T12:00:00.000Z'
expires_at: '2026-06-14T12:00:00.000Z'
`;

describe('loadWaivers', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it('returns empty when .caws/waivers/ does not exist', () => {
    cawsDir = mkTempCawsDir();
    const r = loadWaivers(cawsDir);
    expect(r.waivers).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });

  it('loads a valid waiver', () => {
    cawsDir = mkTempCawsDir();
    fs.mkdirSync(path.join(cawsDir, 'waivers'), { recursive: true });
    fs.writeFileSync(
      path.join(cawsDir, 'waivers', 'WAIV-001.yaml'),
      VALID_WAIVER_YAML('WAIV-001')
    );
    const r = loadWaivers(cawsDir);
    expect(r.waivers).toHaveLength(1);
    expect(r.waivers[0].id).toBe('WAIV-001');
    expect(r.diagnostics).toEqual([]);
  });

  it('malformed waiver file produces diagnostic; valid ones still load', () => {
    cawsDir = mkTempCawsDir();
    fs.mkdirSync(path.join(cawsDir, 'waivers'), { recursive: true });
    fs.writeFileSync(
      path.join(cawsDir, 'waivers', 'WAIV-001.yaml'),
      VALID_WAIVER_YAML('WAIV-001')
    );
    fs.writeFileSync(
      path.join(cawsDir, 'waivers', 'BROKEN.yaml'),
      'this: : invalid: yaml: :'
    );
    const r = loadWaivers(cawsDir);
    expect(r.waivers).toHaveLength(1); // valid one survives
    expect(r.waivers[0].id).toBe('WAIV-001');
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(
      r.diagnostics.some(
        (d) => typeof d.subject === 'string' && d.subject.endsWith('BROKEN.yaml')
      )
    ).toBe(true);
  });

  it('duplicate waiver ids → diagnostic, first wins', () => {
    cawsDir = mkTempCawsDir();
    fs.mkdirSync(path.join(cawsDir, 'waivers'), { recursive: true });
    fs.writeFileSync(
      path.join(cawsDir, 'waivers', 'AA-DUPE.yaml'),
      VALID_WAIVER_YAML('WAIV-001')
    );
    fs.writeFileSync(
      path.join(cawsDir, 'waivers', 'ZZ-DUPE.yaml'),
      VALID_WAIVER_YAML('WAIV-001')
    );
    const r = loadWaivers(cawsDir);
    expect(r.waivers).toHaveLength(1);
    const dup = r.diagnostics.find(
      (d) => d.rule === STORE_RULES.WAIVERS_DUPLICATE_ID
    );
    expect(dup).toBeDefined();
  });

  it('filename mismatch produces info-level diagnostic', () => {
    cawsDir = mkTempCawsDir();
    fs.mkdirSync(path.join(cawsDir, 'waivers'), { recursive: true });
    fs.writeFileSync(
      path.join(cawsDir, 'waivers', 'wrong-name.yaml'),
      VALID_WAIVER_YAML('WAIV-001')
    );
    const r = loadWaivers(cawsDir);
    expect(r.waivers).toHaveLength(1);
    const mismatch = r.diagnostics.find(
      (d) => d.rule === STORE_RULES.WAIVERS_FILENAME_MISMATCH
    );
    expect(mismatch).toBeDefined();
    expect(mismatch.severity).toBe('info');
  });

  it('non-YAML file produces non_yaml_skipped diagnostic', () => {
    cawsDir = mkTempCawsDir();
    fs.mkdirSync(path.join(cawsDir, 'waivers'), { recursive: true });
    fs.writeFileSync(path.join(cawsDir, 'waivers', 'README.md'), '# readme');
    const r = loadWaivers(cawsDir);
    expect(r.diagnostics.some(
      (d) => d.rule === STORE_RULES.WAIVERS_NON_YAML_SKIPPED
    )).toBe(true);
  });
});

describe('writeWaiver', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it('writes a waiver to .caws/waivers/<id>.yaml', () => {
    cawsDir = mkTempCawsDir();
    const r = writeWaiver(cawsDir, VALID_WAIVER('WAIV-001'));
    expect(r.ok).toBe(true);
    const onDisk = fs.readFileSync(
      path.join(cawsDir, 'waivers', 'WAIV-001.yaml'),
      'utf8'
    );
    expect(onDisk).toContain('id: WAIV-001');
    expect(onDisk).toContain('status: active');
    // Round-trip through loadWaivers
    const load = loadWaivers(cawsDir);
    expect(load.waivers).toHaveLength(1);
    expect(load.waivers[0].id).toBe('WAIV-001');
  });

  it('refuses to overwrite an existing waiver (without allowOverwrite)', () => {
    cawsDir = mkTempCawsDir();
    const w = VALID_WAIVER('WAIV-001');
    expect(writeWaiver(cawsDir, w).ok).toBe(true);
    const second = writeWaiver(cawsDir, w);
    expect(second.ok).toBe(false);
    expect(second.errors[0].rule).toBe(STORE_RULES.WAIVERS_ALREADY_EXISTS);
  });
});

describe('markRevoked', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it('transitions an active waiver to revoked with a revocation record', () => {
    cawsDir = mkTempCawsDir();
    writeWaiver(cawsDir, VALID_WAIVER('WAIV-001'));
    const now = new Date('2026-05-15T00:00:00.000Z');
    const r = markRevoked(cawsDir, 'WAIV-001', {
      now,
      revoked_by: 'darian',
      reason: 'No longer needed',
    });
    expect(r.ok).toBe(true);
    expect(r.value.status).toBe('revoked');
    expect(r.value.revocation.revoked_at).toBe(now.toISOString());

    // Round-trip — load should still see it as a valid (revoked) waiver
    const load = loadWaivers(cawsDir);
    expect(load.waivers).toHaveLength(1);
    expect(load.waivers[0].status).toBe('revoked');
  });

  it('refuses revoke of non-existent waiver', () => {
    cawsDir = mkTempCawsDir();
    const r = markRevoked(cawsDir, 'WAIV-DOES-NOT-EXIST', {
      now: new Date(),
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(STORE_RULES.WAIVERS_NOT_FOUND);
  });

  it('refuses revoke of already-revoked waiver', () => {
    cawsDir = mkTempCawsDir();
    writeWaiver(cawsDir, VALID_WAIVER('WAIV-001'));
    const now = new Date('2026-05-15T00:00:00.000Z');
    expect(markRevoked(cawsDir, 'WAIV-001', { now }).ok).toBe(true);
    const second = markRevoked(cawsDir, 'WAIV-001', { now });
    expect(second.ok).toBe(false);
  });
});
