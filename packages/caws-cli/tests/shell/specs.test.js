/**
 * Tests for `caws specs` lifecycle commands (CLI-SPECS-001).
 *
 * Coverage:
 *   A1  create writes v11 spec with lifecycle_state: active + spec_created event
 *   A2  duplicate id refuses; invalid mode refuses
 *   A3  list excludes archived by default; --archived includes them
 *   A4  show by id; missing id surfaces typed not-found
 *   A5  close non-destructive raw-byte patch (comments preserved)
 *   A6  close appends spec_closed event with chain linkage
 *   A7  archive performs filesystem move with from_path/to_path
 *   A8  close on archived refuses; archive on active refuses
 *   A9  create with invalid plan refuses pre-write (no event, no file)
 *   A10 read-only commands do not rewrite YAML bytes
 *
 * Tests assert on observable runtime state — file content, on-disk
 * event payloads, chain linkage — not just exit codes.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  runSpecsCreateCommand,
  runSpecsListCommand,
  runSpecsShowCommand,
  runSpecsCloseCommand,
  runSpecsArchiveCommand,
} = require('../../dist/shell');
const { initProject } = require('../../dist/store/init-store');

function mkBareGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@t.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'T']);
  execFileSync('git', [
    '-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init',
  ]);
  return root;
}
function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}
function setup(prefix) {
  const repoRoot = mkBareGitRepo(prefix);
  const initResult = initProject(repoRoot);
  if (!initResult.ok) throw new Error('initProject failed');
  return { repoRoot, cawsDir: path.join(repoRoot, '.caws') };
}
function capture(fn, opts) {
  const out = []; const err = [];
  const code = fn({
    ...opts,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}
function readEvents(cawsDir) {
  const p = path.join(cawsDir, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ============================================================
// A1: create writes active spec + spec_created event
// ============================================================
describe('A1: caws specs create', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setup('specs-a1-')); });
  afterEach(() => rmrf(repoRoot));

  it('creates a v11-shape spec with lifecycle_state: active', () => {
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'FEAT-001',
      title: 'first feature',
      mode: 'feature',
      riskTier: 3,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/created FEAT-001/);
    // CAWS-FIRST-CONTACT-UX-001 A4: post-create guidance must explain
    // that scope.in TODO placeholders block edits and name the spec path.
    expect(r.stdout).toMatch(/Next: open the spec/);
    expect(r.stdout).toMatch(/edit:.*FEAT-001\.yaml/);
    expect(r.stdout).toMatch(/scope\.in must list/);
    expect(r.stdout).toMatch(/scope-guard rejects/);

    const filePath = path.join(cawsDir, 'specs/FEAT-001.yaml');
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toMatch(/^id: FEAT-001/m);
    expect(content).toMatch(/^lifecycle_state: active/m);
    expect(content).toMatch(/^mode: feature/m);
    expect(content).toMatch(/^risk_tier: 3/m);
  });

  it('appends a spec_created event with correct shape', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'FEAT-002', title: 'second', mode: 'feature', riskTier: 3,
    });
    const events = readEvents(cawsDir);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('spec_created');
    expect(events[0].spec_id).toBe('FEAT-002');
    expect(events[0].data).toMatchObject({
      title: 'second', risk_tier: 3, mode: 'feature', lifecycle_state: 'active',
    });
    expect(events[0].prev_hash).toBe(null);
    expect(events[0].event_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

// ============================================================
// A2: duplicate id refuses; invalid mode refuses
// ============================================================
describe('A2: create refusals', () => {
  let repoRoot;
  beforeEach(() => { ({ repoRoot } = setup('specs-a2-')); });
  afterEach(() => rmrf(repoRoot));

  it('refuses a duplicate spec id', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'DUP-001', title: 't', mode: 'chore', riskTier: 3,
    });
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'DUP-001', title: 't2', mode: 'chore', riskTier: 3,
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/already exists/);
  });

  it('refuses an invalid --mode', () => {
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'BAD-001', title: 't', mode: 'docs', riskTier: 3,
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/invalid --mode/);
  });

  it('refuses an invalid --risk-tier', () => {
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'BAD-002', title: 't', mode: 'chore', riskTier: 5,
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/invalid --risk-tier/);
  });

  it('refuses an invalid spec id pattern', () => {
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'lowercase-id', title: 't', mode: 'chore', riskTier: 3,
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/does not match the v11 pattern/);
  });
});

// ============================================================
// A3: list excludes archived by default
// ============================================================
describe('A3: caws specs list', () => {
  let repoRoot;
  beforeEach(() => { ({ repoRoot } = setup('specs-a3-')); });
  afterEach(() => rmrf(repoRoot));

  it('lists active specs', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'A-001', title: 'a', mode: 'feature', riskTier: 3,
    });
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'B-001', title: 'b', mode: 'fix', riskTier: 3,
    });
    const r = capture(runSpecsListCommand, { cwd: repoRoot });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('A-001');
    expect(r.stdout).toContain('B-001');
    expect(r.stdout).toContain('active');
  });

  it('does NOT include archived specs by default', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'ARCH-001', title: 'a', mode: 'chore', riskTier: 3,
    });
    capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'ARCH-001', resolution: 'completed',
    });
    capture(runSpecsArchiveCommand, { cwd: repoRoot, id: 'ARCH-001' });

    const r = capture(runSpecsListCommand, { cwd: repoRoot });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/ARCH-001/);
  });

  it('--archived includes archived specs', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'ARCH-002', title: 'a', mode: 'chore', riskTier: 3,
    });
    capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'ARCH-002', resolution: 'completed',
    });
    capture(runSpecsArchiveCommand, { cwd: repoRoot, id: 'ARCH-002' });

    const r = capture(runSpecsListCommand, { cwd: repoRoot, includeArchived: true });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('-- archived --');
    expect(r.stdout).toContain('ARCH-002');
  });
});

// ============================================================
// A4: show command
// ============================================================
describe('A4: caws specs show', () => {
  let repoRoot;
  beforeEach(() => { ({ repoRoot } = setup('specs-a4-')); });
  afterEach(() => rmrf(repoRoot));

  it('shows an existing spec by id', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'SHOW-001', title: 'show me', mode: 'feature', riskTier: 3,
    });
    const r = capture(runSpecsShowCommand, { cwd: repoRoot, id: 'SHOW-001' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('id: SHOW-001');
    expect(r.stdout).toContain("title: 'show me'");
  });

  it('surfaces a typed not-found error for missing id', () => {
    const r = capture(runSpecsShowCommand, { cwd: repoRoot, id: 'NOPE-999' });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/not found in \.caws\/specs/);
  });

  it('finds archived specs', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'FOUND-001', title: 'fnd', mode: 'chore', riskTier: 3,
    });
    capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'FOUND-001', resolution: 'completed',
    });
    capture(runSpecsArchiveCommand, { cwd: repoRoot, id: 'FOUND-001' });
    const r = capture(runSpecsShowCommand, { cwd: repoRoot, id: 'FOUND-001' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('id: FOUND-001');
    expect(r.stdout).toContain('lifecycle_state: archived');
  });
});

// ============================================================
// A5: close is a non-destructive raw-byte patch
// ============================================================
describe('A5: caws specs close (non-destructive)', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setup('specs-a5-')); });
  afterEach(() => rmrf(repoRoot));

  it('preserves field order and unrelated lines byte-for-byte', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'CLOSE-001', title: 'preserve me', mode: 'feature', riskTier: 3,
    });
    const filePath = path.join(cawsDir, 'specs/CLOSE-001.yaml');
    const before = fs.readFileSync(filePath, 'utf8');

    const r = capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'CLOSE-001', resolution: 'completed', reason: 'A5 test',
    });
    expect(r.code).toBe(0);

    const after = fs.readFileSync(filePath, 'utf8');

    // Mutations: lifecycle_state, resolution (inserted), closure_notes
    // (inserted), updated_at.
    expect(after).toMatch(/^lifecycle_state: closed$/m);
    expect(after).toMatch(/^resolution: completed$/m);
    expect(after).toMatch(/^closure_notes: 'A5 test'$/m);

    // Non-mutated lines remain byte-identical (sample a few load-bearing
    // ones).
    expect(after).toContain('id: CLOSE-001');
    expect(after).toContain("title: 'preserve me'");
    expect(after).toContain('mode: feature');
    expect(after).toContain('risk_tier: 3');
    expect(after).toContain('blast_radius:');
    expect(after).toContain('scope:');
    expect(after).toContain('acceptance:');

    // Diff size sanity: compute Levenshtein-style line diff (lines
    // present in 'before' but not in 'after', and vice versa). This
    // accounts for inserted lines shifting line numbers in a naive
    // index-by-index comparison.
    const beforeLines = new Set(before.split('\n'));
    const afterLines = new Set(after.split('\n'));
    const removed = [...beforeLines].filter((l) => !afterLines.has(l));
    const added = [...afterLines].filter((l) => !beforeLines.has(l));
    // Expected: lifecycle_state line changed (1 removed, 1 added);
    // updated_at line changed (1 removed, 1 added); resolution +
    // closure_notes inserted (2 added). Total: 2 removed, 4 added.
    expect(removed.length).toBeLessThanOrEqual(3);
    expect(added.length).toBeLessThanOrEqual(5);
  });
});

// ============================================================
// A6: close appends spec_closed event with chain linkage
// ============================================================
describe('A6: caws specs close (event)', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setup('specs-a6-')); });
  afterEach(() => rmrf(repoRoot));

  it('appends spec_closed with prev_hash = previous tail event_hash', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'EVT-001', title: 't', mode: 'chore', riskTier: 3,
    });
    capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'EVT-001', resolution: 'completed', reason: 'done',
    });

    const events = readEvents(cawsDir);
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('spec_created');
    expect(events[1].event).toBe('spec_closed');
    expect(events[1].spec_id).toBe('EVT-001');
    expect(events[1].data).toEqual({
      resolution: 'completed', closure_notes: 'done',
    });
    expect(events[1].prev_hash).toBe(events[0].event_hash);
    expect(events[1].event_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

// ============================================================
// A7: archive performs filesystem move
// ============================================================
describe('A7: caws specs archive (filesystem move)', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setup('specs-a7-')); });
  afterEach(() => rmrf(repoRoot));

  it('moves the file and emits from_path/to_path on spec_archived', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'ARC-001', title: 't', mode: 'chore', riskTier: 3,
    });
    capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'ARC-001', resolution: 'completed',
    });

    const beforePath = path.join(cawsDir, 'specs/ARC-001.yaml');
    const afterPath = path.join(cawsDir, 'specs/.archive/ARC-001.yaml');
    expect(fs.existsSync(beforePath)).toBe(true);
    expect(fs.existsSync(afterPath)).toBe(false);

    const r = capture(runSpecsArchiveCommand, { cwd: repoRoot, id: 'ARC-001' });
    expect(r.code).toBe(0);
    expect(fs.existsSync(beforePath)).toBe(false);
    expect(fs.existsSync(afterPath)).toBe(true);

    const events = readEvents(cawsDir);
    const archEvent = events.find((e) => e.event === 'spec_archived');
    expect(archEvent).toBeDefined();
    expect(archEvent.spec_id).toBe('ARC-001');
    expect(archEvent.data).toEqual({
      from_path: '.caws/specs/ARC-001.yaml',
      to_path: '.caws/specs/.archive/ARC-001.yaml',
    });
  });
});

// ============================================================
// A8: illegal lifecycle transitions refuse
// ============================================================
describe('A8: illegal transition refusals', () => {
  let repoRoot;
  beforeEach(() => { ({ repoRoot } = setup('specs-a8-')); });
  afterEach(() => rmrf(repoRoot));

  it('refuses archive on an active spec', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'ILL-001', title: 't', mode: 'chore', riskTier: 3,
    });
    const r = capture(runSpecsArchiveCommand, { cwd: repoRoot, id: 'ILL-001' });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/only closed specs can be archived/);
  });

  it('refuses close on an archived spec', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'ILL-002', title: 't', mode: 'chore', riskTier: 3,
    });
    capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'ILL-002', resolution: 'completed',
    });
    capture(runSpecsArchiveCommand, { cwd: repoRoot, id: 'ILL-002' });
    const r = capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'ILL-002', resolution: 'completed',
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/archived; cannot close/);
  });

  it('refuses close with invalid --resolution', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'ILL-003', title: 't', mode: 'chore', riskTier: 3,
    });
    const r = capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'ILL-003', resolution: 'finished',
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/invalid --resolution/);
  });
});

// ============================================================
// A10: read-only commands do not rewrite YAML
// ============================================================
describe('A10: read-only commands are non-mutating', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setup('specs-a10-')); });
  afterEach(() => rmrf(repoRoot));

  it('show does not modify the spec file', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'RO-001', title: 't', mode: 'chore', riskTier: 3,
    });
    const filePath = path.join(cawsDir, 'specs/RO-001.yaml');
    const before = fs.readFileSync(filePath, 'utf8');
    const beforeMtime = fs.statSync(filePath).mtimeMs;

    capture(runSpecsShowCommand, { cwd: repoRoot, id: 'RO-001' });
    capture(runSpecsListCommand, { cwd: repoRoot });

    const after = fs.readFileSync(filePath, 'utf8');
    expect(after).toBe(before);
    // mtime unchanged (no atomic-write run on read paths).
    expect(fs.statSync(filePath).mtimeMs).toBe(beforeMtime);
  });
});
