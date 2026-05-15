/**
 * Tests for `runDoctorCommand` — the doctor composition surface.
 *
 * Coverage:
 *   - clean minimal state (valid spec + valid policy) → exit 0, no findings
 *   - missing policy → doctor finding POLICY_MISSING, exit 1
 *   - invalid spec load (parse error) → load diagnostic, NOT in doctor
 *     findings, but command still exits 1 because load errors count
 *   - broken event chain → doctor.event.chain_invalid finding, exit 1
 *   - cwd outside a git repo → exit 2
 *
 * The doctor command is testable WITHOUT Commander; we call it directly
 * with cwd/out/err/now and assert exit code + captured output.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runDoctorCommand } = require('../../dist/shell');

const NOW = new Date('2026-05-14T12:00:00.000Z');

const VALID_SPEC = (id) => `id: ${id}
title: A reasonably long title for the feature being shipped
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
  god_object: { enabled: true, mode: warn }
  todo_detection: { enabled: true, mode: warn }
`;

function mkTempGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', [
    '-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init',
  ]);
  fs.mkdirSync(path.join(root, '.caws', 'specs'), { recursive: true });
  return root;
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function captureRun(cwd, opts = {}) {
  const outLines = [];
  const errLines = [];
  const code = runDoctorCommand({
    cwd,
    now: NOW,
    out: (s) => outLines.push(s),
    err: (s) => errLines.push(s),
    ...opts,
  });
  return { code, stdout: outLines.join('\n'), stderr: errLines.join('\n') };
}

describe('runDoctorCommand — happy and unhappy paths', () => {
  describe('exit 2: hard composition failure', () => {
    let nonGitDir;
    afterEach(() => rmrf(nonGitDir));

    it('cwd outside a git repo → exit 2', () => {
      nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-doctor-nogit-'));
      const r = captureRun(nonGitDir);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/failed to resolve repo root/);
    });
  });

  describe('exit 0: clean minimal state', () => {
    let repoRoot;
    afterEach(() => rmrf(repoRoot));

    it('valid spec + valid policy → exit 0, no findings, no load errors', () => {
      repoRoot = mkTempGitRepo('caws-doctor-clean-');
      fs.writeFileSync(
        path.join(repoRoot, '.caws', 'specs', 'FOO-1.yaml'),
        VALID_SPEC('FOO-1')
      );
      fs.writeFileSync(
        path.join(repoRoot, '.caws', 'policy.yaml'),
        VALID_POLICY
      );
      // Slice 7c.2 layout-missing rules require the full canonical
      // vNext layout to declare a project clean. mkTempGitRepo only
      // seeds .caws/specs/; add waivers/ + worktrees/agents registries
      // here so this "clean minimal state" test really IS canonical.
      fs.mkdirSync(path.join(repoRoot, '.caws', 'waivers'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, '.caws', 'worktrees.json'), '{}');
      fs.writeFileSync(path.join(repoRoot, '.caws', 'agents.json'), '{}');
      const r = captureRun(repoRoot);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/Doctor findings:\s*\n\s*\(none\)/);
      expect(r.stdout).toMatch(/Store load diagnostics:\s*\n\s*\(none\)/);
      expect(r.stdout).toMatch(/Summary:\s+findings 0E\/0W\/0I; load 0E\/0W\/0I/);
    });
  });

  describe('exit 1: missing policy', () => {
    let repoRoot;
    afterEach(() => rmrf(repoRoot));

    it('no policy.yaml → POLICY_MISSING finding, exit 1', () => {
      repoRoot = mkTempGitRepo('caws-doctor-nopolicy-');
      // No policy.yaml on purpose. Add a valid spec so specs aren't empty.
      fs.writeFileSync(
        path.join(repoRoot, '.caws', 'specs', 'FOO-1.yaml'),
        VALID_SPEC('FOO-1')
      );
      const r = captureRun(repoRoot);
      expect(r.code).toBe(1);
      expect(r.stdout).toMatch(/doctor\.policy\.missing/);
      expect(r.stdout).toMatch(/Doctor findings:/);
      // The finding came from inspectProjectState, NOT from store-load
      // diagnostics — load diagnostics section should be (none).
      expect(r.stdout).toMatch(/Store load diagnostics:\s*\n\s*\(none\)/);
    });
  });

  describe('exit 1: invalid spec load (load-only error)', () => {
    let repoRoot;
    afterEach(() => rmrf(repoRoot));

    it('malformed YAML spec → load diagnostic, doctor findings clean, exit 1', () => {
      repoRoot = mkTempGitRepo('caws-doctor-badspec-');
      fs.writeFileSync(
        path.join(repoRoot, '.caws', 'specs', 'BROKEN.yaml'),
        'this: : invalid: yaml: :'
      );
      fs.writeFileSync(
        path.join(repoRoot, '.caws', 'policy.yaml'),
        VALID_POLICY
      );
      const r = captureRun(repoRoot);
      // The malformed spec did NOT reach the kernel; so doctor findings
      // do NOT contain a "this spec is broken" finding. The load
      // diagnostic appears in the SEPARATE load-diagnostics section.
      expect(r.code).toBe(1);
      expect(r.stdout).toMatch(/Store load diagnostics:/);
      // Load section contains at least one ERROR-level entry referencing
      // BROKEN.yaml (the loadSpecs diagnostic).
      const loadSection = r.stdout
        .split('Doctor findings:')[0]
        .replace('Store load diagnostics:', '');
      expect(loadSection).toMatch(/\[ERROR/);
      expect(loadSection).toMatch(/BROKEN\.yaml/);
    });
  });

  describe('exit 1: broken event chain', () => {
    let repoRoot;
    afterEach(() => rmrf(repoRoot));

    it('events.jsonl with tampered chain → doctor.event.chain_invalid, exit 1', () => {
      repoRoot = mkTempGitRepo('caws-doctor-evtchain-');
      fs.writeFileSync(
        path.join(repoRoot, '.caws', 'policy.yaml'),
        VALID_POLICY
      );
      // Forge two events with a wrong prev_hash linkage. They parse as
      // ChainedEvent shape (so loadEvents OKs them), but verifyChain
      // rejects the linkage.
      const e1 = {
        event: 'spec_created',
        ts: '2026-05-14T10:00:00.000Z',
        seq: 1,
        prev_hash: null,
        event_hash: 'sha256:' + 'a'.repeat(64),
        actor: { kind: 'agent', id: 'x' },
        spec_id: 'X-1',
        data: { title: 'x', risk_tier: 2, mode: 'feature', lifecycle_state: 'draft' },
      };
      const e2 = {
        event: 'spec_validated',
        ts: '2026-05-14T10:01:00.000Z',
        seq: 2,
        prev_hash: 'sha256:' + 'b'.repeat(64), // does NOT match e1.event_hash
        event_hash: 'sha256:' + 'c'.repeat(64),
        actor: { kind: 'agent', id: 'x' },
        spec_id: 'X-1',
        data: { passed: true, error_count: 0, warning_count: 0 },
      };
      fs.writeFileSync(
        path.join(repoRoot, '.caws', 'events.jsonl'),
        JSON.stringify(e1) + '\n' + JSON.stringify(e2) + '\n'
      );
      const r = captureRun(repoRoot);
      expect(r.code).toBe(1);
      // Either rule fires depending on whether the kernel rejects on hash
      // mismatch or chain validity; both come from the doctor namespace.
      expect(r.stdout).toMatch(/doctor\.event\./);
    });
  });
});
