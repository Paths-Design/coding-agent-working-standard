'use strict';

/**
 * Surface-registry conformance (CAWS-DESIGN-GLOBAL-IDENTITY-HOME-001 A2).
 *
 * The registry (packages/caws-cli/surfaces/registry.json) is the single
 * source of truth; the TS union + maps derive from it at build time. This
 * suite pins the REGISTRY against the live code, so a divergence between
 * registry and reality fails loudly instead of silently drifting:
 *   - the generated union matches the registry keys in registry order;
 *   - every pinVar is one of that surface's own env vars;
 *   - TRUST_GATED_SURFACES matches the init guard's GATED_SURFACES;
 *   - ADAPTER_COVERED_SURFACES is a subset of the registry;
 *   - every implemented pack id (register.ts) is a registry key with a
 *     real hook mechanism (the sentinel 'none' has mechanism 'none');
 *   - the sentinel surface is 'none' and carries no env vars or pin.
 */

const fs = require('fs');
const path = require('path');

const registry = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '../../surfaces/registry.json'),
    'utf8'
  )
);
const generated = require('../../dist/init/hook-packs/surfaces.generated');
const {
  ADAPTER_COVERED_SURFACES,
  isAdapterCoveredSurface,
} = require('../../dist/init/hook-packs/types');
const { IMPLEMENTED_SURFACES } = require('../../dist/init/hook-packs/register');
const { GATED_SURFACES } = require('../../dist/init/hook-packs/user-scope-wiring');

const entries = Object.entries(registry.surfaces);

describe('surface registry conformance (A2)', () => {
  test('the generated union matches the registry keys in registry order', () => {
    expect(generated.AGENT_SURFACES).toEqual(entries.map(([id]) => id));
    expect(generated.SENTINEL_SURFACE).toBe('none');
  });

  test('every pinVar is one of that surface\'s own env vars', () => {
    for (const [id, s] of entries) {
      if (s.pinVar === null || s.pinVar === undefined) continue;
      expect(s.envVars).toContain(s.pinVar);
      expect(generated.SURFACE_PIN_VARS[id]).toBe(s.pinVar);
    }
  });

  test('TRUST_GATED_SURFACES matches the init guard\'s GATED_SURFACES', () => {
    expect([...generated.TRUST_GATED_SURFACES].sort()).toEqual([...GATED_SURFACES].sort());
    expect([...generated.TRUST_GATED_SURFACES].sort()).toEqual(['qwen-code', 'zcode']);
  });

  test('ADAPTER_COVERED_SURFACES is a subset of the registry', () => {
    for (const s of ADAPTER_COVERED_SURFACES) {
      expect(Object.keys(registry.surfaces)).toContain(s);
      expect(isAdapterCoveredSurface(s)).toBe(true);
    }
  });

  test('every implemented pack is a registry key with a real hook mechanism', () => {
    for (const id of IMPLEMENTED_SURFACES) {
      expect(Object.keys(registry.surfaces)).toContain(id);
      expect(registry.surfaces[id].hookMechanism).not.toBe('none');
      expect(generated.SURFACE_HOOK_MECHANISMS[id]).toBe(registry.surfaces[id].hookMechanism);
    }
  });

  test('the sentinel carries no identity machinery', () => {
    expect(registry.surfaces.none.envVars).toEqual([]);
    expect(registry.surfaces.none.pinVar).toBeNull();
    expect(registry.surfaces.none.hookMechanism).toBe('none');
    expect(generated.SURFACE_ENV_VARS.none).toEqual([]);
  });

  test('the dsh entry is pinned correctly (the reference adapter surface)', () => {
    expect(registry.surfaces.dsh.envVars).toEqual(['DSH_SESSION_ID']);
    expect(registry.surfaces.dsh.pinVar).toBe('DSH_SESSION_ID');
    expect(registry.surfaces.dsh.trustGated).toBe(false);
    expect(registry.surfaces.dsh.hookMechanism).toBe('harness-plugin');
  });
});
