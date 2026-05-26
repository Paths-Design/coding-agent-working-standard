// Tests for v10 read-side compatibility in validateChainedEvent.
//
// Slice: KERNEL-EVENT-V10-COMPAT-ALIAS-001
// Acceptance criteria covered: A1, A2 (subset via this module's validator
// only — full A2 via events-store; covered in tests/store/events-store-v10-compat.test.js
// after this kernel ships), A4, A5.
//
// The Sterling-shape fixture mirrors the on-disk seq 117-119 entries in
// the canonical v10->v11 migrant repo that motivated this compat alias.
// All field shapes are taken verbatim from those entries.

import {
  EVIDENCE_RULES,
  validateChainedEvent,
  type Hash,
} from '../../src/evidence';
import { isErr, isOk } from '../../src/result';

const HASH_A: Hash = ('sha256:' + 'a'.repeat(64)) as Hash;
const HASH_B: Hash = ('sha256:' + 'b'.repeat(64)) as Hash;
const HASH_C: Hash = ('sha256:' + 'c'.repeat(64)) as Hash;

/**
 * Sterling-shape v10 validation_completed entry. Modeled exactly on the
 * production events.jsonl seq 117-119 shape that surfaced the kernel
 * read-side incompatibility.
 *
 * Distinctive v10 features:
 *   - actor is a STRING ('cli'), not an object
 *   - session_id lives at the TOP LEVEL, not nested in actor.session_id
 *   - event is the literal 'validation_completed' (renamed in v11)
 */
const legacyValidationCompleted = (over: Record<string, unknown> = {}) => ({
  seq: 117,
  ts: '2026-05-26T21:25:04.659Z',
  session_id: 'standalone',
  actor: 'cli',
  event: 'validation_completed',
  spec_id: 'DOC-RECON-AUDIT-RETIREMENT-EXECUTE-01',
  data: {
    passed: true,
    compliance_score: 0.7,
    grade: 'C',
    error_count: 0,
    warning_count: 3,
  },
  prev_hash: HASH_A,
  event_hash: HASH_B,
  ...over,
});

describe('validateChainedEvent — v10 validation_completed compat (A1)', () => {
  it('accepts the canonical Sterling-shape legacy entry verbatim', () => {
    const r = validateChainedEvent(legacyValidationCompleted());
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;

    // I4: the returned value is the input verbatim — no normalization.
    // The string actor and top-level session_id are preserved (which is
    // what makes the original v10-writer-computed event_hash valid).
    const value = r.value as unknown as Record<string, unknown>;
    expect(value['actor']).toBe('cli');
    expect(value['session_id']).toBe('standalone');
    expect(value['event']).toBe('validation_completed');
    expect(value['seq']).toBe(117);
    expect(value['prev_hash']).toBe(HASH_A);
    expect(value['event_hash']).toBe(HASH_B);
  });

  it('accepts a legacy entry with null prev_hash (genesis-position)', () => {
    const r = validateChainedEvent(legacyValidationCompleted({ seq: 1, prev_hash: null }));
    expect(isOk(r)).toBe(true);
  });

  it('preserves the legacy entry sandwiched between v11 entries (chain interleave)', () => {
    // This is the canonical A1 scenario: a v10 event preceded and followed
    // by v11 entries in the same log. Each entry validates independently
    // against its appropriate schema.
    const v11Before = {
      seq: 116,
      ts: '2026-05-26T21:24:00.000Z',
      actor: { kind: 'agent' as const, id: 'caws-test' },
      event: 'spec_created',
      spec_id: 'FOO-1',
      data: { title: 't', risk_tier: 3, mode: 'chore', lifecycle_state: 'active' },
      prev_hash: HASH_C,
      event_hash: HASH_A,
    };
    const v11After = {
      seq: 118,
      ts: '2026-05-26T21:26:00.000Z',
      actor: { kind: 'agent' as const, id: 'caws-test' },
      event: 'worktree_created',
      data: {
        name: 'wt-x',
        branch: 'wt-x',
        base_branch: 'main',
        path: '/tmp/wt-x',
        owner_session_id: 'caws-test',
      },
      prev_hash: HASH_B,
      event_hash: HASH_C,
    };

    expect(isOk(validateChainedEvent(v11Before))).toBe(true);
    expect(isOk(validateChainedEvent(legacyValidationCompleted()))).toBe(true);
    expect(isOk(validateChainedEvent(v11After))).toBe(true);
  });

  it('does not lift session_id from top level into a synthesized actor object', () => {
    // I4: no normalization. The compat path must not silently convert
    // { actor: 'cli', session_id: 'standalone' } into
    // { actor: { kind: 'cli', id: '?', session_id: 'standalone' } } —
    // that would change the bytes that hash to event_hash.
    const r = validateChainedEvent(legacyValidationCompleted());
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const value = r.value as unknown as Record<string, unknown>;
    expect(typeof value['actor']).toBe('string');
    expect(value['actor']).toBe('cli');
  });
});

describe('validateChainedEvent — v10 compat rejects malformed entries (A5)', () => {
  it('rejects when data.passed is missing', () => {
    const r = validateChainedEvent(
      legacyValidationCompleted({
        data: {
          compliance_score: 0.7,
          grade: 'C',
          error_count: 0,
          warning_count: 3,
          // passed: missing
        },
      })
    );
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.errors.length).toBeGreaterThan(0);
    // The legacyCompat tag should appear on every diagnostic from this
    // path so observers can distinguish v10 rejections from v11 ones.
    for (const e of r.errors) {
      expect((e.data as Record<string, unknown>)?.['legacyCompat']).toBe(
        'validation_completed.v1'
      );
    }
  });

  it('rejects an invalid grade enum value', () => {
    const r = validateChainedEvent(
      legacyValidationCompleted({
        data: {
          passed: true,
          compliance_score: 0.7,
          grade: 'X', // not in [A,B,C,D,F]
          error_count: 0,
          warning_count: 3,
        },
      })
    );
    expect(isErr(r)).toBe(true);
  });

  it('rejects when actor is the wrong type (object instead of string)', () => {
    // The v10 actor MUST be a string per the compat schema. A caller that
    // attempts to slip a v11-shaped actor under the v10 event name is
    // rejected — the compat path is narrow, not a general bypass.
    const r = validateChainedEvent(
      legacyValidationCompleted({
        actor: { kind: 'agent', id: 'caws-test' },
      })
    );
    expect(isErr(r)).toBe(true);
  });

  it('rejects when ts is not an ISO date-time string', () => {
    const r = validateChainedEvent(legacyValidationCompleted({ ts: 'last tuesday' }));
    expect(isErr(r)).toBe(true);
  });

  it('rejects when prev_hash is malformed', () => {
    const r = validateChainedEvent(legacyValidationCompleted({ prev_hash: 'not-a-hash' }));
    expect(isErr(r)).toBe(true);
  });

  it('rejects when event_hash is malformed', () => {
    const r = validateChainedEvent(legacyValidationCompleted({ event_hash: 'sha256:tooshort' }));
    expect(isErr(r)).toBe(true);
  });

  it('rejects when spec_id is missing (validation_completed is spec-scoped)', () => {
    const noSpec = legacyValidationCompleted();
    delete (noSpec as Record<string, unknown>)['spec_id'];
    const r = validateChainedEvent(noSpec);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    // The spec_id check should fire — it's a v11 invariant (REQUIRES_SPEC_ID
    // class) that v10 events MUST still honor because the underlying
    // semantic is unchanged.
    const hasSpecIdRule = r.errors.some(
      (e) => e.rule === EVIDENCE_RULES.EVENT_SPEC_ID_REQUIRED
    );
    expect(hasSpecIdRule).toBe(true);
  });

  it('rejects unknown extra top-level fields (compat schema is closed)', () => {
    const r = validateChainedEvent(legacyValidationCompleted({ extra: 'not allowed' }));
    expect(isErr(r)).toBe(true);
  });
});

describe('validateChainedEvent — v11 path unchanged when event is not validation_completed', () => {
  it('a canonical v11 spec_validated event still validates through the v11 path', () => {
    // Belt-and-suspenders: ensure the legacy pre-pass does NOT intercept
    // v11 events. spec_validated is the v11 name for validation_completed;
    // a real spec_validated event must NOT trigger the compat schema.
    const v11SpecValidated = {
      seq: 100,
      ts: '2026-05-26T21:24:00.000Z',
      actor: { kind: 'agent' as const, id: 'caws-test' },
      event: 'spec_validated',
      spec_id: 'FOO-1',
      data: { passed: true, error_count: 0, warning_count: 0 },
      prev_hash: HASH_A,
      event_hash: HASH_B,
    };
    const r = validateChainedEvent(v11SpecValidated);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    // v11 actor object is preserved
    expect(r.value.actor).toEqual({ kind: 'agent', id: 'caws-test' });
  });

  it('an unrecognized event name (not validation_completed, not in v11 enum) still fails', () => {
    const r = validateChainedEvent({
      seq: 1,
      ts: '2026-05-26T21:24:00.000Z',
      actor: { kind: 'agent', id: 'caws-test' },
      event: 'made_up_event',
      data: {},
      prev_hash: null,
      event_hash: HASH_A,
    });
    expect(isErr(r)).toBe(true);
  });
});

describe('A4 — no internal code path emits validation_completed', () => {
  // This is a static-evidence test: grep the kernel src for new writes
  // of validation_completed. The schema file references the string
  // (that's expected); the validate.ts file references it as the
  // discriminator (that's expected). Any OTHER reference is a regression.
  //
  // Note: this test is observational. It does not exhaustively prove
  // there is no runtime path — that's the job of the
  // packages/caws-cli/tests/store/events-store-v10-compat.test.js
  // assertion that a fresh write goes out as spec_validated. This test
  // catches the most obvious regression class (a developer typing
  // 'validation_completed' in a new writer).

  it('no kernel module other than validate.ts and schemas/events/validation_completed.v1.json references the string', () => {
    const fs = require('fs');
    const path = require('path');

    const kernelSrcRoot = path.resolve(__dirname, '..', '..', 'src');
    const allowedFiles = new Set([
      path.join(kernelSrcRoot, 'evidence', 'validate.ts'),
      path.join(kernelSrcRoot, 'schemas', 'events', 'validation_completed.v1.json'),
    ]);

    const matches: string[] = [];

    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!/\.(ts|json)$/.test(entry.name)) continue;
        const content = fs.readFileSync(full, 'utf8');
        if (content.includes('validation_completed') && !allowedFiles.has(full)) {
          matches.push(full);
        }
      }
    }
    walk(kernelSrcRoot);

    expect(matches).toEqual([]);
  });
});
