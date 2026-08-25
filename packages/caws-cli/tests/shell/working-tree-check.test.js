'use strict';

/**
 * WORKING-TREE-PROVENANCE-GUARD-001 CLI contract tests.
 *
 * A7: `caws working-tree check` is a read-only overlap query — exit 0 with no
 *     overlap, exit 1 with overlap; never mutates the tree.
 * A3: `caws working-tree ack --session <id> --paths <p> [--target <cmd>]`
 *     appends a prior_overlap_acks entry to the target session's lease.
 *
 * Real on-disk repos + injected sinks.
 */

const fs = require('fs');
const path = require('path');

const {
  runWorkingTreeAckCommand,
  runWorkingTreeCheckCommand,
} = require('../../dist/shell/commands/working-tree');
const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const init = initProject(root);
  if (!init.ok) throw new Error('initProject failed');
  const cawsDir = path.join(root, '.caws');
  // A self-session pointer so `check` excludes self-overlap.
  fs.mkdirSync(path.join(cawsDir, 'sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(cawsDir, 'sessions', '.caller-session.json'),
    JSON.stringify({ session_id: 'self-sess', repo_root: root })
  );
  // Another session that claimed packages/foo/**.
  fs.mkdirSync(path.join(cawsDir, 'leases'), { recursive: true });
  fs.writeFileSync(
    path.join(cawsDir, 'leases', 'other-sess.json'),
    JSON.stringify({ session_id: 'other-sess', platform: 'dsh', status: 'active', claimed_paths: ['packages/foo'] })
  );
  return { root, cawsDir };
}

function runCheck(root, opts = {}) {
  const out = [];
  const err = [];
  const code = runWorkingTreeCheckCommand({ cwd: root, out: (l) => out.push(l), err: (l) => err.push(l), ...opts });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function runAck(root, opts) {
  const out = [];
  const err = [];
  const code = runWorkingTreeAckCommand({
    cwd: root,
    now: () => new Date('2026-08-25T12:00:00.000Z'),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function dirtyPath(root, rel) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'dirty\n');
}

describe('WORKING-TREE-PROVENANCE-GUARD-001 CLI', () => {
  test('A7: check reports overlap with another session (exit 1), read-only', () => {
    const { root } = mkRepo();
    dirtyPath(root, 'packages/foo/bar.ts');
    const r = runCheck(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('other-sess');
    expect(r.out).toContain('packages/foo/bar.ts');
    // Read-only: the dirty path is untouched.
    expect(fs.existsSync(path.join(root, 'packages/foo/bar.ts'))).toBe(true);
  });

  test('A7: check exits 0 when the dirty tree has no other-session overlap', () => {
    const { root } = mkRepo();
    dirtyPath(root, 'somewhere/else.ts');
    const r = runCheck(root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('no overlap');
  });

  test('A3: ack appends a prior_overlap_acks entry on the target lease', () => {
    const { root, cawsDir } = mkRepo();
    const r = runAck(root, {
      sessionId: 'other-sess',
      paths: ['packages/foo/bar.ts'],
      target: 'git stash',
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('acked overlap for session other-sess');
    const lease = JSON.parse(fs.readFileSync(path.join(cawsDir, 'leases', 'other-sess.json'), 'utf8'));
    expect(Array.isArray(lease.prior_overlap_acks)).toBe(true);
    expect(lease.prior_overlap_acks).toHaveLength(1);
    expect(lease.prior_overlap_acks[0].acked_by_session).toBe('self-sess');
    expect(lease.prior_overlap_acks[0].target_command).toBe('git stash');
    expect(lease.prior_overlap_acks[0].paths).toEqual(['packages/foo/bar.ts']);
  });

  test('A3: ack refuses a session with no lease', () => {
    const { root } = mkRepo();
    const r = runAck(root, { sessionId: 'no-lease', paths: ['x'] });
    expect(r.code).toBe(1);
    expect(r.err).toContain('no lease for session');
  });
});
