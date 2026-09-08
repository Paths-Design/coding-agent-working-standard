'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const factory = require('../helpers/git-repo-factory');
const factoryPath = require.resolve('../helpers/git-repo-factory');
const temporary = [];

afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  factory.cleanupAll();
  for (const root of temporary) fs.rmSync(root, { recursive: true, force: true });
});

function root() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-fixture-isolation-')));
  temporary.push(dir);
  return dir;
}

test('an interrupted copy fails once, removes its partial destination, and retains diagnostic custody', () => {
  const original = Object.assign(new Error('copy interrupted'), { code: 'ENOENT' });
  let destination;
  const copy = jest.spyOn(fs, 'cpSync').mockImplementationOnce((source, target) => {
    destination = target;
    fs.mkdirSync(path.join(target, '.git/objects'), { recursive: true });
    fs.writeFileSync(path.join(target, '.git/objects/partial'), 'incomplete');
    throw original;
  });
  let caught;
  try { factory.makeTempRepo(); } catch (error) { caught = error; }
  expect(copy).toHaveBeenCalledTimes(1);
  expect(caught).toBeInstanceOf(Error);
  expect(fs.existsSync(destination)).toBe(false);
  expect(caught.cause).toBe(original);
  expect(caught.code).toBe('ENOENT');
  expect(caught.fixtureContext).toMatchObject({
    pid: process.pid, destination, destinationExisted: true, templateExisted: true,
  });
  expect(caught.message).toContain('copy interrupted');
});

test('inherited Git storage and config overrides cannot redirect a fixture into a foreign repository', () => {
  const foreign = factory.makeTempRepo();
  const before = factory.git(foreign, ['rev-parse', 'HEAD']);
  const result = spawnSync(process.execPath, ['-e', `
    const fs = require('fs');
    const f = require(${JSON.stringify(factoryPath)});
    const repo = f.makeTempRepo();
    console.log(JSON.stringify({ repo: fs.realpathSync(repo), top: fs.realpathSync(f.git(repo, ['rev-parse', '--show-toplevel'])), clean: f.git(repo, ['status', '--porcelain']), email: f.git(repo, ['config', '--get', 'user.email']) }));
  `], {
    encoding: 'utf8',
    env: {
      ...process.env, TMPDIR: root(),
      GIT_DIR: path.join(foreign, '.git'), GIT_WORK_TREE: foreign,
      GIT_INDEX_FILE: path.join(foreign, '.git/index'),
      GIT_OBJECT_DIRECTORY: path.join(foreign, '.git/objects'),
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.email', GIT_CONFIG_VALUE_0: 'foreign@invalid',
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  const observed = JSON.parse(result.stdout);
  expect(observed.top).toBe(observed.repo);
  expect(observed.clean).toBe('');
  expect(observed.email).toBe('test@caws.invalid');
  expect(factory.git(foreign, ['rev-parse', 'HEAD'])).toBe(before);
  expect(factory.git(foreign, ['config', '--get', 'user.email'])).toBe('test@caws.invalid');
});

test('independent processes with the same worker ID can create and clean fixtures concurrently', async () => {
  const directory = root();
  const sentinel = path.join(directory, 'foreign-repository');
  fs.mkdirSync(sentinel);
  fs.writeFileSync(path.join(sentinel, 'keep'), 'foreign bytes');
  const script = `
    const fs = require('fs');
    const f = require(${JSON.stringify(factoryPath)});
    for (let n = 0; n < 32; n++) {
      const repo = f.makeTempRepo();
      if (fs.realpathSync(f.git(repo, ['rev-parse', '--show-toplevel'])) !== fs.realpathSync(repo)) throw new Error('foreign Git root');
      if (f.git(repo, ['status', '--porcelain']) !== '') throw new Error('dirty fixture');
      f.cleanupRepo(repo);
      if (fs.existsSync(repo)) throw new Error('owned fixture leaked');
    }
    console.log('32 isolated repositories');
  `;
  const results = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, TMPDIR: directory, JEST_WORKER_ID: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  })));
  for (const result of results) {
    expect(result).toEqual({ code: 0, signal: null, stdout: '32 isolated repositories\n', stderr: '' });
  }
  expect(fs.readFileSync(path.join(sentinel, 'keep'), 'utf8')).toBe('foreign bytes');
  expect(fs.readdirSync(directory)).toEqual(['foreign-repository']);
}, 60000);
