'use strict';

/**
 * CAWS-AGENTS-PRUNE-LEGACY-001 — caws agents prune --status legacy.
 *
 * The existing prune modes (stopped/stale/dead) all gate on a lease.status
 * value (or a pid), so a legacy record with NO status field (v10/early-v11
 * shape: {session_id, last_active, platform, ...}) falls through every mode
 * and is unreachable. `--status legacy` selects purely by last_active age >
 * retention, regardless of status field.
 */

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
const { runAgentsPruneCommand } = require('../../dist/shell/commands/agents');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

// A LEGACY lease: no status field, no pid (the unreachable shape).
function writeLegacyLease(cawsDir, sessionId, lastActiveIso) {
  const leasesDir = path.join(cawsDir, 'leases');
  fs.mkdirSync(leasesDir, { recursive: true });
  fs.writeFileSync(
    path.join(leasesDir, `${sessionId}.json`),
    JSON.stringify({
      lease_version: 1,
      session_id: sessionId,
      platform: 'claude-code',
      started_at: lastActiveIso,
      last_active: lastActiveIso,
      repo_root: path.dirname(cawsDir),
    }, null, 2) + '\n'
  );
}

function runPrune(cwd, opts) {
  const out = [];
  const err = [];
  const code = runAgentsPruneCommand({
    cwd,
    now: () => new Date('2026-07-31T00:00:00.000Z'),
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'prune-test' },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('CAWS-AGENTS-PRUNE-LEGACY-001 — prune --status legacy', () => {
  test('A1: a status-less legacy lease older than retention is selected (--status legacy)', () => {
    const root = makeTempRepo();
    initProject(root);
    const cawsDir = path.join(root, '.caws');
    // 30 days old — well past any retention.
    writeLegacyLease(cawsDir, 'legacy-old', '2026-07-01T00:00:00.000Z');

    // 1 day retention (86400000 ms). The lease is 30 days old → candidate.
    const result = runPrune(root, { status: 'legacy', olderThanMs: 86400000 });
    expect(result.code).toBe(0);
    expect(result.out).toContain('legacy-old');
  });

  test('A1 confirmed: the same legacy lease is NOT selected by --status stopped (the gap)', () => {
    const root = makeTempRepo();
    initProject(root);
    const cawsDir = path.join(root, '.caws');
    writeLegacyLease(cawsDir, 'legacy-skip', '2026-07-01T00:00:00.000Z');

    // stopped mode requires status === 'stopped'; the legacy lease has none → skipped.
    const result = runPrune(root, { status: 'stopped', olderThanMs: 86400000 });
    expect(result.code).toBe(0);
    expect(result.out).not.toContain('legacy-skip');
  });

  test('A2: --apply deletes the legacy lease; a fresh legacy lease is protected', () => {
    const root = makeTempRepo();
    initProject(root);
    const cawsDir = path.join(root, '.caws');
    writeLegacyLease(cawsDir, 'legacy-stale', '2026-07-01T00:00:00.000Z');
    // A fresh legacy lease (recent last_active) — protected by retention.
    writeLegacyLease(cawsDir, 'legacy-fresh', '2026-07-30T23:00:00.000Z');

    const result = runPrune(root, { status: 'legacy', olderThanMs: 86400000, apply: true });
    expect(result.code).toBe(0);
    expect(result.out).toContain('DELETED legacy-stale');
    expect(result.out).not.toContain('legacy-fresh');
    // Disk: stale gone, fresh present.
    expect(fs.existsSync(path.join(cawsDir, 'leases', 'legacy-stale.json'))).toBe(false);
    expect(fs.existsSync(path.join(cawsDir, 'leases', 'legacy-fresh.json'))).toBe(true);
  });

  test('A3: a legacy lease with unparseable last_active is skipped (no reference)', () => {
    const root = makeTempRepo();
    initProject(root);
    const cawsDir = path.join(root, '.caws');
    writeLegacyLease(cawsDir, 'legacy-badts', 'not-a-timestamp');

    const result = runPrune(root, { status: 'legacy', olderThanMs: 86400000 });
    expect(result.code).toBe(0);
    expect(result.out).not.toContain('legacy-badts');
  });
});
