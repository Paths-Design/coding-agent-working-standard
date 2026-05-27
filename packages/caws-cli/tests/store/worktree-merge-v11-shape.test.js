/**
 * WORKTREE-MERGE-V11-SHAPE-001
 *
 * Regression lock: the v11 mergeWorktree writer accepts .caws/worktrees.json
 * in the v11 direct-key shape (`{<name>: {status, ...}, ...}`) and does NOT
 * route through the legacy v10 schema validator that demands the nested
 * `{version: 1, worktrees: {...}}` envelope.
 *
 * Origin: spec history. `caws worktree merge <name> --dry-run` crashed with
 *   Worktree registry has schema violations: [...]
 *   Cannot read properties of undefined (reading '<name>')
 * Diagnosis showed the failure was specific to @paths.design/caws-cli@10.2.0
 * (the npm-globally-installed legacy release whose loadRegistry validates
 * against worktrees.schema.json). The HEAD v11 source already uses the
 * shape-agnostic loadWorktrees and never returns the schema-violations
 * error. This test locks that contract so any future refactor that
 * accidentally re-routes mergeWorktree through legacy loadRegistry is
 * caught at CI time.
 *
 * Acceptance criteria covered:
 *   A1 — mergeWorktree on a v11-shaped registry returns dry_run with
 *        actual prerequisite findings (no schema-violations crash).
 *   A2 — fully-bound v11 entry on a clean worktree: canProceed=true,
 *        findings=[].
 *   A3 — v11 entry owned by a foreign session: canProceed=false,
 *        findings includes "owned by a different session"; writer
 *        does not crash.
 *
 * Hand-write the worktrees.json file directly (not via createWorktree)
 * so the test exercises loadWorktrees → mergeWorktree against the
 * literal on-disk v11 shape. createWorktree IS used in A2 as a parallel
 * proof that the production write path produces a registry that
 * round-trips through mergeWorktree successfully.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  createWorktree,
  mergeWorktree,
} = require('../../dist/store/worktrees-writer');
const { initProject } = require('../../dist/store/init-store');

const SESSION = { session_id: 'sess-v11-shape-test', platform: 'jest' };
const ACTOR = {
  kind: 'agent',
  id: 'test-agent',
  session_id: 'sess-v11-shape-test',
};
const FOREIGN_SESSION = { session_id: 'sess-foreign-owner', platform: 'jest' };

// Multi-candidate ownership-admission input for the writer
// (CAWS-WORKTREE-DESTROY-SESSION-RESOLUTION-001). For tests that
// previously passed a single `session`, this constant wraps that same
// identity as the only candidate — preserving the legacy
// "session_id-equality admit/refuse" semantic while satisfying the
// writer's new required input shape.
const SESSION_CANDIDATES = {
  candidates: [{ identity: SESSION, source: 'capsule' }],
  trace: [
    { source: 'claude_env', outcome: 'absent', reason: 'test fixture' },
    { source: 'hook_env', outcome: 'absent', reason: 'test fixture' },
    { source: 'capsule', outcome: 'admitted', count: 1 },
    { source: 'cursor_env', outcome: 'absent', reason: 'test fixture' },
  ],
};
const FOREIGN_SESSION_CANDIDATES = {
  candidates: [{ identity: FOREIGN_SESSION, source: 'capsule' }],
  trace: [
    { source: 'claude_env', outcome: 'absent', reason: 'test fixture' },
    { source: 'hook_env', outcome: 'absent', reason: 'test fixture' },
    { source: 'capsule', outcome: 'admitted', count: 1 },
    { source: 'cursor_env', outcome: 'absent', reason: 'test fixture' },
  ],
};

function mkRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', [
    '-C',
    root,
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'init',
  ]);
  return root;
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function setupCaws(repoRoot) {
  const result = initProject(repoRoot);
  if (!result.ok) {
    throw new Error('initProject failed: ' + JSON.stringify(result.errors));
  }
  return path.join(repoRoot, '.caws');
}

function writeActiveSpec(cawsDir, id, worktreeName) {
  const body = `id: ${id}
title: 'V11 shape regression target spec'
risk_tier: 3
mode: chore
lifecycle_state: active
created_at: '2026-05-23T00:00:00.000Z'
updated_at: '2026-05-23T00:00:00.000Z'
worktree: ${worktreeName}
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
  - 'fixture spec'
acceptance:
  - id: A1
    given: 'fixture'
    when: 'fixture'
    then: 'fixture'
non_functional:
  reliability:
    - 'fixture'
  performance:
    - 'fixture'
contracts: []
`;
  fs.writeFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), body);
}

/**
 * Write .caws/worktrees.json in the v11 direct-key shape, bypassing
 * createWorktree. This is the core fixture for A1 and A3: it proves
 * that mergeWorktree reads the v11 shape directly off disk without
 * any v10 envelope being present.
 */
function writeV11Registry(cawsDir, entries) {
  const filePath = path.join(cawsDir, 'worktrees.json');
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2) + '\n');
}

describe('WORKTREE-MERGE-V11-SHAPE-001 (v11 direct-key shape regression lock)', () => {
  let repo;
  let cawsDir;

  beforeEach(() => {
    repo = mkRepo('caws-v11shape-');
    cawsDir = setupCaws(repo);
  });

  afterEach(() => {
    rmrf(repo);
  });

  // ─────────────────────────────────────────────────────────────────
  // A1: a v11-shaped registry with a stub entry must NOT trigger
  // "Worktree registry has schema violations". mergeWorktree must
  // resolve the named entry and report real prerequisite findings.
  // ─────────────────────────────────────────────────────────────────

  test('A1: v11 direct-key registry produces structured findings, never schema-violations crash', () => {
    // Hand-written v11 shape: top-level keys ARE worktree names. No
    // {version, worktrees: ...} envelope. This is exactly the on-disk
    // form that crashed the v10.2.0 CLI.
    writeV11Registry(cawsDir, {
      'wt-a1': {
        specId: 'V11SHAPE-001',
        owner: { session_id: SESSION.session_id, platform: 'jest' },
        last_heartbeat: '2026-05-23T00:00:00.000Z',
        branch: 'wt-a1',
        baseBranch: 'main',
        // path intentionally absent: triggers worktreePathFor fallback,
        // which leads to "wtPath does not exist" check that does NOT
        // crash on the missing path — it just skips the dirty-check
        // branch. This is the dry-run prerequisite probe surface.
      },
    });

    const result = mergeWorktree(cawsDir, {
      name: 'wt-a1',
      session: SESSION,
      sessionCandidates: SESSION_CANDIDATES,
      actor: ACTOR,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('dry_run');
    expect(result.value.name).toBe('wt-a1');
    // findings is structured prerequisite output; the LACK of a
    // "schema violations" message is what proves the v11 contract.
    expect(Array.isArray(result.value.findings)).toBe(true);
    const findingsText = result.value.findings.join('\n');
    expect(findingsText).not.toMatch(/schema/i);
    expect(findingsText).not.toMatch(/Cannot read properties of undefined/i);
  });

  // ─────────────────────────────────────────────────────────────────
  // A2: createWorktree writes the v11 shape. A successful create
  // followed by mergeWorktree dry-run proves the write→read round-trip
  // works end-to-end. canProceed must be true (everything bound,
  // clean tree, owned by self).
  // ─────────────────────────────────────────────────────────────────

  test('A2: createWorktree → mergeWorktree dry-run round-trip: canProceed=true, findings=[]', () => {
    const specId = 'V11SHAPE-002';
    writeActiveSpec(cawsDir, specId, 'wt-a2');

    const createResult = createWorktree(cawsDir, {
      name: 'wt-a2',
      specId,
      session: SESSION,
      actor: ACTOR,
    });
    if (!createResult.ok) {
      throw new Error(
        'createWorktree failed: ' +
          JSON.stringify(createResult.errors, null, 2)
      );
    }
    expect(createResult.value.kind).toBe('success');

    // Verify createWorktree wrote the v11 direct-key shape (not the
    // v10 envelope). If this ever regresses to v10 shape, the rest of
    // the suite still passes for the wrong reason — assert here.
    const registry = JSON.parse(
      fs.readFileSync(path.join(cawsDir, 'worktrees.json'), 'utf8')
    );
    expect(registry).toHaveProperty('wt-a2');
    expect(registry).not.toHaveProperty('version');
    expect(registry).not.toHaveProperty('worktrees');
    expect(registry['wt-a2']).toHaveProperty('specId', specId);

    const result = mergeWorktree(cawsDir, {
      name: 'wt-a2',
      session: SESSION,
      sessionCandidates: SESSION_CANDIDATES,
      actor: ACTOR,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('dry_run');
    expect(result.value.canProceed).toBe(true);
    expect(result.value.findings).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────
  // A3: a v11 entry with a foreign owner reports the ownership finding.
  // Proves the writer reads `entry.owner.session_id` correctly off the
  // direct-key shape — a structural access that crashed on the v10
  // path when the entry lookup failed.
  // ─────────────────────────────────────────────────────────────────

  test('A3: foreign-owned v11 entry produces "owned by a different session" finding without crash', () => {
    writeV11Registry(cawsDir, {
      'wt-a3': {
        specId: 'V11SHAPE-003',
        owner: {
          session_id: FOREIGN_SESSION.session_id,
          platform: FOREIGN_SESSION.platform,
        },
        last_heartbeat: '2026-05-23T00:00:00.000Z',
        branch: 'wt-a3',
        baseBranch: 'main',
      },
    });

    const result = mergeWorktree(cawsDir, {
      name: 'wt-a3',
      session: SESSION, // local session, not the foreign owner
      sessionCandidates: SESSION_CANDIDATES, // local candidates, not foreign
      actor: ACTOR,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('dry_run');
    expect(result.value.canProceed).toBe(false);
    const findingsText = result.value.findings.join('\n');
    expect(findingsText).toMatch(
      /owned by a different session.*sess-foreign-owner/
    );
    // Negative: no schema-violations leakage on the foreign-owner path.
    expect(findingsText).not.toMatch(/schema/i);
  });
});
