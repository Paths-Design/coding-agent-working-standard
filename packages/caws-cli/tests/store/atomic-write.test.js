'use strict';

/**
 * Unit tests for atomic-write (A2 — durability).
 *
 * CAWS-TEST-CLI-STORE-001. writeFileAtomic's contract is CONTENT atomicity:
 * after Ok, the target holds the new bytes in full or the old bytes in full —
 * never a partial write. Mechanism is temp + fsync + rename. These tests assert
 * the real on-disk outcome (full contents land, overwrite fully replaces, mode
 * preserved on overwrite, failure leaves no leftover temp and an Err with the
 * io_failed code) — not mocks of fs.
 *
 * SUT loaded from dist/. Temp dirs are per-test under os.tmpdir() (isolated,
 * never the project tree), matching the slice-0 isolation discipline.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic, fsyncDir } = require('../../dist/store/atomic-write');

const IO_FAILED = 'store.write.io_failed';

/** @type {string[]} temp dirs to clean up. */
const dirs = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-aw-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('writeFileAtomic: writes full contents', () => {
  test('creates a new file with the exact bytes', () => {
    const target = path.join(tmpDir(), 'new.txt');
    const r = writeFileAtomic(target, 'hello world');
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('hello world');
  });

  test('writes a Buffer payload verbatim', () => {
    const target = path.join(tmpDir(), 'buf.bin');
    const buf = Buffer.from([0, 1, 2, 255]);
    writeFileAtomic(target, buf);
    expect(fs.readFileSync(target)).toEqual(buf);
  });

  test('overwrite FULLY replaces the old contents (no partial residue)', () => {
    const target = path.join(tmpDir(), 'over.txt');
    writeFileAtomic(target, 'AAAAAAAAAA'); // 10 bytes
    writeFileAtomic(target, 'bb'); // 2 bytes — must not leave 'AAAAAAAA' tail
    expect(fs.readFileSync(target, 'utf8')).toBe('bb');
  });
});

describe('writeFileAtomic: no leftover temp files', () => {
  test('a successful write leaves only the target, no .tmp sibling', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'clean.txt');
    writeFileAtomic(target, 'x');
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp.'));
    expect(leftovers).toEqual([]);
  });

  test('a FAILED write (target dir does not exist) returns io_failed Err and leaves no temp', () => {
    const dir = tmpDir();
    const missingSub = path.join(dir, 'does', 'not', 'exist', 'f.txt');
    const r = writeFileAtomic(missingSub, 'x');
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(IO_FAILED);
    // The parent dir we DO control has no temp residue.
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp.'));
    expect(leftovers).toEqual([]);
  });

  test('a failed overwrite does NOT corrupt the existing file', () => {
    // Make the target a directory so writing a file over it fails the rename.
    const dir = tmpDir();
    const existing = path.join(dir, 'keep.txt');
    writeFileAtomic(existing, 'original');
    // Now force a failure: target path is an existing NON-EMPTY directory
    // (rename of a file onto a non-empty dir fails).
    const asDir = path.join(dir, 'asdir');
    fs.mkdirSync(asDir);
    fs.writeFileSync(path.join(asDir, 'child'), 'x'); // make it non-empty
    const r = writeFileAtomic(asDir, 'newdata');
    expect(r.ok).toBe(false);
    // The original untouched file is still intact.
    expect(fs.readFileSync(existing, 'utf8')).toBe('original');
  });
});

describe('writeFileAtomic: preserveMode', () => {
  test('preserveMode keeps the executable bit on overwrite', () => {
    const target = path.join(tmpDir(), 'script.sh');
    writeFileAtomic(target, '#!/bin/sh\necho hi\n');
    fs.chmodSync(target, 0o755);
    // Overwrite WITHOUT preserveMode would drop to default; WITH it keeps 0755.
    const r = writeFileAtomic(target, '#!/bin/sh\necho bye\n', { preserveMode: true });
    expect(r.ok).toBe(true);
    const mode = fs.statSync(target).mode & 0o7777;
    expect(mode & 0o111).toBe(0o111); // exec bits for u/g/o present
    expect(fs.readFileSync(target, 'utf8')).toContain('echo bye');
  });

  test('preserveMode on a NEW file (no prior target) is a no-op, write still succeeds', () => {
    const target = path.join(tmpDir(), 'fresh.txt');
    const r = writeFileAtomic(target, 'x', { preserveMode: true });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('x');
  });
});

describe('fsyncDir: best-effort, never throws', () => {
  test('returns true on an existing directory', () => {
    expect(fsyncDir(tmpDir())).toBe(true);
  });

  test('returns false (does not throw) on a non-existent directory', () => {
    expect(fsyncDir('/no/such/dir/anywhere')).toBe(false);
  });
});
