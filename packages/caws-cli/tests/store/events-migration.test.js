/**
 * Tests for events-migration — CAWS-MIGRATE-V10-EVENTS-001 A9.
 *
 * Pure module: no filesystem I/O, no shell parsing, no rotateEvents calls.
 * The detector + planner here form the dry-run brain that A10's shell
 * command will invoke; the apply path runs through rotateEvents
 * (events-store.ts), not through this module.
 *
 * Coverage:
 *   - detectEventsLogShape: every EventsLogKind (all_v10, all_v11,
 *     mixed_v10_v11, empty, unparseable_only), tail-hash + tail-seq
 *     extraction, NEVER calls validateChainedEvent (proven by feeding
 *     a deliberately envelope-invalid line that still classifies by
 *     actor shape).
 *   - detectV10SpecsPresent: empty input, v10-only, v11-only, mixed,
 *     unclassifiable.
 *   - planEventsRotation: each refusal cause, each happy path, and
 *     three precedence cases that pin the ordering invariants.
 */

'use strict';

const {
  detectEventsLogShape,
  detectV10SpecsPresent,
  planEventsRotation,
  MIGRATION_RULES,
} = require('../../dist/store/events-migration');

// ──────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────

const FIXED_DATE = new Date('2026-05-22T23:15:00.000Z');

const v10Line = (seq, hashSeed = String(seq)) =>
  JSON.stringify({
    seq,
    ts: '2026-04-11T01:00:00.000Z',
    session_id: 'standalone',
    actor: 'cli',
    event: 'validation_completed',
    spec_id: 'X-1',
    data: { passed: true },
    prev_hash: '',
    event_hash: 'sha256:' + hashSeed.padStart(64, '0'),
  });

const v11Line = (seq, hashSeed = String(seq)) =>
  JSON.stringify({
    seq,
    ts: '2026-05-22T10:00:00.000Z',
    actor: { kind: 'agent', id: 'darian', session_id: 'sess-1' },
    event: 'spec_created',
    spec_id: 'X-1',
    data: {
      title: 't',
      risk_tier: 2,
      mode: 'feature',
      lifecycle_state: 'draft',
    },
    prev_hash: '',
    event_hash: 'sha256:' + hashSeed.padStart(64, '0'),
  });

const joinLines = (lines) => lines.join('\n') + '\n';

// ──────────────────────────────────────────────────────────────────────
// detectEventsLogShape — every EventsLogKind
// ──────────────────────────────────────────────────────────────────────

describe('detectEventsLogShape — classification', () => {
  it('classifies all-v10 input correctly', () => {
    const raw = joinLines([v10Line(1), v10Line(2), v10Line(3)]);
    const r = detectEventsLogShape(raw);
    expect(r.ok).toBe(true);
    expect(r.value.kind).toBe('all_v10');
    expect(r.value.stats).toEqual({
      v10_string_actor: 3,
      v11_object_actor: 0,
      unparseable: 0,
    });
    expect(r.value.lineCount).toBe(3);
  });

  it('classifies all-v11 input correctly', () => {
    const raw = joinLines([v11Line(1), v11Line(2)]);
    const r = detectEventsLogShape(raw);
    expect(r.ok).toBe(true);
    expect(r.value.kind).toBe('all_v11');
    expect(r.value.stats).toEqual({
      v10_string_actor: 0,
      v11_object_actor: 2,
      unparseable: 0,
    });
  });

  it('classifies mixed v10/v11 input correctly', () => {
    const raw = joinLines([v10Line(1), v11Line(2), v10Line(3)]);
    const r = detectEventsLogShape(raw);
    expect(r.ok).toBe(true);
    expect(r.value.kind).toBe('mixed_v10_v11');
    expect(r.value.stats).toEqual({
      v10_string_actor: 2,
      v11_object_actor: 1,
      unparseable: 0,
    });
  });

  it('returns Err with EMPTY_INPUT on empty input', () => {
    const r = detectEventsLogShape('');
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(MIGRATION_RULES.EMPTY_INPUT);
  });

  it('returns Err with EMPTY_INPUT on whitespace-only input', () => {
    const r = detectEventsLogShape('\n\n\n');
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(MIGRATION_RULES.EMPTY_INPUT);
  });

  it('classifies unparseable_only input', () => {
    const r = detectEventsLogShape('not json\nstill not json\n');
    expect(r.ok).toBe(true);
    expect(r.value.kind).toBe('unparseable_only');
    expect(r.value.stats).toEqual({
      v10_string_actor: 0,
      v11_object_actor: 0,
      unparseable: 2,
    });
  });

  it('mixed parseable + unparseable still classifies by actor shape (does NOT validateChainedEvent)', () => {
    // The first line is JSON but lacks the v11 envelope fields a
    // strict validator would require (no seq, no ts, no data). Yet
    // the actor field is a structured object with kind, so the
    // detector classifies it as v11 — proving classification is
    // by actor shape inspection, not by validateChainedEvent.
    const oddV11 = JSON.stringify({
      actor: { kind: 'agent', id: 'x' },
      event: 'spec_created',
    });
    // Second line is genuine v10.
    const raw = joinLines([oddV11, v10Line(2)]);
    const r = detectEventsLogShape(raw);
    expect(r.ok).toBe(true);
    expect(r.value.kind).toBe('mixed_v10_v11');
    expect(r.value.stats).toEqual({
      v10_string_actor: 1,
      v11_object_actor: 1,
      unparseable: 0,
    });
  });

  it('lines with null or non-object actor go to unparseable bucket', () => {
    const nullActor = JSON.stringify({ actor: null, event: 'x' });
    const arrayActor = JSON.stringify({ actor: ['a', 'b'], event: 'x' });
    const r = detectEventsLogShape(joinLines([nullActor, arrayActor]));
    expect(r.ok).toBe(true);
    expect(r.value.stats.unparseable).toBe(2);
    expect(r.value.stats.v10_string_actor).toBe(0);
    expect(r.value.stats.v11_object_actor).toBe(0);
    expect(r.value.kind).toBe('unparseable_only');
  });

  it('handles input without a trailing newline', () => {
    const raw = v10Line(1) + '\n' + v10Line(2); // no trailing \n
    const r = detectEventsLogShape(raw);
    expect(r.ok).toBe(true);
    expect(r.value.lineCount).toBe(2);
    expect(r.value.kind).toBe('all_v10');
  });
});

describe('detectEventsLogShape — tail extraction', () => {
  it('extracts the last lines event_hash and seq', () => {
    const raw = joinLines([v10Line(1, '11'), v10Line(2, '22'), v10Line(7, '77')]);
    const r = detectEventsLogShape(raw);
    expect(r.ok).toBe(true);
    expect(r.value.tailSeq).toBe(7);
    expect(r.value.tailHash).toBe(
      'sha256:' + '77'.padStart(64, '0')
    );
  });

  it('returns null tail fields when the last line is unparseable', () => {
    const raw = joinLines([v10Line(1)]) + 'not json\n';
    const r = detectEventsLogShape(raw);
    expect(r.ok).toBe(true);
    expect(r.value.tailHash).toBeNull();
    expect(r.value.tailSeq).toBeNull();
    expect(r.value.lineCount).toBe(2);
  });

  it('returns null when the last line parses but lacks event_hash or seq', () => {
    const noHash = JSON.stringify({
      actor: 'cli',
      event: 'x',
      // no event_hash, no seq
    });
    const raw = joinLines([v10Line(1), noHash]);
    const r = detectEventsLogShape(raw);
    expect(r.ok).toBe(true);
    expect(r.value.tailHash).toBeNull();
    expect(r.value.tailSeq).toBeNull();
  });

  it('rejects a malformed event_hash even if the rest of the line parses', () => {
    const badHash = JSON.stringify({
      actor: 'cli',
      event: 'x',
      seq: 5,
      event_hash: 'not-a-hash',
    });
    const r = detectEventsLogShape(joinLines([badHash]));
    expect(r.ok).toBe(true);
    expect(r.value.tailHash).toBeNull();
    expect(r.value.tailSeq).toBe(5);
  });
});

// ──────────────────────────────────────────────────────────────────────
// detectV10SpecsPresent
// ──────────────────────────────────────────────────────────────────────

describe('detectV10SpecsPresent', () => {
  it('returns detected: false on empty input', () => {
    const r = detectV10SpecsPresent([]);
    expect(r.detected).toBe(false);
    expect(r.v10Paths).toEqual([]);
    expect(r.v11Paths).toEqual([]);
    expect(r.unclassifiedPaths).toEqual([]);
  });

  it('classifies a v10-shape spec (type + status + acceptance_criteria)', () => {
    const v10Spec = `id: FOO-1
type: feature
status: active
acceptance_criteria:
  - AC-1: works
`;
    const r = detectV10SpecsPresent([{ path: 'a.yaml', raw: v10Spec }]);
    expect(r.detected).toBe(true);
    expect(r.v10Paths).toEqual(['a.yaml']);
    expect(r.v11Paths).toEqual([]);
    expect(r.unclassifiedPaths).toEqual([]);
  });

  it('classifies a v11-shape spec (mode + lifecycle_state + acceptance)', () => {
    const v11Spec = `id: FOO-1
mode: feature
lifecycle_state: active
acceptance:
  - id: A1
    given: x
    when: y
    then: z
`;
    const r = detectV10SpecsPresent([{ path: 'b.yaml', raw: v11Spec }]);
    expect(r.detected).toBe(false);
    expect(r.v10Paths).toEqual([]);
    expect(r.v11Paths).toEqual(['b.yaml']);
  });

  it('classifies mixed input: v10 and v11 specs', () => {
    const v10 = 'type: feature\nstatus: active\n';
    const v11 = 'mode: feature\nlifecycle_state: active\n';
    const r = detectV10SpecsPresent([
      { path: 'old.yaml', raw: v10 },
      { path: 'new.yaml', raw: v11 },
    ]);
    expect(r.detected).toBe(true);
    expect(r.v10Paths).toEqual(['old.yaml']);
    expect(r.v11Paths).toEqual(['new.yaml']);
  });

  it('a single v10 signal wins over coexisting v11 keys (mixed-shape spec is v10)', () => {
    // Belt-and-suspenders: if a spec carries both, treat as v10 so
    // the migration command refuses on it; specs migration owns the
    // mixed-shape resolution.
    const mixed = `id: BAD-1
type: feature
mode: feature
status: active
lifecycle_state: active
`;
    const r = detectV10SpecsPresent([{ path: 'mixed.yaml', raw: mixed }]);
    expect(r.detected).toBe(true);
    expect(r.v10Paths).toEqual(['mixed.yaml']);
  });

  it('files with no signal go to unclassifiedPaths', () => {
    const r = detectV10SpecsPresent([
      { path: 'empty.yaml', raw: '' },
      { path: 'comment-only.yaml', raw: '# just a comment\n' },
    ]);
    expect(r.detected).toBe(false);
    expect(r.unclassifiedPaths).toEqual(['empty.yaml', 'comment-only.yaml']);
  });

  it('only matches at column 0 (avoids comment false positives)', () => {
    // The v10/v11 detector uses ^key:/m, anchored at line start.
    // A `type:` appearing in a comment or indented sub-key is ignored.
    const fakeV10 = `id: FAKE-1
mode: feature
lifecycle_state: active
# This spec mentions type: feature in a comment but is v11.
description:
  things:
    type: not-a-top-level-key
`;
    const r = detectV10SpecsPresent([{ path: 'fake.yaml', raw: fakeV10 }]);
    // The `type:` under `things:` is indented (4 spaces), so ^type:
    // doesn't match. The v11 keys do. Detected as v11.
    expect(r.detected).toBe(false);
    expect(r.v11Paths).toEqual(['fake.yaml']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// planEventsRotation — refusal causes and happy paths
// ──────────────────────────────────────────────────────────────────────

describe('planEventsRotation — happy path', () => {
  it('returns a rotate plan for all_v10 input with no v10 specs', () => {
    const detection = detectEventsLogShape(
      joinLines([v10Line(1), v10Line(2)])
    ).value;
    const p = planEventsRotation(detection, {
      reason: 'v10 → v11 migration',
      now: FIXED_DATE,
    });
    expect(p.kind).toBe('rotate');
    expect(p.reason).toBe('v10 → v11 migration');
    expect(p.allowClean).toBe(false);
    expect(p.proposedArchiveName).toBe(
      'events.jsonl.archive-2026-05-22T23-15-00-000Z'
    );
    expect(p.detection).toBe(detection);
  });

  it('returns a rotate plan for all_v10 with v10 specs + allowPartialUpgrade: true', () => {
    const detection = detectEventsLogShape(joinLines([v10Line(1)])).value;
    const v10Specs = detectV10SpecsPresent([
      { path: 'old.yaml', raw: 'type: feature\nstatus: active\n' },
    ]);
    const p = planEventsRotation(detection, {
      reason: 'explicit partial upgrade',
      now: FIXED_DATE,
      v10Specs,
      allowPartialUpgrade: true,
    });
    expect(p.kind).toBe('rotate');
    expect(p.v10Specs).toBe(v10Specs); // pass-through for the reporter
  });

  it('returns a rotate plan for clean v11 chain with allowClean: true', () => {
    const detection = detectEventsLogShape(joinLines([v11Line(1)])).value;
    const p = planEventsRotation(detection, {
      reason: 'operator chose clean rotation',
      now: FIXED_DATE,
      allowClean: true,
    });
    expect(p.kind).toBe('rotate');
    expect(p.allowClean).toBe(true);
  });

  it('archive name is deterministic for the same now value', () => {
    const detection = detectEventsLogShape(joinLines([v10Line(1)])).value;
    const p1 = planEventsRotation(detection, {
      reason: 'r',
      now: FIXED_DATE,
    });
    const p2 = planEventsRotation(detection, {
      reason: 'r',
      now: FIXED_DATE,
    });
    expect(p1.kind).toBe('rotate');
    expect(p2.kind).toBe('rotate');
    expect(p1.proposedArchiveName).toBe(p2.proposedArchiveName);
  });
});

describe('planEventsRotation — refusals', () => {
  it('refuses unparseable_only with UNPARSEABLE_INPUT', () => {
    const detection = detectEventsLogShape('not json\nstill not\n').value;
    const p = planEventsRotation(detection, {
      reason: 'x',
      now: FIXED_DATE,
    });
    expect(p.kind).toBe('refuse');
    expect(p.cause).toBe('unparseable_only');
    expect(p.diagnostic.rule).toBe(MIGRATION_RULES.UNPARSEABLE_INPUT);
  });

  it('refuses when v10 specs detected and allowPartialUpgrade omitted', () => {
    const detection = detectEventsLogShape(joinLines([v10Line(1)])).value;
    const v10Specs = detectV10SpecsPresent([
      { path: 'old.yaml', raw: 'type: feature\nstatus: active\n' },
      { path: 'older.yaml', raw: 'type: fix\nstatus: closed\n' },
    ]);
    const p = planEventsRotation(detection, {
      reason: 'x',
      now: FIXED_DATE,
      v10Specs,
    });
    expect(p.kind).toBe('refuse');
    expect(p.cause).toBe('v10_specs_require_allow_partial_upgrade');
    expect(p.diagnostic.rule).toBe(MIGRATION_RULES.V10_SPEC_DETECTED);
    // Names every offending file for the operator.
    expect(p.diagnostic.message).toContain('old.yaml');
    expect(p.diagnostic.message).toContain('older.yaml');
    expect(p.diagnostic.narrowRepair).toContain('--allow-partial-upgrade');
  });

  it('refuses when v10 specs detected and allowPartialUpgrade explicitly false', () => {
    const detection = detectEventsLogShape(joinLines([v10Line(1)])).value;
    const v10Specs = detectV10SpecsPresent([
      { path: 'old.yaml', raw: 'type: feature\nstatus: active\n' },
    ]);
    const p = planEventsRotation(detection, {
      reason: 'x',
      now: FIXED_DATE,
      v10Specs,
      allowPartialUpgrade: false,
    });
    expect(p.kind).toBe('refuse');
    expect(p.cause).toBe('v10_specs_require_allow_partial_upgrade');
  });

  it('refuses clean v11 chain when allowClean is omitted', () => {
    const detection = detectEventsLogShape(joinLines([v11Line(1)])).value;
    const p = planEventsRotation(detection, {
      reason: 'x',
      now: FIXED_DATE,
    });
    expect(p.kind).toBe('refuse');
    expect(p.cause).toBe('clean_chain_requires_allow_clean');
    expect(p.diagnostic.rule).toBe(
      'store.events.rotate.clean_chain_requires_allow_clean'
    );
  });

  it('does NOT trigger the half-upgrade refusal when v10Specs is omitted', () => {
    // The planner only enforces the half-upgrade refusal when the caller
    // has supplied a scan result. If the caller didn't scan, the planner
    // trusts the operator (the shell decides whether to scan).
    const detection = detectEventsLogShape(joinLines([v10Line(1)])).value;
    const p = planEventsRotation(detection, {
      reason: 'x',
      now: FIXED_DATE,
      // v10Specs omitted on purpose
    });
    expect(p.kind).toBe('rotate');
  });
});

describe('planEventsRotation — refusal precedence', () => {
  it('unparseable_only beats v10-specs presence', () => {
    const detection = detectEventsLogShape('not json\nstill not\n').value;
    const v10Specs = detectV10SpecsPresent([
      { path: 'old.yaml', raw: 'type: feature\nstatus: active\n' },
    ]);
    const p = planEventsRotation(detection, {
      reason: 'x',
      now: FIXED_DATE,
      v10Specs,
    });
    expect(p.kind).toBe('refuse');
    expect(p.cause).toBe('unparseable_only');
  });

  it('v10-specs beats clean-chain friction flag', () => {
    // Even though the chain is clean v11 (would normally need
    // allowClean), the v10-specs refusal fires first because the
    // half-upgrade refusal has higher precedence.
    const detection = detectEventsLogShape(joinLines([v11Line(1)])).value;
    const v10Specs = detectV10SpecsPresent([
      { path: 'old.yaml', raw: 'type: feature\nstatus: active\n' },
    ]);
    const p = planEventsRotation(detection, {
      reason: 'x',
      now: FIXED_DATE,
      v10Specs,
      // both flags omitted
    });
    expect(p.kind).toBe('refuse');
    expect(p.cause).toBe('v10_specs_require_allow_partial_upgrade');
  });

  it('clean-chain friction is the lowest precedence refusal', () => {
    // No unparseable lines, no v10 specs supplied. Only allowClean
    // is missing for a clean v11 chain. The friction flag fires.
    const detection = detectEventsLogShape(joinLines([v11Line(1)])).value;
    const p = planEventsRotation(detection, {
      reason: 'x',
      now: FIXED_DATE,
    });
    expect(p.kind).toBe('refuse');
    expect(p.cause).toBe('clean_chain_requires_allow_clean');
  });
});
