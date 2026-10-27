'use strict';
const { mergeCoverage, spawnCoveredSync } = require('./child-coverage.cjs');
const saved = globalThis.__stryker__;
afterEach(() => {
  if (saved === undefined) delete globalThis.__stryker__;
  else globalThis.__stryker__ = saved;
});
const context = {
  token: 'owned-token',
  testId: 'known test',
  activeMutant: '',
  instrumented: true,
};
function frame(coverage, overrides = {}) {
  const body = Buffer.from(
    JSON.stringify({
      protocol: 'caws.test.child-coverage.v1',
      token: context.token,
      testId: context.testId,
      activeMutant: '',
      coverage,
      ...overrides,
    })
  );
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
describe('test-only child coverage protocol contract', () => {
  test('adds counters to the existing collector and preserves unrelated observations', () => {
    const parent = { mutantCoverage: { static: { 0: 2 }, perTest: { other: { 1: 3 } } } };
    globalThis.__stryker__ = parent;
    const payload = frame({ static: { 0: 1 }, perTest: { 'known test': { 2: 4 } } });
    mergeCoverage(payload, context, parent);
    mergeCoverage(payload, context, parent);
    expect(globalThis.__stryker__).toBe(parent);
    expect(parent.mutantCoverage).toEqual({
      static: { 0: 4 },
      perTest: { other: { 1: 3 }, 'known test': { 2: 8 } },
    });
  });
  test('missing, malformed, unknown-test and empty dry-run coverage are failures', () => {
    const parent = {};
    globalThis.__stryker__ = parent;
    const valid = { static: {}, perTest: { 'known test': { 2: 1 } } };
    for (const input of [
      Buffer.alloc(0),
      Buffer.from('invalid'),
      frame(null),
      frame({ static: {}, perTest: {} }),
      frame(valid, { token: 'other' }),
      frame(valid, { testId: 'unknown' }),
      frame(valid, { activeMutant: '17' }),
      frame({ static: {}, perTest: { unknown: { 2: 1 } } }),
      frame({ static: { 2: 0 }, perTest: {} }),
      frame({ static: { 2: 1.5 }, perTest: {} }),
      frame({ static: { invalid: 1 }, perTest: {} }),
    ])
      expect(() => mergeCoverage(input, context, parent)).toThrow();
    expect(parent).toEqual({});
  });
  test('requires complete single frame and the same parent collector', () => {
    const parent = {};
    globalThis.__stryker__ = parent;
    const payload = frame({ static: { 3: 1 }, perTest: {} });
    expect(() => mergeCoverage(Buffer.concat([payload, payload]), context, parent)).toThrow();
    globalThis.__stryker__ = {};
    expect(() => mergeCoverage(payload, context, parent)).toThrow();
    expect(parent).toEqual({});
  });
  test('normal noninstrumented child preserves stdout, stderr and nonzero exit status', () => {
    delete globalThis.__stryker__;
    const child = spawnCoveredSync(
      process.execPath,
      ['-e', 'process.stdout.write("out");process.stderr.write("err");process.exitCode=2;'],
      { encoding: 'utf8', timeout: 2000 }
    );
    expect(child.status).toBe(2);
    expect(child.stdout).toBe('out');
    expect(child.stderr).toBe('err');
  });
});
