'use strict';

/**
 * Split-state recovery for a partially-completed `caws worktree merge`
 * (CAWS-DEFECT-MERGE-SPLIT-STATE-RECOVERY-01).
 *
 * `caws worktree merge` moves three surfaces that normally travel together:
 * git (branch merged into base), the spec (closed), the registry (worktree
 * de-registered and removed). The git merge is durable the instant the
 * compare-and-swap lands, so a later failure cannot roll it back — it can only
 * be reported. It used to be reported into the diagnostic's `data` block, which
 * renderDiagnostics prints ONLY under `--data`: the operator saw what broke and
 * nothing about what to do, at the moment three surfaces had come apart.
 *
 * These tests drive the REAL compiled writers against REAL git repos and force
 * a REAL late failure by making the write target non-writable, so the merge
 * breaks after the git half has already landed. The property under test is what
 * an operator reads on stderr with no extra flags, so the assertions are on the
 * default rendering.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createSpec } = require('../../dist/store/specs-writer');
const { createWorktree, mergeWorktree } = require('../../dist/store/worktrees-writer');
const { runWorktreeMergeCommand } = require('../../dist/shell/commands/worktree');
const { initProject } = require('../../dist/store/init-store');

const SESSION_ID = 'sess-split-state';
const SESSION = { session_id: SESSION_ID, platform: 'jest' };
const ACTOR = { kind: 'agent', id: 'split-state-agent', session_id: SESSION_ID };
const CANDIDATES = {
  candidates: [{ identity: SESSION, source: 'hook_env' }],
  trace: [],
};

const repos = [];

function mkRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  repos.push(root);
  return root;
}

function setupCaws(repoRoot) {
  const r = initProject(repoRoot);
  if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
  return path.join(repoRoot, '.caws');
}

function commitCaws(repoRoot, message) {
  execFileSync('git', ['-C', repoRoot, 'add', '-A']);
  execFileSync('git', ['-C', repoRoot, 'commit', '--quiet', '--no-verify', '-m', message]);
}

function seedBoundableSpec(caws, id) {
  const r = createSpec(caws, {
    id,
    title: 'Split-state recovery fixture',
    mode: 'chore',
    riskTier: 3,
    actor: ACTOR,
    scopeIn: ['payload.txt'],
  });
  if (!r.ok || r.value.kind !== 'success') {
    throw new Error('seed spec failed: ' + JSON.stringify(r));
  }
}

function seedLane(caws, name, specId) {
  const created = createWorktree(caws, { name, specId, session: SESSION, actor: ACTOR });
  if (!created.ok || created.value.kind !== 'success') {
    throw new Error('createWorktree failed: ' + JSON.stringify(created));
  }
  const wtPath = path.join(caws, 'worktrees', name);
  fs.writeFileSync(path.join(wtPath, 'payload.txt'), 'work product\n');
  execFileSync('git', ['-C', wtPath, 'add', 'payload.txt']);
  execFileSync('git', ['-C', wtPath, 'commit', '--quiet', '--no-verify', '-m', 'feat: work']);
  execFileSync('git', ['-C', wtPath, 'merge', '--quiet', '--no-edit', 'main']);
  return wtPath;
}

const frozenDirs = [];

/**
 * Make the spec write fail for real: the writers land YAML by creating a temp
 * file in the target directory and renaming it, so a non-writable directory
 * fails the write while leaving every read (scope resolution, spec load,
 * binding checks) intact. No mocking — this is what a permissions-hardened or
 * read-only checkout does in the field, and it fails LATE, after the git merge
 * has already landed, which is exactly the split state under test.
 */
function freezeDir(dir) {
  fs.chmodSync(dir, 0o555);
  frozenDirs.push(dir);
}

function freezeSpecDir(caws) {
  freezeDir(path.join(caws, 'specs'));
}

/**
 * Same idea, one layer down: freeze the event log itself so the
 * worktree_merged append fails. Used with --no-close, where the append is the
 * merge's first lifecycle write and therefore the first thing that can break.
 */
function freezeEventLog(caws) {
  const p = path.join(caws, 'events.jsonl');
  fs.chmodSync(p, 0o444);
  frozenFiles.push(p);
}

const frozenFiles = [];

function thawSpecDirs() {
  while (frozenFiles.length > 0) {
    const f = frozenFiles.pop();
    try {
      fs.chmodSync(f, 0o644);
    } catch {
      /* best effort */
    }
  }
  while (frozenDirs.length > 0) {
    const dir = frozenDirs.pop();
    try {
      fs.chmodSync(dir, 0o755);
    } catch {
      /* best effort */
    }
  }
}

afterEach(thawSpecDirs);

function runMergeCommand(repoRoot, name, opts = {}) {
  const out = [];
  const errLines = [];
  const code = runWorktreeMergeCommand({
    cwd: repoRoot,
    name,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: SESSION_ID },
    out: (line) => out.push(line),
    err: (line) => errLines.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: errLines.join('\n') };
}

afterAll(() => {
  for (const r of repos) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  }
});

describe('A1: the recovery for a split merge is visible without --data', () => {
  test('a rolled-back spec close prints the ordered recovery commands on stderr', () => {
    const caws = setupCaws(mkRepo('split-close-'));
    const repo = path.dirname(caws);
    const SPEC = 'SPLIT-CLOSE-001';
    seedBoundableSpec(caws, SPEC);
    commitCaws(repo, 'seed spec');
    seedLane(caws, 'wt-split-close', SPEC);
    freezeSpecDir(caws);

    const { code, err } = runMergeCommand(repo, 'wt-split-close');

    // The merge failed as a whole...
    expect(code).not.toBe(0);
    // ...but the git half is durable, and the operator is told so.
    expect(err).toContain('State is SPLIT');
    expect(err).toContain('the merge cannot be undone by retrying');

    // HEADLINE: both recovery commands are in the DEFAULT rendering. No --data.
    expect(err).toContain(`caws specs close ${SPEC} --resolution completed --merge-commit`);
    expect(err).toContain('caws worktree destroy wt-split-close');
    expect(err).toContain('Re-running `caws worktree merge wt-split-close` will NOT help');

    // And the recovery is not merely echoed prose: it names the real merge SHA
    // an operator must pass to `--merge-commit`.
    const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
    const printed = /--merge-commit ([0-9a-f]{7,40})/.exec(err);
    expect(printed).not.toBeNull();
    expect(sha.startsWith(printed[1])).toBe(true);
  });

  test('the surface-by-surface state names which surfaces moved and which did not', () => {
    const caws = setupCaws(mkRepo('split-surfaces-'));
    const repo = path.dirname(caws);
    const SPEC = 'SPLIT-SURFACES-001';
    seedBoundableSpec(caws, SPEC);
    commitCaws(repo, 'seed spec');
    seedLane(caws, 'wt-split-surfaces', SPEC);
    freezeSpecDir(caws);

    const { err } = runMergeCommand(repo, 'wt-split-surfaces');

    expect(err).toMatch(/git: branch merged into main at [0-9a-f]{7,40}/);
    expect(err).toContain(`spec ${SPEC}: still active`);
    expect(err).toContain('provenance ledger: worktree_merged NOT appended');
    expect(err).toContain('worktree "wt-split-surfaces": still registered and on disk');
  });
});

describe('A2: the reported state matches what actually landed', () => {
  test('with --no-close the close is skipped, so the split names the ledger and the worktree', () => {
    const caws = setupCaws(mkRepo('split-noclose-'));
    const repo = path.dirname(caws);
    const SPEC = 'SPLIT-NOCLOSE-001';
    seedBoundableSpec(caws, SPEC);
    commitCaws(repo, 'seed spec');
    seedLane(caws, 'wt-split-noclose', SPEC);
    freezeEventLog(caws);

    const result = mergeWorktree(caws, {
      name: 'wt-split-noclose',
      session: SESSION,
      sessionCandidates: CANDIDATES,
      actor: ACTOR,
      noClose: true,
    });

    expect(result.ok).toBe(false);
    const repair = result.errors.map((d) => d.narrowRepair ?? '').join('\n');
    // The failure moved past the close (there was none to do) to the
    // worktree_merged append, so the message is about the ledger, not the spec.
    expect(result.errors.map((d) => d.message).join('\n')).toContain('worktree_merged');
    expect(repair).toContain('provenance ledger: worktree_merged NOT appended');
    expect(repair).toContain('caws worktree destroy wt-split-noclose');

    // The git merge is still durable: main carries the lane's work product even
    // though the CLI exits non-zero. This is the whole reason recovery text has
    // to be visible — retrying is not a recovery.
    const landed = execFileSync('git', ['-C', repo, 'show', 'main:payload.txt'], {
      encoding: 'utf8',
    });
    expect(landed).toBe('work product\n');
  });

  test('a failed teardown reports the spec CLOSED and asks only for the destroy', () => {
    const caws = setupCaws(mkRepo('split-destroy-'));
    const repo = path.dirname(caws);
    const SPEC = 'SPLIT-DESTROY-001';
    seedBoundableSpec(caws, SPEC);
    commitCaws(repo, 'seed spec');
    seedLane(caws, 'wt-split-destroy', SPEC);
    // Freeze the worktrees directory: git can read and merge from the lane, but
    // removing its directory entry fails. This is the LAST failure point in the
    // merge — close and worktree_merged have both landed by then.
    freezeDir(path.join(caws, 'worktrees'));

    const { code, err } = runMergeCommand(repo, 'wt-split-destroy');

    expect(code).not.toBe(0);
    // HEADLINE: the state line reflects what actually landed. Two surfaces
    // completed, so the recovery asks for one command, not a blanket replay.
    expect(err).toContain(`spec ${SPEC}: CLOSED`);
    expect(err).toContain('provenance ledger: worktree_merged appended');
    expect(err).toContain('caws worktree destroy wt-split-destroy');
    expect(err).not.toContain(`caws specs close ${SPEC}`);

    // Not vacuous: the spec really is closed on disk and the event really is in
    // the ledger, so re-running those steps would be wrong advice.
    const spec = fs.readFileSync(path.join(caws, 'specs', `${SPEC}.yaml`), 'utf8');
    expect(spec).toContain('lifecycle_state: closed');
    const events = fs
      .readFileSync(path.join(caws, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    expect(events.filter((e) => e.event === 'worktree_merged')).toHaveLength(1);
  });
});

describe('A3: a healthy merge says nothing about split state', () => {
  test('the success path prints no recovery text and leaves no partial state', () => {
    const caws = setupCaws(mkRepo('split-healthy-'));
    const repo = path.dirname(caws);
    const SPEC = 'SPLIT-HEALTHY-001';
    seedBoundableSpec(caws, SPEC);
    commitCaws(repo, 'seed spec');
    seedLane(caws, 'wt-split-healthy', SPEC);

    const { code, out, err } = runMergeCommand(repo, 'wt-split-healthy');

    expect(code).toBe(0);
    expect(`${out}\n${err}`).not.toContain('State is SPLIT');
    expect(`${out}\n${err}`).not.toContain('will NOT help');

    // The control is not vacuous: this merge really did complete all three
    // surfaces, which is why there is nothing to recover.
    const spec = fs.readFileSync(path.join(caws, 'specs', `${SPEC}.yaml`), 'utf8');
    expect(spec).toContain('lifecycle_state: closed');
    expect(fs.existsSync(path.join(caws, 'worktrees', 'wt-split-healthy'))).toBe(false);
  });
});
