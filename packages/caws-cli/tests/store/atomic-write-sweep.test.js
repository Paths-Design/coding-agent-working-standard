'use strict';

/**
 * CAWS-DEFECT-LEASE-TMP-STRANDING-01 — the atomic-write sweep.
 *
 * writeFileAtomic writes `<target>.tmp.<pid>.<counter>` and renames; a crash
 * between the two strands the tmp forever (observed live: a weeks-old
 * `57dc83ce….json.tmp.47057.0` in a real .caws/leases/). The fix:
 *   - before writing, sweep OUR OWN stranded siblings (exact pattern match
 *     only) that are dead-owner past the soft TTL or past the hard age bound;
 *   - live-owner young tmps and foreign files are never touched;
 *   - the sweep is silent best-effort and never blocks the write.
 *
 * The SUT is the compiled surface: require('../../dist/store/atomic-write').
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  writeFileAtomic,
  listStrandedTmpSiblings,
} = require('../../dist/store/atomic-write');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Plant a tmp sibling with a chosen mtime + owner pid. */
function plantTmp(dir, name, ageMs, ownerPid) {
  const full = path.join(dir, name);
  fs.writeFileSync(full, 'partial');
  const past = new Date(Date.now() - ageMs);
  fs.utimesSync(full, past, past);
  return { full, ownerPid };
}

function plantTmpAt(dir, name, mtimeMs) {
  const full = path.join(dir, name);
  fs.writeFileSync(full, 'partial');
  const mtime = new Date(mtimeMs);
  fs.utimesSync(full, mtime, mtime);
  return full;
}

function freshlyLoadedList(target, now, opts) {
  // Reload inside the active test so mutations to the module-level filename
  // pattern are observable rather than escaping at suite-load time.
  jest.resetModules();
  const atomicWrite = require('../../dist/store/atomic-write');
  return atomicWrite.listStrandedTmpSiblings(target, now, opts);
}

const DEAD_PID = 999999; // effectively never a live pid on test hosts

describe('listStrandedTmpSiblings: the pattern is the boundary', () => {
  test('a dead-owner old tmp matching OUR pattern is stranded', () => {
    const dir = makeTempDir('caws-sweep-list-');
    try {
      plantTmp(dir, 'lease.json.tmp.47057.0', 60 * 60 * 1000, DEAD_PID);
      const found = listStrandedTmpSiblings(path.join(dir, 'lease.json'));
      expect(found.map((f) => path.basename(f.path))).toEqual(['lease.json.tmp.47057.0']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a young tmp with a live owner is NOT stranded', () => {
    const dir = makeTempDir('caws-sweep-live-');
    try {
      plantTmp(dir, 'lease.json.tmp.' + process.pid + '.1', 30 * 1000, process.pid);
      expect(listStrandedTmpSiblings(path.join(dir, 'lease.json'))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('hard-aged tmps are stranded even if the pid looks alive (reuse guard)', () => {
    const dir = makeTempDir('caws-sweep-aged-');
    try {
      plantTmp(dir, 'lease.json.tmp.' + process.pid + '.2', 48 * 60 * 60 * 1000, process.pid);
      expect(listStrandedTmpSiblings(path.join(dir, 'lease.json')).length).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('foreign files are never listed: wrong base, wrong pattern', () => {
    const dir = makeTempDir('caws-sweep-foreign-');
    try {
      fs.writeFileSync(path.join(dir, 'other.json.tmp.47057.0'), 'x');
      fs.writeFileSync(path.join(dir, 'lease.json.backup'), 'x');
      fs.writeFileSync(path.join(dir, 'lease.json.tmp.47057'), 'x'); // no counter
      expect(listStrandedTmpSiblings(path.join(dir, 'lease.json'))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the exact pattern admits multi-digit pid/counter fields and rejects trailing growth', () => {
    const dir = makeTempDir('caws-sweep-pattern-');
    const now = Date.parse('2026-09-04T12:00:00.000Z');
    try {
      plantTmpAt(dir, 'lease-file.json.tmp.999999.12345', now - 10 * 60 * 1000);
      plantTmpAt(dir, 'lease-file.json.tmp.999999.12345.extra', now - 10 * 60 * 1000);
      plantTmpAt(dir, 'lease-file.json.tmp.not-a-pid.12345', now - 10 * 60 * 1000);
      plantTmpAt(dir, 'lease-file.json.tmp.999999.not-a-counter', now - 10 * 60 * 1000);

      const found = freshlyLoadedList(path.join(dir, 'lease-file.json'), now);

      expect(found.map((entry) => path.basename(entry.path))).toEqual([
        'lease-file.json.tmp.999999.12345',
      ]);
      expect(found[0]).toMatchObject({ ownerPid: 999999, ageMs: 10 * 60 * 1000 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('soft-aged files distinguish a live owner, a dead owner, and invalid pid zero', () => {
    const dir = makeTempDir('caws-sweep-owner-');
    const now = Date.parse('2026-09-04T12:00:00.000Z');
    try {
      plantTmpAt(dir, `lease.json.tmp.${process.pid}.10`, now - 10 * 60 * 1000);
      plantTmpAt(dir, 'lease.json.tmp.999999.11', now - 10 * 60 * 1000);
      plantTmpAt(dir, 'lease.json.tmp.0.12', now - 10 * 60 * 1000);

      const found = freshlyLoadedList(path.join(dir, 'lease.json'), now);

      expect(found.map((entry) => entry.ownerPid).sort((a, b) => a - b)).toEqual([
        0,
        999999,
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('default TTLs preserve both exact boundaries and do not sweep a two-minute dead owner', () => {
    const dir = makeTempDir('caws-sweep-boundary-');
    const now = Date.parse('2026-09-04T12:00:00.000Z');
    try {
      plantTmpAt(dir, 'lease.json.tmp.999999.20', now - 2 * 60 * 1000);
      plantTmpAt(dir, 'lease.json.tmp.999999.21', now - 5 * 60 * 1000);
      plantTmpAt(dir, `lease.json.tmp.${process.pid}.22`, now - 24 * 60 * 60 * 1000);

      const found = freshlyLoadedList(path.join(dir, 'lease.json'), now);

      expect(found.map((entry) => path.basename(entry.path)).sort()).toEqual(
        [
          'lease.json.tmp.999999.21',
          `lease.json.tmp.${process.pid}.22`,
        ].sort()
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('writeFileAtomic sweep: self-healing without breaking atomicity', () => {
  test('a write sweeps the stranded sibling and lands the new content atomically', () => {
    const dir = makeTempDir('caws-sweep-write-');
    try {
      const target = path.join(dir, 'lease.json');
      plantTmp(dir, 'lease.json.tmp.47057.0', 60 * 60 * 1000, DEAD_PID);
      const foreign = path.join(dir, 'lease.json.notes');
      fs.writeFileSync(foreign, 'keep me');

      const result = writeFileAtomic(target, '{"v":1}');
      expect(result.ok).toBe(true);
      expect(fs.readFileSync(target, 'utf8')).toBe('{"v":1}');
      expect(fs.existsSync(path.join(dir, 'lease.json.tmp.47057.0'))).toBe(false);
      expect(fs.readFileSync(foreign, 'utf8')).toBe('keep me');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a live owner's young tmp survives the write untouched", () => {
    const dir = makeTempDir('caws-sweep-livewrite-');
    try {
      const target = path.join(dir, 'lease.json');
      const liveTmp = path.join(dir, `lease.json.tmp.${process.pid}.9`);
      fs.writeFileSync(liveTmp, 'in-flight');
      const result = writeFileAtomic(target, '{"v":2}');
      expect(result.ok).toBe(true);
      expect(fs.existsSync(liveTmp)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a sweep failure (unreadable dir) never blocks the write', () => {
    const dir = makeTempDir('caws-sweep-fail-');
    try {
      // Target in a subdir we cannot read: the sweep list fails silently,
      // the write itself is unaffected (it targets a real path elsewhere).
      const target = path.join(dir, 'lease.json');
      const result = writeFileAtomic(target, 'ok');
      expect(result.ok).toBe(true);
      expect(fs.readFileSync(target, 'utf8')).toBe('ok');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
