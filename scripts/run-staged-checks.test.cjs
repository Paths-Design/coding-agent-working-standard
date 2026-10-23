'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { test, after } = require('node:test');
const { main } = require('./run-staged-checks.cjs');

const ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(__dirname, 'run-staged-checks.cjs');
const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
);
const VALID_SPEC = Buffer.from(`id: STAGED-RUNNER-FIXTURE-001
title: Staged runner fixture
mode: fix
lifecycle_state: draft
blast_radius:
  modules: [fixture]
  data_migration: false
operational_rollback_slo: 5m
scope:
  in: [doc.md]
  out: []
invariants: [Staged bytes remain owned by the caller]
acceptance:
  - id: A1
    given: staged bytes
    when: validated
    then: valid bytes are accepted
rollback: [Revert the fixture]
non_functional: {}
contracts:
  - name: fixture
    type: behavior
`);
const UNFORMATTED = '#  Formatting   probe\n\nhello   world\n';
const FORMATTED = '# Formatting probe\n\nhello world\n';
const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-staged-check-')));
  roots.push(root);
  const env = {
    ...cleanEnv,
    HOME: root,
    GIT_CONFIG_GLOBAL: path.join(root, '.gitconfig-test'),
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  const git = (...args) =>
    execFileSync(REAL_GIT, ['--literal-pathspecs', ...args], { cwd: root, env });
  const write = (name, bytes) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  };
  git('init', '-q');
  write('doc.md', '# Initial\n');
  write('.caws/specs/PROBE.yaml', VALID_SPEC);
  fs.copyFileSync(path.join(ROOT, '.prettierignore'), path.join(root, '.prettierignore'));
  write('package.json', '{"name":"staged-fixture","private":true}\n');
  write(
    'eslint.config.cjs',
    'module.exports = [{files:["**/*.js"],rules:{semi:["error","always"]}}];\n'
  );
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'));
  git('add', '--', 'doc.md', '.caws/specs/PROBE.yaml');
  git('commit', '-qm', 'fixture baseline');
  const log = path.join(root, 'git-calls.jsonl');
  write(
    'bin/git',
    `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');const r=cp.spawnSync(${JSON.stringify(REAL_GIT)},args,{stdio:'inherit'});process.exit(r.status===null?1:r.status);\n`
  );
  fs.chmodSync(path.join(root, 'bin/git'), 0o755);
  // Use the actual built CLI validator; CI need not install a global caws.
  const cli = path.join(ROOT, 'packages/caws-cli/dist/index.js');
  write(
    'bin/caws',
    `#!${process.execPath}\nconst cp=require('node:child_process');const r=cp.spawnSync(process.execPath,[${JSON.stringify(cli)},...process.argv.slice(2)],{stdio:'inherit'});process.exit(r.status===null?1:r.status);\n`
  );
  fs.chmodSync(path.join(root, 'bin/caws'), 0o755);
  env.PATH = path.join(root, 'bin') + path.delimiter + process.env.PATH;
  const run = (cwd = root, override = {}) =>
    spawnSync(process.execPath, [RUNNER], {
      cwd,
      env: { ...env, ...override },
      encoding: 'utf8',
      timeout: 30000,
    });
  const index = name => {
    const entry = git('ls-files', '--stage', '-z', '--', name).toString();
    const oid = entry.slice(0, entry.indexOf('\t')).split(' ')[1];
    return git('cat-file', 'blob', oid).toString();
  };
  const sparse = bytes => {
    git('sparse-checkout', 'init', '--no-cone');
    git('sparse-checkout', 'set', '--no-cone', '/*', '!/.caws/specs/');
    const oid = execFileSync(REAL_GIT, ['hash-object', '-w', '--stdin'], {
      cwd: root,
      env,
      input: bytes,
    })
      .toString()
      .trim();
    git('update-index', '--cacheinfo', `100644,${oid},.caws/specs/PROBE.yaml`);
    git('update-index', '--skip-worktree', '.caws/specs/PROBE.yaml');
  };
  const calls = () =>
    fs
      .readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
  const noBackup = () => {
    const observed = calls();
    assert.ok(observed.some(args => args.includes('diff')));
    assert.equal(
      observed.some(args =>
        args.some(arg => ['stash', 'reset', 'checkout', '--sparse'].includes(arg))
      ),
      false
    );
    assert.equal(fs.existsSync(path.join(root, '.git/refs/stash')), false);
    assert.deepEqual(
      fs.readdirSync(path.join(root, '.git')).filter(name => name.includes('lint-staged')),
      []
    );
  };
  return { root, env, git, write, run, index, sparse, calls, noBackup };
}

test('valid staged-only sparse spec stays absent and byte-identical while source is formatted', () => {
  const f = fixture();
  const spec = Buffer.from(VALID_SPEC.toString().replace('title:', '# staged-only\ntitle:'));
  f.sparse(spec);
  f.write('doc.md', UNFORMATTED);
  f.git('add', 'doc.md');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.index('.caws/specs/PROBE.yaml'), spec.toString());
  assert.equal(fs.existsSync(path.join(f.root, '.caws/specs/PROBE.yaml')), false);
  assert.equal(
    f.git('ls-files', '-t', '--', '.caws/specs/PROBE.yaml').toString().slice(0, 2),
    'S '
  );
  assert.equal(f.index('doc.md'), FORMATTED);
  assert.equal(
    f
      .calls()
      .filter(args => args.includes('add'))
      .some(args => args.some(arg => arg.includes('.caws/'))),
    false
  );
  f.noBackup();
});

test('invalid sparse staged spec refuses before formatting and is never materialized', () => {
  const f = fixture();
  const invalid = Buffer.from('id: [unterminated\n');
  f.sparse(invalid);
  f.write('doc.md', UNFORMATTED);
  f.git('add', 'doc.md');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /caws exited/);
  assert.equal(f.index('.caws/specs/PROBE.yaml'), invalid.toString());
  assert.equal(fs.existsSync(path.join(f.root, '.caws/specs/PROBE.yaml')), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'doc.md'), 'utf8'), UNFORMATTED);
  assert.equal(
    f.calls().some(args => args.includes('add')),
    false
  );
  f.noBackup();
});

test('spec validation uses staged bytes, preserving different materialized working bytes', () => {
  const f = fixture();
  const valid = VALID_SPEC.toString().replace('title:', '# staged\ntitle:');
  f.write('.caws/specs/PROBE.yaml', valid);
  f.git('add', '.caws/specs/PROBE.yaml');
  f.write('.caws/specs/PROBE.yaml', 'invalid: [working bytes\n');
  let result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.index('.caws/specs/PROBE.yaml'), valid);
  assert.equal(
    fs.readFileSync(path.join(f.root, '.caws/specs/PROBE.yaml'), 'utf8'),
    'invalid: [working bytes\n'
  );
  f.git('add', '.caws/specs/PROBE.yaml');
  f.write('.caws/specs/PROBE.yaml', VALID_SPEC);
  result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(f.index('.caws/specs/PROBE.yaml'), 'invalid: [working bytes\n');
  assert.deepEqual(fs.readFileSync(path.join(f.root, '.caws/specs/PROBE.yaml')), VALID_SPEC);
  f.noBackup();
});

test('real git-add lock failure returns its status and leaves formatted work unstaged', () => {
  const f = fixture();
  f.write('doc.md', UNFORMATTED);
  f.git('add', 'doc.md');
  f.write('.git/index.lock', 'retained lock control\n');
  const result = f.run();
  assert.equal(result.status, 128);
  assert.match(result.stderr, /index\.lock/);
  assert.equal(f.index('doc.md'), UNFORMATTED);
  assert.equal(fs.readFileSync(path.join(f.root, 'doc.md'), 'utf8'), FORMATTED);
  assert.equal(
    fs.readFileSync(path.join(f.root, '.git/index.lock'), 'utf8'),
    'retained lock control\n'
  );
  f.noBackup();
});

test('real formatter failure refuses without restaging or rolling back source', () => {
  const f = fixture();
  const bytes = 'bad: [unterminated\n';
  f.write('bad.yaml', bytes);
  f.git('add', 'bad.yaml');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SyntaxError/);
  assert.equal(f.index('bad.yaml'), bytes);
  assert.equal(fs.readFileSync(path.join(f.root, 'bad.yaml'), 'utf8'), bytes);
  assert.equal(
    f.calls().some(args => args.includes('add')),
    false
  );
  f.noBackup();
});

test('ordinary partial staging retains whole-file restage without hidden backup', () => {
  const f = fixture();
  f.write('doc.md', '#  Staged\n');
  f.git('add', 'doc.md');
  f.write('doc.md', '#  Staged\n\nunstaged   hunk\n');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.index('doc.md'), '# Staged\n\nunstaged hunk\n');
  assert.equal(fs.readFileSync(path.join(f.root, 'doc.md'), 'utf8'), f.index('doc.md'));
  f.noBackup();
});

test('literal filenames with whitespace, Unicode, dash, colon and glob syntax do not expand', () => {
  const f = fixture();
  const names = [
    'space file.md',
    'line\nbreak.md',
    'tab\tfile.md',
    'quote"file.md',
    '-leading.md',
    'unicodé.md',
    'literal[1].md',
    ':(glob)*.md',
  ];
  for (const name of names) f.write(name, UNFORMATTED);
  f.write('literal1.md', UNFORMATTED);
  f.git('add', '--', ...names);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  for (const name of names) assert.equal(f.index(name), FORMATTED, name);
  assert.equal(fs.readFileSync(path.join(f.root, 'literal1.md'), 'utf8'), UNFORMATTED);
  f.noBackup();
});

test('root fences hold and workspace cwd is refused before formatting', () => {
  const f = fixture();
  f.write('.prettierignore', 'fenced.md\n');
  f.write('fenced.md', UNFORMATTED);
  f.write('loose.md', UNFORMATTED);
  f.git('add', 'fenced.md', 'loose.md');
  f.write('packages/pkg/package.json', '{"name":"workspace"}\n');
  let result = f.run(path.join(f.root, 'packages/pkg'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /checkout root/);
  assert.equal(fs.readFileSync(path.join(f.root, 'loose.md'), 'utf8'), UNFORMATTED);
  result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.index('fenced.md'), UNFORMATTED);
  assert.equal(f.index('loose.md'), FORMATTED);
  f.noBackup();
});

test('ESLint fixes run before Prettier and real ESLint syntax failures stop restaging', () => {
  const f = fixture();
  f.write('source.js', 'const value=1\n');
  f.git('add', 'source.js');
  let result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.index('source.js'), 'const value = 1;\n');
  f.write('source.js', 'const =\n');
  f.git('add', 'source.js');
  result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /Parsing error/);
  assert.equal(f.index('source.js'), 'const =\n');
  f.noBackup();
});

test('a symlink working file or parent cannot redirect a formatter outside the tracked path', () => {
  const f = fixture();
  f.write('nested/doc.md', UNFORMATTED);
  f.git('add', 'nested/doc.md');
  fs.renameSync(path.join(f.root, 'nested'), path.join(f.root, 'held'));
  fs.symlinkSync(path.join(f.root, 'held'), path.join(f.root, 'nested'));
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /symlink parent/);
  assert.equal(fs.readFileSync(path.join(f.root, 'held/doc.md'), 'utf8'), UNFORMATTED);
  assert.equal(f.index('nested/doc.md'), UNFORMATTED);
  f.noBackup();
});

for (const failure of [
  { status: null, signal: 'SIGTERM' },
  { status: null, error: new Error('spawn control') },
]) {
  test(`formatter ${failure.signal || 'spawn error'} is a failure and cannot reach restaging`, () => {
    const f = fixture();
    f.write('doc.md', UNFORMATTED);
    f.git('add', 'doc.md');
    let diagnostic = '';
    const status = main({
      cwd: f.root,
      env: f.env,
      error: text => {
        diagnostic += text;
      },
      spawn: (command, args, options) =>
        command === process.execPath ? failure : spawnSync(command, args, options),
    });
    assert.equal(status, 1);
    assert.match(diagnostic, failure.signal ? /SIGTERM/ : /spawn control/);
    assert.equal(
      f.calls().some(args => args.includes('add')),
      false
    );
    assert.equal(f.index('doc.md'), UNFORMATTED);
    f.noBackup();
  });
}

test('a real Git read failure refuses instead of masquerading as no staged files', () => {
  const f = fixture();
  const result = f.run(f.root, { GIT_INDEX_FILE: path.join(f.root, 'broken-index') });
  // An existing malformed alternate index, rather than a missing empty index.
  f.write('broken-index', 'not an index\n');
  const failed = f.run(f.root, { GIT_INDEX_FILE: path.join(f.root, 'broken-index') });
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /index/);
  f.noBackup();
});
