'use strict';

/**
 * Contract tests for WORKTREE-LANE-DIVERGENCE-SURFACE-001.
 *
 * A1: a lane 2 ahead / 3 behind => `caws worktree list` reports exactly that,
 *     matching git rev-list --left-right --count, exit 0.
 * A2: a branch at base's tip => ahead=0 behind=0, and the footer that names
 *     stale lanes does NOT fire for it.
 * A3: an unresolvable branch ref => that row degrades to ahead=? behind=?
 *     with the reason named, every other row still reports real counts, exit 0.
 * A4: `caws status` inside a tracked worktree => a lane line with the same
 *     counts plus the reconcile line, and nothing under .caws/ changes.
 * A5: `caws status` from the canonical checkout => no lane line at all.
 * A6: status --json lane object agrees with the worktree list row.
 *
 * Real on-disk git repos with real branches; injected sinks. Both surfaces are
 * read-only, so "nothing was written" is part of the contract, not an aside.
 */

const fs = require('fs');
const path = require('path');

const { runWorktreeListCommand } = require('../../dist/shell/commands/worktree');
const { runStatusCommand } = require('../../dist/shell/commands/status');
const { initProject } = require('../../dist/store/init-store');
const { loadEvents } = require('../../dist/store/events-store');
const { cleanupAll, git, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) {
    throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  }
  return root;
}

function cawsDir(root) {
  return path.join(root, '.caws');
}

function sinks() {
  const out = [];
  const err = [];
  return { out, err, outFn: (l) => out.push(l), errFn: (l) => err.push(l) };
}

let seq = 0;
/** Commit on the current branch, staging ONLY the fixture file so the lane
 *  never swallows the untracked `.caws/` runtime state. */
function commit(root, message) {
  seq += 1;
  const rel = `lane-fixture-${seq}.txt`;
  fs.writeFileSync(path.join(root, rel), `${message}\n`);
  git(root, ['add', rel]);
  git(root, ['commit', '--quiet', '-m', message]);
}

/**
 * Register worktrees in the v11 flat-map registry and materialize each
 * recorded path, which is what resolveBinding matches cwd against.
 *
 * `owner` is OMITTED rather than written as null when absent: the registry
 * type is `owner?: SessionIdentity` and no production writer emits null, so a
 * null here would exercise a shape the system never produces.
 */
function writeRegistry(root, entries) {
  const registry = {};
  for (const [name, e] of Object.entries(entries)) {
    const wtPath = path.join(cawsDir(root), 'worktrees', name);
    fs.mkdirSync(wtPath, { recursive: true });
    registry[name] = {
      specId: e.specId ?? null,
      ...(e.owner !== undefined ? { owner: e.owner } : {}),
      branch: e.branch,
      baseBranch: e.baseBranch,
      path: wtPath,
    };
  }
  fs.writeFileSync(path.join(cawsDir(root), 'worktrees.json'), JSON.stringify(registry, null, 2));
}

function writeSpec(root, id, worktree) {
  fs.writeFileSync(
    path.join(cawsDir(root), 'specs', `${id}.yaml`),
    `id: ${id}
title: 'Lane divergence fixture'
risk_tier: 3
mode: chore
lifecycle_state: active
worktree: ${worktree}
created_at: '2026-09-16T00:00:00.000Z'
updated_at: '2026-09-16T00:00:00.000Z'
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
non_functional: {}
contracts: []
`
  );
}

function list(root) {
  const s = sinks();
  const code = runWorktreeListCommand({ cwd: root, out: s.outFn, err: s.errFn });
  return { code, text: s.out.join('\n'), err: s.err.join('\n') };
}

function status(root, cwd, opts = {}) {
  const s = sinks();
  const code = runStatusCommand({
    cwd,
    env: { ...process.env },
    out: s.outFn,
    err: s.errFn,
    ...opts,
  });
  return { code, text: s.out.join('\n'), err: s.err.join('\n') };
}

function eventCount(root) {
  const loaded = loadEvents(cawsDir(root));
  return loaded.ok ? loaded.value.events.length : 0;
}

/** The line of `worktree list` output describing one worktree. */
function rowFor(text, name) {
  const row = text.split('\n').find((l) => l.startsWith(name + ' '));
  if (row === undefined) throw new Error(`no row for ${name} in:\n${text}`);
  return row;
}

/**
 * A lane 2 commits ahead of a base that itself moved 3 commits.
 * Asymmetric counts on purpose: 2 vs 3 cannot survive an ahead/behind swap.
 */
function repoWithDivergedLane() {
  const root = mkRepo();
  git(root, ['checkout', '--quiet', '-b', 'wt-demo']);
  commit(root, 'lane commit 1');
  commit(root, 'lane commit 2');
  git(root, ['checkout', '--quiet', 'main']);
  commit(root, 'base commit 1');
  commit(root, 'base commit 2');
  commit(root, 'base commit 3');
  writeSpec(root, 'LANE-001', 'wt-demo');
  writeRegistry(root, {
    'wt-demo': { specId: 'LANE-001', branch: 'wt-demo', baseBranch: 'main' },
  });
  return root;
}

describe('WORKTREE-LANE-DIVERGENCE-SURFACE-001', () => {
  test('A1: worktree list reports the lane 2 ahead / 3 behind, matching git', () => {
    const root = repoWithDivergedLane();

    const r = list(root);
    expect(r.code).toBe(0);

    const row = rowFor(r.text, 'wt-demo');
    expect(row).toContain('ahead=2 behind=3');

    // Corroborate against git's own answer, so a reversed range argument fails
    // here and not only in the store unit test.
    expect(
      git(root, ['rev-list', '--left-right', '--count', 'main...wt-demo']).split(/\s+/)
    ).toEqual(['3', '2']);

    // A lane missing base commits is called out, with the reconcile options.
    expect(r.text).toContain('1 of 1 lane(s) are missing commits from their base');
    expect(r.text).toContain('git merge <base>');
    expect(r.text).toContain('caws worktree merge <name>');
    expect(r.text).toContain('Counts read local refs at this instant');
  });

  test('A2: a branch at base tip reads 0/0 and does not trip the stale-lane footer', () => {
    const root = mkRepo();
    commit(root, 'base commit 1');
    git(root, ['branch', 'wt-fresh']);
    writeRegistry(root, {
      'wt-fresh': { specId: null, branch: 'wt-fresh', baseBranch: 'main' },
    });

    const r = list(root);
    expect(r.code).toBe(0);
    expect(rowFor(r.text, 'wt-fresh')).toContain('ahead=0 behind=0');
    expect(r.text).not.toContain('missing commits from their base');
  });

  test('A3: an unresolvable branch ref degrades alone; sibling rows keep real counts', () => {
    const root = repoWithDivergedLane();
    // A second entry whose branch was deleted (or never existed).
    writeRegistry(root, {
      'wt-demo': { specId: 'LANE-001', branch: 'wt-demo', baseBranch: 'main' },
      'wt-ghost': { specId: null, branch: 'wt-deleted', baseBranch: 'main' },
    });

    const r = list(root);
    expect(r.code).toBe(0);

    // The broken row is explicitly unknown — NOT rendered as 0/0, which would
    // read as "this lane is current".
    expect(rowFor(r.text, 'wt-ghost')).toContain('ahead=? behind=?');
    expect(rowFor(r.text, 'wt-ghost')).not.toContain('ahead=0 behind=0');
    expect(r.text).toContain('Divergence unavailable:');
    expect(r.text).toContain("wt-ghost: branch ref 'wt-deleted' does not resolve");

    // One broken entry does not degrade the others.
    expect(rowFor(r.text, 'wt-demo')).toContain('ahead=2 behind=3');
  });

  test('A4: status inside a tracked worktree renders the lane + reconcile line, writing nothing', () => {
    const root = repoWithDivergedLane();
    const wtPath = path.join(cawsDir(root), 'worktrees', 'wt-demo');

    const registryPath = path.join(cawsDir(root), 'worktrees.json');
    const registryBefore = fs.readFileSync(registryPath, 'utf8');
    const eventsBefore = eventCount(root);

    const r = status(root, wtPath);
    expect(r.code).toBe(0);

    expect(r.text).toContain('lane:        wt-demo → main  ahead=2 behind=3');
    expect(r.text).toContain('this lane is missing 3 commit(s) from main');
    expect(r.text).toContain('`git merge main` from here');
    expect(r.text).toContain('`caws worktree merge wt-demo`');

    // Read-only by contract: status must not have touched the registry or the
    // hash-chained log.
    expect(fs.readFileSync(registryPath, 'utf8')).toBe(registryBefore);
    expect(eventCount(root)).toBe(eventsBefore);
  });

  test('A4b: a lane that contains base renders no reconcile line', () => {
    const root = mkRepo();
    git(root, ['checkout', '--quiet', '-b', 'wt-current']);
    commit(root, 'lane commit');
    git(root, ['checkout', '--quiet', 'main']);
    writeSpec(root, 'LANE-002', 'wt-current');
    writeRegistry(root, {
      'wt-current': { specId: 'LANE-002', branch: 'wt-current', baseBranch: 'main' },
    });

    const r = status(root, path.join(cawsDir(root), 'worktrees', 'wt-current'));
    expect(r.code).toBe(0);
    expect(r.text).toContain('lane:        wt-current → main  ahead=1 behind=0  (contains main)');
    expect(r.text).not.toContain('reconcile:');
  });

  test('A5: status from the canonical checkout renders no lane line at all', () => {
    const root = repoWithDivergedLane();

    const r = status(root, root);
    expect(r.code).toBe(0);
    expect(r.text).toContain('main checkout (no tracked worktree match)');
    // No placeholder, no zero-fill: the concept is simply absent.
    expect(r.text).not.toMatch(/^\s*lane:/m);
    expect(r.text).not.toContain('ahead=');
  });

  test('A5b: --short carries the lane inside a worktree and omits it outside', () => {
    const root = repoWithDivergedLane();
    const wtPath = path.join(cawsDir(root), 'worktrees', 'wt-demo');

    expect(status(root, wtPath, { short: true }).text).toContain(
      'lane:      wt-demo → main  ahead=2 behind=3'
    );
    expect(status(root, root, { short: true }).text).not.toMatch(/^\s*lane:/m);
  });

  test('A6: the status --json lane object agrees with the worktree list row', () => {
    const root = repoWithDivergedLane();
    const wtPath = path.join(cawsDir(root), 'worktrees', 'wt-demo');

    const payload = JSON.parse(status(root, wtPath, { json: true }).text);
    expect(payload.lane).toEqual({
      worktree: 'wt-demo',
      branch: 'wt-demo',
      base_branch: 'main',
      ahead: 2,
      behind: 3,
      contains_base: false,
      unknown_reason: null,
    });

    // Same numbers, other surface — the "one computation, two surfaces"
    // invariant stated as an equality rather than two independent literals.
    const row = rowFor(list(root).text, 'wt-demo');
    expect(row).toContain(`ahead=${payload.lane.ahead} behind=${payload.lane.behind}`);
  });

  test('A6b: a focused-panel JSON run omits lane, mirroring the text path', () => {
    const root = repoWithDivergedLane();
    const wtPath = path.join(cawsDir(root), 'worktrees', 'wt-demo');

    const payload = JSON.parse(status(root, wtPath, { json: true, worktrees: true }).text);
    expect(payload.lane).toBeUndefined();
    expect(payload.worktrees.count).toBe(1);
  });
});
