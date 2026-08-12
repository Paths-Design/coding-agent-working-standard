/**
 * run-tests.js is what `npm test` (and therefore `turbo run test`, and therefore
 * CI) actually executes. Its exit code IS the build verdict, so a wrong exit
 * code is not a test-harness inconvenience — it is a false statement about
 * whether the suite passed.
 *
 * These tests pin the mapping from spawnSync results to that verdict. They run
 * the real control flow (build -> jest -> cleanup, with the precedence rules)
 * against injected spawn results, so a mapping that is correct in isolation but
 * never reached by main() still fails here.
 *
 * [CAWS-DEFECT-TEST-VERDICT-INTEGRITY-01]
 */

const { spawnSync } = require('child_process');
const { main, verdict } = require('../../scripts/run-tests');

/** Collects stderr writes so assertions can read what the operator would see. */
function makeErr() {
  const lines = [];
  const err = (s) => lines.push(s);
  err.text = () => lines.join('');
  return err;
}

/**
 * Builds a `run` double that returns a queued result per invocation and records
 * the (command, args) it was called with, so tests can assert BOTH the verdict
 * and that the step it came from actually ran.
 */
function makeRun(results) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args].join(' '));
    const next = results.shift();
    if (next === undefined) throw new Error(`run() called more times than queued: ${calls.join(' | ')}`);
    return next;
  };
  run.calls = calls;
  return run;
}

const OK = { status: 0, signal: null };
const KILLED = { status: null, signal: 'SIGKILL' };

// ─── the premise: spawnSync really does return a null status on a signal ─────

test('spawnSync reports status null (not 0) when the child dies by signal', () => {
  const r = spawnSync(process.execPath, ['-e', 'process.kill(process.pid, "SIGKILL")']);

  // This is the fact the whole defect rests on: `r.status || 0` would say 0.
  expect(r.status).toBeNull();
  expect(r.signal).toBe('SIGKILL');
});

// ─── verdict(): a null status is a failure, and it says why ──────────────────

test('verdict maps a signal-terminated result to non-zero and names the signal', () => {
  const err = makeErr();

  expect(verdict({ status: null, signal: 'SIGTERM' }, 'jest', err)).not.toBe(0);
  expect(err.text()).toMatch(/SIGTERM/);
});

test('verdict maps a failed spawn to non-zero and surfaces the spawn error message', () => {
  const err = makeErr();
  const result = { status: null, signal: null, error: new Error('spawn npx ENOENT') };

  expect(verdict(result, 'jest', err)).not.toBe(0);
  expect(err.text()).toMatch(/spawn npx ENOENT/);
});

test('verdict passes a real exit code through unchanged', () => {
  const err = makeErr();

  expect(verdict({ status: 0, signal: null }, 'jest', err)).toBe(0);
  expect(verdict({ status: 1, signal: null }, 'jest', err)).toBe(1);
  expect(verdict({ status: 7, signal: null }, 'jest', err)).toBe(7);
  expect(err.text()).toBe('');
});

// ─── main(): the verdict rules reached through the real control flow ─────────

test('a jest run killed by a signal exits non-zero, not 0', () => {
  const err = makeErr();
  const run = makeRun([OK, KILLED, OK]);

  const code = main({ run, err, argv: [] });

  expect(code).not.toBe(0);
  expect(run.calls[1]).toBe('npx jest');
  expect(err.text()).toMatch(/SIGKILL/);
});

test('jest failing to spawn exits non-zero and reports the spawn error', () => {
  const err = makeErr();
  const run = makeRun([OK, { status: null, signal: null, error: new Error('spawn npx ENOENT') }, OK]);

  const code = main({ run, err, argv: [] });

  expect(code).not.toBe(0);
  expect(err.text()).toMatch(/spawn npx ENOENT/);
});

test('an ordinary jest failure still exits with jest exit code', () => {
  const err = makeErr();
  const run = makeRun([OK, { status: 1, signal: null }, OK]);

  expect(main({ run, err, argv: [] })).toBe(1);
});

test('a cleanup failure never masks a jest failure', () => {
  const err = makeErr();
  const run = makeRun([OK, { status: 1, signal: null }, { status: 3, signal: null }]);

  expect(main({ run, err, argv: [] })).toBe(1);
  expect(err.text()).toMatch(/takes precedence/);
});

test('a cleanup failure decides the verdict only when jest passed', () => {
  const err = makeErr();
  const run = makeRun([OK, OK, { status: 3, signal: null }]);

  expect(main({ run, err, argv: [] })).toBe(3);
});

test('a cleanup killed by a signal is a failure, not a 0', () => {
  const err = makeErr();
  const run = makeRun([OK, OK, KILLED]);

  expect(main({ run, err, argv: [] })).not.toBe(0);
});

test('a green run exits 0', () => {
  const err = makeErr();
  const run = makeRun([OK, OK, OK]);

  expect(main({ run, err, argv: [] })).toBe(0);
  expect(err.text()).toBe('');
});

test('a build failure short-circuits: jest never runs and the code is non-zero', () => {
  const err = makeErr();
  const run = makeRun([{ status: 2, signal: null }, OK, OK]);

  expect(main({ run, err, argv: [] })).toBe(2);
  expect(run.calls).toEqual(['npm run build']);
});

test('a build killed by a signal short-circuits with a non-zero code', () => {
  const err = makeErr();
  const run = makeRun([KILLED, OK, OK]);

  expect(main({ run, err, argv: [] })).not.toBe(0);
  expect(run.calls).toEqual(['npm run build']);
  expect(err.text()).toMatch(/SIGKILL/);
});

test('extra CLI arguments are forwarded to jest', () => {
  const err = makeErr();
  const run = makeRun([OK, OK, OK]);

  main({ run, err, argv: ['--coverage', 'tests/shell/foo.test.js'] });

  expect(run.calls[1]).toBe('npx jest --coverage tests/shell/foo.test.js');
});
