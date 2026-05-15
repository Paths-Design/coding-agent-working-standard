/**
 * Slice 7c.3 — CLI doctor/status integration coverage for the new 7c.2
 * doctor rules.
 *
 * The kernel rule matrix is already well covered by tests/unit/doctor-
 * vnext-rules.test.ts (33 cases). This file is intentionally narrow:
 * smoke-level integration that proves the renderers, exit semantics,
 * and mutation-negative properties hold under planted conditions.
 *
 * Invariants under test:
 *
 *   doctor:
 *     1. canonical caws-init project → exit 0, "(none)" findings
 *     2. legacy working-spec.yaml residue → exit 1, rule rendered
 *     3. malformed worktrees.json → exit 1, registry-malformed rendered
 *     4. broad non_governed_zones + force → exit 1, posture rule rendered
 *     5. layout-missing warnings ALONE → exit 0 (warnings don't fail)
 *
 *   status (always exit 0; observability-only):
 *     6. status with planted error finding still exits 0 but counts show 1E
 *     7. status writes nothing under any of the above conditions
 *     8. status' top-finding section includes a 7c.2 rule when planted
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  runDoctorCommand,
  runInitCommand,
  runStatusCommand,
} = require('../../dist/shell');

function mkBareGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@t.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 't']);
  execFileSync('git', [
    '-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init',
  ]);
  return root;
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function cap(fn, opts) {
  const out = [];
  const err = [];
  const code = fn({
    ...opts,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

/**
 * Snapshot every file path + mtime under .caws/ so we can assert that
 * status didn't write anything. Simple deep-equal between two snapshots
 * is sufficient — content changes also bump mtime.
 */
function snapshotCaws(repoRoot) {
  const root = path.join(repoRoot, '.caws');
  if (!fs.existsSync(root)) return [];
  const out = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      const st = fs.statSync(p);
      out.push({
        path: path.relative(repoRoot, p),
        kind: entry.isDirectory() ? 'd' : 'f',
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
      if (entry.isDirectory()) walk(p);
    }
  }
  walk(root);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

// ============================================================
// 1. canonical init → exit 0, "(none)"
// ============================================================
describe('7c.3 / 1: canonical caws-init project', () => {
  let repo;
  afterEach(() => rmrf(repo));

  it('caws doctor on a freshly init-ed project exits 0 with no findings', () => {
    repo = mkBareGitRepo('7c3-1-');
    expect(cap(runInitCommand, { cwd: repo }).code).toBe(0);
    const r = cap(runDoctorCommand, { cwd: repo });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Doctor findings:\s*\n\s*\(none\)/);
    expect(r.stdout).toMatch(/Summary:\s+findings 0E\/0W\/0I/);
  });
});

// ============================================================
// 2. legacy working-spec.yaml residue → exit 1
// ============================================================
describe('7c.3 / 2: legacy residue', () => {
  let repo;
  afterEach(() => rmrf(repo));

  it('working-spec.yaml present → exit 1, doctor.init.legacy_working_spec_present rendered', () => {
    repo = mkBareGitRepo('7c3-2-');
    expect(cap(runInitCommand, { cwd: repo }).code).toBe(0);
    // Plant the legacy file AFTER init.
    fs.writeFileSync(
      path.join(repo, '.caws/working-spec.yaml'),
      'id: LEGACY-1\n'
    );
    const r = cap(runDoctorCommand, { cwd: repo });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/doctor\.init\.legacy_working_spec_present/);
    // Severity rendered correctly.
    expect(r.stdout).toMatch(/\[ERROR {2}\]\s+doctor\.init\.legacy_working_spec_present/);
    // Subject and repair both shown.
    expect(r.stdout).toMatch(/subject:\s+\.caws\/working-spec\.yaml/);
    expect(r.stdout).toMatch(/repair:\s+Move the file aside/);
    // Summary reflects 1 error.
    expect(r.stdout).toMatch(/Summary:\s+findings 1E/);
  });
});

// ============================================================
// 3. malformed worktrees.json → exit 1
// ============================================================
describe('7c.3 / 3: registry malformed', () => {
  let repo;
  afterEach(() => rmrf(repo));

  it('worktrees.json = "[]" → exit 1, doctor.registry.malformed_loaded rendered', () => {
    repo = mkBareGitRepo('7c3-3-');
    expect(cap(runInitCommand, { cwd: repo }).code).toBe(0);
    // Replace the well-formed empty registry with an array.
    fs.writeFileSync(path.join(repo, '.caws/worktrees.json'), '[]');
    const r = cap(runDoctorCommand, { cwd: repo });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/doctor\.registry\.malformed_loaded/);
    expect(r.stdout).toMatch(/\[ERROR {2}\]\s+doctor\.registry\.malformed_loaded/);
    expect(r.stdout).toMatch(/worktrees\.json is not a JSON object/);
    // Note: this is a finding, NOT a "Store load diagnostics" entry.
    // The store's REGISTRY_NOT_OBJECT diagnostic flows through the
    // 7c.1 registryDiagnostics surface and surfaces as a doctor
    // finding. The "Store load diagnostics" section is unrelated.
  });
});

// ============================================================
// 4. broad non_governed_zones + force → exit 1
// ============================================================
describe('7c.3 / 4: dangerous policy posture', () => {
  let repo;
  afterEach(() => rmrf(repo));

  it('non_governed_zones=["**"], force=true → exit 1, posture rule rendered', () => {
    repo = mkBareGitRepo('7c3-4-');
    expect(cap(runInitCommand, { cwd: repo }).code).toBe(0);
    // Overwrite the seeded policy with one that arms the broad pattern.
    const dangerousPolicy = `version: 1
risk_tiers:
  '1':
    max_files: 5
    max_loc: 200
  '2':
    max_files: 15
    max_loc: 600
  '3':
    max_files: 30
    max_loc: 1500
gates:
  budget_limit:
    enabled: true
    mode: block
  spec_completeness:
    enabled: true
    mode: block
  scope_boundary:
    enabled: true
    mode: block
non_governed_zones:
  - "**"
non_governed_zones_force: true
`;
    fs.writeFileSync(path.join(repo, '.caws/policy.yaml'), dangerousPolicy);
    const r = cap(runDoctorCommand, { cwd: repo });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/doctor\.policy\.non_governed_zone_broad/);
    expect(r.stdout).toMatch(/\[ERROR {2}\]\s+doctor\.policy\.non_governed_zone_broad/);
    expect(r.stdout).toMatch(/non_governed_zones_force=true/);
  });
});

// ============================================================
// 5. layout warnings only → exit 0
// ============================================================
describe('7c.3 / 5: warnings do not fail doctor', () => {
  let repo;
  afterEach(() => rmrf(repo));

  it('partial layout (waivers/ + agents.json missing) → exit 0, warnings rendered', () => {
    repo = mkBareGitRepo('7c3-5-');
    // Manually build a partially-canonical state. Skip init so we can
    // control which canonical pieces are present.
    fs.mkdirSync(path.join(repo, '.caws/specs'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.caws/policy.yaml'),
      `version: 1
risk_tiers:
  '1':
    max_files: 5
    max_loc: 200
  '2':
    max_files: 15
    max_loc: 600
  '3':
    max_files: 30
    max_loc: 1500
gates:
  budget_limit:
    enabled: true
    mode: block
  spec_completeness:
    enabled: true
    mode: block
  scope_boundary:
    enabled: true
    mode: block
`
    );
    fs.writeFileSync(path.join(repo, '.caws/worktrees.json'), '{}');
    // waivers/ dir missing, agents.json missing → two warnings.

    const r = cap(runDoctorCommand, { cwd: repo });
    expect(r.code).toBe(0); // warnings do not fail doctor
    expect(r.stdout).toMatch(/doctor\.init\.waivers_dir_missing/);
    expect(r.stdout).toMatch(/doctor\.init\.agents_registry_missing/);
    expect(r.stdout).toMatch(/\[WARN {3}\]\s+doctor\.init\.waivers_dir_missing/);
    expect(r.stdout).toMatch(/Summary:\s+findings 0E\/2W/);
  });
});

// ============================================================
// 6. status with planted error → exit 0, count shows 1E
// ============================================================
describe('7c.3 / 6: status exit semantics', () => {
  let repo;
  afterEach(() => rmrf(repo));

  it('status with a doctor error finding still exits 0', () => {
    repo = mkBareGitRepo('7c3-6-');
    expect(cap(runInitCommand, { cwd: repo }).code).toBe(0);
    fs.writeFileSync(
      path.join(repo, '.caws/working-spec.yaml'),
      'id: LEGACY-1\n'
    );
    const r = cap(runStatusCommand, { cwd: repo });
    // Status is observability — exit 0 regardless of findings.
    expect(r.code).toBe(0);
    // But the rendered Doctor section reflects the count.
    expect(r.stdout).toMatch(/Doctor[\s\S]*Summary:\s+1E/);
  });
});

// ============================================================
// 7. mutation-negative under planted issues
// ============================================================
describe('7c.3 / 7: status writes nothing under any of these conditions', () => {
  let repo;
  afterEach(() => rmrf(repo));

  it('status against legacy-residue project does not mutate .caws/', () => {
    repo = mkBareGitRepo('7c3-7-');
    expect(cap(runInitCommand, { cwd: repo }).code).toBe(0);
    fs.writeFileSync(
      path.join(repo, '.caws/working-spec.yaml'),
      'id: LEGACY-1\n'
    );

    const before = snapshotCaws(repo);
    expect(cap(runStatusCommand, { cwd: repo }).code).toBe(0);
    const after = snapshotCaws(repo);
    // Identical paths and mtimes.
    expect(after).toEqual(before);
    // Concrete absences enforced (defense in depth):
    expect(fs.existsSync(path.join(repo, '.caws/events.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.caws/sessions'))).toBe(false);
  });

  it('status against malformed-registry project does not mutate .caws/', () => {
    repo = mkBareGitRepo('7c3-7b-');
    expect(cap(runInitCommand, { cwd: repo }).code).toBe(0);
    fs.writeFileSync(path.join(repo, '.caws/worktrees.json'), '[]');
    const before = snapshotCaws(repo);
    expect(cap(runStatusCommand, { cwd: repo }).code).toBe(0);
    const after = snapshotCaws(repo);
    expect(after).toEqual(before);
  });

  it('status against dangerous-policy project does not mutate .caws/', () => {
    repo = mkBareGitRepo('7c3-7c-');
    expect(cap(runInitCommand, { cwd: repo }).code).toBe(0);
    const dangerousPolicy = `version: 1
risk_tiers:
  '1':
    max_files: 5
    max_loc: 200
  '2':
    max_files: 15
    max_loc: 600
  '3':
    max_files: 30
    max_loc: 1500
gates:
  budget_limit:
    enabled: true
    mode: block
  spec_completeness:
    enabled: true
    mode: block
  scope_boundary:
    enabled: true
    mode: block
non_governed_zones:
  - "**"
non_governed_zones_force: true
`;
    fs.writeFileSync(path.join(repo, '.caws/policy.yaml'), dangerousPolicy);
    const before = snapshotCaws(repo);
    expect(cap(runStatusCommand, { cwd: repo }).code).toBe(0);
    const after = snapshotCaws(repo);
    expect(after).toEqual(before);
  });
});

// ============================================================
// 8. status top-finding section surfaces 7c.2 rules
// ============================================================
describe('7c.3 / 8: status top-finding section', () => {
  let repo;
  afterEach(() => rmrf(repo));

  it('renders a 7c.2 rule in the Doctor section when planted', () => {
    repo = mkBareGitRepo('7c3-8-');
    expect(cap(runInitCommand, { cwd: repo }).code).toBe(0);
    fs.writeFileSync(
      path.join(repo, '.caws/working-spec.yaml'),
      'id: LEGACY-1\n'
    );
    const r = cap(runStatusCommand, { cwd: repo });
    expect(r.code).toBe(0);
    // The Doctor section in the status panel shows the rule.
    expect(r.stdout).toMatch(/Doctor[\s\S]*doctor\.init\.legacy_working_spec_present/);
  });
});
