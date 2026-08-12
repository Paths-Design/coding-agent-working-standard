'use strict';

/**
 * `caws worktree merge --no-close` — the recordable AC-evidence window
 * (CAWS-DEFECT-AC-EVIDENCE-WINDOW-01, A3/A4).
 *
 * The defect: `caws specs evidence` records only on an active or draft spec,
 * and the default merge auto-closes the bound spec in the same transaction that
 * lands the work. So the interval in which an operator can record evidence for
 * work that is actually finished is zero-width — before the merge the work is
 * unlanded, and the instant it lands the spec is frozen. The close-gate advisory
 * then prints remediation commands that are already refused.
 *
 * --no-close reopens that interval by making the close a separate, explicit
 * step. These tests drive the REAL compiled writers against REAL git repos: the
 * property under test is on-disk lifecycle state and the events chain, which a
 * mocked git cannot exercise.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { createSpec } = require('../../dist/store/specs-writer');
const { createWorktree, mergeWorktree } = require('../../dist/store/worktrees-writer');
const { runWorktreeMergeCommand } = require('../../dist/shell/commands/worktree');
const { initProject } = require('../../dist/store/init-store');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

const SESSION_ID = 'sess-ac-evidence-window';
const SESSION = { session_id: SESSION_ID, platform: 'jest' };
const ACTOR = { kind: 'agent', id: 'ac-window-agent', session_id: SESSION_ID };
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
  // scopeIn covers payload.txt: the merge-time lane-provenance guard refuses any
  // lane commit touching paths outside the bound spec's scope.
  const r = createSpec(caws, {
    id,
    title: 'AC evidence window fixture',
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

function readEvents(caws) {
  const p = path.join(caws, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

function readSpec(caws, id) {
  return fs.readFileSync(path.join(caws, 'specs', `${id}.yaml`), 'utf8');
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

describe('A3: --no-close lands the merge and leaves the bound spec active', () => {
  test('the spec stays active on disk and no spec_closed event is appended', () => {
    const caws = setupCaws(mkRepo('acwin-noclose-'));
    const repo = path.dirname(caws);
    const SPEC = 'ACWIN-NOCLOSE-001';
    seedBoundableSpec(caws, SPEC);
    commitCaws(repo, 'seed spec');
    seedLane(caws, 'wt-acwin-noclose', SPEC);

    const result = mergeWorktree(caws, {
      name: 'wt-acwin-noclose',
      session: SESSION,
      sessionCandidates: CANDIDATES,
      actor: ACTOR,
      noClose: true,
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');

    // The work actually landed — --no-close suppresses the close, not the merge.
    const mergeCommit = result.value.data.merge_commit;
    expect(mergeCommit).toMatch(/^[0-9a-f]{7,40}$/);
    // Read the lane's work product out of main's tree. Asserting on `git show
    // main` would inspect the post-merge AUDIT commit (the registry/spec write
    // the merge appends last), not the merged content — a green that proves
    // only that some commit landed.
    const landed = execFileSync('git', ['-C', repo, 'show', 'main:payload.txt'], {
      encoding: 'utf8',
    });
    expect(landed).toBe('work product\n');
    const mergeIsAncestor = execFileSync(
      'git',
      ['-C', repo, 'merge-base', '--is-ancestor', mergeCommit, 'main'],
      { encoding: 'utf8' }
    );
    expect(mergeIsAncestor).toBe('');

    // HEADLINE: the spec is still active, so `caws specs evidence` is accepted.
    const spec = readSpec(caws, SPEC);
    expect(spec).toContain('lifecycle_state: active');
    expect(spec).not.toContain('lifecycle_state: closed');
    expect(spec).not.toMatch(/^resolution:/m);

    const closedEvents = readEvents(caws).filter(
      (e) => e.event === 'spec_closed' && e.spec_id === SPEC
    );
    expect(closedEvents).toHaveLength(0);

    // The merge record is honest about what it did NOT do.
    const merged = readEvents(caws).filter((e) => e.event === 'worktree_merged');
    expect(merged).toHaveLength(1);
    expect(merged[0].data.auto_closed_spec).toBe(false);
    expect(result.value.data.auto_closed_spec).toBe(false);
    expect(result.value.data.spec_left_open).toBe(true);
  });

  test('the worktree is still destroyed and its spec binding cleared', () => {
    const caws = setupCaws(mkRepo('acwin-noclose-teardown-'));
    const repo = path.dirname(caws);
    const SPEC = 'ACWIN-NOCLOSE-002';
    seedBoundableSpec(caws, SPEC);
    commitCaws(repo, 'seed spec');
    const wtPath = seedLane(caws, 'wt-acwin-teardown', SPEC);

    const result = mergeWorktree(caws, {
      name: 'wt-acwin-teardown',
      session: SESSION,
      sessionCandidates: CANDIDATES,
      actor: ACTOR,
      noClose: true,
    });
    expect(result.ok && result.value.kind === 'success').toBe(true);

    // Teardown is the merge's job regardless of the close. A --no-close that
    // left the worktree alive would strand a bound tree on a merged branch.
    expect(fs.existsSync(wtPath)).toBe(false);
    const registry = JSON.parse(fs.readFileSync(path.join(caws, 'worktrees.json'), 'utf8'));
    expect(registry['wt-acwin-teardown']).toBeUndefined();
    // The binding must be cleared too: the spec is still active, and an active
    // spec pointing at a destroyed worktree is the half-state that produces
    // NO AUTHORITY on every subsequent edit.
    expect(readSpec(caws, SPEC)).not.toMatch(/^worktree:/m);
  });

  test('evidence recording is ACCEPTED after a --no-close merge — the window is real', () => {
    const caws = setupCaws(mkRepo('acwin-window-'));
    const repo = path.dirname(caws);
    const SPEC = 'ACWIN-NOCLOSE-003';
    seedBoundableSpec(caws, SPEC);
    commitCaws(repo, 'seed spec');
    seedLane(caws, 'wt-acwin-window', SPEC);

    const merged = mergeWorktree(caws, {
      name: 'wt-acwin-window',
      session: SESSION,
      sessionCandidates: CANDIDATES,
      actor: ACTOR,
      noClose: true,
    });
    expect(merged.ok && merged.value.kind === 'success').toBe(true);

    // This is the whole point of the slice: the same command the close-gate
    // advisory prescribes, run AFTER the work landed, succeeds.
    const recorded = spawnSync(
      process.execPath,
      [
        CLI, 'specs', 'evidence', SPEC,
        '--ac', 'A1', '--status', 'pass', '--evidence-ref', 'npx jest worktree-merge-no-close',
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, CAWS_QUIET: '1', CLAUDE_CODE_SESSION_ID: SESSION_ID },
      }
    );
    expect(recorded.status).toBe(0);
    expect(readSpec(caws, SPEC)).toContain('criterion_id: A1');

    // And the deferred close then runs clean — no AC-evidence advisory, because
    // the evidence is now in.
    const closed = spawnSync(
      process.execPath,
      [
        CLI, 'specs', 'close', SPEC,
        '--resolution', 'completed', '--reason', 'evidence recorded post-merge',
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, CAWS_QUIET: '1', CLAUDE_CODE_SESSION_ID: SESSION_ID },
      }
    );
    expect(closed.status).toBe(0);
    expect(closed.stderr).not.toContain('lacking satisfying evidence');
    expect(readSpec(caws, SPEC)).toContain('lifecycle_state: closed');
  });
});

describe('A3: the shell states that the spec was NOT closed and names the close', () => {
  test('the success line and follow-up name the close command with the merge commit', () => {
    const caws = setupCaws(mkRepo('acwin-shell-'));
    const repo = path.dirname(caws);
    const SPEC = 'ACWIN-SHELL-001';
    seedBoundableSpec(caws, SPEC);
    commitCaws(repo, 'seed spec');
    seedLane(caws, 'wt-acwin-shell', SPEC);

    const result = runMergeCommand(repo, 'wt-acwin-shell', { noClose: true });

    expect(result.code).toBe(0);
    expect(result.out).toContain('merged wt-acwin-shell');
    // The default line reads "auto_closed_spec: <id>"; under --no-close that
    // would be a false claim about lifecycle state.
    expect(result.out).not.toContain('auto_closed_spec');
    expect(result.out).toContain(`spec_left_open: ${SPEC}`);
    expect(result.out).toContain('was NOT closed');
    expect(result.out).toContain('remains active');
    // The operator still owes a close; naming it is what keeps --no-close from
    // silently accumulating open specs.
    expect(result.out).toContain(`caws specs close ${SPEC} --resolution completed --merge-commit`);
    expect(result.out).toContain(`caws specs evidence ${SPEC} --ac`);
  });

  test('the AC-evidence advisory does NOT fire — there is no close to warn about', () => {
    const caws = setupCaws(mkRepo('acwin-shell-quiet-'));
    const repo = path.dirname(caws);
    const SPEC = 'ACWIN-SHELL-002';
    seedBoundableSpec(caws, SPEC);
    commitCaws(repo, 'seed spec');
    seedLane(caws, 'wt-acwin-quiet', SPEC);

    const result = runMergeCommand(repo, 'wt-acwin-quiet', { noClose: true });

    expect(result.code).toBe(0);
    // The spec has zero evidence, so a bare merge WOULD warn here. Warning on
    // a path that deliberately deferred the close is exactly the noise that
    // trains readers to ignore the advisory.
    expect(result.err).not.toContain('lacking satisfying evidence');
    expect(result.err).not.toContain('caws advisory (non-blocking)');
  });

  test('--no-close with --closure-notes is refused before any git operation', () => {
    const caws = setupCaws(mkRepo('acwin-conflict-'));
    const repo = path.dirname(caws);
    const SPEC = 'ACWIN-CONFLICT-001';
    seedBoundableSpec(caws, SPEC);
    commitCaws(repo, 'seed spec');
    seedLane(caws, 'wt-acwin-conflict', SPEC);
    const baseBefore = execFileSync('git', ['-C', repo, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();

    const result = runMergeCommand(repo, 'wt-acwin-conflict', {
      noClose: true,
      closureNotes: 'notes that have nowhere to go',
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain('mutually exclusive');
    // "Before any git operation" is the claim; prove it by the base not moving.
    const baseAfter = execFileSync('git', ['-C', repo, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
    expect(baseAfter).toBe(baseBefore);
    expect(readSpec(caws, SPEC)).toContain('lifecycle_state: active');
  });
});

describe('A3: the flag survives Commander parsing (--no-X is a NEGATION, not a name)', () => {
  test('spawned CLI: --no-close leaves the spec active', () => {
    const caws = setupCaws(mkRepo('acwin-cli-'));
    const repo = path.dirname(caws);
    const SPEC = 'ACWIN-CLI-001';
    seedBoundableSpec(caws, SPEC);
    commitCaws(repo, 'seed spec');
    seedLane(caws, 'wt-acwin-cli', SPEC);

    const result = spawnSync(
      process.execPath,
      [CLI, 'worktree', 'merge', 'wt-acwin-cli', '--no-close'],
      {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, CAWS_QUIET: '1', CLAUDE_CODE_SESSION_ID: SESSION_ID },
      }
    );

    // Commander binds `--no-close` to an option named `close` with an implicit
    // default of true — reading `opts.noClose` in register.ts would be
    // undefined forever and the flag would parse cleanly while auto-closing
    // anyway. Only a full-parse-path test catches that; the handler tests above
    // pass `noClose` directly and would stay green.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`spec_left_open: ${SPEC}`);
    expect(readSpec(caws, SPEC)).toContain('lifecycle_state: active');
    expect(readEvents(caws).filter((e) => e.event === 'spec_closed')).toHaveLength(0);
  });

  test('spawned CLI: WITHOUT the flag the spec closes — the default is untouched', () => {
    const caws = setupCaws(mkRepo('acwin-cli-default-'));
    const repo = path.dirname(caws);
    const SPEC = 'ACWIN-CLI-002';
    seedBoundableSpec(caws, SPEC);
    commitCaws(repo, 'seed spec');
    seedLane(caws, 'wt-acwin-cli-default', SPEC);

    const result = spawnSync(process.execPath, [CLI, 'worktree', 'merge', 'wt-acwin-cli-default'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, CAWS_QUIET: '1', CLAUDE_CODE_SESSION_ID: SESSION_ID },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`auto_closed_spec: ${SPEC}`);
    expect(result.stdout).not.toContain('spec_left_open');
    expect(readSpec(caws, SPEC)).toContain('lifecycle_state: closed');
  });
});

describe('A4: the default auto-close path is unchanged by this slice', () => {
  test('a bare merge closes the spec, appends spec_closed, and reports auto_closed_spec', () => {
    const caws = setupCaws(mkRepo('acwin-default-'));
    const repo = path.dirname(caws);
    const SPEC = 'ACWIN-DEFAULT-001';
    seedBoundableSpec(caws, SPEC);
    commitCaws(repo, 'seed spec');
    seedLane(caws, 'wt-acwin-default', SPEC);

    const result = mergeWorktree(caws, {
      name: 'wt-acwin-default',
      session: SESSION,
      sessionCandidates: CANDIDATES,
      actor: ACTOR,
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    expect(result.value.data.auto_closed_spec).toBe(true);
    // Absent, not false: a reader checking `'spec_left_open' in data` must not
    // see a vestigial key on the default path.
    expect(result.value.data).not.toHaveProperty('spec_left_open');

    const spec = readSpec(caws, SPEC);
    expect(spec).toContain('lifecycle_state: closed');
    expect(spec).toMatch(/^resolution: completed$/m);

    const closed = readEvents(caws).filter((e) => e.event === 'spec_closed' && e.spec_id === SPEC);
    expect(closed).toHaveLength(1);
    expect(closed[0].data.merge_commit).toBe(result.value.data.merge_commit);

    const merged = readEvents(caws).filter((e) => e.event === 'worktree_merged');
    expect(merged[0].data.auto_closed_spec).toBe(true);
  });

  test('the default still carries the AC-evidence advisory to stderr', () => {
    const caws = setupCaws(mkRepo('acwin-default-warn-'));
    const repo = path.dirname(caws);
    const SPEC = 'ACWIN-DEFAULT-002';
    seedBoundableSpec(caws, SPEC);
    commitCaws(repo, 'seed spec');
    seedLane(caws, 'wt-acwin-default-warn', SPEC);

    const result = runMergeCommand(repo, 'wt-acwin-default-warn');

    expect(result.code).toBe(0);
    expect(result.out).toContain(`auto_closed_spec: ${SPEC}`);
    expect(result.err).toContain('caws advisory (non-blocking)');
    // A1 of CAWS-DEFECT-AC-EVIDENCE-WINDOW-01 applies on the merge path too:
    // the advisory prints after the close landed, so it must name the reopen.
    expect(result.err).toContain(`caws specs reopen ${SPEC}`);
  });

  test('the default records the unsatisfied ids in closure_notes (A2 via merge)', () => {
    const caws = setupCaws(mkRepo('acwin-default-notes-'));
    const repo = path.dirname(caws);
    const SPEC = 'ACWIN-DEFAULT-003';
    seedBoundableSpec(caws, SPEC);
    commitCaws(repo, 'seed spec');
    seedLane(caws, 'wt-acwin-default-notes', SPEC);

    const result = mergeWorktree(caws, {
      name: 'wt-acwin-default-notes',
      session: SESSION,
      sessionCandidates: CANDIDATES,
      actor: ACTOR,
    });
    expect(result.ok && result.value.kind === 'success').toBe(true);

    // The merge auto-close writes the machine stub into closure_notes (the spec
    // carried none), so the annotation rides along on the same line.
    const notesLine = readSpec(caws, SPEC)
      .split('\n')
      .find((l) => l.startsWith('closure_notes:'));
    expect(notesLine).toContain('Auto-closed by caws worktree merge');
    expect(notesLine).toContain('AC evidence missing at close: A1 (missing)');
  });
});
