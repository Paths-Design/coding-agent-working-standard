'use strict';

/**
 * SESSION-CAPSULE-WORKTREE-CWD-001 — caws claim resolves "the current session"
 * through the cwd-independent candidate set, so an agent that creates a
 * worktree from one directory and runs `caws claim` from another (the
 * documented create-then-enter flow) is recognized as the owner without
 * --takeover.
 *
 * Root cause being closed: claim was the only ownership surface that resolved
 * identity through single-identity resolveSession (cwd-keyed capsule tier) and
 * compared via the single-session assertOwnership. merge/bind/destroy already
 * built the cwd-independent resolveSessionCandidates set and admitted via
 * admitsOwner. claim now threads that same candidate set into assertOwnership.
 *
 * SUT: compiled surface — require('../../../dist/shell/commands/claim').
 * `npm run build` compiles TS -> dist before jest runs.
 *
 * Coverage:
 *   A1  create-then-enter: owner capsule keyed to repo root, claim from inside
 *       the worktree (different cwd), no per-surface env var => recognized as
 *       owner (exit 0), NO --takeover required.
 *   A2  genuine foreign owner (no corroborating capsule) => still refused
 *       (foreign-owner diagnostic), unchanged.
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

// Write a CAWS capsule (the TS resolver's tier-3 authority + a candidate-set
// source). Shape mirrors mintCapsule: {session_id, platform, minted_at,
// worktree_root}. Keyed to `worktreeRoot` — the cwd the identity was minted
// FROM. resolveSession's tier-3 readCapsule only matches when this equals the
// resolver's worktreeRoot arg; resolveSessionCandidates/readAllCapsules reads
// EVERY capsule regardless of worktree_root.
function writeCapsule(cawsDir, sessionId, worktreeRoot, platform = 'zcode') {
  const sessionsDir = path.join(cawsDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, `${sessionId}.json`),
    JSON.stringify(
      {
        session_id: sessionId,
        platform,
        minted_at: '2026-07-30T10:00:00.000Z',
        worktree_root: worktreeRoot,
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
      owner: { session_id: ownerSession, platform: 'zcode' },
      last_heartbeat: '2026-07-30T11:45:00.000Z',
    },
  });
  return { root, cawsDir, wtPath };
}

// Run claim with NO per-surface env-var identity source — the real agent-Bash
// scenario where CLAUDE_SESSION_ID etc. do not propagate into the subshell.
// This is the path that, before the fix, minted a fresh id and forced
// --takeover. CAWS_PROJECT_DIR is set so the resolver can locate .caws.
function runClaimFrom(cwd, cawsDir) {
  const out = [];
  const err = [];
  const code = runClaimCommand({
    cwd,
    now: () => new Date('2026-07-30T12:00:00.000Z'),
    env: {
      ...process.env,
      // Explicitly ABSENT identity env vars — forces the resolver off the
      // tier-1 env path and onto the capsule/candidate path under test.
      CLAUDE_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      CODEX_THREAD_ID: '',
      CAWS_SESSION_ID: '',
      HOOK_SESSION_ID: '',
      CURSOR_TRACE_ID: '',
      CAWS_PROJECT_DIR: path.dirname(cawsDir),
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('SESSION-CAPSULE-WORKTREE-CWD-001 — claim cwd-independent recognition', () => {
  test('A1: claim from inside the worktree recognizes an owner minted from the repo root (no --takeover)', () => {
    const ownerSession = 'caws-aaa111';
    const { root, cawsDir, wtPath } = setupRepo({ ownerSession });

    // The owner identity was minted FROM THE REPO ROOT (e.g. when the worktree
    // was created there), so its capsule is keyed to `root`, NOT to wtPath.
    // A claim run from inside the worktree (cwd = wtPath) cannot match this
    // capsule via the cwd-keyed tier-3 readCapsule — but the cwd-independent
    // candidate set finds it and assertOwnership admits the owner.
    writeCapsule(cawsDir, ownerSession, root);

    const result = runClaimFrom(wtPath, cawsDir);

    expect(result.code).toBe(0);
    expect(result.out).toContain('OWNED (you)');
    expect(result.err).not.toContain('foreign_owner_blocked');
    expect(result.err).not.toContain('takeover not authorized');
  });

  test('A2: a genuine foreign owner (no corroborating capsule) is still refused', () => {
    const ownerSession = 'caws-foreign222';
    const { cawsDir, wtPath } = setupRepo({ ownerSession });

    // No capsule for the foreign owner; the only capsule is this process's own
    // fresh mint (written by the resolver on the claim call). The candidate
    // set does NOT contain the foreign owner, so admission must fail.
    // (We deliberately do not write a capsule for ownerSession.)
    const result = runClaimFrom(wtPath, cawsDir);

    expect(result.code).toBe(1);
    expect(result.err).toContain('foreign_owner_blocked');
  });

  test('A1 (no-env control): with CAWS_SESSION_ID corroborating the owner, claim is recognized (the documented escape still works)', () => {
    // Sanity: the pre-existing tier-1.7 CAWS_SESSION_ID path still admits the
    // owner when set. This confirms the new candidate path is ADDITIVE, not a
    // replacement, and that the A1 success above is specifically the
    // no-env-var candidate path, not this env path leaking through.
    const ownerSession = 'caws-bbb333';
    const { root, cawsDir, wtPath } = setupRepo({ ownerSession });
    writeCapsule(cawsDir, ownerSession, root);

    const out = [];
    const err = [];
    const code = runClaimCommand({
      cwd: wtPath,
      now: () => new Date('2026-07-30T12:00:00Z'),
      env: {
        ...process.env,
        CLAUDE_SESSION_ID: '',
        CLAUDE_CODE_SESSION_ID: '',
        CODEX_THREAD_ID: '',
        CAWS_SESSION_ID: ownerSession,
        HOOK_SESSION_ID: '',
        CURSOR_TRACE_ID: '',
        CAWS_PROJECT_DIR: path.dirname(cawsDir),
      },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('OWNED (you)');
  });
});
