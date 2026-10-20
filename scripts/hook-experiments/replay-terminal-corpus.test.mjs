import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArguments, runReplay, snapshotBuild } from './replay-terminal-corpus.mjs';

const RUNNER = fileURLToPath(new URL('./replay-terminal-corpus.mjs', import.meta.url));
const sha = (/** @type {string | Uint8Array} */ bytes) => createHash('sha256').update(bytes).digest('hex');
const ALLOW = { decision: 'allow', reason: 'reviewed fixture', source: 'unknown', enforcement: 'pass' };
// Ordinary controls test refusal semantics, not a two-second startup SLA.
// Admission includes Node startup, source verification and executable hashing.
const ORDINARY_WORKER_WATCHDOG_MS = 10000;
const RETAINED = ['sample.json', 'classifications.jsonl', 'worker.stderr', 'replay.json', 'worker-state.json', 'build-manifest.json'];

/** @param {string} directory */
async function unlockDirectories(directory) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  await chmod(directory, 0o700);
  for (const name of await readdir(directory)) await unlockDirectories(path.join(directory, name));
}

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const parent = process.env.CAWS_REPLAY_TEST_ARTIFACT_ROOT;
  if (parent) {
    assert.ok(path.isAbsolute(parent), 'retained artifact root must be absolute');
    await mkdir(parent, { recursive: true });
  }
  const root = await mkdtemp(path.join(parent ?? tmpdir(), 'replay-test-'));
  if (!parent) t.after(async () => { await unlockDirectories(root); await rm(root, { recursive: true, force: true }); });
  await writeFile(path.join(root, 'fixture.json'), JSON.stringify({
    schema: 'caws.replay_test_fixture.v1', test_name: t.name,
    node_version: process.version, node_executable: process.execPath,
  }, null, 2) + '\n', { flag: 'wx' });
  const buildRoot = path.join(root, 'build');
  await mkdir(buildRoot);
  return { root, buildRoot, classifier: path.join(buildRoot, 'index.js'), corpus: path.join(root, 'corpus.jsonl'), output: path.join(root, 'output') };
}

/** @param {string} file */
async function exists(file) {
  try { await access(file); return true; } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** @param {string} body */
const classifierSource = body => `exports.classifyCommand = function(command, context) {\n${body}\n};\n`;
/** @param {unknown} value */
const returned = value => classifierSource(`return ${JSON.stringify(value)};`);
/** @param {string} command @param {number} offset */
const item = (command, offset = 0) => ({ command, command_sha256: sha(command), offset });

/** @typedef {{code:number|null,signal:NodeJS.Signals|null,timedOut:boolean,stdout:Buffer,stderr:Buffer}} ChildResult */
/** @param {string[]} args @param {string | Uint8Array} input @param {string} cwd @param {number} [timeoutMs]
 * @returns {Promise<ChildResult>}
 */
async function capture(args, input, cwd, timeoutMs = 6000) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, HOME: cwd }, stdio: ['pipe', 'pipe', 'pipe'] });
    /** @type {Buffer[]} */ const stdout = [];
    /** @type {Buffer[]} */ const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.stdin.on('error', () => { /* Close/exit below remains the observation. */ });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    child.stdin.end(input);
  });
}

/** @param {string} file */
async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
/** @param {string} output */
async function classifications(output) {
  const text = await readFile(path.join(output, 'classifications.jsonl'), 'utf8');
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

/** @param {string} output @param {'complete'|'deadline'} [expectation] */
async function terminal(output, expectation = 'complete') {
  const state = await readJson(path.join(output, 'worker-state.json'));
  assert.equal(state.schema, 'caws.replay_worker_state.v1');
  assert.equal(state.terminal_observed, true, 'a parent timeout or promise rejection is not a child terminal receipt');
  assert.ok(Number.isSafeInteger(state.pid) && state.pid > 0, 'receipt identifies the actual child');
  assert.equal(state.stdout_eof, true);
  assert.equal(state.stderr_eof, true);
  assert.equal(state.stdio_forced_closed, false, 'forced pipe closure is not observed EOF');
  assert.ok(state.exit_code !== null || typeof state.signal === 'string', 'retain actual exit or signal');
  assert.equal(typeof state.complete, 'boolean');
  if (expectation === 'complete') {
    assert.equal(state.timed_out, false, 'a refusal row followed by a watchdog kill is incomplete');
    assert.equal(state.complete, true);
    assert.equal(state.exit_code, 0);
    assert.equal(state.signal, null);
  }
  return state;
}

/** @param {Awaited<ReturnType<typeof fixture>>} f @param {string} source @param {string} [command] @param {number} [workerTimeoutMs] */
async function replayFixture(f, source, command = 'echo harmless fixture', workerTimeoutMs = ORDINARY_WORKER_WATCHDOG_MS) {
  await writeFile(f.classifier, source);
  await writeFile(f.corpus, JSON.stringify({ command, harness: 'codex', outcome: { status: 'success' } }) + '\n');
  return await runReplay({ ...f, perStratum: 24, workerTimeoutMs });
}

/** Run the same reviewed module with ordinary Node capabilities before testing its offline refusal.
 * This is a private positive child, not an untrusted corpus command.
 * @param {Awaited<ReturnType<typeof fixture>>} f @param {string} sentinel @param {string} expected
 */
async function positiveEffect(f, sentinel, expected) {
  const positive = path.join(f.root, 'outside-positive.cjs');
  await writeFile(positive, 'const selected = require(process.argv[2]); selected.classifyCommand("reviewed positive", {});\n');
  const result = await capture([positive, f.classifier], '', f.root);
  await writeFile(path.join(f.root, 'positive.stdout'), result.stdout);
  await writeFile(path.join(f.root, 'positive.stderr'), result.stderr);
  const command = { argv: [process.execPath, positive, f.classifier], cwd: f.root,
    exit_code: result.code, signal: result.signal, timed_out: result.timedOut };
  await writeFile(path.join(f.root, 'positive.command.json'), JSON.stringify(command));
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 0, result.stderr.toString());
  const observed = await readFile(sentinel);
  await writeFile(path.join(f.root, 'positive-effect.bin'), observed, { flag: 'wx' });
  await writeFile(path.join(f.root, 'positive-effect.json'), JSON.stringify({
    schema: 'caws.replay_positive_effect.v1', sentinel_path: sentinel,
    observation_boundary: 'after_positive_child_close_before_sentinel_removal',
    positive_command: command, expected_utf8: expected,
    observed_bytes: [...observed], observed_length: observed.length,
    observed_hex: observed.toString('hex'), observed_sha256: sha(observed),
  }, null, 2) + '\n', { flag: 'wx' });
  assert.equal(observed.toString('utf8'), expected, 'the positive must actually reach the attempted effect');
  await rm(sentinel);
  const absent = !(await exists(sentinel));
  await writeFile(path.join(f.root, 'positive-removal.json'), JSON.stringify({
    schema: 'caws.replay_positive_removal.v1', sentinel_path: sentinel,
    observation_boundary: 'after_sentinel_removal', sentinel_absent_observed: absent,
    positive_command: command, positive_effect_sha256: sha(observed),
  }, null, 2) + '\n', { flag: 'wx' });
  assert.equal(absent, true);
}

/** Initialization is a child observation even when no corpus item is selected.
 * @param {string} output @param {string} status
 */
async function initialization(output, status) {
  const state = await terminal(output);
  const receipt = await readJson(path.join(output, 'initialization-receipt.json'));
  assert.equal(receipt.schema, 'caws.replay_initialization.v1');
  assert.equal(receipt.pid, state.pid);
  assert.equal(receipt.phase, 'initialization');
  assert.equal(receipt.status, status);
  assert.equal(state.completion_scope, 'transport_only');
  assert.equal(state.initialization_receipt_valid, true);
  assert.equal(state.initialization_status, status);
  assert.deepEqual(state.initialization, receipt);
  const report = await readJson(path.join(output, 'replay.json'));
  assert.equal(report.initialization_status, status);
  assert.deepEqual(report.initialization, receipt);
  return { state, receipt, report };
}

/** @param {string} output @param {string} marker */
async function redactedArtifacts(output, marker) {
  for (const name of [...RETAINED, 'initialization-receipt.json']) {
    const bytes = await readFile(path.join(output, name));
    assert.equal(bytes.includes(Buffer.from(marker)), false, 'private corpus marker leaked into ' + name);
  }
}

const ZERO_ITEM_CORPORA = [
  { name: 'empty', corpus: '', malformed: 0 },
  { name: 'all malformed', corpus: 'not JSON\n{"command":7}\n', malformed: 2 },
];

for (const { name, corpus, malformed } of ZERO_ITEM_CORPORA) {
  test(`${name} corpus succeeds only after an observed ready initialization`, async t => {
    const f = await fixture(t);
    await writeFile(f.classifier, returned(ALLOW));
    await writeFile(f.corpus, corpus);
    const result = await runReplay({ ...f, workerTimeoutMs: ORDINARY_WORKER_WATCHDOG_MS });
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.records, 0);
    assert.equal(result.report.malformed, malformed);
    assert.equal(result.report.sampled, 0);
    assert.equal(result.report.returned, 0);
    assert.deepEqual(await classifications(f.output), []);
    const { state } = await initialization(f.output, 'ready');
    assert.equal(state.rows_expected, 0);
    assert.equal(state.rows_returned, 0);
  });
}

for (const { name, corpus, malformed } of ZERO_ITEM_CORPORA) {
  test(`${name} corpus cannot hide a refused initialization file write`, async t => {
    const f = await fixture(t);
    const sentinel = path.join(f.root, 'empty-initialization-effect');
    const source = `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'bootstrap effect');\n` + returned(ALLOW);
    await writeFile(f.classifier, source);
    await positiveEffect(f, sentinel, 'bootstrap effect');
    await writeFile(f.corpus, corpus);
    const result = await runReplay({ ...f, workerTimeoutMs: ORDINARY_WORKER_WATCHDOG_MS });
    assert.equal(result.exitCode, 1);
    assert.equal(await exists(sentinel), false);
    assert.equal(result.report.records, 0);
    assert.equal(result.report.malformed, malformed);
    assert.equal(result.report.sampled, 0);
    assert.deepEqual(await classifications(f.output), []);
    const { state, receipt } = await initialization(f.output, 'execution_attempt_refused');
    assert.equal(receipt.operation, 'file write');
    assert.equal(state.rows_expected, 0);
    assert.equal(state.rows_returned, 0);
  });
}

for (const [name, source] of [
  ['unsupported import', 'require("node:inspector");\n' + returned(ALLOW)],
  ['missing classifier export', 'exports.unrelated = true;\n'],
]) {
  test(`empty corpus cannot hide ${name} during initialization`, async t => {
    const f = await fixture(t);
    await writeFile(f.classifier, source);
    await writeFile(f.corpus, '');
    const result = await runReplay({ ...f, workerTimeoutMs: ORDINARY_WORKER_WATCHDOG_MS });
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.sampled, 0);
    assert.deepEqual(await classifications(f.output), []);
    const { state } = await initialization(f.output, 'unsupported_build');
    assert.equal(state.rows_expected, 0);
    assert.equal(state.rows_returned, 0);
  });
}

test('empty corpus observes an initialization VM timeout independently of item rows', async t => {
  const f = await fixture(t);
  await writeFile(f.classifier, 'for (;;) {}\n' + returned(ALLOW));
  await writeFile(f.corpus, '');
  const result = await runReplay({ ...f, workerTimeoutMs: ORDINARY_WORKER_WATCHDOG_MS });
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.sampled, 0);
  assert.deepEqual(await classifications(f.output), []);
  const { state } = await initialization(f.output, 'timeout');
  assert.equal(state.rows_expected, 0);
  assert.equal(state.rows_returned, 0);
  assert.equal(state.timed_out, false, 'outer startup kill is not an observed initialization VM timeout');
});

for (const ready of [true, false]) {
  test(`public worker with zero items ${ready ? 'accepts ready initialization' : 'fails refused initialization'}`, async t => {
    const f = await fixture(t);
    const source = ready ? returned(ALLOW) : 'console.log("private bootstrap output");\n' + returned(ALLOW);
    await writeFile(f.classifier, source);
    const receipt = path.join(f.root, 'empty-worker-state.json');
    const result = await capture([RUNNER, '--worker', '--classifier', f.classifier, '--build-root', f.buildRoot,
      '--worker-timeout-ms', String(ORDINARY_WORKER_WATCHDOG_MS), '--receipt', receipt], '', f.root,
    ORDINARY_WORKER_WATCHDOG_MS + 6000);
    await writeFile(path.join(f.root, 'empty-worker.stdout'), result.stdout);
    await writeFile(path.join(f.root, 'empty-worker.stderr'), result.stderr);
    assert.equal(result.timedOut, false);
    assert.equal(result.code, ready ? 0 : 1);
    assert.equal(result.stdout.length, 0, 'bootstrap outcomes do not invent corpus rows');
    assert.equal(result.stderr.includes(Buffer.from('private bootstrap output')), false);
    const state = await readJson(receipt);
    assert.ok(Number.isSafeInteger(state.pid) && state.pid > 0);
    assert.equal(state.terminal_observed, true);
    assert.equal(state.stdout_eof, true);
    assert.equal(state.stderr_eof, true);
    assert.equal(state.stdio_forced_closed, false);
    assert.equal(state.timed_out, false);
    assert.equal(state.exit_code, 0, 'private protocol transport completes even for semantic initialization refusal');
    assert.equal(state.signal, null);
    assert.equal(state.complete, true);
    assert.equal(state.completion_scope, 'transport_only');
    assert.equal(state.rows_expected, 0);
    assert.equal(state.rows_returned, 0);
    assert.equal(state.initialization_receipt_valid, true);
    assert.equal(state.initialization_status, ready ? 'ready' : 'execution_attempt_refused');
    assert.equal(state.initialization.pid, state.pid);
    assert.equal(state.initialization.phase, 'initialization');
    assert.equal(state.initialization.status, state.initialization_status);
    if (!ready) assert.equal(state.initialization.operation, 'output');
  });
}

for (const [name, body] of [
  ['mutated Unsupported code', "try { require('node:inspector'); } catch (error) { error.code = command; throw error; }"],
  ['new Unsupported constructor', "try { require('node:inspector'); } catch (error) { throw new error.constructor(command); }"],
  ['overridden VM transport metadata', `globalThis.__postInvocationJSON = function () {
  return JSON.stringify({status:'unsupported_build', phase:'invocation', reason_code:'unsupported_builtin_or_external',
    source:command, context_probes:[command], private_detail:command});
};
return ${JSON.stringify(ALLOW)};`],
]) {
  test(`${name} cannot publish private corpus bytes as worker metadata`, async t => {
    const f = await fixture(t);
    const marker = 'PRIVATE_REPLAY_COMMAND_METADATA_9fc4c1';
    const result = await replayFixture(f, classifierSource(body), marker);
    assert.equal((await readFile(f.corpus)).includes(Buffer.from(marker)), true, 'the private marker must actually be in the input');
    assert.equal(result.exitCode, 1);
    const { state } = await initialization(f.output, 'ready');
    assert.equal(state.rows_expected, 1);
    assert.equal(state.rows_returned, 1, 'an admitted child must return a row; preflight rejection is not metadata normalization evidence');
    const rows = await classifications(f.output);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].command_sha256, sha(marker));
    assert.notEqual(rows[0].status, 'classified');
    assert.equal(rows[0].reason, undefined);
    assert.equal(rows[0].private_detail, undefined);
    assert.ok(Object.keys(rows[0]).every(key => ['status', 'phase', 'operation', 'reason_code', 'error_type',
      'decision', 'source', 'enforcement', 'context_probes', 'reason_sha256', 'command_sha256', 'offset',
      'elapsed_ns', 'decision_authority'].includes(key)), 'output fields belong to the declared safe protocol');
    await redactedArtifacts(f.output, marker);
  });
}

test('CLI requires an explicit reviewed build and a positive integer sample bound', () => {
  const parsed = parseArguments(['--corpus', '/fixture/corpus', '--classifier', '/fixture/build/index.js', '--build-root', '/fixture/build', '--output', '/fixture/output']);
  assert.equal(Reflect.get(parsed ?? {}, 'perStratum'), 24);
  for (const count of ['0', '-1', '1.5', 'NaN', '9007199254740992'])
    assert.throws(() => parseArguments(['--corpus', '/c', '--classifier', '/b/i.js', '--build-root', '/b', '--output', '/o', '--per-stratum', count]));
  assert.throws(() => parseArguments(['--corpus', '/c', '--classifier', '/b/i.js', '--output', '/o']));
});

test('the selected actual typed classifier consumes a shell command as data', async t => {
  const f = await fixture(t);
  const actualRoot = process.env.CAWS_REPLAY_TEST_CLASSIFIER_ROOT ?? path.resolve(path.dirname(RUNNER), '../../packages/caws-cli/dist');
  assert.ok(path.isAbsolute(actualRoot), 'actual compiled classifier root must be absolute');
  const actualEntry = path.join(actualRoot, 'runtime/classifier/index.js');
  const classifierDirectory = path.join(f.buildRoot, 'runtime/classifier');
  await mkdir(classifierDirectory, { recursive: true });
  for (const name of await readdir(path.dirname(actualEntry))) {
    if (name.endsWith('.js')) await copyFile(path.join(path.dirname(actualEntry), name), path.join(classifierDirectory, name));
  }
  await mkdir(path.join(f.buildRoot, 'store'));
  await copyFile(path.join(actualRoot, 'store/git-binary.js'), path.join(f.buildRoot, 'store/git-binary.js'));
  const classifier = path.join(classifierDirectory, 'index.js');
  const buildRoot = f.buildRoot;
  assert.equal(sha(await readFile(classifier)), sha(await readFile(actualEntry)));
  const sentinel = path.join(f.root, 'must-not-exist');
  const command = 'touch ' + JSON.stringify(sentinel);
  await writeFile(f.corpus, [command, 'rm -rf /'].map(command => JSON.stringify({ command, harness: 'codex' })).join('\n') + '\n');
  const result = await runReplay({ corpus: f.corpus, classifier, buildRoot, output: f.output });
  assert.equal(result.exitCode, 0);
  assert.equal(await exists(sentinel), false);
  const rows = await classifications(f.output);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].command_sha256, sha(command));
  assert.equal(rows[0].status, 'classified');
  assert.equal(rows[1].decision, 'deny');
  assert.equal(rows[1].enforcement, 'block');
  assert.equal(rows[1].status, 'classified');
  const manifest = await readJson(path.join(f.output, 'build-manifest.json'));
  assert.equal(manifest.profile, 'caws.reviewed_cjs_offline.v1');
  const entry = manifest.files.find((/** @type {{path:string}} */ row) => row.path === manifest.entry);
  assert.ok(entry, 'the actual entry must be named in consumed-byte custody');
  assert.equal(entry.sha256, sha(await readFile(classifier)));
  assert.equal(result.report.build_sha256, manifest.build_sha256);
  assert.equal((await terminal(f.output)).complete, true);
});

for (const phase of ['initialization', 'invocation']) {
  test(`admitted direct file writes are refused during ${phase}, after an actual outside positive`, async t => {
    const f = await fixture(t);
    const sentinel = path.join(f.root, 'direct-effect');
    const effect = `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, ${JSON.stringify(phase)});`;
    const source = phase === 'initialization' ? effect + '\n' + returned(ALLOW) : classifierSource(effect + '\nreturn ' + JSON.stringify(ALLOW) + ';');
    await writeFile(f.classifier, source);
    await positiveEffect(f, sentinel, phase);
    const result = await replayFixture(f, source);
    assert.equal(result.exitCode, 1);
    assert.equal(await exists(sentinel), false);
    const rows = await classifications(f.output);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'execution_attempt_refused', 'rejecting the selected build is not execution-boundary evidence');
    assert.equal(rows[0].phase, phase);
    assert.equal(rows[0].operation, 'file write');
    await terminal(f.output);
  });
}

for (const escape of ['require', 'imported function', 'caught error', 'global object', 'global prototype']) {
  for (const phase of ['initialization', 'invocation']) {
    test(`${escape} constructors cannot acquire host process during ${phase}`, async t => {
      const f = await fixture(t);
      const sentinel = path.join(f.root, 'constructor-effect');
      const suffix = `const hostFs = typeof hostProcess.getBuiltinModule === 'function'
  ? hostProcess.getBuiltinModule('node:fs')
  : hostProcess.mainModule.require('node:fs');
hostFs.writeFileSync(${JSON.stringify(sentinel)}, 'escaped');`;
      const attempt = escape === 'require'
        ? `const hostProcess = require.constructor('return process')();\n${suffix}`
        : escape === 'imported function'
          ? `const hostProcess = require('node:path').join.constructor('return process')();\n${suffix}`
          : escape === 'global object'
            ? `const hostProcess = globalThis.constructor.constructor('return process')();\n${suffix}`
            : escape === 'global prototype'
              ? `const hostProcess = Object.getPrototypeOf(globalThis).constructor.constructor('return process')();\n${suffix}`
              : `try { require('node:path').join(null); } catch (error) { const hostProcess = error.constructor.constructor('return process')();\n${suffix} }`;
      const source = phase === 'initialization' ? attempt + '\n' + returned(ALLOW) : classifierSource(attempt + '\nreturn ' + JSON.stringify(ALLOW) + ';');
      await writeFile(f.classifier, source);
      await positiveEffect(f, sentinel, 'escaped');
      const result = await replayFixture(f, source);
      assert.equal(result.exitCode, 1);
      assert.equal(await exists(sentinel), false);
      const rows = await classifications(f.output);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'execution_attempt_refused');
      assert.equal(rows[0].phase, phase);
      assert.equal(rows[0].operation, 'code generation');
      await terminal(f.output);
    });
  }
}

test('all five offline ports return unavailable observations without reading, consuming or spawning', async t => {
  const f = await fixture(t);
  const sentinel = path.join(f.root, 'existing-private-token');
  await writeFile(sentinel, 'must survive');
  const body = `const p = context.ports;
const observed = [p.git(['status'], '/caws-offline/repo'), p.read(${JSON.stringify(sentinel)}), p.isFile(${JSON.stringify(sentinel)}), p.realpath('/caws-offline/repo'), p.consumeFile(${JSON.stringify(sentinel)})];
const expected = [{status:-1, stdout:''}, null, false, '/caws-offline/repo', false];
if (JSON.stringify(observed) !== JSON.stringify(expected)) throw new Error('offline observations were not unavailable');
return {decision:'allow', reason:JSON.stringify(observed), source:'unknown', enforcement:'pass'};`;
  const result = await replayFixture(f, classifierSource(body));
  assert.equal(result.exitCode, 0);
  const rows = await classifications(f.output);
  assert.equal(rows[0].status, 'classified');
  assert.deepEqual([...new Set(rows[0].context_probes)].sort(), ['consumeFile', 'git', 'isFile', 'read', 'realpath']);
  assert.equal(rows[0].decision_authority, 'context_missing');
  assert.equal(rows[0].reason_sha256, sha(JSON.stringify([{ status: -1, stdout: '' }, null, false, '/caws-offline/repo', false])));
  assert.equal(await readFile(sentinel, 'utf8'), 'must survive');
  await terminal(f.output);
});

test('an admitted process spawn is refused after an actual private outside positive', async t => {
  const f = await fixture(t);
  const sentinel = path.join(f.root, 'spawn-effect');
  const inner = `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'spawned');`;
  const source = classifierSource(`require('node:child_process').spawnSync(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(inner)}]);\nreturn ${JSON.stringify(ALLOW)};`);
  await writeFile(f.classifier, source);
  await positiveEffect(f, sentinel, 'spawned');
  const result = await replayFixture(f, source);
  assert.equal(result.exitCode, 1);
  assert.equal(await exists(sentinel), false);
  const rows = await classifications(f.output);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'execution_attempt_refused');
  assert.equal(rows[0].phase, 'invocation');
  assert.equal(rows[0].operation, 'process spawn');
  await terminal(f.output);
});

test('sampling preserves UTF-8 byte offsets, occurrence ties, strata and report redaction', async t => {
  const f = await fixture(t);
  const secret = 'PRIVATE_FIXTURE_COMMAND';
  const commands = [secret, secret, secret, 'éclair', 'another command'];
  const lines = commands.map(command => Buffer.from(JSON.stringify({ command, harness: 'codex', outcome: { status: 'success' } }) + '\n'));
  lines.push(Buffer.from(JSON.stringify({ command: 'é'.repeat(256), harness: 'unrecognized', outcome: { status: 'invented' } }) + '\n'));
  lines.push(Buffer.from(JSON.stringify({ command: 'é'.repeat(4096), harness: 'dsh', outcome: { status: 'error' } }) + '\n'));
  lines.push(Buffer.from('not JSON\n'), Buffer.from([255, 10]), Buffer.from('{"command":7}\n'));
  const corpus = Buffer.concat(lines);
  await writeFile(f.corpus, corpus);
  await writeFile(f.classifier, returned({ ...ALLOW, reason: 'PRIVATE_FIXTURE_REASON' }));
  const result = await runReplay({ ...f, perStratum: 2 });
  assert.equal(result.exitCode, 0);
  const report = result.report;
  assert.equal(report.corpus_sha256, sha(corpus));
  assert.equal(report.corpus_bytes, corpus.length);
  assert.equal(report.records, 7);
  assert.equal(report.malformed, 3);
  assert.deepEqual(report.census, { 'codex/success/short': 5, 'dsh/error/large': 1, 'unknown/unknown/medium': 1 });
  let offset = 0;
  const candidates = commands.map((command, index) => {
    const row = { offset, command_sha256: sha(command), stratum: 'codex/success/short', bytes: Buffer.byteLength(command) };
    offset += lines[index].length;
    return row;
  });
  const expected = candidates.sort((a, b) => a.command_sha256.localeCompare(b.command_sha256) || a.offset - b.offset).slice(0, 2);
  expected.push({ offset, command_sha256: sha('é'.repeat(256)), stratum: 'unknown/unknown/medium', bytes: 512 });
  offset += lines[5].length;
  expected.push({ offset, command_sha256: sha('é'.repeat(4096)), stratum: 'dsh/error/large', bytes: 8192 });
  expected.sort((a, b) => a.offset - b.offset);
  assert.deepEqual(await readJson(path.join(f.output, 'sample.json')), expected);
  const rows = await classifications(f.output);
  assert.deepEqual(rows.map(row => [row.offset, row.command_sha256]), expected.map(row => [row.offset, row.command_sha256]));
  assert.equal(report.returned, expected.length);
  assert.equal(report.commands_executed, 0);
  for (const name of RETAINED) {
    const bytes = await readFile(path.join(f.output, name), 'utf8');
    assert.equal(bytes.includes(secret), false, name);
    assert.equal(bytes.includes('PRIVATE_FIXTURE_REASON'), false, name);
  }
  await terminal(f.output);
  await assert.rejects(() => runReplay({ ...f, perStratum: 2 }), /exist|overwrite/i);
});

test('repeated identical commands remain selected occurrences with the earliest-offset tie break', async t => {
  const f = await fixture(t);
  await writeFile(f.classifier, returned(ALLOW));
  const line = JSON.stringify({ command: 'same harmless command', harness: 'codex' }) + '\n';
  await writeFile(f.corpus, line.repeat(3));
  assert.equal((await runReplay({ ...f, perStratum: 2 })).exitCode, 0);
  const selected = await readJson(path.join(f.output, 'sample.json'));
  assert.deepEqual(selected.map((/** @type {{offset:number}} */ row) => row.offset), [0, Buffer.byteLength(line)]);
  assert.equal(selected[0].command_sha256, selected[1].command_sha256);
  await terminal(f.output);
});

test('transitive-only build changes alter identity and selected semantic results', async t => {
  const f = await fixture(t);
  const entry = 'const decision = require("./decision.json"); exports.classifyCommand = () => decision;\n';
  await writeFile(f.classifier, entry);
  await writeFile(path.join(f.buildRoot, 'decision.json'), JSON.stringify(ALLOW));
  await writeFile(f.corpus, JSON.stringify({ command: 'echo harmless' }) + '\n');
  const first = await runReplay(f);
  assert.equal(first.exitCode, 0);
  const firstManifest = await readJson(path.join(f.output, 'build-manifest.json'));
  const secondOutput = path.join(f.root, 'second-output');
  await writeFile(path.join(f.buildRoot, 'decision.json'), JSON.stringify({ decision: 'ask', reason: 'second selected build', source: 'unknown', enforcement: 'confirm' }));
  const second = await runReplay({ ...f, output: secondOutput });
  assert.equal(second.exitCode, 0);
  const secondManifest = await readJson(path.join(secondOutput, 'build-manifest.json'));
  assert.equal(sha(await readFile(f.classifier)), sha(entry));
  assert.notEqual(firstManifest.build_sha256, secondManifest.build_sha256);
  assert.equal((await classifications(f.output))[0].decision, 'allow');
  assert.equal((await classifications(secondOutput))[0].decision, 'ask');
  assert.notEqual((await classifications(f.output))[0].reason_sha256, (await classifications(secondOutput))[0].reason_sha256);
  for (const manifest of [firstManifest, secondManifest]) {
    assert.deepEqual(manifest.files.map((/** @type {{path:string}} */ row) => row.path), ['decision.json', 'index.js']);
    assert.equal(manifest.files.find((/** @type {{path:string}} */ row) => row.path === 'index.js').sha256, sha(entry));
  }
  await terminal(f.output);
  await terminal(secondOutput);
});

test('the worker executes retained snapshot bytes after live transitive sources change', async t => {
  const f = await fixture(t);
  await writeFile(f.classifier, 'exports.classifyCommand = require("./helper.js").classifyCommand;\n');
  await writeFile(path.join(f.buildRoot, 'helper.js'), returned(ALLOW));
  await mkdir(f.output);
  const manifest = await snapshotBuild(f);
  await writeFile(path.join(f.buildRoot, 'helper.js'), returned({ decision: 'deny', reason: 'live changed', source: 'regex', enforcement: 'block' }));
  const receipt = path.join(f.root, 'snapshot-worker-state.json');
  const result = await capture([RUNNER, '--worker', '--snapshot', path.join(f.output, 'build-snapshot'), '--manifest', path.join(f.output, 'build-manifest.json'), '--receipt', receipt], JSON.stringify(item('echo harmless')) + '\n', f.root);
  await writeFile(path.join(f.root, 'snapshot-worker.stdout'), result.stdout);
  await writeFile(path.join(f.root, 'snapshot-worker.stderr'), result.stderr);
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 0, result.stderr.toString());
  const row = JSON.parse(result.stdout.toString());
  assert.equal(row.status, 'classified');
  assert.equal(row.decision, 'allow');
  assert.equal(row.reason_sha256, sha(ALLOW.reason));
  assert.equal((await readJson(receipt)).terminal_observed, true);
  assert.equal(sha(await readFile(path.join(f.output, 'build-snapshot', 'helper.js'))), manifest.files.find(row => row.path === 'helper.js')?.sha256);
});

for (const [name, source] of [
  ['external dependency', 'require("not-an-admitted-package");\n'],
  ['traversal outside build', 'require("../outside.js");\n'],
  ['unknown builtin', 'require("node:inspector");\n'],
]) {
  test(`${name} refuses rather than silently substituting another classifier`, async t => {
    const f = await fixture(t);
    await writeFile(path.join(f.root, 'outside.js'), returned(ALLOW));
    const external = path.join(f.root, 'node_modules/not-an-admitted-package');
    await mkdir(external, { recursive: true });
    await writeFile(path.join(external, 'index.js'), returned(ALLOW));
    const result = await replayFixture(f, source + returned(ALLOW));
    assert.equal(result.exitCode, 1);
    const rows = await classifications(f.output);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'unsupported_build');
    await terminal(f.output);
  });
}

test('a symlink anywhere in the admitted root is refused before worker execution', async t => {
  const f = await fixture(t);
  await writeFile(f.classifier, returned(ALLOW));
  await writeFile(path.join(f.root, 'outside.js'), returned(ALLOW));
  await symlink(path.join(f.root, 'outside.js'), path.join(f.buildRoot, 'unused-link.js'));
  await mkdir(f.output);
  await assert.rejects(() => snapshotBuild(f), /symlink|symbolic|regular/i);
});

test('an existing native addon is outside the admitted JS/JSON snapshot profile', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.buildRoot, 'native.node'), 'private nonexecutable native-file control');
  const result = await replayFixture(f, 'exports.classifyCommand = require("./native.node").classifyCommand;\n');
  assert.equal(result.exitCode, 1);
  const manifest = await readJson(path.join(f.output, 'build-manifest.json'));
  assert.equal(manifest.files.some((/** @type {{path:string}} */ row) => row.path === 'native.node'), false);
  assert.equal((await classifications(f.output))[0].status, 'unsupported_build');
  await terminal(f.output);
});

test('a large valid corpus command has an explicit pre-worker profile refusal', async t => {
  const f = await fixture(t);
  const command = 'x'.repeat(1024 * 1024 + 1);
  await assert.rejects(() => replayFixture(f, returned(ALLOW), command), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.constructor.name, 'ProfileRefusal');
    assert.equal(Reflect.get(error, 'code'), 'command_bytes_bound');
    return true;
  });
  const manifest = await readJson(path.join(f.output, 'build-manifest.json'));
  assert.deepEqual(await readJson(path.join(f.output, 'replay-refusal.json')), {
    schema: 'caws.replay_profile_refusal.v1', profile: 'caws.reviewed_cjs_offline.v1',
    reason_code: 'command_bytes_bound', build_sha256: manifest.build_sha256,
  });
  for (const name of ['sample.json', 'replay.json', 'worker-state.json', 'classifications.jsonl'])
    assert.equal(await exists(path.join(f.output, name)), false, 'no successful census or invented child receipt: ' + name);
});

test('a nonobject corpus record is an explicit pre-worker refusal rather than a census entry', async t => {
  const f = await fixture(t);
  await writeFile(f.classifier, returned(ALLOW));
  await writeFile(f.corpus, 'null\n');
  await assert.rejects(() => runReplay(f), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.constructor.name, 'ProfileRefusal');
    assert.equal(Reflect.get(error, 'code'), 'nonobject_corpus_record');
    return true;
  });
  const manifest = await readJson(path.join(f.output, 'build-manifest.json'));
  assert.deepEqual(await readJson(path.join(f.output, 'replay-refusal.json')), {
    schema: 'caws.replay_profile_refusal.v1', profile: 'caws.reviewed_cjs_offline.v1',
    reason_code: 'nonobject_corpus_record', build_sha256: manifest.build_sha256,
  });
  for (const name of ['sample.json', 'replay.json', 'worker-state.json', 'classifications.jsonl'])
    assert.equal(await exists(path.join(f.output, name)), false, name);
});

for (const [name, body] of [
  ['promise result', 'return Promise.resolve(' + JSON.stringify(ALLOW) + ');'],
  ['invalid decision', 'return ' + JSON.stringify({ ...ALLOW, decision: 'permitted' }) + ';'],
  ['raw source leak', 'return ' + JSON.stringify({ ...ALLOW, source: 'PRIVATE_FIXTURE_SOURCE' }) + ';'],
  ['oversize reason', "return {decision:'allow',reason:'x'.repeat(2*1024*1024),source:'unknown',enforcement:'pass'};"],
  ['throwing result getter', "return {get decision(){throw new Error('private getter');},reason:'fixture',source:'unknown',enforcement:'pass'};"],
]) {
  test(`${name} cannot count as a classified result and retains observed child termination`, async t => {
    const f = await fixture(t);
    const result = await replayFixture(f, classifierSource(body));
    assert.equal(result.exitCode, 1);
    const rows = await classifications(f.output);
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].status, 'classified');
    assert.equal(rows[0].decision, undefined);
    assert.equal(rows[0].reason, undefined);
    await terminal(f.output);
  });
}

for (const [name, source] of [
  ['infinite initialization', 'for (;;) {}\n' + returned(ALLOW)],
  ['infinite invocation', classifierSource('for (;;) {}')],
  ['infinite getter serialization', classifierSource("return {get decision(){for (;;){}},reason:'fixture',source:'unknown',enforcement:'pass'};")],
]) {
  test(`${name} cannot outlive the observed terminal deadline`, async t => {
    const f = await fixture(t);
    const result = await replayFixture(f, source, 'echo harmless fixture', 1500);
    assert.equal(result.exitCode, 1);
    const rows = await classifications(f.output);
    assert.equal(rows.some(row => row.status === 'classified'), false);
    const state = await terminal(f.output, 'deadline');
    assert.ok(state.timed_out === true || rows.some(row => row.status === 'timeout'), 'deadline must be the observed failure, not arbitrary startup rejection');
  });
}

test('an explicit outer startup deadline observes child settlement without claiming a VM timeout', async t => {
  const f = await fixture(t);
  const result = await replayFixture(f, returned(ALLOW), 'echo harmless fixture', 1);
  assert.equal(result.exitCode, 1);
  const state = await terminal(f.output, 'deadline');
  assert.equal(state.timeout_ms, 1);
  assert.equal(state.timed_out, true);
  assert.equal(state.complete, false);
  assert.equal(state.rows_expected, 1);
  assert.ok(state.close_observed_elapsed_ms >= state.spawn_call_elapsed_ms);
});

for (const [name, bytes] of [['malformed JSON', Buffer.from('not JSON\n')], ['invalid UTF-8', Buffer.from([255, 10])]]) {
  test(`${name} worker input retains its real nonzero child exit`, async t => {
    const f = await fixture(t);
    await writeFile(f.classifier, returned(ALLOW));
    const receipt = path.join(f.root, 'input-worker-state.json');
    const result = await capture([RUNNER, '--worker', '--classifier', f.classifier, '--build-root', f.buildRoot, '--receipt', receipt], bytes, f.root);
    await writeFile(path.join(f.root, 'input-worker.stdout'), result.stdout);
    await writeFile(path.join(f.root, 'input-worker.stderr'), result.stderr);
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 1);
    const state = await readJson(receipt);
    assert.equal(state.terminal_observed, true);
    assert.equal(state.exit_code, 1);
    assert.equal(state.complete, false);
    const row = JSON.parse(result.stdout.toString());
    assert.equal(row.status, 'error');
    assert.equal(row.error_type, 'InputError');
  });
}

for (const phase of ['initialization', 'invocation']) {
  test(`selected console output cannot pollute the protocol during ${phase}`, async t => {
    const f = await fixture(t);
    const source = phase === 'initialization'
      ? 'console.log("PRIVATE_PROTOCOL_OUTPUT");\n' + returned(ALLOW)
      : classifierSource('console.log("PRIVATE_PROTOCOL_OUTPUT"); return ' + JSON.stringify(ALLOW) + ';');
    const result = await replayFixture(f, source);
    assert.equal(result.exitCode, 1);
    const rows = await classifications(f.output);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'execution_attempt_refused');
    assert.equal(rows[0].phase, phase);
    assert.equal(rows[0].operation, 'output');
    assert.equal((await readFile(path.join(f.output, 'classifications.jsonl'), 'utf8')).includes('PRIVATE_PROTOCOL_OUTPUT'), false);
    assert.equal((await readFile(path.join(f.output, 'worker.stderr'), 'utf8')).includes('PRIVATE_PROTOCOL_OUTPUT'), false);
    await terminal(f.output);
  });
}

test('selected factories cannot resolve private host broker lexical names', async t => {
  const f = await fixture(t);
  const source = classifierSource("return {decision:'allow', reason:JSON.stringify([typeof bridge, typeof broker, typeof globalThis.__bootstrapBroker]), source:'unknown', enforcement:'pass'};");
  const result = await replayFixture(f, source);
  assert.equal(result.exitCode, 0);
  const rows = await classifications(f.output);
  assert.equal(rows[0].status, 'classified');
  assert.equal(rows[0].reason_sha256, sha(JSON.stringify(['undefined', 'undefined', 'undefined'])));
  await terminal(f.output);
});
