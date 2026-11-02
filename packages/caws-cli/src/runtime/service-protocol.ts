import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

export const RENDER_REQUEST_SCHEMA = 'caws.service.render.request.v1' as const;
export const RENDER_OUTCOME_SCHEMA = 'caws.service.render.outcome.v1' as const;
export const RENDER_ARGUMENT_ENCODING = 'caws-session-render-argv-v1' as const;
export const MAX_RENDER_ARGUMENT_BYTES = 65_536;
/** JSON body limits exclude the single optional LF transport delimiter. */
export const MAX_RENDER_REQUEST_BYTES = 131_072;
export const MAX_RENDER_OUTCOME_BYTES = 8_192;

export const RENDER_ARGUMENT_NAMES = Object.freeze([
  'logDir',
  'cwd',
  'sessionId',
  'startedAt',
  'model',
  'branch',
  'headSha',
  'dirtyCount',
  'startSha',
  'transcriptPath',
  'auditLog',
  'hookOutcomeLog',
] as const);

/**
 * JSON carries lossless UTF-8 argv data, including CR/LF/US; POSIX argv cannot
 * carry NUL. Backend wire suitability is the exclusive owner's responsibility:
 * legacy LF/US requests need a serialized owned direct-render backend or an
 * explicit unavailable outcome. CR alone is not a legacy wire delimiter.
 * Unsupported backend data never authorizes caller-side inline fallback.
 */
export type RendererArguments = readonly [
  logDir: string,
  cwd: string,
  sessionId: string,
  startedAt: string,
  model: string,
  branch: string,
  headSha: string,
  dirtyCount: string,
  startSha: string,
  transcriptPath: string,
  auditLog: string,
  hookOutcomeLog: string,
];

export interface OriginalRenderSource {
  readonly handlerSha256: string;
  readonly closureDigest: string;
}

export interface RenderExecutionImage {
  readonly imageDigest: string;
  readonly clientSha256: string;
}

export interface RenderRequest {
  readonly schema: typeof RENDER_REQUEST_SCHEMA;
  readonly requestId: string;
  readonly invocationId: string;
  readonly selectedIndex: number;
  readonly operation: 'render:0';
  /** Lexical identity only; this module performs no realpath or authority check. */
  readonly canonicalProject: string;
  readonly projectServiceKey: string;
  /** Opaque producer binding; this module does not verify source bytes. */
  readonly sourceGeneration: string;
  readonly originalSource: OriginalRenderSource;
  readonly executionImage: RenderExecutionImage;
  readonly argumentDigest: string;
  readonly arguments: RendererArguments;
}

export type RenderRequestInput = Pick<
  RenderRequest,
  | 'invocationId'
  | 'selectedIndex'
  | 'canonicalProject'
  | 'sourceGeneration'
  | 'originalSource'
  | 'executionImage'
  | 'arguments'
>;

export type RenderResult =
  | {
      readonly kind: 'process_exit';
      readonly code: number;
      readonly signal: null;
    }
  | {
      readonly kind: 'process_exit';
      readonly code: null;
      readonly signal: number;
    }
  | {
      readonly kind: 'daemon_response';
      readonly response: 'ok';
      readonly served: number;
      readonly elapsedMs: number;
      readonly cached: boolean;
    };

export type CancelReason = 'source_retired' | 'grant_withdrawn';

export type RenderOutcome =
  | {
      readonly admission: 'rejected';
      readonly execution: 'known_not_executed';
      readonly reason: string;
    }
  | {
      readonly admission: 'accepted';
      readonly execution: 'queued' | 'running' | 'unknown';
    }
  | {
      readonly admission: 'accepted';
      readonly execution: 'cancelled_before_dispatch';
      readonly reason: CancelReason;
    }
  | {
      readonly admission: 'accepted';
      readonly execution: 'returned';
      readonly result: RenderResult;
      readonly artifactManifestDigest: string | null;
    };

export interface RenderOutcomeFrame {
  readonly schema: typeof RENDER_OUTCOME_SCHEMA;
  readonly requestId: string;
  readonly argumentDigest: string;
  readonly projectServiceKey: string;
  readonly sourceGeneration: string;
  readonly executionImageDigest: string;
  readonly outcome: RenderOutcome;
}

export class ServiceProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceProtocolError';
  }
}

const INPUT_KEYS = [
  'invocationId',
  'selectedIndex',
  'canonicalProject',
  'sourceGeneration',
  'originalSource',
  'executionImage',
  'arguments',
] as const;
const REQUEST_KEYS = [
  'schema',
  'requestId',
  'invocationId',
  'selectedIndex',
  'operation',
  'canonicalProject',
  'projectServiceKey',
  'sourceGeneration',
  'originalSource',
  'executionImage',
  'argumentDigest',
  'arguments',
] as const;
const OUTCOME_KEYS = [
  'schema',
  'requestId',
  'argumentDigest',
  'projectServiceKey',
  'sourceGeneration',
  'executionImageDigest',
  'outcome',
] as const;

function fail(message: string): never {
  // Callers supply fixed diagnostics, never untrusted frame contents.
  throw new ServiceProtocolError(message);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  return (
    record(value) &&
    Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name))
  );
}

function lossless(value: string): boolean {
  return Buffer.from(value, 'utf8').toString('utf8') === value;
}

function sha(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    fail('Service digest must be lowercase SHA-256');
  return value;
}

function uint(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  )
    fail('Service integer is outside its v1 range');
  return value;
}

function invocation(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))
    fail('Invalid render invocation identity');
  return value;
}

function project(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !lossless(value) ||
    Buffer.byteLength(value, 'utf8') > 4096 ||
    !value.startsWith('/') ||
    value.includes('\0') ||
    (value !== '/' &&
      value
        .slice(1)
        .split('/')
        .some((part) => part === '' || part === '.' || part === '..'))
  )
    fail('Render project must be a bounded normalized absolute POSIX path');
  return value;
}

function argumentsOf(value: unknown): RendererArguments {
  if (
    !Array.isArray(value) ||
    value.length !== 12 ||
    Object.keys(value).join(',') !== '0,1,2,3,4,5,6,7,8,9,10,11'
  )
    fail('Renderer arguments require exactly twelve fields');
  const fields: string[] = [];
  for (const field of value) {
    if (typeof field !== 'string' || !lossless(field) || field.includes('\0'))
      fail('Renderer fields require lossless UTF-8 without NUL');
    fields.push(field);
  }
  if (
    Buffer.byteLength(JSON.stringify([RENDER_ARGUMENT_ENCODING, fields]), 'utf8') >
    MAX_RENDER_ARGUMENT_BYTES
  )
    fail('Renderer argument payload exceeds 65536 UTF-8 bytes');
  // Length and every field have been checked before this tuple conversion.
  return Object.freeze(fields) as unknown as RendererArguments;
}

function originalSource(value: unknown): OriginalRenderSource {
  if (!exact(value, ['handlerSha256', 'closureDigest']))
    fail('Malformed original render source identity');
  return Object.freeze({
    handlerSha256: digest(value.handlerSha256),
    closureDigest: digest(value.closureDigest),
  });
}

function executionImage(value: unknown): RenderExecutionImage {
  if (!exact(value, ['imageDigest', 'clientSha256']))
    fail('Malformed render execution image identity');
  return Object.freeze({
    imageDigest: digest(value.imageDigest),
    clientSha256: digest(value.clientSha256),
  });
}

export function renderArgumentDigest(args: readonly string[]): string {
  return sha(JSON.stringify([RENDER_ARGUMENT_ENCODING, argumentsOf(args)]));
}

export function renderRequestId(invocationId: string, selectedIndex: number): string {
  return sha(
    JSON.stringify([
      'caws-service-render-request-id-v1',
      invocation(invocationId),
      uint(selectedIndex, 0, 65_535),
      'render:0',
    ])
  );
}

export function projectServiceKey(canonicalProject: string): string {
  return sha(
    JSON.stringify(['caws-project-service-key-v1', project(canonicalProject), 'session-render'])
  );
}

function body(value: RenderRequest | RenderOutcomeFrame, maximum: number): string {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > maximum)
    fail('Service JSON body exceeds its v1 byte limit');
  return encoded;
}

function makeRequest(value: Record<string, unknown>): RenderRequest {
  const invocationId = invocation(value.invocationId);
  const selectedIndex = uint(value.selectedIndex, 0, 65_535);
  const canonicalProject = project(value.canonicalProject);
  const args = argumentsOf(value.arguments);
  // Property order is the encoder's documented v1 order.
  const request: RenderRequest = Object.freeze({
    schema: RENDER_REQUEST_SCHEMA,
    requestId: renderRequestId(invocationId, selectedIndex),
    invocationId,
    selectedIndex,
    operation: 'render:0',
    canonicalProject,
    projectServiceKey: projectServiceKey(canonicalProject),
    sourceGeneration: digest(value.sourceGeneration),
    originalSource: originalSource(value.originalSource),
    executionImage: executionImage(value.executionImage),
    argumentDigest: renderArgumentDigest(args),
    arguments: args,
  });
  body(request, MAX_RENDER_REQUEST_BYTES);
  return request;
}

/** Constructs data only: no admission, filesystem verification, or ownership. */
export function createRenderRequest(input: RenderRequestInput): RenderRequest {
  if (!exact(input, INPUT_KEYS)) fail('Malformed render request input');
  return makeRequest(input);
}

function normalizeRequest(value: unknown): RenderRequest {
  if (
    !exact(value, REQUEST_KEYS) ||
    value.schema !== RENDER_REQUEST_SCHEMA ||
    value.operation !== 'render:0'
  )
    fail('Malformed render request');
  const expected = makeRequest(value);
  if (
    digest(value.requestId) !== expected.requestId ||
    digest(value.projectServiceKey) !== expected.projectServiceKey ||
    digest(value.argumentDigest) !== expected.argumentDigest
  )
    fail('Render request derived identity mismatch');
  return expected;
}

function decode(frame: Uint8Array | string, maximum: number): unknown {
  if (typeof frame !== 'string' && !(frame instanceof Uint8Array))
    fail('Service frame must be UTF-8 bytes or text');
  if (
    (typeof frame === 'string' ? Buffer.byteLength(frame, 'utf8') : frame.byteLength) >
    maximum + 1
  )
    fail('Service JSON body exceeds its v1 byte limit');
  if (typeof frame === 'string' && !lossless(frame)) fail('Service frame is not lossless UTF-8');
  const bytes = typeof frame === 'string' ? Buffer.from(frame, 'utf8') : Buffer.from(frame);
  let text: string;
  try {
    // Preserve a BOM so JSON parsing rejects it instead of silently stripping it.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail('Service frame is not lossless UTF-8');
  }
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail('Service frame is not lossless UTF-8');
  const source = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (Buffer.byteLength(source, 'utf8') > maximum)
    fail('Service JSON body exceeds its v1 byte limit');
  try {
    const value: unknown = JSON.parse(source);
    if (JSON.stringify(value) !== source) fail('Service frame must use canonical v1 JSON');
    return value;
  } catch {
    fail('Service frame must use canonical v1 JSON');
  }
}

export function encodeRenderRequest(request: RenderRequest): Buffer {
  return Buffer.from(body(normalizeRequest(request), MAX_RENDER_REQUEST_BYTES) + '\n', 'utf8');
}

export function decodeRenderRequest(frame: Uint8Array | string): RenderRequest {
  return normalizeRequest(decode(frame, MAX_RENDER_REQUEST_BYTES));
}

function resultOf(value: unknown): RenderResult {
  if (!record(value)) fail('Malformed render result');
  if (value.kind === 'process_exit') {
    if (
      !exact(value, ['kind', 'code', 'signal']) ||
      (value.code === null) === (value.signal === null)
    )
      fail('Process exit requires exactly one code or signal');
    return value.code !== null
      ? Object.freeze({
          kind: 'process_exit',
          code: uint(value.code, 0, 255),
          signal: null,
        })
      : Object.freeze({
          kind: 'process_exit',
          code: null,
          signal: uint(value.signal, 1, 127),
        });
  }
  if (
    value.kind === 'daemon_response' &&
    exact(value, ['kind', 'response', 'served', 'elapsedMs', 'cached']) &&
    value.response === 'ok' &&
    typeof value.cached === 'boolean'
  )
    return Object.freeze({
      kind: 'daemon_response',
      response: 'ok',
      served: uint(value.served, 1, Number.MAX_SAFE_INTEGER),
      elapsedMs: uint(value.elapsedMs, 0, Number.MAX_SAFE_INTEGER),
      cached: value.cached,
    });
  fail('Malformed render result');
}

function outcomeOf(value: unknown): RenderOutcome {
  if (!record(value)) fail('Malformed render outcome');
  if (
    value.admission === 'rejected' &&
    value.execution === 'known_not_executed' &&
    exact(value, ['admission', 'execution', 'reason'])
  ) {
    if (
      typeof value.reason !== 'string' ||
      !lossless(value.reason) ||
      Buffer.byteLength(value.reason, 'utf8') > 1024
    )
      fail('Render rejection reason exceeds its UTF-8 envelope');
    return Object.freeze({
      admission: 'rejected',
      execution: 'known_not_executed',
      reason: value.reason,
    });
  }
  if (value.admission !== 'accepted') fail('Malformed render outcome');
  if (value.execution === 'cancelled_before_dispatch') {
    if (!exact(value, ['admission', 'execution', 'reason']))
      fail('Malformed pre-dispatch cancellation');
    const reason = value.reason;
    if (reason !== 'source_retired' && reason !== 'grant_withdrawn')
      fail('Malformed pre-dispatch cancellation');
    return Object.freeze({
      admission: 'accepted',
      execution: 'cancelled_before_dispatch',
      reason,
    });
  }
  if (
    (value.execution === 'queued' ||
      value.execution === 'running' ||
      value.execution === 'unknown') &&
    exact(value, ['admission', 'execution'])
  )
    return Object.freeze({ admission: 'accepted', execution: value.execution });
  if (
    value.execution === 'returned' &&
    exact(value, ['admission', 'execution', 'result', 'artifactManifestDigest'])
  )
    return Object.freeze({
      admission: 'accepted',
      execution: 'returned',
      result: resultOf(value.result),
      artifactManifestDigest:
        value.artifactManifestDigest === null ? null : digest(value.artifactManifestDigest),
    });
  fail('Malformed render outcome');
}

function normalizeOutcome(value: unknown, origin: RenderRequest): RenderOutcomeFrame {
  const request = normalizeRequest(origin);
  if (!exact(value, OUTCOME_KEYS) || value.schema !== RENDER_OUTCOME_SCHEMA)
    fail('Malformed render outcome frame');
  const frame: RenderOutcomeFrame = Object.freeze({
    schema: RENDER_OUTCOME_SCHEMA,
    requestId: digest(value.requestId),
    argumentDigest: digest(value.argumentDigest),
    projectServiceKey: digest(value.projectServiceKey),
    sourceGeneration: digest(value.sourceGeneration),
    executionImageDigest: digest(value.executionImageDigest),
    outcome: outcomeOf(value.outcome),
  });
  if (
    frame.requestId !== request.requestId ||
    frame.argumentDigest !== request.argumentDigest ||
    frame.projectServiceKey !== request.projectServiceKey ||
    frame.sourceGeneration !== request.sourceGeneration ||
    frame.executionImageDigest !== request.executionImage.imageDigest
  )
    fail('Render outcome identity mismatch');
  body(frame, MAX_RENDER_OUTCOME_BYTES);
  return frame;
}

/**
 * Validated outcome claims are transport observations, not verified ownership,
 * artifact delivery, inline-fallback permission, or authority to replay effects.
 */
export function encodeRenderOutcome(frame: RenderOutcomeFrame, origin: RenderRequest): Buffer {
  return Buffer.from(
    body(normalizeOutcome(frame, origin), MAX_RENDER_OUTCOME_BYTES) + '\n',
    'utf8'
  );
}

export function decodeRenderOutcome(
  frame: Uint8Array | string,
  origin: RenderRequest
): RenderOutcomeFrame {
  return normalizeOutcome(decode(frame, MAX_RENDER_OUTCOME_BYTES), origin);
}

/** Compares identity only; it neither stores a ledger nor dispatches work. */
export function classifyRenderReplay(
  existing: RenderRequest,
  incoming: RenderRequest
): 'different_request' | 'replay' {
  const first = normalizeRequest(existing);
  const next = normalizeRequest(incoming);
  if (first.requestId !== next.requestId) return 'different_request';
  if (JSON.stringify(first) !== JSON.stringify(next))
    fail('Render replay conflicts with the existing immutable request');
  return 'replay';
}
