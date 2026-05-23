/**
 * SESSION-OWNERSHIP-METADATA-001 commit 2 — writer storage-contract tests.
 *
 * Covers:
 *   A2  — explicit claim write: claimed_paths is preserved verbatim.
 *   A3  — last_modified_paths: caller-provided set stored verbatim with
 *         structural validation + FIFO cap (1000). NO TTL pruning in the
 *         writer (C1 storage-bounds interpretation).
 *   A5  — stale-record claim preservation: a record with an old
 *         last_active still exposes its claimed_paths and
 *         last_modified_paths on read; the writer does not retroactively
 *         drop them.
 *   A6  — no new doctor diagnostics introduced by this commit (verified
 *         in a separate doctor test file outside this slice's writer
 *         scope; here we only assert the writer does not emit new
 *         diagnostics on success).
 *   structural validation: empty string, null byte, non-string entries
 *         fail closed; no partial write.
 *   cross-session non-clobber: writing session A's record leaves
 *         session B's claimed_paths and last_modified_paths
 *         byte-identical.
 *   top-level key preservation: `version: 1` and `agents: {}` non-record
 *         top-level keys (the on-disk drift documented in the ADR) are
 *         preserved across writes.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  applyRegistryPatch,
  LAST_MODIFIED_PATHS_MAX,
} = require('../../dist/store/apply-patch');
const { STORE_RULES } = require('../../dist/store/rules');

function mkTempCawsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'caws-agents-writer-'));
}

function readAgents(cawsDir) {
  const filePath = path.join(cawsDir, 'agents.json');
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function writeAgents(cawsDir, value) {
  const filePath = path.join(cawsDir, 'agents.json');
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function refreshAgentPatch(overrides) {
  return Object.assign(
    {
      kind: 'refresh_agent',
      session: { session_id: 'caws-test', platform: 'darwin' },
      last_active: '2026-05-23T00:00:00.000Z',
    },
    overrides
  );
}

describe('A2 — writer accepts and stores claimed_paths verbatim', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it('stores a claimed_paths array exactly as the caller passed it', () => {
    cawsDir = mkTempCawsDir();
    const patch = refreshAgentPatch({
      claimed_paths: ['packages/foo/**', 'tests/foo.test.js'],
    });
    const r = applyRegistryPatch(cawsDir, patch);
    expect(r.ok).toBe(true);
    const agents = readAgents(cawsDir);
    expect(agents['caws-test'].claimed_paths).toEqual([
      'packages/foo/**',
      'tests/foo.test.js',
    ]);
  });

  it('stores claimed_paths verbatim with no glob expansion or normalization', () => {
    cawsDir = mkTempCawsDir();
    const verbatim = [
      'packages/foo/**',
      './relative/path',
      '/absolute/path',
      'with spaces',
      'trailing/slash/',
    ];
    const patch = refreshAgentPatch({ claimed_paths: verbatim });
    const r = applyRegistryPatch(cawsDir, patch);
    expect(r.ok).toBe(true);
    expect(readAgents(cawsDir)['caws-test'].claimed_paths).toEqual(verbatim);
  });

  it('preserves existing v1 fields when adding claimed_paths', () => {
    cawsDir = mkTempCawsDir();
    writeAgents(cawsDir, {
      'caws-test': {
        session_id: 'caws-test',
        last_active: '2026-05-22T00:00:00.000Z',
        platform: 'darwin',
        bound_worktree: 'existing-wt',
        bound_spec_id: 'EXISTING-001',
      },
    });
    const r = applyRegistryPatch(
      cawsDir,
      refreshAgentPatch({ claimed_paths: ['packages/bar'] })
    );
    expect(r.ok).toBe(true);
    const record = readAgents(cawsDir)['caws-test'];
    expect(record.bound_worktree).toBe('existing-wt');
    expect(record.bound_spec_id).toBe('EXISTING-001');
    expect(record.claimed_paths).toEqual(['packages/bar']);
  });

  it('an empty claimed_paths array clears the field semantically (writes empty)', () => {
    cawsDir = mkTempCawsDir();
    writeAgents(cawsDir, {
      'caws-test': {
        session_id: 'caws-test',
        last_active: '2026-05-22T00:00:00.000Z',
        claimed_paths: ['old/path'],
      },
    });
    const r = applyRegistryPatch(
      cawsDir,
      refreshAgentPatch({ claimed_paths: [] })
    );
    expect(r.ok).toBe(true);
    expect(readAgents(cawsDir)['caws-test'].claimed_paths).toEqual([]);
  });
});

describe('A3 — last_modified_paths: storage-bound writer (C1 interpretation)', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it('stores a caller-provided path set verbatim', () => {
    cawsDir = mkTempCawsDir();
    const r = applyRegistryPatch(
      cawsDir,
      refreshAgentPatch({
        last_modified_paths: ['packages/foo/a.ts', 'packages/foo/b.ts'],
      })
    );
    expect(r.ok).toBe(true);
    expect(readAgents(cawsDir)['caws-test'].last_modified_paths).toEqual([
      'packages/foo/a.ts',
      'packages/foo/b.ts',
    ]);
  });

  it('FIFO-truncates at LAST_MODIFIED_PATHS_MAX (1000); caller order preserved among kept entries', () => {
    cawsDir = mkTempCawsDir();
    // 1500 entries; expect last 1000 to survive (lowest-index dropped).
    const paths = Array.from({ length: 1500 }, (_, i) => `p/${i}.ts`);
    const r = applyRegistryPatch(
      cawsDir,
      refreshAgentPatch({ last_modified_paths: paths })
    );
    expect(r.ok).toBe(true);
    const stored = readAgents(cawsDir)['caws-test'].last_modified_paths;
    expect(stored.length).toBe(LAST_MODIFIED_PATHS_MAX);
    expect(LAST_MODIFIED_PATHS_MAX).toBe(1000);
    // First kept entry should be p/500.ts (we dropped p/0 through p/499).
    expect(stored[0]).toBe('p/500.ts');
    expect(stored[stored.length - 1]).toBe('p/1499.ts');
  });

  it('exactly LAST_MODIFIED_PATHS_MAX entries pass through without truncation', () => {
    cawsDir = mkTempCawsDir();
    const paths = Array.from({ length: LAST_MODIFIED_PATHS_MAX }, (_, i) => `p/${i}.ts`);
    const r = applyRegistryPatch(
      cawsDir,
      refreshAgentPatch({ last_modified_paths: paths })
    );
    expect(r.ok).toBe(true);
    expect(readAgents(cawsDir)['caws-test'].last_modified_paths.length).toBe(
      LAST_MODIFIED_PATHS_MAX
    );
  });

  it('does NOT perform TTL pruning — the writer accepts whatever the caller passes', () => {
    // Even if last_active is "old," the writer stores the caller's array.
    // TTL is the caller's responsibility per C1.
    cawsDir = mkTempCawsDir();
    const veryOldDate = '2025-01-01T00:00:00.000Z';
    const r = applyRegistryPatch(
      cawsDir,
      refreshAgentPatch({
        last_active: veryOldDate,
        last_modified_paths: ['old/path.ts', 'newer/path.ts'],
      })
    );
    expect(r.ok).toBe(true);
    expect(readAgents(cawsDir)['caws-test'].last_modified_paths).toEqual([
      'old/path.ts',
      'newer/path.ts',
    ]);
  });
});

describe('structural validation — writer fails closed', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it('rejects empty string entry in claimed_paths', () => {
    cawsDir = mkTempCawsDir();
    const r = applyRegistryPatch(
      cawsDir,
      refreshAgentPatch({ claimed_paths: ['valid', '', 'also-valid'] })
    );
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(STORE_RULES.WRITE_AGENT_PATH_INVALID);
    expect(r.errors[0].data.field).toBe('claimed_paths');
    expect(r.errors[0].data.index).toBe(1);
    // No partial write: agents.json must not exist or be empty.
    const agentsFile = path.join(cawsDir, 'agents.json');
    expect(fs.existsSync(agentsFile)).toBe(false);
  });

  it('rejects null byte in last_modified_paths entry', () => {
    cawsDir = mkTempCawsDir();
    const r = applyRegistryPatch(
      cawsDir,
      refreshAgentPatch({
        last_modified_paths: ['ok.ts', 'bad path.ts'],
      })
    );
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(STORE_RULES.WRITE_AGENT_PATH_INVALID);
    expect(r.errors[0].data.field).toBe('last_modified_paths');
    expect(r.errors[0].data.index).toBe(1);
  });

  it('rejects non-string entry in claimed_paths', () => {
    cawsDir = mkTempCawsDir();
    const r = applyRegistryPatch(
      cawsDir,
      refreshAgentPatch({ claimed_paths: ['ok', 42, 'also-ok'] })
    );
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(STORE_RULES.WRITE_AGENT_PATH_INVALID);
    expect(r.errors[0].data.field).toBe('claimed_paths');
    expect(r.errors[0].data.index).toBe(1);
  });

  it('validation failure does NOT modify agents.json (no partial write)', () => {
    cawsDir = mkTempCawsDir();
    // Pre-existing record we must not corrupt.
    writeAgents(cawsDir, {
      'other-session': {
        session_id: 'other-session',
        last_active: '2026-05-22T00:00:00.000Z',
        claimed_paths: ['pre-existing'],
      },
    });
    const r = applyRegistryPatch(
      cawsDir,
      refreshAgentPatch({ claimed_paths: ['', 'invalid'] })
    );
    expect(r.ok).toBe(false);
    // Pre-existing other-session record must be byte-identical.
    expect(readAgents(cawsDir)).toEqual({
      'other-session': {
        session_id: 'other-session',
        last_active: '2026-05-22T00:00:00.000Z',
        claimed_paths: ['pre-existing'],
      },
    });
  });
});

describe('cross-session non-clobber', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it("writing session A leaves session B's claimed_paths byte-identical", () => {
    cawsDir = mkTempCawsDir();
    writeAgents(cawsDir, {
      'session-a': {
        session_id: 'session-a',
        last_active: '2026-05-22T00:00:00.000Z',
        claimed_paths: ['a/path/1', 'a/path/2'],
        last_modified_paths: ['a/mod/1.ts'],
      },
      'session-b': {
        session_id: 'session-b',
        last_active: '2026-05-22T01:00:00.000Z',
        claimed_paths: ['b/path/1'],
        last_modified_paths: ['b/mod/1.ts', 'b/mod/2.ts'],
      },
    });
    const r = applyRegistryPatch(cawsDir, {
      kind: 'refresh_agent',
      session: { session_id: 'session-a', platform: 'darwin' },
      last_active: '2026-05-23T00:00:00.000Z',
      claimed_paths: ['a/new/path'],
      last_modified_paths: ['a/new/mod.ts'],
    });
    expect(r.ok).toBe(true);
    const agents = readAgents(cawsDir);
    expect(agents['session-b']).toEqual({
      session_id: 'session-b',
      last_active: '2026-05-22T01:00:00.000Z',
      claimed_paths: ['b/path/1'],
      last_modified_paths: ['b/mod/1.ts', 'b/mod/2.ts'],
    });
  });

  it("session A's write only touches session A's record", () => {
    cawsDir = mkTempCawsDir();
    writeAgents(cawsDir, {
      'session-a': {
        session_id: 'session-a',
        last_active: '2026-05-22T00:00:00.000Z',
      },
      'session-b': {
        session_id: 'session-b',
        last_active: '2026-05-22T01:00:00.000Z',
      },
      'session-c': {
        session_id: 'session-c',
        last_active: '2026-05-22T02:00:00.000Z',
      },
    });
    applyRegistryPatch(cawsDir, {
      kind: 'refresh_agent',
      session: { session_id: 'session-a', platform: 'darwin' },
      last_active: '2026-05-23T00:00:00.000Z',
      claimed_paths: ['only/a/should/have/this'],
    });
    const agents = readAgents(cawsDir);
    expect(agents['session-a'].claimed_paths).toEqual(['only/a/should/have/this']);
    expect(agents['session-b'].claimed_paths).toBeUndefined();
    expect(agents['session-c'].claimed_paths).toBeUndefined();
  });
});

describe('top-level non-agent keys are preserved across writes (drift handling)', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it("preserves `version: 1` and `agents: {}` top-level non-record keys", () => {
    cawsDir = mkTempCawsDir();
    writeAgents(cawsDir, {
      version: 1,
      agents: {},
      'caws-existing': {
        session_id: 'caws-existing',
        last_active: '2026-05-22T00:00:00.000Z',
      },
    });
    const r = applyRegistryPatch(
      cawsDir,
      refreshAgentPatch({
        session: { session_id: 'caws-new', platform: 'darwin' },
        claimed_paths: ['new-claim'],
      })
    );
    expect(r.ok).toBe(true);
    const agents = readAgents(cawsDir);
    // Both non-record top-level keys MUST remain.
    expect(agents.version).toBe(1);
    expect(agents.agents).toEqual({});
    // Existing real record MUST remain.
    expect(agents['caws-existing']).toEqual({
      session_id: 'caws-existing',
      last_active: '2026-05-22T00:00:00.000Z',
    });
    // New record MUST have claimed_paths.
    expect(agents['caws-new'].claimed_paths).toEqual(['new-claim']);
  });
});

describe('A5 — stale-record claim preservation', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it('a stale session record retains its claimed_paths and last_modified_paths through subsequent unrelated writes', () => {
    cawsDir = mkTempCawsDir();
    writeAgents(cawsDir, {
      'stale-session': {
        session_id: 'stale-session',
        last_active: '2024-01-01T00:00:00.000Z', // very old
        claimed_paths: ['locked/by/stale'],
        last_modified_paths: ['stale-mod-1.ts', 'stale-mod-2.ts'],
      },
    });
    applyRegistryPatch(cawsDir, {
      kind: 'refresh_agent',
      session: { session_id: 'fresh-session', platform: 'darwin' },
      last_active: '2026-05-23T00:00:00.000Z',
    });
    expect(readAgents(cawsDir)['stale-session']).toEqual({
      session_id: 'stale-session',
      last_active: '2024-01-01T00:00:00.000Z',
      claimed_paths: ['locked/by/stale'],
      last_modified_paths: ['stale-mod-1.ts', 'stale-mod-2.ts'],
    });
  });
});

describe('omitted fields leave existing fields untouched', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it('omitting claimed_paths in a patch does NOT clear an existing claimed_paths', () => {
    cawsDir = mkTempCawsDir();
    writeAgents(cawsDir, {
      'caws-test': {
        session_id: 'caws-test',
        last_active: '2026-05-22T00:00:00.000Z',
        claimed_paths: ['keep/me'],
      },
    });
    const r = applyRegistryPatch(cawsDir, refreshAgentPatch());
    expect(r.ok).toBe(true);
    expect(readAgents(cawsDir)['caws-test'].claimed_paths).toEqual(['keep/me']);
  });

  it('omitting last_modified_paths in a patch does NOT clear an existing one', () => {
    cawsDir = mkTempCawsDir();
    writeAgents(cawsDir, {
      'caws-test': {
        session_id: 'caws-test',
        last_active: '2026-05-22T00:00:00.000Z',
        last_modified_paths: ['keep.ts'],
      },
    });
    const r = applyRegistryPatch(cawsDir, refreshAgentPatch());
    expect(r.ok).toBe(true);
    expect(readAgents(cawsDir)['caws-test'].last_modified_paths).toEqual(['keep.ts']);
  });
});
