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
const WORKTREE_WRITE_GUARD = path.join(SHARED, 'worktree-write-guard.sh');
const CLI = path.resolve(__dirname, '../../dist/index.js');

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

// Inherited oracle inputs, node preloads or Git storage/config overrides would
// change what a case exercises; GIT_DIR in particular redirects even `git -C`.
function baseEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('CAWS_ORACLE_') || key.startsWith('GIT_') || key === 'NODE_OPTIONS') {
      delete environment[key];
    }
  }
  return environment;
}

// Fixture Git and the guard's own Git calls read configuration only from the
// fixture home, as tests/helpers/git-repo-factory.js does; that helper is not
// reused here because it loads the built dist, which these checks do not need.
function hermeticGitEnvironment(home) {
  return {
    ...baseEnvironment(),
    HOME: home,
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
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
function runOracle(
  root,
  candidate,
  { sessionId = 'sess-self', blockJsYaml = false, removeTree = false } = {}
) {
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
      CAWS_ORACLE_REMOVE_TREE: removeTree ? '1' : '0',
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return result.stdout.split('\n')[0];
}

describe('worktree-claim-oracle verdicts', () => {
  test.each(['src', '.'])(
    'canonical directory removal covers a narrower literal claim: %s',
    (candidate) => {
      const repo = makeRepo();
      seedClaimant(repo, {
        name: 'wt-claim',
        specId: 'CLAIM',
        owner: 'sess-self',
        scopeIn: ['src/claimed.txt'],
      });
      expect(runOracle(repo, candidate, { removeTree: true })).toBe(
        'block_claimed:wt-claim:src/claimed.txt'
      );
      expect(runOracle(repo, 'src-other', { removeTree: true })).toBe('pass:unclaimed');
    }
  );
  test.each([false, true])(
    'canonical tree effects cannot infer glob populations with YAML blocked=%s',
    (blockJsYaml) => {
      const repo = makeRepo();
      seedClaimant(repo, {
        name: 'wt-claim',
        specId: 'CLAIM',
        owner: 'foreign-sess',
        scopeIn: ['src/*/claimed.txt'],
      });
      expect(runOracle(repo, 'src', { removeTree: true, blockJsYaml })).toBe(
        'ask_uncertain:remove-tree-claims-unresolved'
      );
    }
  );
  test.each(['root', 'descendant', 'ancestor'])(
    'registered custom physical paths preserve foreign ownership for %s',
    (form) => {
      const repo = makeRepo();
      const custom = path.join(repo, 'docs/custom');
      fs.mkdirSync(custom, { recursive: true });
      const entries = registryEntry(repo, 'wt-custom', 'CUSTOM', 'foreign-sess');
      entries['wt-custom'].path = 'docs/custom';
      writeRegistry(repo, entries);
      const candidate =
        form === 'root'
          ? custom
          : form === 'ancestor'
            ? path.dirname(custom)
            : path.join(custom, 'new/deep/file');
      expect(runOracle(repo, candidate, { blockJsYaml: true })).toBe(
        'block_foreign_worktree:wt-custom:foreign-sess'
      );
    }
  );
  test('a unique owned custom root admits its payload but not a similarly named sibling', () => {
    const repo = makeRepo();
    const custom = path.join(repo, 'docs/custom');
    fs.mkdirSync(custom, { recursive: true });
    const entries = registryEntry(repo, 'wt-custom', 'CUSTOM', 'sess-self');
    entries['wt-custom'].path = custom;
    writeRegistry(repo, entries);
    expect(runOracle(repo, path.join(custom, 'new/deep/file'), { blockJsYaml: true })).toBe(
      'pass:owner-self:wt-custom'
    );
    expect(runOracle(repo, custom + '-other/file', { blockJsYaml: true })).toBe(
      'degraded_no_yaml:no-js-yaml'
    );
  });
  test('a conventional name cannot grant ownership when its registered path is elsewhere', () => {
    const repo = makeRepo();
    makeWorktreeDir(repo, 'wt-custom');
    fs.mkdirSync(path.join(repo, 'lanes/custom'), { recursive: true });
    const entries = registryEntry(repo, 'wt-custom', 'CUSTOM', 'sess-self');
    entries['wt-custom'].path = 'lanes/custom';
    writeRegistry(repo, entries);
    expect(runOracle(repo, '.caws/worktrees/wt-custom/file', { blockJsYaml: true })).toBe(
      'ask_uncertain:worktree-payload-no-entry:wt-custom'
    );
  });
  test('an owned outer root cannot hide a nested foreign registered root', () => {
    const repo = makeRepo();
    const outer = path.join(repo, 'docs/custom');
    const inner = path.join(outer, 'nested');
    fs.mkdirSync(inner, { recursive: true });
    const entries = {
      ...registryEntry(repo, 'outer', 'OUTER', 'sess-self'),
      ...registryEntry(repo, 'inner', 'INNER', 'foreign-sess'),
    };
    entries.outer.path = outer;
    entries.inner.path = inner;
    writeRegistry(repo, entries);
    expect(runOracle(repo, outer, { blockJsYaml: true })).toBe(
      'block_foreign_worktree:inner:foreign-sess'
    );
    expect(runOracle(repo, path.join(inner, 'file'), { blockJsYaml: true })).toBe(
      'block_foreign_worktree:inner:foreign-sess'
    );
    expect(runOracle(repo, path.join(outer, 'other/file'), { blockJsYaml: true })).toBe(
      'ask_uncertain:worktree-ownership-overlap'
    );
  });
  test('duplicate physical roots cannot provide owner-self authority', () => {
    const repo = makeRepo();
    const custom = path.join(repo, 'docs/custom');
    fs.mkdirSync(custom, { recursive: true });
    const entries = {
      ...registryEntry(repo, 'first', 'FIRST', 'sess-self'),
      ...registryEntry(repo, 'second', 'SECOND', 'sess-self'),
    };
    entries.first.path = custom;
    entries.second.path = custom;
    writeRegistry(repo, entries);
    expect(runOracle(repo, path.join(custom, 'file'), { blockJsYaml: true })).toBe(
      'ask_uncertain:worktree-ownership-overlap'
    );
  });
  test('a registry alias cannot grant owner-self authority', () => {
    const repo = makeRepo();
    const custom = path.join(repo, 'docs/custom');
    const alias = path.join(repo, 'alias');
    fs.mkdirSync(custom, { recursive: true });
    fs.symlinkSync(custom, alias);
    const entries = registryEntry(repo, 'wt-custom', 'CUSTOM', 'sess-self');
    entries['wt-custom'].path = alias;
    writeRegistry(repo, entries);
    expect(runOracle(repo, path.join(custom, 'file'), { blockJsYaml: true })).toBe(
      'ask_uncertain:worktree-ownership-path'
    );
  });
  test.each(
    ['absolute', 'absolute-trailing', 'relative', 'relative-trailing'].flatMap((form) =>
      [
        ['my-sess', 'pass:owner-self:wt-boundary'],
        ['foreign-sess', 'block_foreign_worktree:wt-boundary:foreign-sess'],
        [null, 'ask_uncertain:worktree-payload-no-owner:wt-boundary'],
      ].map(([owner, expected]) => [form, owner, expected])
    )
  )(
    'worktree directory roots retain owner decisions for %s coordinates and owner %s',
    (form, owner, expected) => {
      const repo = makeRepo();
      makeWorktreeDir(repo, 'wt-boundary');
      writeRegistry(repo, registryEntry(repo, 'wt-boundary', 'BOUNDARY', owner));
      let candidate = '.caws/worktrees/wt-boundary';
      if (form.startsWith('absolute')) candidate = path.join(repo, candidate);
      if (form.endsWith('trailing')) candidate += '/';
      expect(runOracle(repo, candidate, { sessionId: 'my-sess', blockJsYaml: true })).toBe(
        expected
      );
    }
  );

  test.each(['.caws/worktrees/wt-ghost', '.caws/worktrees/wt-ghost/'])(
    'worktree directory roots without a live entry remain uncertain: %s',
    (candidate) => {
      const repo = makeRepo();
      makeWorktreeDir(repo, 'wt-control');
      makeWorktreeDir(repo, 'wt-ghost');
      writeRegistry(repo, registryEntry(repo, 'wt-control', 'CONTROL', 'my-sess'));
      expect(runOracle(repo, candidate, { sessionId: 'my-sess', blockJsYaml: true })).toBe(
        'ask_uncertain:worktree-payload-no-entry:wt-ghost'
      );
    }
  );

  test.each(['.caws/worktrees', '.caws', '.'])(
    'foreign payload ancestors preserve ownership without YAML: %s',
    (relative) => {
      const repo = makeRepo();
      makeWorktreeDir(repo, 'wt-other');
      writeRegistry(repo, registryEntry(repo, 'wt-other', 'OTHER', 'foreign-sess'));
      expect(
        runOracle(repo, path.join(repo, relative), { sessionId: 'my-sess', blockJsYaml: true })
      ).toBe('block_foreign_worktree:wt-other:foreign-sess');
    }
  );

  test('foreign payload ancestors prefer known ownership refusal over earlier uncertainty', () => {
    const repo = makeRepo();
    makeWorktreeDir(repo, 'wt-unknown');
    makeWorktreeDir(repo, 'wt-other');
    writeRegistry(repo, {
      ...registryEntry(repo, 'wt-unknown', 'UNKNOWN', null),
      ...registryEntry(repo, 'wt-other', 'OTHER', 'foreign-sess'),
    });
    expect(
      runOracle(repo, path.join(repo, '.caws'), { sessionId: 'my-sess', blockJsYaml: true })
    ).toBe('block_foreign_worktree:wt-other:foreign-sess');
  });

  test('foreign payload ancestors retain ownership uncertainty rather than YAML degradation', () => {
    const repo = makeRepo();
    makeWorktreeDir(repo, 'wt-unknown');
    writeRegistry(repo, registryEntry(repo, 'wt-unknown', 'UNKNOWN', null));
    expect(
      runOracle(repo, path.join(repo, '.caws'), { sessionId: 'my-sess', blockJsYaml: true })
    ).toBe('ask_uncertain:worktree-container-no-owner:wt-unknown');
  });

  test('foreign payload ancestors do not inherit a similarly named directory prefix', () => {
    const repo = makeRepo();
    makeWorktreeDir(repo, 'wt-other');
    writeRegistry(repo, registryEntry(repo, 'wt-other', 'OTHER', 'foreign-sess'));
    fs.mkdirSync(path.join(repo, '.caws', 'worktrees-sibling'));
    expect(runOracle(repo, path.join(repo, '.caws', 'worktrees-sibling'))).toBe('pass:unclaimed');
  });

  test('foreign payload ancestors do not turn owner-self into canonical claim permission', () => {
    const repo = makeRepo();
    seedClaimant(repo, { name: 'wt-mine', specId: 'MINE', owner: 'my-sess', scopeIn: ['.caws'] });
    expect(runOracle(repo, path.join(repo, '.caws'), { sessionId: 'my-sess' })).toBe(
      'block_claimed:wt-mine:.caws'
    );
  });

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
    'packages/a/b/src',
    'packages/a/b/x.js',
    'packages/dir/sub/x.py',
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

  function git(repo, home, args) {
    const result = spawnSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      timeout: 30000,
      env: hermeticGitEnvironment(home),
    });
    expect(result.status).toBe(0);
  }

  function makeClaimedRepo() {
    const repo = makeRepo();
    const home = temporaryDirectory('caws-oracle-home-');
    git(repo, home, ['init', '-q', '-b', 'main']);
    git(repo, home, ['config', 'user.name', 'CAWS Test']);
    git(repo, home, ['config', 'user.email', 'test@caws.invalid']);
    git(repo, home, ['config', 'commit.gpgsign', 'false']);
    git(repo, home, ['config', 'core.hooksPath', '/dev/null']);
    git(repo, home, ['commit', '-q', '--allow-empty', '-m', 'root commit']);
    seedClaimant(repo, {
      name: 'wt-dir',
      specId: 'DIR-001',
      owner: 'foreign-session',
      scopeIn: ['packages/dir'],
    });
    const cli = path.join(home, 'caws');
    const shellQuote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
    fs.writeFileSync(
      cli,
      '#!/bin/sh\nexec ' + shellQuote(process.execPath) + ' ' + shellQuote(CLI) + ' "$@"\n',
      { mode: 0o755 }
    );
    return { repo, home, cli };
  }

  // Mirrors the Bats guard harness: an isolated HOME and CAWS_HOME and a synthetic
  // session, so no real session state, registration or kill authority is borrowed.
  function runGuard({ repo, home, cli }, command, { writePath, noAsk = false } = {}) {
    const envelope = JSON.stringify({
      tool_name: writePath ? 'Write' : 'Bash',
      tool_input: writePath
        ? { file_path: writePath, content: 'unexecuted preflight data' }
        : { command },
      session_id: SESSION,
      cwd: repo,
    });
    const result = spawnSync('/bin/bash', [writePath ? WORKTREE_WRITE_GUARD : BASH_WRITE_GUARD], {
      cwd: repo,
      input: envelope,
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...hermeticGitEnvironment(home),
        CAWS_HOME: path.join(home, '.caws'),
        CAWS_BIN: cli,
        CAWS_PROJECT_DIR: repo,
        CAWS_AGENT_SURFACE: 'claude-code',
        HOOK_CWD: repo,
        HOOK_SESSION_ID: SESSION,
        CLAUDE_CODE_SESSION_ID: SESSION,
        CAWS_GUARD_NO_ASK: noAsk ? '1' : '0',
        NODE_PATH,
      },
    });
    expect(result.error).toBeUndefined();
    return result;
  }

  test('a mutation under the claimed directory is blocked, naming the claiming worktree and entry', () => {
    const result = runGuard(makeClaimedRepo(), 'touch packages/dir/file.py');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "BLOCKED: this Bash command mutates 'wt-dir:packages/dir', claimed by an active worktree's scope.in."
    );
  });

  test('a mutation of a sibling that only shares the prefix is admitted without a decision', () => {
    const result = runGuard(makeClaimedRepo(), 'touch packages/directory/file.py');
    // An approval request also exits 0, but writes permissionDecision "ask" to
    // stdout; admission writes no hook decision at all.
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('BLOCKED');
  });

  test.each(
    ['Bash', 'Write'].flatMap((tool) =>
      ['root', 'descendant', 'ancestor'].flatMap((form) =>
        ['foreign-session', null].map((owner) => [tool, form, owner])
      )
    )
  )('custom registered ownership survives allowlisting for %s %s owner %s', (tool, form, owner) => {
    const fixture = makeClaimedRepo();
    const custom = path.join(fixture.repo, 'docs/custom');
    fs.mkdirSync(custom, { recursive: true });
    const entries = registryEntry(fixture.repo, 'wt-custom', 'CUSTOM', owner);
    entries['wt-custom'].path = custom;
    writeRegistry(fixture.repo, entries);
    const target =
      form === 'root'
        ? custom
        : form === 'ancestor'
          ? path.dirname(custom)
          : path.join(custom, 'new/file');
    const result = runGuard(fixture, 'rm -r ' + "'" + target + "'", {
      noAsk: true,
      ...(tool === 'Write' ? { writePath: target } : {}),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(owner ? 'DIFFERENT session' : 'worktree-');
    expect(result.stderr).not.toContain('mandatory analyzer failed');
    expect(fs.lstatSync(custom).isDirectory()).toBe(true);
  });

  test.each(['Bash', 'Write'])('a unique owned custom path admits %s payload', (tool) => {
    const fixture = makeClaimedRepo();
    const custom = path.join(fixture.repo, 'docs/custom');
    fs.mkdirSync(custom, { recursive: true });
    const entries = registryEntry(fixture.repo, 'wt-custom', 'CUSTOM', SESSION);
    entries['wt-custom'].path = custom;
    writeRegistry(fixture.repo, entries);
    const target = path.join(custom, 'new/file');
    const result = runGuard(
      fixture,
      'touch ' + "'" + target + "'",
      tool === 'Write' ? { writePath: target } : {}
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(fs.existsSync(target)).toBe(false);
  });
});
