'use strict';

/**
 * Pack-fingerprint guard (A3, A4) — RE-AUTHORED FROM ZERO.
 *
 * CAWS-TEST-HOOK-INSTALL-FINGERPRINT-001. This is the supply-chain-integrity
 * control deleted with the corpus: it detects a hook-template change that lands
 * WITHOUT a packVersion bump (the stale-installed-fix class — a 9-day-stale
 * danger-latch fix once shipped because a template changed but the installed
 * copy didn't). The guard recomputes each pack's fingerprint from the LIVE
 * template tree and compares it to the recorded baseline in pack-fingerprints.json.
 *
 * Algorithm (deterministic, documented):
 *   fingerprint(packDir) = sha256( JSON of the SORTED list of
 *       [relpath, sha256(fileContent)] pairs )
 *   for every file under packDir, EXCLUDING dirs {tmp, .caws, __pycache__,
 *   node_modules} and the file .DS_Store.
 *
 * The recorded baseline was RECOMPUTED fresh in this slice (never copied from
 * the deleted corpus or main history) — the whole point of the guard is that the
 * baseline is derived, so trusting an old value would defeat it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// tests/init -> packages/caws-cli
const CLI_PKG_ROOT = path.resolve(__dirname, '..', '..');
const PACKS_ROOT = path.join(CLI_PKG_ROOT, 'templates', 'hook-packs');

const EXCLUDED_DIRS = new Set(['tmp', '.caws', '__pycache__', 'node_modules']);
const EXCLUDED_FILES = new Set(['.DS_Store']);

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Collect [relpath, sha256(content)] for every non-excluded file under dir. */
function collectFilePairs(dir, baseDir = dir) {
  const pairs = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      pairs.push(...collectFilePairs(path.join(dir, entry.name), baseDir));
    } else if (entry.isFile()) {
      if (EXCLUDED_FILES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(baseDir, full).split(path.sep).join('/');
      pairs.push([rel, sha256(fs.readFileSync(full))]);
    }
  }
  return pairs;
}

/** Deterministic pack fingerprint: sha256 over the sorted [relpath, contentHash] pairs. */
function fingerprintPack(packDir) {
  const pairs = collectFilePairs(packDir);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256(JSON.stringify(pairs));
}

const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'pack-fingerprints.json'), 'utf8')
);

const { SHARED_PACK_VERSION } = require('../../dist/init/hook-packs/manifest-shared');
const { CLAUDE_CODE_PACK_VERSION } = require('../../dist/init/hook-packs/manifest-claude-code');
const { CODEX_PACK_VERSION } = require('../../dist/init/hook-packs/manifest-codex');

const PACKS = [
  { id: 'shared', dir: path.join(PACKS_ROOT, 'shared'), version: SHARED_PACK_VERSION },
  { id: 'claude-code', dir: path.join(PACKS_ROOT, 'claude-code'), version: CLAUDE_CODE_PACK_VERSION },
  { id: 'codex', dir: path.join(PACKS_ROOT, 'codex'), version: CODEX_PACK_VERSION },
];

describe('pack-fingerprint guard: live template fingerprint matches the recorded baseline', () => {
  test.each(PACKS)('$id pack fingerprint is unchanged (or version bumped)', ({ id, dir, version }) => {
    const live = fingerprintPack(dir);
    const recorded = RECORDED[id];
    expect(recorded).toBeDefined();
    // The recorded version must match the manifest's current version: a template
    // change requires BOTH a new fingerprint AND a packVersion bump.
    expect(recorded.version).toBe(version);
    // If this fails, a template file changed without updating the recorded
    // fingerprint + bumping packVersion (the stale-installed-fix guard firing).
    // The failure message prints the live value so the baseline can be updated
    // deliberately alongside a version bump.
    expect({ id, fingerprint: live }).toEqual({ id, fingerprint: recorded.fingerprint });
  });
});

describe('fingerprintPack: deterministic + exclusions (A4)', () => {
  const SHARED_DIR = path.join(PACKS_ROOT, 'shared');

  test('same dir -> same fingerprint (deterministic)', () => {
    expect(fingerprintPack(SHARED_DIR)).toBe(fingerprintPack(SHARED_DIR));
  });

  test('a tmp dir / .DS_Store / __pycache__ file does NOT change the fingerprint', () => {
    const before = fingerprintPack(SHARED_DIR);
    // Add excluded junk to a throwaway COPY of the pack so we never mutate the
    // real template tree.
    const os = require('os');
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-fp-'));
    try {
      fs.cpSync(SHARED_DIR, copy, { recursive: true });
      const baseCopyFp = fingerprintPack(copy);
      expect(baseCopyFp).toBe(before); // a plain copy fingerprints identically
      // Now add each excluded artifact and confirm the fingerprint is stable.
      fs.writeFileSync(path.join(copy, '.DS_Store'), 'junk');
      fs.mkdirSync(path.join(copy, 'tmp'));
      fs.writeFileSync(path.join(copy, 'tmp', 'scratch.log'), 'junk');
      fs.mkdirSync(path.join(copy, '__pycache__'));
      fs.writeFileSync(path.join(copy, '__pycache__', 'x.pyc'), 'junk');
      expect(fingerprintPack(copy)).toBe(before);
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  });

  test('changing a real (non-excluded) file DOES change the fingerprint', () => {
    const os = require('os');
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-fp-'));
    try {
      fs.cpSync(SHARED_DIR, copy, { recursive: true });
      const before = fingerprintPack(copy);
      // Append a byte to a real guard script: the fingerprint must change.
      const guard = path.join(copy, 'naming-check.sh');
      fs.appendFileSync(guard, '\n# tamper\n');
      expect(fingerprintPack(copy)).not.toBe(before);
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  });
});
