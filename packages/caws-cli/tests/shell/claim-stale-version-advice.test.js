/**
 * CAWS-STALE-VERSION-ADVICE-DIAGNOSTICS-01 regression test for the
 * one CLI-side stale-advice site: caws claim invoked outside any
 * CAWS-tracked worktree.
 *
 * Bug-003 symptom (from the rehearsal report):
 *   `caws claim` from a v11-tracked repo root emitted:
 *     "v11.0.0 does not ship worktree lifecycle commands; create the
 *      worktree externally ... pin to caws-cli@^10.2.x."
 *   This advice would direct a user to downgrade to a v10.2 CLI that
 *   itself has multiple defects (per the recon's v10.2 findings).
 *
 * The fix replaces the diagnostic with current v11.1 advice that
 * names `caws worktree create` and `caws worktree list`.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runClaimCommand } = require('../../dist/shell');

function mkRepo(prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 't']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  // Minimal .caws/ — tracked repo, but no worktrees registered.
  fs.mkdirSync(path.join(root, '.caws', 'specs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.caws', 'policy.yaml'),
    'schema_version: 1\ngates:\n  coverage_threshold:\n    mode: warn\n'
  );
  fs.writeFileSync(path.join(root, '.caws', 'worktrees.json'), '{}\n');
  fs.writeFileSync(path.join(root, '.caws', 'agents.json'), '{}\n');
  return root;
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function captureRun(opts) {
  const out = [];
  const err = [];
  const code = runClaimCommand({
    ...opts,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

describe('CAWS-STALE-VERSION-ADVICE-DIAGNOSTICS-01 — runClaimCommand diagnostic text', () => {
  let repo;

  beforeEach(() => {
    repo = mkRepo('caws-claim-stale-');
  });

  afterEach(() => {
    rmrf(repo);
  });

  test('runClaimCommand from canonical-root (outside any worktree) does NOT emit stale v11.0/pin-to-10.2 advice', () => {
    // cwd is the canonical repo root, NOT inside any
    // .caws/worktrees/<name>/. The diagnostic should fire because
    // the binding resolver cannot identify a worktree from this cwd.
    const result = captureRun({ cwd: repo });

     
    console.log('[claim-stale ARTIFACT] exit code:', result.code);
     
    console.log('[claim-stale ARTIFACT] stderr:');
     
    console.log(result.stderr);

    // The diagnostic MUST fire (exit non-zero from this composition).
    expect(result.code).not.toBe(0);

    // NEGATIVE assertions: stale advice strings must be absent.
    expect(result.stderr).not.toMatch(/v11\.0\.0 does not ship/);
    expect(result.stderr).not.toMatch(/pin to caws-cli@\^10\.2/);
    expect(result.stderr).not.toMatch(/planned for v11\.1/);

    // POSITIVE assertions: the new text names current commands.
    // It tells the user where to cd, OR how to create a worktree, OR
    // how to list existing ones.
    expect(result.stderr).toMatch(
      /cd into a worktree|caws worktree create|caws worktree list/
    );

    // The diagnostic identifies itself clearly.
    expect(result.stderr).toMatch(/caws claim/);
  });
});
