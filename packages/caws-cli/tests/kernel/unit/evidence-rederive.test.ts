/**
 * Acceptance-evidence re-derivation classifier. CAWS-SPECS-VERIFY-ACS-REDERIVE-001.
 *
 * Pins the three-verdict discipline against the pure kernel module. The one
 * property that carries the most weight, and is asserted first: a check that
 * was FOUND but NOT RUN is `not_rederived`, never `verified`. v10.2's
 * `verify-acs` mapped collection onto PASS; every test here that touches
 * `not_run` exists to keep that bug dead.
 *
 * Assertions are on the specific reason string, not merely the verdict — a
 * mutation that collapses two reasons is killed.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  classifyRederivation,
  planRederivation,
  summarizeRederivation,
  type CheckOutcome,
  type RederivationReport,
} from '../../../src/kernel/evidence/rederive';
import { parseAndValidateSpec } from '../../../src/kernel/spec';
import { isOk } from '../../../src/kernel/result/construct';
import type { AcceptanceCriterion, EvidenceRecord, Spec } from '../../../src/kernel/spec/types';

// ─── fixtures ────────────────────────────────────────────────────────────────

function ac(id: string, extra: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion {
  return { id, given: 'g', when: 'w', then: 't', ...extra };
}

function ev(criterion_id: string, extra: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return { criterion_id, status: 'pass', recorded_at: '2026-09-16T12:00:00.000Z', ...extra };
}

function specWith(acceptance: AcceptanceCriterion[], evidence?: EvidenceRecord[]): Spec {
  return {
    id: 'RD-1',
    title: 'rederive fixture',
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
    ...(evidence !== undefined ? { evidence } : {}),
  } as unknown as Spec;
}

function report(outcomes: Record<string, CheckOutcome[]>): RederivationReport {
  return { outcomes };
}

function run(spec: Spec, rep: RederivationReport | undefined) {
  const plan = planRederivation(spec);
  return classifyRederivation(spec, plan, rep);
}

// ─── the ancestral bug (A1) ──────────────────────────────────────────────────

describe('a found-but-unrun check is never verified (A1)', () => {
  test('outcome not_run -> not_rederived / not_run, never verified', () => {
    const spec = specWith([ac('A1')], [ev('A1', { test_nodeid: 'tests/t.py::test_x' })]);
    const [v] = run(
      spec,
      report({ A1: [{ class: 'test', target: 'tests/t.py::test_x', outcome: 'not_run' }] })
    );
    expect(v.verdict).toBe('not_rederived');
    expect(v.reason).toBe('not_run');
    expect(v.verdict).not.toBe('verified');
  });

  test('outcome failed -> refuted / test_failed', () => {
    const spec = specWith([ac('A1')], [ev('A1', { test_nodeid: 'tests/t.py::test_x' })]);
    const [v] = run(
      spec,
      report({
        A1: [
          {
            class: 'test',
            target: 'tests/t.py::test_x',
            outcome: 'failed',
            detail: 'assert 1 == 2',
          },
        ],
      })
    );
    expect(v.verdict).toBe('refuted');
    expect(v.reason).toBe('test_failed');
    expect(v.checks[0].detail).toBe('assert 1 == 2');
  });

  test('only outcome passed yields verified', () => {
    const spec = specWith([ac('A1')], [ev('A1', { test_nodeid: 'tests/t.py::test_x' })]);
    const [v] = run(
      spec,
      report({ A1: [{ class: 'test', target: 'tests/t.py::test_x', outcome: 'passed' }] })
    );
    expect(v.verdict).toBe('verified');
    expect(v.reason).toBe('passed');
  });
});

// ─── no verdict collapse (A2) ────────────────────────────────────────────────

describe('three verdicts stay three (A2)', () => {
  test('one verified, one refuted, one not_rederived summarize as 1/1/1', () => {
    const spec = specWith(
      [ac('A1'), ac('A2'), ac('A3')],
      [
        ev('A1', { commit_sha: 'abc1234' }),
        ev('A2', { artifact_path: 'docs/x.md' }),
        ev('A3', { test_nodeid: 'tests/t.py::test_x' }),
      ]
    );
    const verdicts = run(
      spec,
      report({
        A1: [{ class: 'citation', target: 'abc1234', outcome: 'passed' }],
        A2: [{ class: 'artifact', target: 'docs/x.md', outcome: 'missing' }],
        A3: [{ class: 'test', target: 'tests/t.py::test_x', outcome: 'not_run' }],
      })
    );
    const s = summarizeRederivation(verdicts);
    expect(s).toEqual({
      total: 3,
      verified: 1,
      refuted: 1,
      not_rederived: 1,
      narrative_only: 0,
      self_reported: 3,
      command_declared: 0,
    });
  });
});

// ─── fabrication classes are distinguishable (A3, kernel half) ───────────────

describe('each fabrication class refutes with its own reason (A3)', () => {
  const cases: Array<[string, Partial<EvidenceRecord>, CheckOutcome, string]> = [
    [
      'citation missing',
      { commit_sha: 'dead' },
      { class: 'citation', target: 'dead', outcome: 'missing' },
      'object_missing',
    ],
    [
      'citation unreachable',
      { commit_sha: 'dead' },
      { class: 'citation', target: 'dead', outcome: 'unreachable' },
      'object_unreachable',
    ],
    [
      'artifact missing',
      { artifact_path: 'no/such' },
      { class: 'artifact', target: 'no/such', outcome: 'missing' },
      'artifact_missing',
    ],
    [
      'test not found',
      { test_nodeid: 't::x' },
      { class: 'test', target: 't::x', outcome: 'missing' },
      'test_not_found',
    ],
    [
      'test refused',
      { test_nodeid: '--collect-only' },
      { class: 'test', target: '--collect-only', outcome: 'refused' },
      'target_refused',
    ],
  ];
  test.each(cases)('%s -> refuted / %s', (_label, fields, outcome, reason) => {
    const spec = specWith([ac('A1')], [ev('A1', fields)]);
    const [v] = run(spec, report({ A1: [outcome] }));
    expect(v.verdict).toBe('refuted');
    expect(v.reason).toBe(reason);
  });

  test('the five refuting reasons are pairwise distinct', () => {
    const reasons = new Set(cases.map((c) => c[3]));
    expect(reasons.size).toBe(cases.length);
  });
});

// ─── command is never executed ───────────────────────────────────────────────

describe('command checks are planned non-executable and never trusted', () => {
  test('plan marks evidence command and acceptance test_command executable: false', () => {
    const spec = specWith(
      [ac('A1', { test_command: 'make check' })],
      [ev('A1', { command: 'touch /tmp/probe' })]
    );
    const plan = planRederivation(spec);
    const cmds = plan.criteria[0].checks.filter((c) => c.class === 'command');
    expect(cmds).toHaveLength(2);
    for (const c of cmds) expect(c.executable).toBe(false);
    expect(cmds.map((c) => c.source).sort()).toEqual(['acceptance', 'evidence']);
  });

  test('a store that wrongly reports passed for a command is ignored: command_not_executed', () => {
    const spec = specWith([ac('A1')], [ev('A1', { command: 'touch /tmp/probe' })]);
    const [v] = run(
      spec,
      report({ A1: [{ class: 'command', target: 'touch /tmp/probe', outcome: 'passed' }] })
    );
    expect(v.verdict).toBe('not_rederived');
    expect(v.reason).toBe('command_not_executed');
    expect(summarizeRederivation([v]).command_declared).toBe(1);
  });

  test('a passing citation beside a command still yields not_rederived, not verified', () => {
    const spec = specWith([ac('A1')], [ev('A1', { commit_sha: 'abc', command: 'x' })]);
    const [v] = run(
      spec,
      report({ A1: [{ class: 'citation', target: 'abc', outcome: 'passed' }] })
    );
    expect(v.verdict).toBe('not_rederived');
    expect(v.reason).toBe('command_not_executed');
  });
});

// ─── the undefined report arm ────────────────────────────────────────────────

describe('an unavailable report never reads as clean', () => {
  test('undefined report -> report_unavailable for every executable check', () => {
    const spec = specWith(
      [ac('A1'), ac('A2')],
      [ev('A1', { commit_sha: 'abc' }), ev('A2', { test_nodeid: 't::x' })]
    );
    const verdicts = run(spec, undefined);
    for (const v of verdicts) {
      expect(v.verdict).toBe('not_rederived');
      expect(v.reason).toBe('report_unavailable');
    }
    expect(summarizeRederivation(verdicts).verified).toBe(0);
  });

  test('narrative-only entry -> no_mechanical_field; no entry -> no_evidence', () => {
    const spec = specWith([ac('A1'), ac('A2')], [ev('A1', { evidence_ref: 'ran it, trust me' })]);
    const [a1, a2] = run(spec, report({}));
    expect(a1.reason).toBe('no_mechanical_field');
    expect(a1.self_reported).toBe(false);
    expect(a2.reason).toBe('no_evidence');
    expect(a2.status).toBeUndefined();
    expect(summarizeRederivation([a1, a2]).narrative_only).toBe(2);
  });

  test('an executable check the store did not report -> outcome_missing', () => {
    const spec = specWith([ac('A1')], [ev('A1', { commit_sha: 'abc' })]);
    const [v] = run(spec, report({ A1: [] }));
    expect(v.reason).toBe('outcome_missing');
    expect(v.verdict).toBe('not_rederived');
  });

  test('timeout and unavailable are not_rederived with their own reasons', () => {
    const spec = specWith(
      [ac('A1'), ac('A2')],
      [ev('A1', { test_nodeid: 'a' }), ev('A2', { test_nodeid: 'b' })]
    );
    const [a1, a2] = run(
      spec,
      report({
        A1: [{ class: 'test', target: 'a', outcome: 'timeout' }],
        A2: [{ class: 'test', target: 'b', outcome: 'unavailable' }],
      })
    );
    expect([a1.verdict, a1.reason]).toEqual(['not_rederived', 'timeout']);
    expect([a2.verdict, a2.reason]).toEqual(['not_rederived', 'runner_unavailable']);
  });
});

// ─── aggregation: weakest check decides ──────────────────────────────────────

describe('a criterion is verified only when every check holds', () => {
  test('passed citation + unrun test -> not_rederived', () => {
    const spec = specWith([ac('A1')], [ev('A1', { commit_sha: 'abc', test_nodeid: 't::x' })]);
    const [v] = run(
      spec,
      report({
        A1: [
          { class: 'citation', target: 'abc', outcome: 'passed' },
          { class: 'test', target: 't::x', outcome: 'not_run' },
        ],
      })
    );
    expect(v.verdict).toBe('not_rederived');
    expect(v.reason).toBe('not_run');
    expect(v.checks.map((c) => c.verdict)).toEqual(['verified', 'not_rederived']);
  });

  test('passed citation + failed test -> refuted', () => {
    const spec = specWith([ac('A1')], [ev('A1', { commit_sha: 'abc', test_nodeid: 't::x' })]);
    const [v] = run(
      spec,
      report({
        A1: [
          { class: 'citation', target: 'abc', outcome: 'passed' },
          { class: 'test', target: 't::x', outcome: 'failed' },
        ],
      })
    );
    expect(v.verdict).toBe('refuted');
    expect(v.reason).toBe('test_failed');
  });

  test('all checks passed -> verified', () => {
    const spec = specWith(
      [ac('A1')],
      [ev('A1', { commit_sha: 'abc', artifact_path: 'p', test_nodeid: 't::x' })]
    );
    const [v] = run(
      spec,
      report({
        A1: [
          { class: 'citation', target: 'abc', outcome: 'passed' },
          { class: 'artifact', target: 'p', outcome: 'passed' },
          { class: 'test', target: 't::x', outcome: 'passed' },
        ],
      })
    );
    expect(v.verdict).toBe('verified');
    expect(v.checks).toHaveLength(3);
  });
});

// ─── self-report and divergence (A12) ────────────────────────────────────────

describe('self_reported and divergence', () => {
  test('any mechanical field marks the criterion self_reported', () => {
    const spec = specWith([ac('A1'), ac('A2')], [ev('A1', { artifact_path: 'p' }), ev('A2')]);
    const [a1, a2] = run(
      spec,
      report({ A1: [{ class: 'artifact', target: 'p', outcome: 'passed' }] })
    );
    expect(a1.self_reported).toBe(true);
    expect(a2.self_reported).toBe(false);
  });

  test('acceptance test_nodeids become acceptance-sourced executable checks, deduped against evidence', () => {
    const spec = specWith(
      [ac('A1', { test_nodeids: ['t::same', 't::other'] })],
      [ev('A1', { test_nodeid: 't::same' })]
    );
    const plan = planRederivation(spec);
    const tests = plan.criteria[0].checks.filter((c) => c.class === 'test');
    expect(tests.map((c) => [c.target, c.source])).toEqual([
      ['t::same', 'evidence'],
      ['t::other', 'acceptance'],
    ]);
    for (const t of tests) expect(t.executable).toBe(true);
  });

  test('divergence is reported when the evidence nodeid is outside the declared set', () => {
    const spec = specWith(
      [ac('A1', { test_nodeids: ['t::declared'] })],
      [ev('A1', { test_nodeid: 't::substituted' })]
    );
    const [v] = run(spec, undefined);
    expect(v.divergence).toEqual({ declared: ['t::declared'], reported: 't::substituted' });
  });

  test('no divergence when the evidence nodeid is within the declared set, or nothing is declared', () => {
    const within = specWith(
      [ac('A1', { test_nodeids: ['t::a'] })],
      [ev('A1', { test_nodeid: 't::a' })]
    );
    const none = specWith([ac('A1')], [ev('A1', { test_nodeid: 't::a' })]);
    expect(run(within, undefined)[0].divergence).toBeUndefined();
    expect(run(none, undefined)[0].divergence).toBeUndefined();
  });
});

// ─── through the real parser ─────────────────────────────────────────────────

describe('plan reads the typed fields the parser produces', () => {
  test('a YAML spec with all five fields plans citation, artifact, test and command with exact targets', () => {
    const yaml = `
id: RD-YAML-1
title: parsed fixture
risk_tier: 3
mode: chore
lifecycle_state: active
blast_radius:
  modules: ['x']
  data_migration: false
operational_rollback_slo: 5m
scope:
  in: ['x']
  out: []
invariants: ['i']
acceptance:
  - id: A1
    given: g
    when: w
    then: t
non_functional: {}
contracts: []
evidence:
  - criterion_id: A1
    status: pass
    recorded_at: '2026-09-16T12:00:00.000Z'
    test_nodeid: 'tests/unit/test_gate.py::TestGate::test_refuses[case-1]'
    command: python3 -m pytest -q -- tests/unit/test_gate.py
    exit_code: 0
    artifact_path: docs/reports/gate-run.md
    commit_sha: d7f2267d90
`;
    const parsed = parseAndValidateSpec(yaml);
    expect(isOk(parsed)).toBe(true);
    if (!isOk(parsed)) return;
    const plan = planRederivation(parsed.value);
    expect(plan.criteria[0].checks).toEqual([
      { class: 'citation', target: 'd7f2267d90', source: 'evidence', executable: true },
      {
        class: 'artifact',
        target: 'docs/reports/gate-run.md',
        source: 'evidence',
        executable: true,
      },
      {
        class: 'test',
        target: 'tests/unit/test_gate.py::TestGate::test_refuses[case-1]',
        source: 'evidence',
        executable: true,
      },
      {
        class: 'command',
        target: 'python3 -m pytest -q -- tests/unit/test_gate.py',
        source: 'evidence',
        executable: false,
      },
    ]);
  });
});

// ─── purity (A8, kernel half) ────────────────────────────────────────────────

describe('the module is pure', () => {
  test('rederive.ts imports nothing impure and touches no clock', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../../src/kernel/evidence/rederive.ts'),
      'utf8'
    );
    // Strip comments so prose mentioning these names does not trip the check.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const forbidden of [
      "from 'fs'",
      'from "fs"',
      'child_process',
      'process.env',
      'process.cwd',
      'Date.now',
      'new Date(',
      'require(',
    ]) {
      expect(code).not.toContain(forbidden);
    }
    // The only import is a type-only import from the spec types.
    const imports = code.match(/^import .*$/gm) ?? [];
    expect(imports).toEqual([
      "import type { EvidenceRecord, EvidenceStatus, Spec } from '../spec/types';",
    ]);
  });
});
