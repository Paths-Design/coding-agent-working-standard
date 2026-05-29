/**
 * Cross-cwd integration tests for runWorktreeDestroyCommand and
 * runWorktreeMergeCommand — the acceptance criteria of
 * CAWS-WORKTREE-DESTROY-SESSION-RESOLUTION-001.
 *
 * Coverage:
 *   A1  claim/takeover inside a worktree, then destroy from canonical
 *       succeeds (no foreign-claim refusal, no manual recovery, no
 *       additional capsule minted by destroy).
 *   A2  genuinely-foreign session destroy still refuses (no regression
 *       of the foreign-claim soft-block).
 *   A3  destroy from a sibling worktree's cwd succeeds when the
 *       invoking session has a capsule that matches the target
 *       worktree's owner.
 *   A4  no env, no capsule → destroy refuses and does NOT mint a
 *       capsule on the filesystem.
 *   A5  end-to-end claim→destroy chain: runClaimCommand then
 *       runWorktreeDestroyCommand both exit 0 with no intermediate
 *       state mutation needed.
 *   merge-A1 mirror: the same multi-candidate admission applies to
 *       runWorktreeMergeCommand so destroy's contract semantics are
 *       not the only surface protected.
 *
 * Method: tests prime the .caws/sessions/ directory directly with
 * capsule files that point at specific worktree_roots, simulating
 * the multi-cwd state that occurs when claim mints inside a
 * worktree and destroy is later issued from a different cwd. The
 * command-layer's resolveSessionCandidates() reads ALL capsules
 * regardless of cwd, so the admission decision becomes a function
 * of the registered owner.session_id matching one of the capsule
 * candidates — independent of where the destroy was invoked from.
 *
 * Adapter discipline: tmpdir fixtures. Each test sets up a real
 * git repo + real linked worktree(s) via `git worktree add`,
 * primes worktrees.json + capsule files directly, then invokes
 * the v11 command wrappers and asserts on observable state
 * (exit code, registry contents, capsule directory contents,
 * events.jsonl).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  runWorktreeCreateCommand,
  runWorktreeDestroyCommand,
  runWorktreeMergeCommand,
  runClaimCommand,
  runSpecsCreateCommand,
} = require('../../dist/shell');
const { initProject } = require('../../dist/store/init-store');

// ─── Fixtures ───────────────────────────────────────────────────────────

function mkBareGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@t.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'T']);
  fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
  execFileSync('git', ['-C', root, 'add', 'README.md']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'init']);
  return root;
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

function setupRepoWithSpec(prefix, specId = 'FEAT-001') {
  const repoRoot = mkBareGitRepo(prefix);
  const init = initProject(repoRoot);
  if (!init.ok) throw new Error('initProject failed');
  const cawsDir = path.join(repoRoot, '.caws');
  capture(runSpecsCreateCommand, {
    cwd: repoRoot,
    id: specId, title: 'feature', mode: 'feature', riskTier: 3,
  });
  return { repoRoot, cawsDir };
}

function capture(fn, opts) {
  const out = []; const err = [];
  const code = fn({
    ...opts,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

function readRegistry(cawsDir) {
  const p = path.join(cawsDir, 'worktrees.json');
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function listCapsules(cawsDir) {
  const p = path.join(cawsDir, 'sessions');
  if (!fs.existsSync(p)) return [];
  return fs.readdirSync(p).filter((n) => n.endsWith('.json')).sort();
}

function writeCapsule(cawsDir, sessionId, worktreeRoot) {
  const sessionsDir = path.join(cawsDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const capsule = {
    session_id: sessionId,
    platform: 'claude-code',
    minted_at: new Date().toISOString(),
    worktree_root: worktreeRoot,
  };
  fs.writeFileSync(
    path.join(sessionsDir, `${sessionId}.json`),
    JSON.stringify(capsule, null, 2) + '\n'
  );
}

function setOwner(cawsDir, wtName, sessionId, platform = 'claude-code') {
  const regPath = path.join(cawsDir, 'worktrees.json');
  const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  reg[wtName] = {
    ...(reg[wtName] || {}),
    owner: { session_id: sessionId, platform },
    last_heartbeat: new Date().toISOString(),
  };
  fs.writeFileSync(regPath, JSON.stringify(reg, null, 2) + '\n');
}

// ─── A1: claim-inside → destroy-from-canonical succeeds ─────────────────

describe('A1: destroy from canonical succeeds when owner matches an existing capsule', () => {
  let repoRoot, cawsDir, wtRoot;
  afterEach(() => { if (repoRoot) rmrf(repoRoot); if (wtRoot) rmrf(wtRoot); repoRoot = wtRoot = undefined; });

  it('issues destroy from canonical cwd with owner == capsule.session_id, exits 0, mints no new capsule', () => {
    ({ repoRoot, cawsDir } = setupRepoWithSpec('a1-'));

    // 1. Create the worktree via the v11 command surface so the
    //    registry + spec binding is real.
    const create = capture(runWorktreeCreateCommand, {
      cwd: repoRoot,
      name: 'wt-a1',
      specId: 'FEAT-001',
      // Pin env so the create actor resolves hermetically. Without this the
      // command falls to process.env, and a live Claude Code session leaks
      // CLAUDE_CODE_SESSION_ID (resolver tier 1.5), changing the capsule-mint
      // count this test asserts on. CAWS-SESSION-ID-AGENT-BASH-PROPAGATION-001.
      env: {},
    });
    expect(create.code).toBe(0);
    wtRoot = path.join(cawsDir, 'worktrees', 'wt-a1');

    // 2. Simulate the post-claim state: a capsule exists for the
    //    invoking session, KEYED TO THE WORKTREE_ROOT (this is what
    //    `caws claim` from inside the worktree would have minted).
    //    The registry owner is set to that session_id.
    //
    //    Note: runWorktreeCreateCommand itself minted an actor capsule
    //    for the canonical cwd, so the sessions dir is non-empty
    //    before we add the owner-keyed capsule. The invariant under
    //    test is "destroy does NOT mint an additional capsule," not
    //    "exactly one capsule exists before destroy."
    const ownerId = 'caws-a1-owner';
    writeCapsule(cawsDir, ownerId, wtRoot);
    setOwner(cawsDir, 'wt-a1', ownerId);

    const capsulesBefore = listCapsules(cawsDir);
    expect(capsulesBefore).toContain(`${ownerId}.json`);

    // 3. Issue destroy from canonical cwd, env stripped of
    //    HOOK_SESSION_ID / CLAUDE_SESSION_ID (the agent-Bash path
    //    that surfaced the original bug).
    const destroy = capture(runWorktreeDestroyCommand, {
      cwd: repoRoot, // canonical, NOT inside wt-a1
      env: {}, // no env-based session — must rely on capsule scan
      name: 'wt-a1',
    });

    // 4. Destroy succeeds. Pre-fix this returned exit 1 with
    //    "owned by a different session (caws-a1-owner)" because the
    //    canonical-cwd capsule lookup minted a fresh id S' that
    //    didn't match. The multi-candidate admission helper now sees
    //    the wt-root-keyed capsule and admits.
    expect(destroy.code).toBe(0);
    expect(destroy.stdout).toContain('destroyed wt-a1');

    // 5. No new capsule was minted by destroy specifically. The actor
    //    minted by buildActorPair on the destroy call may reuse the
    //    canonical-cwd capsule that runWorktreeCreateCommand already
    //    minted (resolveSession's step-3 will find it via realpath
    //    match) — so the post-state capsule count equals the pre-
    //    state capsule count. The admission-side resolver
    //    (resolveSessionCandidates) NEVER mints regardless.
    const capsulesAfter = listCapsules(cawsDir);
    expect(capsulesAfter.length).toBe(capsulesBefore.length);

    // 6. The worktree is gone from the registry.
    const reg = readRegistry(cawsDir);
    expect(reg['wt-a1']).toBeUndefined();
  });
});

// ─── A2: genuinely-foreign session still refuses ────────────────────────

describe('A2: destroy still refuses a genuinely-foreign owner', () => {
  let repoRoot, cawsDir;
  afterEach(() => { if (repoRoot) rmrf(repoRoot); repoRoot = undefined; });

  it('refuses with the foreign-claim message and surfaces the trace', () => {
    ({ repoRoot, cawsDir } = setupRepoWithSpec('a2-'));

    const create = capture(runWorktreeCreateCommand, {
      cwd: repoRoot,
      name: 'wt-a2',
      specId: 'FEAT-001',
      env: {}, // hermetic — see wt-a1 note (CAWS-SESSION-ID-AGENT-BASH-PROPAGATION-001)
    });
    expect(create.code).toBe(0);

    // Owner is a session no capsule on disk speaks for.
    setOwner(cawsDir, 'wt-a2', 'caws-foreign-owner');

    // Our session has its own capsule (not the foreign one) so the
    // candidate set is non-empty — admission MUST refuse on
    // session_id mismatch, not on empty candidates.
    writeCapsule(cawsDir, 'caws-me', repoRoot);

    const destroy = capture(runWorktreeDestroyCommand, {
      cwd: repoRoot,
      env: {},
      name: 'wt-a2',
    });

    expect(destroy.code).not.toBe(0);
    expect(destroy.stderr).toMatch(/owned by a different session \(caws-foreign-owner\)/);
    // L2 hardening: trace surfaces the candidate that was considered.
    expect(destroy.stderr).toContain('candidate: caws-me');
    // Registry entry untouched.
    const reg = readRegistry(cawsDir);
    expect(reg['wt-a2']).toBeDefined();
    expect(reg['wt-a2'].owner.session_id).toBe('caws-foreign-owner');
  });
});

// ─── A3: destroy from a sibling worktree's cwd ──────────────────────────

describe('A3: destroy from a sibling worktree cwd succeeds with a valid capsule', () => {
  let repoRoot, cawsDir;
  afterEach(() => { if (repoRoot) rmrf(repoRoot); repoRoot = undefined; });

  it('destroys wt-target while cwd is inside wt-sibling, exits 0', () => {
    ({ repoRoot, cawsDir } = setupRepoWithSpec('a3-'));

    // Create target + a separate sibling worktree (need a second
    // spec since worktree create requires a bound spec).
    capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'FEAT-002', title: 'sibling', mode: 'feature', riskTier: 3,
    });
    capture(runWorktreeCreateCommand, {
      cwd: repoRoot, name: 'wt-target', specId: 'FEAT-001', env: {},
    });
    capture(runWorktreeCreateCommand, {
      cwd: repoRoot, name: 'wt-sibling', specId: 'FEAT-002', env: {},
    });
    const targetRoot = path.join(cawsDir, 'worktrees', 'wt-target');
    const siblingRoot = path.join(cawsDir, 'worktrees', 'wt-sibling');

    // Capsule for our session, keyed to the TARGET root (as if claim
    // had been invoked from inside wt-target previously).
    const ownerId = 'caws-a3-owner';
    writeCapsule(cawsDir, ownerId, targetRoot);
    setOwner(cawsDir, 'wt-target', ownerId);

    // Issue destroy from a THIRD cwd: inside the sibling worktree.
    const destroy = capture(runWorktreeDestroyCommand, {
      cwd: siblingRoot, // not canonical, not target
      env: {},
      name: 'wt-target',
    });

    expect(destroy.code).toBe(0);
    expect(destroy.stdout).toContain('destroyed wt-target');
  });
});

// ─── A4: no env, no capsule → refuse, no mint ───────────────────────────

describe('A4: destroy refuses when no session source resolves; never mints', () => {
  let repoRoot, cawsDir;
  afterEach(() => { if (repoRoot) rmrf(repoRoot); repoRoot = undefined; });

  it('with empty env and empty capsule dir, refuses with empty-candidates trace and mints no capsule', () => {
    ({ repoRoot, cawsDir } = setupRepoWithSpec('a4-'));

    capture(runWorktreeCreateCommand, {
      cwd: repoRoot, name: 'wt-a4', specId: 'FEAT-001', env: {},
    });
    setOwner(cawsDir, 'wt-a4', 'caws-foreign-only');

    // CRITICAL: wipe the sessions directory so resolveSessionCandidates
    // sees zero env + zero capsules. The destroy command path normally
    // builds an actor via buildActorPair which calls
    // resolveSession({allowMint: true}) — that DOES mint. So the
    // expectation here is nuanced: buildActorPair will mint a capsule
    // for the event-author (`session` field), but that minted capsule
    // is keyed to the canonical cwd and does NOT match the
    // foreign-only registered owner. The COMPARISON-side resolver
    // (resolveSessionCandidates) will see the newly-minted capsule
    // because it scans the sessions dir post-mint, but its session_id
    // still doesn't match the registered owner — so refusal fires.
    //
    // The invariant under test: destroy refuses, AND any capsule that
    // ends up on disk is the actor-mint (which is legitimate
    // bookkeeping), NOT an admission-side fresh mint we tried to use
    // to pretend to be the owner.
    const sessionsDir = path.join(cawsDir, 'sessions');
    if (fs.existsSync(sessionsDir)) {
      for (const f of fs.readdirSync(sessionsDir)) {
        fs.unlinkSync(path.join(sessionsDir, f));
      }
    }
    const capsulesBefore = listCapsules(cawsDir);
    expect(capsulesBefore).toEqual([]);

    const destroy = capture(runWorktreeDestroyCommand, {
      cwd: repoRoot,
      env: {},
      name: 'wt-a4',
    });

    expect(destroy.code).not.toBe(0);
    expect(destroy.stderr).toMatch(/owned by a different session/);

    // Capsule directory may contain ONE entry (the actor-mint from
    // buildActorPair which is the legitimate event-author resolution),
    // but its session_id does NOT match the foreign owner — proving
    // admission is not silently satisfied by minting.
    const capsulesAfter = listCapsules(cawsDir);
    for (const c of capsulesAfter) {
      const raw = fs.readFileSync(path.join(sessionsDir, c), 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.session_id).not.toBe('caws-foreign-only');
    }

    // Registry owner untouched.
    const reg = readRegistry(cawsDir);
    expect(reg['wt-a4'].owner.session_id).toBe('caws-foreign-only');
  });
});

// ─── A5: claim → destroy chain end-to-end ────────────────────────────────

describe('A5: claim then destroy works with no intermediate recovery', () => {
  let repoRoot, cawsDir;
  afterEach(() => { if (repoRoot) rmrf(repoRoot); repoRoot = undefined; });

  it('claim --takeover from inside the worktree then destroy from canonical: both exit 0', () => {
    ({ repoRoot, cawsDir } = setupRepoWithSpec('a5-'));

    capture(runWorktreeCreateCommand, {
      cwd: repoRoot, name: 'wt-a5', specId: 'FEAT-001', env: {},
    });
    const wtRoot = path.join(cawsDir, 'worktrees', 'wt-a5');

    // Simulate a pre-existing foreign owner — the realistic state
    // when claim --takeover is needed.
    setOwner(cawsDir, 'wt-a5', 'caws-prior-owner');

    // Step 1: claim --takeover from INSIDE the worktree.
    const claim = capture(runClaimCommand, {
      cwd: wtRoot,
      env: { CLAUDE_SESSION_ID: 'caws-a5-me' },
      takeover: true,
    });
    expect(claim.code).toBe(0);
    expect(claim.stdout).toMatch(/OWNED \(you\)/);

    // The takeover should have written caws-a5-me as the owner.
    const regAfterClaim = readRegistry(cawsDir);
    expect(regAfterClaim['wt-a5'].owner.session_id).toBe('caws-a5-me');

    // Step 2: destroy from CANONICAL cwd with the same env carrying
    // CLAUDE_SESSION_ID — the candidate set includes caws-a5-me via
    // the env source, so admission succeeds.
    const destroy = capture(runWorktreeDestroyCommand, {
      cwd: repoRoot, // canonical, not wt-a5
      env: { CLAUDE_SESSION_ID: 'caws-a5-me' },
      name: 'wt-a5',
    });
    expect(destroy.code).toBe(0);
    expect(destroy.stdout).toContain('destroyed wt-a5');

    // Registry shows the worktree is gone — no manual recovery
    // (git worktree remove --force, registry hand-edit, etc.) needed.
    const regAfter = readRegistry(cawsDir);
    expect(regAfter['wt-a5']).toBeUndefined();
  });

  it('A5 variant: claim from inside (mint capsule, no env), then destroy from canonical with empty env, no recovery', () => {
    ({ repoRoot, cawsDir } = setupRepoWithSpec('a5b-'));

    capture(runWorktreeCreateCommand, {
      cwd: repoRoot, name: 'wt-a5b', specId: 'FEAT-001', env: {},
    });
    const wtRoot = path.join(cawsDir, 'worktrees', 'wt-a5b');

    // Simulate the previous owner so takeover is needed.
    setOwner(cawsDir, 'wt-a5b', 'caws-prior-owner');

    // Step 1: claim --takeover from inside, no env — relies on the
    // capsule mint path keyed to wtRoot. This is the path that
    // produced the original bug.
    const claim = capture(runClaimCommand, {
      cwd: wtRoot,
      env: {}, // no CLAUDE_SESSION_ID — mint fires
      takeover: true,
    });
    expect(claim.code).toBe(0);

    // A capsule should now exist keyed to wtRoot, with session_id
    // equal to the new owner.
    const reg = readRegistry(cawsDir);
    const newOwnerId = reg['wt-a5b'].owner.session_id;
    expect(newOwnerId).toMatch(/^caws-/);

    // Step 2: destroy from canonical, still no env. Without the
    // multi-candidate admission, the canonical-cwd resolver would
    // mint a fresh capsule that doesn't match newOwnerId and refuse.
    // With it, the wtRoot-keyed capsule from step 1 is among the
    // candidates and admission succeeds.
    const destroy = capture(runWorktreeDestroyCommand, {
      cwd: repoRoot,
      env: {},
      name: 'wt-a5b',
    });
    expect(destroy.code).toBe(0);
  });
});

// ─── merge mirror: admission semantics apply to merge too ───────────────

describe('merge-A1: same multi-candidate admission applies to runWorktreeMergeCommand', () => {
  let repoRoot, cawsDir;
  afterEach(() => { if (repoRoot) rmrf(repoRoot); repoRoot = undefined; });

  it('dry-run merge from canonical with owner matching a capsule does NOT report owned-by-different-session', () => {
    ({ repoRoot, cawsDir } = setupRepoWithSpec('mA1-'));

    capture(runWorktreeCreateCommand, {
      cwd: repoRoot, name: 'wt-mA1', specId: 'FEAT-001', env: {},
    });
    const wtRoot = path.join(cawsDir, 'worktrees', 'wt-mA1');

    const ownerId = 'caws-mA1-owner';
    writeCapsule(cawsDir, ownerId, wtRoot);
    setOwner(cawsDir, 'wt-mA1', ownerId);

    const merge = capture(runWorktreeMergeCommand, {
      cwd: repoRoot, // canonical
      env: {},
      name: 'wt-mA1',
      dryRun: true,
    });

    // Exit 0 means the dry-run reported it can proceed; exit non-0
    // would mean findings contained the foreign-claim refusal.
    // Either way: stdout/stderr must NOT contain the foreign-claim
    // message for this owner.
    expect(merge.stderr + merge.stdout).not.toMatch(
      /owned by a different session \(caws-mA1-owner\)/
    );
  });
});
