/**
 * @fileoverview CAWS-SCOPE-AMEND-COMMAND-001 A4 — classify_command.py
 * cherry-pick carve-out.
 *
 * A `git cherry-pick <sha>` that provably touches ONLY .caws/specs/*.yaml is
 * the protocol-sanctioned scope-amendment / spec-lifecycle sync and is
 * admitted (`allow`) so it does NOT engage the sticky session-wide danger
 * latch. Every other cherry-pick (source files, multiple non-spec files,
 * ranges, flags, unresolvable sha, no repo) keeps the existing `ask` (which
 * latches). The carve-out is fail-closed: it relaxes ONLY on a cheaply-proven
 * spec-only commit, never on uncertainty.
 *
 * Strategy: build a throwaway git repo with a spec-only commit and a
 * source-file commit, then invoke the SHIPPED classifier with --repo-root
 * pointed at that repo and assert the decision per cherry-pick shape.
 *
 * @author @darianrosebrook
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const CLASSIFIER = path.join(
  REPO_ROOT,
  'packages', 'caws-cli', 'templates', 'hook-packs', 'claude-code', 'classify_command.py'
);

function classify(cmd, repoRoot) {
  const r = spawnSync(
    'python3',
    [CLASSIFIER, '--repo-root', repoRoot, '--home', '/tmp/fake-home', '--cwd', repoRoot],
    { input: cmd, encoding: 'utf8', timeout: 8000 }
  );
  if (r.error) throw r.error;
  return JSON.parse(r.stdout);
}

function git(repo, args) {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
}

/**
 * Build a repo with two commits on a side branch (not on HEAD):
 *   specSha   — touches only .caws/specs/FOO-1.yaml
 *   srcSha    — touches a source .ts file
 * Returns { repo, specSha, srcSha }.
 */
function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-cp-carveout-'));
  git(repo, ['init', '--quiet', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@t.com']);
  git(repo, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '--quiet', '-m', 'init']);

  // Side branch so the commits are cherry-pick-able onto main.
  git(repo, ['checkout', '--quiet', '-b', 'side']);

  fs.mkdirSync(path.join(repo, '.caws', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.caws', 'specs', 'FOO-1.yaml'), 'id: FOO-1\n');
  git(repo, ['add', '.caws/specs/FOO-1.yaml']);
  git(repo, ['commit', '--quiet', '-m', 'chore(caws): amend FOO-1 scope']);
  const specSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'thing.ts'), 'export const x = 1;\n');
  git(repo, ['add', 'src/thing.ts']);
  git(repo, ['commit', '--quiet', '-m', 'feat: add thing']);
  const srcSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  git(repo, ['checkout', '--quiet', 'main']);
  return { repo, specSha, srcSha };
}

describe('CAWS-SCOPE-AMEND-COMMAND-001 A4: cherry-pick carve-out', () => {
  let env;
  afterEach(() => { if (env && fs.existsSync(env.repo)) fs.rmSync(env.repo, { recursive: true, force: true }); env = undefined; });

  it('admits (allow) a cherry-pick that touches ONLY .caws/specs/*.yaml', () => {
    env = makeRepo();
    const d = classify(`git cherry-pick ${env.specSha}`, env.repo);
    expect(d.decision).toBe('allow');
  });

  it('keeps ask for a cherry-pick that touches a source file', () => {
    env = makeRepo();
    const d = classify(`git cherry-pick ${env.srcSha}`, env.repo);
    expect(d.decision).toBe('ask');
  });

  it('keeps ask for cherry-pick --continue (a flag form, no sha proof)', () => {
    env = makeRepo();
    const d = classify('git cherry-pick --continue', env.repo);
    expect(d.decision).toBe('ask');
  });

  it('keeps ask for an unresolvable sha (fail-closed)', () => {
    env = makeRepo();
    const d = classify('git cherry-pick deadbeefdeadbeef', env.repo);
    expect(d.decision).toBe('ask');
  });

  it('keeps ask for a commit RANGE (a..b) even if spec-only', () => {
    env = makeRepo();
    const d = classify(`git cherry-pick ${env.specSha}~1..${env.specSha}`, env.repo);
    expect(d.decision).toBe('ask');
  });

  it('keeps ask when a single cherry-pick names two shas and one touches source', () => {
    env = makeRepo();
    const d = classify(`git cherry-pick ${env.specSha} ${env.srcSha}`, env.repo);
    expect(d.decision).toBe('ask');
  });
});
