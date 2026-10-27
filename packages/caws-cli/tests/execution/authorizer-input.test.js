'use strict';
const { Readable, PassThrough } = require('node:stream');
const { readAuthorizerInput } = require('../../dist/execution/authorizer-main');
const { MAX_AUTHORIZER_REQUEST_BYTES } = require('../../dist/execution/protocol');
afterEach(() => jest.useRealTimers());
test('complete EOF cancels only the input timer and preserves every byte', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  const input = Readable.from([Buffer.from([0, 0, 0, 2]), Buffer.from('{}')]);
  expect(await readAuthorizerInput(input)).toEqual(Buffer.from([0, 0, 0, 2, 123, 125]));
  expect(jest.getTimerCount()).toBe(0);
  jest.advanceTimersByTime(6000);
  expect(input.errored).toBe(null);
});
test('an open incomplete stream fails at the local input deadline', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  const input = new PassThrough();
  const result = readAuthorizerInput(input);
  input.write(Buffer.from([0, 0]));
  const rejected = expect(result).rejects.toThrow('Authorizer input deadline');
  jest.advanceTimersByTime(5000);
  await rejected;
  expect(input.destroyed).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
});
test('oversized input and stream errors never return buffered partial frames', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  await expect(
    readAuthorizerInput(Readable.from([Buffer.alloc(MAX_AUTHORIZER_REQUEST_BYTES + 5)]))
  ).rejects.toThrow('Authorizer input limit');
  expect(jest.getTimerCount()).toBe(0);
  const input = new PassThrough();
  const result = readAuthorizerInput(input);
  input.write(Buffer.from([0, 0, 0, 1]));
  const rejected = expect(result).rejects.toThrow('fixture stream failed');
  input.destroy(new Error('fixture stream failed'));
  await rejected;
  expect(jest.getTimerCount()).toBe(0);
});
