/**
 * @fileoverview WORKTREE-ISOLATION-HARDENING-001 (Fix 4) — bindWorktreeRepair
 * foreign-owner guard + --steal --reason + worktree_ownership_seized audit.
 *
 * D2: bind previously stamped owner UNCONDITIONALLY, so a foreign session could
 * silently steal a worktree by re-binding it. Now:
 *   - foreign owner, no --steal              -> REFUSE (LIFECYCLE_PLAN_REJECTED)
 *   - foreign owner, --steal without reason  -> REFUSE (non-empty reason required)
 *   - foreign owner, --steal + reason        -> SUCCEED + worktree_ownership_seized event
 *   - same owner (admitted candidate)        -> succeed (normal repair)
 * Decoupled from owner liveness — keys only on "owner exists & does not admit".
 *
 * Loads the BUILT dist (../../dist), so this runs on canonical post-build (the
 * worktree's sparse node_modules cannot resolve ts-jest / the fresh dist).
 *
 * @author @darianrosebrook
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createWorktree, bindWorktreeRepair } = require('../../dist/store/worktrees-writer');
const { initProject } = require('../../dist/store/init-store');

const OWNER = { session_id: 'sess-owner-A', platform: 'jest' };
const OWNER_ACTOR = { kind: 'agent', id: 'agent-A', session_id: 'sess-owner-A' };
const FOREIGN = { session_id: 'sess-foreign-B', platform: 'jest' };
const FOREIGN_ACTOR = { kind: 'agent', id: 'agent-B', session_id: 'sess-foreign-B' };

/** A SessionCandidates literal whose only candidate is `sid`. */
function candidatesFor(sid, platform = 'jest') {
  return {
    candidates: [{ identity: { session_id: sid, platform }, source: 'claude_code_env' }],
    trace: [{ source: 'claude_code_env', outcome: 'admitted', count: 1, sessionIds: [sid] }],
  };
}

function mkRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-bind-steal-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', root, 'add', 'README.md']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'init']);
  return root;
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

function writeActiveSpec(cawsDir, id) {
  const body = `id: ${id}
title: '${id} bind-steal fixture'
risk_tier: 3
mode: chore
lifecycle_state: active
created_at: '2026-05-31T00:00:00.000Z'
updated_at: '2026-05-31T00:00:00.000Z'
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
non_functional:
  reliability:
    - 'fixture'
contracts: []
`;
  fs.writeFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), body);
}

function readEvents(cawsDir) {
  const p = path.join(cawsDir, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('WORKTREE-ISOLATION-HARDENING-001 Fix 4: bind foreign-owner guard + steal', () => {
  let repo;
  let cawsDir;

  beforeEach(() => {
    repo = mkRepo();
    const r = initProject(repo);
    if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
    cawsDir = path.join(repo, '.caws');
    writeActiveSpec(cawsDir, 'BIND-001');
    // Owner A creates+owns the worktree.
    const created = createWorktree(cawsDir, {
      name: 'wt-x', specId: 'BIND-001', session: OWNER, actor: OWNER_ACTOR,
    });
    if (!created.ok) throw new Error('createWorktree failed: ' + JSON.stringify(created.errors));
  });

  afterEach(() => rmrf(repo));

  test('foreign session bind WITHOUT --steal -> REFUSE', () => {
    const r = bindWorktreeRepair(cawsDir, {
      name: 'wt-x', specId: 'BIND-001', session: FOREIGN,
      sessionCandidates: candidatesFor(FOREIGN.session_id), actor: FOREIGN_ACTOR,
    });
    expect(r.ok).toBe(false);
    const msg = JSON.stringify(r.errors);
    expect(msg).toMatch(/owned by a different session/);
    expect(msg).toMatch(/--steal --reason/);
  });

  test('foreign session bind --steal WITHOUT reason -> REFUSE', () => {
    const r = bindWorktreeRepair(cawsDir, {
      name: 'wt-x', specId: 'BIND-001', session: FOREIGN,
      sessionCandidates: candidatesFor(FOREIGN.session_id), actor: FOREIGN_ACTOR,
      steal: true, stealReason: '   ',
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.errors)).toMatch(/--steal --reason/);
  });

  test('foreign session bind --steal --reason -> SUCCEED + worktree_ownership_seized event', () => {
    const r = bindWorktreeRepair(cawsDir, {
      name: 'wt-x', specId: 'BIND-001', session: FOREIGN,
      sessionCandidates: candidatesFor(FOREIGN.session_id), actor: FOREIGN_ACTOR,
      steal: true, stealReason: 'prior owner abandoned; taking over for incident response',
    });
    expect(r.ok).toBe(true);
    expect(r.value.kind).toBe('success');

    const seized = readEvents(cawsDir).filter((e) => e.event === 'worktree_ownership_seized');
    expect(seized).toHaveLength(1);
    expect(seized[0].data.worktree_name).toBe('wt-x');
    expect(seized[0].data.prior_owner_session_id).toBe(OWNER.session_id);
    expect(seized[0].data.new_owner_session_id).toBe(FOREIGN.session_id);
    expect(seized[0].data.reason).toMatch(/incident response/);
    expect(seized[0].spec_id).toBe('BIND-001');

    // Registry owner is now the foreign (now-owning) session.
    const reg = JSON.parse(fs.readFileSync(path.join(cawsDir, 'worktrees.json'), 'utf8'));
    expect(reg['wt-x'].owner.session_id).toBe(FOREIGN.session_id);
  });

  test('owner session re-bind (admitted candidate) -> SUCCEED, no seizure event', () => {
    const r = bindWorktreeRepair(cawsDir, {
      name: 'wt-x', specId: 'BIND-001', session: OWNER,
      sessionCandidates: candidatesFor(OWNER.session_id), actor: OWNER_ACTOR,
    });
    expect(r.ok).toBe(true);
    expect(r.value.kind).toBe('success');
    const seized = readEvents(cawsDir).filter((e) => e.event === 'worktree_ownership_seized');
    expect(seized).toHaveLength(0);
  });
});
