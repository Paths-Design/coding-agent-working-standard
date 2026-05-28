/**
 * Tests for CAWS-SPECS-ARCHIVE-COLLISION-REFUSAL-001:
 * tombstone identity on `caws specs create`.
 *
 * Behavior under test:
 *   - createSpec refuses ids that have a prior spec_archived event
 *     in .caws/events.jsonl, regardless of whether an active spec
 *     file or registry entry exists for that id.
 *   - The refusal is structured: non-zero exit, diagnostic names the
 *     spec id and suggests `caws specs recover <id>`.
 *
 * The existing `isArchivedViaTombstone` helper in specs-writer.ts
 * provides the authority signal; this slice elevates it from
 * diagnostic-only to enforcement at the createSpec entry.
 *
 * Note: A1 covers the happy path (never-used id, no archive collision).
 * A2 covers the standard tombstoned-id case. A3 covers the orphan
 * case where the registry is missing or stale but events.jsonl is the
 * authoritative source. A4 inspects the diagnostic text to confirm
 * the remediation guidance.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  runSpecsCreateCommand,
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
// A1: happy path — never-used id creates normally
// ============================================================
describe('A1: caws specs create on a never-used id', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setup('archive-coll-a1-')); });
  afterEach(() => rmrf(repoRoot));

  it('creates the spec normally; no archive-tombstone warning or error', () => {
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'NEVER-USED-01',
      title: 'first contact',
      mode: 'chore',
      riskTier: 3,
    });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/archived|tombstone|caws specs recover/i);
    const filePath = path.join(cawsDir, 'specs/NEVER-USED-01.yaml');
    expect(fs.existsSync(filePath)).toBe(true);
  });
});

// ============================================================
// A2: tombstoned id — full lifecycle, then re-create refuses
// ============================================================
describe('A2: caws specs create refuses an archived id', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setup('archive-coll-a2-')); });
  afterEach(() => rmrf(repoRoot));

  it('exits non-zero with a structured tombstone diagnostic naming the id and recover command', () => {
    // Full lifecycle: create → close → archive.
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'TOMBSTONE-01', title: 'lifecycle probe', mode: 'chore', riskTier: 3,
    });
    capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'TOMBSTONE-01', resolution: 'completed', reason: 'a2 setup',
    });
    const arch = capture(runSpecsArchiveCommand, {
      cwd: repoRoot, id: 'TOMBSTONE-01',
    });
    expect(arch.code).toBe(0);

    // Verify on-disk state: active file deleted (tombstone model),
    // events.jsonl has spec_archived for TOMBSTONE-01.
    expect(fs.existsSync(path.join(cawsDir, 'specs/TOMBSTONE-01.yaml'))).toBe(false);
    const archivedEvent = readEvents(cawsDir).find(
      (e) => e.event === 'spec_archived' && e.spec_id === 'TOMBSTONE-01'
    );
    expect(archivedEvent).toBeDefined();

    // Re-create attempt MUST refuse.
    const eventsBefore = readEvents(cawsDir).length;
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'TOMBSTONE-01', title: 'second life attempt', mode: 'chore', riskTier: 3,
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('TOMBSTONE-01');
    expect(r.stderr).toContain('caws specs recover');

    // No spec_created event was appended (refusal is pre-transaction).
    const eventsAfter = readEvents(cawsDir).length;
    expect(eventsAfter).toBe(eventsBefore);

    // No spec file was written.
    expect(fs.existsSync(path.join(cawsDir, 'specs/TOMBSTONE-01.yaml'))).toBe(false);
  });
});

// ============================================================
// A3: orphan registry — events.jsonl is the authority, not registry.json
// ============================================================
describe('A3: caws specs create refuses on a tombstone even when registry is empty', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setup('archive-coll-a3-')); });
  afterEach(() => rmrf(repoRoot));

  it('refusal still fires when registry.json has no entry for the archived id', () => {
    // Lifecycle: create → close → archive.
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'ORPHAN-01', title: 'orphan probe', mode: 'chore', riskTier: 3,
    });
    capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'ORPHAN-01', resolution: 'completed', reason: 'a3 setup',
    });
    capture(runSpecsArchiveCommand, {
      cwd: repoRoot, id: 'ORPHAN-01',
    });

    // Simulate partially-migrated / hand-edited state: nuke the
    // registry.json file entirely. The tombstone authority lives in
    // events.jsonl; the refusal must still fire from that source.
    const registryPath = path.join(cawsDir, 'specs/registry.json');
    if (fs.existsSync(registryPath)) fs.unlinkSync(registryPath);

    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'ORPHAN-01', title: 'orphan recreation', mode: 'chore', riskTier: 3,
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('ORPHAN-01');
    expect(r.stderr).toContain('caws specs recover');
  });
});

// ============================================================
// A4: diagnostic shape — no --force / --override; concrete recover
// ============================================================
describe('A4: tombstone refusal diagnostic shape', () => {
  let repoRoot;
  beforeEach(() => { ({ repoRoot } = setup('archive-coll-a4-')); });
  afterEach(() => rmrf(repoRoot));

  it('refusal suggests only `caws specs recover <id>` (no v10 --force / --override)', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'DIAG-01', title: 'diag probe', mode: 'chore', riskTier: 3,
    });
    capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'DIAG-01', resolution: 'completed',
    });
    capture(runSpecsArchiveCommand, {
      cwd: repoRoot, id: 'DIAG-01',
    });

    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'DIAG-01', title: 'diag recreate', mode: 'chore', riskTier: 3,
    });
    expect(r.code).not.toBe(0);
    // Concrete recover command with the spec id substituted in.
    expect(r.stderr).toMatch(/caws specs recover\s+DIAG-01/);
    // No v10 remediation flags.
    expect(r.stderr).not.toMatch(/--force/);
    expect(r.stderr).not.toMatch(/--override/);
  });
});
