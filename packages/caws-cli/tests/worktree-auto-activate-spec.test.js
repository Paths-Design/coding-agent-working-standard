/**
 * @fileoverview CAWSFIX-23 — autoActivateBoundSpec unit coverage.
 * Covers A1, A2, A5, A6 from .caws/specs/CAWSFIX-23.yaml. The
 * callsite integration (createWorktree + handleBind) is exercised
 * indirectly by the worktree-manager integration suite; this file
 * focuses on the isolated transition helper.
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { autoActivateBoundSpec } = require('../src/worktree/worktree-manager');

describe('CAWSFIX-23 — autoActivateBoundSpec', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawsfix-23-activate-'));
    fs.mkdirSync(path.join(tempDir, '.caws', 'specs'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const writeSpec = (id, status) => {
    const body = `id: ${id}\ntitle: Test\nrisk_tier: 2\nmode: development\nstatus: ${status}\n`;
    fs.writeFileSync(path.join(tempDir, '.caws', 'specs', `${id}.yaml`), body);
  };

  const readStatus = (id) => {
    const body = fs.readFileSync(path.join(tempDir, '.caws', 'specs', `${id}.yaml`), 'utf8');
    const m = body.match(/^status:\s*(\S+)/m);
    return m ? m[1] : null;
  };

  const readAll = (id) =>
    fs.readFileSync(path.join(tempDir, '.caws', 'specs', `${id}.yaml`), 'utf8');

  test('A1: flips status: draft -> status: active and returns specId', () => {
    writeSpec('TEST-01', 'draft');
    const result = autoActivateBoundSpec(tempDir, 'TEST-01');
    expect(result).toBe('TEST-01');
    expect(readStatus('TEST-01')).toBe('active');
  });

  test('A1: only the status line changes (no YAML reshuffle)', () => {
    writeSpec('TEST-DIFF', 'draft');
    const before = readAll('TEST-DIFF');
    autoActivateBoundSpec(tempDir, 'TEST-DIFF');
    const after = readAll('TEST-DIFF');

    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    expect(afterLines.length).toBe(beforeLines.length);

    const changedLineIndices = [];
    for (let i = 0; i < beforeLines.length; i++) {
      if (beforeLines[i] !== afterLines[i]) changedLineIndices.push(i);
    }
    expect(changedLineIndices.length).toBe(1);
    expect(afterLines[changedLineIndices[0]]).toMatch(/^status: active$/);
    expect(beforeLines[changedLineIndices[0]]).toMatch(/^status: draft$/);
  });

  test('A2: already-active spec is a no-op (byte-identical file, returns specId)', () => {
    writeSpec('TEST-02', 'active');
    const before = readAll('TEST-02');
    const result = autoActivateBoundSpec(tempDir, 'TEST-02');
    expect(result).toBe('TEST-02');
    const after = readAll('TEST-02');
    expect(after).toBe(before);
  });

  test('closed spec is left alone and returns null', () => {
    writeSpec('TEST-03', 'closed');
    const before = readAll('TEST-03');
    const result = autoActivateBoundSpec(tempDir, 'TEST-03');
    expect(result).toBeNull();
    expect(readAll('TEST-03')).toBe(before);
  });

  test('missing spec file returns null (silent skip, no throw)', () => {
    const result = autoActivateBoundSpec(tempDir, 'DOES-NOT-EXIST');
    expect(result).toBeNull();
  });

  test('null/empty specId never throws, returns null', () => {
    expect(autoActivateBoundSpec(tempDir, null)).toBeNull();
    expect(autoActivateBoundSpec(tempDir, '')).toBeNull();
    expect(autoActivateBoundSpec(tempDir, undefined)).toBeNull();
  });

  test('archived or unknown status is left alone and returns null', () => {
    writeSpec('TEST-ARCH', 'archived');
    const before = readAll('TEST-ARCH');
    const result = autoActivateBoundSpec(tempDir, 'TEST-ARCH');
    expect(result).toBeNull();
    expect(readAll('TEST-ARCH')).toBe(before);
  });
});
