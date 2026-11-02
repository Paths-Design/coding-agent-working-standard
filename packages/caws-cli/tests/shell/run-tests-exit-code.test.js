/**
 * run-tests.js is what `npm test` (and therefore `turbo run test`, and therefore
 * CI) actually executes. Its exit code IS the build verdict, so a wrong exit
 * code is not a test-harness inconvenience — it is a false statement about
 * whether the suite passed.
 *
 * These tests pin the mapping from spawnSync results to that verdict. They run
 * the real control flow (prerequisites -> jest -> cleanup, with the precedence rules)
 * against injected spawn results, so a mapping that is correct in isolation but
 * never reached by main() still fails here.
 *
 * [CAWS-DEFECT-TEST-VERDICT-INTEGRITY-01]
 */

const { spawnSync } = require('child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
    if (next === undefined)
      throw new Error(`run() called more times than queued: ${calls.join(' | ')}`);
    return next;
  };
  run.calls = calls;
  return run;
}

const OK = { status: 0, signal: null };
const KILLED = { status: null, signal: 'SIGKILL' };

test('child environment helper preserves its input and does not mutate process.env on import', () => {
  const helper = require.resolve('../../scripts/lib/node-process-env.cjs');
  const imported = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const before = JSON.stringify(process.env);
    require(${JSON.stringify(helper)});
    if (JSON.stringify(process.env) !== before) process.exit(1);
    console.log('unchanged');
  `,
    ],
    { env: { ...process.env }, encoding: 'utf8' }
  );
  expect({ status: imported.status, stderr: imported.stderr, stdout: imported.stdout }).toEqual({
    status: 0,
    stderr: '',
    stdout: 'unchanged\n',
  });
  const { nodeProcessEnv } = require('../../scripts/lib/node-process-env.cjs');
  const env = Object.freeze({
    PATH: '/conflicting/bin',
    KEEP_ME: 'kept',
    Path: 'distinct-posix-key',
  });
  expect(nodeProcessEnv(env)).toEqual({
    ...env,
    PATH: path.dirname(fs.realpathSync(process.execPath)) + path.delimiter + env.PATH,
  });
  expect(nodeProcessEnv({ KEEP_ME: 'kept' }).PATH).toBe(
    path.dirname(fs.realpathSync(process.execPath))
  );
});

test('Windows child environment emits one PATH key with Node lexical casing semantics', () => {
  const { nodeProcessEnv } = require('../../scripts/lib/node-process-env.cjs');
  const env = Object.freeze({ Path: 'second', PATH: 'first', path: 'third', KEEP_ME: 'kept' });
  expect(nodeProcessEnv(env, 'win32')).toEqual({
    KEEP_ME: 'kept',
    PATH: path.dirname(fs.realpathSync(process.execPath)) + ';first',
  });
  expect(nodeProcessEnv({ Path: 'only', KEEP_ME: 'kept' }, 'win32')).toEqual({
    KEEP_ME: 'kept',
    PATH: path.dirname(fs.realpathSync(process.execPath)) + ';only',
  });
});

test('ordinary launcher binds real npm and env-node children despite conflicting ambient PATH', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-node-launch-'));
  const put = (name, text) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  try {
    const runner = put(
      'scripts/run-tests.js',
      fs.readFileSync(require.resolve('../../scripts/run-tests'))
    );
    const helper = path.resolve(__dirname, '../../scripts/lib/node-process-env.cjs');
    if (fs.existsSync(helper)) put('scripts/lib/node-process-env.cjs', fs.readFileSync(helper));
    put(
      'package.json',
      JSON.stringify({
        private: true,
        scripts: {
          'test:prepare': 'node observe.cjs prepare',
          'test:cleanup': 'node observe.cjs cleanup',
        },
      })
    );
    put(
      'observe.cjs',
      `const fs = require('node:fs');
      fs.appendFileSync(process.env.OBSERVATIONS, JSON.stringify({ stage: process.argv[2],
        node: fs.realpathSync(process.execPath), kept: process.env.KEEP_ME }) + '\\n');`
    );
    const jest = put(
      'node_modules/jest/bin/jest.js',
      '#!/usr/bin/env node\nprocess.argv[2] = "jest"; require("../../../observe.cjs");\n'
    );
    put(
      'node_modules/jest/package.json',
      JSON.stringify({ name: 'jest', version: '1.0.0', bin: { jest: 'bin/jest.js' } })
    );
    fs.mkdirSync(path.join(root, 'node_modules/.bin'), { recursive: true });
    fs.chmodSync(jest, 0o755);
    fs.symlinkSync('../jest/bin/jest.js', path.join(root, 'node_modules/.bin/jest'));
    const conflicting = put(
      'conflicting/node',
      '#!/bin/sh\nprintf touched >> "$CONFLICT_SENTINEL"\nexit 91\n'
    );
    fs.chmodSync(conflicting, 0o755);
    const log = path.join(root, 'observations.jsonl'),
      sentinel = path.join(root, 'conflict');
    const env = {
      ...process.env,
      PATH: path.dirname(conflicting) + path.delimiter + process.env.PATH,
      OBSERVATIONS: log,
      CONFLICT_SENTINEL: sentinel,
      KEEP_ME: 'preserved',
      npm_config_offline: 'true',
      npm_config_cache: path.join(root, 'cache'),
    };
    const run = () =>
      spawnSync(process.execPath, [runner], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
    const result = run();
    expect({
      error: result.error,
      signal: result.signal,
      status: result.status,
      stderr: result.stderr,
    }).toEqual({ error: undefined, signal: null, status: 0, stderr: '' });
    expect(fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)).toEqual(
      ['prepare', 'jest', 'cleanup'].map((stage) => ({
        stage,
        node: fs.realpathSync(process.execPath),
        kept: 'preserved',
      }))
    );
    expect(fs.existsSync(sentinel)).toBe(false);
    // Remove the production binding in a copied fixture: this must activate the conflicting Node.
    const source = fs.readFileSync(runner, 'utf8');
    expect(source).toContain('env: nodeProcessEnv(),');
    fs.writeFileSync(runner, source.replace('env: nodeProcessEnv(),', ''));
    const unbound = run();
    expect(unbound.status).not.toBe(0);
    expect(fs.readFileSync(sentinel, 'utf8')).toContain('touched');
    // npm intentionally prepends package-local .bin. Preserve that resolution
    // contract and propagate the supplied Node stub's failure without masking it.
    fs.writeFileSync(runner, source);
    fs.unlinkSync(sentinel);
    const before = fs.readFileSync(log, 'utf8');
    fs.copyFileSync(conflicting, path.join(root, 'node_modules/.bin/node'));
    fs.chmodSync(path.join(root, 'node_modules/.bin/node'), 0o755);
    const localOverride = run();
    expect(localOverride.status).not.toBe(0);
    expect(fs.readFileSync(sentinel, 'utf8')).toContain('touched');
    expect(fs.readFileSync(log, 'utf8')).toBe(before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
  const run = makeRun([
    OK,
    { status: null, signal: null, error: new Error('spawn npx ENOENT') },
    OK,
  ]);

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

test('a prerequisite failure short-circuits: jest never runs and the code is non-zero', () => {
  const err = makeErr();
  const run = makeRun([{ status: 2, signal: null }, OK, OK]);

  expect(main({ run, err, argv: [] })).toBe(2);
  expect(run.calls).toEqual(['npm run test:prepare']);
});

test('a prerequisite killed by a signal short-circuits with a non-zero code', () => {
  const err = makeErr();
  const run = makeRun([KILLED, OK, OK]);

  expect(main({ run, err, argv: [] })).not.toBe(0);
  expect(run.calls).toEqual(['npm run test:prepare']);
  expect(err.text()).toMatch(/SIGKILL/);
});

test('extra CLI arguments are forwarded to jest', () => {
  const err = makeErr();
  const run = makeRun([OK, OK, OK]);

  main({ run, err, argv: ['--coverage', 'tests/shell/foo.test.js'] });

  expect(run.calls[1]).toBe('npx jest --coverage tests/shell/foo.test.js');
});
