/**
 * Tests for `caws gates run` and its supporting modules.
 *
 * The slice's load-bearing invariants:
 *   - policy owns block/warn/skip (subprocess only reports violations)
 *   - subprocess JSON shape is validated before trust
 *   - events go through events-store.appendEvent ONLY
 *   - missing policy → exit 2 (gates cannot decide mode without it)
 *   - subprocess contract failures → exit 2
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  deriveDispositions,
  runGatesRunCommand,
  validateGatesReport,
} = require('../../dist/shell');
const { loadEvents } = require('../../dist/store');

const NOW = new Date('2026-05-14T22:00:00.000Z');

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

// LEGACY-TEST-RECONCILE-001: gates.ts now refuses to run if the named
// spec is not loadable (the local evaluators need the spec). Tests
// using `captureRun(repoRoot, ..., { specId: 'FOO-1' })` must have a
// matching .caws/specs/FOO-1.yaml. We write a minimal tier-3 spec that
// passes both schema and tier-3 semantic checks.
const MINIMAL_SPEC_YAML = `id: FOO-1
title: gates-command test fixture
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
  fs.writeFileSync(path.join(root, '.caws', 'specs', 'FOO-1.yaml'), MINIMAL_SPEC_YAML);
  return root;
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function jsonRunner(payload) {
  return () => ({
    status: 0,
    stdout: typeof payload === 'string' ? payload : JSON.stringify(payload),
    stderr: '',
  });
}

const PASS_REPORT = {
  timestamp: NOW.toISOString(),
  context: 'cli',
  files_scoped: 3,
  warnings: [],
  violations: [],
};

const FAIL_REPORT = (gate, count = 1) => ({
  timestamp: NOW.toISOString(),
  context: 'cli',
  files_scoped: 3,
  warnings: [],
  violations: Array.from({ length: count }, (_, i) => ({
    gate,
    type: 'too_much',
    message: `violation ${i}`,
    file: `src/foo${i}.ts`,
    line: 10 + i,
  })),
});

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
      runner: typeof payload === 'function' ? payload : jsonRunner(payload),
      ...opts,
    }
  );
  return { code, stdout: outLines.join('\n'), stderr: errLines.join('\n') };
}

describe('validateGatesReport — JSON contract', () => {
  it('accepts a well-formed pass report', () => {
    const r = validateGatesReport(JSON.stringify(PASS_REPORT));
    expect(r.ok).toBe(true);
    expect(r.value.violations).toEqual([]);
    expect(r.value.files_scoped).toBe(3);
  });

  it('rejects non-JSON', () => {
    const r = validateGatesReport('not json at all');
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe('shell.gates.report_not_json');
  });

  it('rejects an array payload', () => {
    const r = validateGatesReport('[]');
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe('shell.gates.report_invalid_shape');
  });

  it('rejects missing required fields', () => {
    const r = validateGatesReport(JSON.stringify({ timestamp: 'x' }));
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe('shell.gates.report_invalid_shape');
  });

  it('rejects a violation without a gate name', () => {
    const r = validateGatesReport(
      JSON.stringify({
        ...PASS_REPORT,
        violations: [{ message: 'bare violation, no gate' }],
      })
    );
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toMatch(/missing required string field 'gate'/);
  });
});

describe('deriveDispositions — policy ownership of block/warn/skip', () => {
  // Build a minimal Policy-shaped object the kernel can accept.
  const policy = {
    version: 1,
    risk_tiers: {
      1: { max_files: 5, max_loc: 200 },
      2: { max_files: 15, max_loc: 600 },
      3: { max_files: 30, max_loc: 1500 },
    },
    gates: {
      budget_limit: { enabled: true, mode: 'block' },
      spec_completeness: { enabled: true, mode: 'block' },
      scope_boundary: { enabled: true, mode: 'warn' },
      god_object: { enabled: true, mode: 'warn' },
      todo_detection: { enabled: false, mode: 'skip' },
    },
  };

  it('pass when no violations target a declared gate', () => {
    const r = deriveDispositions(PASS_REPORT, policy);
    const budget = r.dispositions.find((d) => d.gate_id === 'budget_limit');
    expect(budget.outcome).toBe('pass');
    expect(budget.blocks).toBe(false);
    expect(r.anyBlocks).toBe(false);
  });

  it('fail + block mode → blocks=true; anyBlocks=true', () => {
    const r = deriveDispositions(FAIL_REPORT('budget_limit'), policy);
    const budget = r.dispositions.find((d) => d.gate_id === 'budget_limit');
    expect(budget.outcome).toBe('fail');
    expect(budget.blocks).toBe(true);
    expect(r.anyBlocks).toBe(true);
  });

  it('fail + warn mode → blocks=false; anyBlocks stays false', () => {
    const r = deriveDispositions(FAIL_REPORT('scope_boundary'), policy);
    const sb = r.dispositions.find((d) => d.gate_id === 'scope_boundary');
    expect(sb.outcome).toBe('fail');
    expect(sb.blocks).toBe(false);
    expect(r.anyBlocks).toBe(false);
  });

  it('skip / disabled gate → outcome=skipped regardless of violations', () => {
    const r = deriveDispositions(FAIL_REPORT('todo_detection', 5), policy);
    const td = r.dispositions.find((d) => d.gate_id === 'todo_detection');
    expect(td.outcome).toBe('skipped');
    expect(td.blocks).toBe(false);
  });

  it('violations on gates not declared in policy → unmatchedViolations', () => {
    const r = deriveDispositions(FAIL_REPORT('naming', 2), policy);
    expect(r.unmatchedViolations).toHaveLength(2);
    expect(r.unmatchedViolations[0].gate).toBe('naming');
    expect(r.anyBlocks).toBe(false);
  });

  it('subprocess severity does NOT override policy mode', () => {
    // The subprocess marks a violation severity='block', but policy is warn.
    // Final disposition must follow policy.
    const report = {
      ...PASS_REPORT,
      violations: [
        {
          gate: 'scope_boundary',
          severity: 'block', // subprocess opinion
          message: 'subprocess thinks this should block',
        },
      ],
    };
    const r = deriveDispositions(report, policy);
    const sb = r.dispositions.find((d) => d.gate_id === 'scope_boundary');
    // policy says scope_boundary is mode=warn → command does NOT block
    expect(sb.blocks).toBe(false);
    expect(r.anyBlocks).toBe(false);
  });

  // LEGACY-TEST-RECONCILE-001: mechanical alias mappings. The subprocess
  // emits violations under implementation-level gate names that differ
  // from policy KNOWN_GATE_IDS only by mechanical naming (singular vs
  // plural, hyphen vs underscore). Each alias must be a clear naming
  // translation, not a semantic repurposing.
  it('alias: subprocess `god_objects` (plural) maps to policy `god_object`', () => {
    const report = {
      ...PASS_REPORT,
      violations: [
        {
          gate: 'god_objects', // subprocess plural
          type: 'file_too_large',
          file: 'src/big.js',
          message: 'File exceeds size threshold',
        },
      ],
    };
    const r = deriveDispositions(report, policy);
    const godObject = r.dispositions.find((d) => d.gate_id === 'god_object');
    expect(godObject).toBeDefined();
    expect(godObject.outcome).toBe('fail');
    expect(godObject.violations).toHaveLength(1);
    expect(godObject.violations[0].gate).toBe('god_objects'); // original tag preserved
    // policy.god_object.mode === 'warn' here → blocks=false
    expect(godObject.blocks).toBe(false);
    // Alias-routed violation must NOT also appear in unmatchedViolations.
    expect(r.unmatchedViolations.find((v) => v.gate === 'god_objects')).toBeUndefined();
  });

  it('alias: subprocess `hidden-todo` maps to policy `todo_detection`', () => {
    // The hidden-todo gate in quality-gates emits violations with
    // gate: "hidden-todo" (legacy internal name). The disposition layer
    // aliases this to the canonical policy gate `todo_detection`.
    const policyWithTodoBlock = {
      ...policy,
      gates: {
        ...policy.gates,
        todo_detection: { enabled: true, mode: 'block' }, // override skip from outer scope
      },
    };
    const report = {
      ...PASS_REPORT,
      violations: [
        {
          gate: 'hidden-todo',
          type: 'hidden_todo_error',
          file: 'src/incomplete.js',
          line: 42,
          message: 'Found stub returning hardcoded value',
        },
      ],
    };
    const r = deriveDispositions(report, policyWithTodoBlock);
    const td = r.dispositions.find((d) => d.gate_id === 'todo_detection');
    expect(td).toBeDefined();
    expect(td.outcome).toBe('fail');
    expect(td.violations).toHaveLength(1);
    expect(td.violations[0].gate).toBe('hidden-todo');
    // Block mode → blocks=true
    expect(td.blocks).toBe(true);
    expect(r.anyBlocks).toBe(true);
  });

  it('refused alias: subprocess `code_freeze` is NOT mapped to `budget_limit`', () => {
    // code_freeze and budget_limit are semantically distinct (crisis-
    // response new-file block vs risk-tier file/loc budget). Mapping
    // them would be a semantic repurposing, not a mechanical alias.
    // Confirm code_freeze violations land in unmatchedViolations.
    const report = {
      ...PASS_REPORT,
      violations: [
        {
          gate: 'code_freeze',
          type: 'new_file_during_freeze',
          message: 'New file staged during code freeze',
        },
      ],
    };
    const r = deriveDispositions(report, policy);
    expect(r.unmatchedViolations).toHaveLength(1);
    expect(r.unmatchedViolations[0].gate).toBe('code_freeze');
    const budget = r.dispositions.find((d) => d.gate_id === 'budget_limit');
    // budget_limit must remain at pass — no code_freeze leakage.
    expect(budget.outcome).toBe('pass');
    expect(budget.violations).toHaveLength(0);
  });
});

describe('runGatesRunCommand — exit codes', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('all gates pass → exit 0, one event per declared gate', () => {
    repoRoot = mkTempGitRepo('caws-gates-pass-');
    fs.writeFileSync(path.join(repoRoot, '.caws', 'policy.yaml'), VALID_POLICY);
    const r = captureRun(repoRoot, PASS_REPORT);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Overall: OK/);
    // Event log: 5 policy-declared gates → 5 events. (todo_detection is
    // skipped/disabled but the command still emits a skipped event for
    // audit completeness.)
    const events = loadEvents(path.join(repoRoot, '.caws'));
    expect(events.ok).toBe(true);
    expect(events.value.events).toHaveLength(5);
    const gateIds = events.value.events.map((e) => e.data.gate_id).sort();
    expect(gateIds).toEqual([
      'budget_limit',
      'god_object',
      'scope_boundary',
      'spec_completeness',
      'todo_detection',
    ]);
  });

  it('block-mode failure → exit 1, BLOCKED, event reflects fail', () => {
    repoRoot = mkTempGitRepo('caws-gates-block-');
    fs.writeFileSync(path.join(repoRoot, '.caws', 'policy.yaml'), VALID_POLICY);
    const r = captureRun(repoRoot, FAIL_REPORT('budget_limit', 3));
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/FAIL.*budget_limit/);
    expect(r.stdout).toMatch(/\[BLOCKS\]/);
    expect(r.stdout).toMatch(/Overall: BLOCKED by policy/);
    const events = loadEvents(path.join(repoRoot, '.caws'));
    const budget = events.value.events.find((e) => e.data.gate_id === 'budget_limit');
    expect(budget.data.result).toBe('fail');
    expect(budget.data.mode).toBe('block');
    expect(budget.data.violations).toHaveLength(3);
  });

  it('warn-mode failure → exit 0, warn-labeled, event still recorded', () => {
    repoRoot = mkTempGitRepo('caws-gates-warn-');
    fs.writeFileSync(path.join(repoRoot, '.caws', 'policy.yaml'), VALID_POLICY);
    const r = captureRun(repoRoot, FAIL_REPORT('scope_boundary'));
    expect(r.code).toBe(0); // warn does not block
    expect(r.stdout).toMatch(/FAIL.*scope_boundary/);
    expect(r.stdout).toMatch(/\[warn\]/);
    expect(r.stdout).toMatch(/Overall: OK/);
  });

  it('missing policy → exit 2, NO events appended', () => {
    repoRoot = mkTempGitRepo('caws-gates-nopolicy-');
    const r = captureRun(repoRoot, PASS_REPORT);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/no policy\.yaml loaded/);
    expect(r.stderr).toMatch(/policy_required/);
    // events.jsonl never created
    expect(fs.existsSync(path.join(repoRoot, '.caws', 'events.jsonl'))).toBe(false);
  });

  it('malformed subprocess JSON → exit 2, contract failure, NO events', () => {
    repoRoot = mkTempGitRepo('caws-gates-bad-json-');
    fs.writeFileSync(path.join(repoRoot, '.caws', 'policy.yaml'), VALID_POLICY);
    const r = captureRun(repoRoot, () => ({
      status: 0,
      stdout: 'definitely not json',
      stderr: '',
    }));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/subprocess contract failure/);
    expect(r.stderr).toMatch(/report_not_json/);
    expect(fs.existsSync(path.join(repoRoot, '.caws', 'events.jsonl'))).toBe(false);
  });

  it('subprocess JSON missing required fields → exit 2, contract failure', () => {
    repoRoot = mkTempGitRepo('caws-gates-bad-shape-');
    fs.writeFileSync(path.join(repoRoot, '.caws', 'policy.yaml'), VALID_POLICY);
    const r = captureRun(repoRoot, () => ({
      status: 0,
      stdout: JSON.stringify({ timestamp: 'now' }), // missing context/files_scoped/violations/warnings
      stderr: '',
    }));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/report_invalid_shape/);
  });

  it('subprocess ENOENT → exit 2 with subprocess_not_found', () => {
    repoRoot = mkTempGitRepo('caws-gates-noexec-');
    fs.writeFileSync(path.join(repoRoot, '.caws', 'policy.yaml'), VALID_POLICY);
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
    const r = captureRun(repoRoot, () => ({
      status: null,
      stdout: '',
      stderr: '',
      error: enoent,
    }));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/subprocess_not_found/);
  });

  it('subprocess empty stdout (no JSON at all) → exit 2', () => {
    repoRoot = mkTempGitRepo('caws-gates-emptyout-');
    fs.writeFileSync(path.join(repoRoot, '.caws', 'policy.yaml'), VALID_POLICY);
    const r = captureRun(repoRoot, () => ({
      status: 1,
      stdout: '',
      stderr: 'something went wrong',
    }));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/subprocess_failed/);
  });

  it('event-store integrity: events are chained, not written directly', () => {
    repoRoot = mkTempGitRepo('caws-gates-chain-');
    fs.writeFileSync(path.join(repoRoot, '.caws', 'policy.yaml'), VALID_POLICY);
    const r = captureRun(repoRoot, FAIL_REPORT('god_object', 2));
    expect(r.code).toBe(0); // god_object is mode=warn
    const events = loadEvents(path.join(repoRoot, '.caws'));
    expect(events.ok).toBe(true);
    // 5 events; chain integrity holds (each prev_hash = previous event_hash)
    expect(events.value.events).toHaveLength(5);
    for (let i = 1; i < events.value.events.length; i++) {
      expect(events.value.events[i].prev_hash).toBe(
        events.value.events[i - 1].event_hash
      );
    }
    expect(events.value.events[0].prev_hash).toBeNull();
  });
});

describe('runGatesRunCommand — missing --spec', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('empty specId → exit 1', () => {
    repoRoot = mkTempGitRepo('caws-gates-nospec-');
    fs.writeFileSync(path.join(repoRoot, '.caws', 'policy.yaml'), VALID_POLICY);
    const r = captureRun(repoRoot, PASS_REPORT, { specId: '' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--spec is required/);
  });
});
