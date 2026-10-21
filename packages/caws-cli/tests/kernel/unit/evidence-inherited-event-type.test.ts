import Ajv2020 from 'ajv/dist/2020';
import { validateChainedEvent, validateEventBody } from '../../../src/kernel/evidence/validate';
import { isErr, isOk } from '../../../src/kernel/result';

const body = {
  event: 'worktree_pruned',
  ts: '2026-10-21T00:00:00.000Z',
  actor: { kind: 'agent', id: 'fixture', session_id: 'fixture' },
  data: { worktree_name: 'fixture', h_class: 'ghost_registry', reason: 'fixture' },
};

function chained(event: string): unknown {
  // Envelope validation checks hash shape; verifyChain owns hash correctness.
  return {
    ...body,
    event,
    data: {},
    seq: 1,
    prev_hash: null,
    event_hash: 'sha256:' + '0'.repeat(64),
  };
}

beforeAll(() => {
  // Warm only the fixed envelope schema. Unknown payload kinds have no schema.
  expect(isErr(validateChainedEvent(chained('unregistered_fixture')))).toBe(true);
});

test.each([
  '__proto__',
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  '__defineGetter__',
])(
  'read-side event %s returns unknown-type diagnostics without compiling an inherited schema',
  (event) => {
    const compile = jest.spyOn(Ajv2020.prototype, 'compile');
    try {
      const result = validateChainedEvent(chained(event));
      expect(isErr(result)).toBe(true);
      if (!isErr(result)) throw new Error('Unknown event unexpectedly admitted');
      expect(result.errors.map((error) => error.rule)).toContain('evidence.event.unknown_type');
      expect(compile).not.toHaveBeenCalled();
      // Repeated lookup must preserve the same rejection and not compile later.
      const repeated = validateChainedEvent(chained(event));
      expect(repeated).toEqual(result);
      expect(compile).not.toHaveBeenCalled();
    } finally {
      compile.mockRestore();
    }
  }
);

test('declared payload schemas still accept valid data and reject missing required fields', () => {
  expect(isOk(validateEventBody(body))).toBe(true);
  const result = validateEventBody({ ...body, data: {} });
  expect(isErr(result)).toBe(true);
  if (!isErr(result)) throw new Error('Invalid declared payload unexpectedly admitted');
  expect(result.errors.map((error) => error.rule)).toContain('evidence.event.payload_invalid');
});
