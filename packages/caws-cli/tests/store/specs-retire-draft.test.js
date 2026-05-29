/**
 * CAWS-SPECS-RETIRE-DRAFT-001 — store-level verification of retireDraftSpec.
 *
 * retireDraftSpec must:
 *   1. retire ONLY drafts (refuse active/closed with typed diagnostics);
 *   2. capture blob_sha BEFORE mutation; refuse if not tracked at HEAD;
 *   3. append a spec_retired event (from_path + blob_sha, optional reason);
 *   4. unlink the draft yaml; autocommit the deletion (path-scoped);
 *   5. leave the body recoverable via `git show <blob_sha>`.
 *
 * Fixture repos only — never the live repo.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createSpec, closeSpec, retireDraftSpec, recoverArchivedSpec } = require(
  '../../dist/store/specs-writer'
);
const { initProject } = require('../../dist/store');

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

const ACTOR = { id: 'retire-test-actor', kind: 'human' };
const NOW = () => new Date('2026-05-29T04:30:00.000Z');

/** Seed a committed DRAFT spec tracked at HEAD. */
function seedDraft(fixture, id) {
  createSpec(fixture.cawsDir, {
    id,
    title: id,
    mode: 'chore',
    riskTier: 3,
    initialState: 'draft',
    now: NOW,
    actor: ACTOR,
  });
  execFileSync('git', ['-C', fixture.root, 'add', '.caws/']);
  execFileSync('git', ['-C', fixture.root, 'commit', '--quiet', '-m', `add draft ${id}`]);
}

// ─── A1: retire a draft → tombstone + recoverable ──────────────────────
describe('retireDraftSpec — A1: retires a draft via tombstone', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('deletes the draft, appends spec_retired with blob_sha, body recoverable', () => {
    fixture = mkCawsGitRepo('retire-a1-');
    seedDraft(fixture, 'DRAFT-001');
    const specPath = path.join(fixture.cawsDir, 'specs/DRAFT-001.yaml');
    const bodyBefore = fs.readFileSync(specPath, 'utf8');

    const result = retireDraftSpec(fixture.cawsDir, {
      id: 'DRAFT-001',
      reason: 'never activated',
      now: NOW,
      actor: ACTOR,
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    // Draft file gone.
    expect(fs.existsSync(specPath)).toBe(false);
    // spec_retired event with the tombstone shape.
    const events = readEventsForSpec(fixture.cawsDir, 'DRAFT-001');
    const retired = events.filter((e) => e.event === 'spec_retired');
    expect(retired).toHaveLength(1);
    expect(retired[0].data.from_path).toBe('.caws/specs/DRAFT-001.yaml');
    expect(retired[0].data.blob_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(retired[0].data.reason).toBe('never activated');
    // Chain: event_hash present; prev_hash links to a prior event.
    expect(retired[0].event_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(typeof retired[0].prev_hash).toBe('string');
    // Recovery: git show <blob_sha> returns the pre-retire body.
    // recoverArchivedSpec returns { source, blob_sha, from_path }.
    const recovered = recoverArchivedSpec(fixture.cawsDir, 'DRAFT-001', fixture.root);
    expect(recovered.ok).toBe(true);
    expect(recovered.value.source).toBe(bodyBefore);
    // The retirement commit (HEAD) records the spec deletion; the
    // path-scoped autocommit committed ONLY the spec path. events.jsonl is
    // gitignored in real repos (the autocommit never stages it); the test
    // fixture tracks it, so it shows as modified-but-uncommitted here — that
    // is correct (not swept into the retirement commit). Assert the spec
    // deletion is committed and the spec path is not left dirty.
    const head = execFileSync(
      'git', ['-C', fixture.root, 'show', '--name-status', '--pretty=format:', 'HEAD'],
      { encoding: 'utf8' }
    );
    expect(head).toMatch(/^D\s+\.caws\/specs\/DRAFT-001\.yaml/m);
    const specDirty = execFileSync(
      'git', ['-C', fixture.root, 'status', '--porcelain', '--', '.caws/specs/DRAFT-001.yaml'],
      { encoding: 'utf8' }
    ).trim();
    expect(specDirty).toBe('');
  });
});

// ─── A2: refuse non-draft states ───────────────────────────────────────
describe('retireDraftSpec — A2: refuses active/closed', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('refuses an ACTIVE spec, pointing at close; no mutation', () => {
    fixture = mkCawsGitRepo('retire-a2-active-');
    createSpec(fixture.cawsDir, {
      id: 'ACT-001', title: 'ACT-001', mode: 'chore', riskTier: 3,
      initialState: 'active', now: NOW, actor: ACTOR,
    });
    execFileSync('git', ['-C', fixture.root, 'add', '.caws/']);
    execFileSync('git', ['-C', fixture.root, 'commit', '--quiet', '-m', 'add active']);
    const specPath = path.join(fixture.cawsDir, 'specs/ACT-001.yaml');

    const result = retireDraftSpec(fixture.cawsDir, { id: 'ACT-001', now: NOW, actor: ACTOR });

    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toMatch(/lifecycle_state "active"/);
    expect(result.errors[0].message).toMatch(/caws specs close/);
    expect(fs.existsSync(specPath)).toBe(true); // not deleted
    const retired = readEventsForSpec(fixture.cawsDir, 'ACT-001').filter((e) => e.event === 'spec_retired');
    expect(retired).toHaveLength(0); // no event
  });

  it('refuses a CLOSED spec, pointing at archive', () => {
    fixture = mkCawsGitRepo('retire-a2-closed-');
    createSpec(fixture.cawsDir, {
      id: 'CLO-001', title: 'CLO-001', mode: 'chore', riskTier: 3,
      initialState: 'active', now: NOW, actor: ACTOR,
    });
    closeSpec(fixture.cawsDir, { id: 'CLO-001', resolution: 'completed', now: NOW, actor: ACTOR });
    execFileSync('git', ['-C', fixture.root, 'add', '.caws/']);
    execFileSync('git', ['-C', fixture.root, 'commit', '--quiet', '-m', 'add closed']);

    const result = retireDraftSpec(fixture.cawsDir, { id: 'CLO-001', now: NOW, actor: ACTOR });

    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toMatch(/lifecycle_state "closed"/);
    expect(result.errors[0].message).toMatch(/caws specs archive/);
  });
});

// ─── A3: refuse a draft not tracked at HEAD ────────────────────────────
describe('retireDraftSpec — A3: refuses an untracked draft', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('refuses (blob_sha unavailable) without deleting an unrecoverable body', () => {
    fixture = mkCawsGitRepo('retire-a3-');
    // Write a draft yaml DIRECTLY (bypassing createSpec, which autocommits)
    // so the file is genuinely untracked at HEAD → gitBlobShaAtHead null.
    const specPath = path.join(fixture.cawsDir, 'specs/UNC-001.yaml');
    fs.writeFileSync(
      specPath,
      [
        'id: UNC-001',
        "title: 'UNC-001'",
        'risk_tier: 3',
        'mode: chore',
        'lifecycle_state: draft',
        'blast_radius:',
        '  modules:',
        '    - packages/x',
        '  data_migration: false',
        'operational_rollback_slo: 5m',
        'scope:',
        '  in:',
        '    - .caws/specs/UNC-001.yaml',
        '  out: []',
        'invariants:',
        '  - x',
        'acceptance:',
        '  - id: A1',
        '    given: g',
        '    when: w',
        '    then: t',
        'non_functional: {}',
        'contracts: []',
        '',
      ].join('\n')
    );
    // Deliberately NOT git-added — untracked at HEAD.

    const result = retireDraftSpec(fixture.cawsDir, { id: 'UNC-001', now: NOW, actor: ACTOR });

    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toMatch(/not tracked at HEAD/);
    expect(fs.existsSync(specPath)).toBe(true); // not deleted
  });
});

// ─── A6: path-scoped commit does not sweep a sibling-staged file ───────
describe('retireDraftSpec — A6: no sibling sweep', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('the retirement commit contains only the retired draft path', () => {
    fixture = mkCawsGitRepo('retire-a6-');
    seedDraft(fixture, 'DRAFT-006');
    // Sibling pre-stages an unrelated file into the shared index.
    fs.writeFileSync(path.join(fixture.root, 'sibling.txt'), 'sibling wip\n');
    execFileSync('git', ['-C', fixture.root, 'add', '--', 'sibling.txt']);

    const result = retireDraftSpec(fixture.cawsDir, { id: 'DRAFT-006', now: NOW, actor: ACTOR });
    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');

    // The retirement commit (HEAD) must contain ONLY the retired spec path.
    const committed = execFileSync(
      'git', ['-C', fixture.root, 'show', '--name-only', '--pretty=format:', 'HEAD'],
      { encoding: 'utf8' }
    ).split('\n').map((s) => s.trim()).filter(Boolean);
    expect(committed).toEqual(['.caws/specs/DRAFT-006.yaml']);
    // sibling.txt remains staged-uncommitted.
    const staged = execFileSync(
      'git', ['-C', fixture.root, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }
    ).trim();
    expect(staged).toBe('sibling.txt');
  });
});
