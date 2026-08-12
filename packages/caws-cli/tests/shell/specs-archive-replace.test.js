'use strict';

/**
 * `caws specs archive --replace` — resolving the stale-archived-body shadow
 * (CAWS-DEFECT-ARCHIVE-STALE-BODY-SHADOW-01, ledger N11).
 *
 * The defect: two individually defensible behaviors compose into an unfixable
 * state. `archive` refuses to overwrite an existing archived body (to prevent
 * data loss), and `recover` prefers the on-disk `.archive/<id>.yaml` body over
 * git history. So when a spec is archived, later returns to canonical, and is
 * closed again with a DIFFERENT outcome, the FIRST snapshot wins forever — and
 * the governed single-spec read path returns a body asserting the opposite of
 * what actually happened. The refusal that exists to prevent data loss is
 * exactly what preserves the wrong record, and no flag could resolve it.
 *
 * Reproduced live in a consumer repo on 2026-08-12: a batch
 * `caws specs archive --status closed --apply` reported
 * "archived 2; skipped 0; failed 2", both failures being this collision.
 *
 * These drive the real compiled writer against real git repos: the property
 * under test is on-disk archive state plus the events chain.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { archiveSpec } = require('../../dist/store/specs-writer');
const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, git, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
const ACTOR = { kind: 'agent', id: 'archive-replace-agent', session_id: 'sess-archive-replace' };

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  return root;
}

/** A closed spec body. `updatedAt` and `notes` let a test build two divergent
 *  snapshots of the SAME id — the shape that produces the shadow. */
function closedSpecBody(id, { updatedAt, notes, lifecycle = 'closed' }) {
  return `id: ${id}
title: 'archive replace fixture'
risk_tier: 3
mode: chore
lifecycle_state: ${lifecycle}
resolution: completed
closure_notes: '${notes}'
created_at: '2026-07-01T00:00:00.000Z'
updated_at: '${updatedAt}'
blast_radius:
  modules:
    - tests
  data_migration: false
operational_rollback_slo: 5m
scope:
  in:
    - tests
  out: []
invariants:
  - 'fixture spec'
acceptance:
  - id: A1
    given: 'fixture given'
    when: 'fixture when'
    then: 'fixture then'
non_functional: {}
contracts: []
`;
}

function writeCanonical(cawsDir, id, opts) {
  fs.writeFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), closedSpecBody(id, opts));
}

function writeArchived(cawsDir, id, opts) {
  const dir = path.join(cawsDir, 'specs', '.archive');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.yaml`),
    closedSpecBody(id, { ...opts, lifecycle: 'archived' })
  );
}

function commitAll(root, message) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', message]);
}

function archiveDirEntries(cawsDir) {
  return fs.readdirSync(path.join(cawsDir, 'specs', '.archive')).sort();
}

function readEvents(cawsDir) {
  const p = path.join(cawsDir, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

/** Build the exact divergence the defect describes: an OLD archived body and a
 *  NEWER canonical body for the same id, with contradictory closure notes. */
function seedShadow(id) {
  const root = mkRepo();
  const cawsDir = path.join(root, '.caws');
  writeArchived(cawsDir, id, {
    updatedAt: '2026-07-28T02:44:42.651Z',
    notes: 'REGISTRY RECONCILIATION ONLY. Spec is NOT acceptance-complete.',
  });
  writeCanonical(cawsDir, id, {
    updatedAt: '2026-07-29T18:00:00.000Z',
    notes: 'Auto-closed by caws worktree merge at a031a099d.',
  });
  commitAll(root, `fixture: shadow for ${id}`);
  return { root, cawsDir };
}

describe('A1: the collision refusal names the remedy and shows which body is stale', () => {
  test('refuses without --replace, naming --replace and both updated_at values', () => {
    const { root, cawsDir } = seedShadow('ARCREP-001');

    const result = spawnSync(process.execPath, [CLI, 'specs', 'archive', 'ARCREP-001'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CAWS_QUIET: '1', CLAUDE_CODE_SESSION_ID: 'arcrep-a1' },
    });

    expect(result.status).not.toBe(0);
    const combined = `${result.stdout}${result.stderr}`;
    // The refusal itself is preserved — --replace widens what archive can do,
    // it does not make overwriting the default.
    expect(combined).toContain('already has an archived body');
    // Before this slice the refusal named NO remedy, which made a recoverable
    // state read as permanent and pushed the operator to hand-edit .archive/.
    expect(combined).toContain('--replace');
    // Both timestamps, so the operator can tell which body is stale without a
    // second investigation.
    expect(combined).toContain('2026-07-28T02:44:42.651Z');
    expect(combined).toContain('2026-07-29T18:00:00.000Z');
    expect(combined).toContain('OLDER');

    // Nothing moved: the canonical body is still there, no superseded file.
    expect(fs.existsSync(path.join(cawsDir, 'specs', 'ARCREP-001.yaml'))).toBe(true);
    expect(archiveDirEntries(cawsDir)).toEqual(['ARCREP-001.yaml']);
  });

  test('when the archived body is NEWER, the refusal says so rather than crying stale', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeArchived(cawsDir, 'ARCREP-002', {
      updatedAt: '2026-07-30T00:00:00.000Z',
      notes: 'the newer archived body',
    });
    writeCanonical(cawsDir, 'ARCREP-002', {
      updatedAt: '2026-07-01T00:00:00.000Z',
      notes: 'the older canonical body',
    });
    commitAll(root, 'fixture: inverted ages');

    const result = spawnSync(process.execPath, [CLI, 'specs', 'archive', 'ARCREP-002'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CAWS_QUIET: '1', CLAUDE_CODE_SESSION_ID: 'arcrep-a1b' },
    });

    expect(result.status).not.toBe(0);
    const combined = `${result.stdout}${result.stderr}`;
    // Asserting "very likely stale" unconditionally would train the reader to
    // ignore the judgement; here replacing would DESTROY the newer record.
    expect(combined).toContain('NEWER');
    expect(combined).not.toContain('very likely stale');
  });

  test('an archived body whose YAML no longer validates still reports its updated_at', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    const dir = path.join(cawsDir, 'specs', '.archive');
    fs.mkdirSync(dir, { recursive: true });
    // A years-old body can easily fail today's schema. Reading updated_at via
    // the schema parser would report "unknown" in exactly the cases the
    // comparison exists to serve, so it is read by regex.
    fs.writeFileSync(
      path.join(dir, 'ARCREP-003.yaml'),
      `id: ARCREP-003\nlifecycle_state: archived\nupdated_at: '2026-01-01T00:00:00.000Z'\nlegacy_field_that_no_longer_exists: true\n`
    );
    writeCanonical(cawsDir, 'ARCREP-003', {
      updatedAt: '2026-07-29T18:00:00.000Z',
      notes: 'current',
    });
    commitAll(root, 'fixture: unparseable archived body');

    const result = spawnSync(process.execPath, [CLI, 'specs', 'archive', 'ARCREP-003'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CAWS_QUIET: '1', CLAUDE_CODE_SESSION_ID: 'arcrep-a1c' },
    });

    expect(result.status).not.toBe(0);
    const combined = `${result.stdout}${result.stderr}`;
    expect(combined).toContain('2026-01-01T00:00:00.000Z');
    expect(combined).not.toContain('archived body updated_at: unknown');
  });
});

describe('A2: --replace preserves the prior body instead of discarding it', () => {
  test('the existing body is copied byte-for-byte to a superseded snapshot', () => {
    const { root, cawsDir } = seedShadow('ARCREP-010');
    const priorBytes = fs.readFileSync(
      path.join(cawsDir, 'specs', '.archive', 'ARCREP-010.yaml'),
      'utf8'
    );

    const result = archiveSpec(cawsDir, {
      id: 'ARCREP-010',
      actor: ACTOR,
      replace: true,
      now: () => new Date('2026-08-12T09:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');

    const entries = archiveDirEntries(cawsDir);
    expect(entries).toHaveLength(2);
    const superseded = entries.find((e) => e.includes('superseded'));
    expect(superseded).toBeDefined();
    // Colons stripped: legal on POSIX, not on Windows or in many archive tools.
    expect(superseded).not.toContain(':');
    expect(superseded).toBe('ARCREP-010.superseded-2026-08-12T09-00-00Z.yaml');

    // Byte-for-byte. A "preserved" copy that reformats is not a record of what
    // the prior body said.
    expect(fs.readFileSync(path.join(cawsDir, 'specs', '.archive', superseded), 'utf8')).toBe(
      priorBytes
    );

    // The canonical archive path now holds the NEW body.
    const nowArchived = fs.readFileSync(
      path.join(cawsDir, 'specs', '.archive', 'ARCREP-010.yaml'),
      'utf8'
    );
    expect(nowArchived).toContain('Auto-closed by caws worktree merge');
    expect(nowArchived).toContain('lifecycle_state: archived');
    // And the active path is gone — --replace does not skip the archive itself.
    expect(fs.existsSync(path.join(cawsDir, 'specs', 'ARCREP-010.yaml'))).toBe(false);
  });

  test('the spec_archived event records superseded_path', () => {
    const { cawsDir } = seedShadow('ARCREP-011');

    const result = archiveSpec(cawsDir, {
      id: 'ARCREP-011',
      actor: ACTOR,
      replace: true,
      now: () => new Date('2026-08-12T09:05:00.000Z'),
    });
    expect(result.ok && result.value.kind === 'success').toBe(true);

    const archived = readEvents(cawsDir).filter(
      (e) => e.event === 'spec_archived' && e.spec_id === 'ARCREP-011'
    );
    expect(archived).toHaveLength(1);
    // Without this field a --replace is indistinguishable from a first archive,
    // and the demotion of a body that WAS the governed answer goes unrecorded.
    expect(archived[0].data.superseded_path).toContain('ARCREP-011.superseded-');
    expect(archived[0].data.to_path).toContain('.archive/ARCREP-011.yaml');
  });

  test('two replaces in the same second both survive — neither snapshot is lost', () => {
    const { cawsDir } = seedShadow('ARCREP-012');
    const fixedNow = () => new Date('2026-08-12T09:10:00.000Z');

    expect(
      archiveSpec(cawsDir, { id: 'ARCREP-012', actor: ACTOR, replace: true, now: fixedNow }).ok
    ).toBe(true);

    // Return the id to canonical and replace again at the same timestamp.
    writeCanonical(cawsDir, 'ARCREP-012', {
      updatedAt: '2026-07-30T00:00:00.000Z',
      notes: 'third generation',
    });
    expect(
      archiveSpec(cawsDir, { id: 'ARCREP-012', actor: ACTOR, replace: true, now: fixedNow }).ok
    ).toBe(true);

    const superseded = archiveDirEntries(cawsDir).filter((e) => e.includes('superseded'));
    // A same-second collision that overwrote would silently destroy exactly the
    // record --replace exists to keep.
    expect(superseded).toHaveLength(2);
    expect(new Set(superseded).size).toBe(2);
  });

  test('the archive transaction is atomic — a rejected new body leaves the prior one alone', () => {
    const { cawsDir } = seedShadow('ARCREP-013');
    // Corrupt the canonical body so the planned-archive-bytes validation fails
    // AFTER the collision branch has already computed the superseded copy.
    fs.writeFileSync(
      path.join(cawsDir, 'specs', 'ARCREP-013.yaml'),
      `id: ARCREP-013\nlifecycle_state: closed\nrisk_tier: 99\n`
    );

    const result = archiveSpec(cawsDir, { id: 'ARCREP-013', actor: ACTOR, replace: true });

    expect(result.ok).toBe(false);
    // Nothing partial: no superseded file, and the prior archived body intact.
    expect(archiveDirEntries(cawsDir)).toEqual(['ARCREP-013.yaml']);
    expect(
      fs.readFileSync(path.join(cawsDir, 'specs', '.archive', 'ARCREP-013.yaml'), 'utf8')
    ).toContain('REGISTRY RECONCILIATION ONLY');
  });
});

describe('A3: recover returns the new body after a replace', () => {
  test('the governed read path stops returning the stale snapshot', () => {
    const { root, cawsDir } = seedShadow('ARCREP-020');

    const before = spawnSync(process.execPath, [CLI, 'specs', 'recover', 'ARCREP-020'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CAWS_QUIET: '1' },
    });
    // Pre-condition of the defect: recover prefers the on-disk archived body.
    // (No spec_archived event exists yet for this fixture, so recover refuses —
    // either way it must NOT be serving the new body.)
    expect(before.stdout).not.toContain('Auto-closed by caws worktree merge');

    const replaced = spawnSync(
      process.execPath,
      [CLI, 'specs', 'archive', 'ARCREP-020', '--replace'],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, CAWS_QUIET: '1', CLAUDE_CODE_SESSION_ID: 'arcrep-a3' },
      }
    );
    expect(replaced.status).toBe(0);

    const after = spawnSync(process.execPath, [CLI, 'specs', 'recover', 'ARCREP-020'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CAWS_QUIET: '1' },
    });
    expect(after.status).toBe(0);
    // HEADLINE: the read path now returns the body that reflects what actually
    // happened, not the reconciliation snapshot that contradicts it.
    expect(after.stdout).toContain('Auto-closed by caws worktree merge');
    expect(after.stdout).not.toContain('REGISTRY RECONCILIATION ONLY');
  });
});

describe('A4: superseded snapshots are named on the single-spec read paths', () => {
  test('recover advises that a demoted body exists and where it is', () => {
    const { root } = seedShadow('ARCREP-030');
    const env = { ...process.env, CAWS_QUIET: '1', CLAUDE_CODE_SESSION_ID: 'arcrep-a4' };
    expect(
      spawnSync(process.execPath, [CLI, 'specs', 'archive', 'ARCREP-030', '--replace'], {
        cwd: root,
        encoding: 'utf8',
        env,
      }).status
    ).toBe(0);

    const recovered = spawnSync(process.execPath, [CLI, 'specs', 'recover', 'ARCREP-030'], {
      cwd: root,
      encoding: 'utf8',
      env,
    });

    expect(recovered.status).toBe(0);
    // The body itself stays on stdout unpolluted — recover output is piped into
    // editors and files.
    expect(recovered.stdout).not.toContain('caws advisory');
    expect(recovered.stderr).toContain('superseded archived');
    expect(recovered.stderr).toContain('ARCREP-030.superseded-');
  });

  test('show --archived carries the same advisory', () => {
    const { root } = seedShadow('ARCREP-031');
    const env = { ...process.env, CAWS_QUIET: '1', CLAUDE_CODE_SESSION_ID: 'arcrep-a4b' };
    expect(
      spawnSync(process.execPath, [CLI, 'specs', 'archive', 'ARCREP-031', '--replace'], {
        cwd: root,
        encoding: 'utf8',
        env,
      }).status
    ).toBe(0);

    const shown = spawnSync(
      process.execPath,
      [CLI, 'specs', 'show', 'ARCREP-031', '--archived'],
      { cwd: root, encoding: 'utf8', env }
    );
    expect(shown.status).toBe(0);
    expect(shown.stderr).toContain('ARCREP-031.superseded-');
  });

  test('an id with no superseded snapshot produces NO advisory', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeCanonical(cawsDir, 'ARCREP-032', {
      updatedAt: '2026-07-29T18:00:00.000Z',
      notes: 'only ever archived once',
    });
    commitAll(root, 'fixture: single archive');
    const env = { ...process.env, CAWS_QUIET: '1', CLAUDE_CODE_SESSION_ID: 'arcrep-a4c' };
    expect(
      spawnSync(process.execPath, [CLI, 'specs', 'archive', 'ARCREP-032'], {
        cwd: root,
        encoding: 'utf8',
        env,
      }).status
    ).toBe(0);

    const recovered = spawnSync(process.execPath, [CLI, 'specs', 'recover', 'ARCREP-032'], {
      cwd: root,
      encoding: 'utf8',
      env,
    });
    expect(recovered.status).toBe(0);
    // A constant advisory is one readers learn to skip.
    expect(recovered.stderr).not.toContain('superseded');
  });
});

describe('A5: --replace on a clean id behaves exactly like a plain archive', () => {
  test('no superseded file is created and the outcome is identical', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeCanonical(cawsDir, 'ARCREP-040', {
      updatedAt: '2026-07-29T18:00:00.000Z',
      notes: 'never archived before',
    });
    commitAll(root, 'fixture: clean archive');

    const result = archiveSpec(cawsDir, { id: 'ARCREP-040', actor: ACTOR, replace: true });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    // The flag widens what archive CAN do without changing what it normally
    // does; a stray superseded file here would be pure litter.
    expect(archiveDirEntries(cawsDir)).toEqual(['ARCREP-040.yaml']);

    const archived = readEvents(cawsDir).filter(
      (e) => e.event === 'spec_archived' && e.spec_id === 'ARCREP-040'
    );
    expect(archived).toHaveLength(1);
    expect(archived[0].data).not.toHaveProperty('superseded_path');
  });

  test('spawned CLI: --replace reaches the writer (opt-forwarding proof)', () => {
    const { root, cawsDir } = seedShadow('ARCREP-041');

    const result = spawnSync(
      process.execPath,
      [CLI, 'specs', 'archive', 'ARCREP-041', '--replace'],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, CAWS_QUIET: '1', CLAUDE_CODE_SESSION_ID: 'arcrep-a5b' },
      }
    );

    // A dropped mapping in register.ts would leave this refusing with the
    // collision message while the flag parsed cleanly — the handler tests above
    // pass `replace: true` directly and would stay green.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('archived ARCREP-041');
    expect(archiveDirEntries(cawsDir).some((e) => e.includes('superseded'))).toBe(true);
    // The operator is told where the demoted body went, loudly.
    expect(result.stderr).toContain('was preserved at');
  });
});
