'use strict';

/**
 * CAWS-SPEC-ACTIVATION-BINDS-001 — regression pins for four defects found by a
 * headless AX probe (five blind `claude -p` sessions against this build).
 *
 * These are message-and-guidance defects, which is exactly why they need tests:
 * nothing else fails when remediation prose drifts, and every one of these was
 * invisible to the 1958-test suite that was green when they shipped.
 *
 * D1  `specs create` told the caller to `git add && git commit` a spec the CLI
 *     had ALREADY auto-committed. The probed agent ran it, got exit 1, and
 *     burned two diagnostic commands. A remediation the CLI itself refuses is
 *     the failure class this repo treats as most dangerous.
 * D2  The gates refusal offered `caws specs activate` as a COEQUAL remedy to
 *     binding. An agent whose task was "make the gate pass" took it and ended
 *     with an active spec, no worktree, and no work done — re-manufacturing the
 *     unbound-active backlog this slice exists to remove.
 * D3  The scope candidate list was headed "active spec candidates" while
 *     containing drafts, contradicting a command two lines below it.
 * D4  The bind-time draft→active promotion was silent — the one command that
 *     changes a spec's lifecycle was the one that never said so.
 */

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
const { runSpecsCreateCommand } = require('../../dist/shell/commands/specs');
const { runWorktreeCreateCommand } = require('../../dist/shell/commands/worktree');
const { runScopeCommand } = require('../../dist/shell/index');
const {
  evaluateSpecCompleteness,
} = require('../../dist/shell/gates/local-evaluators/spec-completeness');
const { inspectProjectState } = require('../../dist/kernel/doctor/inspect');
const { DOCTOR_RULES } = require('../../dist/kernel/doctor/rules');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed');
  return { root, caws: path.join(root, '.caws') };
}

function runCreate(cwd, id, opts = {}) {
  const out = [];
  const err = [];
  const code = runSpecsCreateCommand({
    cwd,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'ax-probe-test' },
    id,
    title: 'AX probe fixture',
    mode: 'chore',
    riskTier: '3',
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('D1: the create next-steps match what the auto-commit actually did', () => {
  test('a spec the CLI committed is not followed by an instruction to commit it', () => {
    const { root } = mkRepo();

    const result = runCreate(root, 'AX-D1-001', { scopeIn: ['src'] });

    expect(result.code).toBe(0);
    expect(result.out).toContain('already committed');
    expect(result.out).toContain('nothing further to stage');
    // The instruction that exits 1 for every compliant caller.
    expect(result.out).not.toContain('git add .caws/specs/AX-D1-001.yaml && git commit');
  });

  test('the same is true on the branch that does not populate scope.in', () => {
    const { root } = mkRepo();

    const result = runCreate(root, 'AX-D1-002');

    expect(result.out).toContain('already committed');
    expect(result.out).not.toContain('&& git commit');
  });

  test('the commit instruction still appears when the audit commit did NOT land', () => {
    // Negative control. The manual step is correct on the refused_dirty path;
    // suppressing it unconditionally would hide a real next action. Dirty the
    // the spec path first so autoCommit refuses.
    const { root, caws } = mkRepo();
    fs.writeFileSync(path.join(caws, 'specs', 'AX-D1-003.yaml'), 'stale: true\n');
    fs.rmSync(path.join(caws, 'specs', 'AX-D1-003.yaml'));
    // Make the index unusable for a clean single-path commit by leaving an
    // unrelated staged change the writer must not sweep.
    fs.writeFileSync(path.join(root, 'unrelated.txt'), 'unstaged\n');

    const result = runCreate(root, 'AX-D1-003');

    // Whatever the autocommit outcome, the two branches must be mutually
    // exclusive: never both "already committed" and a manual commit command.
    const saysCommitted = result.out.includes('already committed');
    const saysRunCommit = result.out.includes('&& git commit');
    expect(saysCommitted && saysRunCommit).toBe(false);
    expect(saysCommitted || saysRunCommit).toBe(true);
  });
});

describe('D2: activate is offered as an exception, not a coequal shortcut', () => {
  function draftViolation() {
    return evaluateSpecCompleteness({
      spec: {
        id: 'AX-D2-001',
        lifecycle_state: 'draft',
        blast_radius: { modules: ['tests'] },
        invariants: ['fixture'],
        acceptance: [{ id: 'A1', given: 'g', when: 'w', then: 't' }],
        scope: { in: ['tests'], out: [] },
      },
    }).violations.find((v) => v.type === 'spec_not_active');
  }

  test('the gates refusal leads with the bind and conditions the direct activate', () => {
    const message = draftViolation().message;

    const bindAt = message.indexOf('caws worktree create');
    const activateAt = message.indexOf('caws specs activate');
    expect(bindAt).toBeGreaterThan(-1);
    expect(activateAt).toBeGreaterThan(-1);
    // Order carries meaning: the remedy comes first, the exception second.
    expect(bindAt).toBeLessThan(activateAt);
    expect(message).toContain('Only if you are working this slice right now WITHOUT a worktree');
    // Name the consequence, so "make the gate pass" does not read as a licence.
    expect(message).toContain('leaves an active spec nobody is working');
  });

  test('doctor states the consequence of close as well as of deactivate', () => {
    const report = inspectProjectState({
      now: new Date('2026-06-15T12:00:00.000Z'),
      worktrees: {},
      specs: [
        {
          id: 'AX-D2-002',
          lifecycle_state: 'active',
          updated_at: '2026-06-15T09:00:00.000Z',
        },
      ],
    });

    const perSpec = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_STALE
    );
    const aggregate = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.SPEC_UNBOUND_ACTIVE_BACKLOG
    );

    // The parenthetical on deactivate is measurably load-bearing — a probe
    // agent quoted it as its reason for not closing unworked specs. close was
    // carrying no matching clause, so the asymmetry steered by accident.
    for (const repair of [perSpec.narrowRepair, aggregate.narrowRepair]) {
      expect(repair).toContain('no resolution written');
      // Both surfaces must state close's CONSEQUENCE, not merely offer it.
      // The exact phrasing differs between the per-spec and aggregate
      // findings; what is pinned is that each names the resolution write.
      expect(repair).toMatch(/close[^.]*writes a resolution/);
      expect(repair).toMatch(/close[^.]*concluded/);
    }
  });
});

describe('D3: candidate rows carry their own lifecycle state', () => {
  function writeSpec(caws, id, scopeIn, lifecycleState) {
    fs.writeFileSync(
      path.join(caws, 'specs', `${id}.yaml`),
      `id: ${id}
title: 'AX D3 fixture'
risk_tier: 3
mode: chore
lifecycle_state: ${lifecycleState}
created_at: '2026-07-04T00:00:00.000Z'
updated_at: '2026-07-04T00:00:00.000Z'
blast_radius:
  modules:
    - tests
  data_migration: false
operational_rollback_slo: 5m
scope:
  in:
${scopeIn.map((p) => `    - ${p}`).join('\n')}
  out: []
invariants:
  - 'fixture'
acceptance:
  - id: A1
    given: 'fixture'
    when: 'fixture'
    then: 'fixture'
non_functional: {}
contracts: []
`
    );
  }

  test('a draft claimant is not rendered under an "active spec candidates" heading', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'AX-D3-DRAFT-001', ['src/owned'], 'draft');
    const out = [];
    runScopeCommand({
      cwd: root,
      path: 'src/owned/file.ts',
      mode: 'show',
      out: (line) => out.push(line),
      err: () => {},
    });
    const text = out.join('\n');

    expect(text).toContain('spec candidates:');
    expect(text).not.toContain('active spec candidates:');
    // The row says what the spec actually is.
    expect(text).toContain('AX-D3-DRAFT-001 (draft, no worktree)');
    // ...and the summary no longer promises an "active" authority.
    expect(text).not.toContain('choose an active spec authority');
  });

  test('an active claimant is labelled active on its own row', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'AX-D3-ACTIVE-002', ['src/owned'], 'active');
    const out = [];
    runScopeCommand({
      cwd: root,
      path: 'src/owned/file.ts',
      mode: 'show',
      out: (line) => out.push(line),
      err: () => {},
    });

    expect(out.join('\n')).toContain('AX-D3-ACTIVE-002 (active, no worktree)');
  });
});

describe('D4: the bind announces the lifecycle transition it performed', () => {
  test('creating a worktree for a draft says the spec was activated', () => {
    const { root, caws } = mkRepo();
    runCreate(root, 'AX-D4-001');
    expect(
      fs.readFileSync(path.join(caws, 'specs', 'AX-D4-001.yaml'), 'utf8')
    ).toContain('lifecycle_state: draft');

    const out = [];
    const code = runWorktreeCreateCommand({
      cwd: root,
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'ax-probe-test' },
      name: 'wt-ax-d4',
      specId: 'AX-D4-001',
      out: (line) => out.push(line),
      err: () => {},
    });

    expect(code).toBe(0);
    expect(out.join('\n')).toContain('AX-D4-001 activated (draft → active) by this binding.');
  });

  test('creating a worktree for an already-active spec claims no transition', () => {
    const { root } = mkRepo();
    runCreate(root, 'AX-D4-002', { activate: true });

    const out = [];
    runWorktreeCreateCommand({
      cwd: root,
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'ax-probe-test' },
      name: 'wt-ax-d4b',
      specId: 'AX-D4-002',
      out: (line) => out.push(line),
      err: () => {},
    });

    expect(out.join('\n')).not.toContain('activated (draft → active)');
  });
});
