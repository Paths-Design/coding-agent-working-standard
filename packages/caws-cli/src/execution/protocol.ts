import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { parseJsonSource } from '../runtime/json-custody';
import { decodePreparedExecution, MAX_PREPARED_RECORD_BYTES } from './prepared-schema';
import type { AuthorizerReply, AuthorizerRequest, PreparedExecutionV1 } from './prepared';
import { EXECUTION_REASON_CODES } from './prepared';

export const MAX_AUTHORIZER_REQUEST_BYTES = 4 * 1024 * 1024;
export const MAX_AUTHORIZER_REPLY_BYTES = 64 * 1024;
export class InvalidAuthorizerFrame extends Error {
  constructor() {
    super('Invalid execution authorizer frame');
    this.name = 'InvalidAuthorizerFrame';
  }
}
function insist(value: unknown): asserts value {
  if (!value) throw new InvalidAuthorizerFrame();
}
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  insist(value !== null && typeof value === 'object' && !Array.isArray(value));
  const row = value as Record<string, unknown>;
  insist(Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key)));
}
function identity(value: unknown): asserts value is string {
  insist(
    typeof value === 'string' &&
      value.length > 0 &&
      Buffer.byteLength(value) <= 256 &&
      !/\p{Cc}/u.test(value) &&
      Buffer.from(value).toString('utf8') === value
  );
}
function u64(value: unknown): void {
  insist(
    typeof value === 'string' &&
      /^(?:0|[1-9][0-9]{0,19})$/.test(value) &&
      BigInt(value) <= 18446744073709551615n
  );
}
function digest(value: unknown): asserts value is string {
  insist(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
}

/** Complete frame only: incomplete, duplicate and trailing frames never yield an observation. */
export function decodeAuthorizerRequest(frame: Uint8Array): {
  readonly request: AuthorizerRequest;
  readonly record: PreparedExecutionV1;
  readonly recordBytes: Buffer;
} {
  try {
    insist(
      frame instanceof Uint8Array &&
        frame.byteLength >= 4 &&
        frame.byteLength <= MAX_AUTHORIZER_REQUEST_BYTES + 4
    );
    const bytes = Buffer.from(frame);
    const length = bytes.readUInt32BE();
    insist(length > 0 && length <= MAX_AUTHORIZER_REQUEST_BYTES && bytes.length === length + 4);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(4)
    );
    parseJsonSource(text, 4, 64, true);
    const value: unknown = JSON.parse(text);
    exact(value, [
      'protocol',
      'phase',
      'invocationId',
      'recordBase64',
      'executionDigest',
      'expectedAuthorityRevision',
      'fence',
    ]);
    insist(
      value.protocol === 'caws.execution.authorizer.v1' &&
        (value.phase === 'analyze' || value.phase === 'final_validate')
    );
    identity(value.invocationId);
    digest(value.executionDigest);
    insist(
      typeof value.recordBase64 === 'string' &&
        value.recordBase64.length <= 4 * Math.ceil(MAX_PREPARED_RECORD_BYTES / 3)
    );
    const recordBytes = Buffer.from(value.recordBase64, 'base64');
    insist(
      recordBytes.length <= MAX_PREPARED_RECORD_BYTES &&
        recordBytes.toString('base64') === value.recordBase64 &&
        createHash('sha256').update(recordBytes).digest('hex') === value.executionDigest
    );
    if (value.phase === 'analyze')
      insist(value.expectedAuthorityRevision === null && value.fence === null);
    else {
      identity(value.expectedAuthorityRevision);
      exact(value.fence, ['dev', 'ino', 'nonce']);
      u64(value.fence.dev);
      u64(value.fence.ino);
      identity(value.fence.nonce);
      Object.freeze(value.fence);
    }
    const record = decodePreparedExecution(recordBytes);
    insist(record.invocationId === value.invocationId);
    return Object.freeze({
      request: Object.freeze(value) as unknown as AuthorizerRequest,
      record,
      recordBytes,
    });
  } catch {
    throw new InvalidAuthorizerFrame();
  }
}

/** Validate an owned observation before writing it; never serialize submitted source in diagnostics. */
export function encodeAuthorizerReply(reply: AuthorizerReply): Buffer {
  try {
    exact(reply, [
      'protocol',
      'phase',
      'invocationId',
      'executionDigest',
      'decision',
      'authorityRevision',
      'reasonCodes',
    ]);
    insist(
      reply.protocol === 'caws.execution.authorizer.v1' &&
        (reply.phase === 'analyze' || reply.phase === 'final_validate')
    );
    identity(reply.invocationId);
    digest(reply.executionDigest);
    insist(['allow', 'deny', 'unresolved'].includes(reply.decision));
    if (reply.authorityRevision !== null) identity(reply.authorityRevision);
    insist(reply.decision !== 'allow' || reply.authorityRevision !== null);
    insist(
      Array.isArray(reply.reasonCodes) &&
        reply.reasonCodes.length <= 32 &&
        reply.reasonCodes.every((code) => EXECUTION_REASON_CODES.includes(code))
    );
    const payload = Buffer.from(JSON.stringify(reply));
    insist(payload.length > 0 && payload.length <= MAX_AUTHORIZER_REPLY_BYTES);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length);
    return Buffer.concat([header, payload]);
  } catch {
    throw new InvalidAuthorizerFrame();
  }
}
