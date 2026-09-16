/**
 * CAWS-REMEDIATION-NO-LABEL-ESCAPE-001.
 *
 * A remediation must name the substantive repair. It must never offer, as an
 * alternative, a change to the very label that made the rule apply — that turns
 * the gate into a relabeling exercise and the cheapest discharge becomes the one
 * that does none of the work the rule exists to demand.
 *
 * Measured, not hypothesized (docs/failure-lineage.md Entry 42, Specimen B):
 * across 1908 transcripts, 101 `caws specs create` calls were denied for a
 * tier-1/2 spec with no contracts. 73 added a contract; 20 lowered risk_tier
 * 2 -> 3 with `mode` unchanged in all 20. The kernel had told them to: the
 * narrowRepair read "Add at least one contract or change risk_tier to 3 or mode
 * to chore." The requirement prescribed its own bypass.
 *
 * The scan below is the durable half. Fixing the two known strings is a one-time
 * repair; the scan is what makes the class non-recurring, and it already covers a
 * third site Entry 42 never recorded (EXPERIMENTAL_MODE_TIER_RESTRICTED).
 */

import * as fs from 'fs';
import * as path from 'path';

import { validateSpecSemantics } from '../../../src/kernel/spec/validate-semantics';
import { validateSpecShape } from '../../../src/kernel/spec/validate-shape';
import { parseSpecYaml } from '../../../src/kernel/spec/parse';
import { SPEC_RULES } from '../../../src/kernel/spec/rules';
import { isOk, isErr } from '../../../src/kernel/result/construct';
import type { Spec } from '../../../src/kernel/spec/types';

const KERNEL_SRC = path.resolve(__dirname, '../../../src/kernel');

/**
 * A prescription to change the spec's own `risk_tier` or `mode`.
 *
 * Deliberately narrow, because three separate things in this codebase are
 * spelled with these words and only one of them is the spec's own label:
 *
 *  - `risk_tiers[...]` (policy/derive-budget.ts) is the policy budget MAP, a
 *    different field — the trailing word-boundary excludes it.
 *  - `experimental_mode` contains "mode" — the leading `\w` lookbehind excludes
 *    it.
 *  - `gates.<id>.mode` (policy/validate-semantics.ts) is a GATE's mode
 *    (block/warn/skip), not the spec's. Its remediation says to set it to
 *    "block" — prescribing the STRICTER value, the opposite of an escape. The
 *    leading `.` lookbehind excludes it. This one was a live false positive on
 *    the first run of this scan, so it is pinned as a test below rather than
 *    left to the next author to rediscover.
 *
 * Prose that merely mentions the field is likewise not a prescription:
 * "...as risk_tier rises" describes a relationship and must stay legal.
 */
const PRESCRIBES_LABEL_CHANGE =
  /\b(?:change|set|lower|switch|drop)\s+(?:the\s+)?(?<![.\w])(?:risk_tier|mode)\b|(?<![.\w])(?:risk_tier|mode)\s+to\s+\S/i;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

interface Remediation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Every `narrowRepair: '<literal>'` in the kernel, with its source location. */
function collectRemediations(): Remediation[] {
  const found: Remediation[] = [];
  for (const file of tsFilesUnder(KERNEL_SRC)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = /narrowRepair:\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(line);
      if (m !== null) {
        found.push({
          file: path.relative(KERNEL_SRC, file),
          line: i + 1,
          text: m[2]!,
        });
      }
    });
  }
  return found;
}

function parseShape(yaml: string): Spec {
  const parsed = parseSpecYaml(yaml);
  if (!isOk(parsed)) throw new Error('fixture YAML did not parse');
  const shaped = validateSpecShape(parsed.value);
  if (!isOk(shaped)) {
    throw new Error('fixture failed shape: ' + shaped.errors.map((e) => e.rule).join(','));
  }
  return shaped.value;
}

/** Tier-1 spec satisfying every tier-1 rule EXCEPT contracts. */
const TIER1_NO_CONTRACTS = `
id: TEST-1
title: Tier one with no contracts
risk_tier: 1
mode: feature
lifecycle_state: active
blast_radius:
  modules:
    - src/x.ts
scope:
  in:
    - src/x.ts
invariants:
  - holds
acceptance:
  - id: A1
    given: g
    when: w
    then: t
non_functional:
  security:
    - reviewed
observability:
  - logs
rollback:
  - revert
contracts: []
`;

const TIER2_NO_CONTRACTS = `
id: TEST-2
title: Tier two with no contracts
risk_tier: 2
mode: feature
lifecycle_state: active
blast_radius:
  modules:
    - src/x.ts
scope:
  in:
    - src/x.ts
invariants:
  - holds
acceptance:
  - id: A1
    given: g
    when: w
    then: t
non_functional: {}
contracts: []
`;

const TIER1_EXPERIMENTAL = `
id: TEST-3
title: Experimental mode on a governed tier
risk_tier: 1
mode: feature
lifecycle_state: active
experimental_mode:
  enabled: true
  rationale: probing the tier gate
  expires_at: '2030-01-01T00:00:00Z'
blast_radius:
  modules:
    - src/x.ts
scope:
  in:
    - src/x.ts
invariants:
  - holds
acceptance:
  - id: A1
    given: g
    when: w
    then: t
non_functional:
  security:
    - reviewed
observability:
  - logs
rollback:
  - revert
contracts:
  - name: c
    type: behavior
`;

function repairFor(yaml: string, rule: string): string {
  const r = validateSpecSemantics(parseShape(yaml));
  if (isOk(r)) throw new Error(`expected ${rule} to fire, but the spec validated`);
  const hit = r.errors.find((e) => e.rule === rule);
  if (hit === undefined) {
    throw new Error(`expected ${rule}, got: ${r.errors.map((e) => e.rule).join(',')}`);
  }
  return hit.narrowRepair ?? '';
}

describe('A1 — no kernel remediation prescribes a label change', () => {
  // The scan is worthless if the extractor silently matches nothing, so pin a
  // floor: a regex that stops parsing narrowRepair would report zero violations
  // and pass for entirely the wrong reason.
  test('the extractor actually finds the kernel remediation corpus', () => {
    const all = collectRemediations();
    expect(all.length).toBeGreaterThan(50);
    expect(all.every((r) => r.text.length > 0)).toBe(true);
  });

  test('the detector recognises the shapes Entry 42 measured', () => {
    expect(PRESCRIBES_LABEL_CHANGE.test('Add a contract or change risk_tier to 3.')).toBe(true);
    expect(PRESCRIBES_LABEL_CHANGE.test('Remove experimental_mode or change risk_tier to 3.')).toBe(
      true
    );
    expect(PRESCRIBES_LABEL_CHANGE.test('Add a contract or set mode to chore.')).toBe(true);
  });

  test('the detector leaves legitimate risk_tier prose alone', () => {
    // Policy ordering describes a relationship; it prescribes no relabel.
    expect(
      PRESCRIBES_LABEL_CHANGE.test(
        'Order tiers from strict to permissive: max_loc must increase or stay equal as risk_tier rises.'
      )
    ).toBe(false);
    // The policy budget map is `risk_tiers`, a different field.
    expect(
      PRESCRIBES_LABEL_CHANGE.test('Add risk_tiers["tier2"] with max_files and max_loc.')
    ).toBe(false);
    // `experimental_mode` contains "mode" but is not the `mode` field.
    expect(PRESCRIBES_LABEL_CHANGE.test('Remove experimental_mode from this spec.')).toBe(false);
    // A policy GATE's mode is a different field, and this remediation prescribes
    // the STRICTER value — tightening, not escaping. Live false positive on the
    // first run of this scan.
    expect(
      PRESCRIBES_LABEL_CHANGE.test(
        'Set gates.${gateId}.mode to "block" unless the deviation is intentional and documented.'
      )
    ).toBe(false);
  });

  test('no narrowRepair in the kernel offers a relabel as the repair', () => {
    const violations = collectRemediations().filter((r) => PRESCRIBES_LABEL_CHANGE.test(r.text));
    expect(violations.map((v) => `${v.file}:${v.line} -> ${v.text}`)).toEqual([]);
  });
});

describe('A2 — the contract requirement still fires, without the escape', () => {
  test('tier 1 with contracts: [] still fails with tier1.contracts_required', () => {
    const r = validateSpecSemantics(parseShape(TIER1_NO_CONTRACTS));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(SPEC_RULES.TIER1_MISSING_CONTRACTS);
    }
  });

  test('tier 2 with contracts: [] still fails with tier2.contracts_required', () => {
    const r = validateSpecSemantics(parseShape(TIER2_NO_CONTRACTS));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(SPEC_RULES.TIER2_MISSING_CONTRACTS);
    }
  });

  test('the tier-1 repair names adding a contract and never a tier or mode change', () => {
    const repair = repairFor(TIER1_NO_CONTRACTS, SPEC_RULES.TIER1_MISSING_CONTRACTS);
    expect(repair).toMatch(/contract/i);
    expect(PRESCRIBES_LABEL_CHANGE.test(repair)).toBe(false);
  });

  test('the tier-2 repair names adding a contract and never a tier or mode change', () => {
    const repair = repairFor(TIER2_NO_CONTRACTS, SPEC_RULES.TIER2_MISSING_CONTRACTS);
    expect(repair).toMatch(/contract/i);
    expect(PRESCRIBES_LABEL_CHANGE.test(repair)).toBe(false);
  });
});

describe('A3 — the capability is retained, only the prescription is removed', () => {
  test('an author who genuinely chooses tier 3 still validates', () => {
    const tier3 = TIER2_NO_CONTRACTS.replace('risk_tier: 2', 'risk_tier: 3');
    const r = validateSpecSemantics(parseShape(tier3));
    expect(isOk(r)).toBe(true);
  });

  test('an author who genuinely chooses mode: chore still validates at tier 2', () => {
    const chore = TIER2_NO_CONTRACTS.replace('mode: feature', 'mode: chore');
    const r = validateSpecSemantics(parseShape(chore));
    expect(isOk(r)).toBe(true);
  });
});

describe('A4 — experimental_mode, the third site Entry 42 did not record', () => {
  test('the rule still fires on a non-tier-3 spec', () => {
    const r = validateSpecSemantics(parseShape(TIER1_EXPERIMENTAL));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(SPEC_RULES.EXPERIMENTAL_MODE_TIER_RESTRICTED);
    }
  });

  test('its repair names removing experimental_mode and never a tier change', () => {
    const repair = repairFor(TIER1_EXPERIMENTAL, SPEC_RULES.EXPERIMENTAL_MODE_TIER_RESTRICTED);
    expect(repair).toMatch(/experimental_mode/);
    expect(PRESCRIBES_LABEL_CHANGE.test(repair)).toBe(false);
  });
});
