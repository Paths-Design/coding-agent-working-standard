/**
 * @fileoverview Integration tests for `caws gates run` CLI command (v11.1)
 *
 * Exercises the v11 gates pipeline end-to-end via child_process.execFileSync,
 * verifying exit codes, text-output disposition, and the structured
 * `gate_evaluated` events emitted to .caws/events.jsonl.
 *
 * v11 contract notes:
 *   - `caws gates run --spec <id> [--context cli|commit|ci]`
 *   - No `--json` flag; v11 emits a text disposition table.
 *   - Structured per-gate detail lives in events.jsonl, not stdout.
 *   - Exit 0 when all gates pass; exit 1 when any block-mode gate fails.
 *   - One `gate_evaluated` event is appended per policy-declared gate.
 *
 * @author @darianrosebrook
 */

const path = require('path');
const fs = require('fs-extra');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');
const { createTemplateRepo, cloneFixture, cleanupTemplate } = require('../helpers/git-fixture');

// v11 entry point. The legacy v10 src/index.js is deadwood (see
// LEGACY-TEST-RECONCILE-001 closure notes).
const CLI_PATH = path.join(__dirname, '../../dist/index.js');

// v11 policy schema: edit_rules holds only edit-time policy. The
// approvers-for-budget field belongs under `waivers` (the v11 schema
// emits a repair hint to that effect if you misplace it).
const EDIT_RULES = { policy_and_code_same_pr: false };

let _gatesCLITemplate = null;

/**
 * Build a minimal schema-valid v11 spec object. v11 specs live at
 * .caws/specs/<id>.yaml. Required fields are id, title, risk_tier, mode,
 * blast_radius, operational_rollback_slo, scope, invariants, acceptance,
 * lifecycle_state, created_at, updated_at.
 */
function buildValidSpec(overrides = {}) {
  const now = '2026-05-18T00:00:00.000Z';
  // v11 spec schema:
  //   - Required: id, title, risk_tier, mode, lifecycle_state,
  //     blast_radius, scope, invariants, acceptance, non_functional, contracts
  //   - Semantic: tier-1 and tier-2 specs require ≥1 contract; tier-3 does not.
  //   - We use tier-3 for fixtures so we can ship empty contracts without
  //     synthesizing irrelevant contract objects.
  return {
    id: 'FEAT-001',
    title: 'Integration test spec fixture',
    risk_tier: 3,
    mode: 'feature',
    lifecycle_state: 'active',
    created_at: now,
    updated_at: now,
    blast_radius: { modules: ['src'] },
    operational_rollback_slo: '30m',
    scope: { in: ['src/**'], out: [] },
    invariants: ['No regressions in existing tests'],
    acceptance: [
      { id: 'A1', given: 'a project', when: 'gates run', then: 'a report is produced' },
    ],
    non_functional: {},
    contracts: [],
    ...overrides,
  };
}

/**
 * Create a temp directory with a git repo, .caws/policy.yaml, and a v11
 * spec at .caws/specs/<id>.yaml. Returns { dir, specId }.
 */
function createTestProject(overrides = {}) {
  if (!_gatesCLITemplate) {
    _gatesCLITemplate = createTemplateRepo();
  }
  const dir = cloneFixture(_gatesCLITemplate, 'caws-gates-cli-');

  fs.ensureDirSync(path.join(dir, '.caws'));
  fs.ensureDirSync(path.join(dir, '.caws', 'specs'));

  // Default policy with all gates in warn mode (so they pass).
  const defaultPolicy = {
    version: 1,
    risk_tiers: {
      1: { max_files: 25, max_loc: 1000 },
      2: { max_files: 50, max_loc: 2000 },
      3: { max_files: 100, max_loc: 5000 },
    },
    edit_rules: EDIT_RULES,
    gates: {
      scope_boundary: { enabled: true, mode: 'warn' },
      budget_limit: { enabled: true, mode: 'warn' },
      god_object: { enabled: true, mode: 'warn' },
      todo_detection: { enabled: true, mode: 'warn' },
      spec_completeness: { enabled: true, mode: 'warn' },
    },
  };

  const policy = overrides.policy || defaultPolicy;
  fs.writeFileSync(path.join(dir, '.caws', 'policy.yaml'), yaml.dump(policy));

  const spec = overrides.spec || buildValidSpec();
  const specId = spec.id;
  fs.writeFileSync(path.join(dir, '.caws', 'specs', `${specId}.yaml`), yaml.dump(spec));

  // Minimal worktrees registry so doctor doesn't complain.
  fs.writeFileSync(path.join(dir, '.caws', 'worktrees.json'), JSON.stringify({}));
  fs.writeFileSync(path.join(dir, '.caws', 'agents.json'), JSON.stringify({}));

  return { dir, specId };
}

// The quality-gates subprocess uses a lockfile at
// `<quality-gates-pkg>/docs-status/quality-gates.lock` (shared across
// all parallel jest workers — a real product limitation, tracked in
// the LOCK-INTERPROCESS-HARDEN-001 backlog). Tests must clear the lock
// before each run; the lock holds for 5 minutes by default which makes
// parallel test runs flaky without this hygiene.
const QG_LOCK_PATH = path.join(
  __dirname,
  '../../../quality-gates/docs-status/quality-gates.lock'
);

function clearQGLock() {
  try { fs.rmSync(QG_LOCK_PATH, { force: true }); } catch { /* no-op */ }
}

/**
 * Run `caws gates run --spec <id> [...extraArgs]` and return
 * { stdout, stderr, exitCode }. Non-zero exits do not throw.
 */
function runGatesCli(projectDir, specId, extraArgs = []) {
  clearQGLock();
  const args = [CLI_PATH, 'gates', 'run', '--spec', specId, ...extraArgs];
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (error) {
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      exitCode: error.status || 1,
    };
  }
}

/**
 * Read the appended `gate_evaluated` events from .caws/events.jsonl.
 * Returns the structured per-gate detail that v11 publishes in events,
 * not stdout.
 */
function readGateEvents(projectDir) {
  const p = path.join(projectDir, '.caws', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.event === 'gate_evaluated');
}

/** Read every event in events.jsonl in seq order (for hash-chain checks). */
function readAllEvents(projectDir) {
  const p = path.join(projectDir, '.caws', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe('gates CLI integration (v11.1)', () => {
  let ctx;

  afterAll(() => {
    if (_gatesCLITemplate) {
      cleanupTemplate(_gatesCLITemplate);
      _gatesCLITemplate = null;
    }
  });

  afterEach(async () => {
    if (ctx) {
      await fs.remove(ctx.dir);
      ctx = null;
    }
  });

  describe('all gates pass', () => {
    test('exits 0 when all gates are in warn mode and project is clean', () => {
      ctx = createTestProject();

      const result = runGatesCli(ctx.dir, ctx.specId, ['--context=cli']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Overall: OK');

      const events = readGateEvents(ctx.dir);
      expect(events.length).toBeGreaterThan(0);
      // Every emitted event for a warn-mode clean project should
      // report pass.
      for (const evt of events) {
        expect(evt.data.result).toBe('pass');
        expect(evt.spec_id).toBe(ctx.specId);
      }
    });

    test('exits 0 with commit context and no staged files', () => {
      ctx = createTestProject();

      const result = runGatesCli(ctx.dir, ctx.specId, ['--context=commit']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Overall: OK');
    });
  });

  describe('budget exceeded (block mode)', () => {
    test('exits 1 when staged file count exceeds tier-1 budget in block mode', () => {
      // v11 policy schema requires monotonic risk_tiers (T1 ≤ T2 ≤ T3 on
      // both max_files and max_loc), and tier-1 specs require contracts,
      // observability, rollback, and non_functional.security. We build a
      // full tier-1 spec because that's the most authoritative tier — the
      // budget evaluator must enforce when a tier-1 spec exceeds its
      // (strict) budget.
      ctx = createTestProject({
        policy: {
          version: 1,
          risk_tiers: {
            1: { max_files: 3, max_loc: 50 },
            2: { max_files: 5, max_loc: 100 },
            3: { max_files: 100, max_loc: 5000 },
          },
          edit_rules: EDIT_RULES,
          gates: {
            budget_limit: { enabled: true, mode: 'block' },
            spec_completeness: { enabled: true, mode: 'warn' },
            scope_boundary: { enabled: true, mode: 'warn' },
          },
        },
        spec: buildValidSpec({
          risk_tier: 1,
          scope: { in: ['src/**'], out: [] },
          // Tier-1 semantic requirements (kernel/spec validate-semantics).
          contracts: [
            { name: 'test-contract', type: 'api', path: 'contracts/test.yaml' },
          ],
          observability: ['log: gates.test_event'],
          rollback: ['revert the staged change'],
          non_functional: { security: ['no secrets in staged files'] },
        }),
      });

      fs.ensureDirSync(path.join(ctx.dir, 'src'));
      for (let i = 0; i < 10; i++) {
        fs.writeFileSync(
          path.join(ctx.dir, 'src', `file${i}.js`),
          `// file ${i}\nconst x = ${i};\n`
        );
      }
      execFileSync('git', ['add', '.'], { cwd: ctx.dir, stdio: 'pipe' });

      const result = runGatesCli(ctx.dir, ctx.specId, ['--context=commit']);
      expect(result.exitCode).toBe(1);

      const events = readGateEvents(ctx.dir);
      const budgetEvent = events.find((e) => e.data.gate_id === 'budget_limit');
      expect(budgetEvent).toBeDefined();
      expect(budgetEvent.data.mode).toBe('block');
      expect(budgetEvent.data.result).toBe('fail');
      expect(Array.isArray(budgetEvent.data.violations)).toBe(true);
      expect(budgetEvent.data.violations.length).toBeGreaterThan(0);

      // Hash-chain assertion: every event's prev_hash must equal the
      // previous event's event_hash; the first event has prev_hash null.
      // This proves the events.jsonl chain is intact and was not corrupted
      // by the local-evaluator + waiver + disposition merge.
      const all = readAllEvents(ctx.dir);
      expect(all.length).toBeGreaterThan(0);
      for (let i = 0; i < all.length; i++) {
        expect(typeof all[i].event_hash).toBe('string');
        expect(all[i].event_hash).toMatch(/^sha256:/);
        if (i === 0) {
          expect(all[i].prev_hash).toBeNull();
        } else {
          expect(all[i].prev_hash).toBe(all[i - 1].event_hash);
        }
      }
    });
  });

  describe('per-gate event detail', () => {
    test('each gate_evaluated event has gate_id, mode, result, violations, waived_count', () => {
      ctx = createTestProject();

      const result = runGatesCli(ctx.dir, ctx.specId, ['--context=cli']);
      expect(result.exitCode).toBe(0);

      const events = readGateEvents(ctx.dir);
      expect(events.length).toBeGreaterThan(0);

      for (const evt of events) {
        expect(typeof evt.data.gate_id).toBe('string');
        expect(['block', 'warn', 'skip']).toContain(evt.data.mode);
        expect(['pass', 'fail', 'skip']).toContain(evt.data.result);
        expect(Array.isArray(evt.data.violations)).toBe(true);
        expect(typeof evt.data.waived_count).toBe('number');
        // Common envelope assertions.
        expect(typeof evt.event_hash).toBe('string');
        expect(typeof evt.seq).toBe('number');
      }
    });

    test('one gate_evaluated event is appended per policy-declared gate', () => {
      ctx = createTestProject();

      runGatesCli(ctx.dir, ctx.specId, ['--context=cli']);

      const events = readGateEvents(ctx.dir);
      const gateIds = events.map((e) => e.data.gate_id).sort();
      // Default policy declares 5 gates.
      expect(gateIds).toEqual(
        ['budget_limit', 'god_object', 'scope_boundary', 'spec_completeness', 'todo_detection'].sort()
      );
    });
  });

  describe('text output', () => {
    test('produces human-readable disposition table on stdout', () => {
      ctx = createTestProject();

      const result = runGatesCli(ctx.dir, ctx.specId, ['--context=cli']);
      expect(result.exitCode).toBe(0);

      // v11 text format: per-gate PASS/FAIL rows + Overall summary.
      expect(result.stdout).toContain('Gate dispositions');
      expect(result.stdout).toContain('PASS');
      expect(result.stdout).toContain('Overall:');
    });

    test('text output is not valid JSON', () => {
      ctx = createTestProject();

      const result = runGatesCli(ctx.dir, ctx.specId, ['--context=cli']);
      expect(result.exitCode).toBe(0);
      expect(() => JSON.parse(result.stdout)).toThrow();
    });
  });

  describe('unmatched violations are surfaced (not silently dropped)', () => {
    test('subprocess gates with no canonical policy mapping appear in the rendered output', () => {
      // 10 new files trigger the subprocess `code_freeze` gate, which has
      // no canonical policy gate mapping (refused alias — semantically
      // distinct from `budget_limit`). The rendered text must report it
      // under "Unmatched violations" so the operator can see what the
      // subprocess found even when policy does not declare a matching
      // gate. Silent suppression here would let real-quality issues slip
      // past the operator.
      ctx = createTestProject();

      fs.ensureDirSync(path.join(ctx.dir, 'src'));
      for (let i = 0; i < 10; i++) {
        fs.writeFileSync(
          path.join(ctx.dir, 'src', `unmatched${i}.js`),
          `// f ${i}\nconst x = ${i};\n`
        );
      }
      execFileSync('git', ['add', '.'], { cwd: ctx.dir, stdio: 'pipe' });

      const result = runGatesCli(ctx.dir, ctx.specId, ['--context=commit']);
      // Exit 0 because no policy-declared gate blocks (default policy is
      // all warn). The subprocess code_freeze violation surfaces as an
      // unmatched violation, not as a block.
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Unmatched violations');
      expect(result.stdout).toContain('code_freeze');
    });
  });

  describe('scope boundary violation in block mode', () => {
    test('exits 1 when staged file is out of scope with block mode', () => {
      ctx = createTestProject({
        policy: {
          version: 1,
          risk_tiers: {
            1: { max_files: 25, max_loc: 1000 },
            2: { max_files: 50, max_loc: 2000 },
            3: { max_files: 100, max_loc: 5000 },
          },
          edit_rules: EDIT_RULES,
          gates: {
            scope_boundary: { enabled: true, mode: 'block' },
            budget_limit: { enabled: true, mode: 'warn' },
            spec_completeness: { enabled: true, mode: 'warn' },
          },
        },
        spec: buildValidSpec({
          scope: { in: ['src/**'], out: [] },
        }),
      });

      fs.ensureDirSync(path.join(ctx.dir, 'vendor'));
      fs.writeFileSync(path.join(ctx.dir, 'vendor', 'lib.js'), '// out of scope\n');
      execFileSync('git', ['add', '.'], { cwd: ctx.dir, stdio: 'pipe' });

      const result = runGatesCli(ctx.dir, ctx.specId, ['--context=commit']);
      expect(result.exitCode).toBe(1);

      const events = readGateEvents(ctx.dir);
      const scopeEvent = events.find((e) => e.data.gate_id === 'scope_boundary');
      expect(scopeEvent).toBeDefined();
      expect(scopeEvent.data.mode).toBe('block');
      expect(scopeEvent.data.result).toBe('fail');
    });
  });
});
