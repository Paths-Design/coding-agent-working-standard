/**
 * @fileoverview CAWSFIX-14 — autoCloseBoundSpec unit coverage.
 * Covers A1-A4 from .caws/specs/CAWSFIX-14.yaml. Exercises the spec-status
 * flip in isolation; the full `mergeWorktree` path is covered by the
 * existing worktree-manager integration suite.
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { autoCloseBoundSpec } = require('../src/worktree/worktree-manager');

describe('CAWSFIX-14 — autoCloseBoundSpec', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawsfix-14-'));
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

  test('A1: flips status: active -> status: closed and returns specId', () => {
    writeSpec('TEST-01', 'active');
    const result = autoCloseBoundSpec(tempDir, 'TEST-01');
    expect(result).toBe('TEST-01');
    expect(readStatus('TEST-01')).toBe('closed');
  });

  test('A3: already-closed spec is idempotent (no file change, still returns specId)', () => {
    writeSpec('TEST-02', 'closed');
    const before = fs.readFileSync(path.join(tempDir, '.caws', 'specs', 'TEST-02.yaml'), 'utf8');
    const result = autoCloseBoundSpec(tempDir, 'TEST-02');
    expect(result).toBe('TEST-02');
    const after = fs.readFileSync(path.join(tempDir, '.caws', 'specs', 'TEST-02.yaml'), 'utf8');
    expect(after).toBe(before);
  });

  test('A3b: draft/other non-active status is left alone and returns null', () => {
    writeSpec('TEST-03', 'draft');
    const result = autoCloseBoundSpec(tempDir, 'TEST-03');
    expect(result).toBeNull();
    expect(readStatus('TEST-03')).toBe('draft');
  });

  test('A4: missing spec file returns null (silent skip, no throw)', () => {
    const result = autoCloseBoundSpec(tempDir, 'DOES-NOT-EXIST');
    expect(result).toBeNull();
  });

  test('A2 (proxy): null specId is never passed to autoCloseBoundSpec', () => {
    // A2 lives in mergeWorktree — the `if (entry.specId)` guard prevents
    // the function from being called. Here we prove the function itself
    // handles a falsy input gracefully when called defensively.
    expect(autoCloseBoundSpec(tempDir, null)).toBeNull();
    expect(autoCloseBoundSpec(tempDir, '')).toBeNull();
  });
});
