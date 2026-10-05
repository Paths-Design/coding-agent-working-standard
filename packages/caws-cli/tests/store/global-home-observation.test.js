'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { composeStoreSnapshot } = require('../../dist/store/doctor-snapshot');
const { installMachineRuntime } = require('../../dist/init/machine-adapters');
const { inspectProjectState } = require('../../dist/kernel/doctor/inspect');

let fixture, home, previousHome;
beforeEach(() => {
  fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-doctor-home-')));
  home = path.join(fixture, 'machine');
  previousHome = process.env.CAWS_HOME;
  process.env.CAWS_HOME = home;
});
afterEach(() => {
  jest.restoreAllMocks();
  if (previousHome === undefined) delete process.env.CAWS_HOME;
  else process.env.CAWS_HOME = previousHome;
  fs.rmSync(fixture, { recursive: true, force: true });
});

function observe() {
  return composeStoreSnapshot({ repoRoot: fixture, cawsDir: path.join(fixture, '.caws') })
    .filesystem.globalHomeObservation;
}
function findings(observation) {
  return inspectProjectState({
    now: new Date('2026-09-07T00:00:00Z'),
    specs: [],
    filesystem: { globalHomeObservation: observation },
  }).findings.filter((f) => f.rule.startsWith('doctor.global_home.'));
}

test('an absent home is silent and observing it does not create it', () => {
  const value = observe();
  expect(value).toEqual({ kind: 'absent', root: home });
  expect(findings(value)).toEqual([]);
  expect(fs.existsSync(home)).toBe(false);
});

test('an empty existing home has an actionable initialization finding', () => {
  fs.mkdirSync(home);
  const value = observe();
  expect(value).toEqual({
    kind: 'present',
    root: home,
    entries: [],
    stampPresent: false,
    runtime: { status: 'absent' },
  });
  expect(findings(value)).toEqual([
    expect.objectContaining({
      rule: 'doctor.global_home.stamp_missing',
      severity: 'info',
      subject: home,
      narrowRepair: expect.stringContaining('caws init adapters install'),
    }),
  ]);
  expect(fs.readdirSync(home)).toEqual([]);
});

test.each(['EACCES', 'EIO'])('a failed directory read stays an explicit %s observation', (code) => {
  fs.mkdirSync(home);
  const readdir = fs.readdirSync;
  jest.spyOn(fs, 'readdirSync').mockImplementation((file, ...args) => {
    if (file === home) throw Object.assign(new Error('fixture read failure'), { code });
    return readdir(file, ...args);
  });
  const value = observe();
  expect(value).toMatchObject({ kind: 'unreadable', root: home, error: { code } });
  expect(findings(value)).toEqual([
    expect.objectContaining({
      rule: 'doctor.global_home.unreadable',
      severity: 'error',
      subject: home,
      data: expect.objectContaining({ code }),
    }),
  ]);
});

test('a file where the directory belongs is not absence', () => {
  fs.writeFileSync(home, 'operator data');
  expect(observe()).toMatchObject({ kind: 'unreadable', root: home, error: { code: 'ENOTDIR' } });
  expect(fs.readFileSync(home, 'utf8')).toBe('operator data');
});

test('an inaccessible state directory is not an uninitialized home', () => {
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  const stat = fs.statSync;
  jest.spyOn(fs, 'statSync').mockImplementation((file, ...args) => {
    if (file === path.join(home, 'state/global-home.json'))
      throw Object.assign(new Error('fixture state permission failure'), { code: 'EACCES' });
    return stat(file, ...args);
  });
  expect(observe()).toMatchObject({ kind: 'unreadable', error: { code: 'EACCES' } });
});

test('an unreadable runtime pointer cannot become a missing runtime', () => {
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  const stat = fs.statSync;
  jest.spyOn(fs, 'statSync').mockImplementation((file, ...args) => {
    if (file === path.join(home, 'state/adapter-runtime.json'))
      throw Object.assign(new Error('fixture pointer permission failure'), { code: 'EACCES' });
    return stat(file, ...args);
  });
  expect(observe()).toMatchObject({
    kind: 'present',
    runtime: { status: 'invalid', error: 'fixture pointer permission failure' },
  });
});

test('a relative override fails explicitly rather than depending on process cwd', () => {
  process.env.CAWS_HOME = 'relative-machine';
  expect(observe()).toMatchObject({
    kind: 'unreadable',
    root: 'relative-machine',
    error: { code: 'EINVAL' },
  });
});

test('a redirected home is refused without touching its target', () => {
  const target = path.join(fixture, 'personal');
  fs.mkdirSync(target);
  fs.symlinkSync(target, home);
  expect(observe()).toMatchObject({ kind: 'unreadable', root: home });
  expect(fs.readdirSync(target)).toEqual([]);
});

test('installation resolves initialization without a legacy stamp or native configuration', () => {
  fs.mkdirSync(home);
  expect(findings(observe())).toHaveLength(1);
  const installed = installMachineRuntime({ home });
  const value = observe();
  expect(value).toMatchObject({
    kind: 'present',
    stampPresent: false,
    runtime: { status: 'verified', digest: installed.digest },
  });
  expect(findings(value)).toEqual([]);
  expect(fs.existsSync(path.join(home, 'state/global-home.json'))).toBe(false);
  expect(fs.existsSync(path.join(home, 'state/surfaces'))).toBe(false);
});

test('tampered installed bytes produce an integrity error even with a legacy stamp', () => {
  const installed = installMachineRuntime({ home });
  const file = path.join(home, 'lib/runtimes', installed.digest, 'launcher.py');
  fs.appendFileSync(file, '\n# tamper control\n');
  fs.writeFileSync(path.join(home, 'state/global-home.json'), '{}');
  const value = observe();
  expect(value).toMatchObject({
    kind: 'present',
    runtime: {
      status: 'invalid',
      error: expect.stringContaining('launcher.py'),
    },
  });
  expect(findings(value)).toEqual([
    expect.objectContaining({
      rule: 'doctor.global_home.runtime_invalid',
      severity: 'error',
      subject: home,
    }),
  ]);
  expect(fs.readFileSync(file, 'utf8')).toContain('# tamper control');
});

test('malformed pointer state is reported rather than downgraded to uninitialized', () => {
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state/adapter-runtime.json'), '{broken');
  const value = observe();
  expect(value).toMatchObject({ kind: 'present', runtime: { status: 'invalid' } });
  expect(findings(value).map((f) => f.rule)).toEqual(['doctor.global_home.runtime_invalid']);
});

test('a legacy stamp preserves compatibility while unmanaged entries retain their names', () => {
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state/global-home.json'), '{}');
  fs.writeFileSync(path.join(home, 'personal-notes.txt'), 'keep');
  const value = observe();
  expect(value).toMatchObject({
    kind: 'present',
    stampPresent: true,
    runtime: { status: 'absent' },
  });
  expect(findings(value)).toEqual([
    expect.objectContaining({
      rule: 'doctor.global_home.unmanaged_state',
      subject: home,
      data: { foreign_entries: ['personal-notes.txt'] },
    }),
  ]);
  expect(fs.readFileSync(path.join(home, 'personal-notes.txt'), 'utf8')).toBe('keep');
});
