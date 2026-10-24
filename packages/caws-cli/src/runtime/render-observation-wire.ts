/** Finite original-frontend observations within one captured Render phase. */
import { TextDecoder } from 'node:util';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { parseJsonSource } from './json-custody';
import { RuntimeProtocolError } from './protocol';
import type {
  SessionOperationCorrelation,
  SessionPublicationDescriptor,
} from './session-publication-wire';
import type { ObservedRendererFile, ObservedRendererDirectory } from '../transcripts/render-reader';
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
  /** Present only for native Stop binding.v2, never fabricated from omissions. */
  readonly stopSources?: NativeStopRendererSources;
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

export const STOP_PUBLICATION_PREPARE = 'caws.runtime.session-publication.prepare.v2';
export const RENDER_OBSERVATION_STOP_BINDING = `${PREFIX}.binding.v2`;
export const STOP_SOURCE_CATALOG_SCHEMA = 'caws.runtime.stop-render-sources.v1';
export type StopCatalogFile =
  | Readonly<{ path: string; disposition: 'absent' }>
  | Readonly<{ path: string; disposition: 'failed'; error: string }>
  | Readonly<{ path: string; disposition: 'read'; descriptor: SessionPublicationDescriptor }>;
export type StopCatalogDirectory =
  | Readonly<{ path: string; kind: 'absent' | 'not-directory' }>
  | Readonly<{
      path: string;
      kind: 'directory';
      listing:
        | Readonly<{ disposition: 'failed'; error: string }>
        | Readonly<{
            disposition: 'listed';
            names: readonly string[];
            entries: readonly Readonly<{ name: string; file: StopCatalogFile }>[];
          }>;
    }>;
export interface StopSourceCatalog {
  readonly schema: typeof STOP_SOURCE_CATALOG_SCHEMA;
  readonly transcriptPath: string;
  readonly audit: StopCatalogFile;
  readonly hookOutcomes: StopCatalogFile;
  readonly subagents: Readonly<{
    claudeCandidate: StopCatalogDirectory;
    qwenCandidate: StopCatalogDirectory;
  }>;
}
export interface NativeStopRendererSources {
  readonly binding: RenderObservationBinding;
  readonly transcriptPath: string;
  readonly audit: ObservedRendererFile;
  readonly hookOutcomes: ObservedRendererFile;
  readonly subagents: Readonly<{
    claudeCandidate: ObservedRendererDirectory;
    qwenCandidate: ObservedRendererDirectory;
  }>;
}
/** V2's digest covers source disposition/path/listing as well as descriptors.
 * Parsing/validation precedes this canonicalization; no ambient IO or grant. */
export function stopSourceInputDigest(
  files: readonly SessionPublicationDescriptor[],
  catalog: StopSourceCatalog
): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (observationObject(value))
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, sorted(value[key])])
      );
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify(sorted({ files, sourceCatalog: catalog })))
    .digest('hex');
}
export function snapshotStopSourceCatalog(
  value: unknown,
  files: readonly SessionPublicationDescriptor[],
  sessionId: string
): StopSourceCatalog {
  const require: typeof observationRequire = observationRequire;
  const object = observationObject,
    exact = observationExact;
  const path = (value: unknown): value is string =>
    observationText(value, 4096) && isAbsolute(value) && !/[\r\n]/.test(value);
  const name = (value: unknown): value is string =>
    observationText(value, 255) &&
    value.length > 0 &&
    !value.includes('/') &&
    value !== '.' &&
    value !== '..';
  require(object(value) &&
    exact(value, ['schema', 'transcriptPath', 'audit', 'hookOutcomes', 'subagents']) &&
    value.schema === STOP_SOURCE_CATALOG_SCHEMA &&
    path(value.transcriptPath), 'Invalid Stop source catalog');
  require(Buffer.byteLength(JSON.stringify(value)) <= MAX_RENDER_OBSERVATION_FRAME_BYTES &&
    files.length <= 4096, 'Stop source catalog exceeds bound');
  const aliases = new Set<string>();
  const file = (input: unknown, role: string, expectedPath?: string): void => {
    require(object(input) &&
      path(input.path) &&
      (expectedPath === undefined || input.path === expectedPath), 'Invalid Stop source path');
    if (input.disposition === 'absent') {
      require(exact(input, ['path', 'disposition']), 'Invalid Stop source absence');
      return;
    }
    if (input.disposition === 'failed') {
      require(exact(input, ['path', 'disposition', 'error']) &&
        observationText(input.error, 4096) &&
        input.error.length > 0, 'Invalid Stop source failure');
      return;
    }
    require(input.disposition === 'read' &&
      exact(input, ['path', 'disposition', 'descriptor']) &&
      object(input.descriptor), 'Invalid Stop source capture');
    const descriptor = input.descriptor;
    require(exact(descriptor, ['name', 'role', 'byteLength', 'sha256']) &&
      name(descriptor.name) &&
      descriptor.role === role &&
      Number.isSafeInteger(descriptor.byteLength) &&
      (descriptor.byteLength as number) >= 0 &&
      (descriptor.byteLength as number) <= 64 * 1024 * 1024 &&
      observationDigest(descriptor.sha256), 'Invalid Stop source descriptor');
    require(!aliases.has(descriptor.name) &&
      files.filter(
        (item) =>
          item.name === descriptor.name &&
          item.role === descriptor.role &&
          item.byteLength === descriptor.byteLength &&
          item.sha256 === descriptor.sha256
      ).length === 1, 'Stop source descriptor differs from captured inventory');
    aliases.add(descriptor.name);
  };
  file(value.audit, 'audit');
  file(value.hookOutcomes, 'hook_outcomes');
  const presentAlias = (input: unknown, alias: string): boolean =>
    object(input) &&
    (input.disposition === 'read'
      ? object(input.descriptor) && input.descriptor.name === alias
      : !files.some((item) => item.name === alias));
  require(presentAlias(value.audit, 'audit.log') &&
    presentAlias(
      value.hookOutcomes,
      'hook-events.jsonl'
    ), 'Stop source disposition contradicts captured inventory');
  const subagents = value.subagents;
  require(object(subagents) &&
    exact(subagents, ['claudeCandidate', 'qwenCandidate']), 'Invalid Stop subagent candidates');
  const directory = (input: unknown, expectedPath: string): void => {
    require(object(input) &&
      path(input.path) &&
      input.path === expectedPath, 'Invalid Stop subagent directory path');
    if (input.kind === 'absent' || input.kind === 'not-directory') {
      require(exact(input, ['path', 'kind']), 'Invalid Stop subagent disposition');
      return;
    }
    require(input.kind === 'directory' &&
      exact(input, ['path', 'kind', 'listing']) &&
      object(input.listing), 'Invalid Stop subagent directory');
    const listing = input.listing;
    if (listing.disposition === 'failed') {
      require(exact(listing, ['disposition', 'error']) &&
        observationText(listing.error, 4096) &&
        listing.error.length > 0, 'Invalid Stop subagent listing failure');
      return;
    }
    require(listing.disposition === 'listed' &&
      exact(listing, ['disposition', 'names', 'entries']) &&
      Array.isArray(listing.names) &&
      listing.names.length <= 4096 &&
      listing.names.every(name) &&
      new Set(listing.names).size === listing.names.length &&
      Array.isArray(listing.entries) &&
      listing.entries.length <= 4096, 'Invalid Stop subagent listing');
    const expected = new Set(
      listing.names.filter((item) => item.startsWith('agent-') && item.endsWith('.meta.json'))
    );
    for (const entry of listing.entries) {
      require(object(entry) &&
        exact(entry, ['name', 'file']) &&
        name(entry.name) &&
        expected.delete(entry.name), 'Stop metadata entries differ from actual listing');
      file(entry.file, 'subagent', join(input.path, entry.name));
    }
    require(expected.size === 0, 'Stop metadata listing entry omitted');
  };
  directory(subagents.claudeCandidate, join(dirname(value.transcriptPath), sessionId, 'subagents'));
  directory(
    subagents.qwenCandidate,
    join(dirname(dirname(value.transcriptPath)), 'subagents', sessionId)
  );
  // Snapshot the exact validated native data; no caller view is retained.
  const result: StopSourceCatalog = JSON.parse(JSON.stringify(value));
  const freeze = (data: unknown): void => {
    if (data !== null && typeof data === 'object') {
      for (const child of Object.values(data)) freeze(child);
      Object.freeze(data);
    }
  };
  freeze(result);
  return result;
}
export function materializeStopSources(
  catalog: StopSourceCatalog,
  binding: RenderObservationBinding,
  bytes: (name: string) => Uint8Array
): NativeStopRendererSources {
  const file = (source: StopCatalogFile): ObservedRendererFile => {
    if (source.disposition !== 'read') return Object.freeze({ ...source });
    const data = Uint8Array.from(bytes(source.descriptor.name));
    observationRequire(
      data.byteLength === source.descriptor.byteLength &&
        createHash('sha256').update(data).digest('hex') === source.descriptor.sha256,
      'Stop source bytes differ from captured descriptor'
    );
    return Object.freeze({
      path: source.path,
      disposition: 'read' as const,
      source: Object.freeze({
        kind: 'publication-buffer' as const,
        binding,
        descriptor: source.descriptor,
        size: BigInt(data.byteLength),
        bytes: data,
      }),
    });
  };
  const directory = (source: StopCatalogDirectory): ObservedRendererDirectory => {
    if (source.kind !== 'directory') return Object.freeze({ ...source });
    if (source.listing.disposition === 'failed')
      return Object.freeze({
        path: source.path,
        kind: 'directory',
        listing: Object.freeze({ ...source.listing }),
      });
    return Object.freeze({
      path: source.path,
      kind: 'directory',
      listing: Object.freeze({
        disposition: 'listed',
        entries: Object.freeze(
          source.listing.entries.map((entry) =>
            Object.freeze({ name: entry.name, file: file(entry.file) })
          )
        ),
      }),
    });
  };
  return Object.freeze({
    binding,
    transcriptPath: catalog.transcriptPath,
    audit: file(catalog.audit),
    hookOutcomes: file(catalog.hookOutcomes),
    subagents: Object.freeze({
      claudeCandidate: directory(catalog.subagents.claudeCandidate),
      qwenCandidate: directory(catalog.subagents.qwenCandidate),
    }),
  });
}
