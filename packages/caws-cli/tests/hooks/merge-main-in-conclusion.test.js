'use strict';

/**
 * CAWS-DEFECT-MERGE-MAIN-IN-CONCLUSION-BLOCKED-01 — concluding a conflicted
 * `git merge main` inside a lane through the REAL .husky/pre-commit hook.
 *
 * The hook is installed as the temp repo's own pre-commit, so `git commit`
 * runs it exactly as in the incident (2026-10-04, wt-merge-provenance-routing):
 * .caws/policy.yaml arrived from main, was staged beside code, and Guard 2
 * refused a merge that could not be split.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const HOOK = path.resolve(__dirname, '..', '..', '..', '..', '.husky', 'pre-commit');

afterAll(() => {
  cleanupAll();
});

function git(root, args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
  );
  const r = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      ...env,
      HOME: root,
      GIT_CONFIG_GLOBAL: path.join(root, '.gitconfig-test'),
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'CAWS Test',
      GIT_AUTHOR_EMAIL: 'test@caws.invalid',
      GIT_COMMITTER_NAME: 'CAWS Test',
      GIT_COMMITTER_EMAIL: 'test@caws.invalid',
    },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function must(root, args) {
  const r = git(root, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.err}${r.out}`);
  return r.out;
}

/** Install .husky/pre-commit as the repo's live pre-commit. makeTempRepo sets
 *  core.hooksPath=/dev/null, so hooksPath must be pointed back at .git/hooks or
 *  the hook never runs and every "refused" assertion is unreachable. */
function installHook(root) {
  const hooksDir = path.join(root, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.copyFileSync(HOOK, path.join(hooksDir, 'pre-commit'));
  fs.chmodSync(path.join(hooksDir, 'pre-commit'), 0o755);
  must(root, ['config', 'core.hooksPath', hooksDir]);
}

function write(root, rel, body) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

/**
 * A lane mid-`git merge main` with the one conflict resolved. main edited
 * policy.yaml and deleted two files; the lane edited code. The hook is
 * installed AFTER the setup commits so only the concluding commit runs it.
 */
function laneMidMerge() {
  const root = makeTempRepo();
  write(root, '.caws/policy.yaml', 'gates:\n  budget_limit: warn\n');
  write(root, 'src/shared.js', 'base\n');
  write(root, 'src/gone-a.js', 'a\n');
  write(root, 'src/gone-b.js', 'b\n');
  must(root, ['add', '-A']);
  must(root, ['commit', '-q', '-m', 'base']);
  must(root, ['checkout', '-q', '-b', 'lane']);
  write(root, 'src/shared.js', 'lane\n');
  must(root, ['add', '-A']);
  must(root, ['commit', '-q', '-m', 'lane work']);
  must(root, ['checkout', '-q', 'main']);
  must(root, ['rm', '-q', 'src/gone-a.js', 'src/gone-b.js']);
  write(root, 'src/shared.js', 'main\n');
  write(root, '.caws/policy.yaml', 'gates:\n  budget_limit: skip\n');
  must(root, ['add', '-A']);
  must(root, ['commit', '-q', '-m', 'main work']);
  must(root, ['checkout', '-q', 'lane']);

  const merged = git(root, ['merge', '--no-commit', 'main']);
  expect(merged.status).not.toBe(0);
  expect(merged.out).toContain('CONFLICT');
  write(root, 'src/shared.js', 'resolved\n');
  must(root, ['add', 'src/shared.js']);

  installHook(root);
  return root;
}

function mergeInProgress(root) {
  return fs.existsSync(path.join(root, '.git', 'MERGE_HEAD'));
}

describe('concluding git merge main in a lane', () => {
  test('a merge whose staged policy.yaml and deletions all come from main concludes without --no-verify', () => {
    const root = laneMidMerge();
    // Precondition that makes this the incident shape: policy and code are
    // staged together, policy equals main's blob, and main's deletions are staged.
    const staged = must(root, ['diff', '--cached', '--name-status']);
    expect(staged).toContain('M\t.caws/policy.yaml');
    expect(staged).toContain('D\tsrc/gone-a.js');
    expect(must(root, ['diff', '--cached', '--quiet', 'main', '--', '.caws/policy.yaml'])).toBe('');

    const commit = git(root, ['commit', '-m', 'merge main into lane']);

    expect(commit.err).not.toContain('BLOCKED');
    expect(commit.status).toBe(0);
    expect(mergeInProgress(root)).toBe(false);
    expect(must(root, ['log', '-1', '--pretty=%P']).trim().split(' ')).toHaveLength(2);
    expect(fs.readFileSync(path.join(root, '.caws/policy.yaml'), 'utf8')).toContain('skip');
  });

  test('an authored policy.yaml edit that matches neither parent is still refused, naming the path', () => {
    const root = laneMidMerge();
    write(root, '.caws/policy.yaml', 'gates:\n  budget_limit: block\n');
    must(root, ['add', '.caws/policy.yaml']);

    const commit = git(root, ['commit', '-m', 'merge main into lane']);

    expect(commit.status).not.toBe(0);
    expect(commit.err).toContain(
      'BLOCKED: .caws/policy.yaml is staged together with code changes.'
    );
    expect(mergeInProgress(root)).toBe(true);
  });

  test('an incoming-looking policy.yaml that main never changed is authored and is refused', () => {
    // Staged == main's blob, but main left policy.yaml untouched relative to the
    // merge base: the lane's own change was reverted by hand, which is authored.
    const root = makeTempRepo();
    write(root, '.caws/policy.yaml', 'gates: base\n');
    write(root, 'src/shared.js', 'base\n');
    must(root, ['add', '-A']);
    must(root, ['commit', '-q', '-m', 'base']);
    must(root, ['checkout', '-q', '-b', 'lane']);
    write(root, '.caws/policy.yaml', 'gates: lane\n');
    write(root, 'src/shared.js', 'lane\n');
    must(root, ['add', '-A']);
    must(root, ['commit', '-q', '-m', 'lane work']);
    must(root, ['checkout', '-q', 'main']);
    write(root, 'src/shared.js', 'main\n');
    must(root, ['add', '-A']);
    must(root, ['commit', '-q', '-m', 'main work']);
    must(root, ['checkout', '-q', 'lane']);
    expect(git(root, ['merge', '--no-commit', 'main']).status).not.toBe(0);
    write(root, 'src/shared.js', 'resolved\n');
    write(root, '.caws/policy.yaml', 'gates: base\n'); // == main's blob, untouched by main
    must(root, ['add', '-A']);
    installHook(root);

    const commit = git(root, ['commit', '-m', 'merge main']);

    expect(commit.status).not.toBe(0);
    expect(commit.err).toContain('BLOCKED: .caws/policy.yaml');
  });

  test('following the Guard 2 refusal text literally completes the merge and keeps the edit', () => {
    const root = laneMidMerge();
    write(root, '.caws/policy.yaml', 'gates:\n  budget_limit: block\n');
    must(root, ['add', '.caws/policy.yaml']);
    const refused = git(root, ['commit', '-m', 'merge main into lane']);
    expect(refused.status).not.toBe(0);

    // The prescribed remedy is the indented `git restore ...` line in the refusal.
    const remedy = refused.err.split('\n').find((l) => /^\s+git restore --staged/.test(l));
    expect(remedy).toBeDefined();
    const args = remedy.trim().split(/\s+/).slice(1);
    expect(args).not.toContain('commit');
    expect(git(root, args).status).toBe(0);

    const concluded = git(root, ['commit', '-m', 'merge main into lane']);
    expect(concluded.err).not.toContain('BLOCKED');
    expect(concluded.status).toBe(0);
    expect(mergeInProgress(root)).toBe(false);
    // The authored edit survives in the working tree for its own commit.
    expect(fs.readFileSync(path.join(root, '.caws/policy.yaml'), 'utf8')).toContain('block');
    expect(must(root, ['status', '--porcelain'])).toContain(' M .caws/policy.yaml');
  });

  test('the Guard 2 refusal does not present caws waiver create, in or out of a merge', () => {
    const merge = laneMidMerge();
    write(merge, '.caws/policy.yaml', 'gates:\n  budget_limit: block\n');
    must(merge, ['add', '.caws/policy.yaml']);
    const inMerge = git(merge, ['commit', '-m', 'x']);
    expect(inMerge.status).not.toBe(0);
    expect(inMerge.err).not.toMatch(/waiver/i);

    // Plain (non-merge) commit mixing policy and code.
    const root = makeTempRepo();
    write(root, '.caws/policy.yaml', 'gates: a\n');
    write(root, 'src/x.js', 'a\n');
    must(root, ['add', '-A']);
    must(root, ['commit', '-q', '-m', 'base']);
    installHook(root);
    write(root, '.caws/policy.yaml', 'gates: b\n');
    write(root, 'src/x.js', 'b\n');
    must(root, ['add', '-A']);
    const plain = git(root, ['commit', '-m', 'mixed']);
    expect(plain.status).not.toBe(0);
    expect(plain.err).toContain('BLOCKED: .caws/policy.yaml is staged together with code changes.');
    expect(plain.err).not.toMatch(/waiver/i);
  });
});
