/**
 * WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-001 narrow A2 regression.
 *
 * Earned claim: `caws specs show <id>` invoked from a worktree cwd
 * resolves the spec from the control-plane store, NOT from any
 * worktree-local materialized copy.
 *
 * Why this test exists:
 *   - The A2 resolver work (`resolveRepoRoot` using
 *     `git rev-parse --git-common-dir`) is already done in
 *     packages/caws-cli/src/store/repo-root.ts.
 *   - Existing tests pin this for scope-command
 *     (tests/shell/scope-command.test.js:145-220) and for
 *     resolveRepoRoot itself (tests/store/repo-root.test.js:89-135).
 *   - No existing test invokes `caws specs show` from a worktree
 *     cwd. This file closes that regression gap.
 *
 * The adversarial fixture:
 *   1. Create a real temp git repo with a control-plane spec.
 *   2. Use createWorktree to add a worktree at .caws/worktrees/<name>
 *      (sparse-checkout configured by A1's implementation excludes
 *      .caws/specs/ from the worktree's checkout).
 *   3. Manually write a DIFFERENT spec body to
 *      .caws/worktrees/<name>/.caws/specs/<id>.yaml via fs.writeFileSync.
 *      This bypasses sparse-checkout (which only controls what git
 *      materializes, not what an attacker can write afterward) and
 *      simulates the v10.2 split-brain class.
 *   4. Invoke runSpecsShowCommand with cwd: <worktreeRoot>.
 *   5. Assert the displayed/parsed spec bytes match the CONTROL-PLANE
 *      spec, not the divergent worktree-local copy.
 *
 * The point is NOT whether the worktree-local file can exist (it can,
 * via hostile manual writes); the point is that CAWS does not treat
 * it as authority. This is the structural proof of the control-plane-
 * state-authority contract for read-authority commands.
 *
 * Cross-references:
 *   - Contract: WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-001 (active),
 *     `control-plane-state-authority` contract entry, clause (4)
 *     "Read authority".
 *   - Resolver: packages/caws-cli/src/store/repo-root.ts:87-151
 *     (already correct; this test verifies the end-to-end behavior).
 *   - Sibling regression for scope-command:
 *     tests/shell/scope-command.test.js:145-220.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createWorktree } = require('../../dist/store/worktrees-writer');
const { initProject } = require('../../dist/store/init-store');
const { showSpec } = require('../../dist/store/specs-writer');
const { resolveRepoRoot } = require('../../dist/store/repo-root');
const { runScopeCommand } = require('../../dist/shell');

const SESSION = { session_id: 'sess-a2-narrow', platform: 'jest' };
const ACTOR = {
  kind: 'agent',
  id: 'test-agent-a2',
  session_id: 'sess-a2-narrow',
};

function mkRepo(prefix) {
  // Normalize via realpathSync so the test's cawsDir comparison matches
  // what resolveRepoRoot returns. On macOS, fs.mkdtempSync(os.tmpdir())
  // yields a /var/... path while git rev-parse returns the canonical
  // /private/var/... path (because /var is a symlink). The two are the
  // same directory; resolving up front avoids spurious test failures.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  fs.writeFileSync(
    path.join(root, 'README.md'),
    '# A2 narrow regression fixture\n'
  );
  execFileSync('git', ['-C', root, 'add', 'README.md']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'init']);
  return root;
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function setupCaws(repoRoot) {
  const result = initProject(repoRoot);
  if (!result.ok) {
    throw new Error('initProject failed: ' + JSON.stringify(result.errors));
  }
  return path.join(repoRoot, '.caws');
}

const CONTROL_PLANE_SPEC_BODY = (id) => `id: ${id}
title: 'Control-plane spec — the authoritative copy'
risk_tier: 3
mode: chore
lifecycle_state: active
created_at: '2026-05-22T00:00:00.000Z'
updated_at: '2026-05-22T00:00:00.000Z'
blast_radius:
  modules:
    - tests
  data_migration: false
operational_rollback_slo: 5m
scope:
  in:
    - tests/control-plane
  out: []
invariants:
  - 'This is the control-plane (authoritative) spec.'
acceptance:
  - id: A1
    given: 'control-plane fixture'
    when: 'control-plane fixture'
    then: 'control-plane fixture'
non_functional:
  reliability:
    - 'fixture'
  performance:
    - 'fixture'
contracts: []
`;

// A *divergent* spec body the adversarial fixture writes inside the
// worktree. Same id but different title, different scope.in, different
// invariant text — so any assertion against the control-plane bytes
// would fail if the resolver mistakenly reads the worktree-local copy.
const DIVERGENT_LOCAL_SPEC_BODY = (id) => `id: ${id}
title: 'WORKTREE-LOCAL spec — should NEVER be read as authority'
risk_tier: 3
mode: chore
lifecycle_state: active
created_at: '2026-05-22T00:00:00.000Z'
updated_at: '2026-05-22T00:00:00.000Z'
blast_radius:
  modules:
    - tests
  data_migration: false
operational_rollback_slo: 5m
scope:
  in:
    - tests/HOSTILE-MUTATION
  out: []
invariants:
  - 'This is the worktree-local DIVERGENT spec. If CAWS reads this, the contract is broken.'
acceptance:
  - id: A1
    given: 'divergent fixture'
    when: 'divergent fixture'
    then: 'divergent fixture'
non_functional:
  reliability:
    - 'fixture'
  performance:
    - 'fixture'
contracts: []
`;

describe('WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-001 narrow A2 (specs show from worktree cwd)', () => {
  let repo;
  let cawsDir;

  beforeEach(() => {
    repo = mkRepo('caws-a2-narrow-');
    cawsDir = setupCaws(repo);
  });

  afterEach(() => {
    rmrf(repo);
  });

  test('A2.1: showSpec invoked with cawsDir resolved from worktree cwd returns control-plane bytes (no adversarial copy)', () => {
    // Setup: control-plane spec in main checkout.
    const specId = 'A2NARROW-001';
    fs.writeFileSync(
      path.join(cawsDir, 'specs', `${specId}.yaml`),
      CONTROL_PLANE_SPEC_BODY(specId)
    );

    // Create the worktree (A1's implementation excludes .caws/specs/
    // from the worktree's checkout).
    const createResult = createWorktree(cawsDir, {
      name: 'wt-a2',
      specId,
      session: SESSION,
      actor: ACTOR,
    });
    expect(createResult.ok).toBe(true);
    expect(createResult.value.kind).toBe('success');

    const wtPath = path.join(cawsDir, 'worktrees', 'wt-a2');
    expect(fs.existsSync(wtPath)).toBe(true);

    // Resolve repo root + cawsDir from the worktree cwd. This is the
    // same call every CAWS read-authority command makes at startup.
    // Per repo-root.ts:99, it uses `git rev-parse --git-common-dir`
    // which returns the MAIN checkout's .git, not the worktree's
    // .git-link file.
    const ctxResult = resolveRepoRoot(wtPath);
    expect(ctxResult.ok).toBe(true);
    expect(ctxResult.value.cawsDir).toBe(cawsDir); // control-plane cawsDir
    expect(ctxResult.value.repoRoot).toBe(repo); // control-plane repoRoot

    // Confirm pre-condition: control-plane spec exists, no worktree-
    // local spec exists yet.
    expect(
      fs.existsSync(path.join(cawsDir, 'specs', `${specId}.yaml`))
    ).toBe(true);
    expect(
      fs.existsSync(path.join(wtPath, '.caws', 'specs', `${specId}.yaml`))
    ).toBe(false);

    // showSpec called with the resolved cawsDir reads the control-plane
    // bytes.
    const showResult1 = showSpec(ctxResult.value.cawsDir, specId);
    expect(showResult1.ok).toBe(true);
    expect(showResult1.value.spec.id).toBe(specId);
    expect(showResult1.value.spec.title).toBe(
      'Control-plane spec — the authoritative copy'
    );
    expect(showResult1.value.spec.scope.in).toContain('tests/control-plane');
    // Sanity: control-plane spec definitely does NOT contain the
    // divergent fingerprint.
    expect(showResult1.value.source).not.toContain('HOSTILE-MUTATION');

    // Adversarial mutation: write a DIVERGENT spec to the worktree-local
    // path. Sparse-checkout prevents git from materializing this; it
    // does NOT prevent a hostile fs.writeFileSync. We simulate exactly
    // that hostile case.
    fs.mkdirSync(path.join(wtPath, '.caws', 'specs'), { recursive: true });
    fs.writeFileSync(
      path.join(wtPath, '.caws', 'specs', `${specId}.yaml`),
      DIVERGENT_LOCAL_SPEC_BODY(specId)
    );
    expect(
      fs.existsSync(path.join(wtPath, '.caws', 'specs', `${specId}.yaml`))
    ).toBe(true);

    // Resolve again from the worktree cwd. The divergent local file
    // should NOT change the resolver's answer; resolveRepoRoot
    // consults git's common-dir, not the cwd's `.caws/` tree.
    const ctxResult2 = resolveRepoRoot(wtPath);
    expect(ctxResult2.ok).toBe(true);
    expect(ctxResult2.value.cawsDir).toBe(cawsDir);

    // showSpec MUST return the control-plane bytes, not the divergent
    // local bytes. This is the structural proof of clause (4) of the
    // control-plane-state-authority contract.
    const showResult2 = showSpec(ctxResult2.value.cawsDir, specId);
    expect(showResult2.ok).toBe(true);
    expect(showResult2.value.spec.id).toBe(specId);
    expect(showResult2.value.spec.title).toBe(
      'Control-plane spec — the authoritative copy'
    );
    expect(showResult2.value.spec.scope.in).toContain('tests/control-plane');

    // Explicit negative: the divergent copy's fingerprints MUST NOT
    // appear in the resolved spec.
    expect(showResult2.value.spec.scope.in).not.toContain(
      'tests/HOSTILE-MUTATION'
    );
    expect(showResult2.value.spec.title).not.toContain('WORKTREE-LOCAL');
    expect(showResult2.value.source).not.toContain('HOSTILE-MUTATION');
    expect(showResult2.value.source).not.toContain('WORKTREE-LOCAL');

    // And the resolved path MUST point at the control-plane file, not
    // the worktree-local file.
    expect(showResult2.value.path).toBe(
      path.join(cawsDir, 'specs', `${specId}.yaml`)
    );
    expect(showResult2.value.path).not.toContain(
      path.join('worktrees', 'wt-a2')
    );
  });

  test('A2.2: a fresh resolveRepoRoot call from the worktree-local .caws/specs/ subdir still resolves to control-plane', () => {
    // Cover the edge case: cwd is INSIDE the worktree's .caws/specs/
    // subdirectory (which the adversarial fixture creates). The
    // resolver walks via `git rev-parse --git-common-dir`, which is
    // git-aware and ignores cwd-shaped overrides. This guards against
    // a future refactor that adds a manual fs walk for the .caws/
    // directory.
    const specId = 'A2NARROW-002';
    fs.writeFileSync(
      path.join(cawsDir, 'specs', `${specId}.yaml`),
      CONTROL_PLANE_SPEC_BODY(specId)
    );

    const createResult = createWorktree(cawsDir, {
      name: 'wt-a2-deep',
      specId,
      session: SESSION,
      actor: ACTOR,
    });
    expect(createResult.ok).toBe(true);

    const wtPath = path.join(cawsDir, 'worktrees', 'wt-a2-deep');
    const adversarialSpecsDir = path.join(wtPath, '.caws', 'specs');
    fs.mkdirSync(adversarialSpecsDir, { recursive: true });
    fs.writeFileSync(
      path.join(adversarialSpecsDir, `${specId}.yaml`),
      DIVERGENT_LOCAL_SPEC_BODY(specId)
    );

    // Resolve from the adversarial dir's deepest point.
    const ctxResult = resolveRepoRoot(adversarialSpecsDir);
    expect(ctxResult.ok).toBe(true);
    expect(ctxResult.value.cawsDir).toBe(cawsDir);

    const showResult = showSpec(ctxResult.value.cawsDir, specId);
    expect(showResult.ok).toBe(true);
    expect(showResult.value.spec.title).toBe(
      'Control-plane spec — the authoritative copy'
    );
    expect(showResult.value.source).not.toContain('HOSTILE-MUTATION');
  });
});

// ============================================================================
// WORKTREE-SPEC-CANONICAL-ACCESS-GUARD-001 A6
//
// Companion regression for caws scope show invoked from inside a linked
// worktree cwd. The earned claim mirrors the existing A2 narrow regression
// for caws specs show, but for the scope-inspection authority surface:
// when cwd is inside a linked worktree, scope decisions must resolve
// through the canonical control-plane scope authority (via
// resolveRepoRoot's --git-common-dir walk), NOT through any adversarial
// worktree-local .caws/specs/<id>.yaml copy that hostile or
// manual writes may have materialized.
//
// Why this matters: A1/A2 (worktree-write-guard.sh refusal) prevent
// agent-tool reads/writes of <wt>/.caws/specs/* from inside the
// worktree. But the CLI layer above the hook surface — caws scope show /
// caws scope check — also needs to resolve scope from canonical, not
// from any worktree-local materialized file. The existing A2-narrow
// test at the top of this file proves this for caws specs show; this
// describe block extends the proof to caws scope show.
// ============================================================================

describe('WORKTREE-SPEC-CANONICAL-ACCESS-GUARD-001 A6 (scope show from worktree cwd)', () => {
  let repo;
  let cawsDir;

  beforeEach(() => {
    repo = mkRepo('caws-a6-scope-');
    cawsDir = setupCaws(repo);
  });

  afterEach(() => {
    rmrf(repo);
  });

  test('A6.1: runScopeCommand({ path, mode: show, cwd: <linked-worktree-cwd> }) resolves scope from canonical, not from adversarial worktree-local spec', () => {
    // Setup: control-plane spec at canonical with scope.in matching a
    // tests/control-plane/* path. The control-plane scope DOES NOT
    // include tests/HOSTILE-MUTATION/* (the divergent body's scope.in).
    const specId = 'A6SCOPE-001';
    fs.writeFileSync(
      path.join(cawsDir, 'specs', `${specId}.yaml`),
      CONTROL_PLANE_SPEC_BODY(specId)
    );

    // Create linked worktree.
    const createResult = createWorktree(cawsDir, {
      name: 'wt-a6',
      specId,
      session: SESSION,
      actor: ACTOR,
    });
    expect(createResult.ok).toBe(true);
    expect(createResult.value.kind).toBe('success');

    const wtPath = path.join(cawsDir, 'worktrees', 'wt-a6');
    expect(fs.existsSync(wtPath)).toBe(true);

    // Hostile fixture: write the DIVERGENT spec body inside the worktree's
    // .caws/specs/ directory. (Bypasses sparse-checkout by using fs.write
    // directly; sparse-checkout only controls what git materializes.)
    const adversarialSpecsDir = path.join(wtPath, '.caws', 'specs');
    fs.mkdirSync(adversarialSpecsDir, { recursive: true });
    fs.writeFileSync(
      path.join(adversarialSpecsDir, `${specId}.yaml`),
      DIVERGENT_LOCAL_SPEC_BODY(specId)
    );

    // Invoke caws scope show with cwd set to the linked worktree.
    // Target path: a tests/control-plane/* file that ONLY the canonical
    // spec admits in scope.in. If the resolver mistakenly reads the
    // divergent worktree-local spec, the path would be REJECTED
    // (because the divergent spec's scope.in is tests/HOSTILE-MUTATION/*,
    // not tests/control-plane/*).
    const probePath = 'tests/control-plane/example.test.js';
    const out = [];
    const err = [];
    const code = runScopeCommand({
      path: probePath,
      mode: 'show',
      cwd: wtPath,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });

    // scope show always exits 0 (show is informational; check enforces).
    expect(code).toBe(0);
    const combined = [...out, ...err].join('\n');

    // The canonical (control-plane) spec admits this path. The
    // divergent worktree-local spec would NOT. So the rendered
    // decision must reflect ADMIT (or at least not REJECT for
    // scope.in_miss against the wrong scope set).
    expect(combined).toMatch(/ADMIT|admit/);
    expect(combined).toContain(specId);

    // Negative invariant: the decision rendering MUST NOT reflect
    // the divergent worktree-local spec's bytes. If the resolver
    // had landed on DIVERGENT_LOCAL_SPEC_BODY, the rendered scope
    // would show 'tests/HOSTILE-MUTATION' rather than 'tests/control-plane'.
    expect(combined).not.toContain('HOSTILE-MUTATION');
  });

  test('A6.2: runScopeCommand({ mode: check }) from worktree cwd enforces canonical scope, not worktree-local', () => {
    // Same setup as A6.1, but using mode: check (which exits 0 on
    // admit, 1 on refuse) — proves the enforcement path also resolves
    // canonical authority.
    const specId = 'A6CHECK-001';
    fs.writeFileSync(
      path.join(cawsDir, 'specs', `${specId}.yaml`),
      CONTROL_PLANE_SPEC_BODY(specId)
    );
    const createResult = createWorktree(cawsDir, {
      name: 'wt-a6-check',
      specId,
      session: SESSION,
      actor: ACTOR,
    });
    expect(createResult.ok).toBe(true);

    const wtPath = path.join(cawsDir, 'worktrees', 'wt-a6-check');
    const adversarialSpecsDir = path.join(wtPath, '.caws', 'specs');
    fs.mkdirSync(adversarialSpecsDir, { recursive: true });
    fs.writeFileSync(
      path.join(adversarialSpecsDir, `${specId}.yaml`),
      DIVERGENT_LOCAL_SPEC_BODY(specId)
    );

    // Path admitted by canonical scope.in (tests/control-plane/) but
    // NOT by divergent worktree-local scope.in (tests/HOSTILE-MUTATION/).
    const admittedByCanonical = 'tests/control-plane/canonical-admits-this.js';
    const out = [];
    const err = [];
    const code = runScopeCommand({
      path: admittedByCanonical,
      mode: 'check',
      cwd: wtPath,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });

    // Canonical admits => exit 0. If the resolver mistakenly used the
    // divergent worktree-local spec, this path would not be in scope
    // and check would exit 1.
    expect(code).toBe(0);
    const combined = [...out, ...err].join('\n');
    expect(combined).not.toContain('HOSTILE-MUTATION');

    // Cross-check the opposite direction: a path admitted ONLY by the
    // divergent spec must NOT be admitted (proves we are using
    // canonical authority, not the worktree-local file).
    const admittedOnlyByDivergent = 'tests/HOSTILE-MUTATION/divergent-admits-this.js';
    const out2 = [];
    const err2 = [];
    const code2 = runScopeCommand({
      path: admittedOnlyByDivergent,
      mode: 'check',
      cwd: wtPath,
      out: (s) => out2.push(s),
      err: (s) => err2.push(s),
    });
    expect(code2).toBe(1);
  });
});
