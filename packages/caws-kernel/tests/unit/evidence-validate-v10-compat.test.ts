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

describe('Hardening (S1) — spec-id-class diagnostic redundancy', () => {
  it('produces EVENT_SPEC_ID_REQUIRED specifically (not just generic schema-required) when spec_id is missing', () => {
    // Locks the defense-in-depth between (a) the compat schema's
    // `required: ["spec_id"]` and (b) the `checkSpecIdClass('spec_validated', ...)`
    // call in validateLegacyV10ValidationCompleted. If a future mutation
    // changes the second-argument to an OPTIONAL_SPEC_ID class (e.g.,
    // 'worktree_created') or removes the call entirely, the schema's
    // `required` would still catch missing spec_id with a generic
    // diagnostic — but the specific EVENT_SPEC_ID_REQUIRED rule would
    // no longer fire, silently weakening the contract.
    const noSpec = legacyValidationCompleted();
    delete (noSpec as Record<string, unknown>)['spec_id'];
    const r = validateChainedEvent(noSpec);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;

    // The specific rule MUST appear — not just any schema rejection.
    const specIdRequired = r.errors.filter(
      (e) => e.rule === EVIDENCE_RULES.EVENT_SPEC_ID_REQUIRED
    );
    expect(specIdRequired.length).toBeGreaterThan(0);

    // And it MUST be tagged as a legacy-path diagnostic (came through
    // the compat function, not the v11 path).
    for (const e of specIdRequired) {
      expect((e.data as Record<string, unknown>)?.['legacyCompat']).toBe(
        'validation_completed.v1'
      );
    }
  });
});

describe('Hardening (S2) — I4 byte-identity / no-normalization', () => {
  it('returns the input by reference; no normalization happens', () => {
    // I4: "no normalization before hash verification." The v10-writer-
    // computed event_hash is only valid if the bytes that hash to it are
    // unchanged. Locking object identity prevents any future AJV reconfig
    // (coerceTypes: true, useDefaults: true, removeAdditional: true) from
    // silently mutating the input and breaking the hash invariant.
    const input = legacyValidationCompleted();
    const before = JSON.stringify(input);

    const r = validateChainedEvent(input);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;

    // Object identity: returned value IS the input. AJV configured without
    // any coercion/default/removal preserves this.
    expect(r.value as unknown).toBe(input);

    // Byte-identity: serialized form is unchanged. Belt to the suspenders
    // of object identity — if a future AJV reconfig defeats the ===
    // identity check via deep cloning, this byte check catches it.
    const after = JSON.stringify(r.value);
    expect(after).toBe(before);
  });

  it('preserves a v10 entry with no top-level session_id by reference', () => {
    // Variant of the identity check ensuring it does not depend on the
    // optional session_id field being present.
    const input = legacyValidationCompleted();
    delete (input as Record<string, unknown>)['session_id'];
    const before = JSON.stringify(input);

    const r = validateChainedEvent(input);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value as unknown).toBe(input);
    expect(JSON.stringify(r.value)).toBe(before);
  });
});

describe('Hardening (S3) — data block remains closed', () => {
  it('rejects unknown extra fields inside data and tags the diagnostic as legacyCompat', () => {
    // Compat schema has additionalProperties: false on the data block.
    // No test exercised this before, so a mutation removing it would
    // silently broaden the alias. Tests it now and asserts the legacyCompat
    // tag so the diagnostic provenance is also locked.
    const r = validateChainedEvent(
      legacyValidationCompleted({
        data: {
          passed: true,
          compliance_score: 0.7,
          grade: 'C',
          error_count: 0,
          warning_count: 3,
          surprise: 1, // not in the v10 data schema
        },
      })
    );
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    // At least one diagnostic must report the extra field and carry the
    // legacyCompat marker.
    const tagged = r.errors.filter(
      (e) => (e.data as Record<string, unknown>)?.['legacyCompat'] === 'validation_completed.v1'
    );
    expect(tagged.length).toBeGreaterThan(0);
  });
});

describe('Hardening (S4) — invalid spec_id pattern', () => {
  it('rejects a spec_id that does not match the v11 pattern', () => {
    // Compat schema enforces the same regex as v11. Tests this directly
    // so a mutation loosening the regex (e.g., to .* ) is caught.
    const r = validateChainedEvent(
      legacyValidationCompleted({ spec_id: 'lower-case-123' })
    );
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    // Either the schema-pattern path OR the EVENT_SPEC_ID_INVALID rule
    // should appear. Both are valid signals; we accept either.
    const hasPatternFailure = r.errors.some((e) => {
      const data = e.data as Record<string, unknown> | undefined;
      const ajvKw = (data?.['ajvKeyword'] as string | undefined) ?? '';
      return (
        e.rule === EVIDENCE_RULES.EVENT_SPEC_ID_INVALID ||
        ajvKw === 'pattern' ||
        (typeof e.subject === 'string' && e.subject.includes('spec_id'))
      );
    });
    expect(hasPatternFailure).toBe(true);
    // legacyCompat tag MUST be present on at least one diagnostic
    // (provenance for the compat path).
    const tagged = r.errors.filter(
      (e) => (e.data as Record<string, unknown>)?.['legacyCompat'] === 'validation_completed.v1'
    );
    expect(tagged.length).toBeGreaterThan(0);
  });

  it('rejects another pattern-violating spec_id (kebab-case)', () => {
    const r = validateChainedEvent(legacyValidationCompleted({ spec_id: 'foo-bar' }));
    expect(isErr(r)).toBe(true);
  });
});

describe('Hardening (C2) — session_id absence behavior (locked)', () => {
  it('accepts a legacy validation_completed without top-level session_id', () => {
    // Compat schema lists session_id in properties but NOT in required.
    // Locking the current behavior: absence is admitted. v10 may have
    // omitted session_id in some emitter paths; the Sterling fixture
    // always carries it but the schema deliberately does not require it.
    // If future evidence shows v10 always included session_id, this test
    // should be inverted and the schema should add session_id to required
    // — that is a deliberate decision, not a silent drift.
    const noSession = legacyValidationCompleted();
    delete (noSession as Record<string, unknown>)['session_id'];
    const r = validateChainedEvent(noSession);
    expect(isOk(r)).toBe(true);
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
