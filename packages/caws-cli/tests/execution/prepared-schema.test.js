const { createHash } = require('node:crypto');
const {
  decodePreparedExecution,
  InvalidPreparedRecord,
  MAX_PREPARED_RECORD_BYTES,
} = require('../../dist/execution/prepared-schema');

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const image = (path) => ({ path, sha256: 'a'.repeat(64) });
function fixture() {
  const source = 'f="notes\nwith spaces.txt"; sed -n 1p -- "$f"';
  const state = Buffer.from('{"sandboxCwd":"/server","future":{"opaque":9007199254740993}}');
  return {
    schema: 'caws.execution.prepared.v1',
    invocationId: 'invocation-1',
    association: {
      kind: 'codex-mcp-v1',
      sessionId: 'root-lineage',
      threadId: 'actual-child',
      callId: 'native-call',
      callerAnchor: '/project/owned\nlane',
      serverEnvironmentId: 'server-A',
    },
    projectRoot: '/project',
    execution: {
      executable: image('/bin/bash'),
      argv: ['/bin/bash', '--noprofile', '--norc', '-c', source],
      cwd: '/project/owned\nlane',
      environment: [
        { name: 'HOME', value: '/home' },
        { name: 'PATH', value: '/usr/bin:/bin' },
      ],
      stdinBase64: Buffer.from('input\0\xff').toString('base64'),
    },
    profile: { kind: 'bash-clean-v1', source, utilities: [image('/usr/bin/sed')] },
    sandbox: {
      stateBase64: state.toString('base64'),
      stateSha256: digest(state),
      launcher: image('/trusted/codex'),
      environmentAnchor: '/server',
    },
    limits: {
      preparationDeadlineUnixMs: 1793056186000,
      jobTimeoutMs: 60000,
      terminationGraceMs: 1000,
      maxOutputBytes: 1048576,
    },
  };
}
function npmFixture() {
  const input = fixture();
  const node = image('/generation/node');
  const entry = image('/generation/npm/bin/npm-cli.js');
  input.execution.executable = node;
  input.execution.argv = [
    node.path,
    entry.path,
    '--prefix',
    input.execution.cwd,
    '--workspaces=false',
    'test',
  ];
  input.execution.stdinBase64 = '';
  input.profile = {
    kind: 'npm-test-v1',
    source: 'npm test',
    utilities: [],
    npm: {
      runtime: {
        node,
        entry,
        root: '/generation/npm',
        generationManifestSha256: 'b'.repeat(64),
      },
      project: {
        packageJson: image('/project/package.json'),
        npmrc: null,
        testScript: 'node tests/run.js',
        pathShadowSha256: 'c'.repeat(64),
      },
    },
  };
  input.sandbox.writeCeiling = {
    schema: 'caws.execution.write-ceiling.v1',
    launchId: 'd'.repeat(64),
    invocationRoot: '/private/run',
    outputRoot: '/private/run/output',
    tmpRoot: '/private/run/tmp',
    cacheRoot: '/private/run/cache',
    manifestSha256: 'e'.repeat(64),
  };
  return input;
}
const encode = (value) => Buffer.from(JSON.stringify(value));
const decode = (value) => decodePreparedExecution(encode(value));
function at(value, path) {
  return path.reduce((row, key) => row[key], value);
}
function replace(value, path, replacement) {
  const row = at(value, path.slice(0, -1));
  row[path.at(-1)] = replacement;
}
function reject(value) {
  expect(() => decode(value)).toThrow(new InvalidPreparedRecord());
}

describe('private prepared execution record', () => {
  test('retains one exact npm test route with pinned runtime, project and host ceiling', () => {
    const input = npmFixture();
    const result = decode(input);
    expect(result).toEqual(input);
    expect(Object.isFrozen(result.profile.npm.project)).toBe(true);
    expect(Object.isFrozen(result.sandbox.writeCeiling)).toBe(true);
  });

  test('refuses npm argv, image, project or ceiling substitutions before authorization', () => {
    const mutations = [
      (r) => {
        r.profile.source = 'npm test -- --watch';
      },
      (r) => {
        r.execution.argv[2] = 'install';
      },
      (r) => {
        r.execution.argv[1] = '/other/npm-cli.js';
      },
      (r) => {
        r.execution.executable = { ...r.execution.executable, sha256: 'f'.repeat(64) };
      },
      (r) => {
        r.profile.npm.runtime.entry.path = '/generation/npm/other.js';
      },
      (r) => {
        r.profile.npm.project.packageJson.sha256 = 'not-a-digest';
      },
      (r) => {
        r.profile.npm.project.npmrc = {};
      },
      (r) => {
        r.profile.npm.project.testScript = '';
      },
      (r) => {
        r.profile.utilities = [image('/usr/bin/true')];
      },
      (r) => {
        r.execution.stdinBase64 = 'YQ==';
      },
      (r) => {
        delete r.sandbox.writeCeiling;
      },
      (r) => {
        r.sandbox.writeCeiling.tmpRoot = '/project/tmp';
      },
      (r) => {
        r.sandbox.writeCeiling.manifestSha256 = '0';
      },
    ];
    for (const mutate of mutations) {
      const input = npmFixture();
      mutate(input);
      reject(input);
    }
    const missing = npmFixture();
    delete missing.profile.npm.project.npmrc;
    reject(missing);
    const extra = npmFixture();
    extra.profile.npm.project.pretest = 'node alter.js';
    reject(extra);
  });
  test('retains the dedicated consumer kind and direct argv without replacing original source', () => {
    const input = fixture();
    input.profile.kind = 'caws-evidence-v1';
    input.profile.source =
      "'/trusted/node' '/trusted/writer-main.js' specs evidence EXAMPLE-001 --ac A1 --status unchecked --evidence-ref 'quoted node input.js'";
    input.execution.executable = image('/trusted/node');
    input.execution.argv = [
      '/trusted/node',
      '/trusted/writer-main.js',
      'specs',
      'evidence',
      'EXAMPLE-001',
      '--ac',
      'A1',
      '--status',
      'unchecked',
      '--evidence-ref',
      'quoted node input.js',
    ];
    const decoded = decode(input);
    expect(decoded.profile).toEqual(input.profile);
    expect(decoded.execution.argv).toEqual(input.execution.argv);
    expect(Object.isFrozen(decoded.execution.argv)).toBe(true);
    input.execution.argv[0] = '/foreign/node';
    reject(input);
    input.execution.argv = ['/trusted/node', 'too', 'short', 'argv'];
    reject(input);
  });
  test('retains exact native identities, LF paths, opaque bytes and immutable invocation data', () => {
    const input = fixture();
    const result = decode(input);
    expect(result).toEqual(input);
    expect(result.association.threadId).toBe('actual-child');
    expect(result.association.sessionId).toBe('root-lineage');
    expect(result.association.callerAnchor).toBe('/project/owned\nlane');
    expect(result.sandbox.environmentAnchor).toBe('/server');
    expect(Buffer.from(result.sandbox.stateBase64, 'base64').toString()).toContain(
      '9007199254740993'
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.execution)).toBe(true);
    expect(Object.isFrozen(result.execution.environment)).toBe(true);
    expect(Object.isFrozen(result.execution.environment[0])).toBe(true);
    expect(Object.isFrozen(result.profile.utilities[0])).toBe(true);
    expect(() => result.execution.argv.push('extra')).toThrow(TypeError);
  });

  const objects = [
    [],
    ['association'],
    ['execution'],
    ['execution', 'executable'],
    ['execution', 'environment', 0],
    ['profile'],
    ['profile', 'utilities', 0],
    ['sandbox'],
    ['sandbox', 'launcher'],
    ['limits'],
  ];
  for (const path of objects) {
    for (const key of Object.keys(at(fixture(), path))) {
      test(`requires ${[...path, key].join('.')}`, () => {
        const input = fixture();
        delete at(input, path)[key];
        reject(input);
      });
    }
    test(`rejects unknown member and positional representation at ${path.join('.') || 'root'}`, () => {
      const input = fixture();
      at(input, path).unrecognized = true;
      reject(input);
      const positional = fixture();
      if (path.length) replace(positional, path, Object.values(at(positional, path)));
      else return expect(() => decode(Object.values(positional))).toThrow(InvalidPreparedRecord);
      reject(positional);
    });
  }

  test.each([
    ['schema', null],
    ['schema', {}],
    ['schema', 'caws.execution.prepared.v2'],
    ['association.kind', { 'codex-mcp-v1': null }],
    ['profile.kind', { 'bash-clean-v1': null }],
    ['profile.kind', 'arbitrary'],
    ['association.sessionId', ''],
    ['invocationId', 'x'.repeat(257)],
    ['association.threadId', 'line\nbreak'],
    ['association.callId', '\u0085'],
    ['association.serverEnvironmentId', '\ud800'],
    ['projectRoot', 'relative'],
    ['execution.cwd', '/path\0suffix'],
    ['association.callerAnchor', 42],
    ['sandbox.environmentAnchor', '/'.repeat(4097)],
    ['execution.executable.sha256', 'A'.repeat(64)],
    ['sandbox.launcher.sha256', 'a'.repeat(63)],
    ['profile.utilities', null],
    ['execution.argv', []],
    ['execution.argv', Array(257).fill('')],
    ['execution.argv', null],
    ['execution.environment', Array(1025).fill({ name: 'A', value: '' })],
    ['execution.environment', {}],
    ['execution.stdinBase64', 'YQ'],
    ['execution.stdinBase64', 'YR=='],
    ['execution.stdinBase64', 'YQ==\n'],
    ['execution.stdinBase64', null],
    ['sandbox.stateBase64', '/w=='],
    ['limits.jobTimeoutMs', 0],
    ['limits.jobTimeoutMs', -1],
    ['limits.jobTimeoutMs', 86400001],
    ['limits.terminationGraceMs', 10001],
    ['limits.maxOutputBytes', 16777217],
    ['limits.preparationDeadlineUnixMs', 9007199254740992],
    ['limits.jobTimeoutMs', 1.5],
  ])('rejects invalid native scalar %s=%p', (path, replacement) => {
    const input = fixture();
    replace(input, path.split('.'), replacement);
    reject(input);
  });

  test('accepts exact scalar bounds and empty data without normalizing text', () => {
    const input = fixture();
    input.invocationId = 'é'.repeat(128);
    input.profile.source = '';
    input.execution.argv[4] = '';
    input.execution.environment = [{ name: 'é', value: '' }];
    input.execution.stdinBase64 = '';
    input.profile.utilities = [];
    input.limits = {
      preparationDeadlineUnixMs: Number.MAX_SAFE_INTEGER,
      jobTimeoutMs: 86400000,
      terminationGraceMs: 10000,
      maxOutputBytes: 16777216,
    };
    expect(decode(input)).toEqual(input);
    input.invocationId += 'é';
    reject(input);
  });

  test('requires exact executable, source, startup flags and absence of extra argv', () => {
    for (const [index, value] of [
      [0, '/other/bash'],
      [1, '--login'],
      [2, '--rcfile'],
      [3, '-lc'],
      [4, 'other source'],
    ]) {
      const input = fixture();
      input.execution.argv[index] = value;
      reject(input);
    }
    const input = fixture();
    input.execution.argv.push('model-selected-argv0');
    reject(input);
  });

  test('bounds aggregate argv and preserves empty arguments only in an otherwise exact launch shape', () => {
    const input = fixture();
    input.profile.source = 'x'.repeat(65536);
    input.execution.argv[4] = input.profile.source;
    reject(input);
    input.profile.source += 'x';
    input.execution.argv[4] = input.profile.source;
    reject(input);
    input.execution.argv[0] = '\udfff';
    reject(input);
  });

  test('requires complete unique environment in UTF8 byte order and valid native names', () => {
    for (const environment of [
      [
        { name: 'PATH', value: 'a' },
        { name: 'PATH', value: 'b' },
      ],
      [
        { name: 'Z', value: '' },
        { name: 'A', value: '' },
      ],
      [{ name: '', value: '' }],
      [{ name: 'A=B', value: '' }],
      [{ name: 'A', value: '\0' }],
      [{ name: 'A', value: '\ud800' }],
      [{ name: 'A', value: 'v'.repeat(131072) }],
      [{ name: 'A', value: 'v'.repeat(131073) }],
      [{ name: 'x'.repeat(131073), value: '' }],
      [{ name: 'A', value: 1 }],
    ]) {
      const input = fixture();
      input.execution.environment = environment;
      reject(input);
    }
    const input = fixture();
    input.execution.environment = [{ name: 'A', value: 'v'.repeat(131069) }];
    expect(decode(input).execution.environment).toEqual(input.execution.environment);
    input.execution.environment[0].value += 'v';
    reject(input);
  });

  test('bounds decoded stdin, utility inventory and duplicate image paths', () => {
    const input = fixture();
    input.execution.stdinBase64 = Buffer.alloc(524288).toString('base64');
    expect(decode(input).execution.stdinBase64).toBe(input.execution.stdinBase64);
    input.execution.stdinBase64 = Buffer.alloc(524289).toString('base64');
    reject(input);
    input.execution.stdinBase64 = '';
    input.profile.utilities = Array.from({ length: 32 }, (_, index) => image(`/bin/u${index}`));
    expect(decode(input).profile.utilities).toEqual(input.profile.utilities);
    input.profile.utilities.push(image('/bin/extra'));
    reject(input);
    input.profile.utilities = [image('/bin/same'), image('/bin/same')];
    reject(input);
  });

  test('binds original opaque sandbox bytes, preserving unknown fields and number spellings', () => {
    const input = fixture();
    for (const state of [
      Buffer.from('{"future":1e1000,"duplicate":1,"duplicate":2}'),
      Buffer.from(' '.repeat(262142) + '{}'),
    ]) {
      input.sandbox.stateBase64 = state.toString('base64');
      input.sandbox.stateSha256 = digest(state);
      expect(decode(input).sandbox.stateBase64).toBe(state.toString('base64'));
    }
    for (const state of [
      Buffer.from(' '.repeat(262143) + '{}'),
      Buffer.from('not JSON'),
      Buffer.from([0xff]),
    ]) {
      input.sandbox.stateBase64 = state.toString('base64');
      input.sandbox.stateSha256 = digest(state);
      reject(input);
    }
    const valid = fixture();
    valid.sandbox.stateSha256 = 'b'.repeat(64);
    reject(valid);
  });

  test('rejects duplicate keys, alternate numerals, malformed UTF8, structure and record overflows without leaking content', () => {
    const encoded = JSON.stringify(fixture());
    for (const text of [
      encoded.replace('"schema":', '"schema":"wrong","schema":'),
      encoded.replace('"sessionId":', '"sessionId":"wrong","sessionId":'),
      encoded.replace('"jobTimeoutMs":60000', '"jobTimeoutMs":6e4'),
      encoded.replace('"jobTimeoutMs":60000', '"jobTimeoutMs":60000.0'),
      encoded + '{}',
      '\ufeff' + encoded,
      '{"private":"secret and malformed"',
      '['.repeat(14) + '0' + ']'.repeat(14),
    ])
      expect(() => decodePreparedExecution(Buffer.from(text))).toThrow(new InvalidPreparedRecord());
    for (const data of [
      Buffer.from([0xff]),
      Buffer.alloc(0),
      Buffer.alloc(MAX_PREPARED_RECORD_BYTES + 1),
      'not bytes',
    ])
      expect(() => decodePreparedExecution(data)).toThrow(new InvalidPreparedRecord());
    expect(() => decodePreparedExecution(Buffer.from('{"secret":"DO_NOT_ECHO"'))).toThrow(
      'Invalid prepared execution record'
    );
  });
});
