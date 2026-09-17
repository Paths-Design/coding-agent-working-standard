'use strict';

/**
 * CAWS-DEFECT-INIT-DRIFT-REFUSAL-UNCLASSIFIED-01 — the INSTALL path attributes
 * a body difference to the right side.
 *
 * `evaluateFileState` compared two points (installed vs template) and, on
 * inequality, concluded "the consumer grew this hook". Upstream growth the
 * consumer has not received produces the identical inequality, so a purely
 * stale copy was unreportable as stale and the only discharge offered was
 * `--overwrite --force` — the flag that discards real growth. Observed on
 * .caws/hooks/reset-strikes.sh (2026-09-16), where the installed body was
 * byte-identical to its recorded baseline and differed from the template only
 * because upstream had added sid_for_file()/known_sessions().
 *
 * The third point that separates the two already exists: the installer records
 * the as-installed body under .caws/hooks/.pristine/<packId>/<destPath>. These
 * tests install the shipping pack with the shipping installer, so the baselines
 * are the real ones, then build each of the three classes and assert the class
 * the install path reports.
 *
 * Fixtures, and why each is shaped that way:
 *   local_growth   edit the INSTALLED file only  → installed != baseline
 *   upstream_only  edit installed AND baseline identically → installed ==
 *                  baseline, both != template. This is what an un-received
 *                  upstream change looks like from inside the repo.
 *   unobserved     edit installed, delete the baseline → nothing to compare
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeTempRepo, cleanupAll } = require('../helpers/git-repo-factory');
const { SHARED_PACK } = require('../../dist/init/hook-packs/manifest-shared');
const { installHookPack, planHookPackInstall } = require('../../dist/init/hook-install');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
const DEST = '.caws/hooks/block-dangerous.sh';

afterAll(() => cleanupAll());

/** Spawn the real CLI with CAWS_HOME pinned to a throwaway dir, so a developer
 *  with configured surfaces gets the same verdict as CI. */
function runCliIsolated(root, args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-drift-class-home-'));
  try {
    return spawnSync(process.execPath, [CLI, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CAWS_QUIET: '1', CAWS_HOME: home },
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** A repo with the shipping shared pack really installed (baselines included),
 *  then mutated into one of the three drift classes. */
function repoInClass(driftClass) {
  const repo = makeTempRepo();
  installHookPack(SHARED_PACK, { repoRoot: repo });

  const installedAbs = path.join(repo, DEST);
  const baselineAbs = path.join(repo, '.caws', 'hooks', '.pristine', 'shared', DEST);
  const original = fs.readFileSync(installedAbs, 'utf8');
  const edited = `${original}\n# body change that is not a version stamp\n`;

  if (driftClass === 'local_growth') {
    fs.writeFileSync(installedAbs, edited);
  } else if (driftClass === 'upstream_only') {
    // Both sides carry the same body: nothing was edited here since install,
    // so the only thing that can have moved is the template.
    fs.writeFileSync(installedAbs, edited);
    fs.writeFileSync(baselineAbs, edited);
  } else if (driftClass === 'unobserved') {
    fs.writeFileSync(installedAbs, edited);
    fs.rmSync(baselineAbs);
  } else {
    throw new Error(`unknown fixture class: ${driftClass}`);
  }
  return repo;
}

function actionFor(actions, destPath) {
  return actions.find((a) => a.destPath === destPath);
}

function planActionFor(repo) {
  const plan = planHookPackInstall(SHARED_PACK, { repoRoot: repo });
  return actionFor(plan.actions, DEST);
}

describe('install-path drift classification (CAWS-DEFECT-INIT-DRIFT-REFUSAL-UNCLASSIFIED-01)', () => {
  test('A1: an installed body equal to its baseline is reported as upstream_only, not growth', () => {
    const repo = repoInClass('upstream_only');
    const action = planActionFor(repo);

    expect(action.action).toBe('refused');
    expect(action.refusalReason).toBe('managed_drift');
    expect(action.driftClass).toBe('upstream_only');
  });

  test('A2: a body edited since install is still classified as local growth', () => {
    // Positive control. The narrowing must not disarm the growth guard: the
    // one fixture where the repo really did edit the file must still read as
    // growth, or A1 could be satisfied by labelling everything upstream_only.
    const repo = repoInClass('local_growth');
    const action = planActionFor(repo);

    expect(action.action).toBe('refused');
    expect(action.refusalReason).toBe('managed_drift');
    expect(action.driftClass).toBe('local_growth');
  });

  test('A3: drift with no recorded baseline is unobserved, never upstream_only', () => {
    const repo = repoInClass('unobserved');
    const action = planActionFor(repo);

    expect(action.action).toBe('refused');
    expect(action.driftClass).toBe('unobserved');
    // Fail-closed, stated as its own assertion: mislabelling an undecidable
    // file as a stale copy is the error that ends in destroyed work, so the
    // permissive label is the one that must be unreachable here.
    expect(action.driftClass).not.toBe('upstream_only');
  });

  test('every class still refuses, and refusing still leaves the file untouched', () => {
    // Invariant 1: this slice changed classification and diagnostics only.
    // A refusal that started auto-updating would be a write-gate change
    // wearing a diagnostics change's clothes.
    for (const driftClass of ['local_growth', 'upstream_only', 'unobserved']) {
      const repo = repoInClass(driftClass);
      const before = fs.readFileSync(path.join(repo, DEST), 'utf8');

      const applied = installHookPack(SHARED_PACK, { repoRoot: repo });
      const action = actionFor(applied.actions, DEST);

      expect(action.action).toBe('refused');
      expect(action.driftClass).toBe(driftClass);
      expect(fs.readFileSync(path.join(repo, DEST), 'utf8')).toBe(before);
      // No --overwrite was passed, so the refusal is the plain kind: nothing
      // was selected for replacement and no diff was withheld.
      expect(action.forceRequired).toBeUndefined();
    }
  });

  test('plan and apply report the same class for the same file', () => {
    // Invariant 4: planOne and applyOne classify through the shared
    // resolveCollision, so a preview can never promise an outcome the write
    // path contradicts.
    for (const driftClass of ['local_growth', 'upstream_only', 'unobserved']) {
      const repo = repoInClass(driftClass);
      const planned = planActionFor(repo);
      const applied = actionFor(installHookPack(SHARED_PACK, { repoRoot: repo }).actions, DEST);

      expect(planned.driftClass).toBe(driftClass);
      expect(applied.driftClass).toBe(planned.driftClass);
      expect(applied.action).toBe(planned.action);
    }
  });

  test('an unmanaged collision carries no drift class', () => {
    // driftClass answers "which side moved", which only has meaning for a file
    // this installer wrote. A foreign file at a managed path has no baseline to
    // decompose against, so claiming a class for it would be a fabricated
    // verdict rather than a missing one.
    const repo = makeTempRepo();
    installHookPack(SHARED_PACK, { repoRoot: repo });
    fs.writeFileSync(path.join(repo, DEST), '#!/usr/bin/env bash\necho foreign\n');

    const action = planActionFor(repo);

    expect(action.action).toBe('refused');
    expect(action.refusalReason).toBe('unmanaged_collision');
    expect(action.driftClass).toBeUndefined();
  });

  test('A4: init --plan --json carries driftClass through the real CLI', () => {
    // Proven against dist through the actual command, not the handler: the
    // parse/serialize layer is where an added field silently fails to reach
    // the consumer that a JSON contract exists for.
    const repo = repoInClass('upstream_only');

    const res = runCliIsolated(repo, ['init', '--agent-surface', 'dsh', '--plan', '--json']);
    const plan = JSON.parse(res.stdout);
    const action = actionFor(plan.hook_pack.actions, DEST);

    expect(action.refusalReason).toBe('managed_drift');
    expect(action.driftClass).toBe('upstream_only');
    // The existing field keeps its value: widening refusalReason instead of
    // adding a sibling would break every consumer already matching on it.
    expect(plan.read_only).toBe(true);
  });

  test('A4: the rendered plan text names the class instead of a bare refusal', () => {
    const repo = repoInClass('upstream_only');

    const res = runCliIsolated(repo, ['init', '--agent-surface', 'dsh', '--plan']);

    expect(res.stdout).toContain('Would refuse — template moved; no local edit recorded');
    expect(res.stdout).toContain(DEST);
    // The guidance must not promise safety the baseline cannot establish.
    expect(res.stdout).toContain('caws init diff');
  });
});
