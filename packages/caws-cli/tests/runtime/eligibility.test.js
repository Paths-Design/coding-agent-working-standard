// Real bounded operational records; no reprieve CLI grants or native effects.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { handlerEligibility } = require('../../dist/runtime/eligibility');
const NOW = Date.UTC(2030, 0, 1);
let root, home, repo, file, context;
const handler = { name: 'session-log.sh' };
const record = (extra = {}) => ({
  session_id: 'fixture',
  created_at: 'creation',
  approved_by: 'fixture approver',
  reason: 'fixture reason',
  expires_at: '2099-01-01T00:00:00Z',
  handlers: ['session-log.sh', 'agent-stop.sh'],
  repo_root: repo,
  ...extra,
});
const put = (value = record()) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
const consult = (selected = handler) => handlerEligibility(selected, context);
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-eligibility-')));
  home = path.join(root, 'machine');
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  file = path.join(home, 'state/sessions/fixture/guard-reprieve-fixture.json');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  context = {
    home,
    canonical: repo,
    vendorDirectory: '.codex',
    sessionId: 'fixture',
    event: 'session_end',
    environment: {},
    now: () => NOW,
  };
  put();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test.each([
  '2099-01-01T00:00:00Z',
  '20990101T123045Z',
  '2099-W01-1T12:00',
  '2099-01-01T12:00:00',
  '2099-01-01',
  '2099-01-01T12:30:45.123456789Z',
  '2099-01-01T12:30,5+0130',
  '2099-01-01T12:00+00:00:01.5',
])('bounded eligibility honors consumed legacy expiry %s', (expires_at) => {
  put(record({ expires_at }));
  for (const name of ['session-log.sh', 'agent-stop.sh'])
    expect(consult({ name })).toEqual({
      status: 'reprieved',
      reason: 'Session reprieve until ' + expires_at + ': fixture reason',
    });
});
test.each([
  '2030-01-01T00:00:00Z',
  '2030-01-01T00:00:00.000500Z',
  '2099-02-30T00:00Z',
  '2099-01-01T24:00Z',
  '2099-01-01T12:00z',
  '',
  null,
])('expired, uncertain or invalid expiry %p leaves the handler running', (expires_at) => {
  put(record({ expires_at }));
  expect(consult()).toEqual({ status: 'run' });
});
test('first certain millisecond is active and invalid clock samples cannot skip', () => {
  put(record({ expires_at: '2030-01-01T00:00:00.001000Z' }));
  expect(consult().status).toBe('reprieved');
  for (const value of [NaN, Infinity, NOW + 0.5]) {
    context.now = () => value;
    expect(consult()).toEqual({ status: 'run' });
  }
});
test('unemittable reasons do not turn an inert shell record into a typed skip', () => {
  for (const reason of ['\ud800', '\udfff']) {
    put(record({ reason }));
    expect(consult()).toEqual({ status: 'run' });
  }
  put(record({ reason: 'valid 💥 reason' }));
  expect(consult()).toEqual({
    status: 'reprieved',
    reason: 'Session reprieve until 2099-01-01T00:00:00Z: valid 💥 reason',
  });
});
test('unpaired context and repo strings cannot select replacement-character aliases', () => {
  const replacement = path.join(root, '\ufffd');
  fs.mkdirSync(replacement);
  context.canonical = replacement;
  put(record({ repo_root: path.join(root, '\udc80') }));
  expect(consult()).toEqual({ status: 'run' });
  put(record({ repo_root: replacement }));
  expect(consult().status).toBe('reprieved');
  context.canonical = path.join(root, '\udc80');
  expect(consult()).toEqual({ status: 'run' });
  context.canonical = repo;
  put(record({ handlers: ['\udc80'], repo_root: repo }));
  expect(consult({ name: '\udc80' })).toEqual({ status: 'run' });
  context.sessionId = '\udc80';
  file = path.join(home, 'state/sessions/___/guard-reprieve-___.json');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  put(record({ session_id: '\udc80' }));
  expect(consult()).toEqual({ status: 'run' });
});
test.each([
  { revoked_at: null },
  { session_id: 'neighbor' },
  { handlers: ['other.sh'] },
  { repo_root: '/foreign' },
  { reason: '' },
  { approved_by: null },
])('binding and revocation control %j leaves the handler running', (extra) => {
  put(record(extra));
  expect(consult()).toEqual({ status: 'run' });
});
test('64KiB exact boundary stays active and one extra byte is refused', () => {
  const text = JSON.stringify(record());
  fs.writeFileSync(file, text + ' '.repeat(65_536 - Buffer.byteLength(text)));
  expect(consult().status).toBe('reprieved');
  fs.appendFileSync(file, ' ');
  expect(consult()).toEqual({ status: 'run' });
});
test.each(['symlink', 'hardlink', 'writable', 'invalid utf8', 'directory'])(
  'operational %s data cannot authorize a skip',
  (kind) => {
    if (kind === 'symlink') {
      const target = path.join(root, 'target.json');
      fs.renameSync(file, target);
      fs.symlinkSync(target, file);
    } else if (kind === 'hardlink') fs.linkSync(file, path.join(root, 'second-link'));
    else if (kind === 'writable') fs.chmodSync(file, 0o620);
    else if (kind === 'invalid utf8') fs.writeFileSync(file, Buffer.from([0xff]));
    else {
      fs.rmSync(file);
      fs.mkdirSync(file);
    }
    expect(consult()).toEqual({ status: 'run' });
  }
);
test('redirected parent is refused and malformed machine presence shadows valid legacy', () => {
  const parent = path.dirname(file),
    moved = path.join(root, 'moved-session');
  fs.renameSync(parent, moved);
  fs.symlinkSync(moved, parent);
  expect(consult()).toEqual({ status: 'run' });
  fs.rmSync(parent);
  fs.renameSync(moved, parent);
  const legacy = path.join(repo, '.codex/hooks/state/guard-reprieve-fixture.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true, mode: 0o700 });
  fs.writeFileSync(legacy, JSON.stringify(record()), { mode: 0o600 });
  fs.writeFileSync(file, '{');
  expect(consult()).toEqual({ status: 'run' });
  fs.rmSync(file);
  expect(consult().status).toBe('reprieved');
});
