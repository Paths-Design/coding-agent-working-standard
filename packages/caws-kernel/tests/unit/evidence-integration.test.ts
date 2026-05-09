// Integration: at least one valid sample per per-event payload schema.
// Locks the contract that prepareAppend → verifyChain round-trips for
// every supported event type.

import {
  EVIDENCE_RULE_PREFIXES,
  EVIDENCE_RULES,
  prepareAppend,
  specIdClassOf,
  verifyChain,
  type Actor,
  type ChainedEvent,
  type EventBody,
  type EventType,
} from '../../src/evidence';
import { isOk } from '../../src/result';

const actor: Actor = { kind: 'agent', id: 'darian', session_id: 'sess-1' };
const ts = '2026-05-08T00:00:00.000Z';

interface TypedSample {
  event: EventType;
  spec_id?: string;
  data: EventBody['data'];
}

const samplesByEventType: TypedSample[] = [
  // REQUIRES_SPEC_ID — types with payload schemas
  {
    event: 'spec_created',
    spec_id: 'FOO-1',
    data: { title: 'Test feature', risk_tier: 2, mode: 'feature', lifecycle_state: 'draft' },
  },
  {
    event: 'spec_validated',
    spec_id: 'FOO-1',
    data: { passed: true, error_count: 0, warning_count: 0 },
  },
  { event: 'spec_closed', spec_id: 'FOO-1', data: { resolution: 'completed' } },
  {
    event: 'spec_archived',
    spec_id: 'FOO-1',
    data: { from_path: '.caws/specs/FOO-1.yaml', to_path: '.caws/specs/.archive/FOO-1.yaml' },
  },
  {
    event: 'ac_recorded',
    spec_id: 'FOO-1',
    data: { criterion_id: 'A1', status: 'pass', evidence_ref: 'tests/foo.test.ts' },
  },
  {
    event: 'test_recorded',
    spec_id: 'FOO-1',
    data: { command: 'npx jest', exit_code: 0, nodeids: ['suite > a'] },
  },
  {
    event: 'gate_evaluated',
    spec_id: 'FOO-1',
    data: { gate_id: 'budget_limit', mode: 'block', result: 'pass' },
  },
  {
    event: 'evidence_recorded',
    spec_id: 'FOO-1',
    data: { kind: 'manual', summary: 'Evidence recorded by hand' },
  },
  {
    event: 'waiver_applied',
    spec_id: 'FOO-1',
    data: { waiver_id: 'WV-0001', gates: ['budget_limit'] },
  },
  { event: 'worktree_bound', spec_id: 'FOO-1', data: { worktree_name: 'wt-foo' } },

  // OPTIONAL_SPEC_ID
  {
    event: 'worktree_created',
    spec_id: 'FOO-1',
    data: {
      name: 'wt-foo',
      branch: 'caws/wt-foo',
      base_branch: 'main',
      path: '.caws/worktrees/wt-foo',
    },
  },
  {
    event: 'worktree_merged',
    spec_id: 'FOO-1',
    data: { worktree_name: 'wt-foo', merge_commit: 'a1b2c3d4e5f6', base_branch: 'main' },
  },
  {
    event: 'claim_taken_over',
    spec_id: 'FOO-1',
    data: {
      worktree_name: 'wt-foo',
      prior_owner: { session_id: 'sess-prev' },
      new_owner: { session_id: 'sess-1' },
    },
  },

  // NO_SPEC_ID
  {
    event: 'doctor_completed',
    data: { passed: true, checks_run: 5, drift_count: 0 },
  },
];

describe('evidence integration — every typed event round-trips', () => {
  it.each(samplesByEventType)(
    'prepareAppend + verifyChain on a single $event event',
    ({ event, spec_id, data }) => {
      const body: EventBody =
        spec_id !== undefined
          ? { event, ts, actor, spec_id, data }
          : { event, ts, actor, data };
      const r = prepareAppend(null, body);
      expect(isOk(r)).toBe(true);
      if (!isOk(r)) return;
      expect(r.value.seq).toBe(1);
      expect(r.value.prev_hash).toBeNull();
      expect(verifyChain([r.value])).toEqual({ ok: true, value: [r.value] });
    }
  );

  it('chains all sample events together and verifies', () => {
    let prev: ChainedEvent | null = null;
    const chain: ChainedEvent[] = [];
    for (const s of samplesByEventType) {
      const body: EventBody =
        s.spec_id !== undefined
          ? { event: s.event, ts, actor, spec_id: s.spec_id, data: s.data }
          : { event: s.event, ts, actor, data: s.data };
      const r = prepareAppend(prev, body);
      if (!isOk(r)) {
        throw new Error(
          `prepareAppend failed for ${s.event}: ${JSON.stringify(r.errors)}`
        );
      }
      chain.push(r.value);
      prev = r.value;
    }
    const v = verifyChain(chain);
    expect(isOk(v)).toBe(true);
  });
});

describe('evidence — public namespace contract', () => {
  it('every EVIDENCE_RULES value falls under one of the public prefixes', () => {
    for (const value of Object.values(EVIDENCE_RULES)) {
      expect(EVIDENCE_RULE_PREFIXES.some((p) => value.startsWith(p))).toBe(true);
    }
  });

  it('specIdClassOf agrees with the closed sets for known types', () => {
    expect(specIdClassOf('spec_created')).toBe('requires');
    expect(specIdClassOf('worktree_created')).toBe('optional');
    expect(specIdClassOf('doctor_completed')).toBe('forbidden');
    expect(specIdClassOf('not_an_event')).toBe('unknown');
  });
});
