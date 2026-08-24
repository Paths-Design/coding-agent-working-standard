'use strict';

/**
 * SESSION-CANDIDATE-RESOLUTION-HARDENING-001 — the D3 over-match fixture
 * (failure-lineage Entry 35, split from WORKTREE-ISOLATION-HARDENING-001).
 *
 * The defect: readAllCapsules admitted EVERY well-formed capsule under
 * .caws/sessions/*.json identity-blind, so with two distinct sessions'
 * capsules in one repo, session B's candidate set included session A —
 * admitsOwner then let B destroy/merge/bind A's worktree. This suite
 * asserts the FIXED behavior (the original Entry-35 fixture asserted the
 * over-match; this is its flipped expectation):
 *
 * A1  Two capsules, no env identity, no caller pointer => NEITHER admits
 *     for a foreign process; admitsOwner(candidates, A-owned) === null.
 *     Fail closed: under-admit degrades to the refusal --takeover resolves.
 * A1b Fresh repo-matched caller pointer naming B => B admits, A does not.
 * A1c Env identity (CAWS_SESSION_ID=A) => A admits, B does not.
 * A2  Single capsule on disk => admits with NO corroboration (the
 *     machine-and-repo evidence CAWS-WORKTREE-DESTROY-SESSION-RESOLUTION-001
 *     pinned — the takeover-from-canonical compat rule).
 * A3  The candidate trace renders every rejected capsule with a reason —
 *     no silent fallback.
 *
 * SUT: dist/shell/session/resolve-session (npm run build compiles first).
 */

const fs = require('fs');
const path = require('path');

const {
  resolveSessionCandidates,
  admitsOwner,
  describeCandidateTrace,
} = require('../../dist/shell/session/resolve-session');
const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

function writeCapsule(cawsDir, sessionId, worktreeRoot, platform = 'zcode') {
  const sessionsDir = path.join(cawsDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, `${sessionId}.json`),
    JSON.stringify(
      {
        session_id: sessionId,
        platform,
        minted_at: '2026-06-01T10:00:00.000Z',
        worktree_root: worktreeRoot,
      },
      null,
      2
    ) + '\n'
  );
}

function writeCallerPointer(cawsDir, repoRoot, sessionId, lastSeenIso) {
  fs.writeFileSync(
    path.join(cawsDir, 'sessions', '.caller-session.json'),
    JSON.stringify({ session_id: sessionId, repo_root: repoRoot, last_seen_at: lastSeenIso }) + '\n'
  );
}

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  return { root, cawsDir: path.join(root, '.caws') };
}

const NOW = new Date('2026-06-01T12:00:00.000Z');
const FRESH = '2026-06-01T11:55:00.000Z'; // inside the freshness window at NOW

describe('SESSION-CANDIDATE-RESOLUTION-HARDENING-001 (D3 over-match fix)', () => {
  test('A1: two capsules, no env identity, no pointer — neither admits for a foreign process', () => {
    const { root, cawsDir } = mkRepo();
    writeCapsule(cawsDir, 'session-a', root);
    writeCapsule(cawsDir, 'session-b', root);

    const result = resolveSessionCandidates({ cawsDir, env: {}, now: () => NOW });
    const capsuleIds = result.candidates
      .filter((c) => c.source === 'capsule')
      .map((c) => c.identity.session_id);

    expect(capsuleIds).toEqual([]); // fail closed — no corroboration, no admission
    expect(admitsOwner(result, 'session-a')).toBeNull();
    expect(admitsOwner(result, 'session-b')).toBeNull();
  });

  test('A1b: fresh repo-matched caller pointer naming B — B admits, A rejected', () => {
    const { root, cawsDir } = mkRepo();
    writeCapsule(cawsDir, 'session-a', root);
    writeCapsule(cawsDir, 'session-b', root);
    writeCallerPointer(cawsDir, root, 'session-b', FRESH);

    const result = resolveSessionCandidates({ cawsDir, env: {}, now: () => NOW });
    const capsuleIds = result.candidates
      .filter((c) => c.source === 'capsule')
      .map((c) => c.identity.session_id);

    expect(capsuleIds).toEqual(['session-b']);
    expect(admitsOwner(result, 'session-b')).not.toBeNull();
    expect(admitsOwner(result, 'session-a')).toBeNull(); // the D3 breach, closed
  });

  test('A1c: env identity corroborates its own capsule only', () => {
    const { root, cawsDir } = mkRepo();
    writeCapsule(cawsDir, 'session-a', root);
    writeCapsule(cawsDir, 'session-b', root);

    const result = resolveSessionCandidates({
      cawsDir,
      env: { CAWS_SESSION_ID: 'session-a' },
      now: () => NOW,
    });
    const capsuleIds = result.candidates
      .filter((c) => c.source === 'capsule')
      .map((c) => c.identity.session_id);

    expect(capsuleIds).toEqual(['session-a']);
    expect(admitsOwner(result, 'session-a')).not.toBeNull();
    expect(admitsOwner(result, 'session-b')).toBeNull();
  });

  test('A2: single capsule admits with no corroboration (takeover-from-canonical compat)', () => {
    const { root, cawsDir } = mkRepo();
    writeCapsule(cawsDir, 'session-owner', root);

    const result = resolveSessionCandidates({ cawsDir, env: {}, now: () => NOW });
    const capsuleIds = result.candidates
      .filter((c) => c.source === 'capsule')
      .map((c) => c.identity.session_id);

    expect(capsuleIds).toEqual(['session-owner']);
    expect(admitsOwner(result, 'session-owner')).not.toBeNull();
  });

  test('A3: rejected capsules appear in the trace with reasons (no silent fallback)', () => {
    const { root, cawsDir } = mkRepo();
    writeCapsule(cawsDir, 'session-a', root);
    writeCapsule(cawsDir, 'session-b', root);
    writeCallerPointer(cawsDir, root, 'session-b', FRESH);

    const result = resolveSessionCandidates({ cawsDir, env: {}, now: () => NOW });
    const rendered = describeCandidateTrace(result);

    expect(rendered).toContain('capsule: admitted');
    expect(rendered).toContain('session-b');
    // The rejection rides along in the mixed-admission reason.
    expect(rendered).toContain('uncorroborated-capsule: session-a.json');
    expect(rendered).toContain('D3 over-match guard');
  });

  test('A3b: all-rejected multi-capsule case renders every capsule with a reason', () => {
    const { root, cawsDir } = mkRepo();
    writeCapsule(cawsDir, 'session-a', root);
    writeCapsule(cawsDir, 'session-b', root);

    const result = resolveSessionCandidates({ cawsDir, env: {}, now: () => NOW });
    const rendered = describeCandidateTrace(result);

    expect(rendered).toContain('uncorroborated-capsule: session-a.json');
    expect(rendered).toContain('uncorroborated-capsule: session-b.json');
  });
});
