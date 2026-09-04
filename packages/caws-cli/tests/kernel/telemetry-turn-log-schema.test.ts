/**
 * CAWS-HARNESS-TELEMETRY-ADAPTER-001 — turn-log wire-format contract (A5).
 *
 * The kernel contract for .caws/sessions/<id>/turn-NNN.json v2 payloads is
 * src/kernel/schemas/telemetry/turn-log.v2.json. It is a producer contract for
 * the operational cache: no kernel authority path reads turn logs, but every
 * conformant producer (vendored renderer, per-harness adapter) must satisfy
 * this shape.
 *
 * The negative fixtures double as the mutation check required by the spec:
 * each asserts that a non-conformant payload is rejected AND names the exact
 * ajv keyword + instancePath for the rejection. If the schema document is
 * mutated to accept non-conformant shapes (schema_version loosened,
 * additionalProperties flipped, status enum widened, required list trimmed),
 * the corresponding fixture fails — the schema cannot be silently relaxed.
 *
 * The 'document pins' block asserts the schema file itself still declares the
 * load-bearing constraints, so a mutated schema is caught even before fixtures
 * run against it.
 */
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { ErrorObject, ValidateFunction } from 'ajv';
import turnLogSchema from '../../src/kernel/schemas/telemetry/turn-log.v2.json';

function compile(schema: object): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

/** Assert `payload` is rejected, and rejected for the RIGHT reason: the error
 *  list must contain an error at `instancePath` with ajv keyword `keyword`. */
function expectRejected(
  validate: ValidateFunction,
  payload: unknown,
  instancePath: string,
  keyword: string
): void {
  const valid = validate(payload);
  expect(valid).toBe(false);
  const errors: ErrorObject[] = validate.errors || [];
  const matched = errors.some(
    (e) => e.instancePath === instancePath && e.keyword === keyword
  );
  if (!matched) {
    throw new Error(
      `expected rejection at ${instancePath} (${keyword}), got: ` +
        errors.map((e) => `${e.instancePath} ${e.keyword}`).join('; ')
    );
  }
}

// --- fixtures ---------------------------------------------------------------

// Fixtures deliberately exercise invalid shapes too (wrong-typed status,
// out-of-range turn, unknown keys), so every field stays `unknown` and the
// negative tests assign through the loose index signature. `context` is
// pinned narrower because two fixtures spread-and-mutate it.
interface TurnLogFixture {
  [key: string]: unknown;
  context?: Record<string, unknown>;
}

/** Mirrors a real vendored-renderer payload (session_log_renderer.py v2 fold),
 *  timeline trimmed to one item per polymorphic kind family. */
const fullRealShapedPayload: TurnLogFixture = {
  schema_version: 2,
  turn: 7,
  context: {
    session_id: 'session-9b3e0aff-1ca1-47b0-bfe8-64fa50f4899b',
    project: 'caws',
    cwd: '/Users/darianrosebrook/Desktop/Projects/caws',
    model: 'unknown',
    session_started_at: '2026-08-26T20:29:10.733Z',
    branch: 'main',
    head_sha: 'c40c4eee',
    start_sha: '',
    dirty_files: 0,
  },
  ts_start: '2026-08-26T20:29:19.472Z',
  ts_end: '2026-08-26T20:36:42.666Z',
  user: 'How many of these have already been addressed?',
  user_ts: '2026-08-26T20:29:19.472Z',
  turn_summary: 'Done — with one detour the guard forced.',
  status: 'ok',
  ended_by: null,
  decisions: [],
  next_action: null,
  blocking_issue: null,
  refs: {
    files: { edited: [], read: [] },
    searches: [],
    commands: [],
    agents: [],
    artifacts: [],
  },
  hook_contexts: [],
  interjections: [],
  timeline: [
    {
      kind: 'reasoning',
      provenance: 'assistant_reasoning',
      text: 'Reading the ledger first.',
      ts: '2026-08-26T20:29:20.000Z',
    },
    {
      kind: 'tool_call',
      name: 'bash',
      id: 'call_c839c5b0adf2444683cfa994',
      command: 'git log --oneline -5',
      description: 'Show recent commits',
      run_in_background: false,
      ts: '2026-08-26T20:29:26.307Z',
      result_ts: '2026-08-26T20:29:26.900Z',
      duration_s: 0.6,
      is_error: false,
      output: 'c40c4eee chore(caws): close HANDOFF-EXPORT-IMPORT-001',
      provenance: 'tool_call',
    },
    {
      kind: 'tool_call',
      name: 'edit',
      id: 'call_edit1',
      file: 'packages/caws-cli/src/init/hook-packs/manifest-shared.ts',
      old_string: 'const x = 1;',
      new_string: 'const x = 2;',
      ts: '2026-08-26T20:30:00.000Z',
      result_ts: '2026-08-26T20:30:00.200Z',
      duration_s: 0.2,
      is_error: false,
      output: 'ok',
      provenance: 'tool_call',
    },
  ],
};

/** The required-key intersection: a degraded turn that omits context,
 *  ended_by, and every deferred-detail field must still validate. */
const minimalDegradedPayload: TurnLogFixture = {
  schema_version: 2,
  turn: 1,
  ts_start: '2026-08-26T20:29:19.472Z',
  ts_end: '2026-08-26T20:36:42.666Z',
  user: 'go',
  user_ts: '2026-08-26T20:29:19.472Z',
  turn_summary: 'Turn without captured context.',
  status: 'error',
  timeline: [],
};

// --- the contract ------------------------------------------------------------

describe('turn-log.v2 schema (CAWS-HARNESS-TELEMETRY-ADAPTER-001 A5)', () => {
  let validate: ValidateFunction;

  beforeAll(() => {
    validate = compile(turnLogSchema);
  });

  describe('document pins (mutation check on the schema file itself)', () => {
    it('pins schema_version to the literal 2', () => {
      expect(turnLogSchema.properties.schema_version.const).toBe(2);
    });

    it('forbids additional top-level properties', () => {
      expect(turnLogSchema.additionalProperties).toBe(false);
    });

    it('requires the intersection core every real v2 file carries', () => {
      expect([...turnLogSchema.required].sort()).toEqual(
        [
          'schema_version',
          'turn',
          'ts_start',
          'ts_end',
          'user',
          'user_ts',
          'turn_summary',
          'status',
          'timeline',
        ].sort()
      );
    });

    it('pins the status enum to the renderer vocabulary', () => {
      expect(turnLogSchema.properties.status.enum).toEqual([
        'ok',
        'error',
        'blocked',
      ]);
    });

    it('leaves timeline items open on per-kind detail but pinned on the core', () => {
      const item = turnLogSchema.$defs.timelineItem;
      expect(item.additionalProperties).toBe(true);
      expect([...item.required].sort()).toEqual(
        ['kind', 'provenance', 'ts'].sort()
      );
    });
  });

  describe('conformant payloads pass', () => {
    it('accepts a full real-shaped vendored-renderer payload', () => {
      const valid = validate(fullRealShapedPayload);
      if (!valid) {
        throw new Error(
          'full payload rejected: ' +
            (validate.errors || [])
              .map((e) => `${e.instancePath} ${e.message}`)
              .join('; ')
        );
      }
    });

    it('accepts the minimal degraded shape (context omitted)', () => {
      const valid = validate(minimalDegradedPayload);
      if (!valid) {
        throw new Error(
          'minimal payload rejected: ' +
            (validate.errors || [])
              .map((e) => `${e.instancePath} ${e.message}`)
              .join('; ')
        );
      }
    });

    it('accepts polymorphic timeline items with per-kind detail', () => {
      const valid = validate({
        ...minimalDegradedPayload,
        timeline: fullRealShapedPayload.timeline,
      });
      expect(valid).toBe(true);
    });

    it('accepts every enum-visible status value', () => {
      for (const status of ['ok', 'error', 'blocked']) {
        expect(validate({ ...minimalDegradedPayload, status })).toBe(true);
      }
    });
  });

  describe('non-conformant payloads are rejected with typed reasons', () => {
    it('rejects v1 payloads — schema_version is a const, not a floor', () => {
      expectRejected(
        validate,
        { ...minimalDegradedPayload, schema_version: 1 },
        '/schema_version',
        'const'
      );
    });

    it('rejects stringified version "2"', () => {
      expectRejected(
        validate,
        { ...minimalDegradedPayload, schema_version: '2' },
        '/schema_version',
        'const'
      );
    });

    it('rejects unknown future versions (v3) instead of coercing', () => {
      expectRejected(
        validate,
        { ...minimalDegradedPayload, schema_version: 3 },
        '/schema_version',
        'const'
      );
    });

    it('rejects unknown top-level properties', () => {
      expectRejected(
        validate,
        { ...minimalDegradedPayload, telemetry_extra: true },
        '',
        'additionalProperties'
      );
    });

    it('rejects status values outside the renderer vocabulary', () => {
      expectRejected(
        validate,
        { ...minimalDegradedPayload, status: 'failed' },
        '/status',
        'enum'
      );
    });

    it('rejects non-positive turn numbers', () => {
      expectRejected(validate, { ...minimalDegradedPayload, turn: 0 }, '/turn', 'minimum');
    });

    it('rejects timeline items missing the structural core', () => {
      expectRejected(
        validate,
        {
          ...minimalDegradedPayload,
          timeline: [{ kind: 'tool_call', ts: '2026-08-26T20:29:26Z' }],
        },
        '/timeline/0',
        'required'
      );
    });

    it('rejects a context object missing session identity', () => {
      const context = { ...fullRealShapedPayload.context };
      delete context.session_id;
      expectRejected(
        validate,
        { ...fullRealShapedPayload, context },
        '/context',
        'required'
      );
    });

    it('rejects a context object with unknown fields', () => {
      const context = {
        ...fullRealShapedPayload.context,
        harness_flavor: 'dsh',
      };
      expectRejected(
        validate,
        { ...fullRealShapedPayload, context },
        '/context',
        'additionalProperties'
      );
    });

    it('rejects missing required intersection keys', () => {
      const { turn_summary, ...withoutSummary } = minimalDegradedPayload;
      expectRejected(validate, withoutSummary, '', 'required');
    });

    it('rejects non-timestamps in ts_end (format is validating, not annotation)', () => {
      expectRejected(
        validate,
        { ...minimalDegradedPayload, ts_end: 'not-a-timestamp' },
        '/ts_end',
        'format'
      );
    });
  });
});
