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
// These tests run the hook's staged runner in a scratch npm-workspaces root
// holding one fenced and one unfenced markdown file.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { cleanupAll, git, makeTempRepo } = require('../helpers/git-repo-factory');

const PKG_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: PKG_ROOT,
  encoding: 'utf8',
}).trim();
const RUNNER = path.join(REPO_ROOT, 'scripts/run-staged-checks.cjs');

const UNFORMATTED = '|a|bb|\n|-|-|\n|ccc|d|\n';
const FORMATTED = '| a   | bb  |\n| --- | --- |\n| ccc | d   |\n';

afterAll(() => cleanupAll());

test('the staged runner rejects sparse, formatter, Git and filename counterexamples', () => {
  const result = spawnSync(
    process.execPath,
    ['--test', path.join(REPO_ROOT, 'scripts/run-staged-checks.test.cjs')],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 55000,
    }
  );
  if (result.status !== 0) process.stderr.write(`${result.stdout || ''}\n${result.stderr || ''}`);
  expect({ status: result.status, signal: result.signal, error: result.error?.message }).toEqual({
    status: 0,
    signal: null,
    error: undefined,
  });
}, 60000);

function assertHookInvocation() {
  const hook = fs.readFileSync(path.join(REPO_ROOT, '.husky', 'pre-commit'), 'utf8');
  expect(hook).toContain('node "$STAGED_RUNNER"');
  expect(hook).toContain('scripts/run-staged-checks.cjs');
}

// The scratch repo mirrors the shape that matters: an npm workspaces root with
// workspaces=true in .npmrc, staged files inside the workspace (as the fenced
// templates live in packages/caws-cli), and a fence entry that is a
// repo-relative path like every entry in the real .prettierignore.
const FENCED = 'packages/pkg/docs/fenced.md';
const LOOSE = 'packages/pkg/docs/loose.md';

function runHookStagedChecks(workspaceCwd = false) {
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
  const argv = [RUNNER];
  const result = spawnSync(process.execPath, argv, {
    cwd: workspaceCwd ? path.join(repo, 'packages/pkg') : repo,
    encoding: 'utf8',
    env: {
      ...inherited,
      HOME: repo,
      GIT_CONFIG_GLOBAL: path.join(repo, '.gitconfig-test'),
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  const read = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
  if (process.env.CAWS_RELEASE_ARTIFACT_DIR) {
    fs.mkdirSync(process.env.CAWS_RELEASE_ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(
        process.env.CAWS_RELEASE_ARTIFACT_DIR,
        workspaceCwd ? 'formatting-workspace-refusal.json' : 'formatting-root-hook.json'
      ),
      JSON.stringify(
        {
          command: [process.execPath, ...argv],
          exit_status: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
          fenced_before: UNFORMATTED,
          fenced_after: read(FENCED),
          loose_after: read(LOOSE),
        },
        null,
        2
      ) + '\n'
    );
  }
  return { result, read };
}

const TRACKER = 'docs/internal/caws-runtime-modernization.md';
const INTERNAL_SCRATCH = 'docs/internal/scratch.md';
const INVALID_JSON = 'hook-invalid.json';
const BROKEN_JSON = '{"broken": }\n';

function runCompleteHook(label, relativePath, changedBytes, unignoreJson = false) {
  const repo = makeTempRepo();
  const write = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
  };
  write(
    'package.json',
    JSON.stringify({ name: 'complete-hook-root', private: true, workspaces: ['packages/*'] })
  );
  write('.npmrc', 'workspaces=true\n');
  write('packages/pkg/package.json', JSON.stringify({ name: 'hook-pkg', version: '0.0.0' }));
  for (const rel of ['.gitignore', '.lintstagedrc.json', '.prettierignore']) {
    fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(repo, rel));
  }
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(repo, 'node_modules'));
  write(relativePath, relativePath === INVALID_JSON ? '{"baseline":true}\n' : '# baseline\n');
  // Model an already tracked file under the historical ignore rule, only in
  // this disposable repository. No governed index or hook is modified.
  git(repo, ['add', '-f', '--', relativePath]);
  git(repo, ['commit', '-q', '-m', 'chore: establish hook fixture']);
  write('.husky/pre-commit', fs.readFileSync(path.join(REPO_ROOT, '.husky/pre-commit'), 'utf8'));
  write('scripts/run-staged-checks.cjs', fs.readFileSync(RUNNER, 'utf8'));
  if (unignoreJson) {
    // The real fence ignores *.json. Admit this explicit negative control so
    // a successful skip cannot masquerade as formatter-error handling.
    fs.appendFileSync(path.join(repo, '.prettierignore'), `\n!${INVALID_JSON}\n`);
  }
  write(relativePath, changedBytes);
  git(repo, ['add', '-u', '--', relativePath]);
  write(INTERNAL_SCRATCH, UNFORMATTED);
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('GIT_') && !key.toLowerCase().startsWith('npm_config_')
    )
  );
  const env = {
    ...inherited,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
    HOME: repo,
    GIT_CONFIG_GLOBAL: path.join(repo, '.gitconfig-test'),
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: repo, encoding: 'utf8', env, timeout: 55000 });
    return {
      command: [command, ...args],
      exit_status: result.status,
      signal: result.signal,
      error: result.error?.message,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
  const snapshot = () => ({
    worktree: fs.readFileSync(path.join(repo, relativePath), 'utf8'),
    index: run('git', ['show', `:${relativePath}`]),
    scratch_worktree: fs.readFileSync(path.join(repo, INTERNAL_SCRATCH), 'utf8'),
    scratch_ignored: run('git', ['check-ignore', '--', INTERNAL_SCRATCH]),
    scratch_index: run('git', ['ls-files', '--error-unmatch', '--', INTERNAL_SCRATCH]),
  });
  const before = snapshot();
  const result = run('bash', ['.husky/pre-commit']);
  const after = snapshot();
  const report = {
    cwd: repo,
    relative_path: relativePath,
    runtime: {
      node: process.execPath,
      node_version: process.version,
      staged_runner: RUNNER,
    },
    fixture_json_fence_exception: unignoreJson,
    before,
    result,
    after,
  };
  if (process.env.CAWS_RELEASE_ARTIFACT_DIR) {
    const artifactDir = path.join(process.env.CAWS_RELEASE_ARTIFACT_DIR, label);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(artifactDir, 'hook.stdout'), result.stdout || '');
    fs.writeFileSync(path.join(artifactDir, 'hook.stderr'), result.stderr || '');
    fs.cpSync(repo, path.join(artifactDir, 'fixture'), {
      recursive: true,
      filter: (source) => path.relative(repo, source).split(path.sep)[0] !== 'node_modules',
    });
  }
  return report;
}

describe('the complete pre-commit hook admits the tracked internal tracker', () => {
  test('formats and stages the tracker while internal scratch stays excluded', () => {
    const { before, result, after } = runCompleteHook(
      'formatting-internal-tracker',
      TRACKER,
      UNFORMATTED
    );
    expect(before.index.exit_status).toBe(0);
    expect(before.index.stdout).toBe(UNFORMATTED);
    expect(after.worktree).toBe(FORMATTED);
    expect(after.index.exit_status).toBe(0);
    expect(after.index.stdout).toBe(FORMATTED);
    expect(result.exit_status).toBe(0);
    expect(result.signal).toBeNull();
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('[FAILED]');
    expect(after.scratch_ignored.exit_status).toBe(0);
    expect(after.scratch_ignored.stdout.trim()).toBe(INTERNAL_SCRATCH);
    expect(after.scratch_index.exit_status).toBe(1);
    expect(after.scratch_worktree).toBe(UNFORMATTED);
  }, 60000);
  test('refuses a real formatter error and retains the staged malformed JSON', () => {
    const { before, result, after } = runCompleteHook(
      'formatting-invalid-json-control',
      INVALID_JSON,
      BROKEN_JSON,
      true
    );
    expect(before.index.exit_status).toBe(0);
    expect(before.index.stdout).toBe(BROKEN_JSON);
    expect(result.exit_status).toBe(2);
    expect(result.signal).toBeNull();
    expect(`${result.stdout}\n${result.stderr}`).toContain('SyntaxError');
    expect(result.stderr).toContain('BLOCKED: staged checks failed;');
    expect(after.worktree).toBe(BROKEN_JSON);
    expect(after.index.exit_status).toBe(0);
    expect(after.index.stdout).toBe(BROKEN_JSON);
  }, 60000);
});

describe('the pre-commit staged run honors the root .prettierignore', () => {
  test('the hook invocation leaves a fenced file byte-identical and formats an unfenced one', () => {
    assertHookInvocation();
    const { result, read } = runHookStagedChecks();
    expect([result.status, result.stderr]).toEqual([0, expect.any(String)]);
    expect(read(FENCED)).toBe(UNFORMATTED);
    expect(read(LOOSE)).toBe(FORMATTED);
  }, 60000);

  test('workspace cwd is refused before it can lose the root formatting fence', () => {
    assertHookInvocation();
    const { result, read } = runHookStagedChecks(true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('checkout root');
    expect(read(LOOSE)).toBe(UNFORMATTED);
    expect(read(FENCED)).toBe(UNFORMATTED);
  }, 60000);
});
