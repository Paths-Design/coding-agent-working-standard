/**
 * Tests for `caws waiver` (slice 7a.4) — vNext singular command surface.
 *
 * Coverage targets the 15 invariants the slice spec calls out:
 *   create  (5): atomic write, dup id, invalid id, invalid gate, expired-at
 *   list    (4): default exclusions, --include-revoked, --include-expired
 *   show    (2): display, missing
 *   revoke  (3): mark revoked, double-revoke, missing
 *   reg     (1): legacy plural `waivers` group is gone; sidecar waiver-draft
 *                remains (we don't touch it).
 *
 * Tests bypass Commander and call run*Command directly when possible —
 * faster and deterministic. The registration test spawns the real CLI so
 * we know the legacy plural truly disappeared at the user-visible surface.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  runWaiverCreateCommand,
  runWaiverListCommand,
  runWaiverShowCommand,
  runWaiverRevokeCommand,
} = require('../../dist/shell');
const { loadWaivers } = require('../../dist/store');

const NOW = new Date('2026-05-14T22:00:00.000Z');
const FUTURE_AT = '2027-01-01T00:00:00.000Z';
const PAST_AT = '2025-01-01T00:00:00.000Z';

function mkTempRepo(prefix) {
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

function capture(fn, args) {
  const out = [];
  const err = [];
  const code = fn({
    ...args,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

const VALID_CREATE_BASE = {
  title: 'Authorize a budget overrun for migration',
  gates: ['budget_limit'],
  reason: 'pre-approved scaffolding pass',
  approvedBy: 'lead@example.com',
  expiresAt: FUTURE_AT,
};

// ============================================================
// create
// ============================================================
describe('caws waiver create', () => {
  let repo;
  afterEach(() => rmrf(repo));

  // 1. atomically writes .caws/waivers/<id>.yaml
  it('writes .caws/waivers/<id>.yaml with status=active and matching content', () => {
    repo = mkTempRepo('caws-7a4-create-');
    const r = capture(runWaiverCreateCommand, {
      cwd: repo,
      now: () => NOW,
      id: 'WAIV-1',
      ...VALID_CREATE_BASE,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Waiver WAIV-1/);
    expect(r.stdout).toMatch(/Effectiveness:\s+active/);
    const filePath = path.join(repo, '.caws', 'waivers', 'WAIV-1.yaml');
    expect(fs.existsSync(filePath)).toBe(true);
    const body = fs.readFileSync(filePath, 'utf8');
    expect(body).toMatch(/^id: WAIV-1$/m);
    expect(body).toMatch(/^status: active$/m);
    expect(body).toMatch(/^created_at: '2026-05-14T22:00:00\.000Z'$/m);
    // Round-trip through the loader to prove it parses.
    const load = loadWaivers(path.join(repo, '.caws'));
    expect(load.diagnostics).toEqual([]);
    expect(load.waivers).toHaveLength(1);
    expect(load.waivers[0].id).toBe('WAIV-1');
    expect(load.waivers[0].status).toBe('active');
  });

  // 2. refuses duplicate id (exit 1)
  it('refuses a duplicate id with exit 1 and store.waivers.already_exists', () => {
    repo = mkTempRepo('caws-7a4-create-dup-');
    const first = capture(runWaiverCreateCommand, {
      cwd: repo, now: () => NOW, id: 'WAIV-1', ...VALID_CREATE_BASE,
    });
    expect(first.code).toBe(0);
    const second = capture(runWaiverCreateCommand, {
      cwd: repo, now: () => NOW, id: 'WAIV-1', ...VALID_CREATE_BASE,
    });
    expect(second.code).toBe(1);
    expect(second.stderr).toMatch(/already exists/);
    expect(second.stderr).toMatch(/store\.waivers\.already_exists/);
  });

  // 3. rejects invalid id (exit 1, validation diagnostic)
  it('rejects an invalid id with exit 1 and waiver.schema.invalid_id', () => {
    repo = mkTempRepo('caws-7a4-create-badid-');
    const r = capture(runWaiverCreateCommand, {
      cwd: repo, now: () => NOW, id: 'lowercase-bad', ...VALID_CREATE_BASE,
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/invalid waiver shape/);
    expect(r.stderr).toMatch(/waiver\.schema\.invalid_id/);
    // No file should have been written.
    expect(
      fs.existsSync(path.join(repo, '.caws', 'waivers', 'lowercase-bad.yaml'))
    ).toBe(false);
  });

  // 4. rejects invalid gate (kernel rejects empty/non-string entries)
  it('rejects empty gates array with exit 1 and waiver.schema.invalid_gates', () => {
    repo = mkTempRepo('caws-7a4-create-badgate-');
    const r = capture(runWaiverCreateCommand, {
      cwd: repo,
      now: () => NOW,
      id: 'WAIV-1',
      ...VALID_CREATE_BASE,
      gates: [],
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/waiver\.schema\.invalid_gates/);
  });

  // 5. expires_at semantics — currently the kernel ACCEPTS past dates as
  //    valid (expiry is derived at consult time, not validation time).
  //    The shell does not add an extra rule. This test pins that contract:
  //    a past expires_at writes successfully and is reported as 'expired'
  //    immediately. Doctor's job is to flag stale records, not create's.
  it('accepts an already-past expires_at and reports effectiveness=expired', () => {
    repo = mkTempRepo('caws-7a4-create-pastexp-');
    const r = capture(runWaiverCreateCommand, {
      cwd: repo,
      now: () => NOW,
      id: 'WAIV-1',
      ...VALID_CREATE_BASE,
      expiresAt: PAST_AT,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Effectiveness:\s+expired/);
  });
});

// ============================================================
// list
// ============================================================
describe('caws waiver list', () => {
  let repo;
  beforeEach(() => {
    repo = mkTempRepo('caws-7a4-list-');
    // Three waivers: one effective, one revoked, one expired.
    const create = (id, overrides = {}) =>
      capture(runWaiverCreateCommand, {
        cwd: repo, now: () => NOW, id, ...VALID_CREATE_BASE, ...overrides,
      });
    expect(create('WAIV-A-1').code).toBe(0); // active+effective
    expect(create('WAIV-B-1').code).toBe(0); // will be revoked
    expect(create('WAIV-C-1', { expiresAt: PAST_AT }).code).toBe(0); // expired
    // Revoke B.
    expect(
      capture(runWaiverRevokeCommand, {
        cwd: repo, now: () => NOW, id: 'WAIV-B-1', reason: 'rescinded',
      }).code
    ).toBe(0);
  });
  afterEach(() => rmrf(repo));

  // 6. default list excludes revoked
  // 7. default list excludes expired
  it('default list shows only effective waivers (excludes revoked AND expired)', () => {
    const r = capture(runWaiverListCommand, { cwd: repo, now: () => NOW });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/WAIV-A-1/);
    expect(r.stdout).not.toMatch(/WAIV-B-1/);
    expect(r.stdout).not.toMatch(/WAIV-C-1/);
    expect(r.stdout).toMatch(/1 shown of 3 total/);
  });

  // 8. --include-revoked
  it('--include-revoked includes revoked waivers but still excludes expired', () => {
    const r = capture(runWaiverListCommand, {
      cwd: repo, now: () => NOW, includeRevoked: true,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/WAIV-A-1/);
    expect(r.stdout).toMatch(/WAIV-B-1/);
    expect(r.stdout).not.toMatch(/WAIV-C-1/);
    // Revoked-row should carry the REVOKED label.
    expect(r.stdout).toMatch(/REVOKED.*WAIV-B-1/);
    // Active row precedes revoked row (stable ordering).
    const activeIdx = r.stdout.indexOf('WAIV-A-1');
    const revokedIdx = r.stdout.indexOf('WAIV-B-1');
    expect(activeIdx).toBeGreaterThan(-1);
    expect(revokedIdx).toBeGreaterThan(activeIdx);
  });

  // 9. --include-expired
  it('--include-expired includes expired waivers but still excludes revoked', () => {
    const r = capture(runWaiverListCommand, {
      cwd: repo, now: () => NOW, includeExpired: true,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/WAIV-A-1/);
    expect(r.stdout).not.toMatch(/WAIV-B-1/);
    expect(r.stdout).toMatch(/WAIV-C-1/);
    expect(r.stdout).toMatch(/EXPIRED.*WAIV-C-1/);
  });

  it('both --include-* show all three; ordering is active → revoked → expired', () => {
    const r = capture(runWaiverListCommand, {
      cwd: repo, now: () => NOW, includeRevoked: true, includeExpired: true,
    });
    expect(r.code).toBe(0);
    const aIdx = r.stdout.indexOf('WAIV-A-1');
    const bIdx = r.stdout.indexOf('WAIV-B-1');
    const cIdx = r.stdout.indexOf('WAIV-C-1');
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(cIdx).toBeGreaterThan(bIdx);
    expect(r.stdout).toMatch(/3 shown of 3 total/);
  });

  it('empty .caws/waivers/ exits 0 with a friendly message', () => {
    const empty = mkTempRepo('caws-7a4-list-empty-');
    try {
      const r = capture(runWaiverListCommand, { cwd: empty, now: () => NOW });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/No waivers in \.caws\/waivers\//);
    } finally {
      rmrf(empty);
    }
  });
});

// ============================================================
// show
// ============================================================
describe('caws waiver show', () => {
  let repo;
  beforeEach(() => {
    repo = mkTempRepo('caws-7a4-show-');
    expect(
      capture(runWaiverCreateCommand, {
        cwd: repo, now: () => NOW, id: 'WAIV-1', ...VALID_CREATE_BASE,
      }).code
    ).toBe(0);
  });
  afterEach(() => rmrf(repo));

  // 10. show displays the full waiver
  it('displays the full waiver detail with derived effectiveness', () => {
    const r = capture(runWaiverShowCommand, {
      cwd: repo, now: () => NOW, id: 'WAIV-1',
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Waiver WAIV-1/);
    expect(r.stdout).toMatch(/Status \(stored\):\s+active/);
    expect(r.stdout).toMatch(/Effectiveness:\s+active/);
    expect(r.stdout).toMatch(/Gates:\s+budget_limit/);
    expect(r.stdout).toMatch(/Approved by:\s+lead@example\.com/);
    expect(r.stdout).toMatch(/Expires at:\s+2027-01-01T00:00:00\.000Z/);
  });

  // 11. show with missing id exits 1
  it('exits 1 when the id is unknown with shell.waiver.not_found', () => {
    const r = capture(runWaiverShowCommand, {
      cwd: repo, now: () => NOW, id: 'WAIV-NOPE-1',
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not found/);
    expect(r.stderr).toMatch(/shell\.waiver\.not_found/);
  });

  it('exits 1 when id is empty', () => {
    const r = capture(runWaiverShowCommand, {
      cwd: repo, now: () => NOW, id: '',
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/id is required/);
  });
});

// ============================================================
// revoke
// ============================================================
describe('caws waiver revoke', () => {
  let repo;
  beforeEach(() => {
    repo = mkTempRepo('caws-7a4-revoke-');
    expect(
      capture(runWaiverCreateCommand, {
        cwd: repo, now: () => NOW, id: 'WAIV-1', ...VALID_CREATE_BASE,
      }).code
    ).toBe(0);
  });
  afterEach(() => rmrf(repo));

  // 12. revoke marks revoked with revocation record
  it('marks the waiver revoked and writes a revocation record', () => {
    const r = capture(runWaiverRevokeCommand, {
      cwd: repo,
      now: () => NOW,
      id: 'WAIV-1',
      revokedBy: 'auditor@example.com',
      reason: 'authority withdrawn',
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Effectiveness:\s+revoked/);
    expect(r.stdout).toMatch(/Revoked at:\s+2026-05-14T22:00:00\.000Z/);
    expect(r.stdout).toMatch(/Revoked by:\s+auditor@example\.com/);
    expect(r.stdout).toMatch(/Reason:\s+authority withdrawn/);
    // Reload from disk and confirm.
    const load = loadWaivers(path.join(repo, '.caws'));
    expect(load.diagnostics).toEqual([]);
    expect(load.waivers).toHaveLength(1);
    expect(load.waivers[0].status).toBe('revoked');
    expect(load.waivers[0].revocation).toBeDefined();
    expect(load.waivers[0].revocation.revoked_at).toBe(NOW.toISOString());
    expect(load.waivers[0].revocation.reason).toBe('authority withdrawn');
  });

  // 13. revoke refuses double-revoke (exit 1)
  it('refuses a second revoke with exit 1', () => {
    const first = capture(runWaiverRevokeCommand, {
      cwd: repo, now: () => NOW, id: 'WAIV-1',
    });
    expect(first.code).toBe(0);
    const second = capture(runWaiverRevokeCommand, {
      cwd: repo, now: () => NOW, id: 'WAIV-1',
    });
    expect(second.code).toBe(1);
    expect(second.stderr).toMatch(/cannot revoke/);
    expect(second.stderr).toMatch(/already revoked|already_exists/);
  });

  // 14. revoke missing id exits 1
  it('exits 1 when the id is unknown', () => {
    const r = capture(runWaiverRevokeCommand, {
      cwd: repo, now: () => NOW, id: 'WAIV-NOPE-1',
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/cannot revoke/);
    expect(r.stderr).toMatch(/store\.waivers\.not_found/);
  });
});

// ============================================================
// registration
// ============================================================
describe('caws waiver — registration surface', () => {
  // Spawn the real CLI binary's --help so we know the legacy plural is
  // gone at the user-visible surface, not just inside the shell module.
  const cliPath = path.join(__dirname, '../../dist/index.js');

  function runHelp(args = []) {
    return execFileSync('node', [cliPath, ...args], {
      cwd: path.join(__dirname, '../..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  // 15. exactly one waiver group; no plural waivers; sidecar waiver-draft intact;
  //     four expected subcommands; no `prune` subcommand.
  it('top-level help lists `waiver` and does NOT list plural `waivers`', () => {
    const help = runHelp(['--help']);
    // Singular present.
    expect(help).toMatch(/^\s*waiver\b/m);
    // Plural absent — both as a top-level group and as a separate command.
    expect(help).not.toMatch(/^\s*waivers\b/m);
  });

  it('`caws waiver --help` lists exactly create | list | show | revoke (no prune)', () => {
    const help = runHelp(['waiver', '--help']);
    expect(help).toMatch(/\bcreate\b/);
    expect(help).toMatch(/\blist\b/);
    expect(help).toMatch(/\bshow\b/);
    expect(help).toMatch(/\brevoke\b/);
    // Prune is intentionally NOT part of the vNext authority surface.
    expect(help).not.toMatch(/\bprune\b/);
  });

  // Slice 7a.4 originally guarded that `sidecar waiver-draft` survived
  // the legacy plural `waivers` removal. Under v11.0.0 cutover (slice
  // 8a3.4), the entire `caws sidecar` group is removed — A1 keeps the
  // surface narrow and `sidecar` is not part of the governed core. The
  // assertion is now inverted: `sidecar` must be absent from --help.
  it('sidecar group is removed from the v11 surface (A1)', () => {
    const help = runHelp(['--help']);
    expect(help).not.toMatch(/^\s*sidecar\b/m);
  });
});
