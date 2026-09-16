'use strict';

/**
 * Binding refuses a spec whose scope.in is still the create scaffold
 * (CAWS-SPEC-SCOPE-IN-PLACEHOLDER-CONTRACT-001).
 *
 * Drives the REAL compiled writers against REAL git repositories in temp dirs.
 *
 * Why a refusal and not an advisory: binding is the moment a spec becomes write
 * authority, and it is the last moment declaring the surface is cheap. The
 * scaffold admits nothing — it is a plain prefix entry and no real path begins
 * with it — so a bound scaffold hands the agent a lane that refuses every write
 * via scope.reject.scope_in_miss, discovered one strike at a time. Refusing at
 * bind converts that into one diagnostic naming the governed remediation.
 *
 * This guard asks no judgment question: it is exact string equality against the
 * single-sourced constant, never an inference about what the author meant. A
 * draft carrying the scaffold is the normal resting state, so `specs create`
 * and `specs validate` deliberately only advise; the refusal lives here, where
 * the scaffold stops being a placeholder and becomes a claim.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createSpec, SCOPE_IN_PLACEHOLDER } = require('../../dist/store/specs-writer');
const { createWorktree } = require('../../dist/store/worktrees-writer');
const { initProject } = require('../../dist/store/init-store');
const { loadWorktrees } = require('../../dist/store/worktrees-store');

const SESSION_ID = 'sess-scope-placeholder';
const SESSION = { session_id: SESSION_ID, platform: 'jest' };
const ACTOR = { kind: 'agent', id: 'jest', session_id: SESSION_ID };

const repos = [];
afterEach(() => {
  for (const repo of repos.splice(0)) {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

function mkRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  repos.push(root);
  const r = initProject(root);
  if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--no-verify', '-m', 'caws']);
  return { root, caws: path.join(root, '.caws') };
}

function seed(caws, id, scopeIn) {
  // initialState is explicit: the store-level createSpec defaults to 'active'
  // (specs-writer.ts), while the CLI passes 'draft'. Binding a draft is the
  // shape under test, so the default must not be relied on here.
  const input = {
    id,
    title: 'x',
    mode: 'chore',
    riskTier: 3,
    actor: ACTOR,
    initialState: 'draft',
  };
  if (scopeIn !== undefined) input.scopeIn = scopeIn;
  const r = createSpec(caws, input);
  if (!r.ok || r.value.kind !== 'success') {
    throw new Error('seed failed: ' + JSON.stringify(r));
  }
}

function specYaml(caws, id) {
  return fs.readFileSync(path.join(caws, 'specs', `${id}.yaml`), 'utf8');
}

describe('worktree bind refuses an undeclared scope.in', () => {
  test('create --spec refuses while the scaffold stands', () => {
    const { caws } = mkRepo('caws-bind-scaffold-');
    seed(caws, 'BIND-SCAFFOLD-001');

    const r = createWorktree(caws, {
      name: 'wt-scaffold',
      specId: 'BIND-SCAFFOLD-001',
      session: SESSION,
      actor: ACTOR,
    });

    expect(r.ok).toBe(false);
    const text = JSON.stringify(r.errors);
    // Assert the remediation names the governed command, not just that it
    // failed: the diagnostic is the only surface read at the moment of the
    // block, so naming amend-scope is the behavior under test.
    expect(text).toContain('amend-scope');
    expect(text).toContain('BIND-SCAFFOLD-001');
  });

  test('the refusal writes no registry entry and no binding', () => {
    // A refusal that half-registered would leave exactly the one-sided binding
    // the lifecycle transaction exists to prevent.
    const { caws } = mkRepo('caws-bind-scaffold-atomic-');
    seed(caws, 'BIND-ATOMIC-001');

    createWorktree(caws, {
      name: 'wt-atomic',
      specId: 'BIND-ATOMIC-001',
      session: SESSION,
      actor: ACTOR,
    });

    const reg = loadWorktrees(caws);
    expect(reg.ok).toBe(true);
    expect(reg.value['wt-atomic']).toBeUndefined();
    // The spec must remain a draft with no worktree key: binding is what
    // activates, and the refusal happened before that.
    const yaml = specYaml(caws, 'BIND-ATOMIC-001');
    expect(yaml).toMatch(/^lifecycle_state: draft$/m);
    expect(yaml).not.toMatch(/^worktree:/m);
  });

  test('a declared scope.in binds normally', () => {
    // Non-vacuity control. Without this, a createWorktree broken for ANY reason
    // would make the two refusal tests above pass for the wrong reason.
    const { caws } = mkRepo('caws-bind-declared-');
    seed(caws, 'BIND-DECLARED-001', ['src/a.ts']);

    const r = createWorktree(caws, {
      name: 'wt-declared',
      specId: 'BIND-DECLARED-001',
      session: SESSION,
      actor: ACTOR,
    });

    expect(r.ok).toBe(true);
    const reg = loadWorktrees(caws);
    expect(reg.value['wt-declared']).toBeDefined();
  });

  test('a scaffold sitting beside real paths still refuses', () => {
    // The eight-of-ten shape in the caws repo: the author DID declare a
    // surface, but amend appended beside the scaffold instead of discharging
    // it. Those specs are correctly scoped, so a guard keyed on "scope.in is
    // ONLY the scaffold" would let every one of them through and the residue
    // would keep reaching closed specs.
    const { caws } = mkRepo('caws-bind-mixed-');
    seed(caws, 'BIND-MIXED-001', ['src/a.ts']);

    // Reproduce the pre-fix on-disk shape by hand: scaffold + a real path.
    // create renders scope.in entries QUOTED, so the fixture must match that
    // form or it silently edits nothing and the test passes for the wrong
    // reason (which is exactly what an earlier revision of it did).
    const p = path.join(caws, 'specs', 'BIND-MIXED-001.yaml');
    const before = fs.readFileSync(p, 'utf8');
    const yaml = before.replace(
      /^ {4}- 'src\/a\.ts'$/m,
      `    - '${SCOPE_IN_PLACEHOLDER}'\n    - 'src/a.ts'`
    );
    if (yaml === before) throw new Error('fixture did not install the scaffold line');
    fs.writeFileSync(p, yaml);

    const r = createWorktree(caws, {
      name: 'wt-mixed',
      specId: 'BIND-MIXED-001',
      session: SESSION,
      actor: ACTOR,
    });

    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.errors)).toContain('amend-scope');
  });
});
