'use strict';

/**
 * Unit tests for gate disposition (A2) — the SOLE place block/warn/skip
 * semantics are decided.
 *
 * CAWS-TEST-CLI-SHELL-001. deriveDispositions maps (report violations, policy
 * gate modes) -> one GateDisposition per policy-declared gate, plus an
 * unmatched bucket. The load-bearing distinction: block+violation FAILS AND
 * BLOCKS, warn+violation FAILS BUT DOES NOT BLOCK. Tests assert the actual
 * outcome + blocks flag, so a mutation that makes warn block (or block not
 * block) is killed.
 *
 * Anchors the CAWS-GATES-POLICY-DISPOSITION-DRIFT-001 fix: a policy-declared
 * gate beyond the canonical five must still block (iteration is over
 * policy.gates, not the KNOWN_GATE_IDS tuple).
 *
 * SUT loaded from dist/.
 */

const { deriveDispositions } = require('../../dist/shell/gates/disposition');

const gate = (mode, enabled = true) => ({ mode, enabled });

function policy(gates) {
  return { version: 1, risk_tiers: {}, gates };
}
function report(violations) {
  return {
    timestamp: '2026-06-13T12:00:00.000Z',
    context: 'test',
    files_scoped: 1,
    warnings: [],
    violations,
  };
}
const v = (g) => ({ gate: g, message: `${g} violated` });

function dispoFor(result, gateId) {
  return result.dispositions.find((d) => d.gate_id === gateId);
}

describe('deriveDispositions: block / warn / skip semantics', () => {
  test('block + violation -> fail AND blocks', () => {
    const r = deriveDispositions(report([v('budget_limit')]), policy({ budget_limit: gate('block') }));
    const d = dispoFor(r, 'budget_limit');
    expect(d.outcome).toBe('fail');
    expect(d.blocks).toBe(true);
    expect(r.anyBlocks).toBe(true);
  });

  test('warn + violation -> fail but DOES NOT block (the load-bearing distinction)', () => {
    const r = deriveDispositions(report([v('budget_limit')]), policy({ budget_limit: gate('warn') }));
    const d = dispoFor(r, 'budget_limit');
    expect(d.outcome).toBe('fail');
    expect(d.blocks).toBe(false);
    expect(r.anyBlocks).toBe(false);
  });

  test('skip mode -> skipped, never blocks (even with a violation)', () => {
    const r = deriveDispositions(report([v('budget_limit')]), policy({ budget_limit: gate('skip') }));
    const d = dispoFor(r, 'budget_limit');
    expect(d.outcome).toBe('skipped');
    expect(d.blocks).toBe(false);
  });

  test('enabled:false -> skipped, never blocks (even at mode block with a violation)', () => {
    const r = deriveDispositions(report([v('budget_limit')]), policy({ budget_limit: gate('block', false) }));
    const d = dispoFor(r, 'budget_limit');
    expect(d.outcome).toBe('skipped');
    expect(d.blocks).toBe(false);
  });

  test('no violation -> pass, never blocks', () => {
    const r = deriveDispositions(report([]), policy({ budget_limit: gate('block') }));
    const d = dispoFor(r, 'budget_limit');
    expect(d.outcome).toBe('pass');
    expect(d.blocks).toBe(false);
  });
});

describe('deriveDispositions: violation matching + unmatched bucket', () => {
  test('a violation is matched to a gate iff its gate field equals the gate id', () => {
    const r = deriveDispositions(
      report([v('budget_limit'), v('scope_boundary')]),
      policy({ budget_limit: gate('block'), scope_boundary: gate('warn') })
    );
    expect(dispoFor(r, 'budget_limit').violations).toHaveLength(1);
    expect(dispoFor(r, 'scope_boundary').violations).toHaveLength(1);
  });

  test('a violation targeting an UNKNOWN gate is surfaced as unmatched, NOT driving disposition', () => {
    const r = deriveDispositions(
      report([v('not_a_policy_gate')]),
      policy({ budget_limit: gate('block') })
    );
    // budget_limit has no violation -> pass.
    expect(dispoFor(r, 'budget_limit').outcome).toBe('pass');
    // the unknown gate's violation rides in unmatched, does not block.
    expect(r.unmatchedViolations).toHaveLength(1);
    expect(r.unmatchedViolations[0].gate).toBe('not_a_policy_gate');
    expect(r.anyBlocks).toBe(false);
  });

  test('mechanical alias god_objects -> god_object (naming-only, same intent)', () => {
    const r = deriveDispositions(
      report([v('god_objects')]), // legacy plural in the report
      policy({ god_object: gate('block') }) // canonical singular in policy
    );
    // Aliased into the policy gate -> it blocks.
    expect(dispoFor(r, 'god_object').outcome).toBe('fail');
    expect(dispoFor(r, 'god_object').blocks).toBe(true);
    expect(r.unmatchedViolations).toHaveLength(0);
  });
});

describe('deriveDispositions: policy-declared gates are the authority (DRIFT-001)', () => {
  test('a NON-canonical policy gate in block mode still blocks (not silently demoted)', () => {
    // 'custom_gate' is not in KNOWN_GATE_IDS; it must still be evaluated.
    const r = deriveDispositions(
      report([v('custom_gate')]),
      policy({ custom_gate: gate('block') })
    );
    const d = dispoFor(r, 'custom_gate');
    expect(d).toBeDefined();
    expect(d.outcome).toBe('fail');
    expect(d.blocks).toBe(true);
  });

  test('canonical gates are ordered first; non-canonical appended after', () => {
    const r = deriveDispositions(
      report([]),
      policy({ custom_gate: gate('warn'), budget_limit: gate('block') })
    );
    const ids = r.dispositions.map((d) => d.gate_id);
    // budget_limit (canonical) precedes custom_gate (non-canonical).
    expect(ids.indexOf('budget_limit')).toBeLessThan(ids.indexOf('custom_gate'));
  });
});
