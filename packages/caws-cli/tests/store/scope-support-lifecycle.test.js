/**
 * scope.support must be usable end to end, not just at the scope-check surface.
 *
 * scope.support exists for repo-root deliverables a lane needs to EDIT but must
 * not CLAIM (README, package.json, CHANGELOG) — `caws scope show` admits them
 * and `amend-scope`'s advisory actively recommends them for exactly that case.
 * Two surfaces disagreed with that contract:
 *
 *   A1: the merge-time lane-provenance guard read scope.in only, so a lane
 *       commit touching a support path was reported as "outside spec scope" and
 *       the branch could be written but never landed.
 *   A2: removing the last scope.support entry left `support:` with no value,
 *       which parses as null and the spec schema rejects as "Expected array" —
 *       so the entry could be added and never removed.
 *
 * These drive the REAL compiled writers against REAL git repos in temp dirs, no
 * mocked git, because both properties are about what the actual merge guard and
 * the actual on-disk YAML do.
 *
 * [CAWS-DEFECT-SCOPE-SUPPORT-UNMERGEABLE-01]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createSpec, amendScopeSpec } = require('../../dist/store/specs-writer');
const { loadSpecs } = require('../../dist/store/specs-store');
const { createWorktree, mergeWorktree } = require('../../dist/store/worktrees-writer');
const { initProject } = require('../../dist/store/init-store');

const SESSION_ID = 'sess-scope-support';
const SESSION = { session_id: SESSION_ID, platform: 'jest' };
const ACTOR = { kind: 'agent', id: 'scope-support-agent', session_id: SESSION_ID };
const CANDIDATES = { candidates: [{ identity: SESSION, source: 'hook_env' }], trace: [] };

const repos = [];

afterAll(() => {
  for (const r of repos) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  }
});

function mkRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  repos.push(root);
  return path.join(root, '.caws');
}

function setupCaws(prefix) {
  const caws = mkRepo(prefix);
  const r = initProject(path.dirname(caws));
  if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
  return caws;
}

function commitAll(repoRoot, message) {
  execFileSync('git', ['-C', repoRoot, 'add', '-A']);
  execFileSync('git', ['-C', repoRoot, 'commit', '--quiet', '--no-verify', '-m', message]);
}

function seedSpec(caws, id, scopeIn) {
  const r = createSpec(caws, {
    id,
    title: 'x',
    mode: 'chore',
    riskTier: 3,
    actor: ACTOR,
    scopeIn,
  });
  if (!r.ok || r.value.kind !== 'success') {
    throw new Error('seed spec failed: ' + JSON.stringify(r));
  }
}

/** The spec as it is actually stored, after a round trip through disk. */
function specOnDisk(caws, id) {
  const loaded = loadSpecs(caws);
  const spec = loaded.specs.find((s) => s.id === id);
  if (spec === undefined) {
    throw new Error(`spec ${id} did not load: ${JSON.stringify(loaded.diagnostics ?? [])}`);
  }
  return spec;
}

// ─── A1: a lane commit touching a support path is landable ───────────────────

describe('A1: merge accepts lane commits touching scope.support', () => {
  test('a commit touching ONLY a support path merges instead of being called out-of-scope', () => {
    const caws = setupCaws('sslc-a1-');
    const repo = path.dirname(caws);
    seedSpec(caws, 'SSLC-A1-001', ['src/lane.txt']);
    const amended = amendScopeSpec(caws, {
      id: 'SSLC-A1-001',
      addSupport: ['README.md'],
      actor: ACTOR,
    });
    expect(amended.ok).toBe(true);
    commitAll(repo, 'seed spec');

    const created = createWorktree(caws, {
      name: 'wt-a1',
      specId: 'SSLC-A1-001',
      session: SESSION,
      actor: ACTOR,
    });
    expect(created.ok).toBe(true);

    const wtPath = path.join(caws, 'worktrees', 'wt-a1');
    fs.writeFileSync(path.join(wtPath, 'README.md'), '# edited by the lane\n');
    execFileSync('git', ['-C', wtPath, 'add', 'README.md']);
    execFileSync('git', ['-C', wtPath, 'commit', '--quiet', '--no-verify', '-m', 'docs: readme']);

    const result = mergeWorktree(caws, {
      name: 'wt-a1',
      session: SESSION,
      sessionCandidates: CANDIDATES,
      actor: ACTOR,
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    // The landed base branch really carries the support-path edit.
    const merged = execFileSync('git', ['-C', repo, 'show', 'main:README.md'], {
      encoding: 'utf8',
    });
    expect(merged).toMatch(/edited by the lane/);
  });

  test('a commit touching a path in NEITHER scope.in nor scope.support is still refused', () => {
    const caws = setupCaws('sslc-a1b-');
    const repo = path.dirname(caws);
    seedSpec(caws, 'SSLC-A1B-001', ['src/lane.txt']);
    const amended = amendScopeSpec(caws, {
      id: 'SSLC-A1B-001',
      addSupport: ['README.md'],
      actor: ACTOR,
    });
    expect(amended.ok).toBe(true);
    commitAll(repo, 'seed spec');

    const created = createWorktree(caws, {
      name: 'wt-a1b',
      specId: 'SSLC-A1B-001',
      session: SESSION,
      actor: ACTOR,
    });
    expect(created.ok).toBe(true);

    const wtPath = path.join(caws, 'worktrees', 'wt-a1b');
    fs.writeFileSync(path.join(wtPath, 'INTRUDER.md'), 'not mine\n');
    execFileSync('git', ['-C', wtPath, 'add', 'INTRUDER.md']);
    execFileSync('git', ['-C', wtPath, 'commit', '--quiet', '--no-verify', '-m', 'docs: intruder']);

    const result = mergeWorktree(caws, {
      name: 'wt-a1b',
      session: SESSION,
      sessionCandidates: CANDIDATES,
      actor: ACTOR,
    });

    // Widening the admitted set to include support must not disarm the guard:
    // an unrelated path is still foreign, and the diagnostic still names it.
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result.errors);
    expect(text).toMatch(/outside spec scope/);
    expect(text).toMatch(/INTRUDER\.md/);
  });
});

// ─── A2: the last support entry can be removed ───────────────────────────────

describe('A2: removing the last scope.support entry', () => {
  test('emptying scope.support succeeds and leaves a valid empty list', () => {
    const caws = setupCaws('sslc-a2-');
    seedSpec(caws, 'SSLC-A2-001', ['src/lane.txt']);

    const added = amendScopeSpec(caws, {
      id: 'SSLC-A2-001',
      addSupport: ['README.md'],
      actor: ACTOR,
    });
    expect(added.ok).toBe(true);
    expect(specOnDisk(caws, 'SSLC-A2-001').scope.support).toEqual(['README.md']);

    const removed = amendScopeSpec(caws, {
      id: 'SSLC-A2-001',
      removeSupport: ['README.md'],
      actor: ACTOR,
    });

    expect(removed.ok).toBe(true);
    expect(removed.value.kind).toBe('success');
    // Not null, not absent-and-unparseable: an empty list the schema accepts.
    expect(specOnDisk(caws, 'SSLC-A2-001').scope.support).toEqual([]);
  });

  test('emptying scope.support does not disturb scope.in', () => {
    const caws = setupCaws('sslc-a2b-');
    seedSpec(caws, 'SSLC-A2B-001', ['src/lane.txt', 'src/other.txt']);

    amendScopeSpec(caws, { id: 'SSLC-A2B-001', addSupport: ['README.md'], actor: ACTOR });
    const removed = amendScopeSpec(caws, {
      id: 'SSLC-A2B-001',
      removeSupport: ['README.md'],
      actor: ACTOR,
    });

    expect(removed.ok).toBe(true);
    expect(specOnDisk(caws, 'SSLC-A2B-001').scope.in).toEqual([
      'src/lane.txt',
      'src/other.txt',
    ]);
  });

  test('removing the last scope.out entry is equally landable', () => {
    // scope.out reaches the same emptying path; it was only ever reported for
    // support because that is where an operator hit it first.
    const caws = setupCaws('sslc-a2c-');
    seedSpec(caws, 'SSLC-A2C-001', ['src/lane.txt']);

    amendScopeSpec(caws, { id: 'SSLC-A2C-001', addOut: ['vendor'], actor: ACTOR });
    const removed = amendScopeSpec(caws, {
      id: 'SSLC-A2C-001',
      removeOut: ['vendor'],
      actor: ACTOR,
    });

    expect(removed.ok).toBe(true);
    expect(specOnDisk(caws, 'SSLC-A2C-001').scope.out).toEqual([]);
  });

  test('add and remove in the SAME call resolves to the added entry', () => {
    // The shape an operator reaches for when moving a path from support to in:
    // `--add <p> --remove-support <p>`. It must not error partway.
    const caws = setupCaws('sslc-a2d-');
    seedSpec(caws, 'SSLC-A2D-001', ['src/lane.txt']);

    amendScopeSpec(caws, { id: 'SSLC-A2D-001', addSupport: ['README.md'], actor: ACTOR });
    const moved = amendScopeSpec(caws, {
      id: 'SSLC-A2D-001',
      addIn: ['README.md'],
      removeSupport: ['README.md'],
      actor: ACTOR,
    });

    expect(moved.ok).toBe(true);
    const spec = specOnDisk(caws, 'SSLC-A2D-001');
    expect(spec.scope.in).toContain('README.md');
    expect(spec.scope.support).toEqual([]);
  });
});
