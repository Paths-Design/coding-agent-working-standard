const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { Duplex } = require('node:stream');
const { spawn } = require('node:child_process');
const { AbortController, queueMicrotask } = globalThis;
const client = require('../../dist/runtime/service-client');
const template = fs.readFileSync(
  path.join(__dirname, '../../templates/hook-packs/shared/lib/session-render-service-client.sh'),
  'utf8'
);
const entry = require.resolve('../../dist/runtime/service-client');
const clone = (value) => JSON.parse(JSON.stringify(value));
const wire = (value) => JSON.stringify(value) + '\n';
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
function grant(changes = {}) {
  return {
    schema: 'caws.service.render.grant.v1',
    grantId: '0'.repeat(64),
    adapter: 'sterling-session-log-broker-v1',
    invocationId: 'invocation-1',
    selectedIndex: 3,
    canonicalProject: '/project',
    sourceGeneration: 'a'.repeat(64),
    originalSource: { handlerSha256: 'b'.repeat(64), closureDigest: 'c'.repeat(64) },
    executionImage: { imageDigest: 'd'.repeat(64), clientSha256: 'e'.repeat(64) },
    originalHandlerEntry: 'session-log.sh',
    originalHandlerPath: '/project/.caws/hooks/session-log.sh',
    hooksDirectory: '/immutable/hooks',
    leaseFile: '/project/.caws/sessions/.renderer-daemon.json',
    remainingBudgetMs: 500,
    ...changes,
  };
}
function argv(g = grant()) {
  return [
    g.hooksDirectory,
    g.leaseFile,
    '/logs',
    '/project',
    'sid',
    'started',
    '模型🙂',
    'branch',
    'head',
    '0',
    'start',
    '/transcript',
    '/audit',
    '/outcomes',
  ];
}
function frame(
  request,
  outcome = {
    admission: 'accepted',
    execution: 'returned',
    result: { kind: 'daemon_response', response: 'ok', served: 2, elapsedMs: 3, cached: false },
    artifactManifestDigest: null,
  }
) {
  return {
    schema: 'caws.service.render.outcome.v1',
    requestId: request.requestId,
    argumentDigest: request.argumentDigest,
    projectServiceKey: request.projectServiceKey,
    sourceGeneration: request.sourceGeneration,
    executionImageDigest: request.executionImage.imageDigest,
    outcome,
  };
}
function reply(g, req, outcome) {
  return {
    schema: 'caws.service.render.bridge.reply.v1',
    grantId: g.grantId,
    grantDigest: client.serviceGrantDigest(g),
    outcome: frame(req, outcome),
  };
}
// The fake peer proves bridge transport/correlation only, not native ownership,
// daemon execution, artifact parity, custody, or source-closure admission.
function peer(g, responder) {
  let input = Buffer.alloc(0);
  const stream = new Duplex({
    read() {},
    write(chunk, encoding, done) {
      input = Buffer.concat([input, chunk]);
      done();
    },
    final(done) {
      done();
      queueMicrotask(() => responder(stream, input));
    },
  });
  return { stream, input: () => input };
}
async function run(g, responder, io = {}) {
  const p = peer(g, responder);
  const receipts = [];
  const result = await client.runServiceClient(g, argv(g), {
    openTransport: () => p.stream,
    publishReceipt: (bytes) => receipts.push(bytes),
    ...io,
  });
  return {
    result,
    receipts,
    request: p.input().length ? client.decodeServiceBridgeRequest(p.input(), g).request : null,
  };
}
function responding(outcome) {
  return (stream, bytes) => {
    const g = grant();
    const req = client.decodeServiceBridgeRequest(bytes, g).request;
    stream.push(client.encodeServiceBridgeReply(reply(g, req, outcome), g, req));
    stream.push(null);
  };
}
test('grant and request use independently pinned bytes, every argv position, and separate source/image bindings', () => {
  const g = grant();
  expect(client.encodeServiceGrant(g)).toEqual(Buffer.from(wire(g)));
  expect(client.serviceGrantDigest(g)).toBe(hash(JSON.stringify(g)));
  expect(client.decodeServiceGrant(wire(g))).toEqual(g);
  const a = argv(g);
  const req = client.makeServiceRenderRequest(g, a);
  expect(req.arguments).toEqual(a.slice(2));
  expect(req.argumentDigest).toBe(
    hash(JSON.stringify(['caws-session-render-argv-v1', a.slice(2)]))
  );
  expect(req.originalSource).toEqual(g.originalSource);
  expect(req.executionImage).toEqual(g.executionImage);
  const encoded = client.encodeServiceBridgeRequest(g, req);
  expect(encoded).toEqual(
    Buffer.from(
      wire({
        schema: 'caws.service.render.bridge.request.v1',
        grantId: g.grantId,
        grantDigest: hash(JSON.stringify(g)),
        request: req,
      })
    )
  );
  for (let i = 2; i < 14; i++) {
    const changed = a.slice();
    changed[i] += '!';
    expect(client.makeServiceRenderRequest(g, changed).argumentDigest).not.toBe(req.argumentDigest);
  }
  for (const a2 of [
    a.slice(1),
    [...a, 'extra'],
    ['wrong', ...a.slice(1)],
    [a[0], 'wrong', ...a.slice(2)],
  ])
    expect(() => client.makeServiceRenderRequest(g, a2)).toThrow();
  for (const hostile of ['\0', '\ud800', '\udfff']) {
    const changed = a.slice();
    changed[2] += hostile;
    expect(() => client.makeServiceRenderRequest(g, changed)).toThrow();
  }
});
test('closed grant decoder rejects hostile fields, noncanonical/invalid UTF8, and out-of-range bounds rather than clamping', () => {
  const g = grant();
  for (const value of [
    { ...g, extra: true },
    { ...g, originalSource: { ...g.originalSource, imageDigest: g.sourceGeneration } },
    { ...g, executionImage: { ...g.executionImage, original: true } },
    { ...g, grantId: 'A'.repeat(64) },
    { ...g, selectedIndex: 65536 },
    { ...g, invocationId: 'bad value' },
    { ...g, originalHandlerEntry: 'other.sh' },
    { ...g, canonicalProject: '/project/../other' },
    { ...g, originalHandlerPath: '/x//handler' },
    { ...g, hooksDirectory: 'relative' },
    { ...g, leaseFile: '/bad\ud800' },
    ...[0, 120001, 1.5].map((remainingBudgetMs) => ({ ...g, remainingBudgetMs })),
  ])
    expect(() => client.decodeServiceGrant(wire(value))).toThrow();
  expect(() => client.encodeServiceGrant({ ...g, selectedIndex: -0 })).toThrow();
  expect(client.decodeServiceGrant(wire({ ...g, selectedIndex: 0 })).selectedIndex).toBe(0);
  for (const text of [
    ' ' + wire(g),
    wire(g) + '\n',
    wire(g).replace('"selectedIndex":3', '"selectedIndex":-0'),
    wire(g).replace('"selectedIndex":3', '"selectedIndex":3.0'),
    wire(g).replace('"selectedIndex":3', '"selectedIndex":3,"selectedIndex":3'),
    wire(g).replace('"invocation-1"', '"\\u0069nvocation-1"'),
    '\ufeff' + wire(g),
  ])
    expect(() => client.decodeServiceGrant(text)).toThrow();
  expect(() => client.decodeServiceGrant(Buffer.from([0xff, 0xfe]))).toThrow();
  expect(() =>
    client.decodeServiceGrant(Buffer.alloc(client.MAX_SERVICE_GRANT_BYTES + 2))
  ).toThrow();
  for (const remainingBudgetMs of [1, 120000])
    expect(client.decodeServiceGrant(wire(grant({ remainingBudgetMs }))).remainingBudgetMs).toBe(
      remainingBudgetMs
    );
});
test('bridge and receipt reject wrong grants, changed source/image/args, unknown keys, and fabricated admission', () => {
  const g = grant();
  const req = client.makeServiceRenderRequest(g, argv(g));
  const good = reply(g, req);
  for (const value of [
    { ...good, grantId: '1'.repeat(64) },
    { ...good, grantDigest: '2'.repeat(64) },
    { ...good, extra: true },
    { ...good, outcome: { ...good.outcome, executionImageDigest: '3'.repeat(64) } },
  ])
    expect(() => client.decodeServiceBridgeReply(wire(value), g, req)).toThrow();
  const changed = clone(req);
  changed.sourceGeneration = '1'.repeat(64);
  expect(() => client.encodeServiceBridgeRequest(g, changed)).toThrow();
  const changedArgs = clone(req);
  changedArgs.arguments[0] = '/other';
  expect(() => client.encodeServiceBridgeRequest(g, changedArgs)).toThrow();
  const local = {
    kind: 'client_observation',
    requestId: req.requestId,
    argumentDigest: req.argumentDigest,
    projectServiceKey: req.projectServiceKey,
    sourceGeneration: req.sourceGeneration,
    executionImageDigest: req.executionImage.imageDigest,
    delivery: 'may_have_been_delivered',
    execution: 'unknown',
    reason: 'timeout',
  };
  const receipt = {
    schema: 'caws.service.render.client.receipt.v1',
    grantId: g.grantId,
    grantDigest: client.serviceGrantDigest(g),
    outcome: local,
  };
  expect(client.decodeServiceClientReceipt(wire(receipt), g, req)).toEqual(receipt);
  for (const outcome of [
    { ...local, admission: 'accepted' },
    { ...local, execution: 'known_not_executed' },
    { ...local, delivery: 'not_attempted' },
    { ...local, reason: 'arbitrary' },
    { ...local, requestId: '4'.repeat(64) },
  ])
    expect(() =>
      client.decodeServiceClientReceipt(wire({ ...receipt, outcome }), g, req)
    ).toThrow();
});
test.each([
  [{ admission: 'accepted', execution: 'queued' }, 75],
  [{ admission: 'accepted', execution: 'running' }, 75],
  [{ admission: 'accepted', execution: 'unknown' }, 75],
  [{ admission: 'accepted', execution: 'cancelled_before_dispatch', reason: 'source_retired' }, 75],
  [{ admission: 'rejected', execution: 'known_not_executed', reason: 'withdrawn' }, 75],
  [
    {
      admission: 'accepted',
      execution: 'returned',
      result: { kind: 'process_exit', code: 2, signal: null },
      artifactManifestDigest: null,
    },
    75,
  ],
  [
    {
      admission: 'accepted',
      execution: 'returned',
      result: { kind: 'process_exit', code: null, signal: 15 },
      artifactManifestDigest: null,
    },
    75,
  ],
  [
    {
      admission: 'accepted',
      execution: 'returned',
      result: { kind: 'process_exit', code: 0, signal: null },
      artifactManifestDigest: null,
    },
    0,
  ],
])('only an observed returned success allows zero: %j', async (outcome, exitCode) => {
  const g = grant();
  const value = await run(g, responding(outcome));
  expect(value.result.exitCode).toBe(exitCode);
  expect(value.receipts).toHaveLength(1);
  const receipt = client.decodeServiceClientReceipt(value.receipts[0], g, value.request);
  expect(receipt.outcome).toEqual({ kind: 'owner_outcome', frame: frame(value.request, outcome) });
});
test('requires bounded EOF, rejects fragmented trailing frames, and never treats a transport loss as accepted', async () => {
  const g = grant();
  const success = await run(g, (stream, bytes) => {
    const req = client.decodeServiceBridgeRequest(bytes, g).request;
    const encoded = client.encodeServiceBridgeReply(reply(g, req), g, req);
    stream.push(encoded.subarray(0, 11));
    queueMicrotask(() => {
      stream.push(encoded.subarray(11));
      stream.push(null);
    });
  });
  expect(success.result.exitCode).toBe(0);
  for (const responder of [
    (s) => s.destroy(),
    (s) => {
      s.push(Buffer.alloc(client.MAX_SERVICE_BRIDGE_REPLY_BYTES + 2));
      s.push(null);
    },
    (s) => {
      s.push('{"schema":"wrong"}\n');
      s.push(null);
    },
    (s, bytes) => {
      const req = client.decodeServiceBridgeRequest(bytes, g).request;
      s.push(client.encodeServiceBridgeReply(reply(g, req), g, req));
      queueMicrotask(() => {
        s.push('{}\n');
        s.push(null);
      });
    },
  ]) {
    const value = await run(g, responder);
    expect(value.result.exitCode).toBe(75);
    expect(value.result.receipt.outcome).toMatchObject({
      kind: 'client_observation',
      delivery: 'may_have_been_delivered',
      execution: 'unknown',
    });
    expect(value.result.receipt.outcome).not.toHaveProperty('admission');
  }
});
test('pre-write unavailable is local nonexecution; write callback failure, timeout and interruption remain unknown', async () => {
  const g = grant({ remainingBudgetMs: 15 });
  const receipts = [];
  const pre = await client.runServiceClient(g, argv(g), {
    openTransport: () => {
      throw Error('closed');
    },
    publishReceipt: (b) => receipts.push(b),
  });
  expect(pre.receipt.outcome).toMatchObject({
    delivery: 'not_attempted',
    execution: 'known_not_executed',
    reason: 'transport_unavailable',
  });
  const broken = new Duplex({
    read() {},
    write(chunk, encoding, done) {
      done(Error('write failed'));
    },
  });
  const write = await client.runServiceClient(g, argv(g), {
    openTransport: () => broken,
    publishReceipt() {},
  });
  expect(write.receipt.outcome).toMatchObject({
    delivery: 'may_have_been_delivered',
    execution: 'unknown',
    reason: 'transport_error',
  });
  const timeout = await run(g, () => {});
  expect(timeout.result.receipt.outcome).toMatchObject({
    delivery: 'may_have_been_delivered',
    execution: 'unknown',
    reason: 'timeout',
  });
  const controller = new AbortController();
  const interrupted = await run(g, () => controller.abort(), { signal: controller.signal });
  expect(interrupted.result.receipt.outcome).toMatchObject({
    delivery: 'may_have_been_delivered',
    execution: 'unknown',
    reason: 'interrupted',
  });
  const invalid = await client.runServiceClient(g, argv(g).slice(1), {
    openTransport() {
      throw Error('must not open');
    },
    publishReceipt() {
      throw Error('must not publish');
    },
  });
  expect(invalid).toEqual({ exitCode: 75, receipt: null, receiptPublished: false });
});
test('receipt failure preserves a completed owner outcome but denies shell success', async () => {
  const value = await run(grant(), responding(), {
    publishReceipt() {
      throw Error('readonly');
    },
  });
  expect(value.result.exitCode).toBe(75);
  expect(value.result.receiptPublished).toBe(false);
  expect(value.result.receipt.outcome).toMatchObject({
    kind: 'owner_outcome',
    frame: { outcome: { execution: 'returned' } },
  });
});
test('abort during publication preserves observed result while denying helper zero', async () => {
  const controller = new AbortController();
  const value = await run(grant(), responding(), {
    signal: controller.signal,
    publishReceipt() {
      controller.abort();
    },
  });
  expect(value.result.exitCode).toBe(75);
  expect(value.result.receiptPublished).toBe(true);
  expect(value.result.receipt.outcome.kind).toBe('owner_outcome');
});
test('shell builder quotes absolute literal paths without executable discovery or replacement interpolation', () => {
  const rendered = client.renderServiceClientShell(
    template,
    "/image/node' dollar$`literal`",
    '/image/$&/client.js'
  );
  expect(rendered).toContain("'/image/node'\\'' dollar$`literal`' '/image/$&/client.js'");
  expect(rendered).not.toContain(client.SERVICE_NODE_MARKER);
  for (const [t, n, e] of [
    [template, 'node', '/entry'],
    [template, '/node/../x', '/entry'],
    [template, '/node\nline', '/entry'],
    [template + client.SERVICE_NODE_MARKER, '/node', '/entry'],
    [template.replace(client.SERVICE_ENTRY_MARKER, ''), '/node', '/entry'],
  ])
    expect(() => client.renderServiceClientShell(t, n, e)).toThrow();
});
test('shell builder substitutes original slots once when legal paths contain markers and shell metacharacters', () => {
  const minimal = '#!/bin/bash\n__CAWS_SERVICE_CLIENT_NODE__ __CAWS_SERVICE_CLIENT_ENTRY__ "$@"\n';
  const node =
    "/image/__CAWS_SERVICE_CLIENT_ENTRY__/node'$(printf NODE_INJECTION)`printf NODE_BACKTICK`";
  const entry =
    "/image/__CAWS_SERVICE_CLIENT_NODE__/entry'$(printf ENTRY_INJECTION)`printf ENTRY_BACKTICK`";
  const expected =
    "#!/bin/bash\n'/image/__CAWS_SERVICE_CLIENT_ENTRY__/node'\\''$(printf NODE_INJECTION)`printf NODE_BACKTICK`' " +
    "'/image/__CAWS_SERVICE_CLIENT_NODE__/entry'\\''$(printf ENTRY_INJECTION)`printf ENTRY_BACKTICK`' \"$@\"\n";
  const rendered = client.renderServiceClientShell(minimal, node, entry);
  // Exact shell bytes are the oracle: both embedded markers and quoted hostile
  // text remain path data. No shell or command substitution is executed here.
  expect(rendered).toBe(expected);
  expect(rendered.match(/__CAWS_SERVICE_CLIENT_ENTRY__/g)).toHaveLength(1);
  expect(rendered.match(/__CAWS_SERVICE_CLIENT_NODE__/g)).toHaveLength(1);
});
async function shellFixture(options = {}) {
  const artifactRoot = process.env.CAWS_SERVICE_CLIENT_TEST_ARTIFACT_ROOT;
  if (artifactRoot && (!path.isAbsolute(artifactRoot) || !fs.statSync(artifactRoot).isDirectory()))
    throw new Error(
      'CAWS_SERVICE_CLIENT_TEST_ARTIFACT_ROOT must be an existing absolute directory'
    );
  const dir = fs.mkdtempSync(
    artifactRoot
      ? path.join(fs.realpathSync(artifactRoot), 'client-')
      : '/tmp/caws-service-client-test-'
  );
  const g = grant({ remainingBudgetMs: options.budget || 250 });
  const shellArgv =
    options.renderArguments === undefined
      ? argv(g)
      : [g.hooksDirectory, g.leaseFile, ...options.renderArguments];
  const library = path.join(dir, 'session-log-daemon-client.sh');
  const grantFile = path.join(dir, 'grant');
  const receiptFile = path.join(dir, 'receipt');
  let grantFd = null;
  let receiptFd = null;
  const sockets = new Set();
  let received = null;
  let requestRaw = Buffer.alloc(0);
  let server = null;
  let connection = null;
  let childClosed = null;
  let childReaped = false;
  let shellStatus = null;
  let childError = null;
  let peerError = null;
  let out = '';
  let err = '';
  let positionedRead = null;
  let fixtureError = null;
  let hasFixtureError = false;
  let fixtureResult = null;
  const cleanupErrors = [];
  const collectCleanup = async (work) => {
    try {
      await work();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };
  let cleaningUp = false;
  const diagnostic = (error) => ({
    name: String(error?.name || 'Error').slice(0, 128),
    message: String(error?.message || error).slice(0, 4096),
  });
  try {
    fs.chmodSync(dir, 0o700);
    fs.writeFileSync(library, client.renderServiceClientShell(template, process.execPath, entry), {
      mode: 0o600,
    });
    fs.writeFileSync(grantFile, options.invalidGrant ? '{bad}\n' : client.encodeServiceGrant(g), {
      mode: 0o600,
    });
    fs.writeFileSync(receiptFile, '', { mode: 0o600 });
    grantFd = fs.openSync(grantFile, 'r');
    // Shared open-file offset is deliberately nonzero; the client must pread.
    fs.readSync(grantFd, Buffer.alloc(3), 0, 3, null);
    receiptFd = fs.openSync(receiptFile, options.readonlyReceipt ? 'r' : 'w');
    server = net.createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      if (cleaningUp) {
        socket.destroy();
        return;
      }
      let bytes = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        bytes = Buffer.concat([bytes, chunk]);
        // Retain actual received bytes even when decoding or the fixture fails.
        requestRaw = Buffer.concat([requestRaw, chunk]);
      });
      socket.on('end', () => {
        if (bytes.length === 0) return;
        try {
          received = client.decodeServiceBridgeRequest(bytes, g);
          if (options.noReply) return;
          const response = options.outcome || frame(received.request).outcome;
          socket.end(
            client.encodeServiceBridgeReply(
              reply(g, received.request, response),
              g,
              received.request
            )
          );
        } catch (error) {
          peerError = error;
          socket.destroy();
        }
      });
    });
    server.on('error', (error) => {
      peerError = error;
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(path.join(dir, 'bridge'), resolve);
    });
    connection = net.createConnection(path.join(dir, 'bridge'));
    connection.on('error', () => {});
    await new Promise((resolve, reject) => {
      connection.once('connect', resolve);
      connection.once('error', reject);
    });
    connection.pause();
    const child = spawn(
      '/bin/bash',
      [
        '-c',
        'source "$1"; shift; if slrd_try_render "$@"; then printf "RENDER_RETURNED\\n"; else printf "INLINE_FALLBACK\\n"; fi; printf "AFTER_HANDLER\\n"',
        'fixture',
        library,
        ...shellArgv,
      ],
      {
        stdio: [
          'ignore',
          'pipe',
          'pipe',
          options.invalidTransport ? 'ignore' : connection,
          options.invalidGrantFd ? 'ignore' : grantFd,
          receiptFd,
        ],
        env: { PATH: '/usr/bin:/bin', HOME: dir, CAWS_SERVICE_OWNER: '/untrusted/not-used' },
      }
    );
    childClosed = new Promise((resolve) => {
      child.once('error', (error) => {
        childError = error;
      });
      child.once('close', (code, signal) => {
        shellStatus = { code, signal };
        childReaped = true;
        resolve(shellStatus);
      });
    });
    child.stdout?.on('data', (b) => {
      out += b;
    });
    child.stderr?.on('data', (b) => {
      err += b;
    });
    connection.destroy();
    const status = await childClosed;
    if (childError) throw childError;
    if (peerError) throw peerError;
    const next = Buffer.alloc(1);
    const count = fs.readSync(grantFd, next, 0, 1, null);
    const grantBytes = fs.readFileSync(grantFile);
    positionedRead = {
      initialOffset: 3,
      bytesRead: count,
      observedNextByte: count === 1 ? next[0] : null,
      expectedNextByte: grantBytes.length > 3 ? grantBytes[3] : null,
      preserved: count === 1 && next[0] === grantBytes[3],
    };
    fixtureResult = {
      ...status,
      out,
      err,
      received,
      requestRaw: Buffer.from(requestRaw),
      receipt: fs.readFileSync(receiptFile),
      offsetPreserved: positionedRead.preserved,
      g,
    };
  } catch (error) {
    fixtureError = error;
    hasFixtureError = true;
  } finally {
    cleaningUp = true;
    const closeSocket = async (socket) => {
      if (!socket || socket.closed) return;
      await new Promise((resolve) => {
        socket.once('close', resolve);
        socket.destroy();
      });
    };
    // Retention never skips teardown: close channels, reap the shell, then close
    // the listener and both parent file descriptors before publishing artifacts.
    await collectCleanup(async () => {
      const closed = await Promise.allSettled([
        closeSocket(connection),
        ...Array.from(sockets, closeSocket),
      ]);
      for (const settlement of closed)
        if (settlement.status === 'rejected') cleanupErrors.push(settlement.reason);
    });
    if (childClosed) await collectCleanup(() => childClosed);
    if (server) {
      await collectCleanup(
        () =>
          new Promise((resolve, reject) =>
            server.close((error) => {
              if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
              else resolve();
            })
          )
      );
    }
    for (const fd of [grantFd, receiptFd]) {
      if (fd === null) continue;
      try {
        fs.closeSync(fd);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    await collectCleanup(() => {
      // No request file exists when no bytes reached the fake owner.
      if (requestRaw.length > 0)
        fs.writeFileSync(path.join(dir, 'request.raw'), requestRaw, { mode: 0o600 });
    });
    await collectCleanup(() => {
      fs.writeFileSync(
        path.join(dir, 'status.json'),
        JSON.stringify(
          {
            componentOnly: true,
            ownerIsFixture: true,
            actualDaemonDispatched: false,
            options,
            exitCode: shellStatus?.code ?? null,
            signal: shellStatus?.signal ?? null,
            stdout: out,
            stderr: err,
            positionedRead,
            requestBytes: requestRaw.length,
            fixtureError: hasFixtureError ? diagnostic(fixtureError) : null,
            cleanup: {
              childStarted: childClosed !== null,
              childReaped,
              socketsClosed: [connection, ...sockets]
                .filter(Boolean)
                .every((socket) => socket.closed),
              errors: cleanupErrors.map(diagnostic),
            },
          },
          null,
          2
        ) + '\n',
        { mode: 0o600 }
      );
    });
    if (artifactRoot) {
      await collectCleanup(() =>
        process.stderr.write(
          'CAWS service-client fixture retained: ' + JSON.stringify(dir).slice(0, 4096) + '\n'
        )
      );
    } else {
      await collectCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
    }
  }
  if (cleanupErrors.length > 0)
    throw new AggregateError(
      hasFixtureError ? [fixtureError, ...cleanupErrors] : cleanupErrors,
      'Service-client fixture cleanup or artifact publication failed'
    );
  if (hasFixtureError) throw fixtureError;
  if (fixtureResult === null) throw new Error('Service-client fixture produced no result');
  return fixtureResult;
}
test('real sourced shell + compiled Node reaches fake FD owner with all fourteen args and positioned grant read', async () => {
  const value = await shellFixture();
  expect(value.code).toBe(0);
  expect(value.signal).toBeNull();
  expect(value.out).toBe('RENDER_RETURNED\nAFTER_HANDLER\n');
  expect(value.err).toBe('');
  expect(value.offsetPreserved).toBe(true);
  expect(value.received.request.arguments).toEqual(argv(value.g).slice(2));
  expect(
    client.decodeServiceClientReceipt(value.receipt, value.g, value.received.request).outcome.kind
  ).toBe('owner_outcome');
});
test.each([
  ['CR', '\r'],
  ['LF', '\n'],
  ['US', '\x1f'],
])(
  'real sourced shell carries model %s through compiled Node to fixture FD owner',
  async (name, control) => {
    const renderArguments = argv().slice(2);
    renderArguments[4] = 'model-before' + control + 'model-after';
    const value = await shellFixture({ renderArguments });
    expect(value.code).toBe(0);
    expect(value.signal).toBeNull();
    expect(value.out).toBe('RENDER_RETURNED\nAFTER_HANDLER\n');
    expect(value.err).toBe('');
    expect(value.offsetPreserved).toBe(true);
    expect(value.received.request.arguments).toEqual(renderArguments);
    // Inspect bytes actually read from FD3, not an encoded replacement request.
    expect(value.requestRaw[value.requestRaw.length - 1]).toBe(10);
    for (const byte of [10, 13, 31])
      expect(value.requestRaw.subarray(0, -1).includes(byte)).toBe(false);
    const raw = JSON.parse(value.requestRaw.subarray(0, -1).toString('utf8'));
    expect(raw.schema).toBe('caws.service.render.bridge.request.v1');
    expect(raw.request.arguments).toEqual(renderArguments);
    expect(raw.request.arguments[4]).toBe(renderArguments[4]);
    expect(raw.request.argumentDigest).toBe(
      hash(JSON.stringify(['caws-session-render-argv-v1', renderArguments]))
    );
    expect(
      client.decodeServiceClientReceipt(value.receipt, value.g, value.received.request).outcome
    ).toEqual({ kind: 'owner_outcome', frame: frame(value.received.request) });
    // Zero observes the synthetic fixture reply only; no actual renderer or
    // daemon is dispatched, and artifact parity is not asserted by this test.
  }
);
test('fixture propagates its primary spawn-argv failure after teardown', async () => {
  const renderArguments = argv().slice(2);
  renderArguments[4] = 'cannot-spawn\0model';
  await expect(shellFixture({ renderArguments })).rejects.toMatchObject({
    code: 'ERR_INVALID_ARG_VALUE',
  });
});
test.each([
  { outcome: { admission: 'accepted', execution: 'queued' } },
  { outcome: { admission: 'accepted', execution: 'unknown' } },
  { outcome: { admission: 'rejected', execution: 'known_not_executed', reason: 'no grant' } },
  { noReply: true, budget: 15 },
  { invalidGrant: true },
  { invalidGrantFd: true },
  { invalidTransport: true },
  { readonlyReceipt: true },
])('whole selected shell exits75 without inline fallback on %j', async (options) => {
  const value = await shellFixture(options);
  expect(value.code).toBe(75);
  expect(value.signal).toBeNull();
  expect(value.out).toBe('');
  expect(value.err).toBe('CAWS session render service unavailable\n');
  if (options.invalidGrant || options.invalidGrantFd) expect(value.receipt.length).toBe(0);
  if (options.invalidGrant || options.invalidGrantFd || options.invalidTransport)
    expect(value.received).toBeNull();
  if (options.noReply)
    expect(
      client.decodeServiceClientReceipt(value.receipt, value.g, value.received.request).outcome
    ).toMatchObject({
      kind: 'client_observation',
      delivery: 'may_have_been_delivered',
      execution: 'unknown',
      reason: 'timeout',
    });
  if (options.readonlyReceipt) {
    expect(value.receipt.length).toBe(0);
    expect(value.received).not.toBeNull();
  }
});
