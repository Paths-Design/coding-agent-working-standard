/**
 * @fileoverview WORKTREE-ISOLATION-HARDENING-001 (Fix 6 / D3) — DIAGNOSTIC
 * fixture reproducing the candidate over-match that let a foreign session
 * destroy another session's live worktree in the clash probe (seq 16-18).
 *
 * ROOT CAUSE (recon Map 4, confirmed from the clash-probe events.jsonl): the
 * destroy guard's owner WAS stamped (seq 16 created clash-c owned by 6f0f7d7a;
 * seq 18 destroy by foreign 366eb2f8 recorded owner_session_id 6f0f7d7a). So
 * entry.owner was NOT undefined — the guard ran admitsOwner and over-matched.
 *
 * WHY: resolveSessionCandidates' capsule source (readAllCapsules) contributes
 * EVERY well-formed capsule under .caws/sessions/*.json REGARDLESS of
 * worktree_root or invoking identity. That was a deliberate fix for a
 * cwd-sensitivity bug (CAWS-WORKTREE-DESTROY-SESSION-RESOLUTION-001: destroy
 * from canonical after a takeover). Its side effect: when TWO DISTINCT real
 * sessions both have capsules in the same repo's .caws/sessions/, session B's
 * candidate set INCLUDES session A's identity — so admitsOwner(B-candidates,
 * A-owned) wrongly returns a match and B is admitted to mutate A's worktree.
 *
 * SCOPE DECISION (maintainer split rule): the fix is candidate-resolution
 * hardening and is DELICATE — tightening readAllCapsules risks regressing the
 * legitimate takeover-from-canonical path it was built to support. Therefore
 * this slice ships ONLY this diagnostic fixture and OPENS the successor spec
 * SESSION-CANDIDATE-RESOLUTION-HARDENING-001. No resolveSessionCandidates
 * tightening occurs in WORKTREE-ISOLATION-HARDENING-001; D1/D2/Fix1-5 land
 * independently of D3.
 *
 * This test ASSERTS THE CURRENT (over-matching) BEHAVIOR so it is a regression
 * anchor: when the successor spec fixes candidate resolution, this expectation
 * FLIPS (the over-match should no longer occur), and the successor's author
 * updates it. It is deliberately NOT skipped — a green run here documents that
 * the over-match is still live and the successor work is still owed.
 *
 * Loads BUILT dist; runs on canonical post-build.
 *
 * @author @darianrosebrook
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveSessionCandidates,
  admitsOwner,
} = require('../../dist/shell/session/resolve-session');

function mkCaws() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-d3-overmatch-'));
  const cawsDir = path.join(root, '.caws');
  fs.mkdirSync(path.join(cawsDir, 'sessions'), { recursive: true });
  return { root, cawsDir };
}

function writeCapsule(cawsDir, sessionId, worktreeRoot) {
  fs.writeFileSync(
    path.join(cawsDir, 'sessions', `${sessionId}.json`),
    JSON.stringify({
      session_id: sessionId,
      platform: 'claude-code',
      minted_at: '2026-06-01T00:00:00.000Z',
      worktree_root: worktreeRoot,
    })
  );
}

describe('WORKTREE-ISOLATION-HARDENING-001 D3: candidate over-match (DIAGNOSTIC; flips when SESSION-CANDIDATE-RESOLUTION-HARDENING-001 lands)', () => {
  let root;
  let cawsDir;
  afterEach(() => {
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  test('two distinct sessions sharing .caws/sessions -> session B candidate set INCLUDES session A (the over-match)', () => {
    ({ root, cawsDir } = mkCaws());
    const SESSION_A = 'sess-owner-aaaaaaaa';
    const SESSION_B = 'sess-foreign-bbbbbbbb';
    // Both real sessions left a capsule in the SAME repo's .caws/sessions/.
    writeCapsule(cawsDir, SESSION_A, path.join(root, '.caws', 'worktrees', 'wt-a'));
    writeCapsule(cawsDir, SESSION_B, root);

    // Session B resolves its candidates WITH NO env identity (the agent-Bash /
    // no-HOOK_SESSION_ID case), so the capsule scan is the dominant source.
    const cands = resolveSessionCandidates({ cawsDir, env: {} });
    const ids = cands.candidates.map((c) => c.identity.session_id);

    // THE BUG: B's candidate set contains A's id (capsule scan is
    // identity-blind). When the successor spec fixes this, A should NOT appear
    // in a resolution that is not B's own — and this expectation flips.
    expect(ids).toContain(SESSION_A);

    // CONSEQUENCE: admitsOwner against an A-owned worktree returns a match even
    // though the invoking process is B. This is exactly the destroy over-match
    // the clash probe walked (seq 16-18). NOTE: admitsOwner is correct given
    // its inputs; the defect is upstream in WHAT resolveSessionCandidates
    // admits, which is why the fix is candidate-resolution hardening.
    const matched = admitsOwner(cands, SESSION_A);
    expect(matched).not.toBeNull();
  });
});
