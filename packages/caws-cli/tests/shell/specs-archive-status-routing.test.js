'use strict';

// Full commander-parse-path regression for CAWS-CLI-SPECS-ARCHIVE-STATUS-PARENT-SHADOW-001.
//
// The existing specs-archive-batch.test.js calls runSpecsArchiveCommand({ status:
// 'closed', ... }) directly, bypassing commander. That handler was always correct;
// what was broken was ROUTING: the parent `specs` command's group-level `--status`
// compat option shadowed the archive leaf's own `--status`, so `caws specs archive
// --status closed` printed "batch mode requires --status closed." on the real CLI
// while every handler-level test stayed green. These tests spawn the real dist CLI
// so they can only pass when the flag actually reaches the batch path.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, git, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) {
    throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  }
  return root;
}

function specPath(root, id) {
  return path.join(root, '.caws', 'specs', `${id}.yaml`);
}

function writeClosedSpec(root, id) {
  const body = `id: ${id}
title: '${id}'
risk_tier: 3
mode: chore
lifecycle_state: closed
resolution: completed
created_at: '2026-07-04T00:00:00.000Z'
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
  fs.writeFileSync(specPath(root, id), body);
}

function commitAll(root, message) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message]);
}

function spawnCli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'specs-archive-status-routing-test' },
  });
}

describe('caws specs archive --status routing (full CLI parse path)', () => {
  test('A1: `specs archive --status closed` reaches the batch dry-run instead of the batch-mode guard', () => {
    const root = mkRepo();
    writeClosedSpec(root, 'ARCHIVE-ROUTE-A-001');
    writeClosedSpec(root, 'ARCHIVE-ROUTE-B-001');
    commitAll(root, 'add closed fixtures');
    const beforeHead = git(root, ['rev-parse', 'HEAD']);

    const result = spawnCli(root, ['specs', 'archive', '--status', 'closed']);
    const output = `${result.stdout}${result.stderr}`;

    // The pre-fix failure mode: the guard fires because --status bound to the parent.
    expect(output).not.toContain('batch mode requires --status closed');
    // Dry-run over two clean closed specs skips nothing, so the exit code is 0
    // (the batch dry-run returns 1 only when a candidate was skipped — see
    // runSpecsArchiveCommand: `skipped.length === 0 ? 0 : 1`). What proves the
    // routing fix is that the candidate listing was produced at all.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('archive --status closed (dry-run): 2 candidate(s)');
    expect(result.stdout).toContain('would-archive ARCHIVE-ROUTE-A-001');
    expect(result.stdout).toContain('would-archive ARCHIVE-ROUTE-B-001');
    // Dry-run mutates nothing.
    expect(git(root, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(fs.existsSync(specPath(root, 'ARCHIVE-ROUTE-A-001'))).toBe(true);
  });

  test('A2: `specs archive --status closed --apply` archives via the batch path in one aggregate commit', () => {
    const root = mkRepo();
    writeClosedSpec(root, 'ARCHIVE-ROUTE-A-001');
    writeClosedSpec(root, 'ARCHIVE-ROUTE-B-001');
    commitAll(root, 'add closed fixtures');

    const result = spawnCli(root, ['specs', 'archive', '--status', 'closed', '--apply']);
    const output = `${result.stdout}${result.stderr}`;

    expect(output).not.toContain('batch mode requires --status closed');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('archive --status closed (apply): archived 2');
    expect(git(root, ['log', '-1', '--pretty=%s'])).toBe('chore(caws): archive 2 closed specs');
    expect(fs.existsSync(specPath(root, 'ARCHIVE-ROUTE-A-001'))).toBe(false);
    expect(fs.existsSync(specPath(root, 'ARCHIVE-ROUTE-B-001'))).toBe(false);
  });

  test('A3: parent `specs --status closed` compat handoff to `specs list` still works', () => {
    const root = mkRepo();
    writeClosedSpec(root, 'ARCHIVE-ROUTE-LIST-001');
    commitAll(root, 'add closed fixture');

    const result = spawnCli(root, ['specs', '--status', 'closed']);
    const output = `${result.stdout}${result.stderr}`;

    // The fix must not have removed the parent option: no unknown-option error,
    // and the closed spec is listed (proving the handoff to `specs list` ran).
    expect(output).not.toContain("unknown option '--status'");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ARCHIVE-ROUTE-LIST-001');
    expect(result.stdout).toContain('closed');
  });

  test('A4: single-id `specs archive <id>` archives exactly that spec (routing fix left id path intact)', () => {
    const root = mkRepo();
    writeClosedSpec(root, 'ARCHIVE-ROUTE-SINGLE-001');
    writeClosedSpec(root, 'ARCHIVE-ROUTE-KEEP-001');
    commitAll(root, 'add closed fixtures');

    const result = spawnCli(root, ['specs', 'archive', 'ARCHIVE-ROUTE-SINGLE-001']);
    const output = `${result.stdout}${result.stderr}`;

    expect(output).not.toContain('batch mode requires --status closed');
    expect(result.status).toBe(0);
    expect(fs.existsSync(specPath(root, 'ARCHIVE-ROUTE-SINGLE-001'))).toBe(false);
    expect(fs.existsSync(specPath(root, 'ARCHIVE-ROUTE-KEEP-001'))).toBe(true);
  });
});
