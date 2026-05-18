/**
 * Tests for atomic-write.ts preserveMode option (LIFECYCLE-MUTATION-001 A2).
 *
 * The lifecycle substrate writes managed hook scripts (executable bit
 * must survive) and YAML files (no exec bit). The preserveMode option
 * makes the contract explicit so future managed-file rewrites don't
 * silently drop permissions.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeFileAtomic } = require('../../dist/store/atomic-write');

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

function modeOf(p) {
  return fs.statSync(p).mode & 0o7777;
}

describe('writeFileAtomic — default behavior (no preserveMode)', () => {
  let dir;
  beforeEach(() => { dir = mkTempDir('caws-aw-default-'); });
  afterEach(() => rmrf(dir));

  it('writes the new contents atomically', () => {
    const target = path.join(dir, 'a.txt');
    const result = writeFileAtomic(target, 'hello');
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('hello');
  });

  it('overwrites an existing file', () => {
    const target = path.join(dir, 'b.txt');
    fs.writeFileSync(target, 'old');
    const result = writeFileAtomic(target, 'new');
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
  });

  it('cleans up temp file on write failure (e.g., target dir missing)', () => {
    const target = path.join(dir, 'nonexistent', 'c.txt');
    const result = writeFileAtomic(target, 'x');
    expect(result.ok).toBe(false);
    // No stray .tmp files in the working dir.
    const stray = fs.readdirSync(dir).filter((f) => f.includes('.tmp.'));
    expect(stray).toHaveLength(0);
  });
});

describe('A2: writeFileAtomic preserveMode preserves the executable bit', () => {
  let dir;
  beforeEach(() => { dir = mkTempDir('caws-aw-preserve-'); });
  afterEach(() => rmrf(dir));

  it('preserves 0755 across a content rewrite', () => {
    const target = path.join(dir, 'hook.sh');
    fs.writeFileSync(target, '#!/bin/bash\necho old\n');
    fs.chmodSync(target, 0o755);
    expect(modeOf(target)).toBe(0o755);

    const result = writeFileAtomic(target, '#!/bin/bash\necho new\n', { preserveMode: true });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('#!/bin/bash\necho new\n');
    expect(modeOf(target)).toBe(0o755);
  });

  it('preserves 0600 (read/write owner only) across a rewrite', () => {
    const target = path.join(dir, 'secret.yaml');
    fs.writeFileSync(target, 'k: v\n');
    fs.chmodSync(target, 0o600);
    expect(modeOf(target)).toBe(0o600);

    const result = writeFileAtomic(target, 'k: w\n', { preserveMode: true });
    expect(result.ok).toBe(true);
    expect(modeOf(target)).toBe(0o600);
  });

  it('without preserveMode, exec bit is dropped (documents the default)', () => {
    const target = path.join(dir, 'hook2.sh');
    fs.writeFileSync(target, 'old');
    fs.chmodSync(target, 0o755);
    expect(modeOf(target)).toBe(0o755);

    const result = writeFileAtomic(target, 'new');
    expect(result.ok).toBe(true);
    // Default behavior: temp file is created with 'w' mode (0o666 & umask).
    // Exec bit is NOT preserved unless preserveMode is true.
    expect(modeOf(target) & 0o111).toBe(0);
  });

  it('preserveMode is a no-op when the target does not exist', () => {
    const target = path.join(dir, 'fresh.txt');
    const result = writeFileAtomic(target, 'hello', { preserveMode: true });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('hello');
    // Default mode applies (umask-dependent); we don't pin a specific value.
  });
});
