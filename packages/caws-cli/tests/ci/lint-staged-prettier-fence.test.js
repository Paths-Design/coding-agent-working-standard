'use strict';

// CAWS-BUDGET-ADVISORY-CLEANUP-01 (A4). The root .prettierignore fences files
// whose bytes another tool owns: populate-doc-markers.mjs regenerates marker
// regions in the consumer templates, and prettier reflows those regions into a
// shape the generator reports as STALE. The fence only holds if prettier runs
// from the repo root, because it reads .prettierignore from its cwd. The root
// .npmrc sets workspaces=true, under which a bare `npx` runs its command from
// the workspace directory, so the commit hook's lint-staged never consulted
// the fence and reformatted the fenced templates on every commit.
//
// These tests replay the exact npx + lint-staged invocation .husky/pre-commit
// uses, in a scratch npm-workspaces repo holding one fenced and one unfenced
// markdown file.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { cleanupAll, git, makeTempRepo } = require('../helpers/git-repo-factory');

const PKG_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: PKG_ROOT,
  encoding: 'utf8',
}).trim();
const NPX = path.join(path.dirname(process.execPath), 'npx');

const UNFORMATTED = '|a|bb|\n|-|-|\n|ccc|d|\n';
const FORMATTED = '| a   | bb  |\n| --- | --- |\n| ccc | d   |\n';

afterAll(() => cleanupAll());

/** The hook's `npx <npx flags> lint-staged <lint-staged flags>` invocation. */
function hookInvocation() {
  const hook = fs.readFileSync(path.join(REPO_ROOT, '.husky', 'pre-commit'), 'utf8');
  const m = /npx ([^;\n]*?)\s*lint-staged ([^;\n]*?);\s*then/.exec(hook);
  if (m === null) throw new Error('no npx lint-staged invocation found in .husky/pre-commit');
  return { npxArgs: m[1].trim().split(/\s+/), lintStagedArgs: m[2].trim().split(/\s+/) };
}

// The scratch repo mirrors the shape that matters: an npm workspaces root with
// workspaces=true in .npmrc, staged files inside the workspace (as the fenced
// templates live in packages/caws-cli), and a fence entry that is a
// repo-relative path like every entry in the real .prettierignore.
const FENCED = 'packages/pkg/docs/fenced.md';
const LOOSE = 'packages/pkg/docs/loose.md';

function runHookLintStaged(npxArgs, lintStagedArgs) {
  const repo = makeTempRepo();
  const write = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
  };
  write(
    'package.json',
    JSON.stringify({ name: 'fence-root', private: true, workspaces: ['packages/*'] })
  );
  write('.npmrc', 'workspaces=true\n');
  write('packages/pkg/package.json', JSON.stringify({ name: 'fence-pkg', version: '0.0.0' }));
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(repo, 'node_modules'));
  fs.copyFileSync(
    path.join(REPO_ROOT, '.lintstagedrc.json'),
    path.join(repo, '.lintstagedrc.json')
  );
  write('.prettierignore', `${FENCED}\n`);
  write(FENCED, UNFORMATTED);
  write(LOOSE, UNFORMATTED);
  git(repo, ['add', FENCED, LOOSE]);

  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('GIT_') && !key.toLowerCase().startsWith('npm_config_')
    )
  );
  const result = spawnSync(NPX, [...npxArgs, 'lint-staged', ...lintStagedArgs], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...inherited,
      HOME: repo,
      GIT_CONFIG_GLOBAL: path.join(repo, '.gitconfig-test'),
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  const read = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
  return { result, read };
}

describe('the pre-commit lint-staged run honors the root .prettierignore', () => {
  test('the hook invocation leaves a fenced file byte-identical and formats an unfenced one', () => {
    const { npxArgs, lintStagedArgs } = hookInvocation();
    const { result, read } = runHookLintStaged(npxArgs, lintStagedArgs);
    expect([result.status, result.stderr]).toEqual([0, expect.any(String)]);
    expect(read(FENCED)).toBe(UNFORMATTED);
    expect(read(LOOSE)).toBe(FORMATTED);
  }, 60000);

  // The control proves the scratch repo reproduces the defect, so the case
  // above can fail for the right reason: drop --workspaces=false and npx runs
  // lint-staged from the workspace, where no .prettierignore exists.
  test('without --workspaces=false, the fenced file is reformatted', () => {
    const { npxArgs, lintStagedArgs } = hookInvocation();
    expect(npxArgs).toContain('--workspaces=false');
    const bare = npxArgs.filter((arg) => arg !== '--workspaces=false');
    const { result, read } = runHookLintStaged(bare, lintStagedArgs);
    expect(result.status).toBe(0);
    // Both formatted: prettier ran, and it ran without the fence.
    expect(read(LOOSE)).toBe(FORMATTED);
    expect(read(FENCED)).toBe(FORMATTED);
  }, 60000);
});
