'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const { PassThrough } = require('node:stream');
const helper = path.resolve(__dirname, '../../scripts/observe-codex-mcp.cjs');
const source = fs.readFileSync(helper, 'utf8');
const roots = [];
const initialize = { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} };
const call = (args = {}) => ({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'caws_observe_host_call', arguments: args },
});
const frame = (value) => Buffer.from(JSON.stringify(value) + '\n');
const input = (...values) => Buffer.concat(values.map(frame));
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-mcp-observe-')));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  const file = path.join(root, 'journal.jsonl');
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { mode: 0o700 });
  fs.writeFileSync(path.join(project, 'original'), 'unchanged', { mode: 0o600 });
  return { root, file, project };
}
function records(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}
function run(bytes, f = fixture()) {
  const result = spawnSync(process.execPath, [helper, f.file], {
    cwd: f.project,
    env: { PATH: path.dirname(process.execPath), HOME: f.root },
    input: bytes,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return {
    ...result,
    f,
    journal: records(f.file),
    responses: result.stdout.toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse),
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('real process records original request and actual process/descriptor facts without executing metadata', () => {
  const f = fixture();
  const sentinel = path.join(f.project, 'must-not-exist');
  const observation = call();
  observation._meta = { private: 'private-host-value', command: 'touch ' + sentinel };
  const raw = Buffer.from(
    '  ' + JSON.stringify(observation).replace('"id":3', '"id":2,"id":3') + '\r\n'
  );
  const r = run(Buffer.concat([frame(initialize), raw]), f);
  expect(r.status).toBe(0);
  expect(r.responses.map((message) => message.id)).toEqual([0, 3]);
  expect(r.responses[0].result.capabilities.experimental).toEqual({
    'codex/caller-context': { version: 1 },
    'codex/sandbox-state': {},
  });
  expect(JSON.parse(r.responses[1].result.content[0].text)).toEqual({
    observationOnly: true,
    userSourceExecuted: false,
    authorityGranted: false,
  });
  expect(r.stdout.toString()).not.toContain('private-host-value');
  expect(r.stderr.length).toBe(0);
  expect(
    Buffer.from(r.journal.filter((row) => row.kind === 'received')[1].rawBase64, 'base64')
  ).toEqual(raw);
  const started = r.journal.find((row) => row.kind === 'started');
  const observed = r.journal.find((row) => row.kind === 'call-observed');
  expect(started.pid).toBe(r.pid);
  expect(started.ppid).toBe(process.pid);
  expect(started.cwd).toBe(f.project);
  expect(started.executable).toBe(process.execPath);
  expect(started.nodeVersion).toBe(process.version);
  expect(observed.pid).toBe(started.pid);
  const identity = ({ fd, kind, dev, ino }) => ({ fd, kind, dev, ino });
  expect(observed.descriptors.map(identity)).toEqual(started.descriptors.map(identity));
  expect(observed.descriptors.map((d) => d.fd)).toEqual([0, 1]);
  for (const descriptor of observed.descriptors) {
    expect(['socket', 'fifo', 'file', 'character-device', 'other']).toContain(descriptor.kind);
    expect(descriptor.dev).toMatch(/^-?\d+$/);
    expect(descriptor.ino).toMatch(/^\d+$/);
    expect(descriptor.mode).toMatch(/^\d+$/);
  }
  expect(r.journal.at(-1)).toMatchObject({ kind: 'terminal', code: 0 });
  expect(fs.statSync(f.file).mode & 0o777).toBe(0o600);
  expect(fs.existsSync(sentinel)).toBe(false);
  expect(fs.readFileSync(path.join(f.project, 'original'), 'utf8')).toBe('unchanged');
});

test.each([null, [], '', { x: true }, undefined])(
  'rejects nonempty or absent tool arguments: %p',
  (args) => {
    const request = call(args);
    if (args === undefined) delete request.params.arguments;
    const r = run(input(initialize, request));
    expect(r.status).toBe(2);
    expect(r.responses.map((message) => message.id)).toEqual([0]);
    expect(r.journal.some((row) => row.kind === 'call-observed')).toBe(false);
  }
);

test.each([
  ['wrong tool', { ...call(), params: { name: 'other', arguments: {} } }],
  ['missing request id', { ...call(), id: undefined }],
  ['wrong protocol', { ...call(), jsonrpc: 'other' }],
])('rejects %s', (_name, request) => {
  const r = run(input(initialize, request));
  expect(r.status).toBe(2);
  expect(r.responses.map((message) => message.id)).toEqual([0]);
});

test('second call fails after exactly one inert acknowledgement', () => {
  const r = run(input(initialize, call(), { ...call(), id: 4 }));
  expect(r.status).toBe(2);
  expect(r.responses.map((message) => message.id)).toEqual([0, 3]);
  expect(r.journal.filter((row) => row.kind === 'call-observed')).toHaveLength(1);
});

test.each([Buffer.from('{bad json}\n'), Buffer.from([0xff, 10])])(
  'retains malformed original bytes before refusal',
  (raw) => {
    const r = run(Buffer.concat([frame(initialize), raw]));
    expect(r.status).toBe(2);
    expect(
      Buffer.from(r.journal.filter((row) => row.kind === 'received')[1].rawBase64, 'base64')
    ).toEqual(raw);
    expect(r.responses.map((message) => message.id)).toEqual([0]);
  }
);

test('retains incomplete EOF and refuses even after a valid observation', () => {
  const partial = Buffer.from('{"unfinished":');
  const r = run(Buffer.concat([input(initialize, call()), partial]));
  expect(r.status).toBe(2);
  expect(Buffer.from(r.journal.find((row) => row.kind === 'partial').rawBase64, 'base64')).toEqual(
    partial
  );
});

test.each([true, false])('refuses a bounded oversized frame; newline=%s', (newline) => {
  const oversized = Buffer.from(' '.repeat(1024 * 1024 + 1) + (newline ? '\n' : ''));
  const r = run(Buffer.concat([frame(initialize), oversized]));
  expect(r.status).toBe(2);
  expect(r.responses.map((message) => message.id)).toEqual([0]);
  const evidence = r.journal.find((row) => row.kind === 'oversized');
  expect(Buffer.from(evidence.rawPrefixBase64, 'base64').length).toBe(1024 * 1024);
  expect(fs.statSync(r.f.file).size).toBeLessThan(8 * 1024 * 1024);
});

test.each(['existing', 'symlink'])('refuses %s journal without changing original bytes', (kind) => {
  const f = fixture();
  const original = path.join(f.root, 'original-journal');
  fs.writeFileSync(original, 'do not replace', { mode: 0o600 });
  if (kind === 'symlink') fs.symlinkSync(original, f.file);
  else fs.copyFileSync(original, f.file);
  const result = spawnSync(process.execPath, [helper, f.file], {
    input: input(initialize, call()),
  });
  expect(result.status).not.toBe(0);
  expect(result.stdout.length).toBe(0);
  expect(fs.readFileSync(original, 'utf8')).toBe('do not replace');
  expect(fs.readFileSync(f.file, 'utf8')).toBe('do not replace');
});

function isolated(f, injected = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let written = '';
  stdout.on('data', (data) => {
    written += data;
  });
  const processView = {
    argv: [process.execPath, helper, f.file],
    pid: process.pid,
    ppid: process.ppid,
    version: process.version,
    execPath: process.execPath,
    getuid: () => process.getuid(),
    cwd: () => f.project,
    stdin,
    stdout,
    exitCode: undefined,
    once: () => {},
  };
  const modules = {
    'node:fs': { ...fs, ...injected },
    'node:path': path,
    'node:util': require('node:util'),
    'node:timers': { setTimeout: () => 1, clearTimeout: () => {} },
  };
  vm.runInNewContext(
    source,
    {
      require(name) {
        if (!Object.hasOwn(modules, name)) throw Error('Forbidden dependency: ' + name);
        return modules[name];
      },
      process: processView,
      Buffer,
      setTimeout: () => 1,
      clearTimeout: () => {},
    },
    { filename: helper }
  );
  return { stdin, processView, output: () => written };
}

test('coalesced individually bounded frames and fragmented frames have identical semantics', () => {
  const padding = ' '.repeat(600000);
  const frames = [
    frame(initialize),
    Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', padding }) + '\n'),
    Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping', padding }) + '\n'),
    frame(call()),
  ];
  const a = isolated(fixture());
  a.stdin.emit('data', Buffer.concat(frames));
  a.stdin.emit('end');
  const b = isolated(fixture());
  const combined = Buffer.concat(frames);
  for (let offset = 0; offset < combined.length; offset += 37001)
    b.stdin.emit('data', combined.subarray(offset, offset + 37001));
  b.stdin.emit('end');
  expect(a.processView.exitCode).toBe(0);
  expect(b.processView.exitCode).toBe(0);
  expect(a.output()).toBe(b.output());
  expect(
    a
      .output()
      .trim()
      .split('\n')
      .map(JSON.parse)
      .map((row) => row.id)
  ).toEqual([0, 1, 2, 3]);
});

test.each(['writeSync', 'fsyncSync'])(
  'journal %s failure prevents corresponding acknowledgement',
  (method) => {
    const f = fixture();
    let calls = 0;
    const engine = isolated(f, {
      [method](...args) {
        if (++calls === 2) throw Error('injected journal failure');
        return fs[method](...args);
      },
    });
    engine.stdin.emit('data', input(initialize, call()));
    expect(engine.processView.exitCode).toBe(2);
    expect(engine.output()).toBe('');
  }
);

test('journal exhaustion refuses before an observation acknowledgement', () => {
  const f = fixture();
  const engine = isolated(f);
  engine.stdin.emit('data', frame(initialize));
  const ping = frame({ jsonrpc: '2.0', id: 1, method: 'ping', padding: 'x'.repeat(900000) });
  for (let n = 0; n < 8 && engine.processView.exitCode === undefined; n++)
    engine.stdin.emit('data', ping);
  expect(engine.processView.exitCode).toBe(2);
  expect(fs.statSync(f.file).size).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(engine.output()).not.toContain('observationOnly');
});
