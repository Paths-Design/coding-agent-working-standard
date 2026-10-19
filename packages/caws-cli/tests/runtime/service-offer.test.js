const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { AbortController } = globalThis;
const { decodeDispatchGrant } = require('../../dist/runtime/live-protocol');
const {
  prepareNativeRenderOffer,
  resolveRenderTools,
} = require('../../dist/runtime/service-offer');
const { SERVICE_IMAGE_TOOLS } = require('../../dist/runtime/service-image');

const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const bytes = (value) => Buffer.from(JSON.stringify(value));
const identity = { id: 'service-offer-invocation', runtimeDigest: 'a'.repeat(64) };
let root;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-service-offer-')));
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function selectionFixture() {
  const canonical = path.join(root, 'project');
  const runtime = path.join(root, 'runtime');
  const stock = (name) => ({
    path: path.join(runtime, name),
    sha256: 'b'.repeat(64),
    entry: name,
    name,
    args: [],
    tier: 'stock',
    kind: 'stock',
  });
  const selected = {
    path: path.join(canonical, '.caws/hooks/session-log.sh'),
    sha256: 'c'.repeat(64),
    entry: 'session-log.sh',
    name: 'session-log.sh',
    args: [],
    tier: 'machine-policy',
    kind: 'project-override',
  };
  return {
    status: 'active',
    canonical,
    checkout: canonical,
    runtimeDirectory: runtime,
    hooksDirectory: runtime,
    runtimeDigest: identity.runtimeDigest,
    surface: 'codex',
    event: 'stop',
    configuration: 'system',
    handlers: [stock('goal-ac-gate.sh'), selected, stock('agent-stop.sh')],
    libraries: {},
    overrides: { 'session-log.sh': selected.path },
    libraryOverrides: {},
    transcriptAdapter: null,
  };
}
function requestFixture(selection = selectionFixture()) {
  const environment = { HOME: root, CAWS_HOME: path.join(root, 'machine'), PATH: '/usr/bin:/bin' };
  const payload = { session_id: 'service-offer-session', cwd: selection.checkout };
  return {
    schema: 'caws.runtime.request.v1',
    ...identity,
    surface: selection.surface,
    event: selection.event,
    configuration: selection.configuration,
    caller: { cwd: selection.checkout, processId: process.pid, environment },
    payload,
    inputJson: JSON.stringify(payload),
    deadlineEpochMs: Date.now() + 30000,
  };
}
function policyFile(selection, home) {
  return path.join(home, 'state/projects', hash(selection.canonical), 'render-service.json');
}
function policyFixture(selection) {
  return {
    version: 1,
    adapter: 'sterling-session-log-broker-v1',
    profile: 'sterling-session-log-codex-stop-v1',
    root: selection.canonical,
    handler: {
      entry: 'session-log.sh',
      path: selection.handlers[1].path,
      sha256: selection.handlers[1].sha256,
    },
    sourceProfileDigest: 'd'.repeat(64),
  };
}
function writePolicy(file, policy) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(policy), { mode: 0o600 });
}

// Direct generated frames exercise protocol shape and correlation. They make
// no native publication, FD-rights, owner-lifetime, source-custody, or parity claim.
function protocolFixture() {
  const selected = selectionFixture();
  const manifest = {
    schema: 'caws.service.render.image.v1',
    adapter: 'sterling-session-log-broker-v1',
    profile: 'sterling-session-log-codex-stop-v1',
    selection: {
      canonicalProject: selected.canonical,
      surface: 'codex',
      event: 'stop',
      configuration: 'system',
      runtimeDigest: selected.runtimeDigest,
      selectedIndex: 1,
      handlers: selected.handlers,
      libraries: [],
    },
    originalClosure: [],
    originalClosureDigest: 'd'.repeat(64),
    sourceGeneration: 'e'.repeat(64),
    execution: {
      root: path.join(root, 'image'),
      dispatcher: 'runtime/dispatch.sh',
      hooks: 'hooks',
      client: 'client/service-client.js',
      handlerRoutes: [],
      resolvedLibraries: [],
      files: [{ path: 'client/service-client.js', sha256: 'f'.repeat(64), bytes: 3, mode: 365 }],
    },
    toolchainTcb: {
      tools: [],
      pythonFlags: ['-I', '-S', '-B'],
      systemDependencies: 'trusted-not-hash-complete',
    },
  };
  const prepared = {
    schema: 'caws.service.prepared.image.v1',
    imageKey: '1'.repeat(64),
    imageDigest: '2'.repeat(64),
    manifest,
    stagingRoot: path.join(root, '.stage-fixture'),
  };
  const offer = {
    schema: 'caws.render.owner.offer.v1',
    prepared,
    expectedSelection: clone(manifest.selection),
    policySha256: '3'.repeat(64),
    checkout: selected.checkout,
    sessionId: 'service-offer-session',
    invocationId: identity.id,
    callerEnvironment: {},
    remainingBudgetMs: 1000,
  };
  const grant = {
    schema: 'caws.service.render.grant.v1',
    grantId: '4'.repeat(64),
    adapter: 'sterling-session-log-broker-v1',
    invocationId: identity.id,
    selectedIndex: 1,
    canonicalProject: selected.canonical,
    sourceGeneration: manifest.sourceGeneration,
    originalSource: {
      handlerSha256: selected.handlers[1].sha256,
      closureDigest: manifest.originalClosureDigest,
    },
    executionImage: { imageDigest: prepared.imageDigest, clientSha256: 'f'.repeat(64) },
    originalHandlerEntry: 'session-log.sh',
    originalHandlerPath: selected.handlers[1].path,
    hooksDirectory: path.join(manifest.execution.root, 'hooks'),
    leaseFile: path.join(selected.canonical, '.caws/sessions/.renderer-daemon.json'),
    remainingBudgetMs: 500,
  };
  const admission = {
    schema: 'caws.service.render.admission.v1',
    grant,
    image: {
      imageKey: prepared.imageKey,
      imageDigest: prepared.imageDigest,
      manifest: clone(manifest),
    },
    descriptors: { transport: 3, grant: 4, receipt: 5 },
    gitDirectory: path.join(root, 'private-git'),
    gitWorkTree: selected.checkout,
    gitOriginalDirectory: path.join(selected.checkout, '.git'),
    gitCommonDirectory: path.join(selected.canonical, '.git'),
  };
  return {
    offer,
    admission,
    frame: { schema: 'caws.runtime.dispatch.v2', ...identity, renderAdmission: admission },
  };
}

test('a matching custom handler alone does not opt in without an operator declaration', () => {
  const selected = selectionFixture(),
    request = requestFixture(selected);
  expect(
    prepareNativeRenderOffer(
      request,
      selected,
      request.caller.environment,
      'service-offer-session',
      request.caller.environment.CAWS_HOME
    )
  ).toBeNull();
  expect(fs.existsSync(path.join(request.caller.environment.CAWS_HOME, 'state'))).toBe(false);
});

test('tool pinning accepts real hard-link aliases while private policy refuses them', () => {
  const selected = selectionFixture(),
    request = requestFixture(selected);
  const bin = path.join(root, 'hard-linked-tools');
  fs.mkdirSync(bin);
  const original = path.join(bin, 'fixture-executable');
  const bytes = '#!/bin/sh\nexit 0\n';
  fs.writeFileSync(original, bytes, { mode: 0o700 });
  for (const name of SERVICE_IMAGE_TOOLS) fs.linkSync(original, path.join(bin, name));
  expect(fs.statSync(original).nlink).toBeGreaterThan(1);
  const tools = resolveRenderTools({ PATH: bin });
  expect(tools.find((tool) => tool.name === 'grep')).toEqual({
    name: 'grep',
    path: path.join(bin, 'grep'),
    sha256: hash(bytes),
  });
  const file = policyFile(selected, request.caller.environment.CAWS_HOME);
  writePolicy(file, policyFixture(selected));
  fs.linkSync(file, path.join(root, 'policy-alias.json'));
  expect(() =>
    prepareNativeRenderOffer(
      request,
      selected,
      request.caller.environment,
      'service-offer-session',
      request.caller.environment.CAWS_HOME
    )
  ).toThrow('regular-file envelope');
});

test.each([
  [
    'project-policy configuration',
    (selected) => {
      selected.configuration = 'project-policy';
    },
  ],
  [
    'different surface',
    (selected) => {
      selected.surface = 'claude-code';
    },
  ],
  [
    'different event',
    (selected) => {
      selected.event = 'pre_tool_use';
    },
  ],
  [
    'stock session handler',
    (selected) => {
      selected.handlers[1].kind = 'stock';
    },
  ],
  [
    'different project override',
    (selected) => {
      selected.handlers[1].entry = 'other.sh';
    },
  ],
])('unsupported %s never creates a service offer', (_name, change) => {
  const selected = selectionFixture(),
    request = requestFixture(selected);
  const file = policyFile(selected, request.caller.environment.CAWS_HOME);
  writePolicy(file, policyFixture(selected));
  change(selected);
  expect(
    prepareNativeRenderOffer(
      request,
      selected,
      request.caller.environment,
      'service-offer-session',
      request.caller.environment.CAWS_HOME
    )
  ).toBeNull();
  expect(fs.existsSync(path.join(path.dirname(file), 'service-images'))).toBe(false);
});

test.each([
  [
    'wrong project',
    (policy) => {
      policy.root += '-other';
    },
  ],
  [
    'wrong selected path',
    (policy) => {
      policy.handler.path += '-other';
    },
  ],
  [
    'wrong selected hash',
    (policy) => {
      policy.handler.sha256 = 'f'.repeat(64);
    },
  ],
  [
    'unknown policy field',
    (policy) => {
      policy.extra = true;
    },
  ],
  [
    'unknown handler field',
    (policy) => {
      policy.handler.extra = true;
    },
  ],
])('explicit declaration rejects %s before preparing an image', (_name, change) => {
  const selected = selectionFixture(),
    request = requestFixture(selected);
  const file = policyFile(selected, request.caller.environment.CAWS_HOME);
  const policy = policyFixture(selected);
  change(policy);
  writePolicy(file, policy);
  expect(() =>
    prepareNativeRenderOffer(
      request,
      selected,
      request.caller.environment,
      'service-offer-session',
      request.caller.environment.CAWS_HOME
    )
  ).toThrow();
  expect(fs.existsSync(path.join(path.dirname(file), 'service-images'))).toBe(false);
});

test.each([null, 'unknown'])(
  'declared service requires a real selected session (%s)',
  (sessionId) => {
    const selected = selectionFixture(),
      request = requestFixture(selected);
    writePolicy(
      policyFile(selected, request.caller.environment.CAWS_HOME),
      policyFixture(selected)
    );
    expect(() =>
      prepareNativeRenderOffer(
        request,
        selected,
        request.caller.environment,
        sessionId,
        request.caller.environment.CAWS_HOME
      )
    ).toThrow('supported invocation');
  }
);

test('explicit declaration emits an offer with an independently selected full ordered chain', () => {
  const selected = selectionFixture(),
    request = requestFixture(selected);
  const policy = policyFixture(selected),
    file = policyFile(selected, request.caller.environment.CAWS_HOME);
  writePolicy(file, policy);
  const bin = path.join(root, 'fixture-tools');
  fs.mkdirSync(bin);
  for (const name of SERVICE_IMAGE_TOOLS)
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const prepared = protocolFixture().offer.prepared;
  // This spy supplies only preparation output; the policy and tool source reads
  // above are real. Actual image preparation has its own reviewed-profile tests.
  prepared.manifest.selection.selectedIndex = 99;
  const build = jest.fn(() => prepared);
  let prepare;
  jest.isolateModules(() => {
    jest.doMock('../../dist/runtime/service-image', () => ({
      ...jest.requireActual('../../dist/runtime/service-image'),
      prepareSessionRenderImage: build,
    }));
    prepare = require('../../dist/runtime/service-offer').prepareNativeRenderOffer;
  });
  jest.dontMock('../../dist/runtime/service-image');
  const offered = prepare(
    request,
    selected,
    { ...request.caller.environment, PATH: bin },
    'service-offer-session',
    request.caller.environment.CAWS_HOME
  );
  expect(build).toHaveBeenCalledTimes(1);
  expect(build.mock.calls[0][0]).toMatchObject({
    selection: selected,
    selectedIndex: 1,
    environment: request.caller.environment,
  });
  expect(offered.prepared).toBe(prepared);
  expect(offered.expectedSelection.selectedIndex).toBe(1);
  expect(offered.expectedSelection.handlers).toEqual(selected.handlers);
  expect(offered.expectedSelection.handlers).not.toBe(selected.handlers);
  expect(offered.policySha256).toBe(hash(fs.readFileSync(file)));
  expect(offered.invocationId).toBe(request.id);
  expect(offered.sessionId).toBe('service-offer-session');
  expect(offered.callerEnvironment).toBe(request.caller.environment);
  expect(offered.remainingBudgetMs).toBeGreaterThan(0);
  expect(offered.remainingBudgetMs).toBeLessThanOrEqual(30000);
  expect(Object.isFrozen(offered.expectedSelection.handlers[1].args)).toBe(true);
});

test('legacy dispatch without an offer is valid, while v2 without an offer and v1 with one are refused', () => {
  const { offer, frame } = protocolFixture();
  const legacy = { schema: 'caws.runtime.dispatch.v1', ...identity };
  expect(decodeDispatchGrant(bytes(legacy), identity)).toBeNull();
  expect(() => decodeDispatchGrant(bytes(frame), identity)).toThrow();
  expect(() => decodeDispatchGrant(bytes(legacy), identity, offer)).toThrow();
  expect(() =>
    decodeDispatchGrant(bytes({ ...legacy, renderAdmission: frame.renderAdmission }), identity)
  ).toThrow();
});

test('v2 dispatch preserves the exact offered image, selected index, request and descriptor mapping', () => {
  const { offer, admission, frame } = protocolFixture();
  const decoded = decodeDispatchGrant(bytes(frame), identity, offer);
  expect(decoded).toEqual(admission);
  expect(decoded.descriptors).toEqual({ transport: 3, grant: 4, receipt: 5 });
  expect(decoded.grant.selectedIndex).toBe(1);
  expect(Object.isFrozen(decoded)).toBe(true);
  expect(Object.isFrozen(decoded.descriptors)).toBe(true);
});

test.each([
  [
    'request id',
    (frame) => {
      frame.id = 'different-invocation';
    },
  ],
  [
    'runtime generation',
    (frame) => {
      frame.runtimeDigest = 'f'.repeat(64);
    },
  ],
  [
    'grant invocation',
    (frame) => {
      frame.renderAdmission.grant.invocationId = 'different-invocation';
    },
  ],
  [
    'grant canonical project',
    (frame) => {
      frame.renderAdmission.grant.canonicalProject += '-other';
    },
  ],
  [
    'grant selected index',
    (frame) => {
      frame.renderAdmission.grant.selectedIndex = 0;
    },
  ],
  [
    'grant source generation',
    (frame) => {
      frame.renderAdmission.grant.sourceGeneration = 'f'.repeat(64);
    },
  ],
  [
    'grant image generation',
    (frame) => {
      frame.renderAdmission.grant.executionImage.imageDigest = 'f'.repeat(64);
    },
  ],
  [
    'image key',
    (frame) => {
      frame.renderAdmission.image.imageKey = 'f'.repeat(64);
    },
  ],
  [
    'image digest',
    (frame) => {
      frame.renderAdmission.image.imageDigest = 'f'.repeat(64);
    },
  ],
  [
    'image executable bytes',
    (frame) => {
      frame.renderAdmission.image.manifest.execution.files[0].sha256 = '0'.repeat(64);
    },
  ],
  [
    'image route',
    (frame) => {
      frame.renderAdmission.image.manifest.execution.root += '-other';
    },
  ],
  [
    'image chain order',
    (frame) => {
      frame.renderAdmission.image.manifest.selection.handlers.reverse();
    },
  ],
  [
    'Git work tree',
    (frame) => {
      frame.renderAdmission.gitWorkTree += '-other';
    },
  ],
  [
    'relative Git directory',
    (frame) => {
      frame.renderAdmission.gitDirectory = 'relative';
    },
  ],
  [
    'noncanonical Git directory',
    (frame) => {
      frame.renderAdmission.gitDirectory += '/../other';
    },
  ],
  [
    'Git path newline',
    (frame) => {
      frame.renderAdmission.gitCommonDirectory += '\n';
    },
  ],
  [
    'extra frame key',
    (frame) => {
      frame.extra = true;
    },
  ],
  [
    'extra admission key',
    (frame) => {
      frame.renderAdmission.extra = true;
    },
  ],
  [
    'extra image key',
    (frame) => {
      frame.renderAdmission.image.extra = true;
    },
  ],
  [
    'extra grant key',
    (frame) => {
      frame.renderAdmission.grant.extra = true;
    },
  ],
  [
    'extra descriptor key',
    (frame) => {
      frame.renderAdmission.descriptors.extra = 6;
    },
  ],
  [
    'wrong transport fd',
    (frame) => {
      frame.renderAdmission.descriptors.transport = 7;
    },
  ],
  [
    'swapped grant/receipt fds',
    (frame) => {
      frame.renderAdmission.descriptors.grant = 5;
      frame.renderAdmission.descriptors.receipt = 4;
    },
  ],
  [
    'stdio fd',
    (frame) => {
      frame.renderAdmission.descriptors.receipt = 2;
    },
  ],
  [
    'string fd',
    (frame) => {
      frame.renderAdmission.descriptors.grant = '4';
    },
  ],
])('v2 dispatch rejects %s rather than borrowing the neighboring invocation', (_name, mutate) => {
  const { offer, frame } = protocolFixture();
  mutate(frame);
  expect(() => decodeDispatchGrant(bytes(frame), identity, offer)).toThrow();
});

test.each([
  ['top-level request', (text) => text.replace('"id":', '"id":"service-offer-invocation","id":')],
  [
    'escaped request key',
    (text) => text.replace('"id":', '"\\u0069d":"service-offer-invocation","id":'),
  ],
  ['descriptor right', (text) => text.replace('"transport":3', '"transport":3,"transport":3')],
  [
    'nested grant source',
    (text) =>
      text.replace('"closureDigest":', '"closureDigest":"' + 'd'.repeat(64) + '","closureDigest":'),
  ],
])(
  'v2 dispatch rejects duplicate %s even when JSON.parse would retain matching values',
  (_name, duplicate) => {
    const { offer, frame } = protocolFixture();
    const raw = JSON.stringify(frame),
      hostile = duplicate(raw);
    expect(hostile).not.toBe(raw);
    expect(JSON.parse(hostile)).toEqual(frame);
    expect(() => decodeDispatchGrant(Buffer.from(hostile), identity, offer)).toThrow();
  }
);

function engineFixture(offered, inactive = false) {
  const selected = selectionFixture(),
    request = requestFixture(selected);
  fs.mkdirSync(selected.canonical, { recursive: true });
  const dispatch = jest.fn(async () => ({
    exitCode: 0,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    offers: [],
    offerReceipts: Buffer.alloc(0),
    executionRecords: Buffer.alloc(0),
  }));
  const dispose = jest.fn();
  const prepareOffer = jest.fn(() => offered);
  const direct = jest.fn(() => {
    throw new Error('unexpected direct stock execution');
  });
  let prepare;
  const mocked = [
    'context',
    'selection',
    'identity',
    'service-offer',
    'service-image',
    'handler-executor',
  ];
  jest.isolateModules(() => {
    jest.doMock('../../dist/runtime/context', () => ({
      ...jest.requireActual('../../dist/runtime/context'),
      resolveRuntimeProject: async () => ({
        status: 'resolved',
        checkout: selected.checkout,
        canonical: selected.canonical,
      }),
    }));
    jest.doMock('../../dist/runtime/selection', () => ({
      resolveInvocationSelection: () =>
        inactive ? { status: 'inactive', reason: 'fixture opt-out' } : selected,
    }));
    jest.doMock('../../dist/runtime/identity', () => ({
      resolveInvocationIdentity: () => ({ sessionId: 'service-offer-session', diagnostic: '' }),
    }));
    jest.doMock('../../dist/runtime/service-offer', () => ({
      prepareNativeRenderOffer: prepareOffer,
    }));
    jest.doMock('../../dist/runtime/service-image', () => ({
      ...jest.requireActual('../../dist/runtime/service-image'),
      disposeNativeRenderAdmission: dispose,
    }));
    jest.doMock('../../dist/runtime/handler-executor', () => ({
      ...jest.requireActual('../../dist/runtime/handler-executor'),
      executeCompatibilityDispatch: dispatch,
      createHandlerExecutor: direct,
    }));
    prepare = require('../../dist/runtime/engine').prepareRuntimeInvocation;
  });
  for (const name of mocked) jest.dontMock('../../dist/runtime/' + name);
  return { prepare, selected, request, dispatch, dispose, prepareOffer, direct };
}

test('engine cannot downgrade an offered invocation to dispatch without native admission', async () => {
  const { offer, admission } = protocolFixture();
  const fixture = engineFixture(offer);
  const invocation = await fixture.prepare(fixture.request, new AbortController().signal);
  expect(invocation.serviceOffer).toBe(offer);
  await expect(invocation.dispatch()).rejects.toThrow('must match the prepared service offer');
  expect(fixture.dispatch).not.toHaveBeenCalled();
  const completed = await invocation.dispatch(admission);
  expect(completed.nativeResult.exitCode).toBe(0);
  expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  expect(fixture.dispatch.mock.calls[0][0].nativeRenderAdmission).toBe(admission);
  expect(fixture.direct).not.toHaveBeenCalled();
  await invocation.acknowledgeHandoff(false);
});

test('engine disposes an unsolicited admission before any handler executes', async () => {
  const { admission } = protocolFixture(),
    fixture = engineFixture(null);
  const invocation = await fixture.prepare(fixture.request, new AbortController().signal);
  expect(invocation.serviceOffer).toBeUndefined();
  await expect(invocation.dispatch(admission)).rejects.toThrow(
    'must match the prepared service offer'
  );
  expect(fixture.dispose).toHaveBeenCalledWith(admission);
  expect(fixture.dispatch).not.toHaveBeenCalled();
  await invocation.acknowledgeHandoff(false);
});

test('inactive engine selection cannot prepare or consume a render offer', async () => {
  const { offer, admission } = protocolFixture(),
    fixture = engineFixture(offer, true);
  const invocation = await fixture.prepare(fixture.request, new AbortController().signal);
  expect(invocation.active).toBe(false);
  expect(invocation.serviceOffer).toBeUndefined();
  expect(fixture.prepareOffer).not.toHaveBeenCalled();
  await expect(invocation.dispatch(admission)).rejects.toThrow('Inactive invocation');
  expect(fixture.dispose).toHaveBeenCalledWith(admission);
  expect(fixture.dispatch).not.toHaveBeenCalled();
});
