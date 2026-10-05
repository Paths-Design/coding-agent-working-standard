'use strict';

/** Ownership cache records never establish the invoking caller. These cases
 * preserve the D3 foreign-session controls and close the singleton and shared
 * pointer exceptions. Explicit caller context remains sufficient across cwd.
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

  test('A1b: fresh repo-matched caller pointer naming B cannot identify an unknown caller', () => {
    const { root, cawsDir } = mkRepo();
    writeCapsule(cawsDir, 'session-a', root);
    writeCapsule(cawsDir, 'session-b', root);
    writeCallerPointer(cawsDir, root, 'session-b', FRESH);

    const result = resolveSessionCandidates({ cawsDir, env: {}, now: () => NOW });
    const capsuleIds = result.candidates
      .filter((c) => c.source === 'capsule')
      .map((c) => c.identity.session_id);

    expect(capsuleIds).toEqual([]);
    expect(admitsOwner(result, 'session-b')).toBeNull();
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

  test('A2: single capsule cannot identify an unknown caller', () => {
    const { root, cawsDir } = mkRepo();
    writeCapsule(cawsDir, 'session-owner', root);

    const result = resolveSessionCandidates({ cawsDir, env: {}, now: () => NOW });
    const capsuleIds = result.candidates
      .filter((c) => c.source === 'capsule')
      .map((c) => c.identity.session_id);

    expect(capsuleIds).toEqual([]);
    expect(admitsOwner(result, 'session-owner')).toBeNull();
  });

  test('A3: rejected capsules appear in the trace with reasons (no silent fallback)', () => {
    const { root, cawsDir } = mkRepo();
    writeCapsule(cawsDir, 'session-a', root);
    writeCapsule(cawsDir, 'session-b', root);
    writeCallerPointer(cawsDir, root, 'session-b', FRESH);

    const result = resolveSessionCandidates({ cawsDir, env: {}, now: () => NOW });
    const rendered = describeCandidateTrace(result);

    expect(rendered).toContain('capsule: rejected');
    expect(rendered).toContain('session-b');
    // A shared pointer cannot rescue either cached identity.
    expect(rendered).toContain('uncorroborated-capsule: session-a.json');
    expect(rendered).toContain('does not identify the invoking caller');
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
