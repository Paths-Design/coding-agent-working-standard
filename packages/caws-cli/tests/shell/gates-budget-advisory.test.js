'use strict';

/**
 * CAWS-BUDGET-LIMIT-ADVISORY-SIZING-GOAL-01 — shell side.
 *
 * Risk-tier change budgets are a sizing goal, never an enforced limit. When
 * `budget_limit` blocked, agents trimmed, deferred or stubbed work to come in
 * under a line count; the boundary CAWS actually enforces is scope. These
 * tests pin, from the evaluator to a spawned `caws gates run`:
 *
 *   - an over-budget staged change never blocks, even when policy.yaml still
 *     declares `mode: block` (the pre-change default every consumer carries);
 *   - the recorded gate_evaluated event says what happened (mode warn), not
 *     what the config asked for;
 *   - the text an agent reads tells it not to cut work to fit, and never
 *     offers a waiver for a size number;
 *   - blocking itself still works: a scope_boundary violation in the same
 *     run exits 1. Without that control, "never blocks" would also pass
 *     against a gate runner that had stopped blocking altogether.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const { deriveDispositions } = require('../../dist/shell/gates/disposition');
const { evaluateBudgetLimit } = require('../../dist/shell/gates/local-evaluators/budget-limit');
const { renderGatesRun } = require('../../dist/shell/render/gates');
const { initProject } = require('../../dist/store/init-store');
const { runSpecsCreateCommand } = require('../../dist/shell/commands/specs');
const { cleanupAll, makeTempRepo, git } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

afterAll(() => {
  cleanupAll();
});

const ADVICE =
  'A sizing goal, not a limit: do not trim, defer or stub work to fit it. ' +
  'If the change is larger than planned, say so in the spec.';

function policyWith(budgetMode) {
  return {
    version: 1,
    risk_tiers: {
      1: { max_files: 1, max_loc: 3 },
      2: { max_files: 1, max_loc: 3 },
      3: { max_files: 1, max_loc: 3 },
    },
    gates: {
      budget_limit: { enabled: true, mode: budgetMode },
      spec_completeness: { enabled: true, mode: 'block' },
      scope_boundary: { enabled: true, mode: 'block' },
      god_object: { enabled: true, mode: 'warn' },
      todo_detection: { enabled: true, mode: 'warn' },
    },
    edit_rules: {
      policy_and_code_same_pr: true,
      require_signed_commits: false,
      require_dual_control_for_governance: false,
    },
  };
}

function budgetViolation() {
  return { gate: 'budget_limit', type: 'max_loc_exceeded', message: 'over', severity: 'warn' };
}

describe('disposition: budget_limit never blocks', () => {
  test.each(['block', 'warn'])(
    'a budget violation under declared mode %s is a non-blocking warn disposition',
    (declared) => {
      const r = deriveDispositions({ violations: [budgetViolation()] }, policyWith(declared));
      const d = r.dispositions.find((x) => x.gate_id === 'budget_limit');
      expect(d).toMatchObject({ mode: 'warn', outcome: 'fail', blocks: false });
      expect(d.declared_mode).toBe(declared === 'block' ? 'block' : undefined);
      expect(r.anyBlocks).toBe(false);
    }
  );

  test('skip still skips the budget gate', () => {
    const r = deriveDispositions({ violations: [budgetViolation()] }, policyWith('skip'));
    const d = r.dispositions.find((x) => x.gate_id === 'budget_limit');
    expect(d).toMatchObject({ mode: 'skip', outcome: 'skipped', blocks: false });
  });

  test('a scope_boundary violation in block mode still blocks beside an advisory budget', () => {
    const r = deriveDispositions(
      {
        violations: [
          budgetViolation(),
          { gate: 'scope_boundary', type: 'scope.reject', message: 'out', severity: 'fail' },
        ],
      },
      policyWith('block')
    );
    expect(r.dispositions.find((x) => x.gate_id === 'scope_boundary').blocks).toBe(true);
    expect(r.dispositions.find((x) => x.gate_id === 'budget_limit').blocks).toBe(false);
    expect(r.anyBlocks).toBe(true);
  });
});

describe('evaluator: the overage reads as a sizing observation', () => {
  const spec = { risk_tier: 2 };

  test('a line overage names the count, the goal, and says not to cut work to fit', () => {
    const r = evaluateBudgetLimit({
      spec,
      policy: policyWith('warn'),
      repoRoot: '/unused',
      stagedChanges: [{ path: 'src/a.ts', insertions: 10, deletions: 0 }],
    });
    expect(r.violations).toEqual([
      {
        gate: 'budget_limit',
        type: 'max_loc_exceeded',
        message: `Staged change adds 10 line(s); the risk-tier 2 sizing goal is 3. ${ADVICE}`,
        severity: 'warn',
      },
    ]);
  });

  test('a file-count overage names the count and the goal the same way', () => {
    const r = evaluateBudgetLimit({
      spec,
      policy: policyWith('warn'),
      repoRoot: '/unused',
      stagedChanges: [
        { path: 'src/a.ts', insertions: 1, deletions: 0 },
        { path: 'src/b.ts', insertions: 1, deletions: 0 },
      ],
    });
    expect(r.violations).toEqual([
      {
        gate: 'budget_limit',
        type: 'max_files_exceeded',
        message: `Staged change touches 2 file(s); the risk-tier 2 sizing goal is 1. ${ADVICE}`,
        severity: 'warn',
      },
    ]);
  });

  test('a change within the goal reports nothing', () => {
    const r = evaluateBudgetLimit({
      spec,
      policy: policyWith('warn'),
      repoRoot: '/unused',
      stagedChanges: [{ path: 'src/a.ts', insertions: 3, deletions: 0 }],
    });
    expect(r.violations).toEqual([]);
  });
});

describe('renderer: an overage is labeled advisory and never offers a waiver', () => {
  function rendered(declared) {
    return renderGatesRun(
      deriveDispositions(
        { violations: [{ ...budgetViolation(), message: 'Staged change adds 10 line(s).' }] },
        policyWith(declared)
      )
    );
  }

  test('the budget line says OVER and advisory, and the run is OK', () => {
    const text = rendered('warn');
    expect(text).toContain(
      '  OVER     budget_limit (mode=warn, 1 violations) [advisory — never blocks]'
    );
    expect(text).toContain('              → Staged change adds 10 line(s).');
    expect(text).not.toMatch(/FAIL\s+budget_limit/);
    expect(text).not.toMatch(/caws waiver create/);
    expect(text).toMatch(/Overall: OK$/);
  });

  test('a policy still declaring block is told that block is not honored', () => {
    expect(rendered('block')).toContain(
      '              policy.yaml declares mode=block for this gate; it is not honored ' +
        '(budgets are a sizing goal). Set gates.budget_limit.mode to "warn".'
    );
    expect(rendered('warn')).not.toContain('is not honored');
  });
});

describe('init: the default policy declares the budget advisory', () => {
  test('a fresh init writes budget_limit in warn mode and keeps the sizing goals', () => {
    const root = makeTempRepo();
    const r = initProject(root);
    expect(r.ok).toBe(true);
    const policy = yaml.load(fs.readFileSync(path.join(root, '.caws', 'policy.yaml'), 'utf8'));
    expect(policy.gates.budget_limit).toEqual({ enabled: true, mode: 'warn' });
    expect(policy.gates.scope_boundary).toEqual({ enabled: true, mode: 'block' });
    expect(policy.risk_tiers['2']).toEqual({ max_files: 15, max_loc: 600 });
  });
});

describe('caws gates run: an over-budget staged change does not block', () => {
  function mkRepo(budgetMode) {
    const root = makeTempRepo();
    const init = initProject(root);
    if (!init.ok) throw new Error('initProject failed: ' + JSON.stringify(init.errors));
    fs.writeFileSync(path.join(root, '.caws', 'policy.yaml'), yaml.dump(policyWith(budgetMode)));
    const code = runSpecsCreateCommand({
      cwd: root,
      id: 'BUDGET-ADVISORY-001',
      title: 'Budget advisory end to end',
      mode: 'fix',
      tier: 3,
      scopeIn: ['src'],
      activate: true,
      now: () => new Date('2026-10-01T00:00:00.000Z'),
      out: () => {},
      err: () => {},
    });
    if (code !== 0) throw new Error(`spec create failed with code ${code}`);
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(
      path.join(root, 'src', 'a.ts'),
      'export const a = [\n1,\n2,\n3,\n4,\n5,\n];\n'
    );
    fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = 1;\n');
    git(root, ['add', 'src']);
    return root;
  }

  function runGates(root) {
    return spawnSync(process.execPath, [CLI, 'gates', 'run', 'BUDGET-ADVISORY-001'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'gates-budget-advisory-test' },
    });
  }

  function budgetEvents(root) {
    return fs
      .readFileSync(path.join(root, '.caws', 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((e) => e.event === 'gate_evaluated' && e.data.gate_id === 'budget_limit');
  }

  test('under a policy still declaring block, the run exits 0 and records mode warn', () => {
    const root = mkRepo('block');
    const result = runGates(root);
    expect(result.stdout).toContain('OVER     budget_limit (mode=warn, 2 violations)');
    expect(result.stdout).toContain(
      `Staged change touches 2 file(s); the risk-tier 3 sizing goal is 1. ${ADVICE}`
    );
    expect(result.stdout).toContain('Overall: OK');
    expect(result.status).toBe(0);
    const events = budgetEvents(root);
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ gate_id: 'budget_limit', mode: 'warn', result: 'fail' });
    expect(events[0].data.violations.map((v) => v.rule).sort()).toEqual([
      'max_files_exceeded',
      'max_loc_exceeded',
    ]);
  });

  test('the same run still blocks on a staged file outside scope.in', () => {
    const root = mkRepo('block');
    fs.writeFileSync(path.join(root, 'OUTSIDE.md'), 'out of scope\n');
    git(root, ['add', 'OUTSIDE.md']);
    const result = runGates(root);
    expect(result.stdout).toMatch(/FAIL\s+scope_boundary \(mode=block, 1 violations\) \[BLOCKS\]/);
    expect(result.stdout).toContain('Overall: BLOCKED by policy');
    expect(result.status).toBe(1);
  });
});
