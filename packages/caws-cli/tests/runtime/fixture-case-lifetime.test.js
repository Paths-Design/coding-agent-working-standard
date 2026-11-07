const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  assertPredecessorSettled,
  runCaseLifetime,
  closeCaseLifetime,
} = require('../helpers/fixture-case-lifetime');

test('receipt failure latches an unfinished case before another fixture can be created', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-case-lifetime-'));
  const next = path.join(root, 'next-fixture');
  const receipt = path.join(root, 'stage');
  let release, unsettled;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const owner = { root, pending: true, closed: false };
  owner.stage = (phase) => fs.writeFileSync(receipt, phase);
  const running = runCaseLifetime(owner, owner.stage, () => pending);
  const write = jest.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
    throw new Error('injected receipt write failure');
  });
  try {
    expect(() =>
      closeCaseLifetime(owner, (value) => {
        unsettled = value;
      })
    ).toThrow('injected receipt write failure');
    expect(unsettled).toBe(owner);
    expect(owner.closed).toBe(true);
    expect(() => {
      assertPredecessorSettled(unsettled);
      fs.mkdirSync(next);
    }).toThrow('Earlier fixture lifetime is unproven');
    expect(fs.existsSync(next)).toBe(false);
    expect(fs.existsSync(root)).toBe(true);
  } finally {
    write.mockRestore();
    release();
    await running;
    fs.rmSync(root, { recursive: true, force: true });
  }
  expect(owner.pending).toBe(false);
  expect(() => assertPredecessorSettled(unsettled)).toThrow('Earlier fixture lifetime is unproven');
});

test('failed initial receipt does not start the body or leave a pending promise', async () => {
  const owner = { pending: true };
  const body = jest.fn();
  await expect(
    runCaseLifetime(
      owner,
      () => {
        throw new Error('receipt unavailable');
      },
      body
    )
  ).rejects.toThrow('receipt unavailable');
  expect(body).not.toHaveBeenCalled();
  expect(owner.pending).toBe(false);
});

test('late receipt failure preserves the original body error', async () => {
  const owner = { pending: true };
  const original = new Error('consumer failed');
  const stage = (phase) => {
    if (phase === 'body-settled') throw new Error('late receipt failed');
  };
  await expect(
    runCaseLifetime(owner, stage, async () => {
      throw original;
    })
  ).rejects.toBe(original);
  expect(owner.retentionFailure).toBe('Error: late receipt failed');
  expect(owner.pending).toBe(false);
});

test('failed final receipt cannot turn a completed body into a passing observation', async () => {
  const owner = { pending: true };
  const error = new Error('final receipt failed');
  const stage = (phase) => {
    if (phase === 'body-settled') throw error;
  };
  await expect(runCaseLifetime(owner, stage, async () => 42)).rejects.toBe(error);
  expect(owner.pending).toBe(false);
});

test('settled cases permit ordinary teardown but unknown state is retained', () => {
  const stage = jest.fn();
  const latch = jest.fn();
  const owner = { root: '/fixture', pending: false, stage };
  expect(() => closeCaseLifetime(owner, latch)).not.toThrow();
  expect(latch).not.toHaveBeenCalled();
  expect(stage).toHaveBeenCalledWith('teardown');
  expect(() => assertPredecessorSettled(undefined)).not.toThrow();
  const unknown = { root: '/unknown', stage };
  expect(() => closeCaseLifetime(unknown, latch)).toThrow('fixture retained in place');
  expect(latch).toHaveBeenCalledWith(unknown);
});
