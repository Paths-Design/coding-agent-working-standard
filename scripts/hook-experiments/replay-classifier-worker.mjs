#!/usr/bin/env node
/**
 * Reviewed CommonJS build runner. Corpus text is data. This is a constrained
 * capability profile in a Node VM, not an OS sandbox for hostile native code.
 */
import vm from 'node:vm';
import { writeSync } from 'node:fs';
import path from 'node:path';
import { readFile, lstat, realpath, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isNativeError } from 'node:util/types';
/** Native inspection avoids invoking traps on an arbitrary VM-thrown object.
 * @param {unknown} error
 */
function vmTimeout(error) {
  return isNativeError(error) && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ERR_SCRIPT_EXECUTION_TIMEOUT';
}

const PROFILE = 'caws.reviewed_cjs_offline.v1';
const progressStarted = process.hrtime.bigint();
let progressRecords = 0;
/** Trusted-host lifecycle observations only: no selected source, command, or reason.
 * At most eight fixed-shape records per worker. Best-effort delivery is not a verdict.
 * @param {string} phase
 */
function progress(phase) {
  if (progressRecords >= 8) return;
  progressRecords++;
  try {
    writeSync(2, JSON.stringify({ schema: 'caws.replay_worker_progress.v1', phase,
      pid: process.pid, elapsed_ms: Number(process.hrtime.bigint() - progressStarted) / 1e6 }) + '\n');
  } catch {}
}
/** @param {string | Buffer} value */
const digest = value => createHash('sha256').update(value).digest('hex');
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {boolean} initialization @returns {Record<string,unknown>} */
function protocolFailure(initialization) {
  return { status: 'error', phase: initialization ? 'initialization' : 'invocation_or_serialization',
    error_type: 'ProtocolError', context_probes: [] };
}
const PHASES = ['initialization', 'invocation', 'serialization', 'invocation_or_serialization'];
const OPERATIONS = ['file write', 'filesystem access', 'process spawn', 'network', 'process exit',
  'process signal', 'asynchronous execution', 'output', 'code generation'];
const REASON_CODES = ['external_import', 'missing_relative_import', 'non_string_import',
  'unsupported_builtin_or_external', 'classifier_export', 'offline_absolute_path',
  'asynchronous_classifier', 'classification_shape', 'classification_size', 'dynamic_import',
  'relative_import_escape', 'missing_factory', 'build_admission'];
const SOURCES = ['unknown', 'regex', 'legacy_family', 'rm_classifier', 'find_delete',
  'commit_deletions', 'capability', 'classifier_error', 'sidecar_error'];
const PROBES = ['git', 'read', 'isFile', 'realpath', 'consumeFile'];
/** Only host-parsed JSON enters this boundary. Never forward mutable VM metadata.
 * Arbitrary selected error codes, copied reasons, probes and extra keys are rejected.
 * The raw classifier reason exists only long enough for this host to hash it.
 * @param {unknown} value @param {boolean} [initialization]
 * @returns {Record<string,unknown>}
 */
function projectResult(value, initialization = false) {
  const failed = () => protocolFailure(initialization);
  if (!object(value) || typeof value.status !== 'string') return failed();
  const status = value.status;
  /** @type {Record<string,string[]>} */
  const fields = {
    ready: ['phase'],
    classified: ['decision', 'source', 'enforcement', 'reason'],
    execution_attempt_refused: ['phase', 'operation'],
    unsupported_build: ['phase', 'reason_code'],
    timeout: ['phase'],
    error: ['phase', 'error_type'],
  };
  if (!Object.hasOwn(fields, status) || (status === 'ready' && !initialization) ||
      (status === 'classified' && initialization)) return failed();
  const allowed = new Set(['status', 'context_probes', ...(fields[status] ?? [])]);
  if (Object.keys(value).some(key => !allowed.has(key))) return failed();
  const probes = value.context_probes ?? [];
  if (!Array.isArray(probes) || probes.length > 5 ||
      probes.some(probe => typeof probe !== 'string' || !PROBES.includes(probe)) ||
      new Set(probes).size !== probes.length) return failed();
  /** @type {Record<string,unknown>} */
  const result = { status };
  if (!initialization) result.context_probes = probes;
  if (status === 'ready') {
    if (value.phase !== undefined && value.phase !== 'initialization') return failed();
    result.phase = 'initialization';
    return result;
  }
  if (status === 'classified') {
    if (typeof value.decision !== 'string' || !['allow', 'ask', 'deny'].includes(value.decision) ||
        typeof value.source !== 'string' || !SOURCES.includes(value.source) ||
        typeof value.enforcement !== 'string' || !['pass', 'advisory', 'confirm', 'block'].includes(value.enforcement) ||
        typeof value.reason !== 'string' || value.reason.length > 65536) return failed();
    result.decision = value.decision; result.source = value.source;
    result.enforcement = value.enforcement; result.reason_sha256 = digest(value.reason);
    return result;
  }
  const phase = value.phase;
  if ((phase !== undefined && (typeof phase !== 'string' || !PHASES.includes(phase))) ||
      (initialization && phase !== undefined && phase !== 'initialization')) return failed();
  result.phase = initialization ? 'initialization' : phase ?? 'invocation_or_serialization';
  if (status === 'execution_attempt_refused') {
    if (typeof value.operation !== 'string' || !OPERATIONS.includes(value.operation)) return failed();
    result.operation = value.operation;
  } else if (status === 'unsupported_build') {
    if (typeof value.reason_code !== 'string' || !REASON_CODES.includes(value.reason_code)) return failed();
    result.reason_code = value.reason_code;
  } else if (status === 'error') {
    if (typeof value.error_type !== 'string' || !['ProtocolError', 'ClassifierError'].includes(value.error_type)) return failed();
    result.error_type = value.error_type;
  }
  return result;
}

/**
 * The sole host callback is captured privately before selected code loads.
 * It accepts/returns JSON strings and never throws a host object into the VM.
 * @param {string} request
 */
function broker(request) {
  try {
    const item = JSON.parse(request);
    if (!object(item)) return '{"error":"invalid capability request"}';
    if (item.kind === 'path') {
      const allowed = ['basename', 'dirname', 'join', 'isAbsolute', 'relative', 'resolve', 'normalize', 'extname', 'parse', 'format'];
      if (typeof item.method !== 'string' || !allowed.includes(item.method) || !Array.isArray(item.args))
        return '{"error":"unsupported path capability"}';
      // JSON transport prevents caller-owned objects/functions from crossing realms.
      const methods = /** @type {Record<string, Function>} */ (/** @type {unknown} */ (path.posix));
      const args = item.method === 'resolve' ? ['/caws-offline/repo', ...item.args] : item.args;
      return JSON.stringify({ value: Reflect.apply(methods[item.method], path.posix, args) });
    }
    if (item.kind === 'decode' && Array.isArray(item.bytes) && typeof item.encoding === 'string') {
      const bytes = Uint8Array.from(item.bytes);
      const options = object(item.options) ? { fatal: item.options.fatal === true, ignoreBOM: item.options.ignoreBOM === true } : {};
      return JSON.stringify({ value: new TextDecoder(item.encoding, options).decode(bytes) });
    }
    return '{"error":"unsupported capability"}';
  } catch {
    return '{"error":"capability argument refused"}';
  }
}

/**
 * This function's SOURCE executes inside the context; no host closures survive.
 * @param {{entry:string,files:string[],runtimePlatform:string,dynamicIds:string[]}} config
 */
function initializeRealm(config) {
  'use strict';
  // @ts-expect-error Private bootstrap property exists only inside the VM.
  const bridge = globalThis.__bootstrapBroker;
  // @ts-expect-error Remove access before admitting selected module initialization.
  delete globalThis.__bootstrapBroker;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const freeze = Object.freeze;
  let phase = 'initialization';
  /** @type {{operation:string,phase:string}[]} */
  let faults = [];
  /** @type {string[]} */
  let probes = [];
  class Refusal extends Error {
    /** @param {string} operation */
    constructor(operation) {
      super('reviewed build capability refused');
      faults.push({ operation, phase });
    }
  }
  class Unsupported extends Error {
    /** @param {string} code */
    constructor(code) { super(code); this.code = code; }
  }
  /** @param {string} operation */
  const deny = operation => function () { throw new Refusal(operation); };
  /** @param {unknown} request */
  function pure(request) {
    const reply = parse(bridge(stringify(request)));
    if ('error' in reply) throw new TypeError('capability arguments refused');
    return reply.value;
  }
  /** @type {Record<string, unknown>} */
  const posix = Object.create(null);
  for (const method of ['basename', 'dirname', 'join', 'isAbsolute', 'relative', 'resolve', 'normalize', 'extname', 'parse', 'format']) {
    /** @type {(...args:unknown[])=>unknown} */
    const call = (...args) => pure({ kind: 'path', method, args });
    posix[method] = call;
  }
  posix.sep = '/'; posix.delimiter = ':'; posix.posix = posix;
  freeze(posix);
  const p = /** @type {{dirname:(p:string)=>string,resolve:(...p:string[])=>string,isAbsolute:(p:string)=>boolean}} */ (/** @type {unknown} */ (posix));
  class RealmTextDecoder {
    /** @param {string} [encoding] @param {{fatal?:boolean,ignoreBOM?:boolean}} [options] */
    constructor(encoding = 'utf-8', options = {}) { this.encoding = encoding; this.options = options; }
    /** @param {Iterable<number>} [bytes] */
    decode(bytes = []) { return pure({ kind: 'decode', encoding: this.encoding, options: this.options, bytes: [...bytes] }); }
  }
  /** @param {string} operation */
  function stub(operation) {
    const value = new Proxy(Object.create(null), {
      get(_target, name) {
        if (name === 'promises') return value;
        if (name === 'constants') return freeze({ X_OK: 1 });
        if (name === 'then') return undefined;
        const observed = operation === 'file write' && typeof name === 'string' && /^(read|stat|lstat|realpath|access|exists|readdir)/.test(name) ? 'filesystem access' : operation;
        return deny(observed);
      },
    });
    return freeze(value);
  }
  const fs = stub('file write');
  const child = stub('process spawn');
  const network = stub('network');
  const processView = freeze({
    platform: config.runtimePlatform,
    env: freeze({}),
    cwd: () => '/caws-offline/repo',
    exit: deny('process exit'), kill: deny('process signal'),
    nextTick: deny('asynchronous execution'),
  });
  // VM-owned object/functions, never the real process.
  Object.defineProperty(globalThis, 'process', { value: processView, writable: false, configurable: false });
  Object.defineProperty(globalThis, 'console', { value: freeze({ log: deny('output'), error: deny('output'), warn: deny('output') }), writable: false });
  const names = new Set(config.files);
  /** @type {Record<string,{exports:unknown}>} */
  const modules = Object.create(null);
  /** @param {string} request @param {string} from */
  function resolve(request, from) {
    if (!request.startsWith('./') && !request.startsWith('../')) throw new Unsupported('external_import');
    const stack = p.dirname('/' + from).split('/').filter(Boolean);
    for (const part of request.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (!stack.length) throw new Unsupported('relative_import_escape'); stack.pop(); }
      else stack.push(part);
    }
    const value = stack.join('/');
    for (const candidate of [value, value + '.js', value + '.json', value + '/index.js', value + '/index.json']) {
      if (names.has(candidate)) return candidate;
    }
    throw new Unsupported('missing_relative_import');
  }
  /** @param {string} id */
  function load(id) {
    if (config.dynamicIds.includes(id)) throw new Unsupported('dynamic_import');
    if (Object.hasOwn(modules, id)) return modules[id].exports;
    const module = { exports: {} };
    modules[id] = module;
    // @ts-expect-error VM-owned registry is populated by host-compiled source.
    const factory = globalThis.__factories[id];
    if (typeof factory !== 'function') throw new Unsupported('missing_factory');
    /** @param {string} request */
    function require(request) {
      if (typeof request !== 'string') throw new Unsupported('non_string_import');
      const name = request.startsWith('node:') ? request.slice(5) : request;
      if (name === 'path') return posix;
      if (name === 'util') return freeze({ TextDecoder: RealmTextDecoder });
      if (name === 'fs' || name === 'fs/promises') return fs;
      if (name === 'child_process') return child;
      if (['net', 'http', 'https', 'http2', 'dns', 'dns/promises', 'dgram', 'tls'].includes(name)) return network;
      if (name === 'process') return processView;
      if (!request.startsWith('.')) throw new Unsupported('unsupported_builtin_or_external');
      return load(resolve(request, id));
    }
    factory(module.exports, require, module, '/' + id, p.dirname('/' + id));
    return module.exports;
  }
  /** @param {unknown} error */
  function failure(error) {
    if (faults.length) return { status: 'execution_attempt_refused', ...faults[0] };
    if (error instanceof Unsupported) return { status: 'unsupported_build', phase, reason_code: error.code };
    if (error instanceof EvalError) return { status: 'execution_attempt_refused', phase, operation: 'code generation' };
    return { status: 'error', phase, error_type: 'ClassifierError' };
  }
  /** @type {unknown} */
  let classifier;
  /** @type {unknown} */
  let initialFailure;
  // @ts-expect-error VM transport is created before selected factories.
  globalThis.__initializeJSON = function () {
  try {
    const module = load(config.entry);
    if (module === null || typeof module !== 'object' || !('classifyCommand' in module) || typeof module.classifyCommand !== 'function')
      throw new Unsupported('classifier_export');
    classifier = module.classifyCommand;
    if (faults.length) initialFailure = failure(undefined);
  } catch (error) { initialFailure = failure(error); }
  return stringify(initialFailure === undefined ? { status: 'ready' } : initialFailure);
  };
  // @ts-expect-error VM-owned settlement transport observes initialization microtasks.
  globalThis.__settleInitializationJSON = function () {
    if (faults.length && initialFailure === undefined) initialFailure = failure(undefined);
    return stringify(initialFailure === undefined ? { status: 'ready' } : initialFailure);
  };
  // @ts-expect-error VM-owned settlement transport observes post-invocation microtasks.
  globalThis.__postInvocationJSON = function () {
    return faults.length ? stringify({ ...failure(undefined), context_probes: probes }) : '';
  };
  // Keep the trusted callback and module graph private to this lexical closure.
  // @ts-expect-error Public transport is VM-owned and only returns serialized data.
  globalThis.__invokeJSON = function (/** @type {string} */ command) {
    if (initialFailure !== undefined) return stringify(initialFailure);
    faults = []; probes = []; phase = 'invocation';
    const note = (/** @type {string} */ name) => { if (!probes.includes(name)) probes.push(name); };
    const ports = freeze({
      git: () => { note('git'); return { status: -1, stdout: '' }; },
      read: () => { note('read'); return null; },
      isFile: () => { note('isFile'); return false; },
      realpath: (/** @type {string} */ value) => {
        note('realpath');
        if (typeof value !== 'string' || !p.isAbsolute(value)) throw new Unsupported('offline_absolute_path');
        return p.resolve(value);
      },
      consumeFile: () => { note('consumeFile'); return false; },
    });
    try {
      const context = freeze({ repoRoot: '/caws-offline/repo', cwd: '/caws-offline/repo',
        home: '/caws-offline/home', environment: freeze({}), ports });
      const result = Reflect.apply(/** @type {Function} */ (classifier), undefined, [command, context]);
      phase = 'serialization';
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function')
        throw new Unsupported('asynchronous_classifier');
      if (result === null || typeof result !== 'object') throw new Unsupported('classification_shape');
      const { decision, source, enforcement, reason } = result;
      if (!['allow', 'ask', 'deny'].includes(decision) ||
          !['pass', 'advisory', 'confirm', 'block'].includes(enforcement) ||
          !['unknown', 'regex', 'legacy_family', 'rm_classifier', 'find_delete', 'commit_deletions', 'capability', 'classifier_error', 'sidecar_error'].includes(source) || typeof reason !== 'string')
        throw new Unsupported('classification_shape');
      if (reason.length > 65536 || source.length > 256) throw new Unsupported('classification_size');
      if (faults.length) return stringify({ ...failure(undefined), context_probes: probes });
      return stringify({ status: 'classified', decision, source, enforcement, reason, context_probes: probes });
    } catch (error) { return stringify({ ...failure(error), context_probes: probes }); }
  };
  return stringify(initialFailure === undefined ? { status: 'ready' } : initialFailure);
}

/** @param {string} snapshot @param {string} manifestPath
 * @returns {Promise<{initialization:Record<string,unknown>,invoke:(command:string)=>Record<string,unknown>}>}
 */
async function engine(snapshot, manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!object(manifest) || manifest.profile !== PROFILE || manifest.schema !== 'caws.replay_build_manifest.v1' ||
      typeof manifest.entry !== 'string' || !Array.isArray(manifest.files) || manifest.files.length > 2048)
    throw new Error('invalid build manifest');
  const snapshotReal = await realpath(snapshot);
  if ((await lstat(snapshot)).isSymbolicLink()) throw new Error('snapshot symlink refused');
  /** @type {Record<string,string>} */
  const sources = Object.create(null);
  let total = 0;
  const admitted = new Set();
  for (const file of manifest.files) {
    if (!object(file) || typeof file.path !== 'string' || !/^[A-Za-z0-9_./ -]+\.(js|json)$/.test(file.path) ||
        file.path.startsWith('/') || file.path.split('/').some(part => part === '..' || part === '' || part === '.'))
      throw new Error('invalid manifest path');
    if (admitted.has(file.path)) throw new Error('duplicate manifest path');
    admitted.add(file.path);
    const parts = file.path.split('/');
    let current = snapshotReal;
    for (const part of parts) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error('snapshot symlink refused');
    }
    const stat = await lstat(current);
    if (!stat.isFile() || stat.size > 1048576) throw new Error('snapshot file refused');
    const bytes = await readFile(current);
    total += bytes.length;
    if (total > 16777216 || bytes.length !== file.bytes || digest(bytes) !== file.sha256)
      throw new Error('snapshot identity mismatch');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    sources[file.path] = text;
  }
  /** @param {string} relative */
  async function verifyTree(relative) {
    for (const entry of await readdir(path.join(snapshotReal, relative), { withFileTypes: true })) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) throw new Error('snapshot symlink refused');
      if (entry.isDirectory()) await verifyTree(name);
      else if (!entry.isFile() || !admitted.has(name)) throw new Error('unmanifested snapshot file');
    }
  }
  await verifyTree('');
  if (!(manifest.entry in sources)) throw new Error('entry not in snapshot');
  if (manifest.build_sha256 !== digest(JSON.stringify({ profile: manifest.profile, runtime: manifest.runtime, entry: manifest.entry, files: manifest.files, excluded_files: manifest.excluded_files, capability_profile: manifest.capability_profile })))
    throw new Error('manifest identity mismatch');
  progress('build_verified');
  if (!object(manifest.runtime) || manifest.runtime.version !== process.version || manifest.runtime.platform !== process.platform ||
      manifest.runtime.executable !== process.execPath || process.platform === 'win32') throw new Error('runtime identity/profile mismatch');
  if (!object(manifest.capability_profile) || manifest.capability_profile.profile !== PROFILE ||
      manifest.capability_profile.worker_sha256 !== digest(await readFile(fileURLToPath(import.meta.url))) ||
      manifest.runtime.sha256 !== digest(await readFile(process.execPath))) throw new Error('capability/runtime identity mismatch');
  progress('runtime_verified');
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
  new vm.Script('globalThis.__factories = Object.create(null);').runInContext(context, { timeout: 250 });
  Object.assign(context, { __bootstrapBroker: broker });
  const config = { entry: manifest.entry, files: Object.keys(sources), runtimePlatform: process.platform,
    dynamicIds: Object.entries(sources).filter(([, source]) => /\bimport\s*\(/.test(source)).map(([id]) => id) };
  new vm.Script('(' + initializeRealm.toString() + ')(' + JSON.stringify(config) + ')')
    .runInContext(context, { timeout: 250 });
  /** @type {Record<string,unknown>} */
  let initialization = protocolFailure(true);
  try {
    for (const [id, source] of Object.entries(sources)) {
      const body = id.endsWith('.json')
        ? 'module.exports = JSON.parse(' + JSON.stringify(source) + ');'
        : source.replace(/^#![^\n]*(?:\n|$)/, '');
      new vm.Script('globalThis.__factories[' + JSON.stringify(id) + '] = function(exports, require, module, __filename, __dirname) {\n' + body + '\n};',
        { filename: '/' + id }).runInContext(context, { timeout: 250 });
    }
    const initialized = new vm.Script('globalThis.__initializeJSON()').runInContext(context, { timeout: 250 });
    const settled = new vm.Script('globalThis.__settleInitializationJSON()').runInContext(context, { timeout: 250 });
    const encoded = typeof settled === 'string' ? settled : initialized;
    if (typeof encoded === 'string' && encoded.length <= 4096) initialization = projectResult(JSON.parse(encoded), true);
  } catch (error) {
    if (vmTimeout(error)) initialization = { status: 'timeout', phase: 'initialization' };
    else initialization = { status: 'unsupported_build', phase: 'initialization', reason_code: 'build_admission' };
  }
  progress('realm_initialization_finished');
  /** @param {string} command */
  const invoke = command => {
    const invocationDeadline = Date.now() + 250;
    if (initialization.status !== 'ready') return initialization;
    try {
      let encoded = new vm.Script('globalThis.__invokeJSON(' + JSON.stringify(command) + ')')
        .runInContext(context, { timeout: Math.max(1, invocationDeadline - Date.now()) });
      if (Date.now() >= invocationDeadline) return { status: 'timeout', phase: 'invocation_or_serialization' };
      const post = new vm.Script('globalThis.__postInvocationJSON()').runInContext(context, { timeout: Math.max(1, invocationDeadline - Date.now()) });
      if (typeof post === 'string' && post) encoded = post;
      if (typeof encoded !== 'string' || encoded.length > 131072) return { status: 'error', error_type: 'ProtocolError' };
      const result = JSON.parse(encoded);
      return projectResult(result);
    } catch (error) {
      // An afterEvaluate microtask can throw after the invocation's own catch.
      // Read the VM-owned fault record without transporting the thrown object.
      try {
        const pending = new vm.Script('globalThis.__postInvocationJSON()').runInContext(context, { timeout: 10 });
        if (typeof pending === 'string' && pending) {
          const fault = JSON.parse(pending);
          return projectResult(fault);
        }
      } catch {}
      return vmTimeout(error) ? { status: 'timeout', phase: 'invocation_or_serialization' } :
        { status: 'error', phase: 'invocation_or_serialization', error_type: 'ProtocolError' };
    }
  };
  return { initialization, invoke };
}

async function main() {
  progress('worker_started');
  const args = process.argv.slice(2);
  const snapshot = args[args.indexOf('--snapshot') + 1];
  const manifest = args[args.indexOf('--manifest') + 1];
  if (!args.includes('--snapshot') || !args.includes('--manifest') || !snapshot || !manifest) throw new Error('worker arguments');
  const receiptIndex = args.indexOf('--initialization-receipt');
  const initializationReceipt = receiptIndex < 0 ? undefined : args[receiptIndex + 1];
  if (receiptIndex >= 0 && !initializationReceipt) throw new Error('initialization receipt argument');
  /** @type {{initialization:Record<string,unknown>,invoke:(command:string)=>Record<string,unknown>}} */
  let loaded;
  try { loaded = await engine(snapshot, manifest); }
  catch {
    const initialization = { status: 'unsupported_build', phase: 'initialization', reason_code: 'build_admission' };
    loaded = { initialization, invoke: () => initialization };
  }
  const { initialization, invoke } = loaded;
  if (initializationReceipt) {
    // Exclusive, bounded host receipt; no dummy classification manufactures readiness.
    /** @type {Record<string,unknown>} */
    const receipt = { schema: 'caws.replay_initialization.v1', pid: process.pid };
    for (const key of ['status', 'phase', 'operation', 'reason_code', 'error_type']) {
      if (Object.hasOwn(initialization, key)) receipt[key] = initialization[key];
    }
    await writeFile(initializationReceipt, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 });
  }
  let outputBytes = 0;
  let firstInvocation = true, firstResult = true;
  async function* lines() {
    let pending = Buffer.alloc(0);
    for await (const chunk of process.stdin) {
      pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (pending.length > 2097152 && pending.indexOf(10) === -1) throw new Error('input bound');
      let newline;
      while ((newline = pending.indexOf(10)) !== -1) {
        yield pending.subarray(0, newline + 1);
        pending = pending.subarray(newline + 1);
      }
    }
    if (pending.length) yield pending;
  }
  for await (const lineBytes of lines()) {
    const started = process.hrtime.bigint();
    let row;
    try {
      if (lineBytes.length > 2097152) throw new Error('input bound');
      const line = new TextDecoder('utf-8', { fatal: true }).decode(lineBytes);
      const item = JSON.parse(line);
      if (!object(item) || typeof item.command !== 'string' || typeof item.command_sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(item.command_sha256) || !Number.isSafeInteger(item.offset) || Number(item.offset) < 0 ||
          Buffer.from(item.command, 'utf8').toString('utf8') !== item.command || digest(item.command) !== item.command_sha256) throw new Error('input shape');
      const observeInvocation = firstInvocation;
      firstInvocation = false;
      if (observeInvocation) progress('first_invocation_started');
      let result;
      try { result = invoke(item.command); }
      finally { if (observeInvocation) progress('first_invocation_finished'); }
      // invoke returns only host-projected fields or fixed host diagnostics.
      row = { ...result, command_sha256: item.command_sha256, offset: item.offset,
        elapsed_ns: Number(process.hrtime.bigint() - started), context_probes: result.context_probes ?? [],
        decision_authority: Array.isArray(result.context_probes) && result.context_probes.length ? 'context_missing' : 'text_only' };
    } catch {
      process.exitCode = 1;
      row = { status: 'error', error_type: 'InputError', elapsed_ns: Number(process.hrtime.bigint() - started) };
    }
    const encoded = JSON.stringify(row) + '\n';
    outputBytes += Buffer.byteLength(encoded);
    if (outputBytes > 16777216) throw new Error('output bound');
    if (!process.stdout.write(encoded)) await new Promise(resolve => process.stdout.once('drain', resolve));
    if (firstResult) { firstResult = false; progress('first_result_written'); }
  }
  progress('worker_finished');
}
process.on('unhandledRejection', () => { process.stderr.write('asynchronous build rejected\n'); process.exitCode = 1; });
main().catch(() => { process.stderr.write('offline worker unavailable\n'); process.exitCode = 1; });
