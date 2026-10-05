'use strict';

/**
 * CAWS-GOAL-AC-STOP-GATE-01 — `caws goal set | show | clear` contract tests.
 *
 * These pin the CLI half of the gate: the binding this writes is the ONLY
 * thing that turns the Stop handler on, so its location, its shape, and its
 * refusals are load-bearing. The handler half is pinned in
 * tests/hooks/bats/goal-ac-gate.bats.
 *
 * Two properties get the most attention because they are the ones that fail
 * silently rather than loudly:
 *   - the binding must land where the hook looks (.caws/sessions/<id>/), and
 *   - `set` must refuse a spec the hook could not evaluate, because at stop
 *     time that is indistinguishable from a gate failure.
 *
 * Real on-disk repos + injected sinks.
 */

const fs = require('fs');
const path = require('path');

const {
  runGoalClearCommand,
  runGoalSetCommand,
  runGoalShowCommand,
} = require('../../dist/shell/commands/goal');
const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

const SESSION_ID = 'goal-cli-test-session';

function mkRepo() {
  const root = makeTempRepo();
  const init = initProject(root);
  if (!init.ok) throw new Error('initProject failed');
  return { root, cawsDir: path.join(root, '.caws') };
}

function writeSpec(cawsDir, id, { acceptance } = {}) {
  const criteria =
    acceptance === undefined
      ? [
          { id: 'A1', given: 'g1', when: 'w1', then: 't1' },
          { id: 'A2', given: 'g2', when: 'w2', then: 't2' },
        ]
      : acceptance;
  const accYaml =
    criteria.length === 0
      ? 'acceptance: []\n'
      : 'acceptance:\n' +
        criteria
          .map(
            (c) =>
              `  - id: ${c.id}\n    given: '${c.given}'\n    when: '${c.when}'\n    then: '${c.then}'\n`
          )
          .join('');
  const yaml =
    `id: ${id}\n` +
    `title: '${id} goal cli fixture spec'\n` +
    `risk_tier: 3\n` +
    `mode: chore\n` +
    `lifecycle_state: draft\n` +
    `created_at: '2026-06-01T00:00:00.000Z'\n` +
    `updated_at: '2026-07-03T00:00:00.000Z'\n` +
    `blast_radius:\n  modules:\n    - cli\n  data_migration: false\n` +
    `operational_rollback_slo: 5m\n` +
    `scope:\n  in:\n    - tests\n  out: []\n` +
    `invariants:\n  - 'a fixture invariant'\n` +
    accYaml +
    `non_functional: {}\n` +
    `contracts: []\n`;
  const specsDir = path.join(cawsDir, 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  fs.writeFileSync(path.join(specsDir, `${id}.yaml`), yaml);
}

function run(fn, root, opts = {}) {
  const out = [];
  const err = [];
  const code = fn({
    cwd: root,
    env: { CLAUDE_CODE_SESSION_ID: SESSION_ID },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function bindingPath(cawsDir) {
  return path.join(cawsDir, 'sessions', SESSION_ID, 'goal.json');
}

describe('caws goal set', () => {
  it('writes the binding to .caws/sessions/<session>/goal.json, where the hook looks', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'GOALFIX-1');

    const r = run(runGoalSetCommand, root, { specId: 'GOALFIX-1' });

    expect(r.code).toBe(0);
    // The exact path is the contract between this command and goal-ac-gate.sh.
    // A binding written anywhere else leaves the gate permanently inert with no
    // error on either side.
    const p = bindingPath(cawsDir);
    expect(fs.existsSync(p)).toBe(true);
    const written = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(written.spec_id).toBe('GOALFIX-1');
    expect(written.set_by_session).toBe(SESSION_ID);
    expect(typeof written.set_at).toBe('string');
  });

  it('names the criteria it will hold the session to', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'GOALFIX-2');

    const r = run(runGoalSetCommand, root, { specId: 'GOALFIX-2' });

    expect(r.out).toContain('A1, A2');
    expect(r.out).toContain('GOALFIX-2');
  });

  it('states that only verified passes, so not_rederived is not mistaken for proof', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'GOALFIX-3');

    const r = run(runGoalSetCommand, root, { specId: 'GOALFIX-3' });

    expect(r.out).toContain('verdict=verified');
    expect(r.out).toContain('not_rederived');
    expect(r.out).toContain('caws specs evidence');
  });

  it('refuses a spec that does not exist, rather than binding to it', () => {
    const { root, cawsDir } = mkRepo();

    const r = run(runGoalSetCommand, root, { specId: 'NO-SUCH-SPEC-9' });

    // Binding to an unresolvable spec is not a harmless no-op: at stop time it
    // is indistinguishable from a gate failure, so the agent gets refusals it
    // cannot act on until the block budget runs out.
    expect(r.code).toBe(1);
    expect(r.err).toContain('NO-SUCH-SPEC-9');
    expect(r.err).toContain('caws specs list');
    expect(fs.existsSync(bindingPath(cawsDir))).toBe(false);
  });

  it('refuses a spec with no acceptance criteria, which would be a goal with no bar', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'GOALFIX-4', { acceptance: [] });

    const r = run(runGoalSetCommand, root, { specId: 'GOALFIX-4' });

    // The kernel schema requires a non-empty `acceptance`, so such a spec never
    // validates and is refused as unloadable rather than by a separate
    // criteria-count check in the command. Pinning it here documents WHERE the
    // rule lives: a second check in goal.ts would be unreachable code.
    expect(r.code).toBe(1);
    expect(r.err).toContain('GOALFIX-4');
    expect(fs.existsSync(bindingPath(cawsDir))).toBe(false);
  });

  it('requires a spec id', () => {
    const { root } = mkRepo();

    const r = run(runGoalSetCommand, root, { specId: undefined });

    expect(r.code).toBe(1);
    expect(r.err).toContain('<spec-id> argument is required');
  });

  it('clears a stale block counter so a new goal starts with a full budget', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'GOALFIX-5');
    const sessionDir = path.join(cawsDir, 'sessions', SESSION_ID);
    fs.mkdirSync(sessionDir, { recursive: true });
    const counter = path.join(sessionDir, 'goal-blocks');
    fs.writeFileSync(counter, 'unmet:old\t3\n');

    run(runGoalSetCommand, root, { specId: 'GOALFIX-5' });

    // A leftover counter would spend blocks the new goal never used, releasing
    // the stop earlier than the budget promises.
    expect(fs.existsSync(counter)).toBe(false);
  });
});

describe('caws goal show', () => {
  it('reports no goal when none is set', () => {
    const { root } = mkRepo();

    const r = run(runGoalShowCommand, root);

    expect(r.code).toBe(0);
    expect(r.out).toContain('none set');
    expect(r.out).toContain('caws goal set');
  });

  it('reports the bound spec and the gate block count without editing it', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'GOALFIX-6');
    run(runGoalSetCommand, root, { specId: 'GOALFIX-6' });
    const counter = path.join(cawsDir, 'sessions', SESSION_ID, 'goal-blocks');
    fs.writeFileSync(counter, 'unmet:A1=not_rederived\t2\n');

    const r = run(runGoalShowCommand, root);

    expect(r.code).toBe(0);
    expect(r.out).toContain('GOALFIX-6');
    expect(r.out).toContain('consecutive blocks so far: 2');
    // The counter belongs to the hook; show is read-only over it.
    expect(fs.readFileSync(counter, 'utf8')).toBe('unmet:A1=not_rederived\t2\n');
  });

  it('reports zero blocks when the gate has not blocked yet', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'GOALFIX-7');
    run(runGoalSetCommand, root, { specId: 'GOALFIX-7' });

    const r = run(runGoalShowCommand, root);

    expect(r.out).toContain('consecutive blocks so far: 0');
  });
});

describe('caws goal clear', () => {
  it('removes the binding and the counter so the gate goes inert', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'GOALFIX-8');
    run(runGoalSetCommand, root, { specId: 'GOALFIX-8' });
    const counter = path.join(cawsDir, 'sessions', SESSION_ID, 'goal-blocks');
    fs.writeFileSync(counter, 'unmet:x\t1\n');

    const r = run(runGoalClearCommand, root);

    expect(r.code).toBe(0);
    expect(fs.existsSync(bindingPath(cawsDir))).toBe(false);
    expect(fs.existsSync(counter)).toBe(false);
  });

  it('names the spec it dropped, so releasing a self-set bar is never silent', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'GOALFIX-9');
    run(runGoalSetCommand, root, { specId: 'GOALFIX-9' });

    const r = run(runGoalClearCommand, root);

    // Clearing is allowed without human approval — the gate's block budget is
    // what prevents a trap, not the escape. What it must never be is invisible:
    // the record is what makes the release reviewable in the transcript.
    expect(r.out).toContain('GOALFIX-9');
    expect(r.out).toContain('NOT met by clearing');
  });

  it('does not claim the criteria were satisfied', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'GOALFIX-10');
    run(runGoalSetCommand, root, { specId: 'GOALFIX-10' });

    const r = run(runGoalClearCommand, root);

    expect(r.out).toContain('Recorded evidence is unchanged');
    // Assert the absence of a SUCCESS claim, not the absence of the substring
    // "met" — the honest message necessarily contains it ("NOT met by
    // clearing"), so a bare substring check would forbid the correct wording.
    expect(r.out).not.toMatch(/\bgoal met\b|\bcriteria met\b|\bpassed\b|\bverified\b/i);
  });

  it('is a no-op when no goal is set', () => {
    const { root } = mkRepo();

    const r = run(runGoalClearCommand, root);

    expect(r.code).toBe(0);
    expect(r.out).toContain('nothing to clear');
  });

  it('never writes acceptance evidence — the binding is the only state it owns', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'GOALFIX-11');
    const specPath = path.join(cawsDir, 'specs', 'GOALFIX-11.yaml');
    const before = fs.readFileSync(specPath, 'utf8');

    run(runGoalSetCommand, root, { specId: 'GOALFIX-11' });
    run(runGoalShowCommand, root);
    run(runGoalClearCommand, root);

    // `caws specs evidence` is the single writer of acceptance truth. If this
    // surface could touch a spec it would become a second one.
    expect(fs.readFileSync(specPath, 'utf8')).toBe(before);
  });
});
