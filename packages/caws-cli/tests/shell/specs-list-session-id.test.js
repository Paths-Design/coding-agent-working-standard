'use strict';

// CAWS-SPECS-LIST-SESSION-ID-001 — shell-layer session work-surface view.
//
// Covers: the rendered state + action guidance per lifecycle/binding state
// (active+bound mine/foreign, active+unbound, draft, closed, archived), the
// explicit empty-result message, and the help-surface declaration of
// --session-id. Also a negative control: the default listing is unchanged.

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
const { runSpecsListCommand } = require('../../dist/shell/commands/specs');
const { SPECS_COMMAND_META } = require('../../dist/shell/command-metadata');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const S1 = '44444444-4444-4444-8444-444444444444';
const S1P = `session-${S1}`;
const S2 = '55555555-5555-4555-8555-555555555555';
const UNKNOWN = '66666666-6666-4666-8666-666666666666';

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) {
    throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  }
  return { root, caws: path.join(root, '.caws') };
}

function writeSpec(cawsDir, id, state, opts = {}) {
  const resolution = state === 'closed' ? 'resolution: completed\n' : '';
  const createdBy = opts.createdBy !== undefined ? `created_by_session: '${opts.createdBy}'\n` : '';
  const body = `id: ${id}
title: '${id}'
mode: chore
lifecycle_state: ${state}
${resolution}${createdBy}created_at: '2026-07-04T00:00:00.000Z'
updated_at: '2026-07-04T00:00:00.000Z'
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
  - 'fixture'
acceptance:
  - id: A1
    given: 'fixture'
    when: 'fixture'
    then: 'fixture'
non_functional: {}
contracts: []
`;
  fs.writeFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), body);
}

function appendEvent(cawsDir, event) {
  fs.appendFileSync(path.join(cawsDir, 'events.jsonl'), JSON.stringify(event) + '\n');
}

function runList(root, opts = {}) {
  const out = [];
  const err = [];
  const code = runSpecsListCommand({
    cwd: root,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('specs list --session-id (session work-surface view)', () => {
  let root;
  let caws;
  beforeEach(() => {
    const repo = mkRepo();
    root = repo.root;
    caws = repo.caws;

    // active + bound to a worktree owned by the session (prefixed stamping)
    writeSpec(caws, 'V-MINE-BOUND-1', 'active', { createdBy: S1 });
    // active, no binding
    writeSpec(caws, 'V-UNBOUND-2', 'active', { createdBy: S1 });
    // active, bound to a FOREIGN-owned worktree
    writeSpec(caws, 'V-FOREIGN-BOUND-3', 'active', { createdBy: S1 });
    // draft
    writeSpec(caws, 'V-DRAFT-4', 'draft', { createdBy: S1P });
    // closed
    writeSpec(caws, 'V-CLOSED-5', 'closed', { createdBy: S1 });
    // unrelated
    writeSpec(caws, 'V-OTHER-6', 'active', { createdBy: S2 });

    fs.writeFileSync(
      path.join(caws, 'worktrees.json'),
      JSON.stringify({
        'wt-mine': {
          specId: 'V-MINE-BOUND-1',
          path: '.caws/worktrees/wt-mine',
          owner: { session_id: S1P, platform: 'dsh' },
        },
        'wt-theirs': {
          specId: 'V-FOREIGN-BOUND-3',
          path: '.caws/worktrees/wt-theirs',
          owner: { session_id: S2, platform: 'dsh' },
        },
      })
    );

    appendEvent(caws, {
      seq: 1,
      event: 'spec_created',
      ts: '2026-10-01T00:00:00.000Z',
      actor: { kind: 'agent', id: S1, session_id: S1, platform: 'dsh' },
      spec_id: 'V-ARCHIVED-7',
      data: { title: 'archived', mode: 'chore', lifecycle_state: 'draft' },
    });
    appendEvent(caws, {
      seq: 2,
      event: 'spec_archived',
      ts: '2026-10-05T00:00:00.000Z',
      actor: { kind: 'agent', id: S1, session_id: S1, platform: 'dsh' },
      spec_id: 'V-ARCHIVED-7',
      data: {
        from_path: '.caws/specs/V-ARCHIVED-7.yaml',
        to_path: '.caws/specs/.archive/V-ARCHIVED-7.yaml',
      },
    });
  });

  test('renders every binding state with its state-appropriate action', () => {
    const { code, out, err } = runList(root, { sessionId: S1 });
    expect(code).toBe(0);
    expect(err).toBe('');

    expect(out).toContain(`session ${S1} — 6 related spec(s)`);

    // active+bound, own worktree → continue guidance naming the worktree
    expect(out).toMatch(/V-MINE-BOUND-1\s+active\+bound/);
    expect(out).toContain('action:   continue: cd .caws/worktrees/wt-mine && caws claim');

    // active+unbound → activate or deactivate
    expect(out).toMatch(/V-UNBOUND-2\s+active\+unbound/);
    expect(out).toContain(
      `action:   activate: caws worktree create <name> --spec V-UNBOUND-2 | deactivate: caws specs deactivate V-UNBOUND-2`
    );

    // active+bound to a foreign worktree → honest takeover guidance
    expect(out).toMatch(/V-FOREIGN-BOUND-3\s+active\+bound/);
    expect(out).toContain(`owner ${S2}`);
    expect(out).toContain('caws claim --takeover');

    // draft → tee up or retire
    expect(out).toMatch(/V-DRAFT-4\s+draft/);
    expect(out).toContain(
      `action:   tee up: caws worktree create <name> --spec V-DRAFT-4 | abandon: caws specs retire-draft V-DRAFT-4`
    );

    // closed → no action
    expect(out).toMatch(/V-CLOSED-5\s+closed/);
    expect(out).toContain('action:   no action (concluded');

    // archived → no action + recover hint + age
    expect(out).toMatch(/V-ARCHIVED-7\s+archived/);
    expect(out).toContain(`recover: caws specs recover V-ARCHIVED-7`);
    expect(out).toMatch(/archived \d+d ago/);

    // the unrelated spec is filtered out of the session view entirely
    expect(out).not.toContain('V-OTHER-6');
  });

  test('unknown session id exits 0 with an explicit message naming the session', () => {
    const { code, out } = runList(root, { sessionId: UNKNOWN });
    expect(code).toBe(0);
    expect(out).toBe(`(no specs for session ${UNKNOWN})`);
  });

  test('empty --session-id is a usage error, not an implicit no-op', () => {
    const { code, err } = runList(root, { sessionId: '' });
    expect(code).toBe(1);
    expect(err).toContain('--session-id requires a non-empty session id');
    expect(err).toContain('caws specs list --session-id <session-id>');
  });

  test('help surface declares --session-id <id> (A4)', () => {
    const listLeaf = SPECS_COMMAND_META.subcommands.find((s) => s.name === 'list');
    expect(listLeaf).toBeDefined();
    const flag = listLeaf.options.find((o) => o.flag === '--session-id <id>');
    expect(flag).toBeDefined();
    expect(flag.description).toMatch(/session/i);
    expect(flag.description.length).toBeGreaterThan(20);
  });

  test('negative control: default listing is unchanged (no session rows/annotations)', () => {
    const { code, out } = runList(root, {});
    expect(code).toBe(0);
    // All 6 on-disk specs still list, including the unrelated one.
    expect(out).toContain('V-OTHER-6');
    expect(out).not.toContain('relation:');
    expect(out).not.toContain('action:');
    expect(out).not.toContain('active+bound');
  });
});
