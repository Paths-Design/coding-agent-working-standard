'use strict';

/**
 * CAWS-REPRIEVE-RELATIVE-EXPIRY-001 — `caws reprieve grant --for <duration>`.
 *
 * The absolute-ISO-only interface forced the operator to compute a UTC
 * timestamp at exactly the moment a guard was blocking them; near a UTC date
 * boundary that arithmetic silently fails ("today at 19:20" is already past
 * when now is 01:57Z the next day). This suite pins the relative-duration
 * input, the exactly-one-of contract between --for and --expires-at, and the
 * refusal messages that make a wrong input self-correcting.
 *
 * Coverage:
 *   A1 — --for writes a concrete absolute ISO expiry at now + duration
 *   A2 — compound/single-unit durations parse; unparseable ones are refused
 *        with the unit list rather than silently defaulting
 *   A3 — --for + --expires-at together is refused (ambiguous audit record)
 *   A4 — neither supplied is refused, naming BOTH options
 *   plus: the past-expiry refusal reports "now"; the malformed-ISO refusal
 *        names the expected format; --for survives the real Commander parse
 *        path (a handler-only test would not catch an unregistered option).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

const {
  runReprieveGrantCommand,
  parseDurationToSeconds,
} = require('../../dist/shell/commands/reprieve');

const SESSION = 'sess-relative-expiry';
/** Fixed clock so every expiry assertion is exact, not a tolerance window. */
const NOW = new Date('2026-07-26T01:57:16.000Z');

function makeRepoRoot() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-reprieve-for-'));
  execSync(
    'git init -q -b main && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m root',
    { cwd: repoRoot }
  );
  fs.mkdirSync(path.join(repoRoot, '.claude', 'hooks', 'state'), { recursive: true });
  return repoRoot;
}

/**
 * Run grant against a temp repo with a frozen clock, capturing stdout/stderr.
 *
 * env is pinned to a human shell: CAWS-REPRIEVE-NO-SELF-GRANT-001 refuses a
 * grant when any agent-session var is set, and these cases exercise expiry
 * parsing, not the agent guard. Without this the suite passes in CI and fails
 * for every agent — the env-inheritance class that already bit the resolver
 * precedence tests.
 */
function grant(repoRoot, opts) {
  const out = [];
  const err = [];
  const code = runReprieveGrantCommand({
    cwd: repoRoot,
    env: {},
    now: () => NOW,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    handlers: 'protected-paths.sh',
    reason: 'test reprieve',
    approvedBy: '@tester',
    session: SESSION,
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function readRecord(repoRoot) {
  const file = path.join(
    repoRoot,
    '.claude',
    'hooks',
    'state',
    `guard-reprieve-${SESSION}.json`
  );
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('CAWS-REPRIEVE-RELATIVE-EXPIRY-001: parseDurationToSeconds', () => {
  // A2: each accepted shape resolves to a specific offset. Asserting the exact
  // second count (not just "parsed successfully") is what pins unit semantics —
  // a parser that read every unit as minutes would still return non-null here.
  it.each([
    ['30m', 1800],
    ['90m', 5400],
    ['120s', 120],
    ['2d', 172800],
    ['1h', 3600],
    ['1hr', 3600],
    ['1h30m', 5400],
    ['1hr30m', 5400],
    ['2d12h', 216000],
    ['1h30m15s', 5415],
    ['0s', 0],
  ])('parses %s to %i seconds', (input, expected) => {
    expect(parseDurationToSeconds(input)).toBe(expected);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(parseDurationToSeconds(' 1H30M ')).toBe(5400);
  });

  it.each([
    ['30', 'a bare number has no unit'],
    ['', 'empty'],
    ['abc', 'no digits'],
    ['30x', 'unknown unit'],
    ['m30', 'unit before value'],
    ['1h30', 'trailing value with no unit'],
    ['1.5h', 'fractional values are not accepted'],
    ['-30m', 'a leading sign is not a digit'],
  ])('refuses %s (%s)', (input) => {
    expect(parseDurationToSeconds(input)).toBeNull();
  });
});

describe('CAWS-REPRIEVE-RELATIVE-EXPIRY-001: --for grants (A1)', () => {
  it('writes a concrete absolute ISO expiry at now + duration, not a relative string', () => {
    const repoRoot = makeRepoRoot();
    const r = grant(repoRoot, { for: '90m' });

    expect(r.code).toBe(0);
    const record = readRecord(repoRoot);
    // now 01:57:16Z + 90m = 03:27:16Z. Exact value, not a shape check.
    expect(record.expires_at).toBe('2026-07-26T03:27:16.000Z');
    // The stored value must be re-parseable as an absolute instant; a leaked
    // "90m" would satisfy a truthiness check but be inert for lib/reprieve.sh.
    expect(new Date(record.expires_at).getTime()).toBe(NOW.getTime() + 90 * 60_000);
    expect(record.expires_at).not.toContain('90m');
  });

  it('reports the resolved absolute expiry in the success output', () => {
    const repoRoot = makeRepoRoot();
    const r = grant(repoRoot, { for: '30m' });
    expect(r.out).toContain('2026-07-26T02:27:16.000Z');
  });

  it('refuses a zero duration rather than writing an already-expired reprieve', () => {
    const repoRoot = makeRepoRoot();
    const r = grant(repoRoot, { for: '0s' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('must expire in the future');
    expect(fs.existsSync(
      path.join(repoRoot, '.claude', 'hooks', 'state', `guard-reprieve-${SESSION}.json`)
    )).toBe(false);
  });

  it('refuses an unparseable duration and names the accepted units (A2)', () => {
    const repoRoot = makeRepoRoot();
    const r = grant(repoRoot, { for: '20mins' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('--for "20mins" is not a valid duration');
    // The refusal must carry the unit vocabulary; without it the operator is
    // back to guessing, which is the failure this slice exists to remove.
    expect(r.err).toContain('h/hr');
    expect(r.err).toContain('1h30m');
  });
});

describe('CAWS-REPRIEVE-RELATIVE-EXPIRY-001: exactly-one-of (A3, A4)', () => {
  it('refuses --for and --expires-at together, naming both flags (A3)', () => {
    const repoRoot = makeRepoRoot();
    const r = grant(repoRoot, { for: '30m', expiresAt: '2026-07-27T00:00:00Z' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('--for');
    expect(r.err).toContain('--expires-at');
    expect(r.err).toContain('mutually exclusive');
  });

  it('refuses neither supplied, naming both options (A4)', () => {
    const repoRoot = makeRepoRoot();
    const r = grant(repoRoot, {});
    expect(r.code).toBe(1);
    expect(r.err).toContain('--for');
    expect(r.err).toContain('--expires-at');
    // A4's point is that ISO must never be the sole discoverable path: the
    // refusal has to show a usable relative example, not just name the flag.
    expect(r.err).toContain('--for 30m');
  });
});

describe('CAWS-REPRIEVE-RELATIVE-EXPIRY-001: absolute-expiry refusals stay self-correcting', () => {
  it('reports the current time when the expiry is in the past', () => {
    const repoRoot = makeRepoRoot();
    // The exact shape that burned two retries: "today at 19:20" authored while
    // now is 01:57Z the following day.
    const r = grant(repoRoot, { expiresAt: '2026-07-25T19:20:00Z' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('is in the past');
    expect(r.err).toContain('now: 2026-07-26T01:57:16.000Z');
    expect(r.err).toContain('--for 30m');
  });

  it('names the expected format when the timestamp is malformed', () => {
    const repoRoot = makeRepoRoot();
    const r = grant(repoRoot, { expiresAt: '07-25-2026T19:20:00Z' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('not a valid ISO-8601 timestamp');
    expect(r.err).toContain('YYYY-MM-DDTHH:MM:SSZ');
    expect(r.err).toContain('--for 30m');
  });

  it('still stores an absolute --expires-at verbatim (audit trail unchanged)', () => {
    const repoRoot = makeRepoRoot();
    const r = grant(repoRoot, { expiresAt: '2026-07-27T00:00:00Z' });
    expect(r.code).toBe(0);
    expect(readRecord(repoRoot).expires_at).toBe('2026-07-27T00:00:00Z');
  });

  it('still refuses a timezone-less absolute expiry', () => {
    const repoRoot = makeRepoRoot();
    const r = grant(repoRoot, { expiresAt: '2026-07-27T00:00:00' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('missing a timezone');
  });
});

describe('CAWS-REPRIEVE-RELATIVE-EXPIRY-001: CLI parse path', () => {
  // Handler tests bypass Commander entirely, so they cannot prove --for is
  // registered or that --expires-at stopped being required. Drive the real
  // binary (project_caws_consumer_install_defects lesson).
  const cli = path.resolve(__dirname, '../../dist/index.js');

  function runCli(args, cwd) {
    // The session resolver consults CLAUDE_SESSION_ID / CLAUDE_CODE_SESSION_ID
    // BEFORE CAWS_SESSION_ID, and an agent harness exports those — so a test
    // that only sets CAWS_SESSION_ID resolves to the ambient session and writes
    // its record under a different filename. Delete the higher-precedence vars
    // and pass --session explicitly so the id is the test's, in every context.
    // Every agent-session var must be cleared, not just the higher-precedence
    // ones: CAWS-REPRIEVE-NO-SELF-GRANT-001 refuses the grant if ANY is set,
    // and CAWS_SESSION_ID is itself one of them. The session id is supplied via
    // --session so the record is still deterministically named.
    const env = { ...process.env };
    for (const v of [
      'CLAUDE_SESSION_ID',
      'CLAUDE_CODE_SESSION_ID',
      'CODEX_THREAD_ID',
      'CAWS_SESSION_ID',
      'HOOK_SESSION_ID',
      'CURSOR_TRACE_ID',
    ]) {
      delete env[v];
    }
    return spawnSync('node', [cli, 'reprieve', 'grant', '--session', SESSION, ...args], {
      cwd,
      encoding: 'utf8',
      env,
    });
  }

  it('accepts --for through the real option parser', () => {
    const repoRoot = makeRepoRoot();
    const r = runCli(
      ['--handlers', 'protected-paths.sh', '--reason', 'r', '--approved-by', '@t', '--for', '30m'],
      repoRoot
    );
    expect(r.stderr).not.toContain("unknown option");
    expect(r.stderr).not.toContain("required option '--expires-at'");
    expect(r.status).toBe(0);
    const record = readRecord(repoRoot);
    expect(record.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Date(record.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('no longer requires --expires-at at the parser level (A4 is a handler refusal)', () => {
    const repoRoot = makeRepoRoot();
    const r = runCli(
      ['--handlers', 'protected-paths.sh', '--reason', 'r', '--approved-by', '@t'],
      repoRoot
    );
    // Commander must not preempt with its own required-option error; the
    // handler owns this refusal so it can name --for as the alternative.
    expect(r.stderr).not.toContain("required option '--expires-at' not specified");
    expect(r.stderr).toContain('--for');
    expect(r.status).toBe(1);
  });

  it('lists --for in grant --help', () => {
    const repoRoot = makeRepoRoot();
    const r = spawnSync('node', [cli, 'reprieve', 'grant', '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(r.stdout).toContain('--for <duration>');
    expect(r.stdout).toContain('1h30m');
  });
});
