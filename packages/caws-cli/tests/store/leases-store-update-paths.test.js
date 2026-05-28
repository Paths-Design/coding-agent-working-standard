/**
 * Tests for the SESSION-OWNERSHIP-METADATA-001 (lease-substrate
 * amendment) commit 2 store-side apply branch.
 *
 * Covers the new `update_lease_paths` LeasePatch variant in
 * applyLeasePatch:
 *   - existing lease + valid patch -> atomic-write with merged fields,
 *     preserving every other on-disk field byte-semantically
 *   - missing lease -> warn-no-op (NOT a fabrication route)
 *   - malformed prior lease -> Err, no partial write
 *   - per-field undefined -> leave-alone (prior value preserved)
 *   - empty array -> explicit "no claims" state replaces any prior
 *
 * No CLI surface tested here (caws claim --paths is commit 3).
 * No policy schema tested here (commit 4).
 * No new agents.json reads/writes (FROZEN — preserved).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyLeasePatch, STORE_RULES } = require('../../dist/store');

function mkTempCawsDir() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'leases-update-paths-'));
  const cawsDir = path.join(repoRoot, '.caws');
  fs.mkdirSync(cawsDir, { recursive: true });
  return { repoRoot, cawsDir };
}

function makeLease(sessionId, overrides = {}) {
  return {
    lease_version: 1,
    session_id: sessionId,
    platform: 'claude-code',
    status: 'active',
    started_at: '2026-05-28T00:00:00.000Z',
    last_active: '2026-05-28T01:00:00.000Z',
    repo_root: '/tmp/repo',
    cwd: '/tmp/repo',
    git_common_dir: '/tmp/repo/.git',
    git_dir: '/tmp/repo/.git',
    last_seen_reason: 'session_start',
    bound_worktree: 'wt-foo',
    bound_spec_id: 'SPEC-FOO-001',
    ...overrides,
  };
}

function writeLeaseFile(cawsDir, sessionId, lease) {
  const leasesDir = path.join(cawsDir, 'leases');
  fs.mkdirSync(leasesDir, { recursive: true });
  fs.writeFileSync(
    path.join(leasesDir, `${sessionId}.json`),
    JSON.stringify(lease, null, 2) + '\n'
  );
}

function readLeaseFile(cawsDir, sessionId) {
  const filePath = path.join(cawsDir, 'leases', `${sessionId}.json`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

describe('SESSION-OWNERSHIP-METADATA-001 commit 2: applyLeasePatch update_lease_paths', () => {
  describe('A2/A3: write merged lease, preserving other fields', () => {
    it('writes claimed_paths and preserves every other field byte-semantically', () => {
      const { repoRoot, cawsDir } = mkTempCawsDir();
      try {
        const prior = makeLease('sess-1');
        writeLeaseFile(cawsDir, 'sess-1', prior);

        const r = applyLeasePatch(cawsDir, {
          kind: 'update_lease_paths',
          session_id: 'sess-1',
          claimed_paths: ['packages/foo/**', 'tests/foo.test.js'],
        });

        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.wrote).toBe(true);

        const after = readLeaseFile(cawsDir, 'sess-1');
        expect(after.claimed_paths).toEqual([
          'packages/foo/**',
          'tests/foo.test.js',
        ]);
        // Every prior field unchanged.
        expect(after.lease_version).toBe(1);
        expect(after.session_id).toBe('sess-1');
        expect(after.platform).toBe('claude-code');
        expect(after.status).toBe('active');
        expect(after.started_at).toBe(prior.started_at);
        expect(after.last_active).toBe(prior.last_active);
        expect(after.last_seen_reason).toBe('session_start');
        expect(after.bound_worktree).toBe('wt-foo');
        expect(after.bound_spec_id).toBe('SPEC-FOO-001');
      } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it('writes last_modified_paths and preserves other fields', () => {
      const { repoRoot, cawsDir } = mkTempCawsDir();
      try {
        writeLeaseFile(cawsDir, 'sess-2', makeLease('sess-2'));

        const r = applyLeasePatch(cawsDir, {
          kind: 'update_lease_paths',
          session_id: 'sess-2',
          last_modified_paths: ['packages/foo/src/index.ts'],
        });

        expect(r.ok).toBe(true);
        const after = readLeaseFile(cawsDir, 'sess-2');
        expect(after.last_modified_paths).toEqual([
          'packages/foo/src/index.ts',
        ]);
        expect(after.claimed_paths).toBeUndefined();
      } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it('writes both fields in a single patch', () => {
      const { repoRoot, cawsDir } = mkTempCawsDir();
      try {
        writeLeaseFile(cawsDir, 'sess-3', makeLease('sess-3'));

        const r = applyLeasePatch(cawsDir, {
          kind: 'update_lease_paths',
          session_id: 'sess-3',
          claimed_paths: ['a'],
          last_modified_paths: ['b'],
        });

        expect(r.ok).toBe(true);
        const after = readLeaseFile(cawsDir, 'sess-3');
        expect(after.claimed_paths).toEqual(['a']);
        expect(after.last_modified_paths).toEqual(['b']);
      } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });
  });

  describe('per-field undefined = leave-alone', () => {
    it('omitting claimed_paths in the patch preserves the prior claimed_paths', () => {
      const { repoRoot, cawsDir } = mkTempCawsDir();
      try {
        writeLeaseFile(
          cawsDir,
          'sess-keep',
          makeLease('sess-keep', { claimed_paths: ['prior/a', 'prior/b'] })
        );

        const r = applyLeasePatch(cawsDir, {
          kind: 'update_lease_paths',
          session_id: 'sess-keep',
          last_modified_paths: ['x'],
        });

        expect(r.ok).toBe(true);
        const after = readLeaseFile(cawsDir, 'sess-keep');
        expect(after.claimed_paths).toEqual(['prior/a', 'prior/b']);
        expect(after.last_modified_paths).toEqual(['x']);
      } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it('explicit empty array replaces prior (sets "no claims" state)', () => {
      const { repoRoot, cawsDir } = mkTempCawsDir();
      try {
        writeLeaseFile(
          cawsDir,
          'sess-clear',
          makeLease('sess-clear', { claimed_paths: ['prior/a'] })
        );

        const r = applyLeasePatch(cawsDir, {
          kind: 'update_lease_paths',
          session_id: 'sess-clear',
          claimed_paths: [],
        });

        expect(r.ok).toBe(true);
        const after = readLeaseFile(cawsDir, 'sess-clear');
        expect(after.claimed_paths).toEqual([]);
      } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });
  });

  describe('defensive refusal at the store boundary', () => {
    it('missing lease file -> warn-no-op (NOT a fabrication route)', () => {
      const { repoRoot, cawsDir } = mkTempCawsDir();
      try {
        // No lease file written. Apply against absent target.
        const r = applyLeasePatch(cawsDir, {
          kind: 'update_lease_paths',
          session_id: 'sess-absent',
          claimed_paths: ['a'],
        });

        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.value.wrote).toBe(false);
          expect(r.value.diagnostics).toHaveLength(1);
          expect(r.value.diagnostics[0].rule).toBe(
            STORE_RULES.LEASE_STOP_NO_PRIOR_LEASE
          );
        }

        // No file was fabricated.
        const filePath = path.join(cawsDir, 'leases', 'sess-absent.json');
        expect(fs.existsSync(filePath)).toBe(false);
      } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it('malformed prior lease file -> Err with LEASE_FILE_MALFORMED, no partial write', () => {
      const { repoRoot, cawsDir } = mkTempCawsDir();
      try {
        const leasesDir = path.join(cawsDir, 'leases');
        fs.mkdirSync(leasesDir, { recursive: true });
        const filePath = path.join(leasesDir, 'sess-malformed.json');
        fs.writeFileSync(filePath, '{ not json');

        const r = applyLeasePatch(cawsDir, {
          kind: 'update_lease_paths',
          session_id: 'sess-malformed',
          claimed_paths: ['a'],
        });

        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.errors[0].rule).toBe(STORE_RULES.LEASE_FILE_MALFORMED);
        }
        // File still has the original malformed content; no partial write.
        expect(fs.readFileSync(filePath, 'utf8')).toBe('{ not json');
      } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it('unsafe session_id -> Err before any file operation', () => {
      const { repoRoot, cawsDir } = mkTempCawsDir();
      try {
        const r = applyLeasePatch(cawsDir, {
          kind: 'update_lease_paths',
          session_id: '../escape',
          claimed_paths: ['a'],
        });

        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(
            r.errors.some(
              (e) =>
                e.rule === STORE_RULES.LEASE_SESSION_ID_UNSAFE ||
                e.rule === STORE_RULES.LEASE_SESSION_ID_INVALID
            )
          ).toBe(true);
        }
      } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });
  });

  describe('A7 negative lock: no agents.json touch', () => {
    it('update_lease_paths does NOT create .caws/agents.json', () => {
      const { repoRoot, cawsDir } = mkTempCawsDir();
      try {
        writeLeaseFile(cawsDir, 'sess-noaj', makeLease('sess-noaj'));

        const r = applyLeasePatch(cawsDir, {
          kind: 'update_lease_paths',
          session_id: 'sess-noaj',
          claimed_paths: ['a'],
        });

        expect(r.ok).toBe(true);
        // The agents.json file must NOT have been created by this path.
        const agentsPath = path.join(cawsDir, 'agents.json');
        expect(fs.existsSync(agentsPath)).toBe(false);
      } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it('update_lease_paths does NOT create or touch .caws/events.jsonl', () => {
      const { repoRoot, cawsDir } = mkTempCawsDir();
      try {
        writeLeaseFile(cawsDir, 'sess-noev', makeLease('sess-noev'));

        const r = applyLeasePatch(cawsDir, {
          kind: 'update_lease_paths',
          session_id: 'sess-noev',
          last_modified_paths: ['a', 'b', 'c'],
        });

        expect(r.ok).toBe(true);
        const eventsPath = path.join(cawsDir, 'events.jsonl');
        expect(fs.existsSync(eventsPath)).toBe(false);
      } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });
  });

  describe('no regression on existing variants', () => {
    it('write_lease still works (substrate unchanged)', () => {
      const { repoRoot, cawsDir } = mkTempCawsDir();
      try {
        const lease = makeLease('sess-w');
        const r = applyLeasePatch(cawsDir, {
          kind: 'write_lease',
          session_id: 'sess-w',
          lease,
        });
        expect(r.ok).toBe(true);
        const after = readLeaseFile(cawsDir, 'sess-w');
        expect(after.session_id).toBe('sess-w');
      } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it('mark_stopped still works (substrate unchanged)', () => {
      const { repoRoot, cawsDir } = mkTempCawsDir();
      try {
        writeLeaseFile(cawsDir, 'sess-s', makeLease('sess-s'));
        const r = applyLeasePatch(cawsDir, {
          kind: 'mark_stopped',
          session_id: 'sess-s',
          transitioned_at: '2026-05-28T02:00:00.000Z',
        });
        expect(r.ok).toBe(true);
        const after = readLeaseFile(cawsDir, 'sess-s');
        expect(after.status).toBe('stopped');
      } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it('delete_lease still works (substrate unchanged)', () => {
      const { repoRoot, cawsDir } = mkTempCawsDir();
      try {
        writeLeaseFile(cawsDir, 'sess-d', makeLease('sess-d'));
        const r = applyLeasePatch(cawsDir, {
          kind: 'delete_lease',
          session_id: 'sess-d',
        });
        expect(r.ok).toBe(true);
        const filePath = path.join(cawsDir, 'leases', 'sess-d.json');
        expect(fs.existsSync(filePath)).toBe(false);
      } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });
  });
});
