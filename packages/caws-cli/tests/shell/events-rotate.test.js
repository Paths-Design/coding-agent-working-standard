/**
 * Tests for `runEventsRotateCommand`.
 *
 * Lower-level maintenance rotation. Distinct semantics from
 * runEventsMigrateCommand:
 *   - Does NOT scan .caws/specs/ (no half-upgrade refusal).
 *   - Admits fully-unparseable logs under prior_chain_status:
 *     'unparseable' (evidence-quarantine semantic).
 *   - Refuses on partial corruption (defense-in-depth via rotateEvents
 *     writer; same condition as the planner).
 *   - Refuses clean v11 chains unless --allow-clean is passed.
 *
 * Pinned exit codes:
 *   0 = rotation succeeded
 *   1 = rotateEvents refused (empty, partial corruption, clean-chain
 *       without --allow-clean) OR --reason missing
 *   2 = composition failure
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  runEventsRotateCommand,
} = require('../../dist/shell');
const { appendEvent } = require('../../dist/store');

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

function captureRun(opts) {
  const outLines = [];
  const errLines = [];
  const code = runEventsRotateCommand({
    now: () => NOW,
    env: { CLAUDE_SESSION_ID: 'test-rotate-session' },
    out: (s) => outLines.push(s),
    err: (s) => errLines.push(s),
    ...opts,
  });
  return { code, stdout: outLines.join('\n'), stderr: errLines.join('\n') };
}

function writeV10Events(repoRoot, count) {
  const lines = [];
  for (let seq = 1; seq <= count; seq++) {
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
  fs.writeFileSync(
    path.join(repoRoot, '.caws', 'events.jsonl'),
    lines.join('\n') + '\n'
  );
}

function appendV11Event(repoRoot, eventType, specId) {
  // Use the real appendEvent so the chain is properly chained.
  return appendEvent(path.join(repoRoot, '.caws'), {
    event: eventType,
    ts: '2026-05-22T10:00:00.000Z',
    actor: { kind: 'agent', id: 'test', session_id: 'sess' },
    ...(specId ? { spec_id: specId } : {}),
    data: eventType === 'spec_created'
      ? { title: 't', risk_tier: 3, mode: 'chore', lifecycle_state: 'draft' }
      : {},
  });
}

function readArchives(repoRoot) {
  return fs
    .readdirSync(path.join(repoRoot, '.caws'))
    .filter((f) => f.startsWith('events.jsonl.archive-'));
}

// ──────────────────────────────────────────────────────────────────────
// Required arguments + composition
// ──────────────────────────────────────────────────────────────────────

describe('runEventsRotateCommand — argument validation', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('exits 1 when --reason is missing', () => {
    repoRoot = mkTempGitRepo('caws-rotate-noreason-');
    writeV10Events(repoRoot, 1);
    const r = captureRun({ cwd: repoRoot, reason: '' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--reason "<text>" is required/);
    expect(readArchives(repoRoot)).toEqual([]);
  });

  it('exits 1 when --reason is the empty string', () => {
    repoRoot = mkTempGitRepo('caws-rotate-emptyreason-');
    writeV10Events(repoRoot, 1);
    const r = captureRun({ cwd: repoRoot, reason: '' });
    expect(r.code).toBe(1);
    expect(readArchives(repoRoot)).toEqual([]);
  });

  it('exits 2 when cwd is outside any git repo', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-rotate-norepo-'));
    try {
      const r = captureRun({ cwd: tmpDir, reason: 'try' });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/failed to resolve repo root/);
    } finally {
      rmrf(tmpDir);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Happy path — v10 chain
// ──────────────────────────────────────────────────────────────────────

describe('runEventsRotateCommand — v10 happy path', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('rotates a 3-line v10 chain, prints seq + hash + archive + status', () => {
    repoRoot = mkTempGitRepo('caws-rotate-v10-');
    writeV10Events(repoRoot, 3);
    const r = captureRun({ cwd: repoRoot, reason: 'v10 to v11' });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/rotated\. chain_rotated genesis written\./);
    expect(r.stdout).toMatch(/seq=1/);
    expect(r.stdout).toMatch(/event_hash=sha256:[0-9a-f]{64}/);
    expect(r.stdout).toMatch(/archive=events\.jsonl\.archive-/);
    expect(r.stdout).toMatch(/prior_chain_status=parseable_unverified/);
    expect(r.stdout).toMatch(/prior_line_count=3/);
    expect(readArchives(repoRoot)).toHaveLength(1);
  });

  it('does NOT scan .caws/specs (rotate semantic — not migration)', () => {
    // Setup: remove .caws/specs entirely. rotate should NOT refuse on
    // SPEC_SCAN_UNAVAILABLE because rotate does not scan specs.
    repoRoot = mkTempGitRepo('caws-rotate-nospecs-');
    writeV10Events(repoRoot, 1);
    fs.rmSync(path.join(repoRoot, '.caws', 'specs'), { recursive: true });
    const r = captureRun({ cwd: repoRoot, reason: 'no specs needed' });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/spec_scan_unavailable/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Fully-unparseable — admitted under evidence quarantine semantic
// ──────────────────────────────────────────────────────────────────────

describe('runEventsRotateCommand — fully-unparseable evidence quarantine', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('admits a fully-unparseable log with prior_chain_status: unparseable', () => {
    // The key semantic distinction from runEventsMigrateCommand: this
    // command admits fully-unparseable as evidence quarantine. The
    // honest label is 'unparseable'.
    repoRoot = mkTempGitRepo('caws-rotate-unparseable-');
    fs.writeFileSync(
      path.join(repoRoot, '.caws', 'events.jsonl'),
      'not json\nstill not\nnope\n'
    );
    const r = captureRun({
      cwd: repoRoot,
      reason: 'evidence quarantine of corrupt log',
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/prior_chain_status=unparseable/);
    expect(readArchives(repoRoot)).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Partial corruption — refuses (defense in depth)
// ──────────────────────────────────────────────────────────────────────

describe('runEventsRotateCommand — partial-corruption refusal', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('refuses when log has parseable AND unparseable lines', () => {
    repoRoot = mkTempGitRepo('caws-rotate-partial-');
    const eventsPath = path.join(repoRoot, '.caws', 'events.jsonl');
    writeV10Events(repoRoot, 2);
    fs.appendFileSync(eventsPath, 'this is not json\n');
    const r = captureRun({ cwd: repoRoot, reason: 'try' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/store\.events\.rotate\.partial_corruption/);
    expect(readArchives(repoRoot)).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Empty / missing events.jsonl
// ──────────────────────────────────────────────────────────────────────

describe('runEventsRotateCommand — nothing to rotate', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('refuses when events.jsonl is missing (NOTHING_TO_ROTATE)', () => {
    repoRoot = mkTempGitRepo('caws-rotate-noevents-');
    const r = captureRun({ cwd: repoRoot, reason: 'try' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/store\.events\.rotate\.nothing_to_rotate/);
  });

  it('refuses when events.jsonl is empty', () => {
    repoRoot = mkTempGitRepo('caws-rotate-empty-');
    fs.writeFileSync(path.join(repoRoot, '.caws', 'events.jsonl'), '');
    const r = captureRun({ cwd: repoRoot, reason: 'try' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/store\.events\.rotate\.nothing_to_rotate/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Clean v11 chain — friction flag
// ──────────────────────────────────────────────────────────────────────

describe('runEventsRotateCommand — clean v11 friction flag', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('refuses a clean v11 chain without --allow-clean', () => {
    repoRoot = mkTempGitRepo('caws-rotate-cleanv11-');
    // Use appendEvent to build a real v11 chain so the actor shape is
    // structurally correct. Two spec_created events suffice — both
    // have the same simple payload schema; the test cares about actor
    // shape (structured object) not event-type variety.
    const a = appendV11Event(repoRoot, 'spec_created', 'A-1');
    expect(a.ok).toBe(true);
    const b = appendV11Event(repoRoot, 'spec_created', 'A-2');
    expect(b.ok).toBe(true);

    const r = captureRun({ cwd: repoRoot, reason: 'casual rotate' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(
      /store\.events\.rotate\.clean_chain_requires_allow_clean/
    );
    expect(readArchives(repoRoot)).toEqual([]);
  });

  it('admits a clean v11 chain when --allow-clean is passed', () => {
    repoRoot = mkTempGitRepo('caws-rotate-cleanv11-ok-');
    const a = appendV11Event(repoRoot, 'spec_created', 'A-1');
    expect(a.ok).toBe(true);

    const r = captureRun({
      cwd: repoRoot,
      reason: 'operator chose clean rotation',
      allowClean: true,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/rotated\. chain_rotated genesis written\./);
    expect(readArchives(repoRoot)).toHaveLength(1);
  });
});
