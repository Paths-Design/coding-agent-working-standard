'use strict';

const fs = require('fs');
const path = require('path');
const child = require('child_process');
const { makeTempRepo, cleanupAll, git } = require('../helpers/git-repo-factory');
const { initProject } = require('../../dist/store/init-store');
const { createSpec } = require('../../dist/store/specs-writer');
const {
  createWorktree,
  destroyWorktree,
  mergeWorktree,
} = require('../../dist/store/worktrees-writer');
const { worktreeIsRegistered } = require('../../dist/store/worktree-removal');
const { runWorktreeMergeCommand } = require('../../dist/shell/commands/worktree');

const session = { session_id: 'removal-safety', platform: 'test' };
const actor = { kind: 'agent', id: 'test', session_id: session.session_id };
const candidates = { candidates: [{ identity: session, source: 'hook_env' }], trace: [] };
const input = { name: 'lane', session, sessionCandidates: candidates, actor };
const frozen = [];

afterEach(() => {
  jest.restoreAllMocks();
  for (const directory of frozen.splice(0)) fs.chmodSync(directory, 0o755);
});
afterAll(cleanupAll);

function setup() {
  const root = makeTempRepo();
  expect(initProject(root).ok).toBe(true);
  fs.appendFileSync(
    path.join(root, '.gitignore'),
    '\nnode_modules/\nother/\n.caws/worktrees/\n.caws/worktrees.json\n'
  );
  fs.writeFileSync(path.join(root, 'payload.txt'), 'retained bytes\n');
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'sentinel'), 'shared dependency\n');
  const cawsDir = path.join(root, '.caws');
  expect(
    createSpec(cawsDir, {
      id: 'REMOVE-SAFETY-001',
      title: 'Worktree removal fixture',
      mode: 'fix',
      actor,
      scopeIn: ['payload.txt'],
    }).ok
  ).toBe(true);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'seed fixture']);
  expect(
    createWorktree(cawsDir, { name: 'lane', specId: 'REMOVE-SAFETY-001', session, actor })
  ).toMatchObject({ ok: true, value: { kind: 'success' } });
  const wtPath = path.join(cawsDir, 'worktrees', 'lane');
  const admin = git(wtPath, ['rev-parse', '--absolute-git-dir']).trim();
  return { root, cawsDir, wtPath, admin };
}

function authority(f) {
  return ['worktrees.json', 'specs/REMOVE-SAFETY-001.yaml', 'events.jsonl'].map((file) =>
    fs.readFileSync(path.join(f.cawsDir, file))
  );
}

function assertPreserved(f, before) {
  expect(authority(f)).toEqual(before);
  expect(fs.readFileSync(path.join(f.wtPath, 'payload.txt'), 'utf8')).toBe('retained bytes\n');
  expect(fs.lstatSync(path.join(f.wtPath, 'node_modules')).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(path.join(f.root, 'node_modules', 'sentinel'), 'utf8')).toBe(
    'shared dependency\n'
  );
  expect(worktreeIsRegistered(f.root, f.wtPath)).toBe(true);
}

test.each(['admin', 'parent'])(
  'real metadata permission refusal preserves checkout, links and authority: %s',
  (target) => {
    const f = setup();
    const before = authority(f);
    const directory = target === 'admin' ? f.admin : path.dirname(f.admin);
    frozen.push(directory);
    fs.chmodSync(directory, 0o555);
    const result = destroyWorktree(f.cawsDir, input);
    expect(result.ok).toBe(false);
    expect(result.errors.map((d) => d.message).join('\n')).toMatch(
      /preflight failed.*before checkout deletion.*EACCES/
    );
    assertPreserved(f, before);
  }
);

test('a sandbox-style delete denial is detected by the write/delete probe', () => {
  const f = setup();
  const before = authority(f);
  const unlink = fs.unlinkSync;
  const denied = jest.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
    if (String(file).startsWith(f.admin + path.sep) && String(file).endsWith('write-delete'))
      throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
    return unlink(file);
  });
  const result = destroyWorktree(f.cawsDir, input);
  expect(result.ok).toBe(false);
  expect(denied).toHaveBeenCalled();
  expect(result.errors[0].message).toContain('Operation not permitted');
  assertPreserved(f, before);
});

test('denied cleanup of a missing checkout retains its binding and Git record for retry', () => {
  const f = setup();
  fs.rmSync(f.wtPath, { recursive: true });
  const before = authority(f);
  frozen.push(f.admin);
  fs.chmodSync(f.admin, 0o555);
  const result = destroyWorktree(f.cawsDir, input);
  expect(result.ok).toBe(false);
  expect(result.errors[0].message).toContain('preflight failed');
  expect(authority(f)).toEqual(before);
  expect(worktreeIsRegistered(f.root, f.wtPath)).toBe(true);
});

test.each(['unavailable', 'truncated', 'unregistered'])(
  'uncertain Git inventory refuses before deleting links: %s',
  (problem) => {
    const f = setup();
    const before = authority(f);
    const actual = child.execFileSync;
    jest.spyOn(child, 'execFileSync').mockImplementation((command, args, options) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        if (problem === 'unavailable') throw new Error('inventory unavailable');
        if (problem === 'truncated') return `worktree ${f.wtPath}\0`;
        return `worktree ${f.root}\0bare\0\0`;
      }
      return actual(command, args, options);
    });
    const result = destroyWorktree(f.cawsDir, input);
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toContain('preflight failed');
    expect(authority(f)).toEqual(before);
    expect(fs.readFileSync(path.join(f.wtPath, 'payload.txt'), 'utf8')).toBe('retained bytes\n');
    expect(fs.lstatSync(path.join(f.wtPath, 'node_modules')).isSymbolicLink()).toBe(true);
  }
);

test('a metadata backpointer for another repository cannot authorize checkout deletion', () => {
  const f = setup();
  const before = authority(f);
  fs.writeFileSync(path.join(f.admin, 'commondir'), '/private/tmp/foreign-repository\n');
  const result = destroyWorktree(f.cawsDir, input);
  expect(result.ok).toBe(false);
  expect(authority(f)).toEqual(before);
  expect(fs.readFileSync(path.join(f.wtPath, 'payload.txt'), 'utf8')).toBe('retained bytes\n');
});

test('missing-checkout retry removes only its Git record, including a nonmatching metadata basename', () => {
  const f = setup();
  // Git's admin directory need not have the CAWS name: a basename collision
  // during creation produces a suffixed id. Move this record to simulate it.
  const renamedAdmin = f.admin + '-different-id';
  fs.renameSync(f.admin, renamedAdmin);
  fs.writeFileSync(path.join(f.wtPath, '.git'), `gitdir: ${renamedAdmin}\n`);
  const other = path.join(f.root, 'other', 'lane');
  git(f.root, ['worktree', 'add', '--detach', other]);
  fs.rmSync(f.wtPath, { recursive: true });
  const result = destroyWorktree(f.cawsDir, input);
  expect(result).toMatchObject({
    ok: true,
    value: { kind: 'success', data: { removed_git_worktree: true } },
  });
  expect(worktreeIsRegistered(f.root, f.wtPath)).toBe(false);
  expect(fs.existsSync(renamedAdmin)).toBe(false);
  expect(worktreeIsRegistered(f.root, other)).toBe(true);
  expect(fs.readFileSync(path.join(other, 'payload.txt'), 'utf8')).toBe('retained bytes\n');
  expect(
    JSON.parse(fs.readFileSync(path.join(f.cawsDir, 'worktrees.json'), 'utf8')).lane
  ).toBeUndefined();
  const events = fs
    .readFileSync(path.join(f.cawsDir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  expect(
    events.filter((e) => e.event === 'worktree_destroyed').map((e) => e.data.removed_git_worktree)
  ).toEqual([true]);
});

test('real removal has no short kill deadline and verifies checkout plus Git metadata absence', () => {
  const f = setup();
  const actual = child.execFileSync;
  const removals = [];
  jest.spyOn(child, 'execFileSync').mockImplementation((command, args, options) => {
    if (args[0] === 'worktree' && args[1] === 'remove') removals.push(options);
    return actual(command, args, options);
  });
  expect(destroyWorktree(f.cawsDir, input)).toMatchObject({ ok: true, value: { kind: 'success' } });
  expect(removals).toHaveLength(1);
  expect(removals[0].timeout).toBeUndefined();
  expect(removals[0].killSignal).toBeUndefined();
  expect(fs.existsSync(f.wtPath)).toBe(false);
  expect(fs.existsSync(f.admin)).toBe(false);
  expect(fs.readFileSync(path.join(f.root, 'node_modules', 'sentinel'), 'utf8')).toBe(
    'shared dependency\n'
  );
});

test('an already absent checkout and Git record retires without invoking Git remove', () => {
  const f = setup();
  git(f.root, ['worktree', 'remove', f.wtPath]);
  const actual = child.execFileSync;
  const commands = jest.spyOn(child, 'execFileSync').mockImplementation(actual);
  expect(destroyWorktree(f.cawsDir, input)).toMatchObject({
    ok: true,
    value: { kind: 'success', data: { removed_git_worktree: false } },
  });
  expect(
    commands.mock.calls.filter(([, args]) => args[0] === 'worktree' && args[1] === 'remove')
  ).toEqual([]);
});

test('a reported Git success retaining metadata cannot emit a destroyed event', () => {
  const f = setup();
  const before = authority(f);
  const actual = child.execFileSync;
  jest.spyOn(child, 'execFileSync').mockImplementation((command, args, options) => {
    if (args[0] === 'worktree' && args[1] === 'remove') return '';
    return actual(command, args, options);
  });
  const result = destroyWorktree(f.cawsDir, input);
  expect(result.ok).toBe(false);
  expect(result.errors[0].message).toContain(
    'Git reported success but the checkout or its Git registration remains'
  );
  expect(authority(f)).toEqual(before);
  expect(fs.readFileSync(path.join(f.wtPath, 'payload.txt'), 'utf8')).toBe('retained bytes\n');
});

test.each(['dirty', 'foreign', 'locked'])('%s checkouts are retained', (reason) => {
  const f = setup();
  if (reason === 'dirty') fs.writeFileSync(path.join(f.wtPath, 'payload.txt'), 'user edit\n');
  if (reason === 'locked') git(f.root, ['worktree', 'lock', f.wtPath]);
  const before = authority(f);
  const result = destroyWorktree(
    f.cawsDir,
    reason === 'foreign'
      ? {
          ...input,
          sessionCandidates: { candidates: [], trace: [] },
        }
      : input
  );
  expect(result.ok).toBe(false);
  expect(result.errors.map((d) => d.message).join('\n')).toMatch(
    {
      dirty: /uncommitted changes/,
      foreign: /owned by a different session/,
      locked: /Git worktree is locked/,
    }[reason]
  );
  expect(authority(f)).toEqual(before);
  expect(worktreeIsRegistered(f.root, f.wtPath)).toBe(true);
});

test('default merge output retains an underlying removal error and observes an absent checkout', () => {
  const f = setup();
  fs.writeFileSync(path.join(f.wtPath, 'payload.txt'), 'merged work\n');
  git(f.wtPath, ['add', 'payload.txt']);
  git(f.wtPath, ['commit', '-qm', 'feat: work']);
  const actual = child.execFileSync;
  jest.spyOn(child, 'execFileSync').mockImplementation((command, args, options) => {
    if (args[0] === 'worktree' && args[1] === 'remove') {
      fs.rmSync(f.wtPath, { recursive: true });
      throw new Error("failed to delete '.git/worktrees/lane': Operation not permitted");
    }
    return actual(command, args, options);
  });
  const err = [];
  const code = runWorktreeMergeCommand({
    env: { CAWS_SESSION_ID: session.session_id },
    cwd: f.root,
    name: 'lane',
    noClose: true,
    out: () => {},
    err: (line) => err.push(line),
  });
  expect(code).toBe(1);
  expect(err.join('\n')).toContain(
    "failed to delete '.git/worktrees/lane': Operation not permitted"
  );
  expect(err.join('\n')).toContain('still registered; checkout directory absent');
  expect(err.join('\n')).not.toContain('still registered and on disk');
  expect(git(f.root, ['show', 'main:payload.txt']).trim()).toBe('merged work');
  expect(
    JSON.parse(fs.readFileSync(path.join(f.cawsDir, 'worktrees.json'), 'utf8')).lane
  ).toBeDefined();
});

test('post-merge preflight refusal retains merged source and the complete checkout', () => {
  const f = setup();
  const directory = path.dirname(f.admin);
  frozen.push(directory);
  fs.chmodSync(directory, 0o555);
  const result = mergeWorktree(f.cawsDir, { ...input, noClose: true });
  expect(result.ok).toBe(false);
  expect(result.errors.map((d) => d.message).join('\n')).toContain(
    'Worktree removal preflight failed'
  );
  expect(fs.readFileSync(path.join(f.wtPath, 'payload.txt'), 'utf8')).toBe('retained bytes\n');
  expect(fs.lstatSync(path.join(f.wtPath, 'node_modules')).isSymbolicLink()).toBe(true);
});
