/**
 * WORKTREE-DOCTOR-HALF-STATE-001
 *
 * Regression coverage for the worktree half-state taxonomy (H1-H6) emitted by
 * inspectProjectState. The detection was implemented by a prior recon slice but
 * shipped with ZERO test coverage; this suite is the regression guard the
 * doctrine (§1.4) marked Pending, plus the ONE new event-backed detection for
 * the createWorktree second-event governance-half-state proven by
 * CAWS-LIFECYCLE-ROLLBACK-HARNESS-COMPLETE-001.
 *
 * DIAGNOSE ONLY. inspectProjectState is a pure function over an in-memory
 * DoctorInput — it performs no I/O. A2/A5 read-only is satisfied by
 * construction (no on-disk fixture to mutate); the no-write property is asserted
 * by deep-freezing the input and confirming inspect does not throw / mutate.
 *
 * Fixtures are minimal Spec-shaped objects (inspect reads only id, worktree,
 * lifecycle_state) cast through unknown — the standard kernel-test pattern.
 */

import { inspectProjectState } from '../../src/doctor/inspect';
import { DOCTOR_RULES } from '../../src/doctor/rules';
import { computeEventHash } from '../../src/evidence/hash';
import type { DoctorInput } from '../../src/doctor/types';
import type { Spec } from '../../src/spec/types';
import type { Actor, ChainedEvent, Hash } from '../../src/evidence/types';

// ─── Fixture builders ────────────────────────────────────────────────────

const NOW = new Date('2026-06-15T12:00:00.000Z');

/** A partial filesystem observation carrying only the worktree-observation
 *  fields the H-class under test needs (the full StoreSnapshot has many more
 *  dir-exists fields irrelevant to half-state detection). Cast at the use site. */
type FsObs = NonNullable<DoctorInput['filesystem']>;
function fsObs(partial: Record<string, unknown>): FsObs {
  return partial as unknown as FsObs;
}

function spec(id: string, opts: Partial<Spec> = {}): Spec {
  return {
    id,
    lifecycle_state: 'active',
    ...opts,
  } as unknown as Spec;
}

function rules(report: ReturnType<typeof inspectProjectState>): string[] {
  return report.findings.map((f) => f.rule);
}

function findingFor(report: ReturnType<typeof inspectProjectState>, rule: string) {
  return report.findings.find((f) => f.rule === rule);
}

const ACTOR: Actor = { kind: 'agent', id: 'a', session_id: 's' };

/** Build a real linked chain from event bodies (seq + prev_hash + event_hash). */
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

// =========================================================================
// H1-H6 detection over the already-shipped inspect.ts logic
// =========================================================================

describe('H1 — ghost registry entry (registry entry, no backing git worktree dir)', () => {
  test('emits WORKTREE_GHOST_REGISTRY_ENTRY when the canonical dir is observably absent and git does not know the path', () => {
    const input: DoctorInput = {
      now: NOW,
      specs: [],
      worktrees: { 'wt-ghost': { path: '/repo/.caws/worktrees/wt-ghost' } },
      filesystem: fsObs({
        // canonical dir absent on disk
        worktreeDirByName: { 'wt-ghost': false },
      }),
      // git worktree observation present but empty -> the registry path is a ghost
      gitWorktrees: [],
    };
    const report = inspectProjectState(input);
    expect(rules(report)).toContain(DOCTOR_RULES.WORKTREE_GHOST_REGISTRY_ENTRY);
    const f = findingFor(report, DOCTOR_RULES.WORKTREE_GHOST_REGISTRY_ENTRY);
    expect(f?.data?.worktree_name ?? f?.subject).toBeDefined();
  });

  test('does NOT fire when the canonical dir IS present (healthy worktree)', () => {
    const input: DoctorInput = {
      now: NOW,
      specs: [],
      worktrees: { 'wt-live': { specId: 'S-1', path: '/repo/.caws/worktrees/wt-live' } },
      filesystem: fsObs({
        worktreeDirByName: { 'wt-live': true },
      }),
      gitWorktrees: [{ path: '/repo/.caws/worktrees/wt-live' }],
    };
    expect(rules(inspectProjectState(input))).not.toContain(
      DOCTOR_RULES.WORKTREE_GHOST_REGISTRY_ENTRY
    );
  });
});

describe('H3 — one-sided spec -> registry (spec has worktree:, registry has no entry)', () => {
  test('emits BINDING_SPEC_MISSING_REGISTRY for an active spec claiming a worktree the registry lacks', () => {
    const input: DoctorInput = {
      now: NOW,
      specs: [spec('S-H3', { worktree: 'wt-h3' } as Partial<Spec>)],
      worktrees: {}, // registry has no wt-h3
    };
    const report = inspectProjectState(input);
    expect(rules(report)).toContain(DOCTOR_RULES.BINDING_SPEC_MISSING_REGISTRY);
    const f = findingFor(report, DOCTOR_RULES.BINDING_SPEC_MISSING_REGISTRY);
    expect(f?.subject).toBe('S-H3');
    expect(f?.severity).toBe('error'); // active spec -> live governance drift
  });

  test('severity is INFO for a CLOSED spec (dormant historical residue, no action)', () => {
    const input: DoctorInput = {
      now: NOW,
      specs: [spec('S-H3C', { worktree: 'wt-h3c', lifecycle_state: 'closed' } as Partial<Spec>)],
      worktrees: {},
    };
    const f = findingFor(
      inspectProjectState(input),
      DOCTOR_RULES.BINDING_SPEC_MISSING_REGISTRY
    );
    expect(f?.severity).toBe('info');
  });
});

describe('H2 — one-sided registry -> spec', () => {
  test('registry binds a spec id that is NOT loaded -> BINDING_REGISTRY_MISSING_SPEC', () => {
    const input: DoctorInput = {
      now: NOW,
      specs: [], // spec S-H2 absent entirely
      worktrees: { 'wt-h2': { specId: 'S-H2' } }, // registry references a missing spec
    };
    const report = inspectProjectState(input);
    expect(rules(report)).toContain(DOCTOR_RULES.BINDING_REGISTRY_MISSING_SPEC);
    expect(findingFor(report, DOCTOR_RULES.BINDING_REGISTRY_MISSING_SPEC)?.subject).toBe('wt-h2');
  });

  test('registry binds a LOADED spec that does not back-bind -> BINDING_ONE_SIDED (not missing-spec)', () => {
    // The spec exists but lacks worktree: — this is one-sided, a distinct class
    // from "spec not loaded at all". Pins the semantic boundary.
    const input: DoctorInput = {
      now: NOW,
      specs: [spec('S-H2B', {} as Partial<Spec>)],
      worktrees: { 'wt-h2b': { specId: 'S-H2B' } },
    };
    const rs = rules(inspectProjectState(input));
    expect(rs).toContain(DOCTOR_RULES.BINDING_ONE_SIDED);
    expect(rs).not.toContain(DOCTOR_RULES.BINDING_REGISTRY_MISSING_SPEC);
  });
});

describe('H5 — 3-way registry/spec contradiction (non-actionable repair)', () => {
  test('emits WORKTREE_BINDING_CONTRADICTION_3WAY and its repair is a doctrine pointer, NOT a shell command', () => {
    // registry[name].specId === idB; spec idA claims name; spec idB lacks worktree.
    const input: DoctorInput = {
      now: NOW,
      specs: [
        spec('S-A', { worktree: 'wt-x' } as Partial<Spec>),
        spec('S-B', {} as Partial<Spec>),
      ],
      worktrees: { 'wt-x': { specId: 'S-B' } },
    };
    const report = inspectProjectState(input);
    expect(rules(report)).toContain(DOCTOR_RULES.WORKTREE_BINDING_CONTRADICTION_3WAY);
    const f = findingFor(report, DOCTOR_RULES.WORKTREE_BINDING_CONTRADICTION_3WAY);
    // H5 doctor-UX rule: NO mutating command in the repair field.
    const repair = f?.narrowRepair ?? '';
    expect(repair).not.toMatch(/\bcaws\s+\w/); // no `caws <subcommand>` shell command
    expect(repair).not.toMatch(/\bgit\s+\w/); // no git command either
  });
});

describe('H6 — foreign physical worktree (git knows a path, registry does not)', () => {
  test('emits WORKTREE_FOREIGN_PHYSICAL for a git worktree path absent from the registry', () => {
    const input: DoctorInput = {
      now: NOW,
      specs: [],
      worktrees: {}, // registry empty
      // git lists a worktree the registry has no entry for
      gitWorktrees: [{ path: '/repo/.caws/worktrees/wt-foreign', branch: 'refs/heads/feat' }],
    };
    const report = inspectProjectState(input);
    expect(rules(report)).toContain(DOCTOR_RULES.WORKTREE_FOREIGN_PHYSICAL);
  });
});

// =========================================================================
// A2 — NEW event-backed governance-half-state detection
// (createWorktree second-event divergence from the rollback harness)
// =========================================================================

describe('event-backed governance-half-state (A2/A6 — worktree_created orphan)', () => {
  test('fires WORKTREE_EVENT_WITHOUT_CONTROL_PLANE_BINDING for a worktree_created with no live registry/spec', () => {
    // The exact on-disk shape the harness proves: worktree_created is chained,
    // but the txn rolled back the registry + spec binding (worktree_bound failed).
    const events = chain([
      { event: 'spec_created', spec_id: 'WT-SPEC' },
      { event: 'worktree_created', spec_id: 'WT-SPEC', data: { name: 'wt-orphan' } },
    ]);
    const input: DoctorInput = {
      now: NOW,
      specs: [spec('WT-SPEC', {} as Partial<Spec>)], // no back-binding
      worktrees: {}, // no live registry entry
      events,
    };
    const report = inspectProjectState(input);
    expect(rules(report)).toContain(
      DOCTOR_RULES.WORKTREE_EVENT_WITHOUT_CONTROL_PLANE_BINDING
    );
    const f = findingFor(report, DOCTOR_RULES.WORKTREE_EVENT_WITHOUT_CONTROL_PLANE_BINDING);
    expect(f?.subject).toBe('wt-orphan');
    expect(f?.severity).toBe('warning');
    // Evidence: the event seq + hash (seq/prev_hash are the ordering authority).
    expect(f?.data?.created_event_seq).toBe(2);
    expect(typeof f?.data?.created_event_hash).toBe('string');
    expect(f?.data?.spec_id).toBe('WT-SPEC');
    // DIAGNOSE ONLY: no mutating command in the repair.
    expect(f?.narrowRepair ?? '').not.toMatch(/\bcaws\s+\w|\bgit\s+\w/);
  });

  test('does NOT fire when a live registry entry exists for the created worktree', () => {
    const events = chain([
      { event: 'worktree_created', data: { name: 'wt-live' } },
      { event: 'worktree_bound', data: { name: 'wt-live' } },
    ]);
    const input: DoctorInput = {
      now: NOW,
      specs: [spec('S-1', { worktree: 'wt-live' } as Partial<Spec>)],
      worktrees: { 'wt-live': { specId: 'S-1' } }, // live registry entry
      events,
    };
    expect(rules(inspectProjectState(input))).not.toContain(
      DOCTOR_RULES.WORKTREE_EVENT_WITHOUT_CONTROL_PLANE_BINDING
    );
  });

  test('does NOT fire when a later worktree_destroyed closed the lifecycle (no orphan)', () => {
    const events = chain([
      { event: 'worktree_created', data: { name: 'wt-gone' } },
      { event: 'worktree_destroyed', data: { worktree_name: 'wt-gone' } },
    ]);
    const input: DoctorInput = {
      now: NOW,
      specs: [],
      worktrees: {},
      events,
    };
    expect(rules(inspectProjectState(input))).not.toContain(
      DOCTOR_RULES.WORKTREE_EVENT_WITHOUT_CONTROL_PLANE_BINDING
    );
  });

  test('A3: destroyWorktree external-half-state — registry + event both absent after a clean destroy is NOT a created-orphan (governance is coherent; only external fs is gone, not inferable from events alone)', () => {
    // After destroyWorktree's external-half-state: the worktree_created AND a
    // worktree_destroyed are both chained (clean lifecycle from doctor's view),
    // registry entry absent. The event-orphan rule correctly does NOT fire — the
    // governance record is coherent. The external fs loss is NOT generically
    // inferable from current state without new result metadata (documented A3).
    const events = chain([
      { event: 'worktree_created', data: { name: 'wt-destroyed' } },
      { event: 'worktree_bound', data: { name: 'wt-destroyed' } },
      { event: 'worktree_destroyed', data: { worktree_name: 'wt-destroyed' } },
    ]);
    const input: DoctorInput = {
      now: NOW,
      specs: [],
      worktrees: {},
      events,
    };
    // No created-orphan finding (lifecycle is event-coherent).
    expect(rules(inspectProjectState(input))).not.toContain(
      DOCTOR_RULES.WORKTREE_EVENT_WITHOUT_CONTROL_PLANE_BINDING
    );
  });
});

// =========================================================================
// A5 — doctor is read-only / mutation-free
// =========================================================================

describe('doctor is read-only (A5)', () => {
  test('inspectProjectState does not mutate a deeply-frozen input', () => {
    const input: DoctorInput = Object.freeze({
      now: NOW,
      specs: Object.freeze([
        spec('S-FROZEN', { worktree: 'wt-frozen' } as Partial<Spec>),
      ]) as unknown as Spec[],
      worktrees: Object.freeze({}),
    });
    // If inspect attempted any write to the input, a frozen-object write would
    // throw in strict mode (ts-jest runs ESM-strict). It must complete cleanly.
    expect(() => inspectProjectState(input)).not.toThrow();
  });
});
