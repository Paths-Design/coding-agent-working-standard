/**
 * @fileoverview autoCloseBoundSpec unit coverage.
 * CAWSFIX-14 baseline: active -> closed on merge.
 * CAWSFIX-23 extension: draft -> closed also flips (merge is authoritative),
 * return shape is an object with verify-acs results attached so callers
 * can warn on failing ACs without blocking the close.
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { autoCloseBoundSpec } = require('../src/worktree/worktree-manager');

describe('autoCloseBoundSpec (CAWSFIX-14 + CAWSFIX-23)', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawsfix-23-close-'));
    fs.mkdirSync(path.join(tempDir, '.caws', 'specs'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const writeSpec = (id, status, extra = '') => {
    const body =
      `id: ${id}\ntitle: Test\nrisk_tier: 2\nmode: development\nstatus: ${status}\n` + extra;
    fs.writeFileSync(path.join(tempDir, '.caws', 'specs', `${id}.yaml`), body);
  };

  const readStatus = (id) => {
    const body = fs.readFileSync(path.join(tempDir, '.caws', 'specs', `${id}.yaml`), 'utf8');
    const m = body.match(/^status:\s*(\S+)/m);
    return m ? m[1] : null;
  };

  const readAll = (id) =>
    fs.readFileSync(path.join(tempDir, '.caws', 'specs', `${id}.yaml`), 'utf8');

  test('CAWSFIX-14 A1: flips status: active -> closed and returns specId', () => {
    writeSpec('TEST-01', 'active');
    const result = autoCloseBoundSpec(tempDir, 'TEST-01');
    expect(result.specId).toBe('TEST-01');
    expect(readStatus('TEST-01')).toBe('closed');
  });

  test('CAWSFIX-14 A3: already-closed spec is idempotent (no write, still reports specId)', () => {
    writeSpec('TEST-02', 'closed');
    const before = readAll('TEST-02');
    const result = autoCloseBoundSpec(tempDir, 'TEST-02');
    expect(result.specId).toBe('TEST-02');
    expect(readAll('TEST-02')).toBe(before);
  });

  test('CAWSFIX-23 A3: draft spec flips to closed (merge is authoritative)', () => {
    writeSpec('TEST-DRAFT', 'draft');
    const result = autoCloseBoundSpec(tempDir, 'TEST-DRAFT');
    expect(result.specId).toBe('TEST-DRAFT');
    expect(readStatus('TEST-DRAFT')).toBe('closed');
  });

  test('CAWSFIX-23: only the status line changes (no YAML reshuffle) on draft -> closed', () => {
    writeSpec('TEST-DIFF', 'draft');
    const before = readAll('TEST-DIFF');
    autoCloseBoundSpec(tempDir, 'TEST-DIFF');
    const after = readAll('TEST-DIFF');

    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    expect(afterLines.length).toBe(beforeLines.length);

    const changedLineIndices = [];
    for (let i = 0; i < beforeLines.length; i++) {
      if (beforeLines[i] !== afterLines[i]) changedLineIndices.push(i);
    }
    expect(changedLineIndices.length).toBe(1);
    expect(afterLines[changedLineIndices[0]]).toMatch(/^status: closed$/);
  });

  test('archived/unknown status is left alone (specId: null)', () => {
    writeSpec('TEST-ARCH', 'archived');
    const before = readAll('TEST-ARCH');
    const result = autoCloseBoundSpec(tempDir, 'TEST-ARCH');
    expect(result.specId).toBeNull();
    expect(readAll('TEST-ARCH')).toBe(before);
  });

  test('CAWSFIX-14 A4: missing spec file returns specId: null (silent skip, no throw)', () => {
    const result = autoCloseBoundSpec(tempDir, 'DOES-NOT-EXIST');
    expect(result.specId).toBeNull();
  });

  test('null/empty specId never throws and returns specId: null', () => {
    expect(autoCloseBoundSpec(tempDir, null).specId).toBeNull();
    expect(autoCloseBoundSpec(tempDir, '').specId).toBeNull();
    expect(autoCloseBoundSpec(tempDir, undefined).specId).toBeNull();
  });

  test('CAWSFIX-23: return shape carries acsPassing/acsFailureCount fields even when no ACs run', () => {
    writeSpec('TEST-NOACS', 'active');
    const result = autoCloseBoundSpec(tempDir, 'TEST-NOACS');
    expect(result).toMatchObject({
      specId: 'TEST-NOACS',
      acsFailureCount: 0,
      acsTotal: 0,
      acsFailureIds: [],
    });
    // acsPassing is true when verify-acs ran and found 0 fails — even on an
    // empty acceptance array. If verify-acs failed to run (e.g. malformed
    // spec) acsPassing stays null. We accept either here; the field just
    // has to exist.
    expect(result).toHaveProperty('acsPassing');
  });

  test('CAWSFIX-23 A4: spec with failing AC test_nodeids surfaces acsFailureCount', () => {
    // Give the spec one acceptance criterion that points at a non-existent
    // test file. verify-acs in collect-only mode will mark it FAIL.
    writeSpec(
      'TEST-ACFAIL',
      'active',
      [
        'acceptance:',
        '  - id: A1',
        '    given: "a condition"',
        '    when: "an event"',
        '    then: "an outcome"',
        '    test_nodeids:',
        '      - tests/does-not-exist.test.js::nothing',
        '',
      ].join('\n')
    );
    const result = autoCloseBoundSpec(tempDir, 'TEST-ACFAIL');
    expect(result.specId).toBe('TEST-ACFAIL'); // still closed
    expect(readStatus('TEST-ACFAIL')).toBe('closed');
    expect(result.acsTotal).toBeGreaterThanOrEqual(1);
    expect(result.acsFailureCount).toBeGreaterThanOrEqual(1);
    expect(result.acsFailureIds).toContain('A1');
    expect(result.acsPassing).toBe(false);
  });
});
