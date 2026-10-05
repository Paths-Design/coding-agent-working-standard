'use strict';

/**
 * Contract tests for CAWS-WORKTREE-LIST-JSON-PARITY-01.
 *
 * `caws worktree list` is the AUTHORITY surface for worktree ownership and
 * spec binding — and it had no machine rendering at all. Every other read
 * surface in the group has one, so a tool that needed authoritative ownership
 * had to scrape a padded, column-aligned text table or read
 * .caws/worktrees.json directly and re-implement the divergence join.
 *
 * The parity obligation runs both ways: every fact on a human row must appear
 * in the JSON entry, and --json may add machine detail (the full owner session
 * id where the row prints an eight-character prefix) but may never be the only
 * place a fact lives.
 *
 * The discriminating pair here is "a lane at base tip" versus "a lane whose
 * ref does not resolve". Both are the absence of a positive count, and
 * flattening the second into `ahead: 0, behind: 0` would report the one answer
 * that is actively wrong — "this lane is current". A payload that always
 * emitted nulls would satisfy the unresolvable case alone, so the up-to-date
 * case is asserted alongside it.
 */

const fs = require('fs');
const path = require('path');

const { runWorktreeListCommand } = require('../../dist/shell/commands/worktree');
const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, git, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

function cawsDir(root) {
  return path.join(root, '.caws');
}

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) {
    throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  }
  return root;
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
  const rel = `json-fixture-${seq}.txt`;
  fs.writeFileSync(path.join(root, rel), `${message}\n`);
  git(root, ['add', rel]);
  git(root, ['commit', '--quiet', '-m', message]);
}

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

function list(root, opts = {}) {
  const s = sinks();
  const code = runWorktreeListCommand({ cwd: root, out: s.outFn, err: s.errFn, ...opts });
  return { code, out: s.out, text: s.out.join('\n'), err: s.err.join('\n') };
}

function listJson(root) {
  const r = list(root, { json: true });
  return { ...r, payload: JSON.parse(r.text) };
}

function byName(payload, name) {
  return payload.worktrees.find((w) => w.name === name);
}

/**
 * A repo with three lanes covering the three divergence outcomes:
 *   lane-behind   1 ahead, 2 behind, bound + owned
 *   lane-current  at base tip (real zeros), unbound + unowned
 *   lane-broken   branch ref does not resolve
 */
function mkThreeLaneRepo() {
  const root = mkRepo();
  commit(root, 'base-1');
  git(root, ['checkout', '--quiet', '-b', 'lane-behind']);
  commit(root, 'lane-behind-1');
  git(root, ['checkout', '--quiet', 'main']);
  commit(root, 'base-2');
  commit(root, 'base-3');
  git(root, ['checkout', '--quiet', '-b', 'lane-current']);
  git(root, ['checkout', '--quiet', 'main']);

  writeRegistry(root, {
    'wt-behind': {
      branch: 'lane-behind',
      baseBranch: 'main',
      specId: 'SPEC-BEHIND',
      owner: { session_id: '11112222-3333-4444-5555-666677778888', platform: 'test' },
    },
    'wt-current': { branch: 'lane-current', baseBranch: 'main' },
    'wt-broken': { branch: 'no-such-branch', baseBranch: 'main', specId: 'SPEC-BROKEN' },
  });
  return root;
}

describe('CAWS-WORKTREE-LIST-JSON-PARITY-01', () => {
  // ── C1: the payload exists and is well-shaped ──────────────────────────
  test('C1: --json emits a parseable payload with one fully-populated entry per registry row', () => {
    const root = mkThreeLaneRepo();
    const { code, payload, text } = listJson(root);

    expect(code).toBe(0);
    // Nothing but JSON on stdout — a stray prose line would break every
    // consumer and is the usual way a --json flag is half-implemented.
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text).not.toContain('Reconcile now');

    expect(payload.ok).toBe(true);
    expect(payload.source).toBe('.caws/worktrees.json');
    expect(typeof payload.computed_at).toBe('string');
    expect(Number.isNaN(Date.parse(payload.computed_at))).toBe(false);
    expect(payload.worktrees.map((w) => w.name).sort()).toEqual([
      'wt-behind',
      'wt-broken',
      'wt-current',
    ]);

    const behind = byName(payload, 'wt-behind');
    expect(behind.branch).toBe('lane-behind');
    expect(behind.base_branch).toBe('main');
    expect(behind.spec_id).toBe('SPEC-BEHIND');
    expect(behind.owner.session_id).toBe('11112222-3333-4444-5555-666677778888');
    expect(typeof behind.path).toBe('string');
    expect(behind.divergence).toEqual({
      ahead: 1,
      behind: 2,
      contains_base: false,
      unknown_reason: null,
    });
  });

  test('C1b: an unbound, unowned worktree reports null rather than a placeholder string', () => {
    const root = mkThreeLaneRepo();
    const current = byName(listJson(root).payload, 'wt-current');
    // The human row prints "(unbound)" and "unowned"; those are rendering
    // choices. A machine consumer gets the absence itself.
    expect(current.spec_id).toBeNull();
    expect(current.owner).toBeNull();
  });

  // ── C2: bidirectional parity ───────────────────────────────────────────
  test('C2: every fact on a human row is present in the matching JSON entry', () => {
    const root = mkThreeLaneRepo();
    const human = list(root);
    const { payload } = listJson(root);

    for (const entry of payload.worktrees) {
      const row = human.out.find((l) => l.startsWith(entry.name));
      expect(row).toBeDefined();
      expect(row).toContain(entry.branch);
      expect(row).toContain(entry.base_branch);
      expect(row).toContain(entry.spec_id ?? '(unbound)');
      expect(row).toContain(entry.path);
    }
  });

  test('C2b: the row’s abbreviated owner is a PREFIX of the JSON session id, not a different fact', () => {
    const root = mkThreeLaneRepo();
    const row = list(root).out.find((l) => l.startsWith('wt-behind'));
    const entry = byName(listJson(root).payload, 'wt-behind');

    // Abbreviation is allowed; omission is not. The row shows 8 chars, the
    // payload the whole id, and the former must be the head of the latter.
    expect(row).toContain('owner=11112222');
    expect(entry.owner.session_id.startsWith('11112222')).toBe(true);
    expect(entry.owner.session_id.length).toBeGreaterThan(8);
  });

  // ── C3 + the discriminating counterweight ──────────────────────────────
  test('C3: an unresolvable ref reports null counts with a reason, never zeros', () => {
    const root = mkThreeLaneRepo();
    const broken = byName(listJson(root).payload, 'wt-broken');

    expect(broken.divergence.ahead).toBeNull();
    expect(broken.divergence.behind).toBeNull();
    expect(typeof broken.divergence.unknown_reason).toBe('string');
    expect(broken.divergence.unknown_reason.length).toBeGreaterThan(0);
    expect(broken.divergence.unknown_reason).toContain('no-such-branch');
    // The assertion that matters: zero would read as "this lane is current".
    expect(broken.divergence.ahead).not.toBe(0);
    expect(broken.divergence.behind).not.toBe(0);
  });

  test('C3b: a lane genuinely at base tip reports REAL zeros, so null is not a blanket answer', () => {
    // Without this, an implementation that emitted null for every lane would
    // satisfy C3 while destroying the surface's actual information.
    const root = mkThreeLaneRepo();
    const current = byName(listJson(root).payload, 'wt-current');

    expect(current.divergence.ahead).toBe(0);
    expect(current.divergence.behind).toBe(0);
    expect(current.divergence.unknown_reason).toBeNull();
  });

  // ── C4: empty registry is a successful read ────────────────────────────
  test('C4: no registered worktrees yields an empty array and exit 0, not an error', () => {
    const root = mkRepo();
    const { code, payload, err } = listJson(root);

    expect(code).toBe(0);
    expect(err).toBe('');
    expect(payload.ok).toBe(true);
    expect(payload.worktrees).toEqual([]);
    expect(payload.counts.total).toBe(0);
    expect(payload.counts.behind_base).toBe(0);
    expect(payload.counts.divergence_unavailable).toBe(0);
  });

  // ── C5: the footer signal reaches the machine reader too ───────────────
  test('C5: counts carry the behind-base signal the human footer states in prose', () => {
    const root = mkThreeLaneRepo();
    const human = list(root);
    const { payload } = listJson(root);

    // The human form prints "<n> of <m> lane(s) are missing commits...".
    expect(human.text).toContain('1 of 3 lane(s) are missing commits');
    expect(payload.counts).toEqual({
      total: 3,
      behind_base: 1,
      divergence_unavailable: 1,
    });
  });

  test('C5b: with every lane current the footer is silent and behind_base is 0', () => {
    // The must-stay-quiet side. A counts field hardcoded to 1 would pass C5.
    const root = mkRepo();
    commit(root, 'base-1');
    git(root, ['checkout', '--quiet', '-b', 'lane-tip']);
    git(root, ['checkout', '--quiet', 'main']);
    writeRegistry(root, { 'wt-tip': { branch: 'lane-tip', baseBranch: 'main' } });

    const human = list(root);
    const { payload } = listJson(root);
    expect(human.text).not.toContain('missing commits');
    expect(payload.counts.behind_base).toBe(0);
    expect(payload.counts.divergence_unavailable).toBe(0);
    expect(payload.counts.total).toBe(1);
  });

  // ── the surface stays read-only ────────────────────────────────────────
  test('--json does not write to the registry', () => {
    const root = mkThreeLaneRepo();
    const registryPath = path.join(cawsDir(root), 'worktrees.json');
    const before = fs.readFileSync(registryPath, 'utf8');
    const beforeMtime = fs.statSync(registryPath).mtimeMs;

    expect(listJson(root).code).toBe(0);

    expect(fs.readFileSync(registryPath, 'utf8')).toBe(before);
    expect(fs.statSync(registryPath).mtimeMs).toBe(beforeMtime);
  });
});
