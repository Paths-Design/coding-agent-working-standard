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

// ---------------------------------------------------------------------------
// The canonical gate name literals must route violations to the correct policy
// gate; a blanked-out id would leave violations unmatched.
// ---------------------------------------------------------------------------
describe('deriveDispositions: canonical gate name literals are load-bearing', () => {
  const CANONICAL = [
    'budget_limit',
    'spec_completeness',
    'scope_boundary',
    'god_object',
    'todo_detection',
  ];

  for (const name of CANONICAL) {
    test(`canonical gate '${name}' routes its violation to block disposition`, () => {
      const r = deriveDispositions(
        report([v(name)]),
        policy({ [name]: gate('block') })
      );
      expect(isOk(r)).toBe(true);
      const d = dispoFor(r, name);
      expect(d).toBeDefined();
      // The gate id in the disposition must equal the exact canonical string.
      expect(d.gate_id).toBe(name);
      expect(d.outcome).toBe('fail');
      expect(d.blocks).toBe(true);
    });
  }

  // Ordering is canonical-five first, in KNOWN_GATE_IDS order.
  test('all five canonical gates appear in their fixed order before non-canonical gates', () => {
    const r = deriveDispositions(
      report([]),
      policy({
        extra_gate: gate('warn'),
        todo_detection: gate('block'),
        god_object: gate('warn'),
        scope_boundary: gate('block'),
        spec_completeness: gate('warn'),
        budget_limit: gate('block'),
      })
    );
    expect(isOk(r)).toBe(true);
    const ids = r.dispositions.map((d) => d.gate_id);
    const expectedOrder = ['budget_limit', 'spec_completeness', 'scope_boundary', 'god_object', 'todo_detection'];
    let prev = -1;
    for (const name of expectedOrder) {
      const idx = ids.indexOf(name);
      expect(idx).toBeGreaterThan(prev);
      prev = idx;
    }
    // extra_gate must appear after all five canonical ones.
    expect(ids.indexOf('extra_gate')).toBeGreaterThan(ids.indexOf('todo_detection'));
  });
});

// ---------------------------------------------------------------------------
// Alias string values must resolve violations to the correct policy gate;
// a wrong alias target leaves violations unmatched.
// ---------------------------------------------------------------------------
describe('deriveDispositions: alias string literals are load-bearing', () => {
  test("'hidden-todo' alias maps to exact string 'todo_detection'", () => {
    const r = deriveDispositions(
      report([v('hidden-todo')]),
      policy({ todo_detection: gate('block') })
    );
    expect(isOk(r)).toBe(true);
    const d = dispoFor(r, 'todo_detection');
    expect(d).toBeDefined();
    expect(d.outcome).toBe('fail');
    expect(d.blocks).toBe(true);
    // Must NOT appear in unmatched — the alias must have resolved.
    expect(r.unmatchedViolations).toHaveLength(0);
  });

  test("'god_objects' alias maps to exact string 'god_object' (plural->singular)", () => {
    const r = deriveDispositions(
      report([v('god_objects')]),
      policy({ god_object: gate('block') })
    );
    expect(isOk(r)).toBe(true);
    const d = dispoFor(r, 'god_object');
    expect(d).toBeDefined();
    expect(d.gate_id).toBe('god_object');
    expect(d.outcome).toBe('fail');
    expect(d.blocks).toBe(true);
    expect(r.unmatchedViolations).toHaveLength(0);
  });

  test('an unaliased report gate name falls through to unmatched (no false alias)', () => {
    // 'hidden_todo' (underscore, not dash) is NOT an alias.
    const r = deriveDispositions(
      report([v('hidden_todo')]),
      policy({ todo_detection: gate('block') })
    );
    expect(isOk(r)).toBe(true);
    expect(r.unmatchedViolations).toHaveLength(1);
    expect(r.unmatchedViolations[0].gate).toBe('hidden_todo');
    // todo_detection has no violations -> pass.
    expect(dispoFor(r, 'todo_detection').outcome).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// Structural invariants of the returned object.
// ---------------------------------------------------------------------------
describe('deriveDispositions: return object shape', () => {
  test('returns dispositions array, unmatchedViolations array, anyBlocks bool', () => {
    const r = deriveDispositions(report([]), policy({ budget_limit: gate('block') }));
    expect(isOk(r)).toBe(true);
    expect(Array.isArray(r.dispositions)).toBe(true);
    expect(Array.isArray(r.unmatchedViolations)).toBe(true);
    expect(typeof r.anyBlocks).toBe('boolean');
  });

  test('each disposition has gate_id, mode, outcome, blocks, violations', () => {
    const r = deriveDispositions(
      report([v('budget_limit')]),
      policy({ budget_limit: gate('block') })
    );
    expect(isOk(r)).toBe(true);
    const d = r.dispositions[0];
    expect(d.gate_id).toBe('budget_limit');
    expect(d.mode).toBe('block');
    expect(d.outcome).toBe('fail');
    expect(d.blocks).toBe(true);
    expect(Array.isArray(d.violations)).toBe(true);
    expect(d.violations).toHaveLength(1);
  });

  test('violations array on passing gate is empty (not mutated away)', () => {
    const r = deriveDispositions(report([]), policy({ budget_limit: gate('block') }));
    expect(isOk(r)).toBe(true);
    const d = dispoFor(r, 'budget_limit');
    expect(d.violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// anyBlocks uses "some" semantics: true when at least one gate blocks,
// even if other failing gates do not block.
// ---------------------------------------------------------------------------
describe('deriveDispositions: anyBlocks semantics (some, not every)', () => {
  test('anyBlocks is true when at least ONE gate blocks (even if another does not)', () => {
    const r = deriveDispositions(
      report([v('budget_limit'), v('scope_boundary')]),
      policy({
        budget_limit: gate('block'),  // blocks
        scope_boundary: gate('warn'),  // fails but does NOT block
      })
    );
    expect(isOk(r)).toBe(true);
    expect(dispoFor(r, 'budget_limit').blocks).toBe(true);
    expect(dispoFor(r, 'scope_boundary').blocks).toBe(false);
    expect(r.anyBlocks).toBe(true);
  });

  test('anyBlocks is false when ALL failing gates are warn (not block)', () => {
    const r = deriveDispositions(
      report([v('budget_limit'), v('scope_boundary')]),
      policy({
        budget_limit: gate('warn'),
        scope_boundary: gate('warn'),
      })
    );
    expect(isOk(r)).toBe(true);
    expect(r.anyBlocks).toBe(false);
  });

  test('anyBlocks is false when NO gates have violations', () => {
    const r = deriveDispositions(
      report([]),
      policy({ budget_limit: gate('block'), scope_boundary: gate('block') })
    );
    expect(isOk(r)).toBe(true);
    expect(r.anyBlocks).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gate ordering and deduplication: canonical gates appear first in fixed
// order; each policy gate appears exactly once in the output.
// ---------------------------------------------------------------------------
describe('deriveDispositions: gate ordering and deduplication', () => {
  test('each policy gate appears exactly once in dispositions', () => {
    const r = deriveDispositions(
      report([]),
      policy({
        budget_limit: gate('block'),
        spec_completeness: gate('warn'),
        extra: gate('warn'),
      })
    );
    expect(isOk(r)).toBe(true);
    const ids = r.dispositions.map((d) => d.gate_id);
    // No duplicates.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('budget_limit');
    expect(ids).toContain('spec_completeness');
    expect(ids).toContain('extra');
  });

  test('a gate present in KNOWN_GATE_IDS but absent from policy is NOT emitted', () => {
    // Only budget_limit is in policy; spec_completeness is KNOWN but not declared.
    const r = deriveDispositions(
      report([]),
      policy({ budget_limit: gate('block') })
    );
    expect(isOk(r)).toBe(true);
    const ids = r.dispositions.map((d) => d.gate_id);
    expect(ids).toEqual(['budget_limit']);
  });

  test('non-canonical gates declared in policy ARE evaluated (DRIFT-001)', () => {
    const r = deriveDispositions(
      report([v('drift_gate')]),
      policy({ drift_gate: gate('block') })
    );
    expect(isOk(r)).toBe(true);
    const d = dispoFor(r, 'drift_gate');
    expect(d).toBeDefined();
    expect(d.outcome).toBe('fail');
    expect(d.blocks).toBe(true);
    expect(r.anyBlocks).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Multiple violations on the same gate must accumulate, not replace each other.
// ---------------------------------------------------------------------------
describe('deriveDispositions: multiple violations on the same gate', () => {
  test('two violations on the same gate both appear in its violations array', () => {
    const v1 = { gate: 'budget_limit', message: 'first violation' };
    const v2 = { gate: 'budget_limit', message: 'second violation' };
    const r = deriveDispositions(
      report([v1, v2]),
      policy({ budget_limit: gate('block') })
    );
    expect(isOk(r)).toBe(true);
    const d = dispoFor(r, 'budget_limit');
    expect(d.violations).toHaveLength(2);
    expect(d.violations.map((x) => x.message)).toContain('first violation');
    expect(d.violations.map((x) => x.message)).toContain('second violation');
  });

  test('two violations on different gates each land in their own gate', () => {
    const r = deriveDispositions(
      report([v('budget_limit'), v('scope_boundary')]),
      policy({ budget_limit: gate('block'), scope_boundary: gate('warn') })
    );
    expect(isOk(r)).toBe(true);
    expect(dispoFor(r, 'budget_limit').violations).toHaveLength(1);
    expect(dispoFor(r, 'scope_boundary').violations).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Every gate declared in policy must yield a disposition entry, regardless
// of whether it has a violation.
// ---------------------------------------------------------------------------
describe('deriveDispositions: cfg-undefined guard', () => {
  test('every policy-declared gate produces a disposition entry', () => {
    const r = deriveDispositions(
      report([]),
      policy({
        budget_limit: gate('block'),
        scope_boundary: gate('warn'),
        god_object: gate('skip'),
      })
    );
    expect(isOk(r)).toBe(true);
    expect(dispoFor(r, 'budget_limit')).toBeDefined();
    expect(dispoFor(r, 'scope_boundary')).toBeDefined();
    expect(dispoFor(r, 'god_object')).toBeDefined();
    expect(r.dispositions).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Helper: plain deriveDispositions returns a plain object, not a Result.
// So "isOk" here just checks the value is truthy (not wrapped).
// ---------------------------------------------------------------------------
function isOk(r) {
  return r !== null && r !== undefined && typeof r === 'object';
}
