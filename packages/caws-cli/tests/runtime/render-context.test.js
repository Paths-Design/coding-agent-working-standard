const fs = require('node:fs');
const path = require('node:path');
const {
  deriveRenderGitContext,
  RenderContextError,
  MAX_RENDER_CONTEXT_BYTES,
} = require('../../dist/runtime/render-context');
const { structuredClone } = globalThis;
const expected = Object.freeze({
  id: 'original-render',
  runtimeDigest: 'a'.repeat(64),
  token: '8c766a03-c6a7-42d0-bff5-78c88fab32a1',
  cwd: '/repo/nested/../nested',
  executable: Object.freeze({
    path: '/usr/bin/git',
    physicalPath: '/physical/git',
    sha256: 'c'.repeat(64),
  }),
});
const encoded = (value) => Buffer.from(JSON.stringify(value));
const base64 = (value) => Buffer.from(value).toString('base64');
function observation() {
  return {
    schema: 'caws.render.context.observation.v1',
    id: expected.id,
    runtimeDigest: expected.runtimeDigest,
    token: expected.token,
    cwd: expected.cwd,
    executable: { ...expected.executable },
    queries: ['inside', 'branch', 'head', 'status'].map((operation, index) => ({
      ordinal: index + 1,
      operation,
      exitCode: 0,
      signal: null,
      stdout: base64(
        ['true\n', ' \tbranch \t\n\n', 'abc123\n\n', ' M one\n?? two\nunterminated'][index]
      ),
      stderr: '',
      cleanup: {
        exitObserved: true,
        groupSettled: true,
        stdoutEof: true,
        stderrEof: true,
        reaped: true,
        ownershipRetained: false,
      },
    })),
  };
}
function refused(input, category, message) {
  let error;
  try {
    deriveRenderGitContext(input, expected);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(RenderContextError);
  expect(error.category).toBe(category);
  if (message) expect(error.message).toBe(message);
}
test('native-shaped observations preserve CWD spelling, shell LF stripping and LF dirty count', () => {
  const raw = observation(),
    before = encoded(raw);
  const result = deriveRenderGitContext(before, expected);
  expect(result).toMatchObject({ cwd: expected.cwd, branch: ' \tbranch \t', headSha: 'abc123' });
  expect(result.dirtyFiles.lexeme).toBe('2');
  expect(Object.isFrozen(result)).toBe(true);
  expect(before).toEqual(encoded(raw));
});
test.each(['partial', 'partial\n\n', ' \thead \t'])(
  'failing HEAD stdout %j remains before echo unknown',
  (partial) => {
    const raw = observation();
    raw.queries[2].stdout = base64(partial);
    raw.queries[2].exitCode = 7;
    expect(deriveRenderGitContext(encoded(raw), expected).headSha).toBe(partial + 'unknown');
  }
);
test('nonzero branch discards its partial stdout as the shell assignment fallback does', () => {
  const raw = observation();
  raw.queries[1].stdout = base64('discarded');
  raw.queries[1].exitCode = 1;
  expect(deriveRenderGitContext(encoded(raw), expected).branch).toBe('detached');
});
test('failed repository probe is the actual unknown/zero shell branch with no later query', () => {
  const raw = observation();
  raw.queries = raw.queries.slice(0, 1);
  raw.queries[0].exitCode = 128;
  expect(deriveRenderGitContext(encoded(raw), expected)).toMatchObject({
    branch: 'unknown',
    headSha: 'unknown',
    dirtyFiles: { lexeme: '0' },
  });
});
test('nonzero porcelain status refuses instead of fabricating a dirty count', () => {
  const raw = observation();
  raw.queries[3].exitCode = 2;
  refused(encoded(raw), 'git_exit', 'Render Git porcelain query failed');
});
test.each(['id', 'runtimeDigest', 'token', 'cwd'])('mismatched original %s is refused', (field) => {
  const raw = observation();
  raw[field] = 'foreign';
  refused(encoded(raw), 'identity', 'Render context differs from original identity or CWD');
});
test.each(['schema', 'extra', 'missing', 'executable-extra'])(
  'malformed record %s refuses before context derivation',
  (fault) => {
    const raw = observation();
    if (fault === 'schema') raw.schema = 'caws.render.context.observation.v2';
    if (fault === 'extra') raw.branch = 'unobserved';
    if (fault === 'missing') delete raw.queries;
    if (fault === 'executable-extra') raw.executable.fallback = '/ambient/git';
    refused(encoded(raw), fault === 'executable-extra' ? 'identity' : 'protocol');
  }
);
test.each(['path', 'physicalPath', 'sha256'])('mismatched executable %s is refused', (field) => {
  const raw = observation();
  raw.executable[field] = 'foreign';
  refused(encoded(raw), 'identity', 'Render Git executable differs from original selection');
});
test.each([
  'exitObserved',
  'groupSettled',
  'stdoutEof',
  'stderrEof',
  'reaped',
  'ownershipRetained',
])('unconfirmed cleanup %s refuses', (field) => {
  const raw = observation();
  raw.queries[2].cleanup[field] = field === 'ownershipRetained';
  refused(encoded(raw), 'cleanup', 'Render Git query cleanup is unconfirmed');
});
test.each(['ordinal', 'operation', 'extra', 'count', 'early', 'continued'])(
  'invalid query %s refuses',
  (fault) => {
    const raw = observation();
    if (fault === 'ordinal') raw.queries[1].ordinal = 3;
    if (fault === 'operation') raw.queries[1].operation = 'checkout';
    if (fault === 'extra') raw.queries[1].arbitraryArgv = ['--version'];
    if (fault === 'count') raw.queries.pop();
    if (fault === 'early') raw.queries = raw.queries.slice(0, 1);
    if (fault === 'continued') raw.queries[0].exitCode = 1;
    refused(encoded(raw), 'protocol');
  }
);
test.each(['stdout', 'stderr'])(
  'invalid UTF-8 %s remains unsupported rather than replaced',
  (stream) => {
    const raw = observation();
    raw.queries[1][stream] = base64(Buffer.from([255]));
    refused(encoded(raw), 'utf8', 'Render Git output is outside the UTF-8 consumer profile');
  }
);
test('BOM and CR are data, not generic whitespace to trim', () => {
  const raw = observation();
  raw.queries[1].stdout = base64('\ufeff branch\r\n');
  expect(deriveRenderGitContext(encoded(raw), expected).branch).toBe('\ufeff branch\r');
});
test.each(['null-code', 'negative-code', 'large-code', 'signal'])(
  'unsupported actual status %s refuses',
  (fault) => {
    const raw = observation();
    raw.queries[1].exitCode =
      fault === 'null-code'
        ? null
        : fault === 'negative-code'
          ? -1
          : fault === 'large-code'
            ? 256
            : 0;
    if (fault === 'signal') raw.queries[1].signal = 15;
    refused(encoded(raw), 'git_exit', 'Render Git query has no normal exit status');
  }
);
test.each(['base64', 'oversize', 'combined', 'nul'])('hostile raw output %s refuses', (fault) => {
  const raw = observation();
  let category = 'protocol',
    message = 'Invalid Render Git byte encoding';
  if (fault === 'base64') raw.queries[1].stdout = 'YQ';
  if (fault === 'oversize')
    raw.queries[1].stdout = Buffer.alloc(1024 * 1024 + 1, 97).toString('base64');
  if (fault === 'combined') {
    raw.queries[1].stdout = Buffer.alloc(600000, 97).toString('base64');
    raw.queries[1].stderr = raw.queries[1].stdout;
    message = 'Render Git combined output exceeds byte bound';
  }
  if (fault === 'nul') {
    raw.queries[1].stdout = base64('a\0b');
    category = 'utf8';
    message = 'Render Git output contains unsupported NUL bytes';
  }
  refused(encoded(raw), category, message);
});
test.each(['root', 'escaped', 'cleanup'])(
  'duplicate %s members cannot silently change selection',
  (kind) => {
    let text = JSON.stringify(observation());
    if (kind === 'root') text = text.replace('"id":', '"id":"foreign","id":');
    if (kind === 'escaped') text = text.replace('"id":', '"\\u0069d":"foreign","id":');
    if (kind === 'cleanup') text = text.replace('"reaped":true', '"reaped":false,"reaped":true');
    refused(Buffer.from(text), 'protocol', 'Invalid Render context JSON or duplicate member');
  }
);
test('numeric extension spelling refuses instead of JSON.parse coercion', () => {
  refused(
    Buffer.from(JSON.stringify(observation()).replace('"ordinal":1', '"ordinal":1e0')),
    'protocol',
    'Render context is not canonical native JSON'
  );
});
test('whole encoded bound and malformed UTF-8/JSON refuse', () => {
  refused(
    Buffer.alloc(MAX_RENDER_CONTEXT_BYTES + 1),
    'protocol',
    'Render context exceeds byte bound'
  );
  refused(Buffer.from([255]), 'protocol', 'Invalid Render context JSON or duplicate member');
  refused(Buffer.from('{'), 'protocol', 'Invalid Render context JSON or duplicate member');
});
test('consumer does not mutate caller-owned observation or expected binding', () => {
  const raw = observation();
  const copy = structuredClone(raw);
  deriveRenderGitContext(encoded(raw), expected);
  expect(raw).toEqual(copy);
});

const captureRoot = process.env.CAWS_RENDER_CONTEXT_CAPTURE_ROOT;
(captureRoot ? test : test.skip)(
  'actual native serialized observations match independent original bindings and Bash oracle',
  () => {
    let observed = 0;
    for (const name of ['render-context-captures.json', 'render-context-hostile-captures.json']) {
      const capture = JSON.parse(fs.readFileSync(path.join(captureRoot, name), 'utf8'));
      expect(capture.schema).toBe('caws.render.context.test-captures.v1');
      for (const row of capture.rows) {
        const bytes = Buffer.from(row.wire, 'utf8');
        expect(JSON.parse(row.wire)).toEqual(row.observation);
        if (row.errorCategory) {
          if (row.name === 'failed-status')
            expect(row.shellOutcome).toMatchObject({ exitCode: 9, stdout: '' });
          let error;
          try {
            deriveRenderGitContext(bytes, row.identity);
          } catch (caught) {
            error = caught;
          }
          expect(error).toBeInstanceOf(RenderContextError);
          expect(error.category).toBe(row.errorCategory);
        } else {
          const result = deriveRenderGitContext(bytes, row.identity);
          expect({ ...result, dirtyFiles: result.dirtyFiles.lexeme }).toEqual(row.expected);
        }
        observed++;
      }
    }
    expect(observed).toBe(11);
  }
);

test.each(['', 'a'.repeat(129), 'bad\0token', 'é', 'bad/token', 'bad\n'])(
  'malformed proposal token %j refuses even when record and expected agree',
  (token) => {
    const raw = observation();
    raw.token = token;
    expect(() => deriveRenderGitContext(encoded(raw), { ...expected, token })).toThrow(
      'Render context differs from original identity or CWD'
    );
    let error;
    try {
      deriveRenderGitContext(encoded(raw), { ...expected, token });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RenderContextError);
    expect(error.category).toBe('identity');
  }
);
test('128-byte proposal token remains an opaque accepted identity', () => {
  const token = 'a'.repeat(128),
    raw = observation();
  raw.token = token;
  expect(deriveRenderGitContext(encoded(raw), { ...expected, token }).headSha).toBe('abc123');
});
