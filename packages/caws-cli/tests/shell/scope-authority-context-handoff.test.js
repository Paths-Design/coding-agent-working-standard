'use strict';

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
const { runScopeCommand } = require('../../dist/shell/index');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

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

function writeSpec(caws, id, scopeIn, { worktree, lifecycleState = 'active' } = {}) {
  const wtLine = worktree !== undefined ? `worktree: ${worktree}\n` : '';
  const inLines = scopeIn.map((p) => `    - ${p}`).join('\n');
  fs.writeFileSync(
    path.join(caws, 'specs', `${id}.yaml`),
    `id: ${id}
title: 'Authority context fixture'
risk_tier: 3
mode: chore
lifecycle_state: ${lifecycleState}
${wtLine}created_at: '2026-07-04T00:00:00.000Z'
updated_at: '2026-07-04T00:00:00.000Z'
blast_radius:
  modules:
    - tests
  data_migration: false
operational_rollback_slo: 5m
scope:
  in:
${inLines}
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

function writeRegistry(caws, entries) {
  fs.writeFileSync(path.join(caws, 'worktrees.json'), JSON.stringify(entries, null, 2) + '\n');
}

function runScopeJson(cwd, targetPath, mode = 'check') {
  const out = [];
  const err = [];
  const code = runScopeCommand({
    cwd,
    path: targetPath,
    mode,
    json: true,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, json: JSON.parse(out.join('\n')), err: err.join('\n') };
}

function runScopeHuman(cwd, targetPath, mode = 'show') {
  const out = [];
  const err = [];
  const code = runScopeCommand({
    cwd,
    path: targetPath,
    mode,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('scope authority-context handoff', () => {
  // ── CAWS-SPEC-ACTIVATION-BINDS-001: candidates are ranked by scope fit ──
  //
  // The renderer shows the first five candidates. Ranking them alphabetically
  // meant that in a repo with dozens of active specs, the five shown were
  // whichever ids sorted first — the spec that actually claims the path was
  // routinely absent. These pin fit-first ordering and the note that says
  // which case the operator is looking at.

  test('only the specs whose scope.in admits the path are offered when one does', () => {
    const { root, caws } = mkRepo();
    // AAA sorts first but does NOT claim the path; ZZZ sorts last and does.
    writeSpec(caws, 'AAA-UNRELATED-001', ['packages/unrelated']);
    writeSpec(caws, 'MMM-UNRELATED-002', ['packages/other']);
    writeSpec(caws, 'ZZZ-OWNER-003', ['packages/owned']);

    const result = runScopeJson(root, 'packages/owned/deep/file.ts');

    expect(result.json.decision).toBe('no_authority');
    expect(result.json.remediation.authorityCandidates).toEqual([
      {
        specId: 'ZZZ-OWNER-003',
        lifecycleState: 'active',
        matchedScopeInEntry: 'packages/owned',
      },
    ]);
    // The alphabetically-first specs are gone, not merely demoted.
    const commands = result.json.remediation.commands.map((c) => c.command).join('\n');
    expect(commands).not.toContain('AAA-UNRELATED-001');
    expect(commands).toContain('ZZZ-OWNER-003');
    expect(result.json.remediation.notes[0]).toBe(
      'ZZZ-OWNER-003 claims this path via scope.in "packages/owned".'
    );
  });

  test('two claiming specs are both offered and the note says so', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'CLAIM-A-001', ['packages/shared']);
    writeSpec(caws, 'CLAIM-B-002', ['packages/shared/sub']);
    writeSpec(caws, 'NOCLAIM-C-003', ['packages/elsewhere']);

    const result = runScopeJson(root, 'packages/shared/sub/file.ts');

    expect(
      result.json.remediation.authorityCandidates.map((c) => c.specId)
    ).toEqual(['CLAIM-A-001', 'CLAIM-B-002']);
    expect(result.json.remediation.notes[0]).toBe(
      '2 specs claim this path via scope.in; listed in id order.'
    );
  });

  test('when no active spec claims the path, the full active set is a labelled fallback', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'AAA-UNRELATED-001', ['packages/unrelated']);
    writeSpec(caws, 'ZZZ-UNRELATED-002', ['packages/other']);

    const result = runScopeJson(root, 'packages/no-owner/file.ts');

    expect(
      result.json.remediation.authorityCandidates.map((c) => c.specId)
    ).toEqual(['AAA-UNRELATED-001', 'ZZZ-UNRELATED-002']);
    // None carry a match, so none of them is presented as a claim.
    expect(
      result.json.remediation.authorityCandidates.every(
        (c) => c.matchedScopeInEntry === undefined
      )
    ).toBe(true);
    expect(result.json.remediation.notes[0]).toContain('No active spec claims this path');
    expect(result.json.remediation.notes[0]).toContain('caws specs amend-scope');
  });

  // ── A DRAFT that claims the path is the common case now ────────────────
  //
  // `specs create` writes a draft, and binding is what activates it. So the
  // normal sequence for a new slice is: create the spec (draft, scope.in
  // populated) → try to edit → hit no_authority. If the candidate list only
  // ever considers ACTIVE specs, it omits the one spec that actually claims
  // the path and tells the agent "no active spec claims this path", steering
  // it to amend-scope some unrelated spec. The draft has to be visible here.

  test('a draft spec that claims the path is offered, labelled as a draft', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'AAA-ACTIVE-UNRELATED-001', ['packages/unrelated']);
    writeSpec(caws, 'ZZZ-DRAFT-OWNER-002', ['packages/owned'], {
      lifecycleState: 'draft',
    });

    const result = runScopeJson(root, 'packages/owned/file.ts');

    expect(result.json.remediation.authorityCandidates).toEqual([
      {
        specId: 'ZZZ-DRAFT-OWNER-002',
        lifecycleState: 'draft',
        matchedScopeInEntry: 'packages/owned',
      },
    ]);
    // The command that resolves it must be the one that ALSO activates.
    const commands = result.json.remediation.commands.map((c) => c.command);
    expect(commands).toContain('caws worktree create <name> --spec ZZZ-DRAFT-OWNER-002');
    // ...and it must not describe a draft as active, or say nothing claims it.
    const notes = result.json.remediation.notes.join('\n');
    expect(notes).not.toContain('No active spec claims this path');
    expect(notes).toContain('draft');
  });

  test('the list command offered alongside a draft claimant is not --status active', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'DRAFT-ONLY-001', ['packages/owned'], { lifecycleState: 'draft' });

    const result = runScopeJson(root, 'packages/owned/file.ts');

    // `caws specs list --status active` hides the very spec being recommended.
    const commands = result.json.remediation.commands.map((c) => c.command);
    expect(commands).toContain('caws specs list');
    expect(commands).not.toContain('caws specs list --status active');
  });

  test('a draft that does NOT claim the path stays out of the fallback list', () => {
    // Drafts are the resting state, so a repo can hold dozens. Listing them all
    // as fallback candidates would bury the active set in backlog noise. Only a
    // CLAIMING draft earns a place.
    const { root, caws } = mkRepo();
    writeSpec(caws, 'ACTIVE-A-001', ['packages/a']);
    writeSpec(caws, 'DRAFT-B-002', ['packages/b'], { lifecycleState: 'draft' });
    writeSpec(caws, 'DRAFT-C-003', ['packages/c'], { lifecycleState: 'draft' });

    const result = runScopeJson(root, 'packages/no-owner/file.ts');

    expect(
      result.json.remediation.authorityCandidates.map((c) => c.specId)
    ).toEqual(['ACTIVE-A-001']);
  });

  test('a glob scope.in entry is matched, not treated as a literal', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'GLOB-OWNER-001', ['packages/*/src/index.ts']);
    writeSpec(caws, 'OTHER-002', ['docs']);

    const result = runScopeJson(root, 'packages/thing/src/index.ts');

    expect(result.json.remediation.authorityCandidates).toEqual([
      {
        specId: 'GLOB-OWNER-001',
        lifecycleState: 'active',
        matchedScopeInEntry: 'packages/*/src/index.ts',
      },
    ]);
  });

  test('canonical unbound refusal names active spec candidates and read-only spec-context checks', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'ACTIVE-UNBOUND-001', ['packages/owned-a']);
    writeSpec(caws, 'ACTIVE-BOUND-001', ['packages/owned-b'], { worktree: 'wt-owned-b' });
    writeRegistry(caws, {
      'wt-owned-b': {
        specId: 'ACTIVE-BOUND-001',
        baseBranch: 'main',
        path: path.join(caws, 'worktrees', 'wt-owned-b'),
      },
    });

    const result = runScopeJson(root, 'packages/no-owner/file.ts');

    expect(result.code).toBe(1);
    expect(result.json.decision).toBe('no_authority');
    expect(result.json.repair).toBeUndefined();
    expect(result.json.remediation.authorityCandidates).toEqual([
      { specId: 'ACTIVE-BOUND-001', lifecycleState: 'active', worktreeName: 'wt-owned-b' },
      { specId: 'ACTIVE-UNBOUND-001', lifecycleState: 'active' },
    ]);
    expect(result.json.remediation.commands).toEqual([
      {
        command: 'caws specs list --status active',
        description: 'List active specs before choosing the authority context.',
        mutates: false,
      },
      {
        command: 'caws scope show packages/no-owner/file.ts --spec ACTIVE-BOUND-001',
        description: 'Read-only check whether ACTIVE-BOUND-001 is the right spec context for this path.',
        mutates: false,
      },
      {
        command: 'cd .caws/worktrees/wt-owned-b',
        description: 'Enter the existing worktree already bound to ACTIVE-BOUND-001.',
        mutates: false,
      },
      {
        command: 'caws scope show packages/no-owner/file.ts --spec ACTIVE-UNBOUND-001',
        description: 'Read-only check whether ACTIVE-UNBOUND-001 is the right spec context for this path.',
        mutates: false,
      },
      {
        command: 'caws worktree create <name> --spec ACTIVE-UNBOUND-001',
        description: 'Create a governed worktree for active spec ACTIVE-UNBOUND-001.',
        mutates: true,
      },
    ]);
    expect(result.json.remediation.notes.join('\n')).toContain(
      'does not grant current-checkout write authority'
    );
  });

  test('tracked unbound worktree suggests binding that worktree to visible active specs', () => {
    // The probe runs from inside the loose worktree, not the repo root, so the
    // root path is deliberately unused here.
    const { caws } = mkRepo();
    writeSpec(caws, 'ACTIVE-UNBOUND-002', ['packages/owned']);
    const unboundPath = path.join(caws, 'worktrees', 'loose-wt');
    fs.mkdirSync(unboundPath, { recursive: true });
    writeRegistry(caws, {
      'loose-wt': {
        baseBranch: 'main',
        path: unboundPath,
      },
    });

    const result = runScopeHuman(unboundPath, 'packages/no-owner/file.ts');

    expect(result.code).toBe(0);
    expect(result.out).toContain('spec candidates:');
    expect(result.out).toContain('ACTIVE-UNBOUND-002 (active, no worktree)');
    expect(result.out).toContain(
      'caws scope show packages/no-owner/file.ts --spec ACTIVE-UNBOUND-002'
    );
    expect(result.out).toContain('caws worktree bind loose-wt --spec ACTIVE-UNBOUND-002');
    expect(result.out).not.toContain('caws worktree create <name> --spec <spec-id>');
  });
});
