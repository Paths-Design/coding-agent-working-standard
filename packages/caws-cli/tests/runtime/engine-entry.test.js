// Actual compiled one-shot entry with a framed native-side test peer.
// This proves entry wiring, not native process ownership or settlement.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout, clearTimeout } = require('node:timers');
const { RuntimeFrameReader, writeRuntimeFrame } = require('../../dist/runtime/live-protocol');
const { installMachineRuntime } = require('../../dist/init/machine-adapters');

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

async function withEntry(capability, observe) {
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
