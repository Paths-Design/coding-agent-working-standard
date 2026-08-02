'use strict';

/**
 * CAWS-FIX-N4-CLAIM-TAKEOVER-AUTHORITY-001 — an explicit `caws claim
 * --takeover` on a foreign-owned worktree MUST perform the ownership
 * rewrite, even when the foreign owner has a fresh durable hook envelope
 * on disk that resolveSessionCandidates would otherwise admit as a
 * same-session candidate.
 *
 * The defect this suite pins: before the fix, `claim --takeover` admitted
 * EVERY fresh (<=24h last_seen_at) durable envelope as a candidate, and
 * the kernel's candidate-admission branch did pure session_id equality. A
 * foreign session F that is DEAD but whose envelope is still fresh got
 * admitted, matched owner.session_id, and the kernel returned Ok(null) —
 * so claim exited 0 with NO ownership rewrite, NO prior_owners, and F
 * rendered as "you". An operator relying on --takeover to recover a
 * dead-session worktree was permanently blocked.
 *
 * The fix (resolved-self-strict): under an EXPLICIT --takeover, claim
 * narrows the candidate set to identities whose session_id equals the
 * single resolved self (resolveSession, the same resolver `caws status`
 * uses). The non-takeover claim is unchanged. The kernel stays pure
 * id-equality; the self-vs-foreign decision lives in the shell.
 *
 * SUT: compiled surface — require('../../../dist/shell/commands/claim').
 * `npm run build` compiles TS -> dist before jest runs.
 */

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../../dist/store/init-store');
const { runClaimCommand } = require('../../../dist/shell/commands/claim');
const { cleanupAll, makeTempRepo } = require('../../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

function writeSpec(cawsDir, id, worktree) {
  const body = `id: ${id}
title: '${id}'
risk_tier: 3
mode: chore
lifecycle_state: active
worktree: ${worktree}
created_at: '2026-07-30T00:00:00.000Z'
updated_at: '2026-07-30T00:00:00.000Z'
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
`;
  fs.writeFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), body);
}

function writeRegistry(cawsDir, entries) {
  fs.writeFileSync(path.join(cawsDir, 'worktrees.json'), JSON.stringify(entries, null, 2) + '\n');
}

function readRegistry(cawsDir) {
  return JSON.parse(fs.readFileSync(path.join(cawsDir, 'worktrees.json'), 'utf8'));
}

// Write a durable hook envelope — the resolver's durable-envelope source,
// scanned by resolveSessionCandidates for EVERY fresh (<=24h last_seen_at)
// envelope whose repo_root matches. This is the defect surface: a foreign
// session with a fresh envelope on disk. repo_root must realpath-match the
// test repo root (the resolver realpath-compares repo_root).
function writeDurableEnvelope(cawsDir, sessionId, repoRoot, platform = 'claude-code') {
  // The envelope lives at .caws/sessions/<sessionId>/.session-envelope.json.
  const dir = path.join(cawsDir, 'sessions', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.session-envelope.json'),
    JSON.stringify(
      {
        session_id: sessionId,
        repo_root: repoRoot,
        created_at: '2026-07-30T10:00:00.000Z',
        // last_seen_at FRESH — well within the 24h freshness window used by
        // the real `now` we pass below (2026-07-30T12:00:00Z).
        last_seen_at: '2026-07-30T11:55:00.000Z',
        hook_event: 'PreToolUse',
        platform,
      },
      null,
      2
    ) + '\n'
  );
}

function setupRepo({ ownerSession }) {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  const cawsDir = path.join(root, '.caws');
  const wtPath = path.join(cawsDir, 'worktrees', 'wt-demo');
  fs.mkdirSync(wtPath, { recursive: true });
  writeSpec(cawsDir, 'DEMO-001', 'wt-demo');
  writeRegistry(cawsDir, {
    'wt-demo': {
      branch: 'wt-demo',
      baseBranch: 'main',
      specId: 'DEMO-001',
      path: wtPath,
      owner: { session_id: ownerSession, platform: 'claude-code' },
      last_heartbeat: '2026-07-30T11:45:00.000Z',
    },
  });
  return { root, cawsDir, wtPath };
}

// Run claim with the operating session pinned via CAWS_SESSION_ID. The
// foreign owner has no env-var corroborating it; the operating session is
// the only tier-1 identity.
function runClaimTakeover(cwd, cawsDir, operatingSession) {
  const out = [];
  const err = [];
  const code = runClaimCommand({
    cwd,
    takeover: true,
    now: () => new Date('2026-07-30T12:00:00.000Z'),
    env: {
      ...process.env,
      // No identity env vars corroborate the FOREIGN owner — it only exists
      // as a durable envelope on disk.
      CLAUDE_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      CODEX_THREAD_ID: '',
      CAWS_SESSION_ID: operatingSession,
      HOOK_SESSION_ID: '',
      CURSOR_TRACE_ID: '',
      CAWS_PROJECT_DIR: path.dirname(cawsDir),
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('CAWS-FIX-N4-CLAIM-TAKEOVER-AUTHORITY-001 — takeover of a foreign-owner with a fresh envelope', () => {
  test('A1: --takeover on a foreign owner with a fresh durable envelope rewrites ownership', () => {
    const foreign = 'caws-foreign-dead';
    const self = 'caws-self-op';
    const { root, cawsDir, wtPath } = setupRepo({ ownerSession: foreign });

    // The defect trigger: a FRESH durable envelope for the foreign owner.
    // Before the fix this was admitted as a candidate and short-circuited
    // the takeover to a no-op.
    writeDurableEnvelope(cawsDir, foreign, root);

    const before = readRegistry(cawsDir)['wt-demo'];
    expect(before.owner.session_id).toBe(foreign);
    expect(before.prior_owners ?? []).toHaveLength(0);

    const result = runClaimTakeover(wtPath, cawsDir, self);

    // HEADLINE: the takeover IS performed (exit 0), not a silent no-op.
    expect(result.code).toBe(0);

    // The ownership record is REWRITTEN to the operating session, with a
    // prior_owners entry recording the foreign owner.
    const after = readRegistry(cawsDir)['wt-demo'];
    expect(after.owner.session_id).toBe(self);
    expect(after.prior_owners).toBeTruthy();
    expect(after.prior_owners.length).toBe(1);
    expect(after.prior_owners[0].session_id).toBe(foreign);
    // takenOver_at is the authority-bearing timestamp.
    expect(after.prior_owners[0].takenOver_at).toBeTruthy();

    // The panel must NOT render the foreign owner as "you" post-takeover.
    expect(result.out).not.toMatch(new RegExp(foreign + '.*you', 'i'));
  });

  test('A2: --takeover on a worktree already owned by the resolved self is a benign no-op', () => {
    // Accepted trade-off: a self-takeover may write a self prior_owners
    // entry. The headline contract is that it exits 0 without error (the
    // legit create-then-enter self-takeover is preserved).
    const self = 'caws-self-owner';
    const { root, cawsDir, wtPath } = setupRepo({ ownerSession: self });
    // A capsule keyed to root so the resolved-self candidate admits the
    // owner even from a different cwd.
    const sessionsDir = path.join(cawsDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, `${self}.json`),
      JSON.stringify(
        { session_id: self, platform: 'zcode', minted_at: '2026-07-30T10:00:00.000Z', worktree_root: root },
        null,
        2
      ) + '\n'
    );

    const result = runClaimTakeover(wtPath, cawsDir, self);

    // No foreign owner; the resolved self IS the owner. Exit 0, no error.
    expect(result.code).toBe(0);
    expect(result.err).not.toContain('foreign_owner_blocked');
  });

  test('A4: --takeover on a foreign owner with NO fresh candidate still performs the takeover', () => {
    // Pre-existing behavior pinned: a genuinely-foreign owner (no envelope,
    // no capsule) under an explicit --takeover is taken over (not blocked).
    // The fix does NOT loosen the foreign block; an authorized takeover
    // always worked for this case and still does.
    const foreign = 'caws-foreign-nocand';
    const self = 'caws-self-op2';
    const { cawsDir, wtPath } = setupRepo({ ownerSession: foreign });
    // Deliberately NO envelope / capsule for the foreign owner.

    const result = runClaimTakeover(wtPath, cawsDir, self);

    expect(result.code).toBe(0);
    const after = readRegistry(cawsDir)['wt-demo'];
    expect(after.owner.session_id).toBe(self);
    expect(after.prior_owners[0].session_id).toBe(foreign);
  });
});
