// SESSION-OWNERSHIP-METADATA-001 commit 2 — kernel freshness tests.
//
// Covers the kernel-side patch construction for claimed_paths and
// last_modified_paths. The kernel does NOT validate or cap; it
// constructs the patch envelope verbatim. Storage-bound enforcement
// lives in the shell-layer writer (apply-patch.ts).

import { refreshAgentClaim } from '../../src/worktree';
import type { RegistryPatch, SessionIdentity } from '../../src/worktree';
import { isOk } from '../../src/result';

const NOW = new Date('2026-05-23T00:00:00.000Z');
const SESSION: SessionIdentity = {
  session_id: 'caws-test',
  platform: 'darwin',
};

describe('refreshAgentClaim — claimed_paths forwarding', () => {
  it('omits claimed_paths from the patch when not supplied', () => {
    const r = refreshAgentClaim({}, SESSION, NOW);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const patch = r.value as Extract<RegistryPatch, { kind: 'refresh_agent' }>;
    expect(patch.claimed_paths).toBeUndefined();
  });

  it('forwards claimed_paths verbatim into the patch envelope', () => {
    const r = refreshAgentClaim({}, SESSION, NOW, {
      claimed_paths: ['packages/foo/**', 'tests/foo.test.js'],
    });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const patch = r.value as Extract<RegistryPatch, { kind: 'refresh_agent' }>;
    expect(patch.claimed_paths).toEqual([
      'packages/foo/**',
      'tests/foo.test.js',
    ]);
  });

  it('forwards an explicitly-empty array (does NOT collapse to undefined)', () => {
    const r = refreshAgentClaim({}, SESSION, NOW, { claimed_paths: [] });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const patch = r.value as Extract<RegistryPatch, { kind: 'refresh_agent' }>;
    expect(patch.claimed_paths).toEqual([]);
  });

  it('does NOT validate or cap claimed_paths — that is the writer/CLI', () => {
    // Per C1 storage-contract: the kernel constructs; the writer validates.
    const oversized = Array.from({ length: 2000 }, (_, i) => `p/${i}`);
    const r = refreshAgentClaim({}, SESSION, NOW, { claimed_paths: oversized });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const patch = r.value as Extract<RegistryPatch, { kind: 'refresh_agent' }>;
    expect(patch.claimed_paths!.length).toBe(2000);
  });
});

describe('refreshAgentClaim — last_modified_paths forwarding', () => {
  it('omits last_modified_paths from the patch when not supplied', () => {
    const r = refreshAgentClaim({}, SESSION, NOW);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const patch = r.value as Extract<RegistryPatch, { kind: 'refresh_agent' }>;
    expect(patch.last_modified_paths).toBeUndefined();
  });

  it('forwards last_modified_paths verbatim into the patch envelope', () => {
    const r = refreshAgentClaim({}, SESSION, NOW, {
      last_modified_paths: ['a.ts', 'b.ts'],
    });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const patch = r.value as Extract<RegistryPatch, { kind: 'refresh_agent' }>;
    expect(patch.last_modified_paths).toEqual(['a.ts', 'b.ts']);
  });

  it('does NOT TTL-prune or FIFO-cap — that is the writer', () => {
    // Per C1 storage-contract: the kernel does not compute "now() - ttl"
    // and does not enforce the 1000 cap. The writer enforces the cap;
    // the caller enforces TTL.
    const huge = Array.from({ length: 5000 }, (_, i) => `mod/${i}.ts`);
    const r = refreshAgentClaim({}, SESSION, NOW, {
      last_modified_paths: huge,
    });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const patch = r.value as Extract<RegistryPatch, { kind: 'refresh_agent' }>;
    expect(patch.last_modified_paths!.length).toBe(5000);
  });
});

describe('refreshAgentClaim — both new fields with existing options', () => {
  it('coexists with bound_worktree and bound_spec_id', () => {
    const r = refreshAgentClaim({}, SESSION, NOW, {
      bound_worktree: 'session-ownership-metadata',
      bound_spec_id: 'SESSION-OWNERSHIP-METADATA-001',
      claimed_paths: ['packages/caws-kernel/src/worktree/types.ts'],
      last_modified_paths: ['packages/caws-kernel/src/worktree/freshness.ts'],
    });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const patch = r.value as Extract<RegistryPatch, { kind: 'refresh_agent' }>;
    expect(patch.kind).toBe('refresh_agent');
    expect(patch.session.session_id).toBe('caws-test');
    expect(patch.last_active).toBe('2026-05-23T00:00:00.000Z');
    expect(patch.bound_worktree).toBe('session-ownership-metadata');
    expect(patch.bound_spec_id).toBe('SESSION-OWNERSHIP-METADATA-001');
    expect(patch.claimed_paths).toEqual([
      'packages/caws-kernel/src/worktree/types.ts',
    ]);
    expect(patch.last_modified_paths).toEqual([
      'packages/caws-kernel/src/worktree/freshness.ts',
    ]);
  });
});
