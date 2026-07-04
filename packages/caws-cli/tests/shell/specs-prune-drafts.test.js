'use strict';

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
const { runSpecsPruneDraftsCommand } = require('../../dist/shell/commands/specs');
const { cleanupAll, git, makeTempRepo } = require('../helpers/git-repo-factory');

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

function writeSpec(cawsDir, id, state, updatedAt, extra = '') {
  const body = `id: ${id}
title: '${id}'
risk_tier: 3
mode: chore
lifecycle_state: ${state}
created_at: '2026-06-01T00:00:00.000Z'
updated_at: '${updatedAt}'
${extra}blast_radius:
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

function eventsPath(cawsDir) {
  return path.join(cawsDir, 'events.jsonl');
}

function commitAll(root, message) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message]);
}

function runPrune(root, opts) {
  const out = [];
  const err = [];
  const code = runSpecsPruneDraftsCommand({
    cwd: root,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => new Date('2026-07-04T00:00:00.000Z'),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('caws specs prune-drafts', () => {
  test('plans stale draft candidates without mutating events or specs', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'DRAFT-OLD-001', 'draft', '2026-06-01T00:00:00.000Z');
    writeSpec(caws, 'DRAFT-FRESH-001', 'draft', '2026-07-03T23:00:00.000Z');
    writeSpec(caws, 'DRAFT-BOUND-001', 'draft', '2026-06-01T00:00:00.000Z', 'worktree: wt-draft\n');
    writeSpec(caws, 'DRAFT-ACTIVE-001', 'active', '2026-06-01T00:00:00.000Z');
    const oldBefore = fs.readFileSync(path.join(caws, 'specs', 'DRAFT-OLD-001.yaml'), 'utf8');

    const result = runPrune(root, { olderThanMs: 7 * 24 * 60 * 60 * 1000, json: true });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload).toMatchObject({
      ok: true,
      dry_run: true,
      read_only: true,
      counts: { candidates: 1, skipped: 1, refused: 1 },
    });
    expect(payload.candidates.map((entry) => [entry.id, entry.state])).toEqual([
      ['DRAFT-OLD-001', 'stale_draft'],
    ]);
    expect(payload.skipped.map((entry) => [entry.id, entry.state])).toEqual([
      ['DRAFT-FRESH-001', 'fresh_draft_skipped'],
    ]);
    expect(payload.refused.map((entry) => [entry.id, entry.state])).toEqual([
      ['DRAFT-BOUND-001', 'bound_draft_refused'],
    ]);
    expect(fs.existsSync(eventsPath(caws))).toBe(false);
    expect(fs.readFileSync(path.join(caws, 'specs', 'DRAFT-OLD-001.yaml'), 'utf8')).toBe(oldBefore);
  });

  test('include/exclude selectors classify non-drafts and include bound drafts only with opt-in', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'DRAFT-FRESH-001', 'draft', '2026-07-03T23:00:00.000Z');
    writeSpec(caws, 'DRAFT-BOUND-001', 'draft', '2026-07-03T23:00:00.000Z', 'worktree: wt-draft\n');
    writeSpec(caws, 'DRAFT-ACTIVE-001', 'active', '2026-06-01T00:00:00.000Z');

    const result = runPrune(root, {
      include: ['DRAFT-FRESH-001', 'DRAFT-BOUND-001', 'DRAFT-ACTIVE-001', 'DRAFT-MISSING-001'],
      exclude: ['DRAFT-FRESH-001'],
      includeBound: true,
      json: true,
    });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload.selector).toMatchObject({
      include_bound: true,
      include: ['DRAFT-ACTIVE-001', 'DRAFT-BOUND-001', 'DRAFT-FRESH-001', 'DRAFT-MISSING-001'],
      exclude: ['DRAFT-FRESH-001'],
    });
    expect(payload.candidates.map((entry) => [entry.id, entry.state])).toEqual([
      ['DRAFT-BOUND-001', 'bound_draft_candidate'],
    ]);
    expect(payload.refused.map((entry) => [entry.id, entry.state])).toEqual([
      ['DRAFT-ACTIVE-001', 'non_draft_refused'],
      ['DRAFT-MISSING-001', 'missing_refused'],
    ]);
    expect(fs.existsSync(eventsPath(caws))).toBe(false);
  });

  test('rejects invalid older-than value before composing state', () => {
    const { root, caws } = mkRepo();

    const result = runPrune(root, { olderThanMs: '-1' });

    expect(result.code).toBe(1);
    expect(result.err).toContain('--older-than-ms must be a non-negative integer');
    expect(fs.existsSync(eventsPath(caws))).toBe(false);
  });

  test('apply retires selected candidate drafts in one aggregate audit commit', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'DRAFT-OLD-A-001', 'draft', '2026-06-01T00:00:00.000Z');
    writeSpec(caws, 'DRAFT-OLD-B-001', 'draft', '2026-06-01T00:00:00.000Z');
    writeSpec(caws, 'DRAFT-FRESH-001', 'draft', '2026-07-03T23:00:00.000Z');
    commitAll(root, 'add draft prune fixtures');

    const result = runPrune(root, {
      olderThanMs: 7 * 24 * 60 * 60 * 1000,
      apply: true,
      reason: 'stale draft cleanup',
      json: true,
    });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload).toMatchObject({
      ok: true,
      dry_run: false,
      read_only: false,
      counts: { retired: 2, skipped: 1, refused: 0, failed: 0 },
    });
    expect(payload.retired.map((entry) => entry.id)).toEqual([
      'DRAFT-OLD-A-001',
      'DRAFT-OLD-B-001',
    ]);
    expect(payload.skipped.map((entry) => [entry.id, entry.state])).toEqual([
      ['DRAFT-FRESH-001', 'fresh_draft_skipped'],
    ]);
    expect(fs.existsSync(path.join(caws, 'specs', 'DRAFT-OLD-A-001.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(caws, 'specs', 'DRAFT-OLD-B-001.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(caws, 'specs', 'DRAFT-FRESH-001.yaml'))).toBe(true);
    expect(fs.readFileSync(eventsPath(caws), 'utf8')).toContain('spec_retired');
    expect(git(root, ['log', '-1', '--pretty=%s'])).toBe(
      'chore(caws): retire 2 draft specs'
    );
  });

  test('apply requires explicit selection and refuses bound drafts without mutation', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'DRAFT-OLD-001', 'draft', '2026-06-01T00:00:00.000Z');
    writeSpec(caws, 'DRAFT-BOUND-001', 'draft', '2026-06-01T00:00:00.000Z', 'worktree: wt-draft\n');
    commitAll(root, 'add draft prune refusal fixtures');
    const beforeHead = git(root, ['rev-parse', 'HEAD']);

    const unfiltered = runPrune(root, { apply: true, json: true });

    expect(unfiltered.code).toBe(1);
    expect(unfiltered.err).toContain('--apply requires --include or an explicit --older-than-ms selector');
    expect(git(root, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(fs.existsSync(path.join(caws, 'specs', 'DRAFT-OLD-001.yaml'))).toBe(true);
    expect(fs.existsSync(eventsPath(caws))).toBe(false);

    const boundRefusal = runPrune(root, {
      olderThanMs: 7 * 24 * 60 * 60 * 1000,
      apply: true,
      json: true,
    });

    expect(boundRefusal.code).toBe(1);
    const payload = JSON.parse(boundRefusal.out);
    expect(payload).toMatchObject({
      ok: false,
      dry_run: false,
      counts: { retired: 0, refused: 1, failed: 0 },
    });
    expect(payload.refused.map((entry) => [entry.id, entry.state])).toEqual([
      ['DRAFT-BOUND-001', 'bound_draft_refused'],
    ]);
    expect(git(root, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(fs.existsSync(path.join(caws, 'specs', 'DRAFT-OLD-001.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(caws, 'specs', 'DRAFT-BOUND-001.yaml'))).toBe(true);
    expect(fs.existsSync(eventsPath(caws))).toBe(false);
  });
});
