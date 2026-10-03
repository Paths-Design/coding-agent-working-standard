'use strict';

// CAWS-SCOPE-REMEDIATION-STATES-VERIFIED-SAFETY-01
//
// A no-authority handoff used to hedge ("use the read-only --spec check first;
// it does not grant write authority", "can still be blocked") about facts the
// CLI already held, and it offered `worktree ensure` for any active spec that
// claimed the path — including one whose lane had already landed under
// `worktree merge --no-close`. Agents stalled on the hedge, or followed the
// ensure into a finished slice. These tests pin the replacement contract: the
// remediation states what it verified and why the offered action is safe, and
// it never routes new work into a landed spec.

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
const { appendEvent } = require('../../dist/store/events-store');
const { runScopeCommand } = require('../../dist/shell/index');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

const MERGER = { kind: 'agent', id: 'merger-session', session_id: 'merger-session' };
const MERGE_SHA = 'a24edfec04f369c38c5c6036da60557af8ad1c11';
const MERGED_AT = '2026-09-15T18:23:18.145Z';

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) {
    throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  }
  return { root, caws: path.join(root, '.caws') };
}

function writeSpec(caws, id, scopeIn, { worktree, lifecycleState = 'active', scopeOut = [] } = {}) {
  const wtLine = worktree !== undefined ? `worktree: ${worktree}\n` : '';
  const inLines = scopeIn.map((p) => `    - ${p}`).join('\n');
  const outBlock =
    scopeOut.length === 0 ? '  out: []' : '  out:\n' + scopeOut.map((p) => `    - ${p}`).join('\n');
  fs.writeFileSync(
    path.join(caws, 'specs', `${id}.yaml`),
    `id: ${id}
title: 'Verified remediation fixture'
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
${outBlock}
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

function append(caws, body) {
  const result = appendEvent(caws, { ts: MERGED_AT, actor: MERGER, ...body });
  if (!result.ok) throw new Error('appendEvent failed: ' + JSON.stringify(result.errors));
}

/** The event `caws worktree merge --no-close` appends: landed, spec left open. */
function appendNoCloseMerge(caws, specId, { ts = MERGED_AT, autoClosed = false } = {}) {
  append(caws, {
    event: 'worktree_merged',
    ts,
    spec_id: specId,
    data: {
      worktree_name: 'landed-lane',
      merge_commit: MERGE_SHA,
      base_branch: 'main',
      auto_closed_spec: autoClosed,
      spec_already_closed: false,
    },
  });
}

function runScopeJson(cwd, targetPath) {
  const out = [];
  const err = [];
  const code = runScopeCommand({
    cwd,
    path: targetPath,
    mode: 'show',
    json: true,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, json: JSON.parse(out.join('\n')), err: err.join('\n') };
}

function runScopeHuman(cwd, targetPath) {
  const out = [];
  runScopeCommand({ cwd, path: targetPath, mode: 'show', out: (l) => out.push(l), err: () => {} });
  return out.join('\n');
}

const commandsOf = (json) => json.remediation.commands.map((c) => c.command);
const notesOf = (json) => (json.remediation.notes ?? []).join('\n');

describe('A1: a kernel-verified claimant is stated as a fact, with why ensure is safe', () => {
  test('the note, the ensure description and the summary state what was verified', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'OWNER-001', ['packages/owned']);

    const { json } = runScopeJson(root, 'packages/owned/file.ts');

    expect(json.remediation.authorityCandidates).toEqual([
      {
        specId: 'OWNER-001',
        lifecycleState: 'active',
        matchedScopeInEntry: 'packages/owned',
        bindingAdmits: true,
      },
    ]);
    expect(json.remediation.summary).toBe(
      'No worktree is bound for this context; OWNER-001 is the verified authority for this path — create or enter its worktree before editing.'
    );
    expect(json.remediation.notes).toEqual([
      'Verified: OWNER-001 (active, no worktree) claims this path via scope.in "packages/owned", and the kernel admits the path under its binding.',
      'This checkout is refused only because it has no binding. The --spec fit check is already done for the verified claimant, and binding it is what grants write authority here.',
    ]);
    expect(json.remediation.commands).toEqual([
      {
        command: 'caws specs list --status active',
        description: 'List active specs before choosing the authority context.',
        mutates: false,
      },
      {
        command: 'caws worktree ensure <name> --spec OWNER-001',
        description:
          'Safe: OWNER-001 is active with no worktree, and the kernel admits this path under its binding (scope.in "packages/owned"). ensure creates a worktree bound to OWNER-001, or re-enters an untouched lane of that name already bound to it; no other spec or worktree changes.',
        mutates: true,
      },
    ]);
  });

  test('the check the CLI already performed is not handed back, and nothing hedges', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'OWNER-001', ['packages/owned']);

    const { json } = runScopeJson(root, 'packages/owned/file.ts');

    expect(
      commandsOf(json).some(
        (c) => c.includes('--spec OWNER-001') && c.startsWith('caws scope show')
      )
    ).toBe(false);
    expect(notesOf(json)).not.toContain('does not grant current-checkout write authority');
    expect(notesOf(json)).not.toContain('check first');
  });

  test('a verified draft claimant says the bind activates it', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'DRAFT-001', ['packages/owned'], { lifecycleState: 'draft' });

    const { json } = runScopeJson(root, 'packages/owned/file.ts');

    expect(json.remediation.notes[0]).toBe(
      'Verified: DRAFT-001 (draft, no worktree) claims this path via scope.in "packages/owned", and the kernel admits the path under its binding. Binding it activates the draft.'
    );
    const ensure = json.remediation.commands.find((c) => c.command.includes('ensure'));
    expect(ensure.description).toBe(
      'Safe: DRAFT-001 is a draft with no worktree, and the kernel admits this path under its binding (scope.in "packages/owned"). ensure creates a worktree bound to DRAFT-001 and activates the draft in the same transaction; no other spec or worktree changes.'
    );
  });

  test('from an unbound tracked worktree the verified bind is stated the same way', () => {
    const { caws } = mkRepo();
    writeSpec(caws, 'OWNER-001', ['packages/owned']);
    const loose = path.join(caws, 'worktrees', 'loose-wt');
    fs.mkdirSync(loose, { recursive: true });
    fs.writeFileSync(
      path.join(caws, 'worktrees.json'),
      JSON.stringify({ 'loose-wt': { baseBranch: 'main', path: loose } }, null, 2) + '\n'
    );

    const { json } = runScopeJson(loose, 'packages/owned/file.ts');

    expect(json.remediation.summary).toBe(
      'Tracked worktree loose-wt is not bound to a spec; OWNER-001 is the verified authority for this path — bind it before editing.'
    );
    expect(json.remediation.commands).toContainEqual({
      command: 'caws worktree bind loose-wt --spec OWNER-001',
      description:
        'Safe: binds this unbound worktree to active OWNER-001, and the kernel admits this path under its binding (scope.in "packages/owned"). No other spec or worktree changes.',
      mutates: true,
    });
  });
});

describe('A2: a spec whose lane landed under --no-close is never offered as a lane', () => {
  test('sole landed claimant: no ensure/bind for it, the landing is stated, a new spec is the handoff', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'LANDED-001', ['packages/owned']);
    appendNoCloseMerge(caws, 'LANDED-001');

    const { json } = runScopeJson(root, 'packages/owned/file.ts');

    expect(json.remediation.authorityCandidates[0].landedOpen).toEqual({
      mergeCommit: MERGE_SHA,
      mergedAt: MERGED_AT,
      worktreeName: 'landed-lane',
      mergedBySession: 'merger-session',
    });
    const commands = commandsOf(json);
    expect(commands.filter((c) => /worktree (ensure|bind) .*LANDED-001/.test(c))).toEqual([]);
    expect(commands).toContain('caws specs show LANDED-001');
    expect(commands).toContain(
      'caws specs create <id> --title "<title>" --mode <mode> --scope-in packages/owned/file.ts'
    );
    expect(commands).toContain('caws worktree ensure <name> --spec <id>');
    expect(json.remediation.notes[0]).toBe(
      `LANDED-001 already landed: merge a24edfec04 at ${MERGED_AT} from session merger-session, via worktree landed-lane. ` +
        'It was left open with --no-close so its evidence can be recorded before it closes; it is finished work, not a lane for this edit. ' +
        'Closing it belongs to the session that merged it.'
    );
    expect(json.remediation.summary).toBe(
      'No worktree is bound for this context, and no spec listed here can take new work on this path; author a new spec that claims it before editing.'
    );
  });

  test('a landed claimant beside a live one: only the live one is offered, and no new spec is needed', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'LANDED-001', ['packages/owned']);
    writeSpec(caws, 'LIVE-002', ['packages/owned']);
    appendNoCloseMerge(caws, 'LANDED-001');

    const { json } = runScopeJson(root, 'packages/owned/file.ts');

    const commands = commandsOf(json);
    expect(commands).toContain('caws worktree ensure <name> --spec LIVE-002');
    expect(commands).not.toContain('caws worktree ensure <name> --spec LANDED-001');
    expect(commands.some((c) => c.startsWith('caws specs create'))).toBe(false);
    expect(json.remediation.summary).toContain('LIVE-002 is the verified authority');
  });

  test('the human render marks the landed row', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'LANDED-001', ['packages/owned']);
    appendNoCloseMerge(caws, 'LANDED-001');

    expect(runScopeHuman(root, 'packages/owned/file.ts')).toContain(
      '- LANDED-001 (active, no worktree, landed in a24edfec04 and left open)'
    );
  });
});

describe('A3: a claimant the kernel refuses under its own binding is not called verified', () => {
  test('scope.out exclusion: the rule is named, the --spec check stays, no ensure is offered', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'FENCED-001', ['packages/owned'], { scopeOut: ['packages/owned/secret'] });

    const { json } = runScopeJson(root, 'packages/owned/secret/file.ts');

    const [candidate] = json.remediation.authorityCandidates;
    expect(candidate.bindingAdmits).toBe(false);
    expect(candidate.bindingRefusalRule).toBe('scope.reject.scope_out');
    expect(notesOf(json)).not.toContain('Verified:');
    expect(json.remediation.notes[0]).toBe(
      'FENCED-001 claims this path via scope.in "packages/owned", but the kernel refuses the path under its binding (scope.reject.scope_out), so binding it would not make this path editable.'
    );
    const commands = commandsOf(json);
    expect(commands).toContain('caws scope show packages/owned/secret/file.ts --spec FENCED-001');
    expect(commands).not.toContain('caws worktree ensure <name> --spec FENCED-001');
  });
});

describe('A4: a path claimed by a bound worktree states the owner and the guard as facts', () => {
  test('summary names worktree, spec and entry; the guard note has no "can still be"', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'OWNER-001', ['packages/owned'], { worktree: 'owned-wt' });
    fs.writeFileSync(
      path.join(caws, 'worktrees.json'),
      JSON.stringify(
        {
          'owned-wt': {
            specId: 'OWNER-001',
            baseBranch: 'main',
            path: path.join(caws, 'worktrees', 'owned-wt'),
          },
        },
        null,
        2
      ) + '\n'
    );

    const { json } = runScopeJson(root, 'packages/owned/file.ts');

    expect(json.decision).toBe('admit');
    expect(json.remediation.summary).toBe(
      'Verified: worktree owned-wt is bound to OWNER-001, whose scope.in entry "packages/owned" admits this path. Edit it from inside owned-wt.'
    );
    expect(json.remediation.notes).toEqual([
      "A write to this path from the checkout of owned-wt's base branch is blocked by worktree-write-guard, because owned-wt claims it.",
    ]);
    expect(notesOf(json)).not.toContain('can still be');
  });
});

describe('A5: a landing that was later resumed or never left the spec open is not reported', () => {
  test.each([
    [
      'rebound after the merge',
      (caws) =>
        append(caws, {
          event: 'worktree_bound',
          ts: '2026-09-16T00:00:00.000Z',
          spec_id: 'RESUMED-001',
          data: { worktree_name: 'second-lane' },
        }),
    ],
    [
      'reopened after the merge',
      (caws) =>
        append(caws, {
          event: 'spec_reopened',
          ts: '2026-09-16T00:00:00.000Z',
          spec_id: 'RESUMED-001',
          data: { previous_lifecycle_state: 'closed' },
        }),
    ],
    [
      'reactivated after the merge',
      (caws) =>
        append(caws, {
          event: 'spec_activated',
          ts: '2026-09-16T00:00:00.000Z',
          spec_id: 'RESUMED-001',
          data: { previous_lifecycle_state: 'draft', lifecycle_state: 'active' },
        }),
    ],
  ])('%s: offered the normal verified handoff', (_label, resume) => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'RESUMED-001', ['packages/owned']);
    appendNoCloseMerge(caws, 'RESUMED-001');
    resume(caws);

    const { json } = runScopeJson(root, 'packages/owned/file.ts');

    expect(json.remediation.authorityCandidates[0].landedOpen).toBeUndefined();
    expect(json.remediation.authorityCandidates[0].bindingAdmits).toBe(true);
    expect(commandsOf(json)).toContain('caws worktree ensure <name> --spec RESUMED-001');
  });

  test('a merge that auto-closed the spec is not a --no-close landing', () => {
    // The spec is active again only because a later reopen is absent from the
    // log; the merge event itself says the close happened, so it is not
    // "landed and left open".
    const { root, caws } = mkRepo();
    writeSpec(caws, 'CLOSED-AT-MERGE-001', ['packages/owned']);
    appendNoCloseMerge(caws, 'CLOSED-AT-MERGE-001', { autoClosed: true });

    const { json } = runScopeJson(root, 'packages/owned/file.ts');

    expect(json.remediation.authorityCandidates[0].landedOpen).toBeUndefined();
  });

  test('a landed spec that now has a worktree is not reported as landed', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'HAS-WT-001', ['packages/owned'], { worktree: 'fresh-wt' });
    appendNoCloseMerge(caws, 'HAS-WT-001');

    const { json } = runScopeJson(root, 'packages/owned/file.ts');

    const candidate = json.remediation.authorityCandidates.find((c) => c.specId === 'HAS-WT-001');
    expect(candidate).toMatchObject({ specId: 'HAS-WT-001', worktreeName: 'fresh-wt' });
    expect(candidate.landedOpen).toBeUndefined();
  });
});

describe('A6: the kernel decision fields are unchanged by the verified remediation', () => {
  test('canonical no-authority keeps its kernel contract across verified, landed and refused claimants', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'LIVE-001', ['packages/a']);
    writeSpec(caws, 'LANDED-002', ['packages/b']);
    writeSpec(caws, 'FENCED-003', ['packages/c'], { scopeOut: ['packages/c/x'] });
    appendNoCloseMerge(caws, 'LANDED-002');

    for (const target of ['packages/a/f.ts', 'packages/b/f.ts', 'packages/c/x/f.ts']) {
      const { json } = runScopeJson(root, target);
      expect({
        decision: json.decision,
        rule: json.rule,
        mode: json.mode,
        bindingState: json.bindingState,
        boundSpecId: json.boundSpecId,
        ambiguousClaimants: json.ambiguousClaimants,
      }).toEqual({
        decision: 'no_authority',
        rule: 'scope.no_authority.unbound',
        mode: 'union',
        bindingState: 'unbound',
        boundSpecId: undefined,
        ambiguousClaimants: undefined,
      });
      for (const candidate of json.remediation.authorityCandidates) {
        expect(typeof candidate.specId).toBe('string');
        expect(candidate.lifecycleState).toBe('active');
        expect(typeof candidate.matchedScopeInEntry).toBe('string');
      }
    }
  });
});
