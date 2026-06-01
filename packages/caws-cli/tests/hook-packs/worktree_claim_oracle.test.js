/**
 * @fileoverview WORKTREE-ISOLATION-HARDENING-001 — the shared
 * worktree-claim-oracle.js decision logic.
 *
 * The oracle is the single ownership authority shelled out to by BOTH
 * worktree-write-guard.sh (Write/Edit) and bash-write-guard.sh (Bash mutation
 * target). It takes a candidate path + the operating session via CAWS_ORACLE_*
 * env vars, reads the canonical worktrees.json + active bound specs, and prints
 * one of the closed-set outcomes:
 *   pass | block_claimed | block_foreign_worktree | ask_uncertain | error_fail_closed
 *
 * These tests exercise the oracle DIRECTLY (node <oracle>) against synthetic
 * registry+spec fixtures. The guard integration (the .caws/worktrees/* allowlist
 * arm routing into the oracle) is covered by the guard's own subprocess test.
 *
 * Decision matrix under test (maintainer directive — physical root matters):
 *   canonical root + claimed scope.in path   -> block_claimed (session-INDEPENDENT)
 *   .caws/worktrees/<own>/<rest>             -> pass (op session == owner)
 *   .caws/worktrees/<foreign>/<rest>         -> block_foreign_worktree
 *   scope.support path                       -> never claimed (pass)
 *
 * @author @darianrosebrook
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ORACLE = path.join(
  REPO_ROOT,
  'packages', 'caws-cli', 'templates', 'hook-packs', 'claude-code', 'lib',
  'worktree-claim-oracle.js'
);

/** Build a throwaway .caws control plane (no git needed — oracle reads files). */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-oracle-'));
  fs.mkdirSync(path.join(dir, '.caws', 'specs'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.caws', 'worktrees'), { recursive: true });
  return dir;
}

/** Write worktrees.json (v11 flat-map). Materializes each entry's worktree dir
 * so the oracle's dir-existence (ghost) filter keeps it live. */
function writeRegistry(dir, entries) {
  for (const name of Object.keys(entries)) {
    const e = entries[name];
    const wtPath = e.path || path.join(dir, '.caws', 'worktrees', name);
    fs.mkdirSync(wtPath, { recursive: true });
    if (!e.path) e.path = wtPath;
  }
  fs.writeFileSync(
    path.join(dir, '.caws', 'worktrees.json'),
    JSON.stringify(entries, null, 2)
  );
}

function writeSpec(dir, id, { lifecycle = 'active', scopeIn = [], scopeOut = [], scopeSupport = [] }) {
  const lines = [
    `id: ${id}`,
    `title: '${id} fixture'`,
    'risk_tier: 3',
    'mode: refactor',
    `lifecycle_state: ${lifecycle}`,
    'scope:',
    '  in:',
    ...(scopeIn.length ? scopeIn.map((p) => `    - ${p}`) : ['    - packages/nothing']),
  ];
  if (scopeOut.length) {
    lines.push('  out:', ...scopeOut.map((p) => `    - ${p}`));
  }
  if (scopeSupport.length) {
    lines.push('  support:', ...scopeSupport.map((p) => `    - ${p}`));
  }
  fs.writeFileSync(path.join(dir, '.caws', 'specs', `${id}.yaml`), lines.join('\n') + '\n');
}

/** Invoke the oracle. Returns { outcome, detail, raw, status }. */
function oracle(dir, relPath, sessionId, { branch = 'main' } = {}) {
  const r = spawnSync('node', [ORACLE], {
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      CAWS_ORACLE_PROJECT_DIR: dir,
      CAWS_ORACLE_CURRENT_BRANCH: branch,
      CAWS_ORACLE_REL_PATH: relPath,
      CAWS_ORACLE_SESSION_ID: sessionId,
    },
  });
  const raw = (r.stdout || '').trim();
  const idx = raw.indexOf(':');
  return {
    outcome: idx >= 0 ? raw.slice(0, idx) : raw,
    detail: idx >= 0 ? raw.slice(idx + 1) : '',
    raw,
    status: r.status,
  };
}

const OWNER = 'session-owner-AAA';
const FOREIGN = 'session-foreign-ZZZ';

describe('worktree-claim-oracle: physical-root-aware ownership', () => {
  let dir;
  afterEach(() => {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function setupOneWorktree() {
    dir = makeRepo();
    writeRegistry(dir, {
      'wt-a': {
        spec_id: 'CLAIM-001', branch: 'wt-a', baseBranch: 'main',
        owner: { session_id: OWNER, platform: 'claude-code' },
      },
    });
    writeSpec(dir, 'CLAIM-001', {
      lifecycle: 'active',
      scopeIn: ['packages/caws-cli/src/target.ts'],
      scopeSupport: ['SHARED-NOTES.md'],
    });
  }

  test('foreign session writing .caws/worktrees/<other>/file -> block_foreign_worktree', () => {
    setupOneWorktree();
    const r = oracle(dir, '.caws/worktrees/wt-a/src/x.ts', FOREIGN);
    expect(r.outcome).toBe('block_foreign_worktree');
    expect(r.detail).toMatch(/^wt-a:/);
    expect(r.detail).toContain(OWNER);
  });

  test('owner session writing .caws/worktrees/<own>/file -> pass', () => {
    setupOneWorktree();
    const r = oracle(dir, '.caws/worktrees/wt-a/src/x.ts', OWNER);
    expect(r.outcome).toBe('pass');
    expect(r.detail).toMatch(/owner-self/);
  });

  test('canonical-root claimed scope.in path -> block_claimed REGARDLESS of session (owner)', () => {
    setupOneWorktree();
    // Even the OWNER writing the claimed path at the CANONICAL root is blocked:
    // the canonical-root protection is session-independent and must not relax.
    const r = oracle(dir, 'packages/caws-cli/src/target.ts', OWNER);
    expect(r.outcome).toBe('block_claimed');
    expect(r.detail).toMatch(/^wt-a:/);
  });

  test('canonical-root claimed scope.in path -> block_claimed (foreign too)', () => {
    setupOneWorktree();
    const r = oracle(dir, 'packages/caws-cli/src/target.ts', FOREIGN);
    expect(r.outcome).toBe('block_claimed');
  });

  test('scope.support path is never worktree-claimed -> pass', () => {
    setupOneWorktree();
    const r = oracle(dir, 'SHARED-NOTES.md', FOREIGN);
    expect(r.outcome).toBe('pass');
    expect(r.detail).toBe('unclaimed');
  });

  test('absolute canonical path normalizes and still blocks claimed', () => {
    setupOneWorktree();
    const abs = path.join(dir, 'packages/caws-cli/src/target.ts');
    const r = oracle(dir, abs, FOREIGN);
    expect(r.outcome).toBe('block_claimed');
  });

  test('unclaimed canonical path -> pass', () => {
    setupOneWorktree();
    const r = oracle(dir, 'packages/caws-cli/src/unrelated.ts', FOREIGN);
    expect(r.outcome).toBe('pass');
    expect(r.detail).toBe('unclaimed');
  });

  test('write to .caws/worktrees/<destroyed-not-in-registry>/ -> ask_uncertain', () => {
    setupOneWorktree();
    // clash-c-style: path looks like worktree payload but no live registry entry.
    const r = oracle(dir, '.caws/worktrees/wt-gone/src/x.ts', FOREIGN);
    expect(r.outcome).toBe('ask_uncertain');
    expect(r.detail).toMatch(/worktree-payload-no-entry/);
  });

  test('worktree payload under an entry with NO owner stamped -> ask_uncertain (fail closed)', () => {
    dir = makeRepo();
    writeRegistry(dir, {
      'wt-noowner': { spec_id: 'CLAIM-002', branch: 'wt-noowner', baseBranch: 'main' },
    });
    writeSpec(dir, 'CLAIM-002', { lifecycle: 'active', scopeIn: ['packages/x.ts'] });
    const r = oracle(dir, '.caws/worktrees/wt-noowner/src/x.ts', OWNER);
    expect(r.outcome).toBe('ask_uncertain');
    expect(r.detail).toMatch(/worktree-payload-no-owner/);
  });

  test('no registry -> pass (genuinely unguarded base state)', () => {
    dir = makeRepo();
    fs.rmSync(path.join(dir, '.caws', 'worktrees.json'), { force: true });
    const r = oracle(dir, 'packages/caws-cli/src/target.ts', FOREIGN);
    expect(r.outcome).toBe('pass');
    expect(r.detail).toBe('no-registry');
  });

  test('draft-bound spec does NOT confer a canonical-root claim -> pass', () => {
    dir = makeRepo();
    writeRegistry(dir, {
      'wt-d': {
        spec_id: 'CLAIM-003', branch: 'wt-d', baseBranch: 'main',
        owner: { session_id: OWNER, platform: 'claude-code' },
      },
    });
    writeSpec(dir, 'CLAIM-003', { lifecycle: 'draft', scopeIn: ['packages/caws-cli/src/target.ts'] });
    const r = oracle(dir, 'packages/caws-cli/src/target.ts', FOREIGN);
    expect(r.outcome).toBe('pass');
  });

  test('missing input -> error_fail_closed', () => {
    dir = makeRepo();
    const r = spawnSync('node', [ORACLE], {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, CAWS_ORACLE_PROJECT_DIR: dir, CAWS_ORACLE_REL_PATH: '' },
    });
    expect((r.stdout || '').trim()).toMatch(/^error_fail_closed:/);
  });
});
