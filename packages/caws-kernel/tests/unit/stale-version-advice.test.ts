/**
 * CAWS-STALE-VERSION-ADVICE-DIAGNOSTICS-01 regression tests.
 *
 * Bug-003 from USER-E2E-SETUP-REHEARSAL-001: kernel-emitted
 * diagnostics were carrying a stale parenthetical
 *   '(v11.0.0 does not ship ...; pin to caws-cli@^10.2.x ...)'
 * left over from the v11.0 cutover. That advice would direct users
 * to downgrade away from a v11.1 cli that DOES ship the very
 * commands the diagnostic claimed were absent.
 *
 * Each sub-test asserts the stale regexes are absent and the
 * replacement text names a current canonical command.
 */

import {
  DOCTOR_RULES,
  inspectProjectState,
} from '../../src/doctor';
import type { DoctorInput } from '../../src/doctor';
import type { Spec } from '../../src/spec/types';
import { evaluatePath, SCOPE_RULES } from '../../src/scope';
import type { BindingState } from '../../src/scope';
import type { Policy } from '../../src/policy/types';
import {
  canTransitionSpecWithWorktree,
  WORKTREE_RULES,
} from '../../src/worktree';
import type { WorktreeRegistry } from '../../src/worktree';
import { isOk } from '../../src/result';

const STALE_PIN_REGEX = /pin to caws-cli@\^10\.2/;
const STALE_V11_0_REGEX = /v11\.0\.0 does not ship/;

const NOW = new Date('2026-05-26T14:00:00.000Z');

function makeSpec(overrides: Partial<Spec> = {}): Spec {
  return {
    id: 'TEST-001',
    title: 'Test spec',
    risk_tier: 3,
    mode: 'feature',
    lifecycle_state: 'active',
    blast_radius: { modules: ['src/test'] },
    scope: { in: ['src/**'] },
    invariants: ['none'],
    acceptance: [{ id: 'A1', given: 'g', when: 'w', then: 't' }],
    non_functional: {},
    contracts: [],
    ...overrides,
  };
}

function makePolicy(): Policy {
  return {
    version: 1,
    risk_tiers: {
      '1': { max_files: 5, max_loc: 200 },
      '2': { max_files: 15, max_loc: 600 },
      '3': { max_files: 30, max_loc: 1500 },
    },
    gates: {},
  };
}

function assertNoStaleAdvice(text: string, label: string): void {
  if (STALE_PIN_REGEX.test(text)) {
    throw new Error(
      `Stale advice regression at ${label}: text contains "pin to caws-cli@^10.2". Full text: ${text}`
    );
  }
  if (STALE_V11_0_REGEX.test(text)) {
    throw new Error(
      `Stale advice regression at ${label}: text contains "v11.0.0 does not ship". Full text: ${text}`
    );
  }
}

describe('CAWS-STALE-VERSION-ADVICE-DIAGNOSTICS-01 — kernel narrowRepair text', () => {
  describe('inspect.ts (3 sites)', () => {
    test('1. doctor.spec.unbound_active_stale narrowRepair has no stale advice + names current commands', () => {
      const spec = makeSpec({
        id: 'UNBOUND-001',
        updated_at: '2026-01-01T00:00:00.000Z', // very old; well past TTL
      });
      const input: DoctorInput = {
        specs: [spec],
        worktrees: {} as WorktreeRegistry,
        agents: {},
        events: [],
        templates: [],
        now: NOW,
        unboundActiveThresholdMs: 1000 * 60 * 60, // 1h
      };

      const report = inspectProjectState(input);
      const finding = report.findings.find(
        (f) => f.rule === DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_STALE
      );
      expect(finding).toBeDefined();
      expect(finding!.subject).toBe('UNBOUND-001');
      const repair = finding!.narrowRepair ?? '';
      assertNoStaleAdvice(repair, 'doctor.spec.unbound_active_stale');
      expect(repair).toMatch(/caws worktree (create|bind)/);
      expect(repair).toMatch(/caws specs close/);
    });

    test('2. doctor.worktree.spec_missing narrowRepair has no stale advice + names destroy', () => {
      const registry: WorktreeRegistry = {
        'wt-orphan': {
          specId: 'MISSING-SPEC',
          owner: { session_id: 's1', platform: 'darwin' },
          last_heartbeat: NOW.toISOString(),
          status: 'active',
          branch: 'feat/orphan',
          baseBranch: 'main',
          path: '/tmp/wt-orphan',
        },
      };
      const input: DoctorInput = {
        specs: [],
        worktrees: registry,
        agents: {},
        events: [],
        templates: [],
        now: NOW,
      };
      const report = inspectProjectState(input);
      const finding = report.findings.find(
        (f) => f.rule === DOCTOR_RULES.BINDING_REGISTRY_MISSING_SPEC
      );
      expect(finding).toBeDefined();
      const repair = finding!.narrowRepair ?? '';
      assertNoStaleAdvice(repair, 'doctor.worktree.spec_missing');
      expect(repair).toMatch(/caws worktree destroy wt-orphan/);
    });

    test('3. doctor.worktree.binding_to_terminal_spec narrowRepair has no stale advice + names destroy and bind', () => {
      const spec = makeSpec({
        id: 'CLOSED-001',
        lifecycle_state: 'closed',
        worktree: 'wt-closed',
      });
      const registry: WorktreeRegistry = {
        'wt-closed': {
          specId: 'CLOSED-001',
          owner: { session_id: 's1', platform: 'darwin' },
          last_heartbeat: NOW.toISOString(),
          status: 'active',
          branch: 'feat/closed',
          baseBranch: 'main',
          path: '/tmp/wt-closed',
        },
      };
      const input: DoctorInput = {
        specs: [spec],
        worktrees: registry,
        agents: {},
        events: [],
        templates: [],
        now: NOW,
      };
      const report = inspectProjectState(input);
      const finding = report.findings.find(
        (f) => f.rule === DOCTOR_RULES.BINDING_SPEC_NOT_GOVERNABLE
      );
      expect(finding).toBeDefined();
      const repair = finding!.narrowRepair ?? '';
      assertNoStaleAdvice(repair, 'doctor.worktree.binding_to_terminal_spec');
      expect(repair).toMatch(/caws worktree destroy wt-closed/);
      expect(repair).toMatch(/caws worktree bind wt-closed/);
    });
  });

  describe('transitions.ts (1 site)', () => {
    test('4. worktree.transition.blocked_by_active_binding narrowRepair has no stale advice + names merge|destroy', () => {
      const spec = makeSpec({
        id: 'TRANSIT-001',
        worktree: 'wt-active',
      });
      const registry: WorktreeRegistry = {
        'wt-active': {
          specId: 'TRANSIT-001',
          owner: { session_id: 's1', platform: 'darwin' },
          last_heartbeat: NOW.toISOString(),
          status: 'active',
          branch: 'feat/transit',
          baseBranch: 'main',
          path: '/tmp/wt-active',
        },
      };
      const result = canTransitionSpecWithWorktree(spec, registry, 'archive');
      expect(isOk(result)).toBe(false);
      if (isOk(result)) return;
      const diag = result.errors[0]!;
      expect(diag.rule).toBe(WORKTREE_RULES.TRANSITION_BLOCKED_BY_ACTIVE_BINDING);
      const repair = diag.narrowRepair ?? '';
      assertNoStaleAdvice(repair, 'worktree.transition.blocked_by_active_binding');
      expect(repair).toMatch(/caws worktree merge wt-active|caws worktree destroy wt-active/);
    });
  });

  describe('evaluate.ts (2 sites)', () => {
    test('5. scope.no_authority.unbound narrowRepair has no stale advice + names current commands', () => {
      const unbound: BindingState = { kind: 'unbound' };
      const decision = evaluatePath('src/foo.ts', unbound, makePolicy());
      expect(decision.kind).toBe('no_authority');
      if (decision.kind !== 'no_authority') return;
      expect(decision.rule).toBe(SCOPE_RULES.NO_AUTHORITY_UNBOUND);
      const repair = decision.narrowRepair ?? '';
      assertNoStaleAdvice(repair, 'scope.no_authority.unbound');
      // The new text names caws worktree bind AND caws worktree create.
      expect(repair).toMatch(/caws worktree bind/);
      expect(repair).toMatch(/caws worktree create/);
    });

    test('6. scope.no_authority.binding_one_sided narrowRepair has no stale advice + names caws worktree bind', () => {
      const oneSided: BindingState = {
        kind: 'one_sided',
        detail: {
          specHasWorktree: true,
          registryHasSpecId: false,
          specWorktree: 'wt-onesided',
        },
      };
      const decision = evaluatePath('src/foo.ts', oneSided, makePolicy());
      expect(decision.kind).toBe('no_authority');
      if (decision.kind !== 'no_authority') return;
      expect(decision.rule).toBe(SCOPE_RULES.NO_AUTHORITY_BINDING_ONE_SIDED);
      const repair = decision.narrowRepair ?? '';
      assertNoStaleAdvice(repair, 'scope.no_authority.binding_one_sided');
      expect(repair).toMatch(/caws worktree bind/);
    });
  });
});
