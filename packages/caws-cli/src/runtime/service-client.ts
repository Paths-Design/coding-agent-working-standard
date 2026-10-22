import { createHash } from 'node:crypto';
import { fstatSync, readSync, writeSync } from 'node:fs';
import { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { TextDecoder } from 'node:util';
import {
  createRenderRequest,
  decodeRenderRequest,
  encodeRenderRequest,
  decodeRenderOutcome,
  type OriginalRenderSource,
  type RenderExecutionImage,
  type RendererArguments,
  type RenderRequest,
  type RenderOutcomeFrame,
} from './service-protocol';

export const SERVICE_GRANT_SCHEMA = 'caws.service.render.grant.v1' as const;
export const SERVICE_BRIDGE_REQUEST_SCHEMA = 'caws.service.render.bridge.request.v1' as const;
export const SERVICE_BRIDGE_REPLY_SCHEMA = 'caws.service.render.bridge.reply.v1' as const;
export const SERVICE_RECEIPT_SCHEMA = 'caws.service.render.client.receipt.v1' as const;
export const SERVICE_ADAPTER = 'sterling-session-log-broker-v1' as const;
/** Body byte limits exclude the mandatory wire LF (optional for pure decode APIs). */
export const MAX_SERVICE_GRANT_BYTES = 32_768;
export const MAX_SERVICE_BRIDGE_REQUEST_BYTES = 132_096;
export const MAX_SERVICE_BRIDGE_REPLY_BYTES = 9_216;
export const MAX_SERVICE_RECEIPT_BYTES = 9_216;

/**
 * Data issued by the native selected-handler boundary. Validation here proves
 * shape/correlation only, never authority, source closure, realpath, FD rights,
 * owner lifetime, or the binding to an actual selected index/path/hash.
 * hooksDirectory is the executed image's SCRIPT_DIR; leaseFile is logical data,
 * never a discovery endpoint and is never opened by this client.
 */
export interface ServiceRenderGrant {
  readonly schema: typeof SERVICE_GRANT_SCHEMA;
  readonly grantId: string;
  readonly adapter: typeof SERVICE_ADAPTER;
  readonly invocationId: string;
  readonly selectedIndex: number;
  readonly canonicalProject: string;
  readonly sourceGeneration: string;
  readonly originalSource: OriginalRenderSource;
  readonly executionImage: RenderExecutionImage;
  readonly originalHandlerEntry: 'session-log.sh';
  readonly originalHandlerPath: string;
  readonly hooksDirectory: string;
  readonly leaseFile: string;
  /** Waiting budget only; the native owner enforces its monotonic deadline. */
  readonly remainingBudgetMs: number;
}
export interface ServiceBridgeRequest {
  readonly schema: typeof SERVICE_BRIDGE_REQUEST_SCHEMA;
  readonly grantId: string;
  readonly grantDigest: string;
  readonly request: RenderRequest;
}
export interface ServiceBridgeReply {
  readonly schema: typeof SERVICE_BRIDGE_REPLY_SCHEMA;
  readonly grantId: string;
  readonly grantDigest: string;
  readonly outcome: RenderOutcomeFrame;
}
export type ServiceClientFailureReason =
  | 'transport_unavailable'
  | 'transport_error'
  | 'transport_closed'
  | 'invalid_reply'
  | 'reply_too_large'
  | 'timeout'
  | 'interrupted';
type LocalRequestIdentity = Pick<
  RenderOutcomeFrame,
  'requestId' | 'argumentDigest' | 'projectServiceKey' | 'sourceGeneration' | 'executionImageDigest'
>;
/** Local transport observation; neither variant grants inline fallback. */
export type ServiceClientObservation =
  | { readonly kind: 'owner_outcome'; readonly frame: RenderOutcomeFrame }
  | (LocalRequestIdentity & {
      readonly kind: 'client_observation';
      readonly delivery: 'not_attempted';
      readonly execution: 'known_not_executed';
      readonly reason: ServiceClientFailureReason;
    })
  | (LocalRequestIdentity & {
      readonly kind: 'client_observation';
      readonly delivery: 'may_have_been_delivered';
      readonly execution: 'unknown';
      readonly reason: ServiceClientFailureReason;
    });
export interface ServiceClientReceipt {
  readonly schema: typeof SERVICE_RECEIPT_SCHEMA;
  readonly grantId: string;
  readonly grantDigest: string;
  readonly outcome: ServiceClientObservation;
}
export class ServiceClientProtocolError extends Error {
  constructor() {
    super('Invalid session render service frame');
    this.name = 'ServiceClientProtocolError';
  }
}
function fail(): never {
  throw new ServiceClientProtocolError();
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail();
  return value;
}
function uint(value: unknown, min: number, max: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < min ||
    value > max
  )
    fail();
  return value;
}
function absolutePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    Buffer.from(value, 'utf8').toString('utf8') !== value ||
    Buffer.byteLength(value, 'utf8') > 4096 ||
    !value.startsWith('/') ||
    value.includes('\0') ||
    (value !== '/' &&
      value
        .slice(1)
        .split('/')
        .some((p) => p === '' || p === '.' || p === '..'))
  )
    fail();
  return value;
}
function encode(value: unknown, max: number): Buffer {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body, 'utf8') > max) fail();
  return Buffer.from(body + '\n', 'utf8');
}
function decode(frame: Uint8Array | string, max: number): unknown {
  if (typeof frame !== 'string' && !(frame instanceof Uint8Array)) fail();
  if ((typeof frame === 'string' ? Buffer.byteLength(frame, 'utf8') : frame.byteLength) > max + 1)
    fail();
  if (typeof frame === 'string' && Buffer.from(frame, 'utf8').toString('utf8') !== frame) fail();
  const bytes = typeof frame === 'string' ? Buffer.from(frame, 'utf8') : Buffer.from(frame);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail();
  }
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail();
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (Buffer.byteLength(body, 'utf8') > max) fail();
  try {
    const value: unknown = JSON.parse(body);
    if (JSON.stringify(value) !== body) fail();
    return value;
  } catch {
    fail();
  }
}
function normalizeGrant(value: unknown): ServiceRenderGrant {
  if (
    !exact(value, [
      'schema',
      'grantId',
      'adapter',
      'invocationId',
      'selectedIndex',
      'canonicalProject',
      'sourceGeneration',
      'originalSource',
      'executionImage',
      'originalHandlerEntry',
      'originalHandlerPath',
      'hooksDirectory',
      'leaseFile',
      'remainingBudgetMs',
    ]) ||
    value.schema !== SERVICE_GRANT_SCHEMA ||
    value.adapter !== SERVICE_ADAPTER ||
    value.originalHandlerEntry !== 'session-log.sh' ||
    typeof value.invocationId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.invocationId) ||
    !exact(value.originalSource, ['handlerSha256', 'closureDigest']) ||
    !exact(value.executionImage, ['imageDigest', 'clientSha256'])
  )
    fail();
  // Fixed encoder order. Original source and executed image are separate identities.
  const grant: ServiceRenderGrant = Object.freeze({
    schema: SERVICE_GRANT_SCHEMA,
    grantId: hash(value.grantId),
    adapter: SERVICE_ADAPTER,
    invocationId: value.invocationId,
    selectedIndex: uint(value.selectedIndex, 0, 65_535),
    canonicalProject: absolutePath(value.canonicalProject),
    sourceGeneration: hash(value.sourceGeneration),
    originalSource: Object.freeze({
      handlerSha256: hash(value.originalSource.handlerSha256),
      closureDigest: hash(value.originalSource.closureDigest),
    }),
    executionImage: Object.freeze({
      imageDigest: hash(value.executionImage.imageDigest),
      clientSha256: hash(value.executionImage.clientSha256),
    }),
    originalHandlerEntry: 'session-log.sh',
    originalHandlerPath: absolutePath(value.originalHandlerPath),
    hooksDirectory: absolutePath(value.hooksDirectory),
    leaseFile: absolutePath(value.leaseFile),
    remainingBudgetMs: uint(value.remainingBudgetMs, 1, 120_000),
  });
  encode(grant, MAX_SERVICE_GRANT_BYTES);
  return grant;
}
export function encodeServiceGrant(grant: ServiceRenderGrant): Buffer {
  return encode(normalizeGrant(grant), MAX_SERVICE_GRANT_BYTES);
}
export function decodeServiceGrant(frame: Uint8Array | string): ServiceRenderGrant {
  return normalizeGrant(decode(frame, MAX_SERVICE_GRANT_BYTES));
}
/** SHA-256 of the normalized fixed-order grant JSON body, without the LF. */
export function serviceGrantDigest(grant: ServiceRenderGrant): string {
  const bytes = encodeServiceGrant(grant);
  return createHash('sha256')
    .update(bytes.subarray(0, bytes.length - 1))
    .digest('hex');
}
export function makeServiceRenderRequest(
  grantValue: ServiceRenderGrant,
  argv: readonly string[]
): RenderRequest {
  const grant = normalizeGrant(grantValue);
  if (
    !Array.isArray(argv) ||
    argv.length !== 14 ||
    Object.keys(argv).join(',') !== '0,1,2,3,4,5,6,7,8,9,10,11,12,13' ||
    !argv.every((value) => typeof value === 'string') ||
    argv[0] !== grant.hooksDirectory ||
    argv[1] !== grant.leaseFile
  )
    fail();
  return createRenderRequest({
    invocationId: grant.invocationId,
    selectedIndex: grant.selectedIndex,
    canonicalProject: grant.canonicalProject,
    sourceGeneration: grant.sourceGeneration,
    originalSource: grant.originalSource,
    executionImage: grant.executionImage,
    arguments: argv.slice(2) as unknown as RendererArguments,
  });
}
function boundRequest(value: RenderRequest, grant: ServiceRenderGrant): RenderRequest {
  const request = decodeRenderRequest(encodeRenderRequest(value));
  const expected = makeServiceRenderRequest(grant, [
    grant.hooksDirectory,
    grant.leaseFile,
    ...request.arguments,
  ]);
  if (JSON.stringify(request) !== JSON.stringify(expected)) fail();
  return request;
}
function envelope(
  value: unknown,
  schema: string,
  payload: string,
  grant: ServiceRenderGrant
): Record<string, unknown> {
  if (
    !exact(value, ['schema', 'grantId', 'grantDigest', payload]) ||
    value.schema !== schema ||
    hash(value.grantId) !== grant.grantId ||
    hash(value.grantDigest) !== serviceGrantDigest(grant)
  )
    fail();
  return value;
}
export function encodeServiceBridgeRequest(
  grantValue: ServiceRenderGrant,
  requestValue: RenderRequest
): Buffer {
  const grant = normalizeGrant(grantValue);
  return encode(
    {
      schema: SERVICE_BRIDGE_REQUEST_SCHEMA,
      grantId: grant.grantId,
      grantDigest: serviceGrantDigest(grant),
      request: boundRequest(requestValue, grant),
    },
    MAX_SERVICE_BRIDGE_REQUEST_BYTES
  );
}
export function decodeServiceBridgeRequest(
  frame: Uint8Array | string,
  grantValue: ServiceRenderGrant
): ServiceBridgeRequest {
  const grant = normalizeGrant(grantValue);
  const value = envelope(
    decode(frame, MAX_SERVICE_BRIDGE_REQUEST_BYTES),
    SERVICE_BRIDGE_REQUEST_SCHEMA,
    'request',
    grant
  );
  const request = boundRequest(decodeRenderRequest(JSON.stringify(value.request)), grant);
  return Object.freeze({
    schema: SERVICE_BRIDGE_REQUEST_SCHEMA,
    grantId: grant.grantId,
    grantDigest: serviceGrantDigest(grant),
    request,
  });
}
export function decodeServiceBridgeReply(
  frame: Uint8Array | string,
  grantValue: ServiceRenderGrant,
  requestValue: RenderRequest
): ServiceBridgeReply {
  const grant = normalizeGrant(grantValue);
  const request = boundRequest(requestValue, grant);
  const value = envelope(
    decode(frame, MAX_SERVICE_BRIDGE_REPLY_BYTES),
    SERVICE_BRIDGE_REPLY_SCHEMA,
    'outcome',
    grant
  );
  return Object.freeze({
    schema: SERVICE_BRIDGE_REPLY_SCHEMA,
    grantId: grant.grantId,
    grantDigest: serviceGrantDigest(grant),
    outcome: decodeRenderOutcome(JSON.stringify(value.outcome), request),
  });
}
export function encodeServiceBridgeReply(
  reply: ServiceBridgeReply,
  grant: ServiceRenderGrant,
  request: RenderRequest
): Buffer {
  const value = decodeServiceBridgeReply(
    encode(reply, MAX_SERVICE_BRIDGE_REPLY_BYTES),
    grant,
    request
  );
  return encode(value, MAX_SERVICE_BRIDGE_REPLY_BYTES);
}
const FAILURE_REASONS: readonly string[] = [
  'transport_unavailable',
  'transport_error',
  'transport_closed',
  'invalid_reply',
  'reply_too_large',
  'timeout',
  'interrupted',
];
function localIdentity(request: RenderRequest): LocalRequestIdentity {
  return {
    requestId: request.requestId,
    argumentDigest: request.argumentDigest,
    projectServiceKey: request.projectServiceKey,
    sourceGeneration: request.sourceGeneration,
    executionImageDigest: request.executionImage.imageDigest,
  };
}
function observation(value: unknown, request: RenderRequest): ServiceClientObservation {
  if (exact(value, ['kind', 'frame']) && value.kind === 'owner_outcome')
    return Object.freeze({
      kind: 'owner_outcome',
      frame: decodeRenderOutcome(JSON.stringify(value.frame), request),
    });
  if (
    !exact(value, [
      'kind',
      'requestId',
      'argumentDigest',
      'projectServiceKey',
      'sourceGeneration',
      'executionImageDigest',
      'delivery',
      'execution',
      'reason',
    ]) ||
    value.kind !== 'client_observation' ||
    typeof value.reason !== 'string' ||
    !FAILURE_REASONS.includes(value.reason)
  )
    fail();
  const identity = localIdentity(request);
  for (const key of Object.keys(identity) as (keyof LocalRequestIdentity)[])
    if (hash(value[key]) !== identity[key]) fail();
  const reason = value.reason as ServiceClientFailureReason;
  if (value.delivery === 'not_attempted' && value.execution === 'known_not_executed')
    return Object.freeze({
      kind: 'client_observation',
      ...identity,
      delivery: 'not_attempted',
      execution: 'known_not_executed',
      reason,
    });
  if (value.delivery === 'may_have_been_delivered' && value.execution === 'unknown')
    return Object.freeze({
      kind: 'client_observation',
      ...identity,
      delivery: 'may_have_been_delivered',
      execution: 'unknown',
      reason,
    });
  fail();
}
export function decodeServiceClientReceipt(
  frame: Uint8Array | string,
  grantValue: ServiceRenderGrant,
  requestValue: RenderRequest
): ServiceClientReceipt {
  const grant = normalizeGrant(grantValue);
  const request = boundRequest(requestValue, grant);
  const value = envelope(
    decode(frame, MAX_SERVICE_RECEIPT_BYTES),
    SERVICE_RECEIPT_SCHEMA,
    'outcome',
    grant
  );
  return Object.freeze({
    schema: SERVICE_RECEIPT_SCHEMA,
    grantId: grant.grantId,
    grantDigest: serviceGrantDigest(grant),
    outcome: observation(value.outcome, request),
  });
}
export function encodeServiceClientReceipt(
  receipt: ServiceClientReceipt,
  grant: ServiceRenderGrant,
  request: RenderRequest
): Buffer {
  return encode(
    decodeServiceClientReceipt(encode(receipt, MAX_SERVICE_RECEIPT_BYTES), grant, request),
    MAX_SERVICE_RECEIPT_BYTES
  );
}
function localObservation(
  request: RenderRequest,
  attempted: boolean,
  reason: ServiceClientFailureReason
): ServiceClientObservation {
  const identity = localIdentity(request);
  return attempted
    ? {
        kind: 'client_observation',
        ...identity,
        delivery: 'may_have_been_delivered',
        execution: 'unknown',
        reason,
      }
    : {
        kind: 'client_observation',
        ...identity,
        delivery: 'not_attempted',
        execution: 'known_not_executed',
        reason,
      };
}
/**
 * One offer, one request/reply, no retries. Both sides half-close their write
 * side. EOF is required before accepting a reply, so fragmented trailing bytes
 * cannot be mistaken for a complete outcome. Native deadlines bound the owner
 * independently of this caller's remaining waiting budget.
 */
function exchange(
  grant: ServiceRenderGrant,
  request: RenderRequest,
  openTransport: () => Duplex,
  signal: AbortSignal | undefined
): Promise<ServiceClientObservation> {
  let transport: Duplex;
  if (signal?.aborted) return Promise.resolve(localObservation(request, false, 'interrupted'));
  try {
    transport = openTransport();
  } catch {
    return Promise.resolve(localObservation(request, false, 'transport_unavailable'));
  }
  return new Promise((resolve) => {
    let attempted = false;
    let settled = false;
    let bytes = Buffer.alloc(0);
    const finish = (value: ServiceClientObservation): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      transport.removeListener('data', onData);
      transport.removeListener('end', onEnd);
      transport.removeListener('close', onClose);
      transport.removeListener('error', onError);
      // A late destroy/write callback error cannot escape the bounded exchange.
      transport.once('error', () => {});
      transport.destroy();
      resolve(value);
    };
    const bad = (reason: ServiceClientFailureReason): void =>
      finish(localObservation(request, attempted, reason));
    const onAbort = (): void => bad('interrupted');
    const onError = (): void => bad('transport_error');
    const onClose = (): void => bad('transport_closed');
    const onData = (chunk: Buffer | string): void => {
      const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      if (bytes.length + incoming.length > MAX_SERVICE_BRIDGE_REPLY_BYTES + 1) {
        bad('reply_too_large');
        return;
      }
      bytes = Buffer.concat([bytes, incoming]);
    };
    const onEnd = (): void => {
      if (bytes.length === 0 || bytes[bytes.length - 1] !== 10) {
        bad('invalid_reply');
        return;
      }
      try {
        const reply = decodeServiceBridgeReply(bytes, grant, request);
        finish({ kind: 'owner_outcome', frame: reply.outcome });
      } catch {
        bad('invalid_reply');
      }
    };
    const timer = setTimeout(() => bad('timeout'), grant.remainingBudgetMs);
    transport.on('data', onData);
    transport.once('end', onEnd);
    transport.once('close', onClose);
    transport.on('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    try {
      const frame = encodeServiceBridgeRequest(grant, request);
      // Set before end/write: even a synchronous throw or error callback can
      // follow partial delivery. It is never evidence of nonexecution.
      attempted = true;
      transport.end(frame, (error?: Error | null) => {
        if (error) onError();
      });
    } catch {
      onError();
    }
  });
}
export interface ServiceClientIO {
  readonly openTransport: () => Duplex;
  /** One bounded write; native setup must prevent blocking indefinitely. */
  readonly publishReceipt: (frame: Buffer) => void;
  readonly signal?: AbortSignal;
}
export interface ServiceClientRun {
  readonly exitCode: 0 | 75;
  readonly receipt: ServiceClientReceipt | null;
  readonly receiptPublished: boolean;
}
function observedSuccess(value: ServiceClientObservation): boolean {
  if (value.kind !== 'owner_outcome') return false;
  const outcome = value.frame.outcome;
  return (
    outcome.admission === 'accepted' &&
    outcome.execution === 'returned' &&
    (outcome.result.kind === 'daemon_response' ||
      (outcome.result.kind === 'process_exit' &&
        outcome.result.code === 0 &&
        outcome.result.signal === null))
  );
}
/**
 * No discovery, admission, retry, owner creation, inline execution, or delivery
 * inference. A successful observed result remains distinct from artifact proof.
 */
export async function runServiceClient(
  grantValue: ServiceRenderGrant,
  argv: readonly string[],
  io: ServiceClientIO
): Promise<ServiceClientRun> {
  let grant: ServiceRenderGrant;
  let request: RenderRequest;
  try {
    grant = normalizeGrant(grantValue);
    request = makeServiceRenderRequest(grant, argv);
  } catch {
    return { exitCode: 75, receipt: null, receiptPublished: false };
  }
  const outcome = await exchange(grant, request, io.openTransport, io.signal);
  const receipt: ServiceClientReceipt = {
    schema: SERVICE_RECEIPT_SCHEMA,
    grantId: grant.grantId,
    grantDigest: serviceGrantDigest(grant),
    outcome,
  };
  try {
    io.publishReceipt(encodeServiceClientReceipt(receipt, grant, request));
  } catch {
    return { exitCode: 75, receipt, receiptPublished: false };
  }
  return {
    exitCode: observedSuccess(outcome) && !io.signal?.aborted ? 0 : 75,
    receipt,
    receiptPublished: true,
  };
}
/**
 * Positioned reads preserve FD4's shared open-file offset across shell/Node.
 * Native must supply a read-only, immutable regular-file descriptor. Node fs
 * cannot attest its O_ACCMODE or immutability, and this method grants nothing.
 */
export function readServiceGrantFd(fd: number = 4): ServiceRenderGrant {
  const before = fstatSync(fd);
  if (
    !before.isFile() ||
    !Number.isSafeInteger(before.size) ||
    before.size <= 0 ||
    before.size > MAX_SERVICE_GRANT_BYTES + 1
  )
    fail();
  const bytes = Buffer.alloc(before.size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count === 0) fail();
    offset += count;
  }
  const after = fstatSync(fd);
  if (
    !after.isFile() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    fail();
  return decodeServiceGrant(bytes);
}
/** FD5 must be a per-offer write-only regular or nonblocking descriptor. */
function publishReceiptFd(frame: Buffer): void {
  if (frame.length > MAX_SERVICE_RECEIPT_BYTES + 1) fail();
  let offset = 0;
  while (offset < frame.length) {
    const count = writeSync(5, frame, offset, frame.length - offset);
    if (count <= 0) fail();
    offset += count;
  }
}
export const SERVICE_NODE_MARKER = '__CAWS_SERVICE_CLIENT_NODE__';
export const SERVICE_ENTRY_MARKER = '__CAWS_SERVICE_CLIENT_ENTRY__';
/**
 * Render trusted template bytes into an immutable image using pinned absolute
 * literals. Template/client hashes and executable custody are native admission
 * obligations, including scrubbing interpreter preload/environment hooks.
 * There is no PATH, environment, shell eval, or owner lookup in this builder.
 */
export function renderServiceClientShell(
  template: string,
  nodePath: string,
  entryPath: string
): string {
  const quote = (value: string): string => {
    const path = absolutePath(value);
    if (/[\r\n]/.test(path)) fail();
    return "'" + path.replace(/'/g, "'\\''") + "'";
  };
  if (
    Buffer.from(template, 'utf8').toString('utf8') !== template ||
    Buffer.byteLength(template, 'utf8') > 16_384 ||
    template.split(SERVICE_NODE_MARKER).length !== 2 ||
    template.split(SERVICE_ENTRY_MARKER).length !== 2
  )
    fail();
  const nodeLiteral = quote(nodePath);
  const entryLiteral = quote(entryPath);
  // One pass over original template markers only. Inserted path bytes may
  // themselves contain either marker and must never be interpreted again.
  return template.replace(/__CAWS_SERVICE_CLIENT_(?:NODE|ENTRY)__/g, (marker) =>
    marker === SERVICE_NODE_MARKER ? nodeLiteral : entryLiteral
  );
}
/** Production entry: only the three inherited descriptor capabilities are used. */
export async function serviceClientMain(
  argv: readonly string[] = process.argv.slice(2)
): Promise<0 | 75> {
  let grant: ServiceRenderGrant;
  try {
    grant = readServiceGrantFd(4);
  } catch {
    process.stderr.write('CAWS session render service unavailable\n');
    return 75;
  }
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const signal of signals) process.once(signal, onSignal);
  try {
    const result = await runServiceClient(grant, argv, {
      openTransport: () =>
        new Socket({ fd: 3, readable: true, writable: true, allowHalfOpen: true }),
      publishReceipt: publishReceiptFd,
      signal: controller.signal,
    });
    if (result.exitCode !== 0) process.stderr.write('CAWS session render service unavailable\n');
    return result.exitCode;
  } finally {
    for (const signal of signals) process.removeListener(signal, onSignal);
  }
}
if (require.main === module) {
  void serviceClientMain().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write('CAWS session render service unavailable\n');
      process.exitCode = 75;
    }
  );
}
