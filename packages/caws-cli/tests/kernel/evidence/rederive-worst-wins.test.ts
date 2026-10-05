/**
 * Worst-wins ranking among executed checks when a recorded command is present.
 * CAWS-EVIDENCE-VERIFY-WORST-WINS-MASKS-PROOF-01.
 *
 * A command is disclosed, never executed, so it does not rank beside the
 * checks that did run. These cases pin the other half of that rule: a check
 * that DID execute and disproved the claim still decides the verdict, however
 * many verified siblings or recorded commands accompany it, and a located but
 * unexecuted test keeps its not_rederived rank.
 */

import {
  classifyRederivation,
  planRederivation,
  type CheckOutcome,
  type CriterionVerdict,
} from '../../../src/kernel/evidence/rederive';
import type { AcceptanceCriterion, EvidenceRecord, Spec } from '../../../src/kernel/spec/types';

function ac(id: string): AcceptanceCriterion {
  return { id, given: 'g', when: 'w', then: 't' };
}

function ev(criterion_id: string, extra: Partial<EvidenceRecord>): EvidenceRecord {
  return { criterion_id, status: 'pass', recorded_at: '2026-10-04T12:00:00.000Z', ...extra };
}

function specWith(acceptance: AcceptanceCriterion[], evidence: EvidenceRecord[]): Spec {
  return {
    id: 'WW-1',
    title: 'worst-wins fixture',
    risk_tier: 3,
    mode: 'chore',
    lifecycle_state: 'active',
    blast_radius: { modules: ['x'], data_migration: false },
    operational_rollback_slo: '5m',
    scope: { in: ['x'], out: [] },
    invariants: ['i'],
    acceptance,
    non_functional: {},
    contracts: [],
    evidence,
  } as unknown as Spec;
}

function classifyOne(spec: Spec, outcomes: CheckOutcome[]): CriterionVerdict {
  const [verdict] = classifyRederivation(spec, planRederivation(spec), {
    outcomes: { A1: outcomes },
  });
  if (verdict === undefined) throw new Error('expected one criterion verdict');
  return verdict;
}

describe('a recorded command never dilutes a check that executed and failed', () => {
  test('verified commit + failing test + recorded command -> refuted / test_failed', () => {
    const spec = specWith(
      [ac('A1')],
      [ev('A1', { commit_sha: 'abc', test_nodeid: 't.test.js::red', command: 'npm test' })]
    );
    const v = classifyOne(spec, [
      { class: 'citation', target: 'abc', outcome: 'passed' },
      { class: 'test', target: 't.test.js::red', outcome: 'failed' },
    ]);
    expect(v.verdict).toBe('refuted');
    expect(v.reason).toBe('test_failed');
    expect(v.checks.map((c) => [c.class, c.verdict, c.reason])).toEqual([
      ['citation', 'verified', 'passed'],
      ['test', 'refuted', 'test_failed'],
      ['command', 'not_rederived', 'command_not_executed'],
    ]);
  });

  test('verified commit + located-but-unexecuted test + recorded command stays not_rederived / not_run', () => {
    const spec = specWith(
      [ac('A1')],
      [ev('A1', { commit_sha: 'abc', test_nodeid: 't.test.js::green', command: 'npm test' })]
    );
    const v = classifyOne(spec, [
      { class: 'citation', target: 'abc', outcome: 'passed' },
      { class: 'test', target: 't.test.js::green', outcome: 'not_run' },
    ]);
    expect(v.verdict).toBe('not_rederived');
    expect(v.reason).toBe('not_run');
  });

  test('a failing test refutes whether or not a verified commit accompanies it', () => {
    const withCommit = specWith(
      [ac('A1')],
      [ev('A1', { commit_sha: 'abc', test_nodeid: 't.test.js::red' })]
    );
    const alone = specWith([ac('A1')], [ev('A1', { test_nodeid: 't.test.js::red' })]);
    const failed: CheckOutcome = { class: 'test', target: 't.test.js::red', outcome: 'failed' };
    const passedCommit: CheckOutcome = { class: 'citation', target: 'abc', outcome: 'passed' };

    expect(classifyOne(withCommit, [passedCommit, failed]).verdict).toBe('refuted');
    expect(classifyOne(alone, [failed]).verdict).toBe('refuted');
  });
});
