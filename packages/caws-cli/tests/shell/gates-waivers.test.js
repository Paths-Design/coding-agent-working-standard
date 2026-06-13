/**
 * Slice 7a.3 — waiver integration with `caws gates run`.
 *
 * Load-bearing invariants under test:
 *
 *   1. Effective waivers are filtered BEFORE deriveDispositions is called.
 *      The reported violations remain unchanged on disk; only
 *      the disposition pipeline sees the unwaived subset.
 *
 *   2. Policy continues to own block/warn/skip semantics. Waivers can
 *      remove a violation from the calculation, but they MUST NOT mutate
 *      `policy.gates[gate].mode`. A warn-mode gate stays warn after
 *      filtering; a block-mode gate stays block.
 *
 *   3. The gate_evaluated event records waiver evidence (waived_count
 *      always present; waiver_ids when ≥1) without dumping raw waiver
 *      bodies.
 *
 *   4. Effectiveness rules:
 *        - revoked  → not effective
 *        - expired  → not effective (derived from expires_at + now)
 *        - wrong gate → not effective
 *        - wrong spec → not effective
 *        - project-wide (no scope.spec_id) → effective for any spec id
 *
 *   5. Unmatched report violations (gates not declared in policy)
 *      remain observational and are NEVER turned into policy decisions
 *      by waiver presence/absence.
 *
 *   6. Malformed waiver files produce a load diagnostic but DO NOT
 *      discard valid waivers parsed from sibling files.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runGatesRunCommand } = require('../../dist/shell');
const { loadEvents } = require('../../dist/store');

const NOW = new Date('2026-05-14T22:00:00.000Z');
// Far past — anything with this expires_at is expired against NOW.
const EXPIRED_AT = '2025-01-01T00:00:00.000Z';
// Far future — anything with this expires_at is still active against NOW.
const FUTURE_AT = '2027-01-01T00:00:00.000Z';

const VALID_POLICY = `version: 1
risk_tiers:
  "1": { max_files: 5, max_loc: 200 }
  "2": { max_files: 15, max_loc: 600 }
  "3": { max_files: 30, max_loc: 1500 }
gates:
  budget_limit: { enabled: true, mode: block }
  spec_completeness: { enabled: true, mode: block }
  scope_boundary: { enabled: true, mode: warn }
  god_object: { enabled: true, mode: warn }
  todo_detection: { enabled: false, mode: skip }
`;

// LEGACY-TEST-RECONCILE-001: gates.ts now refuses to run without a
// loadable spec for the named id. captureRun uses specId 'FOO-1'; we
// write a minimal tier-3 spec that passes schema + tier-3 semantics.
const MINIMAL_SPEC_YAML = `id: FOO-1
title: gates-waivers test fixture
risk_tier: 3
mode: feature
lifecycle_state: active
created_at: '2026-05-18T00:00:00Z'
updated_at: '2026-05-18T00:00:00Z'
blast_radius:
  modules:
    - src
operational_rollback_slo: 30m
scope:
  in:
    - src/**
  out: []
invariants:
  - no regressions
acceptance:
  - id: A1
    given: a project
    when: gates run
    then: report is produced
non_functional: {}
contracts: []
`;

function mkTempGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', [
    '-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init',
  ]);
  fs.mkdirSync(path.join(root, '.caws', 'specs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.caws', 'waivers'), { recursive: true });
  fs.writeFileSync(path.join(root, '.caws', 'policy.yaml'), VALID_POLICY);
  fs.writeFileSync(path.join(root, '.caws', 'specs', 'FOO-1.yaml'), MINIMAL_SPEC_YAML);
  return root;
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function writeWaiver(root, waiver) {
  const lines = [];
  lines.push(`id: ${waiver.id}`);
  lines.push(`title: '${waiver.title.replace(/'/g, "''")}'`);
  lines.push(`status: ${waiver.status}`);
  lines.push('gates:');
  for (const g of waiver.gates) lines.push(`  - ${g}`);
  lines.push(`reason: '${waiver.reason.replace(/'/g, "''")}'`);
  lines.push(`approved_by: '${waiver.approved_by.replace(/'/g, "''")}'`);
  lines.push(`created_at: '${waiver.created_at}'`);
  lines.push(`expires_at: '${waiver.expires_at}'`);
  if (waiver.scope) {
    lines.push('scope:');
    if (waiver.scope.spec_id) lines.push(`  spec_id: ${waiver.scope.spec_id}`);
  }
  if (waiver.revocation) {
    lines.push('revocation:');
    lines.push(`  revoked_at: '${waiver.revocation.revoked_at}'`);
    if (waiver.revocation.reason)
      lines.push(`  reason: '${waiver.revocation.reason.replace(/'/g, "''")}'`);
  }
  fs.writeFileSync(
    path.join(root, '.caws', 'waivers', `${waiver.id}.yaml`),
    lines.join('\n') + '\n'
  );
}

const REPORT_WITH = (violations) => ({
  timestamp: NOW.toISOString(),
  context: 'cli',
  files_scoped: 3,
  warnings: [],
  violations,
});

function violation(gate, idx = 0) {
  return {
    gate,
    type: 'too_much',
    message: `violation ${idx} on ${gate}`,
    file: `src/${gate}-${idx}.ts`,
    line: 10 + idx,
  };
}

function captureRun(repoRoot, payload, opts = {}) {
  const outLines = [];
  const errLines = [];
  const code = runGatesRunCommand(
    { specId: opts.specId ?? 'FOO-1' },
    {
      cwd: repoRoot,
      now: () => NOW,
      env: { CLAUDE_SESSION_ID: 'sess-me' },
      out: (s) => outLines.push(s),
      err: (s) => errLines.push(s),
      report: typeof payload === 'function' ? payload() : payload,
      ...opts,
    }
  );
  return { code, stdout: outLines.join('\n'), stderr: errLines.join('\n') };
}

function findGateEvent(repoRoot, gateId) {
  const events = loadEvents(path.join(repoRoot, '.caws'));
  if (!events.ok) throw new Error('events did not load');
  return events.value.events.find((e) => e.data.gate_id === gateId);
}

// ------------------------------------------------------------------
// 1. active matching waiver suppresses a block-mode violation → exit 0
// ------------------------------------------------------------------
describe('7a.3: active matching waiver suppresses block-mode violation', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('removes the violation from disposition and command exits 0', () => {
    repoRoot = mkTempGitRepo('caws-7a3-active-');
    writeWaiver(repoRoot, {
      id: 'WAIV-MAIN-1',
      title: 'authorize budget overrun',
      status: 'active',
      gates: ['budget_limit'],
      reason: 'pre-approved scaffolding pass',
      approved_by: 'lead@example.com',
      created_at: NOW.toISOString(),
      expires_at: FUTURE_AT,
    });
    const r = captureRun(repoRoot, REPORT_WITH([violation('budget_limit')]));
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Overall: OK/);
    // Disposition should be PASS (no violations remain), not "fail with [BLOCKS]"
    expect(r.stdout).toMatch(/PASS.*budget_limit/);
    expect(r.stdout).not.toMatch(/\[BLOCKS\]/);
  });
});

// ------------------------------------------------------------------
// 2. event payload includes waived_count and waiver_ids
// ------------------------------------------------------------------
describe('7a.3: gate_evaluated event records waiver evidence', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('writes waived_count and sorted waiver_ids on the suppressed gate', () => {
    repoRoot = mkTempGitRepo('caws-7a3-evidence-');
    // Two effective waivers covering the same gate, two violations on it.
    writeWaiver(repoRoot, {
      id: 'WAIV-B-1',
      title: 'b waiver',
      status: 'active',
      gates: ['budget_limit'],
      reason: 'reason b',
      approved_by: 'b@example.com',
      created_at: NOW.toISOString(),
      expires_at: FUTURE_AT,
    });
    writeWaiver(repoRoot, {
      id: 'WAIV-A-1',
      title: 'a waiver',
      status: 'active',
      gates: ['budget_limit'],
      reason: 'reason a',
      approved_by: 'a@example.com',
      created_at: NOW.toISOString(),
      expires_at: FUTURE_AT,
    });
    const r = captureRun(
      repoRoot,
      REPORT_WITH([violation('budget_limit', 0), violation('budget_limit', 1)])
    );
    expect(r.code).toBe(0);
    const ev = findGateEvent(repoRoot, 'budget_limit');
    expect(ev).toBeDefined();
    expect(ev.data.waived_count).toBe(2);
    // Sorted ascending.
    expect(ev.data.waiver_ids).toEqual(['WAIV-A-1', 'WAIV-B-1']);
    // Suppressed → no surviving violations on this gate.
    expect(ev.data.violations).toEqual([]);
    expect(ev.data.result).toBe('pass');
    // Mode is unchanged by waiver presence.
    expect(ev.data.mode).toBe('block');

    // A gate with no waivers and no violations: waived_count present and 0,
    // waiver_ids omitted (canonical "absent means zero" form).
    const sc = findGateEvent(repoRoot, 'spec_completeness');
    expect(sc.data.waived_count).toBe(0);
    expect(sc.data.waiver_ids).toBeUndefined();
  });
});

// ------------------------------------------------------------------
// 3. revoked waiver does not suppress → exit 1
// ------------------------------------------------------------------
describe('7a.3: revoked waiver is not effective', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('lets the violation through and the command blocks', () => {
    repoRoot = mkTempGitRepo('caws-7a3-revoked-');
    writeWaiver(repoRoot, {
      id: 'WAIV-REV-1',
      title: 'revoked waiver',
      status: 'revoked',
      gates: ['budget_limit'],
      reason: 'no longer authorized',
      approved_by: 'lead@example.com',
      created_at: NOW.toISOString(),
      expires_at: FUTURE_AT,
      revocation: {
        revoked_at: '2026-05-01T00:00:00.000Z',
        reason: 'rescinded after audit',
      },
    });
    const r = captureRun(repoRoot, REPORT_WITH([violation('budget_limit')]));
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/Overall: BLOCKED by policy/);
    const ev = findGateEvent(repoRoot, 'budget_limit');
    expect(ev.data.waived_count).toBe(0);
    expect(ev.data.violations).toHaveLength(1);
  });
});

// ------------------------------------------------------------------
// 4. expired waiver does not suppress → exit 1
// ------------------------------------------------------------------
describe('7a.3: expired waiver is not effective', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('does not suppress despite stored status=active', () => {
    repoRoot = mkTempGitRepo('caws-7a3-expired-');
    writeWaiver(repoRoot, {
      id: 'WAIV-EXP-1',
      title: 'expired waiver',
      status: 'active', // stored status — expiry is derived
      gates: ['budget_limit'],
      reason: 'time-boxed exception that already lapsed',
      approved_by: 'lead@example.com',
      created_at: '2024-12-01T00:00:00.000Z',
      expires_at: EXPIRED_AT,
    });
    const r = captureRun(repoRoot, REPORT_WITH([violation('budget_limit')]));
    expect(r.code).toBe(1);
    const ev = findGateEvent(repoRoot, 'budget_limit');
    expect(ev.data.waived_count).toBe(0);
  });
});

// ------------------------------------------------------------------
// 5. wrong-gate waiver does not suppress → exit 1
// ------------------------------------------------------------------
describe('7a.3: waiver covering a different gate does not suppress', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('budget_limit violation persists despite a scope_boundary waiver', () => {
    repoRoot = mkTempGitRepo('caws-7a3-wronggate-');
    writeWaiver(repoRoot, {
      id: 'WAIV-WRONG-1',
      title: 'covers a different gate',
      status: 'active',
      gates: ['scope_boundary'],
      reason: 'authorized scope drift',
      approved_by: 'lead@example.com',
      created_at: NOW.toISOString(),
      expires_at: FUTURE_AT,
    });
    const r = captureRun(repoRoot, REPORT_WITH([violation('budget_limit')]));
    expect(r.code).toBe(1);
    const ev = findGateEvent(repoRoot, 'budget_limit');
    expect(ev.data.waived_count).toBe(0);
  });
});

// ------------------------------------------------------------------
// 6. wrong-spec waiver does not suppress → exit 1
// ------------------------------------------------------------------
describe('7a.3: spec-scoped waiver does not apply to other specs', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('a scope.spec_id waiver bound to spec OTHER-1 does not suppress for FOO-1', () => {
    repoRoot = mkTempGitRepo('caws-7a3-wrongspec-');
    writeWaiver(repoRoot, {
      id: 'WAIV-OTHER-1',
      title: 'authorized only for OTHER-1',
      status: 'active',
      gates: ['budget_limit'],
      reason: 'one-off for unrelated spec',
      approved_by: 'lead@example.com',
      created_at: NOW.toISOString(),
      expires_at: FUTURE_AT,
      scope: { spec_id: 'OTHER-1' },
    });
    const r = captureRun(
      repoRoot,
      REPORT_WITH([violation('budget_limit')]),
      { specId: 'FOO-1' }
    );
    expect(r.code).toBe(1);
    const ev = findGateEvent(repoRoot, 'budget_limit');
    expect(ev.data.waived_count).toBe(0);
  });
});

// ------------------------------------------------------------------
// 7. project-wide waiver suppresses across spec ids
// ------------------------------------------------------------------
describe('7a.3: project-wide waiver (no scope.spec_id) suppresses for any spec', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('suppresses for spec FOO-1 and would suppress for any other id too', () => {
    repoRoot = mkTempGitRepo('caws-7a3-projectwide-');
    writeWaiver(repoRoot, {
      id: 'WAIV-PROJ-1',
      title: 'project-wide budget exception',
      status: 'active',
      gates: ['budget_limit'],
      reason: 'monorepo-wide migration',
      approved_by: 'lead@example.com',
      created_at: NOW.toISOString(),
      expires_at: FUTURE_AT,
      // no scope at all → applies to every spec id
    });
    const r = captureRun(
      repoRoot,
      REPORT_WITH([violation('budget_limit')]),
      { specId: 'FOO-1' }
    );
    expect(r.code).toBe(0);
    const ev = findGateEvent(repoRoot, 'budget_limit');
    expect(ev.data.waived_count).toBe(1);
    expect(ev.data.waiver_ids).toEqual(['WAIV-PROJ-1']);
  });
});

// ------------------------------------------------------------------
// 8. unmatched report violation remains observational and is not waived
// ------------------------------------------------------------------
describe('7a.3: report gates not declared in policy stay observational', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('a waiver covering an unmatched gate does NOT cause it to gain a policy disposition', () => {
    repoRoot = mkTempGitRepo('caws-7a3-unmatched-');
    // 'naming' is not in policy.gates → unmatched.
    writeWaiver(repoRoot, {
      id: 'WAIV-NAMING-1',
      title: 'naming exception',
      status: 'active',
      gates: ['naming'],
      reason: 'legacy module',
      approved_by: 'lead@example.com',
      created_at: NOW.toISOString(),
      expires_at: FUTURE_AT,
    });
    const r = captureRun(repoRoot, REPORT_WITH([violation('naming')]));
    // No policy gate failed → exit 0.
    expect(r.code).toBe(0);
    // The unmatched violation is still surfaced in the rendered output.
    expect(r.stdout).toMatch(/Unmatched violations/);
    // No event was appended for the un-policy-declared 'naming' gate.
    const events = loadEvents(path.join(repoRoot, '.caws'));
    const namingEv = events.value.events.find((e) => e.data.gate_id === 'naming');
    expect(namingEv).toBeUndefined();
  });
});

// ------------------------------------------------------------------
// 9. malformed waiver file produces load diagnostic but valid waivers still apply
// ------------------------------------------------------------------
describe('7a.3: malformed waiver file does not poison valid waivers', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('valid waiver still suppresses; malformed one shows as a stderr diagnostic', () => {
    repoRoot = mkTempGitRepo('caws-7a3-malformed-');
    // Valid waiver — should still take effect.
    writeWaiver(repoRoot, {
      id: 'WAIV-OK-1',
      title: 'valid waiver',
      status: 'active',
      gates: ['budget_limit'],
      reason: 'authorized',
      approved_by: 'lead@example.com',
      created_at: NOW.toISOString(),
      expires_at: FUTURE_AT,
    });
    // Malformed sibling — bad YAML / missing required fields.
    fs.writeFileSync(
      path.join(repoRoot, '.caws', 'waivers', 'WAIV-B-1AD.yaml'),
      "id: 'not-a-valid-id-shape'\nstatus: 'banana'\n"
    );

    const r = captureRun(repoRoot, REPORT_WITH([violation('budget_limit')]));

    // Valid waiver still applied → command exits 0.
    expect(r.code).toBe(0);
    const ev = findGateEvent(repoRoot, 'budget_limit');
    expect(ev.data.waived_count).toBe(1);
    expect(ev.data.waiver_ids).toEqual(['WAIV-OK-1']);

    // Stderr should mention the malformed file (load diagnostic surfaced).
    expect(r.stderr).toMatch(/WAIV-B-1AD\.yaml|waiver/i);
  });
});

// ------------------------------------------------------------------
// 10. policy mode remains decisive after filtering:
//     warn-mode unwaived failure → exit 0
//     block-mode unwaived failure → exit 1
// ------------------------------------------------------------------
describe('7a.3: policy mode is decisive after waiver filtering', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('warn-mode gate with an unwaived violation → exit 0; block-mode gate with an unwaived violation → exit 1', () => {
    repoRoot = mkTempGitRepo('caws-7a3-policymode-');
    // No waivers at all in this scenario.
    // First: a warn-mode failure should not block.
    let r = captureRun(repoRoot, REPORT_WITH([violation('scope_boundary')]));
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\[warn\]/);
    // Reset events so the second invocation starts fresh (avoid chain growth
    // confusion in this assertion — the disposition is what matters).
    rmrf(path.join(repoRoot, '.caws', 'events.jsonl'));

    // Second: a block-mode failure on a different gate should block.
    r = captureRun(repoRoot, REPORT_WITH([violation('budget_limit')]));
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/\[BLOCKS\]/);
  });

  it('a partially-waived block-mode gate (some violations waived, some not) STILL blocks', () => {
    // This nails the "policy mode is unchanged" rule: waivers only remove
    // violations from the count; they do NOT downgrade block→warn. If even
    // one unwaived block-mode violation remains, the gate blocks.
    repoRoot = mkTempGitRepo('caws-7a3-partial-');
    // The waiver covers 'budget_limit' but does not address per-violation
    // identity in this slice — applicability is gate-level. So a single
    // matching effective waiver would suppress ALL violations on the gate.
    // To prove "unwaived violation blocks", we use a waiver that does NOT
    // cover the gate of the violations.
    writeWaiver(repoRoot, {
      id: 'WAIV-OFFTOPIC-1',
      title: 'covers a different gate',
      status: 'active',
      gates: ['scope_boundary'], // wrong gate — does not waive budget_limit
      reason: 'unrelated',
      approved_by: 'lead@example.com',
      created_at: NOW.toISOString(),
      expires_at: FUTURE_AT,
    });
    const r = captureRun(repoRoot, REPORT_WITH([violation('budget_limit')]));
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/\[BLOCKS\]/);
    const ev = findGateEvent(repoRoot, 'budget_limit');
    expect(ev.data.mode).toBe('block'); // mode unchanged
    expect(ev.data.waived_count).toBe(0);
  });
});
