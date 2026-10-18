const {
  normalizeNativeResult,
  adapterFailure,
  NativeOutputError,
} = require('../../dist/runtime/native-response');
const { MACHINE_EVENTS } = require('../../dist/init/native-hook-identification');
const { AGENT_SURFACES } = require('../../dist/init/hook-packs/types');
const HOOK_EVENTS = Object.keys(MACHINE_EVENTS);

const context = (event = 'pre_tool_use', surface = 'codex', runtimeDigest = 'digest-a') => ({
  event,
  surface,
  runtimeDigest,
});
const result = (stdout = '', exitCode = 0, stderr = '') => ({ stdout, exitCode, stderr });

test.each(AGENT_SURFACES.filter((s) => s !== 'codex'))(
  'passes %s output through without interpreting it',
  (surface) => {
    const input = result('null\n', 2, 'original stderr');
    expect(normalizeNativeResult(context('stop', surface), input)).toEqual(input);
  }
);

test('Codex bare refusal has a native stderr reason without changing stdout or exit', () => {
  expect(normalizeNativeResult(context(), result('', 2, 'handler error'))).toEqual({
    exitCode: 2,
    stdout: '',
    stderr:
      'handler error\n[caws machine adapter digest-a] CAWS pre_tool_use blocked with exit code 2\n',
  });
});

test.each([
  [
    {
      hookSpecificOutput: { permissionDecisionReason: 'specific' },
      reason: 'reason',
      stopReason: 'stop',
    },
    'specific',
  ],
  [
    { hookSpecificOutput: { permissionDecisionReason: ' ' }, reason: 'reason', stopReason: 'stop' },
    'reason',
  ],
  [{ reason: 7, stopReason: 'stop' }, 'stop'],
  [{ reason: [], stopReason: null }, '{"reason":[],"stopReason":null}'],
])('Codex refusal chooses the meaningful native reason for %j', (output, reason) => {
  const stdout = ' \n' + JSON.stringify(output) + '\n';
  expect(normalizeNativeResult(context('stop'), result(stdout, 2, 'original\n'))).toEqual({
    stdout,
    exitCode: 2,
    stderr: `original\n[caws machine adapter digest-a] ${reason}\n`,
  });
});

test('a plain-text refusal retains its text and native diagnostic', () => {
  expect(normalizeNativeResult(context(), result(' denied \n', 2)).stderr).toBe(
    '[caws machine adapter digest-a] denied\n'
  );
});

test.each(['', ' \n', '{"continue":false}\n', '{}'])(
  'successful Stop preserves empty or structured bytes %j',
  (stdout) => {
    expect(normalizeNativeResult(context('stop'), result(stdout))).toEqual(result(stdout));
  }
);

test('successful plain Stop text becomes a native system message', () => {
  expect(
    normalizeNativeResult(context('stop'), result(' stopped session \n', 0, 'notice\n'))
  ).toEqual(result('{"systemMessage":"stopped session"}\n', 0, 'notice\n'));
});

test.each([
  '{"decision":',
  '[',
  'null',
  '[]',
  'true',
  '42',
  '"text"',
  'NaN',
  'Infinity',
  '-Infinity',
])('malformed/nonobject successful Stop %s is a typed failure', (stdout) => {
  expect(() => normalizeNativeResult(context('stop'), result(stdout))).toThrow(NativeOutputError);
  expect(() => normalizeNativeResult(context('stop'), result(stdout))).toThrow(
    'Malformed Codex Stop JSON'
  );
});

test('non-Stop success and nonzero Stop preserve otherwise malformed native bytes', () => {
  expect(normalizeNativeResult(context(), result('{bad\n', 0, 'notice'))).toEqual(
    result('{bad\n', 0, 'notice')
  );
  expect(normalizeNativeResult(context('stop'), result('null\n', 1))).toEqual(result('null\n', 1));
});

test.each(HOOK_EVENTS)('configuration failure policy is event-specific for %s', async (event) => {
  const actual = await adapterFailure(context(event), 'configuration', 'invalid policy');
  expect(actual).toEqual({
    exitCode: event === 'pre_tool_use' ? 2 : 0,
    stdout:
      event === 'pre_tool_use'
        ? '{"decision":"block","reason":"CAWS machine adapter: invalid policy"}\n'
        : '',
    stderr: '[caws machine adapter] CAWS machine adapter: invalid policy\n',
  });
});

test.each(HOOK_EVENTS)(
  'execution failure cannot silently drop a handler answer for %s',
  async (event) => {
    expect(await adapterFailure(context(event), 'execution', 'unusable result')).toEqual({
      exitCode: 2,
      stdout: '{"decision":"block","reason":"CAWS machine adapter: unusable result"}\n',
      stderr: '[caws machine adapter] CAWS machine adapter: unusable result\n',
    });
  }
);

test('Stop failure budget bounds infrastructure refusal and never resets implicitly', async () => {
  let charges = 0;
  const budget = {
    charge: jest.fn(async () => (++charges <= 3 ? 'refuse' : 'release')),
    reset: jest.fn(),
  };
  const outcomes = [];
  for (let i = 0; i < 4; i++)
    outcomes.push(await adapterFailure(context('stop'), 'execution', 'broken', budget));
  expect(outcomes.map((r) => r.exitCode)).toEqual([2, 2, 2, 0]);
  expect(JSON.parse(outcomes[3].stdout).systemMessage).toContain(
    'releasing this stop over an unmet, undeliverable condition'
  );
  expect(outcomes[3].stderr).toContain('CAWS machine adapter: broken');
  expect(budget.charge).toHaveBeenCalledTimes(4);
  expect(budget.reset).not.toHaveBeenCalled();
});

test('unpersistable Stop budget releases explicitly instead of refusing forever', async () => {
  const budget = {
    charge: async () => {
      throw new Error('unwritable journal');
    },
    reset: jest.fn(),
  };
  const actual = await adapterFailure(context('stop'), 'execution', 'broken output', budget);
  expect(actual.exitCode).toBe(0);
  expect(JSON.parse(actual.stdout).systemMessage).toContain('failure budget released');
  expect(actual.stderr).toContain('releasing this stop');
  expect(budget.reset).not.toHaveBeenCalled();
});

test('configuration, other events and valid guard Stop refusals never consume the budget', async () => {
  const budget = { charge: jest.fn(async () => 'release'), reset: jest.fn() };
  expect((await adapterFailure(context('stop'), 'configuration', 'bad', budget)).exitCode).toBe(0);
  expect((await adapterFailure(context(), 'execution', 'bad', budget)).exitCode).toBe(2);
  expect(
    normalizeNativeResult(context('stop'), result('{"decision":"block","reason":"AC unmet"}', 2))
      .exitCode
  ).toBe(2);
  expect(budget.charge).not.toHaveBeenCalled();
  expect(budget.reset).not.toHaveBeenCalled();
});

test('interleaved requests retain their own context and budget outcomes', async () => {
  let finish;
  const pending = adapterFailure(context('stop'), 'execution', 'session-a', {
    charge: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    reset: async () => {},
  });
  const other = await adapterFailure(
    context('stop', 'codex', 'digest-b'),
    'execution',
    'session-b',
    {
      charge: async () => 'refuse',
      reset: async () => {},
    }
  );
  finish('release');
  expect(JSON.parse(other.stdout)).toEqual({
    decision: 'block',
    reason: 'CAWS machine adapter: session-b',
  });
  expect(JSON.parse((await pending).stdout).systemMessage).toContain('session-a');
  expect(
    normalizeNativeResult(context('pre_tool_use', 'codex', 'digest-b'), result('', 2)).stderr
  ).toContain('digest-b');
});
