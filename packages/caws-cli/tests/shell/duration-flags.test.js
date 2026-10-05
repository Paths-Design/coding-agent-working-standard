'use strict';

/**
 * CAWS-CLI-HUMAN-DURATION-FLAGS-01 — age and TTL flags accept human durations.
 *
 * `--older-than <duration>` and `--stale-ttl <duration>` sit beside the
 * existing `-ms` flags and share the `reprieve grant --for` grammar. The CLI
 * cases drive the built binary: handler tests bypass Commander, so they cannot
 * prove a flag is registered or that the parse layer forwards the resolved
 * value rather than the raw option.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  parseDurationToSeconds,
  formatDurationMs,
  resolveDurationOption,
  OLDER_THAN_FLAGS,
  STALE_TTL_FLAGS,
  DURATION_UNITS_HELP,
} = require('../../dist/shell/duration');
const reprieve = require('../../dist/shell/commands/reprieve');
const { COMMAND_SURFACE_METADATA } = require('../../dist/shell/command-metadata');
const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const SESSION = 'duration-flags-test';

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  return root;
}

function runCli(root, args) {
  // Clear every harness session var so the resolver sees this test's id, not
  // the ambient agent session that is running the suite.
  const env = { ...process.env, CAWS_SESSION_ID: SESSION };
  for (const v of reprieve.AGENT_SESSION_VARS) delete env[v];
  env.CAWS_SESSION_ID = SESSION;
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function json(result) {
  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    throw new Error(
      `expected JSON on stdout (exit ${result.code}):\n${result.stdout}\n--- stderr ---\n${result.stderr}`
    );
  }
}

function writeLease(root, sessionId, fields) {
  const dir = path.join(root, '.caws', 'leases');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.json`),
    JSON.stringify(
      {
        lease_version: 1,
        session_id: sessionId,
        platform: 'test',
        repo_root: root,
        ...fields,
      },
      null,
      2
    ) + '\n'
  );
}

/** Snapshot every file under .caws so a refusal can be shown to change nothing. */
function cawsSnapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(root, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(path.join(root, '.caws'));
  return out;
}

describe('shared duration grammar', () => {
  test('reprieve --for and the age/TTL flags use the same parser object', () => {
    // One grammar: if reprieve kept a private copy, the two could drift.
    expect(reprieve.parseDurationToSeconds).toBe(parseDurationToSeconds);
    expect(reprieve.DURATION_UNITS_HELP).toBe(DURATION_UNITS_HELP);
  });

  test.each([
    [0, '0s'],
    [1000, '1s'],
    [10 * MIN, '10m'],
    [90 * MIN, '1h30m'],
    [30 * 24 * HOUR, '30d'],
    [24 * HOUR + HOUR + MIN + 1000, '1d1h1m1s'],
  ])('formatDurationMs(%i) is %s and parses back to the same value', (ms, text) => {
    expect(formatDurationMs(ms)).toBe(text);
    expect(parseDurationToSeconds(text) * 1000).toBe(ms);
  });

  test.each([1500, -1000, 1.5, Number.NaN])(
    'formatDurationMs(%p) is null: no duration string expresses it exactly',
    (ms) => {
      expect(formatDurationMs(ms)).toBeNull();
    }
  );
});

describe('resolveDurationOption', () => {
  test('neither spelling leaves the command default in force', () => {
    expect(resolveDurationOption(OLDER_THAN_FLAGS, undefined, undefined)).toEqual({
      ok: true,
      ms: undefined,
    });
  });

  test.each([
    ['10m', 600000],
    ['2h', 7200000],
    ['1h30m', 5400000],
    ['7d', 604800000],
    ['0s', 0],
  ])('duration %s resolves to %i ms', (text, ms) => {
    expect(resolveDurationOption(OLDER_THAN_FLAGS, text, undefined)).toEqual({ ok: true, ms });
  });

  test('a valid ms value keeps its exact meaning', () => {
    expect(resolveDurationOption(OLDER_THAN_FLAGS, undefined, '600000')).toEqual({
      ok: true,
      ms: 600000,
    });
    expect(resolveDurationOption(OLDER_THAN_FLAGS, undefined, '0')).toEqual({ ok: true, ms: 0 });
  });

  test('a bare number is refused and the refusal offers both readings', () => {
    const r = resolveDurationOption(OLDER_THAN_FLAGS, '30', undefined);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('--older-than "30" is not a valid duration');
    expect(r.error).toContain(DURATION_UNITS_HELP);
    expect(r.error).toContain('write 30m, 30h');
    expect(r.error).toContain('--older-than-ms 30 for milliseconds');
  });

  test.each(['10x', '-5m', '', '  ', '5m3', 'm5', '1.5h'])(
    'duration %p is refused with the unit list',
    (text) => {
      const r = resolveDurationOption(STALE_TTL_FLAGS, text, undefined);
      expect(r.ok).toBe(false);
      expect(r.error).toContain(`--stale-ttl ${JSON.stringify(text)} is not a valid duration`);
      expect(r.error).toContain(DURATION_UNITS_HELP);
    }
  );

  test('a duration too large to hold as a safe integer of ms is refused, not wrapped', () => {
    const r = resolveDurationOption(OLDER_THAN_FLAGS, '9999999999999d', undefined);
    expect(r.ok).toBe(false);
  });

  test.each(['abc', '-1', '1.5', '', '1e3x'])(
    'ms value %p is refused instead of falling back to the default',
    (raw) => {
      const r = resolveDurationOption(STALE_TTL_FLAGS, undefined, raw);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('--stale-ttl-ms must be a non-negative integer');
      expect(r.error).toContain('--stale-ttl <duration>');
    }
  );

  test('both spellings at once are refused rather than one silently winning', () => {
    const r = resolveDurationOption(OLDER_THAN_FLAGS, '10m', '600000');
    expect(r).toEqual({
      ok: false,
      error:
        'pass --older-than <duration> or --older-than-ms <ms>, not both (got --older-than "10m" and --older-than-ms "600000").',
    });
  });
});

describe('CLI: the duration flag reaches each handler as milliseconds', () => {
  // Each command below echoes the threshold it applied in --json. Comparing
  // the duration form with the -ms form and with a second, different
  // duration proves the value is forwarded rather than ignored or defaulted.
  const ECHOING = [
    {
      name: 'specs prune-drafts',
      args: ['specs', 'prune-drafts', '--json'],
      flag: '--older-than',
      read: (p) => p.selector.older_than_ms,
    },
    {
      name: 'specs archive --status closed',
      args: ['specs', 'archive', '--status', 'closed', '--json'],
      flag: '--older-than',
      read: (p) => p.selector.older_than_ms,
    },
    {
      name: 'session prune',
      args: ['session', 'prune', '--json'],
      flag: '--older-than',
      read: (p) => p.retention_ms,
    },
    {
      name: 'message status --mine --queued',
      args: ['message', 'status', '--mine', '--queued', '--json'],
      flag: '--older-than',
      read: (p) => p.older_than_ms,
    },
    {
      name: 'message prune --status undelivered-to-dead-session',
      args: ['message', 'prune', '--status', 'undelivered-to-dead-session', '--json'],
      flag: '--older-than',
      read: (p) => p.dead_recipient_floor_ms,
    },
    {
      name: 'agents list',
      args: ['agents', 'list', '--json'],
      flag: '--stale-ttl',
      read: (p) => p.stale_ttl_ms,
    },
  ];

  let root;
  beforeAll(() => {
    root = mkRepo();
  });

  test.each(ECHOING)('$name: $flag 10m applies 600000 ms, same as the -ms form', (c) => {
    const viaDuration = runCli(root, [...c.args, c.flag, '10m']);
    expect(viaDuration.stderr).not.toContain('unknown option');
    expect(viaDuration.code).toBe(0);
    expect(c.read(json(viaDuration))).toBe(600000);

    const viaMs = runCli(root, [...c.args, `${c.flag}-ms`, '600000']);
    expect(viaMs.code).toBe(0);
    expect(c.read(json(viaMs))).toBe(600000);

    const other = runCli(root, [...c.args, c.flag, '1h30m']);
    expect(c.read(json(other))).toBe(5400000);
  });

  test('agents show: --stale-ttl 10m sets the derived liveness TTL', () => {
    writeLease(root, 'show-target', {
      status: 'active',
      started_at: new Date(Date.now() - 20 * MIN).toISOString(),
      last_active: new Date(Date.now() - 20 * MIN).toISOString(),
    });
    // 20 minutes idle: active under the 30m default, stale under 10m.
    const tight = json(
      runCli(root, ['agents', 'show', 'show-target', '--stale-ttl', '10m', '--json'])
    );
    expect(tight.liveness.ttl_ms).toBe(600000);
    expect(tight.liveness.classification).toBe('stale');

    const loose = json(
      runCli(root, ['agents', 'show', 'show-target', '--stale-ttl', '1h', '--json'])
    );
    expect(loose.liveness.ttl_ms).toBe(3600000);
    expect(loose.liveness.classification).toBe('active');
  });

  test('agents prune --status stopped: --older-than selects by the same threshold as --older-than-ms', () => {
    const repo = mkRepo();
    const stoppedAt = (ageMs) => new Date(Date.now() - ageMs).toISOString();
    writeLease(repo, 'stopped-2h', {
      status: 'stopped',
      started_at: stoppedAt(3 * HOUR),
      last_active: stoppedAt(2 * HOUR),
      stopped_at: stoppedAt(2 * HOUR),
    });
    writeLease(repo, 'stopped-1m', {
      status: 'stopped',
      started_at: stoppedAt(2 * MIN),
      last_active: stoppedAt(MIN),
      stopped_at: stoppedAt(MIN),
    });
    const candidates = (args) =>
      json(runCli(repo, ['agents', 'prune', '--status', 'stopped', '--json', ...args])).candidates;

    expect(candidates(['--older-than', '10m'])).toEqual(['stopped-2h']);
    expect(candidates(['--older-than-ms', '600000'])).toEqual(['stopped-2h']);
    expect(candidates(['--older-than', '3h'])).toEqual([]);
    expect(candidates(['--older-than', '0s']).sort()).toEqual(['stopped-1m', 'stopped-2h']);
  });
});

describe('CLI: refusals exit 1, name the flag, and change nothing', () => {
  const CASES = [
    ['specs', 'archive', '--status', 'closed', '--apply', '--older-than', '30'],
    ['specs', 'prune-drafts', '--apply', '--older-than', '10x'],
    ['agents', 'prune', '--status', 'stopped', '--apply', '--older-than', '-5m'],
    ['session', 'prune', '--apply', '--older-than', ''],
    ['message', 'prune', '--status', 'delivered', '--apply', '--older-than', '2 days'],
    ['message', 'status', '--mine', '--queued', '--older-than', 'soon'],
    ['agents', 'list', '--stale-ttl', '30'],
  ];

  let root;
  beforeAll(() => {
    root = mkRepo();
    writeLease(root, 'old-stopped', {
      status: 'stopped',
      started_at: new Date(Date.now() - 48 * HOUR).toISOString(),
      last_active: new Date(Date.now() - 48 * HOUR).toISOString(),
      stopped_at: new Date(Date.now() - 48 * HOUR).toISOString(),
    });
  });

  test.each(CASES)('caws %s %s … refuses an invalid duration', (...args) => {
    const before = cawsSnapshot(root);
    const r = runCli(root, args);
    const flagIndex = args.findIndex((a) => a === '--older-than' || a === '--stale-ttl');
    const flag = args[flagIndex];
    const value = args[flagIndex + 1];

    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`caws ${args[0]} ${args[1]}: ${flag} ${JSON.stringify(value)}`);
    expect(r.stderr).toContain(DURATION_UNITS_HELP);
    expect(cawsSnapshot(root)).toEqual(before);
  });

  test.each([
    ['specs', 'archive', '--status', 'closed', '--older-than', '10m', '--older-than-ms', '600000'],
    ['agents', 'show', 'x', '--stale-ttl', '10m', '--stale-ttl-ms', '600000'],
  ])('caws %s %s … refuses both spellings at once', (...args) => {
    const r = runCli(root, args);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/pass --(older-than|stale-ttl) <duration> or --\1-ms <ms>, not both/);
  });

  test.each([
    ['agents', 'list', '--stale-ttl-ms', 'abc'],
    ['agents', 'show', 'x', '--stale-ttl-ms', '-1'],
    ['message', 'status', '--mine', '--queued', '--older-than-ms', '1.5'],
    ['agents', 'prune', '--status', 'stopped', '--older-than-ms', 'abc'],
  ])('caws %s %s … refuses an invalid -ms value instead of using the default', (...args) => {
    const r = runCli(root, args);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--(older-than|stale-ttl)-ms must be a non-negative integer/);
  });

  test('the -ms form with a valid integer keeps working', () => {
    const r = runCli(root, [
      'agents',
      'prune',
      '--status',
      'stopped',
      '--older-than-ms',
      '86400000',
      '--json',
    ]);
    expect(r.code).toBe(0);
    expect(json(r).candidates).toEqual(['old-stopped']);
  });
});

describe('CLI: archive dry-run echoes the duration form', () => {
  test('the printed apply line uses --older-than 10m, not --older-than-ms 600000', () => {
    const root = mkRepo();
    const r = runCli(root, ['specs', 'archive', '--status', 'closed', '--older-than', '10m']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      'apply: caws specs archive --status closed --older-than 10m --apply'
    );
    expect(r.stdout).not.toContain('--older-than-ms');
  });

  test('a threshold that is not whole seconds is echoed exactly in the -ms form', () => {
    const root = mkRepo();
    const r = runCli(root, ['specs', 'archive', '--status', 'closed', '--older-than-ms', '1500']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--older-than-ms 1500 --apply');
  });
});

describe('help lists each duration flag beside its -ms flag', () => {
  const LEAVES = [
    ['specs', 'prune-drafts', '--older-than'],
    ['specs', 'archive', '--older-than'],
    ['agents', 'list', '--stale-ttl'],
    ['agents', 'show', '--stale-ttl'],
    ['agents', 'prune', '--older-than'],
    ['agents', 'prune', '--stale-ttl'],
    ['session', 'prune', '--older-than'],
    ['message', 'status', '--older-than'],
    ['message', 'prune', '--older-than'],
  ];

  test.each(LEAVES)('%s %s declares %s <duration> and keeps the -ms form', (group, leaf, flag) => {
    const groupMeta = COMMAND_SURFACE_METADATA.find((g) => g.name === group);
    const leafMeta = groupMeta.subcommands.find((c) => c.name === leaf);
    const flags = leafMeta.options.map((o) => o.flag);
    expect(flags).toContain(`${flag} <duration>`);
    expect(flags).toContain(`${flag}-ms <ms>`);
  });

  test('rendered --help for specs archive shows --older-than with units', () => {
    const root = mkRepo();
    const r = runCli(root, ['specs', 'archive', '--help']);
    expect(r.stdout).toContain('--older-than <duration>');
    expect(r.stdout).toContain('--older-than-ms <ms>');
    expect(r.stdout).toMatch(/units: s, m, h\/hr,\s+d/);
  });
});
