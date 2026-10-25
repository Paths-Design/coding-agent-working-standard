'use strict';
const { AbortController } = globalThis;
const { createNativeStopLeaseContextPort } = require('../../dist/runtime/stop-lease-context');
const base = {
  id: 'late',
  runtimeDigest: 'a'.repeat(64),
  configuration: 'system',
  surface: 'opencode',
  event: 'stop',
  stopLeaseContext: 'caws.runtime.stop-lease-context.v1',
  deadlineEpochMs: Date.now() + 60000,
};
function fixture(change = {}) {
  let sent;
  const transport = {
    write: jest.fn(async (frame) => {
      sent = frame;
    }),
    read: jest.fn(async () =>
      Buffer.from(
        JSON.stringify({
          schema: 'caws.runtime.stop-lease-context.result.v1',
          id: sent.id,
          runtimeDigest: sent.runtimeDigest,
          token: sent.token,
          consumerIndex: 3,
          status: 'resolved',
          commonDir: '/admitted/.git',
          ...change,
        })
      )
    ),
  };
  return {
    port: createNativeStopLeaseContextPort(base, transport, new AbortController().signal),
    transport,
  };
}
test('late port emits only fixed consumer/correlation, consumes once, and preserves settled Git failure', async () => {
  const { port, transport } = fixture();
  await expect(port.observe()).resolves.toEqual({
    status: 'resolved',
    commonDir: '/admitted/.git',
  });
  expect(Object.keys(transport.write.mock.calls[0][0]).sort()).toEqual(
    ['schema', 'id', 'runtimeDigest', 'token', 'consumerIndex'].sort()
  );
  expect(transport.write.mock.calls[0][0].consumerIndex).toBe(3);
  await expect(port.observe()).rejects.toThrow('consumed');
  expect(transport.write).toHaveBeenCalledTimes(1);
  await expect(fixture({ status: 'git_failed', commonDir: null }).port.observe()).resolves.toEqual({
    status: 'git_failed',
    commonDir: null,
  });
});
test.each([
  { consumerIndex: 2 },
  { id: 'neighbor' },
  { cwd: '/forged' },
  { commonDir: 'relative' },
  { status: 'cleanup_unsettled' },
])('malformed or forged late result fails without replay: %j', async (change) => {
  const { port, transport } = fixture(change);
  await expect(port.observe()).rejects.toThrow();
  await expect(port.observe()).rejects.toThrow('consumed');
  expect(transport.write).toHaveBeenCalledTimes(1);
});
test('early unsupported domain cannot even construct a late request port', () => {
  for (const change of [
    { stopLeaseContext: undefined },
    { surface: 'codex' },
    { event: 'session_end' },
  ])
    expect(() =>
      createNativeStopLeaseContextPort({ ...base, ...change }, {}, new AbortController().signal)
    ).toThrow();
});
