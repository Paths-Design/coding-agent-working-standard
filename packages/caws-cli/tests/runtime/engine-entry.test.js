// Actual compiled one-shot entry with a framed native-side test peer.
// This proves entry wiring, not native process ownership or settlement.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { captureSelectionRead } = require('../../dist/init/selection-read-io');
const { setTimeout, clearTimeout } = require('node:timers');
const { RuntimeFrameReader, writeRuntimeFrame } = require('../../dist/runtime/live-protocol');
const { installMachineRuntime } = require('../../dist/init/machine-adapters');
const { sha, verifyRuntime } = require('../../dist/init/machine-runtime-state');

const entry = path.resolve(__dirname, '../../dist/runtime/engine-entry.js');
const cleanup = { groupSettled: true, stdoutEof: true, stderrEof: true, reaped: true };
let root, identity;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-context-entry-')));
  // Resolved Git projects verify their immutable runtime before selection can
  // conclude that project governance is absent. Supply a real private runtime.
  const installed = installMachineRuntime({
    home: path.join(root, 'machine'),
    templatesRoot: path.resolve(__dirname, '../../templates/hook-packs'),
  });
  identity = { id: 'entry-context-git', runtimeDigest: installed.digest };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function withEntry(capability, observe, requestChanges = {}) {
  const marker = path.join(root, 'node-git-executed');
  const executable = path.join(root, 'caller-git');
  const quote = (text) => "'" + text.replace(/'/g, "'\\''") + "'";
  // The legacy control executes this wrapper; native-mode controls must not.
  fs.writeFileSync(executable, '#!/bin/sh\nprintf called > ' + quote(marker) + '\nexit 128\n', {
    mode: 0o755,
  });
  const request = {
    schema: 'caws.runtime.request.v1',
    ...identity,
    surface: 'codex',
    event: 'pre_tool_use',
    configuration: 'system',
    ...(capability === undefined ? {} : { contextGit: capability }),
    sessionCache: 'caws.runtime.session-cache.v1',
    caller: {
      processId: process.pid,
      cwd: root,
      environment: {
        HOME: root,
        CAWS_HOME: path.join(root, 'machine'),
        PATH: '',
        CAWS_GIT_BINARY: executable,
      },
    },
    deadlineEpochMs: Date.now() + 4000,
    inputJson: '{}',
    payload: {},
    ...requestChanges,
  };
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const controller = new globalThis.AbortController();
  const reader = new RuntimeFrameReader(child.stdout);
  let closed = false,
    stderr = '';
  const terminal = new Promise((accept) => {
    child.once('error', (error) => {
      closed = true;
      accept({ error });
    });
    child.once('close', (code, signal) => {
      closed = true;
      accept({ code, signal });
    });
  });
  child.stderr.on('data', (bytes) => {
    stderr += bytes.toString();
  });
  child.stdin.on('error', () => {}); // A deliberate refusal may close stdin before a peer write.
  const timer = setTimeout(() => {
    controller.abort(new Error('Actual engine-entry test deadline expired'));
    if (!closed) child.kill('SIGKILL');
  }, 6000);
  const peer = {
    request,
    executable,
    marker,
    read: async () => JSON.parse((await reader.read(controller.signal)).toString('utf8')),
    write: (frame) => writeRuntimeFrame(child.stdin, frame, controller.signal),
    terminal: async () => ({ ...(await terminal), stderr }),
  };
  try {
    await peer.write(request);
    await observe(peer);
  } finally {
    clearTimeout(timer);
    if (!closed) child.kill('SIGKILL');
    await terminal;
  }
}

function result(request, stdout, changes = {}) {
  return {
    schema: 'caws.runtime.context-git.result.v1',
    id: request.id,
    runtimeDigest: request.runtimeDigest,
    token: request.token,
    ordinal: request.ordinal,
    operation: request.operation,
    status: 'exited',
    exitCode: 0,
    signal: null,
    stdout: Buffer.from(stdout + '\n').toString('base64'),
    stderr: '',
    cleanup: { ...cleanup },
    diagnostic: '',
    ...changes,
  };
}

async function finishInactive(peer, ready) {
  if (ready.schema === 'caws.runtime.failure.v1')
    throw new Error('Expected inactive Ready; actual failure frame: ' + JSON.stringify(ready));
  expect(ready).toMatchObject({ schema: 'caws.runtime.ready.v1', ...identity, active: false });
  await peer.write({ schema: 'caws.runtime.dispatch.v1', ...identity });
  const proposal = await peer.read();
  expect(proposal).toMatchObject({
    schema: 'caws.runtime.proposal.v2',
    ...identity,
    containment: null,
    response: {
      schema: 'caws.runtime.response.v1',
      ...identity,
      result: { exitCode: 0, stdoutBase64: '' },
    },
  });
  await peer.write({
    schema: 'caws.runtime.handoff.v2',
    ...identity,
    token: proposal.token,
    success: true,
    containment: null,
  });
  expect(await peer.terminal()).toEqual({ code: 0, signal: null, stderr: '' });
}

test('actual entry performs both correlated Git exchanges before Ready and preserves dispatch/handoff', async () => {
  await withEntry('caws.runtime.context-git.v1', async (peer) => {
    const checkout = await peer.read();
    expect(checkout).toEqual({
      schema: 'caws.runtime.context-git.request.v1',
      ...identity,
      token: expect.stringMatching(/^[a-f0-9]{64}$/),
      ordinal: 1,
      operation: 'checkout',
      executable: peer.executable,
      cwd: root,
    });
    await peer.write(result(checkout, root));
    const common = await peer.read();
    expect(common).toEqual({ ...checkout, ordinal: 2, operation: 'commonDir', cwd: root });
    await peer.write(result(common, path.join(root, '.git')));
    await finishInactive(peer, await peer.read());
    expect(fs.existsSync(peer.marker)).toBe(false);
  });
});

test.each(['identity', 'cleanup'])(
  'actual entry refuses %s failure before Ready without Node fallback',
  async (failure) => {
    await withEntry('caws.runtime.context-git.v1', async (peer) => {
      const checkout = await peer.read();
      expect(checkout.schema).toBe('caws.runtime.context-git.request.v1');
      const changed =
        failure === 'identity' ? { id: 'foreign' } : { cleanup: { ...cleanup, reaped: false } };
      await peer.write(result(checkout, root, changed));
      expect(await peer.read()).toMatchObject({
        schema: 'caws.runtime.failure.v1',
        ...identity,
        message: expect.stringMatching(failure === 'identity' ? /identity/ : /cleanup/),
      });
      expect(await peer.terminal()).toEqual({ code: 1, signal: null, stderr: '' });
      expect(fs.existsSync(peer.marker)).toBe(false);
    });
  }
);

test('native Git nonzero returns inactive before the second exchange without fallback', async () => {
  await withEntry('caws.runtime.context-git.v1', async (peer) => {
    const checkout = await peer.read();
    expect(checkout).toMatchObject({ ordinal: 1, operation: 'checkout' });
    await peer.write(result(checkout, '', { exitCode: 128 }));
    await finishInactive(peer, await peer.read());
    expect(fs.existsSync(peer.marker)).toBe(false);
  });
});

test('absent capability retains actual legacy context Git rather than requesting native exchanges', async () => {
  await withEntry(undefined, async (peer) => {
    await finishInactive(peer, await peer.read());
    expect(fs.readFileSync(peer.marker, 'utf8')).toBe('called');
  });
});

test('unknown capability is refused by the actual entry before project resolution', async () => {
  await withEntry('caws.runtime.context-git.v2', async (peer) => {
    expect(await peer.terminal()).toMatchObject({
      code: 1,
      signal: null,
      stderr: expect.stringMatching(/Unsupported context Git capability/),
    });
    expect(fs.existsSync(peer.marker)).toBe(false);
  });
});

// Native peer fixture only: fake executable members are never launched. The
// ordinary verifier checks the actual fixture before the mock native summary;
// authentic native generation ownership is covered by separate native tests.
function prepareNativeSelectionFixture() {
  const home = path.join(root, 'machine');
  const stage = path.join(root, 'native-selection-image');
  fs.cpSync(path.join(home, 'lib/runtimes', identity.runtimeDigest), stage, { recursive: true });
  const assets = {
    'native/caws-hook-native': '#!/bin/sh\nexit 0\n',
    'native/node': '#!/bin/sh\nexit 0\n',
    'client/engine.js': '// fixture engine, never executed\n',
    'client/describe.js': '// fixture describe, never executed\n',
    'native-entry.json': JSON.stringify({
      schema: 'caws.runtime.native-entry.v1',
      timeoutMs: 1000,
      nativeExecutable: 'native/caws-hook-native',
      nodeExecutable: 'native/node',
      engineEntry: 'client/engine.js',
      describeEntry: 'client/describe.js',
    }),
  };
  for (const [relative, bytes] of Object.entries(assets)) {
    const file = path.join(stage, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, { mode: relative.startsWith('native/') ? 0o755 : 0o644 });
  }
  const members = [];
  const visit = (directory, prefix = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name),
        relative = prefix + name;
      if (fs.statSync(file).isDirectory()) visit(file, relative + '/');
      else {
        // Legacy installation uses read-only modes. This fixture changes to
        // native layout, whose declared regular-file modes are 0644 or 0755.
        fs.chmodSync(file, fs.statSync(file).mode & 0o111 ? 0o755 : 0o644);
        if (relative !== 'manifest.json') members.push(relative);
      }
    }
  };
  visit(stage);
  const modes = Object.fromEntries(
    [...members, 'native-modes.json']
      .sort()
      .map((relative) => [
        relative,
        relative === 'native-modes.json'
          ? 0o644
          : fs.statSync(path.join(stage, relative)).mode & 0o7777,
      ])
  );
  fs.writeFileSync(path.join(stage, 'native-modes.json'), JSON.stringify(modes), { mode: 0o644 });
  const manifest = Object.fromEntries(
    Object.keys(modes).map((relative) => [
      relative,
      sha(fs.readFileSync(path.join(stage, relative))),
    ])
  );
  const manifestBytes = JSON.stringify(manifest),
    digest = sha(manifestBytes);
  fs.writeFileSync(path.join(stage, 'manifest.json'), manifestBytes, { mode: 0o644 });
  fs.renameSync(stage, path.join(home, 'lib/runtimes', digest));
  fs.writeFileSync(
    path.join(home, 'state/adapter-runtime.json'),
    JSON.stringify({ version: 1, digest, previous_digest: identity.runtimeDigest })
  );
  identity = { ...identity, runtimeDigest: digest };
  expect(verifyRuntime(home, digest)).toEqual(manifest);
}

const selectionAdvertisement = () => ({
  schema: 'caws.runtime.selection-observation.v1',
  snapshotId: 'selection-original-entry',
  limits: { maximumObservations: 4096, maximumBytes: 64 * 1024 * 1024, maximumPathBytes: 16384 },
});
async function finishProjectObservation(peer) {
  const checkout = await peer.read();
  await peer.write(result(checkout, root));
  const common = await peer.read();
  await peer.write(result(common, path.join(root, '.git')));
}
async function selectionReply(peer, request, corrupt = false) {
  const body = Buffer.from(
    JSON.stringify({
      snapshotId: request.snapshotId,
      sequence: request.sequence,
      observationId: 'native-' + request.sequence,
      operation: request.operation,
      result:
        request.operation.kind === 'runtime-generation'
          ? (() => {
              const generation = path.join(root, 'machine/lib/runtimes', identity.runtimeDigest);
              expect(request.operation).toEqual({ kind: 'runtime-generation', path: generation });
              return {
                kind: 'runtime-generation',
                digest: identity.runtimeDigest,
                manifest: JSON.parse(
                  fs.readFileSync(path.join(generation, 'manifest.json'), 'utf8')
                ),
              };
            })()
          : captureSelectionRead(request.operation),
    })
  );
  const common = {
    id: request.id,
    runtimeDigest: request.runtimeDigest,
    snapshotId: request.snapshotId,
    sequence: request.sequence,
  };
  await peer.write({
    schema: 'caws.runtime.selection-observation.result.v1',
    ...common,
    byteLength: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
  });
  for (let offset = 0; offset < body.length; offset += 65536)
    await peer.write({
      schema: 'caws.runtime.selection-observation.chunk.v1',
      ...common,
      offset: corrupt ? offset + 1 : offset,
      base64: body.subarray(offset, offset + 65536).toString('base64'),
    });
}

test('actual entry serializes native selection reads on the existing reader before Ready', async () => {
  prepareNativeSelectionFixture();
  await withEntry(
    'caws.runtime.context-git.v1',
    async (peer) => {
      await finishProjectObservation(peer);
      const requests = [];
      for (;;) {
        const frame = await peer.read();
        if (frame.schema === 'caws.runtime.ready.v1') {
          expect(requests.length).toBeGreaterThan(0);
          expect(requests.map((row) => row.sequence)).toEqual(
            requests.map((_, index) => index + 1)
          );
          expect(
            requests.filter((row) => row.operation.kind === 'runtime-generation')
          ).toHaveLength(1);
          expect(requests.some((row) => row.operation.kind === 'runtime-digest')).toBe(false);
          await finishInactive(peer, frame);
          break;
        }
        expect(frame).toMatchObject({
          schema: 'caws.runtime.selection-observation.request.v1',
          ...identity,
          snapshotId: 'selection-original-entry',
        });
        requests.push(frame);
        await selectionReply(peer, frame);
      }
      expect(fs.existsSync(peer.marker)).toBe(false);
    },
    { selectionObservation: selectionAdvertisement() }
  );
});

test('actual entry malformed native selection chunk fails before Ready without live fallback', async () => {
  prepareNativeSelectionFixture();
  await withEntry(
    'caws.runtime.context-git.v1',
    async (peer) => {
      await finishProjectObservation(peer);
      const request = await peer.read();
      expect(request.schema).toBe('caws.runtime.selection-observation.request.v1');
      await selectionReply(peer, request, true);
      expect(await peer.read()).toMatchObject({
        schema: 'caws.runtime.failure.v1',
        ...identity,
        message: expect.stringMatching(/selection transport chunk/),
      });
      expect(await peer.terminal()).toMatchObject({ code: 1, signal: null });
      expect(fs.existsSync(peer.marker)).toBe(false);
    },
    { selectionObservation: selectionAdvertisement() }
  );
});
