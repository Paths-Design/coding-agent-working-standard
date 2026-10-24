// Control admission and consumer connection checks; these do not prove native
// custody, SQL/profile qualification, filesystem publication or local cutover.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { decodeDispatchGrant } = require('../../dist/runtime/live-protocol');
const { RuntimeProtocolError } = require('../../dist/runtime/protocol');
const { createNativeStopPrefixPort } = require('../../dist/runtime/session-cache-client');
const context = require('../../dist/runtime/context');
const stock = require('../../dist/runtime/stock-handlers');
const eligibility = require('../../dist/runtime/eligibility');
const publication = require('../../dist/runtime/session-store-publication');
const executor = require('../../dist/runtime/handler-executor');
const {
  prepareRuntimeInvocation,
  NATIVE_STOP_PRODUCTION_LIMITS,
} = require('../../dist/runtime/engine');
const identity = { id: 'stop-connection', runtimeDigest: 'a'.repeat(64) };
const requestBase = {
  ...identity,
  surface: 'opencode',
  event: 'stop',
  configuration: 'system',
  stopPrefix: 'caws.runtime.stop-prefix.v1',
  sessionStore: 'caws.runtime.transcript-store.v1',
  sessionPublication: 'caws.runtime.session-publication.v1',
};
const selector = {
  schema: 'caws.runtime.stop-admission.v1',
  loggerIndex: 2,
  sqlProfile: 'cpython-3.11.13-unicode14-int4300',
  rendererProfile: 'cpython3.11-json/int-max-str-digits:4300',
  rendererIntegerMaxDigits: 4300,
};
const grant = (nativeStop = selector) => ({
  schema: 'caws.runtime.dispatch.v3',
  ...identity,
  nativeStop,
});
const bytes = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
const decode = (frame = grant(), request = requestBase, offer) =>
  decodeDispatchGrant(bytes(frame), request, offer);
const completedPrefix = {
  status: 'completed',
  prefixComplete: true,
  envelopePublished: true,
  pointerPublished: true,
  agentPid: 'not_found',
  reap: 'not_run',
  diagnostic: null,
};
const completedHandler = { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };

test('Stop selectors require exact fields, identity, matching numeric profiles and invocation capabilities', () => {
  expect(decode()).toEqual(selector);
  expect(
    decode(
      grant({
        ...selector,
        sqlProfile: 'cpython-3.11.13-unicode14-int0',
        rendererProfile: 'cpython3.11-json/int-max-str-digits:0',
        rendererIntegerMaxDigits: 0,
      })
    )
  ).toMatchObject({ rendererIntegerMaxDigits: 0 });
  for (const change of [
    { surface: 'zcode' },
    { event: 'session_end' },
    { configuration: 'project' },
    { stopPrefix: undefined },
    { sessionStore: undefined },
    { sessionPublication: undefined },
  ])
    expect(() => decode(grant(), { ...requestBase, ...change })).toThrow();
  for (const change of [
    { loggerIndex: 1 },
    { rendererIntegerMaxDigits: 0 },
    { sqlProfile: 'unknown' },
    { rendererProfile: 'cpython3.11-json/int-max-str-digits:0' },
    { authority: true },
  ])
    expect(() => decode(grant({ ...selector, ...change }))).toThrow();
  for (const change of [{ id: 'neighbor' }, { runtimeDigest: 'b'.repeat(64) }, { extra: true }])
    expect(() => decode({ ...grant(), ...change })).toThrow();
  expect(() => decode(undefined, requestBase, {})).toThrow();
  for (const text of [
    JSON.stringify(grant()).replace('"loggerIndex":2', '"loggerIndex":1,"loggerIndex":2'),
    JSON.stringify(grant()).replace(
      '"id":"stop-connection"',
      '"id":"wrong","id":"stop-connection"'
    ),
  ])
    expect(() => decode(text)).toThrow();
  expect(
    decodeDispatchGrant(bytes({ schema: 'caws.runtime.dispatch.v1', ...identity }), identity)
  ).toBeNull();
  for (const malformed of [Buffer.from([0xff]), Buffer.from('{')])
    expect(() => decodeDispatchGrant(malformed, requestBase)).toThrow(RuntimeProtocolError);
  expect(() => decodeDispatchGrant(Buffer.alloc(4097, 0xff), requestBase)).toThrow(
    'Control frame exceeds byte limit'
  );
});

test('Stop prefix uses its own correlated previous/decision exchange and preserves a received effect result on cancellation', async () => {
  const writes = [],
    controller = new globalThis.AbortController();
  const request = { ...requestBase, payload: { session_id: 'supplied' } };
  let reads = 0;
  const port = createNativeStopPrefixPort(
    request,
    {
      async write(frame, signal) {
        expect(signal).toBe(controller.signal);
        writes.push(frame);
      },
      async read(signal) {
        expect(signal).toBe(controller.signal);
        const common = {
          id: writes[0].id,
          runtimeDigest: writes[0].runtimeDigest,
          token: writes[0].token,
        };
        if (++reads === 1)
          return bytes({
            schema: 'caws.runtime.stop-prefix.previous.v1',
            ...common,
            existingBase64: bytes({ session_id: 'supplied', created_at: 'prior' }).toString(
              'base64'
            ),
          });
        controller.abort(new Error('after native effects'));
        return bytes({
          schema: 'caws.runtime.stop-prefix.result.v1',
          ...common,
          ...completedPrefix,
        });
      },
    },
    controller.signal
  );
  await expect(port.capture('/canonical')).resolves.toEqual(completedPrefix);
  expect(writes[0]).toMatchObject({
    schema: 'caws.runtime.stop-prefix.request.v1',
    ...identity,
    canonicalRoot: '/canonical',
  });
  expect(writes[1]).toMatchObject({
    schema: 'caws.runtime.stop-prefix.decision.v1',
    action: 'capture',
    createdUnits: [112, 114, 105, 111, 114],
  });
  await expect(port.capture('/canonical')).rejects.toThrow('single-use');
});

let root, request, selection, trace, controller, prefix, store, nativePublication, compatibility;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-stop-connection-')));
  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(runtime);
  fs.mkdirSync(path.join(root, '.caws'));
  trace = [];
  selection = {
    status: 'active',
    ...identity,
    runtimeDigest: identity.runtimeDigest,
    surface: 'opencode',
    event: 'stop',
    configuration: 'system',
    checkout: root,
    canonical: root,
    runtimeDirectory: runtime,
    hooksDirectory: runtime,
    overrides: {},
    libraryOverrides: {},
    libraries: {},
    transcriptAdapter: null,
    handlers: ['first.sh', 'second.sh', 'session-log.sh', 'last.sh'].map((name) => {
      const file = path.join(runtime, name);
      fs.writeFileSync(file, '#!/bin/bash\nexit 93\n', { mode: 0o755 });
      return {
        name,
        path: file,
        entry: name,
        args: [],
        kind: 'stock',
        tier: 'repo-policy',
        sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      };
    }),
  };
  request = {
    schema: 'caws.runtime.request.v1',
    ...requestBase,
    deadlineEpochMs: Date.now() + 10000,
    payload: { cwd: root, session_id: 'supplied' },
    caller: {
      cwd: root,
      processId: process.pid,
      environment: { HOME: root, CAWS_HOME: root, CAWS_HOOK_ADVISORY_DEDUP: '0' },
    },
  };
  request.inputJson = JSON.stringify(request.payload);
  controller = new globalThis.AbortController();
  prefix = {
    capture: jest.fn(async () => {
      trace.push('prefix');
      return completedPrefix;
    }),
  };
  store = { surface: 'opencode' };
  jest
    .spyOn(context, 'resolveRuntimeProject')
    .mockResolvedValue({ status: 'resolved', checkout: root, canonical: root });
  jest.spyOn(stock, 'tryExecuteStockHandler').mockImplementation(async (handler) => {
    trace.push(handler.name);
    return completedHandler;
  });
  jest.spyOn(eligibility, 'handlerEligibility').mockReturnValue({ status: 'run' });
  nativePublication = jest
    .spyOn(publication, 'executeNativeStopPublication')
    .mockImplementation(async () => {
      trace.push('publication');
      return { ...completedHandler, stdout: Buffer.from('native logger') };
    });
  compatibility = jest
    .spyOn(executor, 'executeCompatibilityDispatch')
    .mockRejectedValue(new Error('compatibility replay'));
});
afterEach(() => {
  const retain = process.env.CAWS_STOP_CONNECTION_ARTIFACT_DIR;
  if (retain) {
    const test = expect.getState().currentTestName;
    const directory = path.join(
      retain,
      crypto.createHash('sha256').update(test).digest('hex').slice(0, 16)
    );
    fs.mkdirSync(directory, { recursive: true });
    fs.cpSync(root, path.join(directory, 'fixture'), { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'observation.json'),
      JSON.stringify(
        {
          test,
          trace,
          prefixCalls: prefix.capture.mock.calls.length,
          publicationCalls: nativePublication.mock.calls.length,
          compatibilityCalls: compatibility.mock.calls.length,
          boundary:
            'Mocked native publication; real composer, executor file checks and journal only',
        },
        null,
        2
      )
    );
  }
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
const prepare = () =>
  prepareRuntimeInvocation(
    request,
    controller.signal,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => selection,
    prefix,
    store
  );

test('mandatory prefix precedes ordinary composition and logger publication occupies index two', async () => {
  const prepared = await prepare();
  const result = await prepared.dispatch(undefined, decode());
  expect(trace).toEqual(['prefix', 'first.sh', 'second.sh', 'publication', 'last.sh']);
  expect(Buffer.from(result.nativeResult.stdout).toString()).toContain('native logger');
  expect(nativePublication.mock.calls[0][0]).toMatchObject({
    ...NATIVE_STOP_PRODUCTION_LIMITS,
    port: store,
    canonicalRoot: root,
    sessionId: 'supplied',
    deadlineEpochMs: request.deadlineEpochMs,
    sqlProfile: selector.sqlProfile,
    rendererProfile: { id: selector.rendererProfile, integerMaxDigits: 4300 },
  });
  expect(compatibility).not.toHaveBeenCalled();
});

test('reprieving the logger preserves the mandatory prefix and ordinary ordered handlers', async () => {
  eligibility.handlerEligibility.mockImplementation((handler) =>
    handler.name === 'session-log.sh'
      ? { status: 'reprieved', reason: 'fixture native reprieve' }
      : { status: 'run' }
  );
  const prepared = await prepare();
  await prepared.dispatch(undefined, decode());
  expect(trace).toEqual(['prefix', 'first.sh', 'second.sh', 'last.sh']);
  expect(nativePublication).not.toHaveBeenCalled();
  expect(compatibility).not.toHaveBeenCalled();
});

test.each(['declined', 'incomplete', 'lost', 'publication'])(
  'attempted native %s failure never falls back or retries',
  async (kind) => {
    if (kind === 'declined')
      prefix.capture.mockResolvedValue({
        status: 'declined',
        prefixComplete: false,
        envelopePublished: false,
        pointerPublished: false,
        agentPid: 'not_run',
        reap: 'not_run',
        diagnostic: 'declined',
      });
    if (kind === 'incomplete')
      prefix.capture.mockResolvedValue({
        ...completedPrefix,
        status: 'unavailable',
        prefixComplete: false,
        diagnostic: 'partial',
      });
    if (kind === 'lost') prefix.capture.mockRejectedValue(new Error('lost prefix frame'));
    if (kind === 'publication')
      nativePublication.mockRejectedValue(new Error('publication failed after acquisition'));
    const prepared = await prepare();
    await expect(prepared.dispatch(undefined, decode())).rejects.toThrow();
    expect(prefix.capture).toHaveBeenCalledTimes(1);
    expect(nativePublication).toHaveBeenCalledTimes(kind === 'publication' ? 1 : 0);
    expect(compatibility).not.toHaveBeenCalled();
    await expect(prepared.dispatch(undefined, decode())).rejects.toThrow('single-use');
  }
);

test('logger source is reverified after prefix effects before native publication', async () => {
  prefix.capture.mockImplementation(async () => {
    fs.appendFileSync(selection.handlers[2].path, '# source changed\n');
    return completedPrefix;
  });
  const prepared = await prepare();
  await expect(prepared.dispatch(undefined, decode())).rejects.toThrow('changed after selection');
  expect(nativePublication).not.toHaveBeenCalled();
  expect(compatibility).not.toHaveBeenCalled();
});

test.each([{ BASH_ENV: '/foreign/startup' }, { CAWS_PRIOR_BASH_ENV: '/prior/startup' }])(
  'ambient startup disagreement fails before the prefix: %j',
  async (environment) => {
    Object.assign(request.caller.environment, environment);
    const prepared = await prepare();
    await expect(prepared.dispatch(undefined, decode())).rejects.toThrow('disagrees');
    expect(prefix.capture).not.toHaveBeenCalled();
    expect(compatibility).not.toHaveBeenCalled();
  }
);

test.each([{}, { BASH_ENV: '' }, { CAWS_PRIOR_BASH_ENV: '' }])(
  'absent and empty ambient startup remain inert: %j',
  async (environment) => {
    Object.assign(request.caller.environment, environment, {
      BASH_ENV: environment.BASH_ENV ?? path.join(selection.runtimeDirectory, 'handler-env.sh'),
    });
    const prepared = await prepare();
    await prepared.dispatch(undefined, decode());
    expect(prefix.capture).toHaveBeenCalledTimes(1);
  }
);
