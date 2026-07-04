// `caws evidence record` — append one typed evidence event.
//
// Pipeline:
//   1. resolveRepoRoot(cwd)
//   2. resolveSession({ allowMint: true })       — this is a write op
//   3. buildActor({ session, kind })
//   4. construct EventBody from caller inputs   — body-only; no seq/prev/hash
//   5. appendEvent(cawsDir, body)                 — store enforces lock,
//                                                   chain via kernel
//                                                   prepareAppend
//   6. print seq + event_hash AFTER success
//
// Exit codes:
//   0 = append succeeded
//   1 = validation rejected the body OR appendEvent returned Err
//   2 = repo-root / session resolution / composition failure
//
// CRITICAL: the API surface accepts EventBody-shaped inputs only. It does
// not accept `seq`, `prev_hash`, or `event_hash`. The CLI layer parsing
// (commander) MUST NOT add those fields. If a caller does pass them via
// the data object, kernel `validateEventBody` rejects them (additionalProperties:
// false on the per-event-type payload schemas).

import * as path from 'node:path';
import * as fs from 'node:fs';

import {
  type Actor,
  type ActorKind,
  type ChainedEvent,
  type EventBody,
  type EventType,
  isOk,
  verifyChain,
} from '@paths.design/caws-kernel';

import { appendEvent, loadEvents, resolveRepoRoot } from '../../store';
import { buildActor } from '../session/actor';
import { resolveSession } from '../session/resolve-session';
import { renderDiagnostics } from '../render/diagnostic';
import { SHELL_RULES } from '../rules';

export type EvidenceKind = 'test' | 'gate' | 'ac';

const KIND_TO_EVENT_TYPE: Record<EvidenceKind, EventType> = {
  test: 'test_recorded',
  gate: 'gate_evaluated',
  ac: 'ac_recorded',
};

const EVENT_TYPE_TO_KIND: Partial<Record<EventType, EvidenceKind>> = {
  test_recorded: 'test',
  gate_evaluated: 'gate',
  ac_recorded: 'ac',
};

export interface EvidenceRecordOptions {
  /** Which evidence event to record. */
  readonly kind: EvidenceKind;
  /** Required: the spec id this evidence is about. */
  readonly specId: string;
  /** Required: the event payload — must match the kernel's event-type schema. */
  readonly data: Record<string, unknown>;
  /** Actor kind. Defaults to 'agent'. */
  readonly actorKind?: ActorKind;
  /** Optional actor id override. Defaults to session.identity.session_id. */
  readonly actorId?: string;
  /** Optional ISO-8601 ts. Defaults to now. */
  readonly ts?: string;
  /** Working directory. Defaults to process.cwd(). */
  readonly cwd?: string;
  /** Injected clock for tests. */
  readonly now?: () => Date;
  /** Injected env for tests. */
  readonly env?: NodeJS.ProcessEnv;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  /** Show optional `data` blocks on rendered errors. */
  readonly showData?: boolean;
}

export interface EvidenceListOptions {
  /** Required: the spec id whose typed evidence should be listed. */
  readonly specId: string;
  /** Optional evidence kind filter. */
  readonly kind?: EvidenceKind;
  /** Emit machine-readable JSON instead of human summary lines. */
  readonly json?: boolean;
  /** Working directory. Defaults to process.cwd(). */
  readonly cwd?: string;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  /** Show optional `data` blocks on rendered errors. */
  readonly showData?: boolean;
}

export interface EvidenceShowOptions {
  /** Sequence number, full event_hash, or unique event_hash prefix. */
  readonly ref: string;
  /** Emit machine-readable JSON instead of a human summary + payload. */
  readonly json?: boolean;
  /** Working directory. Defaults to process.cwd(). */
  readonly cwd?: string;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  /** Show optional `data` blocks on rendered errors. */
  readonly showData?: boolean;
}

export interface EvidenceSchemaOptions {
  /** Which evidence event payload schema to inspect. */
  readonly kind: EvidenceKind;
  /** Emit machine-readable JSON instead of a human summary. */
  readonly json?: boolean;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
}

interface EvidenceSchemaExample {
  readonly data: Record<string, unknown>;
  readonly command: string;
}

interface EvidenceSchemaRecord {
  readonly kind: EvidenceKind;
  readonly event: EventType;
  readonly schema: Record<string, unknown>;
  readonly required: readonly string[];
  readonly properties: readonly string[];
  readonly example: EvidenceSchemaExample;
}

function rejectPreChainedFields(data: Record<string, unknown>): string | null {
  for (const banned of ['seq', 'prev_hash', 'event_hash']) {
    if (Object.prototype.hasOwnProperty.call(data, banned)) {
      return banned;
    }
  }
  return null;
}

function isEvidenceKind(value: unknown): value is EvidenceKind {
  return value === 'test' || value === 'gate' || value === 'ac';
}

function evidenceKindForEvent(event: ChainedEvent): EvidenceKind | undefined {
  return EVENT_TYPE_TO_KIND[event.event];
}

function evidenceSummary(event: ChainedEvent): Record<string, unknown> {
  return {
    seq: event.seq,
    hash: event.event_hash,
    type: evidenceKindForEvent(event),
    event: event.event,
    spec_id: event.spec_id,
    ts: event.ts,
    actor: event.actor,
    data: event.data,
  };
}

function exampleDataForKind(kind: EvidenceKind): Record<string, unknown> {
  if (kind === 'test') {
    return { command: 'npm test', exit_code: 0 };
  }
  if (kind === 'gate') {
    return {
      gate_id: 'budget_limit',
      mode: 'block',
      result: 'pass',
      violations: [],
    };
  }
  return {
    criterion_id: 'A1',
    status: 'pass',
    evidence_ref: 'npm test',
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function exampleCommandForKind(kind: EvidenceKind): EvidenceSchemaExample {
  const data = exampleDataForKind(kind);
  return {
    data,
    command:
      `caws evidence record --type ${kind} --spec FEAT-1 --data ` +
      shellQuote(JSON.stringify(data)),
  };
}

function schemaPathCandidates(eventType: EventType): readonly string[] {
  const schemaFile = `${eventType}.v1.json`;
  const kernelMain = require.resolve('@paths.design/caws-kernel');
  const kernelDistDir = path.dirname(kernelMain);
  return [
    path.join(kernelDistDir, 'schemas', 'events', schemaFile),
    path.join(kernelDistDir, '..', 'src', 'schemas', 'events', schemaFile),
  ];
}

function loadSchemaForKind(kind: EvidenceKind): EvidenceSchemaRecord {
  const eventType = KIND_TO_EVENT_TYPE[kind];
  const candidates = schemaPathCandidates(eventType);
  const schemaPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (schemaPath === undefined) {
    throw new Error(
      `missing schema file for ${eventType}; searched ${candidates.join(', ')}`
    );
  }
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
  const rawRequired = Array.isArray(schema.required) ? schema.required : [];
  const rawProperties =
    typeof schema.properties === 'object' && schema.properties !== null
      ? Object.keys(schema.properties as Record<string, unknown>)
      : [];
  return {
    kind,
    event: eventType,
    schema,
    required: rawRequired.filter((field): field is string => typeof field === 'string'),
    properties: rawProperties,
    example: exampleCommandForKind(kind),
  };
}

function renderPropertySummary(schema: Record<string, unknown>, property: string): string {
  const properties = schema.properties as Record<string, unknown> | undefined;
  const propertySchema = properties?.[property];
  if (typeof propertySchema !== 'object' || propertySchema === null) {
    return property;
  }
  const typedSchema = propertySchema as Record<string, unknown>;
  const type = typedSchema.type;
  const enumValues = typedSchema.enum;
  const details: string[] = [];
  if (typeof type === 'string') details.push(type);
  if (Array.isArray(enumValues)) details.push(`one of ${enumValues.join('|')}`);
  return details.length > 0 ? `${property} (${details.join('; ')})` : property;
}

function loadVerifiedEventsForRead(
  cwd: string,
  err: (line: string) => void,
  showData: boolean,
  commandName: string
): { repoRoot: string; cawsDir: string; events: readonly ChainedEvent[] } | null {
  const repoRootResult = resolveRepoRoot(cwd);
  if (!repoRootResult.ok) {
    err(`caws evidence ${commandName}: failed to resolve repo root.`);
    err(renderDiagnostics(repoRootResult.errors, { showData }));
    return null;
  }
  const { repoRoot, cawsDir } = repoRootResult.value;
  const loaded = loadEvents(cawsDir);
  if (!loaded.ok) {
    err(`caws evidence ${commandName}: failed to load events.jsonl.`);
    err(renderDiagnostics(loaded.errors, { showData }));
    return null;
  }
  const verified = verifyChain(loaded.value.events);
  if (!isOk(verified)) {
    err(`caws evidence ${commandName}: event chain verification failed.`);
    err(renderDiagnostics(verified.errors, { showData }));
    return null;
  }
  return { repoRoot, cawsDir, events: loaded.value.events };
}

function eventMatchesRef(event: ChainedEvent, ref: string): boolean {
  if (/^\d+$/.test(ref)) return event.seq === Number(ref);
  return event.event_hash === ref || event.event_hash.startsWith(ref);
}

function resolveEventRef(events: readonly ChainedEvent[], ref: string):
  | { kind: 'found'; event: ChainedEvent }
  | { kind: 'not_found' }
  | { kind: 'ambiguous'; matches: readonly ChainedEvent[] } {
  const matches = events.filter((event) => eventMatchesRef(event, ref));
  if (matches.length === 0) return { kind: 'not_found' };
  if (matches.length > 1) return { kind: 'ambiguous', matches };
  return { kind: 'found', event: matches[0]! };
}

export function runEvidenceRecordCommand(opts: EvidenceRecordOptions): number {
  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;

  // Validate the evidence kind up front (defensive — Commander should
  // reject unknown values at the parser, but tests / programmatic callers
  // may bypass that).
  if (!isEvidenceKind(opts.kind)) {
    err(
      `caws evidence record: invalid --type. Got ${JSON.stringify(opts.kind)}; expected test|gate|ac.`
    );
    err(
      `(rule: ${SHELL_RULES.COMMAND_INVALID_EVIDENCE_TYPE})`
    );
    return 1;
  }

  // Reject pre-chained fields in the payload BEFORE doing any I/O.
  const banned = rejectPreChainedFields(opts.data);
  if (banned !== null) {
    err(
      `caws evidence record: payload must NOT include \`${banned}\`. Pre-chained events are not accepted by this command.`
    );
    err(`(rule: ${SHELL_RULES.COMMAND_PRE_CHAINED_EVENT_REFUSED})`);
    return 1;
  }

  // Require non-empty spec_id (also enforced by kernel REQUIRES_SPEC_ID
  // fence, but we surface the shell-level error early).
  if (typeof opts.specId !== 'string' || opts.specId.length === 0) {
    err('caws evidence record: --spec is required.');
    err(`(rule: ${SHELL_RULES.COMMAND_MISSING_SPEC_ID})`);
    return 1;
  }

  // 1. Repo root.
  const repoRootResult = resolveRepoRoot(cwd);
  if (!repoRootResult.ok) {
    err('caws evidence record: failed to resolve repo root.');
    err(renderDiagnostics(repoRootResult.errors, { showData }));
    return 2;
  }
  const { repoRoot, cawsDir } = repoRootResult.value;

  // 2. Session (write op → allowMint).
  const sessionResult = resolveSession({
    cawsDir,
    worktreeRoot: cwd,
    env,
    now,
    allowMint: true,
  });
  if (!sessionResult.ok) {
    err('caws evidence record: failed to resolve session identity.');
    err(renderDiagnostics(sessionResult.errors, { showData }));
    return 2;
  }

  // 3. Actor envelope.
  const actor: Actor = buildActor({
    session: sessionResult.value,
    kind: opts.actorKind ?? 'agent',
    ...(opts.actorId !== undefined ? { id: opts.actorId } : {}),
  });

  // 4. Body.
  const eventType = KIND_TO_EVENT_TYPE[opts.kind];
  const ts = opts.ts ?? now().toISOString();
  // `EventBody.data` is typed as `EventPayload` (a union of per-event
  // payload shapes). The kernel will validate against the right schema
  // at append time; we hand off the caller's already-parsed object.
  const body = {
    event: eventType,
    ts,
    actor,
    spec_id: opts.specId,
    data: opts.data,
  } as unknown as EventBody;

  // 5. Append. `appendEvent` calls `prepareAppend` which calls
  // `validateEventBody` against the per-type schema.
  const appendResult = appendEvent(cawsDir, body);
  if (!appendResult.ok) {
    err('caws evidence record: append rejected.');
    err(renderDiagnostics(appendResult.errors, { showData }));
    return 1;
  }

  // 6. Print outcome AFTER success. Includes seq + event_hash so the
  // caller (agent or human) gets a stable handle for the new event.
  const ev = appendResult.value;
  out(
    `recorded ${ev.event} seq=${ev.seq} hash=${ev.event_hash} spec=${ev.spec_id ?? '(none)'}`
  );
  // Print the relative events file path for ergonomics.
  out(`  written to ${path.relative(repoRoot, path.join(cawsDir, 'events.jsonl'))}`);
  return 0;
}

export function runEvidenceListCommand(opts: EvidenceListOptions): number {
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;

  if (typeof opts.specId !== 'string' || opts.specId.length === 0) {
    err('caws evidence list: --spec is required.');
    err(`(rule: ${SHELL_RULES.COMMAND_MISSING_SPEC_ID})`);
    return 1;
  }
  if (opts.kind !== undefined && !isEvidenceKind(opts.kind)) {
    err(
      `caws evidence list: invalid --type. Got ${JSON.stringify(opts.kind)}; expected test|gate|ac.`
    );
    err(`(rule: ${SHELL_RULES.COMMAND_INVALID_EVIDENCE_TYPE})`);
    return 1;
  }

  const loaded = loadVerifiedEventsForRead(cwd, err, showData, 'list');
  if (loaded === null) return 2;

  const candidates = loaded.events.filter((event) => {
    const kind = evidenceKindForEvent(event);
    return (
      kind !== undefined &&
      event.spec_id === opts.specId &&
      (opts.kind === undefined || kind === opts.kind)
    );
  });
  const summaries = candidates.map(evidenceSummary);

  if (opts.json === true) {
    out(JSON.stringify({
      ok: true,
      read_only: true,
      spec_id: opts.specId,
      type: opts.kind ?? null,
      count: summaries.length,
      events: summaries,
    }, null, 2));
  } else {
    out(
      `caws evidence list: ${summaries.length} event(s) for spec ${opts.specId}` +
        (opts.kind !== undefined ? ` type=${opts.kind}` : '')
    );
    for (const item of summaries) {
      out(
        `- seq=${item.seq} type=${item.type} hash=${item.hash} ts=${item.ts}`
      );
    }
    if (summaries.length === 0) out('  (none)');
  }
  return 0;
}

export function runEvidenceShowCommand(opts: EvidenceShowOptions): number {
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;
  const ref = opts.ref.trim();
  if (ref.length === 0) {
    err('caws evidence show: event-ref is required.');
    return 1;
  }

  const loaded = loadVerifiedEventsForRead(cwd, err, showData, 'show');
  if (loaded === null) return 2;

  const resolved = resolveEventRef(loaded.events, ref);
  if (resolved.kind === 'not_found') {
    err(`caws evidence show: event-ref ${JSON.stringify(ref)} not found.`);
    return 1;
  }
  if (resolved.kind === 'ambiguous') {
    err(
      `caws evidence show: event-ref ${JSON.stringify(ref)} is ambiguous (${resolved.matches.length} matches).`
    );
    for (const match of resolved.matches.slice(0, 10)) {
      err(`- seq=${match.seq} hash=${match.event_hash} event=${match.event}`);
    }
    return 1;
  }

  const summary = evidenceSummary(resolved.event);
  if (opts.json === true) {
    out(JSON.stringify({
      ok: true,
      read_only: true,
      event: summary,
    }, null, 2));
  } else {
    out(
      `seq=${summary.seq} event=${summary.event} type=${summary.type ?? '(non-evidence)'} ` +
        `spec=${summary.spec_id ?? '(none)'} hash=${summary.hash}`
    );
    out(JSON.stringify(summary.data, null, 2));
  }
  return 0;
}

export function runEvidenceSchemaCommand(opts: EvidenceSchemaOptions): number {
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));

  if (!isEvidenceKind(opts.kind)) {
    err(
      `caws evidence schema: invalid --type. Got ${JSON.stringify(opts.kind)}; expected test|gate|ac.`
    );
    err(`(rule: ${SHELL_RULES.COMMAND_INVALID_EVIDENCE_TYPE})`);
    return 1;
  }

  let record: EvidenceSchemaRecord;
  try {
    record = loadSchemaForKind(opts.kind);
  } catch (e) {
    err(`caws evidence schema: failed to load kernel schema: ${(e as Error).message}`);
    return 2;
  }

  if (opts.json === true) {
    out(JSON.stringify({
      ok: true,
      read_only: true,
      type: record.kind,
      event: record.event,
      required: record.required,
      properties: record.properties,
      schema: record.schema,
      example: record.example,
    }, null, 2));
    return 0;
  }

  out(`caws evidence schema: ${record.kind} (${record.event})`);
  out('  read-only: true');
  out(`  required: ${record.required.length > 0 ? record.required.join(', ') : '(none)'}`);
  out('  fields:');
  for (const property of record.properties) {
    out(`  - ${renderPropertySummary(record.schema, property)}`);
  }
  out('  example:');
  out(`  ${record.example.command}`);
  return 0;
}
