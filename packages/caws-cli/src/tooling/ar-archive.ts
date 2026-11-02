/** Pure regular BSD #1/N framing. Inventory confers no native admission authority. */
import { createHash } from 'node:crypto';
import { isSharedArrayBuffer, isUint8Array } from 'node:util/types';

export interface ArInspectionLimits {
  readonly maxArchiveBytes: number;
  readonly maxMembers: number;
  /** Stored size includes the BSD extended name. */
  readonly maxMemberBytes: number;
  readonly maxNameBytes: number;
}
export interface ArByteIdentity {
  readonly offset: number;
  readonly sizeBytes: number;
  readonly sha256: string;
}
export interface ArMember {
  readonly index: number;
  /** Printable ASCII, removing only trailing NUL padding. */
  readonly name: string;
  readonly storedSizeBytes: number;
  readonly header: ArByteIdentity;
  readonly rawName: ArByteIdentity;
  readonly payload: ArByteIdentity;
  readonly alignment: ArByteIdentity;
}
export type ArBytePart = 'header' | 'rawName' | 'payload' | 'alignment';
export interface ArInventory {
  readonly format: 'bsd-extended-ar/1';
  readonly archive: ArByteIdentity;
  readonly members: readonly ArMember[];
  /** Returns independent bytes from the private snapshot. */
  copyBytes(index: number, part: ArBytePart): Uint8Array;
}
export class ArInspectionError extends Error {
  constructor(
    readonly code: string,
    readonly offset: number,
    detail: string
  ) {
    super(`${code} at byte ${offset}: ${detail}`);
    this.name = 'ArInspectionError';
  }
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const intrinsicGetter = (key: string): ((this: Uint8Array) => unknown) =>
  Object.getOwnPropertyDescriptor(typedArrayPrototype, key)!.get!;
const bufferGetter = intrinsicGetter('buffer');
const offsetGetter = intrinsicGetter('byteOffset');
const lengthGetter = intrinsicGetter('byteLength');
const PARTS: readonly ArBytePart[] = Object.freeze(['header', 'rawName', 'payload', 'alignment']);

/**
 * Synchronous framing inspection with explicit budgets and no I/O.
 * Shared memory is refused because copying it cannot establish an atomic
 * snapshot. Metadata remains ordinary inventory. Object files, symbol tables,
 * compiler provenance and native-profile admission require separate validation.
 */
export function inspectBsdAr(input: Uint8Array, limits: ArInspectionLimits): ArInventory {
  const fail = (code: string, offset: number, detail: string): never => {
    throw new ArInspectionError(code, offset, detail);
  };
  const budget = {} as Record<keyof ArInspectionLimits, number>;
  for (const key of ['maxArchiveBytes', 'maxMembers', 'maxMemberBytes', 'maxNameBytes'] as const) {
    const value = limits?.[key];
    if (!Number.isSafeInteger(value) || value < 0) fail('invalid_limit', 0, key);
    budget[key] = value;
  }
  if (!isUint8Array(input)) fail('invalid_input', 0, 'requires Uint8Array');
  const backing = bufferGetter.call(input) as ArrayBuffer;
  if (isSharedArrayBuffer(backing)) fail('shared_input', 0, 'shared snapshot refused');
  const length = lengthGetter.call(input) as number;
  if (length > budget.maxArchiveBytes) fail('archive_limit', 0, 'archive budget exceeded');

  let bytes: Buffer;
  try {
    // Intrinsic coordinates prevent subclass getters from disguising shared
    // backing memory or redirecting the captured view.
    // Unpooled storage keeps a caller's pooled input/copy ArrayBuffer from
    // exposing the private snapshot through another slice of the same pool.
    bytes = Buffer.alloc(length);
    bytes.set(new Uint8Array(backing, offsetGetter.call(input) as number, length));
  } catch {
    return fail('invalid_input', 0, 'backing memory unavailable');
  }
  const identity = (offset: number, sizeBytes: number): ArByteIdentity =>
    Object.freeze({
      offset,
      sizeBytes,
      sha256: createHash('sha256')
        .update(bytes.subarray(offset, offset + sizeBytes))
        .digest('hex'),
    });

  if (bytes.subarray(0, 8).equals(Buffer.from('!<thin>\n')))
    fail('unsupported_format', 0, 'thin archive');
  if (!bytes.subarray(0, 8).equals(Buffer.from('!<arch>\n')))
    fail('invalid_magic', 0, 'regular ar magic required');

  const members: ArMember[] = [];
  const names = new Set<string>();
  let offset = 8;
  while (offset < bytes.length) {
    if (members.length >= budget.maxMembers)
      fail('member_count_limit', offset, 'member count exceeded');
    if (bytes.length - offset < 60) fail('truncated_header', offset, 'requires 60 bytes');

    const ascii = (start: number, end: number): string => {
      const field = bytes.subarray(offset + start, offset + end);
      if (field.some((byte) => byte < 0x20 || byte > 0x7e))
        fail('invalid_header', offset + start, 'non-ASCII header');
      return field.toString('ascii');
    };
    if (bytes[offset + 58] !== 0x60 || bytes[offset + 59] !== 0x0a)
      fail('invalid_trailer', offset + 58, 'requires backtick and newline');
    const nameField = ascii(0, 16);
    for (const [start, end, pattern] of [
      [16, 28, /^[0-9]+ *$/],
      [28, 34, /^[0-9]+ *$/],
      [34, 40, /^[0-9]+ *$/],
      [40, 48, /^[0-7]+ *$/],
    ] as const) {
      if (!pattern.test(ascii(start, end)))
        fail('invalid_header', offset + start, 'invalid numeric metadata');
    }

    const sizeField = ascii(48, 58);
    if (!/^[0-9]+ *$/.test(sizeField))
      fail('invalid_size', offset + 48, 'decimal stored size required');
    const storedSize = Number(sizeField.trimEnd());
    // Ten decimal positions cannot overflow a safe integer. Keep the
    // invariant explicit rather than rely on coercive parsing.
    if (!Number.isSafeInteger(storedSize)) fail('invalid_size', offset + 48, 'unsafe stored size');
    if (storedSize > budget.maxMemberBytes)
      fail('member_byte_limit', offset, 'stored member budget exceeded');
    const body = offset + 60;
    if (storedSize > bytes.length - body)
      fail('truncated_member', body, 'size exceeds remaining bytes');

    const match = /^#1\/([0-9]+) *$/.exec(nameField);
    if (!match) fail('unsupported_name_form', offset, 'only BSD #1/N names supported');
    const nameSize = Number(match![1]);
    if (!Number.isSafeInteger(nameSize) || nameSize === 0 || nameSize > storedSize)
      fail('invalid_name_size', offset, 'name size must fit stored member');
    if (nameSize > budget.maxNameBytes) fail('name_byte_limit', body, 'name budget exceeded');

    const rawName = bytes.subarray(body, body + nameSize);
    const nul = rawName.indexOf(0);
    const end = nul < 0 ? rawName.length : nul;
    if (
      end === 0 ||
      rawName.subarray(0, end).some((byte) => byte < 0x20 || byte > 0x7e) ||
      (nul >= 0 && rawName.subarray(nul).some((byte) => byte !== 0))
    )
      fail('invalid_name', body, 'printable name with trailing NUL padding required');
    const name = rawName.subarray(0, end).toString('ascii');
    if (names.has(name)) fail('duplicate_name', body, 'normalized member name already exists');
    names.add(name);

    const payloadEnd = body + storedSize;
    const padding = storedSize % 2;
    if (padding && bytes[payloadEnd] !== 0x0a)
      fail('invalid_alignment', payloadEnd, 'odd stored size requires newline');
    members.push(
      Object.freeze({
        index: members.length,
        name,
        storedSizeBytes: storedSize,
        header: identity(offset, 60),
        rawName: identity(body, nameSize),
        payload: identity(body + nameSize, storedSize - nameSize),
        alignment: identity(payloadEnd, padding),
      })
    );
    offset = payloadEnd + padding;
  }

  return Object.freeze({
    format: 'bsd-extended-ar/1' as const,
    archive: identity(0, bytes.length),
    members: Object.freeze(members),
    copyBytes(index: number, part: ArBytePart): Uint8Array {
      if (!Number.isSafeInteger(index) || index < 0 || index >= members.length)
        fail('invalid_accessor', 0, 'member index out of range');
      if (!PARTS.includes(part)) fail('invalid_accessor', 0, 'unknown byte part');
      const range = members[index]![part];
      return Uint8Array.from(bytes.subarray(range.offset, range.offset + range.sizeBytes));
    },
  });
}
