/**
 * Tests for `runEvidenceRecordCommand`.
 *
 * Pinned exit codes:
 *   0 = appended successfully; stdout shows seq + event_hash
 *   1 = validation/store failure (pre-chained fields, missing --spec,
 *       kernel validateEventBody rejection)
 *   2 = repo-root / session resolution failure
 *
 * The command must NOT accept pre-chained input (`seq`, `prev_hash`,
 * `event_hash`) — this is a load-bearing safety property.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runEvidenceRecordCommand } = require('../../dist/shell');
const { loadEvents: loadEventsFromStore } = require('../../dist/store');

const NOW = new Date('2026-05-14T15:00:00.000Z');

function mkTempGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', [
    '-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init',
  ]);
  fs.mkdirSync(path.join(root, '.caws', 'specs'), { recursive: true });
  return root;
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function captureRun(opts) {
  const outLines = [];
  const errLines = [];
  const code = runEvidenceRecordCommand({
    now: () => NOW,
    env: { CLAUDE_SESSION_ID: 'test-session' },
    out: (s) => outLines.push(s),
    err: (s) => errLines.push(s),
    ...opts,
  });
  return { code, stdout: outLines.join('\n'), stderr: errLines.join('\n') };
}

describe('runEvidenceRecordCommand — happy path', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('test_recorded: appends successfully, prints seq + event_hash, chains', () => {
    repoRoot = mkTempGitRepo('caws-ev-happy-');
    const r = captureRun({
      cwd: repoRoot,
      kind: 'test',
      specId: 'FOO-1',
      data: {
        command: 'npm test',
        exit_code: 0,
        passed: 10,
        failed: 0,
      },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/recorded test_recorded seq=1 hash=sha256:[0-9a-f]{64}/);
    expect(r.stdout).toMatch(/spec=FOO-1/);
    expect(r.stdout).toMatch(/written to \.caws\/events\.jsonl/);

    // Verify the chain in the events file.
    const cawsDir = path.join(repoRoot, '.caws');
    const events = loadEventsFromStore(cawsDir);
    expect(events.ok).toBe(true);
    expect(events.value.events).toHaveLength(1);
    expect(events.value.events[0].event).toBe('test_recorded');
    expect(events.value.events[0].seq).toBe(1);
    expect(events.value.events[0].prev_hash).toBeNull();
  });

  it('appending a second event chains correctly (prev_hash links)', () => {
    repoRoot = mkTempGitRepo('caws-ev-chain-');
    const r1 = captureRun({
      cwd: repoRoot,
      kind: 'test',
      specId: 'FOO-1',
      data: { command: 'npm test', exit_code: 0 },
    });
    expect(r1.code).toBe(0);
    const r2 = captureRun({
      cwd: repoRoot,
      kind: 'gate',
      specId: 'FOO-1',
      data: {
        gate_id: 'budget_limit',
        mode: 'block',
        result: 'pass',
      },
    });
    expect(r2.code).toBe(0);

    const cawsDir = path.join(repoRoot, '.caws');
    const events = loadEventsFromStore(cawsDir);
    expect(events.ok).toBe(true);
    expect(events.value.events).toHaveLength(2);
    expect(events.value.events[1].seq).toBe(2);
    expect(events.value.events[1].prev_hash).toBe(events.value.events[0].event_hash);
  });
});

describe('runEvidenceRecordCommand — refuses pre-chained fields', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('payload with `seq` is rejected (exit 1) BEFORE any I/O', () => {
    repoRoot = mkTempGitRepo('caws-ev-prechain-seq-');
    const r = captureRun({
      cwd: repoRoot,
      kind: 'test',
      specId: 'FOO-1',
      data: {
        command: 'npm test',
        exit_code: 0,
        seq: 99, // forbidden
      },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/payload must NOT include `seq`/);
    expect(r.stderr).toMatch(/pre_chained_event_refused/);
    // No events file was created.
    expect(fs.existsSync(path.join(repoRoot, '.caws', 'events.jsonl'))).toBe(false);
  });

  it('payload with `prev_hash` is rejected', () => {
    repoRoot = mkTempGitRepo('caws-ev-prechain-prev-');
    const r = captureRun({
      cwd: repoRoot,
      kind: 'test',
      specId: 'FOO-1',
      data: {
        command: 'npm test',
        exit_code: 0,
        prev_hash: 'sha256:abc',
      },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/payload must NOT include `prev_hash`/);
  });

  it('payload with `event_hash` is rejected', () => {
    repoRoot = mkTempGitRepo('caws-ev-prechain-hash-');
    const r = captureRun({
      cwd: repoRoot,
      kind: 'test',
      specId: 'FOO-1',
      data: {
        command: 'npm test',
        exit_code: 0,
        event_hash: 'sha256:abc',
      },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/payload must NOT include `event_hash`/);
  });
});

describe('runEvidenceRecordCommand — validation', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('missing --spec returns exit 1', () => {
    repoRoot = mkTempGitRepo('caws-ev-nospec-');
    const r = captureRun({
      cwd: repoRoot,
      kind: 'test',
      specId: '', // empty
      data: { command: 'npm test', exit_code: 0 },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--spec is required/);
  });

  it('invalid --type returns exit 1', () => {
    repoRoot = mkTempGitRepo('caws-ev-badkind-');
    const r = captureRun({
      cwd: repoRoot,
      kind: 'unknown', // not test|gate|ac
      specId: 'FOO-1',
      data: {},
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/invalid --type/);
  });

  it('kernel validateEventBody rejects malformed payload (exit 1, no events written)', () => {
    repoRoot = mkTempGitRepo('caws-ev-badpayload-');
    const r = captureRun({
      cwd: repoRoot,
      kind: 'test',
      specId: 'FOO-1',
      data: {
        // missing required `command` field for test_recorded schema
        exit_code: 0,
      },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/append rejected/);
    // No events file was created.
    expect(fs.existsSync(path.join(repoRoot, '.caws', 'events.jsonl'))).toBe(false);
  });
});

describe('runEvidenceRecordCommand — composition failure', () => {
  let nonGitDir;
  afterEach(() => rmrf(nonGitDir));

  it('cwd outside a git repo → exit 2', () => {
    nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-ev-nogit-'));
    const r = captureRun({
      cwd: nonGitDir,
      kind: 'test',
      specId: 'FOO-1',
      data: { command: 'npm test', exit_code: 0 },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/failed to resolve repo root/);
  });
});
