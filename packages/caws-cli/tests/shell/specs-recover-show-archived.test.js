/**
 * CAWS-ARCHIVE-AS-TOMBSTONE-001 — A2, A3, A4, A5 verification.
 *
 * Exercises the recover + show --archived surface:
 *   A2: caws specs recover <id> resolves via event log + git show
 *   A3: caws specs show <id> (no flags) on an ACTIVE spec → happy path
 *   A4: caws specs show <id> (no flags) on an ARCHIVED spec → typed
 *       diagnostic, exit 1, no silent fallback to .archive/
 *   A5: caws specs show <id> --archived on an ARCHIVED spec →
 *       recovered body via event log
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  runSpecsCreateCommand,
  runSpecsCloseCommand,
  runSpecsArchiveCommand,
  runSpecsShowCommand,
  runSpecsRecoverCommand,
} = require('../../dist/shell');
const { initProject } = require('../../dist/store');

// ─── Fixture helpers (mirrors specs-writer-archive-tombstone) ──────────

function mkCawsGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test User']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  const result = initProject(root);
  if (!result.ok) throw new Error('initProject failed in fixture');
  execFileSync('git', ['-C', root, 'add', '.caws/']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'chore: bootstrap caws']);
  return { root, cawsDir: path.join(root, '.caws') };
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function capture(fn, opts) {
  const out = [];
  const err = [];
  const code = fn({
    ...opts,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

/**
 * Seed a closed-then-archived spec FEAT-001 in a fresh repo. Returns
 * { fixture, preArchiveBody, blobSha } so tests can assert against
 * the recovered body byte-for-byte.
 */
function seedArchived(prefix) {
  const fixture = mkCawsGitRepo(prefix);
  capture(runSpecsCreateCommand, {
    cwd: fixture.root,
    id: 'FEAT-001',
    title: 'recover-show-archived fixture',
    mode: 'chore',
    riskTier: 3,
  });
  capture(runSpecsCloseCommand, {
    cwd: fixture.root,
    id: 'FEAT-001',
    resolution: 'completed',
  });
  // Capture the post-close body (the bytes we'll later recover).
  const activePath = path.join(fixture.cawsDir, 'specs', 'FEAT-001.yaml');
  const preArchiveBody = fs.readFileSync(activePath, 'utf8');
  const blobSha = execFileSync(
    'git',
    ['-C', fixture.root, 'ls-tree', 'HEAD', '.caws/specs/FEAT-001.yaml'],
    { encoding: 'utf8' }
  ).split(/\s+/)[2];

  capture(runSpecsArchiveCommand, {
    cwd: fixture.root,
    id: 'FEAT-001',
  });

  return { fixture, preArchiveBody, blobSha };
}

// ─── A3: show on an active spec (happy path) ───────────────────────────

describe('A3: caws specs show on an active spec', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('prints the spec yaml body', () => {
    fixture = mkCawsGitRepo('a3-');
    capture(runSpecsCreateCommand, {
      cwd: fixture.root,
      id: 'FEAT-001',
      title: 'a3 fixture',
      mode: 'chore',
      riskTier: 3,
    });

    const r = capture(runSpecsShowCommand, {
      cwd: fixture.root,
      id: 'FEAT-001',
    });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('id: FEAT-001');
    expect(r.stdout).toContain("title: 'a3 fixture'");
    expect(r.stdout).toContain('lifecycle_state: active');
  });
});

// ─── A4: show on an archived spec without --archived (typed refusal) ───

describe('A4: caws specs show on an archived spec without --archived', () => {
  let seeded;
  afterEach(() => seeded && rmrf(seeded.fixture.root));

  it('returns typed diagnostic naming --archived and recover; exit 1', () => {
    seeded = seedArchived('a4-');

    const r = capture(runSpecsShowCommand, {
      cwd: seeded.fixture.root,
      id: 'FEAT-001',
    });

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not in active specs/);
    expect(r.stderr).toMatch(/--archived/);
    expect(r.stderr).toMatch(/caws specs recover/);
    // Does NOT silently fall back to .archive/ walk.
    expect(r.stdout).not.toContain('id: FEAT-001');
  });

  it('distinguishes "archived" from "never existed"', () => {
    seeded = seedArchived('a4b-');

    const r = capture(runSpecsShowCommand, {
      cwd: seeded.fixture.root,
      id: 'NEVER-EXISTED-001',
    });

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not found in \.caws\/specs\//);
    // Specifically NOT the "archived; use --archived" diagnostic.
    expect(r.stderr).not.toMatch(/--archived/);
  });
});

// ─── A5: show --archived on an archived spec ──────────────────────────

describe('A5: caws specs show --archived on an archived spec', () => {
  let seeded;
  afterEach(() => seeded && rmrf(seeded.fixture.root));

  it('returns the recovered body byte-for-byte via event log + git show', () => {
    seeded = seedArchived('a5-');

    const r = capture(runSpecsShowCommand, {
      cwd: seeded.fixture.root,
      id: 'FEAT-001',
      archived: true,
    });

    expect(r.code).toBe(0);
    // Recovered body matches the pre-archive bytes.
    expect(r.stdout).toBe(seeded.preArchiveBody);
  });
});

// ─── A2: caws specs recover (dedicated command) ────────────────────────

describe('A2: caws specs recover <id>', () => {
  let seeded;
  afterEach(() => seeded && rmrf(seeded.fixture.root));

  it('prints the recovered body to stdout when --out is not set', () => {
    seeded = seedArchived('a2-');

    const r = capture(runSpecsRecoverCommand, {
      cwd: seeded.fixture.root,
      id: 'FEAT-001',
    });

    expect(r.code).toBe(0);
    expect(r.stdout).toBe(seeded.preArchiveBody);
  });

  it('writes to --out <path> and prints a confirmation line', () => {
    seeded = seedArchived('a2b-');
    const outPath = path.join(seeded.fixture.root, 'recovered.yaml');

    const r = capture(runSpecsRecoverCommand, {
      cwd: seeded.fixture.root,
      id: 'FEAT-001',
      outPath,
    });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('recovered FEAT-001 to');
    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.readFileSync(outPath, 'utf8')).toBe(seeded.preArchiveBody);
  });

  it('returns typed Err when spec was never archived', () => {
    const fixture = mkCawsGitRepo('a2c-');
    seeded = { fixture };

    const r = capture(runSpecsRecoverCommand, {
      cwd: fixture.root,
      id: 'NEVER-ARCHIVED-001',
    });

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/was never archived/);
  });

  it('does NOT mutate .caws/specs/ on recovery', () => {
    seeded = seedArchived('a2d-');
    const specsDirBefore = fs.readdirSync(
      path.join(seeded.fixture.cawsDir, 'specs')
    ).sort();

    const r = capture(runSpecsRecoverCommand, {
      cwd: seeded.fixture.root,
      id: 'FEAT-001',
    });

    expect(r.code).toBe(0);
    const specsDirAfter = fs.readdirSync(
      path.join(seeded.fixture.cawsDir, 'specs')
    ).sort();
    expect(specsDirAfter).toEqual(specsDirBefore);
    // FEAT-001.yaml is NOT re-materialized in active path.
    expect(specsDirAfter).not.toContain('FEAT-001.yaml');
  });
});

// ─── Legacy event compatibility (oneOf branch 1) ──────────────────────

describe('Legacy event compatibility: recover handles legacy {from_path, to_path} events', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('falls back to git log --follow when event has no blob_sha', () => {
    fixture = mkCawsGitRepo('legacy-');
    // Create + close + commit a spec so its body lives in git history.
    capture(runSpecsCreateCommand, {
      cwd: fixture.root,
      id: 'LEGACY-001',
      title: 'legacy event fixture',
      mode: 'chore',
      riskTier: 3,
    });
    capture(runSpecsCloseCommand, {
      cwd: fixture.root,
      id: 'LEGACY-001',
      resolution: 'completed',
    });
    const activePath = path.join(fixture.cawsDir, 'specs', 'LEGACY-001.yaml');
    const preArchiveBody = fs.readFileSync(activePath, 'utf8');

    // Manually unlink the active file (simulating a legacy archive
    // that happened before the tombstone slice — the unlink ran but
    // we want to fake a legacy event payload).
    fs.unlinkSync(activePath);
    execFileSync('git', ['-C', fixture.root, 'add', '.caws/specs/LEGACY-001.yaml']);
    execFileSync('git', ['-C', fixture.root, 'commit', '--quiet', '-m', 'manual archive']);

    // Hand-author a legacy-shape spec_archived event in events.jsonl.
    // (We can't use archiveSpec because the new writer produces
    // tombstone-shape events.)
    const eventsPath = path.join(fixture.cawsDir, 'events.jsonl');
    const existing = fs.readFileSync(eventsPath, 'utf8');
    // Find the prev_hash by re-reading the last line.
    const prevLine = existing.trim().split('\n').pop();
    const prev = JSON.parse(prevLine);
    const legacyEvent = {
      seq: prev.seq + 1,
      event: 'spec_archived',
      ts: '2026-05-27T22:00:00.000Z',
      actor: { kind: 'agent', id: 'legacy-tester', session_id: 'legacy-tester', platform: 'test' },
      spec_id: 'LEGACY-001',
      data: {
        from_path: '.caws/specs/LEGACY-001.yaml',
        to_path: '.caws/specs/.archive/LEGACY-001.yaml',
      },
      prev_hash: prev.event_hash,
      // Hash is irrelevant for the recover-side test (recover doesn't
      // verify chain integrity; doctor does); use a placeholder.
      event_hash: 'sha256:legacy-placeholder',
    };
    fs.writeFileSync(eventsPath, existing + JSON.stringify(legacyEvent) + '\n');

    const r = capture(runSpecsRecoverCommand, {
      cwd: fixture.root,
      id: 'LEGACY-001',
    });

    expect(r.code).toBe(0);
    expect(r.stdout).toBe(preArchiveBody);
  });
});
