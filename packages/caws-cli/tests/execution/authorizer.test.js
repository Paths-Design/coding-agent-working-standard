const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { spawnCoveredSync } = require('./child-coverage.cjs');
const { authorityFixture, cleanupAll, source, hash } = require('./authority-fixture');
afterAll(cleanupAll);
// Native ESM import is unavailable in Jest's VM. Exercise the actual private
// child entry with inert framed source, including the active mutant explicitly.
function evaluatePreparedExecution(record, envelope) {
  const body = Buffer.from(JSON.stringify(envelope));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  const active = String(
    globalThis.__stryker__?.activeMutant ?? process.env.__STRYKER_ACTIVE_MUTANT__ ?? ''
  );
  const child = spawnCoveredSync(
    process.execPath,
    [path.resolve(__dirname, '../../dist/execution/authorizer-main.js')],
    {
      input: Buffer.concat([header, body]),
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', __STRYKER_ACTIVE_MUTANT__: active },
      timeout: 5000,
      maxBuffer: 1048576,
    }
  );
  expect(child.status).toBe(0);
  expect(child.stderr.toString()).toBe('');
  expect(child.stdout.readUInt32BE()).toBe(child.stdout.length - 4);
  const observation = JSON.parse(child.stdout.subarray(4).toString());
  expect(observation.invocationId).toBe(record.invocationId);
  expect(observation.executionDigest).toBe(envelope.executionDigest);
  return observation;
}
function request(record, revision = null, fence = null) {
  const bytes = Buffer.from(JSON.stringify(record));
  return {
    protocol: 'caws.execution.authorizer.v1',
    phase: revision === null ? 'analyze' : 'final_validate',
    invocationId: record.invocationId,
    recordBase64: bytes.toString('base64'),
    executionDigest: hash(bytes),
    expectedAuthorityRevision: revision,
    fence,
  };
}
async function observe(f, command, utilities = []) {
  const record = source(f, command, utilities);
  return evaluatePreparedExecution(record, request(record));
}
describe('private authorizer component observations, without USER execution', () => {
  test('rejects reader aliases to writers or shells while accepting an alias to the actual reader', async () => {
    const f = authorityFixture();
    const directory = path.join(f.root, 'utility-path');
    fs.mkdirSync(directory);
    const alias = path.join(directory, 'cat');
    f.record.execution.environment.find((entry) => entry.name === 'PATH').value =
      `${directory}:${f.record.execution.environment.find((entry) => entry.name === 'PATH').value}`;
    const target = path.join(f.root, 'must-remain-absent');
    for (const image of ['/usr/bin/touch', '/bin/bash']) {
      fs.symlinkSync(fs.realpathSync.native(image), alias);
      const observation = await observe(f, `cat ${JSON.stringify(target)}`, [image]);
      expect(observation.decision).toBe('unresolved');
      expect(observation.reasonCodes).toEqual(['unsupported_profile']);
      expect(fs.existsSync(target)).toBe(false);
      fs.unlinkSync(alias);
    }
    fs.symlinkSync(fs.realpathSync.native('/bin/cat'), alias);
    const benign = await observe(f, 'cat src/data.txt', ['/bin/cat']);
    expect(benign.decision).toBe('allow');
    expect(benign.reasonCodes).toEqual([]);
  });
  test('allows benign computed sed data and owned finite redirection without executing either', async () => {
    const f = authorityFixture();
    fs.writeFileSync(path.join(f.lane, 'notes\nfile.txt'), 'line one\n');
    const result = await observe(
      f,
      'file="notes\nfile.txt"; sed -n 1p -- "$file" > src/result.txt',
      ['/usr/bin/sed']
    );
    expect(result.decision).toBe('allow');
    expect(result.reasonCodes).toEqual([]);
    expect(fs.existsSync(path.join(f.lane, 'src/result.txt'))).toBe(false);
    expect(result.authorityRevision).toMatch(/^[a-f0-9]{64}$/);
  });
  test('allows harmless JavaScript braces and finite owned fs writes on the pinned actual Node image', async () => {
    const f = authorityFixture();
    f.record.execution.environment.find((entry) => entry.name === 'PATH').value =
      `${fs.realpathSync.native(path.dirname(process.execPath))}:${f.record.execution.environment.find((entry) => entry.name === 'PATH').value}`;
    const read = await observe(f, 'node -e \'console.log({kind:"data", values:[1,2]})\'', [
      process.execPath,
    ]);
    expect(read.decision).toBe('allow');
    const write = await observe(
      f,
      'node -e \'require("node:fs").writeFileSync("src/owned.txt","ok")\'',
      [process.execPath]
    );
    expect(write.decision).toBe('allow');
    expect(fs.existsSync(path.join(f.lane, 'src/owned.txt'))).toBe(false);
  });
  test.each([
    ['foreign write', 'printf ok > ../canonical.txt', [], 'deny', 'scope_refused'],
    ['out of scope', 'printf ok > outside.txt', [], 'deny', 'scope_refused'],
    ['authority write', 'printf ok > .caws/state.lock', [], 'deny', 'scope_refused'],
    ['unknown executable', 'npm run build', [], 'unresolved', 'unsupported_profile'],
    ['implicit temp writer', 'sort notes.txt', [], 'unresolved', 'unsupported_profile'],
    ['dynamic executable', '"$unknown" arg', [], 'unresolved', 'source_unresolved'],
    [
      'executable sed',
      'sed -n "1e touch sentinel" notes.txt',
      ['/usr/bin/sed'],
      'deny',
      'source_denied',
    ],
    ['private descriptor', 'printf data >&3', [], 'unresolved', 'unsupported_profile'],
    ['opened private descriptor', '3>src/opened.txt', [], 'unresolved', 'unsupported_profile'],
  ])(
    'holds %s with zero submitted effects',
    async (_name, command, utilities, decision, reason) => {
      const f = authorityFixture();
      const result = await observe(f, command, utilities);
      expect(result.decision).toBe(decision);
      expect(result.reasonCodes).toEqual([reason]);
      expect(fs.existsSync(path.join(f.lane, 'sentinel'))).toBe(false);
    }
  );
  test('denies known sed execution and foreign Node writes after valid image preparation', async () => {
    const f = authorityFixture();
    fs.writeFileSync(path.join(f.lane, 'notes.txt'), 'data');
    expect(
      (await observe(f, 'sed -n "1e touch sentinel" notes.txt', ['/usr/bin/sed'])).reasonCodes
    ).toEqual(['source_denied']);
    f.record.execution.environment.find((entry) => entry.name === 'PATH').value =
      `${fs.realpathSync.native(path.dirname(process.execPath))}:${f.record.execution.environment.find((entry) => entry.name === 'PATH').value}`;
    expect(
      (
        await observe(f, 'node -e \'require("node:fs").writeFileSync("../foreign.txt","no")\'', [
          process.execPath,
        ])
      ).reasonCodes
    ).toEqual(['scope_refused']);
    expect(fs.existsSync(path.join(f.root, 'foreign.txt'))).toBe(false);
  });
  test('refuses symlink/hardlink targets, startup overrides, stale images, extra manifest and expired preparation', async () => {
    const f = authorityFixture();
    const foreign = path.join(f.root, 'foreign');
    fs.writeFileSync(foreign, 'keep');
    fs.symlinkSync(foreign, path.join(f.lane, 'src/link'));
    fs.linkSync(foreign, path.join(f.lane, 'src/hard'));
    for (const name of ['link', 'hard'])
      expect((await observe(f, `printf no > src/${name}`)).reasonCodes).toEqual(['scope_refused']);
    expect(fs.readFileSync(foreign, 'utf8')).toBe('keep');
    f.record.execution.environment.unshift({ name: 'BASH_ENV', value: '/untrusted' });
    expect((await observe(f, 'printf ok')).reasonCodes).toEqual(['unsupported_profile']);
    f.record.execution.environment.shift();
    source(f, 'printf ok');
    f.record.execution.executable.sha256 = '0'.repeat(64);
    expect((await evaluatePreparedExecution(f.record, request(f.record))).reasonCodes).toEqual([
      'unsupported_profile',
    ]);
    const fresh = authorityFixture();
    source(fresh, 'printf ok', ['/usr/bin/sed']);
    expect(
      (await evaluatePreparedExecution(fresh.record, request(fresh.record))).reasonCodes
    ).toEqual(['unsupported_profile']);
    fresh.record.limits.preparationDeadlineUnixMs = Date.now() - 1;
    expect(
      (await evaluatePreparedExecution(fresh.record, request(fresh.record))).reasonCodes
    ).toEqual(['deadline_expired']);
  });
  test('does not trust Bash startup or special-variable values as ordinary inherited scalars', async () => {
    const f = authorityFixture();
    const actual = execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', 'printf %s "$PWD"'], {
      cwd: f.lane,
      env: { PATH: '/usr/bin:/bin', PWD: path.join(f.lane, 'src') },
    }).toString();
    expect(actual).toBe(f.lane);
    f.record.execution.environment.push({ name: 'PWD', value: path.join(f.lane, 'src') });
    expect((await observe(f, 'printf data > "$PWD/escaped.txt"')).reasonCodes).toEqual([
      'unsupported_profile',
    ]);
    f.record.execution.environment.pop();
    expect((await observe(f, 'printf data > "$PWD/src/owned.txt"')).decision).toBe('allow');
    for (const command of [
      'UID=src; printf x > "$UID/escaped.txt"',
      'for SHLVL in src; do printf x; done',
      'read OLDPWD; printf x',
    ])
      expect((await observe(f, command)).reasonCodes).toEqual(['unsupported_profile']);
    expect(fs.existsSync(path.join(f.lane, 'escaped.txt'))).toBe(false);
  });
  test('private child checks final fence, changed authority and complete framing; never launches USER', async () => {
    const f = authorityFixture();
    source(f, 'printf ok > src/must-not-execute.txt');
    const initial = await evaluatePreparedExecution(f.record, request(f.record));
    expect(initial.decision).toBe('allow');
    const lockPath = path.join(f.caws, 'state.lock');
    const fd = fs.openSync(lockPath, 'wx+', 0o600);
    const metadata = {
      pid: process.pid,
      at: new Date().toISOString(),
      purpose: 'execution-launch',
      nonce: 'owned-nonce',
      protocol: 'caws.execution.fence.v1',
    };
    fs.writeFileSync(fd, JSON.stringify(metadata));
    fs.fsyncSync(fd);
    const stat = fs.fstatSync(fd, { bigint: true });
    const fence = { dev: stat.dev.toString(), ino: stat.ino.toString(), nonce: metadata.nonce };
    const run = (input, suffix = Buffer.alloc(0)) => {
      const body = Buffer.from(JSON.stringify(input));
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      return spawnCoveredSync(
        process.execPath,
        [path.resolve(__dirname, '../../dist/execution/authorizer-main.js')],
        {
          input: Buffer.concat([header, body, suffix]),
          stdio: ['pipe', 'pipe', 'pipe', fd],
          env: {
            PATH: f.record.execution.environment.find((entry) => entry.name === 'PATH').value,
            LC_ALL: 'C',
            __STRYKER_ACTIVE_MUTANT__: String(
              globalThis.__stryker__?.activeMutant ?? process.env.__STRYKER_ACTIVE_MUTANT__ ?? ''
            ),
          },
          timeout: 5000,
          maxBuffer: 1048576,
        }
      );
    };
    const observation = (child) => {
      expect(child.status).toBe(0);
      expect(child.stderr.toString()).toBe('');
      expect(child.stdout.readUInt32BE()).toBe(child.stdout.length - 4);
      return JSON.parse(child.stdout.subarray(4).toString());
    };
    try {
      const final = request(f.record, initial.authorityRevision, fence);
      expect(observation(run(final)).decision).toBe('allow');
      fs.appendFileSync(path.join(f.caws, 'policy.yaml'), '\n# revocation checkpoint\n');
      expect(observation(run(final)).reasonCodes).toEqual(['authority_changed']);
      expect(
        observation(run({ ...final, fence: { ...fence, nonce: 'wrong' } })).reasonCodes
      ).toEqual(['fence_unverified']);
      const trailing = run(final, Buffer.from('x'));
      expect(trailing.status).toBe(2);
      expect(trailing.stdout.length).toBe(0);
      expect(trailing.stderr.toString()).toBe(
        'Execution authorizer input or infrastructure failure\n'
      );
      expect(fs.existsSync(path.join(f.lane, 'src/must-not-execute.txt'))).toBe(false);
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(fs.fstatSync(fd, { bigint: true }).ino).toBe(stat.ino);
    } finally {
      fs.closeSync(fd);
    }
  });
});
