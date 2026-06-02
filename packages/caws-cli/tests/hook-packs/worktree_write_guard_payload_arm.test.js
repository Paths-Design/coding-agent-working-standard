/**
 * @fileoverview WORKTREE-ISOLATION-HARDENING-001 (Fix 1+2) — proves
 * worktree-write-guard.sh ROUTES .caws/worktrees/<name>/<rest> writes through
 * the ownership oracle instead of allowlisting them.
 *
 * This is the integration the oracle unit test (worktree_claim_oracle.test.js)
 * does NOT cover: that the guard's allowlist arm actually intercepts a
 * .caws/worktrees/* path BEFORE the broad .caws/* exit-0 arm, calls the oracle,
 * and acts on the outcome. Before this slice the clash probe showed a foreign
 * session writing into another worktree's payload sailed through the .caws/*
 * allowlist (exit 0). After: a foreign write hard-blocks (exit 2), an owner
 * write passes (exit 0).
 *
 * Harness: build an isolated git repo with the guard + lib + the oracle
 * installed, a .caws/ control plane (worktrees.json with a session-stamped
 * owner + the bound spec), and invoke worktree-write-guard.sh as a real
 * subprocess with the operating session_id varied via the hook input payload.
 *
 * @author @darianrosebrook
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PACK = path.join(REPO_ROOT, 'packages', 'caws-cli', 'templates', 'hook-packs', 'claude-code');

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r;
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-wgpayload-'));
  sh('git', ['init', '-q', '-b', 'main'], dir);
  sh('git', ['config', 'user.email', 'test@example.com'], dir);
  sh('git', ['config', 'user.name', 'test'], dir);

  fs.mkdirSync(path.join(dir, '.claude', 'hooks', 'lib'), { recursive: true });
  fs.copyFileSync(
    path.join(PACK, 'worktree-write-guard.sh'),
    path.join(dir, '.claude', 'hooks', 'worktree-write-guard.sh')
  );
  fs.copyFileSync(
    path.join(PACK, 'runtime-paths.sh'),
    path.join(dir, '.claude', 'hooks', 'runtime-paths.sh')
  );
  for (const f of ['parse-input.sh', 'caws-state.sh', 'emit.sh', 'guard-message.sh']) {
    fs.copyFileSync(path.join(PACK, 'lib', f), path.join(dir, '.claude', 'hooks', 'lib', f));
  }
  // The new oracle helper — the whole point of this test.
  fs.copyFileSync(
    path.join(PACK, 'lib', 'worktree-claim-oracle.cjs'),
    path.join(dir, '.claude', 'hooks', 'lib', 'worktree-claim-oracle.cjs')
  );

  fs.mkdirSync(path.join(dir, '.caws', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  sh('git', ['add', '-A'], dir);
  sh('git', ['commit', '-qm', 'init'], dir);
  return dir;
}

function writeRegistry(dir, entries) {
  for (const name of Object.keys(entries)) {
    const e = entries[name];
    const wtPath = e.path || path.join(dir, '.caws', 'worktrees', name);
    fs.mkdirSync(wtPath, { recursive: true });
    if (!e.path) e.path = wtPath;
  }
  fs.writeFileSync(path.join(dir, '.caws', 'worktrees.json'), JSON.stringify(entries, null, 2));
}

function writeSpec(dir, id, { lifecycle = 'active', scopeIn = [] }) {
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
  fs.writeFileSync(path.join(dir, '.caws', 'specs', `${id}.yaml`), lines.join('\n') + '\n');
}

/** Invoke the guard for a Write of relFile, as operating session `sessionId`. */
function guard(dir, relFile, sessionId, extraEnv = {}) {
  const input = JSON.stringify({
    tool_name: 'Write',
    tool_input: { file_path: path.join(dir, relFile) },
    cwd: dir,
    session_id: sessionId,
  });
  return spawnSync('bash', [path.join(dir, '.claude', 'hooks', 'worktree-write-guard.sh')], {
    input,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...extraEnv },
  });
}

const OWNER = 'session-owner-AAA';
const FOREIGN = 'session-foreign-ZZZ';

describe('WORKTREE-ISOLATION-HARDENING-001 Fix 1+2: .caws/worktrees payload arm', () => {
  let dir;
  afterEach(() => {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function setup() {
    dir = makeRepo();
    writeRegistry(dir, {
      'wt-owned': {
        spec_id: 'OWN-001', branch: 'wt-owned', baseBranch: 'main',
        owner: { session_id: OWNER, platform: 'claude-code' },
      },
    });
    writeSpec(dir, 'OWN-001', { lifecycle: 'active', scopeIn: ['src/owned.ts'] });
  }

  test('FOREIGN session Write into .caws/worktrees/<owned>/file -> HARD BLOCK (exit 2)', () => {
    setup();
    const r = guard(dir, '.caws/worktrees/wt-owned/src/owned.ts', FOREIGN);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/worktree-write-guard/);
    expect(r.stderr).toMatch(/wt-owned/);
    expect(r.stderr).toMatch(/owned by a DIFFERENT session/);
  });

  test('OWNER session Write into .caws/worktrees/<owned>/file -> ALLOW (exit 0)', () => {
    setup();
    const r = guard(dir, '.caws/worktrees/wt-owned/src/owned.ts', OWNER);
    expect(r.status).toBe(0);
  });

  test('control-plane .caws/specs path is still allowlisted (exit 0)', () => {
    setup();
    // A .caws/ path that is NOT under worktrees/ must keep riding the allowlist.
    const r = guard(dir, '.caws/agents.json', FOREIGN);
    expect(r.status).toBe(0);
  });

  test('payload write to a destroyed/unknown worktree -> ask or block, never silent allow', () => {
    setup();
    // ask-incapable harness so the fail-closed path degrades to a hard block we
    // can assert deterministically (exit 2), proving no silent allow.
    const r = guard(dir, '.caws/worktrees/wt-gone/src/x.ts', FOREIGN, { CAWS_GUARD_NO_ASK: '1' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/ownership could not be confirmed/);
  });
});
