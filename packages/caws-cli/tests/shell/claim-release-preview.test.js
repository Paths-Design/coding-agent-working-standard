'use strict';

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
const { runClaimCommand } = require('../../dist/shell/commands/claim');
const { COMMAND_SURFACE_METADATA } = require('../../dist/shell/command-metadata');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

function writeSpec(cawsDir, id, worktree) {
  const body = `id: ${id}
title: '${id}'
risk_tier: 3
mode: chore
lifecycle_state: active
worktree: ${worktree}
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
  fs.writeFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), body);
}

function writeRegistry(cawsDir, entries) {
  fs.writeFileSync(path.join(cawsDir, 'worktrees.json'), JSON.stringify(entries, null, 2) + '\n');
}

function writeLease(cawsDir, sessionId, extra = {}) {
  const leasesDir = path.join(cawsDir, 'leases');
  fs.mkdirSync(leasesDir, { recursive: true });
  fs.writeFileSync(
    path.join(leasesDir, `${sessionId}.json`),
    JSON.stringify(
      {
        lease_version: 1,
        session_id: sessionId,
        platform: 'claude-code',
        status: 'active',
        started_at: '2026-07-04T11:00:00.000Z',
        last_active: '2026-07-04T11:30:00.000Z',
        repo_root: path.dirname(cawsDir),
        cwd: path.dirname(cawsDir),
        git_common_dir: path.join(path.dirname(cawsDir), '.git'),
        git_dir: path.join(path.dirname(cawsDir), '.git'),
        last_seen_reason: 'claim',
        ...extra,
      },
      null,
      2
    ) + '\n'
  );
}

function readText(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
}

function readLease(cawsDir, sessionId) {
  return JSON.parse(fs.readFileSync(path.join(cawsDir, 'leases', `${sessionId}.json`), 'utf8'));
}

function setupClaimRepo({ ownerSession = 'me', leaseSession = 'me' } = {}) {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  const cawsDir = path.join(root, '.caws');
  const wtPath = path.join(cawsDir, 'worktrees', 'wt-claim');
  fs.mkdirSync(wtPath, { recursive: true });
  writeSpec(cawsDir, 'CLAIM-001', 'wt-claim');
  writeRegistry(cawsDir, {
    'wt-claim': {
      branch: 'wt-claim',
      baseBranch: 'main',
      specId: 'CLAIM-001',
      path: wtPath,
      owner: { session_id: ownerSession, platform: 'claude-code' },
      last_heartbeat: '2026-07-04T11:45:00.000Z',
    },
  });
  if (leaseSession) {
    writeLease(cawsDir, leaseSession, {
      cwd: wtPath,
      bound_worktree: 'wt-claim',
      bound_spec_id: 'CLAIM-001',
      claimed_paths: ['src/a.ts', 'src/b.ts'],
      last_modified_paths: ['src/keep.ts'],
    });
  }
  return { root, cawsDir, wtPath };
}

function runClaim(cwd, opts = {}) {
  const out = [];
  const err = [];
  const code = runClaimCommand({
    cwd,
    now: () => new Date('2026-07-04T12:00:00.000Z'),
    env: {
      ...process.env,
      CLAUDE_SESSION_ID: 'me',
      CLAUDE_PROJECT_DIR: cwd,
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function claimMeta() {
  return COMMAND_SURFACE_METADATA.find((command) => command.name === 'claim');
}

describe('caws claim release and preview UX', () => {
  test('help metadata lists plan, JSON, release, and apply flags', () => {
    const flags = claimMeta().options.map((option) => option.flag);
    expect(flags).toEqual(expect.arrayContaining(['--plan', '--json', '--release-paths', '--apply']));
  });

  test('takeover plan reports prior-owner audit impact without mutating registry or leases', () => {
    const { cawsDir, wtPath } = setupClaimRepo({ ownerSession: 'other', leaseSession: null });
    const beforeRegistry = readText(path.join(cawsDir, 'worktrees.json'));
    const beforeLeases = fs.existsSync(path.join(cawsDir, 'leases'))
      ? fs.readdirSync(path.join(cawsDir, 'leases'))
      : [];

    const result = runClaim(wtPath, { takeover: true, plan: true, json: true });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload).toMatchObject({
      ok: true,
      read_only: true,
      command: 'claim',
      mode: 'takeover',
      worktree_name: 'wt-claim',
      current_session: { session_id: 'me' },
      current_owner: { session_id: 'other' },
      ownership_relation: 'foreign',
      takeover: {
        would_apply: true,
        prior_owner_to_append: {
          session_id: 'other',
          last_seen: '2026-07-04T11:45:00.000Z',
          takenOver_at: '2026-07-04T12:00:00.000Z',
        },
        resulting_owner: { session_id: 'me' },
        prior_owner_count_before: 0,
        prior_owner_count_after: 1,
      },
      next_apply_command: 'caws claim --takeover',
    });
    expect(readText(path.join(cawsDir, 'worktrees.json'))).toBe(beforeRegistry);
    expect(
      fs.existsSync(path.join(cawsDir, 'leases')) ? fs.readdirSync(path.join(cawsDir, 'leases')) : []
    ).toEqual(beforeLeases);
  });

  test('release paths defaults to read-only plan and apply clears only claimed paths', () => {
    const { cawsDir, wtPath } = setupClaimRepo();
    const registryBefore = readText(path.join(cawsDir, 'worktrees.json'));
    const leaseBefore = readLease(cawsDir, 'me');

    const dryRun = runClaim(wtPath, { releasePaths: true, json: true });

    expect(dryRun.code).toBe(0);
    const dryPayload = JSON.parse(dryRun.out);
    expect(dryPayload).toMatchObject({
      ok: true,
      read_only: true,
      mode: 'release-paths',
      release_paths: {
        apply: false,
        lease_found: true,
        current_claimed_paths: ['src/a.ts', 'src/b.ts'],
        would_clear_count: 2,
      },
      next_apply_command: 'caws claim --release-paths --apply',
    });
    expect(readLease(cawsDir, 'me')).toEqual(leaseBefore);

    const applied = runClaim(wtPath, { releasePaths: true, apply: true, json: true });

    expect(applied.code).toBe(0);
    const applyPayload = JSON.parse(applied.out);
    expect(applyPayload).toMatchObject({
      ok: true,
      read_only: false,
      mode: 'release-paths',
      release_paths: {
        apply: true,
        wrote: true,
      },
    });
    const leaseAfter = readLease(cawsDir, 'me');
    expect(leaseAfter.claimed_paths).toEqual([]);
    expect(leaseAfter.last_modified_paths).toEqual(['src/keep.ts']);
    expect(leaseAfter.last_active).toBe(leaseBefore.last_active);
    expect(leaseAfter.last_seen_reason).toBe(leaseBefore.last_seen_reason);
    expect(readText(path.join(cawsDir, 'worktrees.json'))).toBe(registryBefore);
    expect(readText(path.join(cawsDir, 'events.jsonl'))).toBe(null);
  });
});
