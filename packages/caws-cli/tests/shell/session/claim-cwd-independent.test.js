'use strict';

/**
 * A directory switch alone is not a witness that the caller owns a capsule
 * minted elsewhere. Preserve the old fixture as a refusal control. The actual
 * create -> emitted continuation -> enter path is exercised through the built
 * CLI in worktree-create-enter.test.js.
 *
 * SUT: compiled surface — require('../../../dist/shell/commands/claim').
 * `npm run build` compiles TS -> dist before jest runs.
 *
 * Coverage:
 *   A1  owner capsule keyed to another cwd without current identity => refuse
 *       without minting or changing ownership.
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
function runClaimFrom(cwd, cawsDir, extraEnv = {}) {
  const out = [];
  const err = [];
  const code = runClaimCommand({
    cwd,
    now: () => new Date('2026-07-30T12:00:00.000Z'),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      // Explicitly ABSENT identity env vars — forces the resolver off the
      // tier-1 env path and onto the capsule/candidate path under test.
      CLAUDE_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      CODEX_THREAD_ID: '',
      CAWS_SESSION_ID: '',
      HOOK_SESSION_ID: '',
      CURSOR_TRACE_ID: '',
      CAWS_PROJECT_DIR: path.dirname(cawsDir),
      ...extraEnv,
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('SESSION-CAPSULE-WORKTREE-CWD-001 — claim cwd-independent recognition', () => {
  test('A1: a capsule from another cwd cannot establish the caller and claim never mints to compare ownership', () => {
    const ownerSession = 'caws-aaa111';
    const { root, cawsDir, wtPath } = setupRepo({ ownerSession });

    // This fixture has no native process/env continuity and never executed
    // create. A neighboring capsule alone cannot prove same-session entry.
    writeCapsule(cawsDir, ownerSession, root);
    const beforeCapsules = fs.readdirSync(path.join(cawsDir, 'sessions')).sort();
    const beforeRegistry = fs.readFileSync(path.join(cawsDir, 'worktrees.json'), 'utf8');

    const result = runClaimFrom(wtPath, cawsDir);

    expect(result.code).toBe(2);
    expect(result.err).toContain('session identity');
    expect(result.out).not.toContain('OWNED (you)');
    expect(fs.readdirSync(path.join(cawsDir, 'sessions')).sort()).toEqual(beforeCapsules);
    expect(fs.readFileSync(path.join(cawsDir, 'worktrees.json'), 'utf8')).toBe(beforeRegistry);
  });

  test('A2: a genuine foreign owner (no corroborating capsule) is still refused', () => {
    const ownerSession = 'caws-foreign222';
    const { cawsDir, wtPath } = setupRepo({ ownerSession });

    // The invoking identity differs from the registry owner and has no
    // corroboration for that owner. The refusal remains a domain failure.
    const result = runClaimFrom(wtPath, cawsDir, { CAWS_SESSION_ID: 'caller-session' });

    expect(result.code).toBe(1);
    expect(result.err).toContain('foreign_owner_blocked');
  });

  test('A1 (no-env control): with CAWS_SESSION_ID corroborating the owner, claim is recognized (the documented escape still works)', () => {
    // Explicit context identifies the caller across directories; it is the
    // continuity source used by the fallback continuation printed by create.
    const ownerSession = 'caws-bbb333';
    const { root, cawsDir, wtPath } = setupRepo({ ownerSession });
    writeCapsule(cawsDir, ownerSession, root);

    const out = [];
    const err = [];
    const code = runClaimCommand({
      cwd: wtPath,
      now: () => new Date('2026-07-30T12:00:00Z'),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
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
