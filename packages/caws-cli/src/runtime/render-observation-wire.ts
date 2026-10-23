/** Finite original-frontend observations within one captured Render phase. */
import { TextDecoder } from 'node:util';
import { parseJsonSource } from './json-custody';
import { RuntimeProtocolError } from './protocol';
import type { SessionOperationCorrelation } from './session-publication-wire';
import type {
  RendererCalendarContext,
  RendererLocalCalendarPort,
} from '../transcripts/renderer-calendar';
import type { RenderGitContext } from './render-context';

const PREFIX = 'caws.runtime.render-observation';
export const RENDER_OBSERVATION_BINDING = `${PREFIX}.binding.v1`;
export const RENDER_OBSERVATION_REQUEST = `${PREFIX}.request.v1`;
export const RENDER_OBSERVATION_RESULT = `${PREFIX}.result.v1`;
export const RENDER_OBSERVATION_CHUNK = `${PREFIX}.chunk.v1`;
export const RENDER_OBSERVATION_FAILURE = `${PREFIX}.failure.v1`;
export const MAX_RENDER_OBSERVATION_FRAME_BYTES = 2 * 1024 * 1024;
export const RENDER_OBSERVATION_CHUNK_BYTES = 64 * 1024;
export const MAX_CALENDAR_OBSERVATION_BYTES = 2 * 1024 * 1024;
export const RENDER_OBSERVATION_KEYS = [
  'schema',
  'id',
  'runtimeDigest',
  'token',
  'attempt',
  'observationId',
  'inputDigest',
] as const;
export interface RenderObservationBinding extends SessionOperationCorrelation {
  readonly observationId: string;
  readonly inputDigest: string;
}
export interface NativeRenderObservations {
  /** Original correlation copied from the validated native phase, never a new token. */
  readonly binding: RenderObservationBinding;
  /** Exactly once; completes before any calendar batches. */
  git(): Promise<RenderGitContext>;
  readonly calendarContext: RendererCalendarContext;
  readonly calendar: RendererLocalCalendarPort;
}
export type ObservationRow = Record<string, unknown>;
export function observationObject(value: unknown): value is ObservationRow {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function observationExact(row: ObservationRow, keys: readonly string[]): boolean {
  return Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key));
}
export function observationRequire(value: unknown, message: string): asserts value {
  if (!value) throw new RuntimeProtocolError(message);
}
export function observationText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value) <= maximum;
}
export function observationDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
export function decodeObservation(bytes: Uint8Array): ObservationRow {
  observationRequire(
    bytes instanceof Uint8Array && bytes.byteLength <= MAX_RENDER_OBSERVATION_FRAME_BYTES,
    'Render observation frame exceeds bound'
  );
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    parseJsonSource(text, 32, 100_000, true);
    const row: unknown = JSON.parse(text);
    observationRequire(observationObject(row), 'Invalid Render observation object');
    return row;
  } catch (error) {
    if (error instanceof RuntimeProtocolError) throw error;
    throw new RuntimeProtocolError('Invalid Render observation encoding or duplicate member');
  }
}
