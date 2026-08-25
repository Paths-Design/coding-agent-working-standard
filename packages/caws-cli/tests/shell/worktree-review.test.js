'use strict';

/**
 * Contract tests for WORKTREE-REVIEW-SURFACE-001.
 *
 * A1: a registered lane ahead of base by an in-scope commit and an
 *     out-of-scope commit => exit 0, both commits listed with short SHA +
 *     subject, the out-of-scope path flagged with the exact merge refusal,
 *     and zero .caws/ byte changes / zero events appended.
 * A2: bound spec with one recorded-pass AC and one unchecked AC => the
 *     spec-readiness section renders pass (with evidence_ref) + unchecked and
 *     names the close-gate consequence.
 * A3: worktree entry records owner S and S's lease carries work_state
 *     review_ready + note => owner-context section in text and JSON; an
 *     absent owner/lease degrades to no section, never an error.
 * A4: no such worktree registered => exit 1 with the not-found handoff naming
 *     the list; nothing written.
 * A5: an empty lane (branch at base) => exit 0 with an honest
 *     "(lane is empty — branch is at base)"; no crash, no fabricated rows.
 *
 * Real on-disk git+caws repos; injected sinks. Command under test is the
 * read-only review surface, so the contract is that it renders a truthful
 * preview of the merge provenance gate and never mutates anything.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const { runWorktreeReviewCommand } = require('../../dist/shell/commands/worktree');
const { initProject } = require('../../dist/store/init-store');
const { loadEvents } = require('../../dist/store/events-store');
const { loadSpecs } = require('../../dist/store/specs-store');

const repos = [];
afterAll(() => {
  for (const r of repos) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function mkRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-review-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  const r = initProject(root);
  if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
  repos.push(root);
  return root;
}

function sinks() {
  const out = [];
  const err = [];
  return { out, err, outFn: (l) => out.push(l), errFn: (l) => err.push(l) };
}

function cawsDir(root) {
  return path.join(root, '.caws');
}

/** Write a valid spec fixture under the canonical .caws/specs/. */
function writeSpec(root, id, overrides = {}) {
  const spec = {
    id,
    title: `${id} review fixture`,
    risk_tier: 3,
    mode: 'feature',
    lifecycle_state: 'active',
    blast_radius: { modules: ['src'] },
    scope: { in: ['src'] },
    invariants: ['read-only review fixture invariant'],
    acceptance: [{ id: 'A1', given: 'g', when: 'w', then: 't' }],
    non_functional: {},
    contracts: [],
    ...overrides,
  };
  fs.writeFileSync(path.join(cawsDir(root), 'specs', `${id}.yaml`), yaml.dump(spec));
  const loaded = loadSpecs(cawsDir(root));
  if (!loaded.specs.some((s) => s.id === id)) {
    const msgs = loaded.diagnostics.map((d) => `${d.rule}: ${d.message}`).join(' | ');
    throw new Error(`writeSpec(${id}) produced an invalid spec: ${msgs}`);
  }
  return spec;
}

/** Write the flat-map worktree registry entries for review to resolve. */
function writeRegistry(root, entries) {
  fs.writeFileSync(
    path.join(cawsDir(root), 'worktrees.json'),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(entries).map(([name, e]) => [
          name,
          {
            specId: e.specId,
            owner: e.owner ?? null,
            branch: e.branch,
            baseBranch: e.baseBranch,
            path: path.join(cawsDir(root), 'worktrees', name),
          },
        ])
      ),
      null,
      2
    )
  );
}

/** Create a commit on the CURRENT branch adding `files` (path -> content).
 *  Stages ONLY the named files so the lane never swallows the fixture's
 *  `.caws/` working-tree state (which is not part of the lane). */
function addCommit(root, message, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  execFileSync('git', ['-C', root, 'add', ...Object.keys(files)]);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', message]);
}

function review(root, name, opts = {}) {
  const s = sinks();
  const code = runWorktreeReviewCommand({
    name,
    cwd: root,
    env: { ...process.env },
    out: s.outFn,
    err: s.errFn,
    ...(opts.json === true ? { json: true } : {}),
  });
  return { code, out: s.out, err: s.err };
}

function eventCount(root) {
  const loaded = loadEvents(cawsDir(root));
  if (!loaded.ok) return 0;
  return loaded.value.events.length;
}

describe('WORKTREE-REVIEW-SURFACE-001', () => {
  test('A1: renders exact commits + provenance table, flags out-of-scope, mutates nothing', () => {
    const root = mkRepo();
    writeSpec(root, 'WREV-001');

    execFileSync('git', ['-C', root, 'checkout', '--quiet', '-b', 'wt-demo']);
    addCommit(root, 'feat(ok): in-scope change', { 'src/ok.ts': 'export const ok = 1;\n' });
    addCommit(root, 'fix(foreign): out-of-scope note', { 'note/foreign.md': '# foreign\n' });
    execFileSync('git', ['-C', root, 'checkout', '--quiet', 'main']);

    writeRegistry(root, {
      'wt-demo': { specId: 'WREV-001', branch: 'wt-demo', baseBranch: 'main' },
    });

    const wtMtimeBefore = fs.statSync(path.join(cawsDir(root), 'worktrees.json')).mtimeMs;
    const eventsBefore = eventCount(root);

    const r = review(root, 'wt-demo');
    expect(r.code).toBe(0);
    const text = r.out.join('\n');
    expect(text).toContain('worktree review: wt-demo');
    // Exact commit list (never counts-only): both subjects present.
    expect(text).toContain('in-scope change');
    expect(text).toContain('out-of-scope note');
    // Provenance table flags the out-of-scope path and names the merge refusal.
    expect(text).toContain('OUT-OF-SCOPE note/foreign.md');
    expect(text).toContain('merge refuses: lane branch contains commit');
    expect(text).toContain('outside spec scope: note/foreign.md');
    // In-scope path renders as admitted.
    expect(text).toContain('in-scope   src/ok.ts');

    // Read-only: no .caws/ byte changes, no events appended.
    expect(fs.statSync(path.join(cawsDir(root), 'worktrees.json')).mtimeMs).toBe(wtMtimeBefore);
    expect(eventCount(root)).toBe(eventsBefore);
  });

  test('A2: spec-readiness renders pass + unchecked and names the close-gate consequence', () => {
    const root = mkRepo();
    writeSpec(root, 'WREV-002', {
      acceptance: [
        { id: 'A1', given: 'g', when: 'w', then: 't' },
        { id: 'A2', given: 'g', when: 'w', then: 't' },
      ],
      evidence: [
        {
          criterion_id: 'A1',
          status: 'pass',
          evidence_ref: 'npm test',
          recorded_at: '2026-08-25T00:00:00.000Z',
        },
      ],
    });
    writeRegistry(root, {
      'wt-demo': { specId: 'WREV-002', branch: 'main', baseBranch: 'main' },
    });

    const r = review(root, 'wt-demo');
    expect(r.code).toBe(0);
    const text = r.out.join('\n');
    expect(text).toContain('Spec readiness (WREV-002, active):');
    expect(text).toContain('A1 PASS  (npm test)');
    expect(text).toContain('A2 UNCHECKED');
    expect(text).toContain('does not satisfy closure');
  });

  test('A3: owner context renders work_state + note + age; JSON carries the fields; absent degrades', () => {
    const root = mkRepo();
    writeSpec(root, 'WREV-003');
    const now = new Date().toISOString();
    // Owner lease file must match the registered owner session_id.
    fs.mkdirSync(path.join(cawsDir(root), 'leases'), { recursive: true });
    fs.writeFileSync(
      path.join(cawsDir(root), 'leases', 'owner-session.json'),
      JSON.stringify({
        session_id: 'owner-session',
        platform: 'dsh',
        status: 'active',
        work_state: 'review_ready',
        work_state_note: 'awaiting human review',
        last_active: now,
      })
    );
    writeRegistry(root, {
      'wt-demo': {
        specId: 'WREV-003',
        branch: 'main',
        baseBranch: 'main',
        owner: { session_id: 'owner-session', platform: 'dsh' },
      },
    });

    const textRes = review(root, 'wt-demo');
    expect(textRes.code).toBe(0);
    const text = textRes.out.join('\n');
    expect(text).toContain('Owner context (owner-session):');
    expect(text).toContain('work_state: review_ready — awaiting human review');
    expect(text).toMatch(/last active: \d+(s|m|h|d) ago/);

    const jsonRes = review(root, 'wt-demo', { json: true });
    expect(jsonRes.code).toBe(0);
    const report = JSON.parse(jsonRes.out[0]);
    expect(report.ownerContext.workState).toBe('review_ready');
    expect(report.ownerContext.workStateNote).toBe('awaiting human review');
    expect(typeof report.ownerContext.lastActiveAgeMs).toBe('number');

    // Absent owner/lease degrades to no owner context, never an error.
    writeRegistry(root, {
      'wt-demo': { specId: 'WREV-003', branch: 'main', baseBranch: 'main' },
    });
    const degraded = review(root, 'wt-demo');
    expect(degraded.code).toBe(0);
    expect(degraded.out.join('\n')).not.toContain('Owner context');
  });

  test('A4: unregistered worktree exits 1 with the not-found handoff', () => {
    const root = mkRepo();
    writeSpec(root, 'WREV-004');
    const r = review(root, 'wt-missing');
    expect(r.code).toBe(1);
    const text = r.err.join('\n');
    expect(text).toContain('no worktree "wt-missing" is registered');
    expect(text).toContain('Registered worktrees');
  });

  test('A5: empty lane renders honestly, no fabricated rows', () => {
    const root = mkRepo();
    writeSpec(root, 'WREV-005');
    writeRegistry(root, {
      'wt-demo': { specId: 'WREV-005', branch: 'main', baseBranch: 'main' },
    });

    const r = review(root, 'wt-demo');
    expect(r.code).toBe(0);
    const text = r.out.join('\n');
    expect(text).toContain('lane is empty — branch is at base');
    expect(text).toContain('(no commits to verify)');
  });
});
