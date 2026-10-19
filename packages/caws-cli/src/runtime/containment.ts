import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { TextDecoder } from 'node:util';
import type { NativeResult } from './types';
import type { RuntimeRequest } from './protocol';
import type { ActiveInvocationSelection, SelectedHandler } from './selection';
import { parseJsonSource, objectMemberSource, type JsonSource } from './json-custody';
import { readOperationalFile } from './operational-files';
import { qualifiesForNativeContainment } from './stock-handlers';

export const CONTAINMENT_ENV = 'CAWS_NATIVE_CONTAINMENT_FILE';
export const CONTAINMENT_INTENT_SCHEMA = 'caws.containment.intent.v1';
export const CONTAINMENT_RECEIPT_SCHEMA = 'caws.containment.receipt.v1';
const INTENT_LIMIT = 64 * 1024;
/** Selected producer passes command+reason together through jq --arg. JSON
 * escaping expands each admitted argument byte by at most six; 32 KiB covers
 * the fixed producer fields, bounded identity and 200-byte strike projection.
 * This is a producer bound, not the original hook-input bound (a sidecar can
 * contribute classifier reason text). Revisit it when that producer changes.
 */
export function producerLatchReadLimit(argumentBytes: string): number {
  if (!/^[1-9][0-9]*\n?$/.test(argumentBytes))
    throw new Error('Producer argument limit is unavailable');
  const maximum = Number(argumentBytes.trim());
  if (!Number.isSafeInteger(maximum) || maximum > 8 * 1024 * 1024)
    throw new Error('Producer argument limit exceeds the supported envelope');
  return maximum * 6 + 32 * 1024;
}
function observeLatchReadLimit(): number {
  return producerLatchReadLimit(
    execFileSync('/usr/bin/getconf', ['ARG_MAX'], {
      encoding: 'utf8',
      env: { LC_ALL: 'C' },
      timeout: 250,
      maxBuffer: 128,
    })
  );
}
function readLatch(root: string, file: string, maximum: number): Buffer {
  // Avoid allocating the full producer allowance for ordinary small records.
  // The owning read repeats size/type/link/owner and no-follow checks. A race
  // that grows the file beyond this snapshot is unavailable, never truncated.
  const size = lstatSync(file).size;
  return readOperationalFile(root, file, Math.min(maximum, size + 1));
}
const fields = ['pid', 'startEpoch', 'comm', 'sessionId', 'latchPath', 'latchGeneration'] as const;
const keys = ['schema', ...fields];
export interface ContainmentIntent {
  readonly schema: typeof CONTAINMENT_INTENT_SCHEMA;
  readonly pid: number;
  readonly startEpoch: string;
  readonly comm: string;
  readonly sessionId: string;
  readonly latchPath: string;
  readonly latchGeneration: string;
}
export interface ContainmentReceipt extends Omit<ContainmentIntent, 'schema'> {
  readonly schema: typeof CONTAINMENT_RECEIPT_SCHEMA;
  readonly status: 'held' | 'signal-accepted';
  readonly reason:
    | 'signal-accepted'
    | 'not-captured'
    | 'unsafe-target'
    | 'identity-mismatch'
    | 'observation-unavailable'
    | 'signal-failed'
    | 'capture-unavailable';
  readonly errno: number | null;
}
declare const validated: unique symbol;
export type ValidatedContainmentIntent = ContainmentIntent & { readonly [validated]: true };
interface Evidence {
  readonly requestId: string;
  readonly selection: ActiveInvocationSelection;
  readonly handler: SelectedHandler;
  readonly latchRoot: string;
  readonly latchHash: string;
  readonly latchLimit: number;
}
const owned = new WeakMap<object, Evidence>();
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function exact(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}
function string(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= limit &&
    Buffer.from(value, 'utf8').toString('utf8') === value
  );
}
function positive(value: unknown, limit: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= limit;
}
function canonical(source: JsonSource | undefined): boolean {
  return Boolean(
    source && /^[1-9][0-9]*$/.test(source.text.slice(source.root.start, source.root.end))
  );
}
function tuple(value: Record<string, unknown>): boolean {
  return (
    positive(value.pid, 2_147_483_647) &&
    typeof value.startEpoch === 'string' &&
    /^[1-9][0-9]{0,19}$/.test(value.startEpoch) &&
    string(value.comm, 4096) &&
    string(value.sessionId, 128) &&
    value.sessionId !== 'unknown' &&
    string(value.latchPath, 4096) &&
    isAbsolute(value.latchPath) &&
    typeof value.latchGeneration === 'string' &&
    /^[a-f0-9]{32}$/.test(value.latchGeneration)
  );
}
/** Parses data only. A parsed object has no executor provenance and cannot authorize an effect. */
export function parseContainmentIntent(text: string): ContainmentIntent {
  if (Buffer.byteLength(text, 'utf8') > INTENT_LIMIT)
    throw new Error('Containment intent exceeds byte limit');
  const source = parseJsonSource(text, 8, 64);
  const value: unknown = JSON.parse(text);
  if (
    !record(value) ||
    !exact(value, keys) ||
    value.schema !== CONTAINMENT_INTENT_SCHEMA ||
    !tuple(value) ||
    !canonical(objectMemberSource(source, 'pid'))
  )
    throw new Error('Malformed containment intent');
  return Object.freeze(value) as unknown as ContainmentIntent;
}
export function containmentWire(intent: ValidatedContainmentIntent): ContainmentIntent {
  if (!owned.has(intent)) throw new Error('Containment intent lacks executor provenance');
  return Object.freeze({
    schema: CONTAINMENT_INTENT_SCHEMA,
    ...Object.fromEntries(fields.map((key) => [key, intent[key]])),
  }) as unknown as ContainmentIntent;
}
function sameHandler(left: SelectedHandler, right: SelectedHandler): boolean {
  return (
    left.kind === 'stock' &&
    right.kind === 'stock' &&
    left.path === right.path &&
    left.entry === right.entry &&
    left.sha256 === right.sha256 &&
    left.args.length === 0 &&
    right.args.length === 0
  );
}
/** Only decision-owned copies retain the module-private provenance; observer copies do not. */
export function copyContainment(
  value: unknown,
  selection: ActiveInvocationSelection,
  handler: SelectedHandler,
  requestId: string | undefined
): ValidatedContainmentIntent | null {
  if (!record(value)) return null;
  const evidence = owned.get(value);
  if (
    !evidence ||
    evidence.requestId !== requestId ||
    !sameHandler(evidence.handler, handler) ||
    evidence.selection.runtimeDigest !== selection.runtimeDigest ||
    evidence.selection.checkout !== selection.checkout ||
    evidence.selection.canonical !== selection.canonical ||
    selection.surface !== 'codex' ||
    selection.event !== 'pre_tool_use' ||
    selection.configuration !== 'system' ||
    selection.handlers.some((entry) => entry.kind !== 'stock') ||
    Object.values(selection.libraries).some(
      (entry) => entry.kind === 'project' || entry.kind === 'user'
    ) ||
    Object.keys(selection.libraryOverrides).length > 0 ||
    Object.keys(selection.overrides).length > 0
  )
    return null;
  const clone = containmentWire(
    value as unknown as ValidatedContainmentIntent
  ) as ValidatedContainmentIntent;
  owned.set(clone, evidence);
  return clone;
}
function protective(result: NativeResult): boolean {
  try {
    const value: unknown = JSON.parse(Buffer.from(result.stdout).toString('utf8'));
    if (!record(value)) return false;
    const specific = record(value.hookSpecificOutput) ? value.hookSpecificOutput : {};
    const decision =
      value.decision === undefined || value.decision === null || value.decision === false
        ? specific.permissionDecision
        : value.decision;
    return decision === 'block' || decision === 'deny';
  } catch {
    return false;
  }
}
function latchMatches(value: unknown, intent: ContainmentIntent): boolean {
  return (
    record(value) &&
    value.agent_pid === String(intent.pid) &&
    value.agent_pid_started_at === intent.startEpoch &&
    value.agent_pid_comm === intent.comm &&
    value.latch_generation === intent.latchGeneration &&
    typeof value.trap_strikes === 'number' &&
    Number.isSafeInteger(value.trap_strikes) &&
    value.trap_strikes > 0
  );
}
export interface ContainmentCapability {
  readonly file: string;
  consume(result: NativeResult): {
    readonly intent: ValidatedContainmentIntent | null;
    readonly diagnostic: string;
  };
}
export interface ContainmentOwner {
  readonly request: RuntimeRequest;
  readonly selection: ActiveInvocationSelection;
  readonly handler: SelectedHandler;
  readonly environment: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}
/** The executor grants this file only to the qualified stock guard for this invocation. */
export function createContainmentCapability(
  owner: ContainmentOwner,
  directory: string
): ContainmentCapability | null {
  if (!qualifiesForNativeContainment(owner.handler, owner)) return null;
  const file = join(directory, 'containment.json');
  writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  let consumed = false;
  return Object.freeze({
    file,
    consume(result: NativeResult) {
      if (consumed) throw new Error('Containment capability was already consumed');
      consumed = true;
      try {
        const bytes = readOperationalFile(directory, file, INTENT_LIMIT);
        if (!bytes.length) return { intent: null, diagnostic: '' };
        if (!protective(result)) throw new Error('Intent has no completed protective block');
        // Recheck the selected source closure after completion. This is not pinned-byte execution.
        if (!qualifiesForNativeContainment(owner.handler, owner))
          throw new Error('Selected guard source changed');
        const intent = parseContainmentIntent(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        );
        const sid = owner.environment.CAWS_SESSION_ID;
        if (!string(sid, 128) || sid === 'unknown' || intent.sessionId !== sid)
          throw new Error('Containment session differs from the invocation identity');
        // The selected shell's sanitize_session uses bytewise tr, including
        // one underscore per non-ASCII UTF-8 byte rather than UTF-16 unit.
        const safe = Buffer.from(
          Buffer.from(sid, 'utf8').map((byte) =>
            (byte >= 65 && byte <= 90) ||
            (byte >= 97 && byte <= 122) ||
            (byte >= 48 && byte <= 57) ||
            byte === 46 ||
            byte === 95 ||
            byte === 45
              ? byte
              : 95
          )
        ).toString('ascii');
        const root = [owner.selection.checkout, owner.selection.canonical].find(
          (candidate) =>
            intent.latchPath ===
            join(candidate, '.codex/hooks/state', 'danger-latch-' + safe + '.json')
        );
        if (!root) throw new Error('Containment latch is outside selected session state');
        const latchLimit = observeLatchReadLimit();
        const latch = readLatch(root, intent.latchPath, latchLimit);
        if (
          !latchMatches(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(latch)), intent)
        )
          throw new Error('Containment latch identity, generation or strike does not match');
        const validatedIntent = Object.freeze({ ...intent }) as ValidatedContainmentIntent;
        owned.set(validatedIntent, {
          requestId: owner.request.id,
          selection: owner.selection,
          handler: owner.handler,
          latchRoot: root,
          latchHash: hash(latch),
          latchLimit,
        });
        return { intent: validatedIntent, diagnostic: '' };
      } catch (error) {
        return {
          intent: null,
          diagnostic: '[caws containment] signal held: ' + String(error) + '\n',
        };
      }
    },
  });
}
/** Wire receipt validation never creates effect authority. Correlate every echoed field. */
export function decodeContainmentReceipt(
  value: unknown,
  expected: ContainmentIntent | null,
  source?: JsonSource
): ContainmentReceipt | null {
  if (value === null) return null;
  if (
    !expected ||
    !record(value) ||
    !exact(value, [...keys, 'status', 'reason', 'errno']) ||
    value.schema !== CONTAINMENT_RECEIPT_SCHEMA ||
    !tuple(value) ||
    !fields.every((key) => value[key] === expected[key]) ||
    (source !== undefined && !canonical(objectMemberSource(source, 'pid'))) ||
    (value.status !== 'held' && value.status !== 'signal-accepted') ||
    ![
      'signal-accepted',
      'not-captured',
      'unsafe-target',
      'identity-mismatch',
      'observation-unavailable',
      'signal-failed',
      'capture-unavailable',
    ].includes(value.reason as string) ||
    (value.errno !== null &&
      (!positive(value.errno, 2_147_483_647) ||
        (source !== undefined && !canonical(objectMemberSource(source, 'errno'))))) ||
    (value.status === 'signal-accepted') !== (value.reason === 'signal-accepted') ||
    (value.status === 'signal-accepted' && value.errno !== null)
  )
    throw new Error('Mismatched containment receipt');
  return Object.freeze({ ...value }) as unknown as ContainmentReceipt;
}
/** Observes state after the effect receipt. It neither retries a signal nor rewrites a legacy latch. */
export function observeContainmentLatch(
  intent: ValidatedContainmentIntent
): 'unchanged' | 'changed' | 'unavailable' {
  const evidence = owned.get(intent);
  if (!evidence) throw new Error('Containment intent lacks executor provenance');
  try {
    const bytes = readLatch(evidence.latchRoot, intent.latchPath, evidence.latchLimit);
    return hash(bytes) === evidence.latchHash &&
      latchMatches(JSON.parse(bytes.toString('utf8')), intent)
      ? 'unchanged'
      : 'changed';
  } catch {
    return 'unavailable';
  }
}
