'use strict';

/**
 * `caws claim --takeover` emits its audit event, atomically
 * (CAWS-DEFECT-CLAIM-TAKEOVER-AUDIT-01, ledger N10).
 *
 * The defect: `worktrees.json[name].owner` is documented in claim.ts as "the
 * SOLE ownership authority", which makes a takeover the highest-authority
 * mutation in the control plane — and it was the one lifecycle transition that
 * left no audit record at all. `claim_taken_over` has been in the kernel schema
 * since v11 with no emitter anywhere in the CLI; the single occurrence of the
 * identifier in src/ was the comment declining to emit it.
 *
 * Why that gap was sharp rather than cosmetic: the events chain is hash-linked,
 * so a reader who verifies it end-to-end learns that nothing was altered or
 * reordered — and learns nothing about whether the session emitting events
 * after a transfer was entitled to. Chain integrity READS as provenance and is
 * not. In the originating incident the transfer was visible only as the `actor`
 * field quietly changing between two consecutive events ~34 hours apart, with
 * prev_hash/event_hash linking cleanly straight across it.
 */

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
const { runClaimCommand } = require('../../dist/shell/commands/claim');
const { applyTakeoverWithAudit } = require('../../dist/store/worktrees-writer');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

function writeSpec(cawsDir, id, worktree) {
  fs.writeFileSync(
    path.join(cawsDir, 'specs', `${id}.yaml`),
    `id: ${id}
title: '${id}'
risk_tier: 3
mode: chore
lifecycle_state: active
worktree: ${worktree}
created_at: '2026-08-12T00:00:00.000Z'
updated_at: '2026-08-12T00:00:00.000Z'
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
  - 'fixture'
acceptance:
  - id: A1
    given: 'fixture'
    when: 'fixture'
    then: 'fixture'
non_functional: {}
contracts: []
`
  );
}

function writeLease(cawsDir, sessionId, extra = {}) {
  const leasesDir = path.join(cawsDir, 'leases');
  fs.mkdirSync(leasesDir, { recursive: true });
  fs.writeFileSync(
    path.join(leasesDir, `${sessionId}.json`),
    JSON.stringify(
      {
        lease_version: 1,
        session_id: sessionId,
        platform: 'claude-code',
        status: 'active',
        started_at: '2026-08-12T11:00:00.000Z',
        last_active: '2026-08-12T11:30:00.000Z',
        repo_root: path.dirname(cawsDir),
        cwd: path.dirname(cawsDir),
        git_common_dir: path.join(path.dirname(cawsDir), '.git'),
        git_dir: path.join(path.dirname(cawsDir), '.git'),
        last_seen_reason: 'claim',
        ...extra,
      },
      null,
      2
    ) + '\n'
  );
}

/** A worktree owned by `ownerSession`, ready for `takerSession` to take over. */
function setupTakeoverRepo({ ownerSession = 'peer-session', takerSession = 'me' } = {}) {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  const cawsDir = path.join(root, '.caws');
  const wtPath = path.join(cawsDir, 'worktrees', 'wt-claim');
  fs.mkdirSync(wtPath, { recursive: true });
  writeSpec(cawsDir, 'CLAIMEV-001', 'wt-claim');
  fs.writeFileSync(
    path.join(cawsDir, 'worktrees.json'),
    JSON.stringify(
      {
        'wt-claim': {
          branch: 'wt-claim',
          baseBranch: 'main',
          specId: 'CLAIMEV-001',
          path: wtPath,
          owner: { session_id: ownerSession, platform: 'claude-code' },
          last_heartbeat: '2026-08-12T11:45:00.000Z',
        },
      },
      null,
      2
    ) + '\n'
  );
  writeLease(cawsDir, ownerSession, { cwd: wtPath, bound_worktree: 'wt-claim' });
  writeLease(cawsDir, takerSession, { cwd: wtPath, bound_worktree: 'wt-claim' });
  return { root, cawsDir, wtPath };
}

function runClaim(cwd, wtPath, opts = {}) {
  const out = [];
  const err = [];
  const code = runClaimCommand({
    cwd: wtPath,
    now: () => new Date('2026-08-12T12:00:00.000Z'),
    env: {
      ...process.env,
      CLAUDE_SESSION_ID: 'me',
      // The phantom-root guard keys on this: a takeover from a transient `cd`
      // registers ownership the write-guard would never honour.
      CLAUDE_PROJECT_DIR: wtPath,
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
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

function takenOverEvents(cawsDir) {
  return readEvents(cawsDir).filter((e) => e.event === 'claim_taken_over');
}

function readOwner(cawsDir) {
  const reg = JSON.parse(fs.readFileSync(path.join(cawsDir, 'worktrees.json'), 'utf8'));
  return reg['wt-claim'].owner.session_id;
}

describe('A1: a successful takeover appends claim_taken_over', () => {
  test('the event names the worktree, prior owner with last_seen, and new owner', () => {
    const { root, cawsDir, wtPath } = setupTakeoverRepo();

    const result = runClaim(root, wtPath, { takeover: true });

    expect(result.code).toBe(0);
    expect(readOwner(cawsDir)).toBe('me');

    const events = takenOverEvents(cawsDir);
    // HEADLINE: before this slice this array was empty for every takeover ever
    // performed, in every CAWS repo.
    expect(events).toHaveLength(1);
    const data = events[0].data;
    expect(data.worktree_name).toBe('wt-claim');
    expect(data.prior_owner.session_id).toBe('peer-session');
    expect(data.new_owner.session_id).toBe('me');
    // last_seen is what distinguishes "took over from a session that went quiet
    // an hour ago" from "took over from a session that was mid-keystroke".
    expect(data.prior_owner).toHaveProperty('last_seen');

    // The actor and the beneficiary must be provably one party, or the record
    // does not answer "who did this".
    expect(events[0].actor.id).toBe('me');
    expect(events[0].spec_id).toBe('CLAIMEV-001');
  });

  test('the event lands in the hash chain and the chain still verifies', () => {
    const { root, cawsDir, wtPath } = setupTakeoverRepo();
    const before = readEvents(cawsDir);

    expect(runClaim(root, wtPath, { takeover: true }).code).toBe(0);

    const after = readEvents(cawsDir);
    expect(after).toHaveLength(before.length + 1);
    const appended = after[after.length - 1];
    expect(appended.event).toBe('claim_taken_over');
    // seq is the ordering authority; a chain-appended event must extend it.
    expect(appended.seq).toBe(after.length);
    // prev_hash links to the event before it — the append went through the
    // sanctioned substrate rather than a raw file write.
    if (before.length > 0) {
      expect(appended.prev_hash).toBe(before[before.length - 1].event_hash);
    }
    expect(typeof appended.event_hash).toBe('string');
    expect(appended.event_hash.length).toBeGreaterThan(0);
  });

  test('last_seen carries the prior owner heartbeat when one exists', () => {
    const { root, cawsDir, wtPath } = setupTakeoverRepo();

    expect(runClaim(root, wtPath, { takeover: true }).code).toBe(0);

    // The kernel derives prior_owner.last_seen from the REGISTRY entry's
    // last_heartbeat (ownership.ts), not from the lease file — ownership
    // authority and liveness display are deliberately separate surfaces.
    expect(takenOverEvents(cawsDir)[0].data.prior_owner.last_seen).toBe(
      '2026-08-12T11:45:00.000Z'
    );
  });

  test('last_seen is explicit null when the prior owner entry has no heartbeat', () => {
    const { root, cawsDir, wtPath } = setupTakeoverRepo();
    // The TTL-pruned shape: the registry entry survives but its heartbeat is
    // gone, so there is no answer to "when was that session last seen".
    const registryPath = path.join(cawsDir, 'worktrees.json');
    const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    delete reg['wt-claim'].last_heartbeat;
    fs.writeFileSync(registryPath, JSON.stringify(reg, null, 2) + '\n');

    expect(runClaim(root, wtPath, { takeover: true }).code).toBe(0);

    const data = takenOverEvents(cawsDir)[0].data;
    // Explicit null, NOT an absent field: the schema models this case, and
    // omitting it would be indistinguishable from "we never looked".
    expect(data.prior_owner.last_seen).toBeNull();
    expect('last_seen' in data.prior_owner).toBe(true);
  });
});

/** The kernel's takeover_claim envelope (worktree/types.ts): the name field is
 *  `worktree_name`, and prior_owner carries takenOver_at. Built by hand here so
 *  the fault-injection tests can drive the writer directly. */
function takeoverPatch() {
  return {
    kind: 'takeover_claim',
    worktree_name: 'wt-claim',
    owner: { session_id: 'me', platform: 'claude-code' },
    prior_owner: {
      session_id: 'peer-session',
      platform: 'claude-code',
      last_seen: '2026-08-12T11:45:00.000Z',
      takenOver_at: '2026-08-12T12:00:00.000Z',
    },
    when: '2026-08-12T12:00:00.000Z',
  };
}

/** Make the event chain unappendable. Written (not appended to) because a fresh
 *  initProject repo may not have the file at all. */
function corruptEventChain(cawsDir) {
  fs.writeFileSync(
    path.join(cawsDir, 'events.jsonl'),
    'this is not valid jsonl and cannot be chained\n'
  );
}

describe('A2: the registry write and the audit append are one transaction', () => {
  test('a failed append rolls the ownership back to the prior owner', () => {
    const { cawsDir } = setupTakeoverRepo();
    const registryPath = path.join(cawsDir, 'worktrees.json');
    corruptEventChain(cawsDir);

    const result = applyTakeoverWithAudit(cawsDir, {
      name: 'wt-claim',
      patch: takeoverPatch(),
      actor: { kind: 'agent', id: 'me', session_id: 'me' },
      priorOwner: {
        session_id: 'peer-session',
        platform: 'claude-code',
        last_seen: '2026-08-12T11:45:00.000Z',
      },
      newOwner: { session_id: 'me', platform: 'claude-code' },
    });

    expect(result.ok).toBe(false);
    // The compensation is the whole point: a takeover that proceeded here would
    // produce exactly the state this slice forbids — ownership transferred with
    // no record of who transferred it.
    const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    expect(reg['wt-claim'].owner.session_id).toBe('peer-session');
    // And the descriptive metadata the kernel does not model survives too —
    // the compensation restores the prior BYTES, not a re-serialized object.
    expect(reg['wt-claim'].branch).toBe('wt-claim');
    expect(reg['wt-claim'].specId).toBe('CLAIMEV-001');
  });

  test('the refusal names the prior owner so the operator knows who owns it now', () => {
    const { cawsDir } = setupTakeoverRepo();
    corruptEventChain(cawsDir);

    const result = applyTakeoverWithAudit(cawsDir, {
      name: 'wt-claim',
      patch: takeoverPatch(),
      actor: { kind: 'agent', id: 'me', session_id: 'me' },
      priorOwner: { session_id: 'peer-session', last_seen: null },
      newOwner: { session_id: 'me' },
    });

    expect(result.ok).toBe(false);
    const messages = result.errors.map((d) => d.message).join('\n');
    // An operator reading this must not have to guess whether they now own it.
    expect(messages).toMatch(/peer-session/);
  });

  test('a healthy chain lets the same call succeed — the fault injection is what fails it', () => {
    const { cawsDir } = setupTakeoverRepo();

    const result = applyTakeoverWithAudit(cawsDir, {
      name: 'wt-claim',
      patch: takeoverPatch(),
      actor: { kind: 'agent', id: 'me', session_id: 'me' },
      priorOwner: { session_id: 'peer-session', last_seen: null },
      newOwner: { session_id: 'me' },
    });

    // Without this control, the two tests above could both be passing because
    // the hand-built patch is malformed rather than because the chain is
    // corrupt — a rollback assertion that never exercised the rollback.
    expect(result.ok).toBe(true);
    expect(readOwner(cawsDir)).toBe('me');
    expect(takenOverEvents(cawsDir)).toHaveLength(1);
  });
});

describe('A3: claim_taken_over means a TRANSFER, not a heartbeat', () => {
  test('a same-session claim with no --takeover appends nothing', () => {
    const { root, cawsDir, wtPath } = setupTakeoverRepo({ ownerSession: 'me' });

    const result = runClaim(root, wtPath);

    expect(result.code).toBe(0);
    // If a refresh emitted the event, a reader could not distinguish "a
    // takeover happened" from "the owner said hello", which would make the
    // audit surface useless for the question it exists to answer.
    expect(takenOverEvents(cawsDir)).toHaveLength(0);
  });

  test('a foreign claim WITHOUT --takeover is refused and appends nothing', () => {
    const { root, cawsDir, wtPath } = setupTakeoverRepo();

    const result = runClaim(root, wtPath);

    expect(result.code).toBe(1);
    expect(takenOverEvents(cawsDir)).toHaveLength(0);
    // And ownership genuinely did not move.
    expect(readOwner(cawsDir)).toBe('peer-session');
  });
});

describe('A4: a refused takeover leaves no audit implying it happened', () => {
  test('the phantom-root refusal appends nothing and does not transfer ownership', () => {
    const { root, cawsDir, wtPath } = setupTakeoverRepo();

    // A one-off shell `cd` into the worktree does NOT root the session there;
    // the write guard keys authority on the harness project root, so the
    // registered ownership would be unexercisable.
    const result = runClaim(root, wtPath, {
      takeover: true,
      env: {
        ...process.env,
        CLAUDE_SESSION_ID: 'me',
        CLAUDE_PROJECT_DIR: root,
      },
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain('phantom');
    // The event append is placed AFTER this guard for exactly this reason.
    expect(takenOverEvents(cawsDir)).toHaveLength(0);
    expect(readOwner(cawsDir)).toBe('peer-session');
  });

  test('--plan previews the takeover without appending the event', () => {
    const { root, cawsDir, wtPath } = setupTakeoverRepo();

    const result = runClaim(root, wtPath, { takeover: true, plan: true });

    expect(result.code).toBe(0);
    // A preview that wrote the audit would assert a transfer that never
    // occurred — worse than the silence this slice is fixing.
    expect(takenOverEvents(cawsDir)).toHaveLength(0);
    expect(readOwner(cawsDir)).toBe('peer-session');
  });
});
