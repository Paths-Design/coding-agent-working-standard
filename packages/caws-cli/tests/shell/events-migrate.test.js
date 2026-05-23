/**
 * Tests for `runEventsMigrateCommand`.
 *
 * Distinct semantics from runEventsRotateCommand:
 *   - Reads + plans BEFORE any mutation.
 *   - Scans .caws/specs/ — MANDATORY. Refuses on SPEC_SCAN_UNAVAILABLE.
 *   - Refuses fully-unparseable with MIGRATE_UNPARSEABLE_REFUSED (not
 *     the generic UNPARSEABLE_INPUT — the diagnostic reflects the
 *     migration-command framing).
 *   - Refuses partial corruption (same condition as the writer; pinned
 *     here at the command layer too).
 *   - Refuses clean v11 (no --allow-clean in migrate semantics).
 *   - Refuses v10 specs unless --allow-partial-upgrade.
 *   - --apply requires --reason.
 *   - --from must be v10 in v11.2.
 *
 * Pinned exit codes:
 *   0 = dry-run successful OR --apply rotation succeeded
 *   1 = any refusal
 *   2 = composition failure (repo-root, session, IO)
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  runEventsMigrateCommand,
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

function captureRun(opts) {
  const outLines = [];
  const errLines = [];
  const code = runEventsMigrateCommand({
    now: () => NOW,
    env: { CLAUDE_SESSION_ID: 'test-migrate-session' },
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

function writeV11SpecYaml(repoRoot, id) {
  fs.writeFileSync(
    path.join(repoRoot, '.caws', 'specs', `${id}.yaml`),
    `id: ${id}
mode: chore
lifecycle_state: active
acceptance:
  - id: A1
    given: x
    when: y
    then: z
`
  );
}

function writeV10SpecYaml(repoRoot, id) {
  fs.writeFileSync(
    path.join(repoRoot, '.caws', 'specs', `${id}.yaml`),
    `id: ${id}
type: feature
status: active
acceptance_criteria:
  - AC-1: works
`
  );
}

function readArchives(repoRoot) {
  return fs
    .readdirSync(path.join(repoRoot, '.caws'))
    .filter((f) => f.startsWith('events.jsonl.archive-'));
}

// ──────────────────────────────────────────────────────────────────────
// --from validation
// ──────────────────────────────────────────────────────────────────────

describe('runEventsMigrateCommand — --from validation', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('refuses --from values other than v10', () => {
    repoRoot = mkTempGitRepo('caws-migrate-badfrom-');
    writeV10Events(repoRoot, 1);
    const r = captureRun({ cwd: repoRoot, from: 'v9' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/only --from v10 is supported/);
    expect(readArchives(repoRoot)).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Dry-run happy path
// ──────────────────────────────────────────────────────────────────────

describe('runEventsMigrateCommand — dry-run happy path (no FS changes)', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('exits 0, prints rotate plan, leaves events.jsonl untouched and creates no archive', () => {
    repoRoot = mkTempGitRepo('caws-migrate-dryrun-');
    writeV10Events(repoRoot, 3);
    writeV11SpecYaml(repoRoot, 'FOO-1'); // v11 spec, no half-upgrade trigger

    const beforeEvents = fs.readFileSync(
      path.join(repoRoot, '.caws', 'events.jsonl')
    );

    const r = captureRun({ cwd: repoRoot, from: 'v10' });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\[dry-run\] plan: rotate/);
    expect(r.stdout).toMatch(/detection: all_v10, 3 lines/);
    expect(r.stdout).toMatch(/v10_string_actor=3/);
    expect(r.stdout).toMatch(/proposed archive: events\.jsonl\.archive-/);
    expect(r.stdout).toMatch(/No filesystem changes/);

    // events.jsonl is byte-identical pre/post.
    const afterEvents = fs.readFileSync(
      path.join(repoRoot, '.caws', 'events.jsonl')
    );
    expect(afterEvents.equals(beforeEvents)).toBe(true);
    expect(readArchives(repoRoot)).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Apply happy path — dry-run/apply archive-name agreement under frozen clock
// ──────────────────────────────────────────────────────────────────────

describe('runEventsMigrateCommand — --apply with dry-run/apply name agreement', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('apply produces an archive whose name byte-equals the dry-run proposal under frozen clock', () => {
    repoRoot = mkTempGitRepo('caws-migrate-apply-');
    writeV10Events(repoRoot, 2);
    writeV11SpecYaml(repoRoot, 'BAR-1');

    // First run: dry-run with frozen clock → capture proposed archive name.
    const dry = captureRun({ cwd: repoRoot, from: 'v10' });
    expect(dry.code).toBe(0);
    const proposedMatch = dry.stdout.match(/proposed archive: (events\.jsonl\.archive-\S+)/);
    expect(proposedMatch).not.toBeNull();
    const proposedName = proposedMatch[1];

    // Second run: apply with same frozen clock → archive name MUST match.
    const apply = captureRun({
      cwd: repoRoot,
      from: 'v10',
      apply: true,
      reason: 'apply for name-agreement test',
    });
    expect(apply.code).toBe(0);
    expect(apply.stdout).toMatch(/applied\. chain_rotated genesis written\./);

    // Concrete artifact check: the archive on disk is named what dry-run proposed.
    const archives = readArchives(repoRoot);
    expect(archives).toEqual([proposedName]);

    // The apply output also names that archive.
    expect(apply.stdout).toMatch(new RegExp(`archive=${proposedName.replace(/\./g, '\\.')}`));
  });

  it('--apply without --reason refuses', () => {
    repoRoot = mkTempGitRepo('caws-migrate-noreason-');
    writeV10Events(repoRoot, 1);
    const r = captureRun({ cwd: repoRoot, from: 'v10', apply: true });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--reason "<text>" is required/);
    expect(readArchives(repoRoot)).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Spec scan unavailable
// ──────────────────────────────────────────────────────────────────────

describe('runEventsMigrateCommand — SPEC_SCAN_UNAVAILABLE', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('refuses with SPEC_SCAN_UNAVAILABLE when .caws/specs is missing', () => {
    repoRoot = mkTempGitRepo('caws-migrate-nospecs-');
    writeV10Events(repoRoot, 1);
    // Remove the specs directory entirely.
    fs.rmSync(path.join(repoRoot, '.caws', 'specs'), { recursive: true });

    const r = captureRun({ cwd: repoRoot, from: 'v10' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/store\.events\.migration\.spec_scan_unavailable/);
    // Refusal must explicitly mention "Refusing rather than silently
    // bypassing" — the diagnostic narrowRepair frames the safety
    // posture for operators.
    // Wording must point at the safety posture, not the technical cause —
    // the operator needs to understand WHY this refuses rather than how.
    expect(r.stderr).toMatch(/refusing rather than silently bypassing/i);
    expect(readArchives(repoRoot)).toEqual([]);
  });

  it('does NOT degrade to "no v10 specs found" when scan unavailable', () => {
    // The whole point: a sparse-checkout exclusion of .caws/specs/ must
    // not let migration through pretending no v10 specs exist.
    repoRoot = mkTempGitRepo('caws-migrate-nodegrade-');
    writeV10Events(repoRoot, 1);
    fs.rmSync(path.join(repoRoot, '.caws', 'specs'), { recursive: true });

    const r = captureRun({
      cwd: repoRoot,
      from: 'v10',
      apply: true,
      reason: 'should never apply',
    });
    expect(r.code).toBe(1);
    // Did NOT proceed to rotation.
    expect(r.stdout).not.toMatch(/applied\. chain_rotated genesis written/);
    expect(readArchives(repoRoot)).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// MIGRATE_UNPARSEABLE_REFUSED — fully-unparseable
// ──────────────────────────────────────────────────────────────────────

describe('runEventsMigrateCommand — MIGRATE_UNPARSEABLE_REFUSED', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('refuses fully-unparseable with the migrate-specific rule (not generic UNPARSEABLE_INPUT)', () => {
    repoRoot = mkTempGitRepo('caws-migrate-unparseable-');
    fs.writeFileSync(
      path.join(repoRoot, '.caws', 'events.jsonl'),
      'not json\nnope\n'
    );

    const r = captureRun({ cwd: repoRoot, from: 'v10' });
    expect(r.code).toBe(1);
    // Migrate-specific rule (proves the shell re-routes the diagnostic
    // from the planner's generic UNPARSEABLE_INPUT to MIGRATE_UNPARSEABLE_REFUSED).
    expect(r.stderr).toMatch(/store\.events\.migration\.unparseable_refused/);
    expect(r.stderr).toMatch(/Migration cannot claim it found a v10 chain/);
    // Operator framing: points at 'caws events rotate' for evidence quarantine.
    expect(r.stderr).toMatch(/'caws events rotate --reason/);
    expect(readArchives(repoRoot)).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Partial corruption — refuses
// ──────────────────────────────────────────────────────────────────────

describe('runEventsMigrateCommand — partial-corruption refusal', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('refuses when log has parseable + unparseable mixed', () => {
    repoRoot = mkTempGitRepo('caws-migrate-partial-');
    writeV10Events(repoRoot, 2);
    fs.appendFileSync(
      path.join(repoRoot, '.caws', 'events.jsonl'),
      'this is not json\n'
    );
    writeV11SpecYaml(repoRoot, 'FOO-1');

    const r = captureRun({ cwd: repoRoot, from: 'v10' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(
      /store\.events\.migration\.partial_corruption_refused/
    );
    expect(readArchives(repoRoot)).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Clean v11 chain under migrate — no --allow-clean in migrate semantics
// ──────────────────────────────────────────────────────────────────────

describe('runEventsMigrateCommand — clean v11 under migrate refuses', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('refuses clean v11 chain (no --allow-clean equivalent in migrate)', () => {
    // Use rotateEvents indirectly by appending real v11 events via
    // the append path. For this test fixture, write a minimal valid
    // v11 line by hand.
    repoRoot = mkTempGitRepo('caws-migrate-cleanv11-');
    const event = {
      seq: 1,
      ts: '2026-05-22T10:00:00.000Z',
      actor: { kind: 'agent', id: 'a' },
      event: 'session_started',
      data: {},
      prev_hash: null,
      event_hash: `sha256:${'0'.repeat(64)}`,
    };
    fs.writeFileSync(
      path.join(repoRoot, '.caws', 'events.jsonl'),
      JSON.stringify(event) + '\n'
    );
    writeV11SpecYaml(repoRoot, 'BAR-1');

    const r = captureRun({ cwd: repoRoot, from: 'v10' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(
      /store\.events\.rotate\.clean_chain_requires_allow_clean/
    );
    expect(readArchives(repoRoot)).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// v10 specs detected — half-upgrade refusal
// ──────────────────────────────────────────────────────────────────────

describe('runEventsMigrateCommand — half-upgrade refusal', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('refuses when v10 specs present and --allow-partial-upgrade omitted', () => {
    repoRoot = mkTempGitRepo('caws-migrate-v10specs-');
    writeV10Events(repoRoot, 1);
    writeV10SpecYaml(repoRoot, 'OLD-1');
    writeV11SpecYaml(repoRoot, 'NEW-1');

    const r = captureRun({ cwd: repoRoot, from: 'v10' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/store\.events\.migration\.v10_spec_detected/);
    expect(r.stderr).toMatch(/OLD-1\.yaml/);
    expect(r.stderr).toMatch(/--allow-partial-upgrade/);
    expect(readArchives(repoRoot)).toEqual([]);
  });

  it('admits when --allow-partial-upgrade is passed', () => {
    repoRoot = mkTempGitRepo('caws-migrate-v10specs-ok-');
    writeV10Events(repoRoot, 1);
    writeV10SpecYaml(repoRoot, 'OLD-1');

    const r = captureRun({
      cwd: repoRoot,
      from: 'v10',
      apply: true,
      reason: 'partial upgrade intentional',
      allowPartialUpgrade: true,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/applied\. chain_rotated genesis written/);
    expect(readArchives(repoRoot)).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// events.jsonl missing
// ──────────────────────────────────────────────────────────────────────

describe('runEventsMigrateCommand — events.jsonl missing', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('refuses with EMPTY_INPUT framing when events.jsonl does not exist', () => {
    repoRoot = mkTempGitRepo('caws-migrate-noevents-');
    writeV11SpecYaml(repoRoot, 'X-1');

    const r = captureRun({ cwd: repoRoot, from: 'v10' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/events\.jsonl does not exist/);
    expect(r.stderr).toMatch(/store\.events\.migration\.empty_input/);
  });
});
