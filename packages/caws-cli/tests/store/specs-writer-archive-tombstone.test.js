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

// ─── HARDENING A1: same-id non-`spec_archived` event does NOT tombstone ─

describe('HARDENING A1: same-id non-spec_archived event does not tombstone', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('createSpec succeeds when events.jsonl carries spec_created/spec_closed for the id but NO spec_archived', () => {
    // CAWS-SPECS-ARCHIVE-COLLISION-MUTATION-HARDENING-001 A1.
    //
    // Kills surviving mutants on isArchivedViaTombstone equality check
    // (line 128 in source / 124-128 in dist):
    //   - body.event === 'spec_archived'  →  body.event !== 'spec_archived'
    //   - body.event === 'spec_archived'  →  true
    //   - logical && weakening to ||
    //
    // The test seeds events.jsonl with real (chain-valid) spec_created
    // and spec_closed events for an id, then physically deletes the
    // active spec yaml WITHOUT going through archive. There is no
    // spec_archived event for the id. isArchivedViaTombstone MUST
    // return false; createSpec MUST succeed.
    //
    // A mutant that flips the event-type equality to !== or to true
    // will see the spec_created/spec_closed events as "archived" and
    // refuse the create.
    fixture = mkCawsGitRepo('hard-a1-');

    // Seed: create + close to generate non-archived events for the id.
    createSpec(fixture.cawsDir, {
      id: 'NON-ARCH-EVENTS-01', title: 't', mode: 'chore', riskTier: 3,
      now: NOW, actor: ACTOR,
    });
    closeSpec(fixture.cawsDir, {
      id: 'NON-ARCH-EVENTS-01', resolution: 'completed', now: NOW, actor: ACTOR,
    });

    // Pre-conditions: spec_created and spec_closed exist; no spec_archived.
    const seededEvents = readEventsForSpec(fixture.cawsDir, 'NON-ARCH-EVENTS-01');
    expect(seededEvents.find((e) => e.event === 'spec_created')).toBeDefined();
    expect(seededEvents.find((e) => e.event === 'spec_closed')).toBeDefined();
    expect(seededEvents.find((e) => e.event === 'spec_archived')).toBeUndefined();

    // Physically remove the active file so the create attempt is not
    // blocked by an active-file collision (a different refusal path).
    // Bypassing archive ensures NO spec_archived event is appended.
    const activePath = path.join(fixture.cawsDir, 'specs', 'NON-ARCH-EVENTS-01.yaml');
    fs.unlinkSync(activePath);
    execFileSync('git', ['-C', fixture.root, 'add', '-u']);
    execFileSync('git', ['-C', fixture.root, 'commit', '--quiet', '-m', 'rm spec without archive']);

    // Now attempt to recreate the same id. With the existing events
    // being only spec_created/spec_closed, isArchivedViaTombstone must
    // return false and createSpec must succeed.
    const result = createSpec(fixture.cawsDir, {
      id: 'NON-ARCH-EVENTS-01', title: 'recreated', mode: 'chore', riskTier: 3,
      now: NOW, actor: ACTOR,
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    expect(
      fs.existsSync(path.join(fixture.cawsDir, 'specs', 'NON-ARCH-EVENTS-01.yaml'))
    ).toBe(true);
  });
});

// ─── HARDENING A2: spec_archived for a DIFFERENT id does NOT tombstone ─

describe('HARDENING A2: spec_archived for a different id does not tombstone the requested id', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('createSpec succeeds for id Y when spec_archived event exists only for id X', () => {
    // CAWS-SPECS-ARCHIVE-COLLISION-MUTATION-HARDENING-001 A2.
    //
    // Kills surviving mutants on isArchivedViaTombstone spec_id check
    // (line 128 in source — the && conjunction):
    //   - body.spec_id === id  →  body.spec_id !== id
    //   - body.spec_id === id  →  true
    //   - && weakening to ||
    //
    // Lifecycle-archive id X (producing a real spec_archived event for
    // X), then attempt to create id Y. isArchivedViaTombstone must
    // return false for Y; createSpec must succeed.
    fixture = mkCawsGitRepo('hard-a2-');

    // Lifecycle-archive id X.
    createSpec(fixture.cawsDir, {
      id: 'OTHER-ID-001', title: 't', mode: 'chore', riskTier: 3,
      now: NOW, actor: ACTOR,
    });
    closeSpec(fixture.cawsDir, {
      id: 'OTHER-ID-001', resolution: 'completed', now: NOW, actor: ACTOR,
    });
    const archiveResult = archiveSpec(fixture.cawsDir, {
      id: 'OTHER-ID-001', now: NOW, actor: ACTOR,
    });
    expect(archiveResult.ok).toBe(true);

    // Pre-conditions: spec_archived for X exists; no events for Y.
    const xEvents = readEventsForSpec(fixture.cawsDir, 'OTHER-ID-001');
    const yEvents = readEventsForSpec(fixture.cawsDir, 'REQUESTED-ID-001');
    expect(xEvents.find((e) => e.event === 'spec_archived')).toBeDefined();
    expect(yEvents).toHaveLength(0);

    // Attempt to create Y. The spec_id check inside
    // isArchivedViaTombstone must distinguish X from Y.
    const result = createSpec(fixture.cawsDir, {
      id: 'REQUESTED-ID-001', title: 'unrelated id', mode: 'chore', riskTier: 3,
      now: NOW, actor: ACTOR,
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    expect(
      fs.existsSync(path.join(fixture.cawsDir, 'specs', 'REQUESTED-ID-001.yaml'))
    ).toBe(true);
  });
});

// ─── HARDENING A3: createSpec refusal diagnostic shape at the store layer ─

describe('HARDENING A3: createSpec tombstone refusal diagnostic shape', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('Result.errors[0] has message containing "caws specs recover <id>", subject=id, data.reason="archived_tombstone"', () => {
    // CAWS-SPECS-ARCHIVE-COLLISION-MUTATION-HARDENING-001 A3.
    //
    // Kills surviving mutants on the createSpec tombstone diagnostic
    // construction (line 304 in dist / 403-410 in source):
    //   - the message StringLiteral can be emptied to ""
    //   - the ObjectLiteral { subject, data } can be replaced with {}
    //   - the ObjectLiteral { reason: 'archived_tombstone' } can be {}
    //
    // The previous test only asserted shell stderr substrings. Asserting
    // at the store-Result layer is strictly stronger: shell rendering
    // could mask a structural defect (subject dropped, data.reason
    // missing) while the user still sees the right human text.
    fixture = mkCawsGitRepo('hard-a3-');

    // Lifecycle-archive to produce a tombstone.
    createSpec(fixture.cawsDir, {
      id: 'DIAG-SHAPE-01', title: 't', mode: 'chore', riskTier: 3,
      now: NOW, actor: ACTOR,
    });
    closeSpec(fixture.cawsDir, {
      id: 'DIAG-SHAPE-01', resolution: 'completed', now: NOW, actor: ACTOR,
    });
    archiveSpec(fixture.cawsDir, {
      id: 'DIAG-SHAPE-01', now: NOW, actor: ACTOR,
    });

    // Attempt re-create against the tombstoned id and inspect the Err.
    const result = createSpec(fixture.cawsDir, {
      id: 'DIAG-SHAPE-01', title: 'recreate', mode: 'chore', riskTier: 3,
      now: NOW, actor: ACTOR,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors.length).toBeGreaterThanOrEqual(1);

    const diag = result.errors[0];
    // Message: contains literal substring with the actual id substituted.
    expect(diag.message).toContain('caws specs recover DIAG-SHAPE-01');
    // Subject: the spec id, not undefined / not something else.
    expect(diag.subject).toBe('DIAG-SHAPE-01');
    // data.reason: the tombstone discriminator the diagnostic promised.
    expect(diag.data).toBeDefined();
    expect(diag.data.reason).toBe('archived_tombstone');
    // No v10 remediation language sneaks back in.
    expect(diag.message).not.toMatch(/--force/);
    expect(diag.message).not.toMatch(/--override/);
  });
});

// ─── HARDENING A1b: loadEvents-Err early-return — corrupted log fail-open ─

describe('HARDENING A1b: corrupted events.jsonl makes isArchivedViaTombstone fail-open', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('createSpec succeeds for an unrelated id when events.jsonl is corrupted (loadEvents Err)', () => {
    // CAWS-SPECS-ARCHIVE-COLLISION-MUTATION-HARDENING-001 A1 (extended).
    //
    // Kills surviving mutants on the loadEvents Err early-return in
    // isArchivedViaTombstone (specs-writer.ts lines 162-163):
    //   - if (!result.ok) return false;  →  if (false) return false;
    //     (mutant removes the guard; loop iterates undefined → throws)
    //   - if (!result.ok) return false;  →  if (!result.ok) return true;
    //     (mutant would claim every id is tombstoned on log corruption)
    //
    // The contract under test is: when the event log cannot be loaded
    // (corrupt JSON, missing hash chain, etc.), isArchivedViaTombstone
    // returns false (fail-open), so createSpec proceeds normally for
    // any id. A `return true` mutant would refuse every create; a
    // removed guard would crash.
    //
    // Note: this test documents the current fail-open behavior. Whether
    // fail-open is the right policy for a corrupted event log is a
    // separate question — out of scope for mutation hardening, but
    // worth filing if the maintainer disagrees with the policy.
    fixture = mkCawsGitRepo('hard-a1b-');

    // Seed a real tombstone for some id so the event log is non-empty
    // before corruption. Without this, the file might be empty and the
    // mutant difference would be unobservable.
    createSpec(fixture.cawsDir, {
      id: 'SEED-001', title: 't', mode: 'chore', riskTier: 3,
      now: NOW, actor: ACTOR,
    });
    closeSpec(fixture.cawsDir, {
      id: 'SEED-001', resolution: 'completed', now: NOW, actor: ACTOR,
    });
    const archiveOk = archiveSpec(fixture.cawsDir, {
      id: 'SEED-001', now: NOW, actor: ACTOR,
    });
    expect(archiveOk.ok).toBe(true);

    // Corrupt events.jsonl: replace a chain hash to break
    // validateChainedEvent. This forces loadEvents to return Err.
    const eventsPath = path.join(fixture.cawsDir, 'events.jsonl');
    const original = fs.readFileSync(eventsPath, 'utf8');
    // Append a syntactically-invalid line in the interior. loadEvents
    // tolerates a trailing partial line, but an interior malformed
    // line is Err.
    const corrupted = original.replace(/\n$/, '') + '\nNOT_JSON\n{"valid":"line"}\n';
    fs.writeFileSync(eventsPath, corrupted);

    // Attempt to create an UNRELATED id. If loadEvents fails:
    //   - With current code: isArchivedViaTombstone returns false → createSpec
    //     proceeds past the tombstone check. The downstream event append may
    //     fail-and-rollback on the corrupted log, surfacing as
    //     partial_failure_recovered — that's a different layer and still
    //     proves the tombstone check did not block.
    //   - With mutant `return true`: would refuse the unrelated id → ok=false
    //     with tombstone diagnostic → test fails on ok=false.
    //   - With mutant removing the guard (`if (false)`): loop iterates
    //     undefined → throws TypeError → createSpec throws → test fails.
    const result = createSpec(fixture.cawsDir, {
      id: 'UNRELATED-001', title: 'after corruption', mode: 'chore', riskTier: 3,
      now: NOW, actor: ACTOR,
    });

    // The tombstone check passed (didn't refuse with a tombstone Err).
    // Accept either clean success or partial_failure_recovered (which
    // means the corrupted log broke a later step, not the tombstone
    // check). Reject Err — which is what the killing mutants produce.
    expect(result.ok).toBe(true);
    expect(['success', 'partial_failure_recovered']).toContain(result.value.kind);
    // Defensive: even if the outcome was partial_failure_recovered, it
    // was NOT a tombstone refusal. Verify no diagnostic with the
    // tombstone reason crept in via the partial-failure outcome.
    if (result.value.kind === 'partial_failure_recovered') {
      const tombstoneDiag = (result.value.diagnostics || []).find(
        (d) => d && d.data && d.data.reason === 'archived_tombstone'
      );
      expect(tombstoneDiag).toBeUndefined();
    }
  });
});

// ─── HARDENING A4-store: closeSpec store-level diagnostic on tombstone ──

describe('HARDENING A4-store: closeSpec returns structured diagnostic on tombstoned id', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('Result.errors[0] has message containing "archived" + id, subject=id, on tombstone-only close attempt', () => {
    // CAWS-SPECS-ARCHIVE-COLLISION-MUTATION-HARDENING-001 A4
    // (store-level extension).
    //
    // The shell-level A4(a)/A4(b) tests assert stderr substrings, which
    // misses store-layer diagnostic-shape mutants on closeSpec's
    // archived-refusal (specs-writer.ts line 498-505 / dist 374-376):
    //   - The message StringLiteral can be replaced with ``.
    //   - The { subject: input.id } ObjectLiteral can be replaced with {}.
    //
    // Lifecycle-archive an id, then attempt closeSpec at the store
    // layer and inspect Result.errors[0] directly.
    fixture = mkCawsGitRepo('hard-a4-store-');

    // Lifecycle-archive id.
    createSpec(fixture.cawsDir, {
      id: 'CLOSE-DIAG-001', title: 't', mode: 'chore', riskTier: 3,
      now: NOW, actor: ACTOR,
    });
    closeSpec(fixture.cawsDir, {
      id: 'CLOSE-DIAG-001', resolution: 'completed', now: NOW, actor: ACTOR,
    });
    const arch = archiveSpec(fixture.cawsDir, {
      id: 'CLOSE-DIAG-001', now: NOW, actor: ACTOR,
    });
    expect(arch.ok).toBe(true);

    // Attempt close on the tombstoned id.
    const result = closeSpec(fixture.cawsDir, {
      id: 'CLOSE-DIAG-001', resolution: 'completed', now: NOW, actor: ACTOR,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors.length).toBeGreaterThanOrEqual(1);

    const diag = result.errors[0];
    // Message: identifies the spec id and the archived state — not
    // empty, not generic.
    expect(diag.message).toContain('CLOSE-DIAG-001');
    expect(diag.message).toMatch(/archived/i);
    // Subject: the spec id, not undefined.
    expect(diag.subject).toBe('CLOSE-DIAG-001');
  });
});

// ─── HARDENING A4-not-found: closeSpec on a never-existed id ───────────

describe('HARDENING A4-not-found: closeSpec on an unknown id emits the not-found diagnostic', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('Result.errors[0] message contains "not found at" + the resolved targetPath, subject=id', () => {
    // CAWS-SPECS-ARCHIVE-COLLISION-MUTATION-HARDENING-001 A4
    // (not-found path).
    //
    // closeSpec's "not found" branch fires when the active spec yaml
    // does NOT exist AND neither archive disjunct fires (no legacy
    // .archive file, no tombstone event). Kills surviving mutants on:
    //   - 373:13 (dist) ConditionalExpression → true (the disjunction
    //     mutant; with `true`, we'd hit the archived-refusal even on
    //     unknown ids and never reach this branch)
    //   - 376:117 StringLiteral → `` (the "not found at" message
    //     emptied)
    //   - 376:167 ObjectLiteral → {} (the subject stripped)
    //
    // The test creates a fresh fixture, never creates the spec, and
    // calls closeSpec on the id. Both archive disjuncts evaluate
    // false; the not-found branch must fire with a structured
    // diagnostic.
    fixture = mkCawsGitRepo('hard-a4-notfound-');

    const result = closeSpec(fixture.cawsDir, {
      id: 'NEVER-EXISTED-001', resolution: 'completed', now: NOW, actor: ACTOR,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors.length).toBeGreaterThanOrEqual(1);

    const diag = result.errors[0];
    expect(diag.message).toContain('not found at');
    expect(diag.message).toContain('NEVER-EXISTED-001');
    // No "archived" language in this branch.
    expect(diag.message).not.toMatch(/archived/i);
    // Subject is the spec id, not undefined.
    expect(diag.subject).toBe('NEVER-EXISTED-001');
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

// ─── SEAM A1: createSpec kernel-validation error branch ────────────────
//
// CAWS-SPECS-WRITER-INTERNALS-MUTATION-SEAM-001 A1.
//
// createSpec renders YAML then runs parseAndValidateSpec before any
// write. If validation fails, it returns Err mapping each kernel
// diagnostic through storeDiagnostic with subject ?? input.id and
// data.source_rule. The previous suite never drove this branch, so the
// mutants on dist 311-314 (the !isOk(parsed) guard, the error-map
// arrow, the subject ?? fallback, the data object) all survived.
//
// Lever: inject a risk_tier outside 1|2|3 past the TypeScript type at
// the JS test layer. renderInitialSpecYaml writes `risk_tier: 7`, which
// fails the kernel schema, driving the error branch with a real
// diagnostic.

describe('SEAM A1: createSpec kernel-validation error branch', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('returns Err with a non-empty kernel diagnostic, subject defaulting to the id, and data.source_rule present', () => {
    fixture = mkCawsGitRepo('seam-a1-');

    const result = createSpec(fixture.cawsDir, {
      id: 'BAD-TIER-001',
      title: 'invalid risk tier',
      mode: 'chore',
      // Out-of-range tier — invalid per kernel schema. Cast past the
      // TS union at the JS layer to reach the validation branch.
      riskTier: 7,
      now: NOW,
      actor: ACTOR,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors.length).toBeGreaterThanOrEqual(1);

    const diag = result.errors[0];
    // Message is the kernel diagnostic, not empty (kills the
    // d.message → "" StringLiteral-adjacent mutants and proves the
    // error-map arrow ran rather than returning undefined).
    expect(typeof diag.message).toBe('string');
    expect(diag.message.length).toBeGreaterThan(0);
    // The kernel diagnostic for a schema violation carries its own
    // subject — the JSON-pointer path to the failing field
    // (e.g. "/risk_tier"). createSpec maps it through `d.subject ??
    // input.id`, so the kernel's subject is preserved.
    //
    // Asserting the kernel subject value (not input.id) is the stronger
    // check here:
    //   - It kills the subject-strip ObjectLiteral mutant (stripped →
    //     undefined ≠ "/risk_tier").
    //   - It kills the `?? → &&` LogicalOperator mutant: with `&&`,
    //     `d.subject && input.id` collapses a truthy d.subject to
    //     input.id ("BAD-TIER-001"), which would NOT equal the kernel
    //     field path. So this assertion fails under the mutant.
    expect(diag.subject).toBe('/risk_tier');
    // data.source_rule carries the originating kernel rule — kills the
    // data ObjectLiteral → {} mutant.
    expect(diag.data).toBeDefined();
    expect(diag.data.source_rule).toBeDefined();

    // No spec file was written (the error branch returns before the
    // transaction).
    expect(
      fs.existsSync(path.join(fixture.cawsDir, 'specs', 'BAD-TIER-001.yaml'))
    ).toBe(false);
  });
});

// ─── SEAM A2: createSpec now-default fallback ──────────────────────────
//
// CAWS-SPECS-WRITER-INTERNALS-MUTATION-SEAM-001 A2.
//
// createSpec computes `now = (input.now ?? (() => new Date()))()`. The
// existing suite always injects NOW, so the default arrow never ran and
// the dist-317 mutants (?? → &&, and the () => new Date() arrow → () =>
// undefined) survived. This test omits `now` so the fallback executes,
// then asserts created_at is a real recent ISO timestamp.

describe('SEAM A2: createSpec now-default fallback', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('omitting now uses the live clock; created_at is a valid ISO timestamp near real now', () => {
    fixture = mkCawsGitRepo('seam-a2-');

    const before = Date.now();
    const result = createSpec(fixture.cawsDir, {
      id: 'LIVE-CLOCK-001',
      title: 'no injected now',
      mode: 'chore',
      riskTier: 3,
      // now intentionally omitted — exercises the default arrow.
      actor: ACTOR,
    });
    const after = Date.now();

    expect(result.ok).toBe(true);

    const body = fs.readFileSync(
      path.join(fixture.cawsDir, 'specs', 'LIVE-CLOCK-001.yaml'),
      'utf8'
    );
    const m = body.match(/created_at:\s*'([^']+)'/);
    expect(m).not.toBeNull();
    const createdAt = Date.parse(m[1]);
    // Valid ISO timestamp.
    expect(Number.isNaN(createdAt)).toBe(false);
    // Within the wall-clock window of the call (a 5s slop guards CI
    // jitter). A () => undefined mutant would make .toISOString() throw
    // (TypeError on undefined) → test fails; a stale/zero value would
    // fall outside the window.
    expect(createdAt).toBeGreaterThanOrEqual(before - 5000);
    expect(createdAt).toBeLessThanOrEqual(after + 5000);
  });
});

// ─── SEAM A3: closeSpec id-validation guard ────────────────────────────
//
// CAWS-SPECS-WRITER-INTERNALS-MUTATION-SEAM-001 A3.
//
// closeSpec's first statement validates the spec id and returns Err
// before any filesystem read. The dist-354 ConditionalExpression mutant
// (if (!idValidation.ok) → if (false)) survived because no test drove
// closeSpec with a structurally invalid id.

describe('SEAM A3: closeSpec id-validation guard', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('returns Err for a pattern-violating id before touching the filesystem', () => {
    fixture = mkCawsGitRepo('seam-a3-');

    const result = closeSpec(fixture.cawsDir, {
      // Lowercase + no trailing -<digits> — fails the v11 id pattern.
      id: 'not a valid id',
      resolution: 'completed',
      now: NOW,
      actor: ACTOR,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    // The id-validation diagnostic names the v11 pattern.
    expect(result.errors[0].message).toMatch(/v11 pattern/);
  });
});

// ─── SEAM A4: closeSpec autocommit action literal ──────────────────────
//
// CAWS-SPECS-WRITER-INTERNALS-MUTATION-SEAM-001 A4.
//
// On a successful close, closeSpec calls attachAutoCommit(..., 'close',
// ...), which produces a commit `chore(caws): close <id>`. The dist-349
// StringLiteral mutant ('close' → "") and the dist-345 txnResult.ok
// guard survived because no store-level test asserted the autocommit
// subject after a successful close.

describe('SEAM A4: closeSpec autocommit action literal', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('a successful close produces a commit whose subject is "chore(caws): close <id>"', () => {
    fixture = mkCawsGitRepo('seam-a4-');

    createSpec(fixture.cawsDir, {
      id: 'CLOSE-COMMIT-001', title: 't', mode: 'chore', riskTier: 3,
      now: NOW, actor: ACTOR,
    });

    const result = closeSpec(fixture.cawsDir, {
      id: 'CLOSE-COMMIT-001', resolution: 'completed', now: NOW, actor: ACTOR,
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    // The autocommit subject carries the exact 'close' action literal.
    // A StringLiteral mutant ('close' → "") yields "chore(caws):  " and
    // fails this assertion.
    expect(gitLastSubject(fixture.root)).toBe('chore(caws): close CLOSE-COMMIT-001');
    // Working tree clean — proves the txnResult.ok success path ran
    // (dist-345) rather than the error branch.
    expect(gitStatus(fixture.root)).toBe('');
  });
});

// ─── SEAM A5: closeSpec readYamlSource fault-injection (EACCES) ────────
//
// CAWS-SPECS-WRITER-INTERNALS-MUTATION-SEAM-001 A5.
//
// After the active-file existence check, closeSpec reads the yaml via
// readYamlSource and guards `if (!isOk(sourceResult)) return err(...)`
// (dist line 380). The dist-380 ConditionalExpression mutant (→ if
// (false)) initially survived.
//
// CRITICAL mechanism note: readYamlSource (src/store/yaml-store.ts) does
// NOT parse YAML — it only reads raw bytes and fails on filesystem IO
// errors (ENOENT/EACCES). A corrupt-but-readable file returns Ok(raw);
// the structural failure happens LATER at parseAndValidateSpec. So the
// first A5 attempt (writing non-parseable bytes) never reached the
// line-380 guard — readYamlSource returned Ok, the guard passed, and the
// parse failure fired downstream. That made the line-380 mutant LOOK
// equivalent (both paths returned Err).
//
// To actually exercise — and distinguish — the line-380 guard, we need
// readYamlSource itself to fail while the file still exists. The lever
// is a permission error: chmod the file to 0o000 so fs.existsSync (378)
// passes but fs.readFileSync (379) throws EACCES → readYamlSource Err →
// the line-380 guard fires with a READ_IO_FAILED diagnostic
// ("Failed to read ...").
//
// Under the mutant (if (false)): the guard is skipped, originalBytes =
// sourceResult.value is undefined, parseAndValidateSpec(undefined) fails
// with a PARSE diagnostic — a DIFFERENT message. Asserting the message
// is the read-IO failure ("Failed to read") kills the mutant.
//
// Skipped on platforms where the test process can read 0o000 files
// (e.g. running as root, or filesystems that ignore mode bits), since
// the fault cannot be induced there.

describe('SEAM A5: closeSpec readYamlSource fault-injection (EACCES)', () => {
  let fixture;
  let chmodTarget;
  afterEach(() => {
    // Restore permissions so rmrf can clean up.
    if (chmodTarget && fs.existsSync(chmodTarget)) {
      try { fs.chmodSync(chmodTarget, 0o644); } catch { /* ignore */ }
    }
    chmodTarget = undefined;
    fixture && rmrf(fixture.root);
  });

  it('returns the READ_IO_FAILED diagnostic when the active yaml exists but is unreadable', () => {
    fixture = mkCawsGitRepo('seam-a5-');

    createSpec(fixture.cawsDir, {
      id: 'UNREADABLE-001', title: 't', mode: 'chore', riskTier: 3,
      now: NOW, actor: ACTOR,
    });

    const activePath = path.join(fixture.cawsDir, 'specs', 'UNREADABLE-001.yaml');
    expect(fs.existsSync(activePath)).toBe(true);

    // Make the file unreadable. fs.existsSync still passes; readFileSync
    // throws EACCES → readYamlSource Err → line-380 guard fires.
    chmodTarget = activePath;
    fs.chmodSync(activePath, 0o000);

    // Guard against environments where 0o000 is still readable (root /
    // permissive FS): if we can still read it, the fault can't be
    // induced and the assertion below would be meaningless.
    let stillReadable = false;
    try { fs.readFileSync(activePath, 'utf8'); stillReadable = true; } catch { /* expected */ }
    if (stillReadable) {
       
      console.warn('SEAM A5 skipped: 0o000 file still readable in this environment.');
      return;
    }

    const result = closeSpec(fixture.cawsDir, {
      id: 'UNREADABLE-001', resolution: 'completed', now: NOW, actor: ACTOR,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    // The line-380 guard returns sourceResult.errors verbatim — the
    // READ_IO_FAILED diagnostic from readYamlSource. Asserting on its
    // distinctive "Failed to read" message kills the if(false) mutant,
    // whose downstream parseAndValidateSpec(undefined) yields a parse
    // diagnostic with different wording.
    expect(result.errors[0].message).toMatch(/Failed to read/);
    // And definitively NOT the not-found branch (upstream of existsSync).
    expect(result.errors[0].message).not.toMatch(/not found at/);
  });
});

// ─── SEAM A7: createSpec success path + autocommit action literal ──────
//
// CAWS-SPECS-WRITER-INTERNALS-MUTATION-SEAM-001 A4 (createSpec half).
//
// The first SEAM pass covered closeSpec's autocommit ('close') but left
// createSpec's success-path internals untested at the assertion level:
//   - dist 345: if (!txnResult.ok) { return err(...) } — the
//     ConditionalExpression and BlockStatement mutants survived because
//     no test asserted a SUCCESSFUL create produces a clean committed
//     state (the success path past the guard).
//   - dist 349: attachAutoCommit(..., 'create', ...) — the 'create'
//     StringLiteral mutant ('create' → '') survived because no test
//     asserted the create autocommit subject.
//
// This test drives a clean createSpec and asserts the committed subject
// is exactly 'chore(caws): create <id>' with a clean working tree.

describe('SEAM A7: createSpec success path + autocommit action literal', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('a successful create produces commit "chore(caws): create <id>" and a clean tree', () => {
    fixture = mkCawsGitRepo('seam-a7-');

    const result = createSpec(fixture.cawsDir, {
      id: 'CREATE-COMMIT-001', title: 't', mode: 'chore', riskTier: 3,
      now: NOW, actor: ACTOR,
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    // The 'create' action literal flows into the autocommit subject.
    // A StringLiteral mutant ('create' → '') yields "chore(caws):  "
    // and fails this assertion.
    expect(gitLastSubject(fixture.root)).toBe('chore(caws): create CREATE-COMMIT-001');
    // Clean tree proves the txnResult.ok success path executed
    // (dist-345) rather than the error branch, and the autocommit
    // landed.
    expect(gitStatus(fixture.root)).toBe('');
    // The spec file is on disk and active.
    expect(
      fs.existsSync(path.join(fixture.cawsDir, 'specs', 'CREATE-COMMIT-001.yaml'))
    ).toBe(true);
  });
});
