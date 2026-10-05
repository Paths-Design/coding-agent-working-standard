'use strict';

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
const { archiveClosedSpecs } = require('../../dist/store/specs-writer');
const { runSpecsArchiveCommand } = require('../../dist/shell/commands/specs');
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

function writeSpec(cawsDir, id, state, opts = {}) {
  const resolution = state === 'closed' ? 'resolution: completed\n' : '';
  const createdAt = opts.createdAt ?? '2026-07-04T00:00:00.000Z';
  const updatedAt = opts.updatedAt ?? '2026-07-04T00:00:00.000Z';
  const worktreeLine = opts.worktree !== undefined ? `worktree: ${opts.worktree}\n` : '';
  const body = `id: ${id}
title: '${id}'
risk_tier: 3
mode: chore
lifecycle_state: ${state}
${resolution}${worktreeLine}created_at: '${createdAt}'
updated_at: '${updatedAt}'
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

function commitAll(root, message) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message]);
}

function runArchive(root, opts) {
  const out = [];
  const err = [];
  const code = runSpecsArchiveCommand({
    cwd: root,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => new Date('2026-07-04T01:02:03.000Z'),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const REPLACE_REMEDY = (id) => `caws specs archive ${id} --replace`;

/** Seed a closed spec whose id already has an OLDER archived body (the stale shadow). */
function seedStaleShadow(caws, id) {
  writeSpec(caws, id, 'closed', { updatedAt: '2026-07-04T00:00:00.000Z' });
  const archiveDir = path.join(caws, 'specs', '.archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  const live = fs.readFileSync(path.join(caws, 'specs', `${id}.yaml`), 'utf8');
  fs.writeFileSync(
    path.join(archiveDir, `${id}.yaml`),
    live
      .replace('lifecycle_state: closed', 'lifecycle_state: archived')
      .replace("updated_at: '2026-07-04T00:00:00.000Z'", "updated_at: '2026-06-01T00:00:00.000Z'")
  );
}

describe('caws specs archive batch mode', () => {
  test('dry-run status closed lists candidates without mutating', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'ARCHIVE-BATCH-A-001', 'closed');
    writeSpec(caws, 'ARCHIVE-BATCH-B-001', 'closed');
    writeSpec(caws, 'ARCHIVE-BATCH-C-001', 'active');
    commitAll(root, 'add archive batch fixtures');
    const beforeHead = git(root, ['rev-parse', 'HEAD']);

    const result = runArchive(root, {
      status: 'closed',
      include: ['ARCHIVE-BATCH-A-001', 'ARCHIVE-BATCH-B-001', 'ARCHIVE-BATCH-C-001'],
      exclude: ['ARCHIVE-BATCH-B-001'],
    });

    expect(result.code).toBe(1);
    expect(result.out).toContain('archive --status closed (dry-run): 1 candidate(s)');
    expect(result.out).toContain('would-archive ARCHIVE-BATCH-A-001');
    expect(result.out).not.toContain('would-archive ARCHIVE-BATCH-B-001');
    expect(result.out).toContain('skipped ARCHIVE-BATCH-C-001: not_closed (active)');
    expect(result.out).toContain(
      'apply: caws specs archive --status closed --include ARCHIVE-BATCH-A-001,ARCHIVE-BATCH-B-001,ARCHIVE-BATCH-C-001 --exclude ARCHIVE-BATCH-B-001 --apply'
    );
    expect(git(root, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(fs.existsSync(path.join(caws, 'specs', 'ARCHIVE-BATCH-A-001.yaml'))).toBe(true);
  });

  test('apply archives included closed specs and emits json', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'ARCHIVE-BATCH-A-001', 'closed');
    writeSpec(caws, 'ARCHIVE-BATCH-B-001', 'closed');
    commitAll(root, 'add archive batch fixtures');

    const result = runArchive(root, {
      status: 'closed',
      include: ['ARCHIVE-BATCH-A-001', 'ARCHIVE-BATCH-B-001'],
      apply: true,
      json: true,
    });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload.ok).toBe(true);
    expect(payload.dry_run).toBe(false);
    expect(payload.archived.map((entry) => entry.id)).toEqual([
      'ARCHIVE-BATCH-A-001',
      'ARCHIVE-BATCH-B-001',
    ]);
    expect(git(root, ['log', '-1', '--pretty=%s'])).toBe('chore(caws): archive 2 closed specs');
    expect(fs.existsSync(path.join(caws, 'specs', 'ARCHIVE-BATCH-A-001.yaml'))).toBe(false);
  });

  test('dry-run applies age/date/worktree selectors and renders skipped included specs', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'ARCHIVE-BATCH-OLD-001', 'closed', {
      updatedAt: '2026-06-01T00:00:00.000Z',
    });
    writeSpec(caws, 'ARCHIVE-BATCH-FRESH-001', 'closed', {
      updatedAt: '2026-07-04T00:30:00.000Z',
    });
    writeSpec(caws, 'ARCHIVE-BATCH-BOUND-001', 'closed', {
      updatedAt: '2026-06-01T00:00:00.000Z',
      worktree: 'wt-bound',
    });
    commitAll(root, 'add archive selector fixtures');
    const beforeHead = git(root, ['rev-parse', 'HEAD']);

    const result = runArchive(root, {
      status: 'closed',
      include: ['ARCHIVE-BATCH-OLD-001', 'ARCHIVE-BATCH-FRESH-001', 'ARCHIVE-BATCH-BOUND-001'],
      olderThanMs: 60 * 60 * 1000,
      updatedBefore: '2026-07-01T00:00:00.000Z',
      withoutWorktree: true,
      json: true,
    });

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.out);
    expect(payload.dry_run).toBe(true);
    expect(payload.selector).toMatchObject({
      status: 'closed',
      older_than_ms: 60 * 60 * 1000,
      updated_before: '2026-07-01T00:00:00.000Z',
      without_worktree: true,
    });
    expect(payload.candidates.map((entry) => entry.id)).toEqual(['ARCHIVE-BATCH-OLD-001']);
    expect(payload.candidates[0].timestamp).toBe('2026-06-01T00:00:00.000Z');
    expect(payload.skipped.map((entry) => [entry.id, entry.reason])).toEqual([
      ['ARCHIVE-BATCH-BOUND-001', 'has_worktree'],
      ['ARCHIVE-BATCH-FRESH-001', 'too_fresh'],
    ]);
    expect(git(root, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(fs.existsSync(path.join(caws, 'specs', 'ARCHIVE-BATCH-OLD-001.yaml'))).toBe(true);
  });

  test('apply archives only selected specs after age selectors', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'ARCHIVE-BATCH-OLD-001', 'closed', {
      updatedAt: '2026-06-01T00:00:00.000Z',
    });
    writeSpec(caws, 'ARCHIVE-BATCH-FRESH-001', 'closed', {
      updatedAt: '2026-07-04T00:30:00.000Z',
    });
    commitAll(root, 'add archive selector fixtures');

    const result = runArchive(root, {
      status: 'closed',
      olderThanMs: 60 * 60 * 1000,
      updatedBefore: '2026-07-01T00:00:00.000Z',
      apply: true,
      json: true,
    });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload.archived.map((entry) => entry.id)).toEqual(['ARCHIVE-BATCH-OLD-001']);
    expect(payload.skipped).toEqual([]);
    expect(fs.existsSync(path.join(caws, 'specs', 'ARCHIVE-BATCH-OLD-001.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(caws, 'specs', 'ARCHIVE-BATCH-FRESH-001.yaml'))).toBe(true);
  });

  test('A1: a stale-shadow failure prints the --replace remedy under its failed line', () => {
    const { root, caws } = mkRepo();
    seedStaleShadow(caws, 'ARCHIVE-BATCH-STALE-001');
    commitAll(root, 'stale shadow fixture');

    const result = runArchive(root, {
      status: 'closed',
      include: ['ARCHIVE-BATCH-STALE-001'],
      apply: true,
    });

    expect(result.code).toBe(1);
    const lines = result.out.split('\n');
    const failedIdx = lines.findIndex((l) => l.startsWith('  failed ARCHIVE-BATCH-STALE-001:'));
    expect(failedIdx).toBeGreaterThanOrEqual(0);
    // The remedy line follows the failed entry's (multi-line) reason, indented as a child.
    const nextLines = lines.filter((l) => l.startsWith('    next: '));
    expect(nextLines).toHaveLength(1);
    expect(lines.indexOf(nextLines[0])).toBeGreaterThan(failedIdx);
    expect(nextLines[0]).toContain(REPLACE_REMEDY('ARCHIVE-BATCH-STALE-001'));
  });

  test('A2: --json failed entry carries narrowRepair as a field', () => {
    const { root, caws } = mkRepo();
    seedStaleShadow(caws, 'ARCHIVE-BATCH-STALE-002');
    commitAll(root, 'stale shadow fixture');

    const result = runArchive(root, {
      status: 'closed',
      include: ['ARCHIVE-BATCH-STALE-002'],
      apply: true,
      json: true,
    });

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.out);
    expect(payload.failed).toHaveLength(1);
    expect(payload.failed[0].id).toBe('ARCHIVE-BATCH-STALE-002');
    expect(payload.failed[0].reason).toContain('already has an archived body');
    expect(payload.failed[0].narrowRepair).toContain(REPLACE_REMEDY('ARCHIVE-BATCH-STALE-002'));
  });

  test('A3: archiveClosedSpecs failed entry carries the diagnostic narrowRepair', () => {
    const { root, caws } = mkRepo();
    seedStaleShadow(caws, 'ARCHIVE-BATCH-STALE-003');
    writeSpec(caws, 'ARCHIVE-BATCH-OK-003', 'closed');
    commitAll(root, 'mixed batch fixture');

    const outcome = archiveClosedSpecs(caws, {
      actor: { kind: 'agent', id: 'jest', platform: 'jest' },
      include: ['ARCHIVE-BATCH-STALE-003', 'ARCHIVE-BATCH-OK-003'],
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.value.kind).toBe('success');
    expect(outcome.value.archived.map((e) => e.id)).toEqual(['ARCHIVE-BATCH-OK-003']);
    expect(outcome.value.failed).toHaveLength(1);
    expect(outcome.value.failed[0].id).toBe('ARCHIVE-BATCH-STALE-003');
    expect(outcome.value.failed[0].narrowRepair).toContain(
      REPLACE_REMEDY('ARCHIVE-BATCH-STALE-003')
    );
  });

  test('rejects invalid older-than before composing archive state', () => {
    const { root } = mkRepo();

    const result = runArchive(root, {
      status: 'closed',
      olderThanMs: 'abc',
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain('--older-than-ms must be a non-negative integer');
  });
});
