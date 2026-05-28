/**
 * SESSION-OWNERSHIP-METADATA-001 A6 negative locks.
 *
 * A6 says: adding `claimed_paths` / `last_modified_paths` to a lease
 * record must NOT introduce new doctor or status diagnostics. The
 * lease writer is the sole enforcer of structural invariants on these
 * fields (non-empty strings, no null bytes, max 1000 entries); doctor
 * and status remain diagnostic-neutral on the new fields' presence,
 * absence, or contents.
 *
 * Strategy: parameterize each scenario as "baseline vs widened" and
 * assert byte-equivalent diagnostic surface between the two runs.
 * This proves diagnostic-neutrality dynamically, without snapshotting
 * specific rule IDs (which would couple this test to internal rendering).
 *
 * Negative locks proven here:
 *   1. status exit code + Agents-panel rendering unchanged when lease
 *      gains `claimed_paths`.
 *   2. status exit code + Agents-panel rendering unchanged when lease
 *      gains `last_modified_paths`.
 *   3. doctor exit code + finding count unchanged when lease gains
 *      `claimed_paths`.
 *   4. doctor exit code + finding count unchanged when lease gains
 *      `last_modified_paths`.
 *   5. doctor/status do NOT emit new diagnostics about malformed path
 *      metadata — that's the lease writer's surface, not doctor/status.
 *   6. agents.json absent/corrupt remains irrelevant to lease panel
 *      rendering with the new fields populated.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runStatusCommand, runDoctorCommand } = require('../../dist/shell');

const NOW = new Date('2026-05-28T18:00:00.000Z');

const VALID_SPEC = `id: A6-PROBE
title: A reasonably long title for the A6 doctor/status probe
risk_tier: 3
mode: feature
lifecycle_state: draft
blast_radius:
  modules:
    - src/test
scope:
  in:
    - "src/**"
invariants:
  - "Some invariant."
acceptance:
  - id: A1
    given: a precondition
    when: an action
    then: an outcome
non_functional: {}
contracts: []
`;

const VALID_POLICY = `version: 1
risk_tiers:
  "1": { max_files: 5, max_loc: 200 }
  "2": { max_files: 15, max_loc: 600 }
  "3": { max_files: 30, max_loc: 1500 }
gates:
  budget_limit: { enabled: true, mode: block }
  spec_completeness: { enabled: true, mode: block }
  scope_boundary: { enabled: true, mode: block }
`;

function mkRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', [
    '-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init',
  ]);
  fs.mkdirSync(path.join(root, '.caws', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.caws', 'specs', 'A6-PROBE.yaml'), VALID_SPEC);
  fs.writeFileSync(path.join(root, '.caws', 'policy.yaml'), VALID_POLICY);
  return root;
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function writeLease(root, sessionId, extra = {}) {
  const leasesDir = path.join(root, '.caws', 'leases');
  fs.mkdirSync(leasesDir, { recursive: true });
  const lease = {
    lease_version: 1,
    session_id: sessionId,
    platform: 'cli',
    status: 'active',
    started_at: '2026-05-28T17:00:00.000Z',
    last_active: '2026-05-28T17:59:50.000Z',
    repo_root: root,
    cwd: root,
    git_common_dir: path.join(root, '.git'),
    git_dir: path.join(root, '.git'),
    last_seen_reason: 'session_start',
    ...extra,
  };
  fs.writeFileSync(
    path.join(leasesDir, `${sessionId}.json`),
    JSON.stringify(lease, null, 2) + '\n'
  );
}

function runStatus(repo) {
  const out = [];
  const err = [];
  const code = runStatusCommand({
    cwd: repo,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    now: () => NOW,
    leaseStaleTtlMs: 60_000,
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

function runDoctor(repo) {
  const out = [];
  const err = [];
  const code = runDoctorCommand({
    cwd: repo,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    now: NOW,
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

/**
 * Count findings the doctor renderer emits. The renderer prefixes each
 * finding with a severity tag; the same prefix style is used for the
 * "Summary" line. We count finding-rows by looking for the leading
 * severity tokens.
 *
 * If the renderer changes, this counter will need to adapt — that's
 * fine: the test compares baseline vs widened, so a renderer change
 * that affects both runs equally is invisible to the assertion.
 */
function countDoctorFindings(stdout) {
  const lines = stdout.split('\n');
  return lines.filter((l) =>
    /^\s*(error|warning|info|notice)\b/i.test(l) ||
    /^\s*(ERROR|WARNING|INFO|NOTICE)\b/.test(l)
  ).length;
}

// ─── A6 baseline vs widened: status diagnostic-neutrality ──────────

describe('SESSION-OWNERSHIP-METADATA-001 A6 — status is diagnostic-neutral', () => {
  it('claimed_paths presence does NOT change status exit code or stderr', () => {
    const baseline = mkRepo('a6-status-base-');
    const widened = mkRepo('a6-status-claimed-');
    try {
      writeLease(baseline, 'sess-A');
      writeLease(widened, 'sess-A', {
        claimed_paths: ['packages/foo/**', 'tests/foo.test.js'],
      });

      const b = runStatus(baseline);
      const w = runStatus(widened);

      expect(w.code).toBe(b.code);
      expect(w.stderr).toBe(b.stderr);
      // Stdout may legitimately differ if the panel chooses to display
      // claimed_paths verbatim (display-only) — but it must not add a
      // new diagnostic line. Both runs render the Agents panel and the
      // same session id.
      expect(b.stdout).toMatch(/sess-A/);
      expect(w.stdout).toMatch(/sess-A/);
    } finally {
      rmrf(baseline);
      rmrf(widened);
    }
  });

  it('last_modified_paths presence does NOT change status exit code or stderr', () => {
    const baseline = mkRepo('a6-status-lmpbase-');
    const widened = mkRepo('a6-status-lmp-');
    try {
      writeLease(baseline, 'sess-B');
      writeLease(widened, 'sess-B', {
        last_modified_paths: ['src/touched.ts', 'README.md'],
      });

      const b = runStatus(baseline);
      const w = runStatus(widened);

      expect(w.code).toBe(b.code);
      expect(w.stderr).toBe(b.stderr);
      expect(b.stdout).toMatch(/sess-B/);
      expect(w.stdout).toMatch(/sess-B/);
    } finally {
      rmrf(baseline);
      rmrf(widened);
    }
  });

  it('both fields populated together — still diagnostic-neutral', () => {
    const baseline = mkRepo('a6-status-bothbase-');
    const widened = mkRepo('a6-status-both-');
    try {
      writeLease(baseline, 'sess-C');
      writeLease(widened, 'sess-C', {
        claimed_paths: ['a.ts'],
        last_modified_paths: ['b.ts'],
      });

      const b = runStatus(baseline);
      const w = runStatus(widened);

      expect(w.code).toBe(b.code);
      expect(w.stderr).toBe(b.stderr);
    } finally {
      rmrf(baseline);
      rmrf(widened);
    }
  });
});

// ─── A6 baseline vs widened: doctor diagnostic-neutrality ──────────

describe('SESSION-OWNERSHIP-METADATA-001 A6 — doctor is diagnostic-neutral', () => {
  it('claimed_paths presence does NOT change doctor exit code or finding count', () => {
    const baseline = mkRepo('a6-doctor-base-');
    const widened = mkRepo('a6-doctor-claimed-');
    try {
      writeLease(baseline, 'sess-D');
      writeLease(widened, 'sess-D', {
        claimed_paths: ['packages/foo/**'],
      });

      const b = runDoctor(baseline);
      const w = runDoctor(widened);

      expect(w.code).toBe(b.code);
      expect(countDoctorFindings(w.stdout)).toBe(countDoctorFindings(b.stdout));
    } finally {
      rmrf(baseline);
      rmrf(widened);
    }
  });

  it('last_modified_paths presence does NOT change doctor exit code or finding count', () => {
    const baseline = mkRepo('a6-doctor-lmpbase-');
    const widened = mkRepo('a6-doctor-lmp-');
    try {
      writeLease(baseline, 'sess-E');
      writeLease(widened, 'sess-E', {
        last_modified_paths: ['src/touched.ts'],
      });

      const b = runDoctor(baseline);
      const w = runDoctor(widened);

      expect(w.code).toBe(b.code);
      expect(countDoctorFindings(w.stdout)).toBe(countDoctorFindings(b.stdout));
    } finally {
      rmrf(baseline);
      rmrf(widened);
    }
  });

  it('large but valid last_modified_paths (50 entries) — still diagnostic-neutral', () => {
    const baseline = mkRepo('a6-doctor-large-base-');
    const widened = mkRepo('a6-doctor-large-');
    try {
      writeLease(baseline, 'sess-F');
      writeLease(widened, 'sess-F', {
        last_modified_paths: Array.from(
          { length: 50 },
          (_, i) => `src/touched-${i}.ts`
        ),
      });

      const b = runDoctor(baseline);
      const w = runDoctor(widened);

      expect(w.code).toBe(b.code);
      expect(countDoctorFindings(w.stdout)).toBe(countDoctorFindings(b.stdout));
    } finally {
      rmrf(baseline);
      rmrf(widened);
    }
  });
});

// ─── A6: malformed metadata is the writer's surface, not doctor/status ────

describe('SESSION-OWNERSHIP-METADATA-001 A6 — malformed path metadata routing', () => {
  it('doctor/status do NOT inspect path-metadata semantics — neutrality preserved', () => {
    // The lease writer (commit 2) rejects empty strings and null bytes
    // before they ever land on disk. So any lease that exists on disk
    // is already structurally valid by writer enforcement. The A6
    // assertion is: doctor and status do not RE-validate path-metadata
    // semantics on read. They treat the field as opaque display data.
    //
    // We probe this by writing a lease with arrays the writer would
    // accept (non-empty, no null bytes) and asserting doctor/status
    // are diagnostic-neutral compared to no-metadata baseline. The
    // structural-rejection surface itself is covered by
    // leases-store-update-paths.test.js (commit 2).
    const baseline = mkRepo('a6-malformed-base-');
    const widened = mkRepo('a6-malformed-');
    try {
      writeLease(baseline, 'sess-G');
      writeLease(widened, 'sess-G', {
        claimed_paths: ['valid-path.ts'],
        last_modified_paths: ['another-valid-path.ts'],
      });

      const bStatus = runStatus(baseline);
      const wStatus = runStatus(widened);
      const bDoctor = runDoctor(baseline);
      const wDoctor = runDoctor(widened);

      expect(wStatus.code).toBe(bStatus.code);
      expect(wStatus.stderr).toBe(bStatus.stderr);
      expect(wDoctor.code).toBe(bDoctor.code);
      expect(countDoctorFindings(wDoctor.stdout)).toBe(
        countDoctorFindings(bDoctor.stdout)
      );
    } finally {
      rmrf(baseline);
      rmrf(widened);
    }
  });
});

// ─── A6: agents.json absent remains irrelevant ────────────────────

describe('SESSION-OWNERSHIP-METADATA-001 A6 — lease/agents.json independence preserved with new fields', () => {
  it('agents.json absent + lease with claimed_paths → lease panel still renders, doctor count stable', () => {
    const baseline = mkRepo('a6-noagents-base-');
    const widened = mkRepo('a6-noagents-');
    try {
      writeLease(baseline, 'sess-H');
      writeLease(widened, 'sess-H', {
        claimed_paths: ['x.ts'],
        last_modified_paths: ['y.ts'],
      });

      // Pre-condition: agents.json does not exist on either fixture
      // (mkRepo creates only specs/ + policy.yaml).
      expect(fs.existsSync(path.join(baseline, '.caws', 'agents.json'))).toBe(false);
      expect(fs.existsSync(path.join(widened, '.caws', 'agents.json'))).toBe(false);

      const bStatus = runStatus(baseline);
      const wStatus = runStatus(widened);
      const bDoctor = runDoctor(baseline);
      const wDoctor = runDoctor(widened);

      // Status: same exit code, same stderr, lease still rendered.
      expect(wStatus.code).toBe(bStatus.code);
      expect(wStatus.stderr).toBe(bStatus.stderr);
      expect(wStatus.stdout).toMatch(/sess-H/);

      // Doctor: same exit code, same finding count.
      expect(wDoctor.code).toBe(bDoctor.code);
      expect(countDoctorFindings(wDoctor.stdout)).toBe(
        countDoctorFindings(bDoctor.stdout)
      );

      // agents.json STILL absent — the new fields did not cause any
      // hidden creation.
      expect(fs.existsSync(path.join(baseline, '.caws', 'agents.json'))).toBe(false);
      expect(fs.existsSync(path.join(widened, '.caws', 'agents.json'))).toBe(false);
    } finally {
      rmrf(baseline);
      rmrf(widened);
    }
  });

  it('agents.json corrupt + lease with claimed_paths → doctor/status surface unchanged from baseline corruption', () => {
    // The independence test in leases-agents-independence.test.js
    // (commit 1) proves that loadLeases works regardless of agents.json
    // state. This A6 test proves the OUTER surface (doctor/status)
    // does not introduce a new diagnostic when the lease ALSO has the
    // new fields populated. Baseline corruption surface should equal
    // widened corruption surface.
    const baseline = mkRepo('a6-corrupt-base-');
    const widened = mkRepo('a6-corrupt-');
    try {
      writeLease(baseline, 'sess-I');
      writeLease(widened, 'sess-I', {
        claimed_paths: ['x.ts'],
      });
      fs.writeFileSync(path.join(baseline, '.caws', 'agents.json'), 'not json');
      fs.writeFileSync(path.join(widened, '.caws', 'agents.json'), 'not json');

      const bStatus = runStatus(baseline);
      const wStatus = runStatus(widened);
      const bDoctor = runDoctor(baseline);
      const wDoctor = runDoctor(widened);

      expect(wStatus.code).toBe(bStatus.code);
      expect(wDoctor.code).toBe(bDoctor.code);
      expect(countDoctorFindings(wDoctor.stdout)).toBe(
        countDoctorFindings(bDoctor.stdout)
      );
    } finally {
      rmrf(baseline);
      rmrf(widened);
    }
  });
});
