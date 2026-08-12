'use strict';

/**
 * CAWS-DEFECT-SPEC-DEACTIVATE-MISSING-01 — caws specs deactivate (active -> draft).
 *
 * The lifecycle had no non-terminal exit from `active`. A spec activated
 * against the wrong id, or whose slice turned out to be unnecessary, could only
 * leave that state through `close` — which writes a `resolution` asserting the
 * work concluded. That is a false statement in the audit trail, and the audit
 * trail is the product. deactivate demotes to draft, asserts nothing about
 * outcomes, and is refused where the one-way property is load-bearing: a spec
 * bound to a live worktree.
 *
 * SUT: compiled surface — require('../../dist/store/specs-writer') (writer),
 * require('../../dist/shell/commands/specs') (command), plus one spawned
 * dist/index.js run to pin the Commander wiring, which handler-level tests
 * bypass entirely.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { initProject } = require('../../dist/store/init-store');
const { runSpecsDeactivateCommand } = require('../../dist/shell/commands/specs');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

afterAll(() => {
  cleanupAll();
});

function specBody(id, lifecycleState, extraTopLevel = '') {
  return `id: ${id}
title: '${id}'
risk_tier: 3
mode: chore
lifecycle_state: ${lifecycleState}
${extraTopLevel}created_at: '2026-07-30T00:00:00.000Z'
updated_at: '2026-07-30T00:00:00.000Z'
blast_radius:
  modules:
    - tests
  data_migration: false
operational_rollback_slo: 5m
scope:
  in:
    - tests
  out: []
invariants:
  - fixture
acceptance:
  - id: A1
    given: fixture
    when: fixture
    then: fixture
non_functional: {}
contracts: []
`;
}

function writeSpec(cawsDir, id, lifecycleState, extraTopLevel = '') {
  fs.writeFileSync(
    path.join(cawsDir, 'specs', `${id}.yaml`),
    specBody(id, lifecycleState, extraTopLevel)
  );
}

function setupRepo(id, lifecycleState, extraTopLevel = '') {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed');
  const cawsDir = path.join(root, '.caws');
  writeSpec(cawsDir, id, lifecycleState, extraTopLevel);
  return { root, cawsDir, specPath: path.join(cawsDir, 'specs', `${id}.yaml`) };
}

function runDeactivate(cwd, id, opts = {}) {
  const out = [];
  const err = [];
  const code = runSpecsDeactivateCommand({
    cwd,
    now: () => new Date('2026-07-30T12:00:00.000Z'),
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'test-session' },
    id,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function readEvents(cawsDir) {
  const p = path.join(cawsDir, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

describe('A1: an active, unbound spec demotes to draft with no closure claim', () => {
  test('lifecycle_state becomes draft and spec_deactivated is appended', () => {
    const { root, cawsDir, specPath } = setupRepo('DEACT-A1-001', 'active');

    const result = runDeactivate(root, 'DEACT-A1-001');
    expect(result.code).toBe(0);
    expect(result.out).toContain('deactivated DEACT-A1-001');
    expect(result.out).toContain('lifecycle_state: draft');

    const yaml = fs.readFileSync(specPath, 'utf8');
    expect(yaml).toContain('lifecycle_state: draft');
    expect(yaml).not.toContain('lifecycle_state: active');

    // HEADLINE: the demotion asserts nothing about outcomes. A resolution here
    // would be the exact false closure this command exists to avoid.
    expect(yaml).not.toMatch(/^resolution:/m);
    expect(yaml).not.toMatch(/^closure_notes:/m);

    const deactivated = readEvents(cawsDir).filter((e) => e.event === 'spec_deactivated');
    expect(deactivated).toHaveLength(1);
    expect(deactivated[0].spec_id).toBe('DEACT-A1-001');
    expect(deactivated[0].data.previous_lifecycle_state).toBe('active');
    // No spec_closed anywhere: the audit trail must not record a closure.
    expect(readEvents(cawsDir).filter((e) => e.event === 'spec_closed')).toHaveLength(0);
  });

  test('--reason lands on the event, never in the spec body', () => {
    const { root, cawsDir, specPath } = setupRepo('DEACT-REASON-001', 'active');

    const result = runDeactivate(root, 'DEACT-REASON-001', {
      reason: 'activated against the wrong id',
    });
    expect(result.code).toBe(0);

    const deactivated = readEvents(cawsDir).filter((e) => e.event === 'spec_deactivated');
    expect(deactivated[0].data.reason).toBe('activated against the wrong id');
    // The reason is audit, not a closure note — the body must not absorb it.
    expect(fs.readFileSync(specPath, 'utf8')).not.toContain('activated against the wrong id');
  });

  test('the demoted spec is a draft the CLI will accept for re-activation', () => {
    const { root, cawsDir } = setupRepo('DEACT-ROUNDTRIP-001', 'active');

    expect(runDeactivate(root, 'DEACT-ROUNDTRIP-001').code).toBe(0);

    // Not vacuous: prove the demoted body is genuinely a valid draft by driving
    // the real activate leg over it. A body that only *looks* like a draft
    // would fail here.
    const activate = spawnSync(process.execPath, [CLI, 'specs', 'activate', 'DEACT-ROUNDTRIP-001'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'test-session' },
    });
    expect(activate.status).toBe(0);
    const yaml = fs.readFileSync(path.join(cawsDir, 'specs', 'DEACT-ROUNDTRIP-001.yaml'), 'utf8');
    expect(yaml).toContain('lifecycle_state: active');
  });
});

describe('A2: a spec bound to a worktree is refused', () => {
  test('the refusal names the worktree and mutates nothing', () => {
    const { root, cawsDir, specPath } = setupRepo(
      'DEACT-BOUND-001',
      'active',
      "worktree: wt-deact-bound\n"
    );
    const before = fs.readFileSync(specPath, 'utf8');

    const result = runDeactivate(root, 'DEACT-BOUND-001');
    expect(result.code).toBe(1);
    expect(result.err).toContain('bound to worktree "wt-deact-bound"');
    // The remediation must name the lane's real exits, not just say no.
    expect(result.err).toContain('caws worktree merge wt-deact-bound');
    expect(result.err).toContain('caws worktree repair');

    // Byte-identical: a refused transition writes nothing.
    expect(fs.readFileSync(specPath, 'utf8')).toBe(before);
    expect(readEvents(cawsDir).filter((e) => e.event === 'spec_deactivated')).toHaveLength(0);
  });
});

describe('A3: every non-active state is refused, naming its own correct transition', () => {
  test('a draft is refused and points at retire-draft', () => {
    const { root, specPath } = setupRepo('DEACT-DRAFT-001', 'draft');
    const before = fs.readFileSync(specPath, 'utf8');

    const result = runDeactivate(root, 'DEACT-DRAFT-001');
    expect(result.code).toBe(1);
    expect(result.err).toContain('already a draft');
    expect(result.err).toContain('caws specs retire-draft DEACT-DRAFT-001');
    expect(fs.readFileSync(specPath, 'utf8')).toBe(before);
  });

  test('a closed spec is refused and points at reopen, not at close', () => {
    const { root, specPath } = setupRepo(
      'DEACT-CLOSED-001',
      'closed',
      "resolution: completed\nclosure_notes: 'done'\n"
    );
    const before = fs.readFileSync(specPath, 'utf8');

    const result = runDeactivate(root, 'DEACT-CLOSED-001');
    expect(result.code).toBe(1);
    expect(result.err).toContain('is closed');
    expect(result.err).toContain('caws specs reopen DEACT-CLOSED-001');
    expect(fs.readFileSync(specPath, 'utf8')).toBe(before);
  });

  test('an archived spec is refused and points at restore', () => {
    const root = makeTempRepo();
    initProject(root);
    const cawsDir = path.join(root, '.caws');
    const archiveDir = path.join(cawsDir, 'specs', '.archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, 'DEACT-ARCHIVED-001.yaml'),
      specBody('DEACT-ARCHIVED-001', 'archived')
    );

    const result = runDeactivate(root, 'DEACT-ARCHIVED-001');
    expect(result.code).toBe(1);
    expect(result.err).toContain('archived');
    expect(result.err).toContain('caws specs restore DEACT-ARCHIVED-001');
  });
});

describe('A4: closure residue never survives the demotion', () => {
  test('closure_notes on an active body are stripped and recorded on the event', () => {
    // A body that reached active still carrying closure_notes. The governed
    // reopen leg strips these, so this pins deactivate's OWN strip rather than
    // inheriting reopen's — without it, the assertion below would pass for the
    // wrong reason.
    const { root, cawsDir, specPath } = setupRepo(
      'DEACT-RESIDUE-001',
      'active',
      "closure_notes: 'closure that no longer applies'\n"
    );
    expect(fs.readFileSync(specPath, 'utf8')).toContain('closure that no longer applies');

    const result = runDeactivate(root, 'DEACT-RESIDUE-001');
    expect(result.code).toBe(0);

    const yaml = fs.readFileSync(specPath, 'utf8');
    expect(yaml).toContain('lifecycle_state: draft');
    expect(yaml).not.toMatch(/^closure_notes:/m);
    expect(yaml).not.toContain('closure that no longer applies');

    // The removal is auditable, not silent.
    const deactivated = readEvents(cawsDir).filter((e) => e.event === 'spec_deactivated');
    expect(deactivated[0].data.cleared_terminal_fields).toEqual(['closure_notes']);
  });

  test('a clean body reports no cleared fields', () => {
    const { root, cawsDir } = setupRepo('DEACT-NORESIDUE-001', 'active');
    expect(runDeactivate(root, 'DEACT-NORESIDUE-001').code).toBe(0);

    const deactivated = readEvents(cawsDir).filter((e) => e.event === 'spec_deactivated');
    // Absent, not an empty array — the event should not claim work it did not do.
    expect(deactivated[0].data.cleared_terminal_fields).toBeUndefined();
  });
});

describe('the Commander wiring is real, not just the handler', () => {
  test('a spawned CLI run demotes the spec and forwards --reason', () => {
    const { root, cawsDir, specPath } = setupRepo('DEACT-CLI-001', 'active');

    const run = spawnSync(
      process.execPath,
      [CLI, 'specs', 'deactivate', 'DEACT-CLI-001', '--reason', 'wrong id at activation'],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'test-session' },
      }
    );

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('deactivated DEACT-CLI-001');
    expect(fs.readFileSync(specPath, 'utf8')).toContain('lifecycle_state: draft');

    // HEADLINE for this test: --reason survived the register.ts opt-forward.
    // A handler-level test cannot see a dropped mapping here.
    const deactivated = readEvents(cawsDir).filter((e) => e.event === 'spec_deactivated');
    expect(deactivated[0].data.reason).toBe('wrong id at activation');
  });
});
