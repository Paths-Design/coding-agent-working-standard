'use strict';

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
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

function writeSpec(cawsDir, id, state) {
  const resolution = state === 'closed' ? 'resolution: completed\n' : '';
  const body = `id: ${id}
title: '${id}'
risk_tier: 3
mode: chore
lifecycle_state: ${state}
${resolution}created_at: '2026-07-04T00:00:00.000Z'
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
    expect(git(root, ['log', '-1', '--pretty=%s'])).toBe(
      'chore(caws): archive 2 closed specs'
    );
    expect(fs.existsSync(path.join(caws, 'specs', 'ARCHIVE-BATCH-A-001.yaml'))).toBe(false);
  });
});
