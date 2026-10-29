import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { TextDecoder } from 'node:util';
import { parseJsonSource } from '../runtime/json-custody';
import type { PreparedExecutionV1 } from './prepared';

export const MAX_PREPARED_RECORD_BYTES = 2 * 1024 * 1024;
export class InvalidPreparedRecord extends Error {
  constructor() {
    super('Invalid prepared execution record');
    this.name = 'InvalidPreparedRecord';
  }
}

function insist(value: unknown): asserts value {
  if (!value) throw new InvalidPreparedRecord();
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  insist(value !== null && typeof value === 'object' && !Array.isArray(value));
  const row = value as Record<string, unknown>;
  insist(Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key)));
  return row;
}
function nativeText(value: unknown, maximum: number, empty = false): asserts value is string {
  insist(
    typeof value === 'string' &&
      (empty || value.length > 0) &&
      Buffer.byteLength(value) <= maximum &&
      !value.includes('\0') &&
      Buffer.from(value).toString('utf8') === value
  );
}
function identity(value: unknown): void {
  nativeText(value, 256);
  insist(!/\p{Cc}/u.test(value));
}
function nativePath(value: unknown): asserts value is string {
  nativeText(value, 4096);
  insist(isAbsolute(value));
}
function digest(value: unknown): asserts value is string {
  insist(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
}
function image(value: unknown): Record<string, unknown> {
  const row = object(value, ['path', 'sha256']);
  nativePath(row.path);
  digest(row.sha256);
  return row;
}
function bytes(value: unknown, maximum: number): Buffer {
  insist(typeof value === 'string' && value.length <= 4 * Math.ceil(maximum / 3));
  const decoded = Buffer.from(value, 'base64');
  insist(decoded.length <= maximum && decoded.toString('base64') === value);
  return decoded;
}
function integer(value: unknown, maximum: number): void {
  insist(typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum);
}
function freeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}

/** Reject duplicate keys and alternate representations before any authority I/O.
 * The caller retains the original bytes and their digest; no JSON reserialization
 * substitutes for that identity. Opaque sandbox bytes are validated but not rewritten.
 */
export function decodePreparedExecution(input: Uint8Array): PreparedExecutionV1 {
  try {
    insist(
      input instanceof Uint8Array &&
        input.byteLength > 0 &&
        input.byteLength <= MAX_PREPARED_RECORD_BYTES
    );
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
    const source = parseJsonSource(text, 12, 20_000, true);
    // All owned numeric fields are unsigned decimal integers. Policy-extension
    // numbers remain inside the opaque base64 state and are not interpreted here.
    const pending = [source.root];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.kind === 'object') pending.push(...node.entries.values());
      else if (node.kind === 'array') pending.push(...node.items);
      else if (node.kind === 'number')
        insist(/^(?:0|[1-9][0-9]*)$/.test(text.slice(node.start, node.end)));
    }
    const value: unknown = JSON.parse(text);
    const root = object(value, [
      'schema',
      'invocationId',
      'association',
      'projectRoot',
      'execution',
      'profile',
      'sandbox',
      'limits',
    ]);
    insist(root.schema === 'caws.execution.prepared.v1');
    identity(root.invocationId);
    const association = object(root.association, [
      'kind',
      'sessionId',
      'threadId',
      'callId',
      'callerAnchor',
      'serverEnvironmentId',
    ]);
    insist(association.kind === 'codex-mcp-v1');
    for (const key of ['sessionId', 'threadId', 'callId', 'serverEnvironmentId'])
      identity(association[key]);
    nativePath(association.callerAnchor);
    nativePath(root.projectRoot);
    const execution = object(root.execution, [
      'executable',
      'argv',
      'cwd',
      'environment',
      'stdinBase64',
    ]);
    const executable = image(execution.executable);
    nativePath(execution.cwd);
    insist(
      Array.isArray(execution.argv) && execution.argv.length > 0 && execution.argv.length <= 256
    );
    let argvBytes = 0;
    for (const argument of execution.argv) {
      nativeText(argument, 65536, true);
      argvBytes += Buffer.byteLength(argument) + 1;
    }
    insist(argvBytes <= 65536);
    insist(Array.isArray(execution.environment) && execution.environment.length <= 1024);
    let environmentBytes = 0;
    let previous: Buffer | undefined;
    for (const entry of execution.environment) {
      const row = object(entry, ['name', 'value']);
      nativeText(row.name, 131072);
      nativeText(row.value, 131072, true);
      insist(!row.name.includes('='));
      const name = Buffer.from(row.name);
      insist(previous === undefined || Buffer.compare(previous, name) < 0);
      previous = name;
      environmentBytes += name.length + Buffer.byteLength(row.value) + 2;
    }
    insist(environmentBytes <= 131072);
    bytes(execution.stdinBase64, 524288);
    const npmProfile =
      root.profile !== null &&
      typeof root.profile === 'object' &&
      !Array.isArray(root.profile) &&
      (root.profile as Record<string, unknown>).kind === 'npm-test-v1';
    const profile = object(
      root.profile,
      npmProfile ? ['kind', 'source', 'utilities', 'npm'] : ['kind', 'source', 'utilities']
    );
    insist(
      profile.kind === 'bash-clean-v1' ||
        profile.kind === 'caws-evidence-v1' ||
        profile.kind === 'npm-test-v1'
    );
    nativeText(profile.source, 65536, true);
    if (profile.kind === 'bash-clean-v1')
      insist(
        execution.argv.length === 5 &&
          execution.argv[0] === executable.path &&
          execution.argv[1] === '--noprofile' &&
          execution.argv[2] === '--norc' &&
          execution.argv[3] === '-c' &&
          execution.argv[4] === profile.source
      );
    else if (profile.kind === 'caws-evidence-v1')
      insist(execution.argv.length >= 5 && execution.argv[0] === executable.path);
    else {
      insist(profile.source === 'npm test' && execution.stdinBase64 === '');
      const npm = object(profile.npm, ['runtime', 'project']);
      const runtime = object(npm.runtime, ['node', 'entry', 'root', 'generationManifestSha256']);
      const node = image(runtime.node);
      const entry = image(runtime.entry);
      nativePath(runtime.root);
      digest(runtime.generationManifestSha256);
      insist(entry.path === join(runtime.root, 'bin', 'npm-cli.js'));
      const project = object(npm.project, [
        'packageJson',
        'npmrc',
        'testScript',
        'pathShadowSha256',
      ]);
      image(project.packageJson);
      if (project.npmrc !== null) image(project.npmrc);
      nativeText(project.testScript, 65536);
      digest(project.pathShadowSha256);
      insist(
        Array.isArray(execution.argv) &&
          execution.argv.length === 3 &&
          execution.argv[0] === node.path &&
          execution.argv[1] === entry.path &&
          execution.argv[2] === 'test' &&
          executable.path === node.path &&
          executable.sha256 === node.sha256
      );
    }
    insist(Array.isArray(profile.utilities) && profile.utilities.length <= 32);
    const paths = new Set<string>();
    for (const utility of profile.utilities) {
      const row = image(utility);
      insist(!paths.has(row.path as string));
      paths.add(row.path as string);
    }
    if (npmProfile) insist(profile.utilities.length === 0);
    const sandbox = object(
      root.sandbox,
      npmProfile
        ? ['stateBase64', 'stateSha256', 'launcher', 'environmentAnchor', 'writeCeiling']
        : ['stateBase64', 'stateSha256', 'launcher', 'environmentAnchor']
    );
    digest(sandbox.stateSha256);
    const state = bytes(sandbox.stateBase64, 262144);
    insist(createHash('sha256').update(state).digest('hex') === sandbox.stateSha256);
    // Validate JSON grammar/UTF-8 only. Unknown policy fields and duplicate-key
    // semantics belong to the pinned launcher, and the original bytes survive.
    JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(state));
    image(sandbox.launcher);
    nativePath(sandbox.environmentAnchor);
    if (npmProfile) {
      const ceiling = object(sandbox.writeCeiling, [
        'schema',
        'launchId',
        'invocationRoot',
        'outputRoot',
        'tmpRoot',
        'cacheRoot',
        'manifestSha256',
      ]);
      insist(ceiling.schema === 'caws.execution.write-ceiling.v1');
      digest(ceiling.launchId);
      digest(ceiling.manifestSha256);
      for (const key of ['invocationRoot', 'outputRoot', 'tmpRoot', 'cacheRoot'])
        nativePath(ceiling[key]);
      insist(
        ceiling.outputRoot === join(ceiling.invocationRoot as string, 'output') &&
          ceiling.tmpRoot === join(ceiling.invocationRoot as string, 'tmp') &&
          ceiling.cacheRoot === join(ceiling.invocationRoot as string, 'cache')
      );
    }
    const limits = object(root.limits, [
      'preparationDeadlineUnixMs',
      'jobTimeoutMs',
      'terminationGraceMs',
      'maxOutputBytes',
    ]);
    integer(limits.preparationDeadlineUnixMs, Number.MAX_SAFE_INTEGER);
    integer(limits.jobTimeoutMs, 86400000);
    integer(limits.terminationGraceMs, 10000);
    integer(limits.maxOutputBytes, 16777216);
    freeze(root);
    return root as unknown as PreparedExecutionV1;
  } catch {
    // Do not disclose source, environment, stdin, or parser excerpts on failure.
    throw new InvalidPreparedRecord();
  }
}
