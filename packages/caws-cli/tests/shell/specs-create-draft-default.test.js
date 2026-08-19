'use strict';

/**
 * CAWS-SPEC-ACTIVATION-BINDS-001 — `caws specs create` yields a DRAFT.
 *
 * `active` now asserts that a worktree is bound and the slice is being worked,
 * which creation cannot truthfully claim. Minting active at create time is what
 * made `active` a record of "someone typed a command" rather than a work
 * signal, and how repos reached dozens of active specs nobody was working.
 *
 * `--activate` keeps the old behavior for the case it was actually right for:
 * working a slice without a worktree. `caws specs activate` / `deactivate` are
 * unaffected and still move a spec between the two states on demand.
 *
 * The spawned-CLI cases are load-bearing. Commander parsing `--activate` is not
 * the same as `runSpecsCreateCommand` receiving it; a dropped mapping in
 * register.ts is invisible to every handler-level test in this file.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { initProject } = require('../../dist/store/init-store');
const { runSpecsCreateCommand } = require('../../dist/shell/commands/specs');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

afterAll(() => {
  cleanupAll();
});

function setupRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed');
  return { root, cawsDir: path.join(root, '.caws') };
}

function runCreate(cwd, id, opts = {}) {
  const out = [];
  const err = [];
  const code = runSpecsCreateCommand({
    cwd,
    now: () => new Date('2026-08-12T12:00:00.000Z'),
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'test-session' },
    id,
    title: 'draft default fixture',
    mode: 'chore',
    riskTier: '3',
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function lifecycleOf(cawsDir, id) {
  const m = /^lifecycle_state:\s*(\S+)\s*$/m.exec(
    fs.readFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), 'utf8')
  );
  return m === null ? null : m[1];
}

function specCreatedEvent(cawsDir, id) {
  const p = path.join(cawsDir, 'events.jsonl');
  if (!fs.existsSync(p)) return undefined;
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
    .find((e) => e.event === 'spec_created' && e.spec_id === id);
}

function spawnCreate(cwd, id, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [
      CLI,
      'specs',
      'create',
      id,
      '--title',
      'spawned draft default fixture',
      '--mode',
      'chore',
      '--risk-tier',
      '3',
      ...extraArgs,
    ],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, CAWS_QUIET: '1', CLAUDE_CODE_SESSION_ID: 'test-session' },
    }
  );
}

describe('specs create yields a draft by default', () => {
  test('the spec body, the reported state, and the spec_created event all say draft', () => {
    const { root, cawsDir } = setupRepo();

    const result = runCreate(root, 'DRAFT-DEFAULT-001');

    expect(result.code).toBe(0);
    expect(lifecycleOf(cawsDir, 'DRAFT-DEFAULT-001')).toBe('draft');
    expect(result.out).toContain('(lifecycle_state: draft)');
    // The event is what an auditor reads; it must not disagree with the body.
    expect(specCreatedEvent(cawsDir, 'DRAFT-DEFAULT-001')?.data?.lifecycle_state).toBe('draft');
  });

  test('the create output says what draft costs and what lifts it', () => {
    const { root } = setupRepo();

    const result = runCreate(root, 'DRAFT-DEFAULT-002');

    // Without this, a first-timer reads "draft" as "broken" and reaches for
    // --activate, recreating the condition the default exists to prevent.
    expect(result.out).toContain('fully editable');
    expect(result.out).toContain('does not appear in the active set');
    expect(result.out).toContain('binding a worktree activates it');
    expect(result.out).toContain('caws worktree create <name> --spec DRAFT-DEFAULT-002');
  });

  test('--activate creates the spec active instead', () => {
    const { root, cawsDir } = setupRepo();

    const result = runCreate(root, 'ACTIVE-OPTIN-003', { activate: true });

    expect(result.code).toBe(0);
    expect(lifecycleOf(cawsDir, 'ACTIVE-OPTIN-003')).toBe('active');
    expect(result.out).toContain('(lifecycle_state: active)');
    expect(specCreatedEvent(cawsDir, 'ACTIVE-OPTIN-003')?.data?.lifecycle_state).toBe('active');
    // No draft guidance on the path that did not produce a draft.
    expect(result.out).not.toContain('fully editable');
  });

  test('--plan reports the state it would write, and writes nothing', () => {
    const { root, cawsDir } = setupRepo();

    const draftPlan = runCreate(root, 'PLAN-DRAFT-004', { plan: true, json: true });
    const activePlan = runCreate(root, 'PLAN-ACTIVE-005', {
      plan: true,
      json: true,
      activate: true,
    });

    expect(JSON.parse(draftPlan.out).candidate.lifecycle_state).toBe('draft');
    expect(JSON.parse(activePlan.out).candidate.lifecycle_state).toBe('active');
    expect(fs.existsSync(path.join(cawsDir, 'specs', 'PLAN-DRAFT-004.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(cawsDir, 'specs', 'PLAN-ACTIVE-005.yaml'))).toBe(false);
  });
});

describe('the flag survives Commander parsing', () => {
  test('spawned CLI: no flag creates a draft', () => {
    const { root, cawsDir } = setupRepo();

    const result = spawnCreate(root, 'SPAWN-DRAFT-006');

    expect(result.status).toBe(0);
    expect(lifecycleOf(cawsDir, 'SPAWN-DRAFT-006')).toBe('draft');
  });

  test('spawned CLI: --activate reaches the writer', () => {
    const { root, cawsDir } = setupRepo();

    // A dropped mapping in register.ts leaves opts.activate undefined forever,
    // so the flag parses cleanly and every spec is created draft anyway. Only a
    // full-parse-path run catches that.
    const result = spawnCreate(root, 'SPAWN-ACTIVE-007', ['--activate']);

    expect(result.status).toBe(0);
    expect(lifecycleOf(cawsDir, 'SPAWN-ACTIVE-007')).toBe('active');
  });

  test('spawned CLI: --activate is documented in help', () => {
    const { root } = setupRepo();

    const help = spawnSync(process.execPath, [CLI, 'specs', 'create', '--help'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CAWS_QUIET: '1' },
    });

    expect(help.stdout).toContain('--activate');
    expect(help.stdout).toContain('lifecycle_state: draft');
  });
});
