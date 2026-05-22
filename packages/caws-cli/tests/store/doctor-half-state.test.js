/**
 * WORKTREE-DOCTOR-HALF-STATE-001 — store integration tests.
 *
 * Verifies the store-side snapshot composition correctly populates the
 * new DoctorInput fields (filesystem.worktreeDirByName, gitWorktrees,
 * gitObservationFailure) and that the end-to-end doctor pipeline
 * produces the expected H1/H4/H5/H6/git-unavailable findings on real
 * temp repos.
 *
 * Test discipline:
 *   - Each H-class fixture is constructed directly on a real temp repo
 *     (no dependency on the lifecycle-rollback fault-injection seam).
 *   - Doctor purity is verified at integration level (A8): byte-compare
 *     .caws/worktrees.json + active spec YAMLs + events.jsonl before/after
 *     a doctor run; also assert git worktree list stable before/after.
 *   - Non-fatal git observation (A7) is exercised by running
 *     composeDoctorSnapshot against a repoRoot that is not a git repo;
 *     assert the report contains git_observation_unavailable INFO AND
 *     all other non-git-backed rules still fire.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  composeDoctorSnapshot,
} = require('../../dist/store/doctor-snapshot');
const { inspectProjectState, DOCTOR_RULES } = require('@paths.design/caws-kernel');

const NOW = new Date('2026-05-22T12:00:00.000Z');

// ---- fixture helpers ------------------------------------------------------

function mkRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', [
    '-C',
    root,
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'init',
  ]);
  return root;
}

function mkNonGitDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function makeCawsLayout(repoRoot) {
  const cawsDir = path.join(repoRoot, '.caws');
  fs.mkdirSync(cawsDir, { recursive: true });
  fs.mkdirSync(path.join(cawsDir, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(cawsDir, 'waivers'), { recursive: true });
  fs.mkdirSync(path.join(cawsDir, 'worktrees'), { recursive: true });
  fs.writeFileSync(
    path.join(cawsDir, 'policy.yaml'),
    `version: 1
risk_tiers:
  "1": { max_files: 5, max_loc: 200 }
  "2": { max_files: 15, max_loc: 600 }
  "3": { max_files: 30, max_loc: 1500 }
gates:
  budget_limit: { enabled: true, mode: block }
  spec_completeness: { enabled: true, mode: block }
  scope_boundary: { enabled: true, mode: block }
  god_object: { enabled: true, mode: warn }
  todo_detection: { enabled: true, mode: warn }
`
  );
  fs.writeFileSync(path.join(cawsDir, 'worktrees.json'), '{}');
  fs.writeFileSync(path.join(cawsDir, 'agents.json'), '{}');
  return cawsDir;
}

function writeSpec(cawsDir, id, opts = {}) {
  const lifecycle = opts.lifecycle ?? 'active';
  const worktreeLine =
    opts.worktree !== undefined ? `worktree: '${opts.worktree}'\n` : '';
  fs.writeFileSync(
    path.join(cawsDir, 'specs', `${id}.yaml`),
    `id: ${id}
title: 'Fixture spec'
risk_tier: 3
mode: chore
lifecycle_state: ${lifecycle}
created_at: '2026-05-22T00:00:00.000Z'
updated_at: '2026-05-22T11:59:30.000Z'
${worktreeLine}blast_radius:
  modules: [src/test]
  data_migration: false
operational_rollback_slo: 5m
scope:
  in: [src/test]
  out: []
invariants: ['fixture']
acceptance:
  - id: A1
    given: 'fixture'
    when: 'fixture'
    then: 'fixture'
non_functional: {}
contracts: []
`
  );
}

function writeRegistry(cawsDir, registry) {
  fs.writeFileSync(
    path.join(cawsDir, 'worktrees.json'),
    JSON.stringify(registry, null, 2)
  );
}

function snapshotCawsDirBytes(cawsDir) {
  // Concatenate all governance-state file bytes into one string for
  // byte-equality comparison. Skips directories that doctor never reads.
  const files = [];
  function walk(dir, relParts = []) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, ent.name);
      const rel = [...relParts, ent.name].join('/');
      if (ent.isDirectory()) {
        // Skip the worktrees/ dir contents — those are git worktrees,
        // not governance state; their internal content can shift on
        // its own.
        if (relParts.length === 0 && ent.name === 'worktrees') continue;
        walk(full, [...relParts, ent.name]);
      } else if (ent.isFile()) {
        files.push(`==${rel}==\n${fs.readFileSync(full, 'utf8')}`);
      }
    }
  }
  walk(cawsDir);
  return files.join('\n---\n');
}

function gitWorktreeListStable(repoRoot) {
  try {
    return execFileSync(
      'git',
      ['-C', repoRoot, 'worktree', 'list', '--porcelain'],
      { encoding: 'utf8' }
    );
  } catch {
    return '<<git failed>>';
  }
}

// ---------------------------------------------------------------------------

describe('WORKTREE-DOCTOR-HALF-STATE-001 store integration', () => {
  let repo;
  let cawsDir;

  beforeEach(() => {
    repo = mkRepo('caws-doctor-hs-');
    cawsDir = makeCawsLayout(repo);
  });

  afterEach(() => {
    rmrf(repo);
  });

  // ----- field plumbing ---------------------------------------------------

  describe('composeDoctorSnapshot field plumbing', () => {
    test('populates filesystem.worktreeDirByName for each registry entry', () => {
      writeSpec(cawsDir, 'PLUMB-001');
      writeRegistry(cawsDir, {
        'wt-present': { specId: 'PLUMB-001' },
        'wt-absent': { specId: 'PLUMB-001' },
      });
      fs.mkdirSync(path.join(cawsDir, 'worktrees', 'wt-present'));
      // wt-absent: directory intentionally not created

      const { doctorInput } = composeDoctorSnapshot({
        repoRoot: repo,
        cawsDir,
        now: NOW,
      });

      expect(doctorInput.filesystem).toBeDefined();
      expect(doctorInput.filesystem.worktreeDirByName).toEqual({
        'wt-present': true,
        'wt-absent': false,
      });
    });

    test('populates gitWorktrees when git observation succeeds (filters main worktree)', () => {
      // Add a real linked git worktree at a non-canonical path.
      const linkedPath = path.join(os.tmpdir(), `caws-doctor-hs-linked-${Date.now()}`);
      try {
        execFileSync('git', [
          '-C',
          repo,
          'worktree',
          'add',
          '--quiet',
          '-b',
          'linked-branch',
          linkedPath,
        ]);

        const { doctorInput } = composeDoctorSnapshot({
          repoRoot: repo,
          cawsDir,
          now: NOW,
        });

        expect(doctorInput.gitWorktrees).toBeDefined();
        // Main worktree (repo itself) MUST be filtered out.
        const paths = doctorInput.gitWorktrees.map((w) => w.path);
        expect(paths).not.toContain(repo);
        // The linked one MUST be present. realpath normalises macOS /tmp
        // symlink to /private/tmp; compare via realpath both sides.
        const realLinked = fs.realpathSync(linkedPath);
        expect(paths.map((p) => fs.realpathSync(p))).toContain(realLinked);

        expect(doctorInput.gitObservationFailure).toBeUndefined();
      } finally {
        // Clean up the linked worktree to keep the test isolated.
        try {
          execFileSync('git', [
            '-C',
            repo,
            'worktree',
            'remove',
            '--force',
            linkedPath,
          ]);
        } catch {
          /* best-effort */
        }
        rmrf(linkedPath);
      }
    });

    test('populates gitObservationFailure when repoRoot is not a git repo (non-fatal)', () => {
      // Construct a doctor snapshot against a non-git dir; the rest of
      // the snapshot still works because cawsDir is independent of git.
      const nonGitRoot = mkNonGitDir('caws-doctor-hs-nongit-');
      try {
        const nonGitCaws = makeCawsLayout(nonGitRoot);

        const { doctorInput } = composeDoctorSnapshot({
          repoRoot: nonGitRoot,
          cawsDir: nonGitCaws,
          now: NOW,
        });

        // gitWorktrees absent; gitObservationFailure present.
        expect(doctorInput.gitWorktrees).toBeUndefined();
        expect(typeof doctorInput.gitObservationFailure).toBe('string');
        expect(doctorInput.gitObservationFailure.length).toBeGreaterThan(0);

        // The rest of doctorInput still composed correctly.
        expect(doctorInput.filesystem).toBeDefined();
        expect(doctorInput.specs).toEqual([]);
      } finally {
        rmrf(nonGitRoot);
      }
    });
  });

  // ----- end-to-end rule firing through composeDoctorSnapshot -------------

  describe('end-to-end doctor findings on real fixtures', () => {
    test('H1: registry entry + missing dir + missing from git list → ghost_registry_entry ERROR', () => {
      writeSpec(cawsDir, 'H1-INT-001');
      writeRegistry(cawsDir, {
        'wt-ghost-int': { specId: 'H1-INT-001' },
      });
      // Intentionally do NOT create .caws/worktrees/wt-ghost-int dir
      // and do NOT git worktree add anything.

      const { doctorInput } = composeDoctorSnapshot({
        repoRoot: repo,
        cawsDir,
        now: NOW,
      });
      const report = inspectProjectState(doctorInput);

      const ghost = report.findings.find(
        (f) => f.rule === DOCTOR_RULES.WORKTREE_GHOST_REGISTRY_ENTRY
      );
      expect(ghost).toBeDefined();
      expect(ghost.severity).toBe('error');
      expect(ghost.subject).toBe('wt-ghost-int');
    });

    test('H4 enrichment: BINDING_SPEC_MISSING_REGISTRY data carries git_worktree_present', () => {
      writeSpec(cawsDir, 'H4-INT-001', { worktree: 'wt-h4-int' });
      // Empty registry — spec claims worktree, registry has no entry.
      writeRegistry(cawsDir, {});

      const { doctorInput } = composeDoctorSnapshot({
        repoRoot: repo,
        cawsDir,
        now: NOW,
      });
      const report = inspectProjectState(doctorInput);

      const finding = report.findings.find(
        (f) => f.rule === DOCTOR_RULES.BINDING_SPEC_MISSING_REGISTRY
      );
      expect(finding).toBeDefined();
      // worktreeDirByName is keyed by registry name. The registry is
      // empty here, so the map is empty. The enrichment fallback reads
      // false for any name not in the map. (worktreeDirByName[name] ===
      // true returns false when undefined.)
      expect(finding.data).toMatchObject({
        spec_id: 'H4-INT-001',
        worktree_name: 'wt-h4-int',
        git_worktree_present: false,
      });
    });

    test('H5: 3-way contradiction fires binding_contradiction_3way ERROR with doctrine pointer', () => {
      writeSpec(cawsDir, 'H5-INT-A-1', { worktree: 'wt-h5-int' });
      writeSpec(cawsDir, 'H5-INT-B-1');
      writeRegistry(cawsDir, {
        'wt-h5-int': { specId: 'H5-INT-B-1' },
      });

      const { doctorInput } = composeDoctorSnapshot({
        repoRoot: repo,
        cawsDir,
        now: NOW,
      });
      const report = inspectProjectState(doctorInput);

      const h5 = report.findings.find(
        (f) => f.rule === DOCTOR_RULES.WORKTREE_BINDING_CONTRADICTION_3WAY
      );
      expect(h5).toBeDefined();
      expect(h5.severity).toBe('error');
      // Substring-refusal: pin the no-shell-command UX rule at
      // integration level too (defence in depth — kernel test already
      // pins it; integration test confirms the doctrine pointer
      // survives the full pipeline).
      const repair = h5.narrowRepair ?? '';
      expect(repair).toContain('WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-001');
      for (const needle of [
        'caws worktree',
        'caws specs',
        'git ',
        'rm ',
        'mv ',
      ]) {
        expect(repair).not.toContain(needle);
      }
    });

    test('H6: foreign physical worktree fires foreign_physical INFO', () => {
      // Add a real linked git worktree that is NOT in .caws/worktrees.json.
      const foreignPath = path.join(
        os.tmpdir(),
        `caws-doctor-hs-foreign-${Date.now()}`
      );
      try {
        execFileSync('git', [
          '-C',
          repo,
          'worktree',
          'add',
          '--quiet',
          '-b',
          'foreign-branch',
          foreignPath,
        ]);

        const { doctorInput } = composeDoctorSnapshot({
          repoRoot: repo,
          cawsDir,
          now: NOW,
        });
        const report = inspectProjectState(doctorInput);

        const h6 = report.findings.find(
          (f) => f.rule === DOCTOR_RULES.WORKTREE_FOREIGN_PHYSICAL
        );
        expect(h6).toBeDefined();
        expect(h6.severity).toBe('info');
        // Subject is the path as git reports it.
        const realForeign = fs.realpathSync(foreignPath);
        expect(fs.realpathSync(h6.subject)).toBe(realForeign);
      } finally {
        try {
          execFileSync('git', [
            '-C',
            repo,
            'worktree',
            'remove',
            '--force',
            foreignPath,
          ]);
        } catch {
          /* best-effort */
        }
        rmrf(foreignPath);
      }
    });

    test('A7: non-fatal git observation — doctor still produces full report when git fails', () => {
      // Use a non-git dir as repoRoot. observeGitWorktrees fails;
      // gitObservationFailure is set. Doctor emits the INFO and skips
      // H1/H6. Other rules (H3 in this fixture) still fire.
      const nonGitRoot = mkNonGitDir('caws-doctor-hs-a7-');
      try {
        const nonGitCaws = makeCawsLayout(nonGitRoot);
        writeSpec(nonGitCaws, 'A7-INT-001', { worktree: 'wt-a7' });
        // Empty registry → H3 fires.
        writeRegistry(nonGitCaws, {});

        const { doctorInput } = composeDoctorSnapshot({
          repoRoot: nonGitRoot,
          cawsDir: nonGitCaws,
          now: NOW,
        });
        const report = inspectProjectState(doctorInput);

        // Git-unavailable INFO present.
        const gitUnavail = report.findings.find(
          (f) =>
            f.rule === DOCTOR_RULES.WORKTREE_GIT_OBSERVATION_UNAVAILABLE
        );
        expect(gitUnavail).toBeDefined();
        expect(gitUnavail.severity).toBe('info');

        // H3 still fires.
        const h3 = report.findings.find(
          (f) => f.rule === DOCTOR_RULES.BINDING_SPEC_MISSING_REGISTRY
        );
        expect(h3).toBeDefined();
        expect(h3.severity).toBe('error');

        // H1 and H6 silently skipped.
        expect(
          report.findings.find(
            (f) => f.rule === DOCTOR_RULES.WORKTREE_GHOST_REGISTRY_ENTRY
          )
        ).toBeUndefined();
        expect(
          report.findings.find(
            (f) => f.rule === DOCTOR_RULES.WORKTREE_FOREIGN_PHYSICAL
          )
        ).toBeUndefined();
      } finally {
        rmrf(nonGitRoot);
      }
    });
  });

  // ----- A8: doctor purity at integration level --------------------------

  describe('A8: doctor purity', () => {
    test('composeDoctorSnapshot + inspectProjectState leave .caws/ and git worktree list byte-identical', () => {
      // Mixed fixture: H3 + H6 + an existing valid binding.
      writeSpec(cawsDir, 'PURE-001');
      writeSpec(cawsDir, 'PURE-002', { worktree: 'wt-purity-orphan' });
      writeRegistry(cawsDir, {
        'wt-known': { specId: 'PURE-001' },
      });
      fs.mkdirSync(path.join(cawsDir, 'worktrees', 'wt-known'));

      const pre = snapshotCawsDirBytes(cawsDir);
      const preGit = gitWorktreeListStable(repo);

      const { doctorInput } = composeDoctorSnapshot({
        repoRoot: repo,
        cawsDir,
        now: NOW,
      });
      const report = inspectProjectState(doctorInput);

      // Sanity: the report actually has findings (otherwise purity is
      // trivially true).
      expect(report.findings.length).toBeGreaterThan(0);

      const post = snapshotCawsDirBytes(cawsDir);
      const postGit = gitWorktreeListStable(repo);

      expect(post).toBe(pre);
      expect(postGit).toBe(preGit);
    });
  });
});
