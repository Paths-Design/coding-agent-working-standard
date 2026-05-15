// Slice 7a.5 — waiver-specific doctor rules.
//
// Asserts the four new rules and the surrounding contracts:
//
//   doctor.waiver.expired_active     — warning when status='active' but
//                                      expires_at <= now.
//   doctor.waiver.unknown_gate       — error if policy declares no such
//                                      gate; warning if policy is absent.
//   doctor.waiver.malformed_loaded   — passthrough of waiverDiagnostics
//                                      with severity inherited.
//   doctor.waiver.revoked_referenced — gate_evaluated.data.waiver_ids
//                                      cites a currently-revoked waiver.
//
// Doctor stays pure: no fs / path / env / Date.now / new Date imports;
// caller supplies `now` and the loaded waiver state.

import { readFileSync } from 'fs';
import { resolve } from 'path';

import { DOCTOR_RULES, inspectProjectState } from '../../src/doctor';
import type { DoctorInput } from '../../src/doctor';
import { prepareAppend } from '../../src/evidence';
import { isOk } from '../../src/result';
import type { Diagnostic } from '../../src/diagnostics/types';
import type { Policy } from '../../src/policy/types';
import type { Waiver } from '../../src/waiver/types';

const NOW = new Date('2026-05-15T12:00:00.000Z');
const FUTURE_AT = '2027-01-01T00:00:00.000Z';
const PAST_AT = '2025-01-01T00:00:00.000Z';

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    version: 1,
    risk_tiers: {
      '1': { max_files: 5, max_loc: 200 },
      '2': { max_files: 15, max_loc: 600 },
      '3': { max_files: 30, max_loc: 1500 },
    },
    gates: {
      budget_limit: { enabled: true, mode: 'block' },
      spec_completeness: { enabled: true, mode: 'block' },
      scope_boundary: { enabled: true, mode: 'warn' },
      god_object: { enabled: true, mode: 'warn' },
      todo_detection: { enabled: true, mode: 'warn' },
    },
    ...overrides,
  };
}

function baseInput(overrides: Partial<DoctorInput> = {}): DoctorInput {
  return {
    specs: [],
    policy: makePolicy(),
    now: NOW,
    ...overrides,
  };
}

function activeWaiver(overrides: Partial<Waiver> = {}): Waiver {
  return {
    id: 'WAIV-1',
    title: 'a waiver',
    status: 'active',
    gates: ['budget_limit'],
    reason: 'authorized',
    approved_by: 'lead@example.com',
    created_at: '2026-05-01T00:00:00.000Z',
    expires_at: FUTURE_AT,
    ...overrides,
  } as Waiver;
}

function revokedWaiver(overrides: Partial<Waiver> = {}): Waiver {
  return {
    id: 'WAIV-2',
    title: 'rescinded',
    status: 'revoked',
    gates: ['budget_limit'],
    reason: 'withdrawn',
    approved_by: 'lead@example.com',
    created_at: '2026-05-01T00:00:00.000Z',
    expires_at: FUTURE_AT,
    revocation: {
      revoked_at: '2026-05-10T00:00:00.000Z',
      reason: 'audit follow-up',
    },
    ...overrides,
  } as Waiver;
}

// =====================================================================
// 1. active+future expiry → no waiver finding
// =====================================================================
test('active waiver with future expires_at produces no waiver finding', () => {
  const r = inspectProjectState(
    baseInput({ waivers: [activeWaiver({ expires_at: FUTURE_AT })] })
  );
  const waiverFindings = r.findings.filter((f) =>
    f.rule.startsWith('doctor.waiver.')
  );
  expect(waiverFindings).toEqual([]);
});

// =====================================================================
// 2. active+past expiry → expired_active warning
// =====================================================================
test('active waiver with past expires_at → doctor.waiver.expired_active warning', () => {
  const r = inspectProjectState(
    baseInput({
      waivers: [activeWaiver({ id: 'WAIV-EXP-1', expires_at: PAST_AT })],
    })
  );
  const expired = r.findings.filter(
    (f) => f.rule === DOCTOR_RULES.WAIVER_EXPIRED_ACTIVE
  );
  expect(expired).toHaveLength(1);
  expect(expired[0].severity).toBe('warning');
  expect(expired[0].subject).toBe('WAIV-EXP-1');
  expect(expired[0].data?.expires_at).toBe(PAST_AT);
  // Severity is warning, so doctor stays clean (no errors).
  expect(r.summary.errors).toBe(0);
  expect(r.clean).toBe(true);
});

// =====================================================================
// 3. revoked waiver with future expiry does NOT trigger expired_active
// =====================================================================
test('revoked waiver does not produce expired_active even if expires_at is past', () => {
  const r = inspectProjectState(
    baseInput({
      waivers: [
        revokedWaiver({ id: 'WAIV-REV-PAST-1', expires_at: PAST_AT }),
      ],
    })
  );
  const expired = r.findings.filter(
    (f) => f.rule === DOCTOR_RULES.WAIVER_EXPIRED_ACTIVE
  );
  expect(expired).toEqual([]);
});

// =====================================================================
// 4. unknown gate + policy present → error
// =====================================================================
test('waiver with unknown gate + policy loaded → doctor.waiver.unknown_gate error', () => {
  const r = inspectProjectState(
    baseInput({
      waivers: [activeWaiver({ id: 'WAIV-UG-1', gates: ['ghost_gate'] })],
    })
  );
  const unknown = r.findings.filter(
    (f) => f.rule === DOCTOR_RULES.WAIVER_UNKNOWN_GATE
  );
  expect(unknown).toHaveLength(1);
  expect(unknown[0].severity).toBe('error');
  expect(unknown[0].subject).toBe('WAIV-UG-1');
  expect(unknown[0].data?.gate).toBe('ghost_gate');
  expect(unknown[0].data?.policy_loaded).toBe(true);
  expect(r.summary.errors).toBe(1);
  expect(r.clean).toBe(false);
});

test('waiver with unknown gate + NO policy → doctor.waiver.unknown_gate warning', () => {
  // No policy in input → doctor cannot authoritatively compare.
  const r = inspectProjectState({
    specs: [],
    now: NOW,
    waivers: [
      activeWaiver({ id: 'WAIV-UGW-1', gates: ['budget_limit', 'ghost'] }),
    ],
  });
  const unknown = r.findings.filter(
    (f) => f.rule === DOCTOR_RULES.WAIVER_UNKNOWN_GATE
  );
  expect(unknown).toHaveLength(1);
  expect(unknown[0].severity).toBe('warning');
  expect(unknown[0].data?.policy_loaded).toBe(false);
});

// =====================================================================
// 5. malformed waiver file → malformed_loaded passthrough
// =====================================================================
test('waiverDiagnostics flow through as doctor.waiver.malformed_loaded with severity preserved', () => {
  const diag: Diagnostic = {
    rule: 'waiver.schema.invalid_id',
    authority: 'kernel/waiver',
    severity: 'error',
    message: 'Waiver id must match regex (got "lowercase-bad").',
    subject: '/abs/.caws/waivers/bad.yaml',
  };
  const r = inspectProjectState(
    baseInput({
      waiverDiagnostics: [diag],
    })
  );
  const malformed = r.findings.filter(
    (f) => f.rule === DOCTOR_RULES.WAIVER_MALFORMED_LOADED
  );
  expect(malformed).toHaveLength(1);
  expect(malformed[0].severity).toBe('error');
  expect(malformed[0].subject).toBe('/abs/.caws/waivers/bad.yaml');
  expect(malformed[0].message).toMatch(/lowercase-bad/);
  // The original diagnostic source rule is preserved in `data` so the shell
  // can show "kernel/waiver said X" without losing provenance.
  expect(malformed[0].data?.source_rule).toBe('waiver.schema.invalid_id');
  expect(malformed[0].data?.source_authority).toBe('kernel/waiver');
});

// =====================================================================
// 6. valid waiver sibling preserved when another file is malformed
// =====================================================================
test('a valid waiver still appears in input alongside malformed_loaded findings', () => {
  // The shell loader contract is: malformed waiver → diagnostic, valid
  // siblings → still in waivers[]. Doctor consumes both inputs and emits
  // findings for each surface independently.
  const valid = activeWaiver({ id: 'WAIV-OK-1', expires_at: FUTURE_AT });
  const diag: Diagnostic = {
    rule: 'waiver.schema.invalid_status',
    authority: 'kernel/waiver',
    severity: 'error',
    message: 'Waiver status must be active or revoked.',
    subject: '/abs/.caws/waivers/bad.yaml',
  };

  const r = inspectProjectState(
    baseInput({ waivers: [valid], waiverDiagnostics: [diag] })
  );
  const malformed = r.findings.filter(
    (f) => f.rule === DOCTOR_RULES.WAIVER_MALFORMED_LOADED
  );
  expect(malformed).toHaveLength(1);
  // The valid waiver is well-formed and gate-known; it produces no
  // waiver-specific finding of its own.
  const validFindings = r.findings.filter(
    (f) =>
      f.rule.startsWith('doctor.waiver.') &&
      f.rule !== DOCTOR_RULES.WAIVER_MALFORMED_LOADED
  );
  expect(validFindings).toEqual([]);
});

// =====================================================================
// 7. revoked waiver referenced by gate_evaluated → revoked_referenced
// =====================================================================
test('revoked waiver referenced by gate_evaluated.waiver_ids → doctor.waiver.revoked_referenced', () => {
  const revoked = revokedWaiver({ id: 'WAIV-RR-1' });
  // Build a real chained event so the chain math passes; we use
  // prepareAppend + emptyChain so the event is well-formed.
  const append = prepareAppend(null, {
    event: 'gate_evaluated',
    ts: NOW.toISOString(),
    actor: { kind: 'agent', id: 'darian' },
    spec_id: 'FOO-1',
    data: {
      gate_id: 'budget_limit',
      mode: 'block',
      result: 'pass',
      violations: [],
      waived_count: 1,
      waiver_ids: ['WAIV-RR-1'],
    },
  });
  if (!isOk(append)) throw new Error('unreachable');

  const r = inspectProjectState(
    baseInput({
      waivers: [revoked],
      events: [append.value],
    })
  );
  const refd = r.findings.filter(
    (f) => f.rule === DOCTOR_RULES.WAIVER_REVOKED_REFERENCED
  );
  expect(refd).toHaveLength(1);
  expect(refd[0].severity).toBe('warning');
  expect(refd[0].subject).toBe('WAIV-RR-1');
  expect(refd[0].data?.first_event_seq).toBe(1);
  expect(refd[0].data?.revoked_at).toBe('2026-05-10T00:00:00.000Z');
});

// =====================================================================
// 8. non-revoked referenced waiver produces no revoked_referenced
// =====================================================================
test('an active referenced waiver does NOT produce revoked_referenced', () => {
  const active = activeWaiver({ id: 'WAIV-AR-1' });
  const append = prepareAppend(null, {
    event: 'gate_evaluated',
    ts: NOW.toISOString(),
    actor: { kind: 'agent', id: 'darian' },
    spec_id: 'FOO-1',
    data: {
      gate_id: 'budget_limit',
      mode: 'block',
      result: 'pass',
      violations: [],
      waived_count: 1,
      waiver_ids: ['WAIV-AR-1'],
    },
  });
  if (!isOk(append)) throw new Error('unreachable');

  const r = inspectProjectState(
    baseInput({ waivers: [active], events: [append.value] })
  );
  const refd = r.findings.filter(
    (f) => f.rule === DOCTOR_RULES.WAIVER_REVOKED_REFERENCED
  );
  expect(refd).toEqual([]);
});

// =====================================================================
// 9. doctor remains pure — no fs/path/env/clock imports
// =====================================================================
test('doctor source has no fs/path/env/Date.now/new Date references in executable code', () => {
  // Read the kernel doctor sources and assert that they contain no
  // executable references to file I/O, process state, or wall-clock
  // reads. We strip line and block comments first so doc strings that
  // *describe* the discipline (e.g. "no Date.now() — `now` is injected")
  // do not register as violations.
  function stripComments(src: string): string {
    // Block comments first (they may span lines).
    const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
    // Then line comments.
    return noBlock
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
  }

  const files = ['../../src/doctor/inspect.ts', '../../src/doctor/types.ts'];
  for (const rel of files) {
    const src = stripComments(readFileSync(resolve(__dirname, rel), 'utf8'));
    expect(src).not.toMatch(/from ['"]fs['"]/);
    expect(src).not.toMatch(/from ['"]node:fs['"]/);
    expect(src).not.toMatch(/from ['"]path['"]/);
    expect(src).not.toMatch(/from ['"]node:path['"]/);
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/process\.cwd/);
    expect(src).not.toMatch(/Date\.now\s*\(/);
    expect(src).not.toMatch(/new\s+Date\s*\(\s*\)/);
  }
});

// =====================================================================
// 10. existing doctor rules still pass when waivers are absent
// =====================================================================
test('with no waivers and no waiverDiagnostics, existing doctor behavior is unchanged', () => {
  // Sanity smoke: running inspectProjectState against an empty input
  // should not produce ANY doctor.waiver.* finding even though the
  // policy is loaded.
  const r = inspectProjectState(baseInput());
  const waiverFindings = r.findings.filter((f) =>
    f.rule.startsWith('doctor.waiver.')
  );
  expect(waiverFindings).toEqual([]);
});
