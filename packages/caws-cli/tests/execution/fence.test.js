const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnCoveredSync } = require('./child-coverage.cjs');
const { verifyInheritedFence } = require('../../dist/execution/fence');
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function holder() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-fence-'));
  roots.push(root);
  const caws = path.join(root, '.caws');
  fs.mkdirSync(caws);
  const file = path.join(caws, 'state.lock');
  const fd = fs.openSync(file, 'wx+', 0o600);
  const value = {
    pid: process.ppid,
    at: '2026-10-26T00:00:00.000Z',
    purpose: 'execution-launch',
    nonce: 'nonce-1',
    protocol: 'caws.execution.fence.v1',
  };
  fs.writeFileSync(fd, JSON.stringify(value));
  fs.fsyncSync(fd);
  const stat = fs.fstatSync(fd, { bigint: true });
  return {
    root,
    caws,
    file,
    fd,
    value,
    expected: { dev: stat.dev.toString(), ino: stat.ino.toString(), nonce: value.nonce },
  };
}
function write(h, value) {
  fs.ftruncateSync(h.fd, 0);
  fs.writeSync(h.fd, typeof value === 'string' ? value : JSON.stringify(value), 0, 'utf8');
}

describe('inherited canonical execution fence', () => {
  test('validates inherited fd3 in a real child without consuming its shared offset, releasing or unlinking it', () => {
    const h = holder();
    try {
      write(h, { ...h.value, pid: process.pid });
      fs.readFileSync(h.fd);
      const child = spawnCoveredSync(
        process.execPath,
        [
          '-e',
          'const fs=require("node:fs");const {verifyInheritedFence}=require(process.argv[1]);const valid=verifyInheritedFence(process.argv[2],JSON.parse(process.argv[3]));const atEnd=fs.readSync(3,Buffer.alloc(1),0,1,null);process.stdout.write(JSON.stringify({valid,atEnd}));',
          path.resolve(__dirname, '../../dist/execution/fence.js'),
          h.caws,
          JSON.stringify(h.expected),
        ],
        { stdio: ['ignore', 'pipe', 'pipe', h.fd], timeout: 1500 }
      );
      expect(child.status).toBe(0);
      expect(child.stderr.toString()).toBe('');
      expect(JSON.parse(child.stdout.toString())).toEqual({ valid: true, atEnd: 0 });
      expect(fs.existsSync(h.file)).toBe(true);
      expect(fs.fstatSync(h.fd, { bigint: true }).ino.toString()).toBe(h.expected.ino);
    } finally {
      fs.closeSync(h.fd);
    }
  });

  test('validates physical file identity and exact nonce while retaining the owner handle', () => {
    const h = holder();
    try {
      expect(verifyInheritedFence(h.caws, h.expected, h.fd)).toBe(true);
      for (const changed of [
        { ...h.expected, dev: '0' },
        { ...h.expected, ino: '0' },
        { ...h.expected, nonce: 'wrong' },
      ])
        expect(verifyInheritedFence(h.caws, changed, h.fd)).toBe(false);
      fs.renameSync(h.file, h.file + '.owned');
      fs.writeFileSync(h.file, JSON.stringify(h.value));
      expect(verifyInheritedFence(h.caws, h.expected, h.fd)).toBe(false);
      fs.unlinkSync(h.file);
      fs.symlinkSync(h.file + '.owned', h.file);
      expect(verifyInheritedFence(h.caws, h.expected, h.fd)).toBe(false);
    } finally {
      fs.closeSync(h.fd);
    }
  });

  test('rejects each missing/extra member and unsupported parent, purpose, protocol or timestamp', () => {
    const h = holder();
    try {
      for (const key of Object.keys(h.value)) {
        const value = { ...h.value };
        delete value[key];
        write(h, value);
        expect(verifyInheritedFence(h.caws, h.expected, h.fd)).toBe(false);
      }
      for (const value of [
        { ...h.value, extra: 1 },
        Object.values(h.value),
        null,
        { ...h.value, pid: process.pid },
        { ...h.value, pid: 0 },
        { ...h.value, purpose: 'lifecycle-mutation' },
        { ...h.value, protocol: 'v2' },
        { ...h.value, at: 'not a date' },
        { ...h.value, at: '2026-99-99T00:00:00.000Z' },
        { ...h.value, at: 42 },
      ]) {
        write(h, value);
        expect(verifyInheritedFence(h.caws, h.expected, h.fd)).toBe(false);
      }
    } finally {
      fs.closeSync(h.fd);
    }
  });

  test('rejects malformed, duplicate, empty, oversized and hardlinked metadata or unavailable descriptor', () => {
    const h = holder();
    try {
      for (const text of [
        '',
        'invalid',
        JSON.stringify(h.value).replace('"pid":', '"pid":1,"pid":'),
        'x'.repeat(4097),
      ]) {
        write(h, text);
        expect(verifyInheritedFence(h.caws, h.expected, h.fd)).toBe(false);
      }
      write(h, h.value);
      fs.linkSync(h.file, h.file + '.alias');
      expect(verifyInheritedFence(h.caws, h.expected, h.fd)).toBe(false);
      fs.unlinkSync(h.file + '.alias');
      expect(verifyInheritedFence(h.caws, h.expected, h.fd)).toBe(true);
    } finally {
      fs.closeSync(h.fd);
    }
    expect(verifyInheritedFence(h.caws, h.expected, h.fd)).toBe(false);
  });

  test('rejects changed metadata after reading before returning validation', () => {
    const h = holder();
    try {
      const read = fs.readSync;
      const spy = jest.spyOn(fs, 'readSync').mockImplementationOnce((...args) => {
        const result = read(...args);
        fs.appendFileSync(h.file, ' ');
        return result;
      });
      expect(verifyInheritedFence(h.caws, h.expected, h.fd)).toBe(false);
      spy.mockRestore();
      expect(fs.readFileSync(h.file, 'utf8')).toBe(JSON.stringify(h.value) + ' ');
    } finally {
      fs.closeSync(h.fd);
    }
  });
});
