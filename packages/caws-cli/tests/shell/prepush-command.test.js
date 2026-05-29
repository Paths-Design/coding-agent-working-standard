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
