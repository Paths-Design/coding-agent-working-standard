#!/usr/bin/env node
/**
 * Offline corpus replay for operator-chosen reviewed CommonJS builds.
 * Build identity is provenance, never evidence that a build was reviewed.
 */
import { createReadStream } from 'node:fs';
import { mkdir, readdir, lstat, realpath, readFile, writeFile, chmod, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

export const PROFILE = 'caws.reviewed_cjs_offline.v1';
const MAX_FILE = 1048576;
const MAX_BUILD = 16777216;
const MAX_FILES = 2048;
const MAX_WIRE = 16777216;
class ProfileRefusal extends Error {
  /** @param {string} code */
  constructor(code) { super('offline replay profile refused: ' + code); this.code = code; }
}
const WORKER = fileURLToPath(new URL('./replay-classifier-worker.mjs', import.meta.url));
/** @param {string | Buffer} bytes */
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
/** @param {unknown} value @returns {value is Record<string,unknown>} */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** @param {string} file @param {unknown} value */
const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
/** @param {string} value */
function absolute(value) {
  if (!value) throw new Error('empty path refused');
  return path.resolve(value);
}
/** Resolve physical existing ancestors before interpreting following parent components.
 * @param {string} value
 */
export async function resolveOutput(value) {
  if (!value) throw new Error('empty output refused');
  let current = '/';
  const pending = (path.isAbsolute(value) ? value : process.cwd() + '/' + value).split('/');
  let links = 0;
  while (pending.length) {
    const component = pending.shift();
    if (!component || component === '.') continue;
    if (component === '..') { current = path.dirname(current); continue; }
    const next = path.join(current, component);
    try {
      const stat = await lstat(next);
      if (stat.isSymbolicLink()) {
        if (++links > 40) throw new Error('output symlink cycle');
        const physical = await realpath(next);
        current = physical;
      } else current = next;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      current = next;
    }
  }
  return current;
}

/** @typedef {{path:string,bytes:number,sha256:string}} BuildFile */
/** @typedef {{schema:string,profile:string,entry:string,build_root:string,files:BuildFile[],excluded_files:{path:string,bytes:number,reason:string}[],runtime:{executable:string,version:string,platform:string,sha256:string},capability_profile:{profile:string,worker_sha256:string},build_sha256:string}} BuildManifest */
/** Snapshot every admitted regular file; no implicit live dependency loads.
 * The output directory must already exist and contain no manifest/snapshot.
 * @param {{classifier:string,buildRoot:string,output:string}} options
 * @returns {Promise<BuildManifest>}
 */
export async function snapshotBuild({ classifier, buildRoot, output }) {
  if (process.platform === 'win32') throw new Error('POSIX profile required');
  const requestedRoot = absolute(buildRoot);
  if ((await lstat(requestedRoot)).isSymbolicLink()) throw new Error('build root symlink refused');
  const root = await realpath(requestedRoot);
  const selected = absolute(classifier);
  const selectedReal = await realpath(selected);
  const entry = path.relative(root, selectedReal).split(path.sep).join('/');
  if (!entry || entry.startsWith('../') || path.isAbsolute(entry) || !entry.endsWith('.js'))
    throw new Error('classifier must be a CommonJS entry inside build root');
  const selectedRelative = path.relative(requestedRoot, selected);
  if (selectedRelative.startsWith('../') || path.isAbsolute(selectedRelative))
    throw new Error('classifier escapes build root');
  let selectedPart = requestedRoot;
  for (const component of selectedRelative.split(path.sep)) {
    selectedPart = path.join(selectedPart, component);
    if ((await lstat(selectedPart)).isSymbolicLink()) throw new Error('classifier symlink refused');
  }
  const outputReal = await realpath(output);
  if (outputReal === root || outputReal.startsWith(root + path.sep)) throw new Error('output inside reviewed build root refused');
  const destination = path.join(output, 'build-snapshot');
  await mkdir(destination);
  /** @type {BuildFile[]} */
  const files = [];
  let total = 0, entriesSeen = 0;
  /** @type {{path:string,bytes:number,reason:string}[]} */
  const excluded_files = [];
  /** @param {string} relative */
  async function visit(relative) {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const item of entries) {
      if (++entriesSeen > 16384) throw new Error('build tree bound');
      const name = relative ? relative + '/' + item.name : item.name;
      if (!/^[A-Za-z0-9_./ -]+$/.test(name)) throw new Error('build filename outside profile');
      const source = path.join(root, name);
      const stat = await lstat(source);
      if (stat.isSymbolicLink()) throw new Error('build symlink refused');
      if (stat.isDirectory()) {
        await mkdir(path.join(destination, name));
        await visit(name);
        await chmod(path.join(destination, name), 0o555);
        continue;
      }
      if (!stat.isFile()) throw new Error('unsupported build file');
      if (!/\.(js|json)$/.test(name)) {
        excluded_files.push({ path: name, bytes: stat.size, reason: 'outside_commonjs_json_profile' });
        continue;
      }
      if (stat.size > MAX_FILE || files.length >= MAX_FILES) throw new Error('build admission bound');
      const bytes = await readFile(source);
      total += bytes.length;
      if (bytes.length > MAX_FILE || total > MAX_BUILD) throw new Error('build admission bound');
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      await writeFile(path.join(destination, name), bytes, { flag: 'wx', mode: 0o444 });
      files.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
    }
  }
  await visit('');
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!files.some(file => file.path === entry)) throw new Error('entry not admitted');
  const workerBytes = await readFile(WORKER);
  await writeFile(path.join(output, 'worker-runner.mjs'), workerBytes, { flag: 'wx', mode: 0o444 });
  const runtime = { executable: process.execPath, version: process.version, platform: process.platform,
    sha256: sha(await readFile(process.execPath)) };
  const capability_profile = { profile: PROFILE, worker_sha256: sha(workerBytes) };
  const identity = { profile: PROFILE, runtime, entry, files, excluded_files, capability_profile };
  const manifest = { schema: 'caws.replay_build_manifest.v1', ...identity, build_root: root,
    build_sha256: sha(JSON.stringify(identity)) };
  await json(path.join(output, 'build-manifest.json'), manifest);
  await chmod(path.join(output, 'build-manifest.json'), 0o444);
  await chmod(destination, 0o555);
  return manifest;
}

/** @typedef {{command:string,command_sha256:string,offset:number,stratum?:string,bytes?:number}} Item */
/** @param {string} text */
function commandBytes(text) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.toString('utf8') !== text) throw new ProfileRefusal('command_unicode');
  return bytes;
}
/** @param {string} corpus @param {number} perStratum */
async function sample(corpus, perStratum) {
  /** @type {Map<string,Item[]>} */
  const groups = new Map();
  /** @type {Record<string,number>} */
  const census = Object.create(null);
  const digest = createHash('sha256');
  let offset = 0, malformed = 0;
  let remainder = Buffer.alloc(0);
  /** @param {Item} a @param {Item} b */
  const compare = (a, b) => a.command_sha256 < b.command_sha256 ? -1 :
    a.command_sha256 > b.command_sha256 ? 1 : a.offset - b.offset;
  /** @param {Buffer} line */
  function accept(line) {
    const start = offset;
    offset += line.length;
    let row;
    try {
      let text = new TextDecoder('utf-8', { fatal: true }).decode(line);
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      row = JSON.parse(text);
    } catch { malformed++; return; }
    if (!object(row)) throw new ProfileRefusal('nonobject_corpus_record');
    if (typeof row.command !== 'string') { malformed++; return; }
    const bytes = commandBytes(row.command);
    if (bytes.length > MAX_FILE) throw new ProfileRefusal('command_bytes_bound');
    const harness = typeof row.harness === 'string' && ['claude-code', 'codex', 'dsh', 'qwen'].includes(row.harness) ? row.harness : 'unknown';
    const status = object(row.outcome) && typeof row.outcome.status === 'string' ? row.outcome.status : 'unknown';
    const outcome = ['success', 'error', 'denied', 'rejected', 'aborted', 'unknown'].includes(status) ? status : 'unknown';
    const bucket = bytes.length < 512 ? 'short' : bytes.length < 8192 ? 'medium' : 'large';
    const stratum = harness + '/' + outcome + '/' + bucket;
    census[stratum] = (census[stratum] ?? 0) + 1;
    const item = { command: row.command, command_sha256: sha(bytes), offset: start, stratum, bytes: bytes.length };
    const group = groups.get(stratum) ?? [];
    group.push(item); group.sort(compare);
    if (group.length > perStratum) group.pop();
    groups.set(stratum, group);
  }
  for await (const chunk of createReadStream(corpus)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    digest.update(bytes);
    remainder = Buffer.concat([remainder, bytes]);
    let newline;
    while ((newline = remainder.indexOf(10)) !== -1) {
      const line = remainder.subarray(0, newline + 1);
      if (line.length > 2097152) throw new ProfileRefusal('corpus_line_bound');
      accept(line); remainder = remainder.subarray(newline + 1);
    }
    if (remainder.length > 2097152) throw new ProfileRefusal('corpus_line_bound');
  }
  if (remainder.length) accept(remainder);
  const selected = [...groups.values()].flat().sort((a, b) => a.offset - b.offset);
  return { selected, census: Object.fromEntries(Object.entries(census).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
    corpus_bytes: offset, corpus_sha256: digest.digest('hex'), malformed };
}

/** @param {Buffer} bytes @param {Item[]} items */
function parseRows(bytes, items) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text && !text.endsWith('\n')) throw new Error('partial worker row');
  const rows = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (rows.length !== items.length) throw new Error('incomplete worker rows');
  for (const [index, row] of rows.entries()) {
    const item = items[index];
    if (!object(row) || !item || row.offset !== item.offset || row.command_sha256 !== item.command_sha256 ||
        !['classified', 'execution_attempt_refused', 'unsupported_build', 'timeout', 'error'].includes(String(row.status)) ||
        'command' in row || 'reason' in row) throw new Error('worker row identity');
  }
  return rows;
}

/** @param {{directory:string,snapshot:string,manifest:string,items:Item[],timeoutMs:number,wire?:Buffer}} options */
async function runWorker({ directory, snapshot, manifest, items, timeoutMs, wire }) {
  const runStarted = process.hrtime.bigint();
  const elapsedMs = () => Number(process.hrtime.bigint() - runStarted) / 1e6;
  const runner = path.join(path.dirname(manifest), 'worker-runner.mjs');
  if ((await lstat(runner)).isSymbolicLink() || sha(await readFile(runner)) !== sha(await readFile(WORKER)))
    throw new Error('worker capability source mismatch');
  const argv = [process.execPath, runner, '--snapshot', snapshot, '--manifest', manifest];
  const input = wire ?? Buffer.from(items.map(item => JSON.stringify(item)).join('\n') + (items.length ? '\n' : ''));
  if (input.length > MAX_WIRE) throw new Error('worker input bound');
  const spawnCallElapsedMs = elapsedMs();
  const child = spawn(argv[0] ?? process.execPath, argv.slice(1), {
    cwd: directory, env: { PATH: '/usr/bin:/bin', HOME: '/caws-offline/home', NODE_NO_WARNINGS: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  /** @type {Buffer[]} */
  const out = [];
  /** @type {Buffer[]} */
  const err = [];
  let size = 0, timedOut = false, exceeded = false;
  let stdoutEof = false, stderrEof = false, stdioForcedClosed = false;
  /** @type {string | null} */
  let spawnError = null;
  /** @param {Buffer[]} target @param {Buffer} chunk */
  function capture(target, chunk) {
    size += chunk.length;
    if (size > MAX_WIRE) { exceeded = true; child.kill('SIGKILL'); return; }
    target.push(chunk);
  }
  /** @type {number | null} */
  let spawnObservedElapsedMs = null;
  /** @type {number | null} */
  let exitObservedElapsedMs = null;
  /** @type {number | null} */
  let closeObservedElapsedMs = null;
  child.once('spawn', () => { spawnObservedElapsedMs = elapsedMs(); });
  child.stdout.on('data', chunk => capture(out, chunk));
  child.stderr.on('data', chunk => capture(err, chunk));
  child.stdout.once('end', () => { stdoutEof = true; });
  child.stderr.once('end', () => { stderrEof = true; });
  child.stdin.on('error', () => {});
  child.on('error', () => { spawnError = 'SpawnError'; });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  child.stdin.end(input);
  let terminalObserved = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let drainTimer;
  child.once('exit', () => {
    exitObservedElapsedMs = elapsedMs();
    terminalObserved = true;
    drainTimer = setTimeout(() => {
      stdioForcedClosed = !stdoutEof || !stderrEof;
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    }, 250);
  });
  /** @type {{code:number|null,signal:NodeJS.Signals|null}} */
  const terminal = await new Promise(resolve => child.once('close', (code, signal) => {
    closeObservedElapsedMs = elapsedMs();
    resolve({ code, signal });
  }));
  if (drainTimer) clearTimeout(drainTimer);
  clearTimeout(timer);
  const stdout = Buffer.concat(out), stderr = Buffer.concat(err);
  await writeFile(path.join(directory, 'classifications.jsonl'), stdout, { flag: 'wx' });
  await writeFile(path.join(directory, 'worker.stderr'), stderr, { flag: 'wx' });
  /** @type {Record<string,unknown>[]} */
  let rows = [];
  let protocolError = false;
  try { rows = parseRows(stdout, items); } catch { protocolError = true; }
  const state = { schema: 'caws.replay_worker_state.v1', argv, pid: child.pid ?? null,
    timeout_ms: timeoutMs, spawn_call_elapsed_ms: spawnCallElapsedMs,
    spawn_observed_elapsed_ms: spawnObservedElapsedMs, exit_observed_elapsed_ms: exitObservedElapsedMs,
    close_observed_elapsed_ms: closeObservedElapsedMs,
    // Monotonic duration through capture publication; excludes writing this receipt.
    total_elapsed_ms: elapsedMs(),
    exit_code: terminal.code, signal: terminal.signal, timed_out: timedOut,
    terminal_observed: terminalObserved, rows_expected: items.length, rows_returned: rows.length,
    stdout_eof: stdoutEof, stderr_eof: stderrEof, stdio_forced_closed: stdioForcedClosed,
    complete: terminalObserved && stdoutEof && stderrEof && !stdioForcedClosed &&
      !timedOut && !exceeded && !spawnError && !protocolError && terminal.code === 0,
    ...(spawnError ? { error_type: spawnError } : {}), output_bound_exceeded: exceeded };
  await json(path.join(directory, 'worker-state.json'), state);
  return { rows, state, stdout };
}

/** @typedef {{corpus:string,classifier:string,buildRoot:string,output:string,perStratum?:number,workerTimeoutMs?:number}} ReplayOptions */
/** Validate both public entry modes before filesystem or child effects.
 * @param {number} perStratum @param {number} timeoutMs
 */
function validateBounds(perStratum, timeoutMs) {
  if (!Number.isSafeInteger(perStratum) || perStratum < 1 || perStratum > 256 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
    throw new Error('invalid replay bound');
}
/** @param {ReplayOptions} options */
export async function runReplay(options) {
  const perStratum = options.perStratum ?? 24;
  const timeoutMs = options.workerTimeoutMs ?? 300000;
  validateBounds(perStratum, timeoutMs);
  const output = await resolveOutput(options.output);
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  const manifest = await snapshotBuild({ classifier: options.classifier, buildRoot: options.buildRoot, output });
  let census;
  try { census = await sample(options.corpus, perStratum); }
  catch (error) {
    await json(path.join(output, 'replay-refusal.json'), {
      schema: 'caws.replay_profile_refusal.v1', profile: PROFILE,
      reason_code: error instanceof ProfileRefusal ? error.code : 'corpus_unavailable',
      build_sha256: manifest.build_sha256,
    });
    throw error;
  }
  const sampleRows = census.selected.map(({ command: _command, ...row }) => row);
  await json(path.join(output, 'sample.json'), sampleRows);
  const execution = await runWorker({ directory: output, snapshot: path.join(output, 'build-snapshot'),
    manifest: path.join(output, 'build-manifest.json'), items: census.selected, timeoutMs });
  /** @type {Record<string,number>} */
  const statuses = Object.create(null), decisions = Object.create(null);
  const elapsed = execution.rows.map(row => Number(row.elapsed_ns)).sort((a, b) => a - b);
  /** @param {number} p */
  const percentile = p => elapsed.length ? (elapsed[Math.floor((elapsed.length - 1) * p)] ?? 0) / 1e6 : null;
  for (const row of execution.rows) {
    const status = String(row.status), decision = String(row.decision ?? 'unclassified');
    statuses[status] = (statuses[status] ?? 0) + 1;
    decisions[decision] = (decisions[decision] ?? 0) + 1;
  }
  const report = { schema: 'caws.corpus_replay.v1', profile: PROFILE,
    corpus: absolute(options.corpus), corpus_bytes: census.corpus_bytes, corpus_sha256: census.corpus_sha256,
    census: census.census, records: Object.values(census.census).reduce((a, b) => a + b, 0),
    malformed: census.malformed, sampled: census.selected.length,
    classifier: absolute(options.classifier), classifier_sha256: manifest.files.find(file => file.path === manifest.entry)?.sha256,
    build_root: manifest.build_root, build_sha256: manifest.build_sha256,
    worker_argv: execution.state.argv, worker_exit_code: execution.state.exit_code, returned: execution.rows.length,
    status_counts: statuses, decision_counts: decisions,
    context_missing: execution.rows.filter(row => row.decision_authority === 'context_missing').length,
    latency_ms: { p50: percentile(.5), p95: percentile(.95), max: percentile(1) }, commands_executed: 0,
    limits: ['Captured commands are data; no historical correctness or enforcement labels.',
      'Reviewed selected CommonJS builds only; identity does not establish review or authority.',
      'All path observations are synthetic lexical POSIX assumptions; filesystem, Git, adapters and tokens are unavailable.',
      'The constrained VM capability profile is not an OS sandbox or escaped-descendant containment claim.',
      '250 ms initialization/invocation VM deadlines; external deadline includes loading and observed child termination.',
      'Stratified occurrences are not unbiased population prevalence; no native latency claim.',
      'Regular non-JS/JSON assets are excluded and cannot be required; symlinks and nonregular files are refused.',
      'Corpus command/line bounds and nonobject/unpaired-Unicode records refuse the profile instead of changing census categories.',
      'Read-only snapshot modes preserve custody, not OS immutability against another same-user process.',
      'Whole admitted JS/JSON build-root snapshot is attributed, including unused admitted files.'] };
  await json(path.join(output, 'replay.json'), report);
  return { report, exitCode: execution.state.complete && execution.rows.every(row => row.status === 'classified') ? 0 : 1 };
}

/** @typedef {{corpus?:string,classifier?:string,buildRoot?:string,output?:string,perStratum:number,workerTimeoutMs:number,worker:boolean,receipt?:string,snapshot?:string,manifest?:string}} Arguments */
/** @param {string[]} argv @returns {Arguments | null} */
export function parseArguments(argv) {
  /** @type {Arguments} */
  const result = { perStratum: 24, workerTimeoutMs: 300000, worker: false };
  const values = new Map([['--corpus', 'corpus'], ['--classifier', 'classifier'], ['--build-root', 'buildRoot'],
    ['--output', 'output'], ['--per-stratum', 'perStratum'], ['--worker-timeout-ms', 'workerTimeoutMs'],
    ['--receipt', 'receipt'], ['--snapshot', 'snapshot'], ['--manifest', 'manifest']]);
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? '';
    if (argument === '--help' || argument === '-h') return null;
    if (argument === '--worker') { result.worker = true; continue; }
    const split = argument.indexOf('=');
    const option = split < 0 ? argument : argument.slice(0, split);
    const key = values.get(option);
    if (!key) throw new Error('unrecognized argument');
    const value = split < 0 ? argv[++index] : argument.slice(split + 1);
    if (value === undefined || (!value && key !== 'output')) throw new Error('argument value required');
    if (key === 'perStratum' || key === 'workerTimeoutMs') {
      if (!/^[0-9]+$/.test(value)) throw new Error('invalid numeric argument');
      result[key] = Number(value);
    } else Reflect.set(result, key, value);
  }
  if (!result.worker && (!result.corpus || !result.classifier || !result.buildRoot || result.output === undefined))
    throw new Error('corpus, classifier, build-root and output required');
  if (result.worker && !(result.snapshot && result.manifest) && !(result.classifier && result.buildRoot))
    throw new Error('worker selected build required');
  validateBounds(result.perStratum, result.workerTimeoutMs);
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    process.stdout.write([
      'Usage: replay-terminal-corpus.mjs --corpus FILE --classifier ENTRY.js --build-root DIR --output NEWDIR [--per-stratum N] [--worker-timeout-ms N]',
      'Worker: --worker --classifier ENTRY.js --build-root DIR [--receipt NEWFILE] reads command/hash/offset JSONL from stdin.',
      'Select operator-reviewed CommonJS code on Node >=18/POSIX. Build hashes identify bytes; they do not establish review or authority.',
      'Captured corpus commands, cwd and environment remain untrusted data. Reports retain hashes and offsets, not raw commands or reasons.',
      'Complete offline ports and reviewed-build capability controls refuse exercised direct effects during initialization and invocation.',
      'This VM profile is not an arbitrary-JavaScript or OS sandbox. Unknown imports and unsupported build contracts refuse.',
      'Whole-worker default/max 300000 ms; initialization and invocation VM limits 250 ms; per-stratum range 1..256 (default 24).',
      'Build limits: 2048 JS/JSON files, 1 MiB each, 16 MiB total; corpus commands <=1 MiB and lines <=2 MiB. Out-of-profile data refuses explicitly.',
      'Regular non-JS/JSON assets are excluded; symlinks and nonregular files refuse. Snapshot modes are not same-user OS immutability.',
      '',
    ].join('\n'));
    return;
  }
  if (!options.worker) {
    if (!options.corpus || !options.classifier || !options.buildRoot || options.output === undefined) throw new Error('arguments');
    const result = await runReplay({ corpus: options.corpus, classifier: options.classifier, buildRoot: options.buildRoot,
      output: options.output, perStratum: options.perStratum, workerTimeoutMs: options.workerTimeoutMs });
    process.stdout.write(JSON.stringify(result.report, null, 2) + '\n'); process.exitCode = result.exitCode;
    return;
  }
  const temporary = await mkdtemp(path.join(tmpdir(), 'caws-offline-replay-'));
  try {
    let manifestPath = options.manifest;
    let snapshot = options.snapshot;
    if (!manifestPath || !snapshot) {
      if (!options.classifier || !options.buildRoot) throw new Error('arguments');
      await snapshotBuild({ classifier: options.classifier, buildRoot: options.buildRoot, output: temporary });
      manifestPath = path.join(temporary, 'build-manifest.json'); snapshot = path.join(temporary, 'build-snapshot');
    }
    let wire = Buffer.alloc(0);
    for await (const chunk of process.stdin) {
      wire = Buffer.concat([wire, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (wire.length > MAX_WIRE) throw new Error('input bound');
    }
    const items = wire.toString('utf8').split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); }
      catch { return { command: '', command_sha256: sha(''), offset: 0 }; }
    });
    const result = await runWorker({ directory: temporary, snapshot, manifest: manifestPath,
      items, wire, timeoutMs: options.workerTimeoutMs });
    if (options.receipt) await json(options.receipt, result.state);
    process.stdout.write(result.stdout);
    process.exitCode = result.state.complete ? 0 : 1;
  } finally {
    // Snapshot files are read-only; directories must be writable for cleanup.
    /** @param {string} directory */
    async function writable(directory) {
      await chmod(directory, 0o700);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) await writable(path.join(directory, entry.name));
      }
    }
    await writable(temporary);
    await rm(temporary, { recursive: true, force: true });
  }
}
let cli = false;
try { cli = !!process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url)); } catch {}
if (cli) main().catch(() => { process.stderr.write('offline replay failed; inspect retained artifacts\n'); process.exitCode = 1; });
