const { createHash } = require('node:crypto');
const {
  MAX_RENDER_ARGUMENT_BYTES,
  MAX_RENDER_REQUEST_BYTES,
  MAX_RENDER_OUTCOME_BYTES,
  RENDER_ARGUMENT_NAMES,
  ServiceProtocolError,
  createRenderRequest,
  renderArgumentDigest,
  renderRequestId,
  projectServiceKey,
  encodeRenderRequest,
  decodeRenderRequest,
  encodeRenderOutcome,
  decodeRenderOutcome,
  classifyRenderReplay,
} = require('../../dist/runtime/service-protocol');

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
function input(changes = {}) {
  return {
    invocationId: 'invocation-1',
    selectedIndex: 3,
    canonicalProject: '/project',
    sourceGeneration: 'a'.repeat(64),
    originalSource: { handlerSha256: 'b'.repeat(64), closureDigest: 'c'.repeat(64) },
    executionImage: { imageDigest: 'd'.repeat(64), clientSha256: 'e'.repeat(64) },
    arguments: [
      '/project/.caws/sessions/sid',
      '/project',
      'sid',
      'started',
      'model',
      'branch',
      'head',
      '0',
      'start',
      '/transcript',
      '/audit',
      '/outcome',
    ],
    ...changes,
  };
}

// Independent encoding oracle: literal domains, field order, and byte encoding.
function expectedRequest(value = input()) {
  return {
    schema: 'caws.service.render.request.v1',
    requestId: sha(
      JSON.stringify([
        'caws-service-render-request-id-v1',
        value.invocationId,
        value.selectedIndex,
        'render:0',
      ])
    ),
    invocationId: value.invocationId,
    selectedIndex: value.selectedIndex,
    operation: 'render:0',
    canonicalProject: value.canonicalProject,
    projectServiceKey: sha(
      JSON.stringify(['caws-project-service-key-v1', value.canonicalProject, 'session-render'])
    ),
    sourceGeneration: value.sourceGeneration,
    originalSource: { ...value.originalSource },
    executionImage: { ...value.executionImage },
    argumentDigest: sha(JSON.stringify(['caws-session-render-argv-v1', value.arguments])),
    arguments: value.arguments.slice(),
  };
}

function outcome(request, value = { admission: 'accepted', execution: 'queued' }) {
  return {
    schema: 'caws.service.render.outcome.v1',
    requestId: request.requestId,
    argumentDigest: request.argumentDigest,
    projectServiceKey: request.projectServiceKey,
    sourceGeneration: request.sourceGeneration,
    executionImageDigest: request.executionImage.imageDigest,
    outcome: value,
  };
}

const wire = (value) => JSON.stringify(value) + '\n';

test('encodes the independently specified request bytes and all twelve argument positions', () => {
  expect(RENDER_ARGUMENT_NAMES).toEqual([
    'logDir',
    'cwd',
    'sessionId',
    'startedAt',
    'model',
    'branch',
    'headSha',
    'dirtyCount',
    'startSha',
    'transcriptPath',
    'auditLog',
    'hookOutcomeLog',
  ]);
  const value = input();
  value.arguments[4] = '模型🙂';
  const expected = expectedRequest(value);
  const request = createRenderRequest(value);
  expect(request).toEqual(expected);
  expect(encodeRenderRequest(request)).toEqual(Buffer.from(wire(expected), 'utf8'));
  expect(decodeRenderRequest(Buffer.from(wire(expected), 'utf8'))).toEqual(expected);
  expect(renderRequestId(value.invocationId, value.selectedIndex)).toBe(expected.requestId);
  expect(projectServiceKey(value.canonicalProject)).toBe(expected.projectServiceKey);
  expect(renderArgumentDigest(value.arguments)).toBe(expected.argumentDigest);
  for (let index = 0; index < 12; index++) {
    const changed = value.arguments.slice();
    changed[index] += '-changed';
    expect(renderArgumentDigest(changed)).not.toBe(expected.argumentDigest);
  }
});

test('copies and deeply freezes transport data rather than retaining caller mutations', () => {
  const value = input();
  const request = createRenderRequest(value);
  value.arguments[0] = 'changed';
  value.originalSource.handlerSha256 = 'f'.repeat(64);
  expect(request.arguments[0]).not.toBe('changed');
  expect(request.originalSource.handlerSha256).toBe('b'.repeat(64));
  for (const part of [request, request.arguments, request.originalSource, request.executionImage])
    expect(Object.isFrozen(part)).toBe(true);
  const response = decodeRenderOutcome(
    wire(
      outcome(request, {
        admission: 'accepted',
        execution: 'returned',
        result: { kind: 'daemon_response', response: 'ok', served: 1, elapsedMs: 0, cached: false },
        artifactManifestDigest: null,
      })
    ),
    request
  );
  expect(Object.isFrozen(response.outcome)).toBe(true);
  expect(Object.isFrozen(response.outcome.result)).toBe(true);
});

test('accepts one LF or no LF and canonical member reordering, but emits fixed order', () => {
  const request = expectedRequest();
  const reordered = Object.fromEntries(Object.entries(request).reverse());
  reordered.originalSource = Object.fromEntries(Object.entries(request.originalSource).reverse());
  const encoded = JSON.stringify(reordered);
  expect(decodeRenderRequest(encoded)).toEqual(request);
  expect(decodeRenderRequest(encoded + '\n')).toEqual(request);
  expect(encodeRenderRequest(decodeRenderRequest(encoded)).toString()).toBe(wire(request));
});

test.each([
  (body) => ' ' + body,
  (body) => body + ' ',
  (body) => body + '\n\n',
  (body) => body + '\r\n',
  (body) => '\ufeff' + body,
  (body) => body.replace('"selectedIndex":3', '"selectedIndex":3.0'),
  (body) => body.replace('"selectedIndex":3', '"selectedIndex":3e0'),
  (body) => body.replace('"selectedIndex":3', '"selectedIndex":-0'),
  (body) => body.replace('"invocation-1"', '"\\u0069nvocation-1"'),
  (body) => body.replace('"selectedIndex":3', '"selectedIndex":3,"selectedIndex":3'),
  (body) =>
    body.replace('"handlerSha256":', '"closureDigest":"' + 'c'.repeat(64) + '","handlerSha256":'),
])('rejects noncanonical wire spelling even when parsed values could match', (change) => {
  expect(() => decodeRenderRequest(change(JSON.stringify(expectedRequest())))).toThrow(
    ServiceProtocolError
  );
});

test('rejects malformed UTF-8 and raw or escaped unpaired surrogates', () => {
  expect(() => decodeRenderRequest(Buffer.from([0xc0, 0xaf]))).toThrow('UTF-8');
  expect(() => decodeRenderRequest('\ud800')).toThrow('UTF-8');
  const request = expectedRequest();
  request.arguments[0] = '\ud800';
  expect(() => decodeRenderRequest(wire(request))).toThrow('single-line UTF-8');
});

test.each(['\0', '\x1f', '\r', '\n', '\ud800', '\udfff'])(
  'rejects unsupported renderer field %j',
  (bad) => {
    const args = input().arguments;
    args[9] = bad;
    expect(() => renderArgumentDigest(args)).toThrow('single-line UTF-8');
  }
);

test('rejects wrong arity, sparse arrays, extra array properties, and nonstrings', () => {
  for (const args of [Array(11).fill(''), Array(13).fill(''), new Array(12)]) {
    expect(() => renderArgumentDigest(args)).toThrow('twelve');
  }
  const extra = Array(12).fill('');
  extra.authority = true;
  expect(() => renderArgumentDigest(extra)).toThrow('twelve');
  const nonstring = Array(12).fill('');
  nonstring[5] = null;
  expect(() => renderArgumentDigest(nonstring)).toThrow('single-line UTF-8');
});

test('bounds the independently encoded argument payload in UTF-8 bytes exactly', () => {
  expect(MAX_RENDER_ARGUMENT_BYTES).toBe(65536);
  const args = Array(12).fill('');
  const overhead = Buffer.byteLength(JSON.stringify(['caws-session-render-argv-v1', args]));
  args[0] = 'a'.repeat(65536 - overhead);
  expect(Buffer.byteLength(JSON.stringify(['caws-session-render-argv-v1', args]))).toBe(65536);
  expect(renderArgumentDigest(args)).toBe(
    sha(JSON.stringify(['caws-session-render-argv-v1', args]))
  );
  args[0] += 'a';
  expect(() => renderArgumentDigest(args)).toThrow('65536');
  args[0] = 'é'.repeat(32768);
  expect(() => renderArgumentDigest(args)).toThrow('65536');
});

test.each([
  (value) => {
    value.unknown = true;
  },
  (value) => {
    delete value.operation;
  },
  (value) => {
    value.schema = 'other';
  },
  (value) => {
    value.operation = 'render:1';
  },
  (value) => {
    value.originalSource.extra = true;
  },
  (value) => {
    delete value.originalSource.closureDigest;
  },
  (value) => {
    value.executionImage.originalSourceSha256 = 'b'.repeat(64);
  },
  (value) => {
    value.sourceGeneration = 'A'.repeat(64);
  },
])('rejects hostile or incomplete request records', (change) => {
  const value = expectedRequest();
  change(value);
  expect(() => decodeRenderRequest(wire(value))).toThrow(ServiceProtocolError);
});

test.each(['requestId', 'projectServiceKey', 'argumentDigest'])(
  'rederives %s rather than trusting an echoed digest',
  (name) => {
    const request = expectedRequest();
    request[name] = '0'.repeat(64);
    expect(() => decodeRenderRequest(wire(request))).toThrow('derived identity mismatch');
  }
);

test.each(['', '_bad', '-bad', 'é', 'a'.repeat(129)])(
  'rejects invocation identity %j',
  (invocationId) => {
    expect(() => createRenderRequest(input({ invocationId }))).toThrow('invocation identity');
  }
);

test('accepts exact invocation/index bounds and rejects noncanonical or unsafe index values', () => {
  expect(
    createRenderRequest(input({ invocationId: 'a'.repeat(128), selectedIndex: 0 })).selectedIndex
  ).toBe(0);
  expect(createRenderRequest(input({ selectedIndex: 65535 })).selectedIndex).toBe(65535);
  for (const selectedIndex of [-0, -1, 65536, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() => createRenderRequest(input({ selectedIndex }))).toThrow('integer');
});

test.each(['relative', '//project', '/project/', '/project/./x', '/project/../x', '/a\0b'])(
  'rejects noncanonical project identity %j',
  (canonicalProject) => {
    expect(() => createRenderRequest(input({ canonicalProject }))).toThrow('POSIX path');
  }
);

test('project identity is lexical, bounded in bytes, and independent of generation', () => {
  const canonicalProject = '/' + 'a'.repeat(4095);
  expect(createRenderRequest(input({ canonicalProject })).canonicalProject).toBe(canonicalProject);
  expect(() => createRenderRequest(input({ canonicalProject: canonicalProject + 'a' }))).toThrow(
    'POSIX path'
  );
  const first = createRenderRequest(input());
  const changed = createRenderRequest(
    input({
      sourceGeneration: 'f'.repeat(64),
      executionImage: { imageDigest: '1'.repeat(64), clientSha256: '2'.repeat(64) },
    })
  );
  expect(changed.projectServiceKey).toBe(first.projectServiceKey);
  expect(changed.requestId).toBe(first.requestId);
  expect(projectServiceKey('/other')).not.toBe(first.projectServiceKey);
  // No realpath lookup occurs for this nonexistent but lexical identity.
  expect(projectServiceKey('/not/a/real/project')).toMatch(/^[a-f0-9]{64}$/);
});

test('bounds complete request and outcome bodies before semantic parsing', () => {
  expect(MAX_RENDER_REQUEST_BYTES).toBe(131072);
  expect(MAX_RENDER_OUTCOME_BYTES).toBe(8192);
  const request = expectedRequest();
  expect(() =>
    decodeRenderRequest(
      wire({
        ...request,
        padding: 'a'.repeat(131072),
      })
    )
  ).toThrow('byte limit');
  expect(() =>
    decodeRenderOutcome(
      wire({
        ...outcome(request),
        padding: 'a'.repeat(8192),
      }),
      request
    )
  ).toThrow('byte limit');
});

test.each(['queued', 'running', 'unknown'])(
  'preserves accepted %s as an observation without invented success',
  (execution) => {
    const request = expectedRequest();
    const frame = outcome(request, { admission: 'accepted', execution });
    expect(decodeRenderOutcome(wire(frame), request)).toEqual(frame);
    expect(encodeRenderOutcome(frame, request)).toEqual(Buffer.from(wire(frame)));
    expect(decodeRenderOutcome(wire(frame), request).outcome).not.toHaveProperty('success');
  }
);

test('preserves rejection with a byte-bounded reason and no fallback permission', () => {
  const request = expectedRequest();
  const frame = outcome(request, {
    admission: 'rejected',
    execution: 'known_not_executed',
    reason: 'é'.repeat(512),
  });
  expect(decodeRenderOutcome(wire(frame), request).outcome).toEqual(frame.outcome);
  frame.outcome.reason += 'é';
  expect(() => decodeRenderOutcome(wire(frame), request)).toThrow('reason');
  frame.outcome.reason = '\ud800';
  expect(() => decodeRenderOutcome(wire(frame), request)).toThrow('reason');
});

test('keeps process return, daemon return, and artifact manifest independent', () => {
  const request = expectedRequest();
  const cases = [
    {
      admission: 'accepted',
      execution: 'returned',
      result: { kind: 'process_exit', code: 0, signal: null },
      artifactManifestDigest: null,
    },
    {
      admission: 'accepted',
      execution: 'returned',
      result: { kind: 'process_exit', code: 7, signal: null },
      artifactManifestDigest: 'f'.repeat(64),
    },
    {
      admission: 'accepted',
      execution: 'returned',
      result: { kind: 'process_exit', code: null, signal: 15 },
      artifactManifestDigest: null,
    },
    {
      admission: 'accepted',
      execution: 'returned',
      result: {
        kind: 'daemon_response',
        response: 'ok',
        served: Number.MAX_SAFE_INTEGER,
        elapsedMs: 0,
        cached: false,
      },
      artifactManifestDigest: null,
    },
  ];
  for (const value of cases) {
    const frame = outcome(request, value);
    expect(decodeRenderOutcome(wire(frame), request).outcome).toEqual(value);
    expect(encodeRenderOutcome(frame, request).toString()).toBe(wire(frame));
  }
});

test.each([
  { kind: 'process_exit', code: null, signal: null },
  { kind: 'process_exit', code: 0, signal: 15 },
  { kind: 'process_exit', code: 256, signal: null },
  { kind: 'process_exit', code: null, signal: 0 },
  { kind: 'process_exit', code: null, signal: 128 },
  { kind: 'process_exit', code: 0.5, signal: null },
  { kind: 'process_exit', code: 0, signal: null, delivered: true },
  { kind: 'daemon_response', response: 'error', served: 1, elapsedMs: 0, cached: false },
  { kind: 'daemon_response', response: 'ok', served: 0, elapsedMs: 0, cached: false },
  { kind: 'daemon_response', response: 'ok', served: 1.5, elapsedMs: 0, cached: false },
  { kind: 'daemon_response', response: 'ok', served: 1, elapsedMs: -1, cached: false },
  { kind: 'daemon_response', response: 'ok', served: 1, elapsedMs: 0, cached: 0 },
  {
    kind: 'daemon_response',
    response: 'ok',
    served: Number.MAX_SAFE_INTEGER + 1,
    elapsedMs: 0,
    cached: false,
  },
])('rejects malformed or fabricated returned result %j', (result) => {
  const request = expectedRequest();
  const frame = outcome(request, {
    admission: 'accepted',
    execution: 'returned',
    result,
    artifactManifestDigest: null,
  });
  expect(() => decodeRenderOutcome(wire(frame), request)).toThrow(ServiceProtocolError);
});

test.each([
  { admission: 'accepted', execution: 'known_not_executed' },
  { admission: 'rejected', execution: 'unknown', reason: 'lost' },
  { admission: 'accepted', execution: 'queued', success: true },
  { admission: 'accepted', execution: 'unknown', reason: 'not a v1 field' },
  { admission: 'accepted', execution: 'returned', workerExit: 0, artifactManifestDigest: null },
  {
    admission: 'accepted',
    execution: 'returned',
    result: { kind: 'process_exit', code: 0, signal: null },
  },
  {
    admission: 'accepted',
    execution: 'returned',
    result: { kind: 'process_exit', code: 0, signal: null },
    artifactManifestDigest: 'BAD',
  },
])('rejects outcome combinations outside the exact union %j', (value) => {
  const request = expectedRequest();
  expect(() => decodeRenderOutcome(wire(outcome(request, value)), request)).toThrow(
    ServiceProtocolError
  );
});

test.each([
  'requestId',
  'argumentDigest',
  'projectServiceKey',
  'sourceGeneration',
  'executionImageDigest',
])('matches echoed %s against the originating request', (name) => {
  const request = expectedRequest();
  const frame = outcome(request);
  frame[name] = '0'.repeat(64);
  expect(() => decodeRenderOutcome(wire(frame), request)).toThrow('identity mismatch');
  expect(() => encodeRenderOutcome(frame, request)).toThrow('identity mismatch');
});

test('rejects noncanonical outcome bytes and revalidates the originating request', () => {
  const request = expectedRequest();
  const frame = outcome(request, {
    admission: 'accepted',
    execution: 'returned',
    result: { kind: 'daemon_response', response: 'ok', served: 1, elapsedMs: 0, cached: true },
    artifactManifestDigest: null,
  });
  expect(() =>
    decodeRenderOutcome(wire(frame).replace('"served":1', '"served":1e0'), request)
  ).toThrow('canonical');
  expect(() =>
    decodeRenderOutcome(
      wire(frame).replace('"cached":true', '"cached":true,"cached":true'),
      request
    )
  ).toThrow('canonical');
  const tampered = clone(request);
  tampered.arguments[0] = 'changed without updating its digest';
  expect(() => decodeRenderOutcome(wire(frame), tampered)).toThrow('derived identity mismatch');
});

test('replay compares the full normalized immutable request without running or relabeling work', () => {
  const existing = expectedRequest();
  const reordered = Object.fromEntries(Object.entries(existing).reverse());
  expect(classifyRenderReplay(existing, reordered)).toBe('replay');
  expect(classifyRenderReplay(existing, expectedRequest(input({ invocationId: 'other' })))).toBe(
    'different_request'
  );
  for (const changed of [
    expectedRequest(input({ arguments: input().arguments.map((v, i) => (i === 4 ? v + 'x' : v)) })),
    expectedRequest(input({ canonicalProject: '/other' })),
    expectedRequest(input({ sourceGeneration: 'f'.repeat(64) })),
    expectedRequest(
      input({
        originalSource: { handlerSha256: '1'.repeat(64), closureDigest: 'c'.repeat(64) },
      })
    ),
    expectedRequest(
      input({
        originalSource: { handlerSha256: 'b'.repeat(64), closureDigest: '1'.repeat(64) },
      })
    ),
    expectedRequest(
      input({
        executionImage: { imageDigest: '1'.repeat(64), clientSha256: 'e'.repeat(64) },
      })
    ),
    expectedRequest(
      input({
        executionImage: { imageDigest: 'd'.repeat(64), clientSha256: '1'.repeat(64) },
      })
    ),
  ]) {
    expect(changed.requestId).toBe(existing.requestId);
    expect(() => classifyRenderReplay(existing, changed)).toThrow('immutable request');
  }
  const tampered = clone(existing);
  tampered.arguments[0] = 'different argument with the old digest';
  expect(() => classifyRenderReplay(existing, tampered)).toThrow('derived identity mismatch');
});

test('diagnostics remain bounded and do not reflect hostile frame contents', () => {
  const secret = 'caller-controlled-sensitive-content'.repeat(100);
  const request = expectedRequest();
  request.originalSource[secret] = secret;
  try {
    decodeRenderRequest(wire(request));
    throw new Error('expected protocol refusal');
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceProtocolError);
    expect(Buffer.byteLength(error.message)).toBeLessThan(256);
    expect(error.message).not.toContain(secret);
  }
});

test.each(['source_retired', 'grant_withdrawn'])(
  'roundtrips accepted cancellation %s without a worker result or fallback permission',
  (reason) => {
    const request = expectedRequest();
    const value = { admission: 'accepted', execution: 'cancelled_before_dispatch', reason };
    const frame = outcome(request, value);
    const decoded = decodeRenderOutcome(wire(frame), request);
    expect(decoded).toEqual(frame);
    expect(encodeRenderOutcome(frame, request)).toEqual(Buffer.from(wire(frame)));
    expect(Object.isFrozen(decoded.outcome)).toBe(true);
    expect(decoded.outcome).not.toHaveProperty('result');
    expect(decoded.outcome).not.toHaveProperty('artifactManifestDigest');
    expect(decoded.outcome).not.toHaveProperty('allowInlineFallback');
  }
);

test.each([
  { admission: 'rejected', execution: 'cancelled_before_dispatch', reason: 'source_retired' },
  { admission: 'accepted', execution: 'known_not_executed', reason: 'grant_withdrawn' },
  { admission: 'accepted', execution: 'cancelled_before_dispatch' },
  { admission: 'accepted', execution: 'cancelled_before_dispatch', reason: null },
  { admission: 'accepted', execution: 'cancelled_before_dispatch', reason: '' },
  { admission: 'accepted', execution: 'cancelled_before_dispatch', reason: 'SourceRetired' },
  { admission: 'accepted', execution: 'cancelled_before_dispatch', reason: 'future_reason' },
  { admission: 'accepted', execution: 'cancelled_before_dispatch', reason: ['source_retired'] },
  {
    admission: 'accepted',
    execution: 'cancelled_before_dispatch',
    reason: 'source_retired',
    result: { kind: 'process_exit', code: 0, signal: null },
  },
  {
    admission: 'accepted',
    execution: 'cancelled_before_dispatch',
    reason: 'grant_withdrawn',
    artifactManifestDigest: null,
  },
  {
    admission: 'accepted',
    execution: 'cancelled_before_dispatch',
    reason: 'source_retired',
    allowInlineFallback: true,
  },
])('rejects cancellation claims outside the exact accepted union %j', (value) => {
  const request = expectedRequest();
  const frame = outcome(request, value);
  expect(() => decodeRenderOutcome(wire(frame), request)).toThrow(ServiceProtocolError);
  expect(() => encodeRenderOutcome(frame, request)).toThrow(ServiceProtocolError);
});

test.each([
  'requestId',
  'argumentDigest',
  'projectServiceKey',
  'sourceGeneration',
  'executionImageDigest',
])('correlates cancelled operations through %s', (name) => {
  const request = expectedRequest();
  for (const reason of ['source_retired', 'grant_withdrawn']) {
    const frame = outcome(request, {
      admission: 'accepted',
      execution: 'cancelled_before_dispatch',
      reason,
    });
    frame[name] = '0'.repeat(64);
    expect(() => decodeRenderOutcome(wire(frame), request)).toThrow('identity mismatch');
    expect(() => encodeRenderOutcome(frame, request)).toThrow('identity mismatch');
  }
});

test('cancellation does not relabel an old identity as a new source grant', () => {
  const retired = expectedRequest();
  const frame = outcome(retired, {
    admission: 'accepted',
    execution: 'cancelled_before_dispatch',
    reason: 'source_retired',
  });
  const next = expectedRequest(input({ sourceGeneration: 'f'.repeat(64) }));
  expect(next.requestId).toBe(retired.requestId);
  expect(() => decodeRenderOutcome(wire(frame), next)).toThrow('identity mismatch');
  expect(() => classifyRenderReplay(retired, next)).toThrow('immutable request');
  expect(() =>
    decodeRenderOutcome(
      wire(frame).replace(
        '"reason":"source_retired"',
        '"reason":"source_retired","reason":"grant_withdrawn"'
      ),
      retired
    )
  ).toThrow('canonical');
});
