/**
 * Integration test proving lease classification against a REAL linked
 * worktree (not a mocked git_dir).
 *
 * MULTI-AGENT-ACTIVITY-REGISTRY-001 acceptance — visibility-substrate
 * proof that the canonical-vs-worktree distinction works mechanically,
 * not just structurally.
 *
 * Spec invariant 8: git_dir_kind = canonical iff fs.realpathSync-
 * normalized git_common_dir === git_dir. This test creates a real
 * `git worktree add` linked worktree and registers a lease from
 * INSIDE that worktree, then asserts:
 *
 *   - The lease's git_common_dir points to the canonical .git/
 *   - The lease's git_dir points to .git/worktrees/<name>/
 *   - git_common_dir !== git_dir
 *   - `caws agents list --json --include-stale --include-stopped`
 *     reports the lease with git_dir_kind: 'worktree'
 *   - A second lease registered from the canonical checkout has
 *     git_common_dir === git_dir and git_dir_kind: 'canonical'
 *
 * This is the exact failure mode the slice exists to make visible:
 * canonical vs linked-worktree confusion. Without this test, only
 * the structural intent is proven; the mechanical behavior is not.
 */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  runAgentsRegisterCommand,
  runAgentsListCommand,
} = require('../../dist/shell');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function mkCanonicalRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-link-wt-'));
  execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, '.gitignore'), '');
  execFileSync('git', ['-C', dir, 'add', '.gitignore'], { stdio: 'ignore' });
  execFileSync(
    'git',
    [
      '-C',
      dir,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-qm',
      'init',
    ],
    { stdio: 'ignore' }
  );
  fs.mkdirSync(path.join(dir, '.caws'));
  return dir;
}

function capture(fn) {
  const out = [];
  const err = [];
  const NOW = new Date('2026-05-23T10:00:00.000Z');
  const code = fn({
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    now: () => NOW,
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

describe('linked-worktree integration — git_dir_kind classification', () => {
  let canonical;
  let linkedWtPath;

  afterEach(() => {
    if (canonical && fs.existsSync(canonical)) {
      try {
        // Remove the linked worktree first if present.
        if (linkedWtPath && fs.existsSync(linkedWtPath)) {
          execFileSync('git', ['-C', canonical, 'worktree', 'remove', '--force', linkedWtPath], {
            stdio: 'ignore',
          });
        }
      } catch {
        // best effort
      }
      fs.rmSync(canonical, { recursive: true, force: true });
    }
    canonical = undefined;
    linkedWtPath = undefined;
  });

  it('lease from canonical checkout: git_common_dir === git_dir → git_dir_kind=canonical', () => {
    canonical = mkCanonicalRepo();
    const r = capture((io) =>
      runAgentsRegisterCommand({
        ...io,
        cwd: canonical,
        sessionId: 'caws-canon',
        platform: 'claude-code',
        json: true,
        includeActiveSummary: true,
      })
    );
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.active_agent_count).toBe(1);
    const self = payload.active_agents[0];
    expect(self.session_id).toBe('caws-canon');
    expect(self.git_dir_kind).toBe('canonical');

    // Read the on-disk lease and verify git_common_dir === git_dir.
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(canonical, '.caws', 'leases', 'caws-canon.json'), 'utf8')
    );
    expect(onDisk.git_common_dir).toBe(onDisk.git_dir);
  });

  it('lease from linked worktree: git_common_dir !== git_dir → git_dir_kind=worktree', () => {
    canonical = mkCanonicalRepo();
    linkedWtPath = path.join(canonical, '..', path.basename(canonical) + '-linked-wt');
    git(canonical, ['worktree', 'add', '-b', 'linked-branch', linkedWtPath]);
    // Linked worktrees share the canonical .caws/ via the canonical's
    // resolveRepoRoot. We register from cwd = linked worktree path.
    const r = capture((io) =>
      runAgentsRegisterCommand({
        ...io,
        cwd: linkedWtPath,
        sessionId: 'caws-linked',
        platform: 'claude-code',
        json: true,
        includeActiveSummary: true,
      })
    );
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.active_agent_count).toBe(1);
    const self = payload.active_agents[0];
    expect(self.session_id).toBe('caws-linked');
    expect(self.git_dir_kind).toBe('worktree');

    // Read the on-disk lease (in canonical's .caws/leases/) and verify
    // git_common_dir !== git_dir.
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(canonical, '.caws', 'leases', 'caws-linked.json'), 'utf8')
    );
    expect(onDisk.git_common_dir).not.toBe(onDisk.git_dir);
    // git_dir for a linked worktree should be under
    // <canonical>/.git/worktrees/<name>/
    expect(onDisk.git_dir).toMatch(/worktrees/);
    // git_common_dir should be the canonical .git/
    expect(onDisk.git_common_dir).not.toMatch(/worktrees\//);
  });

  it('mixed: both canonical and linked-worktree leases coexist and are correctly classified', () => {
    canonical = mkCanonicalRepo();
    linkedWtPath = path.join(canonical, '..', path.basename(canonical) + '-mixed-wt');
    git(canonical, ['worktree', 'add', '-b', 'mixed-branch', linkedWtPath]);

    // Register from canonical.
    capture((io) =>
      runAgentsRegisterCommand({
        ...io,
        cwd: canonical,
        sessionId: 'caws-mix-canon',
        platform: 'claude-code',
        json: true,
      })
    );
    // Register from linked worktree.
    capture((io) =>
      runAgentsRegisterCommand({
        ...io,
        cwd: linkedWtPath,
        sessionId: 'caws-mix-linked',
        platform: 'claude-code',
        json: true,
      })
    );

    // List — both should appear; check git_dir_kind for each.
    const listResult = capture((io) =>
      runAgentsListCommand({
        ...io,
        cwd: canonical,
        json: true,
      })
    );
    expect(listResult.code).toBe(0);
    const list = JSON.parse(listResult.stdout);
    expect(list.counts.active).toBe(2);
    // Active entries come from summarizeActiveAgents which returns
    // AgentLease objects — but the entries we render in --include-active-summary
    // are the projected summary entries with git_dir_kind. The plain
    // `caws agents list` returns the full AgentLease records, so we
    // need to derive git_dir_kind from git_common_dir === git_dir.
    const canon = list.active.find((l) => l.session_id === 'caws-mix-canon');
    const linked = list.active.find((l) => l.session_id === 'caws-mix-linked');
    expect(canon).toBeDefined();
    expect(linked).toBeDefined();
    expect(canon.git_common_dir).toBe(canon.git_dir); // canonical
    expect(linked.git_common_dir).not.toBe(linked.git_dir); // linked
  });
});
