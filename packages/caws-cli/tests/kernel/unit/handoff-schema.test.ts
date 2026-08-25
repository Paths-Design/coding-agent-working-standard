import { validateEventBody } from '../../../src/kernel/evidence/validate';
import { isOk } from '../../../src/kernel/result/construct';

// MULTI-AGENT-HANDOFF-EVENT-001 A6: each handoff event variant validates
// against its payload schema; malformed variants are rejected; existing types
// continue to validate. Verifies the five vocabulary sites admit the new types
// atomically (schema -> envelope enum -> EventType -> class set -> known set).

function makeBody(event: string, data: Record<string, unknown>, specId?: string) {
  return {
    event,
    ts: '2026-08-25T12:00:00.000Z',
    actor: { kind: 'agent', id: 'sess-b', session_id: 'sess-b' },
    ...(specId !== undefined ? { spec_id: specId } : {}),
    data,
  };
}

describe('handoff event schema validation (MULTI-AGENT-HANDOFF-EVENT-001)', () => {
  test('each handoff variant validates with a well-formed payload', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['stash_restore', { source_session: 'sess-a', receiving_session: 'sess-b', paths: ['src/a.ts'] }],
      ['claim_transfer', { source_session: 'sess-a', receiving_session: 'sess-b', paths: ['src/**'] }],
      ['overlap_ack_proceed', { source_session: 'sess-a', receiving_session: 'sess-b', paths: ['src/a.ts'], target_command: 'git stash' }],
      ['manual_pickup', { source_session: 'sess-a', receiving_session: 'sess-b', paths: ['src/a.ts'], reason: 'user-authorized' }],
    ];
    for (const [event, data] of cases) {
      const result = validateEventBody(makeBody(event, data));
      expect(isOk(result)).toBe(true);
    }
  });

  test('malformed variants are rejected (missing required field / extra field)', () => {
    // missing receiving_session
    expect(isOk(validateEventBody(makeBody('stash_restore', { source_session: 'a', paths: ['x'] })))).toBe(false);
    // overlap_ack_proceed requires target_command
    expect(
      isOk(validateEventBody(makeBody('overlap_ack_proceed', { source_session: 'a', receiving_session: 'b', paths: ['x'] })))
    ).toBe(false);
    // additionalProperties: false
    expect(
      isOk(
        validateEventBody(
          makeBody('manual_pickup', { source_session: 'a', receiving_session: 'b', paths: ['x'], extra: 1 })
        )
      )
    ).toBe(false);
  });

  test('existing event types still validate unchanged', () => {
    // gate_evaluated is REQUIRES_SPEC_ID, so carry a spec_id.
    expect(
      isOk(
        validateEventBody(
          makeBody('gate_evaluated', { gate_id: 'budget_limit', mode: 'block', result: 'pass' }, 'FEAT-1')
        )
      )
    ).toBe(true);
  });
});
