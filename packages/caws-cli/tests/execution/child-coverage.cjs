'use strict';
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const preload = path.join(__dirname, 'child-coverage-preload.cjs');
const MAX_BYTES = 2 * 1024 * 1024;
const COVERAGE_FD = 5;
function insist(value) { if (!value) throw new Error('Invalid or missing child mutation coverage'); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys) { return object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function prepare(options = {}) {
  const parent = globalThis.__stryker__;
  const context = { token: randomUUID(), testId: parent?.currentTestId ?? null, activeMutant: String(parent?.activeMutant ?? process.env.__STRYKER_ACTIVE_MUTANT__ ?? ''), instrumented: parent !== undefined };
  insist(context.testId === null || typeof context.testId === 'string');
  const stdio = options.stdio ? [...options.stdio] : ['pipe', 'pipe', 'pipe'];
  insist(stdio.length <= COVERAGE_FD);
  while (stdio.length < COVERAGE_FD) stdio.push('ignore');
  stdio.push('pipe');
  return { parent, context, options: { ...options, encoding: undefined, stdio, env: { ...(options.env ?? process.env), CAWS_TEST_CHILD_COVERAGE: JSON.stringify(context), __STRYKER_ACTIVE_MUTANT__: context.activeMutant } } };
}
function counts(value) {
  insist(object(value));
  for (const [id, count] of Object.entries(value)) insist(/^(?:0|[1-9][0-9]*)$/.test(id) && Number.isSafeInteger(count) && count > 0);
}
function mergeCoverage(frame, context, parent) {
  insist(Buffer.isBuffer(frame) && frame.length >= 4 && frame.length <= MAX_BYTES + 4);
  insist(frame.readUInt32BE() === frame.length - 4);
  const value = JSON.parse(frame.subarray(4).toString('utf8'));
  insist(exact(value, ['protocol', 'token', 'testId', 'activeMutant', 'coverage']) && value.protocol === 'caws.test.child-coverage.v1' && value.token === context.token && value.testId === context.testId && value.activeMutant === context.activeMutant);
  if (value.coverage === null) {
    // A dry-run child which imports instrumented production code must actually
    // return its counters. Empty selection cannot masquerade as an optimization.
    insist(!context.instrumented || context.testId === null || context.activeMutant !== '');
    return;
  }
  insist(exact(value.coverage, ['static', 'perTest']));
  counts(value.coverage.static);
  insist(object(value.coverage.perTest));
  for (const [testId, hits] of Object.entries(value.coverage.perTest)) {
    insist(testId === context.testId); counts(hits);
  }
  if (context.instrumented && context.testId !== null && context.activeMutant === '')
    insist(Object.keys(value.coverage.static).length + Object.values(value.coverage.perTest).reduce((total, hits) => total + Object.keys(hits).length, 0) > 0);
  if (!parent) return;
  insist(globalThis.__stryker__ === parent);
  const destination = parent.mutantCoverage ?? (parent.mutantCoverage = { static: {}, perTest: {} });
  const add = (target, source) => {
    for (const [id, count] of Object.entries(source)) {
      const total = (target[id] ?? 0) + count;
      insist(Number.isSafeInteger(total)); target[id] = total;
    }
  };
  add(destination.static, value.coverage.static);
  for (const [id, hits] of Object.entries(value.coverage.perTest)) add(destination.perTest[id] ?? (destination.perTest[id] = {}), hits);
}
function coverageDiagnostic(error, result, frame) {
  let completeFrames = 0;
  if (Buffer.isBuffer(frame)) {
    let offset = 0;
    while (offset + 4 <= frame.length) {
      const length = frame.readUInt32BE(offset);
      if (length > MAX_BYTES || offset + 4 + length > frame.length) break;
      completeFrames++; offset += 4 + length;
    }
  }
  const stderr = result.stderr == null ? null : result.stderr.toString('utf8').slice(0, 4096);
  const detail = { status: result.status ?? null, signal: result.signal ?? null,
    error: result.error?.code ?? result.error?.message ?? null, stderr,
    coverageBytes: Buffer.isBuffer(frame) ? frame.length : 0, completeFrames };
  return new Error(`Invalid or missing child mutation coverage: ${JSON.stringify(detail)}`, { cause: error });
}
function spawnCoveredSync(command, args, options = {}) {
  insist(command === process.execPath);
  const prepared = prepare(options);
  const result = spawnSync(command, ['--require', preload, ...args], prepared.options);
  const frame = result.output?.[COVERAGE_FD];
  try { mergeCoverage(frame, prepared.context, prepared.parent); }
  catch (error) { throw coverageDiagnostic(error, result, frame); }
  if (options.encoding && options.encoding !== 'buffer') {
    result.stdout = result.stdout?.toString(options.encoding) ?? null;
    result.stderr = result.stderr?.toString(options.encoding) ?? null;
  }
  return result;
}
function spawnCovered(command, args, options = {}) {
  insist(command === process.execPath);
  const prepared = prepare(options);
  const child = spawn(command, ['--require', preload, ...args], prepared.options);
  const chunks = []; let size = 0; let failure;
  child.stdio[COVERAGE_FD].on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BYTES + 4) failure = new Error('Child mutation coverage limit');
    else chunks.push(chunk);
  });
  child.stdio[COVERAGE_FD].on('error', (error) => { failure = error; });
  // Resolve the close observation; defer rejection until explicitly consumed,
  // so a child failing during an earlier barrier cannot create an unhandled promise.
  const closed = new Promise((resolve) => child.once('close', resolve));
  return { child, async completeCoverage() {
    await closed;
    const frame = Buffer.concat(chunks);
    try { if (failure) throw failure; mergeCoverage(frame, prepared.context, prepared.parent); }
    catch (error) { throw coverageDiagnostic(error, { status: child.exitCode, signal: child.signalCode }, frame); }
  } };
}
module.exports = { spawnCoveredSync, spawnCovered, mergeCoverage };
