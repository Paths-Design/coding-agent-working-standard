'use strict';

/**
 * Hook-pack registration mechanical lock.
 *
 * register.ts warns (lines 4-6) that the hand-maintained surface list has
 * drifted before — the stale VALID_COMMANDS array once listed 8 entries while
 * register.ts registered 12, so unknown-command suggestions never fired for
 * the missing four. The pack-fingerprint + render tests cover template
 * integrity and install behavior; NOTHING currently locks the registration
 * surface itself. Adding a surface is "drop a manifest + register it here",
 * and forgetting the resolveHookPack branch would make
 * `caws init --agent-surface <new>` silently return declared_not_implemented
 * (the surface is "recognized but not implemented") instead of installing.
 *
 * This suite pins the three registration arrays against each other and against
 * the manifests, so the addition step can't silently go incomplete.
 */

const {
  resolveHookPack,
  KNOWN_SURFACES,
  IMPLEMENTED_SURFACES,
} = require('../../dist/init/hook-packs/register');

describe('hook-pack registration: the surface arrays are mutually consistent', () => {
  test('every IMPLEMENTED surface resolves to an installed pack', () => {
    // Catches: surface added to IMPLEMENTED_SURFACES but no resolveHookPack
    // branch (it would resolve to declared_not_implemented).
    for (const surface of IMPLEMENTED_SURFACES) {
      const r = resolveHookPack(surface);
      expect(r).toEqual({ kind: 'pack', pack: expect.objectContaining({ id: surface }) });
    }
  });

  test('every IMPLEMENTED surface is also KNOWN', () => {
    for (const surface of IMPLEMENTED_SURFACES) {
      expect(KNOWN_SURFACES).toContain(surface);
    }
  });

  test('every resolved pack targets the surface it was registered under', () => {
    // Catches: a manifest wired into the wrong branch (mislabeled targetSurface).
    for (const surface of IMPLEMENTED_SURFACES) {
      const r = resolveHookPack(surface);
      if (r.kind !== 'pack') continue;
      expect(r.pack.targetSurface).toBe(surface);
      expect(r.pack.id).toBe(surface);
    }
  });

  test("'none' resolves to the explicit opt-out", () => {
    expect(resolveHookPack('none')).toEqual({ kind: 'none' });
  });

  test('the unimplemented surfaces stay declared_not_implemented', () => {
    // cursor / windsurf are recognized values but ship no pack. If a pack is
    // added for one of them, move it to IMPLEMENTED_SURFACES and update this.
    for (const surface of KNOWN_SURFACES) {
      if (surface === 'none' || IMPLEMENTED_SURFACES.includes(surface)) continue;
      expect(resolveHookPack(surface).kind).toBe('declared_not_implemented');
    }
  });

  test('the implemented surfaces are exactly claude-code, codex, dsh, opencode, zcode, kimi-code, qwen-code', () => {
    // Canary: adding a new implemented surface MUST update this assertion, so
    // the registration lock cannot silently go stale. If you ship a new pack,
    // add it here AND confirm every assertion above still holds.
    expect([...IMPLEMENTED_SURFACES].sort()).toEqual(
      ['claude-code', 'codex', 'dsh', 'kimi-code', 'opencode', 'qwen-code', 'zcode'].sort()
    );
  });
});

describe('hook-pack registration: the telemetry cut is surface-conditional (CAWS-HARNESS-TELEMETRY-ADAPTER-001)', () => {
  const {
    SHARED_PACK,
    sharedPackForSurface,
    TELEMETRY_ROW_DEST_PATHS,
  } = require('../../dist/init/hook-packs/manifest-shared');
  const {
    isAdapterCoveredSurface,
    ADAPTER_COVERED_SURFACES,
  } = require('../../dist/init/hook-packs/types');

  test('every declared adapter-covered surface is a KNOWN surface', () => {
    // A coverage list naming an unknown surface would silently stop cutting.
    for (const s of ADAPTER_COVERED_SURFACES) {
      expect(KNOWN_SURFACES).toContain(s);
    }
  });

  test('adapter-covered surfaces get the shared core WITHOUT the telemetry rows', () => {
    for (const surface of ADAPTER_COVERED_SURFACES) {
      const pack = sharedPackForSurface(surface);
      expect(pack.id).toBe('shared');
      const dests = pack.installedFiles.map((f) => f.destPath);
      for (const dest of TELEMETRY_ROW_DEST_PATHS) {
        expect(dests).not.toContain(dest);
      }
      // The POLICY plane stays: registration, session status, audit.
      expect(dests).toContain('.caws/hooks/agent-register.sh');
      expect(dests).toContain('.caws/hooks/session-caws-status.sh');
      expect(dests).toContain('.caws/hooks/audit.sh');
    }
  });

  test('non-covered surfaces get SHARED_PACK unchanged', () => {
    for (const surface of IMPLEMENTED_SURFACES) {
      if (isAdapterCoveredSurface(surface)) continue;
      expect(sharedPackForSurface(surface)).toBe(SHARED_PACK);
    }
  });
});
