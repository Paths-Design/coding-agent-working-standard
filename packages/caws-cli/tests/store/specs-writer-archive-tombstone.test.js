/**
 * CAWS-ARCHIVE-AS-TOMBSTONE-001 — A1 verification.
 *
 * archiveSpec must:
 *   1. capture blob_sha BEFORE any filesystem mutation;
 *   2. NOT write a body to .caws/specs/.archive/;
 *   3. unlink the active spec yaml;
 *   4. append a spec_archived event in the NEW shape (from_path +
 *      blob_sha, no to_path) — valid against the amended schema;
 *   5. autocommit the deletion via the autocommit landed in
 *      CAWS-SPECS-WRITER-AUTOCOMMIT-001.
 *
 * Post-conditions verified:
 *   - .caws/specs/<id>.yaml is gone from disk;
 *   - .caws/specs/.archive/<id>.yaml was NOT written;
 *   - `git show <blob_sha>` returns the pre-archive body;
 *   - working tree clean after the call (autocommit landed).
 *
 * Also tests the REFUSAL case: archiving a spec that is not tracked
 * at HEAD must fail with a typed diagnostic naming the gap.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createSpec, closeSpec, archiveSpec } = require(
  '../../dist/store/specs-writer'
);
const { initProject } = require('../../dist/store');

// ─── Fixture helpers ────────────────────────────────────────────────────

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

function gitStatus(root) {
  return execFileSync('git', ['-C', root, 'status', '--porcelain', '-uno'], {
    encoding: 'utf8',
  }).trim();
}

function gitShow(root, blobSha) {
  return execFileSync('git', ['-C', root, 'show', blobSha], {
    encoding: 'utf8',
  });
}

function gitLastSubject(root) {
  return execFileSync('git', ['-C', root, 'log', '-1', '--pretty=%s'], {
    encoding: 'utf8',
  }).trim();
}

function readEventsForSpec(cawsDir, specId) {
  const log = path.join(cawsDir, 'events.jsonl');
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((e) => e.spec_id === specId);
}

const ACTOR = { id: 'tombstone-test-actor', kind: 'human' };
const NOW = () => new Date('2026-05-27T22:00:00.000Z');

// ─── A1: archive captures blob_sha + does not write to .archive/ ───────

describe('A1: archive captures blob_sha and removes the active yaml', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('archive succeeds; spec_archived event carries blob_sha; no .archive/ body written', () => {
    fixture = mkCawsGitRepo('a1-tomb-');

    // Seed: create + close (both autocommit via CAWS-SPECS-WRITER-
    // AUTOCOMMIT-001, so the file is tracked at HEAD).
    createSpec(fixture.cawsDir, {
      id: 'FEAT-001', title: 't', mode: 'chore', riskTier: 3,
      now: NOW, actor: ACTOR,
    });
    closeSpec(fixture.cawsDir, {
      id: 'FEAT-001', resolution: 'completed', now: NOW, actor: ACTOR,
    });
    expect(gitStatus(fixture.root)).toBe('');

    // Capture the pre-archive blob_sha via git directly so we can
    // cross-check against the event payload.
    const expectedBlobSha = execFileSync(
      'git',
      ['-C', fixture.root, 'ls-tree', 'HEAD', '.caws/specs/FEAT-001.yaml'],
      { encoding: 'utf8' }
    ).split(/\s+/)[2];
    const expectedBody = fs.readFileSync(
      path.join(fixture.cawsDir, 'specs', 'FEAT-001.yaml'),
      'utf8'
    );

    const result = archiveSpec(fixture.cawsDir, {
      id: 'FEAT-001',
      now: NOW,
      actor: ACTOR,
    });

    // 1. Success.
    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    expect(result.value.id).toBe('FEAT-001');

    // 2. Working tree clean — autocommit landed.
    expect(gitStatus(fixture.root)).toBe('');
    expect(result.value.data.audit_commit.kind).toBe('committed');
    expect(gitLastSubject(fixture.root)).toBe('chore(caws): archive FEAT-001');

    // 3. Active path is gone from disk.
    expect(
      fs.existsSync(path.join(fixture.cawsDir, 'specs', 'FEAT-001.yaml'))
    ).toBe(false);

    // 4. .archive/ directory was NOT created.
    expect(
      fs.existsSync(path.join(fixture.cawsDir, 'specs', '.archive'))
    ).toBe(false);

    // 5. spec_archived event carries the NEW shape (from_path +
    //    blob_sha, no to_path).
    const events = readEventsForSpec(fixture.cawsDir, 'FEAT-001');
    const archivedEvent = events.find((e) => e.event === 'spec_archived');
    expect(archivedEvent).toBeDefined();
    expect(archivedEvent.data.from_path).toBe('.caws/specs/FEAT-001.yaml');
    expect(archivedEvent.data.blob_sha).toBe(expectedBlobSha);
    expect(archivedEvent.data).not.toHaveProperty('to_path');
    expect(archivedEvent.data.source_commit_sha).toMatch(/^[0-9a-f]{40}$/);

    // 6. Recovery via git show works topology-independently.
    expect(gitShow(fixture.root, expectedBlobSha)).toBe(expectedBody);
  });
});

// ─── A1 refusal: untracked spec yaml cannot be archived ────────────────

describe('A1 refusal: archive refuses when spec is not tracked at HEAD', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('returns typed Err naming the gap, no event appended, no mutation', () => {
    fixture = mkCawsGitRepo('a1-untrk-');

    // Seed: create the spec yaml DIRECTLY without going through
    // createSpec (so it's not auto-committed → not tracked at HEAD).
    // We also need lifecycle_state: closed so archive's pre-check
    // doesn't reject for a different reason.
    const specPath = path.join(fixture.cawsDir, 'specs', 'FEAT-002.yaml');
    const body = `id: FEAT-002
title: untracked test
risk_tier: 3
mode: chore
lifecycle_state: closed
resolution: completed
created_at: '2026-05-27T00:00:00.000Z'
updated_at: '2026-05-27T00:00:00.000Z'
blast_radius:
  modules:
    - x
  data_migration: false
operational_rollback_slo: 5m
scope:
  in:
    - x
  out: []
invariants:
  - placeholder
acceptance:
  - id: A1
    given: x
    when: x
    then: x
non_functional: {}
contracts: []
`;
    fs.writeFileSync(specPath, body);
    // The file exists on disk but is not committed; gitStatus will
    // show it as untracked but we passed -uno so it's hidden — but
    // ls-tree HEAD won't find it, which is what archiveSpec checks.

    const result = archiveSpec(fixture.cawsDir, {
      id: 'FEAT-002', now: NOW, actor: ACTOR,
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toMatch(/not tracked at HEAD/);
    expect(result.errors[0].message).toMatch(/blob_sha is the authoritative recovery target/);
    // No event appended.
    const events = readEventsForSpec(fixture.cawsDir, 'FEAT-002');
    expect(events.filter((e) => e.event === 'spec_archived')).toHaveLength(0);
    // The untracked file is still on disk; the refusal did not delete it.
    expect(fs.existsSync(specPath)).toBe(true);
  });
});
