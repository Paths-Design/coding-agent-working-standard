/**
 * WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-002 — authority-policy lock test (A7).
 *
 * This is the Decide slice's regression guard. The §1.4 half-state authority
 * decision matrix marks H5, H6, and the event-backed orphan as
 * FORBIDDEN/ambiguous — repair is doctrinally refused, so their doctor
 * diagnostics MUST carry a non-actionable doctrine pointer, never an executable
 * repair command. This test locks that: a future change cannot silently make an
 * ambiguous/forbidden class look auto-repairable by slipping a `caws`/`git`
 * command into its repair field.
 *
 * It is DECIDE-ONLY coverage: it asserts the SHAPE of the repair text the
 * shipped doctor already emits; it does not change detection logic. (Detection
 * itself is regression-tested by doctor-half-state.test.ts.)
 */

import { inspectProjectState } from '../../src/doctor/inspect';
import { DOCTOR_RULES } from '../../src/doctor/rules';
import { computeEventHash } from '../../src/evidence/hash';
import type { DoctorInput } from '../../src/doctor/types';
import type { Spec } from '../../src/spec/types';
import type { Actor, ChainedEvent, Hash } from '../../src/evidence/types';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const ACTOR: Actor = { kind: 'agent', id: 'a', session_id: 's' };

function spec(id: string, opts: Partial<Spec> = {}): Spec {
  return { id, lifecycle_state: 'active', ...opts } as unknown as Spec;
}

function findingFor(report: ReturnType<typeof inspectProjectState>, rule: string) {
  return report.findings.find((f) => f.rule === rule);
}

function chain(bodies: Array<{ event: string; spec_id?: string; data?: unknown }>): ChainedEvent[] {
  const events: ChainedEvent[] = [];
  let prev: Hash | null = null;
  bodies.forEach((b, i) => {
    const body = {
      seq: i + 1,
      event: b.event,
      ts: `2026-06-15T00:00:0${i}.000Z`,
      actor: ACTOR,
      ...(b.spec_id ? { spec_id: b.spec_id } : {}),
      data: b.data ?? {},
      prev_hash: prev,
    };
    const event_hash = computeEventHash(body as unknown as ChainedEvent);
    events.push({ ...body, event_hash } as unknown as ChainedEvent);
    prev = event_hash;
  });
  return events;
}

/**
 * A repair field is "non-actionable" iff it contains no copy-pasteable shell
 * command. We forbid an invokable `caws <subcommand>` or `git <subcommand>` —
 * a bare mention of the words is fine in prose, but `caws worktree destroy ...`
 * or `git ...` as an instruction is not, for a class doctrine forbids repairing.
 */
function hasExecutableCommand(text: string | undefined): boolean {
  const t = text ?? '';
  return /\bcaws\s+[a-z]/.test(t) || /\bgit\s+[a-z]/.test(t);
}

describe('authority policy lock: forbidden/ambiguous classes carry NO repair command (A3/A7)', () => {
  test('H5 (3-way contradiction) repair is a doctrine pointer, not a command', () => {
    const input: DoctorInput = {
      now: NOW,
      specs: [
        spec('S-A', { worktree: 'wt-x' } as Partial<Spec>),
        spec('S-B', {} as Partial<Spec>),
      ],
      worktrees: { 'wt-x': { specId: 'S-B' } },
    };
    const f = findingFor(
      inspectProjectState(input),
      DOCTOR_RULES.WORKTREE_BINDING_CONTRADICTION_3WAY
    );
    expect(f).toBeDefined();
    // The matrix marks H5 FORBIDDEN — no winner, no command.
    expect(hasExecutableCommand(f?.narrowRepair)).toBe(false);
  });

  test('event-backed orphan (governance-half-state) repair is a doctrine pointer, not a command', () => {
    const events = chain([
      { event: 'spec_created', spec_id: 'WT-SPEC' },
      { event: 'worktree_created', spec_id: 'WT-SPEC', data: { name: 'wt-orphan' } },
    ]);
    const input: DoctorInput = {
      now: NOW,
      specs: [spec('WT-SPEC', {} as Partial<Spec>)],
      worktrees: {},
      events,
    };
    const f = findingFor(
      inspectProjectState(input),
      DOCTOR_RULES.WORKTREE_EVENT_WITHOUT_CONTROL_PLANE_BINDING
    );
    expect(f).toBeDefined();
    // The matrix marks the orphan FORBIDDEN-as-deletion — the event is immutable
    // history; "repair" is reconciliation, never a delete command.
    expect(hasExecutableCommand(f?.narrowRepair)).toBe(false);
  });

  test('the lock recognizes an executable command (the check is not vacuous)', () => {
    // Sanity: hasExecutableCommand must actually fire on a real command, or the
    // two assertions above would pass trivially. This pins the detector.
    expect(hasExecutableCommand('Run `caws worktree destroy wt-x` to fix.')).toBe(true);
    expect(hasExecutableCommand('git worktree prune')).toBe(true);
    expect(
      hasExecutableCommand(
        'Ambiguous authority split; no automatic repair under current doctrine. See WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-002.'
      )
    ).toBe(false);
  });
});
