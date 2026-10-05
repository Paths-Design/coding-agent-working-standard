'use strict';

/**
 * HOOKPACK-COPIED-PACK-LAG-VISIBILITY-001 A4 /
 * CAWS-DEFECT-HOOK-DRIFT-NO-NONDESTRUCTIVE-DISCHARGE-01 —
 * observeSharedPackBodyDrift against a REAL install, now row-classified.
 *
 * The version stamp is not a freshness proxy. `installHookPack` stamps
 * `hook_pack_version: <cli-version>` into the project copy while the template
 * literal stays frozen, and manifest-shared.ts records content changes that
 * landed WITHOUT a version bump. A comparison that keys on the version number
 * therefore cannot prove the copied pack matches what this CLI ships.
 *
 * These tests install the shipping SHARED_PACK with the shipping installer and
 * then observe the copied pack — so "matches" is a genuine end-to-end property
 * of the real write path, not a hand-built expectation. A hand-built fixture
 * that hashes the installed files to synthesize the expected manifest is
 * tautological and cannot observe install-time divergence at all.
 *
 * The classification extension proves the baseline decomposition the doctor
 * downgrade consumes: installed-vs-baseline = LOCAL GROWTH, baseline-vs-
 * template = UPSTREAM change, no baseline = unobserved.
 */

const fs = require('fs');
const path = require('path');
const { makeTempRepo, cleanupAll } = require('../helpers/git-repo-factory');
const { SHARED_PACK } = require('../../dist/init/hook-packs/manifest-shared');
const { installHookPack, observeSharedPackBodyDrift } = require('../../dist/init/hook-install');

const DEST = '.caws/hooks/block-dangerous.sh';

describe('observeSharedPackBodyDrift (A4)', () => {
  let repo;

  beforeAll(() => {
    repo = makeTempRepo();
    installHookPack(SHARED_PACK, { repoRoot: repo });
  });

  afterAll(() => cleanupAll());

  const destAbs = (rel) => path.join(repo, rel);
  const baselineAbs = (rel) => path.join(repo, '.caws', 'hooks', '.pristine', 'shared', rel);

  test('a byte-pristine install reports no body drift', () => {
    expect(observeSharedPackBodyDrift(repo)).toEqual([]);
  });

  test('re-stamping only the version header is NOT body drift', () => {
    // The load-bearing normalization case: a file that differs from the
    // template by the version line alone predates the current pack version and
    // carries no local growth. Reporting it would be a false positive on every
    // clean install (the defect class this observation exists to avoid).
    const original = fs.readFileSync(destAbs(DEST), 'utf8');
    const restamped = original.replace(/^(#\s*hook_pack_version:\s*)\d+/m, '$1999');
    expect(restamped).not.toBe(original);
    fs.writeFileSync(destAbs(DEST), restamped);
    try {
      expect(observeSharedPackBodyDrift(repo)).toEqual([]);
    } finally {
      fs.writeFileSync(destAbs(DEST), original);
    }
  });

  test('a genuine body edit yields a growth-classified row (A1)', () => {
    const original = fs.readFileSync(destAbs(DEST), 'utf8');
    fs.writeFileSync(destAbs(DEST), `${original}\n# repo-local edit\n`);
    try {
      expect(observeSharedPackBodyDrift(repo)).toEqual([
        {
          destPath: DEST,
          baselinePresent: true,
          localGrowth: true,
          upstreamChange: false,
        },
      ]);
    } finally {
      fs.writeFileSync(destAbs(DEST), original);
    }
  });

  test('a drifted baseline records upstream change alongside growth (A1)', () => {
    // Append to the BASELINE (not the installed file): installed now differs
    // from its recorded as-installed copy (growth) AND the baseline differs
    // from the shipping template (upstream). This is the row shape doctor
    // renders as "growth the retrofit must port carefully".
    const original = fs.readFileSync(destAbs(DEST), 'utf8');
    const baseline = fs.readFileSync(baselineAbs(DEST), 'utf8');
    fs.writeFileSync(destAbs(DEST), `${original}\n# repo-local edit\n`);
    fs.writeFileSync(baselineAbs(DEST), `${baseline}\n# baseline moved\n`);
    try {
      expect(observeSharedPackBodyDrift(repo)).toEqual([
        {
          destPath: DEST,
          baselinePresent: true,
          localGrowth: true,
          upstreamChange: true,
        },
      ]);
    } finally {
      fs.writeFileSync(destAbs(DEST), original);
      fs.writeFileSync(baselineAbs(DEST), baseline);
    }
  });

  test('a drifted file with NO baseline is unobserved — never classified as growth (A4)', () => {
    const original = fs.readFileSync(destAbs(DEST), 'utf8');
    fs.writeFileSync(destAbs(DEST), `${original}\n# repo-local edit\n`);
    fs.rmSync(baselineAbs(DEST));
    try {
      expect(observeSharedPackBodyDrift(repo)).toEqual([
        {
          destPath: DEST,
          baselinePresent: false,
          localGrowth: false,
          upstreamChange: false,
        },
      ]);
    } finally {
      fs.writeFileSync(destAbs(DEST), original);
      // Restore the baseline from the (restored) installed body minus the
      // edit — the pristine copy is the rendered install.
      fs.writeFileSync(baselineAbs(DEST), original);
    }
  });

  test('multiple edits are named in sorted order and restoring clears the observation', () => {
    const one = destAbs(DEST);
    const two = destAbs('.caws/hooks/audit.sh');
    const originalOne = fs.readFileSync(one, 'utf8');
    const originalTwo = fs.readFileSync(two, 'utf8');
    fs.writeFileSync(one, `${originalOne}\n# edit one\n`);
    fs.writeFileSync(two, `${originalTwo}\n# edit two\n`);
    try {
      const rows = observeSharedPackBodyDrift(repo);
      expect(rows.map((r) => r.destPath)).toEqual(['.caws/hooks/audit.sh', DEST]);
      expect(rows.every((r) => r.baselinePresent && r.localGrowth && !r.upstreamChange)).toBe(true);
    } finally {
      fs.writeFileSync(one, originalOne);
      fs.writeFileSync(two, originalTwo);
    }
    // Restoring both clears the observation — it is a pure function of disk.
    expect(observeSharedPackBodyDrift(repo)).toEqual([]);
  });

  test('a missing copied pack yields an empty observation, never a throw', () => {
    const empty = makeTempRepo();
    expect(observeSharedPackBodyDrift(empty)).toEqual([]);
  });
});
