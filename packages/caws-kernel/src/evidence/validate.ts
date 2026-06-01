// Evidence event validation.
//
// Two validators:
//
//   validateEventBody(input): Result<EventBody>
//     For caller-supplied input BEFORE prepareAppend.
//     Validates: envelope shape minus chain fields, actor shape, ts format,
//                event vocabulary, spec_id class enforcement, per-type
//                payload schema (when one exists).
//
//   validateChainedEvent(input): Result<ChainedEvent>
//     For events read from disk or returned from prepareAppend.
//     Validates everything validateEventBody does, PLUS chain field shape:
//     seq integer ≥ 1, prev_hash null|sha256:hex, event_hash sha256:hex.
//     Does NOT verify the hash is correct against the event content —
//     that's verifyChain's job.
//
// Both validators reject extra properties (additionalProperties: false on
// the envelope schema, additionalProperties: false on per-type payload
// schemas where present). Strict by default.
//
// The kernel does NOT verify session liveness, agents.json membership, or
// worktree ownership. Actor.session_id is enforced as non-empty when
// present, and that's it.

import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { diagnostic } from '../diagnostics';
import type { Diagnostic } from '../diagnostics/types';
import { err, ok } from '../result';
import type { Result } from '../result/types';

import envelopeSchema from '../schemas/events.v1.json';

import acRecordedSchema from '../schemas/events/ac_recorded.v1.json';
import chainRotatedSchema from '../schemas/events/chain_rotated.v1.json';
import claimTakenOverSchema from '../schemas/events/claim_taken_over.v1.json';
import doctorCompletedSchema from '../schemas/events/doctor_completed.v1.json';
import evidenceRecordedSchema from '../schemas/events/evidence_recorded.v1.json';
import gateEvaluatedSchema from '../schemas/events/gate_evaluated.v1.json';
import specArchivedSchema from '../schemas/events/spec_archived.v1.json';
import specArchivePrunedSchema from '../schemas/events/spec_archive_pruned.v1.json';
import specActivatedSchema from '../schemas/events/spec_activated.v1.json';
import specRetiredSchema from '../schemas/events/spec_retired.v1.json';
import specScopeAmendedSchema from '../schemas/events/spec_scope_amended.v1.json';
import specClosedSchema from '../schemas/events/spec_closed.v1.json';
import specCreatedSchema from '../schemas/events/spec_created.v1.json';
import specValidatedSchema from '../schemas/events/spec_validated.v1.json';
import testRecordedSchema from '../schemas/events/test_recorded.v1.json';
import waiverAppliedSchema from '../schemas/events/waiver_applied.v1.json';
import worktreeBoundSchema from '../schemas/events/worktree_bound.v1.json';
import worktreeCreatedSchema from '../schemas/events/worktree_created.v1.json';
import worktreeDestroyedSchema from '../schemas/events/worktree_destroyed.v1.json';
import worktreeMergedSchema from '../schemas/events/worktree_merged.v1.json';
import worktreeOwnershipSeizedSchema from '../schemas/events/worktree_ownership_seized.v1.json';

// v10 read-side compatibility (KERNEL-EVENT-V10-COMPAT-ALIAS-001). Used
// ONLY by validateChainedEvent's legacy-detection pre-pass for events with
// event === 'validation_completed'. New writes never emit this event type
// — prepareAppend / appendEvent only emit canonical v11 events. The schema
// exists so v11 kernels can load existing event logs from v10-migrant
// repos without failing the full-log re-read on every event-append
// lifecycle transaction.
import validationCompletedSchema from '../schemas/events/validation_completed.v1.json';

import { EVIDENCE_RULES } from './rules';
import {
  HASH_REGEX,
  NO_SPEC_ID,
  REQUIRES_SPEC_ID,
  type ActorKind,
  type ChainedEvent,
  type EventBody,
  type EventType,
} from './types';

/**
 * Module-level lazy AJV singleton + per-event-type payload validator cache.
 *
 * Same contract as spec/validate-shape.ts:
 *  - Constructed once per process; reused across calls.
 *  - allErrors:true and strict:true are fixed.
 *  - Tests share the compiled validator. Schema is immutable per release.
 *
 * Per-event payload validators are compiled lazily when first needed and
 * cached by event type. Event types without a payload schema are recorded
 * as `null` so we don't re-attempt to load them.
 */
let envelopeValidator: ValidateFunction | null = null;
const payloadValidators = new Map<string, ValidateFunction | null>();

const PAYLOAD_SCHEMAS: Readonly<Partial<Record<EventType, object>>> = {
  ac_recorded: acRecordedSchema,
  chain_rotated: chainRotatedSchema,
  claim_taken_over: claimTakenOverSchema,
  doctor_completed: doctorCompletedSchema,
  evidence_recorded: evidenceRecordedSchema,
  gate_evaluated: gateEvaluatedSchema,
  spec_archived: specArchivedSchema,
  spec_archive_pruned: specArchivePrunedSchema,
  spec_activated: specActivatedSchema,
  spec_retired: specRetiredSchema,
  spec_scope_amended: specScopeAmendedSchema,
  spec_closed: specClosedSchema,
  spec_created: specCreatedSchema,
  spec_validated: specValidatedSchema,
  test_recorded: testRecordedSchema,
  waiver_applied: waiverAppliedSchema,
  worktree_bound: worktreeBoundSchema,
  worktree_created: worktreeCreatedSchema,
  worktree_destroyed: worktreeDestroyedSchema,
  worktree_merged: worktreeMergedSchema,
  worktree_ownership_seized: worktreeOwnershipSeizedSchema,
} as const;

function getAjv(): Ajv2020 {
  // Sharing one AJV instance across all validators is safe because
  // strict:true is set globally and we never reuse $id namespaces.
  return ajvSingleton ?? (ajvSingleton = makeAjv());
}
let ajvSingleton: Ajv2020 | null = null;

function makeAjv(): Ajv2020 {
  const a = new Ajv2020({ allErrors: true, strict: true });
  addFormats(a);
  return a;
}

function getEnvelopeValidator(): ValidateFunction {
  if (envelopeValidator !== null) return envelopeValidator;
  envelopeValidator = getAjv().compile(envelopeSchema as object);
  return envelopeValidator;
}

function getPayloadValidator(eventType: string): ValidateFunction | null {
  if (payloadValidators.has(eventType)) {
    return payloadValidators.get(eventType) ?? null;
  }
  const schema = PAYLOAD_SCHEMAS[eventType as EventType];
  if (schema === undefined) {
    payloadValidators.set(eventType, null);
    return null;
  }
  const compiled = getAjv().compile(schema);
  payloadValidators.set(eventType, compiled);
  return compiled;
}

// ---------------------------------------------------------------------------
// Public validators
// ---------------------------------------------------------------------------

/**
 * Validate caller-supplied event body BEFORE prepareAppend.
 *
 * The body is the input to prepareAppend: event vocabulary, ts, actor, data,
 * optional spec_id. The chain fields (seq, prev_hash, event_hash) are
 * deliberately ABSENT — the kernel computes them.
 *
 * Returns Ok with the value cast to EventBody on success. The cast is safe
 * because we explicitly check the chain fields are absent.
 */
export function validateEventBody(input: unknown): Result<EventBody> {
  const errors: Diagnostic[] = [];

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return err(
      diagnostic({
        rule: EVIDENCE_RULES.EVENT_ENVELOPE_INVALID,
        authority: 'kernel/evidence',
        message: 'Event body must be a non-null object.',
      })
    );
  }
  const obj = input as Record<string, unknown>;

  // Caller MUST NOT supply chain fields. If they do, that's a footgun —
  // they'd be claiming to know the seq/hash before the kernel chose it.
  for (const forbidden of ['seq', 'prev_hash', 'event_hash'] as const) {
    if (forbidden in obj) {
      errors.push(
        diagnostic({
          rule: EVIDENCE_RULES.EVENT_ENVELOPE_INVALID,
          authority: 'kernel/evidence',
          message: `Field "${forbidden}" must not be present on an EventBody — it is computed by prepareAppend.`,
          subject: forbidden,
          narrowRepair: `Remove "${forbidden}" from the body before calling prepareAppend.`,
        })
      );
    }
  }

  // Validate the body's intrinsic shape (event, ts, actor, data, optional spec_id).
  errors.push(...validateBodyIntrinsic(obj));

  if (errors.length > 0) return err(errors);
  return ok(input as EventBody);
}

/**
 * Validate a fully chained event (e.g. read from disk or returned by
 * prepareAppend). Validates body shape PLUS chain field shape. Does NOT
 * verify hash correctness — that's verifyChain's job.
 *
 * v10 read-side compatibility (KERNEL-EVENT-V10-COMPAT-ALIAS-001):
 * If `input.event === 'validation_completed'`, route through the v10
 * compat schema instead of the canonical v11 envelope. The v10 envelope
 * differs in three ways:
 *   - actor is a STRING (e.g. 'cli'), not a structured { kind, id }
 *   - session_id lives at the top level, not nested in actor.session_id
 *   - event is the literal 'validation_completed' (v11 renamed it to
 *     'spec_validated')
 *
 * On success the legacy event is returned cast as ChainedEvent — the
 * runtime shape (actor: string, top-level session_id) is preserved
 * verbatim per spec invariant I4 (no normalization before hash
 * verification, so the v10-writer-computed event_hash remains valid).
 * Callers reading the event's actor sub-fields must check
 * `event.event === 'validation_completed'` to detect legacy records
 * (that field value IS the discriminator). The compat path is read-only;
 * the writer (prepareAppend/appendEvent) emits only canonical v11 events.
 */
export function validateChainedEvent(input: unknown): Result<ChainedEvent> {
  const errors: Diagnostic[] = [];

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return err(
      diagnostic({
        rule: EVIDENCE_RULES.EVENT_ENVELOPE_INVALID,
        authority: 'kernel/evidence',
        message: 'ChainedEvent must be a non-null object.',
      })
    );
  }
  const obj = input as Record<string, unknown>;

  // v10 compat alias — route legacy validation_completed events through
  // a narrow alternative schema. The compat path is invoked ONLY when the
  // event name literally matches the deprecated v10 name. Every other
  // event name falls through to the canonical v11 validator unchanged.
  if (obj['event'] === 'validation_completed') {
    return validateLegacyV10ValidationCompleted(input, obj);
  }

  // Run AJV against the full envelope (chain fields + body fields).
  const validate = getEnvelopeValidator();
  if (!validate(input)) {
    for (const e of validate.errors ?? []) {
      errors.push(ajvErrorToDiagnostic(e));
    }
  }

  // Cross-check spec_id class — AJV can't express "presence depends on
  // event type" cleanly across 23 enums.
  const eventType = obj['event'];
  if (typeof eventType === 'string') {
    errors.push(...checkSpecIdClass(eventType, obj['spec_id']));
  }

  // Cross-check actor shape with structured rule ids — AJV's generic
  // additionalProperties / required errors don't carry our stable rule.
  const actor = obj['actor'];
  if (actor !== undefined) {
    errors.push(...checkActorShape(actor));
  }

  // Per-type payload schema (when one exists).
  if (typeof eventType === 'string' && obj['data'] !== undefined) {
    errors.push(...validatePayload(eventType, obj['data']));
  }

  if (errors.length > 0) return err(errors);
  return ok(input as ChainedEvent);
}

// ---------------------------------------------------------------------------
// v10 read-side compatibility (KERNEL-EVENT-V10-COMPAT-ALIAS-001)
// ---------------------------------------------------------------------------

/**
 * Lazy-compiled validator for the v10 validation_completed envelope.
 * Built on first use, then cached for the process lifetime. The schema
 * itself is immutable (versioned at .v1).
 */
let validationCompletedValidator: ValidateFunction | null = null;

function getValidationCompletedValidator(): ValidateFunction {
  if (validationCompletedValidator !== null) return validationCompletedValidator;
  validationCompletedValidator = getAjv().compile(validationCompletedSchema as object);
  return validationCompletedValidator;
}

/**
 * Accept a v10 validation_completed entry as a legacy chained event.
 *
 * Returns ok(ChainedEvent) — the runtime shape is preserved verbatim
 * (actor as string, top-level session_id). The cast lets the caller
 * treat the value as a chained event for chain-traversal purposes;
 * callers that need to dereference actor sub-fields must first check
 * `event === 'validation_completed'` and handle the legacy shape
 * accordingly.
 *
 * On schema mismatch, returns err with a structured diagnostic naming
 * the failing field. This is NOT a general bypass — malformed
 * validation_completed records are still rejected (spec invariants I3).
 *
 * Hash chain semantics are unchanged. The v10 writer computed event_hash
 * over its own canonical JSON serialization (which included the string
 * actor and top-level session_id); the v11 verifier MUST hash the same
 * bytes to get a matching event_hash. This function does not normalize,
 * lift, or rewrite any field of the parsed event before returning it
 * (spec invariant I4).
 */
function validateLegacyV10ValidationCompleted(
  input: unknown,
  obj: Record<string, unknown>
): Result<ChainedEvent> {
  const validate = getValidationCompletedValidator();
  if (validate(input)) {
    // The cast is structurally lossy at compile time (the runtime
    // actor is `string`, the type declares it as `Actor`). The
    // discriminator is `event === 'validation_completed'`, which is
    // the v10 sentinel — no v11 event uses that name.
    return ok(input as unknown as ChainedEvent);
  }
  const errors: Diagnostic[] = [];
  for (const e of validate.errors ?? []) {
    // Reuse ajvErrorToDiagnostic so the diagnostic shape is identical
    // to the v11 path. The compat schema's error pointers
    // (`/actor`, `/data/passed`, etc.) flow through naturally.
    const d = ajvErrorToDiagnostic(e);
    // Tag legacy diagnostics with a hint so downstream observers can
    // distinguish "malformed v10 event" from "valid v10 event rejected
    // by v11 rules" — useful for surfacing the compat path's failure
    // mode without conflating it with the canonical path.
    errors.push({
      ...d,
      data: { ...(d.data ?? {}), legacyCompat: 'validation_completed.v1' },
    });
  }
  // checkSpecIdClass — validation_completed is v10's name for
  // spec_validated which is REQUIRES_SPEC_ID; enforce the same class.
  const specIdErrors = checkSpecIdClass('spec_validated', obj['spec_id']);
  for (const d of specIdErrors) {
    errors.push({
      ...d,
      data: { ...(d.data ?? {}), legacyCompat: 'validation_completed.v1' },
    });
  }
  if (errors.length > 0) return err(errors);
  // Shouldn't reach here — AJV failed but no errors collected. Defensive.
  return err(
    diagnostic({
      rule: EVIDENCE_RULES.EVENT_ENVELOPE_INVALID,
      authority: 'kernel/evidence',
      message:
        'v10 validation_completed event failed schema validation but no specific error was reported.',
      data: { legacyCompat: 'validation_completed.v1' },
    })
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validate the intrinsic body fields (no chain fields). */
function validateBodyIntrinsic(obj: Record<string, unknown>): Diagnostic[] {
  const out: Diagnostic[] = [];

  // event vocabulary
  const eventType = obj['event'];
  if (typeof eventType !== 'string' || !isKnownEventType(eventType)) {
    out.push(
      diagnostic({
        rule: EVIDENCE_RULES.EVENT_UNKNOWN_TYPE,
        authority: 'kernel/evidence',
        message: `Unknown event type ${typeof eventType === 'string' ? JSON.stringify(eventType) : '<missing>'}.`,
        subject: 'event',
        narrowRepair: 'Use one of the closed event types from EventType union.',
      })
    );
    // Without a known event type we can't reason about spec_id class or payload.
  } else {
    out.push(...checkSpecIdClass(eventType, obj['spec_id']));
    if (obj['data'] === undefined) {
      out.push(
        diagnostic({
          rule: EVIDENCE_RULES.EVENT_DATA_MISSING,
          authority: 'kernel/evidence',
          message: 'Event body must include a data field (use {} when there is no payload).',
          subject: 'data',
        })
      );
    } else {
      out.push(...validatePayload(eventType, obj['data']));
    }
  }

  // ts shape
  const ts = obj['ts'];
  if (typeof ts !== 'string' || !isIsoDateTime(ts)) {
    out.push(
      diagnostic({
        rule: EVIDENCE_RULES.EVENT_TIMESTAMP_INVALID,
        authority: 'kernel/evidence',
        message: 'ts must be an ISO-8601 date-time string.',
        subject: 'ts',
        narrowRepair: 'Use a UTC ISO-8601 string, e.g. new Date().toISOString().',
      })
    );
  }

  // actor
  const actor = obj['actor'];
  if (actor === undefined || actor === null) {
    out.push(
      diagnostic({
        rule: EVIDENCE_RULES.ACTOR_MISSING,
        authority: 'kernel/evidence',
        message: 'actor is required on every event.',
        subject: 'actor',
      })
    );
  } else {
    out.push(...checkActorShape(actor));
  }

  return out;
}

const VALID_ACTOR_KINDS: ReadonlySet<ActorKind> = new Set<ActorKind>([
  'human',
  'agent',
  'system',
  'automation',
]);

function checkActorShape(actor: unknown): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (actor === null || typeof actor !== 'object' || Array.isArray(actor)) {
    out.push(
      diagnostic({
        rule: EVIDENCE_RULES.ACTOR_MISSING,
        authority: 'kernel/evidence',
        message: 'actor must be a non-null object with kind and id.',
        subject: 'actor',
      })
    );
    return out;
  }
  const a = actor as Record<string, unknown>;

  const kind = a['kind'];
  if (typeof kind !== 'string' || !VALID_ACTOR_KINDS.has(kind as ActorKind)) {
    out.push(
      diagnostic({
        rule: EVIDENCE_RULES.ACTOR_KIND_INVALID,
        authority: 'kernel/evidence',
        message: `actor.kind must be one of: human, agent, system, automation. Got ${typeof kind === 'string' ? JSON.stringify(kind) : '<missing>'}.`,
        subject: 'actor.kind',
      })
    );
  }

  const id = a['id'];
  if (typeof id !== 'string' || id.length === 0) {
    out.push(
      diagnostic({
        rule: EVIDENCE_RULES.ACTOR_ID_EMPTY,
        authority: 'kernel/evidence',
        message: 'actor.id must be a non-empty string.',
        subject: 'actor.id',
        narrowRepair: 'Set actor.id to a non-empty caller-defined identifier.',
      })
    );
  }

  if (a['session_id'] !== undefined) {
    if (typeof a['session_id'] !== 'string' || (a['session_id'] as string).length === 0) {
      out.push(
        diagnostic({
          rule: EVIDENCE_RULES.ACTOR_SESSION_ID_EMPTY,
          authority: 'kernel/evidence',
          message: 'actor.session_id, when present, must be a non-empty string.',
          subject: 'actor.session_id',
        })
      );
    }
  }
  if (a['platform'] !== undefined) {
    if (typeof a['platform'] !== 'string' || (a['platform'] as string).length === 0) {
      out.push(
        diagnostic({
          rule: EVIDENCE_RULES.ACTOR_PLATFORM_EMPTY,
          authority: 'kernel/evidence',
          message: 'actor.platform, when present, must be a non-empty string.',
          subject: 'actor.platform',
        })
      );
    }
  }
  return out;
}

function checkSpecIdClass(eventType: string, specId: unknown): Diagnostic[] {
  const out: Diagnostic[] = [];
  const requires = REQUIRES_SPEC_ID.has(eventType as EventType);
  const forbidden = NO_SPEC_ID.has(eventType as EventType);

  if (requires) {
    if (typeof specId !== 'string' || specId.trim().length === 0) {
      out.push(
        diagnostic({
          rule: EVIDENCE_RULES.EVENT_SPEC_ID_REQUIRED,
          authority: 'kernel/evidence',
          message: `Event type "${eventType}" requires a non-empty spec_id.`,
          subject: 'spec_id',
          narrowRepair: 'Set spec_id to the spec the event is scoped to.',
        })
      );
    }
  } else if (forbidden) {
    if (specId !== undefined) {
      out.push(
        diagnostic({
          rule: EVIDENCE_RULES.EVENT_SPEC_ID_FORBIDDEN,
          authority: 'kernel/evidence',
          message: `Event type "${eventType}" must not carry a spec_id (it is repo-level, not spec-scoped).`,
          subject: 'spec_id',
          narrowRepair: 'Omit spec_id from the body.',
        })
      );
    }
  }

  // When present (REQUIRES or OPTIONAL), shape must satisfy the spec id regex.
  if (typeof specId === 'string' && specId.length > 0 && !SPEC_ID_REGEX.test(specId)) {
    out.push(
      diagnostic({
        rule: EVIDENCE_RULES.EVENT_SPEC_ID_INVALID,
        authority: 'kernel/evidence',
        message: `spec_id ${JSON.stringify(specId)} does not match required pattern.`,
        subject: 'spec_id',
        narrowRepair: 'Use the canonical spec id format: ^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\\d+[a-z]*$',
      })
    );
  }

  return out;
}

function validatePayload(eventType: string, data: unknown): Diagnostic[] {
  const validator = getPayloadValidator(eventType);
  if (validator === null) {
    // No payload schema for this event type — accept any object.
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return [
        diagnostic({
          rule: EVIDENCE_RULES.EVENT_PAYLOAD_INVALID,
          authority: 'kernel/evidence',
          message: 'data must be an object (use {} when no payload).',
          subject: 'data',
        }),
      ];
    }
    return [];
  }
  if (validator(data)) return [];
  return (validator.errors ?? []).map((e) =>
    diagnostic({
      rule: EVIDENCE_RULES.EVENT_PAYLOAD_INVALID,
      authority: 'kernel/evidence',
      message: `data: ${e.message ?? 'payload schema violation'}`,
      subject: `data${e.instancePath || ''}`,
      data: { ajvKeyword: e.keyword, ajvParams: e.params, ajvSchemaPath: e.schemaPath },
    })
  );
}

const SPEC_ID_REGEX = /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\d+[a-z]*$/;

function isIsoDateTime(s: string): boolean {
  // AJV's date-time format does this exactly; we mirror it for body
  // validation since validateEventBody doesn't run the full envelope schema.
  // RFC 3339 / ISO 8601 with required 'T' and timezone or 'Z'.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s);
}

// All event types we know about (mirrors the closed enum in events.v1.json).
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<EventType>([
  'spec_created',
  'spec_validated',
  'spec_updated',
  'spec_activated',
  'spec_closed',
  'spec_archived',
  'spec_archive_pruned',
  'spec_retired',
  'spec_deleted',
  'spec_scope_amended',
  'spec_drift_detected',
  'worktree_created',
  'worktree_bound',
  'worktree_merged',
  'worktree_destroyed',
  'worktree_ownership_seized',
  'claim_taken_over',
  'evidence_recorded',
  'ac_recorded',
  'test_recorded',
  'gate_evaluated',
  'waiver_applied',
  'waiver_revoked',
  'doctor_completed',
  'session_started',
  'session_ended',
  'commit_made',
  'branch_switched',
  'chain_rotated',
]);

function isKnownEventType(s: string): boolean {
  return KNOWN_EVENT_TYPES.has(s);
}

function ajvErrorToDiagnostic(e: ErrorObject): Diagnostic {
  const pointer = e.instancePath || '/';

  // Map a few AJV errors to our stable rules.
  let rule: string = EVIDENCE_RULES.EVENT_ENVELOPE_INVALID;
  if (pointer.startsWith('/data')) rule = EVIDENCE_RULES.EVENT_PAYLOAD_INVALID;
  if (pointer === '/ts' || (pointer.startsWith('/ts') && e.keyword === 'format'))
    rule = EVIDENCE_RULES.EVENT_TIMESTAMP_INVALID;
  if (pointer === '/event' && e.keyword === 'enum') rule = EVIDENCE_RULES.EVENT_UNKNOWN_TYPE;
  if (pointer === '/spec_id' && e.keyword === 'pattern')
    rule = EVIDENCE_RULES.EVENT_SPEC_ID_INVALID;
  if (pointer.startsWith('/actor')) {
    if (pointer === '/actor' && e.keyword === 'required') rule = EVIDENCE_RULES.ACTOR_MISSING;
    else if (pointer === '/actor/kind' && e.keyword === 'enum') rule = EVIDENCE_RULES.ACTOR_KIND_INVALID;
    else if (pointer === '/actor/id') rule = EVIDENCE_RULES.ACTOR_ID_EMPTY;
    else if (pointer === '/actor/session_id') rule = EVIDENCE_RULES.ACTOR_SESSION_ID_EMPTY;
    else if (pointer === '/actor/platform') rule = EVIDENCE_RULES.ACTOR_PLATFORM_EMPTY;
  }
  if (pointer === '/seq' && (e.keyword === 'type' || e.keyword === 'integer'))
    rule = EVIDENCE_RULES.CHAIN_SEQ_NOT_INTEGER;
  if (pointer === '/seq' && (e.keyword === 'minimum' || e.keyword === 'exclusiveMinimum'))
    rule = EVIDENCE_RULES.CHAIN_SEQ_NOT_POSITIVE;
  if (pointer === '/prev_hash' && e.keyword === 'pattern')
    rule = EVIDENCE_RULES.CHAIN_PREV_HASH_MALFORMED;
  if (pointer === '/event_hash' && e.keyword === 'pattern')
    rule = EVIDENCE_RULES.CHAIN_EVENT_HASH_MALFORMED;

  return diagnostic({
    rule,
    authority: 'kernel/evidence',
    message: e.message ?? `Schema violation (${e.keyword}).`,
    subject: pointer,
    location: { pointer },
    data: { ajvKeyword: e.keyword, ajvParams: e.params, ajvSchemaPath: e.schemaPath },
  });
}

/** Re-export the hash regex for callers that want to validate format without parsing. */
export { HASH_REGEX };
