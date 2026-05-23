/**
 * Tests for `runEventsVerifyArchiveCommand`.
 *
 * Pinned exit codes:
 *   0 = verification succeeded
 *   1 = any of the 5 distinguishable verification failures (each has
 *       a distinct rule id; tooling can discriminate without parsing
 *       message text)
 *   2 = repo-root composition failure
 *
 * The 5 verify-archive failure modes (each tested by rule id):
 *   - VERIFY_CURRENT_CHAIN_INVALID — loadEvents failed (malformed log)
 *   - VERIFY_NO_ROTATION_EVENT     — chain has no chain_rotated event
 *   - VERIFY_ARCHIVE_MISSING       — archive file named in event is absent
 *   - EVENTS_ARCHIVE_DIGEST_MISMATCH — archive sha256 differs (tamper)
 *   - EVENTS_ARCHIVE_LINE_COUNT_MISMATCH — line count differs
 *
 * Happy path: digest + line count both match → exit 0, stdout shows
 * archive name + sha256 + lines + rotation event seq.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  runEventsRotateCommand,
  runEventsVerifyArchiveCommand,
} = require('../../dist/shell');

const NOW = new Date('2026-05-22T23:15:00.000Z');

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

function captureRun(runFn, opts) {
  const outLines = [];
  const errLines = [];
  const code = runFn({
    now: () => NOW,
    env: { CLAUDE_SESSION_ID: 'test-verify-session' },
    out: (s) => outLines.push(s),
    err: (s) => errLines.push(s),
    ...opts,
  });
  return { code, stdout: outLines.join('\n'), stderr: errLines.join('\n') };
}

function writeV10EventsJsonl(repoRoot, lineCount) {
  const eventsPath = path.join(repoRoot, '.caws', 'events.jsonl');
  const lines = [];
  for (let seq = 1; seq <= lineCount; seq++) {
    lines.push(JSON.stringify({
      seq,
      ts: '2026-04-11T01:00:00.000Z',
      session_id: 'standalone',
      actor: 'cli',
      event: 'validation_completed',
      spec_id: 'X-1',
      data: { passed: true },
      prev_hash: seq === 1 ? '' : `sha256:${String(seq - 1).padStart(64, '0')}`,
      event_hash: `sha256:${String(seq).padStart(64, '0')}`,
    }));
  }
  fs.writeFileSync(eventsPath, lines.join('\n') + '\n');
}

function rotateAndGetArchive(repoRoot) {
  // Helper: rotate via the shell command (so the resulting chain has a
  // chain_rotated event with the actual payload format produced by
  // the writer), then return the archive filename so tests can tamper.
  const r = captureRun(runEventsRotateCommand, {
    cwd: repoRoot,
    reason: 'fixture rotation',
  });
  if (r.code !== 0) {
    throw new Error(`fixture rotateEvents failed: code=${r.code} stderr=${r.stderr}`);
  }
  const cawsDir = path.join(repoRoot, '.caws');
  const archives = fs
    .readdirSync(cawsDir)
    .filter((f) => f.startsWith('events.jsonl.archive-'));
  if (archives.length !== 1) {
    throw new Error(`expected 1 archive, found ${archives.length}: ${archives.join(',')}`);
  }
  return path.join(cawsDir, archives[0]);
}

// ──────────────────────────────────────────────────────────────────────
// Happy path
// ──────────────────────────────────────────────────────────────────────

describe('runEventsVerifyArchiveCommand — happy path', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('exits 0 with sha256 + line count when archive matches committed payload', () => {
    repoRoot = mkTempGitRepo('caws-verify-happy-');
    writeV10EventsJsonl(repoRoot, 3);
    rotateAndGetArchive(repoRoot);

    const r = captureRun(runEventsVerifyArchiveCommand, { cwd: repoRoot });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/verified\. archive matches chain_rotated payload\./);
    expect(r.stdout).toMatch(/archive: events\.jsonl\.archive-/);
    expect(r.stdout).toMatch(/sha256: sha256:[0-9a-f]{64}/);
    expect(r.stdout).toMatch(/lines: 3/);
    expect(r.stdout).toMatch(/rotation event seq: 1/);
    expect(r.stderr).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Failure modes — each pinned by distinct rule id
// ──────────────────────────────────────────────────────────────────────

describe('runEventsVerifyArchiveCommand — VERIFY_CURRENT_CHAIN_INVALID', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('returns 1 with the rule when events.jsonl has an interior malformed line', () => {
    repoRoot = mkTempGitRepo('caws-verify-bad-chain-');
    const eventsPath = path.join(repoRoot, '.caws', 'events.jsonl');
    // Write a valid v10 line, then a malformed interior line — loadEvents
    // is strict and surfaces EVENTS_INTERIOR_MALFORMED_LINE, which the
    // shell wraps in VERIFY_CURRENT_CHAIN_INVALID.
    writeV10EventsJsonl(repoRoot, 1);
    fs.appendFileSync(eventsPath, 'not valid json\n');
    fs.appendFileSync(eventsPath, JSON.stringify({ seq: 2 }) + '\n');

    const r = captureRun(runEventsVerifyArchiveCommand, { cwd: repoRoot });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(
      /store\.events\.verify_archive\.current_chain_invalid/
    );
  });
});

describe('runEventsVerifyArchiveCommand — VERIFY_NO_ROTATION_EVENT', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('returns 1 with the rule when the current chain has no chain_rotated', () => {
    repoRoot = mkTempGitRepo('caws-verify-no-rotation-');
    // A clean v11 chain with one event_recorded but no chain_rotated.
    // Easiest fixture: hand-author one well-formed event line that
    // loadEvents accepts. But validateChainedEvent is strict; the
    // simplest route is to write a fake-but-valid envelope with all
    // chain fields set to sha256:0... — this loads cleanly and is
    // not a chain_rotated event.
    const eventsPath = path.join(repoRoot, '.caws', 'events.jsonl');
    const event = {
      seq: 1,
      ts: '2026-05-22T10:00:00.000Z',
      actor: { kind: 'agent', id: 'a' },
      event: 'session_started',
      data: {},
      prev_hash: null,
      event_hash: `sha256:${'0'.repeat(64)}`,
    };
    fs.writeFileSync(eventsPath, JSON.stringify(event) + '\n');

    const r = captureRun(runEventsVerifyArchiveCommand, { cwd: repoRoot });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(
      /store\.events\.verify_archive\.no_rotation_event/
    );
    expect(r.stderr).toMatch(/1 event\(s\) but no chain_rotated event/);
  });
});

describe('runEventsVerifyArchiveCommand — VERIFY_ARCHIVE_MISSING', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('returns 1 with the rule when the archive file is deleted after rotation', () => {
    repoRoot = mkTempGitRepo('caws-verify-archive-gone-');
    writeV10EventsJsonl(repoRoot, 2);
    const archivePath = rotateAndGetArchive(repoRoot);
    fs.unlinkSync(archivePath);

    const r = captureRun(runEventsVerifyArchiveCommand, { cwd: repoRoot });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(
      /store\.events\.verify_archive\.archive_missing/
    );
    expect(r.stderr).toMatch(/named by chain_rotated event seq=1/);
  });
});

describe('runEventsVerifyArchiveCommand — EVENTS_ARCHIVE_DIGEST_MISMATCH', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('returns 1 with the rule + expected/actual digests on tamper', () => {
    repoRoot = mkTempGitRepo('caws-verify-tamper-');
    writeV10EventsJsonl(repoRoot, 2);
    const archivePath = rotateAndGetArchive(repoRoot);
    // Append one byte to the archive. Now sha256 + line count both
    // change, but the digest check fires first (precedence in the
    // shell). However, if we append a fresh \n then count drifts;
    // tampering mid-line keeps the count the same.
    fs.appendFileSync(archivePath, 'tampered\n');

    const r = captureRun(runEventsVerifyArchiveCommand, { cwd: repoRoot });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/store\.events\.archive\.digest_mismatch/);
    expect(r.stderr).toMatch(/Expected sha256:[0-9a-f]{64}/);
    expect(r.stderr).toMatch(/got sha256:[0-9a-f]{64}/);
  });
});

describe('runEventsVerifyArchiveCommand — EVENTS_ARCHIVE_LINE_COUNT_MISMATCH', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  // The line-count branch is structurally unreachable via simple tamper
  // (any byte change to the archive breaks sha256 first, and the shell
  // checks digest before line count). To isolate the branch we need a
  // synthetic forged fixture: a chain_rotated event whose payload has
  // the CORRECT prior_file_digest for some archive bytes but a WRONG
  // prior_line_count. Then verify-archive's digest check passes and the
  // line-count check fires.
  //
  // The forge uses kernel.prepareAppend(null, body) so the chain_rotated
  // event is structurally valid (validateEventBody passes, event_hash
  // chain field is real) — only the SEMANTIC content of the payload is
  // wrong. This is the smallest harness that exercises the branch without
  // contorting production code or skipping kernel validation.
  it('returns 1 with the rule when archive digest matches but committed prior_line_count is wrong', () => {
    repoRoot = mkTempGitRepo('caws-verify-linecount-');
    const cawsDir = path.join(repoRoot, '.caws');

    // 1. Write a 3-line archive directly under a known name.
    const archiveName = 'events.jsonl.archive-2026-05-22T23-15-00-000Z';
    const archivePath = path.join(cawsDir, archiveName);
    const lines = [];
    for (let seq = 1; seq <= 3; seq++) {
      lines.push(JSON.stringify({
        seq,
        ts: '2026-04-11T01:00:00.000Z',
        actor: 'cli',
        event: 'validation_completed',
        spec_id: 'X-1',
        data: { passed: true },
        prev_hash: seq === 1 ? '' : `sha256:${String(seq - 1).padStart(64, '0')}`,
        event_hash: `sha256:${String(seq).padStart(64, '0')}`,
      }));
    }
    const archiveBytes = Buffer.from(lines.join('\n') + '\n');
    fs.writeFileSync(archivePath, archiveBytes);
    const realDigest =
      'sha256:' + crypto.createHash('sha256').update(archiveBytes).digest('hex');
    const realLineCount = 3;
    const forgedLineCount = realLineCount + 5; // deliberately wrong

    // 2. Forge a chain_rotated body with CORRECT digest but WRONG count.
    //    Pass through kernel prepareAppend so the chain fields are real
    //    (event_hash chains over the wrong-line-count payload) — the
    //    semantic content is the only lie.
    const {
      prepareAppend,
    } = require('@paths.design/caws-kernel');
    const body = {
      event: 'chain_rotated',
      ts: '2026-05-22T23:15:00.000Z',
      actor: { kind: 'agent', id: 'test', session_id: 'sess' },
      data: {
        prior_tail_hash: `sha256:${'3'.repeat(64)}`,
        prior_file_path: archiveName,
        prior_file_digest: realDigest, // correct → digest check passes
        prior_line_count: forgedLineCount, // wrong → line-count check fails
        prior_chain_status: 'parseable_unverified',
        actor_shape_stats: { v10_string_actor: 3, v11_object_actor: 0, unparseable: 0 },
        migration_reason: 'forged for line-count test',
      },
    };
    const prepared = prepareAppend(null, body);
    if (!prepared.ok) {
      throw new Error(
        `forge failed: prepareAppend rejected the body — ${JSON.stringify(prepared.errors)}`
      );
    }
    fs.writeFileSync(
      path.join(cawsDir, 'events.jsonl'),
      JSON.stringify(prepared.value) + '\n'
    );

    // 3. verify-archive should pass the digest check (real digest) and
    //    fail the line-count check (forged count).
    const r = captureRun(runEventsVerifyArchiveCommand, { cwd: repoRoot });
    expect(r.code).toBe(1);
    // Critical: it must be the LINE-COUNT rule, NOT the digest rule.
    expect(r.stderr).toMatch(/store\.events\.archive\.line_count_mismatch/);
    expect(r.stderr).not.toMatch(/store\.events\.archive\.digest_mismatch/);
    // Diagnostic must name expected vs actual.
    expect(r.stderr).toMatch(new RegExp(`Expected ${forgedLineCount}`));
    expect(r.stderr).toMatch(new RegExp(`got ${realLineCount}`));
  });
});

// ──────────────────────────────────────────────────────────────────────
// Composition failures
// ──────────────────────────────────────────────────────────────────────

describe('runEventsVerifyArchiveCommand — composition failures', () => {
  it('exits 2 when repo root cannot be resolved (cwd outside any git repo)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-verify-norepo-'));
    try {
      const r = captureRun(runEventsVerifyArchiveCommand, { cwd: tmpDir });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/failed to resolve repo root/);
    } finally {
      rmrf(tmpDir);
    }
  });
});
