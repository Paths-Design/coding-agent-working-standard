'use strict';

// Test-only IPC. FD3 belongs to the fence and FD4 to the native Git broker;
// FD5 carries instrumentation counters without changing production output.
const fs = require('node:fs');
const context = JSON.parse(process.env.CAWS_TEST_CHILD_COVERAGE);
if (
  !context ||
  typeof context.token !== 'string' ||
  !(context.testId === null || typeof context.testId === 'string') ||
  typeof context.activeMutant !== 'string' ||
  typeof context.instrumented !== 'boolean'
)
  throw new Error('Invalid child coverage context');
const collector = context.instrumented
  ? { static: Object.create(null), perTest: Object.create(null) }
  : null;
const staticHits = collector?.static;
const perTestHits = collector?.perTest;
const namespace = context.instrumented
  ? {
      activeMutant: context.activeMutant || undefined,
      currentTestId: context.testId || undefined,
      mutantCoverage: collector,
    }
  : undefined;
if (context.instrumented) {
  globalThis.__stryker__ = namespace;
}
process.once('exit', () => {
  if (
    context.instrumented &&
    (globalThis.__stryker__ !== namespace ||
      namespace.mutantCoverage !== collector ||
      collector.static !== staticHits ||
      collector.perTest !== perTestHits ||
      namespace.activeMutant !== (context.activeMutant || undefined) ||
      namespace.currentTestId !== (context.testId || undefined))
  )
    throw new Error('Invalid child coverage collector');
  const body = Buffer.from(
    JSON.stringify({
      protocol: 'caws.test.child-coverage.v1',
      token: context.token,
      testId: context.testId,
      activeMutant: context.activeMutant,
      coverage: globalThis.__stryker__?.mutantCoverage ?? null,
    })
  );
  if (body.length > 2 * 1024 * 1024) throw new Error('Child coverage limit');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  const frame = Buffer.concat([header, body]);
  let offset = 0;
  while (offset < frame.length) {
    const count = fs.writeSync(5, frame, offset, frame.length - offset);
    if (count <= 0) throw new Error('Child coverage write failed');
    offset += count;
  }
});
