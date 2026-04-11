/**
 * Event Log Read-Parity Integration Test (EVLOG-002 Phase 2)
 *
 * Load-bearing verification that the four consumer commands
 * (iterate, status, sidecar, gates) correctly read from the append-only
 * event log via `loadStateFromEvents` instead of the state layer.
 *
 * Test shape:
 *   1. Set up a tmp project with a real spec + policy + minimal git repo.
 *   2. Populate the event log via real recordX calls + appendEvent
 *      (dual-write, same as the Phase 1 integration test).
 *   3. Run each consumer command via execFileSync against the CLI source.
 *      Capture stdout.
 *   4. DELETE .caws/state/ entirely (the load-bearing assertion).
 *   5. Re-run each consumer command. Capture stdout.
 *   6. Assert stdout is byte-identical across runs after normalizing
 *      non-deterministic fields (timestamps, durations).
 *
 * A byte-identical diff with state absent proves the event log alone
 * is sufficient. This is the EVLOG-002 A6 invariant: "deleting
 * .caws/state/<spec-id>.json does not change any consumer's output."
 *
 * Scope note: this test is command-layer black-box. The data-layer
 * parity (renderSpecState vs loadState field-by-field) is covered by
 * tests/integration/event-log-parity.test.js from Phase 1.
 *
 * @author @darianrosebrook
 */

const fs = require('fs');
const fse = require('fs-extra');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');
const { execFileSync } = require('child_process');

const {
  recordValidation,
  recordEvaluation,
  recordGates,
  recordACVerification,
} = require('../../src/utils/working-state');
const { appendEventSync } = require('../../src/utils/event-log');

const cliPath = path.join(__dirname, '../../src/index.js');

// ---------------------------------------------------------------------------
// Test fixture setup
// ---------------------------------------------------------------------------

function buildValidSpec(id, title) {
  return {
    id,
    type: 'feature',
    title,
    status: 'active',
    risk_tier: 3,
    mode: 'development',
    created_at: '2026-04-11T00:00:00.000Z',
    updated_at: '2026-04-11T00:00:00.000Z',
    blast_radius: { modules: ['src'], data_migration: false },
    operational_rollback_slo: '5m',
    scope: { in: ['src/'], out: ['node_modules/'] },
    invariants: ['Read-parity invariant'],
    acceptance: [
      { id: 'A1', given: 'A spec with events', when: 'A consumer runs', then: 'Output reflects event data' },
    ],
    non_functional: { perf: { api_p95_ms: 100 }, a11y: [], security: [] },
    contracts: [],
  };
}

function createTestProject(specId = 'READTEST-001') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-read-parity-'));
  fse.ensureDirSync(path.join(dir, '.caws', 'specs'));

  const spec = buildValidSpec(specId, 'Phase 2 read parity test');
  fs.writeFileSync(
    path.join(dir, '.caws', 'specs', `${specId}.yaml`),
    yaml.dump(spec)
  );
  // Duplicate as working-spec.yaml for commands that default to it.
  fs.writeFileSync(
    path.join(dir, '.caws', 'working-spec.yaml'),
    yaml.dump(spec)
  );

  // Minimal policy.yaml so gates don't warn.
  const policy = {
    version: 1,
    risk_tiers: {
      3: { max_files: 100, max_loc: 5000 },
    },
    gates: {
      scope_boundary: { enabled: true, mode: 'warn' },
      budget_limit: { enabled: true, mode: 'warn' },
      god_object: { enabled: true, mode: 'warn' },
      todo_detection: { enabled: true, mode: 'warn' },
      spec_completeness: { enabled: true, mode: 'warn' },
    },
  };
  fs.writeFileSync(path.join(dir, '.caws', 'policy.yaml'), yaml.dump(policy));

  return dir;
}

/**
 * Populate both .caws/state/ and .caws/events.jsonl with matched
 * validation/evaluation/gates/acceptance data. This is the dualWrite
 * helper from the Phase 1 parity test, adapted to use the sync
 * appendEvent path so we don't need async test harness.
 */
function dualWrite(projectRoot, specId) {
  const validationPayload = {
    passed: true,
    compliance_score: 0.9,
    grade: 'A',
    error_count: 0,
    warning_count: 1,
  };
  recordValidation(specId, validationPayload, projectRoot);
  appendEventSync(
    {
      actor: 'cli',
      event: 'validation_completed',
      spec_id: specId,
      data: validationPayload,
    },
    { projectRoot }
  );

  const evaluationPayload = {
    score: 85,
    max_score: 100,
    percentage: 85,
    grade: 'B',
    checks_passed: 10,
    checks_total: 12,
  };
  recordEvaluation(specId, evaluationPayload, projectRoot);
  appendEventSync(
    {
      actor: 'cli',
      event: 'evaluation_completed',
      spec_id: specId,
      data: evaluationPayload,
    },
    { projectRoot }
  );

  const gatesPayload = {
    passed: true,
    summary: { passed: 5, blocked: 0, warned: 0 },
    gates: [
      { name: 'scope_boundary', status: 'pass', mode: 'warn' },
      { name: 'budget_limit', status: 'pass', mode: 'warn' },
      { name: 'god_object', status: 'pass', mode: 'warn' },
      { name: 'todo_detection', status: 'pass', mode: 'warn' },
      { name: 'spec_completeness', status: 'pass', mode: 'warn' },
    ],
  };
  recordGates(specId, gatesPayload, 'cli', projectRoot);
  appendEventSync(
    {
      actor: 'cli',
      event: 'gates_evaluated',
      spec_id: specId,
      data: { context: 'cli', ...gatesPayload },
    },
    { projectRoot }
  );

  const acPayload = {
    total: 1,
    pass: 1,
    fail: 0,
    unchecked: 0,
    results: [{ id: 'A1', status: 'pass' }],
  };
  recordACVerification(specId, acPayload, projectRoot);
  appendEventSync(
    {
      actor: 'cli',
      event: 'verify_acs_completed',
      spec_id: specId,
      data: acPayload,
    },
    { projectRoot }
  );
}

/**
 * Run a CLI command against a project and return stdout (stderr is
 * swallowed by default since it contains non-deterministic setup
 * detection output).
 */
function runCli(projectDir, args) {
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args], {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status || 1,
    };
  }
}

/**
 * Normalize command output for byte-comparison. Strips:
 * - ISO timestamps (non-deterministic across runs)
 * - Elapsed-time strings like "(completed in 3ms)"
 * - Absolute paths that may point at different tmp dirs
 */
function normalizeOutput(text, projectDir) {
  return text
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<TS>')
    .replace(/\(completed in \d+ms\)/g, '(completed in <N>ms)')
    .replace(/\b\d+ms\b/g, '<N>ms')
    .replace(new RegExp(projectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<PROJECT>');
}

/**
 * Assert a command's output is byte-identical before and after
 * deleting the .caws/state/ directory. This is the load-bearing
 * A6 assertion.
 */
function assertReadParity(projectDir, specId, commandArgs, label) {
  // Run 1: state file present
  const before = runCli(projectDir, commandArgs);

  // Delete state directory entirely
  const stateDir = path.join(projectDir, '.caws', 'state');
  if (fs.existsSync(stateDir)) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  expect(fs.existsSync(stateDir)).toBe(false);

  // Run 2: state file absent
  const after = runCli(projectDir, commandArgs);

  const beforeNorm = normalizeOutput(before.stdout, projectDir);
  const afterNorm = normalizeOutput(after.stdout, projectDir);

  if (beforeNorm !== afterNorm) {
    // Give a useful diff message
    const maxLen = Math.max(beforeNorm.length, afterNorm.length);
    for (let i = 0; i < maxLen; i++) {
      if (beforeNorm[i] !== afterNorm[i]) {
        const ctx = 60;
        throw new Error(
          `Read-parity mismatch for ${label} at char ${i}:\n` +
            `BEFORE: ...${beforeNorm.slice(Math.max(0, i - ctx), i + ctx)}...\n` +
            `AFTER:  ...${afterNorm.slice(Math.max(0, i - ctx), i + ctx)}...`
        );
      }
    }
  }
  expect(afterNorm).toBe(beforeNorm);

  // Sanity: output should not be empty or a crash message.
  expect(after.stdout.length).toBeGreaterThan(0);
  expect(after.exitCode).toBe(before.exitCode);

  return { before, after };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('EVLOG-002 command-layer read parity', () => {
  let projectDir;
  const specId = 'READTEST-001';

  beforeEach(() => {
    projectDir = createTestProject(specId);
    dualWrite(projectDir, specId);
  });

  afterEach(() => {
    if (projectDir && fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('pre-condition: dualWrite populates both state and events', () => {
    const stateFile = path.join(projectDir, '.caws', 'state', `${specId}.json`);
    const eventsFile = path.join(projectDir, '.caws', 'events.jsonl');
    expect(fs.existsSync(stateFile)).toBe(true);
    expect(fs.existsSync(eventsFile)).toBe(true);

    const events = fs
      .readFileSync(eventsFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(events.length).toBe(4);
    expect(events.map((e) => e.event).sort()).toEqual([
      'evaluation_completed',
      'gates_evaluated',
      'validation_completed',
      'verify_acs_completed',
    ]);
  });

  test('iterate produces identical output with state present vs absent', () => {
    const { after } = assertReadParity(
      projectDir,
      specId,
      ['iterate', '--spec-id', specId, '--current-state', '{"phase":"implementation"}'],
      'iterate'
    );
    // Sanity: the output must reflect the event-log data, not just a
    // generic "not started" guidance.
    expect(after.stdout).toContain('Validation passed (Grade A)');
    expect(after.stdout).toContain('Evaluation: 85%');
  });

  test('status (human) produces identical output with state present vs absent', () => {
    const { after } = assertReadParity(
      projectDir,
      specId,
      ['status', '--spec-id', specId],
      'status human'
    );
    // Working State section must render with all four derived fields.
    expect(after.stdout).toContain('Working State');
    expect(after.stdout).toContain('Grade A');
    expect(after.stdout).toContain('85%');
  });

  test('status --json produces identical output with state present vs absent', () => {
    const { after } = assertReadParity(
      projectDir,
      specId,
      ['status', '--spec-id', specId, '--json'],
      'status json'
    );
    // Extract the JSON and verify workingState.validation exists.
    const jsonStart = after.stdout.indexOf('{');
    const jsonBlock = after.stdout.slice(jsonStart);
    // May be followed by other output; find matching close brace.
    let depth = 0;
    let end = -1;
    for (let i = 0; i < jsonBlock.length; i++) {
      if (jsonBlock[i] === '{') depth++;
      else if (jsonBlock[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    const parsed = JSON.parse(jsonBlock.slice(0, end));
    expect(parsed.workingState).not.toBeNull();
    expect(parsed.workingState.validation).toMatchObject({ passed: true, grade: 'A' });
    expect(parsed.workingState.evaluation).toMatchObject({ percentage: 85, grade: 'B' });
  });

  test('sidecar gaps produces identical output with state present vs absent', () => {
    const { after } = assertReadParity(
      projectDir,
      specId,
      ['sidecar', 'gaps', '--spec-id', specId],
      'sidecar gaps'
    );
    expect(after.stdout).toContain('Phase Gaps');
  });

  test('sidecar drift produces identical output with state present vs absent', () => {
    const { after } = assertReadParity(
      projectDir,
      specId,
      ['sidecar', 'drift', '--spec-id', specId],
      'sidecar drift'
    );
    expect(after.stdout).toContain('Drift Analysis');
  });

  test('sidecar waiver-draft produces identical output with state present vs absent', () => {
    // waiver-draft requires a --gate filter; pick one that exists in the dualWrite payload.
    assertReadParity(
      projectDir,
      specId,
      ['sidecar', 'waiver-draft', '--spec-id', specId, '--gate', 'scope_boundary'],
      'sidecar waiver-draft'
    );
  });

  test('untouched spec returns null workingState in status --json', () => {
    // Create a second spec that has no events recorded for it.
    const untouchedId = 'UNTOUCHED-999';
    const spec = buildValidSpec(untouchedId, 'Untouched spec — no events');
    fs.writeFileSync(
      path.join(projectDir, '.caws', 'specs', `${untouchedId}.yaml`),
      yaml.dump(spec)
    );

    const result = runCli(projectDir, ['status', '--spec-id', untouchedId, '--json']);

    // Parse the JSON block
    const jsonStart = result.stdout.indexOf('{');
    const jsonBlock = result.stdout.slice(jsonStart);
    let depth = 0;
    let end = -1;
    for (let i = 0; i < jsonBlock.length; i++) {
      if (jsonBlock[i] === '{') depth++;
      else if (jsonBlock[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    const parsed = JSON.parse(jsonBlock.slice(0, end));
    // This is the || null coalesce assertion: loadStateFromEvents must
    // return null for untouched specs so the coalesce stays a no-op.
    expect(parsed.workingState).toBeNull();
  });
});
