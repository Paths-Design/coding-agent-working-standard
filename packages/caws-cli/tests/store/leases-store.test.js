/**
 * Tests for the agent-lease store layer.
 *
 * MULTI-AGENT-ACTIVITY-REGISTRY-001 acceptance A5–A8.
 *
 * Covers:
 *   - safeLeaseFilename: regex enforcement, 'unknown' refusal, type check
 *   - loadLeases: lenient per file, strict on directory
 *   - applyLeasePatch: write_lease atomic, mark_stopped against missing
 *     is warn no-op, delete_lease idempotent
 *   - applyLeasePatches: aggregates diagnostics, does not abort on per-patch
 *     failure
 *   - pruneLeasesByStatus: dry-run by default, retention math, deletes
 *     when --apply
 *   - Static-evidence: apply-patch.ts does NOT contain LeasePatch kinds
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  safeLeaseFilename,
  loadLeases,
  applyLeasePatch,
  applyLeasePatches,
  pruneLeasesByStatus,
  STORE_RULES,
} = require('../../dist/store');

function mkTempCawsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'caws-leases-store-'));
}

function makeLease(sessionId, overrides = {}) {
  return {
    lease_version: 1,
    session_id: sessionId,
    platform: 'claude-code',
    status: 'active',
    started_at: '2026-05-23T10:00:00.000Z',
    last_active: '2026-05-23T10:00:30.000Z',
    repo_root: '/test/repo',
    cwd: '/test/repo',
    git_common_dir: '/test/repo/.git',
    git_dir: '/test/repo/.git',
    last_seen_reason: 'pre_tool_use',
    ...overrides,
  };
}

// ─── A6: safeLeaseFilename ────────────────────────────────────────────────

describe('safeLeaseFilename (A6)', () => {
  it('accepts caws-<hex> format', () => {
    const r = safeLeaseFilename('caws-2e94385548fa');
    expect(r.ok).toBe(true);
    expect(r.value).toBe('caws-2e94385548fa.json');
  });

  it('accepts UUIDs', () => {
    const r = safeLeaseFilename('bc73ba3b-534f-4932-a7e2-8f3f699db486');
    expect(r.ok).toBe(true);
    expect(r.value).toBe('bc73ba3b-534f-4932-a7e2-8f3f699db486.json');
  });

  it('accepts allowlist chars: dot, underscore, colon, hyphen', () => {
    const r = safeLeaseFilename('a_b.c:d-e');
    expect(r.ok).toBe(true);
    expect(r.value).toBe('a_b.c:d-e.json');
  });

  it('rejects empty string', () => {
    const r = safeLeaseFilename('');
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(STORE_RULES.LEASE_SESSION_ID_INVALID);
  });

  it("rejects 'unknown' (parse-input.sh's fallback)", () => {
    const r = safeLeaseFilename('unknown');
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(STORE_RULES.LEASE_SESSION_ID_INVALID);
    expect(r.errors[0].message).toMatch(/would collide across anonymous sessions/);
  });

  it('rejects non-string input', () => {
    const r = safeLeaseFilename(42);
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(STORE_RULES.LEASE_SESSION_ID_INVALID);
  });

  it('rejects null', () => {
    const r = safeLeaseFilename(null);
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(STORE_RULES.LEASE_SESSION_ID_INVALID);
  });

  it('rejects path separator (forward slash)', () => {
    const r = safeLeaseFilename('with/slash');
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(STORE_RULES.LEASE_SESSION_ID_UNSAFE);
  });

  it('rejects path separator (backslash)', () => {
    const r = safeLeaseFilename('with\\backslash');
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(STORE_RULES.LEASE_SESSION_ID_UNSAFE);
  });

  it('rejects parent-directory traversal', () => {
    const r = safeLeaseFilename('../escape');
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(STORE_RULES.LEASE_SESSION_ID_UNSAFE);
  });

  it('rejects whitespace', () => {
    const r = safeLeaseFilename('has spaces');
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(STORE_RULES.LEASE_SESSION_ID_UNSAFE);
  });

  it('rejects shell metacharacters', () => {
    expect(safeLeaseFilename('a;b').ok).toBe(false);
    expect(safeLeaseFilename('a|b').ok).toBe(false);
    expect(safeLeaseFilename('a$b').ok).toBe(false);
    expect(safeLeaseFilename('a`b').ok).toBe(false);
  });
});

// ─── A7: loadLeases lenient under per-file corruption ────────────────────

describe('loadLeases lenient per file (A7)', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it('missing leases directory → Ok({ leases: {}, diagnostics: [] })', () => {
    cawsDir = mkTempCawsDir();
    const r = loadLeases(cawsDir);
    expect(r.ok).toBe(true);
    expect(r.value.leases).toEqual({});
    expect(r.value.diagnostics).toEqual([]);
  });

  it('empty leases directory → Ok({ leases: {}, diagnostics: [] })', () => {
    cawsDir = mkTempCawsDir();
    fs.mkdirSync(path.join(cawsDir, 'leases'));
    const r = loadLeases(cawsDir);
    expect(r.ok).toBe(true);
    expect(r.value.leases).toEqual({});
  });

  it('mix of valid and malformed files → returns valid subset + diagnostics', () => {
    cawsDir = mkTempCawsDir();
    const leasesDir = path.join(cawsDir, 'leases');
    fs.mkdirSync(leasesDir);

    fs.writeFileSync(
      path.join(leasesDir, 'good1.json'),
      JSON.stringify(makeLease('good1'))
    );
    fs.writeFileSync(
      path.join(leasesDir, 'good2.json'),
      JSON.stringify(makeLease('good2'))
    );
    fs.writeFileSync(path.join(leasesDir, 'malformed.json'), 'not json');
    fs.writeFileSync(
      path.join(leasesDir, 'mismatch.json'),
      JSON.stringify({ ...makeLease('different-id') })
    );

    const r = loadLeases(cawsDir);
    expect(r.ok).toBe(true);
    expect(Object.keys(r.value.leases).sort()).toEqual(['good1', 'good2']);

    const rules = r.value.diagnostics.map((d) => d.rule);
    expect(rules).toContain(STORE_RULES.LEASE_FILE_MALFORMED);
    expect(r.value.diagnostics.length).toBe(2); // malformed.json + mismatch.json
  });

  it('non-lease files in directory are silently ignored (no diagnostic)', () => {
    cawsDir = mkTempCawsDir();
    const leasesDir = path.join(cawsDir, 'leases');
    fs.mkdirSync(leasesDir);
    fs.writeFileSync(path.join(leasesDir, 'README.md'), '# leases dir');
    fs.writeFileSync(path.join(leasesDir, '.DS_Store'), '');

    const r = loadLeases(cawsDir);
    expect(r.ok).toBe(true);
    expect(r.value.diagnostics).toEqual([]);
  });

  it('lease file with non-object root → diagnostic, excluded', () => {
    cawsDir = mkTempCawsDir();
    const leasesDir = path.join(cawsDir, 'leases');
    fs.mkdirSync(leasesDir);
    fs.writeFileSync(
      path.join(leasesDir, 'array.json'),
      JSON.stringify(['not', 'an', 'object'])
    );
    const r = loadLeases(cawsDir);
    expect(r.ok).toBe(true);
    expect(r.value.leases).toEqual({});
    expect(r.value.diagnostics[0].rule).toBe(STORE_RULES.LEASE_FILE_MALFORMED);
  });
});

// ─── A8: loadLeases strict on directory unreadable ────────────────────────

describe('loadLeases strict on directory (A8)', () => {
  let cawsDir;
  afterEach(() => {
    if (cawsDir) {
      try {
        fs.chmodSync(path.join(cawsDir, 'leases'), 0o755);
      } catch {}
      fs.rmSync(cawsDir, { recursive: true, force: true });
    }
  });

  it('unreadable leases directory → Err with LEASE_DIR_UNREADABLE', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      // chmod 000 doesn't reliably block readdir on Windows or root.
      return;
    }
    cawsDir = mkTempCawsDir();
    const leasesDir = path.join(cawsDir, 'leases');
    fs.mkdirSync(leasesDir);
    fs.writeFileSync(path.join(leasesDir, 'x.json'), JSON.stringify(makeLease('x')));
    fs.chmodSync(leasesDir, 0o000);

    const r = loadLeases(cawsDir);
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(STORE_RULES.LEASE_DIR_UNREADABLE);
  });
});

// ─── applyLeasePatch — write_lease ────────────────────────────────────────

describe('applyLeasePatch write_lease', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it('creates leases dir on first write', () => {
    cawsDir = mkTempCawsDir();
    expect(fs.existsSync(path.join(cawsDir, 'leases'))).toBe(false);

    const lease = makeLease('caws-test1');
    const r = applyLeasePatch(cawsDir, { kind: 'write_lease', session_id: 'caws-test1', lease });
    expect(r.ok).toBe(true);
    expect(r.value.wrote).toBe(true);
    expect(fs.existsSync(path.join(cawsDir, 'leases', 'caws-test1.json'))).toBe(true);
  });

  it('written file is the canonical AgentLease JSON', () => {
    cawsDir = mkTempCawsDir();
    const lease = makeLease('caws-test2', { status: 'active', branch: 'feat/x' });
    applyLeasePatch(cawsDir, { kind: 'write_lease', session_id: 'caws-test2', lease });

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(cawsDir, 'leases', 'caws-test2.json'), 'utf8')
    );
    expect(onDisk).toEqual(lease);
  });

  it('rejects unsafe session_id BEFORE any I/O', () => {
    cawsDir = mkTempCawsDir();
    const r = applyLeasePatch(cawsDir, {
      kind: 'write_lease',
      session_id: 'with/slash',
      lease: makeLease('with/slash'),
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(STORE_RULES.LEASE_SESSION_ID_UNSAFE);
    // No leases dir created.
    expect(fs.existsSync(path.join(cawsDir, 'leases'))).toBe(false);
  });

  it('rejects unknown session_id', () => {
    cawsDir = mkTempCawsDir();
    const r = applyLeasePatch(cawsDir, {
      kind: 'write_lease',
      session_id: 'unknown',
      lease: makeLease('unknown'),
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(STORE_RULES.LEASE_SESSION_ID_INVALID);
  });
});

// ─── applyLeasePatch — mark_stopped ───────────────────────────────────────

describe('applyLeasePatch mark_stopped', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it('against existing lease: updates status + stopped_at, preserves other fields', () => {
    cawsDir = mkTempCawsDir();
    const lease = makeLease('caws-test3', { branch: 'preserve-me', bound_spec_id: 'SPEC-X' });
    applyLeasePatch(cawsDir, { kind: 'write_lease', session_id: 'caws-test3', lease });

    const stopAt = '2026-05-23T11:00:00.000Z';
    const r = applyLeasePatch(cawsDir, {
      kind: 'mark_stopped',
      session_id: 'caws-test3',
      transitioned_at: stopAt,
    });
    expect(r.ok).toBe(true);
    expect(r.value.wrote).toBe(true);

    const after = JSON.parse(
      fs.readFileSync(path.join(cawsDir, 'leases', 'caws-test3.json'), 'utf8')
    );
    expect(after.status).toBe('stopped');
    expect(after.stopped_at).toBe(stopAt);
    expect(after.last_seen_reason).toBe('session_stop');
    // PRESERVED:
    expect(after.branch).toBe('preserve-me');
    expect(after.bound_spec_id).toBe('SPEC-X');
    expect(after.started_at).toBe(lease.started_at);
    expect(after.last_active).toBe(lease.last_active);
  });

  it('against missing lease: WARN no-op (does NOT fabricate)', () => {
    cawsDir = mkTempCawsDir();
    fs.mkdirSync(path.join(cawsDir, 'leases'));

    const r = applyLeasePatch(cawsDir, {
      kind: 'mark_stopped',
      session_id: 'never-registered',
      transitioned_at: '2026-05-23T11:00:00.000Z',
    });
    expect(r.ok).toBe(true);
    expect(r.value.wrote).toBe(false); // NO write
    expect(r.value.diagnostics.length).toBe(1);
    expect(r.value.diagnostics[0].rule).toBe(STORE_RULES.LEASE_STOP_NO_PRIOR_LEASE);
    expect(r.value.diagnostics[0].severity).toBe('warning');
    // No file created on disk.
    expect(fs.existsSync(path.join(cawsDir, 'leases', 'never-registered.json'))).toBe(false);
  });
});

// ─── applyLeasePatch — delete_lease ───────────────────────────────────────

describe('applyLeasePatch delete_lease', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it('deletes existing lease file', () => {
    cawsDir = mkTempCawsDir();
    applyLeasePatch(cawsDir, {
      kind: 'write_lease',
      session_id: 'caws-test4',
      lease: makeLease('caws-test4'),
    });
    expect(fs.existsSync(path.join(cawsDir, 'leases', 'caws-test4.json'))).toBe(true);

    const r = applyLeasePatch(cawsDir, { kind: 'delete_lease', session_id: 'caws-test4' });
    expect(r.ok).toBe(true);
    expect(r.value.wrote).toBe(true);
    expect(fs.existsSync(path.join(cawsDir, 'leases', 'caws-test4.json'))).toBe(false);
  });

  it('idempotent on absent lease (ok with wrote=false)', () => {
    cawsDir = mkTempCawsDir();
    const r = applyLeasePatch(cawsDir, { kind: 'delete_lease', session_id: 'caws-test5' });
    expect(r.ok).toBe(true);
    expect(r.value.wrote).toBe(false);
  });
});

// ─── applyLeasePatches batch aggregation ──────────────────────────────────

describe('applyLeasePatches', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it('aggregates per-patch diagnostics, does NOT abort on per-patch failure', () => {
    cawsDir = mkTempCawsDir();
    const patches = [
      { kind: 'write_lease', session_id: 'A', lease: makeLease('A') },
      // Second patch will fail filename validation (rejected before I/O):
      { kind: 'write_lease', session_id: 'with/slash', lease: makeLease('with/slash') },
      { kind: 'write_lease', session_id: 'B', lease: makeLease('B') },
    ];
    const r = applyLeasePatches(cawsDir, patches);
    expect(r.ok).toBe(true);
    expect(r.value.applied).toBe(2); // A and B
    expect(r.value.diagnostics.length).toBeGreaterThan(0);
    expect(r.value.diagnostics.some((d) => d.rule === STORE_RULES.LEASE_SESSION_ID_UNSAFE)).toBe(true);
    expect(fs.existsSync(path.join(cawsDir, 'leases', 'A.json'))).toBe(true);
    expect(fs.existsSync(path.join(cawsDir, 'leases', 'B.json'))).toBe(true);
  });
});

// ─── pruneLeasesByStatus ──────────────────────────────────────────────────

describe('pruneLeasesByStatus', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it('default is dry-run (no files deleted)', () => {
    cawsDir = mkTempCawsDir();
    applyLeasePatch(cawsDir, {
      kind: 'write_lease',
      session_id: 'old-stopped',
      lease: makeLease('old-stopped', {
        status: 'stopped',
        stopped_at: '2026-05-22T00:00:00.000Z',
      }),
    });

    const r = pruneLeasesByStatus(cawsDir, {
      status: 'stopped',
      retentionMs: 1000,
      now: new Date('2026-05-23T00:00:00.000Z'),
      // dryRun: omitted, defaults to true
    });
    expect(r.ok).toBe(true);
    expect(r.value.candidates).toEqual(['old-stopped']);
    expect(r.value.deleted).toEqual([]); // dry-run
    expect(fs.existsSync(path.join(cawsDir, 'leases', 'old-stopped.json'))).toBe(true);
  });

  it('deletes when dryRun: false', () => {
    cawsDir = mkTempCawsDir();
    applyLeasePatch(cawsDir, {
      kind: 'write_lease',
      session_id: 'old-stopped',
      lease: makeLease('old-stopped', {
        status: 'stopped',
        stopped_at: '2026-05-22T00:00:00.000Z',
      }),
    });
    applyLeasePatch(cawsDir, {
      kind: 'write_lease',
      session_id: 'recent-stopped',
      lease: makeLease('recent-stopped', {
        status: 'stopped',
        stopped_at: '2026-05-23T00:00:00.000Z',
      }),
    });

    const r = pruneLeasesByStatus(cawsDir, {
      status: 'stopped',
      retentionMs: 60 * 60 * 1000, // 1h retention
      now: new Date('2026-05-23T00:00:30.000Z'),
      dryRun: false,
    });
    expect(r.ok).toBe(true);
    expect(r.value.candidates).toEqual(['old-stopped']);
    expect(r.value.deleted).toEqual(['old-stopped']);
    // recent-stopped survives (within retention window).
    expect(fs.existsSync(path.join(cawsDir, 'leases', 'recent-stopped.json'))).toBe(true);
    expect(fs.existsSync(path.join(cawsDir, 'leases', 'old-stopped.json'))).toBe(false);
  });

  it('prunes stale leases (status=active but last_active beyond staleTtl + retention)', () => {
    cawsDir = mkTempCawsDir();
    applyLeasePatch(cawsDir, {
      kind: 'write_lease',
      session_id: 'old-active',
      lease: makeLease('old-active', {
        status: 'active',
        last_active: '2026-05-22T00:00:00.000Z',
      }),
    });

    const r = pruneLeasesByStatus(cawsDir, {
      status: 'stale',
      staleTtlMs: 60 * 1000, // 60s ttl
      retentionMs: 60 * 1000, // 60s additional retention
      now: new Date('2026-05-23T00:00:00.000Z'),
      dryRun: false,
    });
    expect(r.ok).toBe(true);
    expect(r.value.deleted).toEqual(['old-active']);
  });
});

// ─── Static-evidence: apply-patch.ts isolation ────────────────────────────

describe('apply-patch.ts does NOT handle LeasePatch kinds (A5 — static evidence)', () => {
  it('apply-patch.ts contains no LeasePatch kind strings', () => {
    const applyPatchPath = path.join(__dirname, '..', '..', 'src', 'store', 'apply-patch.ts');
    const source = fs.readFileSync(applyPatchPath, 'utf8');
    // No applied kind strings (we DO allow them in COMMENTS explaining the
    // separation, but no quoted-string literal that could be a discriminator).
    // The match is for the literal "'write_lease'" / '"write_lease"' as
    // a switch/case discriminator. We use a simple regex: no quoted literal.
    expect(source).not.toMatch(/case\s+['"]write_lease['"]/);
    expect(source).not.toMatch(/case\s+['"]mark_stopped['"]/);
    expect(source).not.toMatch(/case\s+['"]delete_lease['"]/);
    expect(source).not.toMatch(/===\s*['"]write_lease['"]/);
    expect(source).not.toMatch(/===\s*['"]mark_stopped['"]/);
    expect(source).not.toMatch(/===\s*['"]delete_lease['"]/);
  });

  it('apply-patch.ts does NOT import from leases-store.ts', () => {
    const applyPatchPath = path.join(__dirname, '..', '..', 'src', 'store', 'apply-patch.ts');
    const source = fs.readFileSync(applyPatchPath, 'utf8');
    expect(source).not.toMatch(/from\s+['"]\.\/leases-store['"]/);
  });

  it('leases-store.ts does NOT import or call applyRegistryPatch', () => {
    // References to "applyRegistryPatch" in DOC COMMENTS are allowed and
    // encouraged (they document the boundary). What's forbidden is
    // importing or calling the symbol.
    const leasesStorePath = path.join(__dirname, '..', '..', 'src', 'store', 'leases-store.ts');
    const source = fs.readFileSync(leasesStorePath, 'utf8');
    expect(source).not.toMatch(/import\s+[^;]*applyRegistryPatch/);
    expect(source).not.toMatch(/applyRegistryPatch\s*\(/); // not called
    expect(source).not.toMatch(/from\s+['"]\.\/apply-patch['"]/); // not imported from module
  });
});
