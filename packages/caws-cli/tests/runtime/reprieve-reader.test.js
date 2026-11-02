const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  parseReprieveExpiry,
  readReprieve,
  serializeReprieveMatch,
} = require('../../dist/runtime/reprieve-reader');
const entry = path.resolve(__dirname, '../../dist/runtime/reprieve-entry.js');
const NOW = Date.UTC(2030, 0, 1);
const frame = (fields) =>
  Buffer.concat(
    fields.map((value) =>
      Buffer.concat([Buffer.isBuffer(value) ? value : Buffer.from(value), Buffer.from([0])])
    )
  );
const micros = (year, month, day, hour = 0, minute = 0, second = 0, fraction = 0) =>
  BigInt(Date.UTC(year, month - 1, day, hour, minute, second)) * 1000n + BigInt(fraction);
let root, repo, file;
const record = (extra = {}) => ({
  session_id: 'fixture-session',
  created_at: 'legacy creation text',
  approved_by: 'fixture approver',
  reason: 'fixture reason',
  expires_at: '2099-01-01T00:00:00Z',
  handlers: ['scope-guard.sh'],
  repo_root: repo,
  ...extra,
});
const put = (value = record()) => fs.writeFileSync(file, JSON.stringify(value));
const read = (
  handler = 'scope-guard.sh',
  session = 'fixture-session',
  project = repo,
  now = () => NOW
) => readReprieve(file, handler, session, project, now);
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-reprieve-reader-')));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  file = path.join(root, 'record.json');
  put();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test.each([
  ['2099-01-01', micros(2099, 1, 1)],
  ['20990101T123045Z', micros(2099, 1, 1, 12, 30, 45)],
  ['2099-01-01T12', micros(2099, 1, 1, 12)],
  ['2099-01-01T12.Z', micros(2099, 1, 1, 12)],
  ['2099-01-01T12xZ', micros(2099, 1, 1, 12)],
  ['2099-01-01T12:30\nZ', micros(2099, 1, 1, 12, 30)],
  ['2099-01-01T12:30\0', micros(2099, 1, 1, 12, 30)],
  ['2099-01-01T12.5', micros(2099, 1, 1, 12, 0, 0, 500000)],
  ['2099-01-01T12:30,5', micros(2099, 1, 1, 12, 30, 0, 500000)],
  ['2099-01-01T12:30:45.123456789', micros(2099, 1, 1, 12, 30, 45, 123456)],
  ['2099-W01', micros(2098, 12, 29)],
  ['2099W011T12:00', micros(2098, 12, 29, 12)],
  ['2099-W01-1234', micros(2098, 12, 29, 12, 34)],
  ['2099-01-01💥12:00', micros(2099, 1, 1, 12)],
  ['2099-01-01\n12:00', micros(2099, 1, 1, 12)],
  ['2099-01-01Z', micros(2099, 1, 1)],
  ['2099-01-01T12:00+00:60', micros(2099, 1, 1, 11)],
  ['2099-01-01T12:00+00:00:99', micros(2099, 1, 1, 11, 58, 21)],
  ['2099-01-01T12:00+00:00:01.5', micros(2099, 1, 1, 11, 59, 58, 500000)],
  ['2099-01-01T12:00-00:00:00.5', micros(2099, 1, 1, 12)],
])('consumed expiry spelling %s retains its exact instant', (value, expected) => {
  expect(parseReprieveExpiry(value)).toBe(expected);
  put(record({ expires_at: value }));
  expect(read()).toEqual({ expiresAt: value, reason: 'fixture reason' });
});
test.each([
  null,
  1,
  '',
  '2099',
  '2099-02-29T00:00Z',
  '2100-02-29T00:00Z',
  '2099-04-31T00:00Z',
  '0000-01-01T00:00Z',
  '2099-01-01T24:00Z',
  '2099-01-01T23:60Z',
  '2099-01-01T23:59:60Z',
  '2099-01-01T12:00z',
  '2099-01-01T00:00Z ',
  ' 2099-01-01T00:00Z',
  '2099-01-01T12:00\n',
  '2099-01-01T12:00+00:00\n',
  '2099-01-01T12:00+24',
  '2099-01-01T12:00+23:60',
  '2099-W00-1',
  '2099-W54-1',
  '2099-W01-0',
  '2099-W01-8',
  '2100-W53-1',
  '2099-01-01T1230:45',
  '2099-01-01T12:3045',
  '2099-01-01T12:00.',
])('invalid consumed expiry %p does not skip a guard', (value) => {
  expect(parseReprieveExpiry(value)).toBeUndefined();
  put(record({ expires_at: value }));
  expect(read()).toBeUndefined();
});
test('calendar years below 100 and microseconds use exact integer arithmetic', () => {
  expect(parseReprieveExpiry('0001-01-01')).toBe(-62135596800000000n);
  expect(parseReprieveExpiry('9999-12-31T23:59:59.999999')).toBe(253402300799999999n);
  expect(parseReprieveExpiry('2000-02-29T00:00Z')).toBe(micros(2000, 2, 29));
});
test('millisecond clock precision declines only uncertain expiry rather than skipping late', () => {
  for (const expires_at of ['2030-01-01T00:00:00Z', '2030-01-01T00:00:00.000500Z']) {
    put(record({ expires_at }));
    expect(read()).toBeUndefined();
  }
  for (const expires_at of ['2030-01-01T00:00:00.001000Z', '2030-01-01T00:00:00.001001Z']) {
    put(record({ expires_at }));
    expect(read()).toEqual({ expiresAt: expires_at, reason: 'fixture reason' });
  }
  put();
  expect(read(undefined, undefined, undefined, () => NaN)).toBeUndefined();
});
test.each(['created_at', 'approved_by', 'reason', 'expires_at'])(
  '%s must be a present nonempty string',
  (key) => {
    for (const value of [null, 0, true, [], {}, '']) {
      put(record({ [key]: value }));
      expect(read()).toBeUndefined();
    }
    const missing = record();
    delete missing[key];
    put(missing);
    expect(read()).toBeUndefined();
  }
);
test('created/approver/reason preserve the consumed nonempty rather than trimmed contract', () => {
  put(record({ created_at: ' ', approved_by: '\t', reason: ' ' }));
  expect(read()).toEqual({ expiresAt: '2099-01-01T00:00:00Z', reason: ' ' });
});
test.each([null, false, '', 0, '2030-01-01', {}, []])(
  'revocation key is decisive even when its value is %p',
  (revoked_at) => {
    put(record({ revoked_at }));
    expect(read()).toBeUndefined();
  }
);
test('exact session and handler membership cannot become a shared reprieve', () => {
  expect(read('other.sh')).toBeUndefined();
  expect(read(undefined, 'other-session')).toBeUndefined();
  for (const handlers of [
    null,
    'scope-guard.sh',
    ['scope-guard.sh', null],
    ['scope-guard.sh', 1],
  ]) {
    put(record({ handlers }));
    expect(read()).toBeUndefined();
  }
  put(record({ session_id: 'unknown' }));
  expect(read(undefined, 'unknown')).toBeUndefined();
});
test('missing/null repo root keeps legacy reach; malformed or foreign roots do not', () => {
  const missing = record();
  delete missing.repo_root;
  put(missing);
  expect(read('scope-guard.sh', 'fixture-session', '/foreign')).toEqual({
    expiresAt: '2099-01-01T00:00:00Z',
    reason: 'fixture reason',
  });
  put(record({ repo_root: null }));
  expect(read('scope-guard.sh', 'fixture-session', '/foreign')).toEqual({
    expiresAt: '2099-01-01T00:00:00Z',
    reason: 'fixture reason',
  });
  for (const repo_root of ['', 0, false, [], {}, path.join(root, 'repo-other')]) {
    put(record({ repo_root }));
    expect(read()).toBeUndefined();
  }
});
test('repo reach resolves symlinks, relative paths and missing tails without prefix matching', () => {
  const alias = path.join(root, 'repo-alias');
  fs.symlinkSync(repo, alias);
  put(record({ repo_root: alias }));
  expect(read()).toEqual({ expiresAt: '2099-01-01T00:00:00Z', reason: 'fixture reason' });
  put(record({ repo_root: path.relative(process.cwd(), repo) }));
  expect(read()).toEqual({ expiresAt: '2099-01-01T00:00:00Z', reason: 'fixture reason' });
  put(record({ repo_root: path.join(alias, 'missing/tail') }));
  expect(read(undefined, undefined, path.join(repo, 'missing/tail'))).toEqual({
    expiresAt: '2099-01-01T00:00:00Z',
    reason: 'fixture reason',
  });
  expect(read(undefined, undefined, path.join(repo, 'missing/tail-extra'))).toBeUndefined();
});
test.each([0, 1, 2, 3, 4])('a symlink at checked record depth %i refuses', (depth) => {
  const target = path.join(root, 'target');
  fs.mkdirSync(target);
  if (depth === 0) {
    const linked = path.join(root, 'linked-record');
    fs.symlinkSync(file, linked);
    file = linked;
  } else {
    const suffix = Array.from({ length: depth - 1 }, (_, index) => 'part-' + index);
    const directory = path.join(target, ...suffix);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'record.json'), JSON.stringify(record()));
    const alias = path.join(root, 'linked-parent');
    fs.symlinkSync(target, alias);
    file = path.join(alias, ...suffix, 'record.json');
  }
  expect(read()).toBeUndefined();
});
test('a symlink above four parents retains the existing lookup boundary', () => {
  const target = path.join(root, 'target');
  const suffix = ['one', 'two', 'three', 'four'];
  fs.mkdirSync(path.join(target, ...suffix), { recursive: true });
  fs.writeFileSync(path.join(target, ...suffix, 'record.json'), JSON.stringify(record()));
  const alias = path.join(root, 'higher-link');
  fs.symlinkSync(target, alias);
  file = path.join(alias, ...suffix, 'record.json');
  expect(read()).toEqual({ expiresAt: '2099-01-01T00:00:00Z', reason: 'fixture reason' });
});
test('unreadable/malformed records and invalid UTF8 never produce a match', () => {
  for (const bytes of [
    Buffer.from('{'),
    Buffer.from('[]'),
    Buffer.from('null'),
    Buffer.from([0xff]),
    Buffer.from('\ufeff' + JSON.stringify(record())),
  ]) {
    fs.writeFileSync(file, bytes);
    expect(read()).toBeUndefined();
  }
  put(record({ reason: '\ud800' }));
  expect(read()).toBeUndefined();
  fs.unlinkSync(file);
  expect(read()).toBeUndefined();
  fs.mkdirSync(file);
  expect(read()).toBeUndefined();
});
test('Python nonfinite JSON values stay non-string, never legacy null reach', () => {
  fs.writeFileSync(file, JSON.stringify(record()).replace(/}$/, ',"unused":NaN,"other":Infinity}'));
  expect(read()).toEqual({ expiresAt: '2099-01-01T00:00:00Z', reason: 'fixture reason' });
  fs.writeFileSync(
    file,
    JSON.stringify(record()).replace(/"repo_root":"[^"]*"/, '"repo_root":NaN')
  );
  expect(read()).toBeUndefined();
});
test('read-only consult does not change file bytes or caller environment', () => {
  const before = fs.readFileSync(file),
    environment = { ...process.env };
  expect(read()).toEqual({ expiresAt: '2099-01-01T00:00:00Z', reason: 'fixture reason' });
  expect(fs.readFileSync(file)).toEqual(before);
  expect(process.env).toEqual(environment);
});
test('standalone entry admits only four complete UTF8 stdin fields and exact output', () => {
  const reason = 'original\twhy\ncontinued café';
  put(record({ reason }));
  const fields = [file, 'scope-guard.sh', 'fixture-session', repo];
  const run = (input, args = ['--stdin0'], env = {}) =>
    spawnSync(process.execPath, [entry, ...args], { input, env: { ...process.env, ...env } });
  const result = run(frame(fields));
  expect(result.status).toBe(0);
  expect(result.stderr).toEqual(Buffer.alloc(0));
  expect(result.stdout).toEqual(Buffer.from('ADMIT\t2099-01-01T00:00:00Z\t' + reason + '\n'));
  for (const input of [
    Buffer.alloc(0),
    frame(fields.slice(0, 3)),
    frame(fields).subarray(0, -1),
    frame([...fields, '0']),
    Buffer.concat([frame(fields), Buffer.from('tail')]),
  ]) {
    const invalid = run(input);
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).toEqual(Buffer.alloc(0));
    expect(invalid.stderr).toEqual(Buffer.alloc(0));
  }
  for (const args of [[], fields, ['--stdin0', '--now', '0'], ['--stdin0', '--stdin0']]) {
    const invalid = run(frame(fields), args);
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).toEqual(Buffer.alloc(0));
    expect(invalid.stderr).toEqual(Buffer.alloc(0));
  }
  put(record({ expires_at: '2000-01-01T00:00:00Z' }));
  const expired = run(frame(fields), ['--stdin0'], {
    CAWS_REPRIEVE_NOW: '0',
    CAWS_REPRIEVE_EXPIRES_AT: '2999-01-01',
  });
  expect(expired.status).toBe(1);
  expect(expired.stdout).toEqual(Buffer.alloc(0));
});
test.each([0, 1, 2, 3])(
  'invalid UTF8 in context field %i cannot select a replacement alias',
  (index) => {
    const fields = [file, 'scope-guard.sh', 'fixture-session', repo];
    const validReplacement = '\ufffd\ufffd\ufffd';
    const invalid = Buffer.from([0xff, 0x90, 0xff]);
    if (index === 0) {
      file = path.join(root, validReplacement);
      put();
      fields[0] = file;
    }
    if (index === 1) {
      put(record({ handlers: [validReplacement] }));
      fields[1] = validReplacement;
    }
    if (index === 2) {
      put(record({ session_id: validReplacement }));
      fields[2] = validReplacement;
    }
    if (index === 3) {
      const target = path.join(root, validReplacement);
      fs.mkdirSync(target);
      put(record({ repo_root: target }));
      fields[3] = target;
    }
    const good = spawnSync(process.execPath, [entry, '--stdin0'], { input: frame(fields) });
    expect(good.status).toBe(0);
    const bad = [...fields];
    bad[index] =
      index === 0 || index === 3 ? Buffer.concat([Buffer.from(root + '/'), invalid]) : invalid;
    const denied = spawnSync(process.execPath, [entry, '--stdin0'], { input: frame(bad) });
    expect(denied.status).toBe(1);
    expect(denied.stdout).toEqual(Buffer.alloc(0));
    expect(denied.stderr).toEqual(Buffer.alloc(0));
  }
);

test('surrogateescape output keeps raw low bytes while unencodable output cannot admit', () => {
  for (const [reason, byte] of [
    ['\udc80', 0x80],
    ['\udcff', 0xff],
  ]) {
    put(record({ reason }));
    const match = read();
    expect(match).toEqual({ expiresAt: '2099-01-01T00:00:00Z', reason });
    const expected = Buffer.concat([
      Buffer.from('ADMIT\t2099-01-01T00:00:00Z\t'),
      Buffer.from([byte, 10]),
    ]);
    expect(serializeReprieveMatch(match)).toEqual(expected);
    const result = spawnSync(process.execPath, [entry, '--stdin0'], {
      input: frame([file, 'scope-guard.sh', 'fixture-session', repo]),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toEqual(expected);
    expect(result.stderr).toEqual(Buffer.alloc(0));
  }
  for (const reason of ['\ud800', '\udc00', '\udfff']) {
    put(record({ reason }));
    expect(read()).toBeUndefined();
  }
  const expires_at = '2099-01-01\udc8012:00';
  put(record({ expires_at }));
  expect(parseReprieveExpiry(expires_at)).toBe(micros(2099, 1, 1, 12));
  expect(read()).toEqual({ expiresAt: expires_at, reason: 'fixture reason' });
});
test('unpaired surrogate path strings cannot select replacement-character aliases', () => {
  const replacement = path.join(root, '\ufffd');
  fs.mkdirSync(replacement);
  put(record({ repo_root: path.join(root, '\udc80') }));
  expect(read(undefined, undefined, replacement)).toBeUndefined();
  put(record({ repo_root: replacement }));
  expect(read(undefined, undefined, path.join(root, '\udc80'))).toBeUndefined();
  const original = file;
  file = path.join(root, '\ufffd-record');
  put();
  file = path.join(root, '\udc80-record');
  expect(read()).toBeUndefined();
  file = original;
});
test('invalid symlink-target bytes cannot become a UTF8 replacement scope alias', () => {
  const replacement = path.join(root, '\ufffd');
  fs.mkdirSync(replacement);
  const link = path.join(root, 'raw-link');
  fs.symlinkSync(Buffer.from([0xff]), link);
  put(record({ repo_root: link }));
  expect(read(undefined, undefined, replacement)).toBeUndefined();
});
test('invalid physical cwd bytes cannot become a relative scope alias', () => {
  const raw = Buffer.concat([Buffer.from(root + '/'), Buffer.from([0xff])]);
  const replacement = path.join(root, '\ufffd');
  fs.mkdirSync(replacement);
  const physicalCwd = jest.spyOn(fs.realpathSync, 'native').mockReturnValue(raw);
  try {
    put(record({ repo_root: '.' }));
    expect(read(undefined, undefined, replacement)).toBeUndefined();
    put(record({ repo_root: repo }));
    expect(read()).toEqual({ expiresAt: '2099-01-01T00:00:00Z', reason: 'fixture reason' });
  } finally {
    physicalCwd.mockRestore();
  }
});
