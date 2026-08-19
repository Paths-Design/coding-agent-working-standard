/**
 * CAWS-SPEC-ACTIVATION-BINDS-001 — the unbound-active backlog aggregate.
 *
 * Before this slice, every stale active+unbound spec produced its own
 * `warning`. A repo that drifted to 27 of them produced 27 warnings, which
 * buried every other doctor finding — and that burial is part of why the
 * condition went unnoticed long enough to reach 27 in the first place.
 *
 * The behavior pinned here:
 *   - the per-spec finding survives at INFO (the repair plan keys on its
 *     `subject` for a per-spec next_command),
 *   - exactly ONE aggregate finding carries the severity,
 *   - the aggregate escalates warning → error at the configured count,
 *   - the aggregate's `data.spec_ids` is COMPLETE even when the human message
 *     truncates, so no consumer has to re-derive the list,
 *   - a bound active spec is not counted, and a fresh one is not counted.
 */

import { inspectProjectState } from '../../../src/kernel/doctor/inspect';
import { DOCTOR_RULES } from '../../../src/kernel/doctor/rules';
import type { DoctorInput } from '../../../src/kernel/doctor/types';
import type { Spec } from '../../../src/kernel/spec/types';

const NOW = new Date('2026-06-15T12:00:00.000Z');
/** Two hours before NOW — past the 1h default unbound-active threshold. */
const STALE = '2026-06-15T10:00:00.000Z';
/** One minute before NOW — inside the threshold. */
const FRESH = '2026-06-15T11:59:00.000Z';

function spec(id: string, opts: Partial<Spec> = {}): Spec {
  return {
    id,
    lifecycle_state: 'active',
    updated_at: STALE,
    ...opts,
  } as unknown as Spec;
}

function report(input: Partial<DoctorInput> & { specs: Spec[] }) {
  return inspectProjectState({
    now: NOW,
    worktrees: {},
    ...input,
  } as DoctorInput);
}

function findings(r: ReturnType<typeof inspectProjectState>, rule: string) {
  return r.findings.filter((f) => f.rule === rule);
}

describe('doctor unbound-active backlog aggregate', () => {
  test('three stale unbound specs produce three info findings and exactly one warning aggregate', () => {
    const r = report({ specs: [spec('A-1'), spec('B-2'), spec('C-3')] });

    const perSpec = findings(r, DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_STALE);
    expect(perSpec).toHaveLength(3);
    expect(perSpec.every((f) => f.severity === 'info')).toBe(true);
    expect(perSpec.map((f) => f.subject)).toEqual(['A-1', 'B-2', 'C-3']);

    const aggregate = findings(r, DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_BACKLOG);
    expect(aggregate).toHaveLength(1);
    expect(aggregate[0]?.severity).toBe('warning');
    expect(aggregate[0]?.message).toContain('3 active spec(s)');
    expect(aggregate[0]?.data?.spec_count).toBe(3);
    expect(aggregate[0]?.data?.spec_ids).toEqual(['A-1', 'B-2', 'C-3']);
  });

  test('the aggregate escalates to error at the configured count and says why', () => {
    const specs = Array.from({ length: 10 }, (_, i) => spec(`SPEC-${i}`));

    const aggregate = findings(
      report({ specs }),
      DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_BACKLOG
    );

    expect(aggregate).toHaveLength(1);
    expect(aggregate[0]?.severity).toBe('error');
    expect(aggregate[0]?.message).toContain(
      '"active" no longer distinguishes work in progress from a backlog'
    );
    expect(aggregate[0]?.data?.error_count_threshold).toBe(10);
  });

  test('nine is still a warning — the escalation boundary is at, not below, the count', () => {
    const specs = Array.from({ length: 9 }, (_, i) => spec(`SPEC-${i}`));

    const aggregate = findings(
      report({ specs }),
      DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_BACKLOG
    );

    expect(aggregate[0]?.severity).toBe('warning');
  });

  test('the caller can lower the escalation count', () => {
    const aggregate = findings(
      report({ specs: [spec('A-1'), spec('B-2')], unboundActiveErrorCount: 2 } as never),
      DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_BACKLOG
    );

    expect(aggregate[0]?.severity).toBe('error');
  });

  test('the truncated message never truncates data.spec_ids', () => {
    const specs = Array.from({ length: 12 }, (_, i) =>
      spec(`SPEC-${String(i).padStart(2, '0')}`)
    );

    const aggregate = findings(
      report({ specs }),
      DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_BACKLOG
    )[0];

    expect(aggregate?.message).toContain('+7 more');
    expect(aggregate?.message).toContain('full list in data.spec_ids');
    expect(aggregate?.data?.spec_ids).toHaveLength(12);
    // The last id is absent from the prose but present in the data — that gap
    // is exactly what makes the truncation safe to render.
    expect(aggregate?.message).not.toContain('SPEC-11');
    expect(aggregate?.data?.spec_ids).toContain('SPEC-11');
  });

  test('bound and fresh active specs are not in the backlog', () => {
    const r = report({
      specs: [
        spec('BOUND-1', { worktree: 'wt-1' } as Partial<Spec>),
        spec('REGISTRY-BOUND-2'),
        spec('FRESH-3', { updated_at: FRESH } as Partial<Spec>),
        spec('STALE-4'),
      ],
      worktrees: { 'wt-2': { specId: 'REGISTRY-BOUND-2' } },
    } as never);

    const aggregate = findings(r, DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_BACKLOG)[0];
    expect(aggregate?.data?.spec_ids).toEqual(['STALE-4']);
  });

  test('no stale unbound specs means no aggregate finding at all', () => {
    const r = report({ specs: [spec('FRESH-1', { updated_at: FRESH } as Partial<Spec>)] });

    expect(findings(r, DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_BACKLOG)).toHaveLength(0);
    expect(findings(r, DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_STALE)).toHaveLength(0);
  });

  test('the aggregate repair names deactivate, not only close', () => {
    const aggregate = findings(
      report({ specs: [spec('A-1')] }),
      DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_BACKLOG
    )[0];

    // Closing writes a resolution and asserts the work concluded, which is the
    // wrong exit for a spec whose slice never started. The repair must offer
    // the demotion path or operators will close specs they have not done.
    expect(aggregate?.narrowRepair).toContain('caws specs deactivate');
    expect(aggregate?.narrowRepair).toContain('caws worktree create');
  });
});
