// caws prepush command — fixture-repo end-to-end tests.
// MULTI-AGENT-PUSH-RANGE-GUARD-001 A9: every test uses an isolated temp
// git repo (never the live repo / live .caws/). The command does real git
// reads against the fixture; no network, no real push.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runPrepushCommand } = require('../../dist/shell');

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function mkRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  git(root, 'config', 'user.email', 't@t.com');
  git(root, 'config', 'user.name', 'T');
  // Seed: create the .caws/ shape + an initial commit that becomes the base.
  fs.mkdirSync(path.join(root, '.caws', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  // Mirror the real repo: the worktree registry is runtime state and the
  // linked-worktree dir is not tracked. Ignore both so they do not trip the
  // A8 dirty-tree preflight when a fixture adds a sibling worktree.
  fs.writeFileSync(
    path.join(root, '.gitignore'),
    '.caws/worktrees.json\n.wt/\n'
  );
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'init');
  // A "remote" base ref: point origin/main at the init commit by creating a
  // local branch we treat as the base (the command takes --base).
  git(root, 'branch', 'base-ref');
  return root;
}

function writeSpec(root, id, scopeIn, lifecycle = 'active') {
  // Real specs list their own YAML in scope.in; include it so the
  // spec-authoring commit is attributable (mirrors production specs).
  const fullScopeIn = [`.caws/specs/${id}.yaml`, ...scopeIn];
  const yaml = [
    `id: ${id}`,
    `title: '${id}'`,
    'risk_tier: 3',
    'mode: chore',
    `lifecycle_state: ${lifecycle}`,
    'blast_radius:',
    '  modules:',
    '    - packages/x',
    '  data_migration: false',
    'operational_rollback_slo: 5m',
    'scope:',
    '  in:',
    ...fullScopeIn.map((s) => `    - ${s}`),
    '  out: []',
    'invariants:',
    '  - x',
    'acceptance:',
    '  - id: A1',
    "    given: g",
    "    when: w",
    "    then: t",
    'non_functional: {}',
    'contracts: []',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, '.caws', 'specs', `${id}.yaml`), yaml);
}

function commitFile(root, relPath, content, subject) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  git(root, 'add', '--', relPath);
  git(root, 'commit', '--quiet', '-m', subject);
}

function capture(opts) {
  const out = [];
  const err = [];
  const code = runPrepushCommand({
    ...opts,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('caws prepush — A2: clean current-slice range passes (exit 0)', () => {
  let root;
  afterEach(() => rmrf(root));

  it('exits 0 and reports the range as cleanly attributable', () => {
    root = mkRepo('prepush-a2-');
    writeSpec(root, 'FOO-001', ['packages/foo']);
    git(root, 'add', '-A'); git(root, 'commit', '--quiet', '-m', 'add spec');
    commitFile(root, 'packages/foo/a.ts', 'export const a = 1;\n', 'feat(foo): a');

    const r = capture({ cwd: root, base: 'base-ref', specId: 'FOO-001' });

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/cleanly attributable/);
    expect(r.stdout).toMatch(/current-slice/);
  });
});

describe('caws prepush — A1: foreign-spec commit refuses (exit 1)', () => {
  let root;
  afterEach(() => rmrf(root));

  it('exits 1 and names the unexpected commit', () => {
    root = mkRepo('prepush-a1-');
    writeSpec(root, 'FOO-001', ['packages/foo']);
    writeSpec(root, 'BAR-001', ['packages/bar']);
    git(root, 'add', '-A'); git(root, 'commit', '--quiet', '-m', 'add specs');
    commitFile(root, 'packages/foo/a.ts', 'export const a = 1;\n', 'feat(foo): mine');
    commitFile(root, 'packages/bar/b.ts', 'export const b = 2;\n', 'chore: BAR-001 work');

    const r = capture({ cwd: root, base: 'base-ref', specId: 'FOO-001' });

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/REFUSED/);
    expect(r.stderr).toMatch(/unexpected/i);
  });

  it('--ack <sha> on the unexpected commit clears the refusal (exit 0)', () => {
    root = mkRepo('prepush-a1-ack-');
    writeSpec(root, 'FOO-001', ['packages/foo']);
    writeSpec(root, 'BAR-001', ['packages/bar']);
    git(root, 'add', '-A'); git(root, 'commit', '--quiet', '-m', 'add specs');
    commitFile(root, 'packages/foo/a.ts', 'export const a = 1;\n', 'feat(foo): mine');
    commitFile(root, 'packages/bar/b.ts', 'export const b = 2;\n', 'chore: BAR-001 work');
    const barSha = git(root, 'rev-parse', '--short=12', 'HEAD').trim();

    const r = capture({ cwd: root, base: 'base-ref', specId: 'FOO-001', ack: [barSha] });

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/cleanly attributable/);
  });
});

describe('caws prepush — A8: dirty working tree refuses before classification', () => {
  let root;
  afterEach(() => rmrf(root));

  it('exits 1 naming the dirty path, before any range report', () => {
    root = mkRepo('prepush-a8-');
    writeSpec(root, 'FOO-001', ['packages/foo']);
    git(root, 'add', '-A'); git(root, 'commit', '--quiet', '-m', 'add spec');
    commitFile(root, 'packages/foo/a.ts', 'export const a = 1;\n', 'feat(foo): a');
    // Leave a dirty (uncommitted) change in the working tree.
    fs.writeFileSync(path.join(root, 'packages/foo/a.ts'), 'export const a = 99;\n');

    const r = capture({ cwd: root, base: 'base-ref', specId: 'FOO-001' });

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/working tree is dirty before classification/);
    expect(r.stderr).toMatch(/packages\/foo\/a\.ts/);
    // The range report should NOT have been produced (refused at preflight).
    expect(r.stdout).not.toMatch(/cleanly attributable/);
  });
});

describe('caws prepush — empty outgoing range', () => {
  let root;
  afterEach(() => rmrf(root));

  it('exits 0 with no commits when HEAD == base', () => {
    root = mkRepo('prepush-empty-');
    writeSpec(root, 'FOO-001', ['packages/foo']);
    git(root, 'add', '-A'); git(root, 'commit', '--quiet', '-m', 'add spec');
    // base-ref is behind, so move base-ref up to HEAD → empty range.
    git(root, 'branch', '-f', 'base-ref', 'HEAD');

    const r = capture({ cwd: root, base: 'base-ref', specId: 'FOO-001' });

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/no outgoing commits/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PREPUSH-FOREIGN-WORKTREE-WIRING-001: foreign-worktree facts are now wired
// end-to-end through the command (previously only the pure classifier could
// reach the ERROR/refuse path). These fixtures create a REAL second git
// worktree via `git worktree add`, so `git worktree list --porcelain` and
// `git branch --contains` return real data — the command does its own git
// reads (no injected git runner here; A9 isolated temp repos).
// ─────────────────────────────────────────────────────────────────────────

/** Write a minimal .caws/worktrees.json registry (v11 flat-map shape). */
function writeRegistry(root, entries) {
  fs.writeFileSync(
    path.join(root, '.caws', 'worktrees.json'),
    JSON.stringify(entries, null, 2) + '\n'
  );
}

/**
 * Add a real linked git worktree at <root>/.wt/<name> on a NEW branch
 * <branch> starting from <startPoint> (default HEAD). Returns the worktree
 * path. The sibling lives UNDER root so the single rmrf(root) cleans it,
 * but its path !== root so the command treats it as a foreign checkout.
 */
function addWorktree(root, name, branch, startPoint = 'HEAD') {
  const wtPath = path.join(root, '.wt', name);
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  git(root, 'worktree', 'add', '-q', '-b', branch, wtPath, startPoint);
  return wtPath;
}

describe('caws prepush — A1: a commit authored by a foreign worktree refuses (ERROR, exit 1)', () => {
  let root;
  afterEach(() => {
    try { git(root, 'worktree', 'prune'); } catch { /* ignore */ }
    rmrf(root);
  });

  it('attributes the commit to the foreign worktree, classifies ERROR, refuses', () => {
    root = mkRepo('prepush-fw-a1-');
    writeSpec(root, 'FOO-001', ['packages/foo']);
    writeSpec(root, 'BAR-001', ['packages/bar']);
    git(root, 'add', '-A'); git(root, 'commit', '--quiet', '-m', 'add specs');

    // The foreign worktree authors a commit, which we then merge onto main so
    // it appears in the outgoing range AND is contained by the sibling branch
    // (the session-13 condition: a sibling's commit rode into the push range).
    const sibBranch = 'sibling-work';
    const sibPath = addWorktree(root, 'sibling', sibBranch);
    fs.mkdirSync(path.join(sibPath, 'packages/bar'), { recursive: true });
    fs.writeFileSync(path.join(sibPath, 'packages/bar/b.ts'), 'export const b = 2;\n');
    git(sibPath, 'add', '-A');
    git(sibPath, 'commit', '--quiet', '-m', 'chore: sibling work for BAR-001');
    // Fast-forward main to include the sibling's commit (it now rides the range).
    git(root, 'merge', '--ff-only', sibBranch);

    // Register the sibling under a DIFFERENT spec so it is foreign to FOO-001.
    writeRegistry(root, {
      sibling: { specId: 'BAR-001', path: sibPath, branch: sibBranch },
    });

    const r = capture({ cwd: root, base: 'base-ref', specId: 'FOO-001' });

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/REFUSED/);
    // The foreign worktree is named at ERROR severity with the originates reason.
    expect(r.stdout).toMatch(/\[ERROR\] foreign worktree sibling/);
    expect(r.stdout).toMatch(/commits in the outgoing range originate from it/);
    // The commit carries the origin-worktree attribution in the report.
    expect(r.stdout).toMatch(/origin-worktree: sibling/);
  });
});

describe('caws prepush — A2: unregistered + unmerged foreign worktree (ERROR on origin main; WARN on a feature branch)', () => {
  let root;
  afterEach(() => {
    try { git(root, 'worktree', 'prune'); } catch { /* ignore */ }
    rmrf(root);
  });

  it('origin main: an unregistered, unmerged sibling worktree is ERROR and refuses', () => {
    root = mkRepo('prepush-fw-a2-');
    writeSpec(root, 'FOO-001', ['packages/foo']);
    git(root, 'add', '-A'); git(root, 'commit', '--quiet', '-m', 'add spec');
    commitFile(root, 'packages/foo/a.ts', 'export const a = 1;\n', 'feat(foo): a');

    // Sibling on an unmerged branch, NOT in the registry (created "outside CAWS").
    const sibPath = addWorktree(root, 'rogue', 'rogue-branch');
    fs.writeFileSync(path.join(sibPath, 'unrelated.txt'), 'x\n');
    git(sibPath, 'add', '-A');
    git(sibPath, 'commit', '--quiet', '-m', 'rogue: unmerged work');
    // No writeRegistry → the rogue branch is unregistered. base-ref does not
    // contain rogue-branch → unmerged.

    const r = capture({ cwd: root, base: 'base-ref', specId: 'FOO-001' });

    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/\[ERROR\] foreign worktree/);
    expect(r.stdout).toMatch(/branch not in worktrees\.json/);
    expect(r.stdout).toMatch(/unmerged branch/);
    expect(r.stderr).toMatch(/REFUSED/);
  });

  it('feature-branch target: the same sibling weakens to WARN and exits 0', () => {
    root = mkRepo('prepush-fw-a2b-');
    writeSpec(root, 'FOO-001', ['packages/foo']);
    git(root, 'add', '-A'); git(root, 'commit', '--quiet', '-m', 'add spec');
    commitFile(root, 'packages/foo/a.ts', 'export const a = 1;\n', 'feat(foo): a');

    const sibPath = addWorktree(root, 'rogue', 'rogue-branch');
    fs.writeFileSync(path.join(sibPath, 'unrelated.txt'), 'x\n');
    git(sibPath, 'add', '-A');
    git(sibPath, 'commit', '--quiet', '-m', 'rogue: unmerged work');

    // Push target is a feature branch, not origin main → fullPosture false.
    const r = capture({
      cwd: root,
      base: 'base-ref',
      branch: 'feat-x',
      specId: 'FOO-001',
    });

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\[WARN\] foreign worktree/);
    expect(r.stdout).not.toMatch(/\[ERROR\]/);
    expect(r.stdout).toMatch(/cleanly attributable/);
  });
});

describe('caws prepush — A3: benign registered+merged foreign worktree is WARN, not refused', () => {
  let root;
  afterEach(() => {
    try { git(root, 'worktree', 'prune'); } catch { /* ignore */ }
    rmrf(root);
  });

  it('origin main: a registered, merged sibling with no originating commit is WARN, exit 0', () => {
    root = mkRepo('prepush-fw-a3-');
    writeSpec(root, 'FOO-001', ['packages/foo']);
    writeSpec(root, 'BAR-001', ['packages/bar']);
    git(root, 'add', '-A'); git(root, 'commit', '--quiet', '-m', 'add specs');
    commitFile(root, 'packages/foo/a.ts', 'export const a = 1;\n', 'feat(foo): a');

    // Sibling branch starts from main's HEAD with no new commits → it is an
    // ancestor of base once we point base-ref at HEAD. Move base-ref forward
    // first so the sibling branch is merged into base, and FOO's commit is the
    // only thing ahead.
    git(root, 'branch', '-f', 'base-ref', 'HEAD');
    commitFile(root, 'packages/foo/c.ts', 'export const c = 3;\n', 'feat(foo): c');
    const sibBranch = 'sibling-merged';
    // Sibling branches from base-ref (merged: it's an ancestor of base-ref).
    const sibPath = addWorktree(root, 'sib', sibBranch, 'base-ref');

    writeRegistry(root, {
      sib: { specId: 'BAR-001', path: sibPath, branch: sibBranch },
    });

    const r = capture({ cwd: root, base: 'base-ref', specId: 'FOO-001' });

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\[WARN\] foreign worktree sib/);
    expect(r.stdout).not.toMatch(/\[ERROR\]/);
    expect(r.stdout).toMatch(/cleanly attributable/);
  });
});

describe('caws prepush — A4: a commit no worktree contains is left unattributed (non-escalating)', () => {
  let root;
  afterEach(() => {
    try { git(root, 'worktree', 'prune'); } catch { /* ignore */ }
    rmrf(root);
  });

  it('a commit authored directly on main has undefined origin-worktree and does not fabricate a finding', () => {
    root = mkRepo('prepush-fw-a4-');
    writeSpec(root, 'FOO-001', ['packages/foo']);
    git(root, 'add', '-A'); git(root, 'commit', '--quiet', '-m', 'add spec');
    // Commit authored on main directly, in FOO's scope → current-slice, and
    // no foreign worktree exists to attribute it to.
    commitFile(root, 'packages/foo/a.ts', 'export const a = 1;\n', 'feat(foo): a');

    const r = capture({ cwd: root, base: 'base-ref', specId: 'FOO-001' });

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/cleanly attributable/);
    // No origin-worktree line (attribution returned undefined) and no
    // fabricated foreign-worktree finding.
    expect(r.stdout).not.toMatch(/origin-worktree:/);
    expect(r.stdout).not.toMatch(/foreign worktree/);
  });
});
