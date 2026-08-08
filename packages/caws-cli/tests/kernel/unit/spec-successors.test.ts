/**
 * Structured successor declarations: schema shape, intra-spec semantics, and
 * the resolution oracle. CAWS-SPEC-SUCCESSOR-DECLARATION-CUSTODY-01.
 *
 * These drive the REAL pipeline (parseAndValidateSpec and its layers) and the
 * real resolver, and assert each failure by its SPECIFIC SPEC_RULES code or
 * its specific resolution outcome — not merely "is Err". A mutation that
 * collapses two rule mappings, or that widens an outcome, is killed.
 *
 * Two properties carry most of the weight here and are worth naming:
 *   - CUSTODY, NOT COMPLETION: an authored target in ANY lifecycle state
 *     satisfies a required successor. Abandoned included — that is a governed
 *     outcome, not a lost obligation.
 *   - LAYER SEPARATION: the semantic layer never resolves a target. The same
 *     bytes that pass validation can still be refused at close preflight, and
 *     a test asserts exactly that disagreement.
 */

import { parseSpecYaml } from '../../../src/kernel/spec/parse';
import { validateSpecShape } from '../../../src/kernel/spec/validate-shape';
import { validateSpecSemantics } from '../../../src/kernel/spec/validate-semantics';
import { parseAndValidateSpec } from '../../../src/kernel/spec';
import { SPEC_RULES } from '../../../src/kernel/spec/rules';
import {
  createSuccessorResolver,
  findUnresolvedObligations,
  projectSuccessorsForEvent,
  type SpecCorpusEntry,
} from '../../../src/kernel/spec/successors';
import { isOk, isErr } from '../../../src/kernel/result/construct';
import type { Spec } from '../../../src/kernel/spec/types';

/** Build a tier-3 chore spec carrying an arbitrary successors block. */
function specWith(successorsYaml: string, id = 'TEST-1'): string {
  return `
id: ${id}
title: A spec with successor declarations
risk_tier: 3
mode: chore
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
${successorsYaml}
`;
}

/** Rule codes emitted by a failed validation, for exact-code assertions. */
function rulesFrom(source: string): string[] {
  const result = parseAndValidateSpec(source);
  if (isOk(result)) return [];
  return result.errors.map((e) => e.rule);
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

describe('successors: schema shape (A1, A2)', () => {
  it('accepts a structured declaration without any closure_notes prose', () => {
    const source = specWith(`successors:
  - target_spec_id: SOME-SPEC-01
    disposition: required
    rationale: Implements the runtime wiring established by this recon.`);

    const result = parseAndValidateSpec(source);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    // The obligation is queryable DATA, which is the whole point of the slice.
    expect(result.value.successors).toEqual([
      {
        target_spec_id: 'SOME-SPEC-01',
        disposition: 'required',
        rationale: 'Implements the runtime wiring established by this recon.',
      },
    ]);
    // And it did not smuggle itself into prose.
    expect(source).not.toContain('closure_notes');
  });

  it.each([
    ['ALG-001a-HARDEN-01 (not yet created) will take this atom'],
    ['a multi-seed-evidence slice that executes the seam across a seed'],
    ['retiring test_p11_p21_promotion_proposal.py and'],
  ])('makes the malformed legacy declaration %# structurally unrepresentable', (malformed) => {
    // These three are verbatim from Sterling's census of 46 controlled
    // closure-note declarations, 17 of which were malformed. They are not
    // typos — they are prose written after an identifier because no
    // structured field existed. The field must make them UNREPRESENTABLE,
    // not merely detectable.
    const source = specWith(`successors:
  - target_spec_id: ${JSON.stringify(malformed)}
    disposition: required`);

    expect(rulesFrom(source)).toContain(SPEC_RULES.SCHEMA_VIOLATION);
  });

  it('rejects a disposition outside the closed vocabulary', () => {
    // 'unresolved' is the tempting fourth value — it describes the TARGET,
    // not a decision by the source. Admitting it would collapse the two axes.
    const source = specWith(`successors:
  - target_spec_id: SOME-SPEC-01
    disposition: unresolved`);

    expect(rulesFrom(source)).toContain(SPEC_RULES.SCHEMA_VIOLATION);
  });

  it('rejects a target-standing field smuggled into the declaration', () => {
    // additionalProperties:false is what keeps derived state out of the
    // source spec. If this ever passes, standing can drift from the target.
    const source = specWith(`successors:
  - target_spec_id: SOME-SPEC-01
    disposition: required
    target_lifecycle_state: active`);

    expect(rulesFrom(source)).toContain(SPEC_RULES.SCHEMA_VIOLATION);
  });
});

describe('successors: intra-spec semantics (A3, A4, A18, A19)', () => {
  it('rejects declined with no rationale', () => {
    const source = specWith(`successors:
  - target_spec_id: SOME-SPEC-01
    disposition: declined`);

    expect(rulesFrom(source)).toContain(SPEC_RULES.SUCCESSOR_DECLINED_MISSING_RATIONALE);
  });

  it('rejects declined with a whitespace-only rationale', () => {
    // minLength:1 in the schema passes a single space; the decision is still
    // absent. Asserted separately from the missing-key case so one fix cannot
    // silently cover both.
    const source = specWith(`successors:
  - target_spec_id: SOME-SPEC-01
    disposition: declined
    rationale: '   '`);

    const rules = rulesFrom(source);
    expect(rules).toContain(SPEC_RULES.SUCCESSOR_DECLINED_MISSING_RATIONALE);
    expect(rules).toContain(SPEC_RULES.SUCCESSOR_RATIONALE_FORBIDDEN_EMPTY);
  });

  it('rejects absorbed with no absorbed_by', () => {
    const source = specWith(`successors:
  - target_spec_id: PROPOSED-SUCCESSOR-01
    disposition: absorbed`);

    expect(rulesFrom(source)).toContain(SPEC_RULES.SUCCESSOR_ABSORBED_MISSING_ABSORBED_BY);
  });

  it('rejects a duplicate target rather than deduplicating it', () => {
    // Two declarations for one target mean the author's intent is ambiguous.
    // Silent dedup would pick one rationale and discard the other.
    const source = specWith(`successors:
  - target_spec_id: SOME-SPEC-01
    disposition: required
    rationale: first
  - target_spec_id: SOME-SPEC-01
    disposition: declined
    rationale: second`);

    expect(rulesFrom(source)).toContain(SPEC_RULES.SUCCESSOR_DUPLICATE_TARGET);
  });

  it('names both colliding entry indexes in the duplicate diagnostic', () => {
    const source = specWith(`successors:
  - target_spec_id: OTHER-SPEC-01
    disposition: required
  - target_spec_id: SOME-SPEC-01
    disposition: required
  - target_spec_id: SOME-SPEC-01
    disposition: required`);

    const result = parseAndValidateSpec(source);
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;

    const dup = result.errors.find((e) => e.rule === SPEC_RULES.SUCCESSOR_DUPLICATE_TARGET);
    expect(dup).toBeDefined();
    // The operator needs to know WHICH entries collided, not just that they did.
    expect(dup?.message).toContain('entries 1 and 2');
  });

  it('rejects a spec naming itself as its own successor', () => {
    const source = specWith(
      `successors:
  - target_spec_id: TEST-1
    disposition: required`,
      'TEST-1',
    );

    expect(rulesFrom(source)).toContain(SPEC_RULES.SUCCESSOR_SELF_REFERENCE);
  });

  it('rejects a spec absorbing its own successor obligation', () => {
    const source = specWith(
      `successors:
  - target_spec_id: SOME-SPEC-01
    disposition: absorbed
    absorbed_by: TEST-1`,
      'TEST-1',
    );

    expect(rulesFrom(source)).toContain(SPEC_RULES.SUCCESSOR_ABSORBED_BY_SELF_REFERENCE);
  });

  it('rejects absorbed_by equal to the entry target (self-satisfying)', () => {
    // "the successor obligation was absorbed by the successor" asserts nothing.
    const source = specWith(`successors:
  - target_spec_id: SOME-SPEC-01
    disposition: absorbed
    absorbed_by: SOME-SPEC-01`);

    expect(rulesFrom(source)).toContain(SPEC_RULES.SUCCESSOR_ABSORBED_BY_EQUALS_TARGET);
  });

  it('accepts a well-formed absorbed declaration', () => {
    const source = specWith(`successors:
  - target_spec_id: PROPOSED-SUCCESSOR-01
    disposition: absorbed
    absorbed_by: ACTUAL-IMPLEMENTATION-01
    rationale: The implementation was folded into the broader runtime slice.`);

    expect(isOk(parseAndValidateSpec(source))).toBe(true);
  });

  it('does NOT resolve targets — an unauthored id passes the semantic layer', () => {
    // The load-bearing purity assertion. If this ever fails, referential
    // resolution has leaked into validateSpecSemantics and
    // `caws specs validate <file>` has become repository-dependent.
    const spec = parseShape(
      specWith(`successors:
  - target_spec_id: DEFINITELY-NOT-AUTHORED-99
    disposition: required`),
    );

    expect(isOk(validateSpecSemantics(spec))).toBe(true);
  });
});

describe('successor resolver: existence oracle (A6, A7, A8, A17)', () => {
  const corpus: SpecCorpusEntry[] = [
    { id: 'DRAFT-TARGET-01', lifecycle_state: 'draft', archived: false },
    { id: 'ACTIVE-TARGET-01', lifecycle_state: 'active', archived: false },
    {
      id: 'CLOSED-TARGET-01',
      lifecycle_state: 'closed',
      resolution: 'completed',
      archived: false,
    },
    {
      id: 'ARCHIVED-TARGET-01',
      lifecycle_state: 'archived',
      resolution: 'completed',
      archived: true,
    },
    {
      id: 'ABANDONED-TARGET-01',
      lifecycle_state: 'closed',
      resolution: 'abandoned',
      archived: false,
    },
  ];

  const resolver = createSuccessorResolver(corpus);

  it.each([
    ['DRAFT-TARGET-01', 'draft'],
    ['ACTIVE-TARGET-01', 'active'],
    ['CLOSED-TARGET-01', 'closed'],
    ['ARCHIVED-TARGET-01', 'archived'],
  ])('resolves %s (lifecycle %s) as AUTHORED — custody, not completion', (id, lifecycle) => {
    const result = resolver.resolve(id);
    expect(result.outcome).toBe('AUTHORED');
    expect(result.standing?.lifecycle_state).toBe(lifecycle);
  });

  it('resolves an ABANDONED target as AUTHORED with its standing surfaced', () => {
    // The sharpest custody case: someone decided, and the decision is on
    // record. That is a governed outcome, not a lost obligation.
    const result = resolver.resolve('ABANDONED-TARGET-01');
    expect(result.outcome).toBe('AUTHORED');
    expect(result.standing?.resolution).toBe('abandoned');
  });

  it('reports UNAUTHORED for an id that was never authored', () => {
    expect(resolver.resolve('NEVER-AUTHORED-01').outcome).toBe('UNAUTHORED');
  });

  it('reports MALFORMED_ID distinctly from UNAUTHORED', () => {
    // Reaching the resolver with a malformed id means validation was
    // bypassed. Reporting "not found" would send the operator hunting for a
    // spec that could never have existed.
    expect(resolver.resolve('not a spec id').outcome).toBe('MALFORMED_ID');
  });

  it('resolves AUTHORED with an ambiguity report when an id is in both live and archive', () => {
    // Corpus drift is worth REPORTING but not worth refusing a close over:
    // custody is satisfied either way, and the declaring spec neither caused
    // the drift nor can fix it. This repo already carries such a pair
    // (WORKTREE-DOCTOR-HALF-STATE-001), so the case is live, not theoretical.
    const ambiguous = createSuccessorResolver([
      { id: 'DUPE-01', lifecycle_state: 'active', archived: false, source: 'live' },
      { id: 'DUPE-01', lifecycle_state: 'archived', archived: true, source: 'archive' },
    ]);

    const result = ambiguous.resolve('DUPE-01');
    expect(result.outcome).toBe('AUTHORED');
    expect(result.ambiguous_sources).toEqual(['live', 'archive']);
    // Standing reports the LIVE copy, which is what the rest of the system
    // treats as current.
    expect(result.standing?.lifecycle_state).toBe('active');
  });

  it('does not block a close on an ambiguous target', () => {
    const ambiguous = createSuccessorResolver([
      { id: 'DUPE-01', lifecycle_state: 'active', archived: false, source: 'live' },
      { id: 'DUPE-01', lifecycle_state: 'archived', archived: true, source: 'archive' },
    ]);

    expect(
      findUnresolvedObligations(
        [{ target_spec_id: 'DUPE-01', disposition: 'required' }],
        ambiguous,
      ),
    ).toEqual([]);
  });

  it('omits ambiguous_sources when the id resolves uniquely', () => {
    // A warning field that is always present is a warning nobody reads.
    expect(resolver.resolve('ACTIVE-TARGET-01').ambiguous_sources).toBeUndefined();
  });

  it('labels ambiguous entries by live/archive when no source is supplied', () => {
    // The corpus builder sets `source`, but the type makes it optional, so
    // the fallback label is reachable by any other caller. Without this case
    // the fallback is uncovered and its mutants survive untested.
    const unlabeled = createSuccessorResolver([
      { id: 'DUPE-02', lifecycle_state: 'active', archived: false },
      { id: 'DUPE-02', lifecycle_state: 'archived', archived: true },
    ]);

    expect(unlabeled.resolve('DUPE-02').ambiguous_sources).toEqual([
      'live[0]',
      'archive[1]',
    ]);
  });

  it('prefers the LIVE entry for standing when both copies exist', () => {
    // Ordering must not decide which copy is reported: the live entry wins
    // even when the archived one is first in the corpus.
    const archiveFirst = createSuccessorResolver([
      {
        id: 'DUPE-03',
        lifecycle_state: 'archived',
        resolution: 'completed',
        archived: true,
      },
      { id: 'DUPE-03', lifecycle_state: 'active', archived: false },
    ]);

    const result = archiveFirst.resolve('DUPE-03');
    expect(result.standing?.lifecycle_state).toBe('active');
    expect(result.standing?.archived).toBe(false);
  });

  it('falls back to the archived entry when every copy is archived', () => {
    // `found.find(live) ?? found[0]` — the right-hand side is a real branch,
    // not dead defensive code.
    const allArchived = createSuccessorResolver([
      {
        id: 'ARCH-ONLY-01',
        lifecycle_state: 'archived',
        resolution: 'superseded',
        archived: true,
      },
    ]);

    const result = allArchived.resolve('ARCH-ONLY-01');
    expect(result.outcome).toBe('AUTHORED');
    expect(result.standing?.archived).toBe(true);
    expect(result.standing?.resolution).toBe('superseded');
  });

  it('omits resolution from standing when the target has none', () => {
    // Pins the conditional assignment: an absent key, not an explicit
    // undefined, which is what exactOptionalPropertyTypes requires.
    const result = resolver.resolve('ACTIVE-TARGET-01');
    expect(result.standing).toBeDefined();
    expect('resolution' in (result.standing ?? {})).toBe(false);
  });

  it('reports REGISTRY_UNAVAILABLE — never UNAUTHORED — for an unreadable corpus', () => {
    // "I cannot tell" and "it does not exist" are different facts. Collapsing
    // them would let an unreadable corpus wave through the exact obligation
    // this gate governs.
    const unavailable = createSuccessorResolver(undefined);
    const result = unavailable.resolve('ACTIVE-TARGET-01');

    expect(result.outcome).toBe('REGISTRY_UNAVAILABLE');
    expect(result.outcome).not.toBe('UNAUTHORED');
  });

  it.each([
    // Hostile inputs for the canonical grammar, one per rule it enforces.
    ['lowercase-01', 'lowercase prefix'],
    ['SPEC_01', 'underscore separator'],
    ['SPEC-', 'missing numeric segment'],
    ['-SPEC-01', 'leading separator'],
    ['SPEC-01-', 'trailing separator'],
    ['1SPEC-01', 'leading digit'],
    ['SPEC-01A', 'uppercase suffix (only lowercase permitted)'],
    ['SPEC 01', 'embedded space'],
    ['', 'empty string'],
    // ANCHORING. These are the census shapes: a well-formed id with prose
    // attached at one end. Without `$` the first would be accepted as a
    // prefix match; without `^` the second as a suffix match. Both are the
    // exact "prose written after the identifier" failure the structured
    // field exists to make unrepresentable.
    ['ALG-001a-HARDEN-01 (not yet created)', 'valid id followed by prose'],
    ['SPEC-01 will take this atom', 'valid id followed by a sentence'],
    ['see SPEC-01', 'valid id preceded by prose'],
    ['\nSPEC-01', 'leading newline (anchors must be line-insensitive)'],
    ['SPEC-01\n', 'trailing newline'],
  ])('rejects %j as MALFORMED_ID (%s)', (id) => {
    expect(resolver.resolve(id).outcome).toBe('MALFORMED_ID');
  });

  it.each([
    ['ALG-001a', 'numeric segment with lowercase suffix'],
    ['A-1', 'minimal valid form'],
    ['MULTI-PART-PREFIX-42', 'multiple prefix segments'],
    ['SPEC2-01', 'digit inside a prefix segment'],
  ])('accepts %j as well-formed (%s)', (id) => {
    // Well-formed but absent resolves UNAUTHORED — proving the grammar
    // admitted it rather than rejecting it as malformed.
    expect(resolver.resolve(id).outcome).toBe('UNAUTHORED');
  });

  it('does not fall back to prefix or case-insensitive matching', () => {
    // Sterling's census is the evidence that inference over spec identifiers
    // manufactures false governance conclusions.
    expect(resolver.resolve('ACTIVE-TARGET-0').outcome).toBe('UNAUTHORED');
    expect(resolver.resolve('active-target-01').outcome).toBe('MALFORMED_ID');
  });
});

describe('close obligations: which references must resolve (A5, A6, A8, A17)', () => {
  const resolver = createSuccessorResolver([
    { id: 'AUTHORED-TARGET-01', lifecycle_state: 'active', archived: false },
    { id: 'ABSORBER-01', lifecycle_state: 'active', archived: false },
  ]);

  it('blocks close when a required target is unauthored', () => {
    const unresolved = findUnresolvedObligations(
      [{ target_spec_id: 'NEVER-AUTHORED-01', disposition: 'required' }],
      resolver,
    );

    expect(unresolved).toEqual([
      {
        index: 0,
        field: 'target_spec_id',
        target_spec_id: 'NEVER-AUTHORED-01',
        outcome: 'UNAUTHORED',
      },
    ]);
  });

  it('admits close when a required target resolves', () => {
    expect(
      findUnresolvedObligations(
        [{ target_spec_id: 'AUTHORED-TARGET-01', disposition: 'required' }],
        resolver,
      ),
    ).toEqual([]);
  });

  it('admits a declined entry with no target resolution at all', () => {
    // The rationale carries the decision; there is nothing to resolve.
    expect(
      findUnresolvedObligations(
        [
          {
            target_spec_id: 'NEVER-AUTHORED-01',
            disposition: 'declined',
            rationale: 'Superseded by a different approach.',
          },
        ],
        resolver,
      ),
    ).toEqual([]);
  });

  it('resolves absorbed_by, NOT target_spec_id, for an absorbed entry', () => {
    // The absorbed entry's target is the PROPOSED successor that was never
    // authored — that is precisely why it was absorbed. Demanding it resolve
    // would defeat the disposition.
    expect(
      findUnresolvedObligations(
        [
          {
            target_spec_id: 'NEVER-AUTHORED-01',
            disposition: 'absorbed',
            absorbed_by: 'ABSORBER-01',
          },
        ],
        resolver,
      ),
    ).toEqual([]);
  });

  it('blocks close when absorbed_by does not resolve', () => {
    const unresolved = findUnresolvedObligations(
      [
        {
          target_spec_id: 'PROPOSED-01',
          disposition: 'absorbed',
          absorbed_by: 'NEVER-AUTHORED-01',
        },
      ],
      resolver,
    );

    expect(unresolved).toHaveLength(1);
    // The field discriminator matters: an operator fixing target_spec_id when
    // absorbed_by is the broken reference is a real failure mode.
    expect(unresolved[0]?.field).toBe('absorbed_by');
  });

  it('blocks close on REGISTRY_UNAVAILABLE rather than downgrading to local-only', () => {
    const unresolved = findUnresolvedObligations(
      [{ target_spec_id: 'AUTHORED-TARGET-01', disposition: 'required' }],
      createSuccessorResolver(undefined),
    );

    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.outcome).toBe('REGISTRY_UNAVAILABLE');
  });

  it('reports every unresolved obligation, not just the first', () => {
    const unresolved = findUnresolvedObligations(
      [
        { target_spec_id: 'MISSING-A-01', disposition: 'required' },
        { target_spec_id: 'AUTHORED-TARGET-01', disposition: 'required' },
        { target_spec_id: 'MISSING-B-01', disposition: 'required' },
      ],
      resolver,
    );

    expect(unresolved.map((u) => u.target_spec_id)).toEqual(['MISSING-A-01', 'MISSING-B-01']);
  });

  it('returns no obligations for a spec with no successors', () => {
    expect(findUnresolvedObligations(undefined, resolver)).toEqual([]);
  });

  it('skips an absorbed entry whose absorbed_by is absent rather than crashing', () => {
    // The semantic layer rejects this shape, but the resolver must not
    // depend on having been called after it — a caller that resolves an
    // unvalidated spec gets no obligation, not a TypeError.
    expect(
      findUnresolvedObligations(
        [{ target_spec_id: 'PROPOSED-01', disposition: 'absorbed' }],
        resolver,
      ),
    ).toEqual([]);
  });

  it('does not resolve absorbed_by on a NON-absorbed disposition', () => {
    // A stray absorbed_by on a `declined` entry is not an obligation. Both
    // halves of the guard matter: disposition AND presence.
    expect(
      findUnresolvedObligations(
        [
          {
            target_spec_id: 'NEVER-AUTHORED-01',
            disposition: 'declined',
            rationale: 'not pursuing',
            absorbed_by: 'ALSO-NEVER-AUTHORED-01',
          },
        ],
        resolver,
      ),
    ).toEqual([]);
  });
});

describe('event projection preserves the whole declaration (A9)', () => {
  it('projects every entry with disposition, rationale, and absorbed_by intact', () => {
    const spec = parseShape(
      specWith(`successors:
  - target_spec_id: FIRST-TARGET-01
    disposition: required
    rationale: Carries the runtime wiring onward.
  - target_spec_id: SECOND-TARGET-01
    disposition: absorbed
    absorbed_by: ABSORBER-01
    rationale: Folded into the broader slice.`),
    );

    // A projection that keeps ids and drops rationale would pass a naive
    // "contains the target ids" test and destroy the audit record.
    expect(projectSuccessorsForEvent(spec)).toEqual([
      {
        target_spec_id: 'FIRST-TARGET-01',
        disposition: 'required',
        rationale: 'Carries the runtime wiring onward.',
      },
      {
        target_spec_id: 'SECOND-TARGET-01',
        disposition: 'absorbed',
        absorbed_by: 'ABSORBER-01',
        rationale: 'Folded into the broader slice.',
      },
    ]);
  });

  it('does not project target standing into the event', () => {
    const spec = parseShape(
      specWith(`successors:
  - target_spec_id: FIRST-TARGET-01
    disposition: required`),
    );

    const projected = projectSuccessorsForEvent(spec);
    // Standing is derivable from the target's own history; a copy here would
    // go stale the moment the target moved.
    expect(Object.keys(projected?.[0] ?? {}).sort()).toEqual(['disposition', 'target_spec_id']);
  });

  it('projects undefined for a spec with no successors', () => {
    const spec = parseShape(specWith(''));
    expect(projectSuccessorsForEvent(spec)).toBeUndefined();
  });
});

describe('additive schema change: existing specs are unaffected (A10)', () => {
  it('validates a spec with no successors field unchanged', () => {
    expect(isOk(parseAndValidateSpec(specWith('')))).toBe(true);
  });

  it('accepts an empty successors array', () => {
    expect(isOk(parseAndValidateSpec(specWith('successors: []')))).toBe(true);
  });
});
