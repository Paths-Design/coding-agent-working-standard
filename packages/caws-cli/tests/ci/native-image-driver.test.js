'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const {
  parseDriverArguments,
  observeCommittedSource,
  npmEnvironment,
  assertNoNpmProjectConfig,
} = require('../../scripts/build-native-hook-image.cjs');

describe('native image driver explicit request arguments', () => {
  const request = ['--request', '/public/request.json', '--request-sha256', 'a'.repeat(64)];
  test.each(['cli', 'sqlite', 'prepare-native'])(
    '%s requires its driver pin without an unconsumed native pin',
    (phase) => {
      const result = parseDriverArguments([phase, ...request]);
      expect(result.phase).toBe(phase);
      expect(result.options.get('--request-sha256')).toBe('a'.repeat(64));
      expect(() =>
        parseDriverArguments([phase, ...request, '--native-request-sha256', 'b'.repeat(64)])
      ).toThrow();
    }
  );
  test.each(['native', 'image'])('%s requires an explicit selected native request pin', (phase) => {
    expect(() => parseDriverArguments([phase, ...request])).toThrow();
    expect(
      parseDriverArguments([
        phase,
        ...request,
        '--native-request-sha256',
        'b'.repeat(64),
      ]).options.get('--native-request-sha256')
    ).toBe('b'.repeat(64));
  });
  test.each([
    [[], /Unknown phase/],
    [['unknown'], /Unknown phase/],
    [['cli'], /Required driver request/],
    [['cli', ...request, '--request', '/other'], /Duplicate option/],
    [['cli', ...request, '--unknown', 'x'], /Unknown option/],
    [['cli', ...request, '--trailing'], /option\/value pairs/],
    [
      ['cli', '--request', '/public/request.json', '--request-sha256', 'not-a-pin'],
      /Invalid SHA256/,
    ],
  ])('refuses ambiguous or incomplete arguments %j', (args, reason) => {
    expect(() => parseDriverArguments(args)).toThrow(reason);
  });
});

describe('committed build input observation in an actual private Git repository', () => {
  let root, commit, env;
  function git(...args) {
    return execFileSync('/usr/bin/git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  }
  function observe() {
    return observeCommittedSource(root, commit, ['src', '.gitignore'], ['src']);
  }
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-driver-source-')));
    env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
    );
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/a.js'), 'module.exports = 7;\n');
    fs.writeFileSync(path.join(root, '.gitignore'), '*.ignored\n');
    git('init', '-q', '-b', 'main');
    git('add', 'src/a.js', '.gitignore');
    git(
      '-c',
      'user.name=CAWS fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'fixture'
    );
    commit = git('rev-parse', 'HEAD');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  test('refuses a project npm override without reading its content', () => {
    expect(() => assertNoNpmProjectConfig(root)).not.toThrow();
    fs.appendFileSync(path.join(root, '.gitignore'), '.npmrc\n');
    fs.writeFileSync(path.join(root, '.npmrc'), 'ignore-scripts=true\n');
    expect(() => assertNoNpmProjectConfig(root)).toThrow(/Project npm configuration/);
  });
  test('isolated npm configuration uses distinct empty layers and rejects changed contents', () => {
    fs.mkdirSync(path.join(root, 'npm-home'));
    fs.writeFileSync(path.join(root, 'npm-userconfig'), '');
    fs.writeFileSync(path.join(root, 'npm-globalconfig'), '');
    const environment = npmEnvironment(root, process.execPath);
    expect(environment.NPM_CONFIG_USERCONFIG).not.toBe(environment.NPM_CONFIG_GLOBALCONFIG);
    expect(environment.NPM_CONFIG_USERCONFIG).toBe(path.join(root, 'npm-userconfig'));
    expect(environment.NPM_CONFIG_GLOBALCONFIG).toBe(path.join(root, 'npm-globalconfig'));
    expect(environment.HOME).toBe(path.join(root, 'npm-home'));
    fs.writeFileSync(environment.NPM_CONFIG_GLOBALCONFIG, 'registry=https://example.invalid\n');
    expect(() => npmEnvironment(root, process.execPath)).toThrow(/global npm configuration/);
  });
  test('observes the exact committed bytes without creating build artifacts', () => {
    const before = git('status', '--porcelain');
    const result = observe();
    expect(result).toMatchObject({ sourceCommit: commit, files: 2 });
    expect(result.treeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sizeBytes).toBe(
      fs.statSync(path.join(root, 'src/a.js')).size +
        fs.statSync(path.join(root, '.gitignore')).size
    );
    expect(git('status', '--porcelain')).toBe(before);
    expect(fs.readdirSync(root).sort()).toEqual(['.git', '.gitignore', 'src']);
  });
  test('reserves the file bound before hashing even when status hides the change', () => {
    git('update-index', '--assume-unchanged', 'src/a.js');
    fs.truncateSync(path.join(root, 'src/a.js'), 256 * 1024 * 1024 + 1);
    expect(observe).toThrow(/per-file bound/);
  });
  test.each([
    'wrong HEAD',
    'dirty source',
    'hidden dirty source',
    'extra source',
    'ignored source',
    'mode drift',
    'symlink',
  ])('refuses %s before a build can use it', (kind) => {
    if (kind === 'wrong HEAD') commit = '0'.repeat(40);
    if (kind === 'hidden dirty source') git('update-index', '--assume-unchanged', 'src/a.js');
    if (kind === 'dirty source' || kind === 'hidden dirty source')
      fs.writeFileSync(path.join(root, 'src/a.js'), 'module.exports = 9;\n');
    if (kind === 'extra source') fs.writeFileSync(path.join(root, 'src/additional.js'), 'extra\n');
    if (kind === 'ignored source')
      fs.writeFileSync(path.join(root, 'src/additional.ignored'), 'extra\n');
    if (kind === 'mode drift') fs.chmodSync(path.join(root, 'src/a.js'), 0o755);
    if (kind === 'symlink') {
      fs.symlinkSync('a.js', path.join(root, 'src/link.js'));
      git('add', 'src/link.js');
      git(
        '-c',
        'user.name=CAWS fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'symlink fixture'
      );
      commit = git('rev-parse', 'HEAD');
    }
    expect(observe).toThrow();
  });
});
