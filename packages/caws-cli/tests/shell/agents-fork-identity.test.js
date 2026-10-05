'use strict';

/**
 * CAWS-AGENTS-FORK-IDENTITY-001 — CLI parse path + kernel write path.
 *
 * Pins the fork-aware lease surface end to end: harness_session_kind +
 * forked_from written and carried forward across throttled heartbeats,
 * hook_pid replacing the legacy pid on fresh writes (with pid fallback for
 * legacy leases), heartbeat flag validation, identity-backed conjoining
 * telemetry, and the hook template's namespace boundary + env passthrough.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { initProject } = require('../../dist/store/init-store');
const {
  CONJOINING_RETENTION_MS,
  deriveConjoiningTelemetry,
} = require('../../dist/shell/commands/agents-conjoining');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
const HOOK_TEMPLATE = path.resolve(
  __dirname,
  '..',
  '..',
  'templates',
  'hook-packs',
  'shared',
  'agent-heartbeat.sh'
);

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  return root;
}

function spawnCli(root, args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'fork-identity-test', ...env },
  });
}

function readLease(root, sid) {
  return JSON.parse(fs.readFileSync(path.join(root, '.caws', 'leases', `${sid}.json`), 'utf8'));
}

function writeLease(root, sid, overrides = {}) {
  const leasesDir = path.join(root, '.caws', 'leases');
  fs.mkdirSync(leasesDir, { recursive: true });
  fs.writeFileSync(
    path.join(leasesDir, `${sid}.json`),
    JSON.stringify(
      {
        lease_version: 1,
        session_id: sid,
        platform: 'test',
        status: 'active',
        started_at: '2026-07-04T10:00:00.000Z',
        last_active: '2026-07-04T10:00:05.000Z',
        repo_root: root,
        cwd: root,
        git_common_dir: path.join(root, '.git'),
        git_dir: path.join(root, '.git'),
        hostname: os.hostname(),
        last_seen_reason: 'manual_register',
        ...overrides,
      },
      null,
      2
    ) + '\n'
  );
}

function recentIso(offsetMs) {
  return new Date(Date.now() + offsetMs).toISOString();
}

const DIRECT_NOW = new Date('2026-09-09T20:00:00.000Z');

function directLease(sid, overrides = {}) {
  return {
    lease_version: 1,
    session_id: sid,
    platform: 'codex',
    status: 'active',
    started_at: '2026-09-09T18:00:00.000Z',
    last_active: '2026-09-09T19:00:00.000Z',
    repo_root: '/repo',
    cwd: '/repo',
    git_common_dir: '/repo/.git',
    git_dir: '/repo/.git',
    hostname: 'host-a',
    last_seen_reason: 'manual_register',
    ...overrides,
  };
}

test('A1: heartbeat --session-kind fork --forked-from writes the fields; follow-up without flags carries them forward', () => {
  const root = mkRepo();
  const first = spawnCli(root, [
    'agents',
    'heartbeat',
    '--session-id',
    'fork-sess',
    '--platform',
    'test',
    '--session-kind',
    'fork',
    '--forked-from',
    'parent-sess',
  ]);
  expect(first.status).toBe(0);
  let lease = readLease(root, 'fork-sess');
  expect(lease.harness_session_kind).toBe('fork');
  expect(lease.forked_from).toBe('parent-sess');
  expect(typeof lease.hook_pid).toBe('number');
  expect(lease.pid).toBeUndefined();
  // Throttled-style follow-up: context omits the fork fields.
  const second = spawnCli(root, [
    'agents',
    'heartbeat',
    '--session-id',
    'fork-sess',
    '--platform',
    'test',
    '--reason',
    'claim',
  ]);
  expect(second.status).toBe(0);
  lease = readLease(root, 'fork-sess');
  expect(lease.harness_session_kind).toBe('fork');
  expect(lease.forked_from).toBe('parent-sess');
});

test('A2: a legacy pid-only lease still feeds the dead-oracle fallback', () => {
  const root = mkRepo();
  // Legacy shape: pid only, no hook_pid, last_active long past the TTL.
  writeLease(root, 'legacy-sess', {
    pid: 0, // dead pid — the oracle selects dead-pid stale leases
    last_active: '2026-07-04T10:00:00.000Z',
    started_at: '2026-07-04T09:00:00.000Z',
  });
  const r = spawnCli(root, ['agents', 'prune', '--dead', '--json']);
  expect(r.status).toBe(0);
  const parsed = JSON.parse(r.stdout);
  expect(parsed.candidates).toContain('legacy-sess');
});

test('A3: invalid --session-kind and orphaned --forked-from are refused', () => {
  const root = mkRepo();
  const badKind = spawnCli(root, [
    'agents',
    'heartbeat',
    '--session-id',
    's1',
    '--platform',
    'test',
    '--session-kind',
    'bogus',
  ]);
  expect(badKind.status).toBe(1);
  expect(badKind.stderr).toMatch(/session-kind accepts exactly/);
  const orphan = spawnCli(root, [
    'agents',
    'heartbeat',
    '--session-id',
    's1',
    '--platform',
    'test',
    '--forked-from',
    'p',
  ]);
  expect(orphan.status).toBe(1);
  expect(orphan.stderr).toMatch(/only meaningful with --session-kind fork/);
});

test('A4: explicit fork identity confirms a conjoined pair without temporal overlap', () => {
  const root = mkRepo();
  writeLease(root, 'a-sess', {
    started_at: recentIso(-6 * 60 * 60 * 1000),
    last_active: recentIso(-5 * 60 * 60 * 1000),
    harness_session_kind: 'main',
  });
  writeLease(root, 'b-sess', {
    started_at: recentIso(-4 * 60 * 60 * 1000),
    last_active: recentIso(-3 * 60 * 60 * 1000),
    harness_session_kind: 'fork',
    forked_from: 'a-sess',
  });
  const text = spawnCli(root, ['agents', 'list']);
  expect(text.status).toBe(0);
  expect(text.stdout).toContain('conjoined-confirmed: b-sess -> a-sess (explicit fork identity)');
  const json = spawnCli(root, ['agents', 'list', '--json']);
  expect(json.status).toBe(0);
  const parsed = JSON.parse(json.stdout);
  expect(parsed.conjoined_pairs).toEqual([
    {
      a: 'a-sess',
      b: 'b-sess',
      parent: 'a-sess',
      child: 'b-sess',
      source: 'explicit_fork_identity',
    },
  ]);
  expect(parsed.conjoined_unresolved_pairs).toEqual([]);
  // Display-only: no lease file was modified by listing.
  const parentBefore = readLease(root, 'a-sess');
  spawnCli(root, ['agents', 'list', '--json']);
  expect(readLease(root, 'a-sess')).toEqual(parentBefore);
});

test('A5: overlap without fork identity is summarized as unresolved, never asserted pair by pair', () => {
  const root = mkRepo();
  writeLease(root, 'unknown-a', {
    started_at: recentIso(-2 * 60 * 60 * 1000),
    last_active: recentIso(-30 * 60 * 1000),
  });
  writeLease(root, 'unknown-b', {
    started_at: recentIso(-90 * 60 * 1000),
    last_active: recentIso(-15 * 60 * 1000),
  });

  const text = spawnCli(root, ['agents', 'list']);
  expect(text.status).toBe(0);
  expect(text.stdout).not.toContain('conjoined-hint:');
  expect(text.stdout).not.toContain('unknown-a <=> unknown-b');
  // The pair count and the lease-classification coverage are separate
  // statements naming their own units (CAWS-AGENTS-LIST-DISCLOSURE-01); one
  // sentence carrying both read as a ratio between unrelated populations.
  expect(text.stdout).toContain(
    'conjoined-unresolved: 1 lease pair(s) overlap on one platform without complete fork identity'
  );
  expect(text.stdout).toContain('identity coverage: 0 of 2 recent lease(s) declare fork identity');

  const parsed = JSON.parse(spawnCli(root, ['agents', 'list', '--json']).stdout);
  expect(parsed.conjoined_pairs).toEqual([]);
  expect(parsed.conjoined_unresolved_pairs).toEqual([
    { a: 'unknown-a', b: 'unknown-b', reason: 'missing_fork_identity' },
  ]);
  expect(parsed.conjoining_identity).toEqual({
    retention_ms: 7 * 24 * 60 * 60 * 1000,
    recent_leases: 2,
    excluded_leases: 0,
    classified_leases: 0,
    unclassified_leases: 2,
    rejected_overlap_pairs: 0,
  });
});

test('A6: cross-platform overlap and two explicit main sessions are rejected', () => {
  const root = mkRepo();
  const commonWindow = {
    started_at: recentIso(-2 * 60 * 60 * 1000),
    last_active: recentIso(-30 * 60 * 1000),
  };
  writeLease(root, 'main-a', { ...commonWindow, platform: 'codex', harness_session_kind: 'main' });
  writeLease(root, 'main-b', { ...commonWindow, platform: 'codex', harness_session_kind: 'main' });
  writeLease(root, 'foreign', { ...commonWindow, platform: 'claude-code' });

  const parsed = JSON.parse(spawnCli(root, ['agents', 'list', '--json']).stdout);
  expect(parsed.conjoined_pairs).toEqual([]);
  expect(parsed.conjoined_unresolved_pairs).toEqual([]);
  expect(parsed.conjoining_identity).toEqual(
    expect.objectContaining({
      recent_leases: 3,
      classified_leases: 2,
      unclassified_leases: 1,
      rejected_overlap_pairs: 3,
    })
  );
});

test('A7: conjoining telemetry excludes leases older than seven days without changing liveness totals', () => {
  const root = mkRepo();
  const oldWindow = {
    status: 'stopped',
    started_at: recentIso(-10 * 24 * 60 * 60 * 1000),
    last_active: recentIso(-9 * 24 * 60 * 60 * 1000),
    stopped_at: recentIso(-9 * 24 * 60 * 60 * 1000),
  };
  writeLease(root, 'old-a', oldWindow);
  writeLease(root, 'old-b', oldWindow);

  const parsed = JSON.parse(
    spawnCli(root, ['agents', 'list', '--include-stopped', '--json']).stdout
  );
  expect(parsed.counts.stopped).toBe(2);
  expect(parsed.conjoined_pairs).toEqual([]);
  expect(parsed.conjoined_unresolved_pairs).toEqual([]);
  expect(parsed.conjoining_identity).toEqual(
    expect.objectContaining({
      recent_leases: 0,
      excluded_leases: 2,
      rejected_overlap_pairs: 0,
    })
  );
});

describe('identity-backed conjoining classifier', () => {
  test('the diagnostic retention contract is exactly seven days', () => {
    expect(CONJOINING_RETENTION_MS).toBe(604800000);
  });

  test('explicit ancestry confirms a non-overlapping relation and reports complete coverage', () => {
    const leases = {
      parent: directLease('parent', {
        harness_session_kind: 'main',
        started_at: '2026-09-09T10:00:00.000Z',
        last_active: '2026-09-09T11:00:00.000Z',
      }),
      child: directLease('child', {
        harness_session_kind: 'fork',
        forked_from: 'parent',
        started_at: '2026-09-09T12:00:00.000Z',
        last_active: '2026-09-09T13:00:00.000Z',
      }),
    };

    expect(deriveConjoiningTelemetry(leases, DIRECT_NOW)).toEqual({
      confirmed: [
        {
          a: 'parent',
          b: 'child',
          parent: 'parent',
          child: 'child',
          source: 'explicit_fork_identity',
        },
      ],
      unresolved: [],
      identity: {
        retention_ms: CONJOINING_RETENTION_MS,
        recent_leases: 2,
        excluded_leases: 0,
        classified_leases: 2,
        unclassified_leases: 0,
        rejected_overlap_pairs: 0,
      },
    });
  });

  test('unknown same-platform overlap remains unresolved with exact pair identity', () => {
    const telemetry = deriveConjoiningTelemetry(
      {
        beta: directLease('beta'),
        alpha: directLease('alpha'),
      },
      DIRECT_NOW
    );

    expect(telemetry.confirmed).toEqual([]);
    expect(telemetry.unresolved).toEqual([
      { a: 'alpha', b: 'beta', reason: 'missing_fork_identity' },
    ]);
    expect(telemetry.identity).toEqual({
      retention_ms: CONJOINING_RETENTION_MS,
      recent_leases: 2,
      excluded_leases: 0,
      classified_leases: 0,
      unclassified_leases: 2,
      rejected_overlap_pairs: 0,
    });
  });

  test('known main overlap and cross-platform overlap are rejected', () => {
    const telemetry = deriveConjoiningTelemetry(
      {
        mainA: directLease('mainA', { harness_session_kind: 'main' }),
        mainB: directLease('mainB', { harness_session_kind: 'main' }),
        foreign: directLease('foreign', { platform: 'claude-code' }),
      },
      DIRECT_NOW
    );

    expect(telemetry.confirmed).toEqual([]);
    expect(telemetry.unresolved).toEqual([]);
    expect(telemetry.identity).toEqual({
      retention_ms: CONJOINING_RETENTION_MS,
      recent_leases: 3,
      excluded_leases: 0,
      classified_leases: 2,
      unclassified_leases: 1,
      rejected_overlap_pairs: 3,
    });
  });

  test('aged and unparseable leases are excluded from telemetry, not liveness storage', () => {
    const telemetry = deriveConjoiningTelemetry(
      {
        recent: directLease('recent', { harness_session_kind: 'subagent' }),
        old: directLease('old', {
          started_at: '2026-08-30T10:00:00.000Z',
          last_active: '2026-08-31T10:00:00.000Z',
        }),
        invalid: directLease('invalid', { last_active: 'not-a-timestamp' }),
      },
      DIRECT_NOW
    );

    expect(telemetry.confirmed).toEqual([]);
    expect(telemetry.unresolved).toEqual([]);
    expect(telemetry.identity).toEqual({
      retention_ms: 604800000,
      recent_leases: 1,
      excluded_leases: 2,
      classified_leases: 1,
      unclassified_leases: 0,
      rejected_overlap_pairs: 0,
    });
  });

  test('different host, repository, or activity windows never become unresolved candidates', () => {
    const telemetry = deriveConjoiningTelemetry(
      {
        base: directLease('base'),
        otherHost: directLease('otherHost', { hostname: 'host-b' }),
        otherRepo: directLease('otherRepo', { repo_root: '/other-repo' }),
        later: directLease('later', {
          started_at: '2026-09-09T19:15:00.000Z',
          last_active: '2026-09-09T19:30:00.000Z',
        }),
      },
      DIRECT_NOW
    );

    expect(telemetry.confirmed).toEqual([]);
    expect(telemetry.unresolved).toEqual([]);
    expect(telemetry.identity.rejected_overlap_pairs).toBe(0);
  });

  test('missing host identity never becomes an unresolved candidate', () => {
    const telemetry = deriveConjoiningTelemetry(
      {
        absent: directLease('absent', { hostname: undefined }),
        known: directLease('known'),
      },
      DIRECT_NOW
    );

    expect(telemetry.confirmed).toEqual([]);
    expect(telemetry.unresolved).toEqual([]);
    expect(telemetry.identity.rejected_overlap_pairs).toBe(0);
  });

  test('activity windows that touch at one endpoint count as overlap', () => {
    const telemetry = deriveConjoiningTelemetry(
      {
        earlier: directLease('earlier', {
          started_at: '2026-09-09T18:00:00.000Z',
          last_active: '2026-09-09T19:00:00.000Z',
        }),
        later: directLease('later', {
          started_at: '2026-09-09T19:00:00.000Z',
          last_active: '2026-09-09T19:30:00.000Z',
        }),
      },
      DIRECT_NOW
    );

    expect(telemetry.unresolved).toEqual([
      { a: 'earlier', b: 'later', reason: 'missing_fork_identity' },
    ]);
  });

  test.each([
    ['first start', 'a', 'started_at'],
    ['first end', 'a', 'last_active'],
    ['second start', 'b', 'started_at'],
    ['second end', 'b', 'last_active'],
  ])('unparseable %s prevents an overlap candidate', (_label, leaseId, field) => {
    const leases = {
      a: directLease('a'),
      b: directLease('b'),
    };
    leases[leaseId] = directLease(leaseId, { [field]: 'not-a-timestamp' });

    const telemetry = deriveConjoiningTelemetry(leases, DIRECT_NOW);
    expect(telemetry.unresolved).toEqual([]);
    expect(telemetry.identity.rejected_overlap_pairs).toBe(0);
  });

  test('the exact retention boundary is included and one millisecond older is excluded', () => {
    const boundary = new Date(DIRECT_NOW.getTime() - 604800000).toISOString();
    const tooOld = new Date(DIRECT_NOW.getTime() - 604800001).toISOString();
    const telemetry = deriveConjoiningTelemetry(
      {
        boundary: directLease('boundary', { last_active: boundary, harness_session_kind: 'main' }),
        old: directLease('old', { last_active: tooOld, harness_session_kind: 'main' }),
      },
      DIRECT_NOW
    );

    expect(telemetry.identity).toEqual(
      expect.objectContaining({
        recent_leases: 1,
        excluded_leases: 1,
        classified_leases: 1,
      })
    );
  });

  test('an overlapping explicit relation is confirmed once and removed from ambiguity', () => {
    const telemetry = deriveConjoiningTelemetry(
      {
        'a-child': directLease('a-child', {
          harness_session_kind: 'fork',
          forked_from: 'z-parent',
        }),
        'z-parent': directLease('z-parent', { harness_session_kind: 'main' }),
      },
      DIRECT_NOW
    );

    expect(telemetry.confirmed).toEqual([
      expect.objectContaining({
        parent: 'z-parent',
        child: 'a-child',
      }),
    ]);
    expect(telemetry.unresolved).toEqual([]);
    expect(telemetry.identity.rejected_overlap_pairs).toBe(0);
  });

  test('a non-fork lease cannot forge ancestry by carrying forked_from', () => {
    const telemetry = deriveConjoiningTelemetry(
      {
        parent: directLease('parent', { harness_session_kind: 'main' }),
        forged: directLease('forged', {
          harness_session_kind: 'main',
          forked_from: 'parent',
        }),
      },
      DIRECT_NOW
    );

    expect(telemetry.confirmed).toEqual([]);
    expect(telemetry.unresolved).toEqual([]);
    expect(telemetry.identity.rejected_overlap_pairs).toBe(1);
  });

  test('orphan, self-referential, and incomplete fork identity never confirms ancestry', () => {
    const telemetry = deriveConjoiningTelemetry(
      {
        orphan: directLease('orphan', { harness_session_kind: 'fork', forked_from: 'missing' }),
        self: directLease('self', { harness_session_kind: 'fork', forked_from: 'self' }),
        incomplete: directLease('incomplete', { harness_session_kind: 'fork' }),
        empty: directLease('empty', { harness_session_kind: 'fork', forked_from: '' }),
      },
      DIRECT_NOW
    );

    expect(telemetry.confirmed).toEqual([]);
    expect(telemetry.unresolved).toEqual([
      { a: 'empty', b: 'incomplete', reason: 'missing_fork_identity' },
      { a: 'empty', b: 'orphan', reason: 'missing_fork_identity' },
      { a: 'empty', b: 'self', reason: 'missing_fork_identity' },
      { a: 'incomplete', b: 'orphan', reason: 'missing_fork_identity' },
      { a: 'incomplete', b: 'self', reason: 'missing_fork_identity' },
    ]);
    expect(telemetry.identity).toEqual(
      expect.objectContaining({
        classified_leases: 2,
        unclassified_leases: 2,
        rejected_overlap_pairs: 1,
      })
    );
  });
});

test('A8: the hook template teaches the namespace boundary and passes fork identity through', () => {
  const src = fs.readFileSync(HOOK_TEMPLATE, 'utf8');
  expect(src).toMatch(/Harness display names \(ListAgents and similar\) are NOT CAWS addresses/);
  expect(src).toMatch(/\$\{CAWS_SESSION_KIND:\+--session-kind "\$CAWS_SESSION_KIND"\}/);
  expect(src).toMatch(/\$\{CAWS_FORKED_FROM:\+--forked-from "\$CAWS_FORKED_FROM"\}/);
});
