import { inspectProjectState } from '../../../src/kernel/doctor/inspect';
import {
  historicalWaiverUses,
  unmetObligations,
  worktreeHistory,
} from '../../../src/kernel/doctor/history';
import type { Waiver } from '../../../src/kernel/waiver/types';
import type { ChainedEvent } from '../../../src/kernel/evidence/types';
import type { Spec } from '../../../src/kernel/spec/types';

const waiver = {
  id: 'W',
  title: 'waiver',
  reason: 'bounded exception',
  approved_by: 'operator',
  status: 'revoked',
  created_at: '2026-01-01T00:00:00Z',
  expires_at: '2026-01-04T00:00:00Z',
  revocation: { revoked_at: '2026-01-03T00:00:00Z' },
  gates: ['scope'],
  scope: { spec_id: 'S' },
} as Waiver;
function use(ts: string, seq = 1, gate = 'scope', spec = 'S'): ChainedEvent {
  return {
    event: 'gate_evaluated',
    seq,
    ts,
    spec_id: spec,
    data: { gate_id: gate, waiver_ids: ['W'] },
    event_hash: 'sha256:test',
  } as unknown as ChainedEvent;
}
test('every occurrence keeps its temporal classification, including exact boundaries', () => {
  const result = historicalWaiverUses(
    [
      use('2025-12-31T23:59:59Z'),
      use(waiver.created_at, 2),
      use(waiver.revocation!.revoked_at, 3),
      use(waiver.expires_at, 4),
    ],
    [waiver]
  );
  expect(result.map((r) => r.classification)).toEqual([
    'before_creation',
    'within_recorded_bounds',
    'post_revocation',
    'expired',
  ]);
  expect(result.map((r) => r.event_seq)).toEqual([1, 2, 3, 4]);
});
test('record bounds do not excuse a foreign spec, unrelated gate, or missing evidence', () => {
  const ts = '2026-01-02T00:00:00Z';
  expect(
    historicalWaiverUses([use(ts, 1, 'other'), use(ts, 2, 'scope', 'foreign')], [waiver]).map(
      (r) => r.classification
    )
  ).toEqual(['gate_not_covered', 'spec_not_covered']);
  expect(historicalWaiverUses([use(ts)], [])[0]!.classification).toBe('unknown');
  expect(
    historicalWaiverUses(
      [use(ts)],
      [
        Object.fromEntries(
          Object.entries(waiver).filter(([key]) => key !== 'revocation')
        ) as unknown as Waiver,
      ]
    )[0]!.classification
  ).toBe('unknown');
  expect(historicalWaiverUses([use('malformed')], [waiver])[0]!.classification).toBe('unknown');
});
test('recorded held obligations stay visible; passing evidence removes only its criterion', () => {
  const spec = {
    acceptance: [
      { id: 'A1', then: 'done' },
      { id: 'A2', then: 'deployment required' },
    ],
    evidence: [
      { criterion_id: 'A1', status: 'pass' },
      {
        criterion_id: 'A2',
        status: 'unchecked',
        evidence_ref: 'HELD awaiting deployment authority',
      },
    ],
  } as unknown as Spec;
  expect(unmetObligations(spec)).toEqual({
    unmet_acceptance: [
      {
        criterion_id: 'A2',
        then: 'deployment required',
        status: 'unchecked',
        evidence_ref: 'HELD awaiting deployment authority',
      },
    ],
  });
});

test('untrack releases its path and a later creation restores lifecycle accountability', () => {
  const create = {
    event: 'worktree_created',
    seq: 1,
    event_hash: 'first',
    data: { name: 'lane', path: '/lane' },
  } as unknown as ChainedEvent;
  const untrack = {
    event: 'worktree_untracked',
    seq: 2,
    data: { worktree_name: 'lane', path: '/lane' },
  } as unknown as ChainedEvent;
  expect([...worktreeHistory([create, untrack]).pending.keys()]).toEqual([]);
  expect([...worktreeHistory([create, untrack]).releasedPaths]).toEqual(['/lane']);
  const again: ChainedEvent = { ...create, seq: 3, event_hash: 'sha256:second' };
  expect([...worktreeHistory([create, untrack, again]).pending.values()]).toEqual([again]);
  expect([...worktreeHistory([create, untrack, again]).releasedPaths]).toEqual([]);
});
test('absence receipts match both creation sequence and hash; ghost pruning accounts for its lifecycle', () => {
  const create = {
    event: 'worktree_created',
    seq: 1,
    event_hash: 'first',
    data: { name: 'lane' },
  } as unknown as ChainedEvent;
  const receipt = (seq: number, hash: string) =>
    ({
      event: 'worktree_pruned',
      seq: 2,
      data: {
        worktree_name: 'lane',
        h_class: 'verified_dead_creation',
        created_event_seq: seq,
        created_event_hash: hash,
      },
    }) as unknown as ChainedEvent;
  expect(worktreeHistory([create, receipt(1, 'first')]).pending.size).toBe(0);
  expect(worktreeHistory([create, receipt(2, 'first')]).pending.size).toBe(1);
  expect(worktreeHistory([create, receipt(1, 'different')]).pending.size).toBe(1);
  expect(
    worktreeHistory([
      create,
      {
        event: 'worktree_pruned',
        data: { worktree_name: 'lane', h_class: 'ghost_registry' },
      } as unknown as ChainedEvent,
    ]).pending.size
  ).toBe(0);
});

test('valid historical uses are discharged while later invalid uses remain current findings', () => {
  const findings = inspectProjectState({
    now: new Date('2026-02-01'),
    specs: [],
    waivers: [waiver],
    events: [use('2026-01-02T00:00:00Z', 1), use('2026-01-03T00:00:00Z', 2)],
  }).findings.filter(
    (f) =>
      f.rule === 'doctor.waiver.historical_use' || f.rule === 'doctor.waiver.revoked_referenced'
  );
  expect(findings.map((f) => [f.severity, f.data?.event_seq, f.data?.classification])).toEqual([
    ['warning', 2, 'post_revocation'],
  ]);
});
