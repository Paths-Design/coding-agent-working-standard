'use strict';

/**
 * Worktree claim oracle: verdicts, scope-matcher parity and Bash write-guard
 * consumption (CAWS-HOOKPACK-ORACLE-JSYAML-DEGRADE-001,
 * CLAIM-ORACLE-DIRECTORY-CONTAINMENT-001).
 *
 * The oracle decides worktree-payload and canonical-claim ownership for
 * worktree-write-guard.sh and bash-write-guard.sh. js-yaml is required lazily
 * and only for the cross-worktree canonical-claim check: without it that check
 * DEGRADES (degraded_no_yaml, which the guards map to allow-with-advisory)
 * instead of failing closed, while the yaml-free foreign-payload block stays
 * hard. A scope.in entry claims a path and everything beneath it, on a "/"
 * boundary. The guards parse the verdict detail (worktree name, owner, claimed
 * pattern), so details are asserted exactly.
 *
 * caws-state.sh exports a second copy of the scope matcher that hooks inline
 * into node; both copies must answer identically on every input.
 *
 * CAWS_CLAIM_ORACLE_SHARED_DIR (test-only) points every case at another copy of
 * templates/hook-packs/shared, so a disposable altered copy can show which cases
 * depend on a behavior. Unset, the shipped templates are under test.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SHARED = process.env.CAWS_CLAIM_ORACLE_SHARED_DIR
  ? path.resolve(process.env.CAWS_CLAIM_ORACLE_SHARED_DIR)
  : path.resolve(__dirname, '..', '..', 'templates', 'hook-packs', 'shared');
const ORACLE = path.join(SHARED, 'lib', 'worktree-claim-oracle.cjs');
const CAWS_STATE = path.join(SHARED, 'lib', 'caws-state.sh');
const BASH_WRITE_GUARD = path.join(SHARED, 'bash-write-guard.sh');

// The oracle resolves js-yaml by walking up from its own directory. Naming the
// node_modules root that holds js-yaml keeps resolution the same when the shared
// directory is a copy outside this package.
function nodeModulesRootOf(packageName) {
  let directory = path.dirname(require.resolve(packageName));
  while (path.basename(directory) !== packageName) {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`cannot locate the ${packageName} package root`);
    directory = parent;
  }
  return path.dirname(directory);
}
const NODE_PATH = nodeModulesRootOf('js-yaml');

// A preload that makes require('js-yaml') fail as if the package were absent,
// leaving every other module load intact. No repository file is modified.
const JSYAML_BLOCKER = `
const Module = require('module');
const load = Module._load;
Module._load = function (request) {
  if (request === 'js-yaml') {
    const error = new Error("Cannot find module 'js-yaml'");
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  }
  return load.apply(this, arguments);
};
`;

const temporaryDirectories = [];
let blockerPath;

beforeAll(() => {
  const directory = temporaryDirectory('caws-oracle-blocker-');
  blockerPath = path.join(directory, 'jsyaml-block.cjs');
  fs.writeFileSync(blockerPath, JSYAML_BLOCKER);
});

afterAll(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix) {
  // Physical paths keep verdicts about ownership, not about /var -> /private/var aliases.
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

// Inherited oracle inputs or node preloads would change what a case exercises.
function baseEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('CAWS_ORACLE_') || key === 'NODE_OPTIONS') delete environment[key];
  }
  return environment;
}

function makeRepo() {
  const root = temporaryDirectory('caws-oracle-');
  fs.mkdirSync(path.join(root, '.caws', 'specs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.caws', 'worktrees'), { recursive: true });
  return root;
}

function makeWorktreeDir(root, name) {
  fs.mkdirSync(path.join(root, '.caws', 'worktrees', name), { recursive: true });
}

function writeRegistry(root, entries) {
  fs.writeFileSync(path.join(root, '.caws', 'worktrees.json'), JSON.stringify(entries));
}

function registryEntry(root, name, specId, ownerSession) {
  return {
    [name]: {
      name,
      spec_id: specId,
      path: path.join(root, '.caws', 'worktrees', name),
      owner: { session_id: ownerSession },
      baseBranch: 'main',
    },
  };
}

function writeSpec(root, specId, scopeIn, worktreeName) {
  fs.writeFileSync(
    path.join(root, '.caws', 'specs', `${specId}.yaml`),
    `id: ${specId}\nlifecycle_state: active\nworktree: ${worktreeName}\nscope:\n  in:\n` +
      scopeIn.map((entry) => `    - ${entry}\n`).join('')
  );
}

function seedClaimant(root, { name, specId, owner, scopeIn }) {
  makeWorktreeDir(root, name);
  writeRegistry(root, registryEntry(root, name, specId, owner));
  writeSpec(root, specId, scopeIn, name);
}

// Run the oracle and return its first stdout line, `<outcome>:<detail>`.
function runOracle(root, candidate, { sessionId = 'sess-self', blockJsYaml = false } = {}) {
  const args = blockJsYaml ? ['--require', blockerPath, ORACLE] : [ORACLE];
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...baseEnvironment(),
      NODE_PATH,
      CAWS_ORACLE_PROJECT_DIR: root,
      CAWS_ORACLE_REL_PATH: candidate,
      CAWS_ORACLE_SESSION_ID: sessionId,
      CAWS_ORACLE_CURRENT_BRANCH: '',
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return result.stdout.split('\n')[0];
}

describe('worktree-claim-oracle verdicts', () => {
  test('a canonical path with js-yaml absent degrades instead of failing closed', () => {
    const repo = makeRepo();
    seedClaimant(repo, {
      name: 'wt-feat',
      specId: 'FEAT-001',
      owner: 'other-sess',
      scopeIn: ['packages/other/src'],
    });
    const verdict = runOracle(repo, path.join(repo, 'some', 'unrelated', 'file.js'), {
      blockJsYaml: true,
    });
    expect(verdict).toBe('degraded_no_yaml:no-js-yaml');
  });

  test('a path a spec would claim still degrades when js-yaml is absent; it is never a silent pass', () => {
    const repo = makeRepo();
    seedClaimant(repo, {
      name: 'wt-feat',
      specId: 'FEAT-001',
      owner: 'other-sess',
      scopeIn: ['packages/claimed/src'],
    });
    const verdict = runOracle(repo, path.join(repo, 'packages', 'claimed', 'src', 'x.js'), {
      blockJsYaml: true,
    });
    expect(verdict).toBe('degraded_no_yaml:no-js-yaml');
  });

  test("a foreign worktree's payload is blocked without js-yaml, naming worktree and owner", () => {
    const repo = makeRepo();
    makeWorktreeDir(repo, 'wt-other');
    writeRegistry(repo, registryEntry(repo, 'wt-other', 'OTH-001', 'foreign-sess'));
    const payload = path.join(repo, '.caws', 'worktrees', 'wt-other', 'file.js');
    const verdict = runOracle(repo, payload, { sessionId: 'my-sess', blockJsYaml: true });
    expect(verdict).toBe('block_foreign_worktree:wt-other:foreign-sess');
  });

  test("a session's own worktree payload passes as owner-self without js-yaml", () => {
    const repo = makeRepo();
    makeWorktreeDir(repo, 'wt-mine');
    writeRegistry(repo, registryEntry(repo, 'wt-mine', 'MINE-001', 'my-sess'));
    const payload = path.join(repo, '.caws', 'worktrees', 'wt-mine', 'file.js');
    const verdict = runOracle(repo, payload, { sessionId: 'my-sess', blockJsYaml: true });
    expect(verdict).toBe('pass:owner-self:wt-mine');
  });

  test('with js-yaml present, a canonical path outside every scope.in passes as unclaimed', () => {
    const repo = makeRepo();
    seedClaimant(repo, {
      name: 'wt-feat',
      specId: 'FEAT-001',
      owner: 'other-sess',
      scopeIn: ['packages/other/src'],
    });
    expect(runOracle(repo, path.join(repo, 'some', 'unrelated', 'file.js'))).toBe('pass:unclaimed');
  });

  test('with no registry the oracle passes before any claim check', () => {
    const repo = makeRepo();
    expect(runOracle(repo, path.join(repo, 'any', 'file.js'))).toBe('pass:no-registry');
  });

  test.each(['packages/dir/', 'packages/dir'])(
    'a directory entry %p claims files beneath it',
    (entry) => {
      const repo = makeRepo();
      seedClaimant(repo, {
        name: 'wt-dir',
        specId: 'DIR-001',
        owner: 'other-sess',
        scopeIn: [entry],
      });
      expect(runOracle(repo, 'packages/dir/file.py')).toBe(`block_claimed:wt-dir:${entry}`);
    }
  );

  test("a directory entry does not claim a sibling that only shares its prefix ('dir' vs 'directory')", () => {
    const repo = makeRepo();
    seedClaimant(repo, {
      name: 'wt-dir',
      specId: 'DIR-001',
      owner: 'other-sess',
      scopeIn: ['packages/dir'],
    });
    expect(runOracle(repo, 'packages/directory/file.py')).toBe('pass:unclaimed');
  });

  test('an entry made only of slashes claims nothing', () => {
    const repo = makeRepo();
    seedClaimant(repo, { name: 'wt-dir', specId: 'DIR-001', owner: 'other-sess', scopeIn: ['/'] });
    expect(runOracle(repo, 'packages/dir/file.py')).toBe('pass:unclaimed');
  });
});

describe('scope matcher parity between caws-state.sh and the oracle', () => {
  function compileMatcher(source) {
    expect(source.startsWith('function globToRegExp(pattern) {')).toBe(true);

    const globToRegExp = new Function(`${source}\nreturn globToRegExp;`)();
    expect(typeof globToRegExp).toBe('function');
    return globToRegExp;
  }

  function shellMatcherSource() {
    const result = spawnSync(
      '/bin/bash',
      [
        '-c',
        'source "$1" && printf "%s" "$CAWS_NODE_GLOB_TO_SCOPE_REGEXP"',
        'caws-state',
        CAWS_STATE,
      ],
      { encoding: 'utf8', timeout: 30000, env: baseEnvironment() }
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    return result.stdout;
  }

  function oracleMatcherSource() {
    const text = fs.readFileSync(ORACLE, 'utf8');
    const match = /^function globToRegExp\(pattern\) \{\n[\s\S]*?\n\}$/m.exec(text);
    expect(match).not.toBeNull();
    return match[0];
  }

  const PATTERNS = [
    'packages/dir',
    'packages/dir/',
    'packages/dir//',
    'packages/*',
    'packages/**',
    'packages/**/x.js',
    'packages/*/src',
    'packages/dir/*.py',
    'docs/**/*.md',
    'src/?.js',
    '***',
    'a.b',
    'a+b',
    'a(b)',
    'a$b',
    'a[b]',
    'a{b}',
    'a|b',
    'a^b',
    '/',
    '',
    './packages/dir',
    'é/dir',
  ];
  const PATHS = [
    'packages/dir',
    'packages/dir/file.py',
    'packages/dir/sub/deep.py',
    'packages/directory/file.py',
    'packages/x',
    'packages/x/y',
    'packages/x/src',
    'packages/a/b/x.js',
    'packages/x.js',
    'docs/c.md',
    'docs/a/b/c.md',
    'src/a.js',
    'src/ab.js',
    'a.b',
    'axb',
    'a+b',
    'aab',
    'a(b)',
    'ab',
    'a$b',
    'a[b]',
    'a{b}',
    'a|b',
    'a^b',
    '',
    '/',
    './packages/dir/f',
    'é/dir/f',
  ];

  const matchers = {};
  beforeAll(() => {
    matchers.shell = compileMatcher(shellMatcherSource());
    matchers.oracle = compileMatcher(oracleMatcherSource());
  });

  test.each(['shell', 'oracle'])(
    'the %s copy claims a directory subtree on a "/" boundary and treats * as one segment',
    (copy) => {
      const matches = (pattern, candidate) => matchers[copy](pattern).test(candidate);
      expect(matches('packages/dir', 'packages/dir/file.py')).toBe(true);
      expect(matches('packages/dir/', 'packages/dir/file.py')).toBe(true);
      expect(matches('packages/dir', 'packages/directory/file.py')).toBe(false);
      expect(matches('packages/*/src', 'packages/x/src')).toBe(true);
      expect(matches('packages/*/src', 'packages/a/b/src')).toBe(false);
      expect(matches('packages/**/x.js', 'packages/a/b/x.js')).toBe(true);
      expect(matches('a.b', 'axb')).toBe(false);
      expect(matches('/', 'packages/dir/file.py')).toBe(false);
      expect(matches('', '')).toBe(false);
    }
  );

  test('both copies give the same answer for every pattern and path', () => {
    const disagreements = [];
    let claimed = 0;
    for (const pattern of PATTERNS) {
      for (const candidate of PATHS) {
        const shell = matchers.shell(pattern).test(candidate);
        const oracle = matchers.oracle(pattern).test(candidate);
        if (shell !== oracle) disagreements.push({ pattern, candidate, shell, oracle });
        if (oracle) claimed += 1;
      }
    }
    expect(disagreements).toEqual([]);
    // The matrix must exercise both answers, or agreement would be trivial.
    expect(claimed).toBeGreaterThan(0);
    expect(claimed).toBeLessThan(PATTERNS.length * PATHS.length);
  });
});

describe('bash-write-guard.sh refuses mutations inside a foreign-claimed directory', () => {
  const SESSION = 'my-session';

  function git(repo, args) {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 30000 });
    expect(result.status).toBe(0);
  }

  function makeClaimedRepo() {
    const repo = makeRepo();
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'CAWS Test']);
    git(repo, ['config', 'user.email', 'test@caws.invalid']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'root commit']);
    seedClaimant(repo, {
      name: 'wt-dir',
      specId: 'DIR-001',
      owner: 'foreign-session',
      scopeIn: ['packages/dir'],
    });
    return repo;
  }

  // Mirrors the Bats guard harness: an isolated HOME and CAWS_HOME and a synthetic
  // session, so no real session state, registration or kill authority is borrowed.
  function runGuard(repo, command) {
    const home = temporaryDirectory('caws-oracle-home-');
    const envelope = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command },
      session_id: SESSION,
      cwd: repo,
    });
    const result = spawnSync('/bin/bash', [BASH_WRITE_GUARD], {
      cwd: repo,
      input: envelope,
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...baseEnvironment(),
        HOME: home,
        CAWS_HOME: path.join(home, '.caws'),
        CAWS_PROJECT_DIR: repo,
        CAWS_AGENT_SURFACE: 'claude-code',
        HOOK_CWD: repo,
        HOOK_SESSION_ID: SESSION,
        CLAUDE_CODE_SESSION_ID: SESSION,
        CAWS_GUARD_NO_ASK: '0',
        NODE_PATH,
      },
    });
    expect(result.error).toBeUndefined();
    return result;
  }

  test('a mutation under the claimed directory is blocked, naming the claiming worktree and entry', () => {
    const repo = makeClaimedRepo();
    const result = runGuard(repo, 'touch packages/dir/file.py');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "BLOCKED: this Bash command mutates 'wt-dir:packages/dir', claimed by an active worktree's scope.in."
    );
  });

  test('a mutation of a sibling that only shares the prefix is admitted', () => {
    const repo = makeClaimedRepo();
    const result = runGuard(repo, 'touch packages/directory/file.py');
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('BLOCKED');
    expect(result.stdout).not.toContain('"decision":"block"');
  });
});
