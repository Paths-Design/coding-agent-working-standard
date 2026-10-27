'use strict';

// Test-only IPC. FD3 belongs to the real fence or lifecycle-test IPC; FD4
// carries instrumentation counters without changing production wire output.
const fs = require('node:fs');
const context = JSON.parse(process.env.CAWS_TEST_CHILD_COVERAGE);
if (!context || typeof context.token !== 'string' ||
    !(context.testId === null || typeof context.testId === 'string') ||
    typeof context.activeMutant !== 'string') throw new Error('Invalid child coverage context');
if (context.instrumented) {
  globalThis.__stryker__ = { activeMutant: context.activeMutant || undefined, currentTestId: context.testId || undefined };
}
process.once('exit', () => {
  const body = Buffer.from(JSON.stringify({ protocol: 'caws.test.child-coverage.v1', token: context.token, testId: context.testId, activeMutant: context.activeMutant, coverage: globalThis.__stryker__?.mutantCoverage ?? null }));
  if (body.length > 2 * 1024 * 1024) throw new Error('Child coverage limit');
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
  const frame = Buffer.concat([header, body]);
  let offset = 0;
  while (offset < frame.length) {
    const count = fs.writeSync(4, frame, offset, frame.length - offset);
    if (count <= 0) throw new Error('Child coverage write failed');
    offset += count;
  }
});
