'use strict';

/**
 * CAWS-DEFECT-DRIFT-DISCHARGE-UNDISCOVERABLE-01 — the non-destructive discharge
 * for a drifted hook is named where the agent actually reads it.
 *
 * `caws init port <path> --from <file>` lands reviewed content through the
 * managed installer: it validates, version-stamps, records a fresh pristine
 * baseline and audit-commits, so drift tracking RESUMES. It is the only path
 * that both takes upstream and keeps local growth.
 *
 * Every drift refusal used to offer exactly two things: `--overwrite --force`
 * (discard local edits) and `--adopt` (keep them and stop tracking drift).
 * Neither reconciles. Refusal text is the only surface read at the moment of a
 * block, so a discharge absent from it does not exist for the agent hitting it
 * — the same shape as the reprieve/waiver discoverability gap.
 *
 * Compounding it, five help descriptions scoped these to "Legacy packs only" /
 * "LEGACY project-pack". The code makes no such check: resolvePacks returns
 * SHARED_PACK (the current pack) for diff and port, and overwriteSelects has no
 * legacy gate. An agent reading "legacy" concludes the discharge is not for it.
 *
 * A3 is the load-bearing test here: it follows the printed advice end to end on
 * a CURRENT shared-pack file. Guidance naming a command that does not work on
 * the reader's pack is worse than naming nothing, because it spends the trust
 * that makes refusals followable at all.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeTempRepo, cleanupAll, git } = require('../helpers/git-repo-factory');
const { SHARED_PACK } = require('../../dist/init/hook-packs/manifest-shared');
const { installHookPack, planHookPackInstall } = require('../../dist/init/hook-install');
const { renderHookPackInstall } = require('../../dist/shell/render/init-hook-pack');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
const DEST = '.caws/hooks/block-dangerous.sh';

afterAll(() => cleanupAll());

function runCliIsolated(root, args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-discharge-home-'));
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

const baselineAbs = (repo) =>
  path.join(repo, '.caws', 'hooks', '.pristine', 'shared', ...DEST.split('/'));

/** Install the shipping pack, then grow DEST locally and commit, leaving a
 *  clean tree (init port refuses to land over uncommitted changes). */
function repoWithCommittedGrowth() {
  const repo = makeTempRepo();
  installHookPack(SHARED_PACK, { repoRoot: repo });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'install shared hook pack', '--no-verify']);

  const grown = `${fs.readFileSync(path.join(repo, DEST), 'utf8')}\n# repo-local guard growth\n`;
  fs.writeFileSync(path.join(repo, DEST), grown);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'grow the guard locally', '--no-verify']);
  return { repo, grown };
}

describe('drift discharge is discoverable (CAWS-DEFECT-DRIFT-DISCHARGE-UNDISCOVERABLE-01)', () => {
  test('A1: the applied-install refusal names port and separates it from --adopt', () => {
    const { repo } = repoWithCommittedGrowth();
    const rendered = renderHookPackInstall(installHookPack(SHARED_PACK, { repoRoot: repo }));

    expect(rendered).toContain('caws init port <path> --from <staging-file>');
    // The two must not read as interchangeable ways to quiet the warning: one
    // resumes tracking, the other ends it. Collapsing them teaches an agent to
    // stop tracking drift instead of reconciling it.
    expect(rendered).toContain('drift tracking RESUMES');
    expect(rendered).toContain('STOP tracking drift');
  });

  test('A1: the plan refusal names port for a drift class', () => {
    const { repo } = repoWithCommittedGrowth();
    const res = runCliIsolated(repo, ['init', '--agent-surface', 'dsh', '--plan']);

    expect(res.stdout).toContain('caws init port <path> --from <staging-file>');
    expect(res.stdout).toContain('drift tracking resumes');
  });

  test('A2: no discharge surface claims a legacy-only scope the code does not enforce', () => {
    const repo = makeTempRepo();
    const initHelp = runCliIsolated(repo, ['init', '--help']).stdout;
    const portHelp = runCliIsolated(repo, ['init', 'port', '--help']).stdout;

    // Disproved at runtime: --overwrite --force refreshed a current dsh v3 pack
    // file in this repo on 2026-09-16. resolvePacks returns SHARED_PACK for
    // diff/port, and overwriteSelects has no legacy branch at all.
    expect(initHelp).not.toContain('Legacy packs only');
    expect(portHelp).not.toContain('LEGACY project-pack');
    // And the surviving text has to carry the property that makes port the
    // right choice, not merely omit the false one.
    expect(portHelp).toContain('non-destructive discharge');
    expect(initHelp).toContain('caws init port');
  });

  test('A3: following the printed advice actually discharges the drift', () => {
    const { repo, grown } = repoWithCommittedGrowth();

    // Before: the file is refused as growth, so the advice is what an agent
    // would be reading at this point.
    const before = planHookPackInstall(SHARED_PACK, { repoRoot: repo }).actions.find(
      (a) => a.destPath === DEST
    );
    expect(before.action).toBe('refused');
    expect(before.driftClass).toBe('local_growth');

    // Reconcile by hand into a staging file OUTSIDE the protected hooks tree,
    // exactly as the refusal instructs.
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-port-staging-'));
    const staging = path.join(stagingDir, 'reconciled.sh');
    fs.writeFileSync(staging, `${grown}# upstream line taken during reconciliation\n`);

    try {
      const res = runCliIsolated(repo, ['init', 'port', DEST, '--from', staging]);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('baseline recorded, drift tracking resumed');

      // The reconciled body landed, keeping BOTH the local growth and the line
      // taken from upstream — the property --overwrite --force cannot provide.
      const landed = fs.readFileSync(path.join(repo, DEST), 'utf8');
      expect(landed).toContain('# repo-local guard growth');
      expect(landed).toContain('# upstream line taken during reconciliation');

      // The path stays TRACKED as drift, and that is correct: a reconciled body
      // permanently differs from the template. What matters is that it is still
      // called growth.
      const after = planHookPackInstall(SHARED_PACK, { repoRoot: repo }).actions.find(
        (a) => a.destPath === DEST
      );
      expect(after.action).toBe('refused');
      expect(after.driftClass).toBe('local_growth');
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  });

  test('A4: a port baselines the template, so reconciled work is never called upstream_only', () => {
    // The defect this pins: baselining the ported body made installed ===
    // baseline true for a file that is mostly local work, so the classifier
    // reported "no local edit recorded" about reconciled content — the label
    // that makes --overwrite --force look safe on exactly the wrong file.
    const { repo, grown } = repoWithCommittedGrowth();
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-port-staging-'));
    const staging = path.join(stagingDir, 'reconciled.sh');
    fs.writeFileSync(staging, `${grown}# upstream line taken during reconciliation\n`);

    try {
      expect(runCliIsolated(repo, ['init', 'port', DEST, '--from', staging]).status).toBe(0);

      const landed = fs.readFileSync(path.join(repo, DEST), 'utf8');
      const baseline = fs.readFileSync(baselineAbs(repo), 'utf8');

      // The baseline is the UPSTREAM body, not what landed — that is what keeps
      // "installed minus baseline = local growth" true on both write paths.
      expect(baseline).not.toBe(landed);
      expect(baseline).not.toContain('# repo-local guard growth');
      expect(baseline).not.toContain('# upstream line taken during reconciliation');

      const after = planHookPackInstall(SHARED_PACK, { repoRoot: repo }).actions.find(
        (a) => a.destPath === DEST
      );
      expect(after.driftClass).toBe('local_growth');
      expect(after.driftClass).not.toBe('upstream_only');
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  });
});
