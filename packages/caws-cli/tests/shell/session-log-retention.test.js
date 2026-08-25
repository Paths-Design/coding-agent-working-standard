'use strict';

/**
 * SESSION-LOG-RETENTION-SCOPE-001 contract tests.
 *
 * A1: dry-run default — a stale session log dir is listed as a candidate with
 *     its turn-file count, a fresh dir is not; nothing is deleted; --json
 *     carries candidate paths.
 * A2: --apply deletes only the candidate dir's turn-*.json files and preserves
 *     the identity capsule (.session-envelope.json) + .meta.json (per-path
 *     exclusion).
 * A3: the current session's dir and a dir with a live lease are PROTECTED
 *     (never pruned) even when stale.
 * A4: a fresh (under TTL) dir is not a candidate.
 * A5: operational-cache-only — retention appends zero events (events.jsonl is
 *     never created) and dry-run vs apply do not touch governed state.
 *
 * Runs the real command surface against on-disk repos with injected sinks.
 */

const fs = require('fs');
const path = require('path');

const { runSessionPruneCommand } = require('../../dist/shell/commands/session');
const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const NOW = 1770000000000; // fixed reference (ms)
const DAY = 24 * 60 * 60 * 1000;
const RETENTION = 30 * DAY;

afterAll(() => {
  cleanupAll();
});

function sessionsDir(cawsDir) {
  return path.join(cawsDir, 'sessions');
}

/** Create a session-log dir with turn files + capsule/meta at a given age (ms). */
function writeSessionLog(cawsDir, sessionId, turnCount, ageMs) {
  const dir = path.join(sessionsDir(cawsDir), sessionId);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= turnCount; i++) {
    const f = path.join(dir, `turn-${String(i).padStart(3, '0')}.json`);
    fs.writeFileSync(f, JSON.stringify({ turn: i }));
    // Age the turn file so its mtime reflects "last activity".
    fs.utimesSync(f, new Date(NOW - ageMs), new Date(NOW - ageMs));
  }
  fs.writeFileSync(path.join(dir, '.session-envelope.json'), JSON.stringify({ session_id: sessionId }));
  fs.writeFileSync(path.join(dir, '.meta.json'), JSON.stringify({ started: 1 }));
  return dir;
}

function writeCallerSession(cawsDir, sessionId) {
  const dir = sessionsDir(cawsDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.caller-session.json'),
    JSON.stringify({ session_id: sessionId, repo_root: cawsDir })
  );
}

function writeLiveLease(cawsDir, sessionId, lastActiveIso) {
  const leasesDir = path.join(cawsDir, 'leases');
  fs.mkdirSync(leasesDir, { recursive: true });
  fs.writeFileSync(
    path.join(leasesDir, `${sessionId}.json`),
    JSON.stringify({ session_id: sessionId, platform: 'dsh', status: 'active', last_active: lastActiveIso })
  );
}

function runPrune(root, opts = {}) {
  const out = [];
  const err = [];
  const code = runSessionPruneCommand({
    cwd: root,
    now: () => new Date(NOW),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function exists(p) {
  return fs.existsSync(p);
}

describe('SESSION-LOG-RETENTION-SCOPE-001', () => {
  test('A1: dry-run lists stale candidate, not fresh; nothing deleted', () => {
    const root = makeTempRepo();
    const init = initProject(root);
    if (!init.ok) throw new Error('initProject failed');
    const cawsDir = path.join(root, '.caws');

    writeSessionLog(cawsDir, 'stale-sess', 3, 40 * DAY);
    writeSessionLog(cawsDir, 'fresh-sess', 2, 1 * DAY);

    const before = fs.readFileSync(path.join(sessionsDir(cawsDir), 'stale-sess', 'turn-001.json'), 'utf8');
    const r = runPrune(root, { olderThanMs: RETENTION });
    expect(r.code).toBe(0);
    const text = r.out;
    expect(text).toContain('1 candidate(s), 3 turn file(s)');
    expect(text).toContain('stale-sess  3 turn file(s)');
    // Fresh dir is NOT a candidate.
    expect(text).toContain('candidate(s)');
    expect(text).not.toContain('fresh-sess  ');
    // Nothing deleted (dry-run).
    expect(exists(path.join(sessionsDir(cawsDir), 'stale-sess', 'turn-001.json'))).toBe(true);
    expect(fs.readFileSync(path.join(sessionsDir(cawsDir), 'stale-sess', 'turn-001.json'), 'utf8')).toBe(before);

    // JSON carries candidate paths.
    const jr = runPrune(root, { olderThanMs: RETENTION, json: true });
    expect(jr.code).toBe(0);
    const report = JSON.parse(jr.out);
    expect(report.dry_run).toBe(true);
    expect(report.candidate_count).toBe(1);
    expect(report.candidates[0].session_id).toBe('stale-sess');
    expect(report.candidates[0].turn_files).toContain('stale-sess/turn-001.json');
  });

  test('A2: apply deletes only turn files, preserves capsule + meta', () => {
    const root = makeTempRepo();
    const init = initProject(root);
    if (!init.ok) throw new Error('initProject failed');
    const cawsDir = path.join(root, '.caws');

    writeSessionLog(cawsDir, 'stale-sess', 3, 40 * DAY);
    const dir = path.join(sessionsDir(cawsDir), 'stale-sess');

    const r = runPrune(root, { olderThanMs: RETENTION, apply: true });
    expect(r.code).toBe(0);
    expect(r.out).toContain('(apply)');
    // Turn files gone.
    expect(exists(path.join(dir, 'turn-001.json'))).toBe(false);
    expect(exists(path.join(dir, 'turn-002.json'))).toBe(false);
    expect(exists(path.join(dir, 'turn-003.json'))).toBe(false);
    // Identity capsule + meta preserved (per-path exclusion).
    expect(exists(path.join(dir, '.session-envelope.json'))).toBe(true);
    expect(exists(path.join(dir, '.meta.json'))).toBe(true);
  });

  test('A3: current session and live-lease session are protected even when stale', () => {
    const root = makeTempRepo();
    const init = initProject(root);
    if (!init.ok) throw new Error('initProject failed');
    const cawsDir = path.join(root, '.caws');

    writeCallerSession(cawsDir, 'current-sess');
    writeSessionLog(cawsDir, 'current-sess', 2, 40 * DAY); // stale
    writeSessionLog(cawsDir, 'live-sess', 1, 40 * DAY); // stale, but live lease
    writeLiveLease(cawsDir, 'live-sess', new Date(NOW - 5 * 60 * 1000).toISOString()); // fresh heartbeat

    const r = runPrune(root, { olderThanMs: RETENTION, apply: true });
    expect(r.code).toBe(0);
    // Neither protected dir's turns were deleted.
    expect(exists(path.join(sessionsDir(cawsDir), 'current-sess', 'turn-001.json'))).toBe(true);
    expect(exists(path.join(sessionsDir(cawsDir), 'live-sess', 'turn-001.json'))).toBe(true);
    expect(r.out).toContain('protected:');
    expect(r.out).toContain('current-sess');
    expect(r.out).toContain('live-sess');
  });

  test('A4: a fresh dir is not a candidate and survives apply', () => {
    const root = makeTempRepo();
    const init = initProject(root);
    if (!init.ok) throw new Error('initProject failed');
    const cawsDir = path.join(root, '.caws');

    writeSessionLog(cawsDir, 'fresh-sess', 2, 1 * DAY);
    const r = runPrune(root, { olderThanMs: RETENTION, apply: true });
    expect(r.code).toBe(0);
    expect(exists(path.join(sessionsDir(cawsDir), 'fresh-sess', 'turn-001.json'))).toBe(true);
    expect(r.out).toContain('0 candidate(s)');
  });

  test('A5: operational-cache-only — retention appends zero events', () => {
    const root = makeTempRepo();
    const init = initProject(root);
    if (!init.ok) throw new Error('initProject failed');
    const cawsDir = path.join(root, '.caws');

    writeSessionLog(cawsDir, 'stale-sess', 3, 40 * DAY);
    const eventsPath = path.join(cawsDir, 'events.jsonl');
    expect(exists(eventsPath)).toBe(false);

    runPrune(root, { olderThanMs: RETENTION, apply: true });
    // The apply NEVER creates events.jsonl (operational cache only).
    expect(exists(eventsPath)).toBe(false);
  });
});
