import { validateEventBody } from '../../src/evidence/validate';
import { isErr, isOk } from '../../src/result';
import { REQUIRES_SPEC_ID } from '../../src/evidence/types';
import type { Actor } from '../../src/evidence/types';

const ACTOR: Actor = { kind: 'agent', id: 'a', session_id: 's' };
const TS = '2026-07-04T00:00:00.000Z';

describe('spec_restored event contract', () => {
  const valid = {
    event: 'spec_restored',
    ts: TS,
    actor: ACTOR,
    spec_id: 'RESTORE-SPEC-001',
    data: {
      source_event: 'spec_archived',
      from_path: '.caws/specs/RESTORE-SPEC-001.yaml',
      blob_sha: '0123456789abcdef0123456789abcdef01234567',
      restored_path: '.caws/specs/RESTORE-SPEC-001.yaml',
      restored_lifecycle_state: 'draft',
    },
  };

  test('is registered as REQUIRES_SPEC_ID', () => {
    expect(REQUIRES_SPEC_ID.has('spec_restored')).toBe(true);
  });

  test('accepts a well-formed archived restore payload', () => {
    expect(isOk(validateEventBody(valid))).toBe(true);
  });

  test('accepts retired sources and active target state', () => {
    const result = validateEventBody({
      ...valid,
      data: {
        ...valid.data,
        source_event: 'spec_retired',
        restored_lifecycle_state: 'active',
      },
    });
    expect(isOk(result)).toBe(true);
  });

  test('rejects missing spec_id', () => {
    const { spec_id: _drop, ...withoutSpec } = valid;
    void _drop;
    expect(isErr(validateEventBody(withoutSpec))).toBe(true);
  });

  test('rejects unknown data properties and invalid target states', () => {
    expect(isErr(validateEventBody({
      ...valid,
      data: { ...valid.data, restored_lifecycle_state: 'closed' },
    }))).toBe(true);
    expect(isErr(validateEventBody({
      ...valid,
      data: { ...valid.data, extra: true },
    }))).toBe(true);
  });
});
